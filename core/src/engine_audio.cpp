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

// ---- Physical Unburnt-Fuel Exhaust Detonation / Anti-Lag Pop Generator -----------------------

struct ExhaustPopVoice {
    bool active = false;
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

// ---- Dedicated 4-Rotor 26B Peripheral-Port Wankel Combustion Core ----------------------------

struct Rotary4Core {
    double eShaftRad = 0.0;
    double lopePhase = 0.0;
    float prevP[4] = {};

    // Outputs dual-bank stereo exhaust (rotors 0,2 -> L; rotors 1,3 -> R) + intake pulse
    void step(double dt, float rpm, float throttle, bool ignCut, float& exL, float& exR, float& intake, FastRng& rng) {
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

        float sumL = 0.0f, sumR = 0.0f, sumIn = 0.0f;
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
        }

        exL = sumL * 0.48f;
        exR = sumR * 0.48f;
        intake = sumIn * 0.22f;
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
    float prevExL = 0.0f, curExL = 0.0f;
    float prevExR = 0.0f, curExR = 0.0f;
    float prevIn = 0.0f, curIn = 0.0f;
    float prevMech = 0.0f, curMech = 0.0f;
    float measuredRpm = 950.0f;

    // Smoothed controls
    float smoothRpm = 950.0f;
    float smoothThr = 0.08f;
    float smoothLoad = 0.08f;
    float smoothBoost = 0.0f;
    float prevThr = 0.08f;
    float prevBoost = 0.0f;

    // Automatic RMS level tracker (keeps all 10 engines evenly loud without pumping)
    float envRms = 0.08f;

    // Dual-channel Forza acoustic mastering DSP (exhaust + intake + waveguide + reflections)
    Biquad aaLpL, aaLpR, aaLpIn;
    Biquad dcHpL, dcHpR, dcHpIn;
    Biquad subShelfL, subShelfR;
    Biquad bodyEqL, bodyEqR;
    Biquad raspEqL, raspEqR;
    Biquad decelEqL, decelEqR;
    Biquad toneLpL, toneLpR;
    Biquad intakeBp, intakeLp;

    DelayLine<1024> headerCombL, headerCombR;
    DelayLine<2048> erDelayL, erDelayR;
    DelayLine<512> haasDelayR;

    // Forced induction DSP (Turbo spool + compressor surge BOV flutter + Helical Supercharger)
    float turboPhase = 0.0f;
    float scPhase = 0.0f;
    Biquad turboNoiseBp, flutterBp;
    float flutterEnv = 0.0f;
    float flutterAge = 0.0f;
    float flutterRateHz = 13.5f;
    float flutterDur = 0.52f;

    // Unburnt-fuel exhaust detonation pool (up to 4 overlapping bangs)
    std::array<ExhaustPopVoice, 4> pops{};
    float autoPopCooldown = 0.0f;

    // Subtle starter-crank oscillator
    float starterPhase = 0.0f;

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

        headerCombL.reset();
        headerCombR.reset();
        erDelayL.reset();
        erDelayR.reset();
        haasDelayR.reset();
    }

    bool init(const EngineAudioConfig& newCfg) {
        teardownEngineSim();
        cfg = newCfg;
        cfg.sampleRate = std::max(22050, std::min(96000, cfg.sampleRate));
        cfg.simFrequency = std::max(3000, std::min(12000, cfg.simFrequency));
        cfg.fluidSubsteps = std::max(2, std::min(8, cfg.fluidSubsteps));

        preset = getPreset(cfg.voice);
        isRotary = (cfg.voice == EngineVoice::Rotary4);
        ctrl.exhaustStage = cfg.exhaustStage;
        ctrl.turboEnabled = cfg.turboEnabled;

        simAccum = 0.0;
        prevExL = curExL = prevExR = curExR = prevIn = curIn = prevMech = curMech = 0.0f;
        envRms = 0.08f;
        flutterEnv = 0.0f;
        for (auto& p : pops) p.active = false;
        setupFilters();

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
                         std::vector<float>& outExL, std::vector<float>& outExR, std::vector<float>& outIn) {
        outExL.clear();
        outExR.clear();
        outIn.clear();
        if (steps <= 0) return;

        if (isRotary) {
            const double dt = 1.0 / static_cast<double>(cfg.simFrequency);
            for (int k = 0; k < steps; ++k) {
                float el = 0.0f, er = 0.0f, inS = 0.0f;
                rotary.step(dt, rpm, thr, ignCut, el, er, inS, rng);
                outExL.push_back(el);
                outExR.push_back(er);
                outIn.push_back(inS);
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
        }
        sim->endFrame();

        // Keep Synthesizer's internal buffer drained cleanly without running its slow O(N*M) convolution
        if (sim->synthesizer().getLatency() > 256) {
            int16_t trash[256];
            sim->synthesizer().readAudioOutput(256, trash);
        }
        measuredRpm = static_cast<float>(std::abs(engine->getRpm()));
    }

    // Reusable scratch buffers (zero heap allocation inside render loop after first call)
    std::vector<float> batchExL, batchExR, batchIn;

    void spawnPop(float intensity) {
        for (auto& p : pops) {
            if (!p.active) {
                p.active = true;
                p.age = 0.0f;
                p.intensity = clampf(intensity, 0.25f, 1.5f);
                p.duration = 0.17f + 0.14f * rng.next01();
                p.subFreq = 64.0f + 26.0f * rng.next01();
                p.ringFreq = 210.0f + 160.0f * rng.next01();
                p.phase = 0.0f;
                p.ringPhase = 0.0f;
                p.lpState = 0.0f;
                p.hpState = 0.0f;
                return;
            }
        }
    }

    void triggerFlutter(float boostBar) {
        const float b = clampf(boostBar, 0.15f, 2.4f);
        flutterEnv = std::max(flutterEnv, clampf(0.45f + 0.42f * b, 0.4f, 1.25f));
        flutterAge = 0.0f;
        flutterRateHz = 11.5f + 4.0f * clampf(b * 0.5f, 0.0f, 1.0f);
        flutterDur = 0.42f + 0.18f * clampf(b * 0.5f, 0.0f, 1.0f);
    }

    void render(float* outL, float* outR, int numFrames) {
        if (!initialized || numFrames <= 0) {
            if (outL) std::memset(outL, 0, sizeof(float) * numFrames);
            if (outR) std::memset(outR, 0, sizeof(float) * numFrames);
            return;
        }

        const float fs = static_cast<float>(cfg.sampleRate);
        const float invFs = 1.0f / fs;
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
        smoothRpm += (clampf(ctrl.rpm, 420.0f, a.redlineRpm + 500.0f) - smoothRpm) * rpmAlpha;
        smoothThr += (clampf(ctrl.throttle, 0.0f, 1.0f) - smoothThr) * thrAlpha;
        smoothLoad += (clampf(ctrl.load, 0.0f, 1.0f) - smoothLoad) * thrAlpha;
        smoothBoost += (clampf(ctrl.boostBar, 0.0f, 2.5f) - smoothBoost) * (1.0f - std::exp(-blockDt / 0.045f));

        // Automatic physics-driven BOV flutter & overrun pop triggers on crisp high-RPM throttle lift-off!
        const bool hasTurbo = a.hasTurbo || ctrl.turboEnabled;
        if (autoPopCooldown > 0.0f) autoPopCooldown -= blockDt;
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
        prevThr = smoothThr;
        prevBoost = smoothBoost;

        // Dynamic load-responsive tone shaping (THIS is the Forza Horizon 6 secret sauce!)
        const float rpmNorm = clampf((smoothRpm - 850.0f) / std::max(1000.0f, a.redlineRpm - 850.0f), 0.0f, 1.0f);
        const float loadEff = clampf(std::max(smoothThr, smoothLoad), 0.0f, 1.0f);
        const float decelAmt = clampf((0.12f - smoothThr) / 0.12f, 0.0f, 1.0f) * clampf((smoothRpm - 1800.0f) / 2200.0f, 0.0f, 1.0f);

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

        // Intake carbon-airbox formant sweeps subtly up with RPM
        intakeBp.setBandpass(fs, a.intakeHz * (0.82f + 0.75f * rpmNorm), 1.35f);

        // Primary header comb waveguide delay lengths (samples)
        const float combSampsL = a.pipeCombMsL * 0.001f * fs;
        const float combSampsR = a.pipeCombMsR * 0.001f * fs;
        const float combFb = a.pipeFeedback * (cfg.exhaustStage == ExhaustStage::RaceTitanium ? 1.15f
                                             : cfg.exhaustStage == ExhaustStage::Stock ? 0.75f : 1.0f);
        const int haasSamps = std::max(1, static_cast<int>(0.0028f * fs)); // 2.8 ms stereo tailpipe width
        const int erTap1 = static_cast<int>(0.0115f * fs);
        const int erTap2 = static_cast<int>(0.0193f * fs);
        const int erTap3 = static_cast<int>(0.0297f * fs);

        // Effective exhaust drive scales dynamically with load + exhaust stage
        const float drive = a.satDrive * (0.68f + 0.52f * loadEff)
                          * (cfg.exhaustStage == ExhaustStage::RaceTitanium ? 1.16f : 1.0f);
        const float normSat = 1.0f / std::max(0.25f, std::tanh(drive * 1.12f));

        // Intake roar weight explodes open above 30% throttle (Forza WOT induction snarl!)
        const float intakeGain = a.intakeMix * (0.06f + 0.94f * std::pow(loadEff, 1.25f)) * (0.55f + 0.45f * rpmNorm);
        const float reverbWet = clampf(ctrl.reverbMix, 0.0f, 0.85f);

        // Forced induction frequencies
        const float turboWhineHz = 1850.0f + smoothBoost * 1650.0f + rpmNorm * 1450.0f;
        const float scWhineHz = (smoothRpm / 60.0f) * 2.4f * 4.0f * 2.2f; // 4-lobe roots @ 2.4x pulley
        const float scGain = a.hasSupercharger ? clampf((0.025f + 0.13f * loadEff) * (0.35f + 0.65f * rpmNorm), 0.0f, 0.16f) : 0.0f;
        const float turboSpoolLevel = hasTurbo ? clampf(smoothBoost * 0.58f + std::max(0.0f, rpmNorm - 0.18f) * loadEff * 0.45f, 0.0f, 1.0f) : 0.0f;
        if (hasTurbo) {
            turboNoiseBp.setBandpass(fs, clampf(2100.0f + turboSpoolLevel * 3400.0f, 1400.0f, 7500.0f), 2.6f);
        }

        // Run the thermodynamic engine-sim solver for this audio block cleanly (exact step count!)
        const double desiredSteps = simAccum + static_cast<double>(numFrames) * simPerAudio;
        const int nSteps = std::max(1, static_cast<int>(std::floor(desiredSteps)));
        simAccum = desiredSteps - static_cast<double>(nSteps);
        stepSolverBatch(nSteps, smoothRpm, std::max(0.05f, smoothThr), ctrl.ignitionCut, batchExL, batchExR, batchIn);
        const int actualSteps = static_cast<int>(batchExL.size());

        for (int i = 0; i < numFrames; ++i) {
            float exL = curExL, exR = curExR, inSig = curIn;
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
                exL = aL + (bL - aL) * f;
                exR = aR + (bR - aR) * f;
                inSig = aI + (bI - aI) * f;
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

            // 1. Primary header waveguide comb resonators (metallic header sing + bank asymmetry)
            const float cL = headerCombL.readFrac(combSampsL);
            const float cR = headerCombR.readFrac(combSampsR);
            const float wgL = exL + combFb * cL;
            const float wgR = exR + combFb * cR;
            headerCombL.push(clampf(wgL, -2.5f, 2.5f));
            headerCombR.push(clampf(wgR, -2.5f, 2.5f));

            // 2. Physical unburnt-fuel exhaust detonations (broadband shotgun blast + chesty sub impulse — ZERO tonal sine boing!)
            float popMono = 0.0f;
            for (auto& p : pops) {
                if (!p.active) continue;
                p.age += invFs;
                if (p.age >= p.duration) {
                    p.active = false;
                    continue;
                }
                const float nRaw = rng.nextSigned();
                // Two-stage filtered explosion: heavy low-passed shockwave (< 160 Hz) + supersonic crack transient (12-38 ms)
                p.lpState += (nRaw - p.lpState) * 0.025f; // deep sub-thump envelope
                p.hpState += (nRaw - p.hpState) * 0.28f;  // mid-crack band
                const float subBlast = p.lpState * 6.5f * std::exp(-16.0f * p.age);
                const float sharpCrack = (nRaw - p.hpState) * 1.45f * std::exp(-48.0f * p.age);
                const float midTail = p.hpState * 1.15f * std::exp(-22.0f * p.age);
                popMono += std::tanh((subBlast + sharpCrack + midTail) * 1.35f) * p.intensity;
            }

            // 3. Exhaust EQ stack: Helmholtz sub-bass + core body + titanium rasp + hollow decel + dynamic LP
            float sL = wgL + popMono * 0.95f;
            float sR = wgR + popMono * 0.90f;

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

            // 4. Real Intake Manifold Plenum Roar (centered carbon-airbox bark on WOT!)
            const float inFiltered = intakeLp.process(intakeBp.process(inSig) + 0.35f * inSig);
            const float inSat = std::tanh(inFiltered * 1.4f) * intakeGain;
            sL += inSat;
            sR += inSat;

            // 5. Forced Induction (Aerodynamic charge-pipe air rush + whisper-soft turbine spool OR Helical Supercharger)
            float fiMono = 0.0f;
            if (hasTurbo && turboSpoolLevel > 0.02f) {
                turboPhase += 2.0f * static_cast<float>(kPi) * turboWhineHz * invFs;
                if (turboPhase > 2.0f * static_cast<float>(kPi)) turboPhase -= 2.0f * static_cast<float>(kPi);
                const float airRush = turboNoiseBp.process(rng.nextSigned());
                // Realistic turbo = 85% pressurized air-rush + 15% soft turbine harmonic (never an annoying sine beep!)
                const float turbineTone = std::sin(turboPhase) * 0.014f;
                fiMono += (turbineTone + airRush * 0.12f) * std::pow(turboSpoolLevel, 1.2f) * (0.30f + 0.70f * loadEff);
            }
            if (flutterEnv > 0.005f) {
                flutterAge += invFs;
                if (flutterAge >= flutterDur) {
                    flutterEnv = 0.0f;
                } else {
                    const float u = flutterAge / flutterDur;
                    // 5-7 crisp aluminum intake compressor-surge blades ("stu-tu-tu-tu-tu")
                    const float pulseFreq = flutterRateHz * (1.0f - 0.25f * u);
                    const float pulse = std::pow(0.5f + 0.5f * std::sin(2.0f * static_cast<float>(kPi) * pulseFreq * flutterAge), 2.4f);
                    const float decay = std::exp(-3.4f * u);
                    const float whoosh = flutterBp.process(rng.nextSigned());
                    fiMono += whoosh * pulse * decay * flutterEnv * 0.58f;
                }
            }
            if (a.hasSupercharger && scGain > 0.002f) {
                scPhase += 2.0f * static_cast<float>(kPi) * clampf(scWhineHz, 220.0f, 6800.0f) * invFs;
                if (scPhase > 2.0f * static_cast<float>(kPi)) scPhase -= 2.0f * static_cast<float>(kPi);
                const float scTone = std::sin(scPhase) * 0.65f + std::sin(scPhase * 2.0f) * 0.24f + std::sin(scPhase * 3.0f) * 0.08f;
                fiMono += scTone * scGain;
            }

            // 6. Optional starter cranking pulse
            if (ctrl.starterCrank) {
                starterPhase += 2.0f * static_cast<float>(kPi) * 145.0f * invFs;
                const float crankPulse = std::sin(starterPhase) * (0.5f + 0.5f * std::sin(starterPhase * 0.07f));
                fiMono += crankPulse * 0.12f;
            }

            // 7. True stereo dual-tailpipe width (preserve L/R bank balance + subtle 2.8 ms Haas width)
            haasDelayR.push(sR);
            const float wideL = sL * 0.86f + sR * 0.14f + fiMono;
            const float wideR = haasDelayR.read(haasSamps) * 0.86f + sL * 0.14f + fiMono;

            // 8. Tight early asphalt / garage bay reflections (adds real 3D physical space without mud!)
            erDelayL.push(wideL);
            erDelayR.push(wideR);
            const float refL = 0.45f * erDelayR.read(erTap1) - 0.32f * erDelayL.read(erTap2) + 0.22f * erDelayR.read(erTap3);
            const float refR = 0.45f * erDelayL.read(erTap1) - 0.32f * erDelayR.read(erTap2) + 0.22f * erDelayL.read(erTap3);

            // Dynamic overall master presence (clean 10-14 dB crest factor, zero square-wave clipping!)
            const float master = (0.42f + 0.36f * loadEff) * (0.76f + 0.24f * rpmNorm);
            const float finalL = std::tanh((wideL + refL * reverbWet) * master);
            const float finalR = std::tanh((wideR + refR * reverbWet) * master);

            if (outL) outL[i] = finalL;
            if (outR) outR[i] = finalR;
        }
        if (actualSteps > 0) {
            curExL = batchExL.back();
            curExR = batchExR.back();
            curIn = batchIn.back();
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
    impl_->smoothThr = throttle;
    impl_->smoothLoad = throttle;
    impl_->prevThr = throttle;

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
    }
    return "v8_crossplane";
}

}  // namespace rs
