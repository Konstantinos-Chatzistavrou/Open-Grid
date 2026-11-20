// Dual-Rating Esports Matchmaking (Driver Rating DR Elo/Glicko-2 + Safety Rating SR
// Corners-Per-Incident & Bad-Sport Rammer Quarantine) and Automated Virtual-Track
// Performance Index (PI 100..999 + Balance of Performance BoP Equalizer).
#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>
#include "rs/config.hpp"
#include "rs/math.hpp"

namespace rs {

// -----------------------------------------------------------------------------
// 1. Dual-Rating Esports Matchmaking (Driver Rating DR + Safety Rating SR)
// -----------------------------------------------------------------------------

enum class DriverGrade : int {
    E = 0,
    D = 1,
    C = 2,
    B = 3,
    A = 4,
    APlus = 5,
    S = 6
};

enum class SafetyGrade : int {
    E_BadSport = 0,
    D = 1,
    C = 2,
    B = 3,
    A = 4,
    S_Clean = 5
};

struct DriverRatingProfile {
    std::string player_id;
    double skill_mmr = 1500.0;          // 800..3200 Glicko/Elo skill rating
    double rating_deviation = 180.0;    // uncertainty RD (shrinks with races down to 45.0)
    double safety_score = 75.0;         // 0..100 (75 = SafetyGrade::B)
    double rolling_cpi = 25.0;          // rolling Corners-Per-Incident
    int clean_corners_streak = 0;
    bool bad_sport_quarantined = false; // true when safety_score < 25.0; requires 15 consecutive clean corners to lift

    DriverGrade driver_grade() const;
    SafetyGrade safety_grade() const;
};

// Evaluates a single corner traverse for safety rating and bad-sport quarantine tracking.
void record_corner_evaluation(DriverRatingProfile& p, bool off_track_cut, double contact_impact_kj);

// Pairwise Elo/Glicko-2 skill rating update across all drivers in finishing order (P1..Pn).
void update_race_ratings(std::vector<DriverRatingProfile>& finishers_in_order);

// Checks whether two drivers can be placed into the same matchmaking split.
// Quarantined rammers are strictly isolated from clean drivers.
bool can_matchmake_pair(const DriverRatingProfile& a, const DriverRatingProfile& b, double max_mmr_gap = 450.0);

// -----------------------------------------------------------------------------
// 2. Automated Virtual-Track Performance Index (PI 100..999) & BoP Equalizer
// -----------------------------------------------------------------------------

enum class PiClass : int {
    D = 0,   // 100..399
    C = 1,   // 400..499
    B = 2,   // 500..599
    A = 3,   // 600..699
    S1 = 4,  // 700..799
    S2 = 5,  // 800..899
    X = 6    // 900..999
};

struct PerformanceIndexReport {
    int pi = 500; // 100..999
    PiClass pi_class = PiClass::B;
    double peak_power_kw = 0.0;
    double power_to_weight_kw_per_t = 0.0;
    double sim_0_to_100_kmh_s = 0.0;
    double sim_100_to_0_braking_m = 0.0;
    double cornering_g_120m = 0.0;
    double top_speed_kmh = 0.0;
    double virtual_benchmark_lap_s = 0.0; // simulated lap time on a standardized 2.4 km benchmark circuit
};

// Evaluates a CarConfig across power, traction-integrated acceleration, Pacejka+aero braking,
// 120 m cornering G at 40 m/s, and aero drag-limited top speed to produce a deterministic PI report.
PerformanceIndexReport compute_performance_index(const CarConfig& cfg);

struct BopAdjustment {
    double ballast_kg = 0.0;              // 0..+200 kg added mass
    double power_restrictor_scale = 1.0;  // 0.65..1.15 engine torque multiplier
    CarConfig balanced_config;
    PerformanceIndexReport balanced_report;
};

// Iteratively adjusts engine torque restrictor multiplier and ballast mass to equalize a car to target_pi.
BopAdjustment compute_bop_equalizer(const CarConfig& cfg, int target_pi);

}  // namespace rs
