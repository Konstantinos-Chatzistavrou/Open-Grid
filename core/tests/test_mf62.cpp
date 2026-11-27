// rs::mf62 (core/include/rs/mf62.hpp): the MF 5.2 / 6.1 / 6.2 steady-state evaluator.
//
// What these tests prove: the .tir reader handles every committed tyre file, and the equations behave the way the Magic Formula says they must
// (peak = D, slope at the origin = Kya, odd symmetry, Gxa / Gyk weighting, 6.1 and 6.2 agree where the 6.2 extras vanish, pressure and camber
// factors, Mx / My in closed form, the tyre-model switches of useMode). What they do NOT prove: that the numbers equal MFeval's. That needs
// MFeval's own output for the same .tir (docs/mf62.md). The tyre used for the property checks is made up in this file; it is not a measurement.
#include "harness.hpp"
#include "rs/mf62.hpp"
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {
using namespace rs::mf62;

// Only the keys the properties depend on; every other coefficient is the table default (PKY1 = -20, PDY1 = 1.1, PCY1 = 1.3, ...).
std::string synthetic_tir(int fittyp, const std::string& extra = "") {
    return "[MODEL]\nFITTYP = " + std::to_string(fittyp) + "\nLONGVL = 16.7\nVXLOW = 1\n"
           "[DIMENSION]\nUNLOADED_RADIUS = 0.315\nWIDTH = 0.225\nASPECT_RATIO = 0.45\nRIM_RADIUS = 0.2286\n"
           "[OPERATING_CONDITIONS]\nINFLPRES = 220000\nNOMPRES = 220000\n"
           "[VERTICAL]\nFNOMIN = 4000\nVERTICAL_STIFFNESS = 200000\n"
           "[LIMITS]\nFZMIN = 200\nFZMAX = 10000\nKPUMIN = -1.5\nKPUMAX = 1.5\nALPMIN = -1.5\nALPMAX = 1.5\nCAMMIN = -0.175\nCAMMAX = 0.175\n"
           "PRESMIN = 10000\nPRESMAX = 1000000\n" + extra;
}

Params make(int fittyp, const std::string& extra = "") {
    Params p;
    std::string err;
    const bool ok = parse_tir(synthetic_tir(fittyp, extra), p, err);
    test::check("synthetic .tir parses", ok);
    if (!ok) std::printf("         %s\n", err.c_str());
    return p;
}

Output run(const Params& p, double fz, double kappa, double alpha, double gamma = 0, double vx = 16.7, int mode = 111, double phit = 0, double pressure = 0) {
    Input in;
    in.fz = fz; in.kappa = kappa; in.alpha = alpha; in.gamma = gamma; in.vx = vx; in.phit = phit; in.pressure = pressure;
    return evaluate(p, in, modes_from_use_mode(mode));
}

bool finite_all(const Output& o) {
    const double v[] = {o.fx, o.fy, o.fz, o.mx, o.my, o.mz, o.re, o.rho, o.two_a, o.t, o.mux, o.muy, o.omega, o.rl, o.two_b, o.mzr, o.cx, o.cy, o.cz, o.kya, o.sigmax, o.sigmay, o.kxk};
    for (double x : v) if (!std::isfinite(x)) return false;
    return true;
}

bool near_rel(double a, double b, double rel, double abs_floor = 1e-9) { return std::abs(a - b) <= rel * std::max(std::abs(a), std::abs(b)) + abs_floor; }

// the .tir files in data/tires: the PAC2002 sets of Project Chrono (BSD-3-Clause)
RS_TEST(mf62_tir_library) {
    int files = 0;
    bool all_ok = true;
    for (const auto& e : std::filesystem::directory_iterator(test::data_path("tires"))) {
        if (!e.is_regular_file() || e.path().extension() != ".tir") continue;
        Params p;
        std::string err;
        const std::string name = e.path().filename().string();
        const bool ok = load_tir_file(e.path().string(), p, err);
        if (!ok) { std::printf("         %s: %s\n", name.c_str(), err.c_str()); all_ok = false; continue; }
        ++files;
        const double fz = p.fnomin * p.lfzo;
        double peak_y = 0, peak_x = 0;
        bool finite = true;
        for (int i = -40; i <= 40; ++i) {
            const Output ly = run(p, fz, 0.0, i * 0.01, 0.0, 20.0, 111);
            const Output lx = run(p, fz, i * 0.01, 0.0, 0.0, 20.0, 111);
            finite = finite && finite_all(ly) && finite_all(lx);
            peak_y = std::max(peak_y, std::abs(ly.fy));
            peak_x = std::max(peak_x, std::abs(lx.fx));
        }
        const bool plausible = p.version() == Version::Mf52 && finite && peak_y / fz > 0.4 && peak_y / fz < 2.2 && peak_x / fz > 0.4 && peak_x / fz < 2.2;
        if (!plausible) std::printf("         %s: version %d finite %d peak mu_y %.2f mu_x %.2f\n", name.c_str(), static_cast<int>(p.version()), finite, peak_y / fz, peak_x / fz);
        all_ok = all_ok && plausible;
    }
    test::check("every .tir in data/tires loads as the MF 5.2 / PAC2002 family and gives finite, plausible peak grip (0.4 .. 2.2)", all_ok);
    test::check("all 14 tyre sets of data/tires were exercised", files >= 14);
    std::printf("         %d tyre files\n", files);

    Params bad;
    std::string err;
    test::check("a file with no FITTYP and no PAC2002 marker is refused", !parse_tir("[MODEL]\nLONGVL = 16.7\n", bad, err) && !err.empty());
    test::check("an unsupported FITTYP is refused", !parse_tir("[MODEL]\nFITTYP = 99\n", bad, err));
    test::check("a missing file is refused", !load_tir_file("/no/such/dir/x.tir", bad, err));
    Params q;
    test::check("CRLF line ends, inline $ comments, quoted strings and the [SHAPE] section are handled",
                parse_tir("[MDI_HEADER]\r\nFILE_TYPE = 'tir'\r\n[MODEL]\r\nFITTYP = 62 $Magic Formula Version number\r\nTYRESIDE = 'RIGHT'\r\n"
                          "[UNITS]\r\nMASS = 'kg'\r\n[SHAPE]\r\n1.0 0.5\r\nFNOMIN = 1\r\n[VERTICAL]\r\nFNOMIN = 5000 $Nominal wheel load\r\n", q, err) &&
                    q.fittyp == 62 && q.fnomin == 5000.0 && q.tyreside == "RIGHT" && q.version() == Version::Mf62);
}

RS_TEST(mf62_equations) {
    const Params p61 = make(61);
    const Params p62 = make(62);
    const double fz0 = p61.fnomin;

    // --- pure lateral slip: odd symmetry, peak = D, slope at the origin = Kya (PKY1 < 0: positive alpha gives negative Fy)
    {
        bool odd = true;
        double peak = 0;
        for (int i = 1; i <= 60; ++i) {
            const double a = i * 0.01;
            const Output pos = run(p61, fz0, 0, a), neg = run(p61, fz0, 0, -a);
            odd = odd && near_rel(pos.fy, -neg.fy, 1e-9, 1e-6);
            peak = std::max(peak, std::abs(pos.fy));
        }
        const Output ref = run(p61, fz0, 0, 0.0);
        test::check("Fy is odd in the slip angle (no shifts, no camber)", odd);
        test::check_range("peak |Fy| / (muy Fz)", peak / (ref.muy * fz0), 0.995, 1.0005, "-");
        test::check("a positive slip angle gives a negative Fy (PKY1 < 0, TNO convention)", run(p61, fz0, 0, 0.05).fy < 0);
        const double d = 1e-5;
        const double slope = (run(p61, fz0, 0, d).fy - run(p61, fz0, 0, -d).fy) / (2 * d);
        test::check_range("dFy/dalpha at 0 over Kya", slope / ref.kya, 0.999, 1.001, "-");
        test::check_range("Kya at nominal load = PKY1 Fz0 sin(2 atan(1))", ref.kya / (-20.0 * fz0), 0.9999, 1.0001, "-");
    }

    // --- pure longitudinal slip: odd symmetry, peak = D, slope at the origin = Kxk
    {
        bool odd = true;
        double peak = 0;
        for (int i = 1; i <= 50; ++i) {
            const double k = i * 0.01;
            odd = odd && near_rel(run(p61, fz0, k, 0).fx, -run(p61, fz0, -k, 0).fx, 1e-9, 1e-6);
            peak = std::max(peak, std::abs(run(p61, fz0, k, 0).fx));
        }
        const Output ref = run(p61, fz0, 0, 0);
        const double d = 1e-6;
        test::check("Fx is odd in the longitudinal slip", odd);
        test::check_range("peak |Fx| / (mux Fz)", peak / (ref.mux * fz0), 0.995, 1.0005, "-");
        test::check_range("dFx/dkappa at 0 over Kxk", ((run(p61, fz0, d, 0).fx - run(p61, fz0, -d, 0).fx) / (2 * d)) / ref.kxk, 0.999, 1.001, "-");
    }

    // --- combined slip: a slip angle weakens Fx (Gxa < 1, falling), slip weakens Fy; with no slip angle Fx is Fx0
    {
        const double fx0 = run(p61, fz0, 0.1, 0).fx;
        double last = std::abs(fx0);
        bool falling = true;
        for (int i = 1; i <= 8; ++i) {
            const double fx = std::abs(run(p61, fz0, 0.1, i * 0.04).fx);
            falling = falling && fx < last + 1e-9;
            last = fx;
        }
        test::check("Fx falls steadily as the slip angle grows (Gxa weighting)", falling && last < 0.8 * std::abs(fx0));
        const double fy_free = std::abs(run(p61, fz0, 0, 0.15).fy);
        test::check("longitudinal slip takes lateral force away (Gyk weighting)", std::abs(run(p61, fz0, 0.15, 0.15).fy) < fy_free);
        test::check("friction circle: sqrt((Fx/Dx)^2 + (Fy/Dy)^2) stays within 1.05 over a combined-slip grid", [&] {
            const Output ref = run(p61, fz0, 0, 0);
            double worst = 0;
            for (int i = -10; i <= 10; ++i)
                for (int j = -10; j <= 10; ++j) {
                    const Output o = run(p61, fz0, i * 0.03, j * 0.03);
                    worst = std::max(worst, std::hypot(o.fx / (ref.mux * fz0), o.fy / (ref.muy * fz0)));
                }
            return worst < 1.05;
        }());
    }

    // --- load sensitivity: friction falls with load (PDY2 < 0), cornering stiffness saturates
    {
        const Output lo = run(p61, 2000, 0, 0.0), hi = run(p61, 8000, 0, 0.0);
        test::check("friction coefficient falls with load (PDY2, PDX2 < 0)", hi.muy < lo.muy && hi.mux < lo.mux);
        test::check("cornering stiffness grows with load, less than proportionally", std::abs(hi.kya) > std::abs(lo.kya) && std::abs(hi.kya) < 4 * std::abs(lo.kya));
    }

    // --- inflation pressure (MF 6.1 PPY1): Kya scales with (1 + PPY1 dpi) exactly
    {
        const Params pp = make(61, "PPY1 = 0.2\n");
        const double dpi = 0.1;
        const Output a = run(pp, fz0, 0, 0.0, 0, 16.7, 111, 0, 220000.0), b = run(pp, fz0, 0, 0.0, 0, 16.7, 111, 0, 220000.0 * (1 + dpi));
        test::check_range("Kya(1.1 p0) / Kya(p0) with PPY1 = 0.2", b.kya / a.kya, 1.0199, 1.0201, "-");
        test::check("pressure is echoed after the limits", near_rel(b.pressure, 242000.0, 1e-12));
    }

    // --- camber: camber thrust at zero slip angle is about Kyg0 * gamma (small angles), and has the sign of -gamma here
    {
        const double g = 0.05;
        const Output o = run(p61, fz0, 0, 0.0, g);
        const double kyg0 = fz0 * (-1.0);                         // Fz (PKY6 + PKY7 dfz) at nominal load, PKY6 = -1
        test::check_range("Fy(alpha = 0, gamma = 0.05) / (Kyg0 gamma)", o.fy / (kyg0 * g), 0.97, 1.03, "-");
    }

    // --- overturning moment in closed form when only QSX3 is set (QSX4's sine argument is 0)
    {
        const Params pm = make(61, "QSX3 = 0.01\n");
        const Output o = run(pm, 3000, 0, 0.08);
        const double expect = 0.315 * 3000 * 0.01 * (o.fy / fz0);
        test::check_range("Mx = R0 Fz QSX3 Fy / Fz0", o.mx / expect, 0.999999, 1.000001, "-");
    }

    // --- rolling resistance moment in closed form at the nominal point (MF 6.1 / 6.2 form), and 0 at standstill
    {
        const Output o = run(p62, fz0, 0, 0.0);
        const double expect = -0.315 * fz0 * (0.01 + 4e-4 * 1.0 + 4e-5 * 1.0);
        test::check_range("My = -R0 Fz0 (QSY1 + QSY3 |Vx/V0| + QSY4 (Vx/V0)^4) at Vx = V0", o.my / expect, 0.999, 1.001, "-");
        test::check("My is 0 at standstill", run(p62, fz0, 0, 0.0, 0, 0.0).my == 0.0);
    }

    // --- aligning moment: positive pneumatic trail, Mz = -t Fy' + Mzr + s Fx without shifts
    {
        const Output o = run(p61, fz0, 0, 0.05);
        test::check("pneumatic trail is positive and below the contact length", o.t > 0.005 && o.t < 0.2);
        // no residual torque (QDZ6 = 0, gamma = 0) and no Fx: Mz = -t Fy' exactly, so Mz and Fy have opposite signs for a positive trail
        test::check("Mz = -t Fy with a positive trail (restoring: opposite sign to Fy)", near_rel(o.mz, -o.t * o.fy, 1e-6, 1e-9) && o.mz * o.fy < 0);
    }

    // --- loaded radius: MF 6.1 (analytic) and MF 6.2 (secant) agree when the 6.2 extras vanish, and Rl + rho = R_omega at gamma = 0
    {
        bool agree = true, sums = true, monotone = true;
        double last = 1e9;
        for (double fz = 500; fz <= 9000; fz += 500) {
            const Output a = run(p61, fz, 0, 0.0), b = run(p62, fz, 0, 0.0);
            agree = agree && std::abs(a.rl - b.rl) < 1e-6 && std::abs(a.rho - b.rho) < 1e-6;
            sums = sums && std::abs(b.rl + b.rho - 0.315) < 1e-6;
            monotone = monotone && b.rl < last;
            last = b.rl;
        }
        test::check("MF 6.1 and MF 6.2 loaded radius agree to 1 micron when Q_CAM*, Q_FCY2, Q_FYS* are 0 and gamma = 0", agree);
        test::check("Rl + rho = R_omega at gamma = 0 (free radius 0.315 m)", sums);
        test::check("the loaded radius falls as the load rises", monotone);
        const Output nom = run(p62, fz0, 0, 0.0);
        test::check_range("static deflection at Fz0 (m)", nom.rho, 0.005, 0.05, "m");
        test::check_range("Cz = Fz / rho (N/mm)", nom.cz / 1000.0, 100.0, 400.0, "N/mm");
    }

    // --- MF 6.2 camber terms: with Q_CAM set, camber changes the deflection and the load equation still has a (decreasing) solution
    {
        const Params pc = make(62, "Q_CAM1 = 1.0\nQ_CAM2 = 0.5\nQ_CAM3 = 0.3\n");
        const Output flat = run(pc, fz0, 0, 0.0, 0.0), tilted = run(pc, fz0, 0, 0.0, 0.1);
        // the load equation fixes the deflection rho; camber shifts the contact patch, so what moves is the loaded radius (here by about a millimetre)
        test::check("camber changes the MF 6.2 loaded radius (0.1 rad: 0.2 .. 5 mm) and leaves the deflection that carries the load alone",
                    std::abs(tilted.rl - flat.rl) > 2e-4 && std::abs(tilted.rl - flat.rl) < 5e-3 && std::abs(tilted.rho - flat.rho) < 1e-6);
        bool monotone = true;
        double last = 1e9;
        for (double fz = 1000; fz <= 8000; fz += 1000) {
            const double rl = run(pc, fz, 0, 0.0, 0.1).rl;
            monotone = monotone && std::isfinite(rl) && rl < last;
            last = rl;
        }
        test::check("with camber, Rl still falls monotonically with load", monotone);
    }

    // --- relaxation lengths (MF 6.x): sigma = Kxk / Cx and Kya / Cy
    {
        const Output o = run(p61, fz0, 0, 0.0);
        test::check_range("sigma_x = |Kxk / Cx|", o.sigmax / std::abs(o.kxk / o.cx), 0.999999, 1.000001, "-");
        test::check_range("sigma_y = |Kya / Cy|", o.sigmay / std::abs(o.kya / o.cy), 0.999999, 1.000001, "-");
    }

    // --- turn slip: with phit = 0 and gamma = 0 the turn-slip factors are 1, so mode 112 equals mode 111; phit shrinks the lateral force
    {
        const Output a = run(p61, fz0, 0, 0.12, 0.0, 16.7, 111), b = run(p61, fz0, 0, 0.12, 0.0, 16.7, 112);
        test::check("useMode 112 equals 111 when phit = 0 and gamma = 0", near_rel(a.fy, b.fy, 1e-9, 1e-6) && near_rel(a.fx, b.fx, 1e-9, 1e-6));
        const Output c = run(p61, fz0, 0, 0.12, 0.0, 16.7, 112, 0.5);
        test::check("turn slip phit = 0.5 1/m lowers |Fy| (zeta2 < 1)", std::abs(c.fy) < std::abs(b.fy) - 1.0);
    }
}

RS_TEST(mf62_modes_and_edges) {
    const Modes a = modes_from_use_mode(111), b = modes_from_use_mode(122), c = modes_from_use_mode(211), bad = modes_from_use_mode(133);
    test::check("useMode 111 = limits, alpha, no turn slip", a.valid && a.limits_check && !a.alpha_star && !a.turn_slip);
    test::check("useMode 122 = limits, alpha*, turn slip", b.valid && b.limits_check && b.alpha_star && b.turn_slip);
    test::check("useMode 211 = no limits", c.valid && !c.limits_check);
    test::check("useMode 133 / 0 / 311 are invalid", !bad.valid && !modes_from_use_mode(0).valid && !modes_from_use_mode(311).valid);
    const Params p = make(62);
    const Output nan = evaluate(p, Input{4000, 0, 0.05, 0, 0, 16.7, 0, 0}, bad);
    test::check("an invalid useMode gives NaN (as MFeval does)", std::isnan(nan.fx) && std::isnan(nan.kxk));

    // alpha* mode: tan(alpha) sign(Vx) and sin(gamma): small angles agree, large ones differ, reverse speed flips the lateral force
    const Output n1 = run(p, 4000, 0, 0.02, 0, 16.7, 111), n2 = run(p, 4000, 0, 0.02, 0, 16.7, 121);
    const Output l1 = run(p, 4000, 0, 0.6, 0, 16.7, 111), l2 = run(p, 4000, 0, 0.6, 0, 16.7, 121);
    test::check("alpha* matches alpha at small angles", near_rel(n1.fy, n2.fy, 0.01));
    test::check("alpha* differs from alpha at 0.6 rad", std::abs(l1.fy - l2.fy) > 1.0);

    // edge cases must stay finite: no load, standstill, locked wheel, slip beyond the file's limits, reverse speed, huge load, tiny speed
    struct Case { double fz, kappa, alpha, gamma, vx; };
    const std::vector<Case> cases = {{0, 0, 0, 0, 16.7}, {4000, 0, 0, 0, 0}, {4000, -1, 0, 0, 16.7}, {4000, 0, 2.0, 0, 16.7}, {4000, 3.0, 0, 0, 16.7}, {4000, 0, 0.1, 0.3, 16.7},
                                     {4000, 0, 0.1, 0, -16.7}, {30000, 0.1, 0.1, 0, 16.7}, {4000, 0.1, 0.1, 0, 0.3}, {-100, 0.1, 0.1, 0, 16.7}, {4000, 0, 0.1, 0, 0.9}};
    bool finite = true;
    for (const Case& k : cases)
        for (int mode : {111, 121, 112, 211, 222}) {
            const Output o = run(p, k.fz, k.kappa, k.alpha, k.gamma, k.vx, mode, mode % 10 == 2 ? 0.2 : 0.0);
            if (!finite_all(o)) { finite = false; std::printf("         non-finite at fz %.0f kappa %.2f alpha %.2f gamma %.2f vx %.1f mode %d\n", k.fz, k.kappa, k.alpha, k.gamma, k.vx, mode); }
        }
    test::check("edge cases (Fz <= 0, standstill, locked wheel, beyond limits, reverse, overload, low speed) stay finite in every mode", finite);
    test::check("no load gives no force", std::abs(run(p, 0, 0, 0.1).fy) < 1e-9 && std::abs(run(p, 0, 0.1, 0).fx) < 1e-9);
    test::check("the output echoes the inputs", [&] {
        const Output o = run(p, 3500, 0.07, -0.03, 0.02, 21.0);
        return near_rel(o.fz, 3500, 1e-12) && near_rel(o.kappa, 0.07, 1e-12) && near_rel(o.alpha, -0.03, 1e-12) && near_rel(o.gamma, 0.02, 1e-12) && near_rel(o.vx, 21.0, 1e-12);
    }());
    const Output lowv = run(p, 4000, 0, 0.1, 0, 0.2), highv = run(p, 4000, 0, 0.1, 0, 16.7);
    test::check("the low-speed reduction takes lateral force away below VXLOW (0.2 m/s < 1 m/s)", std::abs(lowv.fy) < 0.5 * std::abs(highv.fy));

    // MF 5.2 / PAC2002 family: own equations for Kyg0, SHy, My, Mz, the contact patch and the relaxation lengths
    const Params p52 = make(21, "PTX1 = 2.3\nPTX2 = 1.4\nPTX3 = 0.5\nPTY1 = 2.1\nPTY2 = 1.9\nPHY3 = 0.05\n");
    const Output o52 = run(p52, 4000, 0.05, 0.05, 0.02);
    test::check("an MF 5.2 / PAC2002 file evaluates finite, with relaxation lengths from PTX / PTY", finite_all(o52) && o52.sigmax > 0.01 && o52.sigmay > 0.05);
    test::check("MF 5.2 and MF 6.1 files with the same pure-slip coefficients give the same Fx0", near_rel(run(p52, 4000, 0.08, 0).fx, run(make(61), 4000, 0.08, 0).fx, 1e-9, 1e-6));
}

// The three property files of MFeval.jl's tests (MF 5.2, 6.1, 6.2), whose origin is not stated: used locally only, NOT in the repository.
// RS_MF62_FIXTURES=<folder holding MagicFormula52_Parameters.tir, MagicFormula61_Parameters.tir, MagicFormula62_Parameters.tir>
RS_TEST(mf62_local_fixtures) {
    const char* dir = std::getenv("RS_MF62_FIXTURES");
    if (!dir) { std::printf("  [SKIP] RS_MF62_FIXTURES is not set (local-only property files)\n"); return; }
    const struct { const char* file; Version v; } sets[] = {{"MagicFormula52_Parameters.tir", Version::Mf52}, {"MagicFormula61_Parameters.tir", Version::Mf61}, {"MagicFormula62_Parameters.tir", Version::Mf62}};
    for (const auto& s : sets) {
        Params p;
        std::string err;
        const std::string path = std::string(dir) + "/" + s.file;
        if (!load_tir_file(path, p, err)) { test::check((std::string(s.file) + ": loads (" + err + ")").c_str(), false); continue; }
        test::check((std::string(s.file) + ": loads as the expected version").c_str(), p.version() == s.v);
        bool finite = true;
        double peak_y = 0, peak_x = 0, tmax = 0;
        for (int i = -50; i <= 50; ++i) {
            const Output ly = run(p, p.fnomin, 0, i * 0.01, 0, p.longvl), lx = run(p, p.fnomin, i * 0.01, 0, 0, p.longvl);
            finite = finite && finite_all(ly) && finite_all(lx);
            peak_y = std::max(peak_y, std::abs(ly.fy));
            peak_x = std::max(peak_x, std::abs(lx.fx));
            tmax = std::max(tmax, ly.t);
        }
        std::printf("         %s: Fz0 %.0f N, peak mu_y %.3f, peak mu_x %.3f, max trail %.3f m, Kya %.0f N/rad, Rl %.4f m\n", s.file, p.fnomin, peak_y / p.fnomin, peak_x / p.fnomin, tmax,
                    run(p, p.fnomin, 0, 0, 0, p.longvl).kya, run(p, p.fnomin, 0, 0, 0, p.longvl).rl);
        test::check((std::string(s.file) + ": every output finite over the sweeps").c_str(), finite);
        test::check_range((std::string(s.file) + ": peak lateral grip mu_y").c_str(), peak_y / p.fnomin, 0.5, 2.5, "-");
        test::check_range((std::string(s.file) + ": peak longitudinal grip mu_x").c_str(), peak_x / p.fnomin, 0.5, 2.5, "-");
    }
}

// ---- comparison with MFeval's own output ------------------------------------------------------------------------------------------
// tools/validation/mfeval_reference.m runs the vendored MFeval (MATLAB or GNU Octave) over data/validation/mf62/mf62_cases.csv and writes one CSV per
// tyre file. RS_MF62_FIXTURES = folder with the .tir files, RS_MF62_REFERENCE = folder with <tag>_mfeval.csv (tags mf52, mf61, mf62), see docs/mf62.md.
bool read_numeric_csv(const std::string& path, std::vector<std::vector<double>>& rows) {
    std::ifstream in(path);
    if (!in) return false;
    std::string line;
    std::getline(in, line);                                                    // header
    while (std::getline(in, line)) {
        if (line.empty()) continue;
        std::vector<double> r;
        std::stringstream ss(line);
        std::string cell;
        while (std::getline(ss, cell, ',')) r.push_back(std::strtod(cell.c_str(), nullptr));   // strtod reads NaN / Inf too
        rows.push_back(std::move(r));
    }
    return true;
}

RS_TEST(mf62_vs_mfeval) {
    const char* tir_dir = std::getenv("RS_MF62_FIXTURES");
    const char* ref_dir = std::getenv("RS_MF62_REFERENCE");
    if (!tir_dir || !ref_dir) { std::printf("  [SKIP] RS_MF62_FIXTURES / RS_MF62_REFERENCE not set (needs MFeval's output, see docs/mf62.md)\n"); return; }
    std::vector<std::vector<double>> cases;
    test::check("the case list is readable", read_numeric_csv(test::data_path("validation/mf62/mf62_cases.csv"), cases) && cases.size() > 100);
    static const char* names[30] = {"Fx", "Fy", "Fz", "Mx", "My", "Mz", "kappa", "alpha", "gamma", "phit", "Vx", "P", "Re", "rho", "2a", "t", "mux", "muy", "omega", "Rl", "2b", "Mzr",
                                    "Cx", "Cy", "Cz", "Kya", "sigmax", "sigmay", "instKya", "Kxk"};
    // absolute tolerance per column (relative 1e-6 on top): lengths from MFeval's iterative radius solves are looser than the closed forms
    auto atol = [](int col) { return (col == 12 || col == 13 || col == 19) ? 1e-7 : (col == 24 ? 1.0 : 1e-9); };
    const struct { const char* file; const char* tag; } sets[] = {{"MagicFormula52_Parameters.tir", "mf52"}, {"MagicFormula61_Parameters.tir", "mf61"}, {"MagicFormula62_Parameters.tir", "mf62"}};
    for (const auto& s : sets) {
        std::vector<std::vector<double>> ref;
        const std::string ref_path = std::string(ref_dir) + "/" + s.tag + "_mfeval.csv";
        if (!read_numeric_csv(ref_path, ref)) { std::printf("  [SKIP] %s: no %s\n", s.tag, ref_path.c_str()); continue; }
        Params p;
        std::string err;
        if (!load_tir_file(std::string(tir_dir) + "/" + s.file, p, err)) { test::check((std::string(s.tag) + ": tyre file loads").c_str(), false); continue; }
        test::check((std::string(s.tag) + ": reference has one row per case with 30 columns").c_str(), ref.size() == cases.size() && !ref.empty() && ref[0].size() == 30);
        if (ref.size() != cases.size()) continue;
        int bad_total = 0, ref_nan = 0, evaluated = 0;
        double worst_rel = 0;
        int bad_by_col[30] = {0};
        double worst[30] = {0};
        std::size_t worst_row[30] = {0};
        for (std::size_t i = 0; i < cases.size(); ++i) {
            const auto& c = cases[i];
            Input in;
            in.fz = c[0] * p.fnomin; in.kappa = c[1]; in.alpha = c[2]; in.gamma = c[3]; in.phit = c[4]; in.vx = c[5] * p.longvl; in.pressure = c[6] * p.nompres;
            const Output o = evaluate(p, in, modes_from_use_mode(static_cast<int>(c[7])));
            const double mine[30] = {o.fx, o.fy, o.fz, o.mx, o.my, o.mz, o.kappa, o.alpha, o.gamma, o.phit, o.vx, o.pressure, o.re, o.rho, o.two_a, o.t, o.mux, o.muy, o.omega, o.rl, o.two_b, o.mzr,
                                     o.cx, o.cy, o.cz, o.kya, o.sigmax, o.sigmay, 0.0, o.kxk};
            ++evaluated;
            for (int col = 0; col < 30; ++col) {
                if (col == 28) continue;                                       // instKya depends on how the rows are grouped into one call
                const double r = ref[i][static_cast<std::size_t>(col)];
                if (std::isnan(r) || std::isinf(r)) { ++ref_nan; continue; }   // MFeval itself gave no number here
                const double d = std::abs(mine[col] - r), tol = atol(col) + 1e-6 * std::abs(r);
                const bool ok = std::isfinite(mine[col]) && d <= tol;
                if (std::isfinite(mine[col])) worst_rel = std::max(worst_rel, d / (std::abs(r) + 1e-9));
                if (!ok) { ++bad_total; ++bad_by_col[col]; }
                if (!std::isfinite(mine[col])) { worst[col] = 1e300; worst_row[col] = i; }
                else if (d / tol > worst[col]) { worst[col] = d / tol; worst_row[col] = i; }
            }
        }
        std::printf("         %s: %d cases, %d values compared, %d MFeval NaN / Inf values skipped, worst relative deviation %.2e\n", s.tag, evaluated, evaluated * 29 - ref_nan, ref_nan, worst_rel);
        for (int col = 0; col < 30; ++col)
            if (bad_by_col[col]) {
                const auto& c = cases[worst_row[col]];
                std::printf("         %s %-7s %3d mismatches, worst case %zu (fz_rel %.2f kappa %.3f alpha %.3f gamma %.3f phit %.2f vx_rel %.3f p_rel %.2f mode %d): mine %.10g, MFeval %.10g\n", s.tag, names[col],
                            bad_by_col[col], worst_row[col] + 2, c[0], c[1], c[2], c[3], c[4], c[5], c[6], static_cast<int>(c[7]),
                            [&] { Input in; in.fz = c[0] * p.fnomin; in.kappa = c[1]; in.alpha = c[2]; in.gamma = c[3]; in.phit = c[4]; in.vx = c[5] * p.longvl; in.pressure = c[6] * p.nompres;
                                  const Output o = evaluate(p, in, modes_from_use_mode(static_cast<int>(c[7])));
                                  const double m[30] = {o.fx, o.fy, o.fz, o.mx, o.my, o.mz, o.kappa, o.alpha, o.gamma, o.phit, o.vx, o.pressure, o.re, o.rho, o.two_a, o.t, o.mux, o.muy, o.omega, o.rl, o.two_b, o.mzr,
                                                        o.cx, o.cy, o.cz, o.kya, o.sigmax, o.sigmay, 0.0, o.kxk};
                                  return m[col]; }(),
                            ref[worst_row[col]][static_cast<std::size_t>(col)]);
            }
        test::check((std::string(s.tag) + ": every output column equals MFeval's (tolerance 1e-6 relative + a small absolute floor)").c_str(), bad_total == 0);
    }
}

}  // namespace
