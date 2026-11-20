// Unit tests for C++ Gameplay Systems (WorldClock/Weather, Spontaneous 1v1 Wagers, Speed Traps/Drift Zones, Insurance/Tow/Penalties).
#include <cmath>
#include "harness.hpp"
#include "rs/gameplay.hpp"

RS_TEST(gameplay) {
    using namespace rs;

    // 1. World Clock (1:4 compression), Night Traffic Density & Rain/Season Grip
    {
        WorldEnvironmentState env;
        env.game_seconds = 23.0 * 3600.0; // 23:00 night
        test::check("night shift (23:00) has low realistic street traffic density", env.traffic_density() < 0.45);
        env.game_seconds = 8.0 * 3600.0;  // 08:00 morning rush
        test::check("morning rush (08:00) has full traffic density", env.traffic_density() > 0.95);

        env.season = Season::Summer;
        env.wetness = 0.25;
        const double dry_summer = env.surface_grip_multiplier();
        env.season = Season::Winter;
        env.wetness = 0.95;
        const double wet_winter = env.surface_grip_multiplier();
        test::check("wet winter surface grip is lower than dry summer grip", wet_winter < dry_summer - 0.15);

        const double t0 = env.game_seconds;
        env.tick(10.0); // 10 real seconds = 40 game seconds
        test::check("1:4 world clock advances 40 game seconds per 10 real seconds",
                    std::fabs(env.game_seconds - (t0 + 40.0)) < 1e-6);
    }

    // 2. Spontaneous Headlight-Flash 1v1 Wager & Anti-Save-Scumming Disconnect Forfeit
    {
        SpontaneousWagerState w;
        bool ok = w.try_flash_challenge({0, 0, 0}, 5.0, {6, 2, 0}, 4.0, {1, 0, 0}, "rival_1", "kestrel", WagerStakes::PinkSlip, 2500);
        test::check("headlight flash within 18m at low speed triggers challenge", ok && w.phase == WagerPhase::Challenged);
        w.accept_challenge();
        w.tick({0, 0, 0}, {0, 2, 0}, 3.1); // finish countdown
        test::check("wager enters Racing phase after 3s countdown", w.phase == WagerPhase::Racing);
        w.on_opponent_disconnect();
        test::check("opponent disconnect mid-wager awards automatic forfeit win (anti-save-scumming)",
                    w.phase == WagerPhase::Finished && w.player_won && w.opponent_disconnected_forfeit);
    }

    // 3. Speed Trap & Drift Zone (with Wall-Impact Voiding)
    {
        CityZoneSpec drift_spec{"dz_chinatown", ZoneKind::DriftZone, {0, 0, 0}, {100, 0, 0}, 15.0, 2500.0};
        ActiveZoneRun run;
        run.start(drift_spec);
        run.tick(drift_spec, {50, 0, 0}, 24.0, 0.45, 0.0, 2.0); // 86.4 km/h, ~25.7 deg drift angle
        test::check("drift zone accumulates drift points at speed and slip angle", run.drift_points > 500.0);
        run.tick(drift_spec, {100, 0, 0}, 24.0, 0.45, 14.0, 0.5); // 14 kJ wall hit at finish gate
        test::check("heavy wall impact (> 8 kJ) voids drift zone score", run.completed && run.voided_by_crash && run.final_score == 0.0);
    }

    // 4. Pre-Race Insurance (-50%), Tow Truck Fee & Steward Time Penalties (+5.0 s)
    {
        CarMaintenanceState m_uninsured{1.0, true, false};
        CarMaintenanceState m_insured{1.0, true, true};
        RepairQuote q_un = compute_repair_and_tow_quote(m_uninsured);
        RepairQuote q_in = compute_repair_and_tow_quote(m_insured);
        test::check("pre-race insurance cuts repair bill and tow truck fee by 50%",
                    q_in.repair_cost_xp == q_un.repair_cost_xp / 2 && q_in.tow_fee_xp == q_un.tow_fee_xp / 2);

        StewardPenaltySystem stewards;
        bool p1 = stewards.record_incident(10.0, 28.0, false, 5.0);
        bool p2 = stewards.record_incident(11.0, 30.0, false, 5.0); // debounced (< 4.5 s)
        test::check("steward penalty adds +5.0s on >22 kJ impact and debounces multi-contact frames",
                    p1 && !p2 && std::fabs(stewards.total_penalty_s - 5.0) < 1e-6);
    }
}
