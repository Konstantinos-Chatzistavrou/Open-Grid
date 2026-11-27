// Apache-2.0 - rs_conformance: the REFERENCE ADAPTER of the OpenGrid conformance suite (conformance/README.md). It implements the file interface the suite defines, for this repository's own core:
//
//   rs_conformance tyre <tyre.tir> <cases.csv> <out.csv>      evaluate every case with rs::mf62 and write MFeval's 30 output columns
//   rs_conformance vehicle <car.json> <outdir>                 run the standard manoeuvres on a car and write spec.json + the logs conformance/run.mjs judges
//   rs_conformance tyre-summary <tyre.tir> <cases.csv>         JSON facts about a tyre file (geometry, peak grip, cornering stiffness, finite cases): the tyre registry's numbers
//
// A different simulation implements the same two interfaces in its own language (conformance/SPEC.md) and is judged by the same runner, with no dependency on this code.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include "harness.hpp"
#include "measure.hpp"
#include "rs/config.hpp"
#include "rs/mf62.hpp"
#include "rs/tire.hpp"

namespace {
using namespace rs;

bool slurp(const std::string& path, std::string& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::stringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

int tyre_cmd(const std::string& tir, const std::string& cases, const std::string& out) {
    std::string text, err, ctext;
    mf62::Params p;
    if (!slurp(tir, text) || !mf62::parse_tir(text, p, err)) { std::fprintf(stderr, "tyre %s: %s\n", tir.c_str(), err.c_str()); return 1; }
    if (!slurp(cases, ctext)) { std::fprintf(stderr, "cannot read %s\n", cases.c_str()); return 1; }
    std::ofstream o(out, std::ios::binary);
    o << "Fx,Fy,Fz,Mx,My,Mz,kappa,alpha,gamma,phit,Vx,P,Re,rho,two_a,t,mux,muy,omega,Rl,two_b,Mzr,Cx,Cy,Cz,Kya,sigmax,sigmay,instKya,Kxk\n";
    std::istringstream in(ctext);
    std::string line;
    std::getline(in, line);  // header: fz_rel,kappa,alpha,gamma,phit,vx_rel,p_rel,usemode
    int rows = 0;
    while (std::getline(in, line)) {
        if (line.empty()) continue;
        double c[8];
        if (std::sscanf(line.c_str(), "%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf", &c[0], &c[1], &c[2], &c[3], &c[4], &c[5], &c[6], &c[7]) != 8) { std::fprintf(stderr, "bad case row: %s\n", line.c_str()); return 1; }
        mf62::Input i;
        i.fz = c[0] * p.fnomin; i.kappa = c[1]; i.alpha = c[2]; i.gamma = c[3]; i.phit = c[4]; i.vx = c[5] * p.longvl; i.pressure = c[6] * p.nompres;
        const mf62::Output r = mf62::evaluate(p, i, mf62::modes_from_use_mode(static_cast<int>(c[7])));
        const double v[30] = {r.fx, r.fy, r.fz, r.mx, r.my, r.mz, r.kappa, r.alpha, r.gamma, r.phit, r.vx, r.pressure, r.re, r.rho, r.two_a, r.t, r.mux, r.muy, r.omega, r.rl, r.two_b, r.mzr,
                              r.cx, r.cy, r.cz, r.kya, r.sigmax, r.sigmay, 0.0, r.kxk};
        for (int k = 0; k < 30; ++k) {
            char buf[40];
            std::snprintf(buf, sizeof buf, "%.17g", v[k]);
            o << (k ? "," : "") << buf;
        }
        o << "\n";
        ++rows;
    }
    std::printf("wrote %d rows to %s\n", rows, out.c_str());
    return 0;
}

// rs_conformance tyre-summary <tyre.tir> <cases.csv>: JSON facts about a tyre file, computed by rs::mf62 (the registry page shows these, not claims): geometry, peak grip and cornering stiffness at the
// nominal load (slips swept with the file's limits off), and how many of the conformance cases give finite Fx, Fy and Mz.
int tyre_summary_cmd(const std::string& tir, const std::string& cases) {
    std::string text, err, ctext;
    mf62::Params p;
    if (!slurp(tir, text) || !mf62::parse_tir(text, p, err)) { std::printf("{\"ok\":false,\"error\":\"%s\"}\n", err.empty() ? "cannot read the file" : err.c_str()); return 1; }
    const mf62::Modes free_modes = mf62::modes_from_use_mode(211);
    auto at = [&](double kappa, double alpha, double fz) {
        mf62::Input in;
        in.fz = fz; in.kappa = kappa; in.alpha = alpha; in.vx = p.longvl;
        return mf62::evaluate(p, in, free_modes);
    };
    double mux = 0, muy = 0;
    int arg_x = 0, arg_y = 0;
    for (int i = 1; i <= 500; ++i) {   // slip ratio up to 1.0 and slip angle up to 1.0 rad
        const double fx = std::abs(at(i * 0.002, 0.0, p.fnomin).fx) / p.fnomin, fy = std::abs(at(0.0, i * 0.002, p.fnomin).fy) / p.fnomin;
        if (fx > mux) { mux = fx; arg_x = i; }
        if (fy > muy) { muy = fy; arg_y = i; }
    }
    const bool interior = arg_x < 490 && arg_y < 490;   // false: the peak is at the end of the sweep, so the number is a lower bound
    const double da = 0.002, kya = std::abs(at(0.0, da, p.fnomin).fy - at(0.0, -da, p.fnomin).fy) / (2 * da);
    int total = 0, finite = 0;
    if (slurp(cases, ctext)) {
        std::istringstream in(ctext);
        std::string line;
        std::getline(in, line);
        while (std::getline(in, line)) {
            double c[8];
            if (line.empty() || std::sscanf(line.c_str(), "%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf", &c[0], &c[1], &c[2], &c[3], &c[4], &c[5], &c[6], &c[7]) != 8) continue;
            mf62::Input i;
            i.fz = c[0] * p.fnomin; i.kappa = c[1]; i.alpha = c[2]; i.gamma = c[3]; i.phit = c[4]; i.vx = c[5] * p.longvl; i.pressure = c[6] * p.nompres;
            const mf62::Output o = mf62::evaluate(p, i, mf62::modes_from_use_mode(static_cast<int>(c[7])));
            ++total;
            if (std::isfinite(o.fx) && std::isfinite(o.fy) && std::isfinite(o.mz)) ++finite;
        }
    }
    std::printf("{\"ok\":true,\"fittyp\":%d,\"fnomin_n\":%.6g,\"unloaded_radius_m\":%.6g,\"width_m\":%.6g,\"aspect_ratio\":%.6g,\"rim_radius_m\":%.6g,\"nompres_pa\":%.6g,\"peak_mu_x\":%.4f,\"peak_mu_y\":%.4f,"
                "\"cornering_stiffness_n_per_rad\":%.1f,\"peak_inside_sweep\":%s,\"cases_total\":%d,\"cases_finite\":%d}\n",
                p.fittyp, p.fnomin, p.unloaded_radius, p.width, p.aspect_ratio, p.rim_radius, p.nompres, mux, muy, kya, interior ? "true" : "false", total, finite);
    return 0;
}

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

struct Log {
    std::ofstream f;
    Log(const std::string& path) : f(path) { f << "t,x,y,speed,ax,ay,yaw_rate,steer_deg,fz_fl,fz_fr,fz_rl,fz_rr\n"; }
    void row(const Simulation& s, double steer_deg) {
        const Vec3 a = s.accel_body();
        char buf[400];
        std::snprintf(buf, sizeof buf, "%.5f,%.5f,%.5f,%.6f,%.5f,%.5f,%.6f,%.5f,%.2f,%.2f,%.2f,%.2f\n", s.time, s.body.state.position.x, s.body.state.position.y, length(s.body.state.velocity), a.x, a.y, s.last.yaw_rate, steer_deg,
                      s.last.wheels[0].load, s.last.wheels[1].load, s.last.wheels[2].load, s.last.wheels[3].load);
        f << buf;
    }
};

double steer_circle_cw(const Simulation& s, Vec3 c, double R, double lookahead) {  // pure pursuit on a clockwise circle (the mirror of test::steer_circle)
    const ChassisState& st = s.body.state;
    const double th = std::atan2(st.position.y - c.y, st.position.x - c.x) - lookahead / R;
    const Vec3 target{c.x + R * std::cos(th), c.y + R * std::sin(th), st.position.z};
    const Vec3 local = st.orientation.inv_rotate(target - st.position);
    const double eta = std::atan2(local.y, local.x);
    const double L = s.vehicle.config().wheelbase;
    const double delta = std::atan(2.0 * L * std::sin(eta) / lookahead);
    return clamp(delta / (s.vehicle.config().front.max_steer_deg * kPi / 180.0), -1.0, 1.0);
}

void log_static(const CarConfig& cfg, const std::string& path) {
    auto s = test::make_sim(cfg);
    s->settle(1.0);
    Log log(path);
    double next = 0;
    while (s->time < 3.0) {
        DriverInput in;
        in.gear = 1;     // neutral
        in.clutch = 1.0;
        in.brake = 0.3;  // held on the brakes
        s->step(in);
        if (s->time >= next) { log.row(*s, 0.0); next += 0.01; }
    }
}

void log_coast(const CarConfig& cfg, const std::string& path, double v0) {
    auto s = test::make_sim(cfg);
    s->reset({}, 0, v0, 1);
    Log log(path);
    double next = 0;
    while (s->time < 90.0 && test::speed(*s) > 8.0) {
        DriverInput in;
        in.gear = 1;  // neutral, clutch in, no throttle, no brake: only drag and rolling resistance act
        in.clutch = 1.0;
        s->step(in);
        if (s->time >= next) { log.row(*s, 0.0); next += 0.05; }
    }
}

void log_brake(const CarConfig& cfg, const std::string& path, double v0, double dt) {
    auto s = test::make_sim(cfg, dt);
    s->vehicle.assists().abs = true;
    s->reset({}, 0, v0, 4);
    s->settle(0.3);
    s->body.state.velocity = {v0, 0, 0};
    const Vec3 p0 = s->body.state.position;
    (void)p0;
    Log log(path);
    double next = 0;
    const double t0 = s->time;
    while (test::speed(*s) > 0.05 && s->time - t0 < 30.0) {
        DriverInput in;
        in.gear = 4;
        in.brake = 1.0;
        in.clutch = 1.0;
        s->step(in);
        if (s->time - t0 >= next) { log.row(*s, 0.0); next += 0.01; }
    }
}

void log_launch(const CarConfig& cfg, const std::string& path) {
    auto s = test::make_sim(cfg);
    s->settle(1.0);
    test::LaunchDriver drv;
    drv.shift_time = 0.35;
    Log log(path);
    double next = 0;
    const double t0 = s->time;
    while (s->time - t0 < 40.0 && test::speed(*s) < 140.0 / 3.6) {
        DriverInput in;
        drv.apply(*s, in);
        s->step(in);
        if (s->time - t0 >= next) { log.row(*s, 0.0); next += 0.02; }
    }
}

void log_circle(const CarConfig& cfg, const std::string& path, bool left, double R, double v) {
    auto s = test::make_sim(cfg);
    s->reset({}, 0, v, 3);
    test::SpeedController sc;
    Log log(path);
    double next = 0;
    const double max_steer = cfg.front.max_steer_deg;
    while (s->time < 30.0) {
        DriverInput in;
        in.gear = 3;
        in.steer = left ? test::steer_circle(*s, {0, R, 0}, R, 10.0) : steer_circle_cw(*s, {0, -R, 0}, R, 10.0);
        sc.apply(*s, v, in);
        s->step(in);
        if (s->time >= next) { log.row(*s, in.steer * max_steer); next += 0.02; }
    }
}

int vehicle_cmd(const std::string& car, const std::string& dir) {
    CarConfig cfg;
    try { cfg = load_car_config(car); } catch (const std::exception& e) { std::fprintf(stderr, "%s\n", e.what()); return 1; }
    double p_peak = 0;
    for (const auto& pt : cfg.engine.torque_curve) p_peak = std::max(p_peak, pt[1] * pt[0] * 2.0 * kPi / 60.0);
    const double m = cfg.mass, g = kGravity;
    const double mux = 0.5 * (peak_mu(cfg.tire_front, m * g * cfg.weight_front * 0.5, false) + peak_mu(cfg.tire_rear, m * g * (1 - cfg.weight_front) * 0.5, false));
    const double muy = 0.5 * (peak_mu(cfg.tire_front, m * g * cfg.weight_front * 0.5, true) + peak_mu(cfg.tire_rear, m * g * (1 - cfg.weight_front) * 0.5, true));
    const double R = 50.0, v_circle = 40.0 / 3.6, v_brake = 100.0 / 3.6;
    {
        std::ofstream j(dir + "/spec.json");
        if (!j) { std::fprintf(stderr, "cannot write into %s: the output directory must exist (mkdir -p it first)\n", dir.c_str()); return 1; }
        char buf[1500];
        std::snprintf(buf, sizeof buf,
                      "{\n  \"name\": \"%s\",\n  \"mass_kg\": %.3f,\n  \"weight_front\": %.5f,\n  \"wheelbase_m\": %.4f,\n  \"tyre_mu_long_peak\": %.4f,\n  \"tyre_mu_lat_peak\": %.4f,\n  \"peak_power_kw\": %.3f,\n"
                      "  \"drag_area_m2\": %.5f,\n  \"rolling_resistance_c0\": %.6f,\n  \"rolling_resistance_c2\": %.6f,\n  \"air_density_kg_m3\": %.4f,\n  \"rotating_mass_factor\": 1.03,\n"
                      "  \"circle_radius_m\": %.2f,\n  \"circle_speed_mps\": %.4f,\n  \"brake_speed_mps\": %.4f\n}\n",
                      cfg.name.c_str(), m, cfg.weight_front, cfg.wheelbase, mux, muy, p_peak / 1000.0, cfg.aero.drag_area, cfg.tire_rear.rolling_resistance, cfg.tire_rear.rolling_resistance_v2,
                      cfg.aero.air_density, R, v_circle, v_brake);
        j << buf;
    }
    log_static(cfg, dir + "/static.csv");
    log_coast(cfg, dir + "/coast.csv", 100.0 / 3.6);
    log_brake(cfg, dir + "/brake.csv", v_brake, 1.0 / 240.0);
    log_brake(cfg, dir + "/brake_repeat.csv", v_brake, 1.0 / 240.0);
    log_brake(cfg, dir + "/brake_half_dt.csv", v_brake, 1.0 / 480.0);
    log_launch(cfg, dir + "/launch.csv");
    log_circle(cfg, dir + "/circle_left.csv", true, R, v_circle);
    log_circle(cfg, dir + "/circle_right.csv", false, R, v_circle);
    std::printf("wrote spec.json and 8 logs to %s\n", dir.c_str());
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc >= 5 && std::string(argv[1]) == "tyre") return tyre_cmd(argv[2], argv[3], argv[4]);
    if (argc >= 4 && std::string(argv[1]) == "vehicle") return vehicle_cmd(argv[2], argv[3]);
    if (argc >= 4 && std::string(argv[1]) == "tyre-summary") return tyre_summary_cmd(argv[2], argv[3]);
    std::fprintf(stderr, "usage: rs_conformance tyre <tyre.tir> <cases.csv> <out.csv>\n       rs_conformance vehicle <car.json> <outdir>\n       rs_conformance tyre-summary <tyre.tir> <cases.csv>\n");
    return 2;
}
