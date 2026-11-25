// Vehicle model: suspension, tyres, drivetrain, brakes, aero.
//
// HOW AN ENGINE USES IT (Godot wrapper in Phase 2, or the headless Simulation in tests):
//   every physics tick (e.g. 400 Hz):
//     1. rays = vehicle.wheel_rays(chassis)          -> engine casts 4 rays
//     2. out  = vehicle.update(chassis, contacts, dt) -> engine applies out.force / out.torque
//                                                        at the CG, plus gravity, and integrates
// Plain structs only, SI units, Z-up right-handed world. The core never integrates the chassis
// itself (the engine does, so it can resolve collisions); the stiff internal parts (wheel spin,
// clutch, differentials, tyre slip) are sub-stepped inside update() at >= 1 kHz.
#pragma once
#include <array>
#include "rs/assists.hpp"
#include "rs/config.hpp"
#include "rs/damage.hpp"
#include "rs/drivetrain.hpp"
#include "rs/math.hpp"
#include "rs/tire.hpp"

namespace rs {

enum class AutoClutchQuality : int {
    Perfect = 0,            // Full declutch held until synchro completes + smooth release; never misses a shift
    Normal  = 1,            // Competent street driver: clean normal shifts, can slow-sync/grind if slamming shifts
    Poor    = 2             // Sloppy / late / brief declutch: can miss shifts and damage the transmission
};

struct DriverInput {
    double steer = 0;       // -1 (full right) .. +1 (full left)
    double throttle = 0;    // 0..1
    double brake = 0;       // 0..1
    double clutch = 0;      // 0 = engaged (pedal up) .. 1 = disengaged (pedal down)
    double handbrake = 0;   // 0..1
    double line_lock = 0;   // 0..1: hold the FRONT brakes only (line lock): burnouts, drag-strip tyre warm-up
    int gear = 1;           // index into gear_ratios: 0 = reverse, 1 = neutral, 2 = 1st, ...
    bool auto_clutch = false;   // ASSIST: clutch handled automatically (launch, anti-stall, shifts)
    AutoClutchQuality auto_clutch_quality = AutoClutchQuality::Perfect;
    bool nos = false;           // N2O nitrous solenoid trigger
    bool starter = false;       // manual starter motor cranking button
};

struct ChassisState {       // rigid body state of the car, world frame, origin = CG
    Vec3 position;
    Quat orientation;       // body -> world
    Vec3 velocity;          // m/s
    Vec3 angular_velocity;  // rad/s, world frame
};

struct WheelRay {
    Vec3 origin;            // world, suspension top mount
    Vec3 direction;         // world, unit, pointing down the suspension axis
    double length = 0;      // m, rest length + tyre radius
    Vec3 forward{1, 0, 0};  // world, unit: the tyre's rolling direction (a Ground that builds a per-cell patch profile around
                            // the hit needs it; the vehicle fills it in, steered for the multi-ray modes, body heading otherwise)
};

// 3-ray circular-arc tire contact patch query (center, leading edge, trailing edge along steered wheel plane).
// Bridges sharp curb lips and potholes in UE5 Chaos and Rapier so tires roll smoothly onto curbs instead of stepping abruptly.
struct WheelContactPatchRays {
    std::array<WheelRay, 3> rays{};                  // [0] = center, [1] = leading (+dx), [2] = trailing (-dx)
    std::array<double, 3> longitudinal_offsets_m{};  // m from wheel axle center along steered rolling direction
};

// 16-Point 2D Cylindrical & Cambered Tire Footprint Grid (5 longitudinal x 3 lateral ribs [Inner/Middle/Outer] + 1 leading apex = 16 points).
// Surpasses Forza Motorsport's 8-point and ACC's 5-point contact patch by resolving full 2D lateral + longitudinal curb strikes.
struct WheelFootprint16Rays {
    std::array<WheelRay, 16> rays{};
    std::array<double, 16> longitudinal_offsets_m{}; // dx along steered wheel rolling plane (m)
    std::array<double, 16> lateral_offsets_m{};      // dy across tread width (- = Inner rib, 0 = Middle rib, + = Outer rib, m)
    std::array<int, 16> rib_index{};                 // 0 = Inner rib, 1 = Middle rib, 2 = Outer rib
    double outward_sign = 1.0;                       // +1 for left wheels (outer = +Y left), -1 for right wheels (outer = -Y right)
};

struct WheelContact {
    bool hit = false;
    double distance = 0;    // m from ray origin to the hit point
    Vec3 point;             // world
    Vec3 normal{0, 0, 1};   // world, unit
    int surface = 0;        // index into CarConfig::surface_grip
    double water_depth_mm = 0.0; // mm of standing water at this specific wheel contact patch (0 = dry/damp, > 1.5 mm = puddle/flooded curb)
    std::array<double, 3> rib_contact_shares{1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0}; // 3D geometric normal load shares (Inner, Middle, Outer)
    double enveloping_slope_tan = 0.0; // Simcenter 2606 MF-Swift 3D tandem-cam obstacle enveloping road slope tan(beta_env)
    ContactPatchProfile patch_profile{}; // optional 4x4 multi-point road height / kerb / partial-contact profile
    double surface_mu_mult = 1.0;        // dynamic street surface grip multiplier (rubbered dry > 1, wet rubber/marbles < 1)
    double marble_density = 0.0;         // 0..1 off-line rubber marbles & street dust/grit density at this wheel
};

struct WheelOutput {
    bool contact = false;
    double load = 0;                 // N, normal load Fz (after any hydroplaning water-wedge lift)
    double compression = 0;          // m, spring compression (0 = full droop)
    double slip_ratio = 0;           // kappa (relaxed)
    double slip_angle = 0;           // rad (relaxed)
    double camber = 0;               // rad, inclination angle gamma in tyre frame (+ = top tilted left)
    double fx = 0, fy = 0;           // N, tyre-frame forces (averaged over sub-steps)
    double mz = 0;                   // N m, self-aligning moment about contact normal
    double angular_velocity = 0;     // rad/s about the axle (+ = rolling forward)
    double steer_angle = 0;          // rad
    Vec3 centre_world;               // wheel centre position (for visuals)
    Vec3 contact_point;              // world, where the tyre touches the ground
    Vec3 force_world;                // world, tyre force in the ground plane (Fx + Fy), N
    double grip_limit = 0;           // N, approx. max friction force (peak mu * surface * load)
    TireCondition condition;         // tyre temperature (core + surface + I/M/O zones), pressure & wear state
    double brake_temp_c = 0;         // brake disc temperature, C
    double brake_mu = 1;             // pad friction relative to its working range (cold / fading < 1)
    double carcass_deflection_m = 0; // m, radial tyre carcass compression under vertical load
    double unsprung_vel_mps = 0;     // m/s, vertical wheel-hop velocity of the unsprung hub/wheel mass
    double brake_fluid_temp_c = 45.0;// C, caliper DOT 4 brake fluid temperature (vapor lock / spongy pedal > 260 C)
    double brake_pad_wear = 0.0;     // 0..1 progressive brake pad friction lining wear
    double hydroplaning_lift = 0.0;  // 0..0.90 hydrodynamic water-wedge lift fraction on standing puddles
    double toe_angle = 0.0;          // rad, dynamic suspension alignment toe-in (+ = toe-in: static + bump steer + damage)
    double caster_angle = 0.0;       // rad, instantaneous dynamic steering-axis caster
    double kpi_angle = 0.0;          // rad, instantaneous dynamic kingpin inclination
    double scrub_radius_m = 0.0;     // m, instantaneous scrub radius
    double motion_ratio = 1.0;       // wheel-to-shock kinematic motion ratio
    double kerb_load_ratio = 0.0;    // 0..1 share of vertical load on raised kerb cells from the 4x4 contact patch
    double surface_excitation = 0.0; // 0..1 high-frequency road/kerb/rumble vertical velocity excitation
    double sidewall_rollover = 0.0;  // 0..1 lateral sidewall tuck-under / rollover index
    double sidewall_damage = 0.0;    // 0..1 structural sidewall/bead damage from kerb rim strikes
    double rim_strike_force_n = 0.0; // N, rim-flange bottoming force during sharp kerb/pothole impacts
    double carcass_hysteresis_w = 0.0; // W, viscoelastic flexing power dissipated in the 24-node flexible carcass ring
};

// Chassis torsional stiffness (frame twist between front & rear strut towers), Active Torque-Vectoring E-Diff (AYC),
// Active Aerodynamics (DRS low-drag straight mode + 35-deg braking Airbrake), and DOT 4 Brake Fluid Vapor-Lock config.
struct ChassisDynamicsConfig {
    bool chassis_flex_enabled = false;
    double torsional_stiffness_nm_per_deg = 22000.0; // stock street unibody ~22k N m/deg; Strut Bar + Roll Cage ~48k N m/deg
    bool active_yaw_control_enabled = false;         // Active Torque-Vectoring E-Diff / AYC
    double ayc_max_yaw_moment_nm = 1450.0;           // peak pro-rotation torque-vectoring yaw moment (N m)
    bool active_aero_enabled = false;                // DRS straight-line low-drag (-14% drag > 180 km/h) + Braking Airbrake (+22% rear downforce)
    bool brake_fluid_boil_enabled = false;           // DOT 4 caliper fluid boiling (> 260 C) causes vapor-lock spongy brake pressure loss
    bool bushing_compliance_enabled = false;         // Elastokinematic bushing compliance (toe/camber/recession under Fx/Fy)
    bool progressive_bump_stops_enabled = false;     // Smooth exponential polyurethane jounce packers (when axle uses linear default)
};

// Aerodynamic slipstream (drafting tow), turbulent dirty-air front downforce loss, and drift yaw-angle aero scaling.
struct AeroWakeState {
    double drag_scale = 1.0;                      // 1.0 in clean air, down to 0.72 (-28% drag) in optimal slipstream tow
    double dirty_air_front_downforce_scale = 1.0; // 1.0 in clean air, down to 0.70 (-30% front downforce / understeer) in wake
    bool yaw_aero_enabled = false;                // true: sideslip angle beta increases frontal drag (+35%) & sheds rear wing lift
};

struct VehicleOutput {
    Vec3 force;                      // world, N, total excluding gravity, applied at the CG
    Vec3 torque;                     // world, N m, about the CG
    std::array<WheelOutput, 4> wheels;
    double steer_torque = 0;         // N m about the steering axes (front Mz + Fy x mechanical trail + flat-spot FFB): force feedback
    // chassis telemetry, body frame
    double speed = 0;                // m/s, forward component of velocity
    double sideslip = 0;             // rad, beta = atan(v_y / |v_x|) (0 when slow)
    double yaw_rate = 0;             // rad/s, + = turning left
    Vec3 accel;                      // m/s^2, what an accelerometer on the CG reads (no gravity)
    AssistStatus assists;
    DamageReport damage;
    double throttle_applied = 0;     // after assists
    double brake_applied = 0;
    double engine_rpm = 0;
    int gear = 1;
    bool engine_stalled = false;
    // Forced induction (Turbo + Blow-Off Valve + Intercooler IAT), Nitrous Oxide (N2O), Oil Thermal, Fuel & Drivetrain telemetry
    double boost_bar = 0.0;
    bool bov_venting = false;
    double intake_air_temp_c = 28.0;
    double nos_remaining_l = 4.5;
    double oil_temp_c = 85.0;
    double engine_health = 1.0;
    bool engine_misfire = false;
    double fuel_liters = 55.0;
    double mass_kg = 0.0;            // current total mass: spec mass minus the fuel burnt (see Vehicle::current_mass)
    Vec3 effective_inertia{};        // kg m^2 (roll Ixx, pitch Iyy, yaw Izz), scaled dynamically as fuel burns from rear tank
    double exhaust_primary_hz = 0.0; // Hz, fundamental 4-stroke exhaust firing pulse frequency (engine_rpm * cylinders / 120)
    double gear_whine_hz = 0.0;      // Hz, transmission gear-tooth meshing frequency (|input_shaft_omega| * active_drive_teeth / (2*pi))
    double turbo_surge = 0.0;        // 0..1 compressor surge flutter index when throttle closes abruptly under high boost
    bool gear_grind = false;
    bool shift_cut_active = false;
    bool auto_blip_active = false;
    double driveline_clunk_nm = 0.0;
    // Physical clutch disc & synchromesh gearbox telemetry
    double clutch_temp_c = 40.0;
    double clutch_health = 1.0;
    double gearbox_health = 1.0;
    int missed_shifts = 0;
    bool missed_shift_event = false;
    double clutch_torque_nm = 0.0;
    bool clutch_locked = false;
    double slipstream_drag_scale = 1.0;
    double dirty_air_downforce_scale = 1.0;
    double chassis_twist_deg = 0.0;          // frame twist angle between front and rear axles (deg)
    double ayc_yaw_moment_nm = 0.0;          // Active Torque-Vectoring E-Diff pro-rotation yaw moment (N m)
    bool drs_active = false;                 // Active Aero low-drag mode active
    bool airbrake_active = false;            // Active Aero high-downforce braking airbrake active
    bool front_splitter_stalled = false;     // true when extreme front bottoming chokes ground-effect diffuser airflow
    double brake_vapor_lock_sponge = 0.0;    // 0..0.55 brake line pressure loss from boiling caliper fluid (> 260 C)
    double air_density_kg_m3 = 1.225;        // live ISA atmospheric air density (kg/m^3) from altitude, Celsius & humidity
    double roll_centre_front_m = 0.0;        // m, dynamic front axle kinematic roll-centre height above road
    double roll_centre_rear_m = 0.0;         // m, dynamic rear axle kinematic roll-centre height above road
    double front_ride_height_m = 0.11;       // m, live front splitter/undertray height above road
    double rear_ride_height_m = 0.125;       // m, live rear diffuser height above road
    double aero_balance_front = 0.45;        // live front share of aerodynamic downforce (0..1)
    bool diffuser_stalled = false;           // true when excessive rear-high rake stalls underbody diffuser
    // Physical steering column & speed-sensitive power steering (EPS / Hydraulic)
    double steering_column_torque_nm = 0.0;  // N m at steering wheel rim (after power steering + friction + damping + inertia)
    double steering_assist_torque_nm = 0.0;  // N m hydraulic/EPS assist torque applied to rack
    double power_steering_gain = 0.0;        // 0..1 active speed-sensitive power-steering boost fraction
    // Hydraulic torque converter telemetry (AutomaticTorqueConverter)
    double tc_slip_ratio = 1.0;              // turbine / pump speed ratio SR (0 at stall .. 1.0 locked)
    double tc_torque_ratio = 1.0;            // hydraulic torque multiplication TR(SR)
    bool tc_lockup_engaged = false;          // true when TCC mechanical lock-up clutch is locked
};

// Physical effect multipliers (filled from DamageModel each tick when damage is enabled).
struct DamageState {
    double engine_power = 1.0;
    std::array<double, 4> suspension_stiffness{1, 1, 1, 1};
    double aero_drag = 1.0;
    std::array<double, 4> toe{};               // rad, added to each wheel's steer angle
    std::array<double, 4> camber{};            // rad, bent wishbone/strut camber offset
    std::array<double, 4> caster{};            // rad, bent front caster offset (asymmetric steering pull)
    std::array<double, 4> bearing_drag_nm{};   // N m, damaged hub bearing rolling drag
    double radiator_cooling = 1.0;             // 1.0 intact .. 0.25 punctured front radiator/intercooler
    std::array<double, 4> grip{1, 1, 1, 1};    // tyre grip multiplier
    double brakes = 1.0;                       // brake effectiveness (fade / failure), all brakes
};

/** Brake pad friction factor vs disc temperature (C), 1 = the working plateau (curve in vehicle.cpp). */
double brake_pad_mu(double disc_c);

class Vehicle {
public:
    explicit Vehicle(const CarConfig& cfg);
    Vehicle(const Vehicle&) = delete;              // drivetrain keeps a reference to cfg_
    Vehicle& operator=(const Vehicle&) = delete;

    void set_input(const DriverInput& in) { input_ = in; }
    const DriverInput& input() const { return input_; }
    const CarConfig& config() const { return cfg_; }
    DamageState& damage() { return damage_; }
    // Crash input from the engine's collision system (point in BODY frame, impulse N s).
    void add_contact(std::uint64_t object_id, const Vec3& point_body, double impulse);
    DamageModel& damage_model() { return damage_model_; }
    bool damage_enabled = true;
    AssistSettings& assists() { return assists_; }
    const AssistSettings& assists() const { return assists_; }
    EngineSystemState& engine_systems() { return drivetrain_.systems; }
    const EngineSystemState& engine_systems() const { return drivetrain_.systems; }
    AeroWakeState& aero_wake() { return aero_wake_; }
    const AeroWakeState& aero_wake() const { return aero_wake_; }
    ChassisDynamicsConfig& chassis_dynamics() { return chassis_dyn_; }
    const ChassisDynamicsConfig& chassis_dynamics() const { return chassis_dyn_; }
    AtmosphericEnvironment& atmosphere() { return atmosphere_; }
    const AtmosphericEnvironment& atmosphere() const { return atmosphere_; }
    /** Compute aerodynamic slipstream drag reduction (up to -28%) and dirty-air front downforce loss (up to -30%) behind lead cars. */
    static AeroWakeState compute_slipstream_wake(const Vec3& my_pos, const Vec3& my_fwd, const std::vector<Vec3>& lead_car_positions);

    /** Enable 15 Hz 2-DOF unsprung wheel-hop & radial tyre carcass vertical dynamics, 3-zone I/M/O tread thermals, and 4x4 contact patch grid. */
    bool unsprung_dynamics_enabled = false;
    bool tire_zones_enabled = true;
    bool tire_patch_grid_enabled = true;

    std::array<WheelRay, 4> wheel_rays(const ChassisState& s) const;
    // 3-ray fan along each wheel's steered rolling plane + circular-arc contact resolver for sharp street curbs.
    std::array<WheelContactPatchRays, 4> wheel_contact_patch_rays(const ChassisState& s) const;
    static WheelContact resolve_contact_patch(const WheelContactPatchRays& patch,
                                              const std::array<WheelContact, 3>& hits,
                                              double tire_radius);
    // 16-Point 2D Cylindrical & Cambered Tire Footprint (5 longitudinal x 3 lateral ribs + 1 leading apex) + 3-rib curb load resolver.
    std::array<WheelFootprint16Rays, 4> wheel_footprint_16_rays(const ChassisState& s) const;
    static WheelContact resolve_footprint_16(const WheelFootprint16Rays& footprint,
                                             const std::array<WheelContact, 16>& hits,
                                             double tire_radius);
    // Start already rolling at `forward_speed` (m/s): wheels spin at v/r, slips cleared.
    // If gear >= 0, the engine is also set to the matching rpm (clutch engaged at that speed).
    void reset_motion(double forward_speed, int gear = -1);
    // Garage service (what the R / repair key does with damage_model().repair()): full tank, healthy engine, no
    // misfire. With fuel use and engine wear on, the car would otherwise stop for good on an empty tank.
    void service();
    // Total mass now. The car spec's mass is with a FULL tank; burnt fuel (0.745 kg/L) comes off it. Engines must
    // apply this to their rigid body when it changes (web: world.ts, Unreal: UOpenGridVehicleComponent).
    double current_mass() const;
    Vec3 current_inertia() const;
    double engine_rpm() const { return drivetrain_.engine_rpm(); }
    const Drivetrain& drivetrain() const { return drivetrain_; }
    VehicleOutput update(const ChassisState& s, const std::array<WheelContact, 4>& contacts, double dt);

    double max_substep = 1.0 / 1000.0;   // s; internal integration step upper bound

private:
    CarConfig cfg_;
    DriverInput input_;
    DamageState damage_;
    DamageModel damage_model_;
    double time_ = 0;
    double last_dt_ = 1.0 / 400.0;
    AssistSettings assists_;
    std::array<double, 4> abs_pressure_{1, 1, 1, 1};
    double tc_cut_ = 0;
    Drivetrain drivetrain_;
    std::array<double, 4> kappa_{};      // relaxed longitudinal slip per wheel
    std::array<double, 4> tan_alpha_{};  // relaxed lateral slip (tan of slip angle) per wheel
    std::array<TireCondition, 4> tire_condition_{};
    std::array<double, 4> disc_temp_{};          // brake disc temperatures, C (set from BrakeThermal at reset)
public:
    /** Tests / tooling: set every brake disc to this temperature (C); reset_motion puts them back to warm. */
    void set_brake_temperature(double c) { disc_temp_.fill(c); disc_init_ = true; }
    void set_brake_fluid_temperature(double c) { fluid_temp_.fill(c); }
    /** Rain water film on the road (mm), set by the host from the weather (0 = dry; ~0.1 damp, ~1 heavy rain).
     *  Each contact uses max(this, WheelContact::water_depth_mm), so puddles from the ground add on top. */
    double road_water_mm = 0.0;
    /** Tests / tooling: every tyre soaked at temp_c (tread, ribs, carcass; cavity air at the model's running share,
     *  never above temp_c) with wear 0..1, pressure from the ideal gas law. Call after reset (reset makes them new). */
    void set_tyres(double temp_c, double wear);
private:
    void soak_tyre(int w, double temp_c, double wear);
public:
private:
    bool disc_init_ = false;
    std::array<double, 4> fluid_temp_{45.0, 45.0, 45.0, 45.0}; // caliper DOT 4 brake fluid temperature, C
    std::array<double, 4> pad_wear_{};                         // 0..1 brake pad friction material wear
    ChassisDynamicsConfig chassis_dyn_{};
    AtmosphericEnvironment atmosphere_{};
    std::array<double, 2> prev_axle_fy_{};
    std::array<double, 4> prev_fy_{};       // last step's tyre Fy per wheel (kinematic heave jacking force)
    std::array<double, 4> prev_fx_{};       // last step's tyre Fx per wheel (anti-dive / anti-squat link forces)
    std::array<double, 4> dz_{};            // suspension compression from static per wheel, m (+ = bump; kinematics)
    std::array<double, 4> wheel_angle_{};   // accumulated wheel rotation angle, rad (for flat-spot phase & FFB thump)
    std::array<double, 4> unsprung_z_{};    // 2-DOF unsprung wheel vertical offset relative to static equilibrium, m
    std::array<double, 4> unsprung_vz_{};   // 2-DOF unsprung wheel vertical velocity (wheel hop), m/s
    AeroWakeState aero_wake_{};
    int last_gear_ = 1;                     // auto-clutch: detects gear changes
    double shift_timer_ = 0;                // auto-clutch / AMT: active declutch hold timer (s)
    double shift_release_timer_ = 0;        // auto-clutch / AMT: post-sync clutch release ramp (s)
    double shift_release_duration_ = 0.035; // duration of the current clutch release ramp (s)
    bool amt_downshift_ = false;            // AMT: active shift is a rev-matched downshift
    double dct_blip_timer_ = 0.0;           // DCT: active downshift rev-match blip timer (s)
    double since_shift_timer_ = 10.0;       // auto-clutch: time since previous shift (detects rapid shift slamming)
    double missed_recover_timer_ = 0.0;     // auto-clutch: brief neutral penalty before recovering a missed shift
    bool recovering_from_miss_ = false;     // auto-clutch: a missed shift is being recovered (clutch held open until the retry completes)
    double prev_steer_rad_ = 0.0;           // previous tick average front road-wheel steer angle (for column damping/inertia)
    double prev_steer_vel_rads_ = 0.0;      // previous tick steering wheel angular velocity (rad/s)

    double steer_angle(int wheel) const;
    double roll_centre(int wheel) const;      // roll centre height of the wheel's axle, m (migrates with heave)
};

}  // namespace rs
