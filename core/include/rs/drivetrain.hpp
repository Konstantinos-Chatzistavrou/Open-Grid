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
    double airspeed_mps = 0.0;                       // vehicle forward speed for oil/intercooler radiator cooling
    double radiator_cooling_scale = 1.0;             // 1.0 intact .. 0.25 punctured by front-zone crash damage
    std::array<double, 4> bearing_drag_nm{};         // parasitic hub bearing drag from wheel impact damage, N m
};

enum class TransmissionType : int {
    HPatternSynchro = 0,     // Manual H-pattern synchromesh: requires clutch or rev-match window; grinds if forced raw
    SequentialDogBox = 1,    // Motorsport sequential dog-box: flat-foot upshifts via 55 ms ignition-cut backfire
    DualClutchDct = 2        // Dual-clutch (DCT): 15 ms seamless torque handoff with zero boost drop
};

// Night Runners / UE5 forced induction, intercooler, fuel load, transmission archetype, torsional driveline & health state.
struct EngineSystemState {
    int turbo_stage = 0;            // 0 = NA, 1 = Street (0.70 bar), 2 = Sport (1.15 bar), 3 = Race Twin-Scroll (1.65 bar)
    double boost_bar = 0.0;         // current manifold gauge pressure (bar; negative in vacuum, positive under boost)
    bool bov_venting = false;       // true when blow-off valve is venting compressed charge on throttle lift (UE5 MetaSounds trigger)
    double bov_timer_s = 0.0;       // remaining BOV vent duration (s)
    double intake_air_temp_c = 28.0;// post-intercooler Intake Air Temperature (IAT, C; above 52 C pulls timing/density)
    double intercooler_eff = 0.74;  // air-to-air intercooler effectiveness (0..1)
    double iat_power_factor = 1.0;  // density & ECU knock-retard power multiplier from IAT heat soak
    double nos_bottles_l = 4.5;     // remaining N2O liquid volume (liters)
    double nos_capacity_l = 4.5;    // full N2O bottle capacity (liters)
    double oil_temp_c = 85.0;       // engine oil temperature (C; optimal 80-115 C, overheats > 130 C)
    double engine_health = 1.0;     // 0..1 mechanical health (degrades under severe overheat/redline abuse; < 0.65 causes misfires)
    bool wear_enabled = false;      // true to accumulate progressive redline/thermal wear during a session
    bool misfiring = false;         // true during an active ignition misfire dip
    double misfire_phase = 0.0;     // deterministic phase accumulator for misfire events

    // Dynamic Fuel Load & BSFC Consumption
    bool fuel_consumption_enabled = false;
    double fuel_liters = 55.0;
    double fuel_capacity_liters = 55.0;
    double fuel_mass_kg() const { return fuel_liters * 0.745; } // 0.745 kg/L RON 98 petrol

    // Transmission Archetype (H-Pattern Synchro Grind / Sequential Dog-Box Flat-Shift Cut / DCT)
    TransmissionType transmission = TransmissionType::SequentialDogBox;
    bool strict_h_pattern_synchro = false; // when true on HPatternSynchro, clutchless un-matched shifts grind & block
    bool dog_box_flat_shift_cut = false;   // when true on SequentialDogBox, flat-foot upshifts trigger a 55 ms ignition cut
    int engaged_gear = -1;                 // internal engaged gear (-1 = uninitialized)
    bool gear_grind = false;               // true while synchro teeth are grinding from a missed H-pattern shift
    double grind_timer_s = 0.0;
    bool shift_cut_active = false;         // true during a Sequential Dog-Box 55 ms ignition cut (triggers exhaust flame/pop)
    double shift_cut_timer_s = 0.0;

    // Driveline Torsional Halfshaft Compliance & Mechanical Backlash Clunk
    bool torsional_compliance_enabled = false;
    double torsional_twist_rad = 0.0;              // axle shaft wind-up angle (rad)
    double torsional_vel_rads = 0.0;               // d(twist)/dt (rad/s)
    double torsional_stiffness_nm_per_rad = 8500.0;// halfshaft torsional spring rate (N m / rad)
    double torsional_damping_nms_per_rad = 180.0;  // halfshaft structural + tyre torsional damping (N m s / rad)
    double backlash_rad = 0.032;                   // +-1.8 deg gear/diff dog backlash deadzone
    double driveline_clunk_nm = 0.0;               // impulse torque spike when crossing backlash deadzone (UE5 MetaSounds)
    int last_backlash_side = 0;                    // -1 = coast face, 0 = in lash gap, +1 = drive face
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
