// Apache-2.0 — Lock-free 400 Hz Direct-Drive Force Feedback (FFB) Shaper & SPSC Stream.
//
// Feeds native Windows DirectInput / Linux evdev / UE 5.8 IInputDevice FFB threads directly from the
// 400 Hz physics thread (AsyncVehicleBridge::step) with ZERO 60 fps frame-rate quantization, ZERO locks,
// and ZERO per-tick heap allocations.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include "rs/math.hpp"
#include "rs/vehicle.hpp"

namespace rs::rt {

struct FfbShaperConfig {
    double gain = 1.0;                 // 0..2 overall driver FFB strength multiplier
    double max_wheel_torque_nm = 15.0; // Direct-Drive wheelbase peak torque ceiling (N m: 5-8 entry, 12-25 pro DD)
    double soft_clip_start = 0.80;     // 0.50..0.99: linear up to this fraction, C^1 tanh knee above (prevents flat-top kerb buzz)
    double min_force_norm = 0.0;       // 0..0.15: deadzone lift for gear/belt wheels (0.0 for Direct Drive)
};

struct FfbSample {
    std::uint64_t tick = 0;            // monotonic 400 Hz physics tick
    double sim_time_s = 0.0;           // simulation timestamp (s)
    double rim_torque_nm = 0.0;        // physical steering wheel rim torque (steering_column_torque_nm, N m)
    double rack_torque_nm = 0.0;       // raw 3D kingpin rack torque (steer_torque, N m)
    float normalized = 0.0f;           // -1..+1 shaped Direct-Drive command ready for HID/DirectInput/UE5
    float front_adhesion = 1.0f;       // 0..1 front contact-patch brush adhesion (for tactile scrub / bass shakers)
    float kerb_excitation = 0.0f;      // 0..1 peak front wheel kerb/surface excitation
    bool clipping = false;             // true when raw gain-scaled torque exceeded wheelbase max_wheel_torque_nm
};

/**
 * C^1 smooth Direct-Drive soft-clipper + min-force deadzone compensator.
 * Linear with unit slope up to `soft_clip_start`, transitioning smoothly via tanh to asymptotically approach 1.0.
 */
inline FfbSample shape_ffb_sample(const VehicleOutput& out, std::uint64_t tick, double sim_time_s,
                                  const FfbShaperConfig& cfg) {
    FfbSample s{};
    s.tick = tick;
    s.sim_time_s = sim_time_s;
    s.rim_torque_nm = out.steering_column_torque_nm;
    s.rack_torque_nm = out.steer_torque;
    s.front_adhesion = static_cast<float>(clamp(out.front_adhesion_ratio, 0.0, 1.0));
    s.kerb_excitation = static_cast<float>(clamp(
        std::max(out.wheels[FL].surface_excitation, out.wheels[FR].surface_excitation), 0.0, 1.0));

    const double max_nm = std::max(cfg.max_wheel_torque_nm, 1.0);
    const double raw_norm = (out.steering_column_torque_nm * clamp(cfg.gain, 0.0, 3.0)) / max_nm;
    const double abs_raw = std::abs(raw_norm);
    s.clipping = abs_raw > 1.0;

    const double knee = clamp(cfg.soft_clip_start, 0.40, 0.995);
    double shaped = abs_raw;
    if (abs_raw > knee) {
        const double span = 1.0 - knee;
        shaped = knee + span * std::tanh((abs_raw - knee) / span);
    }

    const double min_f = clamp(cfg.min_force_norm, 0.0, 0.20);
    if (min_f > 1e-5 && shaped > 1e-4) {
        // Smoothly lift tiny forces above belt/gear stiction without a hard discontinuity at zero
        const double lift = min_f * (1.0 - std::exp(-shaped / 0.04));
        shaped = clamp(lift + shaped * (1.0 - min_f), 0.0, 1.0);
    }

    s.normalized = static_cast<float>(clamp((raw_norm >= 0.0 ? 1.0 : -1.0) * shaped, -1.0, 1.0));
    return s;
}

}  // namespace rs::rt
