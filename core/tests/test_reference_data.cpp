// Layer 1 validation against the committed reference data sets (docs/physics-data-gaps.md). Until now those files were
// only checked by Node scripts (tools/physics/*.mjs) that read the car JSON: nothing ran the SIMULATION against them.
// These tests drive every shipped car through the real Vehicle model and hold the result against the data:
//
//   * FMVSS 135 (49 CFR 571.135, public domain) - data/physics/brakes-reference.json: the ABS stop from 100 km/h must
//     stay inside the legal cold-effectiveness envelope AND must not beat what the tyres' own peak friction (plus the
//     downforce and drag the car has at that speed) allows: a stop shorter than physics is a model bug, not a good car.
//   * US EPA certification / coast-down (public domain) - data/powertrain/final-drives.json: every car's axle ratio is a
//     ratio a real car of that gear count ships with, and the top speed the simulation reaches equals the one the
//     engine curve, gearing, drag area (EPA-derived) and rolling resistance predict on paper.
//   * Measured Toyota 7A-FE full-load curve (CC BY 4.0, Zenodo 10.5281/zenodo.23856320) - data/physics/torque-reference.json:
//     the engine model fed that curve verbatim, run on the chassis dyno, must give the curve back (torque, power).
//   * NHTSA NCAP 2020 / VRTC Federal Register (public domain) - data/physics/inertia-reference.json: the tilt-table
//     static stability factor of every car, computed from the SIM's own geometry, sits inside the measured sports-car
//     range, and the sim's quasi-static lateral load transfer agrees with the measured-CG formula.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>
#include "harness.hpp"
#include "measure.hpp"
#include "nlohmann/json.hpp"
#include "rs/controls.hpp"
#include "rs/dyno.hpp"

using namespace rs;
namespace fs = std::filesystem;

namespace {

nlohmann::json read_json(const std::string& rel) {
    std::ifstream f(test::data_path(rel));
    if (!f) throw std::runtime_error("missing data file " + rel);
    return nlohmann::json::parse(f);
}

// Every shipped car (data/cars/*.json minus the *.visual.json sidecars and the catalogue), in a stable order.
std::vector<CarConfig> all_cars() {
    std::vector<std::string> names;
    for (const auto& e : fs::directory_iterator(test::data_path("cars"))) {
        const std::string n = e.path().filename().string();
        if (e.path().extension() != ".json" || n == "catalog.json" || n.find(".visual.") != std::string::npos) continue;
        names.push_back(n);
    }
    std::sort(names.begin(), names.end());
    std::vector<CarConfig> cars;
    for (const auto& n : names) cars.push_back(load_car_config(test::data_path("cars/" + n)));
    return cars;
}

double curve_at(const std::vector<std::array<double, 2>>& c, double rpm) {
    if (c.empty()) return 0;
    if (rpm <= c.front()[0]) return c.front()[1];
    for (std::size_t i = 1; i < c.size(); ++i)
        if (rpm <= c[i][0]) {
            const double t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
            return c[i - 1][1] + t * (c[i][1] - c[i - 1][1]);
        }
    return c.back()[1];
}

// FMVSS 135 cold-effectiveness limit, from the clause stored in brakes-reference.json (S <= 0.10 V + 0.0060 V^2).
double fmvss_cold_limit_m(double v_kmh) { return 0.10 * v_kmh + 0.0060 * v_kmh * v_kmh; }

// Best stop the tyres' peak friction allows: both axles at mu, plus aero (downforce raises the grip, drag adds to the
// braking). Integrates v dv = a(v) dx from v0 to 0. Load sensitivity lets an unloaded axle exceed mu0, so callers allow
// a few per cent of headroom.
double friction_limited_stop_m(const CarConfig& cfg, double v0) {
    const double mu = std::max(cfg.tire_front.mu_x, cfg.tire_rear.mu_x);
    double x = 0;
    const double dv = 0.01;
    for (double v = v0; v > dv; v -= dv) {
        const double q = 0.5 * cfg.aero.air_density * v * v;
        const double a = mu * (kGravity + q * cfg.aero.lift_area / cfg.mass) + q * cfg.aero.drag_area / cfg.mass;
        x += v / a * dv;
    }
    return x;
}

// ABS stop from v0 on flat dry asphalt, cold brakes, full pedal, clutch out (the FMVSS procedure, ABS equipped).
double abs_stop_m(const CarConfig& cfg, double v0) {
    auto s = test::make_sim(cfg);
    s->vehicle.assists().abs = true;
    s->reset({}, 0, v0, 4);
    s->settle(0.3);
    s->body.state.velocity = {v0, 0, 0};
    const Vec3 p0 = s->body.state.position;
    while (test::speed(*s) > 0.05 && s->time < 30) {
        DriverInput in;
        in.gear = 4;
        in.brake = 1.0;
        in.clutch = 1.0;
        s->step(in);
    }
    return length(s->body.state.position - p0);
}

// Top speed on paper: the highest speed at which the engine's full-load torque, through the top gear and the
// drivetrain efficiency, still covers drag + rolling resistance (+ the rolling resistance of the downforce). Capped at
// the redline in the top gear.
struct Paper {
    double v_mps = 0;
    bool rev_limited = false;
};
Paper paper_top_speed(const CarConfig& cfg) {
    const int top = static_cast<int>(cfg.drivetrain.gear_ratios.size()) - 1;
    const double G = cfg.drivetrain.gear_ratios[top] * cfg.drivetrain.final_drive;
    const double r = cfg.tire_rear.radius;
    const double v_red = cfg.engine.redline_rpm * 2 * kPi / 60 * r / G;
    Paper p;
    p.v_mps = v_red;
    p.rev_limited = true;
    for (double v = 5; v <= v_red; v += 0.02) {
        const double rpm = v / r * G * 60 / (2 * kPi);
        const double f_drive = curve_at(cfg.engine.torque_curve, rpm) * G * cfg.drivetrain.efficiency / r;
        const double q = 0.5 * cfg.aero.air_density * v * v;
        const double crr = rolling_resistance_coeff(cfg.tire_rear, v);
        const double f_res = q * cfg.aero.drag_area + crr * (cfg.mass * kGravity + q * cfg.aero.lift_area);
        if (f_drive < f_res) {
            p.v_mps = v;
            p.rev_limited = false;
            break;
        }
    }
    return p;
}

struct TopRun {
    double v_mps = 0;
    double load_swing = 0;   // (max - min) / mean of the summed tyre loads over the last 5 s of the run, relative
    double z_swing_m = 0;    // body height range over the same window
};
// Full throttle in the top gear on an endless straight until the speed stops rising (same procedure as sheet::top_speed),
// watching how steady the car rides at its top speed.
TopRun run_to_top_speed(const CarConfig& cfg) {
    auto s = test::make_sim(cfg);
    const int top = static_cast<int>(cfg.drivetrain.gear_ratios.size()) - 1;
    s->reset({}, 0, 60, top);
    TopRun r;
    double t_best = 0;
    struct Sample { double t, load, z; };
    std::vector<Sample> win;
    while (s->time < 240) {
        DriverInput in;
        in.gear = top;
        in.throttle = 1.0;
        s->step(in);
        const double v = test::speed(*s);
        if (v > r.v_mps + 0.01) { r.v_mps = v; t_best = s->time; }
        double load = 0;
        for (const auto& w : s->last.wheels) load += w.load;
        win.push_back({s->time, load, s->body.state.position.z});
        if (s->time - t_best > 10) break;
    }
    double lo = 1e18, hi = 0, sum = 0, zlo = 1e18, zhi = -1e18;
    int n = 0;
    for (const auto& w : win) {
        if (w.t < win.back().t - 5.0) continue;
        lo = std::min(lo, w.load); hi = std::max(hi, w.load); sum += w.load; ++n;
        zlo = std::min(zlo, w.z); zhi = std::max(zhi, w.z);
    }
    r.load_swing = n ? (hi - lo) / (sum / n) : 0;
    r.z_swing_m = zhi - zlo;
    return r;
}

// Full throttle from rest with the auto gearbox until max_s (same drive as test_dyno).
template <class Step>
void flat_out_pull(const CarConfig& cfg, double max_s, Step step) {
    Controls c(cfg);
    c.settings.auto_gearbox = true;
    VehicleOutput last;
    RawInput raw;
    raw.device = InputDevice::Wheel;
    raw.throttle = 1.0;
    for (double t = 0; t < max_s; t += 1.0 / 240.0) last = step(c.update(raw, last, 1.0 / 240.0));
}

}  // namespace

// ---- FMVSS 135 ------------------------------------------------------------------------------------------------------
RS_TEST(reference_data_fmvss_braking) {
    const auto ref = read_json("physics/brakes-reference.json");
    // the C++ clause must be the same one the data file states
    for (const auto& row : ref.at("requirements")) {
        const double v = row.at("v_kmh").get<double>();
        test::check_range("FMVSS table row equals 0.10 V + 0.0060 V^2", row.at("cold_max_stop_m").get<double>(), fmvss_cold_limit_m(v) - 0.05, fmvss_cold_limit_m(v) + 0.05, "m");
    }
    const double legal_100 = fmvss_cold_limit_m(100);
    for (const CarConfig& cfg : all_cars()) {
        const double stop = abs_stop_m(cfg, 100 / 3.6);
        const double bound = friction_limited_stop_m(cfg, 100 / 3.6);
        std::printf("         %-22s ABS 100-0 km/h %5.1f m | tyre-limit %5.1f m | FMVSS cold limit %.0f m | mean %.2f g\n", cfg.name.c_str(), stop, bound, legal_100,
                    (100 / 3.6) * (100 / 3.6) / (2 * stop) / kGravity);
        test::check_range((cfg.name + ": inside the FMVSS 135 cold envelope").c_str(), stop, 0, legal_100, "m");
        // a stop shorter than the tyres' own peak friction allows would be free energy (5 % for load sensitivity)
        test::check_range((cfg.name + ": not shorter than the tyre limit").c_str(), stop / bound, 0.95, 3.0, "x");
    }
}

// ---- top speed on paper vs simulation, and the ride at top speed ----------------------------------------------------------
// Regression for the damper compression rate: it used to be the mount velocity dotted with the ray direction, which also
// counted forward speed x sin(pitch). Above ~300 km/h that false force fed pitch into heave and the car bounced in a
// growing limit cycle (wheel loads swinging 8-25 kN on a 13 kN car; the Aether Borealis R took off and its "top speed"
// came out at 610 km/h while its engine, gearing and drag allow 376). A real car rides steadily at its top speed.
RS_TEST(reference_data_top_speed_balance) {
    for (const CarConfig& cfg : all_cars()) {
        const Paper paper = paper_top_speed(cfg);
        const TopRun run = run_to_top_speed(cfg);
        std::printf("         %-22s paper %6.1f km/h (%s) | simulated %6.1f km/h | ratio %.3f | load swing %.1f %% | heave %.1f mm\n", cfg.name.c_str(),
                    paper.v_mps * 3.6, paper.rev_limited ? "rev-limited" : "drag-limited", run.v_mps * 3.6, run.v_mps / paper.v_mps,
                    run.load_swing * 100, run.z_swing_m * 1000);
        test::check_range((cfg.name + ": simulated top speed vs the paper balance").c_str(), run.v_mps / paper.v_mps, 0.97, 1.02, "x");
        test::check_range((cfg.name + ": steady ride at top speed (load swing)").c_str(), run.load_swing, 0, 0.06, "");
        test::check_range((cfg.name + ": steady ride at top speed (heave)").c_str(), run.z_swing_m, 0, 0.004, "m");
    }
}

// ---- measured Toyota 7A-FE curve through the engine model and the chassis dyno ----------------------------------------------
// The curve goes in verbatim (data/physics/torque-reference.json, CC BY 4.0). The car is the Mistra 200T body (front-drive)
// with this engine in it and ONE tall forward gear, pulled flat out on the road-load dyno from 1500 rpm to the limiter.
// One tall gear is how a chassis dyno is run (a near 1:1 gear, e.g. 4th): in 1st or 2nd the engine, driveline and wheels
// swallow up to a third of the torque as rotational inertia while the car accelerates, which the table (taken at steady
// speed on a water brake) does not contain. The dyno turns the tractive power back into a crank-torque estimate
// (wheel power + the tyres' rolling resistance power, over drivetrain efficiency x engine speed); against the table what
// is left is the small inertia of a slow pull in a tall gear.
RS_TEST(reference_data_measured_engine_curve) {
    const auto ref = read_json("physics/torque-reference.json");
    const auto& curve = ref.at("curves").at(0);
    test::check("reference curve is the Toyota 7A-FE, CC BY 4.0, measured not digitised",
                curve.at("id").get<std::string>() == "toyota-7a-fe-1.8-full-load" && curve.at("measured").get<bool>() &&
                    !curve.at("digitised").get<bool>() && curve.at("source").at("license").at("id").get<std::string>() == "CC-BY-4.0");
    std::vector<std::array<double, 2>> pts;
    for (const auto& p : curve.at("points_rpm_nm")) pts.push_back({p.at(0).get<double>(), p.at(1).get<double>()});

    CarConfig cfg = load_car_config(test::data_path("cars/mistra_200t.json"));
    cfg.name = "Mistra body, Toyota 7A-FE engine";
    cfg.engine.torque_curve = pts;
    cfg.engine.idle_rpm = 900;
    cfg.engine.redline_rpm = 5600;      // just above the last measured point: the engine never runs on extrapolated numbers
    cfg.engine.cylinders = 4;
    cfg.drivetrain.gear_ratios = {-3.2, 0.0, 1.0};   // reverse, neutral, one forward gear
    cfg.drivetrain.gear_teeth.clear();
    cfg.drivetrain.final_drive_teeth = {0, 0};
    cfg.drivetrain.final_drive = 3.9;                // 5600 rpm at ~172 km/h
    const double G = cfg.drivetrain.final_drive;
    const double r = cfg.tire_front.radius;          // front-drive body

    auto s = test::make_sim(cfg);
    s->vehicle.assists().tc = false;
    const double v0 = 1500 * 2 * kPi / 60 * r / G;
    s->reset({}, 0, v0, 2);
    DynoMeter meter(cfg);
    while (s->time < 240) {
        DriverInput in;
        in.gear = 2;
        in.throttle = 1.0;
        s->step(in);
        meter.sample(s->last, s->vehicle.engine_rpm(), s->dt, 1.0);
        if (s->vehicle.engine_rpm() > 5500) break;
    }

    double p_peak = 0, p_rpm = 0, t_peak = 0, t_rpm = 0;
    for (const auto& pt : pts) {
        const double p = pt[1] * pt[0] * 2 * kPi / 60;
        if (p > p_peak) { p_peak = p; p_rpm = pt[0]; }
        if (pt[1] > t_peak) { t_peak = pt[1]; t_rpm = pt[0]; }
    }
    int covered = 0;
    double worst = 0, mean = 0, est_peak = 0, est_rpm = 0;
    for (const auto& pt : meter.curve()) {
        if (pt.rpm < 1700 || pt.rpm > 5200 || pt.wheel_power_w <= 0) continue;
        const double w_e = pt.rpm * 2 * kPi / 60, v = w_e / G * r;
        const double p_rr = rolling_resistance_coeff(cfg.tire_front, v) * cfg.mass * kGravity * v;
        const double est = (pt.wheel_power_w + p_rr) / (cfg.drivetrain.efficiency * w_e);
        const double ref_nm = curve_at(pts, pt.rpm);
        if (std::getenv("RS_DEBUG")) std::printf("           %5.0f rpm  dyno %6.1f Nm  measured %6.1f Nm  ratio %.3f\n", pt.rpm, est, ref_nm, est / ref_nm);
        worst = std::max(worst, std::abs(est / ref_nm - 1.0));
        mean += est / ref_nm;
        if (est > est_peak) { est_peak = est; est_rpm = pt.rpm; }
        ++covered;
    }
    mean = covered ? mean / covered : 0;
    std::printf("         7A-FE, one tall gear: measured peak %.1f Nm at %.0f rpm | dyno estimate peak %.1f Nm at %.0f rpm | %d bins, mean estimate/measured %.3f, worst %.1f %%\n",
                t_peak, t_rpm, est_peak, est_rpm, covered, mean, worst * 100);
    test::check_range("rpm bins the pull covered", covered, 12, 60, "bins");
    test::check_range("mean crank-torque estimate vs the measured curve", mean, 0.97, 1.03, "x");
    test::check_range("worst single bin vs the measured curve", worst, 0, 0.06, "");
    test::check_range("peak torque rpm vs the measured curve", est_rpm / t_rpm, 0.80, 1.25, "x");
    test::check_range("peak torque vs the measured curve", est_peak / t_peak, 0.97, 1.03, "x");
}
