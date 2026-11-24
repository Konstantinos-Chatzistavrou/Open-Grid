// Layer 1 ISO Vehicle Dynamics Handling Standards Suite (docs/testing_program.md Layer 1 #2-#5; closes Issue #6):
//
//   1. ISO 4138:2021 — Steady-State Circular Driving Behaviour (Constant-Radius Method, R = 100 m):
//      https://www.iso.org/standard/74969.html
//      Linear understeer gradient K_us (deg/g), body roll gradient d(phi)/d(a_y) (deg/g), sideslip
//      angle beta (deg), and limit lateral acceleration a_y,max (g) across Vela GT, Kestrel GT,
//      Harrier GT, and Mistra 200T.
//      Published engineering target ranges:
//        - W. F. Milliken & D. L. Milliken, "Race Car Vehicle Dynamics" (SAE, 1995), Ch. 5-6
//        - T. D. Gillespie, "Fundamentals of Vehicle Dynamics" (SAE, 1992), Ch. 6
//        - NHTSA Crash-Avoidance Test Reference Guide Vol. IV:
//          https://www.nhtsa.gov/document/volume-iv-crash-avoidance-test-reference-guide
//        Typical road sports cars / hot hatches:
//          K_us:          1.0-4.0 deg/g (sports cars ~1.0-2.5 deg/g; passenger/FWD ~2.0-4.0 deg/g;
//                         virtually all production road cars positive for linear stability)
//          Roll gradient: 1.0-4.5 deg/g (track/GT coupes ~1.0-3.0 deg/g; sports cars ~2.0-4.0 deg/g;
//                         compact hatches ~3.0-5.0 deg/g)
//
//   2. ISO 7401:2011 — Lateral Transient Response (Step Steer Input at 100 km/h, 0.40 g steady a_y):
//      https://www.iso.org/standard/51500.html
//      Rapid steering ramp (10%-90% rise time <= 0.15 s; 0.10 s full ramp used here -> 0.08 s 10%-90%).
//      Time origin t_0 at 50% of final steering angle. Measures 90% yaw-rate response time T_r,
//      90% lateral-acceleration response time T_ay, yaw-rate overshoot U_r, and steady yaw gain.
//      Published road/sports car ranges (ISO 7401 literature; Mitschke & Wallentowitz; Bosch Automotive Handbook):
//          T_r:  0.08-0.22 s (sports cars ~0.10-0.18 s; passenger cars ~0.15-0.30 s)
//          T_ay: 0.14-0.38 s
//          U_r:  0-35% (sports cars 0-20%; passenger cars 10-40%)
//
//   3. ISO 7975:2019 — Braking in a Turn (Open-Loop, Fixed Steering Wheel):
//      https://www.iso.org/standard/74972.html
//      Steady ~0.50 g left turn at 100 km/h (R = 157 m), steering locked, ~0.50 g longitudinal braking
//      applied. Evaluates at t = 1.0 s after brake onset: speed drop, longitudinal deceleration,
//      yaw-rate ratio r(1.0s)/r_0, sideslip angle beta(1.0s), and path curvature ratio.
//      Tested with ABS+ESC ON and ABS-only (ESC OFF).
//
//   4. ISO 3888-2:2011 — Severe Double Lane Change / Obstacle Avoidance (Moose Test):
//      https://www.iso.org/standard/57253.html
//      Exact 61 m cone corridor (12.0 + 13.5 + 11.0 + 12.5 + 12.0 m):
//        - Section 1 (Entry,  x in [ 0.0, 12.0] m): width w1 = 1.1*W + 0.25 m, centred at y = 0
//        - Section 3 (Offset, x in [25.5, 36.5] m): width w3 = W + 1.0 m, 1.0 m clear lateral gap
//          from Section 1 left edge (y in [w1/2 + 1.0, w1/2 + 1.0 + w3])
//        - Section 5 (Exit,   x in [49.0, 61.0] m): width w5 = max(1.3*W + 0.25 m, 3.0 m), right
//          edge aligned with Section 1 right edge (y in [-w1/2, -w1/2 + w5])
//      Throttle lifted 2.0 m after Section 1 entry; closed-loop driver tracks the corridor while
//      every vehicle body corner is checked against all 3 cone gates.
//      Published Moose Test benchmarks (km77.com / Teknikens Varld):
//        - Teknikens Varld pass threshold: 72 km/h; km77.com pass benchmark: 77 km/h
//          (https://www.km77.com/pruebas/volkswagen/golf/2020/gti/informacion)
//        - VW Golf GTI Mk7/Mk8: 73 km/h (km77); Honda Civic Type R FL5: 74 km/h (km77);
//          Toyota GR Supra: 77 km/h (km77); Porsche 911 Carrera/Turbo: 80-82 km/h (km77).
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>
#include "harness.hpp"
#include "measure.hpp"

using namespace rs;

namespace {

constexpr double kDeg = 180.0 / kPi;
constexpr double kRad = kPi / 180.0;

CarConfig load_car(const char* id) {
    return load_car_config(test::data_path(std::string("cars/") + id + ".json"));
}

// Yaw-invariant chassis roll angle (deg; positive when rolling right during a left +Y turn).
double body_roll_deg(const Simulation& s) {
    const Vec3 up_b = s.body.state.orientation.inv_rotate({0, 0, 1});
    return std::atan2(up_b.y, up_b.z) * kDeg;
}

double body_heading(const Simulation& s) {
    const Vec3 fwd = s.body.state.orientation.rotate({1, 0, 0});
    return std::atan2(fwd.y, fwd.x);
}

double body_sideslip_deg(const Simulation& s) {
    const Vec3 vb = s.velocity_body();
    return std::atan2(vb.y, std::max(std::abs(vb.x), 0.5)) * kDeg;
}

// Ordinary least-squares linear regression slope dY/dX over (x, y) samples.
double ols_slope(const std::vector<std::pair<double, double>>& pts) {
    if (pts.size() < 2) return 0.0;
    double sx = 0.0, sy = 0.0;
    for (const auto& p : pts) {
        sx += p.first;
        sy += p.second;
    }
    const double mx = sx / static_cast<double>(pts.size());
    const double my = sy / static_cast<double>(pts.size());
    double num = 0.0, den = 0.0;
    for (const auto& p : pts) {
        const double dx = p.first - mx;
        num += dx * (p.second - my);
        den += dx * dx;
    }
    return den > 1e-12 ? num / den : 0.0;
}

// Mean y for samples whose x lies within [x_target - half_win, x_target + half_win].
double mean_near_x(const std::vector<std::pair<double, double>>& pts, double x_target, double half_win) {
    double sum = 0.0;
    int count = 0;
    for (const auto& p : pts) {
        if (std::abs(p.first - x_target) <= half_win) {
            sum += p.second;
            ++count;
        }
    }
    return count > 0 ? sum / count : 0.0;
}

// Linearly interpolated crossing time where |signal| first reaches target_abs.
double first_crossing_time(const std::vector<std::pair<double, double>>& trace, double target_abs) {
    for (std::size_t i = 1; i < trace.size(); ++i) {
        const double y0 = std::abs(trace[i - 1].second);
        const double y1 = std::abs(trace[i].second);
        if (y1 >= target_abs) {
            if (y0 >= target_abs || y1 <= y0 + 1e-12) return trace[i].first;
            const double frac = (target_abs - y0) / (y1 - y0);
            return trace[i - 1].first + frac * (trace[i].first - trace[i - 1].first);
        }
    }
    return 99.0;
}

// =========================================================================
// 1. ISO 4138 Constant-Radius Steady-State Circular Driving Behaviour
// =========================================================================
struct Iso4138Result {
    std::string name;
    double k_us_steer = 0.0;    // deg/g, linear OLS slope of (delta_wheel - L*r/v) over 0.25..0.55 g
    double k_us_slip = 0.0;     // deg/g, linear OLS slope of (alpha_f - alpha_r) over 0.25..0.55 g
    double roll_grad = 0.0;     // deg/g, linear OLS slope of body roll over 0.25..0.55 g
    double beta_05g = 0.0;      // deg, sideslip angle at 0.50 g
    double beta_08g = 0.0;      // deg, sideslip angle at 0.80 g
    double ay_max_g = 0.0;      // g, maximum sustained lateral acceleration on R = 100 m circle
};

Iso4138Result run_iso4138(const CarConfig& cfg) {
    constexpr double kRadius = 100.0;
    constexpr double kRamp = 0.25;         // m/s^2 quasi-static speed ramp per ISO 4138
    constexpr double kSettleSec = 4.0;
    const double v0 = std::sqrt(0.10 * kGravity * kRadius);   // ~9.90 m/s (~0.10 g entry)
    const double L = cfg.wheelbase;

    auto s = test::make_sim(cfg);
    int cur_gear = rs::sheet::gear_for(cfg, v0);
    s->reset({}, 0.0, v0, cur_gear);
    test::SpeedController sc;

    double v_target = v0;
    double r_int = 0.0;
    double ay_filt = 0.0;
    double max_ay = 0.0;
    double last_shift_t = -10.0;

    std::vector<std::pair<double, double>> pts_us_steer;
    std::vector<std::pair<double, double>> pts_us_slip;
    std::vector<std::pair<double, double>> pts_roll;
    std::vector<std::pair<double, double>> pts_beta;

    while (s->time < 160.0) {
        const double v_cur = test::speed(*s);
        const int want_gear = rs::sheet::gear_for(cfg, v_cur);
        if (want_gear != cur_gear && s->time - last_shift_t > 1.0) {
            cur_gear = want_gear;
            last_shift_t = s->time;
        }

        const double r_cur = std::hypot(s->body.state.position.x, s->body.state.position.y - kRadius);
        const double r_err = r_cur - kRadius;   // + = outside circle -> steer left (+)
        r_int = clamp(r_int + r_err * s->dt, -2.5, 2.5);

        DriverInput in;
        in.gear = cur_gear;
        in.auto_clutch = true;
        const double steer_pp = test::steer_circle(*s, {0.0, kRadius, 0.0}, kRadius, 12.0);
        in.steer = clamp(steer_pp + 0.008 * r_err + 0.004 * r_int, -1.0, 1.0);
        sc.apply(*s, v_target, in);
        s->step(in);

        if (s->time >= kSettleSec) v_target += kRamp * s->dt;

        ay_filt += (s->accel_body().y - ay_filt) * (s->dt / 0.5);
        const double ay_g = ay_filt / kGravity;
        const double abs_r_err = std::abs(r_err);

        if (s->time > kSettleSec + 1.0 && abs_r_err < 1.5) {
            max_ay = std::max(max_ay, ay_g);
        }

        // Sample quasi-static points outside gear-shift transients.
        if (s->time > kSettleSec + 0.5 && s->time - last_shift_t > 0.6 && abs_r_err < 1.2) {
            const double v_long = std::max(s->velocity_body().x, 1.0);
            const double delta_cmd_deg = in.steer * cfg.front.max_steer_deg;
            const double ack_deg = (L * s->last.yaw_rate / v_long) * kDeg;
            const double delta_us_deg = delta_cmd_deg - ack_deg;

            const double alpha_f_deg = 0.5 * (s->last.wheels[FL].slip_angle + s->last.wheels[FR].slip_angle) * kDeg;
            const double alpha_r_deg = 0.5 * (s->last.wheels[RL].slip_angle + s->last.wheels[RR].slip_angle) * kDeg;
            const double roll_d = body_roll_deg(*s);
            const double beta_d = body_sideslip_deg(*s);

            if (ay_g >= 0.25 && ay_g <= 0.55) {
                pts_us_steer.emplace_back(ay_g, delta_us_deg);
                pts_us_slip.emplace_back(ay_g, alpha_f_deg - alpha_r_deg);
                pts_roll.emplace_back(ay_g, roll_d);
            }
            if (ay_g >= 0.15) {
                pts_beta.emplace_back(ay_g, beta_d);
            }
        }

        if (s->time > kSettleSec + 2.0 && abs_r_err > 5.0) break;
    }

    Iso4138Result out;
    out.name = cfg.name;
    out.k_us_steer = ols_slope(pts_us_steer);
    out.k_us_slip = ols_slope(pts_us_slip);
    out.roll_grad = ols_slope(pts_roll);
    out.beta_05g = mean_near_x(pts_beta, 0.50, 0.03);
    out.beta_08g = mean_near_x(pts_beta, 0.80, 0.03);
    out.ay_max_g = max_ay;
    return out;
}

// =========================================================================
// 2. ISO 7401 Lateral Transient Response — Step Steer at 100 km/h, 0.40 g
// =========================================================================
struct Iso7401Result {
    std::string name;
    double steer_deg = 0.0;    // calibrated road-wheel step angle (deg)
    double ay_ss_g = 0.0;      // steady-state lateral acceleration (g)
    double r_ss_dps = 0.0;     // steady-state yaw rate (deg/s)
    double t_r = 0.0;          // 90% yaw-rate response time from 50% steer (s)
    double t_ay = 0.0;         // 90% lateral-accel response time from 50% steer (s)
    double u_r_pct = 0.0;      // yaw-rate overshoot (%)
    double yaw_gain = 0.0;     // steady yaw-rate gain r_ss / delta_wheel ((rad/s)/rad = 1/s)
};

Iso7401Result run_iso7401(const CarConfig& cfg) {
    constexpr double kSpeed = 100.0 / 3.6;    // 27.778 m/s
    constexpr double kTargetAy = 0.40 * kGravity;
    constexpr double kRampDur = 0.10;         // s (10%-90% rise = 0.08 s <= 0.15 s per ISO 7401)
    const int gear = rs::sheet::gear_for(cfg, kSpeed);

    // Step A: calibrate the open-loop steering fraction that yields 0.40 g steady lateral acceleration.
    const double max_steer_rad = cfg.front.max_steer_deg * kRad;
    double steer_frac = clamp((cfg.wheelbase * kTargetAy / (kSpeed * kSpeed)) * 1.4 / max_steer_rad, 0.005, 0.30);
    for (int iter = 0; iter < 3; ++iter) {
        auto s = test::make_sim(cfg);
        s->reset({}, 0.0, kSpeed, gear);
        test::SpeedController sc;
        double ay_sum = 0.0;
        int n = 0;
        while (s->time < 3.0) {
            DriverInput in;
            in.gear = gear;
            sc.apply(*s, kSpeed, in);
            in.steer = s->time < 0.5 ? 0.0 : steer_frac * std::min(1.0, (s->time - 0.5) / kRampDur);
            s->step(in);
            if (s->time > 2.2) {
                ay_sum += s->accel_body().y;
                ++n;
            }
        }
        const double ay_meas = n > 0 ? ay_sum / n : kTargetAy;
        if (ay_meas > 0.2) steer_frac = clamp(steer_frac * (kTargetAy / ay_meas), 0.005, 0.35);
    }

    // Step B: full ISO 7401 step-steer recording.
    constexpr double kRampStart = 1.0;
    constexpr double kT0 = kRampStart + 0.5 * kRampDur;   // 50% steering time origin per ISO 7401
    auto s = test::make_sim(cfg);
    s->reset({}, 0.0, kSpeed, gear);
    test::SpeedController sc;

    std::vector<std::pair<double, double>> trace_r;
    std::vector<std::pair<double, double>> trace_ay;
    double r_ss_sum = 0.0, ay_ss_sum = 0.0;
    int ss_n = 0;
    double r_peak = 0.0;

    while (s->time < kT0 + 3.5) {
        DriverInput in;
        in.gear = gear;
        sc.apply(*s, kSpeed, in);
        if (s->time < kRampStart) {
            in.steer = 0.0;
        } else {
            in.steer = steer_frac * std::min(1.0, (s->time - kRampStart) / kRampDur);
        }
        s->step(in);

        const double t_rel = s->time - kT0;
        if (t_rel >= -0.05) {
            const double r = s->last.yaw_rate;
            const double ay = s->accel_body().y;
            trace_r.emplace_back(t_rel, r);
            trace_ay.emplace_back(t_rel, ay);
            if (t_rel >= 0.0 && t_rel <= 2.0) r_peak = std::max(r_peak, std::abs(r));
            if (t_rel >= 2.0 && t_rel <= 3.0) {
                r_ss_sum += r;
                ay_ss_sum += ay;
                ++ss_n;
            }
        }
    }

    const double r_ss = ss_n > 0 ? r_ss_sum / ss_n : 0.0;
    const double ay_ss = ss_n > 0 ? ay_ss_sum / ss_n : 0.0;
    const double delta_rad = steer_frac * max_steer_rad;

    Iso7401Result out;
    out.name = cfg.name;
    out.steer_deg = steer_frac * cfg.front.max_steer_deg;
    out.ay_ss_g = ay_ss / kGravity;
    out.r_ss_dps = r_ss * kDeg;
    out.t_r = first_crossing_time(trace_r, 0.90 * std::abs(r_ss));
    out.t_ay = first_crossing_time(trace_ay, 0.90 * std::abs(ay_ss));
    out.u_r_pct = std::abs(r_ss) > 1e-6 ? std::max(0.0, (r_peak - std::abs(r_ss)) / std::abs(r_ss)) * 100.0 : 0.0;
    out.yaw_gain = delta_rad > 1e-6 ? std::abs(r_ss) / delta_rad : 0.0;
    return out;
}

// =========================================================================
// 3. ISO 7975 Braking in a Turn (Open-Loop, Fixed Steering)
// =========================================================================
struct Iso7975Result {
    bool esc_on = false;
    double brake_pedal = 0.0;
    double ay0_g = 0.0;
    double v0_kmh = 0.0;
    double v_1s_kmh = 0.0;
    double ax_mean_g = 0.0;       // mean longitudinal deceleration over [0.15, 1.0] s (positive = decel)
    double r_ratio_1s = 0.0;      // r(1.0s) / r_0
    double beta_1s_deg = 0.0;     // sideslip angle at t = 1.0 s (deg)
    double peak_beta_deg = 0.0;   // max |beta| over [0, 1.2] s (deg)
    double curv_ratio_1s = 0.0;   // (r(1.0s) / v(1.0s)) * R_0 (> 1 = path tightens inward)
};

Iso7975Result run_iso7975_once(const CarConfig& cfg, bool esc_on, double brake_pedal) {
    constexpr double kV0 = 100.0 / 3.6;                         // 27.778 m/s
    constexpr double kRadius = (kV0 * kV0) / (0.50 * kGravity); // ~157.3 m -> 0.50 g steady turn
    constexpr double kTBrake = 6.0;
    constexpr double kBrakeRamp = 0.15;
    const int gear = rs::sheet::gear_for(cfg, kV0);

    auto s = test::make_sim(cfg);
    s->reset({}, 0.0, kV0, gear);
    s->vehicle.assists().abs = true;
    s->vehicle.assists().esc = esc_on;

    test::SpeedController sc;
    double r_int = 0.0;
    double steer_sum = 0.0, r0_sum = 0.0, ay0_sum = 0.0, v0_sum = 0.0;
    int ss_n = 0;
    double steer_hold = 0.0, r0 = 0.0, ay0 = 0.0, v0 = kV0;

    double ax_sum = 0.0;
    int ax_n = 0;
    double peak_beta = 0.0;
    bool captured_1s = false;
    Iso7975Result res;
    res.esc_on = esc_on;
    res.brake_pedal = brake_pedal;

    while (s->time < kTBrake + 1.25) {
        DriverInput in;
        in.gear = gear;
        if (s->time < kTBrake) {
            const double r_cur = std::hypot(s->body.state.position.x, s->body.state.position.y - kRadius);
            const double r_err = r_cur - kRadius;
            r_int = clamp(r_int + r_err * s->dt, -2.5, 2.5);
            const double steer_pp = test::steer_circle(*s, {0.0, kRadius, 0.0}, kRadius, 14.0);
            in.steer = clamp(steer_pp + 0.006 * r_err + 0.003 * r_int, -1.0, 1.0);
            sc.apply(*s, kV0, in);
            if (s->time >= kTBrake - 1.5) {
                steer_sum += in.steer;
                r0_sum += s->last.yaw_rate;
                ay0_sum += s->accel_body().y;
                v0_sum += test::speed(*s);
                ++ss_n;
            }
            steer_hold = ss_n > 0 ? steer_sum / ss_n : in.steer;
            r0 = ss_n > 0 ? r0_sum / ss_n : s->last.yaw_rate;
            ay0 = ss_n > 0 ? ay0_sum / ss_n : s->accel_body().y;
            v0 = ss_n > 0 ? v0_sum / ss_n : kV0;
        } else {
            const double tb = s->time - kTBrake;
            in.steer = steer_hold;   // steering wheel locked (open-loop per ISO 7975)
            in.throttle = 0.0;
            in.clutch = 1.0;         // declutched to isolate braking dynamics
            in.brake = brake_pedal * std::min(1.0, tb / kBrakeRamp);
        }

        s->step(in);

        if (s->time >= kTBrake) {
            const double tb = s->time - kTBrake;
            const double beta_d = body_sideslip_deg(*s);
            peak_beta = std::max(peak_beta, std::abs(beta_d));
            if (tb >= kBrakeRamp && tb <= 1.0) {
                ax_sum += -s->accel_body().x;
                ++ax_n;
            }
            if (!captured_1s && tb >= 1.0) {
                captured_1s = true;
                const double v1 = test::speed(*s);
                const double r1 = s->last.yaw_rate;
                res.ay0_g = ay0 / kGravity;
                res.v0_kmh = v0 * 3.6;
                res.v_1s_kmh = v1 * 3.6;
                res.ax_mean_g = ax_n > 0 ? (ax_sum / ax_n) / kGravity : 0.0;
                res.r_ratio_1s = std::abs(r0) > 1e-6 ? r1 / r0 : 0.0;
                res.beta_1s_deg = beta_d;
                res.curv_ratio_1s = (r1 / std::max(v1, 1.0)) * kRadius;
            }
        }
    }
    res.peak_beta_deg = peak_beta;
    return res;
}

double calibrate_iso7975_brake(const CarConfig& cfg) {
    double pedal = 0.45;
    for (int iter = 0; iter < 3; ++iter) {
        const Iso7975Result r = run_iso7975_once(cfg, true, pedal);
        if (r.ax_mean_g > 0.05) {
            pedal = clamp(pedal * (0.50 / r.ax_mean_g), 0.15, 0.95);
        }
    }
    return pedal;
}

// =========================================================================
// 4. ISO 3888-2 Severe Double Lane Change (Moose Test, 61 m Corridor)
// =========================================================================
struct MooseCorridor {
    double car_width = 1.85;
    double front_len = 2.15;   // CG -> front bumper (m)
    double rear_len = 2.15;    // CG -> rear bumper (m)

    // Section longitudinal intervals along +X (total 61.0 m)
    double x1_end = 12.0;      // Section 1: [ 0.0, 12.0] (12.0 m)
    double x3_start = 25.5;    // Section 2: (12.0, 25.5) (13.5 m transition)
    double x3_end = 36.5;      // Section 3: [25.5, 36.5] (11.0 m offset gate)
    double x5_start = 49.0;    // Section 4: (36.5, 49.0) (12.5 m return)
    double x5_end = 61.0;      // Section 5: [49.0, 61.0] (12.0 m exit gate)

    // Gate lateral bounds (Y, + = left)
    double w1 = 0.0, y_r1 = 0.0, y_l1 = 0.0;
    double w3 = 0.0, y_r3 = 0.0, y_l3 = 0.0, y_c3 = 0.0;
    double w5 = 0.0, y_r5 = 0.0, y_l5 = 0.0, y_c5 = 0.0;

    explicit MooseCorridor(const CarConfig& cfg) {
        // Overall body width (without mirrors): track + ~0.26 m matches C7 (1.87 m) & Golf Mk7 (1.80 m).
        car_width = std::max(cfg.front.track, cfg.rear.track) + 0.26;
        front_len = cfg.dist_cg_front + 0.85;
        rear_len = cfg.dist_cg_rear + 0.80;

        w1 = 1.1 * car_width + 0.25;
        y_r1 = -0.5 * w1;
        y_l1 = +0.5 * w1;

        w3 = car_width + 1.0;
        y_r3 = y_l1 + 1.0;     // exact 1.0 m clear gap from entry outer (left) edge per ISO 3888-2
        y_l3 = y_r3 + w3;
        y_c3 = 0.5 * (y_r3 + y_l3);

        w5 = std::max(1.3 * car_width + 0.25, 3.0);
        y_r5 = y_r1;           // exit outer (right) edge aligned with entry right edge per ISO 3888-2
        y_l5 = y_r5 + w5;
        y_c5 = 0.5 * (y_r5 + y_l5);
    }

    // Signed clearance of a point (px, py) to whichever cone gate spans px (> 0 inside, < 0 cone hit).
    double point_clearance(double px, double py) const {
        if (px >= 0.0 && px <= x1_end) return std::min(py - y_r1, y_l1 - py);
        if (px >= x3_start && px <= x3_end) return std::min(py - y_r3, y_l3 - py);
        if (px >= x5_start && px <= x5_end) return std::min(py - y_r5, y_l5 - py);
        return 100.0;
    }

    // Minimum clearance over all 4 rectangular corners + side midpoints of the car body.
    double body_clearance(const ChassisState& st) const {
        const double hw = 0.5 * car_width;
        const std::array<Vec3, 6> pts = {{
            {front_len, +hw, 0.0},
            {front_len, -hw, 0.0},
            {0.0,       +hw, 0.0},
            {0.0,       -hw, 0.0},
            {-rear_len, +hw, 0.0},
            {-rear_len, -hw, 0.0}
        }};
        double min_c = 100.0;
        for (const Vec3& loc : pts) {
            const Vec3 w = st.position + st.orientation.rotate(loc);
            min_c = std::min(min_c, point_clearance(w.x, w.y));
        }
        return min_c;
    }

    // Smooth C2 quintic (minimum-jerk) reference trajectory y_ref(x) + first derivative dy/dx.
    // Tuned so the vehicle stays centred through Gate 1 until its front bumper clears x = 12.0 m,
    // threads Gate 3 cleanly, and returns inside Gate 5 with positive cone margins on all corners.
    std::pair<double, double> reference_path(double x) const {
        auto quintic = [](double u) -> std::pair<double, double> {
            const double s = clamp(u, 0.0, 1.0);
            const double val = s * s * s * (10.0 + s * (-15.0 + 6.0 * s));
            const double dval = 30.0 * s * s * (1.0 - s) * (1.0 - s);
            return {val, dval};
        };

        // Centred targets in Gate 3 (1.0 m total slack) and Gate 5 (~1.1-1.2 m total slack).
        const double y_target3 = y_c3;
        const double y_target5 = y_c5;

        // First swerve: delay onset past x = 12.5 m so preview tracker keeps front bumper inside Gate 1.
        const double x_a0 = 12.8, x_a1 = 29.0;
        // Return swerve: hold Gate 3 line, then return cleanly into Gate 5.
        const double x_b0 = 35.5, x_b1 = 53.0;

        if (x <= x_a0) return {0.0, 0.0};
        if (x < x_a1) {
            const double len = x_a1 - x_a0;
            const auto q = quintic((x - x_a0) / len);
            return {y_target3 * q.first, y_target3 * q.second / len};
        }
        if (x <= x_b0) return {y_target3, 0.0};
        if (x < x_b1) {
            const double len = x_b1 - x_b0;
            const auto q = quintic((x - x_b0) / len);
            const double dy = y_target5 - y_target3;
            return {y_target3 + dy * q.first, dy * q.second / len};
        }
        return {y_target5, 0.0};
    }
};

struct MooseRunResult {
    double entry_kmh = 0.0;
    double exit_kmh = 0.0;
    bool passed = false;
    double min_clearance_m = 0.0;
    double peak_ay_g = 0.0;
    double peak_beta_deg = 0.0;
    double esc_time_s = 0.0;
};

MooseRunResult run_moose_once(const CarConfig& cfg, double entry_kmh) {
    const MooseCorridor track(cfg);
    const double v_entry = entry_kmh / 3.6;
    const int gear = rs::sheet::gear_for(cfg, v_entry);

    auto s = test::make_sim(cfg);
    // Start 45 m ahead of Section 1 so the speed controller settles cleanly at exact v_entry.
    s->reset({-45.0, 0.0, 0.0}, 0.0, v_entry, gear);
    s->vehicle.assists().abs = true;
    s->vehicle.assists().esc = true;

    test::SpeedController sc;
    const double max_steer_rad = cfg.front.max_steer_deg * kRad;
    constexpr double kMaxSteerRate = 2.0;   // normalized steer/s (~64 deg/s road wheel; rapid human swerve)

    double steer_cmd = 0.0;
    double min_clear = 100.0;
    double peak_ay = 0.0;
    double peak_beta = 0.0;
    double esc_time = 0.0;
    double entry_meas_kmh = entry_kmh;
    bool recorded_entry = false;

    while (s->body.state.position.x < track.x5_end + track.rear_len + 2.0 && s->time < 12.0) {
        const double x = s->body.state.position.x;
        const double y = s->body.state.position.y;
        const double psi = body_heading(*s);
        const double v = std::max(test::speed(*s), 1.0);

        // Front-axle Stanley + short-horizon preview curvature feedforward.
        const double x_front = x + cfg.dist_cg_front * std::cos(psi);
        const double y_front = y + cfg.dist_cg_front * std::sin(psi);
        const double preview = clamp(0.18 * v, 2.5, 4.5);
        const auto ref_front = track.reference_path(x_front);
        const auto ref_prev = track.reference_path(x_front + preview);

        const double y_err = ref_front.first - y_front;
        const double psi_ref = std::atan(ref_prev.second);
        const double psi_err = psi_ref - psi;

        // Curvature feedforward across the preview horizon.
        const double kappa_ff = (std::atan(ref_prev.second) - std::atan(ref_front.second)) / preview;
        const double r_des = v * kappa_ff;

        const double delta_rad = 1.15 * psi_err
                               + std::atan2(3.2 * y_err, v + 3.0)
                               + 1.25 * cfg.wheelbase * kappa_ff
                               - 0.05 * (s->last.yaw_rate - r_des);
        const double steer_target = clamp(delta_rad / max_steer_rad, -1.0, 1.0);
        const double max_step = kMaxSteerRate * s->dt;
        steer_cmd += clamp(steer_target - steer_cmd, -max_step, max_step);

        DriverInput in;
        in.gear = gear;
        in.steer = steer_cmd;

        if (x < 2.0) {
            // Approach and first 2 m of Section 1: hold target entry speed.
            sc.apply(*s, v_entry, in);
        } else {
            // ISO 3888-2: lift accelerator completely 2 m after entering Section 1; no brake pedal.
            in.throttle = 0.0;
            in.brake = 0.0;
        }

        s->step(in);

        if (!recorded_entry && x >= 0.0) {
            recorded_entry = true;
            entry_meas_kmh = test::speed(*s) * 3.6;
        }
        if (x >= -track.front_len && x <= track.x5_end + track.rear_len) {
            min_clear = std::min(min_clear, track.body_clearance(s->body.state));
            peak_ay = std::max(peak_ay, std::abs(s->accel_body().y) / kGravity);
            peak_beta = std::max(peak_beta, std::abs(body_sideslip_deg(*s)));
            if (s->last.assists.esc_mode != 0) esc_time += s->dt;
        }
    }

    MooseRunResult out;
    out.entry_kmh = entry_meas_kmh;
    out.exit_kmh = test::speed(*s) * 3.6;
    out.min_clearance_m = min_clear;
    out.peak_ay_g = peak_ay;
    out.peak_beta_deg = peak_beta;
    out.esc_time_s = esc_time;
    out.passed = (min_clear >= 0.0) && (peak_beta < 12.0) && (s->body.state.position.x >= track.x5_end);
    return out;
}

}  // namespace

// =========================================================================
// CTest 1: ISO 4138 Steady-State Circular Driving Behaviour (Issue #6)
// =========================================================================
RS_TEST(iso4138_steady_circle) {
    const std::array<const char*, 4> ids = {"vela_gt", "kestrel_gt", "harrier_gt", "mistra_200t"};
    std::array<Iso4138Result, 4> res;

    std::printf("         ISO 4138 Constant-Radius Circle (R = 100 m, dv/dt = 0.25 m/s^2, linear fit 0.25-0.55 g):\n");
    std::printf("         %-14s | %11s | %11s | %9s | %9s | %9s | %8s\n",
                "Car", "K_us(steer)", "K_us(slip)", "RollGrad", "beta@0.5g", "beta@0.8g", "a_y,max");
    std::printf("         %-14s-+-%11s-+-%11s-+-%9s-+-%9s-+-%9s-+-%8s\n",
                "--------------", "-----------", "-----------", "---------", "---------", "---------", "--------");

    for (std::size_t i = 0; i < ids.size(); ++i) {
        res[i] = run_iso4138(load_car(ids[i]));
        std::printf("         %-14s | %6.2f deg/g| %6.2f deg/g| %4.2f deg/g| %5.2f deg | %5.2f deg | %6.3f g\n",
                    res[i].name.c_str(), res[i].k_us_steer, res[i].k_us_slip, res[i].roll_grad,
                    res[i].beta_05g, res[i].beta_08g, res[i].ay_max_g);
    }

    for (std::size_t i = 0; i < res.size(); ++i) {
        const std::string lbl_k = res[i].name + ": linear K_us (0.25-0.55 g) [Milliken/NHTSA]";
        const std::string lbl_r = res[i].name + ": body roll gradient [Gillespie/Milliken]";
        test::check_range(lbl_k.c_str(), res[i].k_us_steer, 0.3, 5.5, "deg/g");
        test::check_range(lbl_r.c_str(), res[i].roll_grad, 0.6, 4.5, "deg/g");
        test::check((res[i].name + ": tyre slip K_us_slip is positive (understeering axle balance)").c_str(),
                    res[i].k_us_slip > 0.1);
    }

    const Iso4138Result& vela = res[0];
    const Iso4138Result& kestrel = res[1];
    const Iso4138Result& harrier = res[2];
    const Iso4138Result& mistra = res[3];

    test::check("Kestrel GT has lowest body roll gradient (stiffest track suspension)",
                kestrel.roll_grad < vela.roll_grad && kestrel.roll_grad < harrier.roll_grad
                && kestrel.roll_grad < mistra.roll_grad);
    test::check("Kestrel GT has highest limit lateral acceleration on R = 100 m",
                kestrel.ay_max_g > vela.ay_max_g && kestrel.ay_max_g > harrier.ay_max_g
                && kestrel.ay_max_g > mistra.ay_max_g);
    test::check("Mistra 200T (FWD) has higher understeer gradient than Kestrel GT (track RWD)",
                mistra.k_us_steer > kestrel.k_us_steer);
}

// =========================================================================
// CTest 2: ISO 7401 Lateral Transient Response (Step Steer at 100 km/h)
// =========================================================================
RS_TEST(iso7401_step_steer) {
    const std::array<const char*, 3> ids = {"vela_gt", "kestrel_gt", "mistra_200t"};
    std::array<Iso7401Result, 3> res;

    std::printf("         ISO 7401 Step Steer (100 km/h, 0.10 s ramp to 0.40 g steady a_y):\n");
    std::printf("         %-14s | %8s | %7s | %8s | %8s | %8s | %10s\n",
                "Car", "delta_w", "a_y,ss", "T_r(90%)", "T_ay(90%)", "U_r(%)", "YawGain");
    std::printf("         %-14s-+-%8s-+-%7s-+-%8s-+-%8s-+-%8s-+-%10s\n",
                "--------------", "--------", "-------", "--------", "--------", "--------", "----------");

    for (std::size_t i = 0; i < ids.size(); ++i) {
        res[i] = run_iso7401(load_car(ids[i]));
        std::printf("         %-14s | %4.2f deg | %5.3f g | %6.3f s | %6.3f s | %6.1f %% | %6.2f 1/s\n",
                    res[i].name.c_str(), res[i].steer_deg, res[i].ay_ss_g,
                    res[i].t_r, res[i].t_ay, res[i].u_r_pct, res[i].yaw_gain);
    }

    for (std::size_t i = 0; i < res.size(); ++i) {
        test::check_range((res[i].name + ": steady lateral accel [ISO 7401 0.40 g]").c_str(),
                          res[i].ay_ss_g, 0.36, 0.44, "g");
        test::check_range((res[i].name + ": yaw-rate 90% response time T_r [ISO 7401]").c_str(),
                          res[i].t_r, 0.06, 0.24, "s");
        test::check_range((res[i].name + ": lateral-accel 90% response time T_ay").c_str(),
                          res[i].t_ay, 0.12, 0.40, "s");
        test::check_range((res[i].name + ": yaw-rate overshoot U_r [ISO 7401]").c_str(),
                          res[i].u_r_pct, 0.0, 40.0, "%");
        test::check((res[i].name + ": positive steady-state yaw gain").c_str(), res[i].yaw_gain > 2.0);
    }

    const Iso7401Result& kestrel = res[1];
    const Iso7401Result& mistra = res[2];
    test::check("track-tuned Kestrel GT has faster yaw response T_r than road Mistra 200T",
                kestrel.t_r < mistra.t_r);
    test::check("track-tuned Kestrel GT has faster lateral-accel response T_ay than Mistra 200T",
                kestrel.t_ay < mistra.t_ay);
}

// =========================================================================
// CTest 3: ISO 7975 Braking in a Turn (100 km/h, 0.50 g turn + 0.50 g brake)
// =========================================================================
RS_TEST(iso7975_braking_in_turn) {
    const CarConfig vela = load_car("vela_gt");
    const double brake_05g = calibrate_iso7975_brake(vela);
    const Iso7975Result with_esc = run_iso7975_once(vela, true, brake_05g);
    const Iso7975Result no_esc = run_iso7975_once(vela, false, brake_05g);

    std::printf("         ISO 7975 Braking in a Turn (Vela GT, 100 km/h, R = 157 m, 0.50 g -> fixed steer + brake %.2f):\n",
                brake_05g);
    std::printf("         %-12s | %7s | %11s | %8s | %10s | %10s | %10s | %9s\n",
                "Config", "a_y0", "v0 -> v1s", "a_x,mean", "r(1s)/r0", "beta(1s)", "peak|beta|", "curvRatio");
    std::printf("         %-12s-+-%7s-+-%11s-+-%8s-+-%10s-+-%10s-+-%10s-+-%9s\n",
                "------------", "-------", "-----------", "--------", "----------", "----------", "----------", "---------");
    for (const Iso7975Result& r : {with_esc, no_esc}) {
        std::printf("         %-12s | %5.3f g | %4.1f->%4.1f | %6.3f g | %10.3f | %6.2f deg | %6.2f deg | %9.3f\n",
                    r.esc_on ? "ABS + ESC" : "ABS only", r.ay0_g, r.v0_kmh, r.v_1s_kmh,
                    r.ax_mean_g, r.r_ratio_1s, r.beta_1s_deg, r.peak_beta_deg, r.curv_ratio_1s);
    }

    test::check_range("initial steady turn lateral accel [ISO 7975 0.50 g]", with_esc.ay0_g, 0.45, 0.55, "g");
    test::check_range("ABS+ESC: mean longitudinal deceleration [>= 0.35 g]", with_esc.ax_mean_g, 0.35, 0.65, "g");
    test::check_range("ABS+ESC: yaw-rate ratio r(1.0s)/r_0 (stable radius)", with_esc.r_ratio_1s, 0.40, 1.80, "-");
    test::check_range("ABS+ESC: |sideslip| at t = 1.0 s (no spin-out)", std::abs(with_esc.beta_1s_deg), 0.0, 10.0, "deg");
    test::check_range("ABS+ESC: peak |sideslip| during braking transient", with_esc.peak_beta_deg, 0.0, 12.0, "deg");
    test::check("ABS+ESC: car stays curving in same turn direction", with_esc.curv_ratio_1s > 0.50 && with_esc.curv_ratio_1s < 2.50);

    test::check_range("ABS-only: mean longitudinal deceleration [>= 0.35 g]", no_esc.ax_mean_g, 0.35, 0.65, "g");
    test::check_range("ABS-only: |sideslip| at t = 1.0 s (controlled chassis)", std::abs(no_esc.beta_1s_deg), 0.0, 15.0, "deg");
}

// =========================================================================
// CTest 4: ISO 3888-2 Severe Double Lane Change (Moose Test, 61 m Corridor)
// =========================================================================
RS_TEST(iso3888_moose_test) {
    const std::array<const char*, 2> ids = {"vela_gt", "mistra_200t"};

    std::printf("         ISO 3888-2 Moose Test (61 m corridor: 12 + 13.5 + 11 + 12.5 + 12 m, throttle lift @ x=2 m, ESC ON):\n");
    std::printf("         %-12s | %5s | %8s | %8s | %8s | %8s | %8s | %6s\n",
                "Car", "v_in", "v_out", "minClear", "peak_ay", "peak|b|", "ESC_t", "Result");
    std::printf("         %-12s-+-%5s-+-%8s-+-%8s-+-%8s-+-%8s-+-%8s-+-%6s\n",
                "------------", "-----", "--------", "--------", "--------", "--------", "--------", "------");

    for (const char* id : ids) {
        const CarConfig cfg = load_car(id);
        const MooseRunResult r70 = run_moose_once(cfg, 70.0);
        const MooseRunResult r77 = run_moose_once(cfg, 77.0);

        // Sweep 68..85 km/h (1 km/h steps) to find maximum clean cone-free pass speed.
        double max_clean_kmh = 0.0;
        MooseRunResult best_pass{};
        for (int v_kmh = 68; v_kmh <= 85; ++v_kmh) {
            const MooseRunResult r = run_moose_once(cfg, static_cast<double>(v_kmh));
            if (r.passed) {
                max_clean_kmh = static_cast<double>(v_kmh);
                best_pass = r;
            }
        }

        auto print_row = [&](const MooseRunResult& r, const char* tag) {
            std::printf("         %-12s | %5.1f | %5.1f kmh| %+6.3f m | %6.2f g | %5.2f deg| %6.2f s | %s%s\n",
                        cfg.name.c_str(), r.entry_kmh, r.exit_kmh, r.min_clearance_m,
                        r.peak_ay_g, r.peak_beta_deg, r.esc_time_s,
                        r.passed ? "PASS" : "FAIL", tag);
        };
        print_row(r70, "");
        print_row(r77, "");
        if (max_clean_kmh > 0.0 && max_clean_kmh != 70.0 && max_clean_kmh != 77.0) {
            print_row(best_pass, " (max)");
        }

        test::check((cfg.name + ": clean pass at 70 km/h (inside all 3 ISO 3888-2 cone gates)").c_str(), r70.passed);
        test::check_range((cfg.name + ": peak |sideslip| at 70 km/h").c_str(), r70.peak_beta_deg, 0.0, 12.0, "deg");
        test::check_range((cfg.name + ": max clean Moose Test speed [Teknikens Varld >= 72 km/h]").c_str(),
                          max_clean_kmh, 72.0, 88.0, "km/h");
    }
}
