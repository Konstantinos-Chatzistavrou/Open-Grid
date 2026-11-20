// Unit tests for the engine-agnostic Tactical Police AI module (rs::TacticalCopSystem).
#include <cmath>
#include <vector>
#include "harness.hpp"
#include "rs/cops.hpp"

#ifndef TEST
#define TEST(name) RS_TEST(name)
#endif
#ifndef CHECK
#define CHECK(cond) test::check(#cond, (cond))
#endif
#ifndef CHECK_NEAR
#define CHECK_NEAR(a, b, tol) test::check(#a " ~= " #b, std::fabs((a) - (b)) <= (tol))
#endif

namespace {

rs::Route make_test_route() {
    std::vector<rs::RouteSample> samples;
    samples.reserve(60);
    for (int i = 0; i < 60; ++i) {
        rs::RouteSample s{};
        s.s = static_cast<double>(i) * 20.0;
        s.p = rs::Vec3{s.s, 0.0, 0.0};
        s.heading = 0.0;
        s.curvature = 0.0;
        s.width_left = 6.0;
        s.width_right = 6.0;
        samples.push_back(s);
    }
    return rs::Route::from_samples(std::move(samples), true);
}

}  // namespace

TEST(cops) {
    using namespace rs;

    const Route route = make_test_route();
    TacticalCopSystem cops;

    // 1. Free Roam rule: cops are NEVER allowed when !is_race_event, and update() with is_race_event = false
    //    immediately deactivates an active pursuit.
    CHECK(!cops.is_allowed_in_mode(false, true, true));
    CHECK(!cops.is_allowed_in_mode(false, true, false));
    CHECK(!cops.is_allowed_in_mode(false, false, true));

    CopTargetState target{};
    target.route_s = 100.0;
    target.position = route.at(target.route_s).p;
    target.heading_rad = 0.0;
    target.speed_ms = 28.0;
    target.velocity = Vec3{28.0, 0.0, 0.0};

    cops.spawn_pursuit(route, target, 2);
    CHECK(cops.active());
    cops.update(route, target, 2, false, true, true, 0.05);
    CHECK(!cops.active());

    // 2. Mandatory patrol district: allowed in a race event even when optional cop_mode_enabled is false.
    CHECK(cops.is_allowed_in_mode(true, false, true));
    CHECK(cops.is_allowed_in_mode(true, true, false));
    CHECK(!cops.is_allowed_in_mode(true, false, false));

    // 3. PIT aim point is behind (-1.65 m local X) and to the rear quarter (+-0.95 m local Y) of the target,
    //    while Flank aim point is ahead (+0.55 m local X) and wide (+-2.15 m local Y).
    const Vec3 pit_left = TacticalCopSystem::compute_pit_aim_point(target, 1) - target.position;
    const Vec3 pit_right = TacticalCopSystem::compute_pit_aim_point(target, -1) - target.position;
    CHECK_NEAR(pit_left.x, -1.65, 1e-6);
    CHECK_NEAR(pit_left.y, 0.95, 1e-6);
    CHECK_NEAR(pit_right.x, -1.65, 1e-6);
    CHECK_NEAR(pit_right.y, -0.95, 1e-6);

    const Vec3 flank_left = TacticalCopSystem::compute_flank_aim_point(target, 1) - target.position;
    const Vec3 flank_right = TacticalCopSystem::compute_flank_aim_point(target, -1) - target.position;
    CHECK_NEAR(flank_left.x, 0.55, 1e-6);
    CHECK_NEAR(flank_left.y, 2.15, 1e-6);
    CHECK_NEAR(flank_right.x, 0.55, 1e-6);
    CHECK_NEAR(flank_right.y, -2.15, 1e-6);

    // 4. Cornering grip penalty: heavy police cruisers lose grip in tight turns vs straights.
    const double grip_tight_corner = TacticalCopSystem::compute_corner_grip_factor(0.035, 35.0);
    const double grip_straight = TacticalCopSystem::compute_corner_grip_factor(0.001, 35.0);
    CHECK(grip_tight_corner < grip_straight);
    CHECK_NEAR(grip_straight, 1.0, 1e-6);
    CHECK_NEAR(grip_tight_corner, 0.62, 1e-6);

    // 5. Roadblock spawns ~420 m ahead with a 3.2 m center gap when heat >= 2 and speed > 20 m/s,
    //    and bust progress reaches 1.0 when pinned slow for 3.6 s.
    cops.spawn_pursuit(route, target, 2);
    cops.update(route, target, 2, true, true, false, 0.1);
    CHECK(cops.roadblock().active);
    CHECK_NEAR(cops.roadblock().route_s, target.route_s + 420.0, 1e-3);
    CHECK_NEAR(cops.roadblock().gap_width_m, 3.2, 1e-6);

    // Verify UE5 coordinate bridge helpers for Unit 0
    const rs::ue5::UeVec3 ue_pos0 = cops.unit_pos_ue5(0);
    CHECK_NEAR(ue_pos0.x, cops.units()[0].position.x * 100.0, 1e-6);
    CHECK_NEAR(ue_pos0.y, -cops.units()[0].position.y * 100.0, 1e-6);

    // Pin target at low speed (< 3.5 m/s) for 3.6 s -> bust_progress reaches 1.0 and busted() is true.
    target.speed_ms = 1.0;
    target.velocity = Vec3{1.0, 0.0, 0.0};
    for (int step = 0; step < 36; ++step) {
        cops.update(route, target, 2, true, true, false, 0.1);
    }
    CHECK_NEAR(cops.bust_progress(), 1.0, 1e-6);
    CHECK(cops.busted());
}
