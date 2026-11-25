// 3D kinematic suspension geometry solver and precomputed lookup tables.
//
// Models real 3D linkage geometry for:
//   - Double wishbone (SLA / unequal-length A-arms + tie rod)
//   - MacPherson strut (lower control arm + telescoping strut + tie rod)
//
// Coordinates (axle-local frame, left wheel corner, static design ride height):
//   +X forward from axle centerline
//   +Y left from vehicle centerline (left wheel centre at y = +track/2)
//   +Z up from static ground plane (wheel centre at z = tire_radius)
// Right-hand corner is obtained by exact XZ-plane mirror symmetry (y -> -y, y_rack -> -y_rack).
//
// References:
//   - W. F. Milliken & D. L. Milliken, "Race Car Vehicle Dynamics" (SAE, 1995), Ch. 17 (Suspension Geometry).
//   - J. C. Dixon, "Suspension Geometry and Computation" (Wiley, 2009), Ch. 3-6 (3D linkages, roll centres, bump steer).
#pragma once
#include <array>
#include <memory>
#include <string>
#include <vector>
#include "rs/math.hpp"

namespace rs {

struct AxleParams;
struct TireParams;

enum class SuspensionType {
    DoubleWishbone = 0,
    MacPherson = 1,
    MultiLink = 2,   // 5-link independent suspension (split lower ball joints / virtual kingpin + dedicated toe link)
    SolidAxle = 3,   // live solid axle beam + Panhard rod / Watts link (camber tracks axle roll, lateral Panhard arc)
};

struct Vec2 {
    double a = 0.0;
    double b = 0.0;
};

// Hardpoints for one axle, defined on the LEFT corner in the axle-local frame at static design height.
struct SuspensionHardpoints {
    SuspensionType type = SuspensionType::DoubleWishbone;
    bool explicit_in_config = false;

    // Lower control arm (both DoubleWishbone and MacPherson)
    Vec3 lca_front{};
    Vec3 lca_rear{};
    Vec3 lca_outer{};      // lower ball joint (LBJ)

    // Upper control arm (DoubleWishbone only)
    Vec3 uca_front{};
    Vec3 uca_rear{};
    Vec3 uca_outer{};      // upper ball joint (UBJ)

    // Strut top mount (MacPherson only)
    Vec3 strut_top{};

    // Solid axle beam + Panhard rod / Watts link parameters (SolidAxle only)
    double panhard_height_m = 0.22;  // m above ground (fixes lateral roll-centre height of live axle)
    double panhard_length_m = 1.25;  // m, Panhard bar length (drives lateral axle shift arc under heave)
    double solid_axle_track_m = 1.60; // m, axle track width for coupled left/right camber roll angle

    // Steering tie rod (or rear toe link when non-steered)
    Vec3 tie_inner{};      // inner ball joint on rack / subframe
    Vec3 tie_outer{};      // outer ball joint on upright steering arm

    // Optional coilover / damper mounting points for DoubleWishbone motion ratio.
    // For MacPherson, the strut itself (strut_top <-> lca_outer) defines the shock length.
    bool has_shock_mounts = false;
    Vec3 shock_upper{};
    Vec3 shock_lower{};    // point on LCA at static design

    // Static wheel reference at design ride height (dz = 0, y_rack = 0)
    Vec3 wheel_center{};       // (0, +track/2, tire_radius)
    double tire_radius = 0.33; // m
    double static_camber_rad = 0.0; // negative = top tilted inward
    double static_toe_rad = 0.0;    // positive = toe-in (left wheel pointed right, -steer)
};

// Solved 3D joint positions for a single corner (left-corner frame), used for geometry verification & tests.
struct KinematicPose {
    bool valid = false;
    Vec3 lca_outer{};
    Vec3 uca_outer{};      // for MacPherson: strut_top
    Vec3 tie_inner{};      // displaced by y_rack
    Vec3 tie_outer{};
    Vec3 wheel_center{};
    Vec3 spindle_out{};    // unit outward wheel spin axis (+Y nominal on left wheel)
    Vec3 shock_lower{};    // displaced lower shock mount (for motion ratio)
    double shock_length = 0.0;
};

// Kinematic output at a single (dz, y_rack) operating point for the LEFT wheel.
struct WheelKinematicSample {
    Vec3 wheel_offset{};         // m, displacement of wheel centre from static design (dx, dy, dz)
    double camber_rad = 0.0;     // rad, car-symmetric convention (- = top tilted inward; includes static + bump + steer)
    double dcamber_dz = 0.0;     // rad/m, local d(camber)/dz
    double steer_rad = 0.0;      // rad, wheel yaw in body frame (+ = turned left; includes static toe + bump steer + steer)
    double toe_rad = 0.0;        // rad, zero-rack alignment toe-in (+ = toe-in; static toe + bump steer)
    double caster_rad = 0.0;     // rad, instantaneous steering-axis caster (+ = top rearward)
    double kpi_rad = 0.0;        // rad, instantaneous kingpin inclination (+ = top inboard)
    double scrub_radius_m = 0.0; // m, y_cp - y_kingpin_ground (+ = kingpin hits ground inboard of CP)
    double caster_trail_m = 0.0; // m, x_kingpin_ground - x_cp (+ = kingpin hits ground ahead of CP)
    double motion_ratio = 1.0;   // |dL_shock / dz_wheel|
    // Contact patch in chassis axle-local YZ plane (left wheel)
    double cp_y = 0.0;
    double cp_z = 0.0;
    // Front-view instant centre (FVIC) in homogeneous YZ coordinates (unit length on projective sphere,
    // so parallel wishbones pass smoothly through fvic_w = 0 with zero singularity).
    double fvic_y = -1.0;
    double fvic_z = 0.0;
    double fvic_w = 0.0;
    // Side-view instant centre (SVIC) in homogeneous XZ coordinates.
    double svic_x = -1.0;
    double svic_z = 0.0;
    double svic_w = 0.0;
};

// Dynamic axle-level roll-centre state computed from left & right FVICs and contact patches.
struct AxleRollCentre {
    double height_m = 0.0;          // m, perpendicular height above the road line CP_R -> CP_L
    double lateral_offset_m = 0.0;  // m, lateral position (+ = left)
    double left_swing_slope = 0.0;  // tan(theta_L) = (z_ic_L - z_cp_L) / (y_cp_L - y_ic_L) for jacking force
    double right_swing_slope = 0.0; // tan(theta_R) = (z_ic_R - z_cp_R) / (y_cp_R - y_ic_R) for jacking force
};

// Direct 3D kinematic solver (constant link lengths to machine precision).
class KinematicSolver {
public:
    explicit KinematicSolver(const SuspensionHardpoints& hp);

    const SuspensionHardpoints& hardpoints() const { return hp_; }

    // Reference static link lengths (for verification / diagnostics).
    double lca_front_len() const { return len_lca_f_; }
    double lca_rear_len() const { return len_lca_r_; }
    double uca_front_len() const { return len_uca_f_; }
    double uca_rear_len() const { return len_uca_r_; }
    double knuckle_len() const { return len_ul_; }
    double tie_rod_len() const { return len_tie_; }
    double lca_to_tie_len() const { return len_lt_; }
    double uca_to_tie_len() const { return len_ut_; }

    // Solve 3D linkage for wheel vertical travel dz (m, + = bump) and physical rack shift y_rack (m, + = left).
    // Optional warm-start angles (theta_l, phi_u, psi) accelerate continuation along sweeps.
    KinematicPose solve_pose(double dz, double y_rack, double* io_theta_l = nullptr,
                             double* io_phi_u = nullptr, double* io_psi = nullptr) const;

    // Solve pose and compute all derived kinematic quantities (camber, toe, caster, KPI, scrub, FVIC, SVIC, MR).
    WheelKinematicSample evaluate(double dz, double y_rack, double* io_theta_l = nullptr,
                                  double* io_phi_u = nullptr, double* io_psi = nullptr) const;

private:
    SuspensionHardpoints hp_;
    // Precomputed static linkage axes, circle parameters, and upright reference triad
    Vec3 lca_axis_{}, lca_center_{}, lca_e1_{}, lca_e2_{};
    double lca_radius_ = 0.0;
    Vec3 uca_axis_{}, uca_center_{}, uca_e1_{}, uca_e2_{};
    double uca_radius_ = 0.0;
    Vec3 kp0_{};
    double tr_axial_ = 0.0, tr_radius_ = 0.0;
    Vec3 tr_e1_0_{};
    Vec3 up_u0_{}, up_v0_{}, up_w0_{};
    Vec3 wheel_local_{};   // (wheel_center - lca_outer) in upright triad
    Vec3 spindle_local_{}; // static outward spindle unit vector in upright triad
    Vec3 shock_lca_local_{}; // lower shock point on LCA in (lca_axis, lca_e1, lca_e2) frame
    double shock_lca_axial_ = 0.0, shock_lca_e1_ = 0.0, shock_lca_e2_ = 0.0;
    double len_lca_f_ = 0.0, len_lca_r_ = 0.0, len_uca_f_ = 0.0, len_uca_r_ = 0.0;
    double len_ul_ = 0.0, len_tie_ = 0.0, len_lt_ = 0.0, len_ut_ = 0.0;
    double cp_z_static_offset_ = 0.0;

    KinematicPose pose_from_theta(double theta_l, double y_rack, double prev_phi_u, double prev_psi,
                                  double& out_phi_u, double& out_psi) const;
};

// Precomputed 2D (steered) or 1D (non-steered) lookup table for fast O(1) substep evaluation.
class AxleKinematicsTable {
public:
    static constexpr int kDefaultTravelSamples = 25;
    static constexpr int kDefaultSteerSamples = 25;

    static std::shared_ptr<const AxleKinematicsTable> build(
        const SuspensionHardpoints& hp, double max_steer_deg,
        double dz_min = -0.12, double dz_max = 0.12,
        int n_z = kDefaultTravelSamples, int n_s = kDefaultSteerSamples);

    bool is_steered() const { return steered_; }
    double max_rack_travel_m() const { return signed_max_rack_m_; }
    double dz_min() const { return dz_min_; }
    double dz_max() const { return dz_max_; }
    int n_z() const { return n_z_; }
    int n_s() const { return n_s_; }
    const SuspensionHardpoints& hardpoints() const { return hp_; }

    // Fast bilinear (steered) or linear (non-steered) lookup for the LEFT corner.
    // u_rack in [-1, +1] (+1 = full left lock).
    WheelKinematicSample sample_left(double dz, double u_rack) const;

    // Fast lookup for either wheel on this axle (left_wheel = true for FL/RL, false for FR/RR).
    // Returns values ALREADY mapped to the requested side:
    //   - camber_rad: car-symmetric (- = top inward)
    //   - steer_rad: body frame (+ = turned left)
    //   - toe_rad: alignment toe-in (+ = toe-in)
    //   - wheel_offset.y: body frame (+ = left)
    WheelKinematicSample sample_wheel(bool left_wheel, double dz, double u_rack) const;

    // Turn a sample taken with sample_left(dz, -u_rack) into the RIGHT wheel's: exact XZ-plane mirror symmetry. The one
    // place that says which fields change sign (sample_wheel and Vehicle::update both use it).
    static WheelKinematicSample mirror_to_right(WheelKinematicSample s);

    // Dynamic axle roll centre height from left & right wheel travels and normalized rack input u_rack in [-1, +1].
    AxleRollCentre roll_centre(double dz_left, double dz_right, double u_rack) const;

private:
    SuspensionHardpoints hp_;
    bool steered_ = false;
    double signed_max_rack_m_ = 0.0; // physical y_rack (m) corresponding to u_rack = +1 (full left)
    double dz_min_ = -0.12;
    double dz_max_ = 0.12;
    double inv_dz_step_ = 1.0;
    double inv_s_step_ = 1.0;
    int n_z_ = 0;
    int n_s_ = 0;
    std::vector<WheelKinematicSample> grid_; // row-major [iz * n_s_ + is]
};

// Compute dynamic roll centre directly from a left-corner sample and a right-corner sample
// (where right_sample is the LEFT-corner sample evaluated at (dz_R, -u_rack), BEFORE mirroring).
AxleRollCentre compute_axle_roll_centre(const WheelKinematicSample& left_sample,
                                        const WheelKinematicSample& right_unmirrored_sample);

// Automatically synthesize double-wishbone hardpoints fitted to an axle's existing linear/quadratic
// parameters (static_camber_deg, camber_gain_rad_per_m, camber_gain2_rad_per_m2, roll_centre_height,
// caster_deg, kpi_deg, static_toe_deg, bump_steer_deg_per_m, ackermann).
SuspensionHardpoints synthesize_fitted_hardpoints(const AxleParams& ax, const TireParams& tire, double wheelbase);

}  // namespace rs
