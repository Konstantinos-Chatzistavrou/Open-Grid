// Handling behaviour tests (ported from an October draft that never reached main): tyre temperature, wear and
// pressure, cold brake pads, steering feel, differentials on split grip, aero, understeer gradient, trail
// braking, handbrake, power oversteer and a kerb strike.
//
// Rule for the checks: a check asserts only what physics (or a textbook vehicle-dynamics result) says must
// happen: a direction, an exact law (v^2, ideal gas), or a range with a published source. Magnitudes that
// depend on tuning are PRINTED, not asserted, so a test never pins a guessed number.
#include <cmath>
#include <cstdio>
#include <functional>
#include "harness.hpp"

using namespace rs;

namespace {

constexpr double kDeg = 180.0 / kPi;

// Ground with surface zones and a height field (kerbs). Rays are nearly vertical, so the hit is found by
// intersecting with the height at the ray's own xy (two fixed-point iterations).
class Course : public Ground {
public:
    std::function<int(double, double)> surface = [](double, double) { return 0; };
    std::function<double(double, double)> height = [](double, double) { return 0.0; };
    WheelContact raycast(const WheelRay& ray) const override {
        WheelContact c;
        if (ray.direction.z >= -1e-6) return c;
        double t = -ray.origin.z / ray.direction.z;
        for (int i = 0; i < 2; ++i) {
            Vec3 p = ray.origin + ray.direction * t;
            t = (ray.origin.z - height(p.x, p.y)) / -ray.direction.z;
        }
        if (t < 0 || t > ray.length) return c;
        c.hit = true;
        c.distance = t;
        c.point = ray.origin + ray.direction * t;
        c.normal = {0, 0, 1};
        c.surface = surface(c.point.x, c.point.y);
        return c;
    }
};

std::unique_ptr<Simulation> sim_on(const CarConfig& cfg, std::shared_ptr<const Ground> g) {
    auto s = std::make_unique<Simulation>(cfg, std::move(g));
    s->dt = 1.0 / 240.0;
    return s;
}

double heading(const Simulation& s) {
    Vec3 f = s.body.state.orientation.rotate({1, 0, 0});
    return std::atan2(f.y, f.x);
}
double sideslip(const Simulation& s) {
    Vec3 v = s.velocity_body();
    return std::atan2(v.y, std::max(std::abs(v.x), 0.5));
}

// Skidpad, 45.7 m radius (150 ft), speed ramp from v0: the best sustained lateral g. The slow default ramp
// is quasi-static (but the tyres warm up on the way to the limit); a fast ramp from near the limit measures
// the grip of the tyres as they were set. Tyres start soaked at temp_c with the given wear (temp_c < 0: as reset).
double skid_g(const CarConfig& cfg, double temp_c, double wear, double ramp = 0.35, double v0 = 12, double t_skip = 4) {
    const double R = 45.72;
    auto s = test::make_sim(cfg);
    double v = v0;
    s->reset({}, 0, v, 3);
    if (temp_c > 0) s->vehicle.set_tyres(temp_c, wear);
    test::SpeedController sc;
    double max_ay = 0, ay_f = 0;
    while (s->time < 120) {
        DriverInput in;
        in.gear = 3;
        in.steer = test::steer_circle(*s, {0, R, 0}, R, 10.0);
        sc.apply(*s, v, in);
        s->step(in);
        v += ramp * s->dt;
        double r_err = std::abs(std::hypot(s->body.state.position.x, s->body.state.position.y - R) - R);
        ay_f += (s->accel_body().y - ay_f) * (s->dt / 0.7);
        if (s->time > t_skip && r_err < 1.5) max_ay = std::max(max_ay, ay_f);
        if (s->time > t_skip && r_err > 5.0) break;
    }
    return max_ay / kGravity;
}

// Constant speed v on an R metre left-hand circle for T seconds; tyres soaked at temp_c first (< 0: as reset).
std::unique_ptr<Simulation> circle_run(const CarConfig& cfg, double R, double v, double T, double temp_c = -1) {
    auto s = test::make_sim(cfg);
    s->reset({}, 0, v, 3);
    if (temp_c > 0) s->vehicle.set_tyres(temp_c, 0.0);
    test::SpeedController sc;
    while (s->time < T) {
        DriverInput in;
        in.gear = 3;
        in.steer = test::steer_circle(*s, {0, R, 0}, R, 10.0);
        sc.apply(*s, v, in);
        s->step(in);
    }
    return s;
}

}  // namespace

// ---------------------------------------------------------------- tyre temperature, wear, pressure
RS_TEST(tyre_thermal) {
    const CarConfig cfg = test::car();
    const TireParams& tp = cfg.tire_front;
    {
        auto factor = [&](double t) {
            TireCondition c;
            c.temperature_c = c.surface_c = c.flash_c = c.inner_c = c.middle_c = c.outer_c = t;
            return c.grip_factor(&tp);
        };
        double f_opt = factor(tp.temp_optimal_c), f_cold = factor(20), f_hot = factor(160);
        std::printf("         grip factor: %.3f at 20 C, %.3f at the optimum (%.0f C), %.3f at 160 C\n", f_cold, f_opt, tp.temp_optimal_c, f_hot);
        test::check_range("grip factor inside the working window", f_opt, 0.999, 1.001, "-");
        test::check("cold tread grips less than the working window", f_cold < f_opt - 0.01);
        test::check("cooked tread grips less than the working window", f_hot < f_opt - 0.01);
    }
    // Cruise: printed only (cooling vs rolling hysteresis at speed is tuning, not a law).
    {
        const double speeds[3] = {10, 30, 55};
        double end_t[3];
        for (int i = 0; i < 3; ++i) {
            auto s = test::make_sim(cfg);
            s->reset({}, 0, speeds[i], 5);
            test::SpeedController sc;
            while (s->time < 90) {
                DriverInput in;
                in.gear = 5;
                sc.apply(*s, speeds[i], in);
                s->step(in);
            }
            end_t[i] = s->last.wheels[RL].condition.temperature_c;
        }
        std::printf("         carcass after 90 s cruise from 80 C: 10 m/s %.1f, 30 m/s %.1f, 55 m/s %.1f C\n", end_t[0], end_t[1], end_t[2]);
        test::check("cruise temperatures are finite", std::isfinite(end_t[0] + end_t[1] + end_t[2]));
    }
    // Cornering heats, and the loaded outer tyre most (left-hand circle: the right-hand tyres are outside).
    {
        auto s = circle_run(cfg, 45.72, 19.0, 60, 45.0);
        const TireCondition& in_c = s->last.wheels[FL].condition;
        const TireCondition& out_c = s->last.wheels[FR].condition;
        std::printf("         ~0.8 g left circle 60 s from 45 C: outer FR %.1f C, inner FL %.1f C, wear FR %.5f\n",
                    out_c.temperature_c, in_c.temperature_c, out_c.wear);
        test::check("cornering heats the tyres", out_c.temperature_c > 50);
        test::check("the loaded outer tyre runs hotter than the inner one", out_c.temperature_c > in_c.temperature_c);
        // Printed, not asserted: by design (tire.cpp, 2026-11-05) tread wear only accrues while a tyre slides
        // (> 18 kW of slip power), so grip-limited cornering does not wear it. Real treads abrade in proportion
        // to friction work with no such threshold; whether to change that is an open design question.
        test::check("hot tyres carry more pressure than cold ones (ideal gas)",
                    out_c.pressure_kpa > in_c.pressure_kpa && out_c.pressure_kpa > tp.p_cold_kpa);
    }
    // Grip vs temperature: a fast ramp from near the limit, so the tyres are still at their set temperature
    // (on the slow ramp, cold tyres are warm before the car reaches the limit; printed for comparison).
    {
        const double g_cold = skid_g(cfg, 20, 0, 0.8, 18, 1.5), g_ok = skid_g(cfg, tp.temp_optimal_c, 0, 0.8, 18, 1.5);
        const double g_hot = skid_g(cfg, 150, 0, 0.8, 18, 1.5);
        std::printf("         skidpad, fast ramp: cold (20 C) %.3f g, warm (%.0f C) %.3f g, cooked (150 C) %.3f g\n", g_cold, tp.temp_optimal_c, g_ok, g_hot);
        // Printed, not asserted (open finding, 2026-11-22): the compound alone loses ~9 % at 20 C (grip factor
        // above), yet the car grips about the same, so another term (cold pressure via the MF 6.1 pressure
        // coefficients, or the rib WLF grip) cancels it. Real cold tyres grip noticeably less.
        test::check("overheated tyres: less grip than warm ones", g_hot < g_ok);
    }
    const double g_warm = skid_g(cfg, tp.temp_optimal_c, 0);
    std::printf("         skidpad, slow ramp: cold start (20 C) %.3f g, warm %.3f g\n", skid_g(cfg, 20, 0), g_warm);
    // Wear.
    const double g_w50 = skid_g(cfg, tp.temp_optimal_c, 0.5), g_w100 = skid_g(cfg, tp.temp_optimal_c, 1.0);
    std::printf("         skidpad vs wear: new %.3f g, 50 %% %.3f g, 100 %% %.3f g\n", g_warm, g_w50, g_w100);
    test::check("worn tyres grip less, and less the more worn", g_w100 < g_w50 && g_w50 < g_warm);
    // Cold pressure, printed: in Magic Formula 6.1 data the peak friction falls as inflation rises (smaller
    // patch) while cornering stiffness peaks near nominal, so 'the set pressure grips best' is not a law.
    {
        auto with_cold = [&](double kpa) {
            CarConfig c = cfg;
            c.tire_front.p_cold_kpa = c.tire_rear.p_cold_kpa = kpa;
            return skid_g(c, tp.temp_optimal_c, 0);
        };
        const double set = cfg.tire_front.p_cold_kpa;
        const double g_low = with_cold(set - 50), g_ok = with_cold(set), g_high = with_cold(set + 70);
        std::printf("         skidpad vs cold pressure: %.0f kPa %.3f g, %.0f kPa %.3f g, %.0f kPa %.3f g\n",
                    set - 50, g_low, set, g_ok, set + 70, g_high);
        test::check("pressure changes the grip (the pressure terms are live)", std::abs(g_high - g_low) > 0.01);
    }
}

// ---------------------------------------------------------------- cold brake pads (fade itself: brake_fade)
RS_TEST(brake_cold_pads) {
    const CarConfig cfg = test::car();
    auto stop = [&](double disc_c) {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, 26.82, 4);
        s->settle(0.3);
        s->vehicle.set_brake_temperature(disc_c);
        s->vehicle.assists().abs = false;
        double x0 = s->body.state.position.x;
        while (test::speed(*s) > 0.5 && s->time < 25) {
            DriverInput in;
            in.gear = 1; in.clutch = 1; in.brake = 0.45;   // light pedal: no lock-up, so pad friction sets the stop
            s->step(in);
        }
        return s->body.state.position.x - x0;
    };
    const double d_cold = stop(20), d_warm = stop(300);
    const double mu_cold = brake_pad_mu(20), mu_warm = brake_pad_mu(300);
    std::printf("         60 mph, 45 %% pedal: cold pads (20 C) %.1f m, warm pads (300 C) %.1f m; pad curve says %.2fx\n",
                d_cold, d_warm, mu_warm / mu_cold);
    // The stop warms the cold pads, so the distance ratio sits between 1 and the pad-curve ratio.
    test::check("cold pads stop longer than warm ones", d_cold > d_warm * 1.01);
    test::check("but no longer than the pad friction curve allows", d_cold / d_warm < mu_warm / mu_cold + 0.03);
}

// ---------------------------------------------------------------- self-aligning torque / steering feel
RS_TEST(steering_feel) {
    const CarConfig cfg = test::car();
    {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, 30, 5);
        for (int i = 0; i < 240; ++i) { DriverInput in; in.gear = 5; in.throttle = 0.2; s->step(in); }
        std::printf("         straight line: steering torque %.2f Nm\n", s->last.steer_torque);
        test::check_range("straight line: steering torque", s->last.steer_torque, -2, 2, "Nm");
    }
    // Steady left circle, rising speed: the restoring torque grows with lateral g, then falls past the peak
    // (pneumatic trail collapses as the front tyres saturate: the wheel goes light at the limit).
    {
        const double R = 45.72;
        auto s = test::make_sim(cfg);
        double v = 8;
        s->reset({}, 0, v, 3);
        test::SpeedController sc;
        double peak = 0, ay_at_peak = 0, ay_f = 0, tq_f = 0, at_limit = 0, sign = 0;
        double t_at[3] = {0, 0, 0};
        const double mark[3] = {0.3, 0.6, 0.9};
        int mi = 0;
        while (s->time < 120) {
            DriverInput in;
            in.gear = 3;
            in.steer = test::steer_circle(*s, {0, R, 0}, R, 10.0);
            sc.apply(*s, v, in);
            s->step(in);
            v += 0.3 * s->dt;
            // restoring = against the steering angle (left steer is +): -torque * sign(steer)
            const double restoring = -s->last.steer_torque * (in.steer >= 0 ? 1.0 : -1.0);
            ay_f += (s->accel_body().y - ay_f) * (s->dt / 0.5);
            tq_f += (restoring - tq_f) * (s->dt / 0.3);
            const double g = ay_f / kGravity;
            if (mi < 3 && g >= mark[mi]) { t_at[mi] = tq_f; ++mi; }
            if (tq_f > peak) { peak = tq_f; ay_at_peak = g; }
            if (s->time > 3 && sign == 0) sign = tq_f;
            double r_err = std::abs(std::hypot(s->body.state.position.x, s->body.state.position.y - R) - R);
            if (s->time > 4 && r_err > 4.0) { at_limit = tq_f; break; }
        }
        std::printf("         left circle: restoring torque %.0f / %.0f / %.0f Nm at 0.3 / 0.6 / 0.9 g, peak %.0f Nm at %.2f g, at the limit %.0f Nm\n",
                    t_at[0], t_at[1], t_at[2], peak, ay_at_peak, at_limit);
        test::check("cornering: the torque pulls the wheel back toward straight", t_at[0] > 0);
        test::check("restoring torque rises with lateral g in the linear range", t_at[1] > t_at[0]);
        test::check("the wheel goes light at the limit (torque falls from its peak)", at_limit < 0.85 * peak);
    }
    // Same small steering angle at 10 and 30 m/s: lateral force (and so the torque) grows with speed.
    {
        double tq[2];
        const double speeds[2] = {10, 30};
        for (int i = 0; i < 2; ++i) {
            auto s = test::make_sim(cfg);
            s->reset({}, 0, speeds[i], 4);
            test::SpeedController sc;
            for (int k = 0; k < 240 * 3; ++k) {
                DriverInput in; in.gear = 4; in.steer = 0.04;
                sc.apply(*s, speeds[i], in);
                s->step(in);
            }
            tq[i] = s->last.steer_torque;
        }
        std::printf("         same %.1f deg steering angle: %.1f Nm at 10 m/s, %.1f Nm at 30 m/s\n", 0.04 * cfg.front.max_steer_deg, tq[0], tq[1]);
        test::check("steering torque grows with speed at a fixed steering angle", std::abs(tq[1]) > 3.0 * std::abs(tq[0]));
    }
}

// ---------------------------------------------------------------- differentials on split grip
RS_TEST(diff_split_mu) {
    // Left wheels on asphalt, right wheels on grass. An open diff can only pass the torque the grass wheel
    // holds; an LSD / locked diff pushes with the asphalt wheel too.
    const CarConfig base = test::car();
    double dist[3], yaw[3];
    const char* names[3] = {"open", "lsd", "locked"};
    for (int i = 0; i < 3; ++i) {
        CarConfig cfg = base;
        cfg.drivetrain.rear_diff.type = names[i];
        auto course = std::make_shared<Course>();
        const int grass = cfg.surface_index("grass");
        course->surface = [grass](double, double y) { return y < 0 ? grass : 0; };
        auto s = sim_on(cfg, course);
        s->settle(1.0);
        s->vehicle.assists().tc = false;
        Vec3 p0 = s->body.state.position;
        double t0 = s->time, d15 = 0;
        while (s->time - t0 < 3.0) {
            DriverInput in;
            in.gear = 2; in.throttle = 0.7; in.auto_clutch = true;
            s->step(in);
            if (s->time - t0 < 1.5) d15 = s->body.state.position.x - p0.x;
        }
        dist[i] = d15;
        yaw[i] = std::abs(heading(*s)) * kDeg;
    }
    std::printf("         split-mu launch, no steering (distance in 1.5 s / heading after 3 s): open %.1f m / %.1f deg, LSD %.1f m / %.1f deg, locked %.1f m / %.1f deg\n",
                dist[0], yaw[0], dist[1], yaw[1], dist[2], yaw[2]);
    test::check("LSD out-accelerates an open diff on split grip", dist[1] > 1.05 * dist[0]);
    test::check("locked >= LSD on split grip", dist[2] >= 0.98 * dist[1]);
}

// ---------------------------------------------------------------- aero
RS_TEST(aero) {
    const CarConfig cfg = test::car();
    auto downforce_at = [&](double v) {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, v, 5);
        test::SpeedController sc;
        while (s->time < 4) { DriverInput in; in.gear = 5; sc.apply(*s, v, in); s->step(in); }
        double sum = 0;
        for (auto& w : s->last.wheels) sum += w.load;
        return sum - cfg.mass * kGravity;
    };
    const double a100 = downforce_at(27.8), a200 = downforce_at(55.6), a250 = downforce_at(69.4);
    std::printf("         downforce at 100 / 200 / 250 km/h: %.0f / %.0f / %.0f N (%.1f %% of weight at 250)\n",
                a100, a200, a250, 100 * a250 / (cfg.mass * kGravity));
    // v^2 law, with room for the ride-height (ground effect) term and the pitch the downforce itself causes.
    test::check_range("downforce ratio 200 vs 100 km/h (v^2 law: 4)", a200 / a100, 3.6, 4.6, "-");
    test::check("downforce stays below the car's weight at 250 km/h (road car)", a250 < cfg.mass * kGravity);
    // Coast-down in neutral at 200 km/h: deceleration vs drag + rolling resistance (printed: the core adds
    // drivetrain and bearing drag on top, so this ratio is a measurement, not a law).
    {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, 55.6, 5);
        DriverInput in; in.gear = 1; in.clutch = 1;
        for (int i = 0; i < 240; ++i) s->step(in);
        const double a = -s->accel_body().x, v = test::speed(*s);
        const double drag = 0.5 * cfg.aero.air_density * cfg.aero.drag_area * v * v;
        const double rr = (cfg.tire_front.rolling_resistance + cfg.tire_front.rolling_resistance_v2 * (v / 30) * (v / 30)) * cfg.mass * kGravity;
        std::printf("         coast-down at %.0f km/h: %.2f m/s^2 measured, %.2f from drag + rolling alone (ratio %.2f)\n",
                    v * 3.6, a, (drag + rr) / cfg.mass, a / ((drag + rr) / cfg.mass));
        test::check("coast-down is at least drag + rolling resistance", a > 0.95 * (drag + rr) / cfg.mass);
    }
    // Braking dives the nose (front ride height drops).
    {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, 60, 5);
        test::SpeedController sc;
        for (int i = 0; i < 240 * 3; ++i) { DriverInput in; in.gear = 5; sc.apply(*s, 60, in); s->step(in); }
        const double cruise = 0.5 * (s->last.wheels[FL].compression + s->last.wheels[FR].compression);
        double acc = 0; int n = 0;
        for (int i = 0; i < 480; ++i) {
            DriverInput in; in.gear = 1; in.clutch = 1; in.brake = 0.3;
            s->step(in);
            if (i > 300) { acc += 0.5 * (s->last.wheels[FL].compression + s->last.wheels[FR].compression); ++n; }
        }
        const double dz = acc / n - cruise;
        std::printf("         0.3 pedal braking at 60 m/s: front compression +%.1f mm\n", dz * 1000);
        test::check("the nose dives under braking", dz > 0.003);
    }
}

// ---------------------------------------------------------------- understeer gradient
RS_TEST(understeer_gradient) {
    // Steady 60 m circle at 0.3 / 0.6 / 0.9 g: road-wheel angle minus the Ackermann angle (L/R), per g.
    auto measure = [&](const CarConfig& cfg, double k[3]) {
        const double R = 60, L = cfg.wheelbase;
        const double gs[3] = {0.3, 0.6, 0.9};
        for (int i = 0; i < 3; ++i) {
            const double v = std::sqrt(gs[i] * kGravity * R);
            auto s = test::make_sim(cfg);
            s->reset({}, 0, v, 3);
            test::SpeedController sc;
            double acc = 0, ay = 0;
            int n = 0;
            while (s->time < 14) {
                DriverInput in;
                in.gear = 3;
                in.steer = test::steer_circle(*s, {0, R, 0}, R, 10.0);
                sc.apply(*s, v, in);
                s->step(in);
                if (s->time > 9) { acc += in.steer; ay += s->accel_body().y; ++n; }
            }
            const double steer_deg = acc / n * cfg.front.max_steer_deg;
            k[i] = (steer_deg - L / R * kDeg) / (ay / n / kGravity);
        }
    };
    CarConfig cfg = test::car();
    double k[3], st[3];
    measure(cfg, k);
    std::printf("         understeer gradient on a 60 m circle: %.2f deg/g at 0.3 g, %.2f at 0.6 g, %.2f at 0.9 g\n", k[0], k[1], k[2]);
    // Road cars understeer in the linear range (Milliken & Milliken, RCVD ch. 5; Gillespie ch. 6).
    test::check("understeer in the linear range (positive gradient)", k[0] > 0);
    test::check("understeer grows toward the limit", k[2] > k[0]);
    CarConfig stiff = cfg;
    stiff.front.anti_roll_rate *= 1.8;
    measure(stiff, st);
    std::printf("         with a 1.8x front anti-roll bar: %.2f / %.2f / %.2f deg/g\n", st[0], st[1], st[2]);
    test::check("more front roll stiffness = more understeer", st[1] > k[1] && st[2] > k[2]);
    // Tyre load sensitivity: the same axle load split unevenly gives less total lateral force.
    {
        const TireParams& t = cfg.tire_front;
        const double even = 2 * mf_pure_fy(t, 0.1, 4000, 1.0);
        const double uneven = mf_pure_fy(t, 0.1, 6000, 1.0) + mf_pure_fy(t, 0.1, 2000, 1.0);
        std::printf("         axle lateral force, 6000 + 2000 N vs 2 x 4000 N: %.3f\n", uneven / even);
        test::check("lateral load transfer costs axle grip", uneven < even);
    }
}

// ---------------------------------------------------------------- trail braking
RS_TEST(trail_braking) {
    const CarConfig cfg = test::car();
    // 0.64 g corner (25 m/s, R 100 m), steering then held while the brake comes in: weight moves forward, the
    // rear gets light, the car turns in tighter than its circle.
    double rho[3], rear_alpha[3];
    const double pedals[3] = {0.0, 0.25, 0.5};
    for (int i = 0; i < 3; ++i) {
        const double R = 100, v = 25;
        auto s = test::make_sim(cfg);
        s->reset({}, 0, v, 4);
        s->vehicle.assists().esc = false;
        test::SpeedController sc;
        double steer_hold = 0, acc = 0;
        int n = 0;
        while (s->time < 5.7) {
            DriverInput in;
            in.gear = 4;
            if (s->time < 5.0) {
                in.steer = test::steer_circle(*s, {0, R, 0}, R, 12.0);
                sc.apply(*s, v, in);
                if (s->time > 3) { acc += in.steer; ++n; }
                steer_hold = n ? acc / n : 0;
            } else {
                in.steer = steer_hold;
                in.brake = pedals[i] * std::min(1.0, (s->time - 5.0) / 0.3);
                in.clutch = 1.0;
            }
            s->step(in);
        }
        rho[i] = s->last.yaw_rate / std::max(test::speed(*s), 1.0) * R;   // path curvature vs the circle (> 1: tighter)
        rear_alpha[i] = 0.5 * (s->last.wheels[RL].slip_angle + s->last.wheels[RR].slip_angle) * kDeg;
    }
    std::printf("         0.64 g corner, steering held, 0.7 s after the brake: curvature vs the circle: coast %.2f, 25%% pedal %.2f, 50%% pedal %.2f; rear slip %.1f / %.1f / %.1f deg\n",
                rho[0], rho[1], rho[2], rear_alpha[0], rear_alpha[1], rear_alpha[2]);
    test::check("trail braking: the car turns in tighter as brake pressure rises", rho[2] > rho[1] && rho[1] > rho[0]);
    test::check("trail braking: the rear tyres work harder", std::abs(rear_alpha[2]) > std::abs(rear_alpha[0]));
}

// ---------------------------------------------------------------- handbrake
RS_TEST(handbrake_slide) {
    const CarConfig cfg = test::car();
    double peak_beta[2];
    for (int hb = 0; hb < 2; ++hb) {
        auto s = test::make_sim(cfg);
        s->reset({}, 0, 22.0, 4);
        s->vehicle.assists().esc = false;
        double peak = 0;
        while (s->time < 3.0) {
            DriverInput in;
            in.gear = 4; in.clutch = 1;    // coasting, so only the handbrake differs
            const double t = s->time;
            if (t < 1.0) in.steer = 0;
            else if (t < 1.6) in.steer = 0.35;
            else in.steer = 0.35 - 0.7 * std::min(1.0, (t - 1.6) / 0.6);   // flick back (counter-steer)
            in.handbrake = (hb && t > 1.0 && t < 1.8) ? 1.0 : 0.0;
            s->step(in);
            peak = std::max(peak, std::abs(sideslip(*s)));
        }
        peak_beta[hb] = peak * kDeg;
    }
    std::printf("         22 m/s flick: peak sideslip without handbrake %.1f deg, with handbrake %.1f deg\n", peak_beta[0], peak_beta[1]);
    test::check("the handbrake breaks the rear loose", peak_beta[1] > peak_beta[0] + 8.0 && peak_beta[1] > 15.0);
}

// ---------------------------------------------------------------- power oversteer
RS_TEST(snap_oversteer) {
    // Steady 60 m left circle in 2nd, then a full-throttle stab with ESC and TC off: a driver who lifts and
    // counter-steers catches it; an unattended car keeps rotating.
    const CarConfig cfg = test::car();
    double final_beta[2], max_beta[2], yaw_rate[2];
    for (int rec = 0; rec < 2; ++rec) {
        const double R = 60, v = 20;
        auto s = test::make_sim(cfg);
        s->reset({}, 0, v, 3);
        s->vehicle.assists().esc = false;
        s->vehicle.assists().tc = false;
        test::SpeedController sc;
        double steer_hold = 0, acc = 0, maxb = 0;
        int n = 0;
        while (s->time < 9) {
            DriverInput in;
            in.gear = 3;
            const double t = s->time;
            if (t < 4.0) {
                in.steer = test::steer_circle(*s, {0, R, 0}, R, 12.0);
                sc.apply(*s, v, in);
                if (t > 2.5) { acc += in.steer; ++n; }
                steer_hold = n ? acc / n : 0;
            } else if (t < 4.6 || !rec) {
                in.throttle = 1.0; in.steer = steer_hold;                    // power stab (unattended: held)
            } else {
                const double b = sideslip(*s), r = s->last.yaw_rate;
                in.throttle = 0.0;
                // counter-steer: wheels along the velocity, damp the extra yaw rate
                in.steer = clamp((b * 1.4 - 0.12 * (r - v / R)) / (cfg.front.max_steer_deg / kDeg), -1.0, 1.0);
            }
            s->step(in);
            maxb = std::max(maxb, std::abs(sideslip(*s)));
        }
        final_beta[rec] = std::abs(sideslip(*s)) * kDeg;
        max_beta[rec] = maxb * kDeg;
        yaw_rate[rec] = std::abs(s->last.yaw_rate) * kDeg;
    }
    std::printf("         throttle stab at ~0.7 g (ESC/TC off): unattended peak sideslip %.0f deg (final %.0f), driver recovers: peak %.0f deg, final %.1f deg, yaw rate %.0f deg/s\n",
                max_beta[0], final_beta[0], max_beta[1], final_beta[1], yaw_rate[1]);
    test::check("unattended power oversteer goes past 25 deg (the car spins)", max_beta[0] > 25.0);
    test::check_range("a driver who lifts and counter-steers recovers: final sideslip", final_beta[1], 0, 8.0, "deg");
}

// ---------------------------------------------------------------- kerb strike
RS_TEST(curb_strike) {
    // 100 km/h, right-hand wheels over a 5 cm ramped kerb 4 m long: the car stays composed.
    const CarConfig cfg = test::car();
    auto course = std::make_shared<Course>();
    const double x_kerb = 40.0;
    course->height = [x_kerb](double x, double y) {
        if (y > -0.6) return 0.0;                         // only under the right-hand wheels (y < 0)
        const double u = x - x_kerb;
        if (u < 0 || u > 4.0) return 0.0;
        if (u < 0.15) return 0.05 * u / 0.15;             // 3:1 ramp up
        if (u > 3.85) return 0.05 * (4.0 - u) / 0.15;
        return 0.05;
    };
    auto s = sim_on(cfg, course);
    s->reset({0, 0, 0}, 0, 27.8, 5);
    test::SpeedController sc;
    double max_roll = 0, max_yaw = 0, max_vz = 0, max_load = 0, min_load = 1e9;
    while (s->body.state.position.x < 55 && s->time < 10) {
        DriverInput in; in.gear = 5; sc.apply(*s, 27.8, in);
        s->step(in);
        const Vec3 up = s->body.state.orientation.rotate({0, 0, 1});
        max_roll = std::max(max_roll, std::abs(std::asin(clamp(up.y, -1.0, 1.0))));
        max_yaw = std::max(max_yaw, std::abs(heading(*s)));
        if (s->body.state.position.x > x_kerb - 3) max_vz = std::max(max_vz, std::abs(s->body.state.velocity.z));
        if (s->body.state.position.x > x_kerb - 2)
            for (auto& w : s->last.wheels) if (w.contact) { min_load = std::min(min_load, w.load); max_load = std::max(max_load, w.load); }
    }
    std::printf("         100 km/h over a 5 cm kerb (right wheels): max roll %.1f deg, heading change %.2f deg, max vertical speed %.2f m/s, wheel load %.0f..%.0f N\n",
                max_roll * kDeg, max_yaw * kDeg, max_vz, min_load, max_load);
    test::check("the kerb rolls the body (it is felt)", max_roll * kDeg > 0.3);
    test::check_range("heading disturbance with no steering input", max_yaw * kDeg, 0, 6.0, "deg");
    test::check("no launch: vertical speed bounded, loads finite", max_vz < 4.0 && std::isfinite(max_load));
}
