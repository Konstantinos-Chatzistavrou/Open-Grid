#include "rs/tire.hpp"
#include "rs/math.hpp"
#include <algorithm>
#include <cmath>

namespace rs {
namespace {

// The Magic Formula itself (Pacejka MF 5.2 / 6.1):
//   y(x) = D sin(C atan(B x - E (B x - atan(B x))))
//   D = peak value, C = shape (how the curve falls after the peak), B = stiffness factor,
//   E = curvature near the peak (constrained <= 1 so the atan argument is strictly monotonic).
//   The slope at the origin is B*C*D (the slip/cornering stiffness K).
double mf(double x, double B, double C, double D, double E) {
    double bx = B * x;
    double e = std::min(E, 1.0);
    return D * std::sin(C * std::atan(bx - e * (bx - std::atan(bx))));
}

// Cosine Magic Formula used by Pacejka MF 5.2 for weighting functions Gxa, Gyk and pneumatic trail t:
//   G(x) = cos(C atan(B x - E (B x - atan(B x))))
// Uses exact identity cos(atan(t)) = 1 / sqrt(1 + t^2) when C == 1 (rcx1 = rcy1 = 1 in MF 5.2).
inline double mf_cos(double x, double B, double C, double E) {
    if (x == 0.0) return 1.0;
    const double bx = B * x;
    const double e = std::min(E, 1.0);
    const double t = bx - e * (bx - std::atan(bx));
    if (std::abs(C - 1.0) < 1e-12) return 1.0 / std::sqrt(1.0 + t * t);
    return std::cos(C * std::atan(t));
}

// Exact identity cos(atan(u)) = 1 / sqrt(1 + u^2) — avoids 2 transcendentals per call.
inline double cos_atan(double u) { return 1.0 / std::sqrt(1.0 + u * u); }

// Normalised load change dfz = (Fz - Fz0) / Fz0, used for load sensitivity.
double dfz_of(const TireParams& p, double fz) { return (fz - p.fz0) / std::max(p.fz0, 1.0); }

// Longitudinal slip stiffness K_xk (MF 5.2 eq. 4.E13):
//   K_xk = Fz (pKx1 + pKx2 dfz) exp(pKx3 dfz)
//   MF 6.1 pressure: * (1 + pPx1 dpi + pPx2 dpi^2)
double kx_of(const TireParams& p, double fz, double dfz, double dpi = 0.0) {
    double factor = std::max(0.2, 1.0 + (p.pkx2 / std::max(p.kx, 1e-6)) * dfz);
    double press = std::max(0.3, 1.0 + p.ppx1 * dpi + p.ppx2 * dpi * dpi);
    return p.kx * fz * factor * std::exp(clamp(p.pkx3 * dfz, -1.0, 1.0)) * press;
}

// Lateral cornering stiffness K_ya (MF 5.2 eq. 4.E25):
//   K_ya = pKy1 Fz0 sin(2 atan(Fz / (pKy2 Fz0))) (1 - pKy3 |gamma|)
// Rises with load, then saturates: doubling load does NOT double cornering stiffness.
//   MF 6.1 pressure: pKy1 Fz0 (1 + pPy1 dpi) sin(2 atan(Fz / (pKy2 Fz0 (1 + pPy2 dpi))))
double ky_of(const TireParams& p, double fz, double gamma, double dpi = 0.0) {
    double camber_loss = std::max(0.2, 1.0 - p.pky3 * std::abs(gamma));
    double peak_load = p.pky2 * p.fz0 * std::max(0.3, 1.0 + p.ppy2 * dpi);
    return p.pky1 * p.fz0 * std::max(0.3, 1.0 + p.ppy1 * dpi) * std::sin(2.0 * std::atan(fz / peak_load)) * camber_loss;
}

// Peak friction coefficients with load, camber and pressure sensitivity (MF 6.1 eqs. 4.E13 / 4.E23):
//   mu_x = pDx1 (1 + pDx2 dfz)(1 + pPx3 dpi + pPx4 dpi^2)(1 - pDx3 gamma^2) lambda_mu
double mu_x_of(const TireParams& p, double dfz, double gamma, double mu_scale, double dpi) {
    return p.mu_x * std::max(0.2, 1.0 + p.pdx2 * dfz) * std::max(0.5, 1.0 + p.ppx3 * dpi + p.ppx4 * dpi * dpi)
           * std::max(0.2, 1.0 - p.pdx3 * gamma * gamma) * mu_scale;
}
double mu_y_of(const TireParams& p, double dfz, double gamma, double mu_scale, double dpi) {
    return p.mu_y * std::max(0.2, 1.0 + p.pdy2 * dfz) * std::max(0.5, 1.0 + p.ppy3 * dpi + p.ppy4 * dpi * dpi)
           * std::max(0.2, 1.0 - p.pdy3 * gamma * gamma) * mu_scale;
}

// 4x4 contact patch normalized coordinates:
//   xi_i in {-0.75, -0.25, +0.25, +0.75} (trailing -x to leading +x along 2a)
//   eta_j in {-0.75, -0.25, +0.25, +0.75} (right -y to left +y across 2b, ISO 8855)
constexpr double kPatchXi[kPatchRows]  = {-0.75, -0.25, 0.25, 0.75};
constexpr double kPatchEta[kPatchCols] = {-0.75, -0.25, 0.25, 0.75};

// Normalized longitudinal & lateral parabolic contact-pressure baseline weights (Pacejka Ch. 3 eq. 3.2).
// Each 4-element array sums to 4.0 so the outer product w_lon[i] * w_lat[j] sums to 16.0.
constexpr double kPatchWLon[kPatchRows] = {
    (1.0 - 0.55 * 0.5625) / 0.828125,
    (1.0 - 0.55 * 0.0625) / 0.828125,
    (1.0 - 0.55 * 0.0625) / 0.828125,
    (1.0 - 0.55 * 0.5625) / 0.828125
};
constexpr double kPatchWLat[kPatchCols] = {
    (1.0 - 0.18 * 0.5625) / 0.94375,
    (1.0 - 0.18 * 0.0625) / 0.94375,
    (1.0 - 0.18 * 0.0625) / 0.94375,
    (1.0 - 0.18 * 0.5625) / 0.94375
};
// Normalized bristle travel from leading edge (x = +a): u_i = (1 - xi_i) / 2 in {0.875, 0.625, 0.375, 0.125}.
constexpr double kPatchU[kPatchRows] = {0.875, 0.625, 0.375, 0.125};

// Tyre-level precomputed invariants shared across all cells of a 4x4 contact patch evaluation.
struct PatchMFPrecomp {
    double press_kx = 1.0, press_ky = 1.0, peak_load_ky = 8000.0;
    double mu_x_base = 1.25, mu_y_base = 1.2;
    double ky_scale = 1.0;
    double g2 = 0.0;
    double rbx_g = 12.0, rby_g = 10.0;
    double inv_fz0 = 1.0 / 4000.0;
    double inv_kx = 1.0 / 25.0;
};

inline PatchMFPrecomp make_patch_precomp(const TireParams& p, double gamma, double dpi) {
    PatchMFPrecomp c;
    c.g2 = gamma * gamma;
    c.inv_fz0 = 1.0 / std::max(p.fz0, 1.0);
    c.inv_kx = 1.0 / std::max(p.kx, 1e-6);
    c.press_kx = std::max(0.3, 1.0 + p.ppx1 * dpi + p.ppx2 * dpi * dpi);
    c.press_ky = std::max(0.3, 1.0 + p.ppy1 * dpi);
    c.peak_load_ky = p.pky2 * p.fz0 * std::max(0.3, 1.0 + p.ppy2 * dpi);
    const double camber_ky = std::max(0.2, 1.0 - p.pky3 * std::abs(gamma));
    c.ky_scale = p.pky1 * p.fz0 * c.press_ky * camber_ky;
    c.mu_x_base = p.mu_x * std::max(0.5, 1.0 + p.ppx3 * dpi + p.ppx4 * dpi * dpi)
                  * std::max(0.2, 1.0 - p.pdx3 * c.g2);
    c.mu_y_base = p.mu_y * std::max(0.5, 1.0 + p.ppy3 * dpi + p.ppy4 * dpi * dpi)
                  * std::max(0.2, 1.0 - p.pdy3 * c.g2);
    c.rbx_g = p.rbx1 + p.rbx3 * c.g2;
    c.rby_g = p.rby1 + p.rby4 * c.g2;
    return c;
}

// Compact combined-slip Magic Formula force-per-unit-load evaluator used by the 4x4 patch cells.
// Uses hoisted pressure/camber invariants and exact algebraic trig identities (cos(atan(u)) = 1/sqrt(1+u^2)).
struct CellForceUnit {
    double fx_per_fz = 0.0;
    double fy_per_fz = 0.0;
    double fy_nosvyk_per_fz = 0.0;
};

inline CellForceUnit eval_cell_mf_unit(const TireParams& p, const PatchMFPrecomp& pre,
                                       double eff_kappa, double eff_alpha, double raw_kappa,
                                       double raw_alpha, double fz_eq, double dfz, double mu_scale,
                                       double gamma, bool mf62_hybrid) {
    CellForceUnit out;
    if (fz_eq <= 1.0 || mu_scale <= 1e-6) return out;
    const double inv_fz = 1.0 / fz_eq;

    // Pure longitudinal force fx0
    const double mu_x = pre.mu_x_base * std::max(0.2, 1.0 + p.pdx2 * dfz) * mu_scale;
    const double Dx = mu_x * fz_eq;
    const double kx_fac = std::max(0.2, 1.0 + (p.pkx2 * pre.inv_kx) * dfz);
    const double Kx = p.kx * fz_eq * kx_fac * std::exp(clamp(p.pkx3 * dfz, -1.0, 1.0)) * pre.press_kx;
    const double Bx = Kx / (p.cx * Dx + 1e-9);
    const double shx = p.phx1 + p.phx2 * dfz;
    const double svx = fz_eq * (p.pvx1 + p.pvx2 * dfz) * mu_scale;
    const double kx = eff_kappa + shx;
    const double ex = (p.ex + p.pex2 * dfz + p.pex3 * dfz * dfz) * (1.0 - p.pex4 * sign(kx));
    const double fx0 = (kx != 0.0 ? mf(kx, Bx, p.cx, Dx, ex) : 0.0) + svx;

    // Pure lateral force fy0 (uses exact identity sin(2*atan(u)) = 2u / (1 + u^2) — zero trig!)
    const double mu_y = pre.mu_y_base * std::max(0.2, 1.0 + p.pdy2 * dfz) * mu_scale;
    const double Dy = mu_y * fz_eq;
    const double u_ky = fz_eq / pre.peak_load_ky;
    const double Ky = pre.ky_scale * (2.0 * u_ky / (1.0 + u_ky * u_ky));
    const double By = Ky / (p.cy * Dy + 1e-9);
    const double shy = (p.phy1 + p.phy2 * dfz) + p.phy3 * gamma;
    const double svy = fz_eq * ((p.pvy1 + p.pvy2 * dfz) + (p.pvy3 + p.pvy4 * dfz) * gamma) * mu_scale;
    const double ay = eff_alpha + shy;
    const double ey = (p.ey + p.pey2 * dfz) * (1.0 - (p.pey3 + p.pey4 * gamma) * sign(ay));
    const double fy0 = (ay != 0.0 ? mf(ay, By, p.cy, Dy, ey) : 0.0) + svy;

    // Combined-slip weighting functions Gxa, Gyk + kappa-induced side force SVyk (MF 5.2 eqs. 4.E50-4.E66)
    double gxa = 1.0;
    if (std::abs(raw_alpha) > 1e-7) {
        const double bxa = pre.rbx_g * cos_atan(p.rbx2 * raw_kappa);
        const double exa = p.rex1 + p.rex2 * dfz;
        const double gxa0 = (p.rhx1 == 0.0) ? 1.0 : std::max(mf_cos(p.rhx1, bxa, p.rcx1, exa), 1e-4);
        gxa = clamp(mf_cos(raw_alpha + p.rhx1, bxa, p.rcx1, exa) / gxa0, 0.0, 1.0);
    }

    const double shyk = p.rhy1 + p.rhy2 * dfz + (mf62_hybrid ? 0.022 * gamma : 0.0);
    double gyk = 1.0;
    if (std::abs(raw_kappa) > 1e-7) {
        const double byk = pre.rby_g * cos_atan(p.rby2 * (raw_alpha - p.rby3));
        const double eyk = p.rey1 + p.rey2 * dfz;
        const double gyk0 = (shyk == 0.0) ? 1.0 : std::max(mf_cos(shyk, byk, p.rcy1, eyk), 1e-4);
        gyk = clamp(mf_cos(raw_kappa + shyk, byk, p.rcy1, eyk) / gyk0, 0.0, 1.0);
    }

    double svyk = 0.0;
    if (std::abs(raw_kappa) > 1e-7) {
        const double rvy_coeff = p.rvy1 + p.rvy2 * dfz + p.rvy3 * gamma;
        if (std::abs(rvy_coeff) > 1e-9) {
            const double dvyk = mu_y * fz_eq * rvy_coeff * cos_atan(p.rvy4 * raw_alpha);
            svyk = dvyk * std::sin(p.rvy5 * std::atan(p.rvy6 * raw_kappa));
        }
    }

    double fx = fx0 * gxa;
    double fy_no_svyk = fy0 * gyk;
    double fy = fy_no_svyk + svyk;

    // Friction-ellipse envelope protection (Dugoff / MF combined saturation bound)
    const double dx_max = std::max({Dx, std::abs(fx0), 1e-6});
    const double dy_max = std::max({Dy, std::abs(fy0), 1e-6});
    const double ex_r = fx / dx_max, ey_r = fy / dy_max;
    const double e2 = ex_r * ex_r + ey_r * ey_r;
    if (e2 > 1.0) {
        const double inv_e = 1.0 / std::sqrt(e2);
        fx *= inv_e;
        fy *= inv_e;
        fy_no_svyk *= inv_e;
    }

    out.fx_per_fz = fx * inv_fz;
    out.fy_per_fz = fy * inv_fz;
    out.fy_nosvyk_per_fz = fy_no_svyk * inv_fz;
    return out;
}

}  // namespace

double contact_patch_half_length(const TireParams& p, double fz, double dpi) {
    if (fz <= 0.0 || p.vertical_stiffness <= 0.0) return 0.0;
    // Pacejka Ch. 3 / MF-Swift radial deflection -> geometric chord contact half-length:
    //   C_Fz(p) = C_Fz0 * (1 + PFZ1 * dpi),  rho = Fz / C_Fz(p),  a = sqrt(2 R0 rho - rho^2).
    const double press_stiff = clamp(1.0 + p.pfz1 * dpi, 0.55, 1.55);
    const double c_fz = std::max(50000.0, p.vertical_stiffness * press_stiff);
    const double rho = clamp(fz / c_fz, 0.0, 0.35 * p.radius);
    const double a = std::sqrt(std::max(0.0, 2.0 * p.radius * rho - rho * rho));
    return clamp(a, 0.025, 0.45 * p.radius);
}

double rolling_resistance_coeff(const TireParams& p, double speed_mps, double dpi) {
    // SAE J2452 / Pacejka Ch. 9 inflation-pressure and speed-dependent rolling resistance:
    //   C_rr(v, P) = (c_rr0 + c_rr2 * (v / 30)^2) * (P_abs / P_nom_abs)^(-0.5)
    // Higher inflation pressure reduces sidewall flexing hysteresis -> lower rolling resistance.
    constexpr double kPAtmKpa = 101.325;
    const double p_nom_abs = std::max(p.p_nominal_kpa + kPAtmKpa, 100.0);
    const double p_abs_ratio = clamp((p.p_nominal_kpa * (1.0 + dpi) + kPAtmKpa) / p_nom_abs, 0.55, 1.65);
    const double vn = speed_mps / 30.0;
    return (p.rolling_resistance + p.rolling_resistance_v2 * vn * vn) / std::sqrt(p_abs_ratio);
}

double stribeck_friction_factor(const TireParams& p, double slip_speed_mps, double surface_c, double flash_c) {
    // Smooth C-infinity Stribeck static-to-kinetic sliding friction transition (Armstrong-Helouvry 1994;
    // Persson 2001 Theory of Rubber Friction) coupled with Pacejka MF 6.1 LMUV high-speed decay and
    // immediate tread surface / micro-asperity flash thermal greasiness.
    // Normalized to 1.0 at v_ref = p.lmuv_ref_mps (normal cornering) and default optimal surface/flash temps.
    const double vs = std::abs(slip_speed_mps);
    double speed_factor = 1.0;
    if (p.lmuv > 0.0) {
        const double lmuv_norm = clamp(p.lmuv / 0.12, 0.0, 3.0);
        const double delta_mu = clamp(0.105 * lmuv_norm, 0.0, 0.30);
        constexpr double v_stribeck = 6.5; // m/s characteristic transition speed (inflection ~3.75 m/s)
        auto curve = [&](double v) {
            const double vr = v / v_stribeck;
            const double stribeck = (1.0 - delta_mu) + delta_mu / (1.0 + vr * vr);
            const double high_v_tail = 1.0 / (1.0 + 0.45 * p.lmuv * v / 16.7);
            return stribeck * high_v_tail;
        };
        const double v_ref = std::max(0.0, p.lmuv_ref_mps);
        speed_factor = curve(vs) / std::max(curve(v_ref), 1e-6);
    }

    // Immediate surface & flash thermal greasiness: C1-smooth roll-off above compound operating ceiling
    // (produces progressive, controllable drift slip when rear tread overheats during sustained slides).
    const double t_ceil = p.temp_optimal_c + p.temp_window_c;
    const double ds = std::max(0.0, surface_c - (t_ceil + 10.0));
    const double surf_grease = 1.0 - 0.12 * (ds * ds) / (ds * ds + 40.0 * 40.0);
    const double df = std::max(0.0, flash_c - (t_ceil + 30.0));
    const double flash_grease = 1.0 - 0.10 * (df * df) / (df * df + 45.0 * 45.0);

    return speed_factor * surf_grease * flash_grease;
}

double TireCondition::ideal_gas_pressure_kpa(const TireParams* p) const {
    // Ideal gas law for constant tyre cavity volume: P_abs / T_K = P_cold_abs / T_cold_K
    // Cold reference temperature T_cold = 20 C (293.15 K), standard atmospheric pressure = 101.325 kPa.
    constexpr double kPAtmKpa = 101.325;
    constexpr double kTColdK = 293.15;
    const double p_cold = p ? p->p_cold_kpa : 188.0;
    const double t_air_k = clamp(inner_air_c, -40.0, 200.0) + 273.15;
    return (p_cold + kPAtmKpa) * (t_air_k / kTColdK) - kPAtmKpa;
}

void TireCondition::update(double slip_power_w, double load_n, double speed_mps, double dt, const TireParams* p) {
    if (dt <= 0) return;
    // Explicit 3-node lumped-capacitance thermal network (Kelly & Sharp 2010; Farroni et al. 2014):
    //   Node 1 (Surface, Ts):   C_s dTs/dt = P_slip - G_sc (Ts - Tc) - h_a(v) (Ts - T_air) - g_road (Ts - T_track)
    //   Node 2 (Carcass, Tc):   C_c dTc/dt = G_sc (Ts - Tc) + P_hyst(p, Fz, v) - G_cg (Tc - Tg) - k_c(v) C_c (Tc - T_eq)
    //   Node 3 (Inner Air, Tg): C_g dTg/dt = G_cg (Tc - Tg) - G_rim(v) (Tg - T_air)
    // Frictional slip work heats the outer 2-3 mm tread surface immediately; rolling hysteresis flexing (which rises
    // when under-inflated) heats the carcass; heat conducts Surface <-> Carcass <-> Inner Air; Inner Air sets inflation
    // pressure directly via the ideal gas law.
    const bool inner_air_mutated = std::abs(inner_air_c - last_inner_air_c_) > 1e-6;
    const bool carcass_teleported = std::abs(temperature_c - last_carcass_c_) > 10.0;
    if (!inner_air_mutated && carcass_teleported) {
        inner_air_c = clamp(0.45 * ambient_air_c + 0.55 * temperature_c, -25.0, 160.0);
    }

    constexpr double Cs = 1500.0;   // J/K, outer 2-3 mm tread surface layer
    constexpr double Cc = 16000.0;  // J/K, steel belt & rubber carcass bulk
    constexpr double Cg = 260.0;    // J/K, cavity inflation gas + inner-liner thermal boundary layer
    constexpr double G_sc = 400.0;  // W/K, conduction Surface <-> Carcass
    constexpr double G_cg = 45.0;   // W/K, conduction/convection Carcass <-> Inner Air

    const double Tair = ambient_air_c;
    const double Ttrack = track_surface_c;
    const double Teq = 78.0 + 0.35 * (0.5 * (Tair + Ttrack) - 30.0);
    const double v = std::abs(speed_mps);
    const double ha_total = 20.0 + 2.5 * v;                 // W/K, surface convective air cooling
    // Solid-to-solid conductive heat transfer between loaded contact patch and asphalt road surface
    const double g_road = (std::abs(Ttrack - Tair) > 1e-4 && load_n > 50.0)
                        ? 38.0 * clamp(load_n / 4000.0, 0.0, 1.6) : 0.0;
    const double ha = std::max(5.0, ha_total - g_road * 0.45);
    const double kc = 0.012 + 0.0012 * v;                   // 1/s, sidewall convective relaxation toward rolling equilibrium
    const double G_rim = 18.0 + 0.65 * v;                   // W/K, Inner Air <-> wheel rim / ambient airflow exchange

    // Pressure-coupled rolling hysteresis power: under-inflated tyres flex more and generate more carcass heat
    const double cur_dpi = (p && pressure_kpa > 0.0) ? dpi(*p) : 0.0;
    const double p_nom_abs = p ? std::max(p->p_nominal_kpa + 101.325, 100.0) : 321.325;
    const double p_abs_ratio = clamp(((p ? p->p_nominal_kpa : 220.0) * (1.0 + cur_dpi) + 101.325) / p_nom_abs, 0.55, 1.65);
    const double hyst = 0.012 * load_n * v / std::sqrt(p_abs_ratio);

    // Integrate in <= 50 ms sub-steps (max eigenvalue ~0.45 /s -> stable with large margin)
    const int n = std::max(1, (int)std::ceil(dt / 0.05));
    const double h = dt / n;
    for (int i = 0; i < n; ++i) {
        const double ts = surface_c, tc = temperature_c, tg = inner_air_c;
        const double q_sc = G_sc * (ts - tc);
        const double q_cg = G_cg * (tc - tg);
        const double dts = (slip_power_w - q_sc - ha * (ts - Tair) - g_road * (ts - Ttrack)) / Cs;
        const double dtc = (q_sc + hyst - q_cg) / Cc - kc * (tc - Teq);
        const double dtg = (q_cg - G_rim * (tg - Tair)) / Cg;
        surface_c = clamp(ts + dts * h, -15.0, 260.0);
        temperature_c = clamp(tc + dtc * h, -15.0, 180.0);
        inner_air_c = clamp(tg + dtg * h, -25.0, 160.0);
    }

    // Ideal gas law directly from Node 3 (Inner Air temperature)
    pressure_kpa = ideal_gas_pressure_kpa(p);
    if (p && load_n > 0.0) {
        contact_patch_length_m = 2.0 * contact_patch_half_length(*p, load_n, dpi(*p));
    }

    // Wear: sliding work above normal cornering
    if (slip_power_w > 18000.0) wear = clamp(wear + (slip_power_w - 18000.0) * 1.2e-9 * dt, 0.0, 1.0);
    // Keep 3-zone surface temperatures synchronized toward surface_c when update() is called directly
    if (imo_spread_c() < 1e-9) {
        inner_c = middle_c = outer_c = surface_c;
    } else {
        const double alpha_sync = clamp(dt * 1.5, 0.0, 1.0);
        inner_c += (surface_c - inner_c) * alpha_sync;
        middle_c += (surface_c - middle_c) * alpha_sync;
        outer_c += (surface_c - outer_c) * alpha_sync;
    }
    flash_c = surface_c;
    last_carcass_c_ = temperature_c;
    last_inner_air_c_ = inner_air_c;
}

void TireCondition::update_zones(double slip_power_w, double load_n, double speed_mps, double camber_rad,
                                 double lateral_force_n, double wheel_side_sign, double wheel_omega_rads,
                                 double wheel_angle_rad, double dt, const TireParams* p) {
    if (dt <= 0) return;
    const double ts_before = surface_c;
    const double tc_before = temperature_c;
    if (imo_spread_c() < 1e-9 && std::abs(middle_c - surface_c) > 1e-6) {
        inner_c = middle_c = outer_c = surface_c;
    }
    const double z_in0 = inner_c, z_mid0 = middle_c, z_out0 = outer_c;

    update(slip_power_w, load_n, speed_mps, dt, p);

    inner_c = z_in0;
    middle_c = z_mid0;
    outer_c = z_out0;

    // 3-zone lateral heat distribution across Inner / Middle / Outer tread surface ribs (Surface Node)
    const double p_nom = p ? std::max(p->p_nominal_kpa, 1.0) : 220.0;
    const double rel_dpi = pressure_kpa > 0.0 ? clamp((pressure_kpa - p_nom) / p_nom, -0.5, 0.5) : 0.0;
    const double fz_ref = p ? std::max(p->fz0, 1000.0) : 4000.0;

    // Negative top-inward tilt (-wheel_side_sign * camber_rad < 0, e.g. negative static camber) biases straight-line heating onto inner_c
    const double top_inward_rad = std::max(-camber_rad, wheel_side_sign * camber_rad);
    const double camber_bias = clamp(top_inward_rad * 9.0, -0.75, 0.75);

    // Hard cornering load shifts heating onto outer_c
    const double lat_ratio = std::abs(lateral_force_n) / fz_ref;
    const double outside_mult = (lateral_force_n * wheel_side_sign < 0.0) ? 1.25 : 1.0;
    const double corner_bias = clamp(lat_ratio * 1.10 * outside_mult, 0.0, 1.05);

    const double net_in_out = clamp(camber_bias - corner_bias, -0.82, 0.82);

    // High inflation pressure (dpi > 0.08) crowns center rib and biases heating toward middle_c
    const double mid_bias = rel_dpi > 0.08 ? clamp((rel_dpi - 0.08) * 1.8, 0.04, 0.40) : 0.0;

    double w_mid = (1.0 + 2.0 * mid_bias) * (0.4 + 1.8 * rib_contact_shares[1]);
    double w_in = clamp(1.0 + net_in_out - mid_bias, 0.12, 2.6) * (0.4 + 1.8 * rib_contact_shares[0]);
    double w_out = clamp(1.0 - net_in_out - mid_bias, 0.12, 2.6) * (0.4 + 1.8 * rib_contact_shares[2]);
    const double w_sum = w_in + w_mid + w_out;
    w_in *= 3.0 / w_sum;
    w_mid *= 3.0 / w_sum;
    w_out *= 3.0 / w_sum;

    constexpr double Cs = 1500.0, G = 400.0, G_zone = 90.0;
    const double Tair = ambient_air_c;
    const double Ttrack = track_surface_c;
    const double v = std::abs(speed_mps);
    const double ha_total = 20.0 + 2.5 * v;
    const double g_road = (std::abs(Ttrack - Tair) > 1e-4 && load_n > 50.0)
                        ? 38.0 * clamp(load_n / 4000.0, 0.0, 1.6) : 0.0;
    const double ha = std::max(5.0, ha_total - g_road * 0.45);
    const double q_asym = std::max(0.0, slip_power_w) + 0.018 * std::max(0.0, load_n) * v;
    const double q_in = slip_power_w + (w_in - 1.0) * q_asym;
    const double q_mid = slip_power_w + (w_mid - 1.0) * q_asym;
    const double q_out = slip_power_w + (w_out - 1.0) * q_asym;

    const int n = std::max(1, (int)std::ceil(dt / 0.05));
    const double h = dt / n;
    for (int i = 0; i < n; ++i) {
        const double frac = (double)(i + 1) / n;
        const double tc = tc_before + (temperature_c - tc_before) * frac;
        const double ts = ts_before + (surface_c - ts_before) * frac;
        const double ti = inner_c, tm = middle_c, to = outer_c;
        const double dti = (q_in - G * (ti - tc) - ha * (ti - Tair) - g_road * w_in * (ti - Ttrack) - G_zone * (ti - ts)) / Cs;
        const double dtm = (q_mid - G * (tm - tc) - ha * (tm - Tair) - g_road * w_mid * (tm - Ttrack) - G_zone * (tm - ts)) / Cs;
        const double dto = (q_out - G * (to - tc) - ha * (to - Tair) - g_road * w_out * (to - Ttrack) - G_zone * (to - ts)) / Cs;
        inner_c = clamp(ti + dti * h, -15.0, 260.0);
        middle_c = clamp(tm + dtm * h, -15.0, 260.0);
        outer_c = clamp(to + dto * h, -15.0, 260.0);
    }
    surface_c = (inner_c + middle_c + outer_c) / 3.0;

    // WLF Micro-Asperity Flash Temperature (~8 ms thermal relaxation time constant):
    // Spikes +20..+50 C in milliseconds at the onset of high-power sliding and cools back to surface_c in ~15 ms.
    const double flash_steady_rise = clamp(std::max(0.0, slip_power_w) / 950.0, 0.0, 58.0);
    const double flash_target = surface_c + flash_steady_rise;
    const double alpha_flash = 1.0 - std::exp(-dt / 0.008);
    flash_c = clamp(flash_c + (flash_target - flash_c) * alpha_flash, 10.0, 310.0);

    // Brake-lockup flat-spotting
    if (v > 8.0 && load_n > 800.0 && std::abs(wheel_omega_rads) < 1.2) {
        flat_spot_depth_mm = clamp(flat_spot_depth_mm + (std::max(0.0, slip_power_w) / 22000.0) * 0.45 * dt, 0.0, 3.0);
        flat_spot_phase_rad = std::fmod(wheel_angle_rad, 2.0 * kPi);
    } else if (std::abs(wheel_omega_rads) > 15.0) {
        flat_spot_depth_mm = clamp(flat_spot_depth_mm - 0.002 * dt, 0.0, 3.0);
    }

    // Blistering & Graining
    const double max_core_c = std::max(tc_before, temperature_c);
    const double max_surf_c = std::max({ts_before, surface_c, inner_c, middle_c, outer_c});
    if (max_core_c > 118.0 && max_surf_c > 145.0) {
        blistering = clamp(blistering + 0.015 * dt, 0.0, 1.0);
    }
    if (std::min(tc_before, temperature_c) < 58.0 && slip_power_w > 12000.0) {
        graining = clamp(graining + 0.02 * dt, 0.0, 1.0);
    } else if (temperature_c >= 75.0 && temperature_c <= 105.0) {
        graining = clamp(graining - 0.01 * dt, 0.0, 1.0);
    }
    last_carcass_c_ = temperature_c;
    last_inner_air_c_ = inner_air_c;
}

double TireCondition::flat_spot_ffb_torque_nm(double wheel_angle_rad, double load_n, double speed_mps) const {
    if (flat_spot_depth_mm <= 0.05 || std::abs(speed_mps) <= 2.0 || load_n <= 0.0) return 0.0;
    const double speed_scale = clamp((std::abs(speed_mps) - 2.0) / 18.0, 0.15, 1.5);
    const double c1 = std::cos(wheel_angle_rad - flat_spot_phase_rad);
    const double pulse = std::exp(-3.0 * (1.0 - c1)) * c1;
    return 3.5 * flat_spot_depth_mm * (load_n / 4000.0) * speed_scale * pulse;
}

double TireCondition::zone_health_grip_factor() const {
    const double blister_loss = 0.08 * clamp(blistering, 0.0, 1.0);
    const double grain_loss = 0.06 * clamp(graining, 0.0, 1.0);
    const double spread = imo_spread_c();
    const double spread_loss = spread > 28.0 ? 0.04 * clamp((spread - 28.0) / 22.0, 0.0, 1.0) : 0.0;
    return clamp(1.0 - blister_loss - grain_loss - spread_loss, 0.82, 1.0);
}

double TireCondition::wlf_rib_grip_factor(double rib_surface_c, const TireParams* p) const {
    // Williams-Landel-Ferry (WLF) viscoelastic log-shift equation:
    //   log10(a_T) = -C1 * (T_eff - T_opt) / (C2 + (T_eff - T_opt)),  C1 = 8.86, C2 = 101.6 K
    // Evaluates local rib + micro-asperity flash temperature relative to the compound's viscoelastic loss peak.
    const double t_opt = p ? p->temp_optimal_c : 90.0;
    const double w = p ? std::max(p->temp_window_c, 15.0) : 25.0;
    const double t_eff = 0.48 * temperature_c + 0.34 * rib_surface_c + 0.18 * flash_c;
    const double dt_c = clamp(t_eff - t_opt, -75.0, 140.0);
    const double wlf_shift = (-8.86 * dt_c) / (101.6 + dt_c);
    // Gaussian viscoelastic master envelope in WLF reduced-frequency space: smooth progressive roll-off at high flash temp
    const double norm_shift = wlf_shift / (8.86 * w / (101.6 + w));
    double wlf_grip = 1.0;
    if (std::abs(dt_c) > w * 0.65) {
        const double excess = (std::abs(norm_shift) - 0.65);
        wlf_grip = clamp(std::exp(-0.085 * excess * excess), 0.80, 1.0);
    }
    const double flash_grease = flash_c > 155.0 ? clamp(1.0 - 0.0014 * (flash_c - 155.0), 0.86, 1.0) : 1.0;
    return wlf_grip * flash_grease;
}

void TireCondition::step_rigid_ring_belt(double fx_n, double fy_n, double radius_m, double dt, const TireParams* p) {
    if (dt <= 0.0) return;
    // Simcenter Tire 2606 MF-Swift Rigid-Ring Belt Model:
    // Steel-belted tread ring (m_belt from measured PAC2002 MBELT = 5.4 kg for 245/40 R18, scaled by tire width/radius)
    // suspended on elastic sidewalls whose stiffness scales inversely with aspect ratio (shorter 30-series sidewall = stiffer):
    //   In-plane torsional eigenfrequency:  f_nx = 1/(2 pi) * sqrt(k_torsion / I_belt) ~ 72-82 Hz
    //   Out-of-plane lateral eigenfrequency: f_ny = 1/(2 pi) * sqrt(k_lat / m_belt)     ~ 45-52 Hz
    const double r = std::max(radius_m, 0.20);
    const double m_belt = p ? clamp(p->mbelt, 3.5, 10.5) : 5.4;
    const double I_belt = std::max(0.28, m_belt * r * r * 0.68);
    const double ar_stiff = p ? clamp(0.40 / std::max(p->aspect_ratio, 0.22), 0.75, 1.45) : 1.0;
    const double k_tor = 90000.0 * ar_stiff, c_tor = 52.0 * std::sqrt(ar_stiff);
    const double k_lat = 590000.0 * ar_stiff, c_lat = 360.0 * std::sqrt(ar_stiff);
    const int n_sub = std::max(1, (int)std::ceil(dt / 0.0005)); // >= 2 kHz integration for 72-82 Hz ring mode stability
    const double h = dt / n_sub;
    for (int i = 0; i < n_sub; ++i) {
        const double tau_belt = fx_n * r * 0.12 - k_tor * belt_torsion_rad - c_tor * belt_torsion_vel_rads;
        belt_torsion_vel_rads = clamp(belt_torsion_vel_rads + (tau_belt / I_belt) * h, -35.0, 35.0);
        belt_torsion_rad = clamp(belt_torsion_rad + belt_torsion_vel_rads * h, -0.045, 0.045);

        const double f_lat_belt = fy_n * 0.15 - k_lat * belt_lateral_m - c_lat * belt_lateral_vel_mps;
        belt_lateral_vel_mps = clamp(belt_lateral_vel_mps + (f_lat_belt / m_belt) * h, -3.5, 3.5);
        belt_lateral_m = clamp(belt_lateral_m + belt_lateral_vel_mps * h, -0.022, 0.022);
    }
}

double TireCondition::thermal_stiffness_factor(const TireParams* p) const {
    // Simcenter Tire 2606 T&V (Temperature & Velocity) Stiffness Coupling:
    // Cold rubber (< 55 C) has a higher glassy storage shear modulus G' (+11% higher cornering/slip stiffness slope at small
    // slip angles before breaking away sharply); overheated rubber (> 110 C) softens thermally (-16% lower cornering stiffness).
    const double t_opt = p ? p->temp_optimal_c : 90.0;
    const double t_blend = 0.60 * temperature_c + 0.40 * surface_c;
    const double dt_c = clamp(t_blend - t_opt, -65.0, 85.0);
    return clamp(1.0 - 0.0019 * dt_c, 0.84, 1.12);
}

TireAcousticSource TireCondition::compute_acoustics(double wheel_omega_rads, double radius_m,
                                                    double carcass_deflection_rate_mps) const {
    TireAcousticSource ac;
    const double r_mean = std::max(0.18, radius_m * 0.78);
    // Speed of sound in enclosed tire cavity gas c_s ~ 343.2 * sqrt(T_inner_air_K / 293.15)
    const double t_gas_k = clamp(inner_air_c, -20.0, 160.0) + 273.15;
    const double c_sound = 343.2 * std::sqrt(t_gas_k / 293.15);
    const double f0_cavity = c_sound / (2.0 * kPi * r_mean); // ~220-238 Hz toroidal cavity fundamental
    // Simcenter 2606 Doppler frequency split between forward- and backward-traveling acoustic waves in a rotating tire:
    const double doppler_hz = std::abs(wheel_omega_rads) / kPi;
    ac.cavity_mode_low_hz = std::max(120.0, f0_cavity - doppler_hz);
    ac.cavity_mode_high_hz = f0_cavity + doppler_hz;
    ac.tread_block_pitch_hz = 64.0 * (std::abs(wheel_omega_rads) / (2.0 * kPi)); // 64 tread pitch blocks around circumference
    // Broadband transient volume-displacement acceleration (m^3/s^2) excited by curb strikes & MF-Swift belt ring vibration
    const double vib_energy = std::abs(carcass_deflection_rate_mps) * 1.8 + std::abs(belt_torsion_vel_rads) * 0.08
                            + std::abs(belt_lateral_vel_mps) * 0.45;
    ac.transient_volume_accel = vib_energy * 0.045;
    ac.cavity_ring_gain = clamp(vib_energy * 0.32, 0.0, 1.0);
    return ac;
}

double TireCondition::dpi(const TireParams& p) const {
    if (pressure_kpa <= 0) return 0.0;
    return clamp((pressure_kpa - p.p_nominal_kpa) / std::max(p.p_nominal_kpa, 1.0), -0.5, 0.5);
}

double TireCondition::grip_factor(const TireParams* p) const {
    // The compound works in a window around T_opt of the carcass/surface blend (contact patch feels the surface
    // immediately; bulk viscoelastic hysteresis tracks the carcass). Overheated tread surface becomes greasy
    // immediately above T_opt + window via a smooth C1 curve until it cools back into the window.
    const double t_opt = p ? p->temp_optimal_c : 90.0, w = p ? p->temp_window_c : 25.0;
    const double t = 0.55 * temperature_c + 0.45 * surface_c;
    double temp_grip = 1.0;
    if (t < t_opt - w) { double d = (t_opt - w - t) / 60.0; temp_grip = std::max(0.85, 1.0 - 0.14 * d * d - 0.02 * d); }
    else if (t > t_opt + w) { double d = (t - t_opt - w) / 50.0; temp_grip = std::max(0.82, 1.0 - 0.14 * d * d); }
    // Immediate surface overheating greasiness (smooth C1 rational roll-off above t_opt + w)
    const double ds = std::max(0.0, surface_c - (t_opt + w));
    const double grease = 1.0 - 0.18 * (ds * ds) / (ds * ds + 38.0 * 38.0);
    double wear_grip = 1.0 - 0.15 * wear * wear;
    return temp_grip * grease * wear_grip * zone_health_grip_factor();
}

double effective_rolling_radius(const TireParams& p, double fz) {
    if (fz <= 0 || p.vertical_stiffness <= 0) return p.radius;
    // Pacejka Ch. 4 eq. 4.E7 / PAC2002 / Simcenter Tire 2606 non-linear effective rolling radius:
    //   delta_Re(fz_norm) = rho_Fz0 * (DREFF * atan(BREFF * fz_norm) + FREFF * fz_norm),  rho_Fz0 = Fz0 / C_Fz0
    // Anchored at p.radius (reference rolling radius at nominal load fz_norm = 1):
    const double fz0 = std::max(p.fz0, 100.0);
    const double rho_fz0 = fz0 / p.vertical_stiffness;
    const double fz_norm = fz / fz0;
    const double comp_at_fz  = rho_fz0 * (p.dreff * std::atan(p.breff * fz_norm) + p.freff * fz_norm);
    const double comp_at_fz0 = rho_fz0 * (p.dreff * std::atan(p.breff) + p.freff);
    return clamp(p.radius - (comp_at_fz - comp_at_fz0), p.radius * 0.85, p.radius * 1.05);
}

double effective_rolling_radius_mf62(const TireParams& p, double fz, double gamma, double dpi, double wheel_omega_rads) {
    // 1. MF 6.2 / Simcenter Tire 2606 pressure-dependent vertical carcass stiffness C_Fz(p) = C_Fz0 * (1 + PFZ1 * dpi):
    const double press_stiff = clamp(1.0 + p.pfz1 * dpi, 0.55, 1.55);
    TireParams p_eff = p;
    p_eff.vertical_stiffness = std::max(50000.0, p.vertical_stiffness * press_stiff);
    const double re0 = effective_rolling_radius(p_eff, fz);
    // 2. Simcenter 2606 high-speed centrifugal steel-belt radial growth (~2-4 mm expansion at 300 km/h from MBELT = 5.4 kg):
    const double v_rim = p.radius * std::abs(wheel_omega_rads);
    const double centrifugal_growth = clamp(0.16 * p.mbelt * v_rim * v_rim / p_eff.vertical_stiffness, 0.0, 0.0055);
    // 3. MF 6.2 camber-conicity asymmetric loaded radius: under inclination gamma, the contact patch shifts toward the
    // tilted shoulder on a cone of half-width ~section_width/2, reducing effective rolling radius by sin^2(gamma) & |sin(gamma)|.
    const double s_g = std::sin(clamp(gamma, -0.45, 0.45));
    const double w_scale = clamp(p.section_width_m / 0.245, 0.75, 1.45);
    const double camber_delta = (re0 * 0.042 * s_g * s_g + 0.011 * std::abs(s_g)) * w_scale;
    return clamp(re0 + centrifugal_growth - camber_delta, p.radius * 0.82, p.radius * 1.06);
}

void relaxation_lengths(const TireParams& p, double fz, double gamma, double& sigma_x, double& sigma_y, double dpi) {
    if (fz <= 0) {
        sigma_x = p.relax_x;
        sigma_y = p.relax_y;
        return;
    }
    // Pacejka Ch. 7 stretched-string compliance + PAC2002 / MF-Swift empirical PTX1..3 & PTY1..2 load/camber/pressure laws:
    //   sigma_x(Fz) ~ (PTX1 + PTX2 * dfz) * exp(-PTX3 * dfz) * (Fz / Fz0)
    //   sigma_y(Fz, gamma) ~ PTY1 * sin(2 * atan(Fz / (PTY2 * Fz0 * (1 + PPY2 * dpi)))) * (1 - PKY3 * |gamma|)
    // Modulated by sidewall aspect ratio (lower-profile 30-series tires have shorter, faster relaxation lengths).
    const double dfz = dfz_of(p, fz);
    const double kx0 = std::max(kx_of(p, p.fz0, 0.0), 1.0);
    const double ky0 = std::max(ky_of(p, p.fz0, 0.0), 1.0);
    const double kx = kx_of(p, fz, dfz, dpi);
    const double ky = ky_of(p, fz, gamma, dpi);
    const double str_ratio_x = kx / kx0;
    const double str_ratio_y = ky / ky0;

    const double fz_ratio = fz / std::max(p.fz0, 100.0);
    const double ptx_ref = std::max(p.ptx1, 0.2);
    const double ptx_val = std::max(0.2, p.ptx1 + p.ptx2 * dfz) * std::exp(clamp(-p.ptx3 * dfz, -1.0, 1.0)) * fz_ratio;
    const double emp_ratio_x = ptx_val / ptx_ref;

    const double pty2_eff = std::max(0.4, p.pty2 * std::max(0.3, 1.0 + p.ppy2 * dpi));
    const double pty_ref = std::max(0.2, std::sin(2.0 * std::atan(1.0 / std::max(p.pty2, 0.4))));
    const double pty_val = std::sin(2.0 * std::atan(fz_ratio / pty2_eff)) * std::max(0.2, 1.0 - p.pky3 * std::abs(gamma));
    const double emp_ratio_y = pty_val / pty_ref;

    const double ar_scale = clamp(p.aspect_ratio / 0.40, 0.78, 1.22);
    sigma_x = clamp(p.relax_x * ar_scale * (0.5 * str_ratio_x + 0.5 * emp_ratio_x), 0.03, p.relax_x * 2.5);
    sigma_y = clamp(p.relax_y * ar_scale * (0.5 * str_ratio_y + 0.5 * emp_ratio_y), 0.05, p.relax_y * 2.5);
}

double mf_pure_fx(const TireParams& p, double kappa, double fz, double mu_scale, double gamma, double dpi) {
    if (fz <= 0) return 0;
    double dfz = dfz_of(p, fz);
    // Load, camber and pressure sensitivity (MF 6.1 eq. 4.E13). Note: in our config, p.pdx2 is normalised by p.mu_x.
    double mu = mu_x_of(p, dfz, gamma, mu_scale, dpi);
    double D = mu * fz;
    double K = kx_of(p, fz, dfz, dpi);
    double B = K / (p.cx * D + 1e-9);
    double shx = p.phx1 + p.phx2 * dfz;
    double svx = fz * (p.pvx1 + p.pvx2 * dfz) * mu_scale;
    double kx = kappa + shx;
    // Load-dependent curvature E_x (MF 5.2 eq. 4.E12):
    double ex = (p.ex + p.pex2 * dfz + p.pex3 * dfz * dfz) * (1.0 - p.pex4 * sign(kx));
    return mf(kx, B, p.cx, D, ex) + svx;
}

double mf_pure_fy(const TireParams& p, double alpha, double fz, double mu_scale, double gamma, double dpi) {
    if (fz <= 0) return 0;
    double dfz = dfz_of(p, fz);
    // Lateral friction coefficient with load, camber and pressure sensitivity (MF 6.1 eq. 4.E23)
    double mu = mu_y_of(p, dfz, gamma, mu_scale, dpi);
    double D = mu * fz;
    double K = ky_of(p, fz, gamma, dpi);
    double B = K / (p.cy * D + 1e-9);
    // Camber shifts (camber thrust, MF 5.2 eqs. 4.E27-4.E28):
    double shy = (p.phy1 + p.phy2 * dfz) + p.phy3 * gamma;
    double svy = fz * ((p.pvy1 + p.pvy2 * dfz) + (p.pvy3 + p.pvy4 * dfz) * gamma) * mu_scale;
    double ay = alpha + shy;
    // Load- and camber-dependent curvature E_y (MF 5.2 eq. 4.E24):
    double ey = (p.ey + p.pey2 * dfz) * (1.0 - (p.pey3 + p.pey4 * gamma) * sign(ay));
    return mf(ay, B, p.cy, D, ey) + svy;
}

double mf_aligning_torque(const TireParams& p, double kappa, double alpha, double fz, double mu_scale, double gamma,
                          double fx, double fy_no_svyk, double* out_trail) {
    if (fz <= 0) {
        if (out_trail) *out_trail = 0;
        return 0;
    }
    double dfz = dfz_of(p, fz);
    double mu_s = std::max(mu_scale, 0.1);
    double kx = kx_of(p, fz, dfz);
    double ky = std::max(ky_of(p, fz, gamma), 1.0);
    double k_ratio = kx / ky;

    // 1. Pneumatic trail t(alpha_t,eq) (MF 5.2 eqs. 4.E33-4.E42, 4.E73):
    double sht = p.qhz1 + p.qhz2 * dfz + (p.qhz3 + p.qhz4 * dfz) * gamma;
    double alpha_t = alpha + sht;
    double tan_at = std::tan(clamp(alpha_t, -1.4, 1.4));
    double alpha_teq = std::atan(std::hypot(tan_at, k_ratio * kappa)) * (alpha_t >= 0 ? 1.0 : -1.0);
    double Bt = std::max(0.5, (p.qbz1 + p.qbz2 * dfz + p.qbz3 * dfz * dfz) * (1.0 + p.qbz4 * gamma + p.qbz5 * std::abs(gamma))) / mu_s;
    double Ct = p.qcz1;
    double Dt = fz * (p.radius / std::max(p.fz0, 1.0)) * (p.qdz1 + p.qdz2 * dfz) * (1.0 + p.qdz3 * gamma + p.qdz4 * gamma * gamma);
    double Et = (p.qez1 + p.qez2 * dfz + p.qez3 * dfz * dfz) *
                (1.0 + (p.qez4 + p.qez5 * gamma) * (2.0 / kPi) * std::atan(Bt * Ct * alpha_teq));
    double trail = Dt * mf_cos(alpha_teq, Bt, Ct, Et) * std::cos(alpha);
    if (out_trail) *out_trail = trail;

    // 2. Residual torque M_zr(alpha_r,eq) (MF 5.2 eqs. 4.E43-4.E47, 4.E74):
    double shy = (p.phy1 + p.phy2 * dfz) + p.phy3 * gamma;
    double svy = fz * ((p.pvy1 + p.pvy2 * dfz) + (p.pvy3 + p.pvy4 * dfz) * gamma) * mu_scale;
    double shf = shy + svy / ky;
    double alpha_r = alpha + shf;
    double tan_ar = std::tan(clamp(alpha_r, -1.4, 1.4));
    double alpha_req = std::atan(std::hypot(tan_ar, k_ratio * kappa)) * (alpha_r >= 0 ? 1.0 : -1.0);
    double mu_y = p.mu_y * std::max(0.2, 1.0 + p.pdy2 * dfz) * std::max(0.2, 1.0 - p.pdy3 * gamma * gamma) * mu_scale;
    double By = ky / (p.cy * mu_y * fz + 1e-9);
    double Br = p.qbz9 / mu_s + p.qbz10 * By * p.cy;
    double Dr = fz * p.radius * ((p.qdz6 + p.qdz7 * dfz) + (p.qdz8 + p.qdz9 * dfz) * gamma) * mu_scale * std::cos(alpha);
    double mzr = Dr * std::cos(std::atan(Br * alpha_req));

    // 3. Moment arm s of longitudinal force Fx due to camber & lateral carcass deflection (MF 5.2 eq. 4.E76):
    double s = p.radius * (p.ssz1 + p.ssz2 * (fy_no_svyk / std::max(p.fz0, 1.0)) + (p.ssz3 + p.ssz4 * dfz) * gamma);

    return -trail * fy_no_svyk + mzr + s * fx;
}

TireForces evaluate_contact_patch_grid(const TireParams& p, double kappa, double tan_alpha, double fz,
                                       double mu_scale, double gamma, const TireOperating& op) {
    // 4x4 Multi-Point Contact Patch Brush-Magic Hybrid Solver:
    //   - Pacejka, "Tire and Vehicle Dynamics" (3rd ed.), Ch. 3 (Brush Model adhesion/sliding zones, Winkler foundation)
    //   - Dugoff, Fancher & Segel (1970) combined-slip friction-ellipse saturation
    //   - Calibrated to the fitted Pacejka MF 5.2 / 6.1 / 6.2 parameters on flat uniform road so measured tire data
    //     remains exact while kerbs, partial contact, camber tilt, yaw spin, and uneven rib thermals emerge naturally.
    TireForces out;
    if (fz <= 0.0) return out;

    const double dpi = op.dpi;
    const double a = contact_patch_half_length(p, fz, dpi);
    const double b = clamp(0.44 * p.section_width_m, 0.05, 0.22);
    out.contact_patch_length_m = 2.0 * a;

    const double press_stiff = clamp(1.0 + p.pfz1 * dpi, 0.55, 1.55);
    const double c_fz = std::max(50000.0, p.vertical_stiffness * press_stiff);
    const double rho0 = std::max(fz / c_fz, 1e-4);

    // Thermal stiffness modulus scaling (T&V)
    if (op.enable_mf62_hybrid && op.condition) {
        out.thermal_stiffness_scale = op.condition->thermal_stiffness_factor(&p);
    }
    const double tv_stiff = out.thermal_stiffness_scale;

    // 1. Winkler elastic-foundation vertical load distribution across 4x4 cells:
    //    Includes parabolic pressure profile, inflation crowning (dpi), camber tilt (y * sin(gamma)),
    //    road kerb elevation (road_dz_m), and drop-off mask (contact_mask).
    const double sin_g = std::sin(clamp(gamma, -0.45, 0.45));
    const double dpi_c = clamp(dpi, -0.35, 0.35);
    const bool has_profile = op.patch != nullptr && op.patch->has_height_map;

    std::array<double, kPatchPoints> z0{};
    std::array<bool, kPatchPoints> active{};
    int n_active = 0;
    double sum_z0 = 0.0;
    for (int i = 0; i < kPatchRows; ++i) {
        for (int j = 0; j < kPatchCols; ++j) {
            const int idx = i * kPatchCols + j;
            const bool mask = !has_profile || op.patch->contact_mask[idx];
            active[idx] = mask;
            if (!mask) continue;
            const double eta = kPatchEta[j];
            const double y_j = eta * b;
            const double w_nom = kPatchWLon[i] * kPatchWLat[j];
            const double dz_crown = rho0 * dpi_c * (0.28 - 0.896 * eta * eta); // zero-mean across j
            const double dz_camber = 0.35 * y_j * sin_g;                       // zero-mean across j
            const double dz_road = has_profile ? op.patch->road_dz_m[idx] : 0.0;
            z0[idx] = rho0 * w_nom + dz_crown + dz_camber + dz_road;
            sum_z0 += z0[idx];
            ++n_active;
        }
    }
    if (n_active == 0) return out;

    // Solve sum_{active} max(0, z0[idx] + drho) = 16 * rho0 via exact piecewise-linear Newton (<= 5 iters).
    const double target_sum = 16.0 * rho0;
    double drho = (target_sum - sum_z0) / static_cast<double>(n_active);
    std::array<double, kPatchPoints> cell_fz{};
    int loaded_cells = 0;
    for (int iter = 0; iter < 5; ++iter) {
        double s = 0.0;
        int n_pos = 0;
        for (int idx = 0; idx < kPatchPoints; ++idx) {
            if (!active[idx]) continue;
            const double d = z0[idx] + drho;
            if (d > 0.0) { s += d; ++n_pos; }
        }
        if (std::abs(s - target_sum) <= 1e-11 * target_sum || n_pos == 0) break;
        drho += (target_sum - s) / static_cast<double>(n_pos);
    }
    double fz_sum_check = 0.0;
    for (int idx = 0; idx < kPatchPoints; ++idx) {
        if (!active[idx]) continue;
        const double d = std::max(0.0, z0[idx] + drho);
        if (d > 0.0) {
            cell_fz[idx] = fz * (d / target_sum);
            fz_sum_check += cell_fz[idx];
            ++loaded_cells;
        }
    }
    if (fz_sum_check <= 1e-9) return out;
    // Re-normalize tiny residual (only if all cells lifted simultaneously due to extreme step)
    const double fz_norm_fix = fz / fz_sum_check;
    for (int idx = 0; idx < kPatchPoints; ++idx) cell_fz[idx] *= fz_norm_fix;

    // 2. Per-column tread surface temperature & WLF rib grip multiplier (mapped via wheel_side_sign)
    std::array<double, kPatchCols> col_surf_c{90.0, 90.0, 90.0, 90.0};
    std::array<double, kPatchCols> col_wlf_mu{1.0, 1.0, 1.0, 1.0};
    const double flash_c = op.condition ? op.condition->flash_c : 90.0;
    if (op.condition) {
        const TireCondition& tc = *op.condition;
        for (int j = 0; j < kPatchCols; ++j) {
            // wheel_side_sign: -1 (left wheel -> +y is outer), +1 (right wheel -> -y is outer)
            const double eta_out = -op.wheel_side_sign * kPatchEta[j];
            double t_rib = tc.surface_c;
            if (op.enable_mf62_hybrid) {
                if (eta_out < -0.5) t_rib = tc.inner_c;
                else if (eta_out < 0.0) t_rib = 0.25 * tc.inner_c + 0.75 * tc.middle_c;
                else if (eta_out < 0.5) t_rib = 0.75 * tc.middle_c + 0.25 * tc.outer_c;
                else t_rib = tc.outer_c;
                col_wlf_mu[j] = tc.wlf_rib_grip_factor(t_rib, &p);
            }
            col_surf_c[j] = t_rib;
        }
    }

    // 3. Patch yaw spin & camber-conicity slip kinematics across (x_i, y_j)
    const double v_ref = std::max(std::abs(op.rolling_speed_mps) > 0.1
                                      ? std::abs(op.rolling_speed_mps)
                                      : (op.phi != 0.0 ? std::abs(op.yaw_rate_rads / op.phi) : 16.7),
                                  0.5);
    const double yaw_r = (std::abs(op.yaw_rate_rads) > 1e-9)
                             ? op.yaw_rate_rads
                             : (-op.phi * std::max(std::abs(op.rolling_speed_mps), 0.5));
    const double inv_vref = 1.0 / v_ref;
    const double alpha_center = std::atan(tan_alpha);

    // Reference stiffness / peak factors for brush adhesion-vs-sliding transition parameter theta_ij
    const double dfz_nom = dfz_of(p, fz);
    const double mu_x_ref = std::max(mu_x_of(p, dfz_nom, gamma, mu_scale, dpi), 0.1);
    const double mu_y_ref = std::max(mu_y_of(p, dfz_nom, gamma, mu_scale, dpi), 0.1);
    const double bx_ref = kx_of(p, fz, dfz_nom, dpi) / (p.cx * mu_x_ref * fz + 1e-9);
    const double by_ref = ky_of(p, fz, gamma, dpi) / (p.cy * mu_y_ref * fz + 1e-9);

    // Flat-road baseline brush trail (for isolating road/yaw/kerb longitudinal moment delta)
    const double lambda_center = std::hypot(bx_ref * kappa * tv_stiff, by_ref * alpha_center * tv_stiff);
    double flat_brush_x_num = 0.0;
    double flat_brush_den = 0.0;
    for (int i = 0; i < kPatchRows; ++i) {
        const double th = (kPatchU[i] * lambda_center) / (0.5 * kPatchWLon[i] + 1e-6);
        const double adh = 1.0 / (1.0 + th * th);
        const double r_w = kPatchWLon[i] * (adh * (2.0 * kPatchU[i]) + (1.0 - adh));
        flat_brush_x_num += (kPatchXi[i] * a) * r_w;
        flat_brush_den += r_w;
    }
    const double flat_brush_xc = flat_brush_den > 1e-9 ? (flat_brush_x_num / flat_brush_den) : 0.0;

    const PatchMFPrecomp pre = make_patch_precomp(p, gamma, dpi);

    // 4. Per-column brush row weights & 4x4 (or exact 4-column when longitudinally uniform) force integration
    double fx_total = 0.0, fy_total = 0.0, fy_nosvyk_total = 0.0;
    double mz_lat_arm = 0.0, mz_lon_grid = 0.0;
    double wlf_mu_weighted = 0.0, adh_weighted = 0.0, mu_mean_weighted = 0.0;

    const bool uniform_along_rows = !has_profile && !op.force_full_patch_grid && !op.patch_out
                                    && std::abs(yaw_r * a * inv_vref) < 0.004;

    if (op.patch_out) {
        *op.patch_out = ContactPatchOutput{};
        op.patch_out->patch_length_m = 2.0 * a;
        op.patch_out->patch_width_m = 2.0 * b;
        op.patch_out->loaded_cells = loaded_cells;
        op.patch_out->used_full_grid = !uniform_along_rows;
    }

    const double conicity_gain = op.enable_mf62_hybrid ? 0.25 : 0.0;
    const double eff_a_center = std::atan(tan_alpha * tv_stiff);

    for (int j = 0; j < kPatchCols; ++j) {
        const double y_j = kPatchEta[j] * b;
        const double dkappa_col = (yaw_r * y_j) * inv_vref - conicity_gain * (y_j * sin_g) / std::max(p.radius, 0.15);

        if (uniform_along_rows) {
            // Exact analytical collapse along the 4 longitudinal rows when road height, mu, and slip are
            // longitudinally uniform across this column: preserves all 4 lateral columns (camber tilt,
            // pressure crown, 3-rib WLF thermals, camber-conicity scrub) at 1/4th the trig cost.
            double col_fz = 0.0;
            double col_fz_eq_weighted = 0.0;
            for (int i = 0; i < kPatchRows; ++i) {
                const double fz_ij = cell_fz[i * kPatchCols + j];
                col_fz += fz_ij;
                col_fz_eq_weighted += fz_ij * ((16.0 * fz_ij) / (kPatchWLon[i] * kPatchWLat[j]));
            }
            if (col_fz <= 1e-9) continue;
            const double fz_eq = clamp(col_fz_eq_weighted / col_fz, 0.1 * p.fz0, 4.5 * p.fz0);
            const double dfz_col = (fz_eq - p.fz0) * pre.inv_fz0;
            const double kap_col = kappa + dkappa_col;
            const double vs_col = std::hypot(op.slip_speed, std::abs(yaw_r * y_j));
            const double stribeck = stribeck_friction_factor(p, vs_col, col_surf_c[j], flash_c);
            const double col_mu = mu_scale * col_wlf_mu[j] * stribeck;
            const CellForceUnit unit = eval_cell_mf_unit(p, pre, kap_col * tv_stiff, eff_a_center, kap_col,
                                                         alpha_center, fz_eq, dfz_col, col_mu, gamma,
                                                         op.enable_mf62_hybrid);
            const double fx_col = col_fz * unit.fx_per_fz;
            const double fy_col = col_fz * unit.fy_per_fz;
            const double fy_nosvyk_col = col_fz * unit.fy_nosvyk_per_fz;
            fx_total += fx_col;
            fy_total += fy_col;
            fy_nosvyk_total += fy_nosvyk_col;
            mz_lat_arm += -y_j * fx_col;
            mz_lon_grid += flat_brush_xc * fy_nosvyk_col;
            wlf_mu_weighted += col_fz * col_wlf_mu[j];
            mu_mean_weighted += col_fz * col_mu;

            const double lam_col = std::hypot(bx_ref * kap_col * tv_stiff, by_ref * alpha_center * tv_stiff);
            double adh_col = 0.0;
            for (int i = 0; i < kPatchRows; ++i) {
                const double th = (kPatchU[i] * lam_col) / (0.5 * kPatchWLon[i] + 1e-6);
                adh_col += kPatchWLon[i] / (1.0 + th * th);
            }
            adh_weighted += col_fz * (adh_col * 0.25);
            continue;
        }

        // Full 4-row brush adhesion/sliding integration along column j
        double col_fz_sum = 0.0;
        double col_fz_r_sum = 0.0;
        std::array<double, kPatchRows> row_r{};
        std::array<double, kPatchRows> row_adh{};
        std::array<double, kPatchRows> row_kappa{};
        std::array<double, kPatchRows> row_tan_a{};

        for (int i = 0; i < kPatchRows; ++i) {
            const int idx = i * kPatchCols + j;
            const double fz_ij = cell_fz[idx];
            if (fz_ij <= 0.0) continue;
            const double x_i = kPatchXi[i] * a;
            const double kap_ij = kappa + dkappa_col;
            const double tan_a_ij = tan_alpha - (yaw_r * x_i) * inv_vref;
            row_kappa[i] = kap_ij;
            row_tan_a[i] = tan_a_ij;

            const double alpha_ij = std::atan(tan_a_ij);
            const double lam_ij = std::hypot(bx_ref * kap_ij * tv_stiff, by_ref * alpha_ij * tv_stiff);
            const double th_ij = (kPatchU[i] * lam_ij) / (0.5 * kPatchWLon[i] + 1e-6);
            const double adh_ij = 1.0 / (1.0 + th_ij * th_ij);
            row_adh[i] = adh_ij;
            const double r_ij = adh_ij * (2.0 * kPatchU[i]) + (1.0 - adh_ij);
            row_r[i] = r_ij;
            col_fz_sum += fz_ij;
            col_fz_r_sum += fz_ij * r_ij;
        }
        if (col_fz_sum <= 1e-9) continue;
        const double col_r_norm = col_fz_r_sum > 1e-9 ? (col_fz_sum / col_fz_r_sum) : 1.0;

        for (int i = 0; i < kPatchRows; ++i) {
            const int idx = i * kPatchCols + j;
            const double fz_ij = cell_fz[idx];
            if (fz_ij <= 0.0) continue;

            const double x_i = kPatchXi[i] * a;
            const double w_nom = kPatchWLon[i] * kPatchWLat[j];
            // Local equivalent full-tyre load from local contact pressure (exact = fz on flat road, rises on kerbs!)
            const double fz_eq = clamp((16.0 * fz_ij) / w_nom, 0.1 * p.fz0, 4.5 * p.fz0);
            const double dfz_ij = (fz_eq - p.fz0) * pre.inv_fz0;

            const double kap_ij = row_kappa[i];
            const double tan_a_ij = row_tan_a[i];
            const double alpha_ij = std::atan(tan_a_ij);

            // Local sliding velocity across the patch (center slip speed + yaw spin arm)
            const double vs_spin = std::abs(yaw_r) * std::hypot(x_i, y_j);
            const double vs_ij = std::hypot(op.slip_speed, vs_spin);
            const double stribeck = stribeck_friction_factor(p, vs_ij, col_surf_c[j], flash_c);
            const double cell_surface_mu = has_profile ? op.patch->mu_cell[idx] : 1.0;
            const double cell_mu = mu_scale * cell_surface_mu * col_wlf_mu[j] * stribeck;

            const double eff_k = kap_ij * tv_stiff;
            const double eff_a = std::atan(tan_a_ij * tv_stiff);
            const CellForceUnit unit = eval_cell_mf_unit(p, pre, eff_k, eff_a, kap_ij, alpha_ij, fz_eq, dfz_ij,
                                                         cell_mu, gamma, op.enable_mf62_hybrid);

            const double fz_weighted = fz_ij * row_r[i] * col_r_norm;
            const double fx_ij = fz_weighted * unit.fx_per_fz;
            const double fy_ij = fz_weighted * unit.fy_per_fz;
            const double fy_nosvyk_ij = fz_weighted * unit.fy_nosvyk_per_fz;

            fx_total += fx_ij;
            fy_total += fy_ij;
            fy_nosvyk_total += fy_nosvyk_ij;
            mz_lat_arm += -y_j * fx_ij;
            mz_lon_grid += x_i * fy_nosvyk_ij;

            wlf_mu_weighted += fz_ij * col_wlf_mu[j];
            adh_weighted += fz_ij * row_adh[i];
            mu_mean_weighted += fz_ij * cell_mu;

            if (op.patch_out) {
                op.patch_out->cell_fz[idx] = fz_ij;
                op.patch_out->cell_fx[idx] = fx_ij;
                op.patch_out->cell_fy[idx] = fy_ij;
                op.patch_out->cell_adhesion[idx] = row_adh[i];
            }
        }
    }

    // MF 6.1 turn-slip lateral peak attenuation when spin phi is large (parking / tight hairpins)
    if (op.phi != 0.0) {
        const double rphi = p.radius * std::abs(op.phi);
        const double byphi = p.pdyp1 * (1.0 + p.pdyp2 * dfz_nom) * std::cos(std::atan(p.pdyp3 * tan_alpha));
        const double zeta2 = std::cos(std::atan(byphi * (rphi + p.pdyp4 * std::sqrt(rphi))));
        const double zeta3 = std::cos(std::atan(p.pkyp1 * rphi * rphi));
        const double spin_scale = zeta2 * (0.5 + 0.5 * zeta3);
        fy_total *= spin_scale;
        fy_nosvyk_total *= spin_scale;
        mz_lon_grid *= spin_scale;
    }

    out.fx = fx_total;
    out.fy = fy_total;
    out.effective_rib_mu = clamp(wlf_mu_weighted / fz, 0.78, 1.05);
    out.adhesion_ratio = clamp(adh_weighted / fz, 0.0, 1.0);
    if (op.patch_out) op.patch_out->adhesion_ratio = out.adhesion_ratio;

    const double mu_eff_mean = mu_mean_weighted / fz;
    double trail_mf = 0.0;
    const double mz_mf = mf_aligning_torque(p, kappa, alpha_center, fz, mu_eff_mean, gamma, fx_total, fy_nosvyk_total, &trail_mf);
    // Add the 4x4 grid's direct lateral-arm moment (-y_j * fx_ij: kerb pull, uneven rib scrub, camber conicity,
    // yaw-spin damping) and longitudinal centroid shift from uneven front/rear road height or yaw spin.
    const double delta_mz_lon = mz_lon_grid - flat_brush_xc * fy_nosvyk_total;
    out.pneumatic_trail = trail_mf;
    if (std::abs(fy_nosvyk_total) > 50.0) {
        out.pneumatic_trail = clamp(trail_mf - delta_mz_lon / fy_nosvyk_total, -a, a);
    }
    out.mz = mz_mf + mz_lat_arm + delta_mz_lon;

    if (op.enable_mf62_hybrid) {
        // PAC2002 / Simcenter 2606 gyroscopic steel-belt precession torque M_z,gyr = QTZ1 * MBELT * r * V_x * d(gamma)/dt
        const double mz_gyr = p.qtz1 * p.mbelt * p.radius * op.rolling_speed_mps * clamp(op.gamma_rate_rads, -8.0, 8.0);
        out.mz += mz_gyr;
        if (op.condition) {
            // Simcenter Tire 2606 MF-Swift 3D Tandem Elliptical Cam Enveloping longitudinal resistance over cleats/curbs
            out.fx -= fz * clamp(op.condition->enveloping_slope_tan, -0.25, 0.25) * 0.35;
        }
    }
    return out;
}

TireForces magic_formula(const TireParams& p, double kappa, double tan_alpha, double fz, double mu_scale, double gamma,
                         const TireOperating& op) {
    TireForces out;
    if (fz <= 0) return out;

    const double yaw_r = (std::abs(op.yaw_rate_rads) > 1e-9)
                             ? op.yaw_rate_rads
                             : (-op.phi * std::max(std::abs(op.rolling_speed_mps), 0.5));
    const double v_ref = std::max(std::abs(op.rolling_speed_mps) > 0.1 ? std::abs(op.rolling_speed_mps) : 16.7, 0.5);
    const double patch_yaw_slip = std::abs(yaw_r) * 0.10 / v_ref;
    const bool has_profile = op.patch != nullptr && op.patch->has_height_map;
    const bool has_rib_spread = op.enable_mf62_hybrid && op.condition && op.condition->imo_spread_c() > 4.0;
    const bool needs_grid = op.force_full_patch_grid || op.patch_out != nullptr || has_profile
                            || patch_yaw_slip >= 0.004 || has_rib_spread;

    if (op.enable_contact_patch_grid && needs_grid) {
        return evaluate_contact_patch_grid(p, kappa, tan_alpha, fz, mu_scale, gamma, op);
    }

    // Exact flat-road analytical fast-path (when road height & mu are uniform across the 4x4 patch,
    // yaw spin is negligible, and 3-rib temperatures are uniform): mathematically identical to the 16-cell
    // calibrated grid on flat roads at ~1/12th the CPU cost.
    const double surf_c = op.condition ? op.condition->surface_c : 90.0;
    const double flash_c = op.condition ? op.condition->flash_c : 90.0;
    mu_scale *= stribeck_friction_factor(p, op.slip_speed, surf_c, flash_c);

    const double dpi = op.dpi;
    const double a = contact_patch_half_length(p, fz, dpi);
    out.contact_patch_length_m = 2.0 * a;
    double dfz = dfz_of(p, fz);
    double alpha = std::atan(tan_alpha);

    // ---- MF 6.2 + Physical 3-Rib (Inner / Middle / Outer) Contact-Patch & WLF Flash-Temperature Integration
    double rib_diff_torque_factor = 0.0;
    if (op.enable_mf62_hybrid && op.condition) {
        const TireCondition& tc = *op.condition;
        const double top_inward = clamp(op.wheel_side_sign * gamma, -0.35, 0.35);
        const double corner_roll = clamp(-op.wheel_side_sign * alpha * 1.8, -0.45, 0.45);
        const double crown = dpi > 0.05 ? clamp((dpi - 0.05) * 0.85, 0.0, 0.25) : 0.0;
        double w_mid = (1.0 + 1.6 * crown) * (0.4 + 1.8 * tc.rib_contact_shares[1]);
        double w_in  = clamp(1.0 + 3.2 * top_inward - 1.4 * corner_roll - 0.8 * crown, 0.15, 2.4) * (0.4 + 1.8 * tc.rib_contact_shares[0]);
        double w_out = clamp(1.0 - 3.2 * top_inward + 1.4 * corner_roll - 0.8 * crown, 0.15, 2.4) * (0.4 + 1.8 * tc.rib_contact_shares[2]);
        const double w_sum = w_in + w_mid + w_out;
        w_in /= w_sum; w_mid /= w_sum; w_out /= w_sum;

        const double mu_in  = tc.wlf_rib_grip_factor(tc.inner_c, &p);
        const double mu_mid = tc.wlf_rib_grip_factor(tc.middle_c, &p);
        const double mu_out = tc.wlf_rib_grip_factor(tc.outer_c, &p);
        out.effective_rib_mu = clamp(w_in * mu_in + w_mid * mu_mid + w_out * mu_out, 0.78, 1.05);
        out.thermal_stiffness_scale = tc.thermal_stiffness_factor(&p);
        mu_scale *= out.effective_rib_mu;
        rib_diff_torque_factor = (w_out * mu_out - w_in * mu_in) * (-op.wheel_side_sign);
    }

    const double tv_stiff = out.thermal_stiffness_scale;
    const double eff_kappa = kappa * tv_stiff;
    const double eff_alpha = std::atan(tan_alpha * tv_stiff);
    const PatchMFPrecomp pre = make_patch_precomp(p, gamma, dpi);
    const CellForceUnit unit = eval_cell_mf_unit(p, pre, eff_kappa, eff_alpha, kappa, alpha, fz, dfz, mu_scale,
                                                 gamma, op.enable_mf62_hybrid);
    double fx = fz * unit.fx_per_fz;
    double fy = fz * unit.fy_per_fz;
    double fy_no_svyk = fz * unit.fy_nosvyk_per_fz;

    if (op.phi != 0.0) {
        const double rphi = p.radius * std::abs(op.phi);
        const double byphi = p.pdyp1 * (1.0 + p.pdyp2 * dfz) * std::cos(std::atan(p.pdyp3 * tan_alpha));
        const double zeta2 = std::cos(std::atan(byphi * (rphi + p.pdyp4 * std::sqrt(rphi))));
        const double zeta3 = std::cos(std::atan(p.pkyp1 * rphi * rphi));
        const double spin_scale = zeta2 * (0.5 + 0.5 * zeta3);
        fy *= spin_scale;
        fy_no_svyk *= spin_scale;
    }

    // Analytical brush adhesion ratio across the 4 longitudinal rows
    const double mu_x_ref = std::max(mu_x_of(p, dfz, gamma, mu_scale, dpi), 0.1);
    const double mu_y_ref = std::max(mu_y_of(p, dfz, gamma, mu_scale, dpi), 0.1);
    const double bx_ref = kx_of(p, fz, dfz, dpi) / (p.cx * mu_x_ref * fz + 1e-9);
    const double by_ref = ky_of(p, fz, gamma, dpi) / (p.cy * mu_y_ref * fz + 1e-9);
    const double lam = std::hypot(bx_ref * eff_kappa, by_ref * eff_alpha);
    double adh_sum = 0.0;
    for (int i = 0; i < kPatchRows; ++i) {
        const double th = (kPatchU[i] * lam) / (0.5 * kPatchWLon[i] + 1e-6);
        adh_sum += kPatchWLon[i] / (1.0 + th * th);
    }
    out.adhesion_ratio = clamp(adh_sum * 0.25, 0.0, 1.0);

    out.fx = fx;
    out.fy = fy;
    out.mz = mf_aligning_torque(p, kappa, alpha, fz, mu_scale, gamma, fx, fy_no_svyk, &out.pneumatic_trail);
    if (op.enable_mf62_hybrid) {
        const double mz_conicity = -0.024 * fz * p.radius * std::sin(gamma) * std::cos(alpha);
        const double mz_3rib = rib_diff_torque_factor * 0.082 * fx;
        const double mz_gyr = p.qtz1 * p.mbelt * p.radius * op.rolling_speed_mps * clamp(op.gamma_rate_rads, -8.0, 8.0);
        out.mz += mz_conicity + mz_3rib + mz_gyr;
        if (op.condition) {
            out.fx -= fz * clamp(op.condition->enveloping_slope_tan, -0.25, 0.25) * 0.35;
        }
    }
    return out;
}

}  // namespace rs
