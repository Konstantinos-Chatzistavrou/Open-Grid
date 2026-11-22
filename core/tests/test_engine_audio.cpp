// Apache-2.0 — CTest verification for OpenGrid's vendored MIT engine-sim + Forza Horizon 6 acoustic engine.
#include "harness.hpp"
#include "rs/engine_audio.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

RS_TEST(engine_audio) {
    // Test 12-cyl V12, 8-cyl Cross-Plane V8, and 4-rotor 26B peripheral-port Wankel
    // across all 4 CameraPerspectives, tunnel/wall FDN, starter crank, burbles, pops, flutter, and gear whine.
    const rs::EngineVoice voices[3] = {
        rs::EngineVoice::V12Na,
        rs::EngineVoice::V8Crossplane,
        rs::EngineVoice::Rotary4,
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
        // Render 0.25s in 256-sample blocks so both crank and catch flare execute
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

        // 2. Test all 4 camera perspectives with tunnel FDN, L/R wall proximity, gearbox whine,
        //    overrun burbles, anti-lag pops, and turbo compressor-surge flutter!
        for (int pIdx = 0; pIdx < 4; ++pIdx) {
            rs::EngineAudioControl ctrl{};
            ctrl.rpm = 5600.0f;
            ctrl.throttle = 0.95f;
            ctrl.load = 0.95f;
            ctrl.boostBar = 1.25f;
            ctrl.reverbMix = 0.18f;
            ctrl.turboEnabled = true;
            ctrl.exhaustStage = rs::ExhaustStage::RaceTitanium;
            ctrl.perspective = perspectives[pIdx];
            ctrl.tunnelReflection = 0.85f;
            ctrl.wallProximityL = 0.80f;
            ctrl.wallProximityR = 0.80f;
            ctrl.gearWhineLevel = 0.60f;
            ctrl.vehicleSpeedMps = 45.0f;
            synth.setControl(ctrl);

            synth.triggerExhaustPop(0.90f);
            synth.triggerOverrunBurble(0.65f);
            synth.triggerTurboFlutter(1.15f);

            double energy = 0.0;
            double finite = 1.0;
            double maxAbs = 0.0;
            // Render 3072 samples (~64ms) to cross the 40ms perspective crossfade + tunnel FDN feedback
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

        // 3. Coast-down decel sweep (4600 -> 2400 RPM) to exercise automatic light overrun burbles & FDN tail
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
