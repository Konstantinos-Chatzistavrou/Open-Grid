// Apache-2.0 — Multi-tyre BSD-3 Project Chrono dataset validation across vehicle classes & inflation pressures.
// Loads real .tir files verbatim from data/tires/ and evaluates rs::magic_formula on every tyre.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <cstdlib>
#include <fstream>
#include <map>
#include <string>
#include <vector>
#include "harness.hpp"
#include "rs/tire.hpp"
#include "tir_loader.hpp"

using namespace rs;

namespace {

using namespace tirload;

TireOperating nominal_op(const TireParams& p) {
    TireOperating op;
    op.slip_speed = p.lmuv_ref_mps;
    op.dpi = 0.0;
    op.phi = 0.0;
    op.rolling_speed_mps = 16.6;
    op.enable_contact_patch_grid = true;
    op.enable_mf62_hybrid = false;
    return op;
}

double peak_mu_x(const TireParams& p, double fz) {
    const TireOperating op = nominal_op(p);
    double best = 0.0;
    for (int i = 1; i <= 300; ++i) {
        const double k = i * 0.001;
        best = std::max(best, magic_formula(p, k, 0.0, fz, 1.0, 0.0, op).fx);
    }
    return best / fz;
}

double peak_mu_y(const TireParams& p, double fz) {
    const TireOperating op = nominal_op(p);
    const double deg = kPi / 180.0;
    double best = 0.0;
    for (int i = 1; i <= 250; ++i) {
        const double a = i * 0.1 * deg;
        best = std::max(best, magic_formula(p, 0.0, std::tan(a), fz, 1.0, 0.0, op).fy);
    }
    return best / fz;
}

double cornering_stiffness(const TireParams& p, double fz) {
    const TireOperating op = nominal_op(p);
    const double da = 0.25 * kPi / 180.0;
    const double fy_p = magic_formula(p, 0.0, std::tan(da), fz, 1.0, 0.0, op).fy;
    const double fy_m = magic_formula(p, 0.0, std::tan(-da), fz, 1.0, 0.0, op).fy;
    return (fy_p - fy_m) / (2.0 * da);
}

// Directory-wide smoke check: every .tir in data/tires loads and returns finite MF forces over a load/slip grid.
// Deliberately physics-light (the deep per-tyre checks below cover the core datasets) so a newly added, unusual
// tyre cannot be silently skipped and cannot weaken the existing assertions.
void verify_loads_and_finite(const LoadedTir& t) {
    const std::string& name = t.filename;
    test::check((name + ": .tir parses and loads").c_str(), t.loaded);
    if (!t.loaded) return;
    const TireOperating op = nominal_op(t.params);
    const double deg = kPi / 180.0;
    bool finite = true;
    for (double load_scale : {0.5, 1.0, 1.5}) {
        const double fz = t.fnomin * load_scale;
        for (double kappa : {-0.15, -0.05, 0.0, 0.05, 0.15}) {
            for (double alpha_deg : {-12.0, -4.0, 0.0, 4.0, 12.0}) {
                const TireForces tf = magic_formula(t.params, kappa, std::tan(alpha_deg * deg), fz, 1.0, 0.0, op);
                if (!std::isfinite(tf.fx) || !std::isfinite(tf.fy) || !std::isfinite(tf.mz)) finite = false;
            }
        }
    }
    test::check((name + ": finite Fx/Fy/Mz over 3-load x 5-slip x 5-slip-angle grid").c_str(), finite);
}

void verify_single_tyre(const LoadedTir& t, bool require_positive_camber_thrust) {
    const std::string& name = t.filename;
    test::check((name + ": parsed valid .tir coefficients").c_str(),
                t.loaded && t.params.radius > 0.1 && t.params.vertical_stiffness > 50000.0 && t.params.fz0 > 500.0);
    if (!t.loaded) return;

    const TireParams& p = t.params;
    const TireOperating op = nominal_op(p);
    const double fz = t.fnomin;
    const double deg = kPi / 180.0;

    // 1. Finite, physically valid sweeps across pure longitudinal and pure lateral slip
    bool all_finite = true;
    for (int i = -30; i <= 30; ++i) {
        const TireForces tf = magic_formula(p, i * 0.01, 0.0, fz, 1.0, 0.0, op);
        if (!std::isfinite(tf.fx) || !std::isfinite(tf.fy) || !std::isfinite(tf.mz)) all_finite = false;
    }
    for (int i = -20; i <= 20; ++i) {
        const TireForces tf = magic_formula(p, 0.0, std::tan(i * deg), fz, 1.0, 0.0, op);
        if (!std::isfinite(tf.fx) || !std::isfinite(tf.fy) || !std::isfinite(tf.mz)) all_finite = false;
    }
    test::check((name + ": finite Fx/Fy/Mz across slip sweeps").c_str(), all_finite);

    // 2. Zero at zero slip and exact odd symmetry at camber = 0
    const TireForces tf0 = magic_formula(p, 0.0, 0.0, fz, 1.0, 0.0, op);
    const bool zero_ok = std::abs(tf0.fx) < 1e-6 && std::abs(tf0.fy) < 1e-6 && std::abs(tf0.mz) < 1e-6;
    test::check((name + ": zero force & moment at zero slip (camber=0)").c_str(), zero_ok);

    bool odd_lat_ok = true;
    for (double a_deg : {2.0, 6.0, 14.0}) {
        const TireForces tp = magic_formula(p, 0.0, std::tan(a_deg * deg), fz, 1.0, 0.0, op);
        const TireForces tm = magic_formula(p, 0.0, std::tan(-a_deg * deg), fz, 1.0, 0.0, op);
        if (std::abs(tp.fy + tm.fy) > 1e-4 || std::abs(tp.mz + tm.mz) > 1e-4) odd_lat_ok = false;
    }
    test::check((name + ": exact odd symmetry in alpha for Fy & Mz (camber=0)").c_str(), odd_lat_ok);

    // Longitudinal Fx is odd up to the tiny physical driving/braking curvature term PEX4, and exact when PEX4=0.
    TireParams p_sym_x = p;
    p_sym_x.pex4 = 0.0;
    bool odd_lon_ok = true;
    for (double k : {0.03, 0.10, 0.22}) {
        const TireForces tp = magic_formula(p, k, 0.0, fz, 1.0, 0.0, op);
        const TireForces tm = magic_formula(p, -k, 0.0, fz, 1.0, 0.0, op);
        if (std::abs(tp.fx + tm.fx) > 1e-3 * std::max(1.0, std::abs(tp.fx))) odd_lon_ok = false;
        const TireForces sp = magic_formula(p_sym_x, k, 0.0, fz, 1.0, 0.0, op);
        const TireForces sm = magic_formula(p_sym_x, -k, 0.0, fz, 1.0, 0.0, op);
        if (std::abs(sp.fx + sm.fx) > 1e-5) odd_lon_ok = false;
    }
    test::check((name + ": odd symmetry in kappa for Fx (camber=0)").c_str(), odd_lon_ok);

    // 3. Peak friction & restoring aligning moment at small slip
    const double mux = peak_mu_x(p, fz);
    const double muy = peak_mu_y(p, fz);
    const double ca = cornering_stiffness(p, fz);
    const TireForces tf_small = magic_formula(p, 0.0, std::tan(3.0 * deg), fz, 1.0, 0.0, op);
    std::printf("         %-32s [%-7s] FNOMIN=%6.0f N  Kv=%7.0f N/m  mux=%.3f  muy=%.3f  Ca=%8.0f N/rad (Ca/Fz=%.2f)\n",
                name.c_str(), t.format.c_str(), fz, p.vertical_stiffness, mux, muy, ca, ca / fz);
    test::check((name + ": physical peak mu_x and mu_y in [0.50, 1.50]").c_str(),
                mux >= 0.50 && mux <= 1.50 && muy >= 0.50 && muy <= 1.50);
    test::check((name + ": restoring Mz < 0 & positive trail at +3 deg slip").c_str(),
                tf_small.mz < 0.0 && tf_small.pneumatic_trail > 0.0);

    // 4. Positive load sensitivity: higher load -> lower peak Fy / Fz
    const double muy_lo = peak_mu_y(p, 0.5 * fz);
    const double muy_hi = peak_mu_y(p, 1.5 * fz);
    test::check((name + ": load sensitivity mu_y(0.5*FNOMIN) > mu_y(1.5*FNOMIN)").c_str(), muy_lo > muy_hi);

    // 5. Camber thrust antisymmetry (and positive sign on all PAC2002 passenger/SUV/off-road fits)
    const double fy_cam_p = magic_formula(p, 0.0, 0.0, fz, 1.0, 2.5 * deg, op).fy;
    const double fy_cam_m = magic_formula(p, 0.0, 0.0, fz, 1.0, -2.5 * deg, op).fy;
    test::check((name + ": camber thrust antisymmetric Fy(0,-2.5deg) == -Fy(0,+2.5deg)").c_str(),
                std::abs(fy_cam_p + fy_cam_m) < 1e-4 && std::abs(fy_cam_p) > 1.0);
    if (require_positive_camber_thrust) {
        test::check((name + ": positive camber thrust Fy(0,+2.5deg) > 0").c_str(), fy_cam_p > 0.0);
    }
}

}  // namespace

RS_TEST(tire_library) {
    const LoadedTir audi    = load_tir_file("audi_245_40R18_pac2002.tir");
    const LoadedTir sedan   = load_tir_file("sedan_pac2002.tir");
    const LoadedTir suv     = load_tir_file("suv_pac2002.tir");
    const LoadedTir classic = load_tir_file("classic_185_80R14_pac2002.tir");
    const LoadedTir generic = load_tir_file("generic_pac2002.tir");
    const LoadedTir hmmwv   = load_tir_file("hmmwv_pac2002.tir");
    const LoadedTir feda40  = load_tir_file("feda_335_65R22_5_40psi.tir");
    const LoadedTir feda70  = load_tir_file("feda_335_65R22_5_70psi.tir");
    const LoadedTir feda95  = load_tir_file("feda_335_65R22_5_95psi.tir");
    const LoadedTir citybus = load_tir_file("citybus_pac2002.tir");
    const LoadedTir polaris = load_tir_file("polaris_pac2002.tir");
    const LoadedTir uazbus  = load_tir_file("uazbus_pac2002.tir");
    const LoadedTir feda60  = load_tir_file("feda_335_65R22_5_60psi_pac2002.tir");
    const LoadedTir p235    = load_tir_file("pac2002_235_60R16.tir");

    // Per-tyre physical sanity across all 9 BSD-3 Chrono datasets
    verify_single_tyre(audi, true);
    verify_single_tyre(sedan, true);
    verify_single_tyre(suv, true);
    verify_single_tyre(classic, true);
    verify_single_tyre(generic, true);
    verify_single_tyre(hmmwv, true);
    verify_single_tyre(feda40, false);
    verify_single_tyre(feda70, false);
    verify_single_tyre(feda95, false);
    verify_loads_and_finite(citybus);
    verify_loads_and_finite(polaris);
    verify_loads_and_finite(uazbus);
    verify_loads_and_finite(feda60);
    verify_loads_and_finite(p235);

    // Every .tir in data/tires must load and stay finite: no dataset may be added without being exercised.
    int tir_files = 0;
    for (const auto& entry : std::filesystem::directory_iterator(test::data_path("tires"))) {
        if (!entry.is_regular_file() || entry.path().extension() != ".tir") continue;
        ++tir_files;
        verify_loads_and_finite(load_tir_file(entry.path().filename().string()));
    }
    test::check("data/tires contains at least 10 .tir datasets (expanded beyond the original 9)", tir_files >= 10);
    std::printf("         tire library: %d .tir files loaded from data/tires\n", tir_files);

    // Class hierarchy: Sport GT 245/40 R18 vs Classic 185/80 R14
    const double ca_fz_audi_nom = cornering_stiffness(audi.params, audi.fnomin) / audi.fnomin;
    const double ca_fz_classic_nom = cornering_stiffness(classic.params, classic.fnomin) / classic.fnomin;
    const double ca_audi_4k = cornering_stiffness(audi.params, 4000.0);
    const double ca_classic_4k = cornering_stiffness(classic.params, 4000.0);
    test::check("sport 245/40 R18 has higher C_alpha/Fz than classic 185/80 R14 (at FNOMIN)",
                ca_fz_audi_nom > ca_fz_classic_nom * 1.25);
    test::check("sport 245/40 R18 has higher C_alpha than classic 185/80 R14 (at equal 4 kN)",
                ca_audi_4k > ca_classic_4k * 1.40);
    test::check("sport 245/40 R18 has stiffer vertical rate than classic 185/80 R14",
                audi.params.vertical_stiffness > classic.params.vertical_stiffness * 1.50);
    test::check("sport 245/40 R18 has higher peak lateral mu than classic 185/80 R14",
                peak_mu_y(audi.params, audi.fnomin) > peak_mu_y(classic.params, classic.fnomin));

    // Class hierarchy: Sport GT 245/40 R18 vs SUV 265/70 R18
    test::check("SUV 265/70 R18 has larger radius, taller sidewall, softer Kv than sport 245/40 R18",
                suv.params.radius > audi.params.radius
                    && suv.params.aspect_ratio > audi.params.aspect_ratio
                    && suv.params.vertical_stiffness < audi.params.vertical_stiffness
                    && suv.params.fz0 > audi.params.fz0);

    // Class hierarchy: Heavy Off-Road HMMWV 37x12.5 R16.5 vs Sport GT 245/40 R18
    test::check("HMMWV heavy off-road tyre has much higher Kv & FNOMIN but lower mu_y and C_alpha/Fz than sport GT",
                hmmwv.params.vertical_stiffness > audi.params.vertical_stiffness * 3.0
                    && hmmwv.fnomin > audi.fnomin * 5.0
                    && peak_mu_y(hmmwv.params, hmmwv.fnomin) < peak_mu_y(audi.params, audi.fnomin)
                    && (cornering_stiffness(hmmwv.params, hmmwv.fnomin) / hmmwv.fnomin) < ca_fz_audi_nom * 0.5);

    // Multi-pressure hierarchy: FEDA 335/65 R22.5 (40 psi -> 70 psi -> 95 psi)
    test::check("FEDA multi-pressure vertical stiffness strictly rises: 95 psi > 70 psi > 40 psi",
                feda95.params.vertical_stiffness > feda70.params.vertical_stiffness
                    && feda70.params.vertical_stiffness > feda40.params.vertical_stiffness);
    test::check_range("FEDA vertical stiffness ratio (95 psi / 40 psi)",
                      feda95.params.vertical_stiffness / feda40.params.vertical_stiffness, 1.9, 2.3, "x");
    test::check("FEDA rated nominal load strictly rises: 95 psi > 70 psi > 40 psi",
                feda95.fnomin > feda70.fnomin && feda70.fnomin > feda40.fnomin);
    const double patch_40 = 2.0 * contact_patch_half_length(feda40.params, 15000.0);
    const double patch_70 = 2.0 * contact_patch_half_length(feda70.params, 15000.0);
    const double patch_95 = 2.0 * contact_patch_half_length(feda95.params, 15000.0);
    test::check("FEDA contact patch length shrinks at higher inflation pressure (15 kN)",
                patch_95 < patch_70 && patch_70 < patch_40);

    // Upstream Chrono equivalence checks (documented verbatim pairs)
    const double deg = kPi / 180.0;
    const TireForces tf_audi = magic_formula(audi.params, 0.0, std::tan(6.0 * deg), 4000.0, 1.0, 0.0, nominal_op(audi.params));
    const TireForces tf_sedan = magic_formula(sedan.params, 0.0, std::tan(6.0 * deg), 4000.0, 1.0, 0.0, nominal_op(sedan.params));
    test::check("audi_245_40R18_pac2002.tir and sedan_pac2002.tir evaluate identically",
                std::abs(tf_audi.fy - tf_sedan.fy) < 1e-9 && std::abs(tf_audi.mz - tf_sedan.mz) < 1e-9);

    const TireForces tf_gen = magic_formula(generic.params, 0.0, std::tan(6.0 * deg), 15000.0, 1.0, 0.0, nominal_op(generic.params));
    const TireForces tf_hmm = magic_formula(hmmwv.params, 0.0, std::tan(6.0 * deg), 15000.0, 1.0, 0.0, nominal_op(hmmwv.params));
    test::check("generic_pac2002.tir and hmmwv_pac2002.tir evaluate identically",
                std::abs(tf_gen.fy - tf_hmm.fy) < 1e-9 && std::abs(tf_gen.mz - tf_hmm.mz) < 1e-9);
}
