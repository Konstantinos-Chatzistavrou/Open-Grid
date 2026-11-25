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
#include <map>
#include <string>
#include <vector>
#include "harness.hpp"
#include "measure.hpp"
#include "nlohmann/json.hpp"
#include "rs/ai.hpp"
#include "rs/controls.hpp"
#include "rs/dyno.hpp"
#include "rs/racing_line.hpp"
#include "rs/route.hpp"

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

// ---- NHTSA static stability: the sim's own tilt table ----------------------------------------------------------------------
// NHTSA's static stability factor is SSF = T / (2 H) (track over twice the measured CG height); a rigid car on a tilt table
// lifts its high-side wheels at tan(phi) = SSF, and a real one a little earlier because the springs let the body roll toward
// the low side. Here the car sits on a plane that is tilted slowly (3 deg/s to 30 deg, then 0.3 deg/s) about the car's long axis, on tyres grippy
// enough not to slide (a tilt table has strapped or very high friction), and we note the angle at which the two high-side
// wheels are unloaded. The CG heights come from the measured data (NHTSA/VRTC 1997 SUVs, NCAP 2020 cars).
namespace {
class TiltGround : public Ground {
public:
    double phi = 0;   // rad, the plane rises toward +y (the car's left)
    WheelContact raycast(const WheelRay& ray) const override {
        const Vec3 n{0, -std::sin(phi), std::cos(phi)};
        WheelContact c;
        const double denom = dot(ray.direction, n);
        if (denom >= -1e-9) return c;
        const double t = -dot(ray.origin, n) / denom;
        if (t < 0 || t > ray.length) return c;
        c.hit = true; c.distance = t; c.point = ray.origin + ray.direction * t; c.normal = n; c.surface = 0;
        return c;
    }
};

// tilt angle (rad) at which both high-side wheels carry < 2 % of their level load; -1 if the car slides / never lifts by 75 deg
double tilt_lift_angle(CarConfig cfg) {
    cfg.tire_front.mu_x *= 4; cfg.tire_front.mu_y *= 4; cfg.tire_rear.mu_x *= 4; cfg.tire_rear.mu_y *= 4;
    auto ground = std::make_shared<TiltGround>();
    Simulation s(cfg, ground);
    s.dt = 1.0 / 240.0;
    s.reset({}, 0, 0, 1);
    s.settle(1.0);
    double w0 = 0;
    for (int i : {0, 2}) w0 += s.last.wheels[i].load;
    DriverInput in;
    in.handbrake = 0; in.brake = 0.0; in.throttle = 0; in.clutch = 1.0; in.gear = 1;
    while (ground->phi < 75 * kPi / 180) {
        // quickly to 30 deg (no car of this kind lifts before 40), then slowly enough to be quasi-static
        ground->phi += (ground->phi < 30 * kPi / 180 ? 3.0 : 0.3) * kPi / 180 * s.dt;
        s.step(in);
        double hi = s.last.wheels[0].load + s.last.wheels[2].load;
        if (s.time > 2.0 && hi < 0.02 * w0) return ground->phi;
        if (std::abs(s.body.state.position.y) > 15.0) return -1;   // slid off (a few metres of creep on a slope is the tyre's slip)
    }
    return -1;
}
}  // namespace

RS_TEST(reference_data_nhtsa_tilt_table) {
    const auto ref = read_json("physics/inertia-reference.json");
    const CarConfig base = load_car_config(test::data_path("cars/vela_gt.json"));
    const double track = 0.5 * (base.front.track + base.rear.track);
    // the measured CG heights (m): modern cars and the 1990s SUVs
    std::vector<std::pair<std::string, double>> cgs;
    for (const auto& e : ref.at("modernEntries")) cgs.push_back({e.at("vehicle").get<std::string>(), e.at("cg_in").get<double>() * 0.0254});
    for (const auto& e : ref.at("entries")) {
        if (!e.contains("cg_in") || e.at("configuration").get<std::string>().find("outrigger") != std::string::npos) continue;
        cgs.push_back({e.at("vehicle").get<std::string>() + " (" + e.at("configuration").get<std::string>() + ")", e.at("cg_in").get<double>() * 0.0254});
    }
    std::vector<double> done;   // one run per distinct CG height (several measured configurations share one to the millimetre)
    for (const auto& [name, cg] : cgs) {
        if (std::any_of(done.begin(), done.end(), [&](double d) { return std::abs(d - cg) < 0.002; })) continue;
        done.push_back(cg);
        CarConfig c = base;
        c.cg_height = cg;
        c.finalize();
        const double ssf = track / (2 * cg);
        const double phi = tilt_lift_angle(c);
        const double ratio = phi > 0 ? std::tan(phi) / ssf : 0;
        std::printf("         CG %.3f m (%s): SSF %.2f (track %.2f m) | sim lifts the high side at %.1f deg, tan = %.2f = %.2f x SSF\n", cg, name.c_str(), ssf, track, phi * 180 / kPi, std::tan(phi), ratio);
        test::check_range(("CG " + std::to_string(cg).substr(0, 5) + " m: tilt-table lift vs track / 2H").c_str(), ratio, 0.85, 1.0, "x");
    }
    // all shipped cars at their own CG and track
    for (const CarConfig& cfg : all_cars()) {
        const double t = 0.5 * (cfg.front.track + cfg.rear.track), ssf = t / (2 * cfg.cg_height);
        const double phi = tilt_lift_angle(cfg), ratio = phi > 0 ? std::tan(phi) / ssf : 0;
        std::printf("         %-22s SSF %.2f | lifts at %.1f deg = %.2f x SSF\n", cfg.name.c_str(), ssf, phi * 180 / kPi, ratio);
        test::check_range((cfg.name + ": tilt-table lift vs track / 2H").c_str(), ratio, 0.85, 1.0, "x");
    }
}

// ---- Project Chrono engine maps (BSD-3) through the engine model and the dyno --------------------------------------------------
// The same single-tall-gear pull as the 7A-FE test, for the four simple engine maps in data/powertrain/reference-powertrains.json
// (a 110 kW petrol, a 185 kW petrol, an 80 kW truck engine, a 193 kW bus diesel with 1250 N m). The test car is the Mistra body
// scaled to the engine (mass, inertia, springs, dampers, tyre inertia and drag area all by the same factor, so the power per
// weight and the way it drives are the same for each) and the clutch sized for the torque. The estimate adds back the tyres'
// rolling resistance at the cold-tyre coefficient; the sim lowers it as the tyres warm (pressure rises), so at the top of the
// pull the estimate reads up to ~4 % high: that, not the engine map, is the spread here.
namespace {
CarConfig scaled_body(CarConfig c, double k) {
    c.mass *= k; c.inertia_xx *= k; c.inertia_yy *= k; c.inertia_zz *= k;
    for (AxleParams* a : {&c.front, &c.rear}) {
        a->spring_rate *= k; a->bump_stop_rate *= k; a->damper_bump *= k; a->damper_rebound *= k; a->anti_roll_rate *= k;
    }
    c.tire_front.inertia *= k; c.tire_rear.inertia *= k;
    c.aero.drag_area *= k; c.aero.lift_area *= k;
    c.brake_torque_total *= k;
    return c;
}
struct PullResult { int covered = 0; double mean = 0, worst = 0, est_peak = 0, est_rpm = 0, t_peak = 0, t_rpm = 0, scale = 1; };
PullResult tall_gear_pull(const std::vector<std::array<double, 2>>& pts, double idle, double redline, int cyl, double peak_power_w) {
    PullResult res;
    double t_peak = 0, t_rpm = 0;
    for (const auto& p : pts) if (p[1] > t_peak) { t_peak = p[1]; t_rpm = p[0]; }
    res.t_peak = t_peak; res.t_rpm = t_rpm;
    res.scale = std::max(1.0, peak_power_w / 56000.0);
    CarConfig cfg = scaled_body(load_car_config(test::data_path("cars/mistra_200t.json")), res.scale);
    cfg.engine.torque_curve = pts;
    cfg.engine.idle_rpm = idle;
    cfg.engine.redline_rpm = redline;
    cfg.engine.cylinders = cyl;
    cfg.engine.inertia = 0.25 * res.scale;
    cfg.drivetrain.gear_ratios = {-3.2, 0.0, 1.0};
    cfg.drivetrain.gear_teeth.clear();
    cfg.drivetrain.final_drive_teeth = {0, 0};
    cfg.drivetrain.clutch_max_torque = std::max(cfg.drivetrain.clutch_max_torque, 2.0 * t_peak);
    const double r = cfg.tire_front.radius;
    const double G = redline * 2 * kPi / 60 * r / 47.6;   // the redline at ~171 km/h
    cfg.drivetrain.final_drive = G;
    auto s = test::make_sim(cfg);
    s->vehicle.assists().tc = false;
    const double rpm0 = std::max(1.4 * pts.front()[0], 1.5 * idle);
    s->reset({}, 0, rpm0 * 2 * kPi / 60 * r / G, 2);
    DynoMeter meter(cfg);
    while (s->time < 240) {
        DriverInput in;
        in.gear = 2; in.throttle = 1.0;
        s->step(in);
        meter.sample(s->last, s->vehicle.engine_rpm(), s->dt, 1.0);
        if (s->vehicle.engine_rpm() > 0.985 * redline) break;
    }
    for (const auto& pt : meter.curve()) {
        if (pt.rpm < rpm0 * 1.05 || pt.rpm > 0.93 * redline || pt.wheel_power_w <= 0) continue;
        const double w_e = pt.rpm * 2 * kPi / 60, v = w_e / G * r;
        const double p_rr = rolling_resistance_coeff(cfg.tire_front, v) * cfg.mass * kGravity * v;
        const double est = (pt.wheel_power_w + p_rr) / (cfg.drivetrain.efficiency * w_e);
        const double ref_nm = curve_at(pts, pt.rpm);
        if (std::getenv("RS_DEBUG")) std::printf("           %5.0f rpm  dyno %7.1f Nm  map %7.1f Nm  ratio %.3f\n", pt.rpm, est, ref_nm, est / ref_nm);
        res.worst = std::max(res.worst, std::abs(est / ref_nm - 1.0));
        res.mean += est / ref_nm;
        if (est > res.est_peak) { res.est_peak = est; res.est_rpm = pt.rpm; }
        ++res.covered;
    }
    res.mean = res.covered ? res.mean / res.covered : 0;
    return res;
}
}  // namespace

RS_TEST(reference_data_chrono_engine_maps) {
    const auto ref = read_json("powertrain/reference-powertrains.json");
    for (const auto& e : ref.at("entries")) {
        std::vector<std::array<double, 2>> pts;
        for (const auto& p : e.at("engine").at("torque_curve")) pts.push_back({p.at(0).get<double>(), p.at(1).get<double>()});
        const auto& en = e.at("engine");
        // the file's own peak figures must be what its curve says (a bad import fails here, not in a race)
        double pk = 0, pk_rpm = 0;
        for (const auto& p : pts) { const double w = p[0] * 2 * kPi / 60 * p[1]; if (w > pk) { pk = w; pk_rpm = p[0]; } }
        test::check_range((e.at("id").get<std::string>() + ": listed peak power vs its own curve").c_str(), en.at("peak_power_kw").get<double>() * 1000 / pk, 0.97, 1.03, "x");
        const PullResult r = tall_gear_pull(pts, en.at("idle_rpm").get<double>(), en.at("redline_rpm").get<double>(), 4, pk);
        std::printf("         %-7s map peak %.0f Nm at %.0f rpm / %.0f kW at %.0f rpm | body x%.1f | dyno: %d bins, mean est/map %.3f, worst %.1f %%, peak %.0f Nm at %.0f rpm\n",
                    e.at("id").get<std::string>().c_str(), r.t_peak, r.t_rpm, pk / 1000, pk_rpm, r.scale, r.covered, r.mean, r.worst * 100, r.est_peak, r.est_rpm);
        const std::string id = e.at("id").get<std::string>();
        test::check_range((id + ": rpm bins the pull covered").c_str(), r.covered, 6, 80, "bins");
        test::check_range((id + ": mean crank-torque estimate vs the map").c_str(), r.mean, 0.96, 1.06, "x");
        test::check_range((id + ": worst bin vs the map").c_str(), r.worst, 0, 0.09, "");
    }
}

// ---- EPA axle ratios --------------------------------------------------------------------------------------------------------
// data/powertrain/final-drives.json: 1,699 certified configurations with their gear count and axle ratio (US EPA, public
// domain). Every shipped car's final drive must be one a real car with that many gears ships with: inside the 5th..95th
// percentile of the EPA cars with the same gear count (the extremes are trucks and economy specials).
RS_TEST(reference_data_epa_final_drives) {
    const auto ref = read_json("powertrain/final-drives.json");
    std::map<int, std::vector<double>> by_gears;
    for (const auto& r : ref.at("rows")) by_gears[r.at("gears").get<int>()].push_back(r.at("final_drive").get<double>());
    for (auto& [g, v] : by_gears) std::sort(v.begin(), v.end());
    for (const CarConfig& cfg : all_cars()) {
        const int gears = static_cast<int>(cfg.drivetrain.gear_ratios.size()) - 2;
        auto it = by_gears.find(gears);
        test::check((cfg.name + ": EPA has cars with " + std::to_string(gears) + " gears").c_str(), it != by_gears.end() && it->second.size() >= 20);
        if (it == by_gears.end()) continue;
        const auto& v = it->second;
        const double lo = v[static_cast<std::size_t>(0.05 * v.size())], hi = v[static_cast<std::size_t>(0.95 * v.size()) - 1];
        const double fd = cfg.drivetrain.final_drive;
        const std::size_t below = std::lower_bound(v.begin(), v.end(), fd) - v.begin();
        std::printf("         %-22s %d gears, axle %.2f | EPA %d-gear cars: p5 %.2f median %.2f p95 %.2f | percentile %.0f\n", cfg.name.c_str(), gears, fd, gears, lo, v[v.size() / 2], hi, 100.0 * below / v.size());
        test::check_range((cfg.name + ": axle ratio vs the EPA 5-95 % band").c_str(), fd, lo, hi, "");
    }
}

// ---- aero data in the tyre loads -----------------------------------------------------------------------------------------------
// The drag area and lift area in the car files (EPA coast-down / class references) must arrive in the simulation as forces:
// at 200 km/h the tyres carry 1/2 rho ClA v^2 more load than at rest (ground effect and the ride-height balance move it by
// a few per cent), split front / rear by the car's own aero balance, and the car decelerates by 1/2 rho CdA v^2 / m.
RS_TEST(reference_data_aero_forces) {
    for (const CarConfig& cfg : all_cars()) {
        auto s = test::make_sim(cfg);
        s->settle(1.0);
        double w_static = 0, wf_static = 0;
        for (int i = 0; i < 4; ++i) { w_static += s->last.wheels[i].load; if (i < 2) wf_static += s->last.wheels[i].load; }
        const double v0 = 200 / 3.6;
        s->reset({}, 0, v0, 1);
        DriverInput in;
        in.gear = 1; in.clutch = 1.0; in.throttle = 0;
        double w = 0, wf = 0, a_sum = 0;
        int n = 0;
        for (int k = 0; k < 120; ++k) {
            s->step(in);
            if (k >= 60) {   // after the suspension has settled, a quarter second
                double sum = 0, front = 0;
                for (int i = 0; i < 4; ++i) { sum += s->last.wheels[i].load; if (i < 2) front += s->last.wheels[i].load; }
                w += sum; wf += front; a_sum += s->accel_body().x; ++n;
            }
        }
        w /= n; wf /= n; a_sum /= n;
        const double v = test::speed(*s), q = 0.5 * cfg.aero.air_density * v * v;
        const double down_expected = q * cfg.aero.lift_area, down_sim = w - w_static;
        const double share_sim = down_sim > 200 ? (wf - wf_static) / down_sim : cfg.aero.front_balance;
        // deceleration while coasting out of gear: aero drag + rolling resistance (+ drag of the idling engine through the wheels: none, neutral)
        const double drag_expected = q * cfg.aero.drag_area / cfg.mass + 0.011 * kGravity;
        std::printf("         %-22s downforce at 200 km/h: expected %5.0f N, tyres carry %5.0f N (%.2f) | front share %.2f vs balance %.2f | decel %.2f vs %.2f m/s^2\n", cfg.name.c_str(),
                    down_expected, down_sim, down_expected > 1 ? down_sim / down_expected : 1.0, share_sim, cfg.aero.front_balance, -a_sum, drag_expected);
        if (down_expected > 300) {
            test::check_range((cfg.name + ": extra tyre load at 200 km/h vs 1/2 rho ClA v^2").c_str(), down_sim / down_expected, 0.85, 1.30, "x");
        }
        // the split is only readable where there is something to split (the low-wing cars carry ~340 N: a few tens of newtons of
        // rolling-resistance load transfer is then a tenth of the share); the nose-down pitch under load moves it forward a little
        if (down_expected > 600)
            test::check_range((cfg.name + ": front share of the extra load vs the aero balance").c_str(), share_sim - cfg.aero.front_balance, -0.05, 0.10, "");
        test::check_range((cfg.name + ": coasting deceleration vs 1/2 rho CdA v^2 / m + rolling").c_str(), -a_sum / drag_expected, 0.85, 1.20, "x");
    }
}

// ---- the five real circuits (TUMFTM racetrack-database geometry, LGPL-3.0, validation use only) ---------------------------------
// Centreline and track widths of Monza, Brands Hatch GP, Spa, Silverstone and Suzuka are loaded as routes, a minimum-curvature
// racing line is computed on them, and a test driver (pure pursuit on that line, a PI speed loop on a speed profile built from
// the car's OWN measured limits: skidpad grip, ABS braking, engine-curve power, drag, downforce) drives a flying lap in two
// cars through the real Vehicle: the Vela GT road car and the Tornado GT3 on slicks with downforce. The profile is the
// quasi-steady-state lap: the fastest speed each point of the line allows. Checked:
//   - the lap is completed and the car stays on the track (widths from the data),
//   - the simulation does not beat the quasi-steady lap at 100 % of the limits (it would be free energy), stays within 20 % of
//     it, and within 10 % of the 92 % profile it is driven on (a slide, gear changes and transients cost the rest); the profile
//     includes the friction ellipse (a corner's lateral acceleration is not available for accelerating or braking: without it
//     the same car spins on 8 of 10 laps),
// and the lap time and average speed are printed. The game's own AI driver is tested on the same circuits below.
namespace {
Route load_tum_track(const std::string& rel) {
    std::ifstream f(test::data_path(rel));
    if (!f) throw std::runtime_error("missing track " + rel);
    std::vector<std::array<double, 4>> p;
    std::string line;
    while (std::getline(f, line)) {
        if (line.empty() || line[0] == '#') continue;
        for (char& c : line) if (c == ',') c = ' ';
        std::array<double, 4> a{};
        if (std::sscanf(line.c_str(), "%lf %lf %lf %lf", &a[0], &a[1], &a[2], &a[3]) == 4) p.push_back(a);
    }
    const int n = static_cast<int>(p.size());
    std::vector<RouteSample> s(n);
    std::vector<double> h(n);
    for (int i = 0; i < n; ++i) {
        const auto& a = p[i]; const auto& b = p[(i + 1) % n];
        h[i] = std::atan2(b[1] - a[1], b[0] - a[0]);
        s[i].p = {a[0], a[1], 0};
        s[i].width_right = a[2]; s[i].width_left = a[3];
        s[i].heading = h[i];
    }
    auto wrap = [](double d) { while (d > kPi) d -= 2 * kPi; while (d < -kPi) d += 2 * kPi; return d; };
    for (int i = 0; i < n; ++i) {
        const int a = (i + n - 2) % n, b = (i + 2) % n;
        const double ds = length(s[b].p - s[a].p);
        s[i].curvature = ds > 1e-6 ? wrap(h[b] - h[a]) / ds : 0.0;   // + = turning left
    }
    return Route::from_samples(std::move(s), true);
}

// speed (m/s) at every 2 m of the racing line from the car's limits, scaled by `use` (1 = the full measured limits)
std::vector<double> qss_profile(const Route& r, const RacingLine& line, const CarConfig& cfg, double a_lat_g, double a_brake_g, double v_top, double use) {
    const double ds = 2.0, rho = cfg.aero.air_density, m = cfg.mass;
    const int n = static_cast<int>(std::ceil(r.length() / ds));
    double p_peak = 0;
    for (const auto& pt : cfg.engine.torque_curve) p_peak = std::max(p_peak, pt[1] * pt[0] * 2 * kPi / 60);
    p_peak *= cfg.drivetrain.efficiency;
    std::vector<double> v(n), cap(n);
    for (int i = 0; i < n; ++i) {
        const double k = std::abs(line.curvature(i * ds));
        const double a = use * a_lat_g, den = k - a * rho * cfg.aero.lift_area / (2 * m);
        cap[i] = den > 1e-9 ? std::min(std::sqrt(a * kGravity / den), v_top) : v_top;
        v[i] = cap[i];
    }
    for (int pass = 0; pass < 3; ++pass) {
        for (int i = 0; i < 2 * n; ++i) {   // forward: power and traction limited
            const int a = i % n, b = (i + 1) % n;
            const double q = 0.5 * rho * v[a] * v[a];
            // friction ellipse: the lateral acceleration the corner takes is not available for driving
            const double k_here = std::abs(line.curvature(a * ds)), a_avail = use * a_lat_g * (kGravity + q * cfg.aero.lift_area / m);
            const double used = std::min(1.0, v[a] * v[a] * k_here / a_avail), ell = std::sqrt(std::max(0.0, 1 - used * used));
            const double f_trac = ell * 0.85 * use * a_lat_g * (m * kGravity + q * cfg.aero.lift_area);
            const double f = std::min(p_peak / std::max(v[a], 5.0), f_trac) - q * cfg.aero.drag_area - 0.011 * (m * kGravity + q * cfg.aero.lift_area);
            const double v2 = v[a] * v[a] + 2 * f / m * ds;
            v[b] = std::min(cap[b], std::sqrt(std::max(v2, 1.0)));
        }
        for (int i = 2 * n; i > 0; --i) {   // backward: braking limited
            const int b = i % n, a = (i - 1 + n) % n;
            const double q = 0.5 * rho * v[b] * v[b];
            const double k_here = std::abs(line.curvature(b * ds)), a_avail = use * a_lat_g * (kGravity + q * cfg.aero.lift_area / m);
            const double used = std::min(1.0, v[b] * v[b] * k_here / a_avail), ell = std::sqrt(std::max(0.0, 1 - used * used));
            const double dec = ell * use * a_brake_g * (kGravity + q * cfg.aero.lift_area / m) + q * cfg.aero.drag_area / m;
            v[a] = std::min(v[a], std::sqrt(v[b] * v[b] + 2 * dec * ds));
        }
    }
    return v;
}
double profile_time(const std::vector<double>& v) {
    const int n = static_cast<int>(v.size());
    double t = 0;
    for (int i = 0; i < n; ++i) t += 2.0 / (0.5 * (v[i] + v[(i + 1) % n]));
    return t;
}
}  // namespace

RS_TEST(reference_data_real_tracks) {
    const std::array<std::pair<const char*, const char*>, 5> tracks = {{
        {"Brands Hatch GP", "validation/racetrack-database/BrandsHatch.csv"}, {"Monza", "validation/racetrack-database/Monza.csv"},
        {"Spa-Francorchamps", "validation/tracks-extra/Spa.csv"}, {"Silverstone", "validation/tracks-extra/Silverstone.csv"},
        {"Suzuka", "validation/tracks-extra/Suzuka.csv"}}};
    // every shipped car: the Vela GT and the Tornado GT3 on all five circuits, the other 23 on Monza (RS_ALL_CARS=1: all 25 on all five)
    const bool all = std::getenv("RS_ALL_CARS") != nullptr;
    for (const CarConfig& cfg : all_cars()) {
        const std::string car_id = cfg.name == "Vela GT" ? "vela_gt" : cfg.name == "Tornado GT3" ? "tornado_gt3" : cfg.name;
        const bool full = all || car_id == "vela_gt" || car_id == "tornado_gt3";
        const double a_lat = sheet::skidpad(cfg), stop = abs_stop_m(cfg, 100 / 3.6);
        const double a_brake = (100 / 3.6) * (100 / 3.6) / (2 * stop) / kGravity;
        const double v_top = paper_top_speed(cfg).v_mps;
        std::printf("         %s: skidpad %.2f g, ABS braking %.2f g mean, top speed %.0f km/h\n", cfg.name.c_str(), a_lat, a_brake, v_top * 3.6);
        for (const auto& [name, rel] : tracks) {
            if (!full && std::string(name) != "Monza") continue;
            if (const char* only = std::getenv("RS_ONLY")) if (std::string(only) != std::string(name) + "/" + car_id) continue;
            const Route r = load_tum_track(rel);
            const RacingLine line(r);
            double min_w = 1e9;
            for (const auto& smp : r.samples()) min_w = std::min({min_w, smp.width_left, smp.width_right});
            const double use = 0.92;
            const std::vector<double> prof = qss_profile(r, line, cfg, a_lat, a_brake, v_top, use);
            const double t_full = profile_time(qss_profile(r, line, cfg, a_lat, a_brake, v_top, 1.0)), t_use = profile_time(prof);
            auto speed_at = [&](double s) {
                const double x = r.wrap(s) / 2.0;
                const int i = static_cast<int>(x) % static_cast<int>(prof.size()), j = (i + 1) % static_cast<int>(prof.size());
                return prof[i] + (prof[j] - prof[i]) * (x - std::floor(x));
            };
            const RouteSample s0 = r.at(0);
            auto sim = test::make_sim(cfg);
            sim->vehicle.assists().abs = sim->vehicle.assists().tc = true;
            sim->reset(s0.p, s0.heading, 25, 4);
            Controls ctl(sim->vehicle.config());
            ctl.settings.auto_gearbox = true;
            ctl.set_gear(4);
            sim->settle(0.2);
            const double lock = cfg.front.max_steer_deg * kPi / 180;
            double travelled = 0, last_s = 0, t_start = -1, worst = -1e9, vmax = 0, v_err_sum = 0;
            int v_err_n = 0;
            bool done = false, dbg = false;
            int hint = 0;
            while (sim->time < 2.6 * t_full + 10) {
                const ChassisState& st = sim->body.state;
                const Route::Projection pr = r.project(st.position, hint);
                hint = pr.index;
                const double v = test::speed(*sim);
                // path follower: curvature feed-forward of the racing line plus heading and lateral feedback (a Stanley-style law);
                // the lap time is then a property of the car's limits, not of how well a lookahead controller copes with them
                auto line_pt = [&](double sq) { return r.at(sq).p + r.left(sq) * line.lateral(sq); };
                const Vec3 t_ahead = line_pt(pr.s + 3.0) - line_pt(pr.s - 3.0);
                const double psi_path = std::atan2(t_ahead.y, t_ahead.x);
                const Vec3 fwd = st.orientation.rotate({1, 0, 0});
                double psi_e = std::atan2(fwd.y, fwd.x) - psi_path;
                while (psi_e > kPi) psi_e -= 2 * kPi;
                while (psi_e < -kPi) psi_e += 2 * kPi;
                const double e_y = pr.lateral - line.lateral(pr.s);
                // a slide: steer into it (towards where the car is going) and come off the pedals, as a driver does
                const double beta = sim->last.sideslip, slide = std::max(0.0, (std::abs(beta) - 0.05) / 0.10);
                const double delta = std::atan(cfg.wheelbase * line.curvature(pr.s + 0.15 * v)) - (1 - std::min(1.0, slide)) * psi_e - std::atan(1.5 * e_y / (v + 5.0)) + 1.2 * beta * std::min(1.0, slide);
                RawInput raw;
                raw.device = InputDevice::Wheel;
                raw.steer = clamp(delta / lock, -1.0, 1.0);
                // speed: follow the profile a little ahead of the car, brakes ahead of the corner come from the profile itself
                const double v_t = speed_at(pr.s + 0.4 * v + 3.0);
                const double a_des = 3.0 * (v_t - v);
                raw.throttle = clamp(a_des / 4.0 + 0.05, 0.0, 1.0);
                raw.brake = clamp(-a_des / 9.0, 0.0, 1.0);
                if (slide > 0) raw.throttle *= 1.0 - std::min(1.0, slide);
                if (std::getenv("RS_TRACE") && static_cast<int>(sim->time * 240) % 240 == 0 && std::abs(v - v_t) * 3.6 > 40 && sim->time > 60)
                    std::printf("           t %5.1f s %5.0f m v %3.0f vt %3.0f km/h gear %d rpm %5.0f thr %.2f brk %.2f ay %.2f g slipRL %.3f slipRR %.3f\n", sim->time, pr.s, v * 3.6, v_t * 3.6, sim->last.gear, sim->vehicle.engine_rpm(), raw.throttle, raw.brake, sim->accel_body().y / kGravity, sim->last.wheels[2].slip_ratio, sim->last.wheels[3].slip_ratio);
                sim->step(ctl.update(raw, sim->last, sim->dt));
                travelled += r.delta(last_s, pr.s);
                last_s = pr.s;
                if (t_start < 0 && travelled > r.length() * 0.25) { t_start = sim->time; travelled = 0; }
                if (t_start >= 0) {
                    const RouteSample sp = r.at(pr.s);
                    const double room = pr.lateral >= 0 ? sp.width_left : sp.width_right;
                    worst = std::max(worst, std::abs(pr.lateral) - room);   // > 0: the CG is outside the track edge
                    if (std::getenv("RS_DEBUG") && !dbg && std::abs(pr.lateral) - room > 0) {
                        dbg = true;
                        std::printf("           first excursion t %.1f s s %.0f m lat %.1f (room %.1f) line %.1f v %.0f vt %.0f km/h ay %.2f g yaw %.2f k %.4f kline %.4f beta %.1f deg\n", sim->time, pr.s, pr.lateral, room, line.lateral(pr.s), v * 3.6, v_t * 3.6, sim->accel_body().y / kGravity,
                                    sim->last.yaw_rate, sp.curvature, line.curvature(pr.s), sim->last.sideslip * 57.3);
                    }
                    vmax = std::max(vmax, v);
                    v_err_sum += std::abs(v - speed_at(pr.s)); ++v_err_n;
                }
                if (t_start >= 0 && travelled >= r.length()) { done = true; break; }
            }
            const double lap = sim->time - t_start;
            std::printf("         %-12s %-17s %.2f km: sim lap %6.1f s (avg %3.0f km/h, max %3.0f) | quasi-steady lap at 100 %% %6.1f s, at 92 %% %6.1f s | ratio %.3f | mean speed error %.1f km/h | CG vs the edge %.1f m (width %.1f)\n",
                        cfg.name.c_str(), name, r.length() / 1000, lap, r.length() / lap * 3.6, vmax * 3.6, t_full, t_use, lap / t_use,
                        v_err_n ? v_err_sum / v_err_n * 3.6 : 0.0, worst, min_w);
            const std::string tag = std::string(name) + " / " + cfg.name;
            if (car_id == "tornado_gt3" && done) {
                // real GT3 qualifying laps (indicative, cited in the file): the Tornado GT3 must not be faster than a real GT3
                const auto gt3 = read_json("physics/gt3-lap-references.json");   // a named local: a range-for over a temporary's member dangles
                for (const auto& l : gt3.at("laps"))
                    if (l.at("track").get<std::string>() == name) {
                        const double ref = l.at("time_s").get<double>();
                        std::printf("         %s vs a real GT3 qualifying lap of %.3f s: the car's quasi-steady lap at 100 %% of its limits is %+.1f %%, the test driver's lap (92 %% of the limits, transients) %+.0f %%\n",
                                    name, ref, (t_full / ref - 1) * 100, (lap / ref - 1) * 100);
                        test::check_range((tag + ": not faster than a real GT3 qualifying lap").c_str(), lap / ref, 0.95, 2.0, "x");
                        // the car itself, not the driver: calibrated to the two real laps (data/physics/gt3-lap-references.json, "calibration").
                        // A quasi-steady lap at 100 % is the lap with no transients, so a real lap can sit a few % either side of it.
                        test::check_range((tag + ": quasi-steady lap at 100 % vs a real GT3 qualifying lap (calibrated)").c_str(), t_full / ref, 0.97, 1.06, "x");
                    }
            }
            test::check((tag + ": completes the lap").c_str(), done);
            test::check_range((tag + ": CG inside the track edge (margin)").c_str(), worst, -100, 0.0, "m");
            test::check_range((tag + ": sim lap vs the quasi-steady lap at 100 % of the limits").c_str(), lap / t_full, 0.98, 1.20, "x");
            test::check_range((tag + ": sim lap vs the 92 % profile it drives").c_str(), lap / t_use, 0.97, 1.10, "x");
        }
    }
}

// The game's own AI driver (racing line, skill 0.95) on the same five circuits. Its speed profile must respect what the car can do:
// the lap is completed on the track, not faster than the quasi-steady lap at the car's full limits.
namespace {
struct LapCar {
    std::unique_ptr<Simulation> sim;
    std::unique_ptr<Controls> ctl;
    std::unique_ptr<AIDriver> ai;
    LapCar(const CarConfig& cfg, const Route& r, AIParams p, Vec3 pos, double yaw, double v) {
        sim = test::make_sim(cfg);
        sim->vehicle.assists().abs = sim->vehicle.assists().tc = true;
        sim->reset(pos, yaw, v, 4);
        ctl = std::make_unique<Controls>(sim->vehicle.config());
        ctl->settings.auto_gearbox = true;
        ctl->set_gear(4);
        ai = std::make_unique<AIDriver>(sim->vehicle.config(), r, p);
    }
    void step() {
        AIOutput o = ai->update(sim->body.state, sim->last, {}, sim->dt);
        if (o.gear_request >= 0) ctl->set_gear(o.gear_request);
        sim->step(ctl->update(o.raw, sim->last, sim->dt));
    }
};
}  // namespace

RS_TEST(reference_data_real_tracks_ai) {
    const std::array<std::pair<const char*, const char*>, 5> tracks = {{
        {"Brands Hatch GP", "validation/racetrack-database/BrandsHatch.csv"}, {"Monza", "validation/racetrack-database/Monza.csv"},
        {"Spa-Francorchamps", "validation/tracks-extra/Spa.csv"}, {"Silverstone", "validation/tracks-extra/Silverstone.csv"},
        {"Suzuka", "validation/tracks-extra/Suzuka.csv"}}};
    int clean = 0, total = 0;
    // the Vela GT and the Tornado GT3 (RS_ALL_CARS=1: every shipped car, 125 laps)
    std::vector<CarConfig> cars;
    if (std::getenv("RS_ALL_CARS")) cars = all_cars();
    else for (const char* car_id : {"vela_gt", "tornado_gt3"}) cars.push_back(load_car_config(test::data_path(std::string("cars/") + car_id + ".json")));
    for (const CarConfig& cfg : cars) {
        const double a_lat = sheet::skidpad(cfg), stop = abs_stop_m(cfg, 100 / 3.6);
        const double a_brake = (100 / 3.6) * (100 / 3.6) / (2 * stop) / kGravity, v_top = paper_top_speed(cfg).v_mps;
        for (const auto& [name, rel] : tracks) {
            const Route r = load_tum_track(rel);
            const RacingLine line(r);
            const double t_full = profile_time(qss_profile(r, line, cfg, a_lat, a_brake, v_top, 1.0));
            AIParams p;
            p.racing_line = true;
            const RouteSample s0 = r.at(0);
            LapCar car(cfg, r, p, s0.p, s0.heading, 25);
            car.sim->settle(0.2);
            double travelled = 0, last_s = car.ai->route_s, t_start = -1, worst = -1e9;
            bool done = false, dbg = false;
            while (car.sim->time < 2.6 * t_full + 10) {   // a lap that takes 2.6x the limit is a failed lap
                car.step();
                travelled += r.delta(last_s, car.ai->route_s);
                last_s = car.ai->route_s;
                if (t_start < 0 && travelled > r.length() * 0.25) { t_start = car.sim->time; travelled = 0; }
                if (t_start >= 0) {
                    const Route::Projection pr = r.project(car.sim->body.state.position);
                    const RouteSample sp = r.at(pr.s);
                    worst = std::max(worst, std::abs(pr.lateral) - (pr.lateral >= 0 ? sp.width_left : sp.width_right));
                    if (worst > 30) break;   // lost: 30 m beyond the edge, no point driving on
                    if (std::getenv("RS_DEBUG") && !dbg && worst > 0) {
                        dbg = true;
                        std::printf("           first excursion t %.1f s s %.0f m lat %.1f v %.0f target %.0f km/h ay %.2f g yaw %.2f beta %.1f deg k %.4f kline %.4f\n", car.sim->time, pr.s, pr.lateral,
                                    test::speed(*car.sim) * 3.6, car.ai->target_speed * 3.6, car.sim->accel_body().y / kGravity, car.sim->last.yaw_rate, car.sim->last.sideslip * 57.3, sp.curvature, line.curvature(pr.s));
                    }
                }
                if (t_start >= 0 && travelled >= r.length()) { done = true; break; }
            }
            const double lap = car.sim->time - t_start;
            std::printf("         AI %-12s %-17s sim lap %6.1f s (avg %3.0f km/h) | quasi-steady lap at 100 %% %6.1f s | ratio %.3f | CG vs the edge %.1f m\n", cfg.name.c_str(), name,
                        lap, r.length() / lap * 3.6, t_full, lap / t_full, worst);
            const std::string tag = std::string("AI, ") + name + " / " + cfg.name;
            if (done && worst <= 2.0) {   // within 2 m of the edge: a car's half width and a kerb
                ++clean;
                // when it does stay on the track it cannot beat what the car's limits allow, and it is not absurdly slow
                test::check_range((tag + ": lap vs the quasi-steady lap at 100 % of the limits").c_str(), lap / t_full, 0.98, 1.50, "x");
            }
            ++total;
        }
    }
    // The race AI (racing_line) follows the line with a feed-forward + feedback steering law, steers into a slide with the throttle
    // lifted, and scales its corner speeds by a grip estimate that drops when it slides or runs wide (src/ai.cpp). Before that it was
    // pure pursuit at the tyres' nominal grip: 4-5 of these 10 laps stayed on the track, the rest spun in a hairpin under braking or
    // ran 4-5 m wide at 170-210 km/h. All 10 must now stay within 2 m of the edge (the car's half width and a kerb).
    std::printf("         AI laps completed on the track: %d of %d\n", clean, total);
    test::check_range("AI laps completed on the track (all of them)", clean, total, total, "laps");
}

// ---- aero reference bands, applied to what the simulation actually does --------------------------------------------------------
// tools/physics/aero_check.mjs holds the JSON values of each car against the envelopes of data/physics/aero_reference.json
// (DrivAer wind-tunnel Cd x frontal area for road cars, NACA 0012 cl_max x a 1 m^2 device for downforce, the CFD front-share
// band for covered-wheel road cars). Here the same envelopes are applied to the EFFECTIVE values the Vehicle produces: the drag
// area from the deceleration while coasting, the lift area and the front share from the tyre loads at speed (300 km/h for the
// cars with a small wing so that there is something to measure). A config can pass on paper and still not arrive in the sim.
RS_TEST(reference_data_aero_reference_bands) {
    const auto ref = read_json("physics/aero_reference.json");
    double cd_min = 1e9, cd_max = 0, cl_max_wing = 1.4;
    for (const auto& r : ref.at("references")) {
        if (r.contains("cd") && r.at("cd").is_number()) { cd_min = std::min(cd_min, r.at("cd").get<double>()); cd_max = std::max(cd_max, r.at("cd").get<double>()); }
        if (r.at("id") == "naca0012_wing") cl_max_wing = r.at("cl_max").get<double>();
    }
    const double a_lo = ref.at("assumptions").at("frontal_area_m2").at("low").get<double>(), a_hi = ref.at("assumptions").at("frontal_area_m2").at("high").get<double>();
    const double wing_area = ref.at("assumptions").at("wing_area_m2_for_bound").get<double>();
    const double cda_lo = cd_min * a_lo, cda_hi = cd_max * a_hi, cla_bound = cl_max_wing * wing_area * 1.15;
    const double share_lo = ref.at("balance_reference").at("front_share_range").at(0).get<double>(), share_hi = ref.at("balance_reference").at("front_share_range").at(1).get<double>();
    std::printf("         bands from the data: CdA road %.2f-%.2f m^2 (x0.8..1.2), ClA <= %.2f m^2, CFD front share %.2f-%.2f for road cars\n", cda_lo, cda_hi, cla_bound, share_lo, share_hi);
    int road_in_band = 0, road_n = 0;
    for (const CarConfig& cfg : all_cars()) {
        auto s = test::make_sim(cfg);
        s->settle(1.0);
        double w_static = 0, wf_static = 0;
        for (int i = 0; i < 4; ++i) { w_static += s->last.wheels[i].load; if (i < 2) wf_static += s->last.wheels[i].load; }
        const double v0 = (cfg.aero.lift_area < 0.3 ? 300 : 200) / 3.6;
        s->reset({}, 0, v0, 1);
        DriverInput in;
        in.gear = 1; in.clutch = 1.0; in.throttle = 0;
        double w = 0, wf = 0, a_sum = 0;
        int n = 0;
        for (int k = 0; k < 120; ++k) {
            s->step(in);
            if (k >= 60) {
                double sum = 0, front = 0;
                for (int i = 0; i < 4; ++i) { sum += s->last.wheels[i].load; if (i < 2) front += s->last.wheels[i].load; }
                w += sum; wf += front; a_sum += s->accel_body().x; ++n;
            }
        }
        w /= n; wf /= n; a_sum /= n;
        const double v = test::speed(*s), q = 0.5 * cfg.aero.air_density * v * v;
        const double cda_eff = (-a_sum - 0.011 * kGravity) * cfg.mass / q, cla_eff = (w - w_static) / q;
        const double share = (w - w_static) > 200 ? (wf - wf_static) / (w - w_static) : -1;
        const bool road = cla_eff < 0.3;
        std::printf("         %-22s effective CdA %.3f m^2, ClA %.2f m^2, front share %.2f (%.0f km/h)%s\n", cfg.name.c_str(), cda_eff, cla_eff, share, v * 3.6, road ? "  [road class]" : "");
        test::check_range((cfg.name + ": effective CdA in the 0.30-1.35 envelope").c_str(), cda_eff, 0.30, 1.35, "m^2");
        // race cars also make downforce with the floor, splitter and diffuser: a car named in race_car_downforce_evidence.cars may go up to
        // bound_margin x the largest implied ClA of the published figures listed for it (data/physics/aero_reference.json)
        double cla_bound_car = cla_bound;
        bool has_evidence = false;
        if (ref.contains("race_car_downforce_evidence") && ref.at("race_car_downforce_evidence").at("cars").contains(cfg.name)) {
            const auto ev = ref.at("race_car_downforce_evidence");   // named locals: a range-for over a temporary's member dangles
            const auto ids = ev.at("cars").at(cfg.name);
            double implied = 0;
            for (const auto& id : ids)
                for (const auto& e : ev.at("entries"))
                    if (e.at("id") == id) implied = std::max(implied, e.at("implied_cla_m2").get<double>());
            cla_bound_car = std::max(cla_bound, ev.at("bound_margin").get<double>() * implied);
            has_evidence = true;
        }
        test::check_range((cfg.name + (has_evidence ? ": effective ClA under the published-downforce bound" : ": effective ClA under the NACA wing bound")).c_str(), cla_eff, 0.0, cla_bound_car, "m^2");
        if (road) test::check_range((cfg.name + ": road-class CdA in the DrivAer band x 0.8..1.2").c_str(), cda_eff, cda_lo * 0.8, cda_hi * 1.2, "m^2");
        if (share >= 0) {
            if (!road) test::check_range((cfg.name + ": effective front share in the 0.30-0.60 envelope").c_str(), share, 0.30, 0.60, "");
            else { ++road_n; if (share >= share_lo && share <= share_hi) ++road_in_band; }
        }
    }
    // the three road-class cars whose configured balance (0.50) the JSON check flags against the CFD band: what the sim does with it
    std::printf("         road-class cars whose effective front share lies in the CFD band %.2f-%.2f: %d of %d\n", share_lo, share_hi, road_in_band, road_n);
    test::check("every road-class car with a readable split lands in the CFD front-share band in the simulation", road_n > 0 && road_in_band == road_n);
}

// ---- measured moments of inertia (NHTSA/VRTC, 12 configurations of 1990s SUVs) -----------------------------------------------
// The measured roll and yaw inertias (slug ft^2 -> kg m^2) with the measured mass and CG enter the simulation three ways, and each
// is checked against theory here:
//   1. the rigid body: a torque about the roll or the yaw axis accelerates it at tau / I, and a torque-free body keeps its angular
//      momentum and its kinetic energy (pitch is not published; the value used is a stand-in, and any value must conserve);
//   2. the car on its springs: a roll or a pitch rate given to the resting car rings at the natural frequency sqrt(K / I), K the
//      roll stiffness of the springs and anti-roll bars at the car's own track (pitch: springs at the axle distances);
//   3. the yaw response: the sim's step-steer yaw response of the same car with the measured radius of gyration, against the
//      linear two-degree-of-freedom bicycle model built from the tyres' cornering stiffness at the static axle loads and the same
//      inertia: the time to 90 % of the steady yaw rate and the overshoot.
namespace {
double ft2slug_to_kgm2(double v) { return v * 1.3558179483; }
double lb_to_kg(double v) { return v * 0.45359237; }
}  // namespace

RS_TEST(reference_data_inertia_rigid_body) {
    const auto ref = read_json("physics/inertia-reference.json");
    int n = 0;
    for (const auto& e : ref.at("entries")) {
        if (!e.contains("roll_slugft2") || !e.at("roll_slugft2").is_number() || !e.contains("yaw_slugft2") || !e.at("yaw_slugft2").is_number()) continue;
        const double m = lb_to_kg(e.at("weight_lb").get<double>()), Ixx = ft2slug_to_kgm2(e.at("roll_slugft2").get<double>()), Izz = ft2slug_to_kgm2(e.at("yaw_slugft2").get<double>());
        const double Iyy = 0.5 * (Ixx + Izz) * 1.2;   // not published: a stand-in
        const std::string tag = e.at("vehicle").get<std::string>() + " (" + e.at("configuration").get<std::string>() + ")";
        // 1a. torque about each measured axis
        for (int axis = 0; axis < 3; axis += 2) {
            RigidBody b;
            b.mass = m; b.inertia = {Ixx, Iyy, Izz};
            const double tau = 1500, T = 0.5;   // 120 steps of 1/240 s
            const Vec3 t = axis == 0 ? Vec3{tau, 0, 0} : Vec3{0, 0, tau};
            for (int i = 0; i < 120; ++i) b.integrate({}, t, 1.0 / 240);
            const double w = axis == 0 ? b.state.angular_velocity.x : b.state.angular_velocity.z;
            test::check_range((tag + (axis == 0 ? ": roll" : ": yaw") + " acceleration vs tau / I").c_str(), w / (tau * T / (axis == 0 ? Ixx : Izz)), 0.995, 1.005, "x");
        }
        // 1b. torque-free tumble: angular momentum (world) and kinetic energy kept over 3 s
        RigidBody b;
        b.mass = m; b.inertia = {Ixx, Iyy, Izz};
        b.state.angular_velocity = {1.5, 2.0, 1.0};
        auto L = [&]() { const Vec3 w = b.state.orientation.inv_rotate(b.state.angular_velocity); return b.state.orientation.rotate({Ixx * w.x, Iyy * w.y, Izz * w.z}); };
        auto E = [&]() { const Vec3 w = b.state.orientation.inv_rotate(b.state.angular_velocity); return 0.5 * (Ixx * w.x * w.x + Iyy * w.y * w.y + Izz * w.z * w.z); };
        const Vec3 L0 = L(); const double E0 = E();
        for (int i = 0; i < 720; ++i) b.integrate({}, {}, 1.0 / 240);
        test::check_range((tag + ": angular momentum kept in a torque-free tumble").c_str(), length(L() - L0) / length(L0), 0, 1e-4, "");
        test::check_range((tag + ": kinetic energy kept in a torque-free tumble").c_str(), E() / E0, 0.9999, 1.0001, "x");
        ++n;
    }
    test::check("measured inertia sets found", n >= 8);
}


// ---- yaw response against the linear bicycle model, with the measured yaw inertia --------------------------------------------
namespace {
// the Vela GT with a measured configuration's mass, CG and inertias (springs and dampers scaled with the mass so the ride
// frequencies stay a car's; pitch inertia is not published, its stand-in follows the yaw inertia)
CarConfig measured_body(double mass_kg, double cg_m, double roll, double yaw) {
    CarConfig c = load_car_config(test::data_path("cars/vela_gt.json"));
    const double k = mass_kg / c.mass;
    c.mass = mass_kg; c.cg_height = cg_m;
    c.inertia_xx = roll; c.inertia_zz = yaw; c.inertia_yy = 0.9 * yaw;
    for (AxleParams* a : {&c.front, &c.rear}) {
        a->spring_rate *= k; a->bump_stop_rate *= k; a->damper_bump *= k; a->damper_rebound *= k; a->anti_roll_rate *= k;
    }
    c.brake_torque_total *= k;
    c.finalize();
    return c;
}

struct YawResponse { double t90 = -1, overshoot = 0, r_ss = 0; };

// step steer at 100 km/h from the sim: the steering input steps at t = 2 s; response normalised by its steady state
YawResponse sim_yaw_step(const CarConfig& cfg, double steer) {
    const double v = 100 / 3.6;
    auto s = test::make_sim(cfg);
    s->reset({}, 0, v, sheet::gear_for(cfg, v));
    test::SpeedController sc;
    std::vector<std::pair<double, double>> tr;
    while (s->time < 2.0 + 4.0) {
        DriverInput in;
        in.gear = sheet::gear_for(cfg, v);
        sc.apply(*s, v, in);
        in.steer = s->time >= 2.0 ? steer : 0.0;
        s->step(in);
        if (s->time >= 2.0) tr.emplace_back(s->time - 2.0, s->last.yaw_rate);
    }
    YawResponse y;
    int n = 0;
    for (auto& p : tr) if (p.first > 3.0) { y.r_ss += p.second; ++n; }
    y.r_ss /= std::max(1, n);
    double peak = 0;
    for (auto& p : tr) {
        peak = std::max(peak, std::abs(p.second));
        if (y.t90 < 0 && std::abs(p.second) >= 0.9 * std::abs(y.r_ss)) y.t90 = p.first;
    }
    y.overshoot = peak / std::abs(y.r_ss) - 1.0;
    return y;
}

// the linear two-degree-of-freedom bicycle model (sideslip, yaw rate) with first-order lag of each axle's lateral force
YawResponse bicycle_yaw_step(const CarConfig& c) {
    const double V = 100 / 3.6, m = c.mass, Izz = c.inertia_zz, a = c.dist_cg_front, b = c.dist_cg_rear, L = a + b;
    auto stiff = [&](const TireParams& tp, double fz) {
        const double h = 0.005;
        return std::abs(mf_pure_fy(tp, h, fz, 1.0) - mf_pure_fy(tp, -h, fz, 1.0)) / (2 * h);
    };
    const double fzf = 0.5 * m * kGravity * b / L, fzr = 0.5 * m * kGravity * a / L;
    const double Cf = 2 * stiff(c.tire_front, fzf), Cr = 2 * stiff(c.tire_rear, fzr);
    double sx, sy_f, sy_r;
    relaxation_lengths(c.tire_front, fzf, 0, sx, sy_f);
    relaxation_lengths(c.tire_rear, fzr, 0, sx, sy_r);
    const double tf = std::max(sy_f / V, 1e-3), tr_ = std::max(sy_r / V, 1e-3);
    double beta = 0, r = 0, Ff = 0, Fr = 0;
    const double delta = 0.02, h = 1e-3;
    std::vector<std::pair<double, double>> tr;
    for (double t = 0; t < 4.0; t += h) {
        const double af = delta - beta - a * r / V, ar = -beta + b * r / V;
        const double db = (Ff + Fr) / (m * V) - r, dr = (a * Ff - b * Fr) / Izz;
        const double dFf = (Cf * af - Ff) / tf, dFr = (Cr * ar - Fr) / tr_;
        beta += db * h; r += dr * h; Ff += dFf * h; Fr += dFr * h;
        tr.emplace_back(t + h, r);
    }
    YawResponse y;
    int n = 0;
    for (auto& p : tr) if (p.first > 2.0) { y.r_ss += p.second; ++n; }
    y.r_ss /= std::max(1, n);
    double peak = 0;
    for (auto& p : tr) {
        peak = std::max(peak, std::abs(p.second));
        if (y.t90 < 0 && std::abs(p.second) >= 0.9 * std::abs(y.r_ss)) y.t90 = p.first;
    }
    y.overshoot = peak / std::abs(y.r_ss) - 1.0;
    return y;
}
}  // namespace

// The measured SUV yaw inertias (radius of gyration^2 = Izz / m, 1.7-2.0 m^2 against 1.6 for a GT) go into the same car body and
// the yaw response of the SIM is compared with the bicycle model that uses the same inertia, tyres, loads and geometry: the time to
// 90 % of the steady yaw rate and the overshoot (both normalised, so the steering ratio and the understeer gradient drop out).
RS_TEST(reference_data_inertia_yaw_response) {
    const auto ref = read_json("physics/inertia-reference.json");
    std::vector<std::pair<std::string, CarConfig>> cars;
    std::vector<double> done;
    for (const auto& e : ref.at("entries")) {
        if (!e.contains("roll_slugft2") || !e.at("roll_slugft2").is_number() || !e.contains("yaw_slugft2") || !e.at("yaw_slugft2").is_number()) continue;
        if (e.at("configuration").get<std::string>().find("outrigger") != std::string::npos) continue;
        const double m = lb_to_kg(e.at("weight_lb").get<double>()), yaw = ft2slug_to_kgm2(e.at("yaw_slugft2").get<double>());
        const double k2 = yaw / m;
        if (std::any_of(done.begin(), done.end(), [&](double d) { return std::abs(d - k2) < 0.03; })) continue;
        done.push_back(k2);
        // the measured radius of gyration in the Vela's body: k^2 x its mass
        const CarConfig vela = load_car_config(test::data_path("cars/vela_gt.json"));
        CarConfig c = measured_body(vela.mass, vela.cg_height, ft2slug_to_kgm2(e.at("roll_slugft2").get<double>()) / m * vela.mass, k2 * vela.mass);
        cars.push_back({"Vela body, " + e.at("vehicle").get<std::string>() + " (" + e.at("configuration").get<std::string>() + ") k^2 " + std::to_string(k2).substr(0, 4) + " m^2", c});
    }
    const std::size_t n_measured = cars.size();
    for (const CarConfig& c : all_cars()) cars.push_back({c.name, c});
    // The sim answers the steering step ~25-35 % faster than the bicycle model for EVERY car, whatever its inertia (the linear
    // model has no roll, no steer-induced load shift, no camber thrust): the absolute level is checked loosely. The effect of the
    // measured inertia is checked tightly, as a ratio to the same body at the Vela's own inertia: the sim and the model must
    // slow the response by the same factor.
    const CarConfig vela = load_car_config(test::data_path("cars/vela_gt.json"));
    const YawResponse vs = sim_yaw_step(vela, 0.03), vm = bicycle_yaw_step(vela);
    for (std::size_t i = 0; i < cars.size(); ++i) {
        const auto& [name, cfg] = cars[i];
        const YawResponse sim = sim_yaw_step(cfg, 0.03), mod = bicycle_yaw_step(cfg);
        std::printf("         %-84s yaw 90 %% time: sim %.3f s, bicycle %.3f s | overshoot: sim %4.1f %%, bicycle %4.1f %%\n", name.c_str(), sim.t90, mod.t90, sim.overshoot * 100, mod.overshoot * 100);
        test::check_range((name + ": yaw 90 % time vs the bicycle model").c_str(), mod.t90 > 0 ? sim.t90 / mod.t90 : 0, 0.55, 1.40, "x");
        test::check_range((name + ": yaw overshoot vs the bicycle model").c_str(), sim.overshoot - mod.overshoot, -0.12, 0.12, "");
        if (i < n_measured) {
            const double ratio_sim = sim.t90 / vs.t90, ratio_mod = mod.t90 / vm.t90;
            std::printf("           measured inertia slows the yaw response by x%.3f in the sim and x%.3f in the model\n", ratio_sim, ratio_mod);
            test::check_range((name + ": the slow-down the measured yaw inertia causes, sim vs model").c_str(), ratio_sim / ratio_mod, 0.85, 1.15, "x");
        }
    }
}

// ---- every other full-throttle engine map in Project Chrono's vehicle data ----------------------------------------------------
// data/reference/chrono-vehicles/summary.json digests the 546 verbatim files imported by tools/physics/import_chrono_vehicles.mjs.
// Its simple-map engines (a rally-class V8 of 310 kW, a van, a UTV, a 4x4 diesel, the HMMWV, the M113's tracked-vehicle diesel...)
// go through the same dyno pull as the four above; the maps already tested and the copies of them (ACV, MAN) are skipped, and the
// Marder's, whose map is written in rad/s, is left out and flagged by the checker.
RS_TEST(reference_data_chrono_engine_maps_all) {
    const auto sum = read_json("reference/chrono-vehicles/summary.json");
    const auto done = read_json("powertrain/reference-powertrains.json");
    std::vector<std::pair<double, double>> seen;   // (peak torque, max rpm) of the maps already run
    for (const auto& e : done.at("entries")) seen.push_back({e.at("engine").at("peak_torque_nm").get<double>(), e.at("engine").at("redline_rpm").get<double>()});
    int n = 0;
    for (const auto& e : sum.at("engines")) {
        if (e.at("kind").get<std::string>() != "simple_map" || e.at("units_rad_s").get<bool>()) continue;
        const double pt = e.at("peak_torque_nm").get<double>(), mr = e.at("max_rpm").get<double>();
        if (std::any_of(seen.begin(), seen.end(), [&](const auto& s) { return std::abs(s.first - pt) < 1.0 && std::abs(s.second - mr) < 1.0; })) continue;
        seen.push_back({pt, mr});
        std::vector<std::array<double, 2>> pts;
        for (const auto& p : e.at("curve_rpm_nm")) pts.push_back({p.at(0).get<double>(), p.at(1).get<double>()});
        double pk = 0;
        for (const auto& p : pts) pk = std::max(pk, p[0] * 2 * kPi / 60 * p[1]);
        const std::string id = e.at("id").get<std::string>();
        test::check_range((id + ": listed peak power vs its own curve").c_str(), e.at("peak_power_kw").get<double>() * 1000 / pk, 0.99, 1.01, "x");
        const PullResult r = tall_gear_pull(pts, 800, mr, 4, pk);
        std::printf("         %-34s map peak %.0f Nm at %.0f rpm / %.0f kW | body x%.1f | dyno: %d bins, mean est/map %.3f, worst %.1f %%\n", id.c_str(), r.t_peak, r.t_rpm, pk / 1000, r.scale, r.covered, r.mean, r.worst * 100);
        test::check_range((id + ": rpm bins the pull covered").c_str(), r.covered, 4, 80, "bins");
        test::check_range((id + ": mean crank-torque estimate vs the map").c_str(), r.mean, 0.95, 1.07, "x");
        test::check_range((id + ": worst bin vs the map").c_str(), r.worst, 0, 0.12, "");
        ++n;
    }
    test::check("at least five further Chrono engine maps were run", n >= 5);
}

// ---- complete Project Chrono vehicles, converted to our schema and driven by the core --------------------------------------------
// tools/physics/chrono_to_cars.mjs turns Chrono's Audi, HMMWV and Nissan Patrol (both axles double wishbone) into cars: chassis mass,
// inertia and CG with the wheels and suspension parts added, axle positions and tracks, the double-wishbone hardpoints, spring and
// damper rates at the wheel (rate x motion ratio^2 measured on the hardpoints), brake torques, steering lock, engine map, gear
// ratios, final drive, driven axles and the Magic Formula tyre. That exercises the suspension, brake, wheel, steering, driveline,
// powertrain, tyre, chassis and assembly files of Chrono together, and the sim is held against theory and against what Chrono states:
//   static ride and weight distribution; the heave natural period from the spring and damper rates; the braking deceleration from the
//   brake torque (the Audi's brakes limit it, not its tyres); the tilt-table lift angle from the converted track and CG; the minimum
//   turning radius at full lock against the one Chrono's vehicle file states; the 0-100 km/h time against the power-limited bound.
namespace {
std::vector<std::string> chrono_car_ids() { return {"chrono_audi", "chrono_hmmwv", "chrono_patrol"}; }

double heave_period_model(const CarConfig& c) {
    const double k = 2 * (c.front.spring_rate + c.rear.spring_rate);
    const double cf = 0.5 * (c.front.damper_bump + c.front.damper_rebound), cr = 0.5 * (c.rear.damper_bump + c.rear.damper_rebound);
    const double cc = 2 * (cf + cr);
    const double wn = std::sqrt(k / c.mass), zeta = cc / (2 * std::sqrt(k * c.mass));
    if (zeta >= 1) return -1;
    return 2 * kPi / (wn * std::sqrt(1 - zeta * zeta));
}
double heave_period_sim(const CarConfig& cfg) {
    auto s = test::make_sim(cfg);
    s->settle(1.5);
    const double z0 = s->body.state.position.z;
    s->body.state.velocity.z = 0.10;
    const double t0 = s->time;
    double prev = 0, t_prev = 0;
    bool up = false;
    DriverInput in; in.gear = 1; in.clutch = 1.0;
    for (int i = 0; i < 3 * 240; ++i) {
        s->step(in);
        const double x = s->body.state.position.z - z0, t = s->time - t0;
        if (x > 1e-5) up = true;
        if (up && prev > 0 && x <= 0) return 2 * (t_prev + (t - t_prev) * prev / (prev - x));
        prev = x; t_prev = t;
    }
    return -1;
}
}  // namespace

RS_TEST(reference_data_chrono_vehicles) {
    std::vector<std::pair<std::string, CarConfig>> cars;
    for (const auto& id : chrono_car_ids()) cars.push_back({id, load_car_config(test::data_path("reference/chrono-vehicles/cars/" + id + ".json"))});
    const std::map<std::string, std::string> vehicle_json = {{"chrono_audi", "audi/json/audi_Vehicle.json"}, {"chrono_hmmwv", "hmmwv/vehicle/HMMWV_Vehicle_4WD.json"}, {"chrono_patrol", "Nissan_Patrol/json/suv_Vehicle.json"}};
    for (const auto& [id, cfg] : cars) {
        std::printf("         --- %s: %.0f kg, CG %.3f m, wheelbase %.3f m, track %.3f / %.3f m, wheel rate %.0f / %.0f N/m, damper %.0f / %.0f N s/m, brakes %.0f N m\n", id.c_str(),
                    cfg.mass, cfg.cg_height, cfg.wheelbase, cfg.front.track, cfg.rear.track, cfg.front.spring_rate, cfg.rear.spring_rate, cfg.front.damper_bump, cfg.rear.damper_bump, cfg.brake_torque_total);
        // 1. static ride and weight distribution
        {
            auto s = test::make_sim(cfg);
            s->settle(2.0);
            double w = 0, wf = 0;
            for (int i = 0; i < 4; ++i) { w += s->last.wheels[i].load; if (i < 2) wf += s->last.wheels[i].load; }
            test::check_range((id + ": settles at its CG height").c_str(), s->body.state.position.z / cfg.cg_height, 0.97, 1.03, "x");
            test::check_range((id + ": tyre loads sum to the weight").c_str(), w / (cfg.mass * kGravity), 0.995, 1.005, "x");
            test::check_range((id + ": front share of the load vs the converted weight distribution").c_str(), wf / w - cfg.weight_front, -0.01, 0.01, "");
        }
        // 1b. our kinematics solver's motion ratio against the lever calculation made on the same hardpoints in the converter
        {
            std::ifstream f(test::data_path("reference/chrono-vehicles/cars/" + id + ".json"));
            const auto cj = nlohmann::json::parse(f);
            for (int a = 0; a < 2; ++a) {
                const double mr_solver = cfg.axle_kinematics[a]->sample_left(0.0, 0.0).motion_ratio, mr_lever = cj.at("reference").at("motion_ratio_from_hardpoints").at(a).get<double>();
                std::printf("         motion ratio axle %d: solver %.3f, lever calculation %.3f\n", a, mr_solver, mr_lever);
                test::check_range((id + ": kinematics solver motion ratio vs the lever calculation").c_str(), mr_solver / mr_lever, 0.88, 1.12, "x");
            }
            const auto kf = cfg.axle_kinematics[0]->sample_left(0.03, 0.0), kb = cfg.axle_kinematics[0]->sample_left(-0.03, 0.0);
            std::printf("         front bump steer %.1f deg/m from Chrono's tie-rod hardpoints (a road car: under ~2)\n", (kf.toe_rad - kb.toe_rad) / 0.06 * 57.3);
        }
        // 2. heave period from the spring and damper rates
        {
            const double mod = heave_period_model(cfg), sim = heave_period_sim(cfg);
            std::printf("         heave period: sim %.3f s, model %.3f s (ride frequency %.2f Hz)\n", sim, mod, 1 / std::max(mod, 1e-3));
            if (mod > 0 && sim > 0) test::check_range((id + ": heave period vs the spring and damper rates").c_str(), sim / mod, 0.88, 1.12, "x");
            else test::check((id + ": heave rings or is critically damped as the model says").c_str(), (mod < 0) == (sim < 0));
        }
        // 3. braking: the brake torque limits the deceleration when it is lower than the tyres' grip
        {
            auto s = test::make_sim(cfg);
            s->vehicle.assists().abs = false;
            s->reset({}, 0, 100 / 3.6, 4);
            s->settle(0.3);
            s->body.state.velocity = {100 / 3.6, 0, 0};
            double t90 = -1, t30 = -1, x90 = 0, x30 = 0;
            Vec3 p0 = s->body.state.position;
            while (test::speed(*s) > 1.0 && s->time < 30) {
                DriverInput in; in.gear = 4; in.clutch = 1.0; in.brake = 1.0;
                s->step(in);
                const double v = test::speed(*s) * 3.6;
                if (t90 < 0 && v <= 90) { t90 = s->time; x90 = length(s->body.state.position - p0); }
                if (t30 < 0 && v <= 30) { t30 = s->time; x30 = length(s->body.state.position - p0); }
            }
            const double a_sim = ((90 - 30) / 3.6) / (t30 - t90);
            const double r = cfg.tire_rear.radius, a_torque = cfg.brake_torque_total / (r * cfg.mass);
            const double a_grip = std::min(cfg.tire_front.mu_x, cfg.tire_rear.mu_x) * kGravity;
            std::printf("         braking 90-30 km/h: sim %.2f m/s^2 | brake torque allows %.2f, tyre grip allows %.2f\n", a_sim, a_torque, a_grip);
            test::check_range((id + ": braking never exceeds what the brake torque or the grip allows").c_str(), a_sim / std::min(a_torque, a_grip), 0.0, 1.03, "x");
            if (a_torque < 0.8 * a_grip) test::check_range((id + ": brake-torque-limited deceleration vs total torque / (r m)").c_str(), a_sim / a_torque, 0.88, 1.03, "x");
            (void)x90; (void)x30;
        }
        // 4. tilt table with the converted track and CG
        {
            const double t = 0.5 * (cfg.front.track + cfg.rear.track), ssf = t / (2 * cfg.cg_height);
            const double phi = tilt_lift_angle(cfg), ratio = phi > 0 ? std::tan(phi) / ssf : 0;
            std::printf("         tilt table: SSF %.2f, lifts at %.1f deg = %.2f x SSF\n", ssf, phi * 180 / kPi, ratio);
            test::check_range((id + ": tilt-table lift vs track / 2H").c_str(), ratio, 0.85, 1.0, "x");
        }
        // 5. minimum turning radius at full lock against the radius Chrono's vehicle file states
        {
            auto s = test::make_sim(cfg);
            s->reset({}, 0, 3.0, 2);
            test::SpeedController sc;
            double r_sum = 0; int n = 0;
            while (s->time < 12.0) {
                DriverInput in; in.gear = 2; in.steer = 1.0;
                sc.apply(*s, 3.0, in);
                s->step(in);
                if (s->time > 6.0 && std::abs(s->last.yaw_rate) > 0.05) { r_sum += test::speed(*s) / std::abs(s->last.yaw_rate); ++n; }
            }
            const double r_cg = n ? r_sum / n : 0, b = cfg.dist_cg_rear, L = cfg.wheelbase;
            const double r_rear = std::sqrt(std::max(0.0, r_cg * r_cg - b * b)), r_outer = std::sqrt((r_rear + cfg.front.track / 2) * (r_rear + cfg.front.track / 2) + L * L);
            double stated = 0;
            try {
                std::ifstream f(test::data_path("reference/chrono-vehicles/" + vehicle_json.at(id)));
                const auto vj = nlohmann::json::parse(f, nullptr, true, true);
                if (vj.contains("Minimum Turning Radius")) stated = vj.at("Minimum Turning Radius").get<double>();
            } catch (...) {}
            std::printf("         full lock: CG circle %.2f m, outer front wheel %.2f m | Chrono's stated minimum turning radius %.2f m\n", r_cg, r_outer, stated);
            test::check_range((id + ": full-lock circle exists").c_str(), r_cg, 3.0, 30.0, "m");
            if (stated > 0) test::check_range((id + ": outer-wheel turning radius vs Chrono's stated minimum").c_str(), r_outer / stated, 0.80, 1.20, "x");
        }
        // 6. 0-100 km/h against the power-limited bound
        {
            sheet::Sheet sh;
            sheet::launch(cfg, sh);
            double p = 0;
            for (const auto& pt : cfg.engine.torque_curve) p = std::max(p, pt[1] * pt[0] * 2 * kPi / 60);
            p *= cfg.drivetrain.efficiency;
            const double v = 100 / 3.6, t_min = 0.5 * cfg.mass * v * v / p;
            std::printf("         0-100 km/h: sim %.2f s | power-limited bound %.2f s (%.0f kW)\n", sh.t100, t_min, p / 1000);
            test::check_range((id + ": 0-100 km/h is not faster than the power allows").c_str(), sh.t100 / t_min, 1.0, 4.0, "x");
        }
        // 7. yaw response against the bicycle model. Chrono's tie-rod hardpoints give these cars a large bump / roll steer that the
        //    bicycle model does not have: the same car with the Vela's hardpoints (everything else Chrono's) must follow the model.
        {
            const YawResponse sim = sim_yaw_step(cfg, 0.03), mod = bicycle_yaw_step(cfg);
            std::printf("         yaw 90 %% time, Chrono hardpoints: sim %.3f s, bicycle %.3f s | overshoot sim %.1f %%, bicycle %.1f %% | steady yaw rate sim %.3f rad/s at %.2f deg, bicycle %.3f rad/s at %.2f deg\n", sim.t90, mod.t90, sim.overshoot * 100, mod.overshoot * 100,
                        sim.r_ss, 0.03 * cfg.front.max_steer_deg, mod.r_ss, 0.02 * 57.3);
            std::ifstream f(test::data_path("reference/chrono-vehicles/cars/" + id + ".json"));
            auto cj = nlohmann::json::parse(f);
            std::ifstream fv(test::data_path("cars/vela_gt.json"));
            const auto vj = nlohmann::json::parse(fv);
            for (const char* ax : {"front_axle", "rear_axle"}) {
                cj[ax]["kinematics"] = vj[ax]["kinematics"];
                for (const char* k : {"static_toe_deg", "bump_steer_deg_per_m", "static_camber_deg", "camber_gain_deg_per_m", "camber_gain2_deg_per_m2", "caster_deg", "kpi_deg"})
                    if (vj[ax].contains(k)) cj[ax][k] = vj[ax][k];
            }
            const CarConfig tame = parse_car_config(cj.dump());
            const YawResponse st = sim_yaw_step(tame, 0.03), mt = bicycle_yaw_step(tame);
            std::printf("         yaw 90 %% time, Vela hardpoints:    sim %.3f s, bicycle %.3f s | overshoot sim %.1f %%, bicycle %.1f %%\n", st.t90, mt.t90, st.overshoot * 100, mt.overshoot * 100);
            // the HMMWV (CG 0.67 m, 2.6 t, soft big tyres) rolls and loads its tyres unevenly in a way a bicycle model has no place for:
            // its band is wider (sim 0.44 x the model) and says so
            test::check_range((id + ": yaw 90 % time vs the bicycle model, neutral hardpoints").c_str(), mt.t90 > 0 ? st.t90 / mt.t90 : 0, id == "chrono_hmmwv" ? 0.40 : 0.55, 1.20, "x");
        }
    }
}

// ---- the nine NHTSA NCAP 2020 cars with all their measured geometry -----------------------------------------------------------
// data/physics/inertia-reference.json "modernEntries": mass, track, wheelbase, CG height and the published static stability factor of
// the WRX, Stinger, CT5, S60, Mazda 3, Sonata, Sentra, CX-30 and XC90. Each becomes a Vela-bodied car with that mass (springs and
// dampers scaled with it), track (the hardpoints' lateral coordinates scaled with it), wheelbase and CG height, and goes on the sim's
// tilt table: the high side must lift at 0.85-1.0 x the SSF NHTSA PUBLISHED for that car (not our own formula).
RS_TEST(reference_data_nhtsa_modern_cars) {
    const auto ref = read_json("physics/inertia-reference.json");
    std::ifstream fv(test::data_path("cars/vela_gt.json"));
    const auto vj = nlohmann::json::parse(fv);
    int n = 0;
    for (const auto& e : ref.at("modernEntries")) {
        const double m = lb_to_kg(e.at("weight_lb").get<double>()), track = e.at("track_in").get<double>() * 0.0254, wb = e.at("wheelbase_in").get<double>() * 0.0254, cg = e.at("cg_in").get<double>() * 0.0254, ssf = e.at("ssf").get<double>();
        auto j = vj;
        const double km = m / vj["chassis"]["mass_kg"].get<double>();
        j["chassis"]["mass_kg"] = m; j["chassis"]["cg_height_m"] = cg; j["chassis"]["wheelbase_m"] = wb;
        for (const char* k : {"inertia_roll_kgm2", "inertia_pitch_kgm2", "inertia_yaw_kgm2"}) j["chassis"][k] = vj["chassis"][k].get<double>() * km;
        for (const char* ax : {"front_axle", "rear_axle"}) {
            const double kt = track / vj[ax]["track_m"].get<double>();
            j[ax]["track_m"] = track;
            for (const char* k : {"spring_rate_n_per_m", "bump_stop_rate_n_per_m", "damper_bump_ns_per_m", "damper_rebound_ns_per_m", "anti_roll_rate_n_per_m"}) j[ax][k] = vj[ax][k].get<double>() * km;
            for (auto& [name, pt] : j[ax]["kinematics"].items()) if (pt.is_array() && pt.size() == 3) pt[1] = pt[1].get<double>() * kt;
        }
        j["brakes"]["max_total_torque_nm"] = vj["brakes"]["max_total_torque_nm"].get<double>() * km;
        const CarConfig cfg = parse_car_config(j.dump());
        const double phi = tilt_lift_angle(cfg), ratio = phi > 0 ? std::tan(phi) / ssf : 0;
        std::printf("         %-22s %.0f kg, track %.3f m, wheelbase %.3f m, CG %.3f m | NHTSA SSF %.2f | the sim lifts at %.1f deg: tan = %.2f = %.2f x the published SSF\n", e.at("vehicle").get<std::string>().c_str(), m, track, wb, cg, ssf, phi * 180 / kPi, std::tan(phi), ratio);
        test::check_range((e.at("vehicle").get<std::string>() + ": tilt-table lift vs the published SSF").c_str(), ratio, 0.85, 1.0, "x");
        ++n;
    }
    test::check("nine modern NHTSA cars were run", n == 9);
}

// ---- clutch capacity against engine torque ---------------------------------------------------------------------------------------
// Found by the real-circuit laps: the Kronos Fulmine V10 (clutch capacity 1.10 x its peak torque) slipped until it was a third slower
// than its own limits on a Monza lap (7th gear at 70 km/h with the engine on the limiter): with almost no margin a hot, slightly
// faded clutch cannot hold full torque. Its capacity is now 1.30 x; no car may be below 1.25 x.
RS_TEST(reference_data_clutch_margin) {
    for (const CarConfig& cfg : all_cars()) {
        double t = 0;
        for (const auto& p : cfg.engine.torque_curve) t = std::max(t, p[1]);
        test::check_range((cfg.name + ": clutch capacity over peak engine torque").c_str(), cfg.drivetrain.clutch_max_torque / t, 1.25, 3.0, "x");
    }
}

// ---- pitch inertia: unpublished, so what does the unknown cost? -------------------------------------------------------------------
// No open source gives the pitch inertia of a car (NHTSA lists roll and yaw). Instead of inventing a value this measures how much the
// number can matter: the Vela GT, Tornado GT3 and Mistra 200T with their pitch inertia scaled by 0.75 and 1.25 (the spread of real cars around the
// value used): the ABS stop from 100 km/h, the 0-100 km/h time and the 60-0 mph stop must move by under 2 %; at 0.5x and 2x (far
// beyond any real car) by under 4 % - the slick-and-wing GT3 is the most sensitive (1.5 % and 3.2 % for the 60-0 mph stop after its
// 2026-11-25 calibration, which brakes at 1.85 g and carries twice the downforce), through its pitch-dependent aero balance.
RS_TEST(reference_data_pitch_inertia_sensitivity) {
    for (const char* id : {"vela_gt", "tornado_gt3", "mistra_200t"}) {
        const CarConfig base = load_car_config(test::data_path(std::string("cars/") + id + ".json"));
        auto measure = [&](double k) {
            CarConfig c = base;
            c.inertia_yy *= k;
            sheet::Sheet sh;
            sheet::launch(c, sh);
            return std::array<double, 3>{abs_stop_m(c, 100 / 3.6), sh.t100, sheet::brake_60(c)};
        };
        const auto m0 = measure(1.0), lo = measure(0.75), hi = measure(1.25), xlo = measure(0.5), xhi = measure(2.0);
        const char* what[3] = {"ABS 100-0 km/h stop", "0-100 km/h time", "60-0 mph stop"};
        for (int i = 0; i < 3; ++i) {
            const double d = std::max(std::abs(lo[i] / m0[i] - 1), std::abs(hi[i] / m0[i] - 1));
            const double dx = std::max(std::abs(xlo[i] / m0[i] - 1), std::abs(xhi[i] / m0[i] - 1));
            std::printf("         %-12s %-20s %.2f | pitch inertia x0.75 %.2f, x1.25 %.2f (change %.2f %%) | x0.5 %.2f, x2 %.2f (change %.2f %%)\n", base.name.c_str(), what[i], m0[i], lo[i], hi[i], d * 100, xlo[i], xhi[i], dx * 100);
            test::check_range((base.name + ": " + what[i] + " vs a +-25 % pitch inertia").c_str(), d, 0, 0.020, "");
            test::check_range((base.name + ": " + what[i] + " vs 0.5x / 2x (bounded)").c_str(), dx, 0, 0.04, "");
        }
    }
}
