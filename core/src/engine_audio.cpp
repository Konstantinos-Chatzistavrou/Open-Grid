// Apache-2.0 — OpenGrid Real-Time Physical Combustion Engine Audio Synthesizer.
//
// Vendors and improves upon AngeTheGreat's MIT-licensed `engine-sim` thermodynamic engine
// simulator (core/third_party/engine_sim/) with Forza-grade real-time acoustics:
//   1. True dual-mic physical exhaust (per-bank L/R collector waves) + intake manifold plenum roar.
//   2. Tuned physical exhaust waveguide (Helmholtz sub-bass chamber, dual header comb resonators,
//      per-architecture resonant body EQ, Stock/Sport/RaceTitanium stage presets, hollow decel
//      engine-braking character, and warm asymmetric pipe saturation).
//   3. Physical unburnt-fuel overrun burbles & anti-lag exhaust bangs injected into the tailpipe.
//   4. Boost-coupled turbocharger turbine spool + rhythmic compressor-surge BOV flutter, and
//      crank-coupled helical twin-screw supercharger lobe whine.
//   5. Dedicated 4-rotor 26B peripheral-port Wankel combustion model (`Rotary4`).
//   6. True stereo dual-tailpipe dispersion + tight early asphalt/garage reflection diffuser.

#include "rs/engine_audio.h"

#include "constants.h"
#include "direct_throttle_linkage.h"
#include "engine.h"
#include "gas_system.h"
#include "piston_engine_simulator.h"
#include "standard_valvetrain.h"
#include "units.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace rs {
namespace {

constexpr double kPi = 3.14159265358979323846;

inline float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

inline double clampd(double v, double lo, double hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// Fast lock-free xorshift32 PRNG for audio-thread air-rush / combustion micro-jitter
struct FastRng {
    uint32_t s = 0x243F6A88u;
    inline float nextSigned() {
        uint32_t x = s;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        s = x;
        return (static_cast<float>(x & 0xFFFFu) / 32767.5f) - 1.0f;
    }
    inline float next01() {
        return 0.5f * (nextSigned() + 1.0f);
    }
};

// Direct Form II Transposed Biquad (zero heap allocations, stable at 48 kHz)
struct Biquad {
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;
    float a1 = 0.0f, a2 = 0.0f;
    float z1 = 0.0f, z2 = 0.0f;

    void reset() { z1 = z2 = 0.0f; }

    inline float process(float x) {
        const float y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }

    void setLowpass(float fs, float fc, float q) {
        fc = clampf(fc, 20.0f, fs * 0.45f);
        q = std::max(0.25f, q);
        const float w0 = 2.0f * static_cast<float>(kPi) * fc / fs;
        const float c = std::cos(w0);
        const float s = std::sin(w0);
        const float alpha = s / (2.0f * q);
        const float a0 = 1.0f + alpha;
        b0 = ((1.0f - c) * 0.5f) / a0;
        b1 = (1.0f - c) / a0;
        b2 = b0;
        a1 = (-2.0f * c) / a0;
        a2 = (1.0f - alpha) / a0;
    }

    void setHighpass(float fs, float fc, float q) {
        fc = clampf(fc, 15.0f, fs * 0.45f);
        q = std::max(0.25f, q);
        const float w0 = 2.0f * static_cast<float>(kPi) * fc / fs;
        const float c = std::cos(w0);
        const float s = std::sin(w0);
        const float alpha = s / (2.0f * q);
        const float a0 = 1.0f + alpha;
        b0 = ((1.0f + c) * 0.5f) / a0;
        b1 = -(1.0f + c) / a0;
        b2 = b0;
        a1 = (-2.0f * c) / a0;
        a2 = (1.0f - alpha) / a0;
    }

    void setBandpass(float fs, float fc, float q) {
        fc = clampf(fc, 25.0f, fs * 0.45f);
        q = std::max(0.3f, q);
        const float w0 = 2.0f * static_cast<float>(kPi) * fc / fs;
        const float c = std::cos(w0);
        const float s = std::sin(w0);
        const float alpha = s / (2.0f * q);
        const float a0 = 1.0f + alpha;
        b0 = alpha / a0;
        b1 = 0.0f;
        b2 = -alpha / a0;
        a1 = (-2.0f * c) / a0;
        a2 = (1.0f - alpha) / a0;
    }

    void setPeaking(float fs, float fc, float q, float gainDb) {
        fc = clampf(fc, 25.0f, fs * 0.45f);
        q = std::max(0.3f, q);
        const float A = std::pow(10.0f, gainDb / 40.0f);
        const float w0 = 2.0f * static_cast<float>(kPi) * fc / fs;
        const float c = std::cos(w0);
        const float s = std::sin(w0);
        const float alpha = s / (2.0f * q);
        const float a0 = 1.0f + alpha / A;
        b0 = (1.0f + alpha * A) / a0;
        b1 = (-2.0f * c) / a0;
        b2 = (1.0f - alpha * A) / a0;
        a1 = (-2.0f * c) / a0;
        a2 = (1.0f - alpha / A) / a0;
    }

    void setLowShelf(float fs, float fc, float gainDb) {
        fc = clampf(fc, 25.0f, fs * 0.42f);
        const float A = std::pow(10.0f, gainDb / 40.0f);
        const float w0 = 2.0f * static_cast<float>(kPi) * fc / fs;
        const float c = std::cos(w0);
        const float s = std::sin(w0);
        const float sq = 2.0f * std::sqrt(A) * s * 0.70710678f;
        const float a0 = (A + 1.0f) + (A - 1.0f) * c + sq;
        b0 = (A * ((A + 1.0f) - (A - 1.0f) * c + sq)) / a0;
        b1 = (2.0f * A * ((A - 1.0f) - (A + 1.0f) * c)) / a0;
        b2 = (A * ((A + 1.0f) - (A - 1.0f) * c - sq)) / a0;
        a1 = (-2.0f * ((A - 1.0f) + (A + 1.0f) * c)) / a0;
        a2 = ((A + 1.0f) + (A - 1.0f) * c - sq) / a0;
    }
};

// Compact ring-buffer waveguide / early reflection delay line (power-of-two size, zero heap allocs)
template <int N>
struct DelayLine {
    static_assert((N & (N - 1)) == 0, "N must be power of 2");
    std::array<float, N> buf{};
    int idx = 0;

    void reset() {
        buf.fill(0.0f);
        idx = 0;
    }

    inline void push(float x) {
        buf[idx] = x;
        idx = (idx + 1) & (N - 1);
    }

    inline float read(int delaySamples) const {
        const int d = std::max(1, std::min(N - 1, delaySamples));
        return buf[(idx - d) & (N - 1)];
    }

    inline float readFrac(float delaySamples) const {
        const float d = clampf(delaySamples, 1.0f, static_cast<float>(N - 2));
        const int i0 = static_cast<int>(d);
        const float frac = d - static_cast<float>(i0);
        const float s0 = buf[(idx - i0) & (N - 1)];
        const float s1 = buf[(idx - i0 - 1) & (N - 1)];
        return s0 + (s1 - s0) * frac;
    }
};

// ---- Engine-sim geometric preset specs -------------------------------------------------------

struct CylSpec {
    int bank;
    int journalIdx;
    int exhaustIdx;
    double fireDeg;
    double primaryCm;
    double atten;
};

struct AcousticProfile {
    float subHz;           // Helmholtz chesty exhaust resonance Hz
    float subGainDb;
    float bodyHz;          // Core mid-pipe growl formant Hz
    float bodyQ;
    float bodyGainDb;
    float raspHz;          // Header / titanium metallic bite Hz
    float raspQ;
    float raspGainDb;
    float intakeHz;        // Carbon airbox / manifold induction roar Hz
    float intakeMix;       // WOT intake mix weight (0.15..0.55)
    float pipeCombMsL;     // Primary tailpipe acoustic reflection time (ms)
    float pipeCombMsR;     // Right bank slight asymmetry for real stereo width
    float pipeFeedback;    // Header resonance feedback
    float satDrive;        // Asymmetric pipe nonlinearity drive
    float redlineRpm;
    float firingsPerRev;
    bool hasTurbo;
    bool hasSupercharger;
};

struct PresetSpec {
    std::string name;
    double redlineRpm;
    double boreMm;
    double strokeMm;
    double rodMm;
    double chamberCc;
    double bank0Deg;
    double bank1Deg;
    int numBanks;
    double tdcDeg;
    double crankMassKg;
    double flywheelMassKg;
    double flywheelRadiusIn;
    double frictionLbFt;
    double intakePlenumL;
    double intakeFlowCfm;
    double runnerFlowCfm;
    double runnerLenIn;
    double idlePlatePos;
    double exOutletCfm;
    double exPrimaryLenIn;
    double exPrimaryCfm;
    double exLen0In;
    double exLen1In;
    double exVol0;
    double exVol1;
    double exVelDecay;
    double camDurDeg;
    double camGamma;
    double camLiftMm;
    double intakeLobeCenterDeg;
    double exhaustLobeCenterDeg;
    double flowAtten;
    std::vector<double> journalDegs;
    std::vector<CylSpec> cyls;
    AcousticProfile acoustic;
};

PresetSpec getPreset(EngineVoice voice) {
    PresetSpec s{};
    s.rodMm = 148.0;
    s.crankMassKg = 20.0;
    s.flywheelMassKg = 11.0;
    s.flywheelRadiusIn = 6.8;
    s.frictionLbFt = 11.0;
    s.intakePlenumL = 1.325;
    s.intakeFlowCfm = 950.0;
    s.runnerFlowCfm = 185.0;
    s.runnerLenIn = 10.0;
    s.idlePlatePos = 0.994;
    s.exOutletCfm = 1450.0;
    s.exPrimaryLenIn = 29.0;
    s.exPrimaryCfm = 600.0;
    s.exLen0In = 96.0;
    s.exLen1In = 98.0;
    s.exVol0 = 0.30;
    s.exVol1 = 0.30;
    s.exVelDecay = 0.6;
    s.camDurDeg = 230.0;
    s.camGamma = 0.95;
    s.camLiftMm = 13.5;
    s.intakeLobeCenterDeg = 114.0;
    s.exhaustLobeCenterDeg = 114.0;
    s.flowAtten = 1.05;

    switch (voice) {
        case EngineVoice::Flat6Na: {
            // Porsche 911 GT3 RS 4.0L Flat-6 Boxer (9000 RPM)
            s.name = "OpenGrid GT3 4.0L Flat-6";
            s.redlineRpm = 9200.0;
            s.boreMm = 102.0; s.strokeMm = 81.5; s.rodMm = 138.0; s.chamberCc = 56.0;
            s.numBanks = 2; s.bank0Deg = 90.0; s.bank1Deg = -90.0; s.tdcDeg = 180.0;
            s.intakeFlowCfm = 1120.0; s.runnerFlowCfm = 215.0; s.runnerLenIn = 7.8;
            s.exOutletCfm = 1550.0; s.exPrimaryLenIn = 25.0; s.exPrimaryCfm = 660.0;
            s.exLen0In = 82.0; s.exLen1In = 86.0;
            s.camDurDeg = 236.0; s.camGamma = 0.90; s.camLiftMm = 13.8;
            s.intakeLobeCenterDeg = 108.0; s.exhaustLobeCenterDeg = 112.0; s.flowAtten = 1.25;
            s.journalDegs = { 0.0, 240.0, 120.0, 180.0, 60.0, 300.0 };
            s.cyls = {
                {0, 0, 0,   0.0, 2.0, 0.95}, {0, 1, 0, 240.0, 3.5, 0.90}, {0, 2, 0, 480.0, 5.0, 1.02},
                {1, 3, 1, 360.0, 2.5, 0.92}, {1, 4, 1, 600.0, 4.0, 1.00}, {1, 5, 1, 120.0, 1.5, 0.88},
            };
            s.acoustic = { 92.0f, 5.2f, 360.0f, 1.4f, 4.0f, 1650.0f, 1.9f, 5.5f, 480.0f, 0.42f, 3.4f, 3.9f, 0.34f, 1.75f, 9000.0f, 3.0f, false, false };
            break;
        }
        case EngineVoice::V12Na: {
            // Ferrari 6.5L 65deg NA V12 (9300 RPM soprano howl)
            s.name = "OpenGrid Valenza 6.5L V12";
            s.redlineRpm = 11500.0;
            s.boreMm = 86.0; s.strokeMm = 54.0; s.rodMm = 122.0; s.chamberCc = 35.0;
            s.numBanks = 2; s.bank0Deg = 32.5; s.bank1Deg = -32.5; s.tdcDeg = 90.0 + 32.5;
            s.crankMassKg = 14.5; s.flywheelMassKg = 7.0; s.flywheelRadiusIn = 5.5; s.frictionLbFt = 3.5;
            s.intakeFlowCfm = 1450.0; s.runnerFlowCfm = 225.0; s.runnerLenIn = 4.6;
            s.exOutletCfm = 2100.0; s.exPrimaryLenIn = 22.0; s.exPrimaryCfm = 420.0;
            s.exLen0In = 38.0; s.exLen1In = 52.0; s.exVol0 = 0.08; s.exVol1 = 0.08;
            s.camDurDeg = 242.0; s.camGamma = 0.85; s.camLiftMm = 15.2;
            s.intakeLobeCenterDeg = 94.0; s.exhaustLobeCenterDeg = 112.0; s.flowAtten = 1.15;
            s.journalDegs = { 0.0, 120.0, 240.0, 240.0, 120.0, 0.0 };
            s.cyls = {
                {0, 0, 1,   0.0, 0.5, 0.80}, {0, 1, 1, 480.0, 0.2, 1.00}, {0, 2, 1, 240.0, 0.4, 0.85},
                {0, 3, 1, 600.0, 1.5, 0.92}, {0, 4, 1, 120.0, 2.2, 0.78}, {0, 5, 1, 360.0, 0.8, 0.98},
                {1, 0, 0,  75.0, 0.5, 0.82}, {1, 1, 0, 555.0, 0.4, 0.76}, {1, 2, 0, 315.0, 2.8, 0.95},
                {1, 3, 0, 675.0, 1.5, 1.05}, {1, 4, 0, 195.0, 0.6, 0.84}, {1, 5, 0, 435.0, 1.4, 1.02},
            };
            s.acoustic = { 105.0f, 4.5f, 440.0f, 1.5f, 3.6f, 2150.0f, 2.1f, 6.2f, 560.0f, 0.44f, 2.6f, 3.1f, 0.36f, 1.65f, 9300.0f, 6.0f, false, false };
            break;
        }
        case EngineVoice::V10Screamer: {
            // Lexus LFA / Huracan 72deg Odd-Fire V10 (9000 RPM)
            s.name = "OpenGrid Kronos 5.2L V10";
            s.redlineRpm = 9500.0;
            s.boreMm = 88.0; s.strokeMm = 79.0; s.rodMm = 130.0; s.chamberCc = 42.0;
            s.numBanks = 2; s.bank0Deg = 36.0; s.bank1Deg = -36.0; s.tdcDeg = 90.0 + 36.0;
            s.frictionLbFt = 4.5;
            s.intakeFlowCfm = 1150.0; s.runnerFlowCfm = 205.0; s.runnerLenIn = 4.6;
            s.exOutletCfm = 2000.0; s.exPrimaryLenIn = 44.0; s.exPrimaryCfm = 900.0;
            s.exLen0In = 98.0; s.exLen1In = 99.5; s.exVol0 = 0.48; s.exVol1 = 0.48; s.exVelDecay = 0.8;
            s.camDurDeg = 230.0; s.camGamma = 1.05; s.camLiftMm = 15.5;
            s.intakeLobeCenterDeg = 94.0; s.exhaustLobeCenterDeg = 112.0; s.flowAtten = 1.45;
            s.journalDegs = { 0.0, 144.0, 216.0, 288.0, 72.0 };
            s.cyls = {
                {0, 0, 1, 0 * 72.0, 5.0, 0.85}, {0, 1, 1, 2 * 72.0, 4.0, 1.00}, {0, 2, 1, 8 * 72.0, 3.0, 1.08},
                {0, 3, 1, 4 * 72.0, 2.0, 0.92}, {0, 4, 1, 6 * 72.0, 1.0, 0.78},
                {1, 0, 0, 1 * 72.0, 5.0, 0.78}, {1, 1, 0, 3 * 72.0, 4.0, 0.86}, {1, 2, 0, 9 * 72.0, 3.0, 0.94},
                {1, 3, 0, 5 * 72.0, 2.0, 1.06}, {1, 4, 0, 7 * 72.0, 1.0, 0.82},
            };
            s.acoustic = { 98.0f, 5.0f, 410.0f, 1.5f, 4.2f, 1850.0f, 2.0f, 6.0f, 520.0f, 0.45f, 2.9f, 3.4f, 0.36f, 1.72f, 9000.0f, 5.0f, false, false };
            break;
        }
        case EngineVoice::I6Forged: {
            // Toyota 2JZ / RB26 2.8L Forged Twin-Turbo Inline-6
            s.name = "OpenGrid Kaze 2.8L TT I6";
            s.redlineRpm = 8400.0;
            s.boreMm = 86.0; s.strokeMm = 86.0; s.rodMm = 142.0; s.chamberCc = 50.0;
            s.numBanks = 1; s.bank0Deg = 0.0; s.bank1Deg = 0.0; s.tdcDeg = 90.0;
            s.crankMassKg = 15.0; s.flywheelMassKg = 10.0; s.frictionLbFt = 5.0;
            s.intakePlenumL = 1.1; s.intakeFlowCfm = 720.0; s.runnerFlowCfm = 205.0; s.runnerLenIn = 20.0;
            s.exOutletCfm = 1150.0; s.exPrimaryLenIn = 34.0; s.exPrimaryCfm = 460.0;
            s.exLen0In = 94.0; s.exLen1In = 96.0; s.exVelDecay = 0.8;
            s.camDurDeg = 224.0; s.camGamma = 1.05; s.camLiftMm = 10.8; s.flowAtten = 1.08;
            s.journalDegs = { 0.0, 480.0, 240.0, 600.0, 120.0, 360.0 };
            s.cyls = {
                {0, 0, 0,   0.0, 6.0, 0.90}, {0, 1, 0, 480.0, 4.8, 0.95}, {0, 2, 0, 240.0, 3.6, 0.92},
                {0, 3, 1, 600.0, 3.6, 0.97}, {0, 4, 1, 120.0, 4.8, 0.98}, {0, 5, 1, 360.0, 6.0, 0.93},
            };
            s.acoustic = { 84.0f, 5.8f, 320.0f, 1.4f, 4.4f, 1380.0f, 1.7f, 4.2f, 430.0f, 0.36f, 3.9f, 4.4f, 0.30f, 1.80f, 8200.0f, 3.0f, true, false };
            break;
        }
        case EngineVoice::V6TwinTurbo: {
            // 3.5L 60deg Twin-Turbo V6 (NSX Type S / Group-B)
            s.name = "OpenGrid 3.5L TT V6";
            s.redlineRpm = 8300.0;
            s.boreMm = 91.0; s.strokeMm = 89.5; s.rodMm = 144.0; s.chamberCc = 54.0;
            s.numBanks = 2; s.bank0Deg = 30.0; s.bank1Deg = -30.0; s.tdcDeg = 90.0 + 30.0;
            s.crankMassKg = 14.0; s.flywheelMassKg = 9.0; s.frictionLbFt = 6.0;
            s.intakeFlowCfm = 860.0; s.runnerFlowCfm = 195.0; s.runnerLenIn = 12.0;
            s.exOutletCfm = 1250.0; s.exPrimaryLenIn = 28.0; s.exPrimaryCfm = 520.0;
            s.exLen0In = 88.0; s.exLen1In = 91.0; s.exVelDecay = 0.75;
            s.camDurDeg = 228.0; s.camGamma = 0.96; s.camLiftMm = 12.4; s.flowAtten = 1.15;
            // Even-fire 60deg V6 split-pin crank: 1-4-2-5-3-6 every 120 deg
            s.journalDegs = { 0.0, 120.0, 240.0, 60.0, 180.0, 300.0 };
            s.cyls = {
                {0, 0, 0,   0.0, 2.5, 0.94}, {0, 1, 0, 240.0, 4.0, 0.98}, {0, 2, 0, 480.0, 5.5, 0.91},
                {1, 3, 1, 120.0, 3.0, 0.96}, {1, 4, 1, 360.0, 4.5, 1.00}, {1, 5, 1, 600.0, 2.0, 0.89},
            };
            s.acoustic = { 88.0f, 5.5f, 345.0f, 1.4f, 4.2f, 1520.0f, 1.8f, 4.8f, 470.0f, 0.40f, 3.6f, 4.1f, 0.32f, 1.82f, 8000.0f, 3.0f, true, false };
            break;
        }
        case EngineVoice::V8Flatplane:
        case EngineVoice::V8TwinTurbo: {
            // Ferrari F136 / McLaren 4.0L Flat-Plane V8 (8800-9000 RPM)
            const bool isTT = (voice == EngineVoice::V8TwinTurbo);
            s.name = isTT ? "OpenGrid Aether 4.0L TT V8" : "OpenGrid Valenza 4.5L Flat-Plane V8";
            s.redlineRpm = isTT ? 8500.0 : 9200.0;
            s.boreMm = 94.0; s.strokeMm = isTT ? 79.0 : 81.0; s.rodMm = 158.0; s.chamberCc = 70.0;
            s.numBanks = 2; s.bank0Deg = 45.0; s.bank1Deg = -45.0; s.tdcDeg = 90.0 + 45.0;
            s.frictionLbFt = 13.0;
            s.intakeFlowCfm = 960.0; s.runnerFlowCfm = 160.0; s.runnerLenIn = 9.5;
            s.exOutletCfm = 1300.0; s.exPrimaryLenIn = 28.0; s.exPrimaryCfm = 610.0;
            s.exLen0In = 96.0; s.exLen1In = 98.0; s.exVol0 = 0.24; s.exVol1 = 0.23;
            s.camDurDeg = 232.0; s.camGamma = 0.90; s.camLiftMm = 14.0;
            s.intakeLobeCenterDeg = 115.0; s.exhaustLobeCenterDeg = 115.0; s.flowAtten = 1.15;
            s.journalDegs = { 0.0, 180.0, 180.0, 0.0 };
            s.cyls = {
                {0, 0, 0, 0 * 90.0, 2.0, 0.92}, {0, 1, 0, 6 * 90.0, 1.0, 0.84},
                {0, 2, 0, 2 * 90.0, 3.0, 1.06}, {0, 3, 0, 4 * 90.0, 5.0, 0.98},
                {1, 0, 1, 1 * 90.0, 1.0, 1.00}, {1, 1, 1, 7 * 90.0, 5.0, 0.84},
                {1, 2, 1, 3 * 90.0, 7.0, 0.92}, {1, 3, 1, 5 * 90.0, 0.5, 0.78},
            };
            s.acoustic = {
                isTT ? 86.0f : 94.0f, isTT ? 6.0f : 5.0f,
                isTT ? 350.0f : 395.0f, 1.45f, 4.2f,
                isTT ? 1480.0f : 1920.0f, 1.9f, isTT ? 4.8f : 5.8f,
                490.0f, isTT ? 0.38f : 0.44f,
                3.1f, 3.6f, 0.34f, isTT ? 1.88f : 1.72f,
                isTT ? 8200.0f : 9000.0f, 4.0f, isTT, false
            };
            break;
        }
        case EngineVoice::Rotary4: {
            // Acoustic profile for our dedicated 4-Rotor 26B peripheral-port Wankel core
            s.name = "OpenGrid Kaze 26B 4-Rotor";
            s.redlineRpm = 10200.0;
            s.acoustic = { 102.0f, 4.8f, 460.0f, 1.6f, 4.2f, 2250.0f, 2.1f, 5.6f, 640.0f, 0.38f, 2.7f, 3.2f, 0.35f, 1.90f, 10200.0f, 4.0f, true, false };
            break;
        }
        case EngineVoice::I4Turbo: {
            // 2.0L Forged Rally / JDM Twin-Scroll Turbo Inline-4 (1-3-4-2, 8200 RPM)
            s.name = "OpenGrid Rally 2.0L Turbo I4";
            s.redlineRpm = 8400.0;
            s.boreMm = 86.0; s.strokeMm = 86.0; s.rodMm = 148.0; s.chamberCc = 48.0;
            s.numBanks = 1; s.bank0Deg = 0.0; s.bank1Deg = 0.0; s.tdcDeg = 90.0;
            s.crankMassKg = 11.5; s.flywheelMassKg = 7.5; s.frictionLbFt = 4.2;
            s.intakePlenumL = 0.95; s.intakeFlowCfm = 620.0; s.runnerFlowCfm = 195.0; s.runnerLenIn = 14.0;
            s.exOutletCfm = 980.0; s.exPrimaryLenIn = 30.0; s.exPrimaryCfm = 420.0;
            s.exLen0In = 86.0; s.exLen1In = 88.0; s.exVol0 = 0.24; s.exVol1 = 0.24; s.exVelDecay = 0.78;
            s.camDurDeg = 232.0; s.camGamma = 0.98; s.camLiftMm = 11.8; s.flowAtten = 1.12;
            s.journalDegs = { 0.0, 180.0, 180.0, 0.0 };
            s.cyls = {
                {0, 0, 0,   0.0, 4.2, 0.94},
                {0, 1, 0, 540.0, 3.0, 0.98},
                {0, 2, 1, 180.0, 3.0, 0.96},
                {0, 3, 1, 360.0, 4.2, 0.92},
            };
            s.acoustic = { 78.0f, 5.4f, 275.0f, 1.45f, 4.6f, 1420.0f, 1.85f, 4.8f, 420.0f, 0.42f, 4.1f, 4.5f, 0.31f, 1.88f, 8200.0f, 2.0f, true, false };
            break;
        }
        case EngineVoice::I5Turbo: {
            // 2.5L Group-B / Quattro 5-Cylinder Turbo (1-2-4-5-3 odd-harmonic warble, 8000 RPM)
            s.name = "OpenGrid Group-B 2.5L Turbo I5";
            s.redlineRpm = 8200.0;
            s.boreMm = 82.5; s.strokeMm = 92.8; s.rodMm = 144.0; s.chamberCc = 50.0;
            s.numBanks = 1; s.bank0Deg = 0.0; s.bank1Deg = 0.0; s.tdcDeg = 90.0;
            s.crankMassKg = 13.0; s.flywheelMassKg = 8.5; s.frictionLbFt = 4.6;
            s.intakePlenumL = 1.05; s.intakeFlowCfm = 680.0; s.runnerFlowCfm = 200.0; s.runnerLenIn = 15.0;
            s.exOutletCfm = 1080.0; s.exPrimaryLenIn = 32.0; s.exPrimaryCfm = 450.0;
            s.exLen0In = 90.0; s.exLen1In = 96.0; s.exVol0 = 0.28; s.exVol1 = 0.28; s.exVelDecay = 0.80;
            s.camDurDeg = 230.0; s.camGamma = 1.00; s.camLiftMm = 11.6; s.flowAtten = 1.16;
            // 72-deg crank throws, classic 1-2-4-5-3 firing every 144 deg -> unmistakable 2.5x half-order warble!
            s.journalDegs = { 0.0, 144.0, 576.0, 288.0, 432.0 };
            s.cyls = {
                {0, 0, 0,   0.0, 5.2, 0.92},
                {0, 1, 0, 144.0, 3.8, 0.98},
                {0, 2, 0, 576.0, 2.8, 0.95},
                {0, 3, 1, 288.0, 3.8, 1.00},
                {0, 4, 1, 432.0, 5.2, 0.94},
            };
            s.acoustic = { 82.0f, 6.0f, 310.0f, 1.50f, 4.9f, 1540.0f, 1.90f, 5.0f, 455.0f, 0.40f, 3.8f, 4.4f, 0.34f, 1.92f, 8000.0f, 2.5f, true, false };
            break;
        }
        case EngineVoice::V8Supercharged:
        case EngineVoice::V8Crossplane:
        default: {
            // GM LS / Hellcat 6.2L Cross-Plane V8 (7200 RPM deep muscle rumble)
            const bool isSC = (voice == EngineVoice::V8Supercharged);
            s.name = isSC ? "OpenGrid Hellhound 6.2L SC V8" : "OpenGrid 6.2L Cross-Plane V8";
            s.redlineRpm = 7400.0;
            s.boreMm = 96.0; s.strokeMm = 92.0; s.rodMm = 160.0; s.chamberCc = 82.0;
            s.numBanks = 2; s.bank0Deg = -45.0; s.bank1Deg = 45.0; s.tdcDeg = 90.0 - 45.0;
            s.frictionLbFt = 15.0;
            s.intakeFlowCfm = isSC ? 1120.0 : 880.0; s.runnerFlowCfm = 145.0; s.runnerLenIn = 12.0;
            s.exOutletCfm = 1250.0; s.exPrimaryLenIn = 29.0; s.exPrimaryCfm = 560.0;
            s.exLen0In = 98.0; s.exLen1In = 140.0; // authentic unequal cross-plane V8 burble!
            s.exVol0 = 0.36; s.exVol1 = 0.36; s.exVelDecay = 0.8;
            s.camDurDeg = 228.0; s.camGamma = 0.95; s.camLiftMm = 14.5; s.flowAtten = 1.08;
            s.journalDegs = { 0.0, 270.0, 90.0, 180.0 };
            s.cyls = {
                {0, 0, 0, 0 * 90.0, 2.0, 0.98}, {0, 1, 0, 7 * 90.0, 6.0, 0.92},
                {0, 2, 0, 5 * 90.0, 4.0, 1.04}, {0, 3, 0, 2 * 90.0, 8.0, 0.95},
                {1, 0, 1, 3 * 90.0, 3.0, 1.00}, {1, 1, 1, 6 * 90.0, 7.0, 0.90},
                {1, 2, 1, 4 * 90.0, 5.0, 0.96}, {1, 3, 1, 1 * 90.0, 1.0, 1.02},
            };
            s.acoustic = { 74.0f, 6.8f, 290.0f, 1.3f, 4.8f, 1280.0f, 1.6f, 4.2f, 380.0f, 0.42f, 4.3f, 5.1f, 0.32f, 1.95f, 7200.0f, 4.0f, false, isSC };
            break;
        }
    }
    return s;
}

std::unique_ptr<Function> makeHarmonicLobe(double durDeg, double liftMm, double gamma) {
    auto fn = std::make_unique<Function>();
    const double dur = durDeg * units::deg;
    const double lift = liftMm * units::mm;
    const double step = 1.0 * units::deg;
    const int steps = std::max(8, static_cast<int>(std::round((dur * 0.5) / step)) + 2);
    fn->initialize(steps * 2 + 2, 0.5 * units::deg);
    const double extents = dur * 0.5;
    const double k = kPi / extents;
    for (int i = 0; i <= steps; ++i) {
        if (i == 0) {
            fn->addSample(0.0, lift);
        } else {
            const double x = i * step;
            const double y = (x >= extents) ? 0.0 : lift * std::pow(0.5 + 0.5 * std::cos(k * x), gamma);
            fn->addSample(x, y);
            fn->addSample(-x, y);
        }
    }
    return fn;
}

std::unique_ptr<Function> makeFlowCurve(const std::vector<std::pair<double, double>>& pts, double liftScale, double flowAtten) {
    auto fn = std::make_unique<Function>();
    fn->initialize(static_cast<int>(pts.size()) + 2, 50.0 * units::thou);
    for (const auto& p : pts) {
        fn->addSample(p.first * units::thou * liftScale, GasSystem::k_28inH2O(p.second * flowAtten));
    }
    return fn;
}

std::unique_ptr<Function> makeTurbulenceCurve() {
    auto fn = std::make_unique<Function>();
    fn->initialize(12, 5.0);
    const double vals[10] = { 3.0, 7.5, 17.5, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0 };
    for (int i = 0; i < 10; ++i) fn->addSample(i * 5.0, vals[i]);
    return fn;
}

std::unique_ptr<Function> makeTimingCurve(double maxRpm) {
    auto fn = std::make_unique<Function>();
    fn->initialize(12, 1000.0 * units::rpm(1.0));
    fn->addSample(units::rpm(0.0), 12.0 * units::deg);
    fn->addSample(units::rpm(1000.0), 14.0 * units::deg);
    fn->addSample(units::rpm(2000.0), 22.0 * units::deg);
    fn->addSample(units::rpm(3000.0), 30.0 * units::deg);
    fn->addSample(units::rpm(4000.0), 38.0 * units::deg);
    fn->addSample(units::rpm(6000.0), 40.0 * units::deg);
    fn->addSample(units::rpm(8000.0), 40.0 * units::deg);
    fn->addSample(units::rpm(maxRpm + 2000.0), 40.0 * units::deg);
    return fn;
}

// ---- Physical Unburnt-Fuel Exhaust Detonation & Overrun Burble Generator ---------------------

struct ExhaustPopVoice {
    bool active = false;
    bool isBurble = false;
    float age = 0.0f;
    float duration = 0.24f;
    float intensity = 0.8f;
    float subFreq = 76.0f;
    float phase = 0.0f;
    float ringPhase = 0.0f;
    float ringFreq = 260.0f;
    float lpState = 0.0f;
    float hpState = 0.0f;
};

// ---- Forza Horizon 6 Camera Perspective Mixing Targets ---------------------------------------

struct PerspectiveMix {
    float exhaustGain = 1.0f;
    float stereoWidth = 0.85f;
    float popGain = 1.0f;
    float intakeGain = 1.0f;
    float turboScGain = 1.0f;
    float mechGain = 0.42f;
    float gearWhineGain = 0.48f;
    float envRefGain = 1.0f;
    float cabinLpHz = 15500.0f;
    float cabinBoomDb = 0.0f;
    float cabinDampDb = 0.0f;
};

PerspectiveMix getPerspectiveTarget(CameraPerspective p) {
    PerspectiveMix m{};
    switch (p) {
        case CameraPerspective::ExteriorRear:
            // Full tailpipe punch, wide stereo banks, strong overrun pops & crackles, moderate intake
            m.exhaustGain   = 1.18f;
            m.stereoWidth   = 1.00f;
            m.popGain       = 1.28f;
            m.intakeGain    = 0.68f;
            m.turboScGain   = 0.78f;
            m.mechGain      = 0.25f;
            m.gearWhineGain = 0.30f;
            m.envRefGain    = 1.00f;
            m.cabinLpHz     = 16500.0f;
            m.cabinBoomDb   = 0.0f;
            m.cabinDampDb   = 0.0f;
            break;
        case CameraPerspective::HoodBumper:
            // Loud induction plenum roar (+5 dB), crisp valvetrain tick, prominent turbo/SC, tighter exhaust
            m.exhaustGain   = 0.74f;
            m.stereoWidth   = 0.55f;
            m.popGain       = 0.65f;
            m.intakeGain    = 1.78f;
            m.turboScGain   = 1.55f;
            m.mechGain      = 1.35f;
            m.gearWhineGain = 0.72f;
            m.envRefGain    = 0.88f;
            m.cabinLpHz     = 14800.0f;
            m.cabinBoomDb   = 1.0f;
            m.cabinDampDb   = 0.0f;
            break;
        case CameraPerspective::InteriorCockpit:
            // Warm low-passed cabin exhaust (<2.8 kHz), boosted 68-115 Hz chassis boom, clear intake + gearbox whine
            m.exhaustGain   = 0.78f;
            m.stereoWidth   = 0.46f;
            m.popGain       = 0.68f;
            m.intakeGain    = 1.35f;
            m.turboScGain   = 1.18f;
            m.mechGain      = 0.88f;
            m.gearWhineGain = 1.32f;
            m.envRefGain    = 0.52f;
            m.cabinLpHz     = 2650.0f;
            m.cabinBoomDb   = 5.8f;
            m.cabinDampDb   = -2.4f;
            break;
        case CameraPerspective::ExteriorChase:
        default:
            // Balanced hero mix (exhaust body + tailpipe bark + intake + turbo/SC + environment reflections)
            m.exhaustGain   = 1.00f;
            m.stereoWidth   = 0.85f;
            m.popGain       = 1.00f;
            m.intakeGain    = 1.00f;
            m.turboScGain   = 1.00f;
            m.mechGain      = 0.42f;
            m.gearWhineGain = 0.48f;
            m.envRefGain    = 1.00f;
            m.cabinLpHz     = 15500.0f;
            m.cabinBoomDb   = 0.0f;
            m.cabinDampDb   = 0.0f;
            break;
    }
    return m;
}

// ---- Dedicated 4-Rotor 26B Peripheral-Port Wankel Combustion Core ----------------------------

struct Rotary4Core {
    double eShaftRad = 0.0;
    double lopePhase = 0.0;
    float prevP[4] = {};

    // Outputs dual-bank stereo exhaust (rotors 0,2 -> L; rotors 1,3 -> R) + intake + rotor mechanical pulse
    void step(double dt, float rpm, float throttle, bool ignCut,
              float& exL, float& exR, float& intake, float& mech, FastRng& rng) {
        const double omega = std::max(55.0, static_cast<double>(rpm) * (2.0 * kPi / 60.0));
        // Signature aggressive peripheral-port idle "brap-brap-brap" cyclic dispersion below 2200 RPM
        const float idleFactor = clampf((2200.0f - rpm) / 1400.0f, 0.0f, 1.0f);
        lopePhase += dt * (9.5 + 3.5 * idleFactor);
        const double brapMod = 1.0 + 0.055 * idleFactor * std::sin(lopePhase * 2.0 * kPi);
        eShaftRad += omega * brapMod * dt;
        if (eShaftRad > 1e6) eShaftRad = std::fmod(eShaftRad, 2.0 * kPi);

        const float loadGain = 0.32f + 0.68f * std::pow(clampf(throttle, 0.0f, 1.0f), 0.78f);
        const float cutScale = ignCut ? 0.14f : 1.0f;
        const float rpmNorm = clampf((rpm - 900.0f) / 9300.0f, 0.0f, 1.0f);

        float sumL = 0.0f, sumR = 0.0f, sumIn = 0.0f, sumMech = 0.0f;
        for (int r = 0; r < 4; ++r) {
            // 4 rotors phased 90 deg apart on eccentric shaft (one firing every 90 deg!)
            const double ph = std::fmod(eShaftRad + r * (kPi * 0.5), 2.0 * kPi);
            const double u = ph / (2.0 * kPi); // 0..1 per combustion event

            // Sharp peripheral-port exhaust blowdown impulse (steep shock rise + asymmetric exponential tail)
            float blowdown = 0.0f;
            if (u < 0.42) {
                const float t = static_cast<float>(u / 0.42);
                const float sharp = 3.2f + 3.8f * rpmNorm;
                blowdown = std::pow(t, 0.42f) * std::exp(-sharp * t);
            }
            // Secondary port-overlap scavenging pulse (gives 26B its singing 2nd/3rd harmonic chime!)
            const float overlap = 0.28f * std::sin(static_cast<float>(ph) * 2.0f + 0.4f) * std::exp(-2.8f * static_cast<float>(u))
                                + 0.16f * std::sin(static_cast<float>(ph) * 3.0f - 0.3f) * (0.3f + 0.7f * rpmNorm);

            // Peripheral-port idle misfire-cadence brap modulation
            const float brapGate = (idleFactor > 0.02f)
                ? (1.0f - 0.48f * idleFactor * ((r & 1) ? std::max(0.0f, static_cast<float>(std::sin(lopePhase * 2.0 * kPi)))
                                                        : std::max(0.0f, static_cast<float>(-std::sin(lopePhase * 2.0 * kPi)))))
                : 1.0f;

            const float cyl = (blowdown * 2.15f + overlap) * loadGain * cutScale * brapGate
                            * (1.0f + 0.06f * rng.nextSigned());
            // Differentiate pressure slightly to model acoustic velocity out of the peripheral exhaust port
            const float ac = cyl - 0.62f * prevP[r];
            prevP[r] = cyl;

            if ((r & 1) == 0) sumL += ac; else sumR += ac;
            // Intake port suction occurs ~180 deg offset from exhaust opening
            const float inWave = std::sin(static_cast<float>(ph) + 2.6f) * (0.4f + 0.6f * std::sin(static_cast<float>(ph) * 2.0f));
            sumIn += inWave * (0.25f + 0.75f * throttle);
            // Apex-seal + stationary gear mechanical tick pulse
            sumMech += std::sin(static_cast<float>(ph) * 3.0f) * (0.35f + 0.65f * blowdown);
        }

        exL = sumL * 0.48f;
        exR = sumR * 0.48f;
        intake = sumIn * 0.22f;
        mech = sumMech * 0.18f;
    }
};

}  // namespace

// ---- EngineAudioSynth::Impl ------------------------------------------------------------------

struct EngineAudioSynth::Impl {
    EngineAudioConfig cfg{};
    EngineAudioControl ctrl{};
    PresetSpec preset{};
    bool initialized = false;
    bool isRotary = false;

    // Owned engine-sim objects (strict RAII cleanup -> zero ASan leaks!)
    std::unique_ptr<Engine> engine;
    std::unique_ptr<Vehicle> vehicle;
    std::unique_ptr<Transmission> transmission;
    std::unique_ptr<PistonEngineSimulator> sim;
    std::vector<std::unique_ptr<Function>> ownedFunctions;
    std::vector<std::unique_ptr<Camshaft>> ownedCamshafts;
    std::vector<std::unique_ptr<StandardValvetrain>> ownedValvetrains;
    std::vector<std::unique_ptr<ImpulseResponse>> ownedIrs;

    Rotary4Core rotary;

    // Resampling state between thermodynamic solver rate (e.g. 5-10 kHz) and audio rate (48 kHz)
    double simAccum = 0.0;
    float curExL = 0.0f;
    float curExR = 0.0f;
    float curIn = 0.0f;
    float curMech = 0.0f;
    float prevMechSample = 0.0f;
    float measuredRpm = 950.0f;

    // Smoothed controls
    float smoothRpm = 950.0f;
    float prevSmoothRpm = 950.0f;
    float rpmSlope = 0.0f;
    float smoothThr = 0.08f;
    float smoothLoad = 0.08f;
    float smoothBoost = 0.0f;
    float prevThr = 0.08f;
    float prevBoost = 0.0f;
    float smoothTunnel = 0.0f;
    float smoothWallL = 0.0f;
    float smoothWallR = 0.0f;
    float smoothGearWhine = 0.0f;
    float smoothGearWhineHz = 0.0f;
    float smoothSpeedMps = 0.0f;
    float smoothWetRoad = 0.0f;
    float smoothOverpass = 0.0f;
    float camCrossoverEnv = 0.0f;
    float exhaustGasTemp = 0.20f; // 0..1 normalized header gas temp (shifts standing-wave speed of sound up to ~6%)

    // Smooth camera perspective crossfade (~40 ms time constant -> zero-click camera switching!)
    PerspectiveMix curPersp{};
    float lastFilterCabinLpHz = 15500.0f;
    float lastFilterBoomDb = 0.0f;
    float lastFilterDampDb = 0.0f;

    // Automatic RMS level tracker (keeps all 10 engines evenly loud without pumping)
    float envRms = 0.08f;

    // Dual-channel Forza acoustic mastering DSP (exhaust + intake + cabin + waveguide + reflections)
    Biquad aaLpL, aaLpR, aaLpIn;
    Biquad dcHpL, dcHpR, dcHpIn;
    Biquad subShelfL, subShelfR;
    Biquad bodyEqL, bodyEqR;
    Biquad raspEqL, raspEqR;
    Biquad decelEqL, decelEqR;
    Biquad toneLpL, toneLpR;
    Biquad intakeBp, intakeLp;

    // Perspective / Interior Cockpit acoustic shaping
    Biquad cabinExLpL, cabinExLpR;
    Biquad cabinBoomEqL, cabinBoomEqR;
    Biquad cabinDampEqL, cabinDampEqR;
    Biquad cabinRefLpL, cabinRefLpR;

    // Valvetrain / injector mechanical texture & straight-cut gearbox whine filters
    Biquad mechHp, mechBp;
    Biquad gearBp, gearLp;
    float gearPhase1 = 0.0f;
    float gearPhase2 = 0.0f;

    // Exhaust waveguide + early asphalt reflections + stereo canyon walls + 8-channel orthogonal Householder tunnel FDN
    DelayLine<1024> headerCombL, headerCombR;
    DelayLine<2048> erDelayL, erDelayR;
    DelayLine<512> haasDelayR;
    DelayLine<4096> wallDelayL, wallDelayR;
    std::array<DelayLine<8192>, 8> tunnelFdn{};
    std::array<float, 8> fdnLp{};
    float fdnInHpL = 0.0f, fdnInHpR = 0.0f;
    float wallLpL = 0.0f, wallLpR = 0.0f;
    Biquad wetSpecHpL, wetSpecHpR;
    Biquad wastegateBp;
    Biquad camBarkEq;

    // Forced induction DSP (Turbo spool + compressor surge BOV flutter + Helical Supercharger)
    float turboPhase = 0.0f;
    float scPhase = 0.0f;
    Biquad turboNoiseBp, flutterBp;
    float flutterEnv = 0.0f;
    float flutterAge = 0.0f;
    float flutterRateHz = 13.5f;
    float flutterDur = 0.52f;

    // Unburnt-fuel exhaust detonation & overrun burble pool (up to 6 overlapping voices)
    std::array<ExhaustPopVoice, 6> pops{};
    float autoPopCooldown = 0.0f;
    float autoBurbleCooldown = 0.0f;

    // Physical 4-compression-stroke starter crank & catch-flare state
    float starterPhase = 0.0f;
    float starterCompPhase = 0.0f;
    float starterTimer = 0.0f;
    float starterDuration = 0.42f;
    float starterFlareTimer = 0.0f;
    float starterFlareDur = 0.28f;
    bool prevCtrlStarter = false;
    Biquad starterBp;

    FastRng rng;

    ~Impl() { teardownEngineSim(); }

    void teardownEngineSim() {
        if (sim) {
            sim->destroy();
            sim.reset();
        }
        if (engine) {
            engine->destroy();
            engine.reset();
        }
        vehicle.reset();
        transmission.reset();
        ownedValvetrains.clear();
        for (auto& c : ownedCamshafts) if (c) c->destroy();
        ownedCamshafts.clear();
        for (auto& f : ownedFunctions) if (f) f->destroy();
        ownedFunctions.clear();
        ownedIrs.clear();
    }

    void updatePerspectiveFilters(float fs) {
        const float lpCut = clampf(curPersp.cabinLpHz, 1200.0f, fs * 0.44f);
        const float refLpCut = clampf(curPersp.cabinLpHz * 1.12f, 1600.0f, fs * 0.44f);
        cabinExLpL.setLowpass(fs, lpCut, 0.72f);
        cabinExLpR.setLowpass(fs, lpCut, 0.72f);
        cabinRefLpL.setLowpass(fs, refLpCut, 0.707f);
        cabinRefLpR.setLowpass(fs, refLpCut, 0.707f);
        cabinBoomEqL.setPeaking(fs, 90.0f, 1.30f, curPersp.cabinBoomDb);
        cabinBoomEqR.setPeaking(fs, 90.0f, 1.30f, curPersp.cabinBoomDb);
        cabinDampEqL.setPeaking(fs, 1450.0f, 1.10f, curPersp.cabinDampDb);
        cabinDampEqR.setPeaking(fs, 1450.0f, 1.10f, curPersp.cabinDampDb);
        lastFilterCabinLpHz = curPersp.cabinLpHz;
        lastFilterBoomDb = curPersp.cabinBoomDb;
        lastFilterDampDb = curPersp.cabinDampDb;
    }

    void setupFilters() {
        const float fs = static_cast<float>(cfg.sampleRate);
        const auto& a = preset.acoustic;

        const float aaCut = std::min(3800.0f, static_cast<float>(cfg.simFrequency) * 0.44f);
        aaLpL.setLowpass(fs, aaCut, 0.707f);
        aaLpR.setLowpass(fs, aaCut, 0.707f);
        aaLpIn.setLowpass(fs, aaCut, 0.707f);

        dcHpL.setHighpass(fs, 26.0f, 0.707f);
        dcHpR.setHighpass(fs, 26.0f, 0.707f);
        dcHpIn.setHighpass(fs, 45.0f, 0.707f);

        float stageSubBoost = 0.0f;
        float stageRaspBoost = 0.0f;
        float stageLpMax = 9200.0f;
        if (cfg.exhaustStage == ExhaustStage::Stock) {
            stageSubBoost = -1.2f;
            stageRaspBoost = -2.6f;
            stageLpMax = 5800.0f;
        } else if (cfg.exhaustStage == ExhaustStage::RaceTitanium) {
            stageSubBoost = 1.4f;
            stageRaspBoost = 2.4f;
            stageLpMax = 12800.0f;
        }

        subShelfL.setLowShelf(fs, a.subHz, a.subGainDb + stageSubBoost);
        subShelfR.setLowShelf(fs, a.subHz, a.subGainDb + stageSubBoost);

        bodyEqL.setPeaking(fs, a.bodyHz, a.bodyQ, a.bodyGainDb);
        bodyEqR.setPeaking(fs, a.bodyHz, a.bodyQ, a.bodyGainDb);

        raspEqL.setPeaking(fs, a.raspHz, a.raspQ, a.raspGainDb + stageRaspBoost);
        raspEqR.setPeaking(fs, a.raspHz, a.raspQ, a.raspGainDb + stageRaspBoost);

        decelEqL.setPeaking(fs, a.bodyHz * 1.65f, 2.2f, 0.0f);
        decelEqR.setPeaking(fs, a.bodyHz * 1.65f, 2.2f, 0.0f);

        toneLpL.setLowpass(fs, stageLpMax, 0.75f);
        toneLpR.setLowpass(fs, stageLpMax, 0.75f);

        intakeBp.setBandpass(fs, a.intakeHz, 1.35f);
        intakeLp.setLowpass(fs, 3600.0f, 0.8f);

        turboNoiseBp.setBandpass(fs, 3200.0f, 2.8f);
        flutterBp.setBandpass(fs, 1150.0f, 3.2f);

        mechHp.setHighpass(fs, 1350.0f, 0.75f);
        mechBp.setBandpass(fs, 3250.0f, 1.45f);
        gearBp.setBandpass(fs, 1200.0f, 1.55f);
        gearLp.setLowpass(fs, 4400.0f, 0.75f);
        starterBp.setBandpass(fs, 380.0f, 1.25f);
        wetSpecHpL.setHighpass(fs, 2400.0f, 0.707f);
        wetSpecHpR.setHighpass(fs, 2400.0f, 0.707f);
        wastegateBp.setBandpass(fs, 1450.0f, 1.25f);
        camBarkEq.setPeaking(fs, a.intakeHz * 2.2f, 1.6f, 0.0f);

        updatePerspectiveFilters(fs);
    }

    void resetDspState() {
        aaLpL.reset(); aaLpR.reset(); aaLpIn.reset();
        dcHpL.reset(); dcHpR.reset(); dcHpIn.reset();
        subShelfL.reset(); subShelfR.reset();
        bodyEqL.reset(); bodyEqR.reset();
        raspEqL.reset(); raspEqR.reset();
        decelEqL.reset(); decelEqR.reset();
        toneLpL.reset(); toneLpR.reset();
        intakeBp.reset(); intakeLp.reset();
        cabinExLpL.reset(); cabinExLpR.reset();
        cabinBoomEqL.reset(); cabinBoomEqR.reset();
        cabinDampEqL.reset(); cabinDampEqR.reset();
        cabinRefLpL.reset(); cabinRefLpR.reset();
        mechHp.reset(); mechBp.reset();
        gearBp.reset(); gearLp.reset();
        turboNoiseBp.reset(); flutterBp.reset();
        starterBp.reset();
        wetSpecHpL.reset(); wetSpecHpR.reset();
        wastegateBp.reset(); camBarkEq.reset();

        headerCombL.reset();
        headerCombR.reset();
        erDelayL.reset();
        erDelayR.reset();
        haasDelayR.reset();
        wallDelayL.reset();
        wallDelayR.reset();
        for (auto& d : tunnelFdn) d.reset();
        fdnLp.fill(0.0f);
        fdnInHpL = fdnInHpR = 0.0f;
        wallLpL = wallLpR = 0.0f;
    }

    bool init(const EngineAudioConfig& newCfg) {
        teardownEngineSim();
        cfg = newCfg;
        cfg.sampleRate = std::max(22050, std::min(96000, cfg.sampleRate));
        cfg.simFrequency = std::max(3000, std::min(12000, cfg.simFrequency));
        cfg.fluidSubsteps = std::max(2, std::min(8, cfg.fluidSubsteps));

        preset = getPreset(cfg.voice);
        isRotary = (cfg.voice == EngineVoice::Rotary4);
        ctrl = EngineAudioControl{};
        ctrl.exhaustStage = cfg.exhaustStage;
        ctrl.turboEnabled = cfg.turboEnabled;

        simAccum = 0.0;
        curExL = curExR = curIn = curMech = prevMechSample = 0.0f;
        smoothRpm = prevSmoothRpm = 950.0f;
        rpmSlope = 0.0f;
        smoothThr = smoothLoad = prevThr = 0.08f;
        smoothBoost = prevBoost = 0.0f;
        smoothTunnel = smoothWallL = smoothWallR = 0.0f;
        smoothGearWhine = smoothSpeedMps = 0.0f;
        exhaustGasTemp = 0.20f;
        curPersp = getPerspectiveTarget(ctrl.perspective);
        envRms = 0.08f;
        flutterEnv = 0.0f;
        autoPopCooldown = 0.0f;
        autoBurbleCooldown = 0.0f;
        starterPhase = starterCompPhase = 0.0f;
        starterTimer = starterFlareTimer = 0.0f;
        prevCtrlStarter = false;
        gearPhase1 = gearPhase2 = 0.0f;
        for (auto& p : pops) p.active = false;

        batchExL.reserve(1024);
        batchExR.reserve(1024);
        batchIn.reserve(1024);
        batchMech.reserve(1024);

        setupFilters();
        resetDspState();

        if (isRotary) {
            rotary = Rotary4Core{};
            initialized = true;
            return true;
        }

        // Build full multi-cylinder thermodynamic engine-sim instance (zero external WAV I/O!)
        const auto& s = preset;
        engine = std::make_unique<Engine>();

        DirectThrottleLinkage* throttle = new DirectThrottleLinkage;
        DirectThrottleLinkage::Parameters tp{};
        tp.gamma = 1.8;
        throttle->initialize(tp);

        const int nCyl = static_cast<int>(s.cyls.size());
        Engine::Parameters ep{};
        ep.cylinderBanks = s.numBanks;
        ep.cylinderCount = nCyl;
        ep.crankshaftCount = 1;
        ep.exhaustSystemCount = 2;
        ep.intakeCount = 1;
        ep.name = s.name;
        ep.starterTorque = units::torque(200.0, units::ft_lb);
        ep.starterSpeed = units::rpm(220.0);
        ep.redline = units::rpm(s.redlineRpm);
        ep.dynoMinSpeed = units::rpm(500.0);
        ep.dynoMaxSpeed = units::rpm(s.redlineRpm + 1000.0);
        ep.dynoHoldStep = units::rpm(100.0);
        ep.throttle = throttle; // owned by Engine::destroy()
        ep.initialSimulationFrequency = static_cast<double>(cfg.simFrequency);
        ep.initialHighFrequencyGain = 0.01;
        ep.initialNoise = 0.0;
        ep.initialJitter = 0.0;
        engine->initialize(ep);

        // Minimal ImpulseResponse placeholders (we process physical L/R collector & intake waves directly!)
        for (int eIdx = 0; eIdx < 2; ++eIdx) {
            auto ir = std::make_unique<ImpulseResponse>();
            ir->initialize("", 0.01);
            ExhaustSystem::Parameters esp{};
            esp.length = units::distance(eIdx == 0 ? s.exLen0In : s.exLen1In, units::inch);
            esp.collectorCrossSectionArea = units::area(16.0, units::cm2);
            esp.outletFlowRate = GasSystem::k_carb(s.exOutletCfm);
            esp.primaryTubeLength = units::distance(s.exPrimaryLenIn, units::inch);
            esp.primaryFlowRate = GasSystem::k_carb(s.exPrimaryCfm);
            esp.velocityDecay = s.exVelDecay;
            esp.audioVolume = (eIdx == 0 ? s.exVol0 : s.exVol1);
            esp.impulseResponse = ir.get();
            engine->getExhaustSystem(eIdx)->initialize(esp);
            ownedIrs.push_back(std::move(ir));
        }

        // Intake manifold
        Intake::Parameters ip{};
        ip.volume = s.intakePlenumL * units::L;
        ip.CrossSectionArea = 20.0 * units::cm2;
        ip.InputFlowK = GasSystem::k_carb(s.intakeFlowCfm);
        ip.IdleFlowK = GasSystem::k_carb(0.0);
        ip.RunnerFlowRate = GasSystem::k_carb(s.runnerFlowCfm);
        ip.IdleThrottlePlatePosition = s.idlePlatePos;
        ip.RunnerLength = units::distance(s.runnerLenIn, units::inch);
        ip.VelocityDecay = 0.5;
        engine->getIntake(0)->initialize(ip);

        // Crankshaft
        const double stroke = s.strokeMm * units::mm;
        const double bore = s.boreMm * units::mm;
        const double rodLen = s.rodMm * units::mm;
        const double compH = 1.0 * units::inch;
        const double flyR = s.flywheelRadiusIn * units::inch;
        const double crankI = 0.75 * s.crankMassKg * stroke * stroke
                            + 0.5 * s.flywheelMassKg * flyR * flyR + 0.01;

        Crankshaft* crank = engine->getCrankshaft(0);
        Crankshaft::Parameters cp{};
        cp.mass = s.crankMassKg;
        cp.flywheelMass = s.flywheelMassKg;
        cp.momentOfInertia = crankI;
        cp.crankThrow = stroke * 0.5;
        cp.pos_x = 0.0;
        cp.pos_y = 0.0;
        cp.tdc = s.tdcDeg * units::deg;
        cp.frictionTorque = units::torque(s.frictionLbFt, units::ft_lb);
        cp.rodJournals = static_cast<int>(s.journalDegs.size());
        crank->initialize(cp);
        for (size_t j = 0; j < s.journalDegs.size(); ++j) {
            crank->setRodJournalAngle(static_cast<int>(j), s.journalDegs[j] * units::deg);
        }

        // Valve lift & flow curves
        auto inLobe = makeHarmonicLobe(s.camDurDeg, s.camLiftMm, s.camGamma);
        auto exLobe = makeHarmonicLobe(s.camDurDeg + 4.0, s.camLiftMm * 0.96, s.camGamma);
        const std::vector<std::pair<double, double>> inPts = {
            {0, 0}, {50, 58}, {100, 103}, {150, 156}, {200, 214},
            {250, 249}, {300, 268}, {350, 280}, {400, 280}, {450, 281}
        };
        const std::vector<std::pair<double, double>> exPts = {
            {0, 0}, {50, 37}, {100, 72}, {150, 113}, {200, 160},
            {250, 196}, {300, 222}, {350, 235}, {400, 245}, {450, 246}
        };
        auto inFlow = makeFlowCurve(inPts, 1.0, s.flowAtten);
        auto exFlow = makeFlowCurve(exPts, 1.0, s.flowAtten);
        auto turbCurve = makeTurbulenceCurve();
        auto timingCurve = makeTimingCurve(s.redlineRpm);
        auto mpsToTurb = std::make_unique<Function>();
        mpsToTurb->initialize(32, 1.0);
        for (int i = 0; i < 30; ++i) mpsToTurb->addSample(static_cast<double>(i), i * 0.5);

        // Group cylinders by bank (exact engine-sim convention)
        std::vector<std::vector<int>> bankCyls(s.numBanks);
        for (int i = 0; i < nCyl; ++i) bankCyls[s.cyls[i].bank].push_back(i);

        int cylGlobal = 0;
        std::vector<int> specToGlobal(nCyl, 0);

        for (int b = 0; b < s.numBanks; ++b) {
            const int bCount = static_cast<int>(bankCyls[b].size());
            CylinderBank* bank = engine->getCylinderBank(b);
            CylinderBank::Parameters bp{};
            bp.crankshaft = crank;
            bp.positionX = 0.0;
            bp.positionY = 0.0;
            bp.angle = (b == 0 ? s.bank0Deg : s.bank1Deg) * units::deg;
            bp.bore = bore;
            bp.deckHeight = stroke * 0.5 + rodLen + compH;
            bp.displayDepth = 0.0;
            bp.cylinderCount = bCount;
            bp.index = b;
            bank->initialize(bp);

            auto inCam = std::make_unique<Camshaft>();
            auto exCam = std::make_unique<Camshaft>();
            Camshaft::Parameters inCp{};
            inCp.lobes = bCount;
            inCp.advance = 0.0;
            inCp.crankshaft = crank;
            inCp.lobeProfile = inLobe.get();
            inCp.baseRadius = 0.9 * units::inch;
            inCam->initialize(inCp);

            Camshaft::Parameters exCp = inCp;
            exCp.lobeProfile = exLobe.get();
            exCam->initialize(exCp);

            for (int loc = 0; loc < bCount; ++loc) {
                const int si = bankCyls[b][loc];
                const CylSpec& cs = s.cyls[si];
                specToGlobal[si] = cylGlobal;

                Piston* piston = engine->getPiston(cylGlobal);
                ConnectingRod* rod = engine->getConnectingRod(cylGlobal);

                Piston::Parameters pp{};
                pp.Rod = rod;
                pp.Bank = bank;
                pp.CylinderIndex = loc;
                pp.BlowbyFlowCoefficient = 0.0;
                pp.CompressionHeight = compH;
                pp.WristPinPosition = 0.0;
                pp.Displacement = 0.0;
                pp.mass = 0.12;
                piston->initialize(pp);

                ConnectingRod::Parameters rp{};
                rp.mass = 0.08;
                rp.momentOfInertia = (1.0 / 12.0) * rp.mass * rodLen * rodLen;
                rp.centerOfMass = 0.0;
                rp.length = rodLen;
                rp.piston = piston;
                rp.crankshaft = crank;
                rp.journal = cs.journalIdx;
                rod->initialize(rp);

                exCam->setLobeCenterline(loc, (360.0 - s.exhaustLobeCenterDeg + cs.fireDeg) * units::deg);
                inCam->setLobeCenterline(loc, (360.0 + s.intakeLobeCenterDeg + cs.fireDeg) * units::deg);
                ++cylGlobal;
            }

            auto vt = std::make_unique<StandardValvetrain>();
            StandardValvetrain::Parameters vtp{};
            vtp.intakeCamshaft = inCam.get();
            vtp.exhaustCamshaft = exCam.get();
            vt->initialize(vtp);

            CylinderHead* head = engine->getHead(b);
            CylinderHead::Parameters hp{};
            hp.Bank = bank;
            hp.ExhaustPortFlow = exFlow.get();
            hp.IntakePortFlow = inFlow.get();
            hp.Valvetrain = vt.get();
            hp.CombustionChamberVolume = s.chamberCc * units::cc;
            hp.IntakeRunnerVolume = 149.6 * units::cc;
            hp.IntakeRunnerCrossSectionArea = (2.0 * units::inch) * (2.0 * units::inch);
            hp.ExhaustRunnerVolume = 50.0 * units::cc;
            hp.ExhaustRunnerCrossSectionArea = (1.85 * units::inch) * (1.85 * units::inch);
            hp.FlipDisplay = (b == 0);
            head->initialize(hp);

            for (int loc = 0; loc < bCount; ++loc) {
                const CylSpec& cs = s.cyls[bankCyls[b][loc]];
                head->setIntake(loc, engine->getIntake(0));
                head->setExhaustSystem(loc, engine->getExhaustSystem(cs.exhaustIdx));
                head->setSoundAttenuation(loc, cs.atten);
                head->setHeaderPrimaryLength(loc, cs.primaryCm * units::cm);
            }

            ownedCamshafts.push_back(std::move(inCam));
            ownedCamshafts.push_back(std::move(exCam));
            ownedValvetrains.push_back(std::move(vt));
        }

        // Ignition module
        IgnitionModule::Parameters imp{};
        imp.cylinderCount = nCyl;
        imp.crankshaft = crank;
        imp.timingCurve = timingCurve.get();
        imp.revLimit = units::rpm(s.redlineRpm + 500.0);
        imp.limiterDuration = 0.08;
        engine->getIgnitionModule()->initialize(imp);
        for (int i = 0; i < nCyl; ++i) {
            engine->getIgnitionModule()->setFiringOrder(specToGlobal[i], s.cyls[i].fireDeg * units::deg);
        }
        engine->getIgnitionModule()->m_enabled = true;

        // Fuel & combustion chambers
        Fuel::Parameters fp{};
        fp.maxBurningEfficiency = 1.0;
        fp.burningEfficiencyRandomness = 0.16;
        fp.turbulenceToFlameSpeedRatio = turbCurve.get();
        engine->getFuel()->initialize(fp);

        CombustionChamber::Parameters ccp{};
        ccp.CrankcasePressure = units::pressure(1.0, units::atm);
        ccp.Fuel = engine->getFuel();
        ccp.StartingPressure = units::pressure(1.0, units::atm);
        ccp.StartingTemperature = 298.15;
        ccp.MeanPistonSpeedToTurbulence = mpsToTurb.get();
        for (int i = 0; i < nCyl; ++i) {
            ccp.Piston = engine->getPiston(i);
            ccp.Head = engine->getHead(ccp.Piston->getCylinderBank()->getIndex());
            engine->getChamber(i)->initialize(ccp);
        }

        engine->calculateDisplacement();

        ownedFunctions.push_back(std::move(inLobe));
        ownedFunctions.push_back(std::move(exLobe));
        ownedFunctions.push_back(std::move(inFlow));
        ownedFunctions.push_back(std::move(exFlow));
        ownedFunctions.push_back(std::move(turbCurve));
        ownedFunctions.push_back(std::move(timingCurve));
        ownedFunctions.push_back(std::move(mpsToTurb));

        // Minimal vehicle & transmission for dyno coupling
        vehicle = std::make_unique<Vehicle>();
        Vehicle::Parameters vp{};
        vp.mass = 1400.0;
        vp.dragCoefficient = 0.30;
        vp.crossSectionArea = 2.0;
        vp.diffRatio = 3.6;
        vp.tireRadius = 0.33;
        vp.rollingResistance = 200.0;
        vehicle->initialize(vp);

        transmission = std::make_unique<Transmission>();
        static const double kGears[6] = { 3.2, 2.2, 1.6, 1.25, 1.0, 0.82 };
        Transmission::Parameters trp{};
        trp.GearCount = 6;
        trp.GearRatios = kGears;
        trp.MaxClutchTorque = units::torque(800.0, units::ft_lb);
        transmission->initialize(trp);
        transmission->changeGear(-1); // neutral — dyno holds exact target RPM from rs_core / garage!

        sim = std::make_unique<PistonEngineSimulator>();
        Simulator::Parameters sp{};
        sp.systemType = Simulator::SystemType::NsvOptimized;
        sim->initialize(sp);
        sim->setSimulationFrequency(cfg.simFrequency);
        sim->setFluidSimulationSteps(cfg.fluidSubsteps);
        sim->loadSimulation(engine.get(), vehicle.get(), transmission.get());

        // Lock dyno speed control directly to target RPM from rs_core / garage
        sim->m_dyno.m_enabled = true;
        sim->m_dyno.m_hold = true;
        sim->m_dyno.m_rotationSpeed = units::rpm(950.0);
        sim->m_starterMotor.m_enabled = false;
        engine->getIgnitionModule()->m_enabled = true;
        engine->setSpeedControl(0.08);

        initialized = true;
        return true;
    }

    void stepSolverBatch(int steps, float rpm, float thr, bool ignCut,
                         std::vector<float>& outExL, std::vector<float>& outExR,
                         std::vector<float>& outIn, std::vector<float>& outMech) {
        outExL.clear();
        outExR.clear();
        outIn.clear();
        outMech.clear();
        if (steps <= 0) return;

        if (isRotary) {
            const double dt = 1.0 / static_cast<double>(cfg.simFrequency);
            for (int k = 0; k < steps; ++k) {
                float el = 0.0f, er = 0.0f, inS = 0.0f, mechS = 0.0f;
                rotary.step(dt, rpm, thr, ignCut, el, er, inS, mechS, rng);
                outExL.push_back(el);
                outExR.push_back(er);
                outIn.push_back(inS);
                outMech.push_back(mechS);
            }
            measuredRpm = rpm;
            return;
        }
        if (!sim || !engine) return;

        // Drive engine-sim's dynamometer & throttle directly from our live RPM + throttle!
        const double targetRpm = clampd(static_cast<double>(rpm), 420.0, preset.redlineRpm + 400.0);
        sim->m_dyno.m_rotationSpeed = units::rpm(targetRpm);
        engine->setSpeedControl(clampd(static_cast<double>(thr), 0.03, 1.0));
        engine->getIgnitionModule()->m_enabled = !ignCut;

        // Pass exact duration + 0.5-step epsilon so Simulator::startFrame(dt) NEVER truncates steps to 0!
        const double dtFrame = (static_cast<double>(steps) + 0.5) / static_cast<double>(cfg.simFrequency);
        sim->startFrame(dtFrame);
        while (sim->simulateStep()) {
            outExL.push_back(static_cast<float>(sim->getLastExhaustLeft()));
            outExR.push_back(static_cast<float>(sim->getLastExhaustRight()));
            outIn.push_back(static_cast<float>(sim->getLastIntakeSignal()));
            outMech.push_back(static_cast<float>(sim->getLastMechPulse()));
        }
        sim->endFrame();

        // Keep Synthesizer's internal buffer drained cleanly without running its slow O(N*M) convolution
        if (sim->synthesizer().getLatency() > 256) {
            int16_t trash[256];
            sim->synthesizer().readAudioOutput(256, trash);
        }
        measuredRpm = static_cast<float>(std::abs(engine->getRpm()));
    }

    // Reusable scratch buffers (pre-reserved in init() -> zero heap allocations inside render loop!)
    std::vector<float> batchExL, batchExR, batchIn, batchMech;

    void spawnPop(float intensity) {
        ExhaustPopVoice* slot = nullptr;
        float oldestAge = -1.0f;
        for (auto& p : pops) {
            if (!p.active) {
                slot = &p;
                break;
            }
            if (p.age > oldestAge) {
                oldestAge = p.age;
                slot = &p;
            }
        }
        if (!slot) return;
        slot->active = true;
        slot->isBurble = false;
        slot->age = 0.0f;
        slot->intensity = clampf(intensity, 0.25f, 1.5f);
        slot->duration = 0.17f + 0.14f * rng.next01();
        slot->subFreq = 64.0f + 26.0f * rng.next01();
        slot->ringFreq = 210.0f + 160.0f * rng.next01();
        slot->phase = 0.0f;
        slot->ringPhase = 0.0f;
        slot->lpState = 0.0f;
        slot->hpState = 0.0f;
    }

    void spawnBurble(float intensity) {
        ExhaustPopVoice* slot = nullptr;
        float oldestBurbleAge = -1.0f;
        for (auto& p : pops) {
            if (!p.active) {
                slot = &p;
                break;
            }
            if (p.isBurble && p.age > oldestBurbleAge) {
                oldestBurbleAge = p.age;
                slot = &p;
            }
        }
        if (!slot) return;
        slot->active = true;
        slot->isBurble = true;
        slot->age = 0.0f;
        slot->intensity = clampf(intensity, 0.15f, 1.25f);
        slot->duration = 0.085f + 0.090f * rng.next01();
        slot->subFreq = 140.0f + 75.0f * rng.next01();
        slot->ringFreq = 155.0f + 225.0f * rng.next01(); // 155..380 Hz warm exhaust-pipe burble band
        slot->phase = 0.0f;
        slot->ringPhase = 0.0f;
        slot->lpState = 0.0f;
        slot->hpState = 0.0f;
    }

    void triggerFlutter(float boostBar) {
        const float b = clampf(boostBar, 0.15f, 2.4f);
        flutterEnv = std::max(flutterEnv, clampf(0.45f + 0.42f * b, 0.4f, 1.25f));
        flutterAge = 0.0f;
        flutterRateHz = 11.5f + 4.0f * clampf(b * 0.5f, 0.0f, 1.0f);
        flutterDur = 0.42f + 0.18f * clampf(b * 0.5f, 0.0f, 1.0f);
    }

    void triggerStarter(float durationSec) {
        starterDuration = clampf(durationSec, 0.15f, 2.5f);
        starterTimer = starterDuration;
        starterFlareTimer = 0.0f;
        starterCompPhase = 0.0f;
    }

    void render(float* outL, float* outR, int numFrames) {
        if (!initialized || numFrames <= 0) {
            if (numFrames > 0) {
                if (outL) std::memset(outL, 0, sizeof(float) * static_cast<size_t>(numFrames));
                if (outR) std::memset(outR, 0, sizeof(float) * static_cast<size_t>(numFrames));
            }
            return;
        }

        const float fs = static_cast<float>(cfg.sampleRate);
        const float invFs = 1.0f / fs;
        const float twoPi = 2.0f * static_cast<float>(kPi);
        const double simPerAudio = static_cast<double>(cfg.simFrequency) / static_cast<double>(cfg.sampleRate);
        const auto& a = preset.acoustic;

        // Update exhaust stage if changed at runtime
        if (ctrl.exhaustStage != cfg.exhaustStage) {
            cfg.exhaustStage = ctrl.exhaustStage;
            setupFilters();
        }

        // Smooth block-level control transitions (zero zipper noise!)
        const float blockDt = static_cast<float>(numFrames) * invFs;
        const float rpmAlpha = 1.0f - std::exp(-blockDt / 0.018f);
        const float thrAlpha = 1.0f - std::exp(-blockDt / 0.022f);
        const float envAlpha = 1.0f - std::exp(-blockDt / 0.035f);
        smoothRpm += (clampf(ctrl.rpm, 420.0f, a.redlineRpm + 500.0f) - smoothRpm) * rpmAlpha;
        smoothThr += (clampf(ctrl.throttle, 0.0f, 1.0f) - smoothThr) * thrAlpha;
        smoothLoad += (clampf(ctrl.load, 0.0f, 1.0f) - smoothLoad) * thrAlpha;
        smoothBoost += (clampf(ctrl.boostBar, 0.0f, 2.5f) - smoothBoost) * (1.0f - std::exp(-blockDt / 0.045f));
        smoothTunnel += (clampf(ctrl.tunnelReflection, 0.0f, 1.0f) - smoothTunnel) * envAlpha;
        smoothWallL += (clampf(ctrl.wallProximityL, 0.0f, 1.0f) - smoothWallL) * envAlpha;
        smoothWallR += (clampf(ctrl.wallProximityR, 0.0f, 1.0f) - smoothWallR) * envAlpha;
        smoothGearWhine += (clampf(ctrl.gearWhineLevel, 0.0f, 1.0f) - smoothGearWhine) * envAlpha;
        smoothGearWhineHz += (clampf(ctrl.gearWhineHz, 0.0f, 6000.0f) - smoothGearWhineHz) * rpmAlpha;
        smoothSpeedMps += (clampf(ctrl.vehicleSpeedMps, 0.0f, 140.0f) - smoothSpeedMps) * envAlpha;
        smoothWetRoad += (clampf(ctrl.wetRoadReflection, 0.0f, 1.0f) - smoothWetRoad) * envAlpha;
        smoothOverpass += (clampf(ctrl.overpassReflection, 0.0f, 1.0f) - smoothOverpass) * envAlpha;

        // Track smoothed RPM rate (RPM/s) for realistic decel-only automatic overrun burbles
        const float instRpmSlope = (smoothRpm - prevSmoothRpm) / std::max(1e-4f, blockDt);
        rpmSlope += (instRpmSlope - rpmSlope) * (1.0f - std::exp(-blockDt / 0.040f));
        prevSmoothRpm = smoothRpm;

        // Handle manual starterCrank release -> trigger catch-flare burst
        if (prevCtrlStarter && !ctrl.starterCrank && starterTimer <= 0.0f) {
            starterFlareTimer = starterFlareDur;
            spawnBurble(0.45f);
        }
        prevCtrlStarter = ctrl.starterCrank;

        // Automatic physics-driven BOV flutter, high-RPM anti-lag bangs, and light off-throttle burbles!
        const bool hasTurbo = a.hasTurbo || ctrl.turboEnabled;
        if (autoPopCooldown > 0.0f) autoPopCooldown -= blockDt;
        if (autoBurbleCooldown > 0.0f) autoBurbleCooldown -= blockDt;
        const float thrDrop = prevThr - smoothThr;
        if (thrDrop > 0.25f && smoothRpm > a.redlineRpm * 0.42f) {
            if (hasTurbo && prevBoost > 0.35f) {
                triggerFlutter(prevBoost);
            }
            if (autoPopCooldown <= 0.0f && cfg.exhaustStage != ExhaustStage::Stock) {
                const float popInt = clampf((smoothRpm / a.redlineRpm) * (cfg.exhaustStage == ExhaustStage::RaceTitanium ? 1.05f : 0.72f), 0.35f, 1.15f);
                spawnPop(popInt);
                autoPopCooldown = 0.26f + 0.18f * rng.next01();
            }
        }
        // Light off-throttle overrun burbles when coasting down 4800 -> 2100 RPM on Sport/RaceTitanium
        if (cfg.exhaustStage != ExhaustStage::Stock &&
            smoothThr < 0.08f && smoothLoad < 0.16f &&
            smoothRpm >= 2100.0f && smoothRpm <= 4800.0f &&
            rpmSlope < -120.0f && autoBurbleCooldown <= 0.0f) {
            const float rpmFrac = clampf((smoothRpm - 2100.0f) / 2700.0f, 0.0f, 1.0f);
            const float stageScale = (cfg.exhaustStage == ExhaustStage::RaceTitanium) ? 0.68f : 0.44f;
            const float bInt = clampf((0.28f + 0.45f * rpmFrac) * stageScale * (0.75f + 0.50f * rng.next01()), 0.20f, 0.85f);
            spawnBurble(bInt);
            autoBurbleCooldown = (cfg.exhaustStage == ExhaustStage::RaceTitanium ? 0.085f : 0.135f) + 0.12f * rng.next01();
        }
        prevThr = smoothThr;
        prevBoost = smoothBoost;

        // Dynamic load-responsive tone shaping (Forza Horizon 6 acoustic core)
        const float rpmNorm = clampf((smoothRpm - 850.0f) / std::max(1000.0f, a.redlineRpm - 850.0f), 0.0f, 1.0f);
        const float loadEff = clampf(std::max(smoothThr, smoothLoad), 0.0f, 1.0f);
        const float decelAmt = clampf((0.12f - smoothThr) / 0.12f, 0.0f, 1.0f) * clampf((smoothRpm - 1800.0f) / 2200.0f, 0.0f, 1.0f);

        // Dynamic exhaust gas temperature model (speed of sound increases with temp -> shortens header comb up to ~6%)
        const float targetTemp = clampf(0.15f + 0.55f * loadEff + 0.30f * rpmNorm, 0.0f, 1.0f);
        const float tempTau = (targetTemp > exhaustGasTemp) ? 0.65f : 1.80f;
        exhaustGasTemp += (targetTemp - exhaustGasTemp) * (1.0f - std::exp(-blockDt / tempTau));
        const float tempDelayScale = 1.0f / (1.0f + 0.064f * exhaustGasTemp); // ~0.940 at full heat (~6% shorter)

        // Lowpass opens wide under WOT load and warms softly at closed-throttle cruise
        const float stageBright = (cfg.exhaustStage == ExhaustStage::RaceTitanium) ? 1.25f
                                : (cfg.exhaustStage == ExhaustStage::Stock) ? 0.72f : 1.0f;
        const float lpCut = clampf((1550.0f + rpmNorm * 3200.0f + std::pow(loadEff, 0.8f) * (5400.0f + rpmNorm * 3200.0f) - decelAmt * 950.0f) * stageBright,
                                   1150.0f, 14500.0f);
        toneLpL.setLowpass(fs, lpCut, 0.78f);
        toneLpR.setLowpass(fs, lpCut, 0.78f);

        // Hollow metallic engine-braking mid-pipe resonance during off-throttle decel!
        decelEqL.setPeaking(fs, a.bodyHz * (1.35f + 0.55f * rpmNorm), 2.1f, decelAmt * 5.2f);
        decelEqR.setPeaking(fs, a.bodyHz * (1.35f + 0.55f * rpmNorm), 2.1f, decelAmt * 5.2f);

        // VTEC / VarioCam high-cam lobe crossover above ~62% of redline under high load (crisp induction bark!)
        const bool camSupported = (cfg.voice == EngineVoice::Flat6Na || cfg.voice == EngineVoice::V12Na ||
                                   cfg.voice == EngineVoice::V10Screamer || cfg.voice == EngineVoice::V8Flatplane ||
                                   cfg.voice == EngineVoice::I4Turbo);
        const float camThresh = clampf(ctrl.camCrossoverFrac, 0.35f, 0.90f);
        const float targetCam = (camSupported && rpmNorm >= camThresh && loadEff > 0.62f)
                              ? clampf((rpmNorm - camThresh) / 0.12f, 0.0f, 1.0f) : 0.0f;
        camCrossoverEnv += (targetCam - camCrossoverEnv) * (1.0f - std::exp(-blockDt / 0.055f));
        camBarkEq.setPeaking(fs, clampf(a.intakeHz * (1.85f + 0.55f * rpmNorm), 600.0f, 4200.0f), 1.55f, camCrossoverEnv * 4.2f);

        // Intake carbon-airbox formant sweeps subtly up with RPM (and opens brighter on high cam!)
        intakeBp.setBandpass(fs, a.intakeHz * (0.82f + 0.75f * rpmNorm + 0.18f * camCrossoverEnv), 1.35f);

        // Primary header comb waveguide delay lengths (samples, shortened dynamically by exhaust gas temperature!)
        const float combSampsL = a.pipeCombMsL * 0.001f * fs * tempDelayScale;
        const float combSampsR = a.pipeCombMsR * 0.001f * fs * tempDelayScale;
        const float combFb = a.pipeFeedback * (cfg.exhaustStage == ExhaustStage::RaceTitanium ? 1.15f
                                             : cfg.exhaustStage == ExhaustStage::Stock ? 0.75f : 1.0f);
        const int haasSamps = std::max(1, static_cast<int>(0.0028f * fs)); // 2.8 ms stereo tailpipe width
        const int erTap1 = static_cast<int>(0.0115f * fs);
        const int erTap2 = static_cast<int>(0.0193f * fs);
        const int erTap3 = static_cast<int>(0.0297f * fs);

        // Canyon / building wall asymmetric slapback taps (L: 7.5 ms + 19.2 ms, R: 9.1 ms + 23.4 ms)
        const int wallTapL1 = std::max(1, static_cast<int>(0.0075f * fs));
        const int wallTapL2 = std::max(1, static_cast<int>(0.0192f * fs));
        const int wallTapR1 = std::max(1, static_cast<int>(0.0091f * fs));
        const int wallTapR2 = std::max(1, static_cast<int>(0.0234f * fs));

        // 8-channel mutually-prime concrete tunnel & street-canyon Householder FDN (23..83 ms)
        const int tunTap[8] = {
            std::max(1, static_cast<int>(0.023f * fs)), std::max(1, static_cast<int>(0.029f * fs)),
            std::max(1, static_cast<int>(0.037f * fs)), std::max(1, static_cast<int>(0.043f * fs)),
            std::max(1, static_cast<int>(0.053f * fs)), std::max(1, static_cast<int>(0.061f * fs)),
            std::max(1, static_cast<int>(0.071f * fs)), std::max(1, static_cast<int>(0.083f * fs)),
        };
        const int overpassTap = std::max(1, static_cast<int>(0.0145f * fs)); // ~5 m bridge deck reflection (~14.5 ms)

        // One-pole coefficients for tunnel air absorption (~3.2 kHz), tunnel DC/mud HP (~90 Hz), wall LP (~4.8 kHz), burble band (140..420 Hz)
        const float fdnDampAlpha = 1.0f - std::exp(-twoPi * 3200.0f * invFs);
        const float fdnHpAlpha   = 1.0f - std::exp(-twoPi * 90.0f * invFs);
        const float wallDampAlpha = 1.0f - std::exp(-twoPi * 4800.0f * invFs);
        const float burbleAlphaHi = 1.0f - std::exp(-twoPi * 420.0f * invFs);
        const float burbleAlphaLo = 1.0f - std::exp(-twoPi * 140.0f * invFs);

        // Effective wall & tunnel reflection weights (clean FDN feedback gain strictly < 0.72!)
        const float effWallL = clampf(smoothWallL + 0.62f * smoothTunnel, 0.0f, 1.0f);
        const float effWallR = clampf(smoothWallR + 0.62f * smoothTunnel, 0.0f, 1.0f);
        const float tunFb = clampf(0.30f + 0.38f * smoothTunnel, 0.30f, 0.68f);
        const float tunDrive = 0.38f * smoothTunnel;

        // Effective exhaust drive scales dynamically with load + exhaust stage
        const float drive = a.satDrive * (0.68f + 0.52f * loadEff)
                          * (cfg.exhaustStage == ExhaustStage::RaceTitanium ? 1.16f : 1.0f);
        const float normSat = 1.0f / std::max(0.25f, std::tanh(drive * 1.12f));

        // Intake roar weight explodes open above 30% throttle (Forza WOT induction snarl!)
        const float baseIntakeGain = a.intakeMix * (0.06f + 0.94f * std::pow(loadEff, 1.25f)) * (0.55f + 0.45f * rpmNorm);
        const float reverbWet = clampf(ctrl.reverbMix, 0.0f, 0.85f);

        // Forced induction frequencies
        const float turboWhineHz = 1850.0f + smoothBoost * 1650.0f + rpmNorm * 1450.0f;
        const float scWhineHz = (smoothRpm / 60.0f) * 2.4f * 4.0f * 2.2f; // 4-lobe roots @ 2.4x pulley
        const float scGain = a.hasSupercharger ? clampf((0.025f + 0.13f * loadEff) * (0.35f + 0.65f * rpmNorm), 0.0f, 0.16f) : 0.0f;
        const float turboSpoolLevel = hasTurbo ? clampf(smoothBoost * 0.58f + std::max(0.0f, rpmNorm - 0.18f) * loadEff * 0.45f, 0.0f, 1.0f) : 0.0f;
        if (hasTurbo) {
            turboNoiseBp.setBandpass(fs, clampf(2100.0f + turboSpoolLevel * 3400.0f, 1400.0f, 7500.0f), 2.6f);
        }

        // Straight-cut motorsport gearbox whine parameters (exact physical gear_whine_hz when provided, else speed fallback)
        const float speedNorm = clampf(smoothSpeedMps / 5.5f, 0.0f, 1.0f);
        const float coastShift = 1.0f + 0.032f * decelAmt;
        const float loadPitchMod = 1.0f + 0.018f * loadEff;
        const float rawMeshHz = (smoothGearWhineHz > 40.0f)
                              ? (smoothGearWhineHz * coastShift * loadPitchMod)
                              : ((210.0f + smoothSpeedMps * 27.5f + smoothRpm * 0.038f) * coastShift * loadPitchMod);
        const float gearMeshHz1 = clampf(rawMeshHz, 180.0f, 4200.0f);
        const float gearMeshHz2 = clampf(gearMeshHz1 * 1.492f, 260.0f, 6200.0f);

        // External wastegate screamer-pipe level (opens raw exhaust bypass above 0.95 bar under WOT!)
        const float wgOpen = (hasTurbo && (ctrl.externalWastegate || cfg.exhaustStage == ExhaustStage::RaceTitanium)
                              && smoothBoost > 0.92f && loadEff > 0.72f)
                           ? clampf((smoothBoost - 0.92f) / 0.55f, 0.0f, 1.0f) * clampf((loadEff - 0.72f) / 0.25f, 0.0f, 1.0f)
                           : 0.0f;
        if (wgOpen > 0.01f) {
            wastegateBp.setBandpass(fs, clampf(1150.0f + rpmNorm * 1350.0f + smoothBoost * 320.0f, 700.0f, 3600.0f), 1.35f);
        }
        const float gearBaseAmp = smoothGearWhine * (0.28f + 0.62f * loadEff + 0.42f * decelAmt)
                                * (0.06f * rpmNorm + 0.94f * speedNorm)
                                * (0.55f + 0.45f * clampf(smoothSpeedMps / 65.0f, 0.0f, 1.0f)) * 0.16f;
        if (smoothGearWhine > 0.002f) {
            gearBp.setBandpass(fs, clampf(gearMeshHz1 * (1.18f - 0.16f * decelAmt), 350.0f, 3800.0f), 1.45f + 0.55f * decelAmt);
        }

        // Valvetrain/mechanical texture idle presence boost
        const float mechIdleBoost = 1.0f + 0.55f * clampf((1800.0f - smoothRpm) / 1000.0f, 0.0f, 1.0f);

        // Camera perspective target + smooth ~40ms per-sample crossfade coefficient
        const PerspectiveMix targetPersp = getPerspectiveTarget(ctrl.perspective);
        const float perspAlpha = 1.0f - std::exp(-invFs / 0.040f);

        // Run the thermodynamic engine-sim solver for this audio block cleanly (exact step count!)
        const double desiredSteps = simAccum + static_cast<double>(numFrames) * simPerAudio;
        const int nSteps = std::max(1, static_cast<int>(std::floor(desiredSteps)));
        simAccum = desiredSteps - static_cast<double>(nSteps);
        stepSolverBatch(nSteps, smoothRpm, std::max(0.05f, smoothThr), ctrl.ignitionCut,
                        batchExL, batchExR, batchIn, batchMech);
        const int actualSteps = static_cast<int>(batchExL.size());

        for (int i = 0; i < numFrames; ++i) {
            // Smooth camera perspective parameters (~40ms crossfade -> click-free mid-rev switching!)
            curPersp.exhaustGain   += (targetPersp.exhaustGain   - curPersp.exhaustGain)   * perspAlpha;
            curPersp.stereoWidth   += (targetPersp.stereoWidth   - curPersp.stereoWidth)   * perspAlpha;
            curPersp.popGain       += (targetPersp.popGain       - curPersp.popGain)       * perspAlpha;
            curPersp.intakeGain    += (targetPersp.intakeGain    - curPersp.intakeGain)    * perspAlpha;
            curPersp.turboScGain   += (targetPersp.turboScGain   - curPersp.turboScGain)   * perspAlpha;
            curPersp.mechGain      += (targetPersp.mechGain      - curPersp.mechGain)      * perspAlpha;
            curPersp.gearWhineGain += (targetPersp.gearWhineGain - curPersp.gearWhineGain) * perspAlpha;
            curPersp.envRefGain    += (targetPersp.envRefGain    - curPersp.envRefGain)    * perspAlpha;
            curPersp.cabinLpHz     += (targetPersp.cabinLpHz     - curPersp.cabinLpHz)     * perspAlpha;
            curPersp.cabinBoomDb   += (targetPersp.cabinBoomDb   - curPersp.cabinBoomDb)   * perspAlpha;
            curPersp.cabinDampDb   += (targetPersp.cabinDampDb   - curPersp.cabinDampDb)   * perspAlpha;

            // Update cabin filters every 32 samples (~0.67 ms) only while crossfading
            if ((i & 31) == 0) {
                if (std::abs(curPersp.cabinLpHz - lastFilterCabinLpHz) > 8.0f ||
                    std::abs(curPersp.cabinBoomDb - lastFilterBoomDb) > 0.03f ||
                    std::abs(curPersp.cabinDampDb - lastFilterDampDb) > 0.03f) {
                    updatePerspectiveFilters(fs);
                }
            }

            float exL = curExL, exR = curExR, inSig = curIn, mechSig = curMech;
            if (actualSteps > 0) {
                const float pos = (static_cast<float>(i) / static_cast<float>(std::max(1, numFrames))) * static_cast<float>(actualSteps);
                const int k0 = std::min(actualSteps - 1, static_cast<int>(pos));
                const float f = pos - static_cast<float>(k0);
                const float aL = (k0 == 0) ? curExL : batchExL[k0 - 1];
                const float bL = batchExL[k0];
                const float aR = (k0 == 0) ? curExR : batchExR[k0 - 1];
                const float bR = batchExR[k0];
                const float aI = (k0 == 0) ? curIn : batchIn[k0 - 1];
                const float bI = batchIn[k0];
                const float aM = (k0 == 0) ? curMech : batchMech[k0 - 1];
                const float bM = batchMech[k0];
                exL = aL + (bL - aL) * f;
                exR = aR + (bR - aR) * f;
                inSig = aI + (bI - aI) * f;
                mechSig = aM + (bM - aM) * f;
            }

            // Pre-scale thermodynamic Pascal/flow values + remove 8kHz->48kHz upsampling stair-step images
            const float rawScale = isRotary ? 1.0f : 1e-4f;
            exL = dcHpL.process(aaLpL.process(exL * rawScale));
            exR = dcHpR.process(aaLpR.process(exR * rawScale));
            inSig = dcHpIn.process(aaLpIn.process(inSig * rawScale));

            // Smooth AGC level normalization (keeps idle warm/purring and WOT punchy with zero clipping!)
            const float instPow = 0.5f * (exL * exL + exR * exR);
            envRms += (instPow - envRms) * 0.00045f;
            const float rms = std::sqrt(std::max(1e-12f, envRms));
            const float agc = clampf(0.16f / std::max(0.0012f, rms), 1e-5f, 36.0f);
            exL *= agc;
            exR *= agc;
            inSig *= agc * 0.45f;

            // 1. Primary header waveguide comb resonators (metallic header sing + hot-gas standing-wave shift)
            const float cL = headerCombL.readFrac(combSampsL);
            const float cR = headerCombR.readFrac(combSampsR);
            const float wgL = exL + combFb * cL;
            const float wgR = exR + combFb * cR;
            headerCombL.push(clampf(wgL, -2.5f, 2.5f));
            headerCombR.push(clampf(wgR, -2.5f, 2.5f));

            // 2. Multi-tier overrun pops: sharp anti-lag detonations vs. warm 140-420 Hz exhaust burbles
            float popMono = 0.0f;
            float burbleMono = 0.0f;
            for (auto& p : pops) {
                if (!p.active) continue;
                p.age += invFs;
                if (p.age >= p.duration) {
                    p.active = false;
                    continue;
                }
                const float nRaw = rng.nextSigned();
                if (p.isBurble) {
                    // Deep, warm muted exhaust-pipe burble/gurgle (140..420 Hz)
                    const float u = p.age / p.duration;
                    p.lpState += (nRaw - p.lpState) * burbleAlphaHi;
                    p.hpState += (p.lpState - p.hpState) * burbleAlphaLo;
                    const float bandNoise = (p.lpState - p.hpState) * 3.6f;
                    const float fInst = p.ringFreq * (1.0f - 0.24f * u);
                    p.ringPhase += twoPi * fInst * invFs;
                    if (p.ringPhase > twoPi) p.ringPhase -= twoPi;
                    const float bodyPulse = std::sin(p.ringPhase) * 0.52f + std::sin(p.ringPhase * 0.5f) * 0.22f;
                    const float attack = 1.0f - std::exp(-p.age * 260.0f);
                    const float decay = std::exp(-20.0f * p.age);
                    burbleMono += std::tanh((bandNoise + bodyPulse) * attack * decay * 1.15f) * p.intensity * 0.55f;
                } else {
                    // Sharp broadband anti-lag gunshot crack + chesty sub-bass shockwave
                    p.lpState += (nRaw - p.lpState) * 0.025f;
                    p.hpState += (nRaw - p.hpState) * 0.28f;
                    const float subBlast = p.lpState * 6.5f * std::exp(-16.0f * p.age);
                    const float sharpCrack = (nRaw - p.hpState) * 1.45f * std::exp(-48.0f * p.age);
                    const float midTail = p.hpState * 1.15f * std::exp(-22.0f * p.age);
                    popMono += std::tanh((subBlast + sharpCrack + midTail) * 1.35f) * p.intensity;
                }
            }
            const float totalPop = (popMono + burbleMono) * curPersp.popGain;

            // 3. Physical Starter Crank (4-compression-stroke solenoid whir 145-190 Hz) & Catch-Flare burst
            float starterSig = 0.0f;
            float crankExhaustScale = 1.0f;
            const bool cranking = ctrl.starterCrank || (starterTimer > 0.0f);
            if (starterTimer > 0.0f) {
                starterTimer -= invFs;
                if (starterTimer <= 0.0f) {
                    starterTimer = 0.0f;
                    starterFlareTimer = starterFlareDur;
                    spawnBurble(0.45f);
                }
            }
            if (cranking) {
                const float compRateHz = clampf(4.0f / std::max(0.25f, starterDuration), 6.5f, 12.0f);
                starterCompPhase += twoPi * compRateHz * invFs;
                if (starterCompPhase > twoPi) starterCompPhase -= twoPi;
                const float compCycle = 0.5f + 0.5f * std::sin(starterCompPhase);
                const float whirHz = 146.0f + 42.0f * (1.0f - compCycle); // 146..188 Hz rhythmic compression cadence
                starterPhase += twoPi * whirHz * invFs;
                if (starterPhase > twoPi) starterPhase -= twoPi;
                const float gearWhir = std::sin(starterPhase) * 0.58f
                                     + std::sin(starterPhase * 2.0f) * 0.28f
                                     + std::sin(starterPhase * 3.04f) * 0.14f;
                const float compThump = std::sin(starterCompPhase * 2.0f) * 0.28f * compCycle;
                const float brushNoise = starterBp.process(rng.nextSigned()) * 0.35f;
                const float chugEnv = 0.52f + 0.48f * compCycle;
                starterSig = std::tanh((gearWhir * chugEnv + brushNoise * chugEnv + compThump) * 1.25f) * 0.28f;
                crankExhaustScale = 0.32f;
            } else if (starterFlareTimer > 0.0f) {
                starterFlareTimer = std::max(0.0f, starterFlareTimer - invFs);
                const float u = 1.0f - (starterFlareTimer / starterFlareDur);
                const float flareEnv = std::sin(static_cast<float>(kPi) * clampf(u, 0.0f, 1.0f)) * std::exp(-2.1f * u);
                crankExhaustScale = 1.0f + 0.48f * flareEnv;
                starterSig = starterBp.process(rng.nextSigned()) * flareEnv * 0.26f;
            }

            // 4. Exhaust EQ stack: Helmholtz sub-bass + core body + titanium rasp + hollow decel + dynamic LP
            float sL = (wgL * crankExhaustScale + totalPop * 0.95f);
            float sR = (wgR * crankExhaustScale + totalPop * 0.90f);

            sL = subShelfL.process(sL);
            sR = subShelfR.process(sR);
            sL = bodyEqL.process(sL);
            sR = bodyEqR.process(sR);
            sL = raspEqL.process(sL);
            sR = raspEqR.process(sR);
            sL = decelEqL.process(sL);
            sR = decelEqR.process(sR);

            // Warm asymmetric pipe saturation (adds rich 2nd + 3rd exhaust harmonics without harsh clipping)
            sL = std::tanh(drive * (sL + 0.11f * sL * sL)) * normSat;
            sR = std::tanh(drive * (sR + 0.11f * sR * sR)) * normSat;

            sL = toneLpL.process(sL);
            sR = toneLpR.process(sR);

            // Keep pre-cabin exterior exhaust copy for tunnel/canyon wall reflections!
            const float exExtL = sL;
            const float exExtR = sR;

            // Perspective cabin lowpass + chassis sub-bass boom (~68-115 Hz) + subtle cabin damping
            sL = cabinDampEqL.process(cabinBoomEqL.process(cabinExLpL.process(sL))) * curPersp.exhaustGain;
            sR = cabinDampEqR.process(cabinBoomEqR.process(cabinExLpR.process(sR))) * curPersp.exhaustGain;

            // 5. Real Intake Manifold Plenum Roar (centered carbon-airbox bark, +5 dB in HoodBumper + VTEC cam crossover!)
            const float inFiltered = camBarkEq.process(intakeLp.process(intakeBp.process(inSig) + 0.35f * inSig));
            const float inSat = std::tanh(inFiltered * (1.4f + 0.35f * camCrossoverEnv))
                              * baseIntakeGain * (1.0f + 0.32f * camCrossoverEnv) * curPersp.intakeGain;

            // 6. Valvetrain / Fuel-Injector Mechanical Texture from real engine-sim `mechPulse` tap
            const float mechDiff = mechSig - prevMechSample;
            prevMechSample = mechSig;
            const float mechScaled = isRotary ? (mechDiff * 0.65f) : (mechDiff * 42.0f);
            const float mechClean = std::tanh(mechBp.process(mechHp.process(mechScaled)) * 1.4f);
            const float mechOut = mechClean * curPersp.mechGain * mechIdleBoost * 0.085f;

            // 7. Straight-Cut Motorsport Gearbox Whine (dual-harmonic tooth mesh, load & coasting modulated)
            float gearSig = 0.0f;
            if (gearBaseAmp > 0.0005f) {
                gearPhase1 += twoPi * gearMeshHz1 * invFs;
                if (gearPhase1 > twoPi) gearPhase1 -= twoPi;
                gearPhase2 += twoPi * gearMeshHz2 * invFs;
                if (gearPhase2 > twoPi) gearPhase2 -= twoPi;
                const float toothJitter = 1.0f + 0.04f * rng.nextSigned();
                const float rawGear = (std::sin(gearPhase1) * 0.64f
                                     + std::sin(gearPhase1 * 2.0f) * 0.22f
                                     + std::sin(gearPhase2) * 0.34f) * toothJitter;
                gearSig = gearLp.process(gearBp.process(rawGear)) * gearBaseAmp * curPersp.gearWhineGain;
            }

            // 8. Forced Induction (Aerodynamic charge-pipe air rush + turbine spool + BOV flutter + Supercharger)
            float fiMono = 0.0f;
            float flutterMono = 0.0f;
            if (hasTurbo && turboSpoolLevel > 0.02f) {
                turboPhase += twoPi * turboWhineHz * invFs;
                if (turboPhase > twoPi) turboPhase -= twoPi;
                const float airRush = turboNoiseBp.process(rng.nextSigned());
                const float turbineTone = std::sin(turboPhase) * 0.014f;
                fiMono += (turbineTone + airRush * 0.12f) * std::pow(turboSpoolLevel, 1.2f) * (0.30f + 0.70f * loadEff);
            }
            if (wgOpen > 0.01f) {
                // External wastegate screamer pipe: raw bypass pulse + broadband exhaust hiss
                const float wgSrc = (exL + exR) * 0.55f + rng.nextSigned() * 0.45f;
                fiMono += std::tanh(wastegateBp.process(wgSrc) * 2.1f) * wgOpen * 0.24f;
            }
            if (flutterEnv > 0.005f) {
                flutterAge += invFs;
                if (flutterAge >= flutterDur) {
                    flutterEnv = 0.0f;
                } else {
                    const float u = flutterAge / flutterDur;
                    const float pulseFreq = flutterRateHz * (1.0f - 0.25f * u);
                    const float pulse = std::pow(0.5f + 0.5f * std::sin(twoPi * pulseFreq * flutterAge), 2.4f);
                    const float decay = std::exp(-3.4f * u);
                    const float whoosh = flutterBp.process(rng.nextSigned());
                    flutterMono = whoosh * pulse * decay * flutterEnv * 0.58f;
                    fiMono += flutterMono;
                }
            }
            if (a.hasSupercharger && scGain > 0.002f) {
                scPhase += twoPi * clampf(scWhineHz, 220.0f, 6800.0f) * invFs;
                if (scPhase > twoPi) scPhase -= twoPi;
                const float scTone = std::sin(scPhase) * 0.65f + std::sin(scPhase * 2.0f) * 0.24f + std::sin(scPhase * 3.0f) * 0.08f;
                fiMono += scTone * scGain;
            }
            fiMono *= curPersp.turboScGain;

            // 9. Perspective-aware stereo dual-tailpipe width + centered intake / FI / mech / gearbox / starter
            haasDelayR.push(sR);
            const float haasR = haasDelayR.read(haasSamps);
            const float crossBleed = 0.50f - 0.36f * curPersp.stereoWidth; // 0.14 wide .. 0.34 intimate cockpit
            const float mainWeight = 1.0f - crossBleed;
            const float centerSum = inSat + fiMono + mechOut + gearSig + starterSig;
            const float wideL = sL * mainWeight + sR * crossBleed + centerSum;
            const float wideR = haasR * mainWeight + sL * crossBleed + centerSum;

            // 10. Tight early asphalt / garage bay reflections
            erDelayL.push(wideL);
            erDelayR.push(wideR);
            const float erL = 0.45f * erDelayR.read(erTap1) - 0.32f * erDelayL.read(erTap2) + 0.22f * erDelayR.read(erTap3);
            const float erR = 0.45f * erDelayL.read(erTap1) - 0.32f * erDelayR.read(erTap2) + 0.22f * erDelayL.read(erTap3);

            // 11. Dynamic Tunnel & Canyon Wall Multi-Tap Stereo Acoustic Engine
            // Feed full-bandwidth exterior exhaust + overrun pops/burbles + turbo flutter into reflection bus!
            const float refBusL = clampf(exExtL + flutterMono * 0.90f + inSat * 0.22f, -2.5f, 2.5f);
            const float refBusR = clampf(exExtR + flutterMono * 0.90f + inSat * 0.22f, -2.5f, 2.5f);

            // 11a. Asymmetric L/R canyon & building wall slapback (L: 7.5+19.2ms, R: 9.1+23.4ms)
            wallDelayL.push(refBusL);
            wallDelayR.push(refBusR);
            const float rawWallL = (0.62f * wallDelayL.read(wallTapL1) + 0.38f * wallDelayL.read(wallTapL2)) * effWallL;
            const float rawWallR = (0.62f * wallDelayR.read(wallTapR1) + 0.38f * wallDelayR.read(wallTapR2)) * effWallR;
            wallLpL += (rawWallL - wallLpL) * wallDampAlpha;
            wallLpR += (rawWallR - wallLpR) * wallDampAlpha;
            const float slapL = (wallLpL * 0.80f + wallLpR * 0.22f) * 0.46f;
            const float slapR = (wallLpR * 0.80f + wallLpL * 0.22f) * 0.46f;

            // 11b. 8-channel orthogonal Householder metallic concrete tunnel FDN (23..83 ms + 3.2 kHz air damping)
            // Householder matrix H = I - (2/N) * 1*1^T is strictly orthogonal -> lush, dense, zero metallic ringing!
            fdnInHpL += (refBusL - fdnInHpL) * fdnHpAlpha;
            fdnInHpR += (refBusR - fdnInHpR) * fdnHpAlpha;
            const float tunInL = refBusL - fdnInHpL;
            const float tunInR = refBusR - fdnInHpR;

            float fdnSum = 0.0f;
            for (int c = 0; c < 8; ++c) {
                const float dc = tunnelFdn[c].read(tunTap[c]);
                fdnLp[c] += (dc - fdnLp[c]) * fdnDampAlpha;
                fdnSum += fdnLp[c];
            }
            const float hAvg = 0.25f * fdnSum; // (2/8) * sum
            for (int c = 0; c < 8; ++c) {
                const float hc = fdnLp[c] - hAvg;
                const float inj = (c & 1) ? ((c & 2) ? (0.72f * tunInR - 0.28f * tunInL) : tunInR)
                                          : ((c & 2) ? (0.72f * tunInL - 0.28f * tunInR) : tunInL);
                tunnelFdn[c].push(clampf(hc * tunFb + inj * tunDrive * 0.72f, -2.0f, 2.0f));
            }

            const float tunOutL = (fdnLp[0] + fdnLp[2] + fdnLp[4] - 0.55f * fdnLp[6]) * 0.30f;
            const float tunOutR = (fdnLp[1] + fdnLp[3] + fdnLp[5] - 0.55f * fdnLp[7]) * 0.30f;

            // Overhead bridge/overpass slapback + rain-slick asphalt high-frequency specular exhaust reflection
            const float ovL = smoothOverpass > 0.01f ? (wallDelayL.read(overpassTap) * smoothOverpass * 0.34f) : 0.0f;
            const float ovR = smoothOverpass > 0.01f ? (wallDelayR.read(overpassTap) * smoothOverpass * 0.34f) : 0.0f;
            const float wetL = smoothWetRoad > 0.01f ? (wetSpecHpL.process(erL) * smoothWetRoad * 0.32f) : 0.0f;
            const float wetR = smoothWetRoad > 0.01f ? (wetSpecHpR.process(erR) * smoothWetRoad * 0.32f) : 0.0f;

            // Cabin-glass lowpass on exterior wall, overpass, wet specular & tunnel reflections
            const float envWetL = cabinRefLpL.process(slapL + tunOutL + ovL + wetL) * curPersp.envRefGain;
            const float envWetR = cabinRefLpR.process(slapR + tunOutR + ovR + wetR) * curPersp.envRefGain;

            // Dynamic overall master presence (clean 10-14 dB crest factor, strictly bounded [-1, 1] via tanh!)
            const float master = (0.42f + 0.36f * loadEff) * (0.76f + 0.24f * rpmNorm);
            const float finalL = std::tanh((wideL + erL * reverbWet * curPersp.envRefGain + envWetL) * master);
            const float finalR = std::tanh((wideR + erR * reverbWet * curPersp.envRefGain + envWetR) * master);

            if (outL) outL[i] = finalL;
            if (outR) outR[i] = finalR;
        }
        if (actualSteps > 0) {
            curExL = batchExL.back();
            curExR = batchExR.back();
            curIn = batchIn.back();
            curMech = batchMech.back();
        }
    }
};

// ---- Public EngineAudioSynth API -------------------------------------------------------------

EngineAudioSynth::EngineAudioSynth() : impl_(std::make_unique<Impl>()) {}
EngineAudioSynth::~EngineAudioSynth() = default;

bool EngineAudioSynth::initialize(const EngineAudioConfig& cfg) {
    return impl_->init(cfg);
}

void EngineAudioSynth::warmup(float seconds, float rpm, float throttle) {
    if (!impl_->initialized || seconds <= 0.0f) return;
    EngineAudioControl c = impl_->ctrl;
    c.rpm = rpm;
    c.throttle = throttle;
    c.load = throttle;
    c.ignitionCut = false;
    impl_->ctrl = c;
    impl_->smoothRpm = rpm;
    impl_->prevSmoothRpm = rpm;
    impl_->rpmSlope = 0.0f;
    impl_->smoothThr = throttle;
    impl_->smoothLoad = throttle;
    impl_->prevThr = throttle;
    impl_->curPersp = getPerspectiveTarget(c.perspective);
    impl_->updatePerspectiveFilters(static_cast<float>(impl_->cfg.sampleRate));

    const int totalFrames = static_cast<int>(seconds * impl_->cfg.sampleRate);
    float dummyL[256], dummyR[256];
    int rem = totalFrames;
    while (rem > 0) {
        const int n = std::min(256, rem);
        impl_->render(dummyL, dummyR, n);
        rem -= n;
    }
}

void EngineAudioSynth::setControl(const EngineAudioControl& ctrl) {
    impl_->ctrl = ctrl;
}

void EngineAudioSynth::triggerExhaustPop(float intensity) {
    impl_->spawnPop(intensity);
}

void EngineAudioSynth::triggerTurboFlutter(float boostBar) {
    impl_->triggerFlutter(boostBar);
}

void EngineAudioSynth::triggerStarterCrank(float durationSec) {
    impl_->triggerStarter(durationSec);
}

void EngineAudioSynth::triggerOverrunBurble(float intensity) {
    impl_->spawnBurble(intensity);
}

void EngineAudioSynth::renderStereo(float* outL, float* outR, int numFrames) {
    impl_->render(outL, outR, numFrames);
}

void EngineAudioSynth::renderMono(float* outMono, int numFrames) {
    if (!outMono || numFrames <= 0) return;
    float tmpL[256], tmpR[256];
    int off = 0;
    while (off < numFrames) {
        const int n = std::min(256, numFrames - off);
        impl_->render(tmpL, tmpR, n);
        for (int i = 0; i < n; ++i) outMono[off + i] = 0.5f * (tmpL[i] + tmpR[i]);
        off += n;
    }
}

EngineVoice EngineAudioSynth::voice() const { return impl_->cfg.voice; }
int EngineAudioSynth::sampleRate() const { return impl_->cfg.sampleRate; }
float EngineAudioSynth::measuredRpm() const { return impl_->measuredRpm; }
bool EngineAudioSynth::isInitialized() const { return impl_->initialized; }

EngineVoice EngineAudioSynth::parseVoice(const std::string& id) {
    if (id == "v8_flatplane" || id == "v8_flat") return EngineVoice::V8Flatplane;
    if (id == "v8_supercharged" || id == "v8_sc") return EngineVoice::V8Supercharged;
    if (id == "v8_twin_turbo" || id == "v8_tt") return EngineVoice::V8TwinTurbo;
    if (id == "v12_na" || id == "v12") return EngineVoice::V12Na;
    if (id == "v10_screamer" || id == "v10") return EngineVoice::V10Screamer;
    if (id == "flat6_na" || id == "flat6") return EngineVoice::Flat6Na;
    if (id == "i6_forged" || id == "i6") return EngineVoice::I6Forged;
    if (id == "v6_tt" || id == "v6") return EngineVoice::V6TwinTurbo;
    if (id == "rotary_4" || id == "rotary") return EngineVoice::Rotary4;
    if (id == "i4_turbo" || id == "i4") return EngineVoice::I4Turbo;
    if (id == "i5_turbo" || id == "i5") return EngineVoice::I5Turbo;
    return EngineVoice::V8Crossplane;
}

const char* EngineAudioSynth::voiceName(EngineVoice v) {
    switch (v) {
        case EngineVoice::V8Crossplane: return "v8_crossplane";
        case EngineVoice::V8Flatplane: return "v8_flatplane";
        case EngineVoice::V8Supercharged: return "v8_supercharged";
        case EngineVoice::V8TwinTurbo: return "v8_twin_turbo";
        case EngineVoice::V12Na: return "v12_na";
        case EngineVoice::V10Screamer: return "v10_screamer";
        case EngineVoice::Flat6Na: return "flat6_na";
        case EngineVoice::I6Forged: return "i6_forged";
        case EngineVoice::V6TwinTurbo: return "v6_tt";
        case EngineVoice::Rotary4: return "rotary_4";
        case EngineVoice::I4Turbo: return "i4_turbo";
        case EngineVoice::I5Turbo: return "i5_turbo";
    }
    return "v8_crossplane";
}

}  // namespace rs
