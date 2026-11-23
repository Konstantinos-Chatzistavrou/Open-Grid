// Apache-2.0 — OpenGrid Magic Formula curve dumper for cross-checking against external PAC2002 evaluators (e.g. VDSim).
//
// Reads a raw converted tyre JSON produced by `node tools/tir2car.mjs <file.tir>` (no per-car mu boost),
// parses it through OpenGrid's actual `rs::parse_car_config` -> `parse_tire` pipeline, and evaluates
// `rs::magic_formula` (plus `rs::mf_pure_fx` / `rs::mf_pure_fy` / `rs::mf_aligning_torque`) across:
//   - Fz in {2000, 4000, 6000} N
//   - camber (OpenGrid gamma) in {0, -2} deg
//   - Pure longitudinal slip: kappa in [-0.30, +0.30], step 0.005, alpha = 0
//   - Pure lateral slip:      alpha in [-20.0, +20.0] deg, step 0.5 deg, kappa = 0
//
// Usage:
//   mf_dump --tire-json <path|-> [--radius 0.344] [--vx 16.6] [--mode nominal|stribeck|hybrid]

#include "rs/config.hpp"
#include "rs/math.hpp"
#include "rs/tire.hpp"
#include "nlohmann/json.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

using nlohmann::json;

std::string read_all(const std::string& path) {
    if (path == "-") {
        std::ostringstream ss;
        ss << std::cin.rdbuf();
        return ss.str();
    }
    std::ifstream in(path);
    if (!in) throw std::runtime_error("mf_dump: cannot open '" + path + "'");
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

// Wrap a standalone `tools/tir2car.mjs` tyre JSON block into a minimal `car/1` document so we parse
// through OpenGrid's exact `rs::parse_car_config` -> `parse_tire` codepath without duplicating parser logic.
rs::TireParams load_tire_from_tir2car_json(const std::string& json_text, double fallback_radius_m) {
    json tj = json::parse(json_text);
    if (!tj.contains("radius_m")) tj["radius_m"] = fallback_radius_m;
    if (!tj.contains("inertia_kgm2")) tj["inertia_kgm2"] = 1.0;
    if (!tj.contains("relaxation_length_long_m")) tj["relaxation_length_long_m"] = 0.12;
    if (!tj.contains("relaxation_length_lat_m")) tj["relaxation_length_lat_m"] = 0.30;
    if (!tj.contains("rolling_resistance")) tj["rolling_resistance"] = 0.012;
    if (!tj.contains("combined")) {
        // Neutral PAC2002 combined-slip defaults when the source .tir has no combined-slip block.
        tj["combined"] = {
            {"rBx1", 10.0}, {"rBx2", 0.0}, {"rBx3", 0.0}, {"rCx1", 1.0}, {"rEx1", 0.0}, {"rEx2", 0.0}, {"rHx1", 0.0},
            {"rBy1", 10.0}, {"rBy2", 0.0}, {"rBy3", 0.0}, {"rBy4", 0.0}, {"rCy1", 1.0}, {"rEy1", 0.0}, {"rEy2", 0.0},
            {"rHy1", 0.0},  {"rHy2", 0.0}, {"rVy1", 0.0}, {"rVy2", 0.0}, {"rVy3", 0.0}, {"rVy4", 0.0}, {"rVy5", 0.0},
            {"rVy6", 0.0},
        };
    }

    const json dummy_axle = {
        {"track_m", 1.6},
        {"spring_rate_n_per_m", 70000.0},
        {"spring_rest_length_m", 0.25},
        {"max_compression_m", 0.12},
        {"damper_bump_ns_per_m", 3500.0},
        {"damper_rebound_ns_per_m", 6500.0},
        {"anti_roll_rate_n_per_m", 20000.0},
        {"roll_centre_height_m", 0.05},
    };

    json car = {
        {"schema", "car/1"},
        {"name", "mf_dump_rig"},
        {"chassis", {
            {"mass_kg", 1450.0},
            {"cg_height_m", 0.47},
            {"weight_front", 0.50},
            {"wheelbase_m", 2.65},
            {"inertia_roll_kgm2", 550.0},
            {"inertia_pitch_kgm2", 2100.0},
            {"inertia_yaw_kgm2", 2400.0},
        }},
        {"front_axle", dummy_axle},
        {"rear_axle", dummy_axle},
        {"tire_front", tj},
        {"tire_rear", tj},
        {"brakes", {
            {"bias_front", 0.62},
            {"max_total_torque_nm", 7000.0},
        }},
        {"engine", {
            {"torque_curve", json::array({json::array({1000.0, 200.0}), json::array({7000.0, 200.0})})},
            {"idle_rpm", 900.0},
            {"redline_rpm", 7500.0},
            {"inertia_kgm2", 0.25},
            {"friction_const_nm", 20.0},
            {"friction_linear_nm_per_radps", 0.03},
        }},
        {"drivetrain", {
            {"gear_ratios", json::array({-3.5, 0.0, 3.0})},
            {"final_drive", 3.7},
            {"efficiency", 0.92},
            {"clutch_max_torque_nm", 900.0},
            {"driveline_inertia_kgm2", 0.05},
            {"layout", "rwd"},
        }},
        {"aero", {
            {"drag_area_m2", 0.68},
            {"downforce_area_m2", 0.0},
            {"front_balance", 0.45},
        }},
        {"surface_grip", {
            {"asphalt", 1.0},
        }},
    };

    return rs::parse_car_config(car.dump()).tire_front;
}

void print_row(const char* sweep, double fz, double camber_deg, double kappa, double alpha_deg,
               const rs::TireForces& tf, double fx_pure, double fy_pure, double mz_pure) {
    std::printf("%s,%.1f,%.2f,%.6f,%.4f,%.8f,%.8f,%.8f,%.8f,%.8f,%.8f,%.8f\n",
                sweep, fz, camber_deg, kappa, alpha_deg,
                tf.fx, tf.fy, tf.mz, tf.pneumatic_trail,
                fx_pure, fy_pure, mz_pure);
}

}  // namespace

int main(int argc, char** argv) {
    std::string tire_json_path;
    double radius_m = 0.344;  // UNLOADED_RADIUS in audi_245_40R18_pac2002.tir
    double vx_mps = 16.6;     // LONGVL in audi_245_40R18_pac2002.tir
    std::string mode = "nominal";

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--tire-json" && i + 1 < argc) {
            tire_json_path = argv[++i];
        } else if (arg == "--radius" && i + 1 < argc) {
            radius_m = std::atof(argv[++i]);
        } else if (arg == "--vx" && i + 1 < argc) {
            vx_mps = std::atof(argv[++i]);
        } else if (arg == "--mode" && i + 1 < argc) {
            mode = argv[++i];
        } else if (arg == "-h" || arg == "--help") {
            std::cerr << "usage: mf_dump --tire-json <path|-> [--radius 0.344] [--vx 16.6] [--mode nominal|stribeck|hybrid]\n";
            return 0;
        } else {
            std::cerr << "mf_dump: unknown argument '" << arg << "'\n";
            return 2;
        }
    }
    if (tire_json_path.empty()) {
        std::cerr << "mf_dump: --tire-json is required\n";
        return 2;
    }

    try {
        const rs::TireParams tp = load_tire_from_tir2car_json(read_all(tire_json_path), radius_m);

        // Nominal reference thermal & inflation state (80 C uniform across carcass/surface/ribs/flash,
        // pressure = pressure_nominal_kpa -> dpi = 0).
        rs::TireCondition cond;
        cond.temperature_c = 80.0;
        cond.surface_c = 80.0;
        cond.flash_c = 80.0;
        cond.inner_c = 80.0;
        cond.middle_c = 80.0;
        cond.outer_c = 80.0;
        cond.pressure_kpa = tp.p_nominal_kpa;
        cond.wear = 0.0;

        const double dpi = cond.dpi(tp);
        const double mu_surface = 1.0;

        constexpr double kLoads[] = {2000.0, 4000.0, 6000.0};
        constexpr double kCambersDeg[] = {0.0, -2.0};
        constexpr double kDegToRad = rs::kPi / 180.0;

        std::printf("sweep,fz_n,camber_deg,kappa,alpha_deg,fx_n,fy_n,mz_nm,trail_m,fx_pure_n,fy_pure_n,mz_pure_nm\n");

        auto make_op = [&](double kappa, double alpha_rad) {
            rs::TireOperating op;
            op.dpi = dpi;
            op.phi = 0.0;
            op.rolling_speed_mps = vx_mps;
            op.yaw_rate_rads = 0.0;
            op.gamma_rate_rads = 0.0;
            op.wheel_side_sign = -1.0;  // left tyre matching TYRESIDE='LEFT'
            op.enable_contact_patch_grid = true;
            op.enable_mf62_hybrid = (mode == "hybrid");
            op.condition = &cond;
            if (mode == "stribeck") {
                op.slip_speed = vx_mps * std::hypot(kappa, std::tan(alpha_rad));
            } else {
                // Evaluate at the calibrated nominal slip-speed reference so stribeck_friction_factor == 1.0
                // (pure isothermal PAC2002 reference without LMUV sliding-speed decay).
                op.slip_speed = tp.lmuv_ref_mps;
            }
            return op;
        };

        for (double fz : kLoads) {
            for (double camber_deg : kCambersDeg) {
                const double gamma = camber_deg * kDegToRad;

                // Pure longitudinal sweep: kappa in [-0.30, +0.30], step 0.005, alpha = 0
                for (int i = -60; i <= 60; ++i) {
                    const double kappa = i * 0.005;
                    const rs::TireOperating op = make_op(kappa, 0.0);
                    const rs::TireForces tf = rs::magic_formula(tp, kappa, 0.0, fz, mu_surface, gamma, op);
                    const double fx_p = rs::mf_pure_fx(tp, kappa, fz, mu_surface, gamma, dpi);
                    const double fy_p = rs::mf_pure_fy(tp, 0.0, fz, mu_surface, gamma, dpi);
                    const double mz_p = rs::mf_aligning_torque(tp, kappa, 0.0, fz, mu_surface, gamma, fx_p, fy_p, nullptr);
                    print_row("pure_long", fz, camber_deg, kappa, 0.0, tf, fx_p, fy_p, mz_p);
                }

                // Pure lateral sweep: alpha in [-20.0, +20.0] deg, step 0.5 deg, kappa = 0
                for (int i = -40; i <= 40; ++i) {
                    const double alpha_deg = i * 0.5;
                    const double alpha_rad = alpha_deg * kDegToRad;
                    const double tan_alpha = std::tan(alpha_rad);
                    const rs::TireOperating op = make_op(0.0, alpha_rad);
                    const rs::TireForces tf = rs::magic_formula(tp, 0.0, tan_alpha, fz, mu_surface, gamma, op);
                    const double fx_p = rs::mf_pure_fx(tp, 0.0, fz, mu_surface, gamma, dpi);
                    const double fy_p = rs::mf_pure_fy(tp, alpha_rad, fz, mu_surface, gamma, dpi);
                    const double mz_p = rs::mf_aligning_torque(tp, 0.0, alpha_rad, fz, mu_surface, gamma, fx_p, fy_p, nullptr);
                    print_row("pure_lat", fz, camber_deg, 0.0, alpha_deg, tf, fx_p, fy_p, mz_p);
                }
            }
        }
    } catch (const std::exception& e) {
        std::cerr << "ERROR: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
