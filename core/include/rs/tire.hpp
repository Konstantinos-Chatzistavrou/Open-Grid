// Tyre model: Siemens Simcenter Tire 2606 (MF-Tyre / MF-Swift 2606 June 2026 architecture) +
// Pacejka Magic Formula (MF 5.2 / 6.1 / 6.2) + WLF Viscoelastic Flash-Temperature +
// Physical 3-Rib (Inner / Middle / Outer) Contact-Patch Integration + T&V Thermal Stiffness Coupling +
// MF-Swift Rigid-Ring Belt Dynamics (40-90 Hz In-Plane/Out-of-Plane Eigenmodes) +
// 3D Tandem Elliptical Cam Obstacle Enveloping + Simcenter 2606 Broadband Transient Tire-Road NVH Acoustics.
#pragma once
#include <algorithm>
#include "rs/config.hpp"

namespace rs {

struct TireForces {
    double fx = 0;               // longitudinal force in the tyre frame (+ = forward), N
    double fy = 0;               // lateral force in the tyre frame (+ = left), N
    double mz = 0;               // self-aligning moment about contact normal (+ = CCW from above), N m
    double pneumatic_trail = 0;  // instantaneous pneumatic trail t, m
    double effective_rib_mu = 1; // load-weighted 3-rib (Inner/Middle/Outer) + WLF flash-temp grip multiplier
    double thermal_stiffness_scale = 1; // Simcenter 2606 T&V cornering/slip stiffness modulus factor (stiffer cold, softer hot)
};

// Simcenter Tire 2606 Broadband Transient Tire-Road NVH & Cavity Resonance Acoustic Source (for UE5 MetaSounds).
struct TireAcousticSource {
    double cavity_mode_low_hz = 224.0;   // Toroidal air-cavity backward-wave resonance frequency (Hz, Doppler split)
    double cavity_mode_high_hz = 224.0;  // Toroidal air-cavity forward-wave resonance frequency (Hz, Doppler split)
    double tread_block_pitch_hz = 0.0;   // Tread-pattern block impact modulation frequency (N_blocks * rps, Hz)
    double transient_volume_accel = 0.0; // Broadband transient volume-displacement acceleration on cleats/curbs (m^3/s^2)
    double cavity_ring_gain = 0.0;       // 0..1 excitation amplitude of the ~225 Hz hollow tire cavity boom
};

// Tyre thermal, pressure & wear state. Three timescales:
//   1. FLASH (flash_c): micro-asperity contact tips (~8 ms response) governing WLF viscoelastic breakaway smoothness
//   2. SURFACE (surface_c & 3 lateral ribs inner_c / middle_c / outer_c): outer 2-3 mm tread (~3 s response)
//   3. CORE (temperature_c): bulk carcass (~30 s response) setting inflation gas pressure via the ideal gas law.
struct TireCondition {
    double temperature_c = 80.0;  // core (bulk) temperature, C
    double surface_c = 80.0;      // tread surface temperature, C
    double flash_c = 80.0;        // micro-asperity WLF flash temperature, C (~8 ms response time)
    double pressure_kpa = 0.0;    // gauge, from the gas law (0 until the first update)
    double wear = 0.0;            // 0 = new, 1 = worn out
    double inner_c = 80.0;        // Inner shoulder tread temperature (C) — heated by negative camber on straights
    double middle_c = 80.0;       // Center rib tread temperature (C) — heated more at high inflation pressure
    double outer_c = 80.0;        // Outer shoulder tread temperature (C) — heated heavily by cornering roll onto outer edge
    double flat_spot_depth_mm = 0.0;  // 0..3.0 mm local tread flat spot ground during locked-wheel skids
    double flat_spot_phase_rad = 0.0; // Wheel rotation angle (rad) where the flat spot sits
    double blistering = 0.0;      // 0..1 internal rubber blistering from sustained core+surface overheating (> 130 C)
    double graining = 0.0;        // 0..1 surface tearing from high lateral slip while core is cold (< 60 C)
    double ambient_air_c = 30.0;  // Ambient air temperature (C) for convective tread cooling & cold-start gas law
    double track_surface_c = 30.0;// Asphalt road surface temperature (C) for conductive contact-patch heat transfer
    std::array<double, 3> rib_contact_shares{1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0}; // 16-point 3D geometric load shares (Inner, Middle, Outer)

    // Simcenter Tire 2606 MF-Swift Rigid-Ring Belt Dynamics (40-90 Hz steel-belt carcass ring vibration relative to rim)
    double belt_torsion_rad = 0.0;      // in-plane torsional deflection of tread belt ring vs wheel rim (rad)
    double belt_torsion_vel_rads = 0.0; // in-plane torsional angular velocity of belt ring vs rim (rad/s)
    double belt_lateral_m = 0.0;        // out-of-plane lateral sidewall deflection of belt ring vs rim (m)
    double belt_lateral_vel_mps = 0.0;  // out-of-plane lateral velocity of belt ring vs rim (m/s)
    double enveloping_slope_tan = 0.0;  // MF-Swift 3D tandem-cam obstacle enveloping slope tan(beta_env)

    void set_environment_celsius(double air_c, double track_c) { ambient_air_c = air_c; track_surface_c = track_c; }
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

// Operating state passed to the Magic Formula besides the slips (MF 6.1 / MF 6.2 + 3-Rib WLF Hybrid).
struct TireOperating {
    double slip_speed = 0;        // |v_slip| m/s: friction falls with sliding speed (LMUV)
    double dpi = 0;               // relative inflation pressure change
    double phi = 0;               // turn slip (spin) 1/m: -(yaw rate of the wheel) / V_cx (MF 6.1)
    bool enable_mf62_hybrid = false;          // enables MF 6.2 camber coupling + 3-Rib load integration + WLF flash temp
    double wheel_side_sign = -1.0;            // -1.0 for left wheels (FL/RL), +1.0 for right wheels (FR/RR)
    double gamma_rate_rads = 0.0;             // camber rate d(gamma)/dt (rad/s) for gyroscopic belt precession torque QTZ1
    double rolling_speed_mps = 0.0;           // wheel longitudinal rolling speed V_x (m/s) for gyroscopic belt torque
    const TireCondition* condition = nullptr; // optional pointer to 3-zone I/M/O + WLF flash-temperature state
};

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
