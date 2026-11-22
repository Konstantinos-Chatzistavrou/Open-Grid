// Chassis dynamometer (road-load), engine-neutral: the web garage and Unreal 5.8 put a car on rollers and run the SAME
// Vehicle as on the road. A road-load dyno's absorber makes the rollers resist like the road does (the car's inertia,
// rolling resistance and air drag), so the car revs, shifts, sounds and reaches its top speed exactly as it would
// driving - only the body stays in the garage.
//
//   DynoRoad   the flat virtual road under the car: the body moves on it (the host keeps the visual model still);
//              the straps stop any sideways motion, yaw and roll.
//   DynoMeter  what the rollers measure: tractive force x speed at the driven tyres (wheel power), a power / torque
//              curve against engine rpm from full-throttle pulls, peaks, top speed and 0-100 km/h.
//
// Host loop (per physics step):  contacts = road.contacts(v);  out = v.update(road.state(), contacts, dt);
//                                road.integrate(out, dt);  meter.sample(out, v.engine_rpm(), dt);
#pragma once
#include <array>
#include <vector>
#include "rs/sim.hpp"

namespace rs {

class DynoRoad {
public:
    explicit DynoRoad(const CarConfig& cfg);
    /** At rest on the rollers at static ride height; resets the vehicle's motion (wheels, tyres, gearbox state). */
    void reset(Vehicle& v);
    const ChassisState& state() const { return body_.state; }
    /** Flat asphalt under each wheel. */
    std::array<WheelContact, 4> contacts(const Vehicle& v) const;
    /** Advance the body with the vehicle's forces; straps: no sideways motion, no yaw or roll. The body stays at
     *  x = 0 (over the rollers); its velocity is the road speed. */
    void integrate(const VehicleOutput& out, double dt);
    /** Distance the rollers have turned (m). */
    double distance_m() const { return distance_; }

private:
    RigidBody body_;
    PlaneGround ground_;
    double distance_ = 0;
};

struct DynoPoint {
    double rpm = 0;              // engine rpm (bin centre)
    double wheel_power_w = 0;    // at the rollers
    double crank_torque_nm = 0;  // estimate: wheel power / (drivetrain efficiency x engine angular speed)
};

class DynoMeter {
public:
    explicit DynoMeter(const CarConfig& cfg);
    void reset();
    /** driver_throttle: the pedal (the limiter cuts throttle_applied while the car sits at its top speed on the limiter);
     *  < 0 uses throttle_applied. */
    void sample(const VehicleOutput& out, double engine_rpm, double dt, double driver_throttle = -1);

    // live readings
    double rpm = 0, speed_mps = 0, wheel_force_n = 0, wheel_power_w = 0, crank_torque_nm = 0;
    // results
    const std::vector<DynoPoint>& curve() const { return curve_; }   // 100 rpm bins, best full-throttle reading
    double peak_wheel_power_w() const { return peak_p_; }
    double peak_power_rpm() const { return peak_p_rpm_; }
    double peak_crank_torque_nm() const { return peak_t_; }
    double peak_torque_rpm() const { return peak_t_rpm_; }
    double top_speed_mps() const { return top_speed_; }   // speed where full throttle no longer accelerates the car
    double max_speed_mps() const { return max_speed_; }
    double zero_to_100_s() const { return t100_; }          // < 0 until a run from rest has reached 100 km/h

private:
    std::vector<bool> driven_;
    double efficiency_ = 0.92, redline_ = 7000;
    std::vector<DynoPoint> curve_;
    double peak_p_ = 0, peak_p_rpm_ = 0, peak_t_ = 0, peak_t_rpm_ = 0;
    double top_speed_ = 0, max_speed_ = 0, steady_t_ = 0, prev_speed_ = 0, accel_f_ = 0;
    double run_t_ = -1, t100_ = -1;
    int last_gear_ = -99;
    double holdoff_ = 0, power_f_ = 0;   // shift hold-off (s) and smoothed wheel power
};

}  // namespace rs
