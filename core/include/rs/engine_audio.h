// Apache-2.0 — OpenGrid Real-Time Physical Combustion Engine Audio Synthesizer.
//
// Built directly on top of our vendored, improved headless AngeTheGreat engine-sim (MIT,
// core/third_party/engine_sim/) with Forza-grade acoustic enhancements:
//   - Real-time multi-cylinder thermodynamic combustion (V8 crossplane, V8 flatplane,
//     V8 supercharged, V8 twin-turbo, Ferrari V12, Odd-fire V10, Porsche Flat-6, 2JZ I6, TT V6)
//     plus a dedicated 4-rotor 26B peripheral-port Wankel combustion model.
//   - Dual-microphone physical exhaust collector (L/R banks) + intake manifold plenum roar.
//   - Tuned acoustic exhaust waveguide (Helmholtz sub-chamber, primary header comb, titanium/muffler
//     stage presets, warm asymmetric pipe saturation, and hollow off-throttle engine-braking resonance).
//   - Physical unburnt-fuel overrun burbles, flat-foot upshift bangs, boost-coupled turbo spool +
//     compressor-surge BOV flutter, and crank-coupled helical twin-screw supercharger whine.
//   - Zero-allocation audio render loop (`renderStereo`) ready for UE 5.8 USynthComponent,
//     offline dual-load dyno stem rendering, and WebAudio WASM AudioWorklet.
#pragma once

#include <cstdint>
#include <memory>
#include <string>

namespace rs {

enum class EngineVoice : uint8_t {
    V8Crossplane = 0,
    V8Flatplane,
    V8Supercharged,
    V8TwinTurbo,
    V12Na,
    V10Screamer,
    Flat6Na,
    I6Forged,
    V6TwinTurbo,
    Rotary4,
};

enum class ExhaustStage : uint8_t {
    Stock = 0,
    Sport,
    RaceTitanium,
};

struct EngineAudioControl {
    float rpm = 950.0f;            // Target crankshaft RPM (from rs_core / garage rev)
    float throttle = 0.0f;         // 0..1 driver throttle pedal
    float load = 0.0f;             // 0..1 engine torque load (0 = coasting/overrun, 1 = WOT pull)
    float boostBar = 0.0f;         // 0..2.4 manifold gauge boost pressure (bar)
    float reverbMix = 0.14f;       // 0..1 early asphalt / garage / tunnel reflection wet mix
    bool ignitionCut = false;      // True during rev-limiter bounce or flat-foot upshift cut
    bool starterCrank = false;     // True during ignition key crank
    bool turboEnabled = false;     // Override aftermarket turbo kit on NA engines
    ExhaustStage exhaustStage = ExhaustStage::Sport;
};

struct EngineAudioConfig {
    EngineVoice voice = EngineVoice::V8Crossplane;
    int sampleRate = 48000;
    int simFrequency = 5000;       // Thermodynamic solver Hz (5000 = fast real-time; 10000 = offline dyno max fidelity)
    int fluidSubsteps = 4;         // Gas-dynamics substeps per solver tick (4 real-time, 8 offline dyno)
    ExhaustStage exhaustStage = ExhaustStage::Sport;
    bool turboEnabled = false;
};

class EngineAudioSynth {
public:
    EngineAudioSynth();
    ~EngineAudioSynth();

    EngineAudioSynth(const EngineAudioSynth&) = delete;
    EngineAudioSynth& operator=(const EngineAudioSynth&) = delete;

    /** Initialize or switch engine architecture (allocates solver state once; call off audio thread or on car swap). */
    bool initialize(const EngineAudioConfig& cfg);

    /** Warm up cylinder pressure & exhaust flow silently for `seconds` so initial output starts cleanly settled. */
    void warmup(float seconds, float rpm = 1000.0f, float throttle = 0.08f);

    /** Update real-time vehicle state (lock-free, allocation-free). */
    void setControl(const EngineAudioControl& ctrl);

    /** Trigger a physical unburnt-fuel exhaust detonation / anti-lag bang (intensity 0.2..1.5). */
    void triggerExhaustPop(float intensity = 0.85f);

    /** Trigger a compressor-surge BOV flutter burst ("stu-tu-tu-tu") on boost lift-off (boostBar 0.2..2.2). */
    void triggerTurboFlutter(float boostBar = 1.0f);

    /** Render `numFrames` stereo float samples into `outL` and `outR` (allocation-free). */
    void renderStereo(float* outL, float* outR, int numFrames);

    /** Convenience mono downmix renderer into `outMono`. */
    void renderMono(float* outMono, int numFrames);

    EngineVoice voice() const;
    int sampleRate() const;
    float measuredRpm() const;
    bool isInitialized() const;

    static EngineVoice parseVoice(const std::string& id);
    static const char* voiceName(EngineVoice v);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace rs
