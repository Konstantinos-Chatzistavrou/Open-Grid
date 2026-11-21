// Tyre model:
//   - Pacejka Magic Formula (MF 5.2 / 6.1 / 6.2) calibrated to measured PAC2002 tire datasets
//   - 4x4 Multi-Point Contact Patch Grid (Winkler elastic foundation + Pacejka Ch. 3 Brush Model adhesion/sliding
//     zones, Dugoff 1970 combined-slip saturation, per-point yaw spin & camber conicity, kerb/partial-contact loads)
//   - Explicit 3-Node Thermal & Pressure Dynamics (3-Rib Surface + WLF Flash <-> Carcass/Belt <-> Inner Cavity Air,
//     Ideal Gas Law P/T_K = P_cold/T_cold_K coupling contact patch length, vertical/cornering stiffness & rolling drag)
//   - Continuous Stribeck + Persson Viscoelastic Sliding Friction Transition for progressive breakaway & controllable drifts
//   - MF-Swift Rigid-Ring Belt Dynamics (40-90 Hz) + 3D Tandem-Cam Enveloping + Toroidal Cavity NVH Acoustics.
#pragma once
#include <algorithm>
#include <array>
#include "rs/config.hpp"

namespace rs {

constexpr int kPatchRows = 4;    // longitudinal stations along contact length 2a (0 = trailing -x .. 3 = leading +x)
constexpr int kPatchCols = 4;    // lateral stations across tread width 2b (0 = right -y .. 3 = left +y, ISO 8855)
constexpr int kPatchPoints = kPatchRows * kPatchCols;

// Per-cell road profile over the 4x4 contact patch (row-major: idx = row * 4 + col).
// row 0..3 = trailing (-0.75a) .. leading (+0.75a); col 0..3 = right (-0.75b) .. left (+0.75b) in ISO tyre frame.
struct ContactPatchProfile {
    bool has_height_map = false;                       // true when road_dz_m, mu_cell, or contact_mask is non-uniform
    std::array<double, kPatchPoints> road_dz_m{};      // local road elevation relative to mean contact plane (+ = raised kerb), m
    std::array<double, kPatchPoints> mu_cell{          // local per-cell surface grip multiplier (asphalt=1, kerb=0.92, grass=0.6)
        1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
        1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0
    };
    std::array<bool, kPatchPoints> contact_mask{       // false when cell hangs over a drop-off / air gap
        true, true, true, true, true, true, true, true,
        true, true, true, true, true, true, true, true
    };
};

// Optional diagnostic snapshot from the 4x4 contact patch solver (for tests, telemetry, and tuning).
struct ContactPatchOutput {
    std::array<double, kPatchPoints> cell_fz{};        // per-cell normal load Fz_ij (N), sums to total Fz
    std::array<double, kPatchPoints> cell_fx{};        // per-cell longitudinal force (N)
    std::array<double, kPatchPoints> cell_fy{};        // per-cell lateral force (N)
    std::array<double, kPatchPoints> cell_adhesion{};  // per-cell brush adhesion fraction (1 = pure adhesion, 0 = full slide)
    double patch_length_m = 0.0;                       // total contact patch length 2a (m)
    double patch_width_m = 0.0;                        // total contact patch width 2b (m)
    int loaded_cells = 0;                              // number of cells with Fz_ij > 0
    double adhesion_ratio = 1.0;                       // load-weighted mean adhesion fraction across patch (0..1)
    bool used_full_grid = false;                       // true if full 16-cell integration ran (false if flat-road analytical path)
};

struct TireForces {
    double fx = 0;               // longitudinal force in the tyre frame (+ = forward), N
    double fy = 0;               // lateral force in the tyre frame (+ = left), N
    double mz = 0;               // self-aligning moment about contact normal (+ = CCW from above), N m
    double pneumatic_trail = 0;  // instantaneous pneumatic trail t, m
    double effective_rib_mu = 1; // load-weighted 3-rib (Inner/Middle/Outer) + WLF flash-temp grip multiplier
    double thermal_stiffness_scale = 1; // Simcenter 2606 T&V cornering/slip stiffness modulus factor (stiffer cold, softer hot)
    double contact_patch_length_m = 0;  // instantaneous contact patch length 2a (m), sensitive to load & inflation pressure
    double adhesion_ratio = 1.0;        // fraction of contact patch load in brush adhesion zone (1 = grip, 0 = full slide)
};

// Simcenter Tire 2606 Broadband Transient Tire-Road NVH & Cavity Resonance Acoustic Source (for UE5 MetaSounds).
struct TireAcousticSource {
    double cavity_mode_low_hz = 224.0;   // Toroidal air-cavity backward-wave resonance frequency (Hz, Doppler split)
    double cavity_mode_high_hz = 224.0;  // Toroidal air-cavity forward-wave resonance frequency (Hz, Doppler split)
    double tread_block_pitch_hz = 0.0;   // Tread-pattern block impact modulation frequency (N_blocks * rps, Hz)
    double transient_volume_accel = 0.0; // Broadband transient volume-displacement acceleration on cleats/curbs (m^3/s^2)
    double cavity_ring_gain = 0.0;       // 0..1 excitation amplitude of the ~225 Hz hollow tire cavity boom
};

// Tyre thermal, pressure & wear state. Explicit 3-node thermal network (Kelly & Sharp 2010; Farroni et al. 2014):
//   1. SURFACE (surface_c + 3 lateral ribs inner_c / middle_c / outer_c, plus ~8 ms WLF micro-asperity flash_c):
//      outer 2-3 mm tread rubber heated by frictional slip power; affects grip immediately (overheated = greasy).
//   2. CARCASS (temperature_c / carcass_c()): bulk belt & sidewall (~30 s response), heated by conduction from surface
//      and rolling hysteresis flexing (pressure-dependent).
//   3. INNER AIR (inner_air_c): enclosed cavity gas exchanging heat with carcass inner liner and wheel rim; sets
//      inflation pressure directly via the ideal gas law (P_abs / T_K = P_cold_abs / T_cold_K).
struct TireCondition {
    double temperature_c = 80.0;  // Node 2: carcass / bulk belt temperature, C
    double surface_c = 80.0;      // Node 1: mean tread surface temperature, C
    double inner_air_c = 53.0;    // Node 3: cavity inner air temperature, C (53 C -> ~220 kPa nominal from 188 kPa cold @ 20 C)
    double flash_c = 80.0;        // micro-asperity WLF flash temperature, C (~8 ms response time)
    double pressure_kpa = 0.0;    // gauge, directly from ideal gas law on inner_air_c (0 until the first update)
    double contact_patch_length_m = 0.19; // latest contact patch length 2a (m)
    double wear = 0.0;            // 0 = new, 1 = worn out
    double inner_c = 80.0;        // Inner shoulder tread surface temperature (C) — heated by negative camber on straights
    double middle_c = 80.0;       // Center rib tread surface temperature (C) — heated more at high inflation pressure
    double outer_c = 80.0;        // Outer shoulder tread surface temperature (C) — heated heavily by cornering roll onto outer edge
    double flat_spot_depth_mm = 0.0;  // 0..3.0 mm local tread flat spot ground during locked-wheel skids
    double flat_spot_phase_rad = 0.0; // Wheel rotation angle (rad) where the flat spot sits
    double blistering = 0.0;      // 0..1 internal rubber blistering from sustained core+surface overheating (> 130 C)
    double graining = 0.0;        // 0..1 surface tearing from high lateral slip while core is cold (< 60 C)
    double ambient_air_c = 30.0;  // Ambient air temperature (C) for convective tread & rim cooling
    double track_surface_c = 30.0;// Asphalt road surface temperature (C) for conductive contact-patch heat transfer
    std::array<double, 3> rib_contact_shares{1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0}; // 16-point 3D geometric load shares (Inner, Middle, Outer)

    // Simcenter Tire 2606 MF-Swift Rigid-Ring Belt Dynamics (40-90 Hz steel-belt carcass ring vibration relative to rim)
    double belt_torsion_rad = 0.0;      // in-plane torsional deflection of tread belt ring vs wheel rim (rad)
    double belt_torsion_vel_rads = 0.0; // in-plane torsional angular velocity of belt ring vs rim (rad/s)
    double belt_lateral_m = 0.0;        // out-of-plane lateral sidewall deflection of belt ring vs rim (m)
    double belt_lateral_vel_mps = 0.0;  // out-of-plane lateral velocity of belt ring vs rim (m/s)
    double enveloping_slope_tan = 0.0;  // MF-Swift 3D tandem-cam obstacle enveloping slope tan(beta_env)

    // Internal change trackers (allows legacy tests that teleport temperature_c directly to stay consistent
    // while keeping continuous 3-node ODE integration pure during simulation).
    double last_carcass_c_ = 80.0;
    double last_inner_air_c_ = 53.0;

    double carcass_c() const { return temperature_c; }
    void set_environment_celsius(double air_c, double track_c) { ambient_air_c = air_c; track_surface_c = track_c; }
    /** Ideal gas law gauge pressure (kPa) from inner_air_c: P_abs = P_cold_abs * (T_air_K / 293.15). */
    double ideal_gas_pressure_kpa(const TireParams* p = nullptr) const;
    void step_rigid_ring_belt(double fx_n, double fy_n, double radius_m, double dt, const TireParams* p = nullptr);
    /** Simcenter Tire 2606 T&V (Temperature & Velocity) shear-modulus stiffness factor for K_xk and K_ya. */
    double thermal_stiffness_factor(const TireParams* p = nullptr) const;
    /** Simcenter Tire 2606 Broadband Transient Tire-Road NVH & Toroidal Cavity Resonance Acoustic Source. */
    TireAcousticSource compute_acoustics(double wheel_omega_rads, double radius_m, double carcass_deflection_rate_mps) const;
    void update(double slip_power_w, double load_n, double speed_mps, double dt, const TireParams* p = nullptr);
    void update_zones(double slip_power_w, double load_n, double speed_mps, double camber_rad, double lateral_force_n,
                      double wheel_side_sign, double wheel_omega_rads, double wheel_angle_rad, double dt,
                      const TireParams* p = nullptr);
    double flat_spot_ffb_torque_nm(double wheel_angle_rad, double load_n, double speed_mps) const;
    double imo_spread_c() const { return std::max({inner_c, middle_c, outer_c}) - std::min({inner_c, middle_c, outer_c}); }
    double zone_health_grip_factor() const;
    /** Williams-Landel-Ferry (WLF) viscoelastic master-curve grip factor at a given rib + flash temperature. */
    double wlf_rib_grip_factor(double rib_surface_c, const TireParams* p = nullptr) const;
    double grip_factor(const TireParams* p = nullptr) const;
    /** Relative pressure change dpi = (p - p_nom) / p_nom (MF 6.1 / 6.2). */
    double dpi(const TireParams& p) const;
};

// Operating state passed to the Magic Formula / 4x4 contact patch solver besides the slips.
struct TireOperating {
    double slip_speed = 0;        // |v_slip| m/s: Stribeck + LMUV friction transition with sliding speed
    double dpi = 0;               // relative inflation pressure change (p - p_nom) / p_nom
    double phi = 0;               // turn slip (spin) 1/m: -(yaw rate of the wheel) / V_cx (MF 6.1)
    bool enable_mf62_hybrid = false;          // enables MF 6.2 camber coupling + 3-Rib WLF flash temp + gyroscopic torque
    bool enable_contact_patch_grid = true;    // enables 4x4 multi-point contact patch brush-MF integration
    bool force_full_patch_grid = false;       // bypasses flat-road analytical fast-path to always run all 16 cells
    double wheel_side_sign = -1.0;            // -1.0 for left wheels (FL/RL), +1.0 for right wheels (FR/RR)
    double gamma_rate_rads = 0.0;             // camber rate d(gamma)/dt (rad/s) for gyroscopic belt precession torque QTZ1
    double rolling_speed_mps = 0.0;           // wheel longitudinal rolling speed V_x (m/s)
    double yaw_rate_rads = 0.0;               // wheel yaw rate about contact normal (+ = CCW/left, rad/s) for patch spin
    const TireCondition* condition = nullptr; // optional pointer to 3-node thermal + 3-rib I/M/O + WLF flash state
    const ContactPatchProfile* patch = nullptr; // optional 4x4 road height / kerb / per-cell mu / partial-contact map
    ContactPatchOutput* patch_out = nullptr;  // optional diagnostic output populated by the 4x4 grid solver
};

// Contact patch half-length a (m) from radial carcass deflection rho = Fz / C_Fz(dpi) (Pacejka Ch. 3 & MF-Swift).
// Total contact patch length is 2a; higher inflation pressure stiffens C_Fz(dpi) and shortens the patch.
double contact_patch_half_length(const TireParams& p, double fz, double dpi = 0.0);

// Inflation-pressure and speed-dependent rolling resistance coefficient C_rr (SAE J2452 / Pacejka Ch. 9).
// Higher inflation pressure reduces sidewall hysteresis flexing and lowers rolling drag.
double rolling_resistance_coeff(const TireParams& p, double speed_mps, double dpi = 0.0);

// Smooth C-infinity Stribeck + Persson/LMUV static-to-kinetic sliding friction multiplier vs sliding speed
// and tread surface / micro-asperity flash temperature (Armstrong-Helouvry 1994; Persson 2001; Pacejka MF 6.1).
double stribeck_friction_factor(const TireParams& p, double slip_speed_mps,
                                double surface_c = 90.0, double flash_c = 90.0);

// Explicit 4x4 multi-point contact patch brush + calibrated Magic Formula solver (Pacejka Ch. 3 Brush Model,
// Dugoff 1970 combined-slip saturation, Winkler elastic-bed load solver).
TireForces evaluate_contact_patch_grid(const TireParams& p, double kappa, double tan_alpha, double fz,
                                       double mu_scale, double gamma = 0.0, const TireOperating& op = {});

// kappa: longitudinal slip ratio (-), tan_alpha: tangent of the slip angle (-, + gives +Fy),
// fz: vertical load (N), mu_scale: surface/condition grip multiplier,
// gamma: inclination / camber angle in the tyre frame (rad, + = top tilted toward +left).
TireForces magic_formula(const TireParams& p, double kappa, double tan_alpha, double fz, double mu_scale, double gamma = 0.0,
                         const TireOperating& op = {});

// Pure-slip curves and self-aligning moment, exposed for tests/plots.
double mf_pure_fx(const TireParams& p, double kappa, double fz, double mu_scale, double gamma = 0.0, double dpi = 0.0);
double mf_pure_fy(const TireParams& p, double alpha, double fz, double mu_scale, double gamma = 0.0, double dpi = 0.0);
double mf_aligning_torque(const TireParams& p, double kappa, double alpha, double fz, double mu_scale, double gamma,
                          double fx, double fy_no_svyk, double* out_trail = nullptr);

// Effective rolling radius R_e under vertical load Fz (Pacejka Ch. 4 BREFF/DREFF/FREFF) and MF 6.2/Simcenter 2606
// camber-conicity, inflation-pressure stiffness PFZ1, and high-speed centrifugal steel-belt growth.
double effective_rolling_radius(const TireParams& p, double fz);
double effective_rolling_radius_mf62(const TireParams& p, double fz, double gamma, double dpi = 0.0,
                                     double wheel_omega_rads = 0.0);

// Load-, camber-, and pressure-dependent transient relaxation lengths sigma_x(Fz), sigma_y(Fz, gamma) (Pacejka Ch. 7 + PTX/PTY).
void relaxation_lengths(const TireParams& p, double fz, double gamma, double& sigma_x, double& sigma_y, double dpi = 0.0);

}  // namespace rs
