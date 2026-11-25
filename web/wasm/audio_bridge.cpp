// Apache-2.0 — WebAssembly AudioWorklet Bridge for OpenGrid's Full-Vehicle Physical Acoustic Engine.
// Exposes rs::VehicleAudioEngine (vendored MIT engine-sim + 12 engine voices + 4-wheel tyre/road/brake/
// aero/drivetrain/impact synthesis + 8-ch Householder tunnel FDN + 2 ms true-peak lookahead limiter)
// through a flat zero-allocation C API for 128-frame AudioWorkletProcessor quanta.
#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>

#include "rs/vehicle_audio.hpp"

namespace {

constexpr int kTelemetryFloats = 128;
constexpr int kMaxRenderFrames = 256;

std::unique_ptr<rs::VehicleAudioEngine> g_engine;
alignas(16) float g_tel[kTelemetryFloats]{};
alignas(16) float g_out_l[kMaxRenderFrames]{};
alignas(16) float g_out_r[kMaxRenderFrames]{};
int g_sample_rate = 48000;
int g_sim_freq = 4000;
int g_fluid_substeps = 3;

rs::EngineVoice clamp_voice(int v) {
    if (v < 0) v = 0;
    if (v > static_cast<int>(rs::EngineVoice::I5Turbo)) v = 0;
    return static_cast<rs::EngineVoice>(v);
}

rs::ExhaustStage clamp_stage(int s) {
    if (s <= 0) return rs::ExhaustStage::Stock;
    if (s >= 2) return rs::ExhaustStage::RaceTitanium;
    return rs::ExhaustStage::Sport;
}

rs::CameraPerspective clamp_persp(int p) {
    if (p <= 0) return rs::CameraPerspective::ExteriorRear;
    if (p == 2) return rs::CameraPerspective::HoodBumper;
    if (p >= 3) return rs::CameraPerspective::InteriorCockpit;
    return rs::CameraPerspective::ExteriorChase;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int rsa_init(int voice_id, int sample_rate, int sim_freq, int fluid_substeps,
                                  int exhaust_stage, int turbo_enabled) {
    g_sample_rate = std::max(22050, std::min(96000, sample_rate));
    g_sim_freq = std::max(3000, std::min(8000, sim_freq));
    g_fluid_substeps = std::max(2, std::min(6, fluid_substeps));

    if (!g_engine) g_engine = std::make_unique<rs::VehicleAudioEngine>();
    rs::VehicleAudioConfig cfg{};
    cfg.engine.voice = clamp_voice(voice_id);
    cfg.engine.sampleRate = g_sample_rate;
    cfg.engine.simFrequency = g_sim_freq;
    cfg.engine.fluidSubsteps = g_fluid_substeps;
    cfg.engine.exhaustStage = clamp_stage(exhaust_stage);
    cfg.engine.turboEnabled = (turbo_enabled != 0);
    cfg.enableEngineSynth = true;
    cfg.enableSpatialDoppler = false;
    cfg.masterGain = 0.92f;

    if (!g_engine->initialize(cfg)) return 0;
    g_engine->warmup(0.04f, 1000.0f, 0.08f);
    return 1;
}

EMSCRIPTEN_KEEPALIVE int rsa_set_voice(int voice_id, int exhaust_stage, int turbo_enabled) {
    return rsa_init(voice_id, g_sample_rate, g_sim_freq, g_fluid_substeps, exhaust_stage, turbo_enabled);
}

EMSCRIPTEN_KEEPALIVE float* rsa_telemetry_ptr() { return g_tel; }
EMSCRIPTEN_KEEPALIVE float* rsa_out_l_ptr() { return g_out_l; }
EMSCRIPTEN_KEEPALIVE float* rsa_out_r_ptr() { return g_out_r; }

EMSCRIPTEN_KEEPALIVE void rsa_apply_telemetry() {
    if (!g_engine || !g_engine->isInitialized()) return;
    rs::VehicleAudioTelemetry t{};
    t.rpm = g_tel[0];
    t.redline_rpm = g_tel[1] > 1000.0f ? g_tel[1] : 7500.0f;
    t.throttle = g_tel[2];
    t.brake = g_tel[3];
    t.load = g_tel[4];
    t.boost_bar = g_tel[5];
    t.turbo_enabled = g_tel[6] > 0.5f;
    t.bov_venting = g_tel[7] > 0.5f;
    t.shift_cut_active = g_tel[8] > 0.5f;
    t.engine_misfire = g_tel[9] > 0.5f;
    t.starter_crank = g_tel[10] > 0.5f;
    t.gear_grind = g_tel[11] > 0.5f;
    t.gear_whine_hz = g_tel[12];
    t.gear_whine_level = g_tel[13];
    t.driveline_clunk_nm = g_tel[14];
    t.tc_slip_ratio = g_tel[15] > 0.0f ? g_tel[15] : 1.0f;
    t.tc_torque_ratio = g_tel[16] >= 1.0f ? g_tel[16] : 1.0f;
    t.speed_mps = g_tel[17];
    t.sideslip_rad = g_tel[18];
    t.front_splitter_stalled = g_tel[19] > 0.5f;
    t.exhaust_stage = clamp_stage(static_cast<int>(std::lround(g_tel[20])));
    t.perspective = clamp_persp(static_cast<int>(std::lround(g_tel[21])));
    t.reverb_mix = g_tel[22];
    t.tunnel_reflection = g_tel[23];
    t.wall_proximity_l = g_tel[24];
    t.wall_proximity_r = g_tel[25];
    t.overpass_reflection = g_tel[26];
    t.road_water_mm = g_tel[27];
    t.street_marbles = g_tel[28];
    t.external_wastegate = g_tel[29] > 0.5f;

    for (int w = 0; w < 4; ++w) {
        const float* p = g_tel + 32 + 20 * w;
        rs::WheelAudioTelemetry& wt = t.wheels[w];
        wt.contact = p[0] > 0.5f;
        wt.load_n = p[1];
        wt.slip_ratio = p[2];
        wt.slip_angle_rad = p[3];
        wt.angular_velocity = p[4];
        wt.radius_m = p[5] > 0.15f ? p[5] : 0.33f;
        wt.surface_temp_c = p[6] > -20.0f ? p[6] : 70.0f;
        wt.brake_temp_c = p[7] > -20.0f ? p[7] : 45.0f;
        wt.pressure_kpa = p[8] > 1.0f ? p[8] : 220.0f;
        wt.flat_spot_depth_mm = p[9];
        wt.rim_strike_force_n = p[10];
        wt.puncture_leak_rate = p[11];
        wt.marble_pickup = p[12];
        wt.hydroplaning_lift = p[13];
        wt.kerb_load_ratio = p[14];
        wt.surface_excitation = p[15];
        wt.cavity_mode_low_hz = p[16] > 80.0f ? p[16] : 220.0f;
        wt.cavity_mode_high_hz = p[17] > 80.0f ? p[17] : 230.0f;
        wt.cavity_ring_gain = p[18];
        wt.abs_active = p[19] >= 10.0f;
        wt.surface_kind = static_cast<int>(p[19]) % 10;
        wt.tread_pitch_hz = g_tel[30] > 50.0f ? g_tel[30] : 520.0f;
    }
    g_engine->setTelemetry(t);
}

EMSCRIPTEN_KEEPALIVE void rsa_trigger_pop(float intensity) {
    if (g_engine && g_engine->isInitialized()) g_engine->triggerExhaustPop(intensity);
}

EMSCRIPTEN_KEEPALIVE void rsa_trigger_flutter(float boost_bar) {
    if (g_engine && g_engine->isInitialized()) g_engine->triggerTurboFlutter(boost_bar);
}

EMSCRIPTEN_KEEPALIVE void rsa_trigger_crank(float duration_s) {
    if (g_engine && g_engine->isInitialized()) g_engine->triggerStarterCrank(duration_s);
}

EMSCRIPTEN_KEEPALIVE void rsa_trigger_burble(float intensity) {
    if (g_engine && g_engine->isInitialized()) g_engine->triggerOverrunBurble(intensity);
}

EMSCRIPTEN_KEEPALIVE void rsa_trigger_impact(float energy_kj) {
    if (g_engine && g_engine->isInitialized()) g_engine->triggerCrashImpact(energy_kj);
}

EMSCRIPTEN_KEEPALIVE void rsa_render(int num_frames) {
    const int n = std::max(0, std::min(kMaxRenderFrames, num_frames));
    if (!g_engine || !g_engine->isInitialized() || n <= 0) {
        if (n > 0) {
            std::memset(g_out_l, 0, sizeof(float) * static_cast<size_t>(n));
            std::memset(g_out_r, 0, sizeof(float) * static_cast<size_t>(n));
        }
        return;
    }
    g_engine->renderStereo(g_out_l, g_out_r, n);
}

}  // extern "C"
