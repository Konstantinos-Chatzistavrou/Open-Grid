// Apache-2.0 — OpenGrid Full-Vehicle Real-Time Physical Acoustic Engine (C++17, Header-Only, Zero Audio-Thread Allocs).
//
// Connects the 400 Hz physics core (rs::VehicleOutput + rs::TireAcousticSource) directly to:
//   1. Real-time thermodynamic combustion (rs::EngineAudioSynth: 12 engine architectures, dual-mic exhaust/intake,
//      8-ch Householder tunnel FDN, canyon wall & overpass reflections, wet-road specular reflections, VTEC cam
//      crossover, external wastegate screamer pipe, overrun burbles, anti-lag bangs, turbo flutter & gear whine).
//   2. 4-Wheel Physical Tyre & Surface Synthesizer (FL/FR/RL/RR stereo-imaged):
//      - Progressive rubber slip scrub -> peak stick-slip squeal -> over-limit hot howl (temperature/load pitched)
//      - Simcenter 2606 Doppler-split ~225 Hz toroidal tyre cavity resonance (from TireCondition::compute_acoustics)
//      - Tread-block rolling roar + surface textures (asphalt, sawtooth kerb rumble strips, cobble/pavement, grass)
//      - Wet road rain spray & standing-puddle hydroplaning splash
//      - Brake-lockup flat-spot speed-synchronous rhythmic thump (phase-locked to wheel rotation)
//      - Kerb/pothole rim-strike aluminum thud + pressurized sidewall puncture air-leak hiss
//      - Off-line marble & street-grit metallic fender-arch pings
//   3. Physical Brake & ABS Synthesizer (temperature-coupled rotor/pad squeal + 15 Hz hydraulic ABS valve thrum).
//   4. Drivetrain, Aero & Chassis Impact Synthesizer (driveline backlash clunk, synchro/dog-ring gear grind,
//      hydraulic torque-converter fluid whirr, v^2 aero wind rush + A-pillar whistle + sideslip shear,
//      front splitter titanium/carbon asphalt scrape, multi-mode crash metallic crunch).
//   5. True Physical 3D Spatial Doppler Processor (continuous fractional-delay Hermite interpolation:
//      f_obs / f_src = c / (c - v_rel), ISO 9613 atmospheric HF air absorption, inverse-square attenuation, ITD/pan).
//   6. Psychoacoustic Mastering Bus (tyre-limit clarity sidechain dip on engine mids + 20 Hz DC blocker +
//      2 ms true-peak lookahead brickwall limiter).
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>

#include "rs/config.hpp"
#include "rs/engine_audio.h"
#include "rs/math.hpp"
#include "rs/vehicle.hpp"

namespace rs {
namespace audio {

constexpr float kPiF = 3.14159265358979323846f;
constexpr float kTwoPiF = 6.28318530717958647692f;
constexpr float kSpeedOfSoundMps = 343.0f;

// NaN-safe (NaN -> lo): `v < lo ? lo : (v > hi ? hi : v)` returned a NaN unchanged.
inline float clampf(float v, float lo, float hi) {
    return !(v >= lo) ? lo : (v > hi ? hi : v);
}

struct FastRng {
    uint32_t s = 0x9E3779B9u;
    inline float nextSigned() {
        uint32_t x = s;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        s = x;
        return (static_cast<float>(x & 0xFFFFu) / 32767.5f) - 1.0f;
    }
    inline float next01() { return 0.5f * (nextSigned() + 1.0f); }
};

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

    void setLowpass(float fs, float fc, float q = 0.7071f) {
        fc = clampf(fc, 20.0f, fs * 0.45f);
        q = std::max(0.25f, q);
        const float w0 = kTwoPiF * fc / fs;
        const float c = std::cos(w0), s = std::sin(w0);
        const float alpha = s / (2.0f * q), a0 = 1.0f + alpha;
        b0 = ((1.0f - c) * 0.5f) / a0;
        b1 = (1.0f - c) / a0;
        b2 = b0;
        a1 = (-2.0f * c) / a0;
        a2 = (1.0f - alpha) / a0;
    }

    void setHighpass(float fs, float fc, float q = 0.7071f) {
        fc = clampf(fc, 15.0f, fs * 0.45f);
        q = std::max(0.25f, q);
        const float w0 = kTwoPiF * fc / fs;
        const float c = std::cos(w0), s = std::sin(w0);
        const float alpha = s / (2.0f * q), a0 = 1.0f + alpha;
        b0 = ((1.0f + c) * 0.5f) / a0;
        b1 = -(1.0f + c) / a0;
        b2 = b0;
        a1 = (-2.0f * c) / a0;
        a2 = (1.0f - alpha) / a0;
    }

    void setBandpass(float fs, float fc, float q = 1.5f) {
        fc = clampf(fc, 25.0f, fs * 0.45f);
        q = std::max(0.3f, q);
        const float w0 = kTwoPiF * fc / fs;
        const float c = std::cos(w0), s = std::sin(w0);
        const float alpha = s / (2.0f * q), a0 = 1.0f + alpha;
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
        const float w0 = kTwoPiF * fc / fs;
        const float c = std::cos(w0), s = std::sin(w0);
        const float alpha = s / (2.0f * q), a0 = 1.0f + alpha / A;
        b0 = (1.0f + alpha * A) / a0;
        b1 = (-2.0f * c) / a0;
        b2 = (1.0f - alpha * A) / a0;
        a1 = (-2.0f * c) / a0;
        a2 = (1.0f - alpha / A) / a0;
    }
};

// 2 ms True-Peak Lookahead Mastering Limiter (strictly zero-allocation, prevents digital harsh clipping).
class LookaheadLimiter {
public:
    static constexpr int kMaxLookahead = 128; // >= 2.6 ms @ 48 kHz

    void reset(int sampleRate, float ceiling = 0.96f) {
        fs_ = static_cast<float>(std::max(22050, sampleRate));
        ceiling_ = clampf(ceiling, 0.5f, 0.995f);
        lookahead_ = std::max(16, std::min(kMaxLookahead - 1, static_cast<int>(0.002f * fs_)));
        bufL_.fill(0.0f);
        bufR_.fill(0.0f);
        writeIdx_ = 0;
        gain_ = 1.0f;
        envPeak_ = 0.0f;
        releaseCoeff_ = std::exp(-1.0f / (0.065f * fs_));
        attackCoeff_ = std::exp(-1.0f / (0.0008f * fs_));
    }

    inline void process(float& ioL, float& ioR) {
        // A non-finite sample would poison the envelope and gain state (every later comparison is false): treat it as silence.
        const float inL = std::isfinite(ioL) ? ioL : 0.0f;
        const float inR = std::isfinite(ioR) ? ioR : 0.0f;
        const float peak = std::max(std::abs(inL), std::abs(inR));

        if (peak > envPeak_) envPeak_ = peak + attackCoeff_ * (envPeak_ - peak);
        else envPeak_ = peak + releaseCoeff_ * (envPeak_ - peak);

        const float targetGain = (envPeak_ > ceiling_) ? (ceiling_ / std::max(envPeak_, 1e-6f)) : 1.0f;
        if (targetGain < gain_) gain_ = targetGain + attackCoeff_ * (gain_ - targetGain);
        else gain_ = targetGain + releaseCoeff_ * (gain_ - targetGain);

        const int readIdx = (writeIdx_ - lookahead_) & (kMaxLookahead - 1);
        const float dL = bufL_[readIdx];
        const float dR = bufR_[readIdx];
        bufL_[writeIdx_] = inL;
        bufR_[writeIdx_] = inR;
        writeIdx_ = (writeIdx_ + 1) & (kMaxLookahead - 1);

        // Hard safety guard guarantees strict true-peak ceiling even on instantaneous impulses
        ioL = clampf(dL * gain_, -ceiling_, ceiling_);
        ioR = clampf(dR * gain_, -ceiling_, ceiling_);
    }

private:
    float fs_ = 48000.0f;
    float ceiling_ = 0.96f;
    int lookahead_ = 96;
    std::array<float, kMaxLookahead> bufL_{};
    std::array<float, kMaxLookahead> bufR_{};
    int writeIdx_ = 0;
    float gain_ = 1.0f;
    float envPeak_ = 0.0f;
    float releaseCoeff_ = 0.999f;
    float attackCoeff_ = 0.97f;
};

}  // namespace audio

// =============================================================================
// 1. True Physical 3D Spatial Doppler & Air-Absorption Processor
// =============================================================================
// Uses continuous fractional-delay Hermite interpolation (delay = distance / 343 m/s) so approaching/receding
// cars exhibit exact physical Doppler frequency shifts (f_obs / f_src = c / (c - v_rel)) without pitch-shifter
// artifacts, plus ISO 9613 atmospheric high-frequency air absorption, inverse-square attenuation, and stereo ITD/pan.
struct SpatialListenerState {
    Vec3 source_pos_m{0, 0, 0};
    Vec3 source_vel_mps{0, 0, 0};
    Vec3 listener_pos_m{0, 0, 0};
    Vec3 listener_vel_mps{0, 0, 0};
    Vec3 listener_right{0, -1, 0}; // unit vector pointing toward listener's right ear (ISO +Y is left -> right = -Y)
    float ref_distance_m = 6.0f;
    float max_distance_m = 420.0f;
};

class SpatialAcousticProcessor {
public:
    static constexpr int kRingSize = 65536; // ~1.36 s @ 48 kHz -> supports up to ~465 m propagation delay!
    static constexpr int kRingMask = kRingSize - 1;

    void initialize(int sampleRate = 48000) {
        fs_ = static_cast<float>(std::max(22050, sampleRate));
        ringL_.assign(kRingSize, 0.0f);
        ringR_.assign(kRingSize, 0.0f);
        writeIdx_ = 0;
        curDelaySamples_ = 16.0f;
        curGainL_ = curGainR_ = 1.0f;
        airLpL_.reset();
        airLpR_.reset();
        airLpL_.setLowpass(fs_, 18000.0f, 0.707f);
        airLpR_.setLowpass(fs_, 18000.0f, 0.707f);
        initialized_ = true;
    }

    void reset() {
        std::fill(ringL_.begin(), ringL_.end(), 0.0f);
        std::fill(ringR_.begin(), ringR_.end(), 0.0f);
        writeIdx_ = 0;
        airLpL_.reset();
        airLpR_.reset();
    }

    // Process a stereo block through physical Doppler propagation, air absorption, and stereo azimuth panning.
    // Smoothly advances distance at exact relative radial velocity per sample so Doppler shift is physically exact!
    void processStereo(const SpatialListenerState& st, float* ioL, float* ioR, int numFrames) {
        if (!initialized_ || numFrames <= 0 || !ioL || !ioR) return;

        const Vec3 rel = st.source_pos_m - st.listener_pos_m;
        const double dist0 = std::max(0.5, length(rel));
        const Vec3 dir = rel * (1.0 / dist0);
        // Exact retarded-time acoustic Doppler wave equation (distinguishes moving source vs moving listener!):
        //   t_emit = t - |x_src(t_emit) - x_lis(t)| / c
        //   dt_emit/dt = (c + v_lis_r) / (c + v_src_r)   where v_*_r = dot(v_*, dir) (+ = receding, - = approaching)
        //   d(delay_samples)/d(sample) = 1 - dt_emit/dt = (v_src_r - v_lis_r) / (c + v_src_r)
        const double v_src_r = clamp(dot(st.source_vel_mps, dir), -200.0, 200.0);
        const double v_lis_r = clamp(dot(st.listener_vel_mps, dir), -200.0, 200.0);
        const double c_snd = static_cast<double>(audio::kSpeedOfSoundMps);
        const double dist_retarded = dist0 * c_snd / std::max(c_snd + v_src_r, 80.0);

        const float distClamped = audio::clampf(static_cast<float>(dist_retarded), 0.5f, st.max_distance_m);
        const float targetDelay = audio::clampf((distClamped / audio::kSpeedOfSoundMps) * fs_, 4.0f, static_cast<float>(kRingSize - 8));

        // On first block or huge teleport (> 20 m jump), snap delay smoothly instead of creating supersonic Doppler shriek
        if (std::abs(targetDelay - curDelaySamples_) > (20.0f / audio::kSpeedOfSoundMps) * fs_) {
            curDelaySamples_ = targetDelay;
        }

        // ISO 9613 atmospheric high-frequency air absorption (distance-dependent lowpass: ~19 kHz near -> ~1.6 kHz far)
        const float airCut = audio::clampf(19500.0f * std::exp(-distClamped * 0.0085f) + 1200.0f, 1200.0f, fs_ * 0.44f);
        airLpL_.setLowpass(fs_, airCut, 0.707f);
        airLpR_.setLowpass(fs_, airCut, 0.707f);

        // Inverse-square-like rolloff + constant-power azimuth stereo pan
        const float atten = st.ref_distance_m / (st.ref_distance_m + std::max(0.0f, distClamped - st.ref_distance_m * 0.5f));
        const float pan = audio::clampf(static_cast<float>(dot(dir, st.listener_right)), -1.0f, 1.0f);
        const float angle = (pan + 1.0f) * 0.25f * audio::kPiF; // 0 (full L) .. pi/2 (full R)
        const float tgtGainL = atten * std::cos(angle);
        const float tgtGainR = atten * std::sin(angle);

        // Exact per-sample retarded-time delay rate: 1 - (c + v_lis_r) / (c + v_src_r)
        const float radialStep = audio::clampf(static_cast<float>((v_src_r - v_lis_r) / std::max(c_snd + v_src_r, 80.0)), -0.45f, 0.45f);
        // Gentle phase-tracking correction toward targetDelay so delay never drifts over long runs
        const float driftPull = (targetDelay - curDelaySamples_) / static_cast<float>(std::max(numFrames * 4, 512));
        const float invN = 1.0f / static_cast<float>(numFrames);
        const float dGainL = (tgtGainL - curGainL_) * invN;
        const float dGainR = (tgtGainR - curGainR_) * invN;

        // Subtle Interaural Time Difference (ITD ~0.55 ms max across human head)
        const float itdSamps = pan * 0.00055f * fs_;

        for (int i = 0; i < numFrames; ++i) {
            ringL_[writeIdx_] = ioL[i];
            ringR_[writeIdx_] = ioR[i];

            curDelaySamples_ = audio::clampf(curDelaySamples_ + radialStep + driftPull, 4.0f, static_cast<float>(kRingSize - 8));
            const float delayL = audio::clampf(curDelaySamples_ + std::max(0.0f, itdSamps), 4.0f, static_cast<float>(kRingSize - 6));
            const float delayR = audio::clampf(curDelaySamples_ + std::max(0.0f, -itdSamps), 4.0f, static_cast<float>(kRingSize - 6));

            const float sL = readHermite(ringL_, delayL);
            const float sR = readHermite(ringR_, delayR);

            curGainL_ += dGainL;
            curGainR_ += dGainR;

            const float mono = 0.5f * (sL + sR);
            // Blend stereo source width near listener -> spatialized point source at distance
            const float stereoBlend = audio::clampf(1.0f - distClamped / 25.0f, 0.0f, 1.0f);
            const float outL = airLpL_.process((sL * stereoBlend + mono * (1.0f - stereoBlend)) * curGainL_);
            const float outR = airLpR_.process((sR * stereoBlend + mono * (1.0f - stereoBlend)) * curGainR_);

            ioL[i] = outL;
            ioR[i] = outR;
            writeIdx_ = (writeIdx_ + 1) & kRingMask;
        }
    }

private:
    inline float readHermite(const std::vector<float>& ring, float delaySamples) const {
        const int i0 = static_cast<int>(delaySamples);
        const float t = delaySamples - static_cast<float>(i0);
        const int idx0 = (writeIdx_ - i0) & kRingMask;
        const float xm1 = ring[(idx0 + 1) & kRingMask];
        const float x0  = ring[idx0];
        const float x1  = ring[(idx0 - 1) & kRingMask];
        const float x2  = ring[(idx0 - 2) & kRingMask];
        const float c = (x1 - xm1) * 0.5f;
        const float v = x0 - x1;
        const float w = c + v;
        const float a = w + v + (x2 - x0) * 0.5f;
        const float b_neg = w + a;
        return (((a * t) - b_neg) * t + c) * t + x0;
    }

    bool initialized_ = false;
    float fs_ = 48000.0f;
    std::vector<float> ringL_;
    std::vector<float> ringR_;
    int writeIdx_ = 0;
    float curDelaySamples_ = 16.0f;
    float curGainL_ = 1.0f;
    float curGainR_ = 1.0f;
    audio::Biquad airLpL_, airLpR_;
};

// =============================================================================
// 2. Car-to-EngineVoice Automatic Mapper
// =============================================================================
inline EngineVoice select_voice_for_car(const CarConfig& cfg) {
    // The car file names its engine sound (the same ids as data/cars/catalog.json "engineVoice" and the web build): that is
    // authoritative. Only a car without one is guessed from its name and cylinder count below.
    if (!cfg.engine.voice.empty()) return EngineAudioSynth::parseVoice(cfg.engine.voice);
    const std::string& n = cfg.name;
    if (n.find("Rotary") != std::string::npos || n.find("Kurogane") != std::string::npos || n.find("26B") != std::string::npos)
        return EngineVoice::Rotary4;
    if (n.find("Hellhound") != std::string::npos) return EngineVoice::V8Supercharged;
    if (n.find("9R") != std::string::npos || n.find("Flat-6") != std::string::npos) return EngineVoice::Flat6Na;
    if (n.find("Integrale") != std::string::npos || n.find("Mistra") != std::string::npos || n.find("037") != std::string::npos)
        return EngineVoice::I4Turbo;
    if (n.find("Quattro") != std::string::npos || n.find("I5") != std::string::npos) return EngineVoice::I5Turbo;
    if (n.find("Ryujin") != std::string::npos || n.find("Hayate") != std::string::npos || n.find("Senkou") != std::string::npos)
        return EngineVoice::I6Forged;
    if (cfg.engine.cylinders >= 12) return EngineVoice::V12Na;
    if (cfg.engine.cylinders == 10) return EngineVoice::V10Screamer;
    if (cfg.engine.cylinders == 6) return EngineVoice::V6TwinTurbo;
    if (cfg.engine.cylinders == 5) return EngineVoice::I5Turbo;
    if (cfg.engine.cylinders == 4) return EngineVoice::I4Turbo;
    if (cfg.engine.redline_rpm >= 8300.0) return EngineVoice::V8Flatplane;
    if (n.find("Aether") != std::string::npos) return EngineVoice::V8TwinTurbo;
    return EngineVoice::V8Crossplane;
}

// =============================================================================
// 3. Full-Vehicle Acoustic Telemetry Snapshot (Physics Thread -> Audio Thread)
// =============================================================================
struct WheelAudioTelemetry {
    bool contact = false;
    float load_n = 0.0f;
    float slip_ratio = 0.0f;
    float slip_angle_rad = 0.0f;
    float angular_velocity = 0.0f;
    float radius_m = 0.33f;
    float surface_temp_c = 70.0f;
    float brake_temp_c = 45.0f;
    float pressure_kpa = 220.0f;
    float flat_spot_depth_mm = 0.0f;
    float rim_strike_force_n = 0.0f;
    float puncture_leak_rate = 0.0f;
    float marble_pickup = 0.0f;
    float hydroplaning_lift = 0.0f;
    float kerb_load_ratio = 0.0f;
    float surface_excitation = 0.0f;
    float cavity_mode_low_hz = 220.0f;
    float cavity_mode_high_hz = 230.0f;
    float cavity_ring_gain = 0.0f;
    float tread_pitch_hz = 600.0f;
    bool abs_active = false;
    int surface_kind = 0; // 0=asphalt, 1=kerb, 2=pavement/cobble, 3=grass/gravel
};

struct VehicleAudioTelemetry {
    // Engine & drivetrain
    float rpm = 950.0f;
    float redline_rpm = 7500.0f;
    float throttle = 0.0f;
    float brake = 0.0f;
    float load = 0.0f;
    float boost_bar = 0.0f;
    bool turbo_enabled = false;
    bool bov_venting = false;
    bool shift_cut_active = false;
    bool engine_misfire = false;
    bool starter_crank = false;
    bool gear_grind = false;
    float gear_whine_hz = 0.0f;
    float gear_whine_level = 0.0f;
    float driveline_clunk_nm = 0.0f;
    float tc_slip_ratio = 1.0f;
    float tc_torque_ratio = 1.0f;

    // Chassis, aero & damage
    float speed_mps = 0.0f;
    float sideslip_rad = 0.0f;
    bool front_splitter_stalled = false;
    int damage_impacts = 0;
    float last_impact_kj = 0.0f;

    // Environment & perspective
    ExhaustStage exhaust_stage = ExhaustStage::Sport;
    CameraPerspective perspective = CameraPerspective::ExteriorChase;
    float reverb_mix = 0.14f;
    float tunnel_reflection = 0.0f;
    float wall_proximity_l = 0.0f;
    float wall_proximity_r = 0.0f;
    float overpass_reflection = 0.0f;
    float road_water_mm = 0.0f;
    float street_marbles = 0.0f;
    bool external_wastegate = false;

    std::array<WheelAudioTelemetry, 4> wheels{};

    /** This telemetry with every non-finite float replaced by the same field of `last` (the last accepted values). */
    VehicleAudioTelemetry sanitized(const VehicleAudioTelemetry& last) const {
        VehicleAudioTelemetry t = *this;
        auto fin = [](float& v, float keep) { if (!std::isfinite(v)) v = keep; };
        fin(t.rpm, last.rpm);
        fin(t.redline_rpm, last.redline_rpm);
        fin(t.throttle, last.throttle);
        fin(t.brake, last.brake);
        fin(t.load, last.load);
        fin(t.boost_bar, last.boost_bar);
        fin(t.gear_whine_hz, last.gear_whine_hz);
        fin(t.gear_whine_level, last.gear_whine_level);
        fin(t.driveline_clunk_nm, last.driveline_clunk_nm);
        fin(t.tc_slip_ratio, last.tc_slip_ratio);
        fin(t.tc_torque_ratio, last.tc_torque_ratio);
        fin(t.speed_mps, last.speed_mps);
        fin(t.sideslip_rad, last.sideslip_rad);
        fin(t.last_impact_kj, last.last_impact_kj);
        fin(t.reverb_mix, last.reverb_mix);
        fin(t.tunnel_reflection, last.tunnel_reflection);
        fin(t.wall_proximity_l, last.wall_proximity_l);
        fin(t.wall_proximity_r, last.wall_proximity_r);
        fin(t.overpass_reflection, last.overpass_reflection);
        fin(t.road_water_mm, last.road_water_mm);
        fin(t.street_marbles, last.street_marbles);
        for (int w = 0; w < 4; ++w) {
            WheelAudioTelemetry& a = t.wheels[w];
            const WheelAudioTelemetry& b = last.wheels[w];
            fin(a.load_n, b.load_n);
            fin(a.slip_ratio, b.slip_ratio);
            fin(a.slip_angle_rad, b.slip_angle_rad);
            fin(a.angular_velocity, b.angular_velocity);
            fin(a.radius_m, b.radius_m);
            fin(a.surface_temp_c, b.surface_temp_c);
            fin(a.brake_temp_c, b.brake_temp_c);
            fin(a.pressure_kpa, b.pressure_kpa);
            fin(a.flat_spot_depth_mm, b.flat_spot_depth_mm);
            fin(a.rim_strike_force_n, b.rim_strike_force_n);
            fin(a.puncture_leak_rate, b.puncture_leak_rate);
            fin(a.marble_pickup, b.marble_pickup);
            fin(a.hydroplaning_lift, b.hydroplaning_lift);
            fin(a.kerb_load_ratio, b.kerb_load_ratio);
            fin(a.surface_excitation, b.surface_excitation);
            fin(a.cavity_mode_low_hz, b.cavity_mode_low_hz);
            fin(a.cavity_mode_high_hz, b.cavity_mode_high_hz);
            fin(a.cavity_ring_gain, b.cavity_ring_gain);
            fin(a.tread_pitch_hz, b.tread_pitch_hz);
        }
        return t;
    }

    static VehicleAudioTelemetry from_vehicle_output(const VehicleOutput& out, const CarConfig& cfg,
                                                     const std::array<int, 4>& wheel_surfaces = {0, 0, 0, 0},
                                                     double road_water_mm = 0.0, double street_marbles = 0.0) {
        VehicleAudioTelemetry t{};
        t.rpm = static_cast<float>(out.engine_rpm);
        t.redline_rpm = static_cast<float>(cfg.engine.redline_rpm);
        t.throttle = static_cast<float>(out.throttle_applied);
        t.brake = static_cast<float>(out.brake_applied);
        t.load = audio::clampf(t.throttle * 0.85f + (out.boost_bar > 0.1 ? 0.15f : 0.0f), 0.0f, 1.0f);
        t.boost_bar = static_cast<float>(std::max(0.0, out.boost_bar));
        t.turbo_enabled = (out.boost_bar > 0.02);
        t.bov_venting = out.bov_venting;
        t.shift_cut_active = out.shift_cut_active;
        t.engine_misfire = out.engine_misfire;
        t.gear_grind = out.gear_grind;
        t.gear_whine_hz = static_cast<float>(out.gear_whine_hz);
        t.gear_whine_level = (cfg.drivetrain.transmission == "dog_box") ? 0.65f : 0.22f;
        t.driveline_clunk_nm = static_cast<float>(out.driveline_clunk_nm);
        t.tc_slip_ratio = static_cast<float>(out.tc_slip_ratio);
        t.tc_torque_ratio = static_cast<float>(out.tc_torque_ratio);
        t.speed_mps = static_cast<float>(std::abs(out.speed));
        t.sideslip_rad = static_cast<float>(out.sideslip);
        t.front_splitter_stalled = out.front_splitter_stalled;
        t.damage_impacts = out.damage.impacts;
        t.last_impact_kj = static_cast<float>(out.damage.last_impact_kj);
        t.road_water_mm = static_cast<float>(std::max(0.0, road_water_mm));
        t.street_marbles = static_cast<float>(clamp(street_marbles, 0.0, 1.0));

        const int idx_kerb = cfg.surface_index("kerb");
        const int idx_pave = cfg.surface_index("pavement");
        const int idx_grass = cfg.surface_index("grass");

        for (int w = 0; w < 4; ++w) {
            const WheelOutput& wo = out.wheels[w];
            WheelAudioTelemetry& wt = t.wheels[w];
            wt.contact = wo.contact;
            wt.load_n = static_cast<float>(wo.load);
            wt.slip_ratio = static_cast<float>(wo.slip_ratio);
            wt.slip_angle_rad = static_cast<float>(wo.slip_angle);
            wt.angular_velocity = static_cast<float>(wo.angular_velocity);
            wt.radius_m = static_cast<float>(cfg.tire(w).radius);
            wt.surface_temp_c = static_cast<float>(wo.condition.surface_c);
            wt.brake_temp_c = static_cast<float>(wo.brake_temp_c);
            wt.pressure_kpa = static_cast<float>(wo.condition.pressure_kpa);
            wt.flat_spot_depth_mm = static_cast<float>(wo.condition.flat_spot_depth_mm);
            wt.rim_strike_force_n = static_cast<float>(wo.rim_strike_force_n);
            wt.puncture_leak_rate = static_cast<float>(wo.condition.puncture_leak_rate);
            wt.marble_pickup = static_cast<float>(wo.condition.marble_pickup);
            wt.hydroplaning_lift = static_cast<float>(wo.hydroplaning_lift);
            wt.kerb_load_ratio = static_cast<float>(wo.kerb_load_ratio);
            wt.surface_excitation = static_cast<float>(wo.surface_excitation);
            wt.abs_active = out.assists.abs_active[w];
            const TireAcousticSource ac = wo.condition.compute_acoustics(
                wo.angular_velocity, cfg.tire(w).radius, std::abs(wo.unsprung_vel_mps));
            wt.cavity_mode_low_hz = static_cast<float>(ac.cavity_mode_low_hz);
            wt.cavity_mode_high_hz = static_cast<float>(ac.cavity_mode_high_hz);
            wt.cavity_ring_gain = static_cast<float>(ac.cavity_ring_gain);
            wt.tread_pitch_hz = static_cast<float>(ac.tread_block_pitch_hz);
            if (wheel_surfaces[w] == idx_kerb) wt.surface_kind = 1;
            else if (wheel_surfaces[w] == idx_pave) wt.surface_kind = 2;
            else if (wheel_surfaces[w] == idx_grass) wt.surface_kind = 3;
            else wt.surface_kind = 0;
        }
        return t;
    }
};

// =============================================================================
// 4. Unified Full-Vehicle Physical Acoustic Engine
// =============================================================================
struct VehicleAudioConfig {
    EngineAudioConfig engine{};
    bool enableEngineSynth = true;
    bool enableSpatialDoppler = false;
    float masterGain = 0.92f;
    float engineBusGain = 0.92f;
    float tireRoadBusGain = 0.85f;
    float brakeMechBusGain = 0.80f;
    float aeroImpactBusGain = 0.78f;
};

class VehicleAudioEngine {
public:
    bool initialize(const VehicleAudioConfig& cfg) {
        cfg_ = cfg;
        fs_ = static_cast<float>(std::max(22050, std::min(96000, cfg.engine.sampleRate)));
        invFs_ = 1.0f / fs_;

        bool ok = true;
        if (cfg_.enableEngineSynth) {
            ok = engine_.initialize(cfg_.engine);
        }
        spatial_.initialize(static_cast<int>(fs_));
        limiter_.reset(static_cast<int>(fs_), 0.96f);

        setupFilters();
        resetTransientState();
        initialized_ = ok;
        return ok;
    }

    void warmup(float seconds, float rpm = 1000.0f, float throttle = 0.08f) {
        if (cfg_.enableEngineSynth && engine_.isInitialized()) {
            engine_.warmup(seconds, rpm, throttle);
        }
    }

    void setTelemetry(const VehicleAudioTelemetry& incoming) {
        // A non-finite value for one tick (a physics blow-up, a teleport) must not reach the smoothers, phases and filters,
        // where it would stay for good: keep the last finite value of that field instead.
        const VehicleAudioTelemetry t = incoming.sanitized(tel_);

        // Detect rising edges for physical one-shot acoustic events!
        if (t.bov_venting && !prevBov_) engine_.triggerTurboFlutter(std::max(0.4f, t.boost_bar));
        prevBov_ = t.bov_venting;

        if ((t.shift_cut_active && !prevShiftCut_) || (t.engine_misfire && !prevMisfire_)) {
            engine_.triggerExhaustPop(t.shift_cut_active ? 0.92f : 0.75f);
        }
        prevShiftCut_ = t.shift_cut_active;
        prevMisfire_ = t.engine_misfire;

        if (t.driveline_clunk_nm > 25.0f && prevClunkNm_ <= 25.0f) {
            clunkEnv_ = audio::clampf(t.driveline_clunk_nm / 280.0f, 0.25f, 1.0f);
            clunkPhase1_ = clunkPhase2_ = 0.0f;
        }
        prevClunkNm_ = t.driveline_clunk_nm;

        if (t.damage_impacts > prevImpacts_ && t.last_impact_kj > 0.05f) {
            impactEnv_ = std::max(impactEnv_, audio::clampf(std::sqrt(t.last_impact_kj) * 0.28f, 0.20f, 1.2f));
            impactPhase1_ = impactPhase2_ = impactPhase3_ = 0.0f;
        }
        prevImpacts_ = t.damage_impacts;

        for (int w = 0; w < 4; ++w) {
            if (t.wheels[w].rim_strike_force_n > 2000.0f && prevRimStrike_[w] <= 2000.0f) {
                wheels_[w].rimThudEnv = std::max(wheels_[w].rimThudEnv,
                    audio::clampf(t.wheels[w].rim_strike_force_n / 18000.0f, 0.25f, 1.2f));
                wheels_[w].rimThudPhase = 0.0f;
            }
            prevRimStrike_[w] = t.wheels[w].rim_strike_force_n;
        }

        tel_ = t;

        if (cfg_.enableEngineSynth) {
            EngineAudioControl ec{};
            ec.rpm = t.rpm;
            ec.throttle = t.throttle;
            ec.load = t.load;
            ec.boostBar = t.boost_bar;
            ec.reverbMix = t.reverb_mix;
            ec.ignitionCut = t.shift_cut_active || t.engine_misfire;
            ec.starterCrank = t.starter_crank;
            ec.turboEnabled = t.turbo_enabled;
            ec.exhaustStage = t.exhaust_stage;
            ec.perspective = t.perspective;
            ec.tunnelReflection = t.tunnel_reflection;
            ec.wallProximityL = t.wall_proximity_l;
            ec.wallProximityR = t.wall_proximity_r;
            ec.gearWhineLevel = t.gear_whine_level;
            ec.gearWhineHz = t.gear_whine_hz;
            ec.vehicleSpeedMps = t.speed_mps;
            ec.wetRoadReflection = audio::clampf(t.road_water_mm / 1.0f, 0.0f, 1.0f);
            ec.overpassReflection = t.overpass_reflection;
            ec.externalWastegate = t.external_wastegate;
            engine_.setControl(ec);
        }
    }

    void setSpatialListener(const SpatialListenerState& st) { spatialState_ = st; }
    void triggerExhaustPop(float intensity = 0.85f) { engine_.triggerExhaustPop(intensity); }
    void triggerTurboFlutter(float boostBar = 1.0f) { engine_.triggerTurboFlutter(boostBar); }
    void triggerStarterCrank(float durationSec = 0.42f) { engine_.triggerStarterCrank(durationSec); }
    void triggerOverrunBurble(float intensity = 0.55f) { engine_.triggerOverrunBurble(intensity); }
    void triggerCrashImpact(float energyKj) {
        impactEnv_ = std::max(impactEnv_, audio::clampf(std::sqrt(std::max(0.05f, energyKj)) * 0.28f, 0.20f, 1.25f));
        impactPhase1_ = impactPhase2_ = impactPhase3_ = 0.0f;
    }

    // Zero-allocation stereo 48 kHz renderer (supports arbitrary block sizes cleanly via 256-sample chunking).
    void renderStereo(float* outL, float* outR, int numFrames) {
        if (!initialized_ || numFrames <= 0 || !outL || !outR) {
            if (numFrames > 0) {
                if (outL) std::memset(outL, 0, sizeof(float) * static_cast<size_t>(numFrames));
                if (outR) std::memset(outR, 0, sizeof(float) * static_cast<size_t>(numFrames));
            }
            return;
        }
        int off = 0;
        while (off < numFrames) {
            const int n = std::min(kChunk, numFrames - off);
            renderChunk(outL + off, outR + off, n);
            off += n;
        }
        if (cfg_.enableSpatialDoppler) {
            spatial_.processStereo(spatialState_, outL, outR, numFrames);
        }
    }

    EngineAudioSynth& engineSynth() { return engine_; }
    const EngineAudioSynth& engineSynth() const { return engine_; }
    bool isInitialized() const { return initialized_; }

private:
    static constexpr int kChunk = 256;

    struct WheelVoice {
        float wheelPhase = 0.0f;       // rad, continuous wheel rotation for flat-spot sync
        float cavPhaseLo = 0.0f;
        float cavPhaseHi = 0.0f;
        float squealPhase1 = 0.0f;
        float squealPhase2 = 0.0f;
        float kerbPhase = 0.0f;
        float rimThudEnv = 0.0f;
        float rimThudPhase = 0.0f;
        float pingEnv = 0.0f;
        float pingPhase = 0.0f;
        float pingFreq = 2600.0f;
        float smoothSlip = 0.0f;
        float smoothLoad = 0.0f;
        float smoothSpeed = 0.0f;
        audio::Biquad scrubBp;
        audio::Biquad squealBp;
        audio::Biquad treadBp;
        audio::Biquad sprayBp;
        audio::Biquad hissBp;
    };

    void setupFilters() {
        for (int w = 0; w < 4; ++w) {
            wheels_[w].scrubBp.setBandpass(fs_, 720.0f, 1.4f);
            wheels_[w].squealBp.setBandpass(fs_, 1280.0f, 3.8f);
            wheels_[w].treadBp.setBandpass(fs_, 220.0f, 1.1f);
            wheels_[w].sprayBp.setBandpass(fs_, 3800.0f, 0.9f);
            wheels_[w].hissBp.setBandpass(fs_, 5600.0f, 1.5f);
        }
        brakeSquealBp_.setBandpass(fs_, 3400.0f, 6.5f);
        gearGrindBp_.setBandpass(fs_, 1450.0f, 1.8f);
        tcWhirrBp_.setBandpass(fs_, 1650.0f, 2.4f);
        windLp_.setLowpass(fs_, 920.0f, 0.707f);
        windHp_.setHighpass(fs_, 140.0f, 0.707f);
        scrapeBp_.setBandpass(fs_, 2600.0f, 1.4f);
        sidechainEqL_.setPeaking(fs_, 2100.0f, 1.1f, 0.0f);
        sidechainEqR_.setPeaking(fs_, 2100.0f, 1.1f, 0.0f);
        dcHpL_.setHighpass(fs_, 20.0f, 0.707f);
        dcHpR_.setHighpass(fs_, 20.0f, 0.707f);
    }

    void resetTransientState() {
        for (auto& w : wheels_) {
            w.wheelPhase = w.cavPhaseLo = w.cavPhaseHi = w.squealPhase1 = w.squealPhase2 = w.kerbPhase = 0.0f;
            w.rimThudEnv = w.rimThudPhase = w.pingEnv = w.pingPhase = 0.0f;
            w.smoothSlip = w.smoothLoad = w.smoothSpeed = 0.0f;
            w.scrubBp.reset(); w.squealBp.reset(); w.treadBp.reset(); w.sprayBp.reset(); w.hissBp.reset();
        }
        brakeSquealBp_.reset(); gearGrindBp_.reset(); tcWhirrBp_.reset();
        windLp_.reset(); windHp_.reset(); scrapeBp_.reset();
        sidechainEqL_.reset(); sidechainEqR_.reset();
        dcHpL_.reset(); dcHpR_.reset();
        clunkEnv_ = impactEnv_ = absPhase_ = brakeSquealPhase_ = grindPhase_ = tcPhase_ = windWhistlePhase_ = 0.0f;
        sidechainDuck_ = 0.0f;
        prevBov_ = prevShiftCut_ = prevMisfire_ = false;
        prevClunkNm_ = 0.0f;
        prevImpacts_ = 0;
        prevRimStrike_.fill(0.0f);
    }

    void renderChunk(float* outL, float* outR, int n) {
        // 1. Render thermodynamic engine bus into scratch buffers
        if (cfg_.enableEngineSynth && engine_.isInitialized()) {
            engine_.renderStereo(engL_.data(), engR_.data(), n);
        } else {
            std::memset(engL_.data(), 0, sizeof(float) * static_cast<size_t>(n));
            std::memset(engR_.data(), 0, sizeof(float) * static_cast<size_t>(n));
        }

        const float blockDt = static_cast<float>(n) * invFs_;
        const float ctrlAlpha = 1.0f - std::exp(-blockDt / 0.025f);
        const bool isCockpit = (tel_.perspective == CameraPerspective::InteriorCockpit);
        const float cabinDamp = isCockpit ? 0.68f : 1.0f;

        // Per-wheel block filter updates & slip peak tracking for psychoacoustic grip-clarity sidechain
        float maxSlipIndex = 0.0f;
        bool anyAbs = false;
        float maxBrakeTemp = 45.0f;
        for (int w = 0; w < 4; ++w) {
            const WheelAudioTelemetry& wt = tel_.wheels[w];
            WheelVoice& wv = wheels_[w];
            const float wheelSpeed = std::abs(wt.angular_velocity) * std::max(0.20f, wt.radius_m);
            const float combinedSlip = wt.contact ? std::hypot(wt.slip_ratio * 1.15f, std::tan(audio::clampf(wt.slip_angle_rad, -1.2f, 1.2f))) : 0.0f;
            wv.smoothSlip += (audio::clampf(combinedSlip, 0.0f, 1.5f) - wv.smoothSlip) * ctrlAlpha;
            wv.smoothLoad += (audio::clampf(wt.load_n / 4500.0f, 0.0f, 2.2f) - wv.smoothLoad) * ctrlAlpha;
            wv.smoothSpeed += (audio::clampf(wheelSpeed, 0.0f, 110.0f) - wv.smoothSpeed) * ctrlAlpha;
            maxSlipIndex = std::max(maxSlipIndex, wv.smoothSlip);
            if (wt.abs_active) anyAbs = true;
            maxBrakeTemp = std::max(maxBrakeTemp, wt.brake_temp_c);

            // Pitch tyre squeal with tread temperature & load (cold = sharper/higher, overheated = lower/groanier)
            const float tempShift = audio::clampf(1.0f - (wt.surface_temp_c - 70.0f) * 0.0028f, 0.78f, 1.18f);
            const float squealFc = audio::clampf((1080.0f + 220.0f * wv.smoothLoad) * tempShift, 750.0f, 2200.0f);
            wv.squealBp.setBandpass(fs_, squealFc, 3.6f);
            wv.treadBp.setBandpass(fs_, audio::clampf(140.0f + wt.tread_pitch_hz * 0.35f, 95.0f, 950.0f), 1.15f);
            wv.sprayBp.setBandpass(fs_, audio::clampf(2200.0f + wv.smoothSpeed * 42.0f, 1600.0f, 7200.0f), 0.95f);
        }

        // Psychoacoustic grip-clarity sidechain: gently dip engine 1.2..3.5 kHz by up to 2.8 dB when tyres near slip limit
        const float targetDuck = audio::clampf((maxSlipIndex - 0.07f) / 0.18f, 0.0f, 1.0f);
        sidechainDuck_ += (targetDuck - sidechainDuck_) * (1.0f - std::exp(-blockDt / 0.045f));
        sidechainEqL_.setPeaking(fs_, 2100.0f, 1.05f, -2.8f * sidechainDuck_);
        sidechainEqR_.setPeaking(fs_, 2100.0f, 1.05f, -2.8f * sidechainDuck_);

        // Brake squeal active on cold (<130 C) or very hot (>420 C) performance rotors under light/moderate braking
        const float brakeColdHot = (maxBrakeTemp < 130.0f) ? audio::clampf((130.0f - maxBrakeTemp) / 90.0f, 0.0f, 1.0f)
                                 : (maxBrakeTemp > 420.0f) ? audio::clampf((maxBrakeTemp - 420.0f) / 220.0f, 0.0f, 1.0f) : 0.12f;
        const float brakeSquealAmp = (tel_.brake > 0.05f && tel_.speed_mps > 1.5f && tel_.speed_mps < 45.0f)
                                   ? audio::clampf(brakeColdHot * std::sin(audio::kPiF * audio::clampf(tel_.brake, 0.0f, 1.0f)) *
                                                   audio::clampf((45.0f - tel_.speed_mps) / 30.0f, 0.0f, 1.0f), 0.0f, 1.0f) * 0.11f
                                   : 0.0f;
        const float brakeSquealHz = audio::clampf(3150.0f + (maxBrakeTemp - 100.0f) * 1.4f, 2400.0f, 4800.0f);

        // Wind rush scales with v^2 (audibly opens past 110 km/h)
        const float vNorm = audio::clampf(tel_.speed_mps / 85.0f, 0.0f, 1.4f);
        const float windAmp = vNorm * vNorm * 0.24f * (isCockpit ? 0.62f : 1.0f);
        windLp_.setLowpass(fs_, audio::clampf(380.0f + tel_.speed_mps * 14.0f, 350.0f, 2400.0f), 0.707f);
        const float windPan = audio::clampf(tel_.sideslip_rad * 1.4f, -0.45f, 0.45f);

        // Torque-converter pump/stator hydraulic whirr under slip/multiplication
        const float tcWhirrAmp = (tel_.tc_torque_ratio > 1.03f && tel_.rpm > 900.0f)
                               ? audio::clampf((tel_.tc_torque_ratio - 1.0f) * 0.75f * (0.3f + 0.7f * tel_.throttle), 0.0f, 0.8f) * 0.075f
                               : 0.0f;
        const float tcWhirrHz = audio::clampf(950.0f + tel_.rpm * 0.32f, 800.0f, 3200.0f);

        // Splitter asphalt scrape when front_splitter_stalled
        const float scrapeAmp = (tel_.front_splitter_stalled && tel_.speed_mps > 20.0f)
                              ? audio::clampf(tel_.speed_mps / 65.0f, 0.3f, 1.1f) * 0.22f : 0.0f;

        // Stereo pan positions for FL(-0.55), FR(+0.55), RL(-0.48), RR(+0.48)
        static constexpr float kWheelPanL[4] = {0.84f, 0.42f, 0.80f, 0.46f};
        static constexpr float kWheelPanR[4] = {0.42f, 0.84f, 0.46f, 0.80f};

        for (int i = 0; i < n; ++i) {
            // ---- A. 4-Wheel Physical Tyre & Surface Synthesis ----
            float tyreBusL = 0.0f, tyreBusR = 0.0f;
            for (int w = 0; w < 4; ++w) {
                const WheelAudioTelemetry& wt = tel_.wheels[w];
                WheelVoice& wv = wheels_[w];
                float wSig = 0.0f;
                const float nWhite = rng_.nextSigned();

                // Advance physical wheel rotation phase
                wv.wheelPhase += std::abs(wt.angular_velocity) * invFs_;
                if (wv.wheelPhase > audio::kTwoPiF) wv.wheelPhase -= audio::kTwoPiF;

                if (wt.contact && wv.smoothLoad > 0.02f) {
                    const float loadGain = std::sqrt(audio::clampf(wv.smoothLoad, 0.0f, 2.0f));
                    const float spdGain = audio::clampf(wv.smoothSpeed / 22.0f, 0.0f, 1.35f);

                    // 1. Tread-block rolling roar + surface texture (asphalt / kerb / cobble / grass)
                    float surfMul = 1.0f;
                    if (wt.surface_kind == 2) surfMul = 1.45f;      // cobblestones/pavement
                    else if (wt.surface_kind == 3) surfMul = 1.65f; // grass/gravel
                    wSig += wv.treadBp.process(nWhite) * 0.09f * spdGain * loadGain * surfMul;

                    // 2. Sawtooth kerb rumble strip excitation (physical kerb spacing ~0.35 m -> f = v / 0.35 Hz)
                    if (wt.kerb_load_ratio > 0.05f || wt.surface_kind == 1) {
                        const float kerbAmt = std::max(wt.kerb_load_ratio, wt.surface_kind == 1 ? 0.85f : 0.0f);
                        const float kerbHz = audio::clampf(wv.smoothSpeed / 0.35f, 18.0f, 220.0f);
                        wv.kerbPhase += audio::kTwoPiF * kerbHz * invFs_;
                        if (wv.kerbPhase > audio::kTwoPiF) wv.kerbPhase -= audio::kTwoPiF;
                        const float kerbWave = std::sin(wv.kerbPhase) * 0.72f + std::sin(wv.kerbPhase * 2.0f) * 0.28f;
                        wSig += kerbWave * kerbAmt * loadGain * audio::clampf(wv.smoothSpeed / 8.0f, 0.0f, 1.0f) * 0.16f;
                    }

                    // 3. Simcenter 2606 Doppler-split ~225 Hz toroidal tyre cavity resonance!
                    if (wt.cavity_ring_gain > 0.005f || wt.surface_excitation > 0.04f) {
                        const float cavAmp = std::max(wt.cavity_ring_gain, wt.surface_excitation * 0.35f) * loadGain * 0.11f;
                        wv.cavPhaseLo += audio::kTwoPiF * audio::clampf(wt.cavity_mode_low_hz, 150.0f, 320.0f) * invFs_;
                        wv.cavPhaseHi += audio::kTwoPiF * audio::clampf(wt.cavity_mode_high_hz, 160.0f, 340.0f) * invFs_;
                        if (wv.cavPhaseLo > audio::kTwoPiF) wv.cavPhaseLo -= audio::kTwoPiF;
                        if (wv.cavPhaseHi > audio::kTwoPiF) wv.cavPhaseHi -= audio::kTwoPiF;
                        wSig += (std::sin(wv.cavPhaseLo) + std::sin(wv.cavPhaseHi)) * 0.5f * cavAmp;
                    }

                    // 4. Progressive rubber slip: micro-scrub (3-6 deg) -> stick-slip squeal (6-12 deg) -> hot howl (>12 deg)
                    if (wv.smoothSlip > 0.035f && wv.smoothSpeed > 1.0f) {
                        const float wetDamp = audio::clampf(1.0f - tel_.road_water_mm * 0.45f, 0.20f, 1.0f);
                        const float scrubAmt = audio::clampf((wv.smoothSlip - 0.035f) / 0.12f, 0.0f, 1.0f);
                        const float squealAmt = audio::clampf((wv.smoothSlip - 0.095f) / 0.14f, 0.0f, 1.0f);
                        const float scrubNoise = wv.scrubBp.process(nWhite) * scrubAmt * 0.16f;
                        const float sqHz = audio::clampf((980.0f + 180.0f * wv.smoothLoad - (wt.surface_temp_c - 75.0f) * 2.2f), 680.0f, 1950.0f);
                        wv.squealPhase1 += audio::kTwoPiF * sqHz * invFs_;
                        wv.squealPhase2 += audio::kTwoPiF * (sqHz * 1.495f) * invFs_;
                        if (wv.squealPhase1 > audio::kTwoPiF) wv.squealPhase1 -= audio::kTwoPiF;
                        if (wv.squealPhase2 > audio::kTwoPiF) wv.squealPhase2 -= audio::kTwoPiF;
                        const float squealTone = (std::sin(wv.squealPhase1) * 0.65f + std::sin(wv.squealPhase2) * 0.35f)
                                               * (0.65f + 0.35f * wv.squealBp.process(nWhite));
                        wSig += (scrubNoise + squealTone * squealAmt * 0.19f) * loadGain * wetDamp;
                    }

                    // 5. Wet road rain spray & hydroplaning puddle splash
                    if ((tel_.road_water_mm > 0.03f || wt.hydroplaning_lift > 0.02f) && wv.smoothSpeed > 2.5f) {
                        const float wetLevel = audio::clampf(tel_.road_water_mm * 0.55f + wt.hydroplaning_lift * 1.8f, 0.0f, 1.4f);
                        wSig += wv.sprayBp.process(nWhite) * wetLevel * spdGain * 0.18f;
                    }

                    // 6. Brake-lockup flat-spot speed-synchronous rhythmic thump (once per revolution!)
                    if (wt.flat_spot_depth_mm > 0.08f && wv.smoothSpeed > 2.0f) {
                        // Sharp Gaussian pulse once per revolution when flat spot strikes the pavement
                        const float dTheta = wv.wheelPhase - audio::kPiF;
                        const float pulse = std::exp(-18.0f * dTheta * dTheta);
                        const float flatAmp = audio::clampf(wt.flat_spot_depth_mm / 1.5f, 0.0f, 1.2f) * loadGain * spdGain;
                        wSig += (pulse * 2.0f - 0.18f) * flatAmp * 0.24f;
                    }

                    // 7. Off-line marble / street-grit metallic fender-arch pings
                    const float marbleRate = (wt.marble_pickup * 14.0f + tel_.street_marbles * 8.0f) * spdGain;
                    if (marbleRate > 0.1f && wv.pingEnv < 0.02f && rng_.next01() < marbleRate * invFs_) {
                        wv.pingEnv = 0.18f + 0.22f * rng_.next01();
                        wv.pingFreq = 1950.0f + 2200.0f * rng_.next01();
                        wv.pingPhase = 0.0f;
                    }
                }

                // Fender-well marble ping decay
                if (wv.pingEnv > 0.002f) {
                    wv.pingPhase += audio::kTwoPiF * wv.pingFreq * invFs_;
                    if (wv.pingPhase > audio::kTwoPiF) wv.pingPhase -= audio::kTwoPiF;
                    wSig += std::sin(wv.pingPhase) * wv.pingEnv * 0.22f;
                    wv.pingEnv *= std::exp(-48.0f * invFs_);
                }

                // 8. Kerb / pothole rim-strike metallic thud (even if wheel bounces briefly airborne!)
                if (wv.rimThudEnv > 0.002f) {
                    wv.rimThudPhase += audio::kTwoPiF * 118.0f * invFs_;
                    if (wv.rimThudPhase > audio::kTwoPiF) wv.rimThudPhase -= audio::kTwoPiF;
                    const float thud = (std::sin(wv.rimThudPhase) * 0.72f + std::sin(wv.rimThudPhase * 3.1f) * 0.28f) * wv.rimThudEnv;
                    wSig += thud * 0.42f;
                    wv.rimThudEnv *= std::exp(-24.0f * invFs_);
                }

                // 9. Sidewall puncture pressurized bead air-leak hiss!
                if (wt.puncture_leak_rate > 0.002f && wt.pressure_kpa > 8.0f) {
                    const float hissAmp = audio::clampf(wt.puncture_leak_rate * 8.0f, 0.0f, 1.0f)
                                        * audio::clampf(wt.pressure_kpa / 180.0f, 0.0f, 1.2f);
                    wSig += wv.hissBp.process(nWhite) * hissAmp * 0.18f;
                }

                tyreBusL += wSig * kWheelPanL[w];
                tyreBusR += wSig * kWheelPanR[w];
            }

            // ---- B. Physical Brake Squeal, ABS Thrum & Drivetrain Mechanicals ----
            float mechMono = 0.0f;
            if (brakeSquealAmp > 0.0005f) {
                brakeSquealPhase_ += audio::kTwoPiF * brakeSquealHz * invFs_;
                if (brakeSquealPhase_ > audio::kTwoPiF) brakeSquealPhase_ -= audio::kTwoPiF;
                const float sqRaw = std::sin(brakeSquealPhase_) * 0.75f + brakeSquealBp_.process(rng_.nextSigned()) * 0.45f;
                mechMono += sqRaw * brakeSquealAmp;
            }
            if (anyAbs) {
                absPhase_ += audio::kTwoPiF * 15.5f * invFs_; // ~15.5 Hz hydraulic ABS valve modulator
                if (absPhase_ > audio::kTwoPiF) absPhase_ -= audio::kTwoPiF;
                const float absPulse = std::pow(0.5f + 0.5f * std::sin(absPhase_), 3.0f);
                mechMono += (absPulse * 2.0f - 0.5f) * 0.095f;
            }
            if (clunkEnv_ > 0.002f) {
                clunkPhase1_ += audio::kTwoPiF * 105.0f * invFs_;
                clunkPhase2_ += audio::kTwoPiF * 340.0f * invFs_;
                mechMono += (std::sin(clunkPhase1_) * 0.68f + std::sin(clunkPhase2_) * 0.32f) * clunkEnv_ * 0.34f;
                clunkEnv_ *= std::exp(-34.0f * invFs_);
            }
            if (tel_.gear_grind) {
                grindPhase_ += audio::kTwoPiF * 68.0f * invFs_;
                if (grindPhase_ > audio::kTwoPiF) grindPhase_ -= audio::kTwoPiF;
                const float grindMod = 0.5f + 0.5f * std::sin(grindPhase_);
                mechMono += std::tanh(gearGrindBp_.process(rng_.nextSigned()) * 2.5f) * grindMod * 0.22f;
            }
            if (tcWhirrAmp > 0.0005f) {
                tcPhase_ += audio::kTwoPiF * tcWhirrHz * invFs_;
                if (tcPhase_ > audio::kTwoPiF) tcPhase_ -= audio::kTwoPiF;
                mechMono += (std::sin(tcPhase_) * 0.45f + tcWhirrBp_.process(rng_.nextSigned()) * 0.55f) * tcWhirrAmp;
            }

            // ---- C. Aerodynamic Wind Rush, Front Splitter Scrape & Crash Metallic Crunch ----
            float aeroL = 0.0f, aeroR = 0.0f;
            if (windAmp > 0.0005f) {
                const float wNoise = windHp_.process(windLp_.process(rng_.nextSigned()));
                windWhistlePhase_ += audio::kTwoPiF * audio::clampf(420.0f + tel_.speed_mps * 9.5f, 350.0f, 1600.0f) * invFs_;
                if (windWhistlePhase_ > audio::kTwoPiF) windWhistlePhase_ -= audio::kTwoPiF;
                const float wSig = (wNoise * 0.90f + std::sin(windWhistlePhase_) * 0.06f) * windAmp;
                aeroL += wSig * (1.0f - windPan);
                aeroR += wSig * (1.0f + windPan);
            }
            if (scrapeAmp > 0.001f) {
                const float sc = std::tanh(scrapeBp_.process(rng_.nextSigned()) * 2.4f) * scrapeAmp;
                aeroL += sc;
                aeroR += sc * 0.92f;
            }
            if (impactEnv_ > 0.002f) {
                impactPhase1_ += audio::kTwoPiF * 78.0f * invFs_;
                impactPhase2_ += audio::kTwoPiF * 245.0f * invFs_;
                impactPhase3_ += audio::kTwoPiF * 690.0f * invFs_;
                const float crunch = (std::sin(impactPhase1_) * 0.48f + std::sin(impactPhase2_) * 0.24f
                                    + std::sin(impactPhase3_) * 0.14f + rng_.nextSigned() * 0.35f) * impactEnv_ * 0.55f;
                aeroL += crunch;
                aeroR += crunch * 0.96f;
                impactEnv_ *= std::exp(-11.0f * invFs_);
            }

            // ---- D. Psychoacoustic Master Bus + DC Blocker + 2 ms Lookahead True-Peak Limiter ----
            const float eL = sidechainEqL_.process(engL_[i]) * cfg_.engineBusGain;
            const float eR = sidechainEqR_.process(engR_[i]) * cfg_.engineBusGain;

            float mixL = (eL + tyreBusL * cfg_.tireRoadBusGain * cabinDamp
                        + mechMono * cfg_.brakeMechBusGain + aeroL * cfg_.aeroImpactBusGain) * cfg_.masterGain;
            float mixR = (eR + tyreBusR * cfg_.tireRoadBusGain * cabinDamp
                        + mechMono * cfg_.brakeMechBusGain + aeroR * cfg_.aeroImpactBusGain) * cfg_.masterGain;

            mixL = dcHpL_.process(mixL);
            mixR = dcHpR_.process(mixR);
            limiter_.process(mixL, mixR);

            outL[i] = mixL;
            outR[i] = mixR;
        }
    }

    bool initialized_ = false;
    VehicleAudioConfig cfg_{};
    VehicleAudioTelemetry tel_{};
    SpatialListenerState spatialState_{};
    float fs_ = 48000.0f;
    float invFs_ = 1.0f / 48000.0f;

    EngineAudioSynth engine_;
    SpatialAcousticProcessor spatial_;
    audio::LookaheadLimiter limiter_;
    audio::FastRng rng_;

    std::array<float, kChunk> engL_{};
    std::array<float, kChunk> engR_{};
    std::array<WheelVoice, 4> wheels_{};

    audio::Biquad brakeSquealBp_, gearGrindBp_, tcWhirrBp_;
    audio::Biquad windLp_, windHp_, scrapeBp_;
    audio::Biquad sidechainEqL_, sidechainEqR_;
    audio::Biquad dcHpL_, dcHpR_;

    float clunkEnv_ = 0.0f, clunkPhase1_ = 0.0f, clunkPhase2_ = 0.0f;
    float impactEnv_ = 0.0f, impactPhase1_ = 0.0f, impactPhase2_ = 0.0f, impactPhase3_ = 0.0f;
    float absPhase_ = 0.0f, brakeSquealPhase_ = 0.0f, grindPhase_ = 0.0f, tcPhase_ = 0.0f, windWhistlePhase_ = 0.0f;
    float sidechainDuck_ = 0.0f;

    bool prevBov_ = false, prevShiftCut_ = false, prevMisfire_ = false;
    float prevClunkNm_ = 0.0f;
    int prevImpacts_ = 0;
    std::array<float, 4> prevRimStrike_{};
};

}  // namespace rs
