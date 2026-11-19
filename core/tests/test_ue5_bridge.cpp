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
}
