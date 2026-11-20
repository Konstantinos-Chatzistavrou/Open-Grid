#include "harness.hpp"
#include "rs/ai.hpp"
#include "rs/config.hpp"
#include "rs/pinnacle.hpp"
#include "rs/route.hpp"

RS_TEST(pinnacle) {
    // 1. Hydroplaning (Aquaplaning Water-Wedge Physics)
    const double speed_mps = 45.0;
    const double pressure_kpa = 220.0;
    const double water_mm = 4.0;

    rs::HydroplaningState fresh = rs::compute_hydroplaning(speed_mps, pressure_kpa, 0.0, water_mm);
    rs::HydroplaningState worn = rs::compute_hydroplaning(speed_mps, pressure_kpa, 0.85, water_mm);

    test::check("hydroplaning: worn tire onset speed < fresh tire onset speed",
                worn.onset_speed_mps < fresh.onset_speed_mps);
    test::check("hydroplaning: worn tire wedge lift > fresh tire wedge lift at 45 m/s",
                worn.wedge_lift_fraction > fresh.wedge_lift_fraction);
    test::check_range("hydroplaning: worn tire FFB aligning torque scale (< 0.65)",
                      worn.ffb_aligning_torque_scale, 0.10, 0.65, "-");
    test::check_range("hydroplaning: worn tire effective load scale",
                      worn.effective_load_scale, 0.10, 0.60, "-");

    // 2. Dynamic Track Groove (Wet drying line & dry rubbering-in)
    rs::DynamicTrackSurface wet_track(2000.0, 3.5, 10.0);
    for (int i = 0; i < 12; ++i) {
        wet_track.record_car_passage(250.0, 0.0, 0.0, 48.0, 0.20);
    }
    double groove_water_mm = wet_track.water_depth_mm_at(250.0, 0.0, 0.0);
    double offline_water_mm = wet_track.water_depth_mm_at(250.0, 3.0, 0.0);

    test::check_range("dynamic track: wet ideal groove water depth (< 2.2 mm)",
                      groove_water_mm, 0.50, 2.20, "mm");
    test::check("dynamic track: wet ideal groove significantly drier than off-line",
                groove_water_mm < offline_water_mm - 1.5);

    rs::DynamicTrackSurface dry_track(2000.0, 0.0, 10.0);
    for (int i = 0; i < 12; ++i) {
        dry_track.record_car_passage(400.0, 0.0, 0.0, 50.0, 0.20);
    }
    double groove_grip = dry_track.grip_multiplier_at(400.0, 0.0, 0.0);
    double offline_grip = dry_track.grip_multiplier_at(400.0, 3.0, 0.0);

    test::check_range("dynamic track: dry rubbered-in ideal groove grip (> 1.015)",
                      groove_grip, 1.015, 1.045, "-");
    test::check("dynamic track: dry ideal groove grip > unrubbered off-line grip",
                groove_grip > offline_grip);

    // 3. Physical Harmonic Engine & Turbo Acoustic Synthesizer State
    rs::EngineAcousticState cp_v8 = rs::compute_engine_acoustics(
        rs::EngineAcousticLayout::CrossPlaneV8, 6200.0, 0.90, 0.0, false, false, 4, 48.0);
    rs::EngineAcousticState fp_v8 = rs::compute_engine_acoustics(
        rs::EngineAcousticLayout::FlatPlaneV8, 6200.0, 0.90, 0.0, false, false, 4, 48.0);
    rs::EngineAcousticState i6 = rs::compute_engine_acoustics(
        rs::EngineAcousticLayout::Inline6, 6800.0, 1.0, 1.25, false, false, 4, 52.0);

    test::check("acoustics: CrossPlaneV8 strong H0.5 rumble vs FlatPlaneV8",
                cp_v8.harmonic_weights[0] > 0.70 && cp_v8.harmonic_weights[0] > fp_v8.harmonic_weights[0] * 5.0);
    test::check("acoustics: Inline6 emphasizes H3.0 metallic wail",
                i6.harmonic_weights[3] > 0.80 && i6.harmonic_weights[3] > cp_v8.harmonic_weights[3] * 2.0);
    test::check_range("acoustics: boosted turbo impeller RPM (> 85,000 RPM)",
                      i6.turbo_impeller_rpm, 85000.0, 155000.0, "rpm");

    rs::EngineAcousticState overrun = rs::compute_engine_acoustics(
        rs::EngineAcousticLayout::Inline6, 6800.0, 0.0, 1.10, true, false, 4, 50.0);
    rs::EngineAcousticState shift_cut = rs::compute_engine_acoustics(
        rs::EngineAcousticLayout::Inline6, 7000.0, 1.0, 1.20, false, true, 4, 52.0);

    test::check_range("acoustics: high-RPM throttle lift overrun pop (> 0.5)",
                      overrun.overrun_pop_intensity, 0.50, 1.00, "-");
    test::check_range("acoustics: flat-shift ignition cut overrun pop (> 0.5)",
                      shift_cut.overrun_pop_intensity, 0.50, 1.00, "-");
    test::check_range("acoustics: BOV venting wastegate surge flutter (28 Hz)",
                      overrun.wastegate_flutter_hz, 27.9, 28.1, "Hz");

    // 4. Proactive AI Racecraft (Slipstream Tuck, Slingshot Pass & Defensive Inside-Apex Blocking)
    const rs::CarConfig cfg = rs::load_car_config(std::string(RS_DATA_DIR) + "/cars/vela_gt.json");
    std::vector<rs::RouteSample> samples = {
        {0.0,   {0, 0, 0},   0.0, 0.0,   6.0, 6.0},
        {100.0, {100, 0, 0}, 0.0, 0.0,   6.0, 6.0},
        {200.0, {200, 0, 0}, 0.0, 0.0,   6.0, 6.0},
        {250.0, {240, 25, 0}, 0.6, 0.02, 6.0, 6.0},
        {300.0, {260, 70, 0}, 1.1, 0.02, 6.0, 6.0},
    };
    rs::Route route = rs::Route::from_samples(samples, false);
    rs::AIParams aip;
    aip.proactive_racecraft = true;
    rs::AIDriver ai(cfg, route, aip);

    rs::ChassisState my_s;
    my_s.position = {30.0, 0.0, 0.5};
    my_s.velocity = {32.0, 0.0, 0.0};
    rs::VehicleOutput last_out;

    // Lead car 26 m ahead at lateral +1.2 m on straight -> AI tucks into slipstream wake
    rs::OtherCar lead_far{{56.0, 1.2, 0.5}, {30.0, 0.0, 0.0}, 4.5, 1.9};
    ai.update(my_s, last_out, {lead_far}, 0.05);
    test::check("AI racecraft: tucks into lead car slipstream wake on straight (16..38 m gap)",
                ai.tucking_slipstream && std::abs(ai.active_lateral_target - 1.2) < 0.35);

    // Lead car 11 m ahead on straight -> AI pulls out laterally for slingshot overtake
    rs::OtherCar lead_close{{41.0, 0.0, 0.5}, {28.0, 0.0, 0.0}, 4.5, 1.9};
    ai.update(my_s, last_out, {lead_close}, 0.05);
    test::check("AI racecraft: pulls out laterally for slingshot overtake when < 16 m behind lead car",
                ai.slingshot_passing && std::abs(ai.active_lateral_target) > 1.5);
}
