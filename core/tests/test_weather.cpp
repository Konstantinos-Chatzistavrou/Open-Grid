// Apache-2.0 — Tests for OpenGrid Dynamic Weather v2:
// Mesoscale frontal bands, veering wind, solar-thermal persistent asphalt memory, sub-meter curvilinear
// track 2D shallow-water hydrology, rubber-line wet-grip inversion ("the rain line"), wet painted-kerb
// ice slip, slick vs intermediate vs full-wet tyre physics, asymmetric puddle-drag yaw pull,
// and wind-advected volumetric trailing spray visibility.
#include "harness.hpp"
#include "rs/pinnacle.hpp"
#include "rs/weather.hpp"
#include <cmath>
#include <cstdio>
#include <vector>

using namespace rs;

static std::vector<TrackWeatherStation> make_test_circuit() {
    // 40-station straight-plus-banked test track (~400 m long, 12 m wide):
    // Stations 0..19: flat sunlit straight, ideal line at center (d=0, rubber=0.85)
    // Stations 20..29: heavily shaded under-bridge/grandstand section (shade=1.0)
    // Stations 30..39: left-banked corner (+8 deg: right edge higher -> water drains left!) + downhill dip at station 35
    std::vector<TrackWeatherStation> st;
    for (int i = 0; i < 40; ++i) {
        TrackWeatherStation s;
        s.x_m = i * 10.0;
        s.y_m = 0.0;
        s.z_m = 0.0;
        s.width_m = 12.0;
        s.crown_m = 0.03;
        s.ideal_offset_m = 0.0;
        s.initial_rubber = 0.85;
        s.drain_rate = 1.0;
        if (i >= 20 && i < 30) {
            s.shade_0_to_1 = 1.0; // dense bridge / grandstand shade
        }
        if (i >= 30) {
            s.banking_rad = 8.0 * (kPi / 180.0); // right edge higher, drains to left (+d, low lane index)
            s.crown_m = 0.0;
            // Elevation dip centered at station 35
            const double d = static_cast<double>(i - 35);
            s.z_m = -0.35 * std::exp(-(d * d) / 4.0);
        }
        st.push_back(s);
    }
    return st;
}

RS_TEST(dynamic_weather) {
    // 1. Determinism: identical seeds & steps produce bit-identical state
    WeatherConfig cfg;
    cfg.preset = WeatherPreset::DynamicFront;
    cfg.seed = 424242u;
    cfg.start_hour_local = 13.0;
    cfg.latitude_deg = 50.43; // Spa-Francorchamps
    cfg.day_of_year = 172;
    cfg.base_ambient_c = 21.0;
    cfg.base_wind_mps = 6.5;
    cfg.wind_direction_deg = 250.0;

    WeatherSystem w1(cfg), w2(cfg);
    for (int i = 0; i < 600; ++i) {
        w1.step(1.0);
        w2.step(1.0);
    }
    const WeatherSample s1 = w1.sample(0.0, 0.0);
    const WeatherSample s2 = w2.sample(0.0, 0.0);
    test::check("identical seeds replay bit-identically (rain)", s1.rain_mm_per_hr == s2.rain_mm_per_hr);
    test::check("identical seeds replay bit-identically (water)", s1.surface_water_mm == s2.surface_water_mm);
    test::check("identical seeds replay bit-identically (track C)", s1.track_surface_c == s2.track_surface_c);
    test::check("identical seeds replay bit-identically (wind dir)", s1.wind_direction_deg == s2.wind_direction_deg);

    // 2. DynamicFront advection, veering wind & anisotropic frontal passage
    WeatherSystem front(cfg);
    const double dir0 = front.live_wind_direction_deg();
    const WeatherSample t0 = front.sample(0.0, 0.0);
    double peak_rain = t0.rain_mm_per_hr;
    double max_dir_delta = 0.0;
    for (int i = 0; i < 1800; ++i) {
        front.step(1.0);
        const WeatherSample s = front.sample(0.0, 0.0);
        if (s.rain_mm_per_hr > peak_rain) peak_rain = s.rain_mm_per_hr;
        const double d_dir = std::abs(front.live_wind_direction_deg() - dir0);
        if (d_dir > max_dir_delta) max_dir_delta = d_dir;
    }
    const WeatherSample t_end = front.sample(0.0, 0.0);
    std::printf("         front: start=%.2f peak=%.2f mm/hr | water=%.2f mm | wind veer=%.1f deg\n",
                t0.rain_mm_per_hr, peak_rain, t_end.surface_water_mm, max_dir_delta);
    test::check("DynamicFront brings advected frontal rain over track", peak_rain > 4.0);
    test::check("DynamicFront accumulates standing surface water", t_end.surface_water_mm > 0.35);
    test::check("synoptic wind direction veers as pressure front crosses", max_dir_delta > 6.0);

    // 3. Per-Cell Persistent Asphalt Thermal Memory: sunlit vs bridge-shaded track sections!
    WeatherConfig sun_cfg = cfg;
    sun_cfg.preset = WeatherPreset::DryingTrack;
    sun_cfg.start_hour_local = 13.0;
    sun_cfg.base_ambient_c = 24.0;
    WeatherSystem track_sun(sun_cfg);
    track_sun.bind_track_geometry(make_test_circuit(), false);
    for (int i = 0; i < 360; ++i) track_sun.step(1.0); // 6 min drying under midday sun
    const WeatherWheelSample sunlit = track_sun.sample_wheel(50.0, 0.0);   // station 5: open sun
    const WeatherWheelSample shaded = track_sun.sample_wheel(250.0, 0.0);  // station 25: under bridge/grandstand
    std::printf("         thermal memory: sunlit=%.1f C (water=%.2f mm) vs shaded=%.1f C (water=%.2f mm)\n",
                sunlit.track_temp_c, sunlit.water_depth_mm, shaded.track_temp_c, shaded.water_depth_mm);
    test::check("sunlit asphalt heats > 6 C warmer than shaded bridge section", sunlit.track_temp_c > shaded.track_temp_c + 6.0);
    test::check("shaded track section stays wetter longer than sunlit straight", shaded.water_depth_mm > sunlit.water_depth_mm + 0.05);

    // 4. Sub-Meter Curvilinear 2D Shallow-Water Banking & Elevation Drainage
    WeatherConfig rain_cfg = cfg;
    rain_cfg.preset = WeatherPreset::HeavyStorm;
    WeatherSystem bank_w(rain_cfg);
    bank_w.bind_track_geometry(make_test_circuit(), false);
    for (int i = 0; i < 240; ++i) bank_w.step(1.0);
    // Station 35 is banked +8 deg (right edge y=-4.5 high -> drains to left inside y=+4.5)
    const WeatherWheelSample high_side = bank_w.sample_wheel(350.0, -4.2);
    const WeatherWheelSample low_side = bank_w.sample_wheel(350.0, +4.2);
    std::printf("         banked drainage: high-side=%.2f mm vs low-inside=%.2f mm\n",
                high_side.water_depth_mm, low_side.water_depth_mm);
    test::check("water drains downhill across banked corner toward low inside", low_side.water_depth_mm > high_side.water_depth_mm + 0.15);

    // 5. True "Rain Line" (Rubber-Line Wet-Grip Inversion) & Wet Painted Kerb Ice Slip!
    WeatherConfig dry_cfg = cfg;
    dry_cfg.preset = WeatherPreset::Clear;
    WeatherSystem dry_trk(dry_cfg);
    dry_trk.bind_track_geometry(make_test_circuit(), false);
    const WeatherWheelSample dry_ideal = dry_trk.sample_wheel(50.0, 0.0);   // rubbered racing line (d=0)
    const WeatherWheelSample dry_off = dry_trk.sample_wheel(50.0, 4.0);     // clean off-line asphalt (d=4 m)
    const WeatherWheelSample wet_ideal = bank_w.sample_wheel(50.0, 0.0);    // same rubbered racing line, NOW WET!
    const WeatherWheelSample wet_off = bank_w.sample_wheel(50.0, 4.0);      // clean off-line asphalt, NOW WET!
    const WeatherWheelSample wet_kerb = bank_w.sample_wheel(50.0, 5.8);     // lane 0: left painted kerb!
    std::printf("         rain-line inversion: DRY ideal=%.3f > off=%.3f | WET ideal=%.3f < off=%.3f | wet kerb=%.3f\n",
                dry_ideal.surface_mu_mult, dry_off.surface_mu_mult,
                wet_ideal.surface_mu_mult, wet_off.surface_mu_mult, wet_kerb.surface_mu_mult);
    test::check("dry rubbered racing line has higher grip than green off-line", dry_ideal.surface_mu_mult > dry_off.surface_mu_mult + 0.04);
    test::check("wet rubbered racing line INVERTS to LOWER grip than off-line wet line", wet_ideal.surface_mu_mult < wet_off.surface_mu_mult - 0.12);
    test::check("wet painted kerb turns ice-slick (< 0.55x grip)", wet_kerb.on_painted_kerb && wet_kerb.surface_mu_mult < 0.55);

    // 6. Sub-Meter Tyre-Width Drying Groove (both bound track strip AND 1.0 m open-world fine patch!)
    WeatherConfig dry_line_cfg = cfg;
    dry_line_cfg.preset = WeatherPreset::DryingTrack;
    WeatherSystem track_groove(dry_line_cfg);
    track_groove.bind_track_geometry(make_test_circuit(), false);
    const double before_lane = track_groove.sample_wheel(100.0, 0.0).water_depth_mm;
    for (int pass = 0; pass < 35; ++pass) {
        track_groove.deposit_tyre_passage(100.0, 0.0, 52.0, 4200.0, 3500.0, 1.4, 0.12);
    }
    const WeatherWheelSample groove_center = track_groove.sample_wheel(100.0, 0.0);
    const WeatherWheelSample groove_side = track_groove.sample_wheel(100.0, 2.5); // only 2.5 m sideways!
    std::printf("         sub-meter groove: before=%.2f -> center=%.2f mm (groove=%.2f) | 2.5m off-line=%.2f mm\n",
                before_lane, groove_center.water_depth_mm, groove_center.drying_line_factor, groove_side.water_depth_mm);
    test::check("passing tyres carve a dry sub-meter lane on track", groove_center.water_depth_mm < before_lane * 0.40);
    test::check("2.5 m off-line stays flooded while racing groove dries", groove_side.water_depth_mm > groove_center.water_depth_mm * 2.0);

    // Open-world 1.0 m fine tile check (no bound track): left wheel vs right wheel 2 m apart
    WeatherSystem open_w(dry_line_cfg);
    const double open_before = open_w.sample_wheel(12.5, 4.5).water_depth_mm;
    for (int pass = 0; pass < 35; ++pass) {
        open_w.deposit_tyre_passage(12.5, 4.5, 48.0, 4200.0, 2000.0, 1.3, 0.12);
    }
    const double open_cleared = open_w.sample_wheel(12.5, 4.5).water_depth_mm;
    const double open_2m_side = open_w.sample_wheel(12.5, 6.5).water_depth_mm;
    test::check("open-world 1.0 m fine tile carves real tyre-width track", open_cleared < open_before * 0.45 && open_2m_side > open_cleared * 1.8);

    // 7. Slick vs Road vs Intermediate vs Full-Wet Tyre Compound Physics
    TireParams tp_slick, tp_road, tp_inter, tp_wet;
    apply_compound(tp_slick, "slick");
    apply_compound(tp_road, "road");
    apply_compound(tp_inter, "intermediate");
    apply_compound(tp_wet, "wet");
    const double v_wet = 110.0 / 3.6;
    const double mu_slick = wet_grip_factor(v_wet, 210.0, 0.0, 2.2, tp_slick.tread_depth_new_mm, tp_slick.tread_void_ratio, tp_slick.wet_chemical_grip);
    const double mu_road  = wet_grip_factor(v_wet, 210.0, 0.0, 2.2, tp_road.tread_depth_new_mm,  tp_road.tread_void_ratio,  tp_road.wet_chemical_grip);
    const double mu_inter = wet_grip_factor(v_wet, 210.0, 0.0, 2.2, tp_inter.tread_depth_new_mm, tp_inter.tread_void_ratio, tp_inter.wet_chemical_grip);
    const double mu_wet   = wet_grip_factor(v_wet, 210.0, 0.0, 2.2, tp_wet.tread_depth_new_mm,   tp_wet.tread_void_ratio,   tp_wet.wet_chemical_grip);
    const HydroplaningState hp_slick = compute_hydroplaning(v_wet, 210.0, 0.0, 2.2, tp_slick.tread_depth_new_mm, tp_slick.tread_void_ratio);
    const HydroplaningState hp_wet   = compute_hydroplaning(v_wet, 210.0, 0.0, 2.2, tp_wet.tread_depth_new_mm,   tp_wet.tread_void_ratio);
    std::printf("         wet compounds @110 km/h 2.2mm: slick=%.3f (onset %.0f km/h) | road=%.3f | inter=%.3f | wet=%.3f (onset %.0f km/h)\n",
                mu_slick, hp_slick.onset_speed_mps * 3.6, mu_road, mu_inter, mu_wet, hp_wet.onset_speed_mps * 3.6);
    test::check("wet compound hierarchy: full wet > inter > road > slick",
                mu_wet > mu_inter && mu_inter > mu_road && mu_road > mu_slick + 0.20);
    test::check("slicks aquaplane violently at 110 km/h on 2.2 mm water while full wets stay planted",
                hp_slick.wedge_lift_fraction > 0.35 && hp_wet.wedge_lift_fraction == 0.0);

    // Wet tyre dry-track overheating vs puddle cooling
    TireCondition wet_dry_cond, wet_puddle_cond;
    wet_dry_cond.temperature_c = wet_dry_cond.surface_c = wet_dry_cond.inner_c = wet_dry_cond.middle_c = wet_dry_cond.outer_c = 42.0;
    wet_dry_cond.set_environment_celsius(22.0, 28.0);
    wet_dry_cond.road_water_mm = 0.0; // dry tarmac!
    wet_puddle_cond = wet_dry_cond;
    wet_puddle_cond.road_water_mm = 1.6; // wet patch cooling!
    for (int i = 0; i < 600; ++i) {
        wet_dry_cond.update(2200.0, 4000.0, 45.0, 0.05, &tp_wet);
        wet_puddle_cond.update(2200.0, 4000.0, 45.0, 0.05, &tp_wet);
    }
    std::printf("         wet tyre thermals: dry tarmac=%.1f C (wear=%.4f) vs puddle-cooled=%.1f C (wear=%.4f)\n",
                wet_dry_cond.surface_c, wet_dry_cond.wear, wet_puddle_cond.surface_c, wet_puddle_cond.wear);
    test::check("full-wet tyre overheats & wears fast on dry tarmac", wet_dry_cond.surface_c > wet_puddle_cond.surface_c + 20.0);
    test::check("full-wet wear accelerates sharply on dry tarmac vs wet", wet_dry_cond.wear > wet_puddle_cond.wear * 2.5);

    // 8. Asymmetric Puddle Hydrodynamic Drag & Yaw Pull in rs::Vehicle
    CarConfig car = test::car();
    Vehicle veh(car);
    veh.reset_motion(42.0, 4); // ~151 km/h straight ahead
    ChassisState cs;
    cs.position = {0, 0, car.cg_height};
    cs.velocity = {42.0, 0, 0};
    auto rays = veh.wheel_rays(cs);
    std::array<WheelContact, 4> contacts{};
    for (int w = 0; w < 4; ++w) {
        contacts[w].hit = true;
        contacts[w].distance = rays[w].length - 0.05;
        contacts[w].point = rays[w].origin + rays[w].direction * contacts[w].distance;
        contacts[w].normal = {0, 0, 1};
        contacts[w].surface = car.surface_index("asphalt");
        // Right wheels (FR=1, RR=3) hit a 4.5 mm standing puddle; left wheels (FL=0, RL=2) stay dry!
        contacts[w].water_depth_mm = (w == FR || w == RR) ? 4.5 : 0.0;
    }
    DriverInput di;
    di.gear = 4;
    di.throttle = 0.2;
    veh.set_input(di);
    VehicleOutput vout{};
    for (int step = 0; step < 5; ++step) vout = veh.update(cs, contacts, 0.0025);
    std::printf("         asymmetric right puddle @151 km/h: yaw_torque=%.1f N m | steer_torque=%.2f N m | FR_lift=%.2f\n",
                vout.torque.z, vout.steer_torque, vout.wheels[FR].hydroplaning_lift);
    // Right wheels dragged backward -> clockwise yaw torque (torque.z < 0 in Z-up right-handed!)
    test::check("right-side standing puddle induces strong clockwise yaw pull into puddle", vout.torque.z < -80.0);
    test::check("asymmetric puddle triggers steering kick", std::abs(vout.steer_torque) > 1.5);

    // 9. Wind-Advected Volumetric Trailing Spray Plumes & Following-Car Visibility Extinction
    WeatherSystem spray_w(rain_cfg);
    for (int i = 0; i < 15; ++i) {
        spray_w.deposit_car_spray({30.0 + i * 2.5, 0.0, 0.5}, {55.0, 0.0, 0.0}, 2.4, 3500.0, 0.15);
        spray_w.step(0.05);
    }
    const double leader_vis = spray_w.sample_driver_visibility_m({90.0, 0.0, 1.1}, {1.0, 0.0, 0.0});
    const double follower_vis = spray_w.sample_driver_visibility_m({22.0, 0.0, 1.1}, {1.0, 0.0, 0.0});
    std::printf("         spray visibility: P1 leader=%.0f m vs P2 follower in spray=%.0f m\n", leader_vis, follower_vis);
    test::check("P1 leader sees clearly compared to car blinded in trailing spray plume",
                leader_vis > 200.0 && follower_vis < 55.0 && follower_vis < leader_vis * 0.25);

    // 10. Radar grid & upstream advection nowcast
    const WeatherRadarGrid radar = front.sample_radar(0.0, 0.0, 8000.0);
    test::check("radar 15-min & 30-min forecasts finite in [0..1]",
                radar.rain_chance_15m >= 0.0 && radar.rain_chance_15m <= 1.0 &&
                radar.rain_chance_30m >= 0.0 && radar.rain_chance_30m <= 1.0);
}
