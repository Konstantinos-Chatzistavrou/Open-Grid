// Apache-2.0 — CTest verification for OpenGrid's vendored MIT engine-sim + full-vehicle physical acoustic engine.
#include "harness.hpp"
#include "rs/engine_audio.h"
#include "rs/vehicle_audio.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace {
double goertzel_power(const std::vector<float>& x, double fs, double target_hz) {
    const double w = 2.0 * rs::kPi * target_hz / fs;
    const double coeff = 2.0 * std::cos(w);
    double s1 = 0.0, s2 = 0.0;
    for (float v : x) {
        const double s0 = static_cast<double>(v) + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

double find_peak_hz(const std::vector<float>& x, double fs, double f_lo, double f_hi, double step_hz) {
    double best_f = f_lo, best_p = -1.0;
    for (double f = f_lo; f <= f_hi + 1e-6; f += step_hz) {
        const double p = goertzel_power(x, fs, f);
        if (p > best_p) { best_p = p; best_f = f; }
    }
    return best_f;
}
}  // namespace

RS_TEST(engine_audio) {
    // Test V12, Cross-Plane V8, 4-rotor 26B Wankel, Rally I4 Turbo, and Group-B I5 Turbo
    // across all 4 CameraPerspectives, 8-ch Householder tunnel FDN, wall/overpass/wet-road reflections,
    // VTEC cam crossover, external wastegate screamer pipe, starter crank, burbles, pops, flutter, and gear whine.
    const rs::EngineVoice voices[5] = {
        rs::EngineVoice::V12Na,
        rs::EngineVoice::V8Crossplane,
        rs::EngineVoice::Rotary4,
        rs::EngineVoice::I4Turbo,
        rs::EngineVoice::I5Turbo,
    };
    const rs::CameraPerspective perspectives[4] = {
        rs::CameraPerspective::ExteriorRear,
        rs::CameraPerspective::ExteriorChase,
        rs::CameraPerspective::HoodBumper,
        rs::CameraPerspective::InteriorCockpit,
    };

    for (rs::EngineVoice v : voices) {
        rs::EngineAudioSynth synth;
        rs::EngineAudioConfig cfg{};
        cfg.voice = v;
        cfg.sampleRate = 48000;
        cfg.simFrequency = 8000;
        cfg.fluidSubsteps = 4;
        cfg.exhaustStage = rs::ExhaustStage::RaceTitanium;
        const bool ok = synth.initialize(cfg);
        test::check_range("synth.initialize", ok ? 1.0 : 0.0, 1.0, 1.0, "bool");

        synth.warmup(0.06f, 3500.0f, 0.8f);

        // 1. Starter crank + catch flare burst
        rs::EngineAudioControl crankCtrl{};
        crankCtrl.rpm = 1100.0f;
        crankCtrl.throttle = 0.08f;
        crankCtrl.load = 0.10f;
        crankCtrl.exhaustStage = rs::ExhaustStage::RaceTitanium;
        crankCtrl.perspective = rs::CameraPerspective::HoodBumper;
        synth.setControl(crankCtrl);
        synth.triggerStarterCrank(0.18f);

        std::vector<float> L(1024), R(1024);
        double crankEnergy = 0.0;
        double crankFinite = 1.0;
        double crankMaxAbs = 0.0;
        for (int b = 0; b < 48; ++b) {
            synth.renderStereo(L.data(), R.data(), 256);
            for (int i = 0; i < 256; ++i) {
                if (!std::isfinite(L[i]) || !std::isfinite(R[i])) crankFinite = 0.0;
                crankMaxAbs = std::max(crankMaxAbs, static_cast<double>(std::max(std::abs(L[i]), std::abs(R[i]))));
                crankEnergy += static_cast<double>(L[i]) * L[i] + static_cast<double>(R[i]) * R[i];
            }
        }
        test::check_range("starter samples finite", crankFinite, 1.0, 1.0, "bool");
        test::check_range("starter peak bounded", crankMaxAbs, 0.001, 1.05, "abs");
        test::check_range("starter stereo energy", crankEnergy, 0.05, 30000.0, "sum2");

        // 2. Test all 4 camera perspectives with 8-ch Householder tunnel FDN, L/R wall + overpass + wet specular,
        //    exact physical gearWhineHz, external wastegate screamer pipe, VTEC cam crossover, pops & flutter!
        for (int pIdx = 0; pIdx < 4; ++pIdx) {
            rs::EngineAudioControl ctrl{};
            ctrl.rpm = 6800.0f;
            ctrl.throttle = 0.95f;
            ctrl.load = 0.95f;
            ctrl.boostBar = 1.45f;
            ctrl.reverbMix = 0.18f;
            ctrl.turboEnabled = true;
            ctrl.externalWastegate = true;
            ctrl.exhaustStage = rs::ExhaustStage::RaceTitanium;
            ctrl.perspective = perspectives[pIdx];
            ctrl.tunnelReflection = 0.85f;
            ctrl.wallProximityL = 0.80f;
            ctrl.wallProximityR = 0.80f;
            ctrl.overpassReflection = 0.70f;
            ctrl.wetRoadReflection = 0.80f;
            ctrl.gearWhineLevel = 0.60f;
            ctrl.gearWhineHz = 1480.0f;
            ctrl.vehicleSpeedMps = 45.0f;
            synth.setControl(ctrl);

            synth.triggerExhaustPop(0.90f);
            synth.triggerOverrunBurble(0.65f);
            synth.triggerTurboFlutter(1.15f);

            double energy = 0.0;
            double finite = 1.0;
            double maxAbs = 0.0;
            for (int blk = 0; blk < 3; ++blk) {
                synth.renderStereo(L.data(), R.data(), 1024);
                for (int i = 0; i < 1024; ++i) {
                    if (!std::isfinite(L[i]) || !std::isfinite(R[i])) finite = 0.0;
                    maxAbs = std::max(maxAbs, static_cast<double>(std::max(std::abs(L[i]), std::abs(R[i]))));
                    energy += static_cast<double>(L[i]) * L[i] + static_cast<double>(R[i]) * R[i];
                }
            }
            test::check_range("samples finite", finite, 1.0, 1.0, "bool");
            test::check_range("peak bounded [-1.05, 1.05]", maxAbs, 0.005, 1.05, "abs");
            test::check_range("stereo energy", energy, 0.02, 7000.0, "sum2");
        }

        // 3. Coast-down decel sweep (4600 -> 2400 RPM) to exercise automatic light overrun burbles & 8-ch FDN tail
        double decelFinite = 1.0;
        double decelMaxAbs = 0.0;
        double decelEnergy = 0.0;
        for (int blk = 0; blk < 16; ++blk) {
            const float u = static_cast<float>(blk) / 15.0f;
            rs::EngineAudioControl decel{};
            decel.rpm = 4600.0f - u * 2200.0f;
            decel.throttle = 0.02f;
            decel.load = 0.02f;
            decel.exhaustStage = rs::ExhaustStage::RaceTitanium;
            decel.perspective = rs::CameraPerspective::ExteriorRear;
            decel.tunnelReflection = 0.85f;
            decel.wallProximityL = 0.80f;
            decel.wallProximityR = 0.80f;
            decel.gearWhineLevel = 0.60f;
            decel.vehicleSpeedMps = 45.0f - u * 15.0f;
            synth.setControl(decel);
            synth.renderStereo(L.data(), R.data(), 512);
            for (int i = 0; i < 512; ++i) {
                if (!std::isfinite(L[i]) || !std::isfinite(R[i])) decelFinite = 0.0;
                decelMaxAbs = std::max(decelMaxAbs, static_cast<double>(std::max(std::abs(L[i]), std::abs(R[i]))));
                decelEnergy += static_cast<double>(L[i]) * L[i] + static_cast<double>(R[i]) * R[i];
            }
        }
        test::check_range("decel samples finite", decelFinite, 1.0, 1.0, "bool");
        test::check_range("decel peak bounded", decelMaxAbs, 0.005, 1.05, "abs");
        test::check_range("decel stereo energy", decelEnergy, 0.05, 20000.0, "sum2");
    }
}

RS_TEST(vehicle_audio) {
    constexpr int kFs = 48000;

    // -------------------------------------------------------------------------
    // 1. Physical 4-Wheel Tyre, Road, Brake, Drivetrain, Aero & Impact Layers
    //    (Engine bus muted so every chassis/tyre acoustic mechanism is verified cleanly!)
    // -------------------------------------------------------------------------
    auto measure_rms = [&](const rs::VehicleAudioTelemetry& tel, int frames = 4096) -> std::pair<double, double> {
        rs::VehicleAudioEngine eng;
        rs::VehicleAudioConfig cfg{};
        cfg.engine.sampleRate = kFs;
        cfg.enableEngineSynth = false;
        eng.initialize(cfg);
        eng.setTelemetry(tel);
        std::vector<float> L(static_cast<size_t>(frames)), R(static_cast<size_t>(frames));
        eng.renderStereo(L.data(), R.data(), frames);
        double sum2 = 0.0, peak = 0.0;
        for (int i = 0; i < frames; ++i) {
            sum2 += 0.5 * (static_cast<double>(L[i]) * L[i] + static_cast<double>(R[i]) * R[i]);
            peak = std::max(peak, static_cast<double>(std::max(std::abs(L[i]), std::abs(R[i]))));
        }
        return {std::sqrt(sum2 / frames), peak};
    };

    rs::VehicleAudioTelemetry base{};
    base.speed_mps = 30.0f;
    for (int w = 0; w < 4; ++w) {
        base.wheels[w].contact = true;
        base.wheels[w].load_n = 3800.0f;
        base.wheels[w].angular_velocity = 90.0f;
        base.wheels[w].radius_m = 0.33f;
    }
    const auto [rms_roll, pk_roll] = measure_rms(base);

    // Progressive slip scrub -> peak stick-slip squeal
    rs::VehicleAudioTelemetry t_scrub = base;
    for (int w = 0; w < 4; ++w) t_scrub.wheels[w].slip_angle_rad = 0.08f;
    const auto [rms_scrub, pk_scrub] = measure_rms(t_scrub);

    rs::VehicleAudioTelemetry t_squeal = base;
    for (int w = 0; w < 4; ++w) t_squeal.wheels[w].slip_angle_rad = 0.22f;
    const auto [rms_squeal, pk_squeal] = measure_rms(t_squeal);

    // Wet rain spray & hydroplaning splash
    rs::VehicleAudioTelemetry t_wet = base;
    t_wet.road_water_mm = 1.6f;
    for (int w = 0; w < 4; ++w) t_wet.wheels[w].hydroplaning_lift = 0.35f;
    const auto [rms_wet, pk_wet] = measure_rms(t_wet);

    // Flat-spot rhythmic thump + kerb rumble + pothole rim strike + puncture hiss
    rs::VehicleAudioTelemetry t_flat = base;
    t_flat.wheels[0].flat_spot_depth_mm = 1.6f;
    const auto [rms_flat, pk_flat] = measure_rms(t_flat);

    rs::VehicleAudioTelemetry t_kerb = base;
    t_kerb.wheels[0].kerb_load_ratio = 0.9f;
    t_kerb.wheels[0].surface_kind = 1;
    t_kerb.wheels[0].rim_strike_force_n = 24000.0f;
    t_kerb.wheels[0].puncture_leak_rate = 0.14f;
    t_kerb.wheels[0].pressure_kpa = 145.0f;
    const auto [rms_kerb, pk_kerb] = measure_rms(t_kerb);

    // Brake squeal + ABS + driveline clunk + synchro gear grind + splitter scrape + crash impact
    rs::VehicleAudioTelemetry t_mech = base;
    t_mech.brake = 0.55f;
    t_mech.wheels[0].brake_temp_c = 520.0f;
    t_mech.wheels[0].abs_active = true;
    t_mech.driveline_clunk_nm = 240.0f;
    t_mech.gear_grind = true;
    t_mech.front_splitter_stalled = true;
    t_mech.damage_impacts = 1;
    t_mech.last_impact_kj = 12.0f;
    const auto [rms_mech, pk_mech] = measure_rms(t_mech);

    std::printf("         chassis/tyre RMS: roll=%.4f -> scrub=%.4f -> squeal=%.4f | wet=%.4f flat=%.4f kerb/rim=%.4f mech/impact=%.4f\n",
                rms_roll, rms_scrub, rms_squeal, rms_wet, rms_flat, rms_kerb, rms_mech);
    test::check("tyre slip audio progresses cleanly from rolling -> micro-scrub -> peak stick-slip squeal",
                rms_roll > 0.005 && rms_scrub > rms_roll * 1.15 && rms_squeal > rms_scrub * 1.35);
    test::check("wet rain spray, flat-spot thump, kerb/rim-strike/puncture, and brake/ABS/clunk/grind/impact all generate distinct audio",
                rms_wet > rms_roll * 1.4 && rms_flat > rms_roll * 1.3 && rms_kerb > rms_roll * 1.8 && rms_mech > rms_roll * 2.0 && pk_mech <= 0.97);

    // -------------------------------------------------------------------------
    // 2. True Physical 3D Spatial Doppler Shift & Atmospheric HF Air Absorption
    // -------------------------------------------------------------------------
    {
        constexpr double f_src = 500.0;
        constexpr double v_car = 50.0; // 180 km/h fly-by
        constexpr int N = 16384;       // ~0.34 s capture window

        auto run_doppler = [&](double start_x, double vel_x) -> double {
            rs::SpatialAcousticProcessor sp;
            sp.initialize(kFs);
            std::vector<float> bufL(N), bufR(N);
            double phase = 0.0;
            const double dphi = 2.0 * rs::kPi * f_src / kFs;
            for (int i = 0; i < N; ++i) {
                const float s = static_cast<float>(0.8 * std::sin(phase));
                bufL[i] = bufR[i] = s;
                phase += dphi;
            }
            // Process in 256-sample real-time audio blocks while moving source along +X toward/away from origin
            for (int off = 0; off < N; off += 256) {
                const double t = static_cast<double>(off) / kFs;
                rs::SpatialListenerState st{};
                st.source_pos_m = {start_x + vel_x * t, 0.0, 0.0};
                st.source_vel_mps = {vel_x, 0.0, 0.0};
                st.listener_pos_m = {0.0, 0.0, 0.0};
                st.listener_vel_mps = {0.0, 0.0, 0.0};
                st.listener_right = {0.0, -1.0, 0.0};
                sp.processStereo(st, bufL.data() + off, bufR.data() + off, 256);
            }
            // Analyze second half after propagation delay fills
            std::vector<float> tail(bufL.begin() + N / 2, bufL.end());
            return find_peak_hz(tail, kFs, 380.0, 640.0, 1.0);
        };

        const double f_approach = run_doppler(-90.0, +v_car); // moving toward listener -> higher pitch
        const double f_recede   = run_doppler(+30.0, +v_car); // moving away from listener -> lower pitch
        const double exp_app = f_src * 343.0 / (343.0 - v_car); // 585.3 Hz
        const double exp_rec = f_src * 343.0 / (343.0 + v_car); // 436.4 Hz

        std::printf("         3D Doppler (500 Hz @ 50 m/s): approach=%.1f Hz (exact %.1f) | recede=%.1f Hz (exact %.1f)\n",
                    f_approach, exp_app, f_recede, exp_rec);
        test::check("approaching 3D Doppler frequency matches exact c/(c-v) physics within 1.5%",
                    std::abs(f_approach - exp_app) / exp_app < 0.015);
        test::check("receding 3D Doppler frequency matches exact c/(c+v) physics within 1.5%",
                    std::abs(f_recede - exp_rec) / exp_rec < 0.015);
    }

    // -------------------------------------------------------------------------
    // 3. End-to-End 400 Hz Physics -> VehicleAudioEngine Mastering & Real-Time CPU Benchmark
    // -------------------------------------------------------------------------
    {
        rs::CarConfig gt3 = rs::load_car_config(test::data_path("cars/tornado_gt3.json"));
        auto sim = test::make_sim(gt3, 1.0 / 400.0);
        test::enable_game_models(sim->vehicle);
        sim->reset({}, 0.0, 42.0, 4);

        rs::VehicleAudioEngine audio;
        rs::VehicleAudioConfig acfg{};
        acfg.engine.voice = rs::select_voice_for_car(gt3);
        acfg.engine.sampleRate = kFs;
        acfg.engine.simFrequency = 5000;
        acfg.engine.fluidSubsteps = 4;
        acfg.engine.exhaustStage = rs::ExhaustStage::RaceTitanium;
        test::check("VehicleAudioEngine initializes cleanly for Tornado GT3", audio.initialize(acfg));
        audio.warmup(0.05f, 4500.0f, 0.8f);

        // Render 0.50 s of full-vehicle 48 kHz stereo audio driven live by 400 Hz physics!
        constexpr int kBlocks = 200; // 200 physics ticks = 0.50 s @ 400 Hz, 120 audio frames/tick = 24,000 frames @ 48 kHz
        constexpr int kAudioPerTick = 120;
        std::vector<float> L(kAudioPerTick), R(kAudioPerTick);
        rs::DriverInput in{};
        in.throttle = 0.92;
        in.steer = 0.14;
        in.gear = 4;
        in.auto_clutch = true;

        double max_abs = 0.0, mean_sum = 0.0, energy = 0.0;
        bool all_finite = true;
        const auto t0 = std::chrono::steady_clock::now();
        for (int b = 0; b < kBlocks; ++b) {
            sim->step(in);
            rs::VehicleAudioTelemetry tel = rs::VehicleAudioTelemetry::from_vehicle_output(
                sim->last, gt3, {0, 0, 0, 0}, 0.4, 0.25);
            tel.tunnel_reflection = 0.65f;
            tel.wall_proximity_l = 0.5f;
            tel.wall_proximity_r = 0.5f;
            tel.exhaust_stage = rs::ExhaustStage::RaceTitanium;
            audio.setTelemetry(tel);
            if (b == 80) audio.triggerExhaustPop(1.2f);
            if (b == 120) audio.triggerCrashImpact(18.0f);
            audio.renderStereo(L.data(), R.data(), kAudioPerTick);
            for (int i = 0; i < kAudioPerTick; ++i) {
                if (!std::isfinite(L[i]) || !std::isfinite(R[i])) all_finite = false;
                max_abs = std::max(max_abs, static_cast<double>(std::max(std::abs(L[i]), std::abs(R[i]))));
                mean_sum += 0.5 * (L[i] + R[i]);
                energy += 0.5 * (static_cast<double>(L[i]) * L[i] + static_cast<double>(R[i]) * R[i]);
            }
        }
        const auto t1 = std::chrono::steady_clock::now();
        const double wall_s = std::chrono::duration<double>(t1 - t0).count();
        const double rt_mult = 0.50 / std::max(wall_s, 1e-6);
        const double total_frames = static_cast<double>(kBlocks * kAudioPerTick);
        const double dc_offset = std::abs(mean_sum / total_frames);
        const double rms = std::sqrt(energy / total_frames);
        const double crest_db = 20.0 * std::log10(std::max(max_abs, 1e-6) / std::max(rms, 1e-6));

        std::printf("         full-vehicle live 400Hz->48kHz: peak=%.3f rms=%.3f crest=%.1f dB DC=%.5f | speed=%.1fx real-time (%.1f ms for 500 ms audio)\n",
                    max_abs, rms, crest_db, dc_offset, rt_mult, wall_s * 1000.0);
        test::check("full-vehicle audio is 100% finite, strictly true-peak limited (<=0.97), DC-free and punchy",
                    all_finite && max_abs > 0.15 && max_abs <= 0.97 && dc_offset < 0.015 && rms > 0.03 && crest_db > 5.0);
    }

    // -------------------------------------------------------------------------
    // 4. Spectral Realism Verification: Deep V8 Growl, Muffled Overrun & Ear-Safe Top Speed
    // -------------------------------------------------------------------------
    {
        auto band_power = [&](const std::vector<float>& x, double f_lo, double f_hi, double step_hz) {
            double total = 0.0;
            for (double f = f_lo; f <= f_hi + 1e-6; f += step_hz) {
                total += goertzel_power(x, kFs, f);
            }
            return total;
        };

        // 4a. Cross-Plane V8 @ 3200 RPM WOT: deep growl (50..360 Hz) must dominate piercing 2.8..6.0 kHz harshness
        rs::EngineAudioSynth v8;
        rs::EngineAudioConfig vcfg{};
        vcfg.voice = rs::EngineVoice::V8Crossplane;
        vcfg.sampleRate = kFs;
        vcfg.simFrequency = 5200;
        vcfg.fluidSubsteps = 3;
        vcfg.exhaustStage = rs::ExhaustStage::Sport;
        v8.initialize(vcfg);
        v8.warmup(0.08f, 3200.0f, 0.95f);

        rs::EngineAudioControl c{};
        c.rpm = 3200.0f;
        c.throttle = 0.95f;
        c.load = 0.95f;
        c.exhaustStage = rs::ExhaustStage::Sport;
        c.perspective = rs::CameraPerspective::ExteriorChase;
        v8.setControl(c);
        std::vector<float> L(8192), R(8192), mono(8192);
        v8.renderStereo(L.data(), R.data(), 8192);
        for (int i = 0; i < 8192; ++i) mono[i] = 0.5f * (L[i] + R[i]);

        const double v8_growl = band_power(mono, 50.0, 360.0, 10.0);
        const double v8_harsh = band_power(mono, 2800.0, 6000.0, 120.0);
        const double v8_ratio_db = 10.0 * std::log10(std::max(v8_growl, 1e-9) / std::max(v8_harsh, 1e-9));

        // 4b. Sport exhaust mid-RPM lift-off (4400 RPM -> throttle 0): warm burble only, NO gunshot HF crack!
        c.rpm = 4400.0f;
        c.throttle = 0.80f;
        c.load = 0.80f;
        v8.setControl(c);
        v8.renderStereo(L.data(), R.data(), 2048);
        c.throttle = 0.0f;
        c.load = 0.0f;
        c.rpm = 4100.0f;
        v8.setControl(c);
        v8.renderStereo(L.data(), R.data(), 8192);
        double lift_peak = 0.0;
        for (int i = 0; i < 8192; ++i) {
            mono[i] = 0.5f * (L[i] + R[i]);
            lift_peak = std::max(lift_peak, static_cast<double>(std::max(std::abs(L[i]), std::abs(R[i]))));
        }
        const double lift_hf = band_power(mono, 3200.0, 7200.0, 160.0);
        const double lift_lo = band_power(mono, 60.0, 420.0, 15.0);

        // 4c. Top-speed full redline (V8 @ 7150 RPM, 88 m/s = 317 km/h): ear-safe warm balance, no shrill whistle
        rs::VehicleAudioEngine full_v8;
        rs::VehicleAudioConfig fvcfg{};
        fvcfg.engine = vcfg;
        full_v8.initialize(fvcfg);
        full_v8.warmup(0.08f, 7150.0f, 1.0f);
        rs::VehicleAudioTelemetry top{};
        top.rpm = 7150.0f;
        top.redline_rpm = 7200.0f;
        top.throttle = 1.0f;
        top.load = 1.0f;
        top.speed_mps = 88.0f;
        top.exhaust_stage = rs::ExhaustStage::Sport;
        top.perspective = rs::CameraPerspective::ExteriorChase;
        for (int w = 0; w < 4; ++w) {
            top.wheels[w].contact = true;
            top.wheels[w].load_n = 4200.0f;
            top.wheels[w].angular_velocity = 266.0f;
            top.wheels[w].radius_m = 0.33f;
        }
        full_v8.setTelemetry(top);
        full_v8.renderStereo(L.data(), R.data(), 8192);
        for (int i = 0; i < 8192; ++i) mono[i] = 0.5f * (L[i] + R[i]);
        const double top_body = band_power(mono, 70.0, 1400.0, 25.0);
        const double top_harsh = band_power(mono, 3000.0, 7500.0, 150.0);
        const double top_ratio_db = 10.0 * std::log10(std::max(top_body, 1e-9) / std::max(top_harsh, 1e-9));

        std::printf("         spectral check: V8 growl/harsh=%.1f dB | lift-off peak=%.3f lo/hf=%.1f dB | top-speed body/harsh=%.1f dB\n",
                    v8_ratio_db, lift_peak,
                    10.0 * std::log10(std::max(lift_lo, 1e-9) / std::max(lift_hf, 1e-9)),
                    top_ratio_db);
        test::check("Cross-Plane V8 has deep chest growl dominating 2.8-6 kHz harshness (> +14 dB)", v8_ratio_db > 14.0);
        test::check("Sport lift-off produces warm muffled overrun without full-scale HF gunshot blasts",
                    lift_peak < 0.78 && lift_lo > lift_hf * 10.0);
        test::check("Top-speed redline (317 km/h) stays warm and ear-safe (body > harsh by > +10 dB)", top_ratio_db > 10.0);
    }
}
