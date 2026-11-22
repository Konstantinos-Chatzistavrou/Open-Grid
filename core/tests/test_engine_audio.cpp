// Apache-2.0 — CTest verification for OpenGrid's vendored MIT engine-sim + Forza acoustic engine.
#include "harness.hpp"
#include "rs/engine_audio.h"

#include <cmath>
#include <vector>

RS_TEST(engine_audio) {
    // Test a 12-cylinder piston engine (V12 -> exercises all 12 chambers under ASan/UBSan!)
    // AND our dedicated 4-rotor 26B peripheral-port Wankel engine (`Rotary4`).
    const rs::EngineVoice voices[2] = { rs::EngineVoice::V12Na, rs::EngineVoice::Rotary4 };
    for (rs::EngineVoice v : voices) {
        rs::EngineAudioSynth synth;
        rs::EngineAudioConfig cfg{};
        cfg.voice = v;
        cfg.sampleRate = 48000;
        cfg.simFrequency = 8000;
        cfg.fluidSubsteps = 4;
        cfg.exhaustStage = rs::ExhaustStage::RaceTitanium;
        bool ok = synth.initialize(cfg);
        test::check_range("synth.initialize", ok ? 1.0 : 0.0, 1.0, 1.0, "bool");

        synth.warmup(0.08f, 3500.0f, 0.8f);
        rs::EngineAudioControl ctrl{};
        ctrl.rpm = 5500.0f;
        ctrl.throttle = 0.95f;
        ctrl.load = 0.95f;
        ctrl.boostBar = 1.2f;
        ctrl.exhaustStage = rs::ExhaustStage::RaceTitanium;
        synth.setControl(ctrl);
        synth.triggerExhaustPop(0.9f);
        synth.triggerTurboFlutter(1.1f);

        std::vector<float> L(1024), R(1024);
        synth.renderStereo(L.data(), R.data(), 1024);

        double energy = 0.0;
        double finite = 1.0;
        for (int i = 0; i < 1024; ++i) {
            if (!std::isfinite(L[i]) || !std::isfinite(R[i])) finite = 0.0;
            energy += static_cast<double>(L[i]) * L[i] + static_cast<double>(R[i]) * R[i];
        }
        test::check_range("samples finite", finite, 1.0, 1.0, "bool");
        test::check_range("stereo energy", energy, 0.01, 2048.0, "sum2");
    }
}
