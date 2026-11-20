// Engine-agnostic C++17 Tactical Police AI for rs_core (OpenGrid).
// Shared between Unreal Engine 5 (APoliceVehicle / UActorComponent) and Web WASM.
//
// Core OpenGrid Rule:
//   Police pursuits are NEVER active in Free Roam (!is_race_event -> false).
//   They engage only in Race Events where Cop Mode is enabled or in a mandatory patrol district.
//
// Convention: ISO 8855 right-handed SI (+X forward, +Y left, +Z up, meters, m/s, radians).
#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include "rs/math.hpp"
#include "rs/route.hpp"
#include "rs/ue5_bridge.hpp"
#include "rs/vehicle.hpp"

namespace rs {

enum class CopRole : int {
    Pit = 0,
    Flank = 1,
    Roadblock = 2
};

struct CopTargetState {
    Vec3 position{};
    Vec3 velocity{};
    double heading_rad = 0.0;
    double speed_ms = 0.0;
    double route_s = 0.0;
    double lateral_m = 0.0;
};

struct CopUnit {
    CopRole role = CopRole::Pit;
    bool active = false;
    Vec3 position{};
    Quat orientation{};
    Vec3 velocity{};
    double route_s = 0.0;
    double lateral_m = 0.0;
    double speed_ms = 0.0;
    int preferred_side = 1;           // +1 left, -1 right
    double pit_cooldown_s = 0.0;
    double corner_grip_factor = 1.0;  // drops in high-curvature corners so nimble street cars can out-corner cruisers
    Vec3 aim_point_world{};
    DriverInput driver_input{};
    bool pit_contact_triggered = false;
    Vec3 pit_impulse_body{};
};

struct RoadblockBarricade {
    bool active = false;
    double route_s = 0.0;
    double gap_center_lat_m = 0.0;
    double gap_width_m = 3.2;
    std::array<Vec3, 2> cruiser_positions{};
    std::array<Quat, 2> cruiser_orientations{};
};

class TacticalCopSystem {
public:
    explicit TacticalCopSystem() = default;

    // Core OpenGrid Rule: NEVER allowed in Free Roam (!is_race_event).
    bool is_allowed_in_mode(bool is_race_event, bool cop_mode_enabled, bool mandatory_patrol_district) const;

    void spawn_pursuit(const Route& route, const CopTargetState& target, int heat_level);
    void break_off();

    // Heavy interceptor cornering penalty: 1.0 on straights, drops smoothly to 0.62 in fast tight turns.
    static double compute_corner_grip_factor(double abs_curvature_inv_m, double speed_ms);

    // Rear-quarter bumper contact point: 1.65 m behind target CG and 0.95 m * side laterally.
    static Vec3 compute_pit_aim_point(const CopTargetState& target, int side);

    // Parallel box-in point: 0.55 m ahead of target CG and 2.15 m * side laterally.
    static Vec3 compute_flank_aim_point(const CopTargetState& target, int side);

    // Pure-pursuit steering & speed controller outputting DriverInput for full rs::Vehicle cruisers.
    static DriverInput compute_pursuit_input(const ChassisState& cruiser_chassis,
                                             const Vec3& aim_point_world,
                                             double desired_speed_ms,
                                             double corner_grip_factor);

    void update(const Route& route,
                const CopTargetState& target,
                int heat_level,
                bool is_race_event,
                bool cop_mode_enabled,
                bool mandatory_patrol_district,
                double dt);

    bool active() const { return active_; }
    const std::array<CopUnit, 2>& units() const { return units_; }
    const RoadblockBarricade& roadblock() const { return roadblock_; }
    double bust_progress() const { return bust_progress_; }
    bool busted() const { return busted_; }
    bool escaped() const { return escaped_; }
    double closest_distance_m() const { return closest_distance_m_; }

    rs::ue5::UeVec3 unit_pos_ue5(int idx) const;
    rs::ue5::UeQuat unit_quat_ue5(int idx) const;

private:
    bool active_ = false;
    int heat_level_ = 1;
    std::array<CopUnit, 2> units_{};
    RoadblockBarricade roadblock_{};
    double bust_progress_ = 0.0;
    bool busted_ = false;
    bool escaped_ = false;
    double escape_timer_s_ = 0.0;
    double closest_distance_m_ = 0.0;
};

}  // namespace rs
