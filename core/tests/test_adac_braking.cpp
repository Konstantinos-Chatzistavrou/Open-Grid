// Layer 1 validation: ADAC Summer Tyre Test & EU EPREL / UNECE Regulation No. 117 Wet & Dry Braking.
//
// Published benchmarks & regulatory standards:
//
//   1. ADAC Summer Tyre Test 2025 — 225/40 R18 on VW Golf (18 summer tyres):
//      https://www.adac.de/rund-ums-fahrzeug/ausstattung-technik-zubehoer/reifen/reifentest/sommerreifen/225-40-r18
//      - Dry 100-0 km/h ABS: best premium 35.2 m (Continental SportContact 7; Toyo Proxes Sport 2 35.4 m)
//                            vs worst budget 39.5 m (Doublecoin DC-100; +4.3 m / 1.12x)
//      - Wet 80-0 km/h ABS (asphalt): best premium 28.4 m (Continental SportContact 7)
//                                     vs worst budget 45.1 m (Doublecoin DC-100; +16.7 m / 1.59x)
//      - Straight-line aquaplaning (7-8 mm standing water): best 83.7 km/h (Kumho Ecsta PS71)
//
//   2. ADAC Summer Tyre Test 2024 — 215/55 R17 on VW T-Roc (16 summer tyres):
//      https://www.adac.de/rund-ums-fahrzeug/ausstattung-technik-zubehoer/reifen/reifentest/sommerreifen/215-55-r17
//      - Dry 100-0 km/h ABS: best 35.4 m (Continental PremiumContact 7)
//      - Wet 80-0 km/h ABS:  best 28.5 m (Continental PremiumContact 7)
//      - Straight-line aquaplaning (7-8 mm standing water): up to 78.5 km/h (Bridgestone Turanza 6; field ~70-79 km/h)
//
//   3. EU Tyre Labelling Regulation (EU) 2020/740, Annex I Part B (Class C1 passenger car tyres):
//      https://eur-lex.europa.eu/eli/reg/2020/740/oj
//      Wet grip index G = G(T) - 0.03 measured per UNECE Regulation No. 117 Annex 5 vs SRTT:
//      - Class A: G >= 1.55
//      - Class B: 1.40 <= G <= 1.54
//      - Class C: 1.25 <= G <= 1.39
//      - Class D: 1.10 <= G <= 1.24
//      - Class E: G <= 1.09
//      Published EU label impact at 80-0 km/h wet: Class A vs Class E = up to ~18 m shorter stopping distance
//      (~1.42x wet grip index spread from G = 1.55 to G = 1.09).
//
//   4. UNECE Regulation No. 117, Annex 5 (Vehicle Method, Class C1 passenger tyres, E/ECE/324/Rev.2/Add.116):
//      https://unece.org/transport/vehicle-regulations-wp29/standards/addenda-1958-agreement-regulations-101-120
//      - Wet asphalt track with 0.5-1.5 mm water film (nominal 1.0 mm), ABS braking from 80 -> 20 km/h
//        for Mean Fully Developed Deceleration (MFDD) / wet grip index G(T).
//
//   5. Continental / Auto Bild Tread-Depth Wet Braking (80-0 km/h ABS, VW Golf):
//      - New (~7.5-8 mm): 25.8 m; 3.0 mm (ADAC summer replacement limit): 31.0 m (1.202x);
//        1.6 mm (EU legal minimum): 36.2 m (1.403x).
//
// Test vehicle: Vela GT (data/cars/vela_gt.json, 1450 kg, PAC2002 road tyres) with ABS enabled.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include "harness.hpp"
#include "rs/pinnacle.hpp"

using namespace rs;

namespace {

struct BrakeResult {
    double dist_m = 0.0;        // full stop distance from v_start_kmh to 0.3 m/s (m)
    double mfdd_80_20 = 0.0;    // UNECE R117 80 -> 20 km/h mean fully developed deceleration (m/s^2)
    double dist_80_20_m = 0.0;  // distance covered strictly between 80 km/h and 20 km/h (m)
};

// Return a copy of cfg with front & rear compound peak friction scaled by mu_scale.
CarConfig with_compound_mu(const CarConfig& base, double mu_scale) {
    CarConfig c = base;
    c.tire_front.mu_x *= mu_scale;
    c.tire_front.mu_y *= mu_scale;
    c.tire_rear.mu_x *= mu_scale;
    c.tire_rear.mu_y *= mu_scale;
    return c;
}

// Run a straight-line ABS panic stop from v_start_kmh with a realistic 0.2 s hydraulic/pedal ramp.
// Captures both full stopping distance and UNECE R117 80 -> 20 km/h MFDD when v_start_kmh >= 80.
BrakeResult run_abs_stop(const CarConfig& cfg, double v_start_kmh, double water_mm, double wear) {
    auto s = test::make_sim(cfg);
    s->reset({}, 0.0, v_start_kmh / 3.6, 4);
    s->vehicle.set_tyres(cfg.tire_front.start_c, wear);
    s->vehicle.road_water_mm = water_mm;
    s->vehicle.assists().abs = true;

    const double x0 = s->body.state.position.x;
    constexpr double kV80 = 80.0 / 3.6;
    constexpr double kV20 = 20.0 / 3.6;
    double x_80 = -1.0, v_80 = 0.0;
    double x_20 = -1.0, v_20 = 0.0;

    while (test::speed(*s) > 0.3 && s->time < 25.0) {
        DriverInput in;
        in.gear = 1;
        in.clutch = 1.0;
        in.brake = std::min(1.0, s->time / 0.2);
        s->step(in);

        const double v = test::speed(*s);
        const double x = s->body.state.position.x;
        if (x_80 < 0.0 && v <= kV80 && s->time >= 0.2) {
            x_80 = x;
            v_80 = v;
        }
        if (x_80 >= 0.0 && x_20 < 0.0 && v <= kV20) {
            x_20 = x;
            v_20 = v;
        }
    }

    BrakeResult r;
    r.dist_m = s->body.state.position.x - x0;
    if (x_80 >= 0.0 && x_20 > x_80) {
        r.dist_80_20_m = x_20 - x_80;
        r.mfdd_80_20 = (v_80 * v_80 - v_20 * v_20) / (2.0 * r.dist_80_20_m);
    }
    return r;
}

// Convert remaining tread depth (mm) to OpenGrid wear [0..1] (7.5 mm new -> 1.2 mm at wear = 1.0).
double wear_for_tread_mm(double tread_mm) {
    return clamp((7.5 - tread_mm) / (7.5 - 1.2), 0.0, 1.0);
}

// Bisect the speed (km/h) at which wet_grip_factor drops below target_factor on deep standing water.
double find_aquaplaning_speed_kmh(double pressure_kpa, double wear, double water_mm, double target_factor) {
    double lo = 10.0, hi = 240.0;
    for (int i = 0; i < 40; ++i) {
        const double mid = 0.5 * (lo + hi);
        if (wet_grip_factor(mid / 3.6, pressure_kpa, wear, water_mm) > target_factor) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return 0.5 * (lo + hi);
}

}  // namespace

RS_TEST(adac_braking) {
    const CarConfig base = test::car();  // Vela GT (PAC2002 road summer tyre, p_nominal = 220 kPa)

    // ------------------------------------------------------------------ 1. Dry 100-0 km/h ABS braking (ADAC)
    // Premium summer tyre (baseline Vela GT road compound) vs lower-mu hard budget summer compound (0.88x dry mu,
    // matching ADAC 2025 225/40 R18 best 35.2 m Conti SportContact 7 vs worst 39.5 m Doublecoin DC-100).
    const BrakeResult dry_premium = run_abs_stop(base, 100.0, 0.0, 0.0);
    const BrakeResult dry_budget = run_abs_stop(with_compound_mu(base, 0.88), 100.0, 0.0, 0.0);
    const double dry_spread_m = dry_budget.dist_m - dry_premium.dist_m;
    std::printf("         [1] Dry 100-0 km/h ABS: premium %.2f m, budget (0.88x mu) %.2f m (spread +%.2f m / %.3fx; "
                "ADAC 2025: 35.2-39.5 m, +4.3 m)\n",
                dry_premium.dist_m, dry_budget.dist_m, dry_spread_m, dry_budget.dist_m / dry_premium.dist_m);

    test::check_range("dry 100-0 km/h ABS, premium summer [ADAC 35.2-37.5 m]", dry_premium.dist_m, 34.0, 40.0, "m");
    test::check_range("dry 100-0 km/h ABS, budget summer  [ADAC ~39.5 m]", dry_budget.dist_m, 38.0, 45.0, "m");
    test::check("dry 100-0 km/h: budget tyre stops later than premium summer", dry_budget.dist_m > dry_premium.dist_m + 2.5);

    // ------------------------------------------------------------------ 2. Wet 80-0 km/h ABS across EU Label classes
    // UNECE R117 Annex 5: 1.0 mm water film (0.5-1.5 mm spec), ABS braking from 80 km/h.
    // Representative Regulation (EU) 2020/740 Annex I Part B C1 wet grip indices G:
    //   Class A (G >= 1.55): G_A = 1.58 -> scale 1.000
    //   Class C (1.25-1.39): G_C = 1.32 -> scale 1.32 / 1.58 = 0.835
    //   Class E (G <= 1.09): G_E = 1.05 -> scale 1.05 / 1.58 = 0.665
    constexpr double kGClassA = 1.58;
    constexpr double kGClassC = 1.32;
    constexpr double kGClassE = 1.05;
    const BrakeResult wet_class_a = run_abs_stop(with_compound_mu(base, 1.0), 80.0, 1.0, 0.0);
    const BrakeResult wet_class_c = run_abs_stop(with_compound_mu(base, kGClassC / kGClassA), 80.0, 1.0, 0.0);
    const BrakeResult wet_class_e = run_abs_stop(with_compound_mu(base, kGClassE / kGClassA), 80.0, 1.0, 0.0);
    const double eu_spread_m = wet_class_e.dist_m - wet_class_a.dist_m;
    const double eu_spread_ratio = wet_class_e.dist_m / wet_class_a.dist_m;
    const double mfdd_ratio_a_e = wet_class_a.mfdd_80_20 / std::max(wet_class_e.mfdd_80_20, 1e-6);

    std::printf("         [2] Wet 80-0 km/h ABS (1.0 mm UNECE R117 film):\n"
                "             Class A (G=1.58): %.2f m (MFDD 80-20: %.2f m/s^2) [ADAC 2025 best 28.4 m / 2024 28.5 m]\n"
                "             Class C (G=1.32): %.2f m (MFDD 80-20: %.2f m/s^2)\n"
                "             Class E (G=1.05): %.2f m (MFDD 80-20: %.2f m/s^2) [ADAC 2025 worst 45.1 m]\n"
                "             Spread E vs A: +%.2f m (%.3fx; EU 2020/740 up to ~18 m / ~1.42x), MFDD A/E = %.3fx (G_A/G_E = %.3fx)\n",
                wet_class_a.dist_m, wet_class_a.mfdd_80_20,
                wet_class_c.dist_m, wet_class_c.mfdd_80_20,
                wet_class_e.dist_m, wet_class_e.mfdd_80_20,
                eu_spread_m, eu_spread_ratio, mfdd_ratio_a_e, kGClassA / kGClassE);

    test::check_range("wet 80-0 km/h ABS, Class A (1 mm) [ADAC 28.4-28.5 m]", wet_class_a.dist_m, 26.0, 31.0, "m");
    test::check_range("wet 80-0 km/h ABS, Class C (1 mm) [mid-tier]", wet_class_c.dist_m, 29.0, 36.0, "m");
    test::check_range("wet 80-0 km/h ABS, Class E (1 mm) [budget/ADAC worst]", wet_class_e.dist_m, 36.0, 44.0, "m");
    test::check("wet 80-0 km/h monotonic ordering: Class A < Class C < Class E",
                wet_class_a.dist_m < wet_class_c.dist_m && wet_class_c.dist_m < wet_class_e.dist_m);
    test::check_range("wet 80-0 km/h Class E - Class A spread [EU 10-18 m]", eu_spread_m, 10.0, 18.0, "m");
    test::check_range("wet 80-0 km/h Class E / Class A ratio  [R117 ~1.4x]", eu_spread_ratio, 1.32, 1.58, "x");
    test::check_range("UNECE R117 80-20 km/h MFDD ratio A/E   [G_A/G_E 1.50]", mfdd_ratio_a_e, 1.35, 1.65, "x");

    // ------------------------------------------------------------------ 3. Wet 100-0 vs Dry 100-0 ratio (Layer 1 #7)
    // Measures 100-0 km/h ABS stops on dry vs 1.0 mm wet film for new (7.5 mm), ADAC 3.0 mm, and legal 1.6 mm tread.
    const double wear_3mm = wear_for_tread_mm(3.0);
    const double wear_16mm = wear_for_tread_mm(1.6);
    const BrakeResult wet100_new = run_abs_stop(base, 100.0, 1.0, 0.0);
    const BrakeResult wet100_3mm = run_abs_stop(base, 100.0, 1.0, wear_3mm);
    const BrakeResult wet100_16mm = run_abs_stop(base, 100.0, 1.0, wear_16mm);
    const double ratio_wet_dry_new = wet100_new.dist_m / dry_premium.dist_m;
    const double ratio_wet_dry_3mm = wet100_3mm.dist_m / dry_premium.dist_m;
    const double ratio_wet_dry_16mm = wet100_16mm.dist_m / dry_premium.dist_m;

    std::printf("         [3] 100-0 km/h ABS (dry vs 1.0 mm wet): dry %.2f m | wet new %.2f m (%.3fx) | "
                "wet 3 mm %.2f m (%.3fx) | wet 1.6 mm %.2f m (%.3fx)\n",
                dry_premium.dist_m,
                wet100_new.dist_m, ratio_wet_dry_new,
                wet100_3mm.dist_m, ratio_wet_dry_3mm,
                wet100_16mm.dist_m, ratio_wet_dry_16mm);

    test::check_range("100-0 km/h wet/dry ratio, new tyres (1 mm) [1.12-1.35x]", ratio_wet_dry_new, 1.12, 1.35, "x");
    test::check_range("100-0 km/h wet/dry ratio, 3 mm tread (1 mm)", ratio_wet_dry_3mm, 1.28, 1.65, "x");
    test::check("100-0 km/h wet stopping grows with tread wear: new < 3 mm < 1.6 mm",
                wet100_new.dist_m < wet100_3mm.dist_m && wet100_3mm.dist_m < wet100_16mm.dist_m);

    // ------------------------------------------------------------------ 4. Deep-water aquaplaning onset (7 mm ADAC)
    // ADAC straight-line aquaplaning test uses 7-8 mm standing water; summer tyres float around ~75-88 km/h
    // (ADAC 2024 215/55 R17 up to 78.5 km/h; ADAC 2025 225/40 R18 best 83.7 km/h).
    constexpr double kDeepWaterMm = 7.0;
    const double p_kpa = base.tire_front.p_nominal_kpa;  // 220 kPa nominal road pressure
    const double grip_50 = wet_grip_factor(50.0 / 3.6, p_kpa, 0.0, kDeepWaterMm);
    const double grip_85 = wet_grip_factor(85.0 / 3.6, p_kpa, 0.0, kDeepWaterMm);
    const double grip_95 = wet_grip_factor(95.0 / 3.6, p_kpa, 0.0, kDeepWaterMm);

    // Effective straight-line float speed where wet_grip_factor falls to 1/3 of dry friction (67% grip loss).
    const double float_new_kmh = find_aquaplaning_speed_kmh(p_kpa, 0.0, kDeepWaterMm, 0.33);
    const double float_3mm_kmh = find_aquaplaning_speed_kmh(p_kpa, wear_3mm, kDeepWaterMm, 0.33);
    const double float_16mm_kmh = find_aquaplaning_speed_kmh(p_kpa, wear_16mm, kDeepWaterMm, 0.33);

    // Full hydrodynamic water-wedge lift onset speeds from Horne's NASA equation (compute_hydroplaning).
    const HydroplaningState hp_new = compute_hydroplaning(130.0 / 3.6, p_kpa, 0.0, kDeepWaterMm);
    const HydroplaningState hp_3mm = compute_hydroplaning(130.0 / 3.6, p_kpa, wear_3mm, kDeepWaterMm);
    const HydroplaningState hp_16mm = compute_hydroplaning(130.0 / 3.6, p_kpa, wear_16mm, kDeepWaterMm);

    // End-to-end Vehicle ABS stop on 7 mm standing water vs 1 mm wet film from 90 km/h.
    const BrakeResult wet90_1mm = run_abs_stop(base, 90.0, 1.0, 0.0);
    const BrakeResult wet90_7mm = run_abs_stop(base, 90.0, kDeepWaterMm, 0.0);

    std::printf("         [4] Deep-water aquaplaning (7.0 mm, %.0f kPa):\n"
                "             new tread wet_grip_factor: 50 km/h %.3f | 85 km/h %.3f | 95 km/h %.3f\n"
                "             effective float speed (grip <= 0.33): new %.1f km/h [ADAC 75-88 km/h] | "
                "3 mm %.1f km/h | 1.6 mm %.1f km/h\n"
                "             NASA wedge-lift onset: new %.1f km/h | 3 mm %.1f km/h (lift@130=%.2f) | "
                "1.6 mm %.1f km/h (lift@130=%.2f)\n"
                "             90-0 km/h ABS stop: 1 mm wet %.2f m vs 7 mm standing water %.2f m (%.2fx)\n",
                p_kpa, grip_50, grip_85, grip_95,
                float_new_kmh, float_3mm_kmh, float_16mm_kmh,
                hp_new.onset_speed_mps * 3.6,
                hp_3mm.onset_speed_mps * 3.6, hp_3mm.wedge_lift_fraction,
                hp_16mm.onset_speed_mps * 3.6, hp_16mm.wedge_lift_fraction,
                wet90_1mm.dist_m, wet90_7mm.dist_m, wet90_7mm.dist_m / wet90_1mm.dist_m);

    test::check_range("7 mm water, new tyre grip retained at 50 km/h", grip_50, 0.50, 0.75, "-");
    test::check("7 mm water, new tyre loses grip sharply by 85-95 km/h", grip_85 < 0.35 && grip_95 < 0.30);
    test::check_range("7 mm straight-line float speed, new tyre [ADAC 75-88 km/h]", float_new_kmh, 74.0, 90.0, "km/h");
    test::check("7 mm float speed drops sharply with wear: 1.6 mm < 3 mm < new",
                float_16mm_kmh < float_3mm_kmh - 5.0 && float_3mm_kmh < float_new_kmh - 20.0);
    test::check("7 mm NASA wedge-lift onset drops with wear: 1.6 mm < 3 mm < new",
                hp_16mm.onset_speed_mps < hp_3mm.onset_speed_mps && hp_3mm.onset_speed_mps < hp_new.onset_speed_mps);
    test::check("7 mm standing water extends 90-0 km/h ABS stop significantly vs 1 mm wet",
                wet90_7mm.dist_m > wet90_1mm.dist_m * 1.40);
}
