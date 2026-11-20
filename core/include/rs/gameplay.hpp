// Engine-agnostic C++17 Gameplay Systems for rs_core (OpenGrid):
//   1. WorldClock & Dynamic Weather/Seasons (1:4 time compression, 1-in-5 rain wetness, 4-season grip, night traffic density)
//   2. Spontaneous 1v1 Headlight-Flash Drag Wagers (Cash / Pink Slip, 400m drag strip, disconnect forfeit)
//   3. Speed Traps & Drift Zones (trap average speed, drift angle/speed scoring, wall-tap voiding)
//   4. Economy, Pre-Race Insurance (-50% repairs & tow), Tow Truck Fee & Steward Time Penalties (+5.0 s)
//
// Zero engine dependencies — runs identically on the C++ dedicated server, Unreal Engine 5, and Web WASM.
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#include "rs/math.hpp"

namespace rs {

// ---- 1. World Clock, Seasons & Weather ---------------------------------------------------------------
enum class Season : int { Winter = 0, Spring = 1, Summer = 2, Autumn = 3 };

struct WorldEnvironmentState {
    double game_seconds = 22.0 * 3600.0;   // starts at 22:00 night shift (0..86400)
    Season season = Season::Autumn;
    bool raining = false;
    double wetness = 0.25;                 // 0.15 dry night sheen .. 1.0 rain puddles
    double target_wetness = 0.25;

    static Season season_for_month(int month_1_to_12);
    double hour_of_day() const;
    /** Realism: 22:00-05:30 has light underground street traffic (0.28..0.45); daytime rush is denser (0.85..1.0). */
    double traffic_density() const;
    /** Combined tire grip multiplier from wetness and season (0.76 in wet winter .. 1.00 dry summer). */
    double surface_grip_multiplier() const;
    /** Roll 1-in-5 (20%) deterministic chance of rain for a session seed. */
    void roll_session_weather(std::uint32_t session_seed);
    /** Advance 1:4 accelerated world clock (15 real minutes = 1 game hour) and smooth wetness. */
    void tick(double real_dt_s);
};

// ---- 2. Spontaneous Headlight-Flash 1v1 Wagers (Free Roam) -------------------------------------------
enum class WagerStakes : int { Cash = 0, PinkSlip = 1 };
enum class WagerPhase : int { Idle = 0, Challenged = 1, Countdown = 2, Racing = 3, Finished = 4 };

struct SpontaneousWagerState {
    WagerPhase phase = WagerPhase::Idle;
    WagerStakes stakes = WagerStakes::Cash;
    int cash_amount_xp = 1500;
    std::string opponent_id;
    std::string opponent_car_id;
    Vec3 start_pos{};
    Vec3 drag_dir{1, 0, 0};
    double drag_distance_m = 400.0;        // 1/4 mile street drag
    double timer_s = 0.0;
    double player_progress_m = 0.0;
    double opponent_progress_m = 0.0;
    bool player_won = false;
    bool opponent_disconnected_forfeit = false;

    /** Trigger a 1v1 wager challenge when flashing headlights within 18m at < 15 m/s in Free Roam. */
    bool try_flash_challenge(const Vec3& my_pos, double my_speed_ms,
                             const Vec3& opp_pos, double opp_speed_ms,
                             const Vec3& road_dir, const std::string& opp_id,
                             const std::string& opp_car, WagerStakes stake_kind, int cash_xp = 1500);
    void accept_challenge();
    void tick(const Vec3& my_pos, const Vec3& opp_pos, double dt_s);
    /** Anti-save-scumming: if opponent disconnects mid-wager, challenger automatically wins escrow stakes. */
    void on_opponent_disconnect();
    void reset();
};

// ---- 3. Speed Traps & Drift Zones --------------------------------------------------------------------
enum class ZoneKind : int { SpeedTrap = 0, DriftZone = 1 };

struct CityZoneSpec {
    std::string id;
    ZoneKind kind = ZoneKind::SpeedTrap;
    Vec3 start_pos{};
    Vec3 end_pos{};
    double trigger_radius_m = 18.0;
    double target_score = 180.0;           // km/h for SpeedTrap, points for DriftZone
};

struct ActiveZoneRun {
    bool active = false;
    std::string zone_id;
    ZoneKind kind = ZoneKind::SpeedTrap;
    double elapsed_s = 0.0;
    double distance_m = 0.0;
    double speed_sum_kmh_s = 0.0;
    double drift_points = 0.0;
    bool voided_by_crash = false;
    bool completed = false;
    double final_score = 0.0;

    void start(const CityZoneSpec& z);
    /** Updates active zone run; wall/traffic impact > 8 kJ voids an active Drift Zone score. */
    void tick(const CityZoneSpec& z, const Vec3& pos, double speed_ms, double sideslip_rad, double impact_kj, double dt_s);
};

// ---- 4. Damage Economy, Pre-Race Insurance (-50%), Tow Truck Fee & Steward Penalties -----------------
struct CarMaintenanceState {
    double structural_damage = 0.0;        // 0.0 (mint) .. 1.0 (totaled)
    bool totaled = false;
    bool pre_race_insured = false;         // -50% on repair bills and tow truck fees
};

struct RepairQuote {
    int damage_pct = 0;
    int repair_cost_xp = 0;
    int tow_fee_xp = 0;
    int insurance_premium_xp = 120;
};

class StewardPenaltySystem {
public:
    double total_penalty_s = 0.0;
    int incident_count = 0;

    void reset();
    /** Adds +5.0 s (default) steward penalty for heavy ramming (> 22 kJ) or track cutting, with 4.5 s debounce. */
    bool record_incident(double now_s, double impact_kj, bool off_track_cut, double penalty_s = 5.0);

private:
    double last_incident_s_ = -100.0;
};

RepairQuote compute_repair_and_tow_quote(const CarMaintenanceState& st);
void apply_post_race_damage(CarMaintenanceState& st, double severity_0_to_1, bool wrecked_or_totaled);
void repair_car_to_mint(CarMaintenanceState& st);

}  // namespace rs
