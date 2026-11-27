// Car configuration: everything that defines a car's physics, loaded from data/cars/*.json
// (schema "car/1", see data/schema/car.schema.json). Adding a car needs no code changes.
#pragma once
#include <array>
#include <memory>
#include <string>
#include <vector>
#include "rs/kinematics.hpp"

namespace rs {

// Pacejka "Magic Formula" coefficients (MF 6.2). Notation follows Pacejka,
// "Tire and Vehicle Dynamics" (3rd ed.), chapter 4 & 7. See docs/physics.md for the equations.
struct TireParams {
    double radius = 0.33;             // m, nominal unloaded/reference radius R0
    double inertia = 1.0;             // kg m^2, wheel + tyre + brake disc about the axle
    double fz0 = 4000;                // N, nominal load Fz0 the coefficients refer to
    double vertical_stiffness = 220000; // N/m, radial carcass stiffness C_Fz (effective rolling radius)
    // longitudinal (pure slip, MF 6.2)
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
    // lateral (pure slip + camber, MF 6.2)
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
    // combined slip weighting (MF 6.2: Gxa, Gyk, SVyk)
    double rbx1 = 12.0, rbx2 = 10.0, rbx3 = 0.0, rcx1 = 1.0, rex1 = -0.05, rex2 = -0.02, rhx1 = 0.0;
    double rby1 = 10.0, rby2 = 10.0, rby3 = 0.0, rby4 = 0.0, rcy1 = 1.0, rey1 = -0.05, rey2 = -0.02, rhy1 = 0.0, rhy2 = 0.0;
    double rvy1 = 0.0, rvy2 = 0.0, rvy3 = -0.15, rvy4 = 14.0, rvy5 = 1.9, rvy6 = 10.0;
    // self-aligning moment Mz (pneumatic trail t + residual torque Mzr + Fx arm s, MF 6.2)
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
    // MF 6.2 additions
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
    // MF 6.2 turn slip (spin): peak lateral force and cornering stiffness drop when the contact patch also rotates
    // (tight turns at low speed, parking). Pacejka's default coefficients.
    double pdyp1 = 0.4, pdyp2 = 0.0, pdyp3 = 0.0, pdyp4 = 0.0, pkyp1 = 1.0;
    // Thermal window: core/surface blend temperature with full grip (C), and the half-width of the window.
    double temp_optimal_c = 90, temp_window_c = 25;
    // Tyre temperature at reset (C, carcass and tread: warmed, like the brakes) and tread wear per MJ of friction
    // work (wear 1 = tread gone). Set together by the car file's "compound" (road / semi_slick / slick).
    double start_c = 80;
    double wear_per_mj = 1.0 / 90.0;
    double wear_grip_loss = 0.15;     // smooth tread wear grip loss at wear = 1.0
    double wear_cliff_loss = 0.02;    // extra late-stint wear cliff drop past 70% tread wear (slicks drop off sharply)
    double hysteresis_loss_factor = 1.0; // compound viscoelastic loss tangent scale (road ~0.65, semi_slick ~0.78, slick ~1.85)
    double tread_cooling_scale = 1.0;    // convective cooling factor: grooved road tread = 1.0, smooth zero-void slick ~ 0.66
    // Wet-weather tread evacuation & compound chemistry (defaults match calibrated road tyre: 7.5 mm tread, 28% void)
    double tread_depth_new_mm = 7.5;     // mm, fresh tread groove depth (slick 0.5, semi_slick 4.5, road 7.5, inter 6.2, wet 8.8)
    double tread_void_ratio = 0.28;      // 0..0.55 groove void area fraction (slick 0.02, semi_slick 0.16, road 0.28, inter 0.34, wet 0.45)
    double wet_chemical_grip = 1.0;      // compound low-temp wet adhesion factor (slick 0.72, road 1.0, inter 1.12, full wet 1.24)
    double dry_overheat_wear_mult = 1.0; // dry-tarmac block-squirm heating & wear multiplier for grooved wet/inter compounds (wet 3.2)
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
    // MF 6.2 additions: asymmetric pressure cornering stiffness, camber-squared curvature, pressure-dependent
    // aligning trail/residual torque, force-coupled loaded-radius deflection, and overturning moment Mx (QSX1..14).
    double ppy5 = 0.0;                // MF 6.2 asymmetric pressure scaling of lateral peak friction
    double pey5 = 0.0;                // MF 6.2 camber-squared curvature term in Ey
    double ppz1 = -0.45;              // MF 6.2 inflation-pressure dependency of pneumatic trail Dt (1 + pPz1 * dpi)
    double ppz2 = 0.55;               // MF 6.2 inflation-pressure dependency of residual aligning torque Dr (1 + pPz2 * dpi)
    double qfcx = 0.04;               // MF 6.2 longitudinal force-coupled radial carcass compression factor
    double qfcy = 0.06;               // MF 6.2 lateral force-coupled radial carcass compression factor
    double qsx1 = 0.0;                // MF 6.2 overturning moment Mx vertical/lateral offset
    double qsx2 = 0.30;               // MF 6.2 overturning moment Mx camber righting term (+R0*Fz*qSx2*gamma in ISO)
    double qsx3 = 0.012;              // MF 6.2 overturning moment Mx lateral force term (+R0*Fz*qSx3*Fy/Fz0 in ISO)
    double qsx13 = 0.0;               // MF 6.2 optional alternate lateral-force arm (0 when qSx3 is active)
    double ppmx1 = 0.15;              // MF 6.2 inflation-pressure sensitivity of Mx camber term
    double mbelt = 5.4;               // kg, steel tread belt mass (MBELT = 5.4 kg for 245/40 R18, scaled by tire width/radius)
    double section_width_m = 0.245;   // m, nominal tire section width (WIDTH)
    double aspect_ratio = 0.40;       // sidewall aspect ratio (ASPECT_RATIO, e.g. 0.40 for 245/40 R18)
};

/** Brake disc material archetype: determines friction-vs-temperature curve, specific heat & radiative emissivity. */
enum class BrakeDiscType : int {
    CastIron = 0,       // Street / GT iron rotor: strong cold bite (0.86), 300-650 C plateau, fades > 700 C
    CarbonCeramic = 1,  // Supercar CCM rotor: 0.84 cold, flat plateau to 780 C, high thermal fade ceiling
    CarbonCarbon = 2    // LMU Hypercar / LMP2 / F1 carbon-carbon: low cold bite (0.58), steep 350-650 C bite surge (1.04), high emissivity
};

/** Brakes: disc + pad thermal model (per axle). */
struct BrakeThermal {
    BrakeDiscType disc_type = BrakeDiscType::CastIron;
    double disc_mass_front = 8.5, disc_mass_rear = 6.0;   // kg (cast iron, c = 460 J/kg K; carbon c = 710 J/kg K)
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
    double spring_progressive_rate = 0.0; // N/m^2 quadratic progressive coil stiffening beyond static ride height (0 = linear)
    double bump_stop_gap_m = 0.0;     // m, progressive polyurethane packer lead-in before max_compression (0 = hard edge)
    double bump_stop_exponent = 1.0;  // 1.0 = linear bump stop; ~2.2-3.0 = exponential polyurethane jounce bumper
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
    double damper_hysteresis_n = 0.0;       // N, gas-pressurized monotube shock seal / bleed hysteresis
    // ---- third / heave spring & heave damper (GT3 / Hypercar aero-platform control decoupled from single-wheel roll/kerbs)
    double heave_spring_rate = 0.0;         // N/m, symmetric axle heave spring (0 = none; engages past heave_gap_m)
    double heave_gap_m = 0.0;               // m, free heave travel / packer gap from static ride height
    double heave_damper_bump = 0.0;         // N s/m, symmetric axle heave bump damping
    double heave_damper_rebound = 0.0;      // N s/m, symmetric axle heave rebound damping
    // ---- elastokinematic suspension bushing compliance (rubber street bushings vs spherical race bearings)
    // Defaults to 0.0 so legacy configs keep exact rigid-hardpoint numbers; game/UE5 or JSON can enable compliance.
    double toe_compliance_rad_per_kn_fx = 0.0;        // rad/kN: + = toe-in under braking (-Fx)
    double toe_compliance_rad_per_kn_fy = 0.0;        // rad/kN: + = compliance toe-in under outward cornering Fy
    double camber_compliance_rad_per_kn_fy = 0.0;     // rad/kN: + = loaded outer wheel loses negative camber under Fy
    double longitudinal_compliance_m_per_kn_fx = 0.0; // m/kN: fore-aft hub recession under braking/kerb Fx
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
    std::string voice;                // engine sound id from the car file ("v12_na", "flat6_na", ...); empty = guess from the name
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

// Hydraulic torque converter + lock-up clutch (TCC) parameters for automatic transmissions ("transmission": "auto_tc").
// Kotwicki / Hrovat-Tobler fluid coupling model: T_pump = C(SR) * w_pump^2, T_turbine = TR(SR) * T_pump.
struct TorqueConverterParams {
    double stall_torque_ratio = 2.15;     // torque multiplication at stall (SR = 0; typically 1.8 .. 2.4)
    double coupling_speed_ratio = 0.85;   // SR where stator freewheels and TR(SR) reaches 1.0
    double stall_k_factor = 145.0;        // RPM / sqrt(N m): lower = tighter sport converter, higher = looser high-stall
    double lockup_speed_ratio = 0.86;     // SR above which the TCC mechanical lock-up clutch engages
    double lockup_min_speed_mps = 14.0;   // m/s (~50 km/h) minimum road speed for TCC lock-up
    int lockup_min_gear = 4;              // gear index (0=R, 1=N, 2=1st, 3=2nd, 4=3rd) for TCC lock-up
};

// Motorsport sequential dog-box pneumatic paddle-shift parameters ("transmission": "dog_box").
struct DogBoxParams {
    double upshift_cut_s = 0.050;         // s, flat-foot ignition cut unloading undercut dog rings (zero clutch pedal)
    double downshift_unload_s = 0.015;    // s, pneumatic dog-ring unload across neutral before engagement
    double downshift_blip_max_s = 0.085;  // s, closed-loop electronic throttle auto-blip window on downshifts
    double blip_throttle_gain = 0.0032;   // throttle per rad/s RPM deficit during pneumatic downshift auto-blip
    double engage_clunk_nm = 260.0;       // N m, crisp mechanical dog-ring engagement impulse
    bool auto_blip = true;                // electronic throttle auto-blip on downshifts
};

// Single-clutch automated manual (ISR / F1 AMT) electro-hydraulic shift parameters ("transmission": "amt").
struct AmtParams {
    double upshift_cut_s = 0.068;         // s, electro-hydraulic single-clutch disconnect + shift-fork throw
    double upshift_reengage_s = 0.024;    // s, crisp hydraulic clutch snap back through bite point (the AMT kick)
    double downshift_blip_max_s = 0.095;  // s, closed-loop heel-toe throttle rev-match window on downshifts
    double downshift_reengage_s = 0.028;  // s, smooth hydraulic clutch re-engagement after rev-match
    double blip_throttle_gain = 0.0028;   // throttle per rad/s RPM deficit during automated heel-toe blip
    double fork_force_n = 720.0;          // N, electro-hydraulic shift-fork actuator force (~2x human hand)
    double engage_clunk_nm = 185.0;       // N m, single-clutch hydraulic re-engagement driveline kick impulse
};

enum class PowerSteeringMode : int {
    Manual = 0,       // Unassisted rack-and-pinion (raw mechanical feel)
    Hydraulic = 1,    // Engine-driven hydraulic boost with relief-valve saturation
    ElectricEps = 2   // Speed-sensitive electric power steering (light parking, firm at speed)
};

// Physical steering column & speed-sensitive power-steering boost parameters (feeds steering_column_torque_nm FFB).
struct SteeringParams {
    PowerSteeringMode assist_mode = PowerSteeringMode::Hydraulic;
    double steer_ratio = 14.5;               // steering wheel angle / front road-wheel angle
    double assist_gain_low_speed = 0.65;     // low-speed rack load boost fraction (0 = manual .. 0.85 = very light)
    double assist_gain_high_speed = 0.35;    // high-speed rack load boost fraction (firms up at speed)
    double assist_speed_ref_mps = 35.0;      // m/s (~126 km/h) speed where boost transitions to high-speed gain
    double max_assist_torque_nm = 340.0;     // N m rack-side relief / EPS saturation ceiling (kerb hits punch through)
    double rack_friction_nm = 4.5;           // N m rack & kingpin dry/seal Coulomb friction
    double column_damping_nms_per_rad = 18.0;// N m s/rad hydraulic/column viscous damping at rack scale
    double column_inertia_kgm2 = 0.045;      // kg m^2 steering wheel + column rotational inertia
    double column_stiffness_nm_per_rad = 180.0; // N m/rad elastic steering column + tie-rod compliance stiffness (LMU DD feel)
};

// Hybrid ERS / MGU-K electric motor, regenerative Brake-by-Wire (BBW) & front-axle e-AWD (LMU Hypercar / modern supercars).
struct HybridParams {
    bool enabled = false;
    double max_deploy_kw = 200.0;            // kW, peak electric deployment power (200 kW = WEC LMH/Hypercar)
    double max_regen_kw = 200.0;             // kW, peak regenerative braking harvest power
    double max_torque_nm = 2200.0;           // N m, electric motor wheel-side axle torque ceiling (motor torque x reduction gear)
    double battery_capacity_mj = 4.0;        // MJ, usable HV battery capacity (4 MJ = endurance race stint pack)
    double front_deploy_min_speed_mps = 0.0; // m/s, minimum speed before front e-AWD activates (52.8 m/s = 190 km/h LMH rule, 0 = street)
    bool front_axle_motor = true;            // true = front-axle e-AWD motor (499P / SF90 / 918), false = rear-axle MGU-K (LMDh / F1)
    bool brake_by_wire = true;               // true = subtract MGU-K regen torque from hydraulic calipers on regen axle to hold steady pedal feel
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
    std::string transmission;                 // optional: "" (default), "h_pattern", "dog_box", "dct", "auto_tc", "amt"
    double awd_front_split = 0.4;             // torque fraction to the front (centre diff)
    DiffParams front_diff, rear_diff, centre_diff;
    ClutchParams clutch;
    SynchroParams synchro;
    TorqueConverterParams torque_converter;
    DogBoxParams dog_box;
    AmtParams amt;
    HybridParams hybrid;
};

// Active aerodynamics. A car has it only if its spec says so ("aero": {"drs": true, "airbrake": true}); the vehicle also needs
// chassis_dynamics().active_aero_enabled (the game and the Unreal plugin switch that on). DRS: a flat, low-drag wing at full throttle
// on a straight above 50 m/s. Airbrake: a steep wing that adds drag and rear downforce under hard braking above 22 m/s.
inline constexpr double kDrsDragMult = 0.86, kDrsRearDownMult = 0.82;
inline constexpr double kAirbrakeDragMult = 1.24, kAirbrakeRearDownMult = 1.22;

// Optional 2D Front/Rear Ride-Height Aerodynamic Lookup Map (front_rh_m x rear_rh_m -> ClA_front, ClA_rear, CdA).
// Captures non-linear ground-effect suction peak, pitch sensitivity, front splitter stall, and diffuser rake stall.
struct AeroMap2D {
    std::vector<double> front_rh_m;   // sorted ascending front ride heights (m)
    std::vector<double> rear_rh_m;    // sorted ascending rear ride heights (m)
    std::vector<double> cl_front;     // row-major [i_f * nr + i_r], front downforce area ClA_f (m^2)
    std::vector<double> cl_rear;      // row-major [i_f * nr + i_r], rear downforce area ClA_r (m^2)
    std::vector<double> cd;           // row-major [i_f * nr + i_r], total drag area CdA (m^2)

    bool valid() const {
        const std::size_t n = front_rh_m.size() * rear_rh_m.size();
        return front_rh_m.size() >= 2 && rear_rh_m.size() >= 2 &&
               cl_front.size() == n && cl_rear.size() == n && cd.size() == n;
    }
    void sample(double h_f, double h_r, double& out_clf, double& out_clr, double& out_cd) const;
};

struct AeroParams {
    bool drs = false;                 // the car has a DRS-style low-drag wing mode
    bool airbrake = false;            // the car has an airbrake wing mode
    double air_density = 1.225;
    double drag_area = 0.68;          // Cd * A, m^2
    double lift_area = 0.3;           // Cl * A (downforce positive), m^2
    double front_balance = 0.45;      // fraction of downforce on the front axle
    // Ride-height sensitivity: underbody and diffuser work harder closer to the road; nose-down pitch moves the
    // aero balance forward. Changes per metre of mean / front-minus-rear compression from static.
    double ground_effect_per_m = 1.5;     // downforce * (1 + this * mean compression), clamped 0.6 .. 1.5
    double pitch_balance_per_m = 1.0;     // front balance + this * (front - rear compression)
    double static_ride_height_front_m = 0.11; // m, static front splitter/undertray clearance
    double static_ride_height_rear_m = 0.125; // m, static rear diffuser clearance
    double diffuser_stall_rake_m = 0.065;     // m, excessive rear-high rake (h_r - h_f) where diffuser stalls
    double steer_downforce_loss = 0.18;       // front wheel-wake floor/bargeboard downforce loss scale vs steer^2
    double steer_balance_shift = -0.06;       // front aero balance shift vs |steer| (negative = rearward shift mid-corner)
    double steer_drag_gain = 0.12;            // exposed front-tyre steering drag gain vs steer^2
    AeroMap2D map_2d;                         // optional explicit 2D ride-height aero table
};

struct CarConfig {
    std::string name;
    double mass = 1450;                       // kg, total (sprung + unsprung; wheels massless here)
    double cg_height = 0.47;                  // m above ground at static ride height
    double weight_front = 0.48;               // static front axle load fraction
    double wheelbase = 2.65;
    double inertia_xx = 550, inertia_yy = 2100, inertia_zz = 2400;   // kg m^2 about the CG
    double torsional_stiffness_nm_per_deg = 0.0; // N m/deg (<= 0 falls back to ChassisDynamicsConfig default)
    double brake_bias_front = 0.62;           // fraction of total brake torque on the front axle at peak pressure
    double brake_migration_front = 0.0;       // BMIG: dynamic front bias reduction as driver trails off brake pedal (e.g. 0.04 = -4% at 0 pedal)
    double brake_torque_total = 7000;         // N m, all four wheels together at full pedal (pads in their range)
    BrakeThermal brake_thermal;
    AxleParams front, rear;
    TireParams tire_front, tire_rear;
    EngineParams engine;
    DrivetrainParams drivetrain;
    AeroParams aero;
    SteeringParams steering;
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
