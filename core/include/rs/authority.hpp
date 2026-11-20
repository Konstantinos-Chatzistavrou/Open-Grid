// Server-Authoritative Physics Verifier, Anti-Cheat Tamper Detector, and
// Unreal Engine 5 Client-Prediction Reconciliation for rs_core (OpenGrid).
//
// Designed for competitive multiplayer & Spec Class racing:
//   1. Deterministic 64-bit FNV-1a CarConfig & quantized ChassisState hashing.
//   2. Server-side input range validation (blocks NaN/Inf and out-of-range throttle/brake/steer packets).
//   3. Server-side replay verification of tick input frames against client state claims
//      (detects 5,000 hp power/grip tamper, speed hacks, teleportation, and state hash tampering).
//   4. UE5 client-prediction reconciliation (centimeter delta, snap threshold, and smooth blend factor).
#pragma once
#include <cstdint>
#include <memory>
#include <vector>
#include "rs/config.hpp"
#include "rs/math.hpp"
#include "rs/sim.hpp"
#include "rs/ue5_bridge.hpp"
#include "rs/vehicle.hpp"

namespace rs {

enum class CheatViolation : int {
    None = 0,
    InvalidInputRange = 1,
    SpeedOrPowerTamper = 2,
    TeleportOrPositionDesync = 3,
    StateHashMismatch = 4,
    SpecConfigMismatch = 5
};

struct TickInputFrame {
    std::uint32_t tick = 0;
    DriverInput input{};
};

struct ClientStateClaim {
    std::uint32_t tick = 0;
    ChassisState chassis{};
    double engine_rpm = 0.0;
    int gear = 1;
    std::uint64_t state_hash = 0;
};

struct VerificationResult {
    bool valid = true;
    CheatViolation violation = CheatViolation::None;
    std::uint32_t failed_tick = 0;
    double position_error_m = 0.0;
    double speed_error_ms = 0.0;
    ChassisState authoritative_state{};
    std::uint64_t authoritative_hash = 0;
};

struct Ue5ReconciliationDelta {
    bool needs_snap = false;               // true if error > snap_threshold_m (default 250.0 cm)
    rs::ue5::UeVec3 pos_correction_cm{};   // authoritative_ue_pos - client_ue_pos
    rs::ue5::UeVec3 vel_correction_cms{};  // authoritative_ue_vel - client_ue_vel
    rs::ue5::UeQuat authoritative_rot_ue{};
    double blend_alpha = 0.0;              // 0..1 smooth visual interpolation factor for UE5 network prediction
};

// Deterministic 64-bit FNV-1a hash of physics-critical CarConfig parameters
// (mass, wheelbase, cg_height, engine redline & torque curve, gear ratios, final drive, tire mu_x/mu_y).
std::uint64_t hash_car_config(const CarConfig& cfg);

// Deterministic 64-bit FNV-1a hash of a quantized ChassisState (1e-3 millimeter / mm/s integer buckets).
std::uint64_t hash_chassis_state(const ChassisState& s, double engine_rpm, int gear);

class AuthorityServerSim {
public:
    explicit AuthorityServerSim(const CarConfig& cfg,
                                std::shared_ptr<const Ground> ground = std::make_shared<PlaneGround>());

    void reset(const Vec3& pos_xy = {}, double yaw = 0.0, double forward_speed = 0.0, int gear = -1);

    const Simulation& sim() const { return sim_; }
    Simulation& sim() { return sim_; }
    std::uint64_t config_hash() const { return config_hash_; }

    // Verifies that a client's CarConfig hash matches the server's authoritative Spec Class CarConfig.
    VerificationResult verify_config_hash(std::uint64_t client_config_hash) const;

    // Rejects NaN/Inf or out-of-range driver controls (|steer| > 1.001, throttle/brake/clutch/handbrake outside
    // [-0.001, 1.001], or invalid gear index).
    static bool validate_input_ranges(const DriverInput& in);

    // Replays `inputs` on the authoritative server simulation and verifies the client's claimed end state.
    VerificationResult verify_ticks(const std::vector<TickInputFrame>& inputs,
                                    const ClientStateClaim& claim,
                                    double pos_tolerance_m = 0.35,
                                    double speed_tolerance_ms = 1.2);

    // Computes UE5 (cm, LH +Y right) reconciliation deltas between a client's predicted state and the server's
    // authoritative state.
    static Ue5ReconciliationDelta compute_ue5_reconciliation(const ChassisState& client_state,
                                                             const ChassisState& auth_state,
                                                             double snap_threshold_m = 2.5);

private:
    Simulation sim_;
    std::uint64_t config_hash_ = 0;
};

}  // namespace rs
