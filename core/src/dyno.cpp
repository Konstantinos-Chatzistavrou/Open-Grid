#include "rs/dyno.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

namespace {
// A shift dumps the spinning engine's energy into the wheels as the clutch closes (and the power dips while it is open): like
// dyno software, ignore the first seconds of every gear and smooth the power with a first-order filter.
constexpr double kShiftHoldoffS = 2.0;   // s ignored after every gear change (the filter below has settled by then)
constexpr double kSmoothS = 0.5;         // s, time constant of the power (and rpm) smoothing
}  // namespace

// ---------------------------------------------------------------- road
DynoRoad::DynoRoad(const CarConfig& cfg) {
    body_.mass = cfg.mass;
    body_.inertia = {cfg.inertia_xx, cfg.inertia_yy, cfg.inertia_zz};
}

void DynoRoad::reset(Vehicle& v) {
    body_.state = ChassisState{};
    body_.state.position = {0, 0, v.config().cg_height};
    v.reset_motion(0.0, -1);
    distance_ = 0;
}

std::array<WheelContact, 4> DynoRoad::contacts(const Vehicle& v) const {
    std::array<WheelContact, 4> c;
    const auto rays = v.wheel_rays(body_.state);
    for (int i = 0; i < 4; ++i) c[i] = ground_.raycast(rays[i]);
    return c;
}

void DynoRoad::integrate(const VehicleOutput& out, double dt) {
    if (out.mass_kg > 0) body_.mass = out.mass_kg;
    if (out.effective_inertia.x > 0) body_.inertia = out.effective_inertia;
    const Vec3 f = out.force + Vec3{0, 0, -kGravity * body_.mass};
    body_.integrate(f, out.torque, dt);
    // straps: the car heads along +X and cannot move sideways, yaw or roll (it may squat and pitch on its springs)
    ChassisState& s = body_.state;
    s.velocity.y = 0;
    s.position.y = 0;
    s.angular_velocity.x = 0;
    s.angular_velocity.z = 0;
    const Vec3 fwd = s.orientation.rotate({1, 0, 0});
    const double pitch = std::atan2(-fwd.z, std::hypot(fwd.x, fwd.y));
    s.orientation = Quat::from_axis_angle({0, 1, 0}, pitch);
    distance_ += std::abs(s.velocity.x) * dt;
    s.position.x = 0;   // the road is endless and flat: only the speed matters, so the body stays over the rollers
}

// ---------------------------------------------------------------- meter
DynoMeter::DynoMeter(const CarConfig& cfg) {
    driven_.resize(4);
    for (int w = 0; w < 4; ++w) driven_[w] = cfg.axle(w).driven;
    efficiency_ = std::max(cfg.drivetrain.efficiency, 0.1);
    redline_ = cfg.engine.redline_rpm;
    reset();
}

void DynoMeter::reset() {
    curve_.assign((std::size_t)std::ceil(std::max(redline_, 1000.0) / 100.0) + 2, DynoPoint{});
    for (std::size_t i = 0; i < curve_.size(); ++i) curve_[i].rpm = 100.0 * (double)i;
    peak_p_ = peak_p_rpm_ = peak_t_ = peak_t_rpm_ = 0;
    last_gear_ = -99;
    holdoff_ = power_f_ = rpm_f_ = 0;
    top_speed_ = max_speed_ = steady_t_ = prev_speed_ = accel_f_ = 0;
    run_t_ = t100_ = -1;
    rpm = speed_mps = wheel_force_n = wheel_power_w = crank_torque_nm = 0;
}

void DynoMeter::sample(const VehicleOutput& out, double engine_rpm, double dt, double driver_throttle) {
    if (dt <= 0) return;
    rpm = engine_rpm;
    speed_mps = out.speed;
    wheel_force_n = 0;
    for (int w = 0; w < 4; ++w) if (driven_[w]) wheel_force_n += out.wheels[w].fx;
    wheel_power_w = wheel_force_n * speed_mps;
    const double omega_e = engine_rpm * 2.0 * kPi / 60.0;
    crank_torque_nm = omega_e > 50.0 ? wheel_power_w / (efficiency_ * omega_e) : 0.0;

    const bool full = out.throttle_applied > 0.95 && out.gear >= 2;
    if (out.gear != last_gear_) { holdoff_ = kShiftHoldoffS; last_gear_ = out.gear; }
    holdoff_ = std::max(0.0, holdoff_ - dt);
    const double k = std::min(1.0, dt / kSmoothS);
    if (rpm_f_ <= 0) rpm_f_ = engine_rpm;
    power_f_ += (wheel_power_w - power_f_) * k;
    // The engine rpm goes through the SAME filter: during a pull the rpm climbs thousands per minute every second, so the
    // smoothed power lags the live rpm by about kSmoothS, and binning it against the live rpm put every reading ~0.5 s of
    // revs too high (a low peak power and torque, read at too high an rpm). Power and rpm smoothed alike belong together.
    rpm_f_ += (engine_rpm - rpm_f_) * k;
    const double omega_f = rpm_f_ * 2.0 * kPi / 60.0;
    // curve: best steady full-throttle reading per 100 rpm bin
    if (full && holdoff_ <= 0 && power_f_ > 0 && rpm_f_ > 500) {
        const double crank = omega_f > 50.0 ? power_f_ / (efficiency_ * omega_f) : 0.0;
        const std::size_t bin = std::min(curve_.size() - 1, (std::size_t)std::lround(rpm_f_ / 100.0));
        DynoPoint& p = curve_[bin];
        if (power_f_ > p.wheel_power_w) {
            p.wheel_power_w = power_f_;
            p.crank_torque_nm = crank;
        }
        if (power_f_ > peak_p_) { peak_p_ = power_f_; peak_p_rpm_ = rpm_f_; }
        if (crank > peak_t_) { peak_t_ = crank; peak_t_rpm_ = rpm_f_; }
    }
    // top speed: pedal flat and the speed has stopped rising (< 0.03 m/s^2 for 3 s), also when that is on the limiter
    const bool pedal_full = (driver_throttle >= 0 ? driver_throttle : out.throttle_applied) > 0.95 && out.gear >= 2;
    const double a = (speed_mps - prev_speed_) / dt;
    prev_speed_ = speed_mps;
    accel_f_ += (a - accel_f_) * std::min(1.0, dt / 2.0);   // 2 s: averages out the limiter bounce at top speed
    max_speed_ = std::max(max_speed_, speed_mps);
    if (pedal_full && speed_mps > 10.0 && std::abs(accel_f_) < 0.03) {
        steady_t_ += dt;
        if (steady_t_ > 3.0) top_speed_ = std::max(top_speed_, speed_mps);
    } else {
        steady_t_ = 0;
    }
    // 0-100 km/h from rest
    if (speed_mps < 0.3 && out.throttle_applied < 0.05) run_t_ = 0;
    else if (run_t_ >= 0) {
        run_t_ += dt;
        if (t100_ < 0 && speed_mps >= 100.0 / 3.6) t100_ = run_t_;
    }
}

}  // namespace rs
