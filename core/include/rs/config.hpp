// Car configuration: everything that defines a car's physics, loaded from data/cars/*.json
// (schema "car/1", see data/schema/car.schema.json). Adding a car needs no code changes.
#pragma once
#include <array>
#include <memory>
#include <string>
#include <vector>
#include "rs/kinematics.hpp"

namespace rs {

// Pacejka "Magic Formula" coefficients (MF 5.2 / 6.1). Notation follows Pacejka,
// "Tire and Vehicle Dynamics" (3rd ed.), chapter 4 & 7. See docs/physics.md for the equations.
struct TireParams {
    double radius = 0.33;             // m, nominal unloaded/reference radius R0
    double inertia = 1.0;             // kg m^2, wheel + tyre + brake disc about the axle
    double fz0 = 4000;                // N, nominal load Fz0 the coefficients refer to
    double vertical_stiffness = 220000; // N/m, radial carcass stiffness C_Fz (effective rolling radius)
    // longitudinal (pure slip, MF 5.2)
    double cx = 1.65;                 // shape factor pCx1
    double mu_x = 1.25;               // peak friction coefficient pDx1 at Fz0
    double pdx2 = -0.08;              // load sensitivity of mu: pDx2 (mu drops with load)
    double pdx3 = 0.0;                // camber sensitivity of longitudinal friction: pDx3
    double ex = 0.1;                  // curvature factor pEx1 at Fz0
    double pex2 = -0.12;              // variation of curvature Ex with dfz
    double pex3 = -0.05;              // variation of curvature Ex with dfz^2
    double pex4 = 0.0;                // driving/braking asymmetry of Ex
    double kx = 25.0;                 // slip stiffness per unit load pKx1: Kx0 = pKx1 * Fz  [1/-]
    double pkx2 = -0.06;              // variation of slip stiffness with dfz
    double pkx3 = 0.08;               // exponential load sensitivity of slip stiffness
    double phx1 = 0.0, phx2 = 0.0;    // horizontal shift SHx
    double pvx1 = 0.0, pvx2 = 0.0;    // vertical shift SVx / Fz
    // lateral (pure slip + camber, MF 5.2)
    double cy = 1.3;                  // shape factor pCy1
    double mu_y = 1.2;                // peak lateral friction pDy1 at Fz0, gamma = 0
    double pdy2 = -0.1;               // load sensitivity of lateral mu: pDy2
    double pdy3 = 0.8;                // camber sensitivity of peak lateral friction: pDy3 (1 - pDy3 gamma^2)
    double ey = -0.4;                 // curvature factor pEy1 at Fz0
    double pey2 = -0.04;              // variation of curvature Ey with dfz
    double pey3 = 0.0;                // zero-camber asymmetry of Ey
    double pey4 = -0.5;               // variation of curvature Ey with camber gamma
    double pky1 = 20.0;               // cornering stiffness peak / Fz0  [1/rad]
    double pky2 = 2.0;                // load (in Fz0 units) at which cornering stiffness peaks
    double pky3 = 0.12;               // variation of cornering stiffness with |gamma|
    double phy1 = 0.0, phy2 = 0.0;    // load-dependent lateral horizontal shift
    double phy3 = 0.08;               // camber contribution to horizontal shift SHy
    double pvy1 = 0.0, pvy2 = 0.0;    // load-dependent lateral vertical shift
    double pvy3 = 0.25;               // camber thrust vertical shift at Fz0
    double pvy4 = -0.08;              // variation of camber thrust vertical shift with dfz
    // combined slip weighting (MF 5.2: Gxa, Gyk, SVyk)
    double rbx1 = 12.0, rbx2 = 10.0, rbx3 = 0.0, rcx1 = 1.0, rex1 = -0.05, rex2 = -0.02, rhx1 = 0.0;
    double rby1 = 10.0, rby2 = 10.0, rby3 = 0.0, rby4 = 0.0, rcy1 = 1.0, rey1 = -0.05, rey2 = -0.02, rhy1 = 0.0, rhy2 = 0.0;
    double rvy1 = 0.0, rvy2 = 0.0, rvy3 = -0.15, rvy4 = 14.0, rvy5 = 1.9, rvy6 = 10.0;
    // self-aligning moment Mz (pneumatic trail t + residual torque Mzr + Fx arm s, MF 5.2)
    double qbz1 = 10.5, qbz2 = -1.4, qbz3 = -0.4, qbz4 = 0.0, qbz5 = 0.25;
    double qcz1 = 1.18;
    double qdz1 = 0.11, qdz2 = -0.02, qdz3 = 0.0, qdz4 = -1.0;
    double qez1 = -1.6, qez2 = -0.35, qez3 = 0.0, qez4 = 0.15, qez5 = -0.7;
    double qhz1 = 0.0, qhz2 = 0.0, qhz3 = 0.005, qhz4 = -0.005;
    double qbz9 = 12.0, qbz10 = 0.75;
    double qdz6 = 0.0, qdz7 = 0.0, qdz8 = 0.14, qdz9 = 0.04;
    double ssz1 = 0.0, ssz2 = 0.02, ssz3 = 0.5, ssz4 = -0.15;
    // transient behaviour: nominal relaxation lengths at Fz0 (m). Scaled dynamically by K(Fz)/C_F.
    double relax_x = 0.12, relax_y = 0.30;
    double rolling_resistance = 0.012;   // F_rr = (c_rr0 + c_rr2 * (v/30)^2) * Fz
    double rolling_resistance_v2 = 0.001; // speed-dependent rolling hysteresis
    // MF 6.1 additions
    // Friction falls with sliding speed (rubber friction, Persson): lambda_mu* = 1 / (1 + LMUV Vs / V0), Vs = |slip
    // velocity|, V0 = 16.7 m/s (LONGVL). The slip curves alone can't tell a 10 km/h slide from a 100 km/h one.
    double lmuv = 0.12;
    double lmuv_ref_mps = 1.5;        // sliding speed the mu coefficients were fitted at (normal cornering): no decay there
    // Inflation pressure (gauge, kPa): nominal (the coefficients' reference) and cold set pressure. Hot pressure follows
    // the gas law from the tyre's core temperature; dpi = (p - p_nom) / p_nom changes slip stiffness and friction
    // (Pacejka 3rd ed. Table 4.2 passenger tyre: PPX1..4, PPY1..4).
    double p_nominal_kpa = 220, p_cold_kpa = 188;   // 188 kPa cold -> ~220 kPa with the core at ~80 C
    double ppx1 = -0.3485, ppx2 = 0.37824, ppx3 = -0.09603, ppx4 = 0.06518;
    double ppy1 = -0.6255, ppy2 = -0.06523, ppy3 = -0.16666, ppy4 = 0.2811;
    // MF 6.1 turn slip (spin): peak lateral force and cornering stiffness drop when the contact patch also rotates
    // (tight turns at low speed, parking). Pacejka's default coefficients.
    double pdyp1 = 0.4, pdyp2 = 0.0, pdyp3 = 0.0, pdyp4 = 0.0, pkyp1 = 1.0;
    // Thermal window: core/surface blend temperature with full grip (C), and the half-width of the window.
    double temp_optimal_c = 90, temp_window_c = 25;
    // Tyre temperature at reset (C, carcass and tread: warmed, like the brakes) and tread wear per MJ of friction
    // work (wear 1 = tread gone). Set together by the car file's "compound" (road / semi_slick / slick).
    double start_c = 80;
    double wear_per_mj = 1.0 / 90.0;
    // PAC2002 / MF 6.2 / MF-Swift-style physical carcass, belt & non-linear rolling radius parameters
    // (defaults from measured Audi 245/40 R18 PAC2002 lab dataset, data/tires/audi_245_40R18_pac2002.tir):
    double vertical_damping = 2000.0; // N s/m, radial tire carcass damping (VERTICAL_DAMPING)
    double breff = 8.4;               // low-load stiffness of effective rolling radius (BREFF)
    double dreff = 0.27;              // peak value of effective rolling radius compression (DREFF)
    double freff = 0.07;              // high-load stiffness of effective rolling radius (FREFF)
    double pfz1 = 0.72;               // MF 6.2 / MF-Swift-style pressure dependency of vertical stiffness C_Fz(p)
    double ptx1 = 2.3657, ptx2 = 1.4112, ptx3 = 0.56626; // longitudinal relaxation length coefficients (PTX1..3)
    double pty1 = 2.1439, pty2 = 1.9829;                 // lateral relaxation length coefficients (PTY1..2)
    double qtz1 = 0.20;               // gyroscopic belt precession aligning torque constant (QTZ1)
    double mbelt = 5.4;               // kg, steel tread belt mass (MBELT = 5.4 kg for 245/40 R18, scaled by tire width/radius)
    double section_width_m = 0.245;   // m, nominal tire section width (WIDTH)
    double aspect_ratio = 0.40;       // sidewall aspect ratio (ASPECT_RATIO, e.g. 0.40 for 245/40 R18)
};

/** Brakes: disc + pad thermal model (per axle). */
struct BrakeThermal {
    double disc_mass_front = 8.5, disc_mass_rear = 6.0;   // kg (cast iron, c = 460 J/kg K)
    double disc_area_front = 0.13, disc_area_rear = 0.10; // m^2 of radiating / cooled surface
    // Convective cooling h A = base + per_mps v (W/K). A ducted, vented disc sheds ~80 W/K at 30 m/s and ~180 W/K at
    // 70 m/s (h ~200-450 W/m^2K over ~0.4 m^2 of faces and vanes): a 600 C disc drops 15-25 C/s on a fast straight,
    // so only repeated hard stops from high speed with little air in between push it into fade.
    double cooling_base = 5.0, cooling_per_mps = 2.5;
    double start_temp_c = 150;                             // warm brakes
};

struct WheelGeom {
    // Filled in at load time from axle data. Body frame, metres, relative to the CG.
    double x = 0, y = 0;
    double mount_z = 0;               // suspension top mount height (ray origin)
    double static_compression = 0;    // m, spring compression at rest
};

struct AxleParams {
    double track = 1.6;               // m, distance between wheel centres
    double spring_rate = 70000;       // N/m, at the wheel (wheel rate)
    double spring_rest_length = 0.25; // m, free length mount->wheel centre (also max droop)
    double max_compression = 0.12;    // m, travel from static before the bump stop
    double bump_stop_rate = 300000;   // N/m beyond max_compression
    double damper_bump = 3500;        // N s/m, compression
    double damper_rebound = 6500;     // N s/m, extension
    double anti_roll_rate = 20000;    // N/m, force per metre of left/right compression difference
    double roll_centre_height = 0.05; // m above ground: lateral tyre forces act on the body here
    double max_steer_deg = 0;         // >0 = steered axle
    double steer_compliance = 0;      // rad per N of axle lateral force (bushing/rack flex)
    double ackermann = 0.0;           // 0 = parallel steer, 1 = full Ackermann
    double static_camber_deg = -1.5;  // deg, negative = top of wheel tilted inward
    double camber_gain_rad_per_m = -0.785; // rad/m of suspension compression (~-45 deg/m double-wishbone camber recovery)
    double caster_deg = 6.8;          // deg, steering axis caster angle (induces negative camber on outer steered wheel)
    double kpi_deg = 7.0;             // deg, kingpin inclination angle
    double handbrake_torque = 0;      // N m per wheel
    bool driven = false;
    // ---- suspension kinematics (double-wishbone-like defaults; dz = compression from static, m, + = bump)
    double camber_gain2_rad_per_m2 = -4.0;  // quadratic camber curve: camber(dz) = static + g1 dz + g2 dz^2 (recovery grows in bump)
    double static_toe_deg = 0.0;            // + = toe-in
    double bump_steer_deg_per_m = 0.0;      // toe-in change per metre of bump (+ = toes in under bump)
    double roll_centre_gain = -1.8;         // roll centre height change per metre of axle heave (drops ~1.8x the body)
    double anti_pitch = 0.0;                // front: anti-dive (braking) / anti-lift (front drive); rear: anti-squat (drive)
    double anti_lift_rear_braking = 0.0;    // rear: anti-lift under braking
    // ---- dampers: digressive valving (firm at low shaft speed for body control, softer past the knee for bumps)
    double damper_knee_mps = 0.13;
    double damper_high_speed_ratio = 0.45;  // coefficient above the knee / below it
    // ---- optional explicit 3D suspension hardpoints (synthesized from parameters above if omitted in JSON)
    SuspensionHardpoints kinematics{};
};

struct DiffParams {
    std::string type = "open";        // "open", "locked", "lsd"
    double preload = 0;               // N m, LSD locking torque at zero input torque
    double power_ramp = 0;            // locking torque per N m of input torque, on power
    double coast_ramp = 0;            // ... off power (engine braking)
};

struct EngineParams {
    std::vector<std::array<double, 2>> torque_curve;   // [rpm, N m] at full throttle
    double idle_rpm = 900, redline_rpm = 7500;
    // Rev limiter (hard fuel cut): cuts at redline, refuels once the revs fall this far below it. The band is what
    // makes the revs (and the needle, and the sound) bounce on the limiter; ECU makers and tuners use ~50-150 rpm.
    double limiter_hysteresis_rpm = 100;
    double inertia = 0.25;            // kg m^2 crank + flywheel
    double friction_const = 20;       // N m, engine braking: T = c0 + c1 * omega (throttle off)
    double friction_linear = 0.03;    // N m / (rad/s)
    int cylinders = 8;                // cylinder count for 4-stroke primary exhaust pulse frequency (rpm * cyl / 120)
};

// Physical dry friction clutch disc parameters.
// Capacity: T_cap = mu(temp, slip) * F_clamp(pedal) * effective_radius_m * num_surfaces
// (Gillespie, "Fundamentals of Vehicle Dynamics"; Milliken & Milliken, RCVD).
struct ClutchParams {
    double bite_point = 0.65;                 // pedal [0..1] (0=up/engaged, 1=down/disengaged) where disc first contacts flywheel
    double full_engage_point = 0.15;          // pedal travel below which diaphragm spring reaches full clamp force (top free play)
    double effective_radius_m = 0.105;        // m, mean annular friction radius: (2/3)*(R_o^3 - R_i^3)/(R_o^2 - R_i^2)
    int num_surfaces = 2;                     // friction faces (2 = single dry plate, 4 = twin-plate)
    double mu_static = 0.42;                  // static lining friction coefficient (Karnopp stick)
    double mu_kinetic = 0.34;                 // kinetic sliding friction coefficient (Karnopp slip, mu_k < mu_s)
    double max_clamp_force_n = 0.0;           // N; <= 0 derives F_max from clutch_max_torque / (mu_static * r_eff * num_surfaces)
    double thermal_capacity_j_per_k = 1600.0; // J/K, effective thermal mass of friction disc + pressure plate face
    double cooling_base_w_per_k = 8.0;        // W/K, natural bellhousing convection
    double cooling_per_mps_w_per_k = 0.35;    // W/(K * m/s), airflow cooling with vehicle speed
    double cooling_per_rads_w_per_k = 0.03;   // W/(K * rad/s), flywheel pumping / windage cooling
    double wear_per_joule = 1.2e-8;           // 1/J, lining wear per Joule of slip energy at normal temp
    double input_shaft_inertia_kgm2 = 0.008;  // kg m^2, free inertia of clutch disc + gearbox input shaft when clutched out
};

// Physical baulk-ring synchromesh cone clutch parameters.
// Synchronizing torque: T_sync = num_cones * mu_sync * shift_fork_force_n * cone_radius_m / sin(cone_angle_deg)
// (Naunheimer et al., "Automotive Transmissions", Ch. 7).
struct SynchroParams {
    double mu_sync = 0.12;                    // wet friction cone coefficient in gear oil
    double shift_fork_force_n = 350.0;        // N, axial force on synchronizer sleeve
    double cone_radius_m = 0.038;             // m, mean synchronizer cone radius
    double cone_angle_deg = 7.0;              // deg, cone half-angle alpha (typical 6.5..7.5 deg)
    int num_cones = 2;                        // 1 = single-cone, 2 = double-cone, 3 = triple-cone
    double engage_tol_rads = 42.0;            // rad/s (~400 RPM) max speed mismatch for clean synchro dog lock
    double dog_engage_tol_rads = 95.0;        // rad/s (~900 RPM) dog-box engagement window without shift cut
};

struct DrivetrainParams {
    std::vector<double> gear_ratios;          // index 0 = reverse (negative), 1 = neutral (0), 2.. forward
    std::vector<std::array<int, 2>> gear_teeth; // optional [driven, drive] tooth pairs per gear (0=R, 1=N=[0,0], 2.. fwd)
    std::array<int, 2> final_drive_teeth{0, 0}; // optional [ring, pinion] tooth pair for differential final drive
    double final_drive = 3.7;
    double efficiency = 0.92;                 // gearbox + diff, applied to drive torque
    double clutch_max_torque = 900;           // N m static capacity at fully released pedal (used if max_clamp_force_n <= 0)
    double driveline_inertia = 0.05;          // kg m^2 gearbox + driveshaft inertia reflected to input shaft
    std::string layout = "rwd";               // "rwd", "fwd", "awd"
    std::string transmission;                 // optional: "" (default), "h_pattern", "dog_box", "dct"
    double awd_front_split = 0.4;             // torque fraction to the front (centre diff)
    DiffParams front_diff, rear_diff, centre_diff;
    ClutchParams clutch;
    SynchroParams synchro;
};

struct AeroParams {
    double air_density = 1.225;
    double drag_area = 0.68;          // Cd * A, m^2
    double lift_area = 0.3;           // Cl * A (downforce positive), m^2
    double front_balance = 0.45;      // fraction of downforce on the front axle
    // Ride-height sensitivity: underbody and diffuser work harder closer to the road; nose-down pitch moves the
    // aero balance forward. Changes per metre of mean / front-minus-rear compression from static.
    double ground_effect_per_m = 1.5;     // downforce * (1 + this * mean compression), clamped 0.6 .. 1.5
    double pitch_balance_per_m = 1.0;     // front balance + this * (front - rear compression)
};

struct CarConfig {
    std::string name;
    double mass = 1450;                       // kg, total (sprung + unsprung; wheels massless here)
    double cg_height = 0.47;                  // m above ground at static ride height
    double weight_front = 0.48;               // static front axle load fraction
    double wheelbase = 2.65;
    double inertia_xx = 550, inertia_yy = 2100, inertia_zz = 2400;   // kg m^2 about the CG
    double brake_bias_front = 0.62;           // fraction of total brake torque on the front axle
    double brake_torque_total = 7000;         // N m, all four wheels together at full pedal (pads in their range)
    BrakeThermal brake_thermal;
    AxleParams front, rear;
    TireParams tire_front, tire_rear;
    EngineParams engine;
    DrivetrainParams drivetrain;
    AeroParams aero;
    std::vector<std::pair<std::string, double>> surface_grip;   // surface name -> grip multiplier

    // derived (set by finalize())
    std::array<WheelGeom, 4> wheels{};        // 0 FL, 1 FR, 2 RL, 3 RR
    double dist_cg_front = 0, dist_cg_rear = 0;
    std::array<std::shared_ptr<const AxleKinematicsTable>, 2> axle_kinematics{}; // 0 front, 1 rear

    const AxleParams& axle(int wheel) const { return wheel < 2 ? front : rear; }
    const TireParams& tire(int wheel) const { return wheel < 2 ? tire_front : tire_rear; }
    double grip_for_surface(int surface_index) const;
    int surface_index(const std::string& name) const;
    void finalize();   // computes wheel geometry so the car sits at cg_height when at rest
};

// Throws std::runtime_error with a readable message on missing/invalid fields.
/** Tyre compound presets ("road", "semi_slick", "slick"): thermal window, reset temperature, tread wear rate.
 *  Throws on an unknown name. Car files set it per tyre with "compound"; explicit keys still override it. */
void apply_compound(TireParams& t, const std::string& compound, const std::string& ctx = "tyre");

CarConfig load_car_config(const std::string& path);
CarConfig parse_car_config(const std::string& json_text);

enum Wheel { FL = 0, FR = 1, RL = 2, RR = 3 };

}  // namespace rs
