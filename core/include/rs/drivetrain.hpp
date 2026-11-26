// Drivetrain: engine -> clutch -> gearbox -> differential(s) -> wheels, plus brakes.
// Integrates the rotating parts (engine and the four wheel spins) for one sub-step.
#pragma once
#include <array>
#include <vector>
#include "rs/config.hpp"
#include "rs/math.hpp"

namespace rs {

struct DrivetrainInput {
    double throttle = 0, clutch = 0, brake = 0, handbrake = 0;
    int gear = 1;
    double engine_power_scale = 1.0;            // damage hook
    double brake_power_scale = 1.0;             // damage hook: brake fade / failure (all brakes)
    double line_lock = 0;                       // 0..1: front brakes held at this share of their full torque (no ABS)
    std::array<double, 4> brake_scale{1, 1, 1, 1};   // ABS: fraction of driver brake pressure
    std::array<bool, 4> wheel_drive_severed{false, false, false, false}; // detached wheel or snapped CV halfshaft -> zero drive torque
    std::array<double, 4> extra_brake{};             // ESC: added brake torque, N m
    std::array<double, 4> pad_mu{1, 1, 1, 1};        // brake pad friction vs. its working range (disc temperature)
    bool nos_active = false;                         // N2O nitrous solenoid open
    bool starter_crank = false;                      // physical starter motor cranking
    double airspeed_mps = 0.0;                       // vehicle forward speed for oil/intercooler radiator cooling
    double radiator_cooling_scale = 1.0;             // 1.0 intact .. 0.15 punctured by front-zone crash damage / drained coolant
    double oil_cooling_scale = 1.0;                  // 1.0 intact .. 0.20 punctured oil pan / drained engine oil
    double oil_starvation_wear_rate = 0.0;           // extra engine_health degradation/s when oil sump runs dry
    double fuel_leak_lps = 0.0;                      // L/s fuel tank puncture drain rate
    std::array<double, 4> bearing_drag_nm{};         // parasitic hub bearing drag from wheel impact damage, N m
    double ambient_air_c = 25.0;                     // live ambient air temperature (C)
    double altitude_m = 0.0;                         // elevation above sea level (m)
    double humidity_0_to_1 = 0.35;                   // relative humidity (0..1)
    bool atmosphere_enabled = false;                 // true: scale NA vs Turbo power, IAT & cooling by altitude/Celsius
};

// International Standard Atmosphere (ISA) barometric altitude, ambient air Celsius, asphalt track Celsius & humidity model.
struct AtmosphericEnvironment {
    bool enabled = false;
    double altitude_m = 0.0;              // meters above sea level (0 m NYC coast .. 2,200 m mountain touge / volcano)
    double ambient_air_c = 25.0;          // ambient air temperature (C: -10 C winter night .. +42 C summer heat)
    double track_surface_c = 30.0;        // asphalt road surface temperature (C: -8 C freezing .. +62 C sun-baked)
    double humidity_0_to_1 = 0.35;        // relative humidity (0..1; water vapor is less dense than dry O2/N2)
    double barometric_offset_kpa = 0.0;   // synoptic pressure anomaly vs ISA 101.325 kPa (-3.5 storm .. +2.0 high)
    Vec3 wind_world_mps{0.0, 0.0, 0.0};   // 3D world-frame wind velocity (m/s; Dynamic Weather gusts & crosswinds)

    /** Barometric pressure P(h) in kPa via ISA tropospheric lapse formula (101.325 kPa at 0 m -> 77.5 kPa at 2,200 m). */
    double barometric_pressure_kpa() const;
    /** Moist air mass density rho(h, T_air, RH) in kg/m^3 (1.225 kg/m^3 at ISA 15 C sea level). */
    double air_density_kg_m3() const;
    /** Naturally aspirated (NA) SAE J1349 dry-air mass power factor (loses ~21% at 2,200 m or hot humid air; +5% at 0 C sea level). */
    double na_engine_power_factor() const;
    /** Turbocharged altitude power factor: closed-loop wastegate spins turbo harder to hold boost until 155k RPM compressor choke. */
    double turbo_altitude_power_factor(double boost_bar, double* out_compressor_pr = nullptr) const;
};

enum class TransmissionType : int {
    HPatternSynchro = 0,          // Manual H-pattern synchromesh: baulk-ring cone clutch; grinds & misses if forced without sync
    SequentialDogBox = 1,         // Motorsport sequential dog-box: flat-foot ignition-cut upshifts + pneumatic auto-blip downshifts
    DualClutchDct = 2,            // Dual-clutch (DCT): 18 ms seamless twin-clutch overlap handoff, zero boost drop, rev-match blip
    AutomaticTorqueConverter = 3, // Planetary automatic with hydraulic fluid torque converter & TCC lock-up clutch
    AutomatedManual = 4           // Single-clutch automated manual (ISR / F1 AMT): hydraulic disconnect, synchro throw, torque-kick & auto-blip
};

enum class SyncState : int {
    Idle = 0,                // In gear or neutral with no active shift
    Synchronizing = 1,       // Sleeve in neutral gate while baulk-ring cone matches input_shaft_omega to target gear
    Missed = 2               // Dog clash / missed gear: kicked into neutral until clutch/gear re-attempted
};

// Night Runners / UE5 forced induction, intercooler, fuel load, transmission archetype, torsional driveline & health state.
struct EngineSystemState {
    int turbo_stage = 0;            // 0 = NA, 1 = Street (0.70 bar), 2 = Sport (1.15 bar), 3 = Race Twin-Scroll (1.65 bar)
    double boost_bar = 0.0;         // current manifold gauge pressure (bar; negative in vacuum, positive under boost)
    bool bov_venting = false;       // true when blow-off valve is venting compressed charge on throttle lift (UE5 MetaSounds trigger)
    double bov_timer_s = 0.0;       // remaining BOV vent duration (s)
    double turbo_surge = 0.0;       // 0..1 compressor surge flutter index when throttle closes abruptly under high boost
    double surge_boost_bar = 0.0;   // captured manifold boost at throttle lift for compressor surge envelope
    double intake_air_temp_c = 28.0;// post-intercooler Intake Air Temperature (IAT, C; above 52 C pulls timing/density)
    double intercooler_eff = 0.74;  // air-to-air intercooler effectiveness (0..1)
    double iat_power_factor = 1.0;  // density & ECU knock-retard power multiplier from IAT heat soak
    double nos_bottles_l = 4.5;     // remaining N2O liquid volume (liters)
    double nos_capacity_l = 4.5;    // full N2O bottle capacity (liters)
    double oil_temp_c = 85.0;       // engine oil temperature (C; optimal 80-115 C, overheats > 130 C)
    double coolant_temp_c = 90.0;   // engine coolant (water) temperature (C; the thermostat holds ~90 C, boils ~125 C)
    double engine_health = 1.0;     // 0..1 mechanical health (degrades under severe overheat/redline abuse; < 0.65 causes misfires)
    bool wear_enabled = false;      // true to accumulate progressive redline/thermal wear during a session
    bool misfiring = false;         // true during an active ignition misfire dip
    double misfire_phase = 0.0;     // deterministic phase accumulator for misfire events

    // Dynamic Fuel Load & BSFC Consumption
    bool fuel_consumption_enabled = false;
    double fuel_liters = 55.0;
    double fuel_capacity_liters = 55.0;
    double fuel_mass_kg() const { return fuel_liters * 0.745; } // 0.745 kg/L RON 98 petrol

    // Physical Clutch Disc (bite point, Karnopp stick/slip friction, thermal fade, wear)
    double clutch_temp_c = 40.0;           // friction disc temperature (C; fades > 260 C)
    double clutch_health = 1.0;            // 0..1 lining health (worn lining lowers capacity and raises bite point)
    double clutch_clamp_frac = 1.0;        // 0..1 normalized clamp force from pedal travel curve
    double clutch_slip_rads = 0.0;         // engine_omega - input_shaft_omega (rad/s)
    bool clutch_locked = false;            // Karnopp stick state (true = locked without chatter)

    // Hydraulic Torque Converter & Lock-Up Clutch (TCC) live telemetry (when transmission == AutomaticTorqueConverter)
    double tc_slip_ratio = 1.0;            // turbine / pump speed ratio SR (0 at stall .. 1.0 locked)
    double tc_torque_ratio = 1.0;          // hydraulic torque multiplication TR(SR) (up to ~2.15 at stall)
    double tc_lockup_frac = 0.0;           // 0..1 smooth TCC lock-up clutch engagement ramp
    bool tc_lockup_engaged = false;        // true when TCC mechanical lock-up clutch is engaged

    // Transmission Archetype (H-Pattern Synchro Cone Clutch / Sequential Dog-Box Flat-Shift Cut / DCT)
    TransmissionType transmission = TransmissionType::SequentialDogBox;
    bool strict_h_pattern_synchro = false; // when true on HPatternSynchro, zero grace window on clutchless shifts
    bool dog_box_flat_shift_cut = false;   // when true on SequentialDogBox, flat-foot upshifts trigger a 55 ms ignition cut
    int engaged_gear = -1;                 // internal engaged gear (-1 = uninitialized, 0 = R, 1 = N, 2.. = fwd)
    double input_shaft_omega = 0.0;        // gearbox input shaft angular speed (rad/s)
    double gearbox_health = 1.0;           // 0..1 synchro & gear tooth health (worn = slower sync, torque cap, pop-out)
    int missed_shifts = 0;                 // cumulative count of missed shifts / damaged-tooth pop-outs
    bool missed_shift_event = false;       // true when a missed shift triggered during the last substep
    SyncState sync_state = SyncState::Idle;
    int sync_target_gear = -1;             // target gear currently synchronizing or just missed
    double sync_timer_s = 0.0;             // elapsed sync duration (s)
    double clash_timer_s = 0.0;            // elapsed clash duration while clutch engaged during shift attempt (s)
    bool clutch_opened_during_sync = false;// true once clutch released load during active synchronization
    double popout_stress_s = 0.0;          // accumulated peak-torque stress for heavily damaged tooth pop-out
    bool gear_grind = false;               // true while synchro / dog teeth are grinding from a missed shift
    double grind_timer_s = 0.0;
    bool limiter_cut = false;              // rev limiter fuel cut active (cut at redline, refuel below redline - hysteresis)
    bool shift_cut_active = false;         // true during Sequential Dog-Box / AMT / DCT ignition shift cut (triggers exhaust pop/flame)
    double shift_cut_timer_s = 0.0;
    bool auto_blip_active = false;         // true during closed-loop electronic throttle auto-blip on downshifts
    double auto_blip_throttle = 0.0;       // 0..1 ECU auto-blip throttle command (feeds engine torque & exhaust bark)
    double dog_blip_timer_s = 0.0;         // elapsed unload + rev-match timer for SequentialDogBox downshifts
    int dog_pending_gear = -1;             // target lower gear awaiting dog-box auto-blip speed match
    double dct_handoff_timer_s = 0.0;      // remaining DCT twin-clutch overlap handoff duration (s)
    double shift_clunk_impulse_nm = 0.0;   // mechanical dog-ring / AMT clutch engagement clunk impulse (N m)

    // Driveline Torsional Halfshaft Compliance & Mechanical Backlash Clunk
    bool torsional_compliance_enabled = false;
    double torsional_twist_rad = 0.0;              // axle shaft wind-up angle (rad)
    double torsional_twist_mean_rad = 0.0;   // settled wind-up under the current load (low-passed twist)
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
    EngineSystemState systems{};                // turbo boost, BOV, N2O nitrous, oil temp, clutch/gearbox & wear
    static double max_boost_for_stage(int stage);

    // Physical clutch & synchromesh helpers (used by step() and exposed for telemetry / tests)
    double clutch_clamp_force(double pedal) const;                       // N, F_clamp(pedal) from bite-point travel curve
    double clutch_torque_capacity(double pedal, bool static_mu = true) const; // N m, T_cap = mu(T) * F_clamp * r_eff * n
    double synchro_torque_capacity() const;                              // N m, cone-clutch sync torque scaled by health
    bool is_synchronizing() const { return systems.sync_state == SyncState::Synchronizing; }
    static double clutch_temp_mu_factor(double temp_c);                  // 0.35..1.0 lining friction vs disc temperature

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
    double peak_engine_torque_ = 500.0;
    double gear_ratio(int gear) const;
};

}  // namespace rs
