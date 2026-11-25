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

// Swept ground strip: a 20 cm wide, 10 cm high kerb that a per-frame plane misses between frames.
RS_TEST(ground_strip) {
    using namespace rs;
    using namespace rs::ue5;
    auto ground_at = [](const Vec3& p) {   // what the engine's downward trace would find
        GroundSample g;
        g.hit = true;
        g.point = {p.x, p.y, (p.x >= 1.0 && p.x <= 1.2) ? 0.10 : 0.0};
        g.normal = {0, 0, 1};
        g.surface = (p.x >= 1.0 && p.x <= 1.2) ? 2 : 0;
        return g;
    };
    GroundStrip strip;
    strip.origin = {0.0, 0.0, 0.6};
    strip.along = {1, 0, 0};
    strip.across = {0, 1, 0};
    strip.spacing = 0.05;
    strip.lane_spacing = 0.12;
    strip.resize(3, 40);   // 2 m ahead, 3 lanes
    for (int l = 0; l < strip.lanes; ++l)
        for (int i = 0; i < strip.count; ++i) strip.at(l, i) = ground_at(strip.position(l, i));

    auto ray_at = [](double x, double y) {
        WheelRay r;
        r.origin = {x, y, 0.6};
        r.direction = {0, 0, -1};
        r.length = 0.6;
        return r;
    };
    auto dist = [&](double x) {
        WheelContact c;
        const bool inside = strip.lookup(ray_at(x, 0.0), c);
        return inside && c.hit ? c.distance : -1.0;
    };
    test::check("road before the kerb: 0.60 m", std::fabs(dist(0.50) - 0.60) < 1e-9);
    test::check("on the kerb: 0.50 m (10 cm higher)", std::fabs(dist(1.10) - 0.50) < 1e-9);
    test::check("2 cm before the kerb edge the tyre already climbs (within one 5 cm sample)", std::fabs(dist(0.98) - 0.50) < 1e-9);
    test::check("off the kerb again by 1.30 m", std::fabs(dist(1.30) - 0.60) < 1e-9);
    WheelContact kerb;
    strip.lookup(ray_at(1.10, 0.0), kerb);
    test::check("kerb surface id comes through", kerb.surface == 2);

    // The old way: one plane per ray, traced when the frame started at x = 0 (road), used for the whole frame
    const GroundSample start = ground_at({0.0, 0.0, 0.6});
    const WheelContact old_way = intersect_ground_plane(ray_at(1.10, 0.0), start.hit, start.point, start.normal, start.surface);
    test::check("per-frame plane misses the kerb at 1.10 m (reads road, 0.60 m)", old_way.hit && std::fabs(old_way.distance - 0.60) < 1e-9);

    WheelContact c;
    test::check("beyond the strip's end: not covered (caller falls back)", !strip.lookup(ray_at(2.5, 0.0), c));
    test::check("beside the strip: not covered", !strip.lookup(ray_at(0.5, 0.5), c));
    test::check("behind the strip: not covered", !strip.lookup(ray_at(-0.2, 0.0), c));
}

// End to end: the real vehicle drives at 100 km/h; the engine refreshes its ground data once per 30 fps frame (every
// 8th 240 Hz step) and the physics reads it every step. Compared against tracing every step (the web build), for a
// street kerb 20 cm wide and 8 cm high under the front-left tyre.
RS_TEST(ground_strip_drive) {
    using namespace rs;
    using namespace rs::ue5;
    const CarConfig cfg = load_car_config(std::string(RS_DATA_DIR) + "/cars/kestrel_gt.json");
    auto flat = std::make_shared<PlaneGround>();
    Simulation sim(cfg, flat);
    sim.dt = 1.0 / 240.0;
    sim.use_contact_patch = true;
    sim.reset({}, 0.0, 27.8, 6);
    sim.settle(0.0);

    const double k0 = 12.0, k1 = 12.45, kh = 0.08;   // 45 cm kerb (< 1 render frame at 28 m/s) so per-frame plane misses it phase-independently
    auto height = [&](double x) { return (x >= k0 && x <= k1) ? kh : 0.0; };
    auto trace = [&](const WheelRay& r) {           // what a downward trace would hit
        GroundSample g;
        if (r.direction.z > -0.5) return g;
        const double h = height(r.origin.x);
        const double t = (r.origin.z - h) / -r.direction.z;
        if (t < 0 || t > r.length + 0.5) return g;
        g.hit = true;
        g.point = {r.origin.x, r.origin.y, h};
        g.normal = {0, 0, 1};
        return g;
    };

    GroundStrip strip;
    GroundSample plane;   // per-ray plane cached at the frame start (centre ray)
    int on_truth = 0, on_strip = 0, on_plane = 0;
    double err_strip = 0, err_plane = 0;
    int n = 0;
    DriverInput cruise;
    cruise.throttle = 0.25;
    cruise.gear = 6;
    cruise.auto_clutch = true;
    for (int step = 0; step < 240; ++step) {   // 1 s: ~28 m, the kerb is passed around 0.4 s
        const auto patches = sim.vehicle.wheel_contact_patch_rays(sim.body.state);
        const WheelRay& ray = patches[0].rays[0];   // front-left, centre ray
        if (step % 8 == 0) {
            // Frame: rebuild the strip ahead of the wheel (as UOpenGridVehicleComponent::TraceGroundStrips) and the plane
            const Vec3 down = ray.direction;
            const Vec3 vel = sim.body.state.velocity;
            const Vec3 vplane = vel - down * dot(vel, down);
            const double speed = length(vplane);
            strip.origin = ray.origin - normalized(vplane) * 0.30;
            strip.along = normalized(vplane);
            strip.across = normalized(cross(down, strip.along));
            strip.spacing = 0.05;
            strip.lane_spacing = 0.12;
            const double len = 0.30 + speed * (8.0 / 240.0) * 1.5 + 0.30;
            strip.resize(3, static_cast<int>(std::ceil(len / 0.05)) + 1);
            for (int l = 0; l < strip.lanes; ++l)
                for (int i = 0; i < strip.count; ++i) {
                    WheelRay r = ray;
                    r.origin = strip.position(l, i);
                    strip.at(l, i) = trace(r);
                }
            plane = trace(ray);
        }
        const GroundSample truth = trace(ray);
        WheelContact s;
        strip.lookup(ray, s);
        const WheelContact p = intersect_ground_plane(ray, plane.hit, plane.point, plane.normal, 0);
        const double h_truth = truth.point.z;
        const double h_strip = s.hit ? s.point.z : 0.0;
        const double h_plane = p.hit ? p.point.z : 0.0;
        on_truth += h_truth > 0.04;
        on_strip += h_strip > 0.04;
        on_plane += h_plane > 0.04;
        err_strip += std::fabs(h_strip - h_truth);
        err_plane += std::fabs(h_plane - h_truth);
        ++n;
        sim.step(cruise);
    }
    std::printf("         steps on the kerb: traced every step %d, strip %d, per-frame plane %d; "
                "mean height error: strip %.2f mm, plane %.2f mm\n",
                on_truth, on_strip, on_plane, 1000 * err_strip / n, 1000 * err_plane / n);
    test::check("tracing every step sees the kerb", on_truth >= 1);
    test::check("strip sees the kerb on as many steps (+1 for the early climb)", on_strip >= on_truth && on_strip <= on_truth + 1);
    test::check("strip height error at most a quarter of the per-frame plane's", err_strip <= 0.25 * err_plane + 1e-9);
}
