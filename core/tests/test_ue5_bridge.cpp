// Unit tests for the Unreal Engine 5 coordinate/unit bridge (rs::ue5).
#include <cmath>
#include "harness.hpp"
#include "rs/ue5_bridge.hpp"

static bool near(double a, double b, double eps = 1e-9) { return std::fabs(a - b) <= eps; }

RS_TEST(ue5_bridge) {
    using namespace rs;
    using namespace rs::ue5;

    // 1. Position round-trip (m, RH +Y left <-> cm, LH +Y right)
    Vec3 p{12.5, 3.25, 0.75};
    UeVec3 pu = pos_to_ue(p);
    test::check("pos_to_ue scales meters->cm and flips Y", near(pu.x, 1250.0) && near(pu.y, -325.0) && near(pu.z, 75.0));
    Vec3 p2 = pos_from_ue(pu);
    test::check("pos round-trip exact", near(p2.x, p.x) && near(p2.y, p.y) && near(p2.z, p.z));

    // 2. Yaw +90 deg in rs_core (turn left: +X -> +Y left) maps to UE5 +X -> -Y (left)
    Quat q_yaw = Quat::from_axis_angle({0, 0, 1}, kPi * 0.5);
    UeVec3 fwd_rot = ue_rotate(quat_to_ue(q_yaw), {1, 0, 0});
    test::check("yaw +90 deg left maps +X -> -Y (UE5 left)", near(fwd_rot.x, 0.0) && near(fwd_rot.y, -1.0) && near(fwd_rot.z, 0.0));

    // 3. Pitch +90 deg in rs_core (+X -> -Z nose down) maps identically in UE5
    Quat q_pitch = Quat::from_axis_angle({0, 1, 0}, kPi * 0.5);
    UeVec3 pitch_rot = ue_rotate(quat_to_ue(q_pitch), {1, 0, 0});
    test::check("pitch +90 deg maps +X -> -Z", near(pitch_rot.x, 0.0) && near(pitch_rot.y, 0.0) && near(pitch_rot.z, -1.0));

    // 4. Arbitrary combined 3D rotation commutes with M = diag(1, -1, 1)
    Quat q_arb = (Quat::from_axis_angle({0, 0, 1}, 0.73) *
                  Quat::from_axis_angle({0, 1, 0}, -0.21) *
                  Quat::from_axis_angle({1, 0, 0}, 0.39)).normalized();
    Vec3 v_test{1.7, -0.8, 2.3};
    UeVec3 lhs = dir_to_ue(q_arb.rotate(v_test));
    UeVec3 rhs = ue_rotate(quat_to_ue(q_arb), dir_to_ue(v_test));
    test::check("arbitrary 3D rotation commutes with handedness reflection",
                near(lhs.x, rhs.x) && near(lhs.y, rhs.y) && near(lhs.z, rhs.z));

    // 5. Quaternion & axial vector (omega, torque) round-trips
    Quat q_rt = quat_from_ue(quat_to_ue(q_arb));
    test::check("quaternion round-trip exact",
                near(q_rt.w, q_arb.w) && near(q_rt.x, q_arb.x) && near(q_rt.y, q_arb.y) && near(q_rt.z, q_arb.z));

    Vec3 w{0.4, -0.2, 1.1};
    Vec3 w_rt = omega_from_ue(omega_to_ue(w));
    test::check("angular velocity round-trip exact", near(w_rt.x, w.x) && near(w_rt.y, w.y) && near(w_rt.z, w.z));

    UeVec3 t_ue = torque_to_ue({10.0, 20.0, 30.0});
    test::check("torque scales by 100^2 and reflects axial axes",
                near(t_ue.x, -100000.0, 1e-6) && near(t_ue.y, 200000.0, 1e-6) && near(t_ue.z, -300000.0, 1e-6));

    // 6. Linear quantities: velocity round-trip and force units (N = kg m/s^2 -> kg cm/s^2)
    Vec3 v{31.0, -4.5, 0.25};
    Vec3 v_rt = vel_from_ue(vel_to_ue(v));
    test::check("velocity round-trip exact", near(v_rt.x, v.x) && near(v_rt.y, v.y) && near(v_rt.z, v.z));
    UeVec3 f_ue = force_to_ue({1000.0, 250.0, -9810.0});
    test::check("force scales by 100 and flips Y",
                near(f_ue.x, 100000.0, 1e-6) && near(f_ue.y, -25000.0, 1e-6) && near(f_ue.z, -981000.0, 1e-6));

    // 7. Rigid-body consistency: the mapped quantities must obey the same physics in Unreal's frame, or the car
    //    spins the wrong way on the first frame. Unreal computes cross products with the usual formula in its own axes.
    auto ue_cross = [](const UeVec3& a, const UeVec3& b) {
        return UeVec3{a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
    };
    Vec3 r{1.3, 0.8, -0.4};          // point on the body relative to the CG, m
    Vec3 om{0.2, -0.7, 1.9};         // body angular velocity, rad/s
    UeVec3 vp_core = vel_to_ue(cross(om, r));                       // v = omega x r in the core, mapped
    UeVec3 vp_ue = ue_cross(omega_to_ue(om), pos_to_ue(r));         // the same computed by Unreal
    test::check("omega x r agrees in both frames (point velocity)",
                near(vp_core.x, vp_ue.x, 1e-9) && near(vp_core.y, vp_ue.y, 1e-9) && near(vp_core.z, vp_ue.z, 1e-9));
    Vec3 F{120.0, -3400.0, 800.0};
    UeVec3 tq_core = torque_to_ue(cross(r, F));                     // tau = r x F in the core, mapped
    UeVec3 tq_ue = ue_cross(pos_to_ue(r), force_to_ue(F));          // the same computed by Unreal
    test::check("r x F agrees in both frames (torque from an off-centre force)",
                near(tq_core.x, tq_ue.x, 1e-6) && near(tq_core.y, tq_ue.y, 1e-6) && near(tq_core.z, tq_ue.z, 1e-6));

    // 8. Yaw rate sign: turning left in the core (+z yaw rate) is a negative yaw rate about Unreal's Z (LH, +Y right).
    UeVec3 yaw_ue = omega_to_ue({0.0, 0.0, 0.5});
    test::check("left turn yaw rate maps to -Z in Unreal", near(yaw_ue.z, -0.5));

    // 9. Cached ground plane intersection (async stepping): flat ground 0.3 m below a 0.6 m ray
    WheelRay ray;
    ray.origin = {0.0, 0.0, 0.6};
    ray.direction = {0.0, 0.0, -1.0};
    ray.length = 0.6;
    WheelContact c = intersect_ground_plane(ray, true, {5.0, -2.0, 0.3}, {0.0, 0.0, 1.0}, 2);
    test::check("plane hit: distance 0.3 m, point on the plane, surface kept",
                c.hit && near(c.distance, 0.3) && near(c.point.z, 0.3) && c.surface == 2);
    // tilted ground: a 10-degree slope rising toward +x through (0,0,0)
    const double s = std::sin(10.0 * kPi / 180.0), co = std::cos(10.0 * kPi / 180.0);
    WheelRay ray2 = ray;
    ray2.origin = {0.5, 0.0, 0.6};
    WheelContact c2 = intersect_ground_plane(ray2, true, {0.0, 0.0, 0.0}, {-s, 0.0, co}, 0);
    test::check("plane hit on a slope: lands on the slope under the ray",
                c2.hit && near(c2.point.x, 0.5) && near(c2.point.z, 0.5 * s / co, 1e-9));
    test::check("plane miss: ground beyond the suspension's reach",
                !intersect_ground_plane(ray, true, {0.0, 0.0, -0.5}, {0.0, 0.0, 1.0}, 0).hit);
    test::check("plane miss: nothing cached",
                !intersect_ground_plane(ray, false, {0.0, 0.0, 0.3}, {0.0, 0.0, 1.0}, 0).hit);
    test::check("plane miss: ray parallel to a wall",
                !intersect_ground_plane(ray, true, {1.0, 0.0, 0.0}, {-1.0, 0.0, 0.0}, 0).hit);
    WheelContact sunk = intersect_ground_plane(ray, true, {0.0, 0.0, 0.62}, {0.0, 0.0, 1.0}, 0);
    test::check("ground just above the mount (car sunk 2 cm) still counts, at distance 0",
                sunk.hit && near(sunk.distance, 0.0));
}
