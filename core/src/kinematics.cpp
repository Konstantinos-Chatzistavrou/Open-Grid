// 3D kinematic suspension geometry solver and precomputed lookup tables.
// References:
//   - W. F. Milliken & D. L. Milliken, "Race Car Vehicle Dynamics" (SAE, 1995), Ch. 17.
//   - J. C. Dixon, "Suspension Geometry and Computation" (Wiley, 2009), Ch. 3-6.
#include "rs/kinematics.hpp"
#include "rs/config.hpp"
#include <algorithm>
#include <cmath>
#include <limits>

namespace rs {
namespace {

double wrap_pi(double a) {
    while (a > kPi) a -= 2.0 * kPi;
    while (a < -kPi) a += 2.0 * kPi;
    return a;
}

// Analytical intersection of a 3D circle P(phi) = C + R * (cos(phi)*e1 + sin(phi)*e2)
// with a sphere |P - S| == target_dist, picking the branch closest to prev_phi.
bool solve_circle_sphere(const Vec3& C, const Vec3& e1, const Vec3& e2, double R,
                         const Vec3& S, double target_dist, double prev_phi, double& out_phi) {
    if (R < 1e-9) return false;
    const Vec3 D = C - S;
    const double A = dot(D, e1);
    const double B = dot(D, e2);
    const double M = std::hypot(A, B);
    if (M < 1e-12) return false;
    const double rhs = (target_dist * target_dist - dot(D, D) - R * R) / (2.0 * R);
    const double cos_val = rhs / M;
    if (std::abs(cos_val) > 1.0 + 1e-6) return false;
    const double alpha = std::atan2(B, A);
    const double delta = std::acos(clamp(cos_val, -1.0, 1.0));
    const double p1 = alpha + delta;
    const double p2 = alpha - delta;
    const double d1 = std::abs(wrap_pi(p1 - prev_phi));
    const double d2 = std::abs(wrap_pi(p2 - prev_phi));
    out_phi = prev_phi + wrap_pi((d1 <= d2 ? p1 : p2) - prev_phi);
    return true;
}

// Minimal-arc unit quaternion rotating unit vector a onto unit vector b.
Quat min_arc_quat(const Vec3& a, const Vec3& b) {
    const double c = dot(a, b);
    if (c > 1.0 - 1e-12) return Quat{1.0, 0.0, 0.0, 0.0};
    if (c < -1.0 + 1e-12) {
        Vec3 ortho = std::abs(a.x) < 0.9 ? Vec3{1.0, 0.0, 0.0} : Vec3{0.0, 1.0, 0.0};
        Vec3 ax = normalized(cross(a, ortho));
        return Quat{0.0, ax.x, ax.y, ax.z};
    }
    const Vec3 ax = cross(a, b);
    return Quat{1.0 + c, ax.x, ax.y, ax.z}.normalized();
}

WheelKinematicSample lerp_sample(const WheelKinematicSample& a, const WheelKinematicSample& b, double t) {
    WheelKinematicSample s;
    s.wheel_offset = a.wheel_offset + (b.wheel_offset - a.wheel_offset) * t;
    s.camber_rad = lerp(a.camber_rad, b.camber_rad, t);
    s.dcamber_dz = lerp(a.dcamber_dz, b.dcamber_dz, t);
    s.steer_rad = lerp(a.steer_rad, b.steer_rad, t);
    s.toe_rad = lerp(a.toe_rad, b.toe_rad, t);
    s.caster_rad = lerp(a.caster_rad, b.caster_rad, t);
    s.kpi_rad = lerp(a.kpi_rad, b.kpi_rad, t);
    s.scrub_radius_m = lerp(a.scrub_radius_m, b.scrub_radius_m, t);
    s.caster_trail_m = lerp(a.caster_trail_m, b.caster_trail_m, t);
    s.motion_ratio = lerp(a.motion_ratio, b.motion_ratio, t);
    s.cp_y = lerp(a.cp_y, b.cp_y, t);
    s.cp_z = lerp(a.cp_z, b.cp_z, t);
    s.fvic_y = lerp(a.fvic_y, b.fvic_y, t);
    s.fvic_z = lerp(a.fvic_z, b.fvic_z, t);
    s.fvic_w = lerp(a.fvic_w, b.fvic_w, t);
    s.svic_x = lerp(a.svic_x, b.svic_x, t);
    s.svic_z = lerp(a.svic_z, b.svic_z, t);
    s.svic_w = lerp(a.svic_w, b.svic_w, t);
    return s;
}

void align_projective_sign(WheelKinematicSample& cur, const WheelKinematicSample& ref) {
    if (cur.fvic_y * ref.fvic_y + cur.fvic_z * ref.fvic_z + cur.fvic_w * ref.fvic_w < 0.0) {
        cur.fvic_y = -cur.fvic_y;
        cur.fvic_z = -cur.fvic_z;
        cur.fvic_w = -cur.fvic_w;
    }
    if (cur.svic_x * ref.svic_x + cur.svic_z * ref.svic_z + cur.svic_w * ref.svic_w < 0.0) {
        cur.svic_x = -cur.svic_x;
        cur.svic_z = -cur.svic_z;
        cur.svic_w = -cur.svic_w;
    }
}

}  // namespace

// --------------------------------------------------------------------------- KinematicSolver

KinematicSolver::KinematicSolver(const SuspensionHardpoints& hp) : hp_(hp) {
    // Lower control arm hinge axis (+X nominal) and outer ball joint circle
    Vec3 lca_span = hp_.lca_front - hp_.lca_rear;
    if (length(lca_span) < 1e-6) lca_span = {1.0, 0.0, 0.0};
    lca_axis_ = normalized(lca_span);
    lca_center_ = hp_.lca_rear + lca_axis_ * dot(hp_.lca_outer - hp_.lca_rear, lca_axis_);
    const Vec3 r_l = hp_.lca_outer - lca_center_;
    lca_radius_ = length(r_l);
    lca_e1_ = lca_radius_ > 1e-9 ? r_l / lca_radius_ : Vec3{0.0, 1.0, 0.0};
    lca_e2_ = cross(lca_axis_, lca_e1_);

    // Upper control arm circle (DoubleWishbone)
    if (hp_.type == SuspensionType::DoubleWishbone) {
        Vec3 uca_span = hp_.uca_front - hp_.uca_rear;
        if (length(uca_span) < 1e-6) uca_span = {1.0, 0.0, 0.0};
        uca_axis_ = normalized(uca_span);
        uca_center_ = hp_.uca_rear + uca_axis_ * dot(hp_.uca_outer - hp_.uca_rear, uca_axis_);
        const Vec3 r_u = hp_.uca_outer - uca_center_;
        uca_radius_ = length(r_u);
        uca_e1_ = uca_radius_ > 1e-9 ? r_u / uca_radius_ : Vec3{0.0, 1.0, 0.0};
        uca_e2_ = cross(uca_axis_, uca_e1_);
    }

    // Reference static link lengths
    len_lca_f_ = length(hp_.lca_outer - hp_.lca_front);
    len_lca_r_ = length(hp_.lca_outer - hp_.lca_rear);
    if (hp_.type == SuspensionType::DoubleWishbone) {
        len_uca_f_ = length(hp_.uca_outer - hp_.uca_front);
        len_uca_r_ = length(hp_.uca_outer - hp_.uca_rear);
        len_ul_ = length(hp_.uca_outer - hp_.lca_outer);
        len_ut_ = length(hp_.tie_outer - hp_.uca_outer);
        kp0_ = normalized(hp_.uca_outer - hp_.lca_outer);
    } else {
        len_ul_ = length(hp_.strut_top - hp_.lca_outer);
        len_ut_ = length(hp_.tie_outer - hp_.strut_top);
        kp0_ = normalized(hp_.strut_top - hp_.lca_outer);
    }
    len_tie_ = length(hp_.tie_outer - hp_.tie_inner);
    len_lt_ = length(hp_.tie_outer - hp_.lca_outer);

    // Tie rod circle about the kingpin axis
    const Vec3 d_tr = hp_.tie_outer - hp_.lca_outer;
    tr_axial_ = dot(d_tr, kp0_);
    const Vec3 r_tr = d_tr - kp0_ * tr_axial_;
    tr_radius_ = length(r_tr);
    tr_e1_0_ = tr_radius_ > 1e-9 ? r_tr / tr_radius_ : Vec3{-1.0, 0.0, 0.0};

    // Rigid upright triad at static design
    up_u0_ = kp0_;
    up_v0_ = tr_e1_0_;
    up_w0_ = cross(up_u0_, up_v0_);

    const Vec3 dw = hp_.wheel_center - hp_.lca_outer;
    wheel_local_ = {dot(dw, up_u0_), dot(dw, up_v0_), dot(dw, up_w0_)};

    // Static wheel outward spindle vector (left wheel: nominal +Y, negative camber = top inward -> +Z component)
    const double steer0 = -hp_.static_toe_rad;
    const double c0 = hp_.static_camber_rad;
    const Vec3 s0{-std::sin(steer0) * std::cos(c0), std::cos(steer0) * std::cos(c0), -std::sin(c0)};
    spindle_local_ = {dot(s0, up_u0_), dot(s0, up_v0_), dot(s0, up_w0_)};

    // Static contact patch vertical offset (so static ground plane sits at z = 0)
    const Vec3 fwd0 = normalized(cross(s0, Vec3{0.0, 0.0, 1.0}));
    const Vec3 wup0 = cross(fwd0, s0);
    cp_z_static_offset_ = hp_.wheel_center.z - wup0.z * hp_.tire_radius;

    // Default shock mount on LCA when not explicitly provided (DoubleWishbone)
    if (hp_.type == SuspensionType::DoubleWishbone) {
        if (!hp_.has_shock_mounts) {
            hp_.shock_lower = lca_center_ + (hp_.lca_outer - lca_center_) * 0.72;
            hp_.shock_upper = hp_.shock_lower + Vec3{0.0, -0.10, 0.42};
        }
        const Vec3 ds = hp_.shock_lower - lca_center_;
        shock_lca_axial_ = dot(ds, lca_axis_);
        shock_lca_e1_ = dot(ds, lca_e1_);
        shock_lca_e2_ = dot(ds, lca_e2_);
    }
}

KinematicPose KinematicSolver::pose_from_theta(double theta_l, double y_rack,
                                               double prev_phi_u, double prev_psi,
                                               double& out_phi_u, double& out_psi) const {
    KinematicPose p;
    const double cl = std::cos(theta_l), sl = std::sin(theta_l);
    p.lca_outer = lca_center_ + (lca_e1_ * cl + lca_e2_ * sl) * lca_radius_;

    Vec3 kp{};
    if (hp_.type == SuspensionType::DoubleWishbone) {
        if (!solve_circle_sphere(uca_center_, uca_e1_, uca_e2_, uca_radius_,
                                 p.lca_outer, len_ul_, prev_phi_u, out_phi_u)) {
            return p;
        }
        p.uca_outer = uca_center_ + (uca_e1_ * std::cos(out_phi_u) + uca_e2_ * std::sin(out_phi_u)) * uca_radius_;
        kp = normalized(p.uca_outer - p.lca_outer);
    } else {
        out_phi_u = 0.0;
        p.uca_outer = hp_.strut_top;
        kp = normalized(hp_.strut_top - p.lca_outer);
    }

    // Tie rod constraint: outer tie rod sits on the upright's circle about kp and at distance len_tie_ from rack inner
    p.tie_inner = hp_.tie_inner + Vec3{0.0, y_rack, 0.0};
    const Quat q_kp = min_arc_quat(kp0_, kp);
    const Vec3 e1 = q_kp.rotate(tr_e1_0_);
    const Vec3 e2 = cross(kp, e1);
    const Vec3 c_tr = p.lca_outer + kp * tr_axial_;
    if (!solve_circle_sphere(c_tr, e1, e2, tr_radius_, p.tie_inner, len_tie_, prev_psi, out_psi)) {
        return p;
    }
    p.tie_outer = c_tr + (e1 * std::cos(out_psi) + e2 * std::sin(out_psi)) * tr_radius_;

    // Reconstruct displaced rigid upright triad (u1, v1, w1)
    const Vec3 u1 = kp;
    const Vec3 tr_rad = (p.tie_outer - p.lca_outer) - u1 * dot(p.tie_outer - p.lca_outer, u1);
    const Vec3 v1 = normalized(tr_rad);
    const Vec3 w1 = cross(u1, v1);

    p.wheel_center = p.lca_outer + u1 * wheel_local_.x + v1 * wheel_local_.y + w1 * wheel_local_.z;
    p.spindle_out = normalized(u1 * spindle_local_.x + v1 * spindle_local_.y + w1 * spindle_local_.z);

    if (hp_.type == SuspensionType::DoubleWishbone) {
        const Vec3 e1_r = lca_e1_ * cl + lca_e2_ * sl;
        const Vec3 e2_r = lca_e2_ * cl - lca_e1_ * sl;
        p.shock_lower = lca_center_ + lca_axis_ * shock_lca_axial_ + e1_r * shock_lca_e1_ + e2_r * shock_lca_e2_;
        p.shock_length = length(hp_.shock_upper - p.shock_lower);
    } else {
        p.shock_lower = p.lca_outer;
        p.shock_length = length(hp_.strut_top - p.lca_outer);
    }
    p.valid = true;
    return p;
}

KinematicPose KinematicSolver::solve_pose(double dz, double y_rack,
                                          double* io_theta_l, double* io_phi_u, double* io_psi) const {
    const double target_z = hp_.wheel_center.z + dz;
    double theta = io_theta_l ? *io_theta_l : (lca_radius_ > 1e-6 ? std::asin(clamp(dz / lca_radius_, -0.9, 0.9)) : 0.0);
    double phi_u = io_phi_u ? *io_phi_u : 0.0;
    double psi = io_psi ? *io_psi : 0.0;

    KinematicPose p{};
    for (int iter = 0; iter < 16; ++iter) {
        double next_phi = phi_u, next_psi = psi;
        p = pose_from_theta(theta, y_rack, phi_u, psi, next_phi, next_psi);
        if (!p.valid) {
            // Fall back toward zero angle if initial guess overshot kinematic lock
            theta *= 0.5;
            continue;
        }
        phi_u = next_phi;
        psi = next_psi;
        const double err = p.wheel_center.z - target_z;
        if (std::abs(err) < 1e-12) break;

        const double h = 1e-5;
        double dummy_u = phi_u, dummy_psi = psi;
        KinematicPose p2 = pose_from_theta(theta + h, y_rack, phi_u, psi, dummy_u, dummy_psi);
        if (!p2.valid) p2 = pose_from_theta(theta - h, y_rack, phi_u, psi, dummy_u, dummy_psi);
        if (!p2.valid) break;
        const double dz_dtheta = (p2.wheel_center.z - p.wheel_center.z) / (p2.lca_outer.z >= p.lca_outer.z ? h : -h);
        if (std::abs(dz_dtheta) < 1e-9) break;
        const double step = clamp(err / dz_dtheta, -0.25, 0.25);
        theta -= step;
    }

    if (p.valid) {
        if (io_theta_l) *io_theta_l = theta;
        if (io_phi_u) *io_phi_u = phi_u;
        if (io_psi) *io_psi = psi;
    }
    return p;
}

WheelKinematicSample KinematicSolver::evaluate(double dz, double y_rack,
                                               double* io_theta_l, double* io_phi_u, double* io_psi) const {
    WheelKinematicSample s;
    double th = io_theta_l ? *io_theta_l : (lca_radius_ > 1e-6 ? std::asin(clamp(dz / lca_radius_, -0.9, 0.9)) : 0.0);
    double fu = io_phi_u ? *io_phi_u : 0.0;
    double ps = io_psi ? *io_psi : 0.0;

    const KinematicPose p = solve_pose(dz, y_rack, &th, &fu, &ps);
    if (!p.valid) return s;

    if (io_theta_l) *io_theta_l = th;
    if (io_phi_u) *io_phi_u = fu;
    if (io_psi) *io_psi = ps;

    s.wheel_offset = p.wheel_center - hp_.wheel_center;
    s.steer_rad = std::atan2(-p.spindle_out.x, p.spindle_out.y);
    s.camber_rad = -std::asin(clamp(p.spindle_out.z, -1.0, 1.0));
    s.toe_rad = -s.steer_rad; // exact at y_rack == 0; overwritten in table with zero-rack toe

    // Tyre contact patch in chassis axle-local frame
    const Vec3 fwd_xy = normalized(cross(p.spindle_out, Vec3{0.0, 0.0, 1.0}));
    const Vec3 wheel_up = cross(fwd_xy, p.spindle_out);
    const Vec3 cp = p.wheel_center - wheel_up * hp_.tire_radius;
    s.cp_y = cp.y;
    s.cp_z = cp.z - cp_z_static_offset_;

    // Steering axis (kingpin) caster, KPI, scrub radius, mechanical caster trail
    const Vec3 kp = p.uca_outer - p.lca_outer; // LBJ -> UBJ (or LBJ -> strut_top)
    if (std::abs(kp.z) > 1e-9) {
        s.caster_rad = std::atan2(-kp.x, kp.z);
        s.kpi_rad = std::atan2(-kp.y, kp.z);
        const double t_g = (s.cp_z - p.lca_outer.z) / kp.z;
        const Vec3 pg = p.lca_outer + kp * t_g;
        s.scrub_radius_m = s.cp_y - pg.y;
        s.caster_trail_m = pg.x - cp.x;
    }

    // Front-View Instant Centre (FVIC) in transverse plane x = wheel_center.x
    // Lower wishbone plane (lca_front, lca_rear, lca_outer)
    const Vec3 n_l = cross(hp_.lca_front - p.lca_outer, hp_.lca_rear - p.lca_outer);
    const Vec3 line_l_fv{n_l.y, n_l.z, n_l.x * p.wheel_center.x - dot(n_l, p.lca_outer)};
    Vec3 line_u_fv{};
    if (hp_.type == SuspensionType::DoubleWishbone) {
        const Vec3 n_u = cross(hp_.uca_front - p.uca_outer, hp_.uca_rear - p.uca_outer);
        line_u_fv = {n_u.y, n_u.z, n_u.x * p.wheel_center.x - dot(n_u, p.uca_outer)};
    } else {
        // MacPherson upper constraint line: through strut_top, perpendicular to front-view strut axis
        const double a_u = hp_.strut_top.y - p.lca_outer.y;
        const double b_u = hp_.strut_top.z - p.lca_outer.z;
        line_u_fv = {a_u, b_u, -(a_u * hp_.strut_top.y + b_u * hp_.strut_top.z)};
    }
    Vec3 fvic = cross(line_l_fv, line_u_fv);
    const double fvic_norm = length(fvic);
    if (fvic_norm > 1e-12) {
        fvic = fvic / fvic_norm;
        // Canonical sign: point inward (fvic.x <= 0) when finite/inboard
        if (fvic.x > 0.0 || (std::abs(fvic.x) < 1e-9 && fvic.z < 0.0)) fvic = -fvic;
        s.fvic_y = fvic.x;
        s.fvic_z = fvic.y;
        s.fvic_w = fvic.z;
    }

    // Side-View Instant Centre (SVIC) in longitudinal plane y = wheel_center.y
    const Vec3 line_l_sv{n_l.x, n_l.z, n_l.y * p.wheel_center.y - dot(n_l, p.lca_outer)};
    Vec3 line_u_sv{};
    if (hp_.type == SuspensionType::DoubleWishbone) {
        const Vec3 n_u = cross(hp_.uca_front - p.uca_outer, hp_.uca_rear - p.uca_outer);
        line_u_sv = {n_u.x, n_u.z, n_u.y * p.wheel_center.y - dot(n_u, p.uca_outer)};
    } else {
        const double a_u = hp_.strut_top.x - p.lca_outer.x;
        const double b_u = hp_.strut_top.z - p.lca_outer.z;
        line_u_sv = {a_u, b_u, -(a_u * hp_.strut_top.x + b_u * hp_.strut_top.z)};
    }
    Vec3 svic = cross(line_l_sv, line_u_sv);
    const double svic_norm = length(svic);
    if (svic_norm > 1e-12) {
        svic = svic / svic_norm;
        if (svic.x > 0.0 || (std::abs(svic.x) < 1e-9 && svic.z < 0.0)) svic = -svic;
        s.svic_x = svic.x;
        s.svic_z = svic.y;
        s.svic_w = svic.z;
    }

    // Local camber slope d(camber)/dz and motion ratio |dL_shock / dz| via central difference
    const double h = 1e-3;
    double th_p = th, fu_p = fu, ps_p = ps;
    double th_m = th, fu_m = fu, ps_m = ps;
    const KinematicPose pp = solve_pose(dz + h, y_rack, &th_p, &fu_p, &ps_p);
    const KinematicPose pm = solve_pose(dz - h, y_rack, &th_m, &fu_m, &ps_m);
    if (pp.valid && pm.valid) {
        const double cam_p = -std::asin(clamp(pp.spindle_out.z, -1.0, 1.0));
        const double cam_m = -std::asin(clamp(pm.spindle_out.z, -1.0, 1.0));
        s.dcamber_dz = (cam_p - cam_m) / (2.0 * h);
        s.motion_ratio = std::abs(pp.shock_length - pm.shock_length) / (2.0 * h);
    } else if (pp.valid) {
        const double cam_p = -std::asin(clamp(pp.spindle_out.z, -1.0, 1.0));
        s.dcamber_dz = (cam_p - s.camber_rad) / h;
        s.motion_ratio = std::abs(pp.shock_length - p.shock_length) / h;
    } else if (pm.valid) {
        const double cam_m = -std::asin(clamp(pm.spindle_out.z, -1.0, 1.0));
        s.dcamber_dz = (s.camber_rad - cam_m) / h;
        s.motion_ratio = std::abs(p.shock_length - pm.shock_length) / h;
    }
    return s;
}

// --------------------------------------------------------------------------- Roll Centre

AxleRollCentre compute_axle_roll_centre(const WheelKinematicSample& left,
                                        const WheelKinematicSample& right_unmirrored) {
    AxleRollCentre out;
    // Left corner in chassis YZ plane
    const Vec3 cp_l{left.cp_y, left.cp_z, 1.0};
    const Vec3 ic_l{left.fvic_y, left.fvic_z, left.fvic_w};
    // Right corner mirrored across Y = 0
    const Vec3 cp_r{-right_unmirrored.cp_y, right_unmirrored.cp_z, 1.0};
    const Vec3 ic_r{-right_unmirrored.fvic_y, right_unmirrored.fvic_z, right_unmirrored.fvic_w};

    // Instantaneous force lines connecting each contact patch to its FVIC
    const Vec3 line_l = cross(cp_l, ic_l);
    const Vec3 line_r = cross(cp_r, ic_r);

    // Swing-arm slopes toward the vehicle centerline (used for vertical jacking forces)
    if (std::abs(line_l.y) > 1e-9) out.left_swing_slope = clamp(line_l.x / line_l.y, -1.5, 1.5);
    if (std::abs(line_r.y) > 1e-9) out.right_swing_slope = clamp(-line_r.x / line_r.y, -1.5, 1.5);

    // Road line from right CP to left CP
    const double ry = cp_l.x - cp_r.x;
    const double rz = cp_l.y - cp_r.y;
    const double rlen = std::hypot(ry, rz);
    if (rlen < 1e-6) return out;
    const double ty = ry / rlen, tz = rz / rlen;
    const double ny = -tz, nz = ty; // unit upward normal to the road in chassis YZ
    const double my = 0.5 * (cp_l.x + cp_r.x);
    const double mz = 0.5 * (cp_l.y + cp_r.y);

    const Vec3 rc_h = cross(line_l, line_r);
    if (std::abs(rc_h.z) > 1e-9) {
        const double rc_y = rc_h.x / rc_h.z;
        const double rc_z = rc_h.y / rc_h.z;
        out.height_m = (rc_y - my) * ny + (rc_z - mz) * nz;
        out.lateral_offset_m = (rc_y - my) * ty + (rc_z - mz) * tz;
    } else {
        // Collinear / parallel horizontal wishbones: roll centre lies on the common swing line
        const double zl = std::abs(line_l.y) > 1e-9 ? -(line_l.x * my + line_l.z) / line_l.y : mz;
        const double zr = std::abs(line_r.y) > 1e-9 ? -(line_r.x * my + line_r.z) / line_r.y : mz;
        const double rc_z = 0.5 * (zl + zr);
        out.height_m = (rc_z - mz) * nz;
        out.lateral_offset_m = 0.0;
    }
    return out;
}

// --------------------------------------------------------------------------- AxleKinematicsTable

std::shared_ptr<const AxleKinematicsTable> AxleKinematicsTable::build(
    const SuspensionHardpoints& hp, double max_steer_deg,
    double dz_min, double dz_max, int n_z, int n_s) {
    auto tbl = std::make_shared<AxleKinematicsTable>();
    tbl->hp_ = hp;
    tbl->steered_ = max_steer_deg > 1e-4;
    tbl->dz_min_ = dz_min;
    tbl->dz_max_ = dz_max;
    tbl->n_z_ = std::max(3, n_z);
    tbl->n_s_ = tbl->steered_ ? std::max(3, n_s) : 1;
    // Keep odd counts so dz = 0 and u_rack = 0 fall cleanly near grid centres
    if (tbl->n_z_ % 2 == 0) ++tbl->n_z_;
    if (tbl->steered_ && tbl->n_s_ % 2 == 0) ++tbl->n_s_;

    tbl->inv_dz_step_ = (tbl->n_z_ - 1) / std::max(1e-6, tbl->dz_max_ - tbl->dz_min_);
    tbl->inv_s_step_ = tbl->steered_ ? (tbl->n_s_ - 1) / 2.0 : 0.0;

    KinematicSolver solver(hp);

    // Calibrate physical steering rack travel (and sign for front- vs rear-steer) so u_rack = +1
    // produces an average front wheel steer angle equal to +max_steer_deg at static ride height.
    if (tbl->steered_) {
        const double target_rad = max_steer_deg * kPi / 180.0;
        const WheelKinematicSample probe = solver.evaluate(0.0, 0.005);
        const WheelKinematicSample zero = solver.evaluate(0.0, 0.0);
        const double rack_sign = (probe.steer_rad >= zero.steer_rad) ? 1.0 : -1.0;

        auto mean_steer = [&](double mag) -> double {
            double tl_p = 0.0, fu_p = 0.0, ps_p = 0.0;
            double tl_m = 0.0, fu_m = 0.0, ps_m = 0.0;
            const KinematicPose pp = solver.solve_pose(0.0, rack_sign * mag, &tl_p, &fu_p, &ps_p);
            const KinematicPose pm = solver.solve_pose(0.0, -rack_sign * mag, &tl_m, &fu_m, &ps_m);
            if (!pp.valid || !pm.valid) return -1.0;
            const double st_l = std::atan2(-pp.spindle_out.x, pp.spindle_out.y);
            const double st_r = -std::atan2(-pm.spindle_out.x, pm.spindle_out.y);
            return 0.5 * (st_l + st_r);
        };

        // Bracket target rack magnitude (typical car: 0.04..0.11 m)
        double lo = 0.0, hi = 0.02;
        while (hi < 0.25) {
            const double ms = mean_steer(hi);
            if (ms < 0.0) { hi *= 0.75; break; }
            if (ms >= target_rad) break;
            lo = hi;
            hi *= 1.5;
        }
        // Bisect to exact max_steer_deg
        for (int it = 0; it < 28; ++it) {
            const double mid = 0.5 * (lo + hi);
            const double ms = mean_steer(mid);
            if (ms < 0.0 || ms > target_rad) hi = mid;
            else lo = mid;
        }
        tbl->signed_max_rack_m_ = rack_sign * 0.5 * (lo + hi);
    }

    const int nz = tbl->n_z_;
    const int ns = tbl->n_s_;
    tbl->grid_.resize(static_cast<std::size_t>(nz * ns));

    const int iz0 = std::clamp(static_cast<int>(std::lround((0.0 - dz_min) * tbl->inv_dz_step_)), 0, nz - 1);
    const int is0 = tbl->steered_ ? (ns / 2) : 0;

    auto dz_at = [&](int iz) { return dz_min + (dz_max - dz_min) * (static_cast<double>(iz) / (nz - 1)); };
    auto rack_at = [&](int is) {
        if (!tbl->steered_) return 0.0;
        const double u = -1.0 + 2.0 * (static_cast<double>(is) / (ns - 1));
        return u * tbl->signed_max_rack_m_;
    };

    // Store warm-start angles along the zero-rack column
    std::vector<double> col_th(nz, 0.0), col_fu(nz, 0.0), col_ps(nz, 0.0);

    // Evaluate centre (iz0, is0)
    {
        double th = 0.0, fu = 0.0, ps = 0.0;
        tbl->grid_[iz0 * ns + is0] = solver.evaluate(dz_at(iz0), 0.0, &th, &fu, &ps);
        col_th[iz0] = th; col_fu[iz0] = fu; col_ps[iz0] = ps;
    }
    // March upward (bump) from iz0 at y_rack = 0
    for (int iz = iz0 + 1; iz < nz; ++iz) {
        double th = col_th[iz - 1], fu = col_fu[iz - 1], ps = col_ps[iz - 1];
        WheelKinematicSample s = solver.evaluate(dz_at(iz), 0.0, &th, &fu, &ps);
        if (s.motion_ratio <= 0.0) s = tbl->grid_[(iz - 1) * ns + is0];
        else align_projective_sign(s, tbl->grid_[(iz - 1) * ns + is0]);
        tbl->grid_[iz * ns + is0] = s;
        col_th[iz] = th; col_fu[iz] = fu; col_ps[iz] = ps;
    }
    // March downward (droop) from iz0 at y_rack = 0
    for (int iz = iz0 - 1; iz >= 0; --iz) {
        double th = col_th[iz + 1], fu = col_fu[iz + 1], ps = col_ps[iz + 1];
        WheelKinematicSample s = solver.evaluate(dz_at(iz), 0.0, &th, &fu, &ps);
        if (s.motion_ratio <= 0.0) s = tbl->grid_[(iz + 1) * ns + is0];
        else align_projective_sign(s, tbl->grid_[(iz + 1) * ns + is0]);
        tbl->grid_[iz * ns + is0] = s;
        col_th[iz] = th; col_fu[iz] = fu; col_ps[iz] = ps;
    }

    // For steered axles, sweep each iz row outward from is0 in +rack and -rack directions
    if (tbl->steered_) {
        for (int iz = 0; iz < nz; ++iz) {
            const double dz = dz_at(iz);
            const double zero_toe = tbl->grid_[iz * ns + is0].toe_rad;

            double th = col_th[iz], fu = col_fu[iz], ps = col_ps[iz];
            for (int is = is0 + 1; is < ns; ++is) {
                WheelKinematicSample s = solver.evaluate(dz, rack_at(is), &th, &fu, &ps);
                if (s.motion_ratio <= 0.0) s = tbl->grid_[iz * ns + (is - 1)];
                else align_projective_sign(s, tbl->grid_[iz * ns + (is - 1)]);
                s.toe_rad = zero_toe;
                tbl->grid_[iz * ns + is] = s;
            }

            th = col_th[iz]; fu = col_fu[iz]; ps = col_ps[iz];
            for (int is = is0 - 1; is >= 0; --is) {
                WheelKinematicSample s = solver.evaluate(dz, rack_at(is), &th, &fu, &ps);
                if (s.motion_ratio <= 0.0) s = tbl->grid_[iz * ns + (is + 1)];
                else align_projective_sign(s, tbl->grid_[iz * ns + (is + 1)]);
                s.toe_rad = zero_toe;
                tbl->grid_[iz * ns + is] = s;
            }
        }
    }

    return tbl;
}

WheelKinematicSample AxleKinematicsTable::sample_left(double dz, double u_rack) const {
    const double fz = clamp((dz - dz_min_) * inv_dz_step_, 0.0, static_cast<double>(n_z_ - 1));
    const int iz0 = std::min(static_cast<int>(fz), n_z_ - 2);
    const double tz = fz - iz0;

    if (!steered_) {
        return lerp_sample(grid_[iz0], grid_[iz0 + 1], tz);
    }

    const double fs = clamp((u_rack + 1.0) * inv_s_step_, 0.0, static_cast<double>(n_s_ - 1));
    const int is0 = std::min(static_cast<int>(fs), n_s_ - 2);
    const double ts = fs - is0;

    const WheelKinematicSample& q00 = grid_[iz0 * n_s_ + is0];
    const WheelKinematicSample& q01 = grid_[iz0 * n_s_ + is0 + 1];
    const WheelKinematicSample& q10 = grid_[(iz0 + 1) * n_s_ + is0];
    const WheelKinematicSample& q11 = grid_[(iz0 + 1) * n_s_ + is0 + 1];
    return lerp_sample(lerp_sample(q00, q01, ts), lerp_sample(q10, q11, ts), tz);
}

WheelKinematicSample AxleKinematicsTable::sample_wheel(bool left_wheel, double dz, double u_rack) const {
    if (left_wheel) return sample_left(dz, u_rack);
    // Exact XZ-plane mirror symmetry for the right wheel
    WheelKinematicSample s = sample_left(dz, -u_rack);
    s.steer_rad = -s.steer_rad;
    s.wheel_offset.y = -s.wheel_offset.y;
    s.cp_y = -s.cp_y;
    s.fvic_y = -s.fvic_y;
    return s;
}

AxleRollCentre AxleKinematicsTable::roll_centre(double dz_left, double dz_right, double u_rack) const {
    const WheelKinematicSample left = sample_left(dz_left, u_rack);
    const WheelKinematicSample right_unmirrored = sample_left(dz_right, -u_rack);
    return compute_axle_roll_centre(left, right_unmirrored);
}

// --------------------------------------------------------------------------- Fitted Default Hardpoints

SuspensionHardpoints synthesize_fitted_hardpoints(const AxleParams& ax, const TireParams& tire, double wheelbase) {
    SuspensionHardpoints hp;
    hp.type = SuspensionType::DoubleWishbone;
    hp.explicit_in_config = false;

    const double half_track = 0.5 * ax.track;
    const double r = tire.radius;
    hp.wheel_center = {0.0, half_track, r};
    hp.tire_radius = r;
    hp.static_camber_rad = ax.static_camber_deg * kPi / 180.0;
    hp.static_toe_rad = ax.static_toe_deg * kPi / 180.0;

    const double caster = ax.caster_deg * kPi / 180.0;
    const double kpi = ax.kpi_deg * kPi / 180.0;
    const double h_knuckle = clamp(0.78 * r, 0.22, 0.30);
    const double lbj_z = std::max(0.14, r - 0.44 * h_knuckle);
    const double ubj_z = lbj_z + h_knuckle;

    // Place ball joints inside wheel hub with exact KPI and caster
    const double lbj_y = half_track - 0.045;
    const double ubj_y = lbj_y - h_knuckle * std::tan(kpi);
    const double lbj_x = 0.005;
    const double ubj_x = lbj_x - h_knuckle * std::tan(caster);

    hp.lca_outer = {lbj_x, lbj_y, lbj_z};
    hp.uca_outer = {ubj_x, ubj_y, ubj_z};

    const double scale_t = clamp(ax.track / 1.60, 0.75, 1.25);
    const double span_l = 0.42 * scale_t;

    // Helper to build inner pivots given FVIC horizontal distance L_fv and upper arm span_u
    auto build_arms = [&](double g1_eff, double span_u) {
        const double h_rc = ax.roll_centre_height;
        const double lca_in_y = lbj_y - span_l;
        const double uca_in_y = ubj_y - span_u;
        double lca_in_z = lbj_z;
        double uca_in_z = ubj_z;
        if (std::abs(g1_eff) > 0.03) {
            const double l_fv = -1.0 / g1_eff;
            const double y_ic = half_track - l_fv;
            const double z_ic = h_rc * l_fv / half_track;
            const double tl = (lca_in_y - lbj_y) / (y_ic - lbj_y);
            const double tu = (uca_in_y - ubj_y) / (y_ic - ubj_y);
            lca_in_z = lbj_z + tl * (z_ic - lbj_z);
            uca_in_z = ubj_z + tu * (z_ic - ubj_z);
        } else {
            // Near-zero camber gain: parallel wishbones tilted at slope h_rc / half_track
            const double slope = h_rc / half_track;
            lca_in_z = lbj_z - span_l * slope;
            uca_in_z = ubj_z - span_u * slope;
        }
        hp.lca_front = {lbj_x + 0.16, lca_in_y, lca_in_z};
        hp.lca_rear = {lbj_x - 0.18, lca_in_y, lca_in_z};
        hp.uca_front = {ubj_x + 0.13, uca_in_y, uca_in_z};
        hp.uca_rear = {ubj_x - 0.14, uca_in_y, uca_in_z};

        // Steering arm (rear-steer): angled inboard according to Ackermann fraction
        const double arm_dx = -0.115;
        const double ack = clamp(ax.ackermann, 0.0, 1.0);
        const double kp_z_frac = 0.18;
        const Vec3 kp_pt = hp.lca_outer + (hp.uca_outer - hp.lca_outer) * kp_z_frac;
        const double slope_ack = (wheelbase > 0.5) ? ack * (kp_pt.y / wheelbase) : 0.0;
        hp.tie_outer = {kp_pt.x + arm_dx, kp_pt.y + arm_dx * slope_ack, kp_pt.z};

        // Initial tie-rod inner pivot: match the interpolated control-arm span so the tie rod
        // sweeps the same arc radius as the upright (minimizes quadratic bump steer, Dixon Ch. 6).
        const double tr_span = lerp(span_l, span_u, kp_z_frac);
        const double tr_in_y = hp.tie_outer.y - tr_span;
        const double tr_in_z = lerp(lca_in_z, uca_in_z, kp_z_frac);
        hp.tie_inner = {hp.tie_outer.x, tr_in_y, tr_in_z};
    };

    const double target_g1 = ax.camber_gain_rad_per_m;
    const double target_g2 = ax.camber_gain2_rad_per_m2;
    const double target_bs = ax.bump_steer_deg_per_m * kPi / 180.0;

    // 1. Fit upper arm length span_u to match camber curvature (g2) while keeping realistic SLA bounds
    double best_span_u = 0.27 * scale_t;
    double g1_fit = target_g1;
    {
        double lo = 0.17 * scale_t, hi = 0.54 * scale_t;
        auto eval_g2 = [&](double su) {
            build_arms(g1_fit, su);
            KinematicSolver sol(hp);
            const double dz = 0.05;
            const double c0 = sol.evaluate(0.0, 0.0).camber_rad;
            const double cp = sol.evaluate(dz, 0.0).camber_rad;
            const double cm = sol.evaluate(-dz, 0.0).camber_rad;
            return 0.5 * (cp + cm - 2.0 * c0) / (dz * dz);
        };
        const double g2_lo = eval_g2(lo);
        const double g2_hi = eval_g2(hi);
        // Pick endpoint if target_g2 lies outside geometric range, else bisect
        if ((target_g2 - g2_lo) * (target_g2 - g2_hi) <= 0.0) {
            const bool inc = g2_hi >= g2_lo;
            for (int it = 0; it < 12; ++it) {
                const double mid = 0.5 * (lo + hi);
                const double val = eval_g2(mid);
                if ((val < target_g2) == inc) lo = mid;
                else hi = mid;
            }
            best_span_u = 0.5 * (lo + hi);
        } else {
            best_span_u = (std::abs(target_g2 - g2_lo) < std::abs(target_g2 - g2_hi)) ? lo : hi;
        }
    }

    // 2. Refine g1_fit (2 secant steps) so static d(camber)/dz matches target_g1 tightly
    for (int it = 0; it < 3; ++it) {
        build_arms(g1_fit, best_span_u);
        KinematicSolver sol(hp);
        const double actual_g1 = sol.evaluate(0.0, 0.0).dcamber_dz;
        g1_fit += (target_g1 - actual_g1);
    }
    build_arms(g1_fit, best_span_u);

    // 3. Tune (tie_inner.y, tie_inner.z) via 2D Newton to match linear bump steer AND suppress
    //    quadratic bump-steer curvature over +/-30 mm (Milliken & Milliken Ch. 17.5 / Dixon Ch. 6).
    {
        const double h = 0.03;
        auto eval_toe_err = [&](double ty, double tz, double& e_lin, double& e_quad) {
            hp.tie_inner.y = ty;
            hp.tie_inner.z = tz;
            KinematicSolver sol(hp);
            const double t0 = sol.evaluate(0.0, 0.0).toe_rad;
            const double tp = sol.evaluate(h, 0.0).toe_rad;
            const double tm = sol.evaluate(-h, 0.0).toe_rad;
            e_lin = (tp - tm) / (2.0 * h) - target_bs;
            e_quad = (tp + tm - 2.0 * t0) / (h * h);
        };
        double ty = hp.tie_inner.y;
        double tz = hp.tie_inner.z;
        const double ty_lo = hp.lca_front.y - 0.12;
        const double ty_hi = hp.tie_outer.y - 0.18;
        const double tz_lo = hp.lca_front.z - 0.12;
        const double tz_hi = hp.uca_front.z + 0.08;
        for (int it = 0; it < 6; ++it) {
            double fl = 0.0, fq = 0.0;
            eval_toe_err(ty, tz, fl, fq);
            if (std::abs(fl) < 1e-5 && std::abs(fq) < 1e-3) break;
            const double eps = 2e-3;
            double fl_y = 0.0, fq_y = 0.0, fl_z = 0.0, fq_z = 0.0;
            eval_toe_err(ty + eps, tz, fl_y, fq_y);
            eval_toe_err(ty, tz + eps, fl_z, fq_z);
            const double j00 = (fl_y - fl) / eps, j01 = (fl_z - fl) / eps;
            const double j10 = (fq_y - fq) / eps, j11 = (fq_z - fq) / eps;
            const double det = j00 * j11 - j01 * j10;
            if (std::abs(det) < 1e-12) break;
            const double dty = -(j11 * fl - j01 * fq) / det;
            const double dtz = -(-j10 * fl + j00 * fq) / det;
            ty = clamp(ty + clamp(dty, -0.06, 0.06), ty_lo, ty_hi);
            tz = clamp(tz + clamp(dtz, -0.06, 0.06), tz_lo, tz_hi);
        }
        hp.tie_inner.y = ty;
        hp.tie_inner.z = tz;
    }

    return hp;
}

}  // namespace rs
