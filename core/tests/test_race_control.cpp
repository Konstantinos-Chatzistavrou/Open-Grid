// Apache-2.0 — CTest verification for OpenGrid's FIA/iRacing Race Control, Fault-Aware Telemetry Steward,
// Pit Lane Speed Limiter & Service Rules, and Endurance Team Driver-Swap Manager.
#include "harness.hpp"
#include "rs/race_control.hpp"

RS_TEST(race_control) {
    rs::RaceControlManager rc;

    // 1. Fault-Aware Telemetry Steward: Victim Shield (0x) on rear-end divebomb & unsafe rejoin!
    {
        rs::CarCollisionTelemetry lead{};
        lead.driver_id = "victim";
        lead.pos = {100.0, 0.0, 0.0};
        lead.vel = {30.0, 0.0, 0.0};
        lead.track_s_m = 100.0;
        lead.brake_01 = 0.85;

        rs::CarCollisionTelemetry rammer{};
        rammer.driver_id = "rammer";
        rammer.pos = {95.2, 0.0, 0.0};
        rammer.vel = {44.0, 0.0, 0.0};
        rammer.track_s_m = 95.2;
        rammer.brake_01 = 0.0;
        rammer.throttle_01 = 1.0;

        const auto v = rs::evaluate_collision_fault(lead, rammer, 34.0);
        test::check("deliberate zero-brake rear ram protects victim with 0x Victim Shield",
                    v.incident_a == rs::IncidentKind::VictimShield0x && v.points_a == 0);
        test::check("deliberate zero-brake rear ram gives attacker 4x + StopAndGo10s + protest auto-flag",
                    v.incident_b == rs::IncidentKind::IntentionalRam4x && v.points_b == 4 &&
                    v.penalty_b == rs::PenaltyType::StopAndGo10s && v.auto_flag_protest_b);

        // Unsafe off-track rejoin
        rs::CarCollisionTelemetry clean{};
        clean.driver_id = "clean";
        clean.pos = {200.0, 0.0, 0.0};
        clean.vel = {45.0, 0.0, 0.0};
        rs::CarCollisionTelemetry rejoiner = clean;
        rejoiner.driver_id = "rejoiner";
        rejoiner.rejoining_track = true;
        const auto rv = rs::evaluate_collision_fault(clean, rejoiner, 24.0);
        test::check("unsafe off-track rejoin gives DriveThrough + 4x to rejoiner and 0x to victim",
                    rv.points_a == 0 && rv.incident_a == rs::IncidentKind::VictimShield0x &&
                    rv.points_b == 4 && rv.penalty_b == rs::PenaltyType::DriveThrough);

        // Side-by-side minor door rub (<8 kJ) = 0x racing
        rs::CarCollisionTelemetry sideA = clean, sideB = clean;
        sideB.pos = {200.5, 1.9, 0.0};
        sideB.track_s_m = 200.5;
        const auto sv = rs::evaluate_collision_fault(sideA, sideB, 5.5);
        test::check("minor side-by-side racing door rub (<8 kJ) incurs 0x for both drivers",
                    sv.points_a == 0 && sv.points_b == 0);
    }

    // 2. Track Limits, Slowdowns, Meatball Flag, Pit Speeding & Penalty Serving
    {
        rs::DriverRaceControlState st{};
        st.driver_id = "driver1";
        rc.record_off_track(st, 10.0, 0.0);
        rc.record_off_track(st, 20.0, 0.0);
        rc.record_off_track(st, 30.0, 0.40);
        test::check("3rd track limit cut raises Black-and-White flag and adds slowdown debt",
                    st.active_flag == rs::RaceFlag::BlackAndWhite && st.slowdown_debt_s > 0.5);

        // Pit lane speeding (+12 km/h over 80 km/h limit -> DriveThrough -> Black flag)
        rc.tick_driver(st, 35.0, 0.1, 94.0, 0.10, false, false, false, true, false);
        test::check("pit lane speeding issues DriveThrough and raises Black flag",
                    st.pending_pit_penalty == rs::PenaltyType::DriveThrough && st.active_flag == rs::RaceFlag::Black);

        // Exit pit cleanly on next lap to serve DriveThrough
        rc.tick_driver(st, 40.0, 0.1, 75.0, 0.10, false, false, false, false, false);
        rc.tick_driver(st, 60.0, 0.1, 76.0, 0.10, false, false, false, true, false);
        rc.tick_driver(st, 65.0, 0.1, 76.0, 0.10, false, false, false, false, false);
        test::check("clean Drive-Through pass clears Black flag",
                    st.pending_pit_penalty == rs::PenaltyType::None);

        // Severe structural damage (>= 72%) raises Meatball flag; pit repair clears it
        rs::PitServiceRequest req{};
        req.change_tyres = true;
        req.refuel_liters = 20.0;
        req.repair_damage_01 = 0.80;
        rc.tick_driver(st, 70.0, 0.1, 140.0, 0.78, false, false, false, false, false);
        test::check("severe structural damage (>=72%) raises Meatball mechanical flag",
                    st.meatball_active && st.active_flag == rs::RaceFlag::Meatball);
        const double svc = rs::RaceControlManager::compute_pit_service_seconds(req, rs::PenaltyType::None);
        test::check_range("pit service time (tyres + 20L + 80% repair)", svc, 40.0, 60.0, "s");
        rc.tick_driver(st, 75.0, svc + 0.5, 0.0, 0.78, false, false, false, true, true, &req);
        test::check("pit box repair clears Meatball flag", !st.meatball_active && st.pit_stops_served == 1);
    }

    // 3. Endurance Team Live Driver-Swap & Fair-Share Compliance
    {
        rs::EnduranceStintTracker end{};
        end.team_id = "team_opengrid";
        end.register_driver("alice");
        end.register_driver("bob");
        test::check("endurance race starts with alice", end.start_race("alice"));
        end.tick(1800.0); // 30 min stint
        test::check("cannot swap driver while moving on track", !end.swap_driver_in_pits("bob", false, 180.0));
        test::check("fair share not satisfied before bob drives", !end.fair_share_satisfied());
        test::check("live driver swap succeeds when stopped in pit box", end.swap_driver_in_pits("bob", true, 0.0));
        end.tick(1800.0);
        test::check("fair share satisfied after equal stints",
                    end.active_driver() == "bob" && end.fair_share_satisfied() && end.total_team_seconds() > 3599.0);
    }
}
