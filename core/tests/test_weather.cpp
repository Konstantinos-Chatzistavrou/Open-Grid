// Apache-2.0 — OpenGrid Dynamic Weather Mesoscale Weather, Solar-Thermal Asphalt, Wind Aero & 2D Hydrology Tests.
#include <cmath>
#include <cstdio>
#include "harness.hpp"
#include "rs/weather.hpp"

using namespace rs;

RS_TEST(dynamic_weather) {
    // 1. Strict bit-exact determinism across identical seeds
    {
        WeatherConfig cfg;
        cfg.preset = WeatherPreset::DynamicFront;
        cfg.seed = 4242u;
        cfg.start_hour_local = 13.5;
        cfg.base_wind_mps = 6.0;

        WeatherSystem a(cfg), b(cfg);
        for (int i = 0; i < 600; ++i) {
            a.step(0.5);
            b.step(0.5);
        }
        const WeatherSample sa = a.sample(320.0, -140.0);
        const WeatherSample sb = b.sample(320.0, -140.0);
        test::check("Dynamic Weather weather is 100% deterministic for identical seed & steps",
                    sa.rain_mm_per_hr == sb.rain_mm_per_hr && sa.track_surface_c == sb.track_surface_c &&
                    sa.surface_water_mm == sb.surface_water_mm && sa.wind_world_mps.x == sb.wind_world_mps.x);
    }

    // 2. Mesoscale storm-cell advection: DynamicFront starts dry/light at origin, rolls in rain, then passes
    {
        WeatherConfig cfg;
        cfg.preset = WeatherPreset::DynamicFront;
        cfg.seed = 9001u;
        cfg.base_wind_mps = 7.5;
        cfg.wind_direction_deg = 270.0; // wind blowing from West -> East (+X)
        cfg.start_hour_local = 14.0;
        WeatherSystem tw(cfg);

        const WeatherSample s0 = tw.sample(0.0, 0.0);
        const WeatherRadarGrid r0 = tw.sample_radar(0.0, 0.0, 6000.0);
        double peak_rain = s0.rain_mm_per_hr;
        double peak_water = s0.surface_water_mm;
        // Advance 12 minutes in 1 s steps: upstream front (~2.8 km away) advects right over origin!
        for (int i = 0; i < 720; ++i) {
            tw.step(1.0);
            const WeatherSample st = tw.sample(0.0, 0.0);
            peak_rain = std::max(peak_rain, st.rain_mm_per_hr);
            peak_water = std::max(peak_water, st.surface_water_mm);
        }
        // Spatial variation check: two points 3.5 km apart see genuinely different rainfall rates!
        const WeatherSample west = tw.sample(-1800.0, 0.0);
        const WeatherSample east = tw.sample(1800.0, 0.0);
        const double spatial_diff = std::abs(west.rain_mm_per_hr - east.rain_mm_per_hr);
        std::printf("         DynamicFront: t=0 rain %.2f mm/h (15m forecast %.0f%%) -> peak %.1f mm/h, water %.2f mm | spatial dRain %.2f mm/h\n",
                    s0.rain_mm_per_hr, r0.rain_chance_15m * 100.0, peak_rain, peak_water, spatial_diff);
        test::check("DynamicFront advects upstream rain cell across the track over time", peak_rain > s0.rain_mm_per_hr + 4.0);
        test::check("Advecting storm accumulates standing surface water", peak_water > 0.35);
        test::check("Spatial weather produces distinct rainfall across opposite ends of a 3.6 km circuit", spatial_diff > 0.25);
        test::check("Dynamic Weather radar forecasts incoming rain front", r0.rain_chance_15m > 0.30 || r0.rain_chance_30m > 0.30);
    }

    // 3. Solar-thermal asphalt energy balance: sunny midday heats tarmac > cloud-shaded > storm rain quenching
    {
        WeatherConfig sun_cfg;
        sun_cfg.preset = WeatherPreset::Clear;
        sun_cfg.start_hour_local = 13.0;
        sun_cfg.base_ambient_c = 25.0;
        WeatherSystem tw_sun(sun_cfg);

        WeatherConfig storm_cfg = sun_cfg;
        storm_cfg.preset = WeatherPreset::HeavyStorm;
        WeatherSystem tw_storm(storm_cfg);

        for (int i = 0; i < 600; ++i) {
            tw_sun.step(1.0);
            tw_storm.step(1.0);
        }
        const WeatherSample ss = tw_sun.sample(0.0, 0.0);
        const WeatherSample sr = tw_storm.sample(0.0, 0.0);
        std::printf("         Thermal balance (25C base): Clear track %.1f C (sun %.0f W/m2) | Storm track %.1f C (rain %.1f mm/h, vis %.0f m)\n",
                    ss.track_surface_c, ss.solar_irradiance_w_m2, sr.track_surface_c, sr.rain_mm_per_hr, sr.visibility_m);
        test::check("Midday clear sun heats asphalt well above ambient air", ss.track_surface_c > ss.ambient_air_c + 8.0 && ss.solar_irradiance_w_m2 > 500.0);
        test::check("Heavy storm clouds & rain quench asphalt significantly cooler than clear sun", sr.track_surface_c < ss.track_surface_c - 10.0);
        test::check("Heavy storm drops visibility & raises humidity near saturation", sr.visibility_m < 2500.0 && sr.humidity_0_to_1 > 0.90);
        test::check("Heavy storm builds deep standing puddles & triggers lightning", sr.surface_water_mm > 1.8 && sr.barometric_kpa < ss.barometric_kpa - 1.0);
    }

    // 4. 2D Surface hydrology & tyre-wake drying racing line
    {
        WeatherConfig dry_cfg;
        dry_cfg.preset = WeatherPreset::DryingTrack;
        dry_cfg.start_hour_local = 13.0;
        dry_cfg.base_ambient_c = 24.0;
        WeatherSystem tw(dry_cfg);

        const double w_before = tw.sample(100.0, 100.0).surface_water_mm;
        // Simulate 40 passing cars pumping water along the racing line at (100, 100) vs untouched off-line (600, 600)
        for (int lap = 0; lap < 40; ++lap) {
            tw.deposit_tyre_wake(100.0, 100.0, 50.0, 4200.0, 0.08);
        }
        for (int i = 0; i < 300; ++i) tw.step(1.0);
        const WeatherSample on_line = tw.sample(100.0, 100.0);
        const WeatherSample off_line = tw.sample(600.0, 600.0);
        std::printf("         DryingTrack: initial %.2f mm -> on-line %.2f mm (groove %.2f) vs off-line %.2f mm\n",
                    w_before, on_line.surface_water_mm, on_line.drying_line_factor, off_line.surface_water_mm);
        test::check("Tyre-wake pumping & solar evaporation carve a drier racing line",
                    on_line.surface_water_mm < w_before * 0.78 && on_line.drying_line_factor > 0.25 &&
                    on_line.surface_water_mm < off_line.surface_water_mm - 0.08);
    }

    // 5. True 3D Aerodynamic Wind Vector inside rs::Vehicle (headwind increases drag & downforce; crosswind adds lateral force)
    {
        const CarConfig cfg = load_car_config(test::data_path("cars/tornado_gt3.json"));
        auto measure_aero = [&](Vec3 wind_mps) {
            auto s = test::make_sim(cfg);
            s->vehicle.atmosphere().enabled = true;
            s->vehicle.atmosphere().wind_world_mps = wind_mps;
            s->reset({}, 0.0, 60.0, 6); // 216 km/h along +X
            DriverInput coast;
            coast.gear = 6;
            coast.clutch = 1.0;
            coast.throttle = 0.0;
            s->step(coast);
            return s->last;
        };
        const VehicleOutput calm = measure_aero({0.0, 0.0, 0.0});
        const VehicleOutput headwind = measure_aero({-15.0, 0.0, 0.0}); // 54 km/h headwind opposing +X motion
        const VehicleOutput crosswind = measure_aero({0.0, 15.0, 0.0}); // 54 km/h crosswind pushing +Y
        std::printf("         Aero wind @ 216 km/h: calm Fx=%.0f N | headwind Fx=%.0f N | crosswind Fy=%.0f N\n",
                    calm.force.x, headwind.force.x, crosswind.force.y);
        test::check("15 m/s headwind measurably increases aerodynamic drag force", headwind.force.x < calm.force.x - 400.0);
        test::check("15 m/s crosswind pushes chassis laterally with aerodynamic side-force", crosswind.force.y > calm.force.y + 400.0);
    }
}
