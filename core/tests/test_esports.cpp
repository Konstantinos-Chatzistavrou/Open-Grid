// Unit tests for Dual-Rating Esports Matchmaking (DR + SR & Rammer Quarantine)
// and Automated Virtual-Track Performance Index (PI 100..999 & BoP Equalizer).
#include <cmath>
#include <vector>
#include "harness.hpp"
#include "rs/esports.hpp"

RS_TEST(esports) {
    // 1. update_race_ratings: P1 gains MMR and P2 loses MMR; beating a higher-rated
    // opponent yields a larger MMR gain than beating a lower-rated opponent.
    {
        rs::DriverRatingProfile p1;
        p1.player_id = "driver_alpha";
        p1.skill_mmr = 1500.0;
        p1.rating_deviation = 150.0;

        rs::DriverRatingProfile p2;
        p2.player_id = "driver_beta";
        p2.skill_mmr = 1500.0;
        p2.rating_deviation = 150.0;

        std::vector<rs::DriverRatingProfile> equal_race = {p1, p2};
        rs::update_race_ratings(equal_race);

        test::check("P1 gains skill MMR after winning race", equal_race[0].skill_mmr > 1500.0);
        test::check("P2 loses skill MMR after losing race", equal_race[1].skill_mmr < 1500.0);
        test::check("rating deviation shrinks after race completion", equal_race[0].rating_deviation < 150.0);

        // Compare MMR gain when beating a higher-rated opponent vs a lower-rated opponent
        rs::DriverRatingProfile hero_vs_high = p1;
        rs::DriverRatingProfile high_opp = p2;
        high_opp.skill_mmr = 1850.0;
        std::vector<rs::DriverRatingProfile> upset_race = {hero_vs_high, high_opp};
        rs::update_race_ratings(upset_race);
        const double gain_vs_higher = upset_race[0].skill_mmr - 1500.0;

        rs::DriverRatingProfile hero_vs_low = p1;
        rs::DriverRatingProfile low_opp = p2;
        low_opp.skill_mmr = 1150.0;
        std::vector<rs::DriverRatingProfile> expected_race = {hero_vs_low, low_opp};
        rs::update_race_ratings(expected_race);
        const double gain_vs_lower = expected_race[0].skill_mmr - 1500.0;

        test::check("beating higher-rated opponent yields larger MMR gain than lower-rated",
                    gain_vs_higher > gain_vs_lower);
    }

    // 2. record_corner_evaluation & Rammer Quarantine: repeated heavy ramming (> 25 kJ)
    // drops safety_score < 25.0, sets bad_sport_quarantined = true, and blocks matchmaking
    // with clean drivers; completing 15 consecutive clean corners lifts bad_sport_quarantined.
    {
        rs::DriverRatingProfile clean_driver;
        clean_driver.player_id = "clean_racer";
        clean_driver.skill_mmr = 1550.0;
        clean_driver.safety_score = 82.0;

        rs::DriverRatingProfile rammer;
        rammer.player_id = "serial_rammer";
        rammer.skill_mmr = 1520.0;
        rammer.safety_score = 75.0;

        test::check("initially clean drivers can matchmake together",
                    rs::can_matchmake_pair(clean_driver, rammer));

        // 9 heavy ramming incidents at 28 kJ (-7.0 safety score each: 75.0 -> 12.0 < 25.0)
        for (int i = 0; i < 9; ++i) {
            rs::record_corner_evaluation(rammer, false, 28.0);
        }

        test::check_range("rammer safety score drops below 25.0", rammer.safety_score, 0.0, 24.9, "pts");
        test::check("rammer placed into bad-sport quarantine", rammer.bad_sport_quarantined);
        test::check("rammer safety grade is E_BadSport",
                    rammer.safety_grade() == rs::SafetyGrade::E_BadSport);
        test::check("quarantined rammer blocked from matchmaking with clean driver",
                    !rs::can_matchmake_pair(clean_driver, rammer));

        // 14 clean corners should not yet lift quarantine
        for (int i = 0; i < 14; ++i) {
            rs::record_corner_evaluation(rammer, false, 0.0);
        }
        test::check("quarantine remains active at 14 clean corners", rammer.bad_sport_quarantined);

        // 15th consecutive clean corner lifts bad_sport_quarantined
        rs::record_corner_evaluation(rammer, false, 0.0);
        test::check("15 consecutive clean corners lifts bad-sport quarantine",
                    !rammer.bad_sport_quarantined);
        test::check_range("clean corner streak reaches 15",
                          static_cast<double>(rammer.clean_corners_streak), 15.0, 15.0, "corners");
    }

    // 3. compute_performance_index: a lighter car with higher grip/downforce gets a faster
    // virtual_benchmark_lap_s and higher pi than a heavier, lower-grip car with the same horsepower.
    {
        rs::CarConfig heavy_low_grip = test::car();
        heavy_low_grip.mass = 1650.0;
        heavy_low_grip.tire_front.mu_x = 1.10;
        heavy_low_grip.tire_front.mu_y = 1.10;
        heavy_low_grip.tire_rear.mu_x = 1.12;
        heavy_low_grip.tire_rear.mu_y = 1.12;
        heavy_low_grip.aero.lift_area = 0.10;

        rs::CarConfig light_high_grip = test::car();
        light_high_grip.mass = 1220.0;
        light_high_grip.tire_front.mu_x = 1.45;
        light_high_grip.tire_front.mu_y = 1.48;
        light_high_grip.tire_rear.mu_x = 1.48;
        light_high_grip.tire_rear.mu_y = 1.52;
        light_high_grip.aero.lift_area = 0.95;

        const rs::PerformanceIndexReport rep_heavy = rs::compute_performance_index(heavy_low_grip);
        const rs::PerformanceIndexReport rep_light = rs::compute_performance_index(light_high_grip);

        test::check("identical engine configs produce equal peak power kW",
                    std::abs(rep_heavy.peak_power_kw - rep_light.peak_power_kw) < 1e-6);
        test::check("lighter high-grip/aero car achieves higher 120m cornering G",
                    rep_light.cornering_g_120m > rep_heavy.cornering_g_120m);
        test::check("lighter high-grip/aero car achieves shorter 100-0 braking distance",
                    rep_light.sim_100_to_0_braking_m < rep_heavy.sim_100_to_0_braking_m);
        test::check("lighter high-grip/aero car achieves faster virtual benchmark lap",
                    rep_light.virtual_benchmark_lap_s < rep_heavy.virtual_benchmark_lap_s);
        test::check("lighter high-grip/aero car receives higher PI rating",
                    rep_light.pi > rep_heavy.pi);
    }

    // 4. compute_bop_equalizer: equalizing two different car configs to target_pi = 650
    // (top of Class A) brings their balanced_report.pi to 650 +- 2 and their
    // virtual_benchmark_lap_s within 0.15 s.
    {
        rs::CarConfig track_coupe = test::car();
        track_coupe.mass = 1320.0;
        track_coupe.aero.lift_area = 0.55;
        track_coupe.tire_front.mu_y = 1.34;
        track_coupe.tire_rear.mu_y = 1.37;

        rs::CarConfig grand_tourer = test::car();
        grand_tourer.mass = 1485.0;
        grand_tourer.aero.lift_area = 0.28;

        const rs::BopAdjustment bop_coupe = rs::compute_bop_equalizer(track_coupe, 650);
        const rs::BopAdjustment bop_gt = rs::compute_bop_equalizer(grand_tourer, 650);

        test::check_range("BoP track coupe balanced PI at target 650 +- 2",
                          static_cast<double>(bop_coupe.balanced_report.pi), 648.0, 652.0, "PI");
        test::check_range("BoP grand tourer balanced PI at target 650 +- 2",
                          static_cast<double>(bop_gt.balanced_report.pi), 648.0, 652.0, "PI");

        const double lap_diff_s = std::abs(bop_coupe.balanced_report.virtual_benchmark_lap_s -
                                           bop_gt.balanced_report.virtual_benchmark_lap_s);
        test::check_range("BoP equalized virtual benchmark lap times within 0.15 s",
                          lap_diff_s, 0.0, 0.15, "s");
    }
}
