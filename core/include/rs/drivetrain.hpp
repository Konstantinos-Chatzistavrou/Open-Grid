// Drivetrain: engine -> clutch -> gearbox -> differential(s) -> wheels, plus brakes.
// Integrates the rotating parts (engine and the four wheel spins) for one sub-step.
#pragma once
#include <array>
#include <vector>
#include "rs/config.hpp"

namespace rs {

struct DrivetrainInput {
    double throttle = 0, clutch = 0, brake = 0, handbrake = 0;
    int gear = 1;
    double engine_power_scale = 1.0;            // damage hook
    double brake_power_scale = 1.0;             // damage hook: brake fade / failure (all brakes)
    std::array<double, 4> brake_scale{1, 1, 1, 1};   // ABS: fraction of driver brake pressure
    std::array<double, 4> extra_brake{};             // ESC: added brake torque, N m
    std::array<double, 4> pad_mu{1, 1, 1, 1};        // brake pad friction vs. its working range (disc temperature)
    bool nos_active = false;                         // N2O nitrous solenoid open
    bool starter_crank = false;                      // physical starter motor cranking
    double airspeed_mps = 0.0;                       // vehicle forward speed for oil radiator cooling
};

// Night Runners / UE5 forced induction, nitrous oxide, oil thermal & mechanical health state.
struct EngineSystemState {
    int turbo_stage = 0;            // 0 = NA, 1 = Street (0.70 bar), 2 = Sport (1.15 bar), 3 = Race Twin-Scroll (1.65 bar)
    double boost_bar = 0.0;         // current manifold gauge pressure (bar; negative in vacuum, positive under boost)
    bool bov_venting = false;       // true when blow-off valve is venting compressed charge on throttle lift (UE5 MetaSounds trigger)
    double bov_timer_s = 0.0;       // remaining BOV vent duration (s)
    double nos_bottles_l = 4.5;     // remaining N2O liquid volume (liters)
    double nos_capacity_l = 4.5;    // full N2O bottle capacity (liters)
    double oil_temp_c = 85.0;       // engine oil temperature (C; optimal 80-115 C, overheats > 130 C)
    double engine_health = 1.0;     // 0..1 mechanical health (degrades under severe overheat/redline abuse; < 0.65 causes misfires)
    bool wear_enabled = false;      // true to accumulate progressive redline/thermal wear during a session
    bool misfiring = false;         // true during an active ignition misfire dip
    double misfire_phase = 0.0;     // deterministic phase accumulator for misfire events
};

class Drivetrain {
public:
    explicit Drivetrain(const CarConfig& cfg);

    // tyre_torque[i]: torque the road applies to wheel i about its axle (= -Fx * r), N m.
    // rolling_torque[i]: rolling-resistance torque magnitude, N m (always opposes spin).
    void step(const DrivetrainInput& in, const std::array<double, 4>& tyre_torque,
              const std::array<double, 4>& rolling_torque, double h);

    std::array<double, 4> wheel_omega{};        // rad/s
    std::array<double, 4> brake_torque{};       // N m, friction torque the brakes applied last step (disc heating)
    double engine_omega = 0;                    // rad/s
    bool stalled = false;
    double engine_rpm() const;
    double engine_torque_full(double rpm) const; // N m at full throttle
    double clutch_torque = 0;                   // last clutch torque (engine -> gearbox), N m
    EngineSystemState systems{};                // turbo boost, BOV, N2O nitrous, oil temp & mechanical wear
    static double max_boost_for_stage(int stage);

    // Differential tree node: a wheel (leaf) or a differential with two children and a torque
    // split (fraction of input torque to child a). Built once from the layout (rwd/fwd/awd).
    struct Node {
        int wheel = -1;
        int a = -1, b = -1;
        double split = 0.5;
        const DiffParams* diff = nullptr;
    };

private:
    const CarConfig& cfg_;
    std::vector<Node> nodes_;
    int root_ = -1;
    double gear_ratio(int gear) const;
};

}  // namespace rs
