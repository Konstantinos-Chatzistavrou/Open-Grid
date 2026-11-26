// Apache-2.0 — OpenGrid FIA/iRacing-Grade Race Control, Fault-Aware Telemetry Stewarding & Endurance Swaps.
#include "rs/race_control.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

CollisionFaultVerdict evaluate_collision_fault(
    const CarCollisionTelemetry& a,
    const CarCollisionTelemetry& b,
    double impact_energy_kj) {
    CollisionFaultVerdict v{};
    if (impact_energy_kj < 2.5) {
        v.reason = "negligible rub (<2.5 kJ)";
        return v;
    }

    // 1. Unsafe Off-Track Rejoin: rejoining car bears 100% fault; on-track driver receives 0x Victim Shield!
    if (a.rejoining_track && !b.rejoining_track) {
        v.incident_a = IncidentKind::UnsafeRejoin4x;
        v.incident_b = IncidentKind::VictimShield0x;
        v.points_a = 4;
        v.points_b = 0;
        v.penalty_a = PenaltyType::DriveThrough;
        v.auto_flag_protest_a = impact_energy_kj > 20.0;
        v.reason = "Car A unsafe off-track rejoin into Car B (0x Victim Shield)";
        return v;
    }
    if (b.rejoining_track && !a.rejoining_track) {
        v.incident_a = IncidentKind::VictimShield0x;
        v.incident_b = IncidentKind::UnsafeRejoin4x;
        v.points_a = 0;
        v.points_b = 4;
        v.penalty_b = PenaltyType::DriveThrough;
        v.auto_flag_protest_b = impact_energy_kj > 20.0;
        v.reason = "Car B unsafe off-track rejoin into Car A (0x Victim Shield)";
        return v;
    }

    // Compute longitudinal separation along track tangent (positive ds = A is ahead of B)
    const double tlen = std::sqrt(a.track_tangent.x * a.track_tangent.x + a.track_tangent.y * a.track_tangent.y + a.track_tangent.z * a.track_tangent.z);
    const Vec3 tang = (tlen > 1e-9) ? Vec3{a.track_tangent.x / tlen, a.track_tangent.y / tlen, a.track_tangent.z / tlen} : Vec3{1.0, 0.0, 0.0};
    const Vec3 rel_pos{a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z};
    const double ds_geom = rel_pos.x * tang.x + rel_pos.y * tang.y + rel_pos.z * tang.z;
    const double ds = (std::abs(a.track_s_m - b.track_s_m) > 0.01 && std::abs(a.track_s_m - b.track_s_m) < 50.0)
                    ? (a.track_s_m - b.track_s_m)
                    : ds_geom;
    const double avg_len = 0.5 * (a.car_length_m + b.car_length_m);
    const double overlap = avg_len - std::abs(ds); // <= 0.35 m means trailing car had NO side-by-side overlap!

    const double va_long = a.vel.x * tang.x + a.vel.y * tang.y + a.vel.z * tang.z;
    const double vb_long = b.vel.x * tang.x + b.vel.y * tang.y + b.vel.z * tang.z;

    // 2. Rear-End / No-Overlap Divebomb: trailing car closing fast into lead car -> trailing car 4x, victim 0x!
    if (overlap <= 0.35) {
        const bool a_ahead = ds > 0.0;
        const CarCollisionTelemetry& lead = a_ahead ? a : b;
        const CarCollisionTelemetry& trail = a_ahead ? b : a;
        const double closing_ms = a_ahead ? (vb_long - va_long) : (va_long - vb_long);
        const bool deliberate_ram = impact_energy_kj >= 28.0 && trail.brake_01 < 0.05 && trail.throttle_01 > 0.65 && closing_ms > 7.0;

        if (closing_ms > 3.0 || lead.brake_01 > 0.20) {
            if (a_ahead) {
                v.incident_a = IncidentKind::VictimShield0x;
                v.incident_b = deliberate_ram ? IncidentKind::IntentionalRam4x : IncidentKind::AtFaultContact4x;
                v.points_a = 0;
                v.points_b = 4;
                if (deliberate_ram) { v.penalty_b = PenaltyType::StopAndGo10s; v.auto_flag_protest_b = true; }
                else if (impact_energy_kj > 22.0) { v.penalty_b = PenaltyType::DriveThrough; }
                v.reason = deliberate_ram ? "Car B deliberate zero-brake rear ram into Car A (0x Victim Shield)"
                                          : "Car B rear-ended lead Car A without overlap (0x Victim Shield)";
            } else {
                v.incident_a = deliberate_ram ? IncidentKind::IntentionalRam4x : IncidentKind::AtFaultContact4x;
                v.incident_b = IncidentKind::VictimShield0x;
                v.points_a = 4;
                v.points_b = 0;
                if (deliberate_ram) { v.penalty_a = PenaltyType::StopAndGo10s; v.auto_flag_protest_a = true; }
                else if (impact_energy_kj > 22.0) { v.penalty_a = PenaltyType::DriveThrough; }
                v.reason = deliberate_ram ? "Car A deliberate zero-brake rear ram into Car B (0x Victim Shield)"
                                          : "Car A rear-ended lead Car B without overlap (0x Victim Shield)";
            }
            return v;
        }
    }

    // 3. Side-by-Side Racing Incident: minor door-rub (<8 kJ) = 0x racing; heavy shared contact = 2x each
    if (impact_energy_kj < 8.0) {
        v.reason = "minor side-by-side racing rub (<8 kJ)";
        return v;
    }
    v.incident_a = IncidentKind::SharedContact2x;
    v.incident_b = IncidentKind::SharedContact2x;
    v.points_a = 2;
    v.points_b = 2;
    v.reason = "side-by-side shared racing contact (2x each)";
    return v;
}

IncidentKind RaceControlManager::record_off_track(DriverRaceControlState& st, double now_s, double time_gained_s) {
    if (st.disqualified) return IncidentKind::None;
    st.incident_points += 1;
    st.track_limit_warnings += 1;
    if (time_gained_s > 0.15) {
        st.slowdown_debt_s += std::min(5.0, time_gained_s * 1.5);
        st.slowdown_deadline_s = now_s + 30.0;
    }
    if (st.track_limit_warnings == 3 && st.active_flag == RaceFlag::Green) {
        st.active_flag = RaceFlag::BlackAndWhite;
    } else if (st.track_limit_warnings >= 4 && (st.track_limit_warnings % 2 == 0)) {
        st.post_race_time_penalty_s += 5.0;
    }
    if (st.incident_points >= max_incidents_dsq) {
        st.disqualified = true;
        st.active_flag = RaceFlag::Black;
    }
    return IncidentKind::OffTrack1x;
}

IncidentKind RaceControlManager::record_loss_of_control(DriverRaceControlState& st) {
    if (st.disqualified) return IncidentKind::None;
    st.incident_points += 2;
    if (st.incident_points >= max_incidents_dsq) {
        st.disqualified = true;
        st.active_flag = RaceFlag::Black;
    }
    return IncidentKind::LossOfControl2x;
}

void RaceControlManager::apply_collision_verdict(DriverRaceControlState& a, DriverRaceControlState& b, const CollisionFaultVerdict& v) {
    auto apply_one = [&](DriverRaceControlState& st, IncidentKind kind, int pts, PenaltyType pen) {
        if (st.disqualified) return;
        st.incident_points += pts;
        if (kind == IncidentKind::VictimShield0x) st.victim_shield_count += 1;
        if (pen == PenaltyType::DriveThrough || pen == PenaltyType::StopAndGo10s) {
            if (static_cast<int>(pen) > static_cast<int>(st.pending_pit_penalty)) {
                st.pending_pit_penalty = pen;
                st.penalty_laps_remaining = 3;
            }
        }
        if (st.incident_points >= max_incidents_dsq) {
            st.disqualified = true;
            st.active_flag = RaceFlag::Black;
        }
    };
    apply_one(a, v.incident_a, v.points_a, v.penalty_a);
    apply_one(b, v.incident_b, v.points_b, v.penalty_b);
}

void RaceControlManager::record_yellow_flag_overtake(DriverRaceControlState& st) {
    if (st.disqualified) return;
    if (st.pending_pit_penalty == PenaltyType::None) {
        st.pending_pit_penalty = PenaltyType::DriveThrough;
        st.penalty_laps_remaining = 3;
    }
}

double RaceControlManager::compute_pit_service_seconds(const PitServiceRequest& req, PenaltyType active_penalty) {
    if (active_penalty == PenaltyType::DriveThrough) return 0.0; // drive-through does not stop in box
    if (active_penalty == PenaltyType::StopAndGo10s && req.serve_penalty) return 10.0; // FIA: no service during Stop&Go!
    const double tyre_s = req.change_tyres ? 12.0 : 0.0;
    const double fuel_s = std::max(0.0, req.refuel_liters) * 0.42;
    const double swap_s = req.driver_swap ? 10.0 : 0.0;
    const double repair_s = std::max(0.0, std::min(1.0, req.repair_damage_01)) * 45.0;
    // Tyres & driver swap run concurrently with refueling; structural repairs add on top
    return std::max({tyre_s, fuel_s, swap_s}) + repair_s;
}

void RaceControlManager::tick_driver(
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
    const PitServiceRequest* service_req) {
    if (st.disqualified) {
        st.active_flag = RaceFlag::Black;
        return;
    }

    // 1. Slowdown penalty bleed or escalation
    if (st.slowdown_debt_s > 0.0) {
        if (speed_kmh < 130.0) {
            st.slowdown_debt_s = std::max(0.0, st.slowdown_debt_s - dt_s * 0.85);
        }
        if (st.slowdown_debt_s > 0.05 && now_s > st.slowdown_deadline_s) {
            st.slowdown_debt_s = 0.0;
            if (st.pending_pit_penalty == PenaltyType::None) {
                st.pending_pit_penalty = PenaltyType::DriveThrough;
                st.penalty_laps_remaining = 3;
            }
        }
    }

    // 2. Meatball mechanical flag on severe structural damage (>= 72%)
    if (structural_damage_01 >= 0.72 && !st.meatball_active) {
        st.meatball_active = true;
        st.meatball_laps_remaining = 3;
    }

    // 3. Pit Lane Speed Limiter & Service / Penalty Serving
    const bool entered_pits = in_pit_lane && !st.in_pit_lane;
    const bool exited_pits = !in_pit_lane && st.in_pit_lane;
    if (entered_pits) st.pit_speeding_flagged_this_entry = false;
    st.in_pit_lane = in_pit_lane;
    st.in_pit_box = in_pit_box;

    if (in_pit_lane) {
        const double over_kmh = speed_kmh - (pit_speed_limit_kmh + 1.5);
        if (over_kmh > 0.0 && !st.pit_speeding_flagged_this_entry) {
            st.pit_speeding_flagged_this_entry = true;
            const PenaltyType pen = over_kmh > 20.0 ? PenaltyType::StopAndGo10s : PenaltyType::DriveThrough;
            if (static_cast<int>(pen) > static_cast<int>(st.pending_pit_penalty)) {
                st.pending_pit_penalty = pen;
                st.penalty_laps_remaining = 3;
            }
        }
        if (in_pit_box && speed_kmh < 2.0) {
            if (st.pit_service_remaining_s <= 0.0 && service_req && !st.pit_stop_completed) {
                st.pit_service_remaining_s = compute_pit_service_seconds(*service_req, st.pending_pit_penalty);
            }
            if (st.pit_service_remaining_s > 0.0) {
                st.pit_service_remaining_s = std::max(0.0, st.pit_service_remaining_s - dt_s);
                if (st.pit_service_remaining_s <= 0.0) {
                    st.pit_stop_completed = true;
                    st.pit_stops_served += 1;
                    if (st.pending_pit_penalty == PenaltyType::StopAndGo10s) {
                        st.pending_pit_penalty = PenaltyType::None;
                        st.penalty_laps_remaining = 0;
                    } else if (st.meatball_active && service_req && service_req->repair_damage_01 >= 0.4) {
                        st.meatball_active = false;
                        st.meatball_laps_remaining = 0;
                    }
                }
            }
        }
    } else if (exited_pits) {
        if (st.pending_pit_penalty == PenaltyType::DriveThrough && !st.pit_speeding_flagged_this_entry) {
            st.pending_pit_penalty = PenaltyType::None;
            st.penalty_laps_remaining = 0;
        }
        st.pit_stop_completed = false;
        st.pit_service_remaining_s = 0.0;
    }

    // 4. Active Flag Priority (FIA hierarchy)
    if (st.pending_pit_penalty == PenaltyType::DriveThrough || st.pending_pit_penalty == PenaltyType::StopAndGo10s) {
        st.active_flag = RaceFlag::Black;
    } else if (st.meatball_active) {
        st.active_flag = RaceFlag::Meatball;
    } else if (full_course_yellow) {
        st.active_flag = RaceFlag::FullCourseYellow;
    } else if (sector_yellow) {
        st.active_flag = RaceFlag::LocalYellow;
    } else if (faster_lapping_car_close) {
        st.active_flag = RaceFlag::Blue;
    } else if (st.track_limit_warnings == 3) {
        st.active_flag = RaceFlag::BlackAndWhite;
    } else {
        st.active_flag = RaceFlag::Green;
    }
}

void RaceControlManager::on_lap_completed(DriverRaceControlState& st) {
    if (st.disqualified) return;
    if (st.pending_pit_penalty == PenaltyType::DriveThrough || st.pending_pit_penalty == PenaltyType::StopAndGo10s) {
        if (--st.penalty_laps_remaining <= 0) {
            st.disqualified = true;
            st.active_flag = RaceFlag::Black;
            return;
        }
    }
    if (st.meatball_active) {
        if (--st.meatball_laps_remaining <= 0) {
            st.disqualified = true;
            st.active_flag = RaceFlag::Black;
        }
    }
}

// ---- Endurance Stint & Driver-Swap Tracker ---------------------------------------------------------

void EnduranceStintTracker::register_driver(const std::string& driver_id) {
    for (const auto& d : drivers_) if (d.driver_id == driver_id) return;
    drivers_.push_back(EnduranceDriverStint{driver_id, 0.0, 0});
}

bool EnduranceStintTracker::start_race(const std::string& starting_driver_id) {
    for (auto& d : drivers_) {
        if (d.driver_id == starting_driver_id) {
            active_driver_id_ = starting_driver_id;
            current_stint_s_ = 0.0;
            total_race_s_ = 0.0;
            d.stints_completed = 1;
            return true;
        }
    }
    return false;
}

void EnduranceStintTracker::tick(double dt_s) {
    if (active_driver_id_.empty() || dt_s <= 0.0) return;
    current_stint_s_ += dt_s;
    total_race_s_ += dt_s;
    for (auto& d : drivers_) {
        if (d.driver_id == active_driver_id_) {
            d.total_drive_time_s += dt_s;
            break;
        }
    }
}

bool EnduranceStintTracker::swap_driver_in_pits(const std::string& next_driver_id, bool in_pit_box, double car_speed_kmh) {
    if (!in_pit_box || car_speed_kmh > 2.0 || next_driver_id == active_driver_id_) return false;
    for (auto& d : drivers_) {
        if (d.driver_id == next_driver_id) {
            active_driver_id_ = next_driver_id;
            current_stint_s_ = 0.0;
            d.stints_completed += 1;
            return true;
        }
    }
    return false;
}

bool EnduranceStintTracker::fair_share_satisfied() const {
    if (drivers_.size() <= 1 || total_race_s_ <= 1.0) return true;
    const double equal_share = total_race_s_ / static_cast<double>(drivers_.size());
    const double min_req = equal_share * min_fair_share_fraction;
    for (const auto& d : drivers_) {
        if (d.total_drive_time_s < min_req) return false;
    }
    return true;
}

}  // namespace rs
