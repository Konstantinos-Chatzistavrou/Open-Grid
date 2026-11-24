// Layer 1 validation: US EPA Public-Domain Coast-Down & Road-Load Benchmark (SAE J2263 / 40 CFR 1066.310).
//
// Primary-source US Government public-domain dataset:
//   US EPA Test Car List Data Files ("Data on Cars used for Testing Fuel Economy"):
//   https://www.epa.gov/compliance-and-fuel-economy-data/data-cars-used-testing-fuel-economy
//   Direct official datasets queried:
//     - MY 2015: https://www.epa.gov/sites/default/files/2016-07/15tstcar.csv
//     - MY 2016: https://www.epa.gov/sites/default/files/2016-07/16tstcar.csv
//     - MY 2017: https://www.epa.gov/sites/default/files/2018-06/17tstcar-2018-05-30.xlsx
//     - MY 2019: https://www.epa.gov/sites/default/files/2020-10/19tstcar-2020-10-02.xlsx
//
// EPA road-load force equation (SAE J2263, Imperial):
//   F_RL(v) = A + B * v + C * v^2   [lbf],  v in mph
// SI conversion (exact NIST / SAE factors):
//   1 lbf = 4.4482216 N,  1 mph = 0.44704 m/s,  1 hp = 745.699872 W
//   F0 [N]         = A * 4.4482216
//   F1 [N/(m/s)]   = B * 4.4482216 / 0.44704
//   F2 [N/(m/s)^2] = C * 4.4482216 / (0.44704^2)
//   P(v) [W]       = F_RL(v) * v
//
// Verified warm-ambient EPA Test Car List reference vehicles (Cold CO +10% rows excluded):
//   1. Chevrolet Corvette C7 (6.2L LT1 RWD, benchmark for Vela GT):
//      - MY2016-17 Stingray 7MT (ID 1EYV2610, 450 hp, ETW 3625 lb):
//          A=37.37 lbf, B=0.5201 lbf/mph, C=0.01305 lbf/mph^2 -> P50=9.54 kW (12.80 hp), P70=19.17 kW (25.71 hp)
//      - MY2016-17 Stingray 8AT (ID 621FYN3039, 455 hp, ETW 3625 lb):
//          A=36.77 lbf, B=0.3782 lbf/mph, C=0.01563 lbf/mph^2 -> P50=9.42 kW (12.63 hp), P70=19.46 kW (26.10 hp)
//      - MY2019 Stingray 7MT (ID 621JYS2017, 455 hp, ETW 3625 lb):
//          A=41.92 lbf, B=0.5036 lbf/mph, C=0.01336 lbf/mph^2 -> P50=9.99 kW (13.40 hp), P70=19.85 kW (26.63 hp)
//      - MY2017-19 Grand Sport 7MT (ID 621HYV2206, 455 hp, ETW 3750-3875 lb):
//          A=40.58-41.66 lbf, B=0.5958-0.5989, C=0.01849-0.01893 -> P50=11.59-11.82 kW, P70=24.07-24.55 kW
//   2. Volkswagen Golf GTI Mk7 / Mk7.5 (2.0T FWD, benchmark for Mistra 200T):
//      - MY2015-17 GTI 6MT (ID FAPA-GMF, 211/220 hp, ETW 3375-3500 lb):
//          A=27.899 lbf, B=0.36533 lbf/mph, C=0.016878 lbf/mph^2 -> P50=8.79 kW (11.78 hp), P70=18.96 kW (25.42 hp)
//      - MY2015-17 GTI 6DSG (ID FAPA-GAF, 211 hp, ETW 3500 lb):
//          A=34.463 lbf, B=0.19533 lbf/mph, C=0.018508 lbf/mph^2 -> P50=9.00 kW (12.07 hp), P70=19.32 kW (25.91 hp)
//      - MY2019 Golf GTI 6MT (ID VW370-09-0274, ETW 3500 lb):
//          A=30.731 lbf, B=0.42321 lbf/mph, C=0.017227 lbf/mph^2 -> P50=9.44 kW (12.66 hp), P70=20.15 kW (27.02 hp)
//   3. High-downforce track coupes (context for Kestrel GT, CdA=0.88 m^2, ClA=1.15 m^2):
//      - MY2019 Porsche 911 GT3 RS (ID FE-991IIGT3RS-19, 513 hp, ETW 3625 lb):
//          A=40.466 lbf, B=0.50651, C=0.019214 -> P50=11.32 kW (15.18 hp), P70=23.67 kW (31.75 hp)
//      - MY2019 Corvette ZR1 7MT (ID 621KYV3006, 750 hp, ETW 3875 lb):
//          A=49.910 lbf, B=0.61600, C=0.024410 -> P50=14.09 kW (18.90 hp), P70=29.60 kW (39.69 hp)
#include <array>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>
#include "harness.hpp"

using namespace rs;

namespace {

constexpr double kLbfToN = 4.4482216;
constexpr double kMphToMps = 0.44704;
constexpr double kHpToKw = 0.745699872;
constexpr double kV50Mps = 50.0 * kMphToMps;  // 22.352 m/s (80.467 km/h)
constexpr double kV70Mps = 70.0 * kMphToMps;  // 31.2928 m/s (112.654 km/h)

struct Sample {
    double t = 0.0;
    double x = 0.0;
    double v = 0.0;
    double f_aero = 0.0;
    double mean_dpi = 0.0;
};

struct CoastdownResult {
    std::string name;
    double mass_kg = 0.0;
    double rot_mass_kg = 0.0;
    double m_eff_kg = 0.0;
    double rho_air = 1.225;
    double mean_dpi = 0.0;

    // Fitted 3-term quadratic F_res(v) = F0 + F1*v + F2*v^2 over 25..110 km/h
    double f0 = 0.0;
    double f1 = 0.0;
    double f2 = 0.0;
    double fit_rms_n = 0.0;

    // Fitted 2-term physics check F_res(v) = F0_2 + F2_2*v^2 over 25..110 km/h
    double f0_2 = 0.0;
    double f2_2 = 0.0;

    // Analytical expectations from CarConfig
    double f0_expected = 0.0;
    double f2_aero_expected = 0.0;
    double f2_total_expected = 0.0;

    // Derived EPA road-load metrics (from 3-term fit)
    double coef_a_lbf = 0.0;
    double coef_b_lbf_mph = 0.0;
    double coef_c_lbf_mph2 = 0.0;
    double p50_kw = 0.0;
    double p50_hp = 0.0;
    double p70_kw = 0.0;
    double p70_hp = 0.0;

    // 100 -> 20 km/h coast-down window & crossover speed
    double t_100_20_s = 0.0;
    double d_100_20_m = 0.0;
    double v_cross_kmh = 0.0;
};

// Solve 3x3 linear system A * x = b via Gaussian elimination with partial pivoting.
bool solve_3x3(double A[3][3], double b[3], double x[3]) {
    for (int col = 0; col < 3; ++col) {
        int piv = col;
        for (int row = col + 1; row < 3; ++row) {
            if (std::abs(A[row][col]) > std::abs(A[piv][col])) piv = row;
        }
        if (std::abs(A[piv][col]) < 1e-18) return false;
        if (piv != col) {
            for (int j = col; j < 3; ++j) std::swap(A[col][j], A[piv][j]);
            std::swap(b[col], b[piv]);
        }
        for (int row = col + 1; row < 3; ++row) {
            const double fac = A[row][col] / A[col][col];
            for (int j = col; j < 3; ++j) A[row][j] -= fac * A[col][j];
            b[row] -= fac * b[col];
        }
    }
    for (int i = 2; i >= 0; --i) {
        double sum = b[i];
        for (int j = i + 1; j < 3; ++j) sum -= A[i][j] * x[j];
        x[i] = sum / A[i][i];
    }
    return true;
}

CoastdownResult run_coastdown(const CarConfig& cfg) {
    CoastdownResult res;
    res.name = cfg.name;
    res.mass_kg = cfg.mass;
    for (int w = 0; w < 4; ++w) {
        const double r = cfg.tire(w).radius;
        res.rot_mass_kg += cfg.tire(w).inertia / (r * r);
    }
    res.m_eff_kg = res.mass_kg + res.rot_mass_kg;

    // Flat dry asphalt at 15 C ISA sea-level standard atmosphere (rho ~ 1.225 kg/m^3).
    auto sim = test::make_sim(cfg, 1.0 / 240.0);
    sim->vehicle.atmosphere().enabled = true;
    sim->vehicle.atmosphere().ambient_air_c = 15.0;
    sim->vehicle.atmosphere().track_surface_c = 15.0;
    sim->vehicle.atmosphere().altitude_m = 0.0;
    sim->vehicle.atmosphere().humidity_0_to_1 = 0.0;
    sim->vehicle.engine_systems().fuel_consumption_enabled = false;

    // Launch slightly above 115 km/h so suspension/slip transients settle before entering the measurement window.
    constexpr double kVStartKmh = 117.0;
    constexpr double kVGateHiMps = 115.0 / 3.6;
    constexpr double kV100Mps = 100.0 / 3.6;
    constexpr double kV20Mps = 20.0 / 3.6;
    constexpr double kVStopMps = 18.0 / 3.6;
    constexpr double kVFitHiMps = 110.0 / 3.6;
    constexpr double kVFitLoMps = 25.0 / 3.6;

    sim->reset({}, 0.0, kVStartKmh / 3.6, 1);

    DriverInput in;
    in.gear = 1;      // Neutral
    in.clutch = 1.0;  // Fully disengaged clutch
    in.throttle = 0.0;
    in.brake = 0.0;
    in.steer = 0.0;

    std::vector<Sample> samples;
    samples.reserve(2000);

    bool crossed_100 = false;
    bool crossed_20 = false;
    double t_100 = 0.0, x_100 = 0.0;
    double t_20 = 0.0, x_20 = 0.0;
    double prev_v = kVStartKmh / 3.6;
    double prev_t = 0.0;
    double prev_x = 0.0;

    int step_idx = 0;
    while (sim->time < 220.0) {
        sim->step(in);
        ++step_idx;

        const double v = sim->last.speed;
        const double t = sim->time;
        const double x = sim->body.state.position.x;

        if (!crossed_100 && prev_v >= kV100Mps && v < kV100Mps) {
            const double frac = (prev_v - kV100Mps) / std::max(prev_v - v, 1e-12);
            t_100 = prev_t + frac * (t - prev_t);
            x_100 = prev_x + frac * (x - prev_x);
            crossed_100 = true;
        }
        if (crossed_100 && !crossed_20 && prev_v >= kV20Mps && v < kV20Mps) {
            const double frac = (prev_v - kV20Mps) / std::max(prev_v - v, 1e-12);
            t_20 = prev_t + frac * (t - prev_t);
            x_20 = prev_x + frac * (x - prev_x);
            crossed_20 = true;
        }

        // Sample at 10 Hz (every 24 ticks at 240 Hz) once below 115 km/h.
        if (v <= kVGateHiMps && (step_idx % 24 == 0)) {
            double dpi_sum = 0.0;
            for (int w = 0; w < 4; ++w) {
                dpi_sum += sim->last.wheels[w].condition.dpi(cfg.tire(w));
            }
            Sample smp;
            smp.t = t;
            smp.x = x;
            smp.v = v;
            smp.mean_dpi = 0.25 * dpi_sum;
            samples.push_back(smp);
            res.rho_air = sim->last.air_density_kg_m3;
        }

        prev_v = v;
        prev_t = t;
        prev_x = x;
        if (v < kVStopMps) break;
    }

    res.t_100_20_s = crossed_20 ? (t_20 - t_100) : 0.0;
    res.d_100_20_m = crossed_20 ? (x_20 - x_100) : 0.0;

    // Central difference dv/dt over +-0.5 s (k = 5 samples at 10 Hz) over 25..110 km/h.
    constexpr int kHalfWin = 5;
    std::vector<double> fit_v;
    std::vector<double> fit_f;
    double dpi_acc = 0.0;
    int dpi_n = 0;

    for (int i = kHalfWin; i + kHalfWin < static_cast<int>(samples.size()); ++i) {
        const double v = samples[i].v;
        if (v > kVFitHiMps || v < kVFitLoMps) continue;
        const double dv_dt = (samples[i + kHalfWin].v - samples[i - kHalfWin].v)
                           / (samples[i + kHalfWin].t - samples[i - kHalfWin].t);
        const double f_res = -res.m_eff_kg * dv_dt;
        fit_v.push_back(v);
        fit_f.push_back(f_res);
        dpi_acc += samples[i].mean_dpi;
        ++dpi_n;
    }
    res.mean_dpi = dpi_n > 0 ? (dpi_acc / dpi_n) : 0.0;

    // 3-term ordinary least squares: F(v) = F0 + F1*v + F2*v^2
    double M[3][3] = {};
    double rhs[3] = {};
    for (size_t i = 0; i < fit_v.size(); ++i) {
        const double v = fit_v[i];
        const double phi[3] = {1.0, v, v * v};
        for (int r = 0; r < 3; ++r) {
            rhs[r] += phi[r] * fit_f[i];
            for (int c = 0; c < 3; ++c) M[r][c] += phi[r] * phi[c];
        }
    }
    double beta[3] = {};
    if (solve_3x3(M, rhs, beta)) {
        res.f0 = beta[0];
        res.f1 = beta[1];
        res.f2 = beta[2];
    }
    double sq_err = 0.0;
    for (size_t i = 0; i < fit_v.size(); ++i) {
        const double v = fit_v[i];
        const double pred = res.f0 + res.f1 * v + res.f2 * v * v;
        const double err = fit_f[i] - pred;
        sq_err += err * err;
    }
    res.fit_rms_n = fit_v.empty() ? 0.0 : std::sqrt(sq_err / static_cast<double>(fit_v.size()));

    // 2-term OLS: F(v) = F0_2 + F2_2 * v^2 (directly compares against rolling + aero physics)
    double s00 = 0.0, s02 = 0.0, s22 = 0.0, y0 = 0.0, y2 = 0.0;
    for (size_t i = 0; i < fit_v.size(); ++i) {
        const double v2 = fit_v[i] * fit_v[i];
        s00 += 1.0;
        s02 += v2;
        s22 += v2 * v2;
        y0 += fit_f[i];
        y2 += v2 * fit_f[i];
    }
    const double det2 = s00 * s22 - s02 * s02;
    if (std::abs(det2) > 1e-18) {
        res.f0_2 = (s22 * y0 - s02 * y2) / det2;
        res.f2_2 = (s00 * y2 - s02 * y0) / det2;
    }

    // Analytical configured expectation using CarConfig's rolling resistance & aero parameters.
    const double c_rr0 = 0.5 * (cfg.tire_front.rolling_resistance + cfg.tire_rear.rolling_resistance);
    const double c_rr2 = 0.5 * (cfg.tire_front.rolling_resistance_v2 + cfg.tire_rear.rolling_resistance_v2);
    const double p_nom = 0.5 * (cfg.tire_front.p_nominal_kpa + cfg.tire_rear.p_nominal_kpa);
    const double p_abs_ratio = clamp((p_nom * (1.0 + res.mean_dpi) + 101.325) / (p_nom + 101.325), 0.55, 1.65);
    const double p_rr_scale = 1.0 / std::sqrt(p_abs_ratio);

    res.f0_expected = c_rr0 * cfg.mass * kGravity * p_rr_scale;
    res.f2_aero_expected = 0.5 * res.rho_air * cfg.aero.drag_area;
    const double f2_rr_v2 = (c_rr2 / 900.0) * cfg.mass * kGravity * p_rr_scale;
    const double f2_downforce_rr = c_rr0 * p_rr_scale * 0.5 * res.rho_air * cfg.aero.lift_area;
    res.f2_total_expected = res.f2_aero_expected + f2_rr_v2 + f2_downforce_rr;

    // Imperial EPA equivalents and road-load power at 50 mph and 70 mph.
    res.coef_a_lbf = res.f0 / kLbfToN;
    res.coef_b_lbf_mph = res.f1 * kMphToMps / kLbfToN;
    res.coef_c_lbf_mph2 = res.f2 * (kMphToMps * kMphToMps) / kLbfToN;

    const double f50 = res.f0 + res.f1 * kV50Mps + res.f2 * kV50Mps * kV50Mps;
    const double f70 = res.f0 + res.f1 * kV70Mps + res.f2 * kV70Mps * kV70Mps;
    res.p50_kw = f50 * kV50Mps / 1000.0;
    res.p50_hp = res.p50_kw / kHpToKw;
    res.p70_kw = f70 * kV70Mps / 1000.0;
    res.p70_hp = res.p70_kw / kHpToKw;

    res.v_cross_kmh = (res.f0 > 0.0 && res.f2 > 0.0) ? (std::sqrt(res.f0 / res.f2) * 3.6) : 0.0;
    return res;
}

void print_summary(const CoastdownResult& r) {
    const double f0_err_pct = 100.0 * (r.f0 - r.f0_expected) / std::max(r.f0_expected, 1e-6);
    const double f2_err_pct = 100.0 * (r.f2 - r.f2_total_expected) / std::max(r.f2_total_expected, 1e-6);
    const double f0_2_err_pct = 100.0 * (r.f0_2 - r.f0_expected) / std::max(r.f0_expected, 1e-6);
    const double f2_2_err_pct = 100.0 * (r.f2_2 - r.f2_total_expected) / std::max(r.f2_total_expected, 1e-6);
    std::printf(
        "         [%s] m=%.0f kg (m_eff=%.2f kg, rot=+%.2f kg), rho=%.4f kg/m^3, mean_dpi=%+.4f\n"
        "           3-term fit (25..110 km/h, RMS=%.3f N):\n"
        "             SI:  F0=%.2f N (exp %.2f N, %+.2f%%), F1=%+.4f N/(m/s), F2=%.4f N/(m/s)^2 (exp %.4f, %+.2f%%; aero-only %.4f)\n"
        "             2-term check: F0=%.2f N (%+.2f%%), F2=%.4f N/(m/s)^2 (%+.2f%%)\n"
        "             EPA: A=%.3f lbf, B=%+.5f lbf/mph, C=%.6f lbf/mph^2\n"
        "             P(50 mph)=%.2f kW (%.2f hp), P(70 mph)=%.2f kW (%.2f hp)\n"
        "             100->20 km/h: %.2f s, %.1f m | aero/rolling crossover v_cross=%.2f km/h\n",
        r.name.c_str(), r.mass_kg, r.m_eff_kg, r.rot_mass_kg, r.rho_air, r.mean_dpi,
        r.fit_rms_n,
        r.f0, r.f0_expected, f0_err_pct, r.f1, r.f2, r.f2_total_expected, f2_err_pct, r.f2_aero_expected,
        r.f0_2, f0_2_err_pct, r.f2_2, f2_2_err_pct,
        r.coef_a_lbf, r.coef_b_lbf_mph, r.coef_c_lbf_mph2,
        r.p50_kw, r.p50_hp, r.p70_kw, r.p70_hp,
        r.t_100_20_s, r.d_100_20_m, r.v_cross_kmh);
}

}  // namespace

RS_TEST(epa_coastdown) {
    const CarConfig vela_cfg = load_car_config(test::data_path("cars/vela_gt.json"));
    const CarConfig mistra_cfg = load_car_config(test::data_path("cars/mistra_200t.json"));
    const CarConfig kestrel_cfg = load_car_config(test::data_path("cars/kestrel_gt.json"));

    const CoastdownResult vela = run_coastdown(vela_cfg);
    const CoastdownResult mistra = run_coastdown(mistra_cfg);
    const CoastdownResult kestrel = run_coastdown(kestrel_cfg);

    print_summary(vela);
    print_summary(mistra);
    print_summary(kestrel);

    // 1. Integrator & force-balance accuracy: fitted F0 and F2 match configured physics within 8%.
    auto check_fit = [](const CoastdownResult& r) {
        const double f0_rel = std::abs(r.f0 - r.f0_expected) / r.f0_expected;
        const double f2_rel = std::abs(r.f2 - r.f2_total_expected) / r.f2_total_expected;
        char buf[128];
        std::snprintf(buf, sizeof(buf), "%s fitted F0 vs config Crr*mg (rel err)", r.name.c_str());
        test::check_range(buf, f0_rel * 100.0, 0.0, 8.0, "%");
        std::snprintf(buf, sizeof(buf), "%s fitted F2 vs config 0.5*rho*CdA+rr (rel err)", r.name.c_str());
        test::check_range(buf, f2_rel * 100.0, 0.0, 8.0, "%");
        std::snprintf(buf, sizeof(buf), "%s quadratic coast-down fit RMS residual", r.name.c_str());
        test::check_range(buf, r.fit_rms_n, 0.0, 3.0, "N");
    };
    check_fit(vela);
    check_fit(mistra);
    check_fit(kestrel);

    // 2. Real US EPA Test Car List road-load power checks.
    test::check_range("Vela GT P(50 mph) [EPA C7 Stingray 8.0-12.5 kW]", vela.p50_kw, 8.0, 12.5, "kW");
    test::check_range("Vela GT P(70 mph) [EPA C7 Stingray 17.5-25.5 kW]", vela.p70_kw, 17.5, 25.5, "kW");
    test::check_range("Mistra 200T P(50 mph) [EPA Mk7 GTI 8.0-11.0 kW]", mistra.p50_kw, 8.0, 11.0, "kW");
    test::check_range("Mistra 200T P(70 mph) [EPA Mk7 GTI 17.5-22.5 kW]", mistra.p70_kw, 17.5, 22.5, "kW");

    // 3. Realistic neutral coast-down duration (100 -> 20 km/h) & aero/rolling crossover speed.
    test::check_range("Vela GT 100->20 km/h coast-down time", vela.t_100_20_s, 85.0, 135.0, "s");
    test::check_range("Mistra 200T 100->20 km/h coast-down time", mistra.t_100_20_s, 85.0, 135.0, "s");
    test::check_range("Kestrel GT 100->20 km/h coast-down time", kestrel.t_100_20_s, 80.0, 125.0, "s");

    test::check_range("Vela GT aero-vs-rolling crossover speed", vela.v_cross_kmh, 55.0, 95.0, "km/h");
    test::check_range("Mistra 200T aero-vs-rolling crossover speed", mistra.v_cross_kmh, 55.0, 95.0, "km/h");
    test::check_range("Kestrel GT aero-vs-rolling crossover speed", kestrel.v_cross_kmh, 55.0, 95.0, "km/h");

    // 4. High-downforce track aero comparison: Kestrel GT vs Vela GT.
    test::check("Kestrel GT (wing) has higher 70 mph road-load power than Vela GT",
                kestrel.p70_kw > vela.p70_kw + 2.5);
    test::check("Kestrel GT (wing) decelerates faster 100->20 km/h than Vela GT",
                kestrel.t_100_20_s < vela.t_100_20_s - 8.0);
    test::check("Kestrel GT aero crossover occurs at lower speed than Vela GT",
                kestrel.v_cross_kmh < vela.v_cross_kmh - 5.0);
}
