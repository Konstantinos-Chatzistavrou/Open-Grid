// Apache-2.0 — Open Grid Neural Driver: deterministic, zero-allocation C++20 MLP policy
// (14 -> 48 -> 32 -> 3) trained directly inside rs_core physics via Behavior Cloning +
// multi-threaded Antithetic Evolution Strategies. Runs identically in native C++, WebAssembly,
// and Unreal Engine 5.8 with zero Python/PyTorch runtime dependencies.
#pragma once
#include <array>
#include <string>
#include <vector>
#include "rs/ai.hpp"
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/racing_line.hpp"
#include "rs/route.hpp"
#include "rs/vehicle.hpp"

namespace rs {

inline constexpr int kNeuralObsDim = 14;
inline constexpr int kNeuralHidden1 = 48;
inline constexpr int kNeuralHidden2 = 32;
inline constexpr int kNeuralActDim = 3;

inline constexpr int kNeuralW1Size = kNeuralHidden1 * kNeuralObsDim;     // 672
inline constexpr int kNeuralB1Size = kNeuralHidden1;                     // 48
inline constexpr int kNeuralW2Size = kNeuralHidden2 * kNeuralHidden1;    // 1536
inline constexpr int kNeuralB2Size = kNeuralHidden2;                     // 32
inline constexpr int kNeuralW3Size = kNeuralActDim * kNeuralHidden2;     // 96
inline constexpr int kNeuralB3Size = kNeuralActDim;                      // 3
inline constexpr int kNeuralParamCount =
    kNeuralW1Size + kNeuralB1Size + kNeuralW2Size + kNeuralB2Size + kNeuralW3Size + kNeuralB3Size;  // 2387

using NeuralObs = std::array<double, kNeuralObsDim>;

struct NeuralAction {
    double steer = 0.0;     // [-1, 1] (+ = left, - = right)
    double throttle = 0.0;  // [0, 1]
    double brake = 0.0;     // [0, 1]
};

struct NeuralTrainingMeta {
    int bc_epochs = 0;
    int bc_samples = 0;
    double bc_mse = 0.0;
    int rl_generations = 0;
    int rl_pop_size = 0;
    double baseline_fitness = 0.0;
    double bc_fitness = 0.0;
    double rl_fitness = 0.0;
};

struct NeuralWeights {
    std::array<double, kNeuralW1Size> w1{};
    std::array<double, kNeuralB1Size> b1{};
    std::array<double, kNeuralW2Size> w2{};
    std::array<double, kNeuralB2Size> b2{};
    std::array<double, kNeuralW3Size> w3{};
    std::array<double, kNeuralB3Size> b3{};
    NeuralTrainingMeta meta{};

    std::array<double, kNeuralParamCount> to_flat() const noexcept;
    void from_flat(const std::array<double, kNeuralParamCount>& flat) noexcept;
};

// Pure deterministic MLP policy: 14 -> 48 (tanh) -> 32 (tanh) -> 3 (tanh, 0.5+0.5*tanh, 0.5+0.5*tanh).
// Zero heap allocations during infer().
class NeuralPolicy {
public:
    NeuralPolicy() = default;
    explicit NeuralPolicy(const NeuralWeights& weights) noexcept : weights_(weights), loaded_(true) {}

    bool load_file(const std::string& path);
    bool parse_json(const std::string& json_text);
    bool save_file(const std::string& path) const;
    std::string to_json() const;

    bool is_loaded() const noexcept { return loaded_; }
    const NeuralWeights& weights() const noexcept { return weights_; }
    NeuralWeights& mutable_weights() noexcept {
        loaded_ = true;
        return weights_;
    }
    void set_weights(const NeuralWeights& weights) noexcept {
        weights_ = weights;
        loaded_ = true;
    }

    // Zero-allocation deterministic forward pass.
    void infer(const NeuralObs& obs, NeuralAction& out) const noexcept;
    NeuralAction infer(const NeuralObs& obs) const noexcept;

    // Exact left-right mirror symmetry helpers (for training augmentation & verification).
    static NeuralObs mirror_obs(const NeuralObs& obs) noexcept;
    static NeuralAction mirror_action(const NeuralAction& act) noexcept;

private:
    NeuralWeights weights_{};
    bool loaded_ = false;
};

// Complete Open Grid Neural Driver wired to rs::Route, rs::RacingLine, and rs::CarConfig.
// Builds the 14-dimensional normalized observation vector and emits RawInput (Wheel device)
// directly from the trained NeuralPolicy.
class NeuralDriver {
public:
    NeuralDriver(const CarConfig& cfg, const Route& route, const NeuralPolicy& policy, double skill = 0.96);

    // Precompute the friction-ellipse speed profile for a route & racing line (matches AIDriver).
    static std::vector<double> build_speed_profile(const CarConfig& cfg, const Route& route,
                                                   const RacingLine& line, double skill);

    // Sample a precomputed speed profile at arc-length s (m).
    static double sample_speed_profile(const Route& route, const std::vector<double>& vprof, double s);

    // Build the exact 14-feature normalized observation vector used by both training and runtime inference.
    static NeuralObs extract_observation(const Route& route, const RacingLine& line,
                                         const std::vector<double>& vprof,
                                         const ChassisState& chassis, const VehicleOutput& last,
                                         const std::vector<OtherCar>& others,
                                         int& hint_io, Route::Projection* out_proj = nullptr,
                                         double* out_v_ref = nullptr);

    AIOutput update(const ChassisState& chassis, const VehicleOutput& last,
                    const std::vector<OtherCar>& others, double dt);

    void set_policy(const NeuralPolicy& policy) noexcept { policy_ = policy; }
    const NeuralPolicy& policy() const noexcept { return policy_; }
    const RacingLine& racing_line() const noexcept { return line_; }
    double speed_profile(double s) const;

    // Live telemetry
    double route_s = 0.0;
    double target_speed = 0.0;
    double last_lateral = 0.0;
    NeuralObs last_obs{};
    NeuralAction last_action{};

private:
    const CarConfig& cfg_;
    const Route& route_;
    NeuralPolicy policy_;
    RacingLine line_;
    std::vector<double> vprof_;
    int hint_ = -1;
};

}  // namespace rs
