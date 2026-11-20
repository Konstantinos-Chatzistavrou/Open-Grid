#include "rs/cops.hpp"
#include <algorithm>
#include <cmath>
#include <cstddef>

namespace rs {

namespace {

constexpr double kMinCornerGripFactor = 0.62;
constexpr double kPitRearOffsetM = 1.65;
constexpr double kPitLateralOffsetM = 0.95;
constexpr double kFlankAheadOffsetM = 0.55;
constexpr double kFlankLateralOffsetM = 2.15;
constexpr double kRoadblockAheadM = 420.0;
constexpr double kRoadblockGapWidthM = 3.2;
constexpr double kRoadblockTriggerSpeedMs = 20.0;
constexpr double kBustDistanceM = 5.5;
constexpr double kBustSpeedMs = 3.5;
constexpr double kBustDurationS = 3.5;
constexpr double kEscapeDistanceM = 180.0;
constexpr double kEscapeHoldS = 12.0;
constexpr double kPitCooldownS = 4.5;
constexpr double kCruiserWheelbaseM = 2.85;
constexpr double kMaxSteerRad = 32.0 * kPi / 180.0;

CopTargetState resolve_target_on_route(const Route& route, const CopTargetState& target) {
    CopTargetState eff = target;
    const RouteSample smp0 = route.at(target.route_s);
    const Vec3 left0 = route.left(target.route_s);
    const Vec3 route_pos = smp0.p + left0 * target.lateral_m;
    const double pos_len = length(target.position);
    const double diff_from_route = length(target.position - route_pos);

    if (pos_len < 1e-6 && std::fabs(target.route_s) > 1e-6) {
        eff.position = route_pos;
    } else if (std::fabs(target.route_s) < 1e-6 && diff_from_route > 1.0) {
        const Route::Projection proj = route.project(target.position);
        eff.route_s = proj.s;
        eff.lateral_m = proj.lateral;
    }
    return eff;
}

int select_pursuit_gear(double speed_ms) {
    const double v = std::max(0.0, speed_ms);
    if (v < 11.0) return 2;
    if (v < 21.0) return 3;
    if (v < 32.0) return 4;
    if (v < 44.0) return 5;
    return 6;
}

void stage_roadblock(const Route& route, double route_s, RoadblockBarricade& rb) {
    rb.active = true;
    rb.route_s = route.wrap(route_s);
    rb.gap_center_lat_m = 0.0;
    rb.gap_width_m = kRoadblockGapWidthM;

    const RouteSample sample = route.at(rb.route_s);
    const Vec3 left_vec = route.left(rb.route_s);
    const Vec3 tan_vec = route.tangent(rb.route_s);
    const double cruiser_lat_offset = 0.5 * rb.gap_width_m + 1.85;

    rb.cruiser_positions[0] = sample.p + left_vec * (rb.gap_center_lat_m + cruiser_lat_offset) - tan_vec * 0.35;
    rb.cruiser_positions[1] = sample.p + left_vec * (rb.gap_center_lat_m - cruiser_lat_offset) + tan_vec * 0.35;
    rb.cruiser_orientations[0] = Quat::from_axis_angle({0.0, 0.0, 1.0}, sample.heading - 0.38 * kPi);
    rb.cruiser_orientations[1] = Quat::from_axis_angle({0.0, 0.0, 1.0}, sample.heading + 0.38 * kPi);
}

}  // namespace

bool TacticalCopSystem::is_allowed_in_mode(bool is_race_event,
                                           bool cop_mode_enabled,
                                           bool mandatory_patrol_district) const {
    if (!is_race_event) {
        return false;
    }
    return cop_mode_enabled || mandatory_patrol_district;
}

double TacticalCopSystem::compute_corner_grip_factor(double abs_curvature_inv_m, double speed_ms) {
    const double k = std::fabs(abs_curvature_inv_m);
    const double v = std::fabs(speed_ms);
    if (k <= 0.004 || v <= 8.0) {
        return 1.0;
    }
    const double curv_t = clamp((k - 0.004) / 0.024, 0.0, 1.0);
    const double speed_t = clamp((v - 8.0) / 22.0, 0.0, 1.0);
    const double combined = curv_t * speed_t;
    const double smooth = combined * combined * (3.0 - 2.0 * combined);
    return clamp(1.0 - (1.0 - kMinCornerGripFactor) * smooth, kMinCornerGripFactor, 1.0);
}

Vec3 TacticalCopSystem::compute_pit_aim_point(const CopTargetState& target, int side) {
    const int s = (side >= 0) ? 1 : -1;
    const Vec3 fwd{std::cos(target.heading_rad), std::sin(target.heading_rad), 0.0};
    const Vec3 left{-std::sin(target.heading_rad), std::cos(target.heading_rad), 0.0};
    return target.position - fwd * kPitRearOffsetM + left * (kPitLateralOffsetM * static_cast<double>(s));
}

Vec3 TacticalCopSystem::compute_flank_aim_point(const CopTargetState& target, int side) {
    const int s = (side >= 0) ? 1 : -1;
    const Vec3 fwd{std::cos(target.heading_rad), std::sin(target.heading_rad), 0.0};
    const Vec3 left{-std::sin(target.heading_rad), std::cos(target.heading_rad), 0.0};
    return target.position + fwd * kFlankAheadOffsetM + left * (kFlankLateralOffsetM * static_cast<double>(s));
}

DriverInput TacticalCopSystem::compute_pursuit_input(const ChassisState& cruiser_chassis,
                                                     const Vec3& aim_point_world,
                                                     double desired_speed_ms,
                                                     double corner_grip_factor) {
    const double grip = clamp(corner_grip_factor, 0.5, 1.0);
    const Vec3 local_target = cruiser_chassis.orientation.inv_rotate(aim_point_world - cruiser_chassis.position);
    const double ld = std::max(3.5, std::hypot(local_target.x, local_target.y));
    const double eta = std::atan2(local_target.y, local_target.x);
    const double delta = std::atan(2.0 * kCruiserWheelbaseM * std::sin(eta) / ld);

    const Vec3 fwd = cruiser_chassis.orientation.rotate({1.0, 0.0, 0.0});
    const double current_speed = dot(cruiser_chassis.velocity, fwd);
    const double effective_target_speed = desired_speed_ms * (0.65 + 0.35 * grip);
    const double speed_err = effective_target_speed - current_speed;

    DriverInput in{};
    in.steer = clamp((delta / kMaxSteerRad) * grip, -1.0, 1.0);
    in.throttle = clamp(speed_err * 0.22, 0.0, 1.0) * grip;
    in.brake = clamp(-speed_err * 0.18, 0.0, 1.0);
    in.clutch = 0.0;
    in.handbrake = 0.0;
    in.gear = select_pursuit_gear(std::max(current_speed, effective_target_speed));
    in.auto_clutch = true;
    return in;
}

void TacticalCopSystem::spawn_pursuit(const Route& route, const CopTargetState& target, int heat_level) {
    const CopTargetState eff = resolve_target_on_route(route, target);
    active_ = true;
    heat_level_ = std::max(1, std::min(5, heat_level));
    bust_progress_ = 0.0;
    busted_ = false;
    escaped_ = false;
    escape_timer_s_ = 0.0;
    roadblock_ = RoadblockBarricade{};

    const int pit_side = (eff.lateral_m >= 0.0) ? -1 : 1;

    // Unit 0: PIT Specialist (stages close on rear quarter)
    CopUnit& u0 = units_[0];
    u0 = CopUnit{};
    u0.role = CopRole::Pit;
    u0.active = true;
    u0.preferred_side = pit_side;
    u0.route_s = route.wrap(eff.route_s - 3.2);
    u0.lateral_m = eff.lateral_m + 1.15 * static_cast<double>(u0.preferred_side);
    u0.speed_ms = std::max(12.0, eff.speed_ms + 2.0);
    const RouteSample smp0 = route.at(u0.route_s);
    u0.corner_grip_factor = compute_corner_grip_factor(std::fabs(smp0.curvature), u0.speed_ms);
    u0.position = smp0.p + route.left(u0.route_s) * u0.lateral_m;
    u0.orientation = Quat::from_axis_angle({0.0, 0.0, 1.0}, smp0.heading);
    u0.velocity = route.tangent(u0.route_s) * u0.speed_ms;
    u0.aim_point_world = compute_pit_aim_point(eff, u0.preferred_side);
    u0.driver_input = compute_pursuit_input(
        ChassisState{u0.position, u0.orientation, u0.velocity, Vec3{}},
        u0.aim_point_world,
        u0.speed_ms + 4.0,
        u0.corner_grip_factor);

    // Unit 1: Flanker (boxes in opposite side at Heat >= 2)
    CopUnit& u1 = units_[1];
    u1 = CopUnit{};
    u1.role = CopRole::Flank;
    u1.active = (heat_level_ >= 2);
    u1.preferred_side = -pit_side;
    u1.route_s = route.wrap(eff.route_s - 6.5);
    u1.lateral_m = eff.lateral_m + kFlankLateralOffsetM * static_cast<double>(u1.preferred_side);
    u1.speed_ms = std::max(12.0, eff.speed_ms + 2.5);
    const RouteSample smp1 = route.at(u1.route_s);
    u1.corner_grip_factor = compute_corner_grip_factor(std::fabs(smp1.curvature), u1.speed_ms);
    u1.position = smp1.p + route.left(u1.route_s) * u1.lateral_m;
    u1.orientation = Quat::from_axis_angle({0.0, 0.0, 1.0}, smp1.heading);
    u1.velocity = route.tangent(u1.route_s) * u1.speed_ms;
    u1.aim_point_world = compute_flank_aim_point(eff, u1.preferred_side);
    u1.driver_input = compute_pursuit_input(
        ChassisState{u1.position, u1.orientation, u1.velocity, Vec3{}},
        u1.aim_point_world,
        u1.speed_ms + 4.0,
        u1.corner_grip_factor);

    closest_distance_m_ = length(u0.position - eff.position);
    if (u1.active) {
        closest_distance_m_ = std::min(closest_distance_m_, length(u1.position - eff.position));
    }
}

void TacticalCopSystem::break_off() {
    active_ = false;
    for (CopUnit& u : units_) {
        u.active = false;
        u.pit_contact_triggered = false;
        u.pit_impulse_body = Vec3{};
        u.driver_input = DriverInput{};
    }
    roadblock_.active = false;
}

void TacticalCopSystem::update(const Route& route,
                               const CopTargetState& target,
                               int heat_level,
                               bool is_race_event,
                               bool cop_mode_enabled,
                               bool mandatory_patrol_district,
                               double dt) {
    if (!is_allowed_in_mode(is_race_event, cop_mode_enabled, mandatory_patrol_district)) {
        break_off();
        return;
    }

    if (!active_ && !busted_ && !escaped_) {
        spawn_pursuit(route, target, heat_level);
    }
    if (!active_) {
        return;
    }

    const CopTargetState eff = resolve_target_on_route(route, target);
    heat_level_ = std::max(1, std::min(5, heat_level));
    if (heat_level_ >= 2 && !units_[1].active) {
        units_[1].active = true;
        units_[1].role = CopRole::Flank;
        units_[1].preferred_side = -units_[0].preferred_side;
        units_[1].route_s = route.wrap(eff.route_s - 6.0);
        units_[1].lateral_m = eff.lateral_m + kFlankLateralOffsetM * static_cast<double>(units_[1].preferred_side);
        units_[1].speed_ms = std::max(12.0, eff.speed_ms);
    }

    const double top_speed_ms = 55.0 + static_cast<double>(heat_level_ - 1) * 3.5;
    double min_dist = 1e9;

    for (std::size_t idx = 0; idx < units_.size(); ++idx) {
        CopUnit& u = units_[idx];
        if (!u.active) {
            continue;
        }

        u.pit_contact_triggered = false;
        u.pit_impulse_body = Vec3{};
        u.pit_cooldown_s = std::max(0.0, u.pit_cooldown_s - dt);

        if (u.role == CopRole::Pit) {
            if (eff.lateral_m > 0.25) {
                u.preferred_side = -1;
            } else if (eff.lateral_m < -0.25) {
                u.preferred_side = 1;
            }
            u.aim_point_world = compute_pit_aim_point(eff, u.preferred_side);
        } else {
            u.preferred_side = -units_[0].preferred_side;
            u.aim_point_world = compute_flank_aim_point(eff, u.preferred_side);
        }

        const RouteSample pre_sample = route.at(u.route_s);
        u.corner_grip_factor = compute_corner_grip_factor(std::fabs(pre_sample.curvature), std::max(u.speed_ms, eff.speed_ms));

        const double pre_dist = length(u.position - eff.position);
        double desired_speed = eff.speed_ms;

        if (pre_dist > kEscapeDistanceM) {
            // Target is beyond visual contact range (> 180 m): hold current search pace without rubber-banding.
            desired_speed = eff.speed_ms * u.corner_grip_factor;
            u.speed_ms = desired_speed;
        } else if (eff.speed_ms < kBustSpeedMs && pre_dist < 40.0) {
            // Target is slow/pinned: box in tightly around the target vehicle.
            const double pin_s_offset = (u.role == CopRole::Pit) ? -kPitRearOffsetM : kFlankAheadOffsetM;
            const double pin_lat_offset = ((u.role == CopRole::Pit) ? kPitLateralOffsetM : kFlankLateralOffsetM) *
                                          static_cast<double>(u.preferred_side);
            u.route_s = route.wrap(eff.route_s + pin_s_offset);
            u.lateral_m = eff.lateral_m + pin_lat_offset;
            u.speed_ms = eff.speed_ms;
            desired_speed = eff.speed_ms;
        } else {
            const double want_s_offset = (u.role == CopRole::Pit)
                                             ? ((u.pit_cooldown_s <= 0.0) ? -kPitRearOffsetM : -4.2)
                                             : kFlankAheadOffsetM;
            const double target_slot_s = route.wrap(eff.route_s + want_s_offset);
            const double ds = route.delta(u.route_s, target_slot_s);
            const double abs_curv = std::fabs(pre_sample.curvature);
            const double corner_cap = (abs_curv > 0.005)
                                          ? std::sqrt((1.08 * kGravity * u.corner_grip_factor) / abs_curv)
                                          : top_speed_ms;
            const double raw_want_speed = clamp(eff.speed_ms + ds * 1.45, 0.0, top_speed_ms * u.corner_grip_factor);
            desired_speed = std::min(raw_want_speed, corner_cap);

            const double accel_rate = (desired_speed >= u.speed_ms) ? (4.8 * u.corner_grip_factor) : 7.5;
            u.speed_ms += (desired_speed - u.speed_ms) * std::min(1.0, dt * accel_rate);
            u.route_s = route.wrap(u.route_s + u.speed_ms * dt);

            const double base_lat = (u.role == CopRole::Pit)
                                        ? (kPitLateralOffsetM * static_cast<double>(u.preferred_side))
                                        : (kFlankLateralOffsetM * static_cast<double>(u.preferred_side));
            const double understeer_push = (1.0 - u.corner_grip_factor) * (-sign(pre_sample.curvature)) * 1.8;
            const double want_lat = clamp(eff.lateral_m + base_lat + understeer_push,
                                          -pre_sample.width_right,
                                          pre_sample.width_left);
            u.lateral_m += (want_lat - u.lateral_m) * std::min(1.0, dt * 3.8 * u.corner_grip_factor);
        }

        const RouteSample cur_sample = route.at(u.route_s);
        const Vec3 left_vec = route.left(u.route_s);
        const Vec3 tan_vec = route.tangent(u.route_s);
        u.position = cur_sample.p + left_vec * u.lateral_m;
        u.orientation = Quat::from_axis_angle({0.0, 0.0, 1.0}, cur_sample.heading);
        u.velocity = tan_vec * u.speed_ms;

        const ChassisState cruiser_chassis{u.position, u.orientation, u.velocity, Vec3{}};
        u.driver_input = compute_pursuit_input(cruiser_chassis, u.aim_point_world, desired_speed, u.corner_grip_factor);

        const double dist_to_target = length(u.position - eff.position);
        min_dist = std::min(min_dist, dist_to_target);

        const double dist_to_aim = length(u.position - u.aim_point_world);
        if (u.role == CopRole::Pit && u.pit_cooldown_s <= 0.0 && eff.speed_ms > 10.0 && dist_to_aim < 2.2) {
            u.pit_contact_triggered = true;
            u.pit_cooldown_s = kPitCooldownS;
            const double push_sign = -static_cast<double>(u.preferred_side);
            const double impulse_ns = 2200.0 + 350.0 * static_cast<double>(heat_level_);
            u.pit_impulse_body = Vec3{-250.0, push_sign * impulse_ns, 0.0};
        }
    }

    closest_distance_m_ = min_dist;

    // Roadblock staging: 420 m ahead along route with 3.2 m center gap when heat >= 2 and speed > 20 m/s
    if (heat_level_ >= 2 && eff.speed_ms > kRoadblockTriggerSpeedMs) {
        if (!roadblock_.active) {
            stage_roadblock(route, eff.route_s + kRoadblockAheadM, roadblock_);
        } else if (route.delta(roadblock_.route_s, eff.route_s) > 35.0) {
            stage_roadblock(route, eff.route_s + kRoadblockAheadM, roadblock_);
        }
    }

    // Bust progress: 0..1 over 3.5 s when closest cruiser < 5.5 m and target.speed_ms < 3.5; decays otherwise
    if (closest_distance_m_ < kBustDistanceM && eff.speed_ms < kBustSpeedMs) {
        bust_progress_ = clamp(bust_progress_ + dt / kBustDurationS, 0.0, 1.0);
        if (bust_progress_ >= 1.0 - 1e-9) {
            bust_progress_ = 1.0;
            busted_ = true;
        }
    } else if (!busted_) {
        bust_progress_ = clamp(bust_progress_ - dt / kBustDurationS, 0.0, 1.0);
    }

    // Escape timer: true after 12.0 s at > 180 m
    if (closest_distance_m_ > kEscapeDistanceM) {
        escape_timer_s_ += dt;
        if (escape_timer_s_ >= kEscapeHoldS) {
            escaped_ = true;
            break_off();
        }
    } else {
        escape_timer_s_ = std::max(0.0, escape_timer_s_ - dt);
    }
}

rs::ue5::UeVec3 TacticalCopSystem::unit_pos_ue5(int idx) const {
    const std::size_t i = (idx <= 0) ? 0u : 1u;
    return rs::ue5::pos_to_ue(units_[i].position);
}

rs::ue5::UeQuat TacticalCopSystem::unit_quat_ue5(int idx) const {
    const std::size_t i = (idx <= 0) ? 0u : 1u;
    return rs::ue5::quat_to_ue(units_[i].orientation);
}

}  // namespace rs
