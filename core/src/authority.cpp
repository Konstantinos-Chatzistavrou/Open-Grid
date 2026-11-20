#include "rs/authority.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <utility>

namespace rs {

namespace {

constexpr std::uint64_t kFnv1aOffsetBasis = 14695981039346656037ULL;
constexpr std::uint64_t kFnv1aPrime = 1099511628211ULL;

inline std::uint64_t fnv1a_mix_i64(std::uint64_t h, std::int64_t val) {
    std::uint64_t u = static_cast<std::uint64_t>(val);
    for (int i = 0; i < 8; ++i) {
        h ^= (u & 0xFFULL);
        h *= kFnv1aPrime;
        u >>= 8;
    }
    return h;
}

inline std::int64_t quantize_1e3(double v) {
    if (!std::isfinite(v)) return 0;
    return static_cast<std::int64_t>(std::llround(v * 1000.0));
}

inline std::int64_t quantize_1e6(double v) {
    if (!std::isfinite(v)) return 0;
    return static_cast<std::int64_t>(std::llround(v * 1000000.0));
}

}  // namespace

std::uint64_t hash_car_config(const CarConfig& cfg) {
    std::uint64_t h = kFnv1aOffsetBasis;

    // Core mass & geometry
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.mass));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.wheelbase));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.cg_height));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.weight_front));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.brake_torque_total));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.brake_bias_front));

    // Engine & torque curve
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.engine.idle_rpm));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.engine.redline_rpm));
    h = fnv1a_mix_i64(h, static_cast<std::int64_t>(cfg.engine.torque_curve.size()));
    for (const auto& pt : cfg.engine.torque_curve) {
        h = fnv1a_mix_i64(h, quantize_1e6(pt[0]));
        h = fnv1a_mix_i64(h, quantize_1e6(pt[1]));
    }

    // Drivetrain
    h = fnv1a_mix_i64(h, static_cast<std::int64_t>(cfg.drivetrain.gear_ratios.size()));
    for (double ratio : cfg.drivetrain.gear_ratios) {
        h = fnv1a_mix_i64(h, quantize_1e6(ratio));
    }
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.drivetrain.final_drive));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.drivetrain.efficiency));

    // Tires (front & rear grip and rolling radius)
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.tire_front.mu_x));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.tire_front.mu_y));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.tire_front.radius));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.tire_rear.mu_x));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.tire_rear.mu_y));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.tire_rear.radius));

    // Aero
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.aero.drag_area));
    h = fnv1a_mix_i64(h, quantize_1e6(cfg.aero.lift_area));

    return h;
}

std::uint64_t hash_chassis_state(const ChassisState& s, double engine_rpm, int gear) {
    std::uint64_t h = kFnv1aOffsetBasis;

    h = fnv1a_mix_i64(h, quantize_1e3(s.position.x));
    h = fnv1a_mix_i64(h, quantize_1e3(s.position.y));
    h = fnv1a_mix_i64(h, quantize_1e3(s.position.z));

    h = fnv1a_mix_i64(h, quantize_1e3(s.velocity.x));
    h = fnv1a_mix_i64(h, quantize_1e3(s.velocity.y));
    h = fnv1a_mix_i64(h, quantize_1e3(s.velocity.z));

    h = fnv1a_mix_i64(h, quantize_1e3(s.orientation.w));
    h = fnv1a_mix_i64(h, quantize_1e3(s.orientation.x));
    h = fnv1a_mix_i64(h, quantize_1e3(s.orientation.y));
    h = fnv1a_mix_i64(h, quantize_1e3(s.orientation.z));

    h = fnv1a_mix_i64(h, quantize_1e3(s.angular_velocity.x));
    h = fnv1a_mix_i64(h, quantize_1e3(s.angular_velocity.y));
    h = fnv1a_mix_i64(h, quantize_1e3(s.angular_velocity.z));

    h = fnv1a_mix_i64(h, quantize_1e3(engine_rpm));
    h = fnv1a_mix_i64(h, static_cast<std::int64_t>(gear));

    return h;
}

AuthorityServerSim::AuthorityServerSim(const CarConfig& cfg, std::shared_ptr<const Ground> ground)
    : sim_(cfg, std::move(ground)), config_hash_(hash_car_config(cfg)) {}

void AuthorityServerSim::reset(const Vec3& pos_xy, double yaw, double forward_speed, int gear) {
    sim_.reset(pos_xy, yaw, forward_speed, gear);
}

VerificationResult AuthorityServerSim::verify_config_hash(std::uint64_t client_config_hash) const {
    VerificationResult res;
    res.authoritative_state = sim_.body.state;
    res.authoritative_hash = hash_chassis_state(sim_.body.state, sim_.vehicle.engine_rpm(), sim_.last.gear);
    if (client_config_hash != config_hash_) {
        res.valid = false;
        res.violation = CheatViolation::SpecConfigMismatch;
    }
    return res;
}

bool AuthorityServerSim::validate_input_ranges(const DriverInput& in) {
    if (!std::isfinite(in.steer) || !std::isfinite(in.throttle) || !std::isfinite(in.brake) ||
        !std::isfinite(in.clutch) || !std::isfinite(in.handbrake)) {
        return false;
    }
    if (std::fabs(in.steer) > 1.001) return false;
    if (in.throttle < -0.001 || in.throttle > 1.001) return false;
    if (in.brake < -0.001 || in.brake > 1.001) return false;
    if (in.clutch < -0.001 || in.clutch > 1.001) return false;
    if (in.handbrake < -0.001 || in.handbrake > 1.001) return false;
    if (in.gear < 0 || in.gear > 16) return false;
    return true;
}

VerificationResult AuthorityServerSim::verify_ticks(const std::vector<TickInputFrame>& inputs,
                                                    const ClientStateClaim& claim,
                                                    double pos_tolerance_m,
                                                    double speed_tolerance_ms) {
    VerificationResult res;

    for (const auto& frame : inputs) {
        if (!validate_input_ranges(frame.input)) {
            res.valid = false;
            res.violation = CheatViolation::InvalidInputRange;
            res.failed_tick = frame.tick;
            res.authoritative_state = sim_.body.state;
            res.authoritative_hash =
                hash_chassis_state(sim_.body.state, sim_.vehicle.engine_rpm(), sim_.last.gear);
            return res;
        }
        sim_.step(frame.input);
    }

    const ChassisState& auth_state = sim_.body.state;
    const double auth_rpm = sim_.vehicle.engine_rpm();
    const int auth_gear = sim_.last.gear;

    res.authoritative_state = auth_state;
    res.authoritative_hash = hash_chassis_state(auth_state, auth_rpm, auth_gear);

    const double pos_error = rs::length(claim.chassis.position - auth_state.position);
    const double auth_speed = rs::length(auth_state.velocity);
    const double client_speed = rs::length(claim.chassis.velocity);
    const double speed_excess = client_speed - auth_speed;

    res.position_error_m = pos_error;
    res.speed_error_ms = std::fabs(speed_excess);

    if (!std::isfinite(client_speed) || speed_excess > speed_tolerance_ms) {
        res.valid = false;
        res.violation = CheatViolation::SpeedOrPowerTamper;
        res.failed_tick = claim.tick;
        return res;
    }

    if (!std::isfinite(pos_error) || pos_error > pos_tolerance_m) {
        res.valid = false;
        res.violation = CheatViolation::TeleportOrPositionDesync;
        res.failed_tick = claim.tick;
        return res;
    }

    if (claim.state_hash != 0 && pos_error < 1e-3 && claim.state_hash != res.authoritative_hash) {
        res.valid = false;
        res.violation = CheatViolation::StateHashMismatch;
        res.failed_tick = claim.tick;
        return res;
    }

    res.valid = true;
    res.violation = CheatViolation::None;
    return res;
}

Ue5ReconciliationDelta AuthorityServerSim::compute_ue5_reconciliation(const ChassisState& client_state,
                                                                      const ChassisState& auth_state,
                                                                      double snap_threshold_m) {
    Ue5ReconciliationDelta delta;

    const rs::ue5::UeVec3 client_pos_ue = rs::ue5::pos_to_ue(client_state.position);
    const rs::ue5::UeVec3 auth_pos_ue = rs::ue5::pos_to_ue(auth_state.position);
    delta.pos_correction_cm = {
        auth_pos_ue.x - client_pos_ue.x,
        auth_pos_ue.y - client_pos_ue.y,
        auth_pos_ue.z - client_pos_ue.z
    };

    const rs::ue5::UeVec3 client_vel_ue = rs::ue5::vel_to_ue(client_state.velocity);
    const rs::ue5::UeVec3 auth_vel_ue = rs::ue5::vel_to_ue(auth_state.velocity);
    delta.vel_correction_cms = {
        auth_vel_ue.x - client_vel_ue.x,
        auth_vel_ue.y - client_vel_ue.y,
        auth_vel_ue.z - client_vel_ue.z
    };

    delta.authoritative_rot_ue = rs::ue5::quat_to_ue(auth_state.orientation);

    const double err_m = rs::length(auth_state.position - client_state.position);
    delta.needs_snap = (err_m > snap_threshold_m);

    if (delta.needs_snap) {
        delta.blend_alpha = 1.0;
    } else if (err_m <= 1e-4) {
        delta.blend_alpha = 0.0;
    } else {
        const double denom = std::max(snap_threshold_m, 1e-6);
        delta.blend_alpha = rs::clamp(err_m / denom, 0.0, 1.0);
    }

    return delta;
}

}  // namespace rs
