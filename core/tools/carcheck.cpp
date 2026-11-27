// Apache-2.0 - rs_carcheck: physics sanity check of a car file (schema car/1). Measures the car the way magazines do (0-100 km/h, 60-0 mph, 300 ft skidpad, core/tests/measure.hpp) and checks the result
// against limits the car's OWN data implies: the engine's energy, the tyre's grip, determinism. These are SELF-CONSISTENCY checks: they catch impossible or broken cars (a typo that gives 3 g, a tyre file
// for the wrong load, a gearbox that cannot launch). They do NOT say the car is accurate against its real counterpart: that needs measured data.
//
//   rs_carcheck <car.json> [--json report.json]        exit 0 = no FAIL (WARN allowed), 1 = at least one FAIL
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>
#include "harness.hpp"
#include "measure.hpp"
#include "rs/config.hpp"
#include "rs/tire.hpp"

namespace {
using namespace rs;

struct Finding { std::string level, what, detail; };

double peak_mu(const TireParams& p, double fz, bool lateral) {
    TireOperating op;
    op.slip_speed = p.lmuv_ref_mps;
    op.rolling_speed_mps = 16.6;
    op.enable_contact_patch_grid = true;
    op.enable_mf62_hybrid = false;
    double best = 0.0;
    for (int i = 1; i <= 300; ++i) {
        const double s = lateral ? std::tan(i * 0.1 * kPi / 180.0) : i * 0.001;
        const TireForces f = lateral ? magic_formula(p, 0.0, s, fz, 1.0, 0.0, op) : magic_formula(p, s, 0.0, fz, 1.0, 0.0, op);
        best = std::max(best, std::abs(lateral ? f.fy : f.fx) / fz);
    }
    return best;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: rs_carcheck <car.json> [--json report.json]\n"); return 2; }
    std::string json_path;
    for (int i = 2; i + 1 < argc; ++i) if (std::string(argv[i]) == "--json") json_path = argv[i + 1];
    CarConfig cfg;
    try { cfg = load_car_config(argv[1]); } catch (const std::exception& e) { std::fprintf(stderr, "%s\n", e.what()); return 1; }

    std::vector<Finding> out;
    auto add = [&](const char* level, const std::string& what, const std::string& detail) { out.push_back({level, what, detail}); };
    char buf[300];

    const double m = cfg.mass, g = kGravity;
    double p_peak = 0, rpm_peak = 0;
    for (const auto& pt : cfg.engine.torque_curve) {  // (rpm, N m)
        const double p = pt[1] * pt[0] * 2.0 * kPi / 60.0;
        if (p > p_peak) { p_peak = p; rpm_peak = pt[0]; }
    }
    std::printf("%s: %.0f kg, wheelbase %.2f m, %.0f kW at %.0f rpm (%.0f kW/t), %s\n", cfg.name.c_str(), m, cfg.wheelbase, p_peak / 1000.0, rpm_peak, p_peak / m, cfg.drivetrain.layout.c_str());

    // tyre
    const double static_load = m * g * cfg.weight_front * 0.5, rear_static = m * g * (1.0 - cfg.weight_front) * 0.5;
    for (int axle = 0; axle < 2; ++axle) {
        const TireParams& t = axle == 0 ? cfg.tire_front : cfg.tire_rear;
        const double fz = axle == 0 ? static_load : rear_static;
        const double mux = peak_mu(t, fz, false), muy = peak_mu(t, fz, true);
        std::printf("  %s tyre: nominal load %.0f N, static load %.0f N, peak grip %.2f (long) %.2f (lat)\n", axle ? "rear " : "front", t.fz0, fz, mux, muy);
        const double ratio = fz / t.fz0;
        std::snprintf(buf, sizeof buf, "%s tyre carries %.0f N against a nominal load of %.0f N (x%.2f)", axle ? "rear" : "front", fz, t.fz0, ratio);
        if (ratio < 0.4 || ratio > 2.5) add("WARN", "tyre load", std::string(buf) + ": the tyre runs on a far-off part of its load curve; check FNOMIN / the tyre file against this car");
        if (muy < 0.5 || muy > 2.5) { std::snprintf(buf, sizeof buf, "%s tyre peak lateral grip %.2f is outside 0.5 .. 2.5", axle ? "rear" : "front", muy); add("WARN", "tyre grip", buf); }
    }
    const double mux_f = peak_mu(cfg.tire_front, static_load, false), muy_f = peak_mu(cfg.tire_front, static_load, true);
    const double mux_r = peak_mu(cfg.tire_rear, rear_static, false), muy_r = peak_mu(cfg.tire_rear, rear_static, true);
    const double mux = 0.5 * (mux_f + mux_r), muy = 0.5 * (muy_f + muy_r);

    // measurements
    sheet::Sheet a, b;
    sheet::launch(cfg, a);
    sheet::launch(cfg, b);
    const double brake60 = sheet::brake_60(cfg), skid = sheet::skidpad(cfg);
    std::printf("  0-60 mph %.2f s | 0-100 km/h %.2f s | 0-200 km/h %.2f s | 60-0 mph %.1f m | skidpad %.3f g\n", a.t60, a.t100, a.t200, brake60, skid);

    // 1. finite, deterministic
    if (!(std::isfinite(a.t100) && a.t100 > 0 && std::isfinite(brake60) && brake60 > 0 && std::isfinite(skid) && skid > 0)) add("FAIL", "finite results", "0-100, braking or skidpad is not a positive finite number: the car cannot launch, stop or hold a circle");
    else add("PASS", "finite results", "launch, braking and skidpad all completed");
    if (a.t100 == b.t100 && a.t60 == b.t60) add("PASS", "deterministic", "two identical launches give identical times");
    else add("FAIL", "deterministic", "two identical launches differ: the simulation is not reproducible");

    // 2. 0-100 km/h against the engine's energy: even a lossless, traction-unlimited car needs KE / P_peak
    const double v100 = 100.0 / 3.6, t_min = 0.5 * m * v100 * v100 / p_peak;
    if (std::isfinite(a.t100) && a.t100 > 0) {
        std::snprintf(buf, sizeof buf, "0-100 km/h in %.2f s; the engine's peak power alone allows no less than %.2f s (kinetic energy / peak power)", a.t100, t_min);
        if (a.t100 < 0.98 * t_min) add("FAIL", "launch vs engine energy", std::string(buf) + ": faster than physics allows");
        else if (a.t100 > 6.0 * t_min) add("WARN", "launch vs engine energy", std::string(buf) + ": more than 6x slower than the power allows (traction, gearing or clutch?)");
        else add("PASS", "launch vs engine energy", buf);
    }
    // 3. braking and cornering against the tyres' own grip (aero adds a little at 60 mph / 15 m/s: allowed for by 15 %)
    const double decel_g = (26.8224 * 26.8224) / (2.0 * brake60) / g;
    std::snprintf(buf, sizeof buf, "braking %.2f g against a tyre peak of %.2f", decel_g, mux);
    if (decel_g > 1.15 * mux + 0.05) add("FAIL", "braking vs tyre grip", std::string(buf) + ": more than the tyres can give (+15 % for aero)");
    else if (decel_g < 0.4 * mux) add("WARN", "braking vs tyre grip", std::string(buf) + ": less than 40 % of what the tyres can give (brake torque or bias?)");
    else add("PASS", "braking vs tyre grip", buf);
    std::snprintf(buf, sizeof buf, "skidpad %.3f g against a tyre peak of %.2f", skid, muy);
    if (skid > 1.15 * muy + 0.05) add("FAIL", "cornering vs tyre grip", std::string(buf) + ": more than the tyres can give (+15 % for aero)");
    else if (skid < 0.4 * muy) add("WARN", "cornering vs tyre grip", std::string(buf) + ": less than 40 % of what the tyres can give (balance, roll stiffness or the driver model?)");
    else add("PASS", "cornering vs tyre grip", buf);

    int fails = 0, warns = 0;
    std::printf("\n");
    for (const Finding& f : out) {
        std::printf("[%s] %s: %s\n", f.level.c_str(), f.what.c_str(), f.detail.c_str());
        fails += f.level == "FAIL";
        warns += f.level == "WARN";
    }
    std::printf("\n%d FAIL, %d WARN. These are self-consistency checks: they do not show the car matches its real counterpart.\n", fails, warns);
    if (!json_path.empty()) {
        std::ofstream j(json_path);
        j << "{\"car\":\"" << cfg.name << "\",\"t60\":" << a.t60 << ",\"t100\":" << a.t100 << ",\"t200\":" << a.t200 << ",\"brake60_m\":" << brake60 << ",\"skidpad_g\":" << skid << ",\"fail\":" << fails << ",\"warn\":" << warns << ",\"findings\":[";
        for (std::size_t i = 0; i < out.size(); ++i) {
            std::string d = out[i].detail;
            for (char& c : d) if (c == '"') c = '\'';
            j << (i ? "," : "") << "{\"level\":\"" << out[i].level << "\",\"what\":\"" << out[i].what << "\",\"detail\":\"" << d << "\"}";
        }
        j << "]}\n";
    }
    return fails ? 1 : 0;
}
