// Apache-2.0 — OpenGrid FIA/iRacing-Grade Race Control, Fault-Aware Telemetry Stewarding,
// Pit Lane Service Rules, and Endurance Team Driver-Swap Manager.
// 100% engine-agnostic C++20: runs identically on the UE 5.8 Dedicated Server, local sims, and replays.
#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include "rs/math.hpp"

namespace rs {

// ---- 1. Full FIA / iRacing Flag System -------------------------------------------------------------

enum class RaceFlag : int {
    Green = 0,
    LocalYellow = 1,       // Incident/stopped car in sector: NO overtaking allowed
    FullCourseYellow = 2,  // Safety Car / FCY: speed cap + no overtaking
    Blue = 3,              // Faster lapping car within 1.2 s behind: yield safely
    BlackAndWhite = 4,     // Unsportsmanlike / 3x track-limit warning
    Black = 5,             // Active Drive-Through / Stop-and-Go penalty (must serve within 3 laps)
    Meatball = 6,          // Severe structural damage (>= 72%): mandatory pit repair within 3 laps
    Checkered = 7,
    Red = 8
};

enum class PenaltyType : int {
    None = 0,
    Slowdown = 1,          // Bleed gained time on track within 30 s
    TimePenalty5s = 2,     // Added post-race
    DriveThrough = 3,      // Must drive through pit lane at limiter speed within 3 laps
    StopAndGo10s = 4,      // Must stop in pit box for 10 s within 3 laps
    Disqualified = 5
};

enum class IncidentKind : int {
    None = 0,
    OffTrack1x = 1,
    LossOfControl2x = 2,
    SharedContact2x = 3,
    AtFaultContact4x = 4,
    VictimShield0x = 5,    // Blameless victim (rear-ended / hit by unsafe rejoin) -> 0x SR protection!
    UnsafeRejoin4x = 6,
    IntentionalRam4x = 7,
    YellowOvertake = 8,
    PitSpeeding = 9
};

// ---- 2. Fault-Aware Telemetry Collision Attribution (Beats iRacing's No-Fault 4x!) ----------------

struct CarCollisionTelemetry {
    std::string driver_id;
    Vec3 pos{};
    Vec3 vel{};
    Vec3 track_tangent{1.0, 0.0, 0.0};
    double track_s_m = 0.0;        // Longitudinal progress along lap (m)
    double brake_01 = 0.0;         // 0..1 brake pedal
    double throttle_01 = 0.0;      // 0..1 throttle pedal
    double steer_rad = 0.0;        // Steering wheel angle
    bool off_track = false;        // Currently outside white lines
    bool rejoining_track = false;  // Returning from off-track within last 2.0 s
    double car_length_m = 4.5;
};

struct CollisionFaultVerdict {
    IncidentKind incident_a = IncidentKind::None;
    IncidentKind incident_b = IncidentKind::None;
    int points_a = 0;
    int points_b = 0;
    PenaltyType penalty_a = PenaltyType::None;
    PenaltyType penalty_b = PenaltyType::None;
    bool auto_flag_protest_a = false;
    bool auto_flag_protest_b = false;
    std::string reason;
};

/**
 * Evaluates a car-to-car contact using 400 Hz physics telemetry to protect blameless victims (0x Victim Shield):
 *  - Unsafe off-track rejoin into on-track traffic -> Rejoiner gets 4x + DriveThrough; victim gets 0x.
 *  - Rear-end / no-overlap divebomb into smoothly braking lead car -> Trailing car gets 4x; victim gets 0x.
 *  - High-energy zero-brake deliberate ramming -> Attacker gets 4x + StopAndGo10s + protest auto-flag; victim gets 0x.
 *  - Side-by-side racing incident -> < 8 kJ door-rub = 0x; heavier shared contact = 2x each.
 */
CollisionFaultVerdict evaluate_collision_fault(
    const CarCollisionTelemetry& a,
    const CarCollisionTelemetry& b,
    double impact_energy_kj);

// ---- 3. Per-Driver Race Control State (Flags, Track Limits, Slowdowns, Pit Rules) ------------------

struct DriverRaceControlState {
    std::string driver_id;
    RaceFlag active_flag = RaceFlag::Green;
    int incident_points = 0;
    int victim_shield_count = 0;
    int track_limit_warnings = 0;
    int dsq_incident_limit = 17;           // iRacing-standard 17x disqualification threshold

    // Active penalties
    double slowdown_debt_s = 0.0;          // Time to give back on track
    double slowdown_deadline_s = 0.0;      // Escalates to DriveThrough if not served in time
    PenaltyType pending_pit_penalty = PenaltyType::None;
    int penalty_laps_remaining = 0;
    double post_race_time_penalty_s = 0.0;
    bool meatball_active = false;
    int meatball_laps_remaining = 0;
    bool disqualified = false;

    // Pit stop & service state
    bool in_pit_lane = false;
    bool pit_limiter_on = false;
    bool in_pit_box = false;
    double pit_service_remaining_s = 0.0;
    bool pit_stop_completed = false;
    int pit_stops_served = 0;
    bool pit_speeding_flagged_this_entry = false;
};

struct PitServiceRequest {
    bool change_tyres = true;
    double refuel_liters = 0.0;
    double repair_damage_01 = 0.0;
    bool driver_swap = false;
    bool serve_penalty = true;
};

class RaceControlManager {
public:
    double pit_speed_limit_kmh = 80.0;
    double fcy_speed_limit_kmh = 100.0;
    int max_incidents_dsq = 17;

    /** Records an off-track excursion (1x). If time was gained (>0.15s), issues a Slowdown; 3rd cut -> Black & White flag. */
    IncidentKind record_off_track(DriverRaceControlState& st, double now_s, double time_gained_s);

    /** Records a spin / loss of control (2x). */
    IncidentKind record_loss_of_control(DriverRaceControlState& st);

    /** Applies a fault-aware collision verdict to both drivers cleanly. */
    void apply_collision_verdict(DriverRaceControlState& a, DriverRaceControlState& b, const CollisionFaultVerdict& v);

    /** Records an illegal overtake under Local Yellow or Full Course Yellow -> Drive-Through if not returned. */
    void record_yellow_flag_overtake(DriverRaceControlState& st);

    /** Updates pit lane entry/speeding, pit box service countdown, slowdown bleeding, meatball damage, and active flag. */
    void tick_driver(
        DriverRaceControlState& st,
        double now_s,
        double dt_s,
        double speed_kmh,
        double structural_damage_01,
        bool sector_yellow,
        bool full_course_yellow,
        bool faster_lapping_car_close,
        bool in_pit_lane,
        bool in_pit_box,
        const PitServiceRequest* service_req = nullptr);

    /** Called when driver completes a lap: decrements penalty/meatball grace laps and disqualifies if ignored past 0. */
    void on_lap_completed(DriverRaceControlState& st);

    /** Computes realistic pit service duration (tyres + fuel + damage repair + driver swap + Stop&Go hold). */
    static double compute_pit_service_seconds(const PitServiceRequest& req, PenaltyType active_penalty);
};

// ---- 4. Endurance Team Stint & Live Driver-Swap Tracker (iRacing / LMU 24h Parity) -----------------

struct EnduranceDriverStint {
    std::string driver_id;
    double total_drive_time_s = 0.0;
    int stints_completed = 0;
};

class EnduranceStintTracker {
public:
    std::string team_id;
    double min_fair_share_fraction = 0.25; // Every registered driver must drive >= 25% of equal share to avoid post-race DQ
    double max_single_stint_s = 3.0 * 3600.0;

    void register_driver(const std::string& driver_id);
    bool start_race(const std::string& starting_driver_id);
    void tick(double dt_s);
    /** Performs a pit-lane live driver swap onto a registered teammate. Returns false if driver unknown or car not stopped in box. */
    bool swap_driver_in_pits(const std::string& next_driver_id, bool in_pit_box, double car_speed_kmh);

    const std::string& active_driver() const { return active_driver_id_; }
    double current_stint_seconds() const { return current_stint_s_; }
    double total_team_seconds() const { return total_race_s_; }
    bool fair_share_satisfied() const;
    const std::vector<EnduranceDriverStint>& drivers() const { return drivers_; }

private:
    std::vector<EnduranceDriverStint> drivers_;
    std::string active_driver_id_;
    double current_stint_s_ = 0.0;
    double total_race_s_ = 0.0;
};

}  // namespace rs
