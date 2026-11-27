// Pacejka Magic Formula MF 5.2 / 6.1 / 6.2 steady-state tyre model: see mf62.hpp for the status, the sources and the third-party notices.
// Written against MFeval 4.3.1's MATLAB source (+mfeval/Solver.m): the stage order, every "empirically discovered" correction and the use-mode
// logic follow it. Deviations are marked "DEVIATION" (all are guards for inputs where MFeval returns NaN / complex numbers).
#include "rs/mf62.hpp"
#include <algorithm>
#include <cctype>
#include <cfloat>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <sstream>
#include <unordered_map>

namespace rs::mf62 {
namespace {

constexpr double kPi = 3.14159265358979323846;
inline double sgn(double x) { return x >= 0.0 ? 1.0 : -1.0; }            // sign(0) = +1: where MFeval forces it (it divides by the sign)
inline double sign0(double x) { return x > 0.0 ? 1.0 : (x < 0.0 ? -1.0 : 0.0); }   // MATLAB sign(): 0 at 0, where MFeval uses it raw
inline double sq(double x) { return x * x; }
inline double clampd(double x, double lo, double hi) { return std::min(std::max(x, lo), hi); }
inline double safe_den(double d, double floor_abs = 1e-12) { return std::abs(d) < floor_abs ? (d < 0 ? -floor_abs : floor_abs) : d; }

// ---- .tir text -------------------------------------------------------------------------------------------------------------------
std::string trim(const std::string& s) {
    std::size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
    return s.substr(a, b - a);
}
std::string strip_quotes(const std::string& s) {
    std::size_t a = 0, b = s.size();
    while (a < b && (s[a] == '\'' || s[a] == '"' || s[a] == ' ')) ++a;
    while (b > a && (s[b - 1] == '\'' || s[b - 1] == '"' || s[b - 1] == ' ')) --b;
    return s.substr(a, b - a);
}

// ---- solver state --------------------------------------------------------------------------------------------------------------
struct Post {                       // MFeval "postProInputs": clamped values for the equations, raw ("u") copies for the outputs
    double Fz = 0, kappa = 0, alpha = 0, gamma = 0, phit = 0, p = 0;
    double uFz = 0, ukappa = 0, ukappaLow = 0, ualpha = 0, ugamma = 0, uVcx = 0;
    double omega = 0, phi = 0, FzLow = 0;
};
struct Internal {
    double eps_x = 1e-6, eps_k = 1e-6, eps_y = 1e-6, eps_v = 1e-6, eps_g = 0;
    double red_smooth = 1;          // low-speed reduction (1 above VXLOW)
    double zeta2 = 1;               // set by Fy0, read by the aligning moment and the combined Fy
};
struct Star { double alpha_star = 0, gamma_star = 0, LMUX_star = 1, LMUY_star = 1; };
struct Prime { double Fz0p = 0, alpha_prime = 0, LMUX_prime = 1, LMUY_prime = 1; };
struct Incr { double dfz = 0, dpi = 0; };

struct Ctx {
    const Params& p;
    const Modes& m;
    Post pp;
    Internal ip;
    Star sv;
    Prime pv;
    Incr iv;
    // the "E <= 1" checks of MFeval run only when the use-mode has the limit checks on
    double lim(double e) const { return m.limits_check ? std::min(e, 1.0) : e; }
};

bool is_mf52(const Params& p) { return p.fittyp == 5 || p.fittyp == 6 || p.fittyp == 21; }   // FITTYP 5 is an extension: MFeval accepts 6, 21, 61, 62

struct ReRes { double Re, Romega, omega; };

// effective rolling radius (MFeval calculateRe). omega_user != 0: use it. Otherwise omega is found from vx and kappa by MFeval's loop.
ReRes compute_re(const Params& p, double uFz, double Vcx, double ukappa, double dpi, double omega_user) {
    const double R0 = p.unloaded_radius, V0 = safe_den(p.longvl), Fz0 = safe_den(p.fnomin);
    const double Cz = safe_den(p.vertical_stiffness * (1.0 + p.pfz1 * dpi));                           // eq. 5 of the paper
    const double sag = (Fz0 / Cz) * (p.dreff * std::atan(p.breff * (uFz / Fz0)) + p.freff * (uFz / Fz0));   // eq. 7
    if (omega_user != 0.0) {
        const double omega = omega_user + DBL_EPSILON;                                                  // eps avoids Romega = 0
        const double Romega = R0 * (p.q_re0 + p.q_v1 * sq(omega * R0 / V0));                            // eq. 1
        return {Romega - sag, Romega, omega};
    }
    double Re = R0 * 0.965, Re_old = R0, omega = 0.0, Romega = R0 * p.q_re0;
    for (int i = 0; i < 100 && std::abs(Re_old - Re) > 1e-9; ++i) {                                    // MFeval has no iteration cap; 100 is far beyond need
        Re_old = Re;
        omega = (ukappa * Vcx + Vcx) / safe_den(Re);                                                    // Pacejka eq. 2.5
        Romega = R0 * (p.q_re0 + p.q_v1 * sq(omega * R0 / V0));
        Re = Romega - sag;
    }
    return {Re, Romega, omega};
}

void parse_inputs(Ctx& c, const Input& in) {
    const Params& p = c.p;
    Post& pp = c.pp;
    Internal& ip = c.ip;
    const double uFz = std::max(in.fz, 0.0);
    double kappa = in.kappa, alpha = in.alpha, gamma = in.gamma, phit = in.phit;
    const double Vcx = in.vx;
    double press = in.pressure != 0.0 ? in.pressure : p.inflpres;
    double ukappaLow = kappa, ualpha = alpha;
    const double ugamma = gamma;
    double Fz = uFz, FzLow = uFz;
    if (c.m.limits_check) {
        phit *= std::cos(alpha);                                                                         // "empirically discovered", with the original alpha
        const double VXLOW = p.vxlow;
        const bool low_speed = std::abs(Vcx) <= VXLOW;
        double lin = 1.0;
        if (low_speed) {                                                                                 // low-speed reduction factors
            lin = std::abs(Vcx / VXLOW);
            ip.red_smooth = 1.0 - 0.5 * (1.0 + std::cos(kPi * (Vcx / VXLOW)));
            ukappaLow *= lin;
            phit *= lin;
        }
        const double Vsy = std::tan(alpha) * Vcx;
        if (Vcx < 0.0) phit = -phit;                                                                     // reverse speed: the turn slip changes sign
        const double speedSum = std::abs(Vcx) + std::abs(Vsy);
        if (low_speed) kappa *= lin;
        if (speedSum < VXLOW) alpha *= speedSum / VXLOW;                                                 // the slip angle is reduced when |Vx| + |Vy| < VXLOW
        alpha = clampd(alpha, p.alpmin, p.alpmax);
        gamma = clampd(gamma, p.cammin, p.cammax);
        Fz = std::min(uFz, p.fzmax);
        FzLow = Fz < p.fzmin ? p.fzmin : Fz;                                                             // used for the aligning moment and (MF 5.2 / 6.1) the deflection
        press = clampd(press, p.presmin, p.presmax);
        kappa = clampd(kappa, p.kpumin, p.kpumax);
    }
    ualpha = Vcx == 0.0 ? 0.0 : ualpha;                                                                  // zero speed reports zero slip angle (MFeval)
    pp.Fz = Fz; pp.kappa = kappa; pp.alpha = alpha; pp.gamma = gamma; pp.phit = phit; pp.p = press;
    pp.uFz = uFz; pp.ukappa = in.kappa; pp.ukappaLow = ukappaLow; pp.ualpha = ualpha; pp.ugamma = ugamma; pp.uVcx = Vcx;
    pp.FzLow = FzLow;
    const double dpi = (press - p.nompres) / safe_den(p.nompres);                                        // eq. 4.E2b, with the limited pressure
    pp.omega = in.omega != 0.0 ? in.omega : compute_re(p, uFz, Vcx, in.kappa, dpi, 0.0).omega;
    if (c.m.turn_slip) {                                                                                 // spin slip phi, eqs. 4.75 / 4.76 / 4.90
        const double Fz0p = p.lfzo * p.fnomin;
        const double dfz = (Fz - Fz0p) / safe_den(Fz0p);
        ip.eps_g = p.pecp1 * (1.0 + p.pecp2 * dfz);
        const double Vsy = -std::tan(alpha) * std::abs(Vcx);
        double Vc_prime = std::sqrt(Vcx * Vcx + Vsy * Vsy);
        if (std::abs(Vcx) < p.vxlow) Vc_prime = p.vxlow * sgn(Vcx);                                      // singularity-protected speed
        const double psi_dot = -phit * Vc_prime;
        pp.phi = (1.0 / safe_den(Vc_prime)) * (psi_dot - (1.0 - ip.eps_g) * pp.omega * std::sin(gamma));
    }
}

void calc_basic_vars(Ctx& c) {
    const Params& p = c.p;
    const Post& pp = c.pp;
    const double Vcx = pp.uVcx;
    const double Vsx = -pp.kappa * std::abs(Vcx), Vsy = std::tan(pp.alpha) * std::abs(Vcx);
    const double Vs = std::sqrt(Vsx * Vsx + Vsy * Vsy);
    const double Vc = std::sqrt(Vcx * Vcx + Vsy * Vsy);                                                  // Vcy = Vsy (book p.67)
    c.pv.Fz0p = p.lfzo * p.fnomin;                                                                       // eq. 4.E1
    c.iv.dfz = (pp.Fz - c.pv.Fz0p) / safe_den(c.pv.Fz0p);                                                // eq. 4.E2a
    c.iv.dpi = (pp.p - p.nompres) / safe_den(p.nompres);                                                 // eq. 4.E2b
    if (c.m.alpha_star) {
        c.sv.alpha_star = std::tan(pp.alpha) * sign0(Vcx);                                                // eq. 4.E3
        c.sv.gamma_star = std::sin(pp.gamma);                                                            // eq. 4.E4
    } else {
        c.sv.alpha_star = pp.alpha;
        c.sv.gamma_star = pp.gamma;
    }
    const double Vc_prime = Vc + c.ip.eps_v * sgn(Vc);                                                   // eq. 4.E6a
    c.pv.alpha_prime = std::acos(clampd(Vcx / Vc_prime, -1.0, 1.0));                                     // eq. 4.E6
    const double LMUV = 0.0, Amu = 1.0;                                                                  // MFeval: LMUV is not in standard files, Amu = 1 matches TNO
    const double denom = 1.0 + LMUV * Vs / safe_den(p.longvl);
    c.sv.LMUX_star = p.lmux / denom;                                                                     // eq. 4.E7
    c.sv.LMUY_star = p.lmuy / denom;
    c.pv.LMUX_prime = Amu * c.sv.LMUX_star / (1.0 + (Amu - 1.0) * c.sv.LMUX_star);                       // eq. 4.E8
    c.pv.LMUY_prime = Amu * c.sv.LMUY_star / (1.0 + (Amu - 1.0) * c.sv.LMUY_star);
}

// ---- turn slip ---------------------------------------------------------------------------------------------------------------------
double zeta1_of(const Ctx& c, double dfz) {
    const Params& p = c.p;
    const double Bxp = p.pdxp1 * (1.0 + p.pdxp2 * dfz) * std::cos(std::atan(p.pdxp3 * c.pp.kappa));   // 4.106
    return std::cos(std::atan(Bxp * p.unloaded_radius * c.pp.phi));                                    // 4.105
}
void zeta2_3_of(const Ctx& c, double dfz, double& z2, double& z3) {
    const Params& p = c.p;
    const double R0 = p.unloaded_radius, phi = c.pp.phi;
    z3 = std::cos(std::atan(p.pkyp1 * R0 * R0 * phi * phi));                                           // 4.79
    const double Byp = p.pdyp1 * (1.0 + p.pdyp2 * dfz) * std::cos(std::atan(p.pdyp3 * std::tan(c.pp.alpha)));   // 4.78
    const double R0phi = R0 * std::abs(phi);
    z2 = std::cos(std::atan(Byp * (R0phi + p.pdyp4 * std::sqrt(R0phi))));                              // 4.77
}

// ---- pure slip ---------------------------------------------------------------------------------------------------------------------
struct Fx0Res { double fx0, mux, kxk; };

Fx0Res calc_fx0(const Ctx& c) {
    const Params& p = c.p;
    const double Fz = c.pp.Fz, kappa = c.pp.kappa, gamma = c.pp.gamma, Vcx = c.pp.uVcx, dfz = c.iv.dfz, dpi = c.iv.dpi;
    const double zeta1 = c.m.turn_slip ? zeta1_of(c, dfz) : 1.0;
    const double Cx = p.pcx1 * p.lcx;                                                                    // 4.E11
    double mux = (p.pdx1 + p.pdx2 * dfz) * (1.0 + p.ppx3 * dpi + p.ppx4 * dpi * dpi) * (1.0 - p.pdx3 * gamma * gamma) * c.sv.LMUX_star;  // 4.E13
    if (Fz == 0.0) mux = 0.0;
    const double Dx = mux * Fz * zeta1;                                                                  // 4.E12
    const double Kxk = Fz * (p.pkx1 + p.pkx2 * dfz) * std::exp(p.pkx3 * dfz) * (1.0 + p.ppx1 * dpi + p.ppx2 * dpi * dpi) * p.lkx;   // 4.E15
    const double Bx = Kxk / (Cx * Dx + c.ip.eps_x * sgn(Dx));                                            // 4.E16
    double SHx = (p.phx1 + p.phx2 * dfz) * p.lhx;                                                        // 4.E17
    double SVx = Fz * (p.pvx1 + p.pvx2 * dfz) * p.lvx * c.pv.LMUX_prime * zeta1;                         // 4.E18
    if (c.ip.red_smooth != 1.0) { SHx *= c.ip.red_smooth; SVx *= c.ip.red_smooth; }
    const double kappax = kappa + SHx;                                                                   // 4.E10
    const double Ex = c.lim((p.pex1 + p.pex2 * dfz + p.pex3 * dfz * dfz) * (1.0 - p.pex4 * sign0(kappax)) * p.lex);   // 4.E14
    double Fx0 = Dx * std::sin(Cx * std::atan(Bx * kappax - Ex * (Bx * kappax - std::atan(Bx * kappax)))) + SVx;   // 4.E9
    if (Vcx < 0.0) Fx0 = -Fx0;
    return {Fx0, mux, Kxk};
}

struct Fy0Res { double fy0, muy, zeta2; double SHy, SVy, By, Cy, Kya, Kyg0, SVyg; };

// pure lateral force (MFeval calculateFy0); pure: the caller stores zeta2. The aligning moment re-runs it with gamma = 0 (copy of the context).
Fy0Res calc_fy0(const Ctx& c) {
    const Params& p = c.p;
    const double Fz = c.pp.Fz, Vcx = c.pp.uVcx, dfz = c.iv.dfz, dpi = c.iv.dpi, Fz0p = c.pv.Fz0p;
    const double a_star = c.sv.alpha_star, g_star = c.sv.gamma_star, LMUY_prime = c.pv.LMUY_prime, eps_k = c.ip.eps_k;
    double zeta2 = 1.0, zeta3 = 1.0;
    if (c.m.turn_slip) zeta2_3_of(c, dfz, zeta2, zeta3);
    const double zeta0 = c.m.turn_slip ? 0.0 : 1.0;
    const bool mf52 = is_mf52(p);

    const double Kya = p.pky1 * Fz0p * (1.0 + p.ppy1 * dpi) * (1.0 - p.pky3 * std::abs(g_star)) *
                       std::sin(p.pky4 * std::atan((Fz / Fz0p) / ((p.pky2 + p.pky5 * g_star * g_star) * (1.0 + p.ppy2 * dpi)))) * zeta3 * p.lky;   // 4.E25
    const double SVyg = Fz * (p.pvy3 + p.pvy4 * dfz) * g_star * p.lkyc * LMUY_prime * zeta2;                                                       // 4.E28
    double Kyg0;
    if (mf52) {                                                                                                                                // from the MF-Tyre manual: LKYC multiplies the whole sum
        const double Kya0 = p.pky1 * Fz0p * std::sin(p.pky4 * std::atan(Fz / (p.pky2 * Fz0p))) * p.lkyc;
        Kyg0 = (p.phy3 * Kya0 + Fz * (p.pvy3 + p.pvy4 * dfz)) * p.lkyc;
    } else {
        Kyg0 = Fz * (p.pky6 + p.pky7 * dfz) * (1.0 + p.ppy5 * dpi) * p.lkyc;                                                                       // 4.E30
    }

    double zeta4 = 1.0;
    if (c.m.turn_slip) {                                                                                                                       // eqs. 4.80 - 4.90
        const double R0 = p.unloaded_radius, phi = c.pp.phi;
        const double Kya0 = p.pky1 * Fz0p * (1.0 + p.ppy1 * dpi) * std::sin(p.pky4 * std::atan((Fz / Fz0p) / (p.pky2 * (1.0 + p.ppy2 * dpi)))) * zeta3 * p.lky;
        const double Kya_prime = Kya + eps_k * sgn(Kya), Kyao_prime = Kya0 + eps_k * sgn(Kya0);
        const double KyRp0 = Kyg0 / (1.0 - c.ip.eps_g);                                                                                        // 4.89
        const double CHyp = p.phyp1, DHyp = (p.phyp2 + p.phyp3 * dfz) * sgn(Vcx), EHyp = c.lim(p.phyp4);                                         // 4.E85-87 (DEVIATION: MFeval's sign(0) = 0 gives BHyp = Inf, SHyp = NaN at Vx = 0)
        const double BHyp = KyRp0 / (CHyp * DHyp * Kyao_prime);                                                                                // 4.E88
        const double SHyp = DHyp * std::sin(CHyp * std::atan(BHyp * R0 * phi - EHyp * (BHyp * R0 * phi - std::atan(BHyp * R0 * phi)))) * sgn(Vcx);   // 4.E80
        zeta4 = 1.0 + SHyp - SVyg / Kya_prime;                                                                                                 // 4.E84
    }

    double SHy = mf52 ? (p.phy1 + p.phy2 * dfz) * p.lhy + p.phy3 * g_star * p.lkyc
                      : (p.phy1 + p.phy2 * dfz) * p.lhy + ((Kyg0 * g_star - SVyg) / (Kya + eps_k * sgn(Kya))) * zeta0 + zeta4 - 1.0;          // 4.E27
    double SVy = Fz * (p.pvy1 + p.pvy2 * dfz) * p.lvy * LMUY_prime * zeta2 + SVyg;                                                             // 4.E29
    if (c.ip.red_smooth != 1.0) { SHy *= c.ip.red_smooth; SVy *= c.ip.red_smooth; }
    const double alphay = a_star + SHy;                                                                                                        // 4.E20
    const double Cy = p.pcy1 * p.lcy;                                                                                                          // 4.E21
    double muy = (p.pdy1 + p.pdy2 * dfz) * (1.0 + p.ppy3 * dpi + p.ppy4 * dpi * dpi) * (1.0 - p.pdy3 * g_star * g_star) * c.sv.LMUY_star;      // 4.E23
    const double Dy = muy * Fz * zeta2;                                                                                                        // 4.E22
    const double Ey = c.lim((p.pey1 + p.pey2 * dfz) * (1.0 + p.pey5 * g_star * g_star - (p.pey3 + p.pey4 * g_star) * sgn(alphay)) * p.ley);   // 4.E24
    const double By = Kya / (Cy * Dy + c.ip.eps_y * sgn(Dy));                                                                                  // 4.E26
    double Fy0 = Dy * std::sin(Cy * std::atan(By * alphay - Ey * (By * alphay - std::atan(By * alphay)))) + SVy;                              // 4.E19
    if (c.m.alpha_star && Vcx < 0.0) Fy0 = -Fy0;
    if (Fz == 0.0) muy = 0.0;
    return {Fy0, muy, zeta2, SHy, SVy, By, Cy, Kya, Kyg0, SVyg};
}

// ---- combined slip -----------------------------------------------------------------------------------------------------------------
double calc_fx(const Ctx& c, double Fx0) {
    const Params& p = c.p;
    const double kappa = c.pp.kappa, a_star = c.sv.alpha_star, g_star = c.sv.gamma_star, dfz = c.iv.dfz;
    const double Cxa = p.rcx1;                                                                           // 4.E55
    const double Exa = c.lim(p.rex1 + p.rex2 * dfz);                                                     // 4.E56
    const double SHxa = p.rhx1;                                                                          // 4.E57
    const double Bxa = (p.rbx1 + p.rbx3 * g_star * g_star) * std::cos(std::atan(p.rbx2 * kappa)) * p.lxal;   // 4.E54
    const double as = a_star + SHxa;                                                                     // 4.E53
    const double Gxa0 = std::cos(Cxa * std::atan(Bxa * SHxa - Exa * (Bxa * SHxa - std::atan(Bxa * SHxa))));   // 4.E52
    const double Gxa = std::cos(Cxa * std::atan(Bxa * as - Exa * (Bxa * as - std::atan(Bxa * as)))) / safe_den(Gxa0);   // 4.E51
    return Gxa * Fx0;                                                                                    // 4.E50
}

struct FyRes { double fy, gyk, svyk; };
FyRes calc_fy(const Ctx& c, const Internal& ip, double Fy0, double muy) {
    const Params& p = c.p;
    const double Fz = c.pp.Fz, kappa = c.pp.kappa, a_star = c.sv.alpha_star, g_star = c.sv.gamma_star, dfz = c.iv.dfz;
    const double zeta2 = c.m.turn_slip ? ip.zeta2 : 1.0;
    const double DVyk = muy * Fz * (p.rvy1 + p.rvy2 * dfz + p.rvy3 * g_star) * std::cos(std::atan(p.rvy4 * a_star)) * zeta2;   // 4.E67
    double SVyk = DVyk * std::sin(p.rvy5 * std::atan(p.rvy6 * kappa)) * p.lvyka;                                                  // 4.E66
    const double SHyk = p.rhy1 + p.rhy2 * dfz;                                                           // 4.E65
    const double Eyk = c.lim(p.rey1 + p.rey2 * dfz);                                                     // 4.E64
    const double Cyk = p.rcy1;                                                                           // 4.E63
    const double Byk = (p.rby1 + p.rby4 * g_star * g_star) * std::cos(std::atan(p.rby2 * (a_star - p.rby3))) * p.lyka;   // 4.E62
    const double ks = kappa + SHyk;                                                                      // 4.E61
    const double Gyk0 = std::cos(Cyk * std::atan(Byk * SHyk - Eyk * (Byk * SHyk - std::atan(Byk * SHyk))));   // 4.E60
    const double Gyk = std::cos(Cyk * std::atan(Byk * ks - Eyk * (Byk * ks - std::atan(Byk * ks)))) / safe_den(Gyk0);   // 4.E59
    if (ip.red_smooth != 1.0) SVyk *= ip.red_smooth;
    return {Gyk * Fy0 + SVyk, Gyk, SVyk};                                                                // 4.E58
}

// ---- moments -----------------------------------------------------------------------------------------------------------------------
double calc_mx(const Ctx& c, double Fy) {
    const Params& p = c.p;
    const double gamma = c.pp.gamma, dpi = c.iv.dpi, Fz0 = safe_den(p.fnomin), R0 = p.unloaded_radius;
    const double FzE = c.pp.Fz < p.fzmin ? c.pp.Fz * sq(c.pp.Fz / safe_den(p.fzmin)) : c.pp.Fz;          // low-load correction (MFeval, "empirically discovered")
    // MFeval has two spellings (draft-paper eq. 49 when both QSX1..11 and QSX12..14 are set, the TNO manual form otherwise); they are algebraically equal
    return R0 * FzE * p.lmx *
               (p.qsx1 * p.lvmx - p.qsx2 * gamma * (1.0 + p.ppmx1 * dpi) + p.qsx3 * (Fy / Fz0) +
                p.qsx4 * std::cos(p.qsx5 * std::atan(sq(p.qsx6 * (FzE / Fz0)))) * std::sin(p.qsx7 * gamma + p.qsx8 * std::atan(p.qsx9 * (Fy / Fz0))) +
                p.qsx10 * std::atan(p.qsx11 * (FzE / Fz0)) * gamma) +
           R0 * p.lmx * (Fy * (p.qsx13 + p.qsx14 * std::abs(gamma)) - FzE * p.qsx12 * gamma * std::abs(gamma));
}

double calc_my(const Ctx& c, double Fx) {
    const Params& p = c.p;
    const double Vcx = c.pp.uVcx, kappa = c.pp.ukappa, gamma = c.pp.gamma, press = c.pp.p, uFz = c.pp.uFz;
    const double V0 = safe_den(p.longvl), R0 = p.unloaded_radius, Fz0 = safe_den(p.fnomin), pi0 = safe_den(p.nompres);
    const double FzE = uFz < p.fzmin ? uFz * (uFz / safe_den(p.fzmin)) : uFz;
    double My;
    if (is_mf52(p)) {                                                                                    // MF-Tyre manual
        My = -R0 * FzE * p.lmy * (p.qsy1 + p.qsy2 * (Fx / Fz0) + p.qsy3 * std::abs(Vcx / V0) + p.qsy4 * std::pow(Vcx / V0, 4.0));
    } else {                                                                                             // Besselink eq. A48 (the book's 4.E70 has a sign / Fz error)
        My = -R0 * Fz0 * p.lmy *
             (p.qsy1 + p.qsy2 * (Fx / Fz0) + p.qsy3 * std::abs(Vcx / V0) + p.qsy4 * std::pow(Vcx / V0, 4.0) + (p.qsy5 + p.qsy6 * (FzE / Fz0)) * gamma * gamma) *
             (std::pow(FzE / Fz0, p.qsy7) * std::pow(press / pi0, p.qsy8));
    }
    if (Vcx < 0.0) My = -My;
    if (Vcx == 0.0) return 0.0;
    const double highLimit = p.vxlow / std::abs(Vcx) - 1.0;                                              // low-speed interpolation (MFeval "empirically discovered")
    const double lowLimit = -1.0 - p.vxlow - highLimit;
    if (kappa >= lowLimit && kappa <= highLimit) {
        const double x0 = -1.0, x1 = highLimit;
        My *= std::sin(((0.0) * (x1 - kappa) + (kPi / 2.0) * (kappa - x0)) / safe_den(x1 - x0));
    } else if (kappa < lowLimit) {
        My = -My;
    }
    return My;
}

struct Mz0Ints { double alphar, alphat, Dr, Cr, Br, Dt, Ct, Bt, Et, Kya_prime; };

Mz0Ints calc_mz0(const Ctx& c, const Fy0Res& fy0) {
    const Params& p = c.p;
    const double dfz = c.iv.dfz, dpi = c.iv.dpi, a_star = c.sv.alpha_star, g_star = c.sv.gamma_star, Fz0p = c.pv.Fz0p;
    const double Fz = c.pp.Fz <= 0.0 ? 0.0 : (c.m.limits_check ? c.pp.FzLow : c.pp.Fz);                  // Fz with the low limit (0 for no load)
    const double Vcx = c.pp.uVcx, gamma = c.pp.gamma, R0 = p.unloaded_radius;
    const double Kya_prime = fy0.Kya + c.ip.eps_k * sgn(fy0.Kya);                                        // 4.E39
    const double SHf = fy0.SHy + fy0.SVy / Kya_prime;                                                    // 4.E38
    const double alphar = a_star + SHf;                                                                  // 4.E37
    const double SHt = p.qhz1 + p.qhz2 * dfz + (p.qhz3 + p.qhz4 * dfz) * g_star;                         // 4.E35
    const double alphat = a_star + SHt;                                                                  // 4.E34
    const double zeta5 = c.m.turn_slip ? std::cos(std::atan(p.qdtp1 * R0 * c.pp.phi)) : 1.0;            // 4.E91
    const double Bt = (p.qbz1 + p.qbz2 * dfz + p.qbz3 * dfz * dfz) * (1.0 + p.qbz4 * gamma + p.qbz5 * std::abs(gamma)) * p.lky / c.sv.LMUY_star;   // Besselink A58
    const double Ct = p.qcz1;                                                                            // 4.E41
    const double Dt = (p.qdz1 + p.qdz2 * dfz) * (1.0 - p.ppz1 * dpi) * (1.0 + p.qdz3 * gamma + p.qdz4 * gamma * gamma) * Fz * (R0 / Fz0p) * p.ltr * zeta5;   // A60
    const double Et = c.lim((p.qez1 + p.qez2 * dfz + p.qez3 * dfz * dfz) * (1.0 + (p.qez4 + p.qez5 * g_star) * (2.0 / kPi) * std::atan(Bt * Ct * alphat)));   // 4.E44

    double zeta0 = 1.0, zeta2 = 1.0, zeta6 = 1.0, zeta7 = 1.0, zeta8 = 1.0;
    if (c.m.turn_slip) {                                                                                 // eqs. 4.91 - 4.103 and the TNO manual's zeta7 / zeta8
        zeta0 = 0.0;
        zeta2 = c.ip.zeta2;
        const double phi = c.pp.phi, phit = c.pp.phit;
        zeta6 = std::cos(std::atan(p.qbrp1 * R0 * phi));                                                 // 4.102
        double Mzp_inf = p.qcrp1 * std::abs(fy0.muy) * R0 * Fz * std::sqrt(Fz / Fz0p) * p.lmp;           // 4.95
        if (Mzp_inf < 0.0) Mzp_inf = 1e-6;
        const double CDrp = p.qdrp1;                                                                     // 4.96
        const double DDrp = Mzp_inf / std::sin(0.5 * kPi * CDrp);                                        // 4.94
        const double Kzgr0 = Fz * R0 * (p.qdz8 * p.qdz9 * dfz + (p.qdz10 + p.qdz11 * dfz * std::abs(gamma))) * p.lkzc;   // 4.99 as written in MFeval
        const double BDrp = Kzgr0 / (CDrp * DDrp * (1.0 - c.ip.eps_g));
        // DEVIATION: with no load Mzp_inf = 0, so BDrp = 0/0 = NaN in MFeval; there is no spin torque without load: Drp = 0.
        const double Drp = (DDrp == 0.0 || !std::isfinite(BDrp)) ? 0.0 : DDrp * std::sin(CDrp * std::atan(BDrp * R0 * phit));
        const double Gyk = calc_fy(c, c.ip, fy0.fy0, fy0.muy).gyk;
        const double Mzp90 = Mzp_inf * (2.0 / kPi) * std::atan(p.qcrp2 * R0 * std::abs(phit)) * Gyk;     // 4.103
        // DEVIATION: with phit = 0 MFeval computes acos(0/0) = NaN and returns NaN for Mz. Without spin the turn-slip effect must vanish: zeta7 = 1.
        // For |ratio| > 1 MFeval's acos is complex and real() keeps the real part (0 or pi): clamping gives the same.
        if (std::abs(Drp) < 1e-12 && std::abs(Mzp90) < 1e-12) zeta7 = 1.0;
        else zeta7 = (2.0 / kPi) * std::acos(clampd(Mzp90 / safe_den(std::abs(Drp), 1e-300), -1.0, 1.0));
        zeta8 = 1.0 + Drp;
    }
    const double Dr = Fz * R0 *
                          ((p.qdz6 + p.qdz7 * dfz) * p.lres * zeta2 +
                           ((p.qdz8 + p.qdz9 * dfz) * (1.0 + p.ppz2 * dpi) + (p.qdz10 + p.qdz11 * dfz) * std::abs(g_star)) * g_star * p.lkzc * zeta0) *
                          c.sv.LMUY_star * sign0(Vcx) * std::cos(a_star) + zeta8 - 1.0;                    // 4.E47
    const double Br = (p.qbz9 * p.lky / c.sv.LMUY_star + p.qbz10 * fy0.By * fy0.Cy) * zeta6;             // 4.E45
    const double Cr = zeta7;                                                                             // 4.E46
    return {alphar, alphat, Dr, Cr, Br, Dt, Ct, Bt, Et, Kya_prime};
}

struct MzRes { double mz, t, mzr; };
MzRes calc_mz(const Ctx& c, const Mz0Ints& m, double Kxk, double Fy, double Fx, double SVyk) {
    const Params& p = c.p;
    const double kappa = c.pp.kappa, gamma = c.pp.gamma, dfz = c.iv.dfz, R0 = p.unloaded_radius, Fz0 = safe_den(p.fnomin);
    const double ratio_sq = sq(Kxk / m.Kya_prime) * kappa * kappa;
    const double alphar_eq = std::atan(std::sqrt(sq(std::tan(m.alphar)) + ratio_sq)) * sign0(m.alphar);   // Besselink A54
    const double alphat_eq = std::atan(std::sqrt(sq(std::tan(m.alphat)) + ratio_sq)) * sign0(m.alphat);   // A55
    const double s = R0 * (p.ssz1 + p.ssz2 * (Fy / Fz0) + (p.ssz3 + p.ssz4 * dfz) * gamma) * p.ls;       // A56 (Fz0, not Fz0')
    double Mzr = m.Dr * std::cos(m.Cr * std::atan(m.Br * alphar_eq));                                    // 4.E75
    // Fy' = Gyk(phit = 0) Fy0(gamma = 0): Fy0 re-run with gamma = 0 but the SAME use-mode (turn slip stays on, as in MFeval); Gyk with zeta2 = 1 and the real gamma
    Ctx c0 = c;
    c0.pp.gamma = 0.0;
    c0.sv.gamma_star = 0.0;
    const Fy0Res fy0_g0 = calc_fy0(c0);
    Internal ip_sub0 = c.ip;
    ip_sub0.zeta2 = 1.0;
    const double Gyk_sub0 = calc_fy(c, ip_sub0, fy0_g0.fy0, fy0_g0.muy).gyk;
    const double Fy_prime = Gyk_sub0 * fy0_g0.fy0;                                                       // 4.E74
    double t = m.Dt * std::cos(m.Ct * std::atan(m.Bt * alphat_eq - m.Et * (m.Bt * alphat_eq - std::atan(m.Bt * alphat_eq)))) * std::cos(c.pv.alpha_prime);   // 4.E73
    t *= p.lfzo;                                                                                         // matches the TNO solver (MFeval)
    if (c.ip.red_smooth != 1.0) { t *= c.ip.red_smooth; Mzr *= c.ip.red_smooth; }
    const double Mz = is_mf52(p) ? -t * (Fy - SVyk) + Mzr + s * Fx : -t * Fy_prime + Mzr + s * Fx;       // MF 5.2 form / 4.E72 + 4.E71
    return {Mz, t, Mzr};
}

// ---- geometry ----------------------------------------------------------------------------------------------------------------------
// MF 6.2: the vertical force as a function of the loaded radius Rl (camber, Fx and Fy dependent); the loaded radius solves Fz(Rl) = Fz.
void fz62(const Params& p, double gamma, double omega, double Romega, double dpi, double Rl, double Fx, double Fy, double& Fz_out, double& rho_out) {
    const double V0 = safe_den(p.longvl), R0 = p.unloaded_radius, Fz0 = safe_den(p.fnomin), Cz0 = p.vertical_stiffness;
    const double Q_FZ1 = std::sqrt(std::max(sq(Cz0 * R0 / Fz0) - 4.0 * p.q_fz2, 0.0));
    const double rr = Rl / safe_den(Romega);
    const double Sfyg = (p.q_fys1 + p.q_fys2 * rr + p.q_fys3 * rr * rr) * gamma;
    const double rho_zfr = std::max(Romega - Rl, 0.0);
    const double rtw = (1.075 - 0.5 * p.aspect_ratio) * p.width;                                         // reference tread width
    const double cam_num = (p.q_cam1 * Rl + p.q_cam2 * Rl * Rl) * gamma;
    const double cam_den = (p.q_cam1 * Romega + p.q_cam2 * Romega * Romega) * gamma;
    // MFeval: (num^2 (rtw/8) |tan g|) / den^2 - Q_CAM3 rho_zfr |g|, and any NaN (0/0 when gamma = 0 or Q_CAM1 = Q_CAM2 = 0) becomes 0 for the whole term
    double rho_zg = (std::abs(gamma) < 1e-15 || cam_den == 0.0) ? 0.0 : sq(cam_num) * (rtw / 8.0) * std::abs(std::tan(gamma)) / sq(cam_den) - p.q_cam3 * rho_zfr * std::abs(gamma);
    if (std::isnan(rho_zg)) rho_zg = 0.0;
    const double rho_z = std::max(rho_zfr + rho_zg, 1e-12);
    const double fcorr = (1.0 + p.q_v2 * (R0 / V0) * std::abs(omega) - sq(p.q_fcx * Fx / Fz0) -
                          sq(std::pow(rho_z / R0, p.q_fcy2) * (p.q_fcy * (Fy - Sfyg) / Fz0))) * (1.0 + p.pfz1 * dpi);
    Fz_out = fcorr * (Q_FZ1 * (rho_z / R0) + p.q_fz2 * sq(rho_z / R0)) * Fz0;
    rho_out = rho_z;
}

double secant_rl(const Params& p, double gamma, double omega, double Romega, double dpi, double Fx, double Fy, double Fz_tgt) {
    const double R0 = p.unloaded_radius, tol = p.fnomin * 1e-6;
    double x0 = R0 * 0.95, x1 = R0, fz = 0, rho = 0;
    fz62(p, gamma, omega, Romega, dpi, x0, Fx, Fy, fz, rho);
    double y0 = fz - Fz_tgt;
    fz62(p, gamma, omega, Romega, dpi, x1, Fx, Fy, fz, rho);
    double y1 = fz - Fz_tgt, x = x1;
    for (int i = 3; i <= 20; ++i) {                                                                      // MFeval's solve_secant: at most 20 calls
        const double dy = y1 - y0;
        if (dy == 0.0) break;                                                                            // DEVIATION: MFeval would divide by zero here
        x = x1 - (x1 - x0) / dy * y1;
        fz62(p, gamma, omega, Romega, dpi, x, Fx, Fy, fz, rho);
        const double y = fz - Fz_tgt;
        if (!(std::abs(y) > tol)) break;
        if (std::abs(y1) < std::abs(y0)) { x0 = x1; y0 = y1; }
        x1 = x;
        y1 = y;
    }
    return x;
}

struct Geom { double rho, Rl, Cz; };

Geom calc_rho_rl(const Ctx& c, double dpi, double omega, double Romega, double Fx, double Fy) {
    const Params& p = c.p;
    if (p.fittyp == 62) {
        const double Rl = secant_rl(p, c.pp.gamma, omega, Romega, dpi, Fx, Fy, c.pp.uFz);
        double fz = 0, rho = 0;
        fz62(p, c.pp.gamma, omega, Romega, dpi, Rl, Fx, Fy, fz, rho);
        if (c.pp.Fz == 0.0) rho = 1e-6;
        return {rho, Rl, c.pp.Fz / rho};
    }
    const double Fz = c.pp.FzLow, R0 = p.unloaded_radius, V0 = safe_den(p.longvl), Fz0 = safe_den(p.fnomin);
    const double Q_FZ1 = std::sqrt(std::max(sq(p.vertical_stiffness * R0 / Fz0) - 4.0 * p.q_fz2, 0.0));
    const double ext = (1.0 + p.q_v2 * (R0 / V0) * std::abs(omega) - sq(p.q_fcx * Fx / Fz0) - sq(p.q_fcy * Fy / Fz0)) * (1.0 + p.pfz1 * dpi) * Fz0;
    const double A = p.q_fz2, B = Q_FZ1, C = -(Fz / safe_den(ext, 1e-15));
    // A x^2 + B x + C = 0 with x = rho / R0. DEVIATION: A = 0 (no quadratic term) is solved linearly; MFeval divides by zero.
    const double x = std::abs(A) < 1e-12 ? -C / safe_den(B) : (-B + std::sqrt(std::max(B * B - 4.0 * A * C, 0.0))) / (2.0 * A);
    double rho = std::max(x * R0, 0.0);
    const double Rl = std::max(Romega - rho, 0.0);
    if (Fz == 0.0) rho = 1e-6;
    return {rho, Rl, Fz / rho};
}

struct Patch { double a, b; };
Patch calc_contact_patch(const Ctx& c, double dpi) {
    const Params& p = c.p;
    const double uFz = c.pp.uFz, R0 = p.unloaded_radius, w = p.width, Cz0 = p.vertical_stiffness, Fz0 = safe_den(p.fnomin);
    const double NCz = safe_den(Cz0 * (1.0 + p.pfz1 * dpi));                                             // eq. 5 of the paper
    const double Rl_approx = R0 - uFz / NCz;
    const double FzE = (Rl_approx - (p.rim_radius + p.bottom_offst) < 0.0) ? (R0 - p.rim_radius - p.bottom_offst) * NCz : uFz;   // tyre bottoming
    if (is_mf52(p)) {
        double q1 = p.q_a1, q2 = p.q_a2;
        if (q1 == 0.0 && q2 == 0.0) {                                                                    // default derived from the vertical stiffness
            const double y = std::log10(std::max(R0 * (Cz0 / Fz0), 1e-12));
            q1 = -0.0388 * y * y * y + 0.2509 * y * y + -0.6283 * y + 0.6279;
            q2 = 1.693 * q1 * q1;
        }
        return {R0 * (q2 * (FzE / Fz0) + q1 * std::sqrt(std::max(FzE / Fz0, 0.0))), w / 2.0};
    }
    const double nr = std::max(FzE / (NCz * R0), 0.0);                                                   // eqs. 9 and 10 of the paper
    return {R0 * (p.q_ra2 * nr + p.q_ra1 * std::sqrt(nr)), w * (p.q_rb2 * nr + p.q_rb1 * std::cbrt(nr))};
}

struct Relax { double Cx, Cy, sigmax, sigmay; };
Relax calc_relax(const Ctx& c, double Kxk, double Kya) {
    const Params& p = c.p;
    const double Fz = c.pp.Fz, gamma = c.pp.gamma, R0 = p.unloaded_radius, Fz0 = safe_den(p.fnomin);
    const double Fz0p = p.lfzo * p.fnomin;
    const double dfz = (Fz - Fz0p) / safe_den(Fz0p), dpi = (c.pp.p - p.nompres) / safe_den(p.nompres);
    const double Cx = p.longitudinal_stiffness * (1.0 + p.pcfx1 * dfz + p.pcfx2 * dfz * dfz) * (1.0 + p.pcfx3 * dpi);   // eqs. 17, 18 of the paper
    const double Cy = p.lateral_stiffness * (1.0 + p.pcfy1 * dfz + p.pcfy2 * dfz * dfz) * (1.0 + p.pcfy3 * dpi);
    double sx, sy;
    if (is_mf52(p)) {
        sx = (p.ptx1 + p.ptx2 * dfz) * std::exp(-p.ptx3 * dfz) * p.lsgkp * R0 * Fz / Fz0;
        sy = p.pty1 * std::sin(2.0 * std::atan(Fz / safe_den(p.pty2 * Fz0p))) * (1.0 - p.pky3 * std::abs(gamma)) * R0 * p.lfzo * p.lsgal;
    } else {
        sx = std::abs(Kxk / safe_den(Cx));                                                               // eq. 19 of the paper
        sy = std::abs(Kya / safe_den(Cy));
    }
    return {Cx, Cy, sx, sy};
}

Output evaluate_impl(const Params& p, const Input& in, const Modes& modes, double* alpha_used) {
    Output o;
    if (!modes.valid) {
        const double nan = std::numeric_limits<double>::quiet_NaN();
        o.fx = o.fy = o.fz = o.mx = o.my = o.mz = o.kappa = o.alpha = o.gamma = o.phit = o.vx = o.pressure = nan;
        o.re = o.rho = o.two_a = o.t = o.mux = o.muy = o.omega = o.rl = o.two_b = o.mzr = nan;
        o.cx = o.cy = o.cz = o.kya = o.sigmax = o.sigmay = o.inst_kya = o.kxk = nan;
        if (alpha_used) *alpha_used = nan;
        return o;
    }
    Ctx c{p, modes, {}, {}, {}, {}, {}};
    parse_inputs(c, in);
    calc_basic_vars(c);
    const Fx0Res fx0 = calc_fx0(c);
    const Fy0Res fy0 = calc_fy0(c);
    c.ip.zeta2 = fy0.zeta2;
    const Mz0Ints mz0 = calc_mz0(c, fy0);
    const double Fx = calc_fx(c, fx0.fx0);
    const FyRes fy = calc_fy(c, c.ip, fy0.fy0, fy0.muy);
    const double Mx = calc_mx(c, fy.fy);
    const double My = calc_my(c, Fx);
    const MzRes mz = calc_mz(c, mz0, fx0.kxk, fy.fy, Fx, fy.svyk);
    const double dpi = c.iv.dpi;
    const ReRes re = compute_re(p, c.pp.uFz, c.pp.uVcx, c.pp.ukappa, dpi, in.omega);                     // Re and omega of the output: the user's omega, else MFeval's loop
    const Geom g = calc_rho_rl(c, dpi, re.omega, re.Romega, Fx, fy.fy);
    const Patch patch = calc_contact_patch(c, dpi);
    const Relax rl = calc_relax(c, fx0.kxk, fy0.Kya);
    o.fx = Fx; o.fy = fy.fy; o.fz = c.pp.uFz; o.mx = Mx; o.my = My; o.mz = mz.mz;
    o.kappa = c.pp.ukappaLow; o.alpha = c.pp.ualpha; o.gamma = c.pp.ugamma; o.phit = c.pp.phit; o.vx = c.pp.uVcx; o.pressure = c.pp.p;
    o.re = re.Re; o.rho = g.rho; o.two_a = 2.0 * patch.a; o.t = mz.t; o.mux = fx0.mux;
    o.muy = modes.limits_check ? std::abs(fy0.muy) : fy0.muy;                                            // MFeval forces a negative muy positive when the limits are checked
    o.omega = re.omega; o.rl = g.Rl; o.two_b = 2.0 * patch.b; o.mzr = mz.mzr;
    o.cx = rl.Cx; o.cy = rl.Cy; o.cz = g.Cz; o.kya = fy0.Kya; o.sigmax = rl.sigmax; o.sigmay = rl.sigmay; o.inst_kya = 0.0; o.kxk = fx0.kxk;
    if (alpha_used) *alpha_used = c.pp.alpha;
    return o;
}

}  // namespace

// ---- public ------------------------------------------------------------------------------------------------------------------------
bool parse_tir(const std::string& text, Params& out, std::string& error) {
    std::unordered_map<std::string, double> num;
    std::unordered_map<std::string, std::string> str;
    std::istringstream in(text);
    std::string raw;
    bool skip = false;                                                                                   // the obsolete [SHAPE] section is skipped
    while (std::getline(in, raw)) {
        const std::string line = trim(raw);
        if (line.empty()) continue;
        if (line[0] == '[') { skip = line.rfind("[SHAPE]", 0) == 0; continue; }
        if (line[0] == '$' || line[0] == '!' || skip) continue;
        const std::size_t eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string key = trim(line.substr(0, eq));
        if (key.empty()) continue;
        for (char& ch : key) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
        std::string val = line.substr(eq + 1);
        const std::size_t dollar = val.find('$');
        if (dollar != std::string::npos) val.resize(dollar);
        val = trim(val);
        if (val.empty()) continue;
        char* endp = nullptr;
        const double d = std::strtod(val.c_str(), &endp);
        if (endp != val.c_str() && *endp == '\0' && std::isfinite(d)) num[key] = d;
        else str[key] = strip_quotes(val);                                                               // e.g. MASS = 'kg' in [UNITS]; the numeric MASS later still lands in num
    }
    int fittyp = 0;
    const auto it = num.find("FITTYP");
    if (it != num.end()) {
        fittyp = static_cast<int>(std::lround(it->second));
    } else {
        const auto fmt = str.find("PROPERTY_FILE_FORMAT");                                                // Project Chrono's PAC2002 files give no FITTYP
        if (fmt == str.end() || fmt->second != "PAC2002") { error = "FITTYP not found in the tyre property file"; return false; }
        fittyp = 21;
    }
    if (fittyp != 5 && fittyp != 6 && fittyp != 21 && fittyp != 61 && fittyp != 62) {
        error = "unsupported FITTYP " + std::to_string(fittyp) + " (supported: 5, 6 and 21 = MF 5.2 / PAC2002 family, 61, 62)";
        return false;
    }
    Params p;
    p.fittyp = fittyp;
#define RS_MF62_LOAD(field, key, def) { const auto f_ = num.find(key); p.field = f_ != num.end() ? f_->second : def; }
    RS_MF62_COEFFS(RS_MF62_LOAD)
#undef RS_MF62_LOAD
    const auto side = str.find("TYRESIDE");
    if (side != str.end()) p.tyreside = side->second;
    out = p;
    return true;
}

bool load_tir_file(const std::string& path, Params& out, std::string& error) {
    std::ifstream f(path, std::ios::binary);
    if (!f) { error = "cannot open " + path; return false; }
    std::ostringstream ss;
    ss << f.rdbuf();
    return parse_tir(ss.str(), out, error);
}

Modes modes_from_use_mode(int use_mode) {
    const int hundreds = use_mode / 100, tens = (use_mode % 100) / 10, units = use_mode % 10;
    Modes m;
    m.valid = use_mode >= 100 && use_mode <= 999 && (hundreds == 1 || hundreds == 2) && (tens == 1 || tens == 2) && (units == 1 || units == 2);
    m.limits_check = hundreds == 1 || !m.valid;
    m.alpha_star = tens == 2 && m.valid;
    m.turn_slip = units == 2 && m.valid;
    return m;
}

Output evaluate(const Params& p, const Input& in, const Modes& modes) { return evaluate_impl(p, in, modes, nullptr); }

std::vector<Output> evaluate_series(const Params& p, const std::vector<Input>& in, const Modes& modes) {
    std::vector<Output> out(in.size());
    std::vector<double> alpha(in.size(), 0.0);
    for (std::size_t i = 0; i < in.size(); ++i) out[i] = evaluate_impl(p, in[i], modes, &alpha[i]);
    if (in.size() > 1 && modes.valid) {                                                                  // MFeval: diff(Fy) ./ diff(alpha), the last value repeated
        for (std::size_t i = 0; i + 1 < in.size(); ++i) out[i].inst_kya = (out[i + 1].fy - out[i].fy) / (alpha[i + 1] - alpha[i]);
        out.back().inst_kya = out[in.size() - 2].inst_kya;
    }
    return out;
}

}  // namespace rs::mf62
