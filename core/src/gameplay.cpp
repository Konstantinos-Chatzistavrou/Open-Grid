#include "rs/gameplay.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

// ---- 1. World Clock, Seasons & Weather ---------------------------------------------------------------
Season WorldEnvironmentState::season_for_month(int month_1_to_12) {
    if (month_1_to_12 == 12 || month_1_to_12 == 1 || month_1_to_12 == 2) return Season::Winter;
    if (month_1_to_12 >= 3 && month_1_to_12 <= 5) return Season::Spring;
    if (month_1_to_12 >= 6 && month_1_to_12 <= 8) return Season::Summer;
    return Season::Autumn;
}

double WorldEnvironmentState::hour_of_day() const {
    double h = std::fmod(game_seconds / 3600.0, 24.0);
    return h < 0.0 ? h + 24.0 : h;
}

double WorldEnvironmentState::traffic_density() const {
    const double h = hour_of_day();
    // 22:00 - 05:30 night shift: sparse underground street traffic
    if (h >= 22.0 || h < 5.5) return 0.32;
    // Morning & evening rush hours
    if ((h >= 7.0 && h <= 9.5) || (h >= 16.5 && h <= 19.0)) return 1.0;
    return 0.72;
}

double WorldEnvironmentState::surface_grip_multiplier() const {
    double season_grip = 1.0;
    switch (season) {
        case Season::Summer: season_grip = 1.00; break;
        case Season::Spring: season_grip = 0.98; break;
        case Season::Autumn: season_grip = 0.96; break;
        case Season::Winter: season_grip = 0.92; break;
    }
    const double wet_penalty = clamp((wetness - 0.25) / 0.75, 0.0, 1.0) * 0.14;
    return clamp(season_grip * (1.0 - wet_penalty), 0.74, 1.0);
}

void WorldEnvironmentState::roll_session_weather(std::uint32_t session_seed) {
    // Deterministic 1-in-5 (20%) rain roll
    std::uint32_t h = session_seed * 2654435761u;
    h ^= (h >> 16);
    raining = (h % 5u) == 0u;
    target_wetness = raining ? 0.92 : 0.25;
    wetness = target_wetness;
}

void WorldEnvironmentState::tick(double real_dt_s) {
    // 1:4 time compression (4 game seconds per 1 real second)
    game_seconds = std::fmod(game_seconds + real_dt_s * 4.0, 86400.0);
    if (game_seconds < 0.0) game_seconds += 86400.0;
    wetness += (target_wetness - wetness) * std::min(1.0, real_dt_s * 0.5);
}

// ---- 2. Spontaneous Headlight-Flash 1v1 Wagers -------------------------------------------------------
bool SpontaneousWagerState::try_flash_challenge(const Vec3& my_pos, double my_speed_ms,
                                                const Vec3& opp_pos, double opp_speed_ms,
                                                const Vec3& road_dir, const std::string& opp_id,
                                                const std::string& opp_car, WagerStakes stake_kind, int cash_xp) {
    if (phase != WagerPhase::Idle) return false;
    const double dist = length(opp_pos - my_pos);
    if (dist > 18.0 || std::abs(my_speed_ms) > 15.0 || std::abs(opp_speed_ms) > 15.0) return false;
    phase = WagerPhase::Challenged;
    stakes = stake_kind;
    cash_amount_xp = std::max(100, cash_xp);
    opponent_id = opp_id;
    opponent_car_id = opp_car;
    start_pos = my_pos;
    drag_dir = length(road_dir) > 1e-6 ? normalized(road_dir) : Vec3{1, 0, 0};
    timer_s = 3.0;
    player_progress_m = 0.0;
    opponent_progress_m = 0.0;
    player_won = false;
    opponent_disconnected_forfeit = false;
    return true;
}

void SpontaneousWagerState::accept_challenge() {
    if (phase == WagerPhase::Challenged) {
        phase = WagerPhase::Countdown;
        timer_s = 3.0;
    }
}

void SpontaneousWagerState::tick(const Vec3& my_pos, const Vec3& opp_pos, double dt_s) {
    if (phase == WagerPhase::Countdown) {
        timer_s -= dt_s;
        if (timer_s <= 0.0) {
            phase = WagerPhase::Racing;
            timer_s = 0.0;
        }
    } else if (phase == WagerPhase::Racing) {
        timer_s += dt_s;
        player_progress_m = std::max(0.0, dot(my_pos - start_pos, drag_dir));
        opponent_progress_m = std::max(0.0, dot(opp_pos - start_pos, drag_dir));
        if (player_progress_m >= drag_distance_m || opponent_progress_m >= drag_distance_m) {
            phase = WagerPhase::Finished;
            player_won = player_progress_m >= opponent_progress_m;
        }
    }
}

void SpontaneousWagerState::on_opponent_disconnect() {
    if (phase == WagerPhase::Countdown || phase == WagerPhase::Racing) {
        phase = WagerPhase::Finished;
        player_won = true;
        opponent_disconnected_forfeit = true;
    }
}

void SpontaneousWagerState::reset() {
    *this = SpontaneousWagerState{};
}

// ---- 3. Speed Traps & Drift Zones --------------------------------------------------------------------
void ActiveZoneRun::start(const CityZoneSpec& z) {
    active = true;
    zone_id = z.id;
    kind = z.kind;
    elapsed_s = 0.0;
    distance_m = 0.0;
    speed_sum_kmh_s = 0.0;
    drift_points = 0.0;
    voided_by_crash = false;
    completed = false;
    final_score = 0.0;
}

void ActiveZoneRun::tick(const CityZoneSpec& z, const Vec3& pos, double speed_ms, double sideslip_rad, double impact_kj, double dt_s) {
    if (!active || completed) return;
    elapsed_s += dt_s;
    const double spd = std::abs(speed_ms);
    const double kmh = spd * 3.6;
    distance_m += spd * dt_s;

    if (kind == ZoneKind::SpeedTrap) {
        speed_sum_kmh_s += kmh * dt_s;
    } else {
        // Drift Zone: wall or traffic hit > 8 kJ voids the run
        if (impact_kj > 8.0) {
            voided_by_crash = true;
        }
        const double slip_deg = std::abs(sideslip_rad) * (180.0 / kPi);
        if (!voided_by_crash && kmh > 32.0 && slip_deg > 11.0) {
            drift_points += (kmh * 0.85) * std::min(65.0, slip_deg) * dt_s * 1.4;
        }
    }

    if (length(pos - z.end_pos) <= z.trigger_radius_m && elapsed_s > 0.25) {
        completed = true;
        active = false;
        if (kind == ZoneKind::SpeedTrap) {
            final_score = speed_sum_kmh_s / std::max(elapsed_s, 0.001);
        } else {
            final_score = voided_by_crash ? 0.0 : std::round(drift_points);
        }
    }
}

// ---- 4. Damage Economy, Pre-Race Insurance (-50%), Tow Truck Fee & Steward Penalties -----------------
void StewardPenaltySystem::reset() {
    total_penalty_s = 0.0;
    incident_count = 0;
    last_incident_s_ = -100.0;
}

bool StewardPenaltySystem::record_incident(double now_s, double impact_kj, bool off_track_cut, double penalty_s) {
    if (!off_track_cut && impact_kj <= 22.0) return false;
    if (now_s - last_incident_s_ < 4.5) return false;
    last_incident_s_ = now_s;
    total_penalty_s += penalty_s;
    ++incident_count;
    return true;
}

RepairQuote compute_repair_and_tow_quote(const CarMaintenanceState& st) {
    RepairQuote q;
    q.damage_pct = static_cast<int>(std::round(clamp(st.structural_damage, 0.0, 1.0) * 100.0));
    const double discount = st.pre_race_insured ? 0.5 : 1.0;
    q.repair_cost_xp = static_cast<int>(std::round(q.damage_pct * 9.0 * discount));
    q.tow_fee_xp = st.totaled ? static_cast<int>(std::round(650.0 * discount)) : 0;
    return q;
}

void apply_post_race_damage(CarMaintenanceState& st, double severity_0_to_1, bool wrecked_or_totaled) {
    st.structural_damage = clamp(std::max(st.structural_damage, severity_0_to_1), 0.0, 1.0);
    if (wrecked_or_totaled || st.structural_damage >= 0.98) {
        st.totaled = true;
        st.structural_damage = 1.0;
    }
}

void repair_car_to_mint(CarMaintenanceState& st) {
    st.structural_damage = 0.0;
    st.totaled = false;
}

}  // namespace rs
