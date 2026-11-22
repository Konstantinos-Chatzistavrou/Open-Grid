// Apache-2.0 — Headless Linux/Cross-Platform Dyno Audio Recorder for AngeTheGreat's engine-sim (MIT).
//
// Links directly against AngeTheGreat's engine-sim core thermodynamic & exhaust waveguide library
// (`libengine_sim.a`), runs exact constant-RPM dynamometer holds (both WOT load and idle/cruise),
// convolves with engine-sim's real exhaust impulse responses, and writes 44.1 kHz 16-bit PCM WAV
// captures ready for seamless phase-locked 48 kHz / 24-bit WAV (UE 5.8) & Vorbis OGG (WebGPU) mastering.
//
// Usage:
//   engine_sim_dyno <engine_id> <rpm> <throttle> <warmup_s> <record_s> <ir_dir> <out_wav>
//   engine_id: flat6 | v12 | v10 | i6 | v8_cross | v8_flat | v8_sc

#include "engine.h"
#include "piston_engine_simulator.h"
#include "direct_throttle_linkage.h"
#include "standard_valvetrain.h"
#include "gas_system.h"
#include "units.h"
#include "constants.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

struct WavData {
    std::vector<int16_t> samples;
    int sampleRate = 44100;
};

bool loadWav16Mono(const std::string &path, WavData &out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) {
        std::cerr << "ERROR: cannot open IR wav: " << path << "\n";
        return false;
    }
    char riff[4];
    uint32_t fileSize = 0;
    char wave[4];
    f.read(riff, 4);
    f.read(reinterpret_cast<char *>(&fileSize), 4);
    f.read(wave, 4);
    if (std::memcmp(riff, "RIFF", 4) != 0 || std::memcmp(wave, "WAVE", 4) != 0) {
        std::cerr << "ERROR: invalid RIFF/WAVE header in " << path << "\n";
        return false;
    }

    uint16_t audioFmt = 1, numChannels = 1, bitsPerSample = 16;
    uint32_t sampleRate = 44100;
    std::vector<uint8_t> dataChunk;

    while (f && !f.eof()) {
        char id[4];
        uint32_t sz = 0;
        f.read(id, 4);
        if (!f) break;
        f.read(reinterpret_cast<char *>(&sz), 4);
        if (!f) break;

        if (std::memcmp(id, "fmt ", 4) == 0) {
            std::vector<uint8_t> fmt(sz);
            f.read(reinterpret_cast<char *>(fmt.data()), sz);
            if (sz >= 16) {
                std::memcpy(&audioFmt, fmt.data() + 0, 2);
                std::memcpy(&numChannels, fmt.data() + 2, 2);
                std::memcpy(&sampleRate, fmt.data() + 4, 4);
                std::memcpy(&bitsPerSample, fmt.data() + 14, 2);
            }
        } else if (std::memcmp(id, "data", 4) == 0) {
            dataChunk.resize(sz);
            f.read(reinterpret_cast<char *>(dataChunk.data()), sz);
        } else {
            f.seekg(sz, std::ios::cur);
        }
        if (sz & 1) f.seekg(1, std::ios::cur);
    }

    if (dataChunk.empty()) {
        std::cerr << "ERROR: no data chunk in " << path << "\n";
        return false;
    }
    out.sampleRate = static_cast<int>(sampleRate);
    const int bytesPerSample = bitsPerSample / 8;
    const size_t nFrames = dataChunk.size() / (bytesPerSample * numChannels);
    out.samples.resize(nFrames);

    for (size_t i = 0; i < nFrames; ++i) {
        double acc = 0.0;
        for (int c = 0; c < numChannels; ++c) {
            const size_t off = (i * numChannels + c) * bytesPerSample;
            if (audioFmt == 1 && bitsPerSample == 16) {
                int16_t v = 0;
                std::memcpy(&v, dataChunk.data() + off, 2);
                acc += static_cast<double>(v);
            } else if (audioFmt == 1 && bitsPerSample == 24) {
                int32_t v = (dataChunk[off] | (dataChunk[off + 1] << 8) | (dataChunk[off + 2] << 16));
                if (v & 0x800000) v |= ~0xFFFFFF;
                acc += static_cast<double>(v >> 8);
            } else if (audioFmt == 3 && bitsPerSample == 32) {
                float v = 0.0f;
                std::memcpy(&v, dataChunk.data() + off, 4);
                acc += static_cast<double>(v) * 32767.0;
            }
        }
        double avg = acc / std::max<int>(1, numChannels);
        if (avg > 32767.0) avg = 32767.0;
        if (avg < -32768.0) avg = -32768.0;
        out.samples[i] = static_cast<int16_t>(std::lrint(avg));
    }
    return true;
}

bool writeWav16Mono(const std::string &path, const std::vector<int16_t> &samples, int sampleRate) {
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    const uint32_t dataBytes = static_cast<uint32_t>(samples.size() * sizeof(int16_t));
    const uint32_t riffSize = 36 + dataBytes;
    const uint32_t fmtSize = 16;
    const uint16_t audioFmt = 1, channels = 1, bits = 16;
    const uint32_t sr = static_cast<uint32_t>(sampleRate);
    const uint32_t byteRate = sr * channels * (bits / 8);
    const uint16_t blockAlign = channels * (bits / 8);

    f.write("RIFF", 4);
    f.write(reinterpret_cast<const char *>(&riffSize), 4);
    f.write("WAVE", 4);
    f.write("fmt ", 4);
    f.write(reinterpret_cast<const char *>(&fmtSize), 4);
    f.write(reinterpret_cast<const char *>(&audioFmt), 2);
    f.write(reinterpret_cast<const char *>(&channels), 2);
    f.write(reinterpret_cast<const char *>(&sr), 4);
    f.write(reinterpret_cast<const char *>(&byteRate), 4);
    f.write(reinterpret_cast<const char *>(&blockAlign), 2);
    f.write(reinterpret_cast<const char *>(&bits), 2);
    f.write("data", 4);
    f.write(reinterpret_cast<const char *>(&dataBytes), 4);
    f.write(reinterpret_cast<const char *>(samples.data()), dataBytes);
    return f.good();
}

// AngeTheGreat's exact harmonic_cam_lobe generator (from scripting/include/actions.h)
Function *makeHarmonicCamLobe(double durationAt50ThouDeg, double gamma, double lift, int steps = 160) {
    const double duration = durationAt50ThouDeg * units::deg;
    const double angle = duration / 4.0;
    const double s = std::pow(2.0 * units::distance(50.0, units::thou) / lift, 1.0 / gamma) - 1.0;
    const double k = std::acos(s) / angle;
    const double extents = constants::pi / k;
    const double step = extents / (steps - 5.0);

    Function *fn = new Function;
    fn->initialize(steps * 2 + 4, step);
    for (int i = 0; i < steps; ++i) {
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

Function *makeFlowCurve(const std::vector<std::pair<double, double>> &pts, double liftScale, double flowAtten) {
    Function *fn = new Function;
    fn->initialize(static_cast<int>(pts.size()) + 2, 50.0 * units::thou);
    for (const auto &p : pts) {
        fn->addSample(p.first * units::thou * liftScale, GasSystem::k_28inH2O(p.second * flowAtten));
    }
    return fn;
}

Function *makeTurbulenceCurve() {
    Function *fn = new Function;
    fn->initialize(12, 5.0);
    fn->addSample(0.0, 3.0);
    fn->addSample(5.0, 7.5);
    fn->addSample(10.0, 17.5);
    fn->addSample(15.0, 30.0);
    fn->addSample(20.0, 40.0);
    fn->addSample(25.0, 50.0);
    fn->addSample(30.0, 60.0);
    fn->addSample(35.0, 70.0);
    fn->addSample(40.0, 80.0);
    fn->addSample(45.0, 90.0);
    return fn;
}

Function *makeTimingCurve(double maxRpm) {
    Function *fn = new Function;
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

struct CylSpec {
    int bank;           // 0 or 1
    int journalIdx;     // index on crankshaft
    int exhaustIdx;     // 0 or 1
    double fireDeg;     // crank degrees in 0..720
    double primaryCm;   // header runner length delta in cm
    double atten;       // sound_attenuation
};

struct PresetSpec {
    std::string name;
    double redlineRpm;
    double boreMm;
    double strokeMm;
    double rodMm;
    double chamberCc;
    double bank0Deg;
    double bank1Deg;      // unused if numBanks == 1
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
    std::string irRelPath;
    double irVolume;
    double camDurDeg;
    double camGamma;
    double camLiftMm;
    double intakeLobeCenterDeg;
    double exhaustLobeCenterDeg;
    double flowAtten;
    double jitter;
    double noise;
    double hfGain;
    std::vector<double> journalDegs;
    std::vector<CylSpec> cyls;
};

PresetSpec getPreset(const std::string &id) {
    PresetSpec s{};
    s.rodMm = 148.0;
    s.crankMassKg = 22.0;
    s.flywheelMassKg = 12.0;
    s.flywheelRadiusIn = 7.0;
    s.frictionLbFt = 12.0;
    s.intakePlenumL = 1.325;
    s.intakeFlowCfm = 900.0;
    s.runnerFlowCfm = 180.0;
    s.runnerLenIn = 10.0;
    s.idlePlatePos = 0.994;
    s.exOutletCfm = 1400.0;
    s.exPrimaryLenIn = 29.0;
    s.exPrimaryCfm = 600.0;
    s.exLen0In = 100.0;
    s.exLen1In = 100.0;
    s.exVol0 = 0.25;
    s.exVol1 = 0.25;
    s.exVelDecay = 0.5;
    s.irRelPath = "new/mild_exhaust_reverb.wav";
    s.irVolume = 0.01;
    s.camDurDeg = 230.0;
    s.camGamma = 0.95;
    s.camLiftMm = 13.5;
    s.intakeLobeCenterDeg = 114.0;
    s.exhaustLobeCenterDeg = 114.0;
    s.flowAtten = 1.0;
    s.jitter = 0.16;
    s.noise = 0.95;
    s.hfGain = 0.012;

    if (id == "flat6") {
        // Porsche 911 GT3 RS 4.0L Flat-6 Boxer (180° opposed banks, 1-6-2-4-3-5 every 120°, 9000 RPM!)
        s.name = "Porsche 911 GT3 4.0L Flat-6";
        s.redlineRpm = 9200.0;
        s.boreMm = 102.0;
        s.strokeMm = 81.5;
        s.rodMm = 138.0;
        s.chamberCc = 56.0;
        s.numBanks = 2;
        s.bank0Deg = 90.0;
        s.bank1Deg = -90.0;
        s.tdcDeg = 180.0;
        s.intakeFlowCfm = 1100.0;
        s.runnerFlowCfm = 210.0;
        s.runnerLenIn = 8.0;
        s.exOutletCfm = 1500.0;
        s.exPrimaryLenIn = 26.0;
        s.exPrimaryCfm = 650.0;
        s.exLen0In = 84.0;
        s.exLen1In = 87.0;
        s.exVol0 = 0.25;
        s.exVol1 = 0.24;
        s.irRelPath = "new/mild_exhaust_reverb.wav";
        s.irVolume = 0.01;
        s.camDurDeg = 236.0;
        s.camGamma = 0.9;
        s.camLiftMm = 13.8;
        s.intakeLobeCenterDeg = 108.0;
        s.exhaustLobeCenterDeg = 112.0;
        s.flowAtten = 1.25;
        s.jitter = 0.14;
        // 6 independent crank throws for true 180° opposed Boxer-6 (pistons move symmetrically!)
        s.journalDegs = { 0.0, 240.0, 120.0, 180.0, 60.0, 300.0 };
        // Firing order 1-6-2-4-3-5 every 120 deg (L: 1,2,3 at 0,240,480; R: 6,4,5 at 120,360,600)
        s.cyls = {
            {0, 0, 0,   0.0, 2.0, 0.95},
            {0, 1, 0, 240.0, 3.5, 0.90},
            {0, 2, 0, 480.0, 5.0, 1.02},
            {1, 3, 1, 360.0, 2.5, 0.92},
            {1, 4, 1, 600.0, 4.0, 1.00},
            {1, 5, 1, 120.0, 1.5, 0.88},
        };
    } else if (id == "v12") {
        // AngeTheGreat's exact Ferrari 412 T2 V12 (atg-video-2/12_ferrari_412_t2.mr)
        s.name = "Ferrari 412 T2 V12";
        s.redlineRpm = 14000.0;
        s.boreMm = 86.0;
        s.strokeMm = 52.0; // slightly deeper than 43mm F1 so street SP3/812 V12 has massive body too!
        s.rodMm = 120.0;
        s.chamberCc = 34.0;
        s.numBanks = 2;
        s.bank0Deg = 37.5;
        s.bank1Deg = -37.5;
        s.tdcDeg = 90.0 + 37.5;
        s.crankMassKg = 14.0;
        s.flywheelMassKg = 7.0;
        s.flywheelRadiusIn = 5.5;
        s.frictionLbFt = 3.0;
        s.intakeFlowCfm = 1400.0;
        s.runnerFlowCfm = 220.0;
        s.runnerLenIn = 4.5;
        s.exOutletCfm = 2000.0;
        s.exPrimaryLenIn = 22.0;
        s.exPrimaryCfm = 400.0;
        s.exLen0In = 34.0;
        s.exLen1In = 52.0;
        s.exVol0 = 0.05;
        s.exVol1 = 0.05;
        s.irRelPath = "new/minimal_muffling_01.wav";
        s.irVolume = 0.01;
        s.camDurDeg = 242.0;
        s.camGamma = 0.85;
        s.camLiftMm = 15.2;
        s.intakeLobeCenterDeg = 94.0;
        s.exhaustLobeCenterDeg = 112.0;
        s.flowAtten = 1.1;
        s.jitter = 0.12;
        s.journalDegs = { 0.0, 120.0, 240.0, 240.0, 120.0, 0.0 };
        // 1-12-5-8-3-10-6-7-2-11-4-9
        s.cyls = {
            {0, 0, 1,   0.0, 0.5, 0.80},
            {0, 1, 1, 480.0, 0.2, 1.00},
            {0, 2, 1, 240.0, 0.4, 0.85},
            {0, 3, 1, 600.0, 1.5, 0.92},
            {0, 4, 1, 120.0, 2.2, 0.78},
            {0, 5, 1, 360.0, 0.8, 0.98},
            {1, 0, 0,  75.0, 0.5, 0.82},
            {1, 1, 0, 555.0, 0.4, 0.76},
            {1, 2, 0, 315.0, 2.8, 0.95},
            {1, 3, 0, 675.0, 1.5, 1.05},
            {1, 4, 0, 195.0, 0.6, 0.84},
            {1, 5, 0, 435.0, 1.4, 1.02},
        };
    } else if (id == "v10") {
        // AngeTheGreat's exact Lexus LFA / Exotic 72° V10 (atg-video-2/10_lfa_v10.mr)
        s.name = "LFA / Exotic 72deg V10";
        s.redlineRpm = 9500.0;
        s.boreMm = 88.0;
        s.strokeMm = 79.0;
        s.rodMm = 130.0;
        s.chamberCc = 42.0;
        s.numBanks = 2;
        s.bank0Deg = 36.0;
        s.bank1Deg = -36.0;
        s.tdcDeg = 90.0 + 36.0;
        s.frictionLbFt = 4.0;
        s.intakeFlowCfm = 1100.0;
        s.runnerFlowCfm = 200.0;
        s.runnerLenIn = 4.5;
        s.exOutletCfm = 2000.0;
        s.exPrimaryLenIn = 46.0;
        s.exPrimaryCfm = 900.0;
        s.exLen0In = 100.0;
        s.exLen1In = 100.5;
        s.exVol0 = 0.5;
        s.exVol1 = 0.5;
        s.exVelDecay = 0.8;
        s.irRelPath = "new/mild_exhaust_reverb.wav";
        s.irVolume = 0.01;
        s.camDurDeg = 230.0;
        s.camGamma = 1.05;
        s.camLiftMm = 15.5;
        s.intakeLobeCenterDeg = 94.0;
        s.exhaustLobeCenterDeg = 112.0;
        s.flowAtten = 1.45;
        s.jitter = 0.14;
        s.journalDegs = { 0.0, 144.0, 216.0, 288.0, 72.0 };
        s.cyls = {
            {0, 0, 1, 0 * 72.0, 5.0, 0.85},
            {0, 1, 1, 2 * 72.0, 4.0, 1.00},
            {0, 2, 1, 8 * 72.0, 3.0, 1.08},
            {0, 3, 1, 4 * 72.0, 2.0, 0.92},
            {0, 4, 1, 6 * 72.0, 1.0, 0.78},
            {1, 0, 0, 1 * 72.0, 5.0, 0.78},
            {1, 1, 0, 3 * 72.0, 4.0, 0.86},
            {1, 2, 0, 9 * 72.0, 3.0, 0.94},
            {1, 3, 0, 5 * 72.0, 2.0, 1.06},
            {1, 4, 0, 7 * 72.0, 1.0, 0.82},
        };
    } else if (id == "i6") {
        // AngeTheGreat's exact Toyota 2JZ Inline-6 (atg-video-2/03_2jz.mr)
        s.name = "Toyota 2JZ Inline-6";
        s.redlineRpm = 8200.0;
        s.boreMm = 86.0;
        s.strokeMm = 86.0;
        s.rodMm = 142.0;
        s.chamberCc = 50.0;
        s.numBanks = 1;
        s.bank0Deg = 0.0;
        s.bank1Deg = 0.0;
        s.tdcDeg = 90.0;
        s.crankMassKg = 15.0;
        s.flywheelMassKg = 10.0;
        s.frictionLbFt = 5.0;
        s.intakePlenumL = 1.1;
        s.intakeFlowCfm = 650.0;
        s.runnerFlowCfm = 200.0;
        s.runnerLenIn = 22.0;
        s.exOutletCfm = 1100.0;
        s.exPrimaryLenIn = 34.0;
        s.exPrimaryCfm = 450.0;
        s.exLen0In = 96.0;
        s.exLen1In = 96.0;
        s.exVol0 = 0.25;
        s.exVol1 = 0.25;
        s.exVelDecay = 0.8;
        s.irRelPath = "new/mild_exhaust_reverb.wav";
        s.irVolume = 0.01;
        s.camDurDeg = 224.0;
        s.camGamma = 1.05;
        s.camLiftMm = 10.8;
        s.intakeLobeCenterDeg = 114.0;
        s.exhaustLobeCenterDeg = 114.0;
        s.flowAtten = 1.05;
        s.jitter = 0.18;
        // 1-5-3-6-2-4
        s.journalDegs = { 0.0, 480.0, 240.0, 600.0, 120.0, 360.0 };
        s.cyls = {
            {0, 0, 0,   0.0, 6.0, 0.90},
            {0, 1, 0, 480.0, 4.8, 0.95},
            {0, 2, 0, 240.0, 3.6, 0.92},
            {0, 3, 1, 600.0, 3.6, 0.97},
            {0, 4, 1, 120.0, 4.8, 0.98},
            {0, 5, 1, 360.0, 6.0, 0.93},
        };
    } else if (id == "v8_flat") {
        // AngeTheGreat's exact Ferrari F136 Flat-Plane V8 (atg-video-2/08_ferrari_f136_v8.mr)
        s.name = "Ferrari F136 Flat-Plane V8";
        s.redlineRpm = 9000.0;
        s.boreMm = 94.0;
        s.strokeMm = 81.0;
        s.rodMm = 160.0;
        s.chamberCc = 72.0;
        s.numBanks = 2;
        s.bank0Deg = 45.0;
        s.bank1Deg = -45.0;
        s.tdcDeg = 90.0 + 45.0;
        s.frictionLbFt = 14.0;
        s.intakeFlowCfm = 900.0;
        s.runnerFlowCfm = 150.0;
        s.runnerLenIn = 10.0;
        s.exOutletCfm = 1200.0;
        s.exPrimaryLenIn = 29.0;
        s.exPrimaryCfm = 600.0;
        s.exLen0In = 100.0;
        s.exLen1In = 100.0;
        s.exVol0 = 0.20;
        s.exVol1 = 0.19;
        s.irRelPath = "new/mild_exhaust_reverb.wav";
        s.irVolume = 0.01;
        s.camDurDeg = 232.0;
        s.camGamma = 0.9;
        s.camLiftMm = 14.0;
        s.intakeLobeCenterDeg = 116.0;
        s.exhaustLobeCenterDeg = 116.0;
        s.flowAtten = 1.1;
        s.jitter = 0.14;
        // 1-5-3-7-4-8-2-6 flat-plane 0/180/180/0
        s.journalDegs = { 0.0, 180.0, 180.0, 0.0 };
        s.cyls = {
            {0, 0, 0, 0 * 90.0, 2.0, 0.92},
            {0, 1, 0, 6 * 90.0, 1.0, 0.84},
            {0, 2, 0, 2 * 90.0, 3.0, 1.06},
            {0, 3, 0, 4 * 90.0, 5.0, 0.98},
            {1, 0, 1, 1 * 90.0, 1.0, 1.00},
            {1, 1, 1, 7 * 90.0, 5.0, 0.84},
            {1, 2, 1, 3 * 90.0, 7.0, 0.92},
            {1, 3, 1, 5 * 90.0, 0.5, 0.78},
        };
    } else {
        // v8_cross or v8_sc: AngeTheGreat's exact GM LS Cross-Plane V8 (atg-video-2/07_gm_ls.mr)
        s.name = (id == "v8_sc") ? "GM LS Supercharged Cross-Plane V8" : "GM LS Cross-Plane V8";
        s.redlineRpm = 7200.0;
        s.boreMm = 96.0;
        s.strokeMm = 92.0;
        s.rodMm = 160.0;
        s.chamberCc = 82.0;
        s.numBanks = 2;
        s.bank0Deg = -45.0;
        s.bank1Deg = 45.0;
        s.tdcDeg = 90.0 - 45.0;
        s.frictionLbFt = 16.0;
        s.intakeFlowCfm = (id == "v8_sc") ? 1100.0 : 850.0;
        s.runnerFlowCfm = 140.0;
        s.runnerLenIn = 12.0;
        s.exOutletCfm = 1200.0;
        s.exPrimaryLenIn = 29.0;
        s.exPrimaryCfm = 550.0;
        s.exLen0In = 100.0;
        s.exLen1In = 142.0; // classic unequal dual exhaust cross-plane burble!
        s.exVol0 = 0.35;
        s.exVol1 = 0.35;
        s.exVelDecay = 0.8;
        s.irRelPath = (id == "v8_sc") ? "new/mild_exhaust.wav" : "new/mild_exhaust_reverb.wav";
        s.irVolume = 0.01;
        s.camDurDeg = 228.0;
        s.camGamma = 0.95;
        s.camLiftMm = 14.5;
        s.intakeLobeCenterDeg = 114.0;
        s.exhaustLobeCenterDeg = 114.0;
        s.flowAtten = 1.05;
        s.jitter = 0.22;
        // 1-8-7-2-6-5-4-3 cross-plane 0/270/90/180
        s.journalDegs = { 0.0, 270.0, 90.0, 180.0 };
        s.cyls = {
            {0, 0, 0, 0 * 90.0, 2.0, 0.98},
            {0, 1, 0, 7 * 90.0, 6.0, 0.92},
            {0, 2, 0, 5 * 90.0, 4.0, 1.04},
            {0, 3, 0, 2 * 90.0, 8.0, 0.95},
            {1, 0, 1, 3 * 90.0, 3.0, 1.00},
            {1, 1, 1, 6 * 90.0, 7.0, 0.90},
            {1, 2, 1, 4 * 90.0, 5.0, 0.96},
            {1, 3, 1, 1 * 90.0, 1.0, 1.02},
        };
    }
    return s;
}

Engine *buildEngineFromPreset(const PresetSpec &s, const std::string &irDir) {
    Engine *engine = new Engine;

    DirectThrottleLinkage *throttle = new DirectThrottleLinkage;
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
    ep.throttle = throttle;
    ep.initialSimulationFrequency = 10000.0;
    ep.initialHighFrequencyGain = s.hfGain;
    ep.initialNoise = s.noise;
    ep.initialJitter = s.jitter;
    engine->initialize(ep);

    // Exhaust impulse responses & systems
    for (int eIdx = 0; eIdx < 2; ++eIdx) {
        ImpulseResponse *ir = new ImpulseResponse;
        ir->initialize(irDir + "/" + s.irRelPath, s.irVolume);
        ExhaustSystem::Parameters esp{};
        esp.length = units::distance(eIdx == 0 ? s.exLen0In : s.exLen1In, units::inch);
        esp.collectorCrossSectionArea = units::area(16.0, units::cm2);
        esp.outletFlowRate = GasSystem::k_carb(s.exOutletCfm);
        esp.primaryTubeLength = units::distance(s.exPrimaryLenIn, units::inch);
        esp.primaryFlowRate = GasSystem::k_carb(s.exPrimaryCfm);
        esp.velocityDecay = s.exVelDecay;
        esp.audioVolume = (eIdx == 0 ? s.exVol0 : s.exVol1);
        esp.impulseResponse = ir;
        engine->getExhaustSystem(eIdx)->initialize(esp);
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

    Crankshaft *crank = engine->getCrankshaft(0);
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

    // Shared harmonic cam lobe & port flow curves
    Function *inLobe = makeHarmonicCamLobe(s.camDurDeg, s.camGamma, s.camLiftMm * units::mm, 160);
    Function *exLobe = makeHarmonicCamLobe(s.camDurDeg, s.camGamma, s.camLiftMm * units::mm, 160);
    const std::vector<std::pair<double, double>> inFlowPts = {
        {0, 0}, {50, 58}, {100, 103}, {150, 156}, {200, 214},
        {250, 249}, {300, 268}, {350, 280}, {400, 280}, {450, 281}
    };
    const std::vector<std::pair<double, double>> exFlowPts = {
        {0, 0}, {50, 37}, {100, 72}, {150, 113}, {200, 160},
        {250, 196}, {300, 222}, {350, 235}, {400, 245}, {450, 246}
    };
    Function *inFlow = makeFlowCurve(inFlowPts, 1.0, s.flowAtten);
    Function *exFlow = makeFlowCurve(exFlowPts, 1.0, s.flowAtten);

    // Group cylinders by bank
    std::vector<std::vector<int>> bankCyls(s.numBanks);
    for (int i = 0; i < nCyl; ++i) bankCyls[s.cyls[i].bank].push_back(i);

    int cylGlobal = 0;
    std::vector<int> specToGlobal(nCyl, 0);

    for (int b = 0; b < s.numBanks; ++b) {
        const int bCount = static_cast<int>(bankCyls[b].size());
        CylinderBank *bank = engine->getCylinderBank(b);
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

        Camshaft *inCam = new Camshaft;
        Camshaft *exCam = new Camshaft;
        Camshaft::Parameters inCp{};
        inCp.lobes = bCount;
        inCp.advance = 0.0;
        inCp.crankshaft = crank;
        inCp.lobeProfile = inLobe;
        inCp.baseRadius = 0.9 * units::inch;
        inCam->initialize(inCp);

        Camshaft::Parameters exCp = inCp;
        exCp.lobeProfile = exLobe;
        exCam->initialize(exCp);

        for (int loc = 0; loc < bCount; ++loc) {
            const int si = bankCyls[b][loc];
            const CylSpec &cs = s.cyls[si];
            specToGlobal[si] = cylGlobal;

            Piston *piston = engine->getPiston(cylGlobal);
            ConnectingRod *rod = engine->getConnectingRod(cylGlobal);

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

            // Standard 4-stroke cam lobe placement around firing TDC (360° + fireDeg)
            exCam->setLobeCenterline(loc, (360.0 - s.exhaustLobeCenterDeg + cs.fireDeg) * units::deg);
            inCam->setLobeCenterline(loc, (360.0 + s.intakeLobeCenterDeg + cs.fireDeg) * units::deg);
            cylGlobal++;
        }

        StandardValvetrain *vt = new StandardValvetrain;
        StandardValvetrain::Parameters vtp{};
        vtp.intakeCamshaft = inCam;
        vtp.exhaustCamshaft = exCam;
        vt->initialize(vtp);

        CylinderHead *head = engine->getHead(b);
        CylinderHead::Parameters hp{};
        hp.Bank = bank;
        hp.ExhaustPortFlow = exFlow;
        hp.IntakePortFlow = inFlow;
        hp.Valvetrain = vt;
        hp.CombustionChamberVolume = s.chamberCc * units::cc;
        hp.IntakeRunnerVolume = 149.6 * units::cc;
        hp.IntakeRunnerCrossSectionArea = (2.0 * units::inch) * (2.0 * units::inch);
        hp.ExhaustRunnerVolume = 50.0 * units::cc;
        hp.ExhaustRunnerCrossSectionArea = (1.85 * units::inch) * (1.85 * units::inch);
        hp.FlipDisplay = (b == 0);
        head->initialize(hp);

        for (int loc = 0; loc < bCount; ++loc) {
            const CylSpec &cs = s.cyls[bankCyls[b][loc]];
            head->setIntake(loc, engine->getIntake(0));
            head->setExhaustSystem(loc, engine->getExhaustSystem(cs.exhaustIdx));
            head->setSoundAttenuation(loc, cs.atten);
            head->setHeaderPrimaryLength(loc, cs.primaryCm * units::cm);
        }
    }

    // Ignition module
    IgnitionModule::Parameters imp{};
    imp.cylinderCount = nCyl;
    imp.crankshaft = crank;
    imp.timingCurve = makeTimingCurve(s.redlineRpm);
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
    fp.burningEfficiencyRandomness = 0.18;
    fp.turbulenceToFlameSpeedRatio = makeTurbulenceCurve();
    engine->getFuel()->initialize(fp);

    Function *mpsToTurb = new Function;
    mpsToTurb->initialize(32, 1.0);
    for (int i = 0; i < 30; ++i) mpsToTurb->addSample(static_cast<double>(i), i * 0.5);

    CombustionChamber::Parameters ccp{};
    ccp.CrankcasePressure = units::pressure(1.0, units::atm);
    ccp.Fuel = engine->getFuel();
    ccp.StartingPressure = units::pressure(1.0, units::atm);
    ccp.StartingTemperature = 298.15;
    ccp.MeanPistonSpeedToTurbulence = mpsToTurb;
    for (int i = 0; i < nCyl; ++i) {
        ccp.Piston = engine->getPiston(i);
        ccp.Head = engine->getHead(ccp.Piston->getCylinderBank()->getIndex());
        engine->getChamber(i)->initialize(ccp);
    }

    engine->calculateDisplacement();
    return engine;
}

} // namespace

int main(int argc, char **argv) {
    if (argc < 8) {
        std::cerr << "Usage: engine_sim_dyno <engine_id> <rpm> <throttle> <warmup_s> <record_s> <ir_dir> <out_wav>\n";
        return 1;
    }
    const std::string engineId = argv[1];
    const double targetRpm = std::atof(argv[2]);
    const double throttle = std::atof(argv[3]);
    const double warmupS = std::atof(argv[4]);
    const double recordS = std::atof(argv[5]);
    const std::string irDir = argv[6];
    const std::string outWav = argv[7];

    PresetSpec preset = getPreset(engineId);
    Engine *engine = buildEngineFromPreset(preset, irDir);

    Vehicle *vehicle = new Vehicle;
    Vehicle::Parameters vp{};
    vp.mass = 1450.0;
    vp.diffRatio = 3.42;
    vp.tireRadius = 12.0 * units::inch;
    vp.dragCoefficient = 0.30;
    vp.crossSectionArea = 2.0;
    vp.rollingResistance = 200.0;
    vehicle->initialize(vp);

    Transmission *trans = new Transmission;
    const double gears[] = { 3.23, 2.19, 1.61, 1.23, 0.97, 0.80 };
    Transmission::Parameters trp{};
    trp.GearCount = 6;
    trp.GearRatios = gears;
    trp.MaxClutchTorque = units::torque(800.0, units::ft_lb);
    trans->initialize(trp);
    trans->changeGear(-1); // neutral — dyno controls exact engine RPM!

    Simulator *sim = engine->createSimulator(vehicle, trans);
    sim->setSimulationFrequency(engine->getSimulationFrequency());

    Synthesizer::AudioParameters ap = sim->synthesizer().getAudioParameters();
    ap.inputSampleNoise = static_cast<float>(engine->getInitialJitter());
    ap.airNoise = static_cast<float>(engine->getInitialNoise());
    ap.dF_F_mix = static_cast<float>(engine->getInitialHighFrequencyGain());
    ap.convolution = 1.0f;
    ap.volume = 0.62f;
    ap.levelerTarget = 17500.0f;
    sim->synthesizer().setAudioParameters(ap);

    for (int i = 0; i < engine->getExhaustSystemCount(); ++i) {
        ImpulseResponse *ir = engine->getExhaustSystem(i)->getImpulseResponse();
        WavData wd;
        if (!loadWav16Mono(ir->getFilename(), wd)) return 2;
        sim->synthesizer().initializeImpulseResponse(
            wd.samples.data(),
            static_cast<unsigned int>(wd.samples.size()),
            static_cast<float>(ir->getVolume()),
            i
        );
    }

    // Engage built-in dynamometer hold at exact target RPM + real combustion throttle!
    sim->m_dyno.m_enabled = true;
    sim->m_dyno.m_hold = true;
    sim->m_dyno.m_rotationSpeed = units::rpm(targetRpm);
    sim->m_starterMotor.m_enabled = false;
    engine->setSpeedControl(throttle);

    sim->startAudioRenderingThread();

    const double dt = 1.0 / 60.0;
    const int warmupFrames = static_cast<int>(std::ceil(warmupS / dt));
    const int recordFrames = static_cast<int>(std::ceil(recordS / dt));
    std::vector<int16_t> recorded;
    recorded.reserve(static_cast<size_t>((recordS + 0.5) * 44100));
    std::vector<int16_t> chunk(4096);

    double rpmSum = 0.0;
    int rpmCnt = 0;

    for (int f = 0; f < warmupFrames + recordFrames; ++f) {
        // Gently ramp dyno speed in first 0.25s so cylinder gas & crank start cleanly
        const double ramp = std::min(1.0, (f + 1) / 15.0);
        sim->m_dyno.m_rotationSpeed = units::rpm(std::max(500.0, targetRpm * (0.4 + 0.6 * ramp)));
        engine->setSpeedControl(throttle);

        sim->startFrame(dt);
        while (sim->simulateStep()) {}
        sim->endFrame();
        sim->synthesizer().waitProcessed();

        int got = sim->readAudioOutput(static_cast<int>(chunk.size()), chunk.data());
        if (f >= warmupFrames) {
            recorded.insert(recorded.end(), chunk.begin(), chunk.begin() + got);
            rpmSum += engine->getRpm();
            rpmCnt++;
        }
    }

    sim->endAudioRenderingThread();
    const double avgRpm = rpmCnt > 0 ? rpmSum / rpmCnt : 0.0;

    if (!writeWav16Mono(outWav, recorded, 44100)) {
        std::cerr << "ERROR: failed to write " << outWav << "\n";
        return 3;
    }

    std::cout << "OK engine-sim " << engineId << " target=" << targetRpm
              << " actual_avg_rpm=" << static_cast<int>(std::lrint(avgRpm))
              << " thr=" << throttle << " samples=" << recorded.size()
              << " (" << (recorded.size() / 44100.0) << "s) -> " << outWav << "\n";
    return 0;
}
