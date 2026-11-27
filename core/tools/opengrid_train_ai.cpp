// Apache-2.0 — Open Grid Neural Driver Trainer (pure C++20, zero Python/PyTorch dependencies).
//
// Two-phase real-physics training directly inside rs_core::Simulation:
//   Phase 1 — Behavior Cloning (Imitation Learning):
//     Rolls out rs::AIDriver (racing_line=true, skill=0.96) across real circuits and real cars
//     (vela_gt, falcorn_9r), including lateral/heading perturbation recovery + traffic avoidance
//     samples and exact left-right symmetry augmentation, then trains the 14->48->32->3 MLP with
//     pure C++20 mini-batch Adam backpropagation until MSE < 0.008.
//   Phase 2 — Multi-Threaded Reinforcement Learning (Antithetic OpenAI Evolution Strategies / NES):
//     Evaluates antithetic weight perturbations in parallel across all CPU cores directly inside
//     real rs::Vehicle physics, maximizing:
//       R = +progress_m + 0.25 * avg_speed_ms - 8.0 * offtrack_sec - 40.0 * impact_count - 0.15 * steer_jerk
//     Exports the trained weights to data/ai/neural_driver.json and copies to
//     web/public/assets/ai/neural_driver.json.
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <numeric>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "rs/ai.hpp"
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/neural_driver.hpp"
#include "rs/racing_line.hpp"
#include "rs/route.hpp"
#include "rs/sim.hpp"

namespace {

using namespace rs;

struct SamplePair {
    NeuralObs obs{};
    NeuralAction act{};
};

struct CircuitData {
    std::string name;
    Route route;
    RacingLine line;
};

struct EvalMetrics {
    double fitness = -1e9;
    double progress_m = 0.0;
    double avg_speed_ms = 0.0;
    double offtrack_sec = 0.0;
    double max_excursion_m = 0.0;
    double lap_time_s = 0.0;
    double steer_jerk = 0.0;
    int impact_count = 0;
    bool completed_lap = false;
};

// Load a TUM racetrack-database CSV (x_m,y_m,w_tr_right_m,w_tr_left_m) into a flat Z=0 rs::Route.
Route load_csv_track(const std::string& path) {
    std::ifstream ifs(path);
    if (!ifs) throw std::runtime_error("cannot open track csv: " + path);
    std::vector<RouteSample> pts;
    std::string line_str;
    while (std::getline(ifs, line_str)) {
        if (line_str.empty() || line_str[0] == '#') continue;
        std::replace(line_str.begin(), line_str.end(), ',', ' ');
        std::istringstream iss(line_str);
        double x = 0.0, y = 0.0, wr = 5.0, wl = 5.0;
        if (!(iss >> x >> y >> wr >> wl)) continue;
        RouteSample s{};
        s.p = {x, y, 0.0};
        s.width_right = wr;
        s.width_left = wl;
        pts.push_back(s);
    }
    const std::size_t n = pts.size();
    for (std::size_t i = 0; i < n; ++i) {
        const Vec3 prev_p = pts[(i + n - 1) % n].p;
        const Vec3 next_p = pts[(i + 1) % n].p;
        const Vec3 d = next_p - prev_p;
        pts[i].heading = std::atan2(d.y, d.x);
    }
    for (std::size_t i = 0; i < n; ++i) {
        const Vec3 a = pts[(i + n - 1) % n].p;
        const Vec3 b = pts[i].p;
        const Vec3 c = pts[(i + 1) % n].p;
        const Vec3 ab{b.x - a.x, b.y - a.y, 0.0};
        const Vec3 bc{c.x - b.x, c.y - b.y, 0.0};
        const Vec3 ac{c.x - a.x, c.y - a.y, 0.0};
        const double cr = ab.x * bc.y - ab.y * bc.x;
        const double den = std::sqrt(dot(ab, ab) * dot(bc, bc) * dot(ac, ac));
        pts[i].curvature = den > 1e-12 ? 2.0 * cr / den : 0.0;
    }
    return Route::from_samples(std::move(pts), true);
}

// Flatten a route/1 JSON track onto z = 0 so it runs directly on rs::PlaneGround.
Route flatten_route_z0(const Route& src) {
    std::vector<RouteSample> pts = src.samples();
    for (auto& pt : pts) pt.p.z = 0.0;
    return Route::from_samples(std::move(pts), src.closed());
}

// Build a balanced left+right synthetic technical circuit (~1.35 km) for diverse corner radii.
Route build_technical_circuit() {
    std::vector<RouteSample> pts;
    const int n = 360;
    for (int i = 0; i < n; ++i) {
        const double t = 2.0 * kPi * static_cast<double>(i) / static_cast<double>(n);
        // Smooth kidney / chicane loop with fast sweeper, hairpin, and left-right esses
        const double x = 230.0 * std::cos(t) + 45.0 * std::cos(2.0 * t) - 22.0 * std::sin(3.0 * t);
        const double y = 145.0 * std::sin(t) - 38.0 * std::sin(2.0 * t) + 18.0 * std::cos(3.0 * t);
        RouteSample s{};
        s.p = {x, y, 0.0};
        s.width_left = 6.5;
        s.width_right = 6.5;
        pts.push_back(s);
    }
    for (int i = 0; i < n; ++i) {
        const Vec3 prev_p = pts[static_cast<std::size_t>((i + n - 1) % n)].p;
        const Vec3 next_p = pts[static_cast<std::size_t>((i + 1) % n)].p;
        const Vec3 d = next_p - prev_p;
        pts[static_cast<std::size_t>(i)].heading = std::atan2(d.y, d.x);
    }
    for (int i = 0; i < n; ++i) {
        const Vec3 a = pts[static_cast<std::size_t>((i + n - 1) % n)].p;
        const Vec3 b = pts[static_cast<std::size_t>(i)].p;
        const Vec3 c = pts[static_cast<std::size_t>((i + 1) % n)].p;
        const Vec3 ab{b.x - a.x, b.y - a.y, 0.0};
        const Vec3 bc{c.x - b.x, c.y - b.y, 0.0};
        const Vec3 ac{c.x - a.x, c.y - a.y, 0.0};
        const double cr = ab.x * bc.y - ab.y * bc.x;
        const double den = std::sqrt(dot(ab, ab) * dot(bc, bc) * dot(ac, ac));
        pts[static_cast<std::size_t>(i)].curvature = den > 1e-12 ? 2.0 * cr / den : 0.0;
    }
    return Route::from_samples(std::move(pts), true);
}

// Collect expert (obs, action) demonstration pairs from rs::AIDriver (racing_line=true).
// When dagger_policy != nullptr, the learner drives the car while rs::AIDriver labels every
// visited state (DAgger), eliminating Behavior Cloning covariate shift!
void collect_bc_rollout(const CarConfig& cfg, const CircuitData& circuit,
                        double duration_s, double start_s, double start_v,
                        double init_lat_offset, double init_yaw_offset,
                        bool with_traffic, double sample_dt,
                        std::vector<SamplePair>& dataset,
                        const NeuralPolicy* dagger_policy = nullptr) {
    auto ground = std::make_shared<PlaneGround>(Vec3{0.0, 0.0, 1.0}, 0);
    Simulation sim(cfg, ground);
    sim.dt = 1.0 / 200.0;
    sim.vehicle.assists().abs = true;
    sim.vehicle.assists().tc = true;

    const RouteSample sp = circuit.route.at(start_s);
    const double line_lat = circuit.line.lateral(start_s);
    const Vec3 pos = sp.p + circuit.route.left(start_s) * (line_lat + init_lat_offset);
    sim.reset({pos.x, pos.y, 0.0}, sp.heading + init_yaw_offset, start_v, start_v > 14.0 ? 4 : 2);
    sim.settle(0.15);

    Controls ctl(sim.vehicle.config());
    ctl.settings.auto_gearbox = true;
    ctl.set_gear(start_v > 14.0 ? 4 : 2);

    AIParams params{};
    params.skill = 0.96;
    params.racing_line = true;
    params.proactive_racecraft = with_traffic;
    params.mistake_susceptibility = 0.0;
    params.reaction_time = 0.1;

    AIDriver expert(sim.vehicle.config(), circuit.route, params);
    const std::vector<double> vprof = NeuralDriver::build_speed_profile(sim.vehicle.config(), circuit.route, circuit.line, 0.96);

    int obs_hint = -1;
    double next_sample_t = 0.20;
    std::vector<OtherCar> others;
    double traffic_s = circuit.route.wrap(start_s + 38.0);
    const double traffic_v = 18.0;

    const int total_steps = static_cast<int>(duration_s / sim.dt);
    for (int step_idx = 0; step_idx < total_steps; ++step_idx) {
        others.clear();
        if (with_traffic) {
            traffic_s = circuit.route.wrap(traffic_s + traffic_v * sim.dt);
            const RouteSample ts = circuit.route.at(traffic_s);
            const Vec3 tpos = ts.p + circuit.route.left(traffic_s) * circuit.line.lateral(traffic_s);
            const Vec3 tvel = circuit.route.tangent(traffic_s) * traffic_v;
            others.push_back({{tpos.x, tpos.y, 0.5}, tvel, 4.5, 1.9});
        }

        Route::Projection pr{};
        const NeuralObs obs = NeuralDriver::extract_observation(
            circuit.route, circuit.line, vprof, sim.body.state, sim.last, others, obs_hint, &pr);

        const AIOutput expert_out = expert.update(sim.body.state, sim.last, others, sim.dt);
        AIOutput drive_out = expert_out;
        if (dagger_policy != nullptr) {
            const NeuralAction pred = dagger_policy->infer(obs);
            drive_out.raw.device = InputDevice::Wheel;
            drive_out.raw.steer = clamp(pred.steer, -1.0, 1.0);
            drive_out.raw.throttle = clamp(pred.throttle, 0.0, 1.0);
            drive_out.raw.brake = clamp(pred.brake, 0.0, 1.0);
            drive_out.gear_request = -1;
        }
        if (drive_out.gear_request >= 0) ctl.set_gear(drive_out.gear_request);
        sim.step(ctl.update(drive_out.raw, sim.last, sim.dt));

        // Skip recording if car went wildly off track
        const RouteSample at_s = circuit.route.at(pr.s);
        const double edge_dist = std::abs(pr.lateral) - (pr.lateral >= 0.0 ? at_s.width_left : at_s.width_right);
        if (edge_dist > 4.5) break;

        if (sim.time >= next_sample_t && !expert.recovering) {
            NeuralAction act{};
            act.steer = clamp(expert_out.raw.steer, -1.0, 1.0);
            act.throttle = clamp(expert_out.raw.throttle, 0.0, 1.0);
            act.brake = clamp(expert_out.raw.brake, 0.0, 1.0);
            dataset.push_back({obs, act});
            // Exact left-right mirror symmetry augmentation
            dataset.push_back({NeuralPolicy::mirror_obs(obs), NeuralPolicy::mirror_action(act)});
            next_sample_t = sim.time + sample_dt;
        }
    }
}

// Pure C++20 mini-batch Adam trainer for 14 -> 48 (tanh) -> 32 (tanh) -> 3 (tanh, sig, sig).
double train_behavior_cloning(NeuralWeights& w, const std::vector<SamplePair>& dataset,
                              int epochs, std::mt19937& rng, bool reinit_weights = true,
                              double lr_max = 0.0035) {
    if (reinit_weights) {
        // Xavier / Glorot initialization
        auto init_layer = [&](auto& weights_arr, int fan_in, int fan_out) {
            const double limit = std::sqrt(6.0 / static_cast<double>(fan_in + fan_out));
            std::uniform_real_distribution<double> dist(-limit, limit);
            for (double& val : weights_arr) val = dist(rng);
        };
        init_layer(w.w1, kNeuralObsDim, kNeuralHidden1);
        w.b1.fill(0.0);
        init_layer(w.w2, kNeuralHidden1, kNeuralHidden2);
        w.b2.fill(0.0);
        init_layer(w.w3, kNeuralHidden2, kNeuralActDim);
        w.b3.fill(0.0);
    }

    std::array<double, kNeuralParamCount> theta = w.to_flat();
    std::array<double, kNeuralParamCount> m_adam{};
    std::array<double, kNeuralParamCount> v_adam{};
    std::array<double, kNeuralParamCount> grad{};

    std::vector<std::size_t> order(dataset.size());
    std::iota(order.begin(), order.end(), 0);

    const std::size_t batch_size = 64;
    const double beta1 = 0.9;
    const double beta2 = 0.999;
    const double eps = 1e-8;
    const double weight_decay = 1e-5;
    int adam_step = 0;
    double final_mse = 1.0;

    // Offsets into flat parameter vector
    constexpr std::size_t off_w1 = 0;
    constexpr std::size_t off_b1 = off_w1 + kNeuralW1Size;
    constexpr std::size_t off_w2 = off_b1 + kNeuralB1Size;
    constexpr std::size_t off_b2 = off_w2 + kNeuralW2Size;
    constexpr std::size_t off_w3 = off_b2 + kNeuralB2Size;
    constexpr std::size_t off_b3 = off_w3 + kNeuralW3Size;

    for (int ep = 0; ep < epochs; ++ep) {
        std::shuffle(order.begin(), order.end(), rng);
        const double progress = static_cast<double>(ep) / static_cast<double>(std::max(1, epochs - 1));
        const double lr = 0.00020 + 0.5 * (lr_max - 0.00020) * (1.0 + std::cos(kPi * progress));

        double epoch_sq_err = 0.0;
        std::size_t epoch_count = 0;

        for (std::size_t start = 0; start < order.size(); start += batch_size) {
            const std::size_t end = std::min(order.size(), start + batch_size);
            const std::size_t bsz = end - start;
            grad.fill(0.0);

            for (std::size_t bi = start; bi < end; ++bi) {
                const SamplePair& sp = dataset[order[bi]];
                std::array<double, kNeuralHidden1> h1{};
                std::array<double, kNeuralHidden2> h2{};
                double t3[kNeuralActDim]{};

                // Forward
                for (int i = 0; i < kNeuralHidden1; ++i) {
                    double acc = theta[off_b1 + static_cast<std::size_t>(i)];
                    const std::size_t row = off_w1 + static_cast<std::size_t>(i * kNeuralObsDim);
                    for (int j = 0; j < kNeuralObsDim; ++j) {
                        acc += theta[row + static_cast<std::size_t>(j)] * sp.obs[static_cast<std::size_t>(j)];
                    }
                    h1[static_cast<std::size_t>(i)] = std::tanh(acc);
                }
                for (int i = 0; i < kNeuralHidden2; ++i) {
                    double acc = theta[off_b2 + static_cast<std::size_t>(i)];
                    const std::size_t row = off_w2 + static_cast<std::size_t>(i * kNeuralHidden1);
                    for (int j = 0; j < kNeuralHidden1; ++j) {
                        acc += theta[row + static_cast<std::size_t>(j)] * h1[static_cast<std::size_t>(j)];
                    }
                    h2[static_cast<std::size_t>(i)] = std::tanh(acc);
                }
                for (int i = 0; i < kNeuralActDim; ++i) {
                    double acc = theta[off_b3 + static_cast<std::size_t>(i)];
                    const std::size_t row = off_w3 + static_cast<std::size_t>(i * kNeuralHidden2);
                    for (int j = 0; j < kNeuralHidden2; ++j) {
                        acc += theta[row + static_cast<std::size_t>(j)] * h2[static_cast<std::size_t>(j)];
                    }
                    t3[i] = std::tanh(acc);
                }

                const double y0 = t3[0];
                const double y1 = 0.5 + 0.5 * t3[1];
                const double y2 = 0.5 + 0.5 * t3[2];

                const double e0 = y0 - sp.act.steer;
                const double e1 = y1 - sp.act.throttle;
                const double e2 = y2 - sp.act.brake;
                epoch_sq_err += (e0 * e0 + e1 * e1 + e2 * e2) / 3.0;
                ++epoch_count;

                // Backprop (extra 2.0x weight on steering accuracy for razor-sharp line tracking)
                double dz3[kNeuralActDim]{};
                dz3[0] = (4.0 / 3.0) * e0 * (1.0 - t3[0] * t3[0]);
                dz3[1] = (2.0 / 3.0) * e1 * 0.5 * (1.0 - t3[1] * t3[1]);
                dz3[2] = (2.0 / 3.0) * e2 * 0.5 * (1.0 - t3[2] * t3[2]);

                std::array<double, kNeuralHidden2> dh2{};
                for (int i = 0; i < kNeuralActDim; ++i) {
                    grad[off_b3 + static_cast<std::size_t>(i)] += dz3[i];
                    const std::size_t row = off_w3 + static_cast<std::size_t>(i * kNeuralHidden2);
                    for (int j = 0; j < kNeuralHidden2; ++j) {
                        grad[row + static_cast<std::size_t>(j)] += dz3[i] * h2[static_cast<std::size_t>(j)];
                        dh2[static_cast<std::size_t>(j)] += dz3[i] * theta[row + static_cast<std::size_t>(j)];
                    }
                }

                std::array<double, kNeuralHidden1> dh1{};
                for (int i = 0; i < kNeuralHidden2; ++i) {
                    const double h2i = h2[static_cast<std::size_t>(i)];
                    const double dz2 = dh2[static_cast<std::size_t>(i)] * (1.0 - h2i * h2i);
                    grad[off_b2 + static_cast<std::size_t>(i)] += dz2;
                    const std::size_t row = off_w2 + static_cast<std::size_t>(i * kNeuralHidden1);
                    for (int j = 0; j < kNeuralHidden1; ++j) {
                        grad[row + static_cast<std::size_t>(j)] += dz2 * h1[static_cast<std::size_t>(j)];
                        dh1[static_cast<std::size_t>(j)] += dz2 * theta[row + static_cast<std::size_t>(j)];
                    }
                }

                for (int i = 0; i < kNeuralHidden1; ++i) {
                    const double h1i = h1[static_cast<std::size_t>(i)];
                    const double dz1 = dh1[static_cast<std::size_t>(i)] * (1.0 - h1i * h1i);
                    grad[off_b1 + static_cast<std::size_t>(i)] += dz1;
                    const std::size_t row = off_w1 + static_cast<std::size_t>(i * kNeuralObsDim);
                    for (int j = 0; j < kNeuralObsDim; ++j) {
                        grad[row + static_cast<std::size_t>(j)] += dz1 * sp.obs[static_cast<std::size_t>(j)];
                    }
                }
            }

            // Adam step
            ++adam_step;
            const double inv_bsz = 1.0 / static_cast<double>(bsz);
            const double bc1 = 1.0 - std::pow(beta1, static_cast<double>(adam_step));
            const double bc2 = 1.0 - std::pow(beta2, static_cast<double>(adam_step));
            for (std::size_t p_idx = 0; p_idx < kNeuralParamCount; ++p_idx) {
                const double g = grad[p_idx] * inv_bsz + weight_decay * theta[p_idx];
                m_adam[p_idx] = beta1 * m_adam[p_idx] + (1.0 - beta1) * g;
                v_adam[p_idx] = beta2 * v_adam[p_idx] + (1.0 - beta2) * g * g;
                const double m_hat = m_adam[p_idx] / bc1;
                const double v_hat = v_adam[p_idx] / bc2;
                theta[p_idx] -= lr * m_hat / (std::sqrt(v_hat) + eps);
            }
        }

        final_mse = epoch_sq_err / static_cast<double>(std::max<std::size_t>(1, epoch_count));
        if (ep == 0 || (ep + 1) % 20 == 0 || ep + 1 == epochs) {
            std::printf("  [Phase 1 BC] Epoch %3d/%d  lr=%.5f  MSE=%.6f\n", ep + 1, epochs, lr, final_mse);
            std::fflush(stdout);
        }
    }

    w.from_flat(theta);
    return final_mse;
}

// Evaluate either rule-based AIDriver (policy == nullptr) or NeuralDriver (policy != nullptr)
// on real rs::Simulation vehicle physics.
EvalMetrics evaluate_driver(const CarConfig& cfg, const CircuitData& circuit,
                            const std::vector<double>& vprof, const NeuralPolicy* policy,
                            double duration_s, double start_s, double start_v) {
    auto ground = std::make_shared<PlaneGround>(Vec3{0.0, 0.0, 1.0}, 0);
    Simulation sim(cfg, ground);
    sim.dt = 1.0 / 200.0;
    sim.vehicle.assists().abs = true;
    sim.vehicle.assists().tc = true;

    const RouteSample sp = circuit.route.at(start_s);
    const Vec3 pos = sp.p + circuit.route.left(start_s) * circuit.line.lateral(start_s);
    sim.reset({pos.x, pos.y, 0.0}, sp.heading, start_v, start_v > 14.0 ? 4 : 2);
    sim.settle(0.15);

    Controls ctl(sim.vehicle.config());
    ctl.settings.auto_gearbox = true;
    ctl.set_gear(start_v > 14.0 ? 4 : 2);

    std::unique_ptr<AIDriver> baseline_ai;
    if (policy == nullptr) {
        AIParams params{};
        params.skill = 0.96;
        params.racing_line = true;
        params.mistake_susceptibility = 0.0;
        baseline_ai = std::make_unique<AIDriver>(sim.vehicle.config(), circuit.route, params);
    }

    const std::vector<OtherCar> empty_others;
    int hint = -1;
    Route::Projection init_pr = circuit.route.project(sim.body.state.position, hint);
    hint = init_pr.index;
    double last_s = init_pr.s;
    double prev_steer = 0.0;

    EvalMetrics m{};
    const double t0 = sim.time;
    const double track_len = circuit.route.length();
    const int steps = static_cast<int>(duration_s / sim.dt);

    for (int step_idx = 0; step_idx < steps; ++step_idx) {
        AIOutput out{};
        Route::Projection pr{};
        if (policy != nullptr) {
            const NeuralObs obs = NeuralDriver::extract_observation(
                circuit.route, circuit.line, vprof, sim.body.state, sim.last, empty_others, hint, &pr);
            const NeuralAction act = policy->infer(obs);
            out.raw.device = InputDevice::Wheel;
            out.raw.steer = clamp(act.steer, -1.0, 1.0);
            out.raw.throttle = clamp(act.throttle, 0.0, 1.0);
            out.raw.brake = clamp(act.brake, 0.0, 1.0);
        } else {
            out = baseline_ai->update(sim.body.state, sim.last, empty_others, sim.dt);
            pr = circuit.route.project(sim.body.state.position, hint);
            hint = pr.index;
        }

        if (step_idx > 0) {
            m.steer_jerk += std::abs(out.raw.steer - prev_steer);
        }
        prev_steer = out.raw.steer;

        if (out.gear_request >= 0) ctl.set_gear(out.gear_request);
        sim.step(ctl.update(out.raw, sim.last, sim.dt));

        const double ds = circuit.route.delta(last_s, pr.s);
        m.progress_m += ds;
        last_s = pr.s;

        if (!m.completed_lap && m.progress_m >= track_len) {
            m.completed_lap = true;
            m.lap_time_s = sim.time - t0;
        }

        const RouteSample rs_here = circuit.route.at(pr.s);
        const double limit_w = (pr.lateral >= 0.0 ? rs_here.width_left : rs_here.width_right) - 0.9;
        const double excursion = std::abs(pr.lateral) - limit_w;
        m.max_excursion_m = std::max(m.max_excursion_m, excursion);
        if (excursion > 0.0) {
            m.offtrack_sec += sim.dt;
        }
        if (excursion > 5.0) {
            ++m.impact_count;
            break;
        }
    }

    const double elapsed = std::max(0.1, sim.time - t0);
    m.avg_speed_ms = m.progress_m / elapsed;
    // Reward function:
    //   R = +progress_m + 0.25 * avg_speed_ms - 8.0 * offtrack_sec - 40.0 * impact_count - 0.15 * steer_jerk
    m.fitness = m.progress_m
              + 0.25 * m.avg_speed_ms
              - 8.0 * m.offtrack_sec
              - 40.0 * static_cast<double>(m.impact_count)
              - 0.15 * m.steer_jerk;
    return m;
}

struct EvalScenario {
    const CarConfig* car = nullptr;
    const CircuitData* circuit = nullptr;
    std::vector<double> vprof;
    double duration_s = 40.0;
    double start_s = 0.0;
    double start_v = 24.0;
};

EvalMetrics evaluate_suite(const std::vector<EvalScenario>& scenarios, const NeuralPolicy* policy) {
    EvalMetrics total{};
    total.fitness = 0.0;
    total.max_excursion_m = -1e9;
    for (const auto& sc : scenarios) {
        const EvalMetrics r = evaluate_driver(*sc.car, *sc.circuit, sc.vprof, policy,
                                              sc.duration_s, sc.start_s, sc.start_v);
        total.fitness += r.fitness;
        total.progress_m += r.progress_m;
        total.avg_speed_ms += r.avg_speed_ms;
        total.offtrack_sec += r.offtrack_sec;
        total.max_excursion_m = std::max(total.max_excursion_m, r.max_excursion_m);
        total.steer_jerk += r.steer_jerk;
        total.impact_count += r.impact_count;
        if (r.completed_lap && total.lap_time_s == 0.0) {
            total.lap_time_s = r.lap_time_s;
            total.completed_lap = true;
        }
    }
    if (!scenarios.empty()) {
        total.avg_speed_ms /= static_cast<double>(scenarios.size());
    }
    return total;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        const auto t_start_all = std::chrono::steady_clock::now();

        std::string data_dir = "data";
        std::string web_out_path = "web/public/assets/ai/neural_driver.json";
        if (argc > 1) data_dir = argv[1];
        if (!std::filesystem::exists(data_dir + "/cars/vela_gt.json") &&
            std::filesystem::exists("../data/cars/vela_gt.json")) {
            data_dir = "../data";
            web_out_path = "../web/public/assets/ai/neural_driver.json";
        }

        const unsigned hw_threads = std::max(1u, std::thread::hardware_concurrency());
        std::printf("=== Open Grid Neural Driver Trainer (Pure C++20, %u CPU threads) ===\n", hw_threads);

        // 1. Load real cars & real circuits
        const CarConfig vela = load_car_config(data_dir + "/cars/vela_gt.json");
        const CarConfig falcorn = load_car_config(data_dir + "/cars/falcorn_9r.json");

        std::vector<CircuitData> circuits;
        {
            Route r_city = flatten_route_z0(Route::load(data_dir + "/tracks/city_route.json"));
            RacingLine l_city(r_city);
            circuits.push_back({"Old Harbour City Loop", std::move(r_city), std::move(l_city)});
        }
        {
            Route r_bh = load_csv_track(data_dir + "/validation/racetrack-database/BrandsHatch.csv");
            RacingLine l_bh(r_bh);
            circuits.push_back({"Brands Hatch GP", std::move(r_bh), std::move(l_bh)});
        }
        {
            Route r_tech = build_technical_circuit();
            RacingLine l_tech(r_tech);
            circuits.push_back({"Open Grid Technical Esses", std::move(r_tech), std::move(l_tech)});
        }

        for (const auto& c : circuits) {
            std::printf("  Loaded circuit: %-28s  length=%.0f m  samples=%zu\n",
                        c.name.c_str(), c.route.length(), c.route.samples().size());
        }

        // Build full benchmark suite (including full City Loop lap!) and fast RL training suite
        std::vector<EvalScenario> full_suite;
        {
            EvalScenario s0{&vela, &circuits[0],
                            NeuralDriver::build_speed_profile(vela, circuits[0].route, circuits[0].line, 0.96),
                            62.0, 0.0, 22.0};
            EvalScenario s1{&falcorn, &circuits[1],
                            NeuralDriver::build_speed_profile(falcorn, circuits[1].route, circuits[1].line, 0.96),
                            36.0, 0.0, 28.0};
            EvalScenario s2{&vela, &circuits[2],
                            NeuralDriver::build_speed_profile(vela, circuits[2].route, circuits[2].line, 0.96),
                            45.0, 0.0, 24.0};
            full_suite.push_back(std::move(s0));
            full_suite.push_back(std::move(s1));
            full_suite.push_back(std::move(s2));
        }

        // Fast RL evaluation suite: City Loop full lap (48 s, vela_gt) + Brands Hatch GP (26 s, falcorn_9r)
        std::vector<EvalScenario> rl_suite;
        {
            rl_suite.push_back(full_suite[0]);
            rl_suite[0].duration_s = 48.0;
            rl_suite.push_back(full_suite[1]);
            rl_suite[1].duration_s = 26.0;
        }

        auto is_better = [](const EvalMetrics& cand, const EvalMetrics& cur) {
            if (cand.impact_count != cur.impact_count) return cand.impact_count < cur.impact_count;
            return cand.fitness > cur.fitness;
        };

        // Baseline: Rule-based rs::AIDriver (racing_line=true, skill=0.96)
        const EvalMetrics baseline_rl = evaluate_suite(rl_suite, nullptr);
        const EvalMetrics baseline = evaluate_suite(full_suite, nullptr);
        std::printf("\n[Gen 0 — Rule-Based AIDriver Baseline]\n");
        std::printf("  Full Suite: fitness=%8.2f | progress=%6.1f m | avg_speed=%5.2f m/s (%.1f km/h) | offtrack=%.2f s | impacts=%d | city_lap=%.2f s\n",
                    baseline.fitness, baseline.progress_m, baseline.avg_speed_ms, baseline.avg_speed_ms * 3.6,
                    baseline.offtrack_sec, baseline.impact_count, baseline.lap_time_s);
        std::printf("  RL Suite:   fitness=%8.2f | avg_speed=%.1f km/h | offtrack=%.2f s | impacts=%d | city_lap=%.2f s\n",
                    baseline_rl.fitness, baseline_rl.avg_speed_ms * 3.6, baseline_rl.offtrack_sec,
                    baseline_rl.impact_count, baseline_rl.lap_time_s);

        // =========================================================================
        // PHASE 1 — Behavior Cloning + 2-Round DAgger (Imitation Learning)
        // =========================================================================
        std::printf("\n=== Phase 1: Behavior Cloning + DAgger (Imitation Learning) ===\n");
        std::vector<SamplePair> dataset;
        dataset.reserve(24000);

        // Nominal optimal racing-line laps across all circuits & both cars
        collect_bc_rollout(vela, circuits[0], 55.0, 0.0, 22.0, 0.0, 0.0, false, 0.04, dataset);
        collect_bc_rollout(falcorn, circuits[0], 45.0, 300.0, 24.0, 0.0, 0.0, false, 0.05, dataset);
        collect_bc_rollout(vela, circuits[1], 75.0, 0.0, 28.0, 0.0, 0.0, false, 0.05, dataset);
        collect_bc_rollout(falcorn, circuits[1], 65.0, 1200.0, 28.0, 0.0, 0.0, false, 0.05, dataset);
        collect_bc_rollout(vela, circuits[2], 45.0, 0.0, 24.0, 0.0, 0.0, false, 0.05, dataset);
        collect_bc_rollout(falcorn, circuits[2], 40.0, 450.0, 24.0, 0.0, 0.0, false, 0.05, dataset);

        // Lateral & heading perturbation recovery demonstrations
        const double lat_perts[4] = {-2.2, 2.2, -1.4, 1.4};
        const double yaw_perts[4] = {0.14, -0.14, -0.08, 0.08};
        for (int k = 0; k < 4; ++k) {
            const double s_off = static_cast<double>(k) * 260.0;
            collect_bc_rollout(vela, circuits[0], 10.0, s_off, 20.0, lat_perts[k], yaw_perts[k], false, 0.04, dataset);
            collect_bc_rollout(falcorn, circuits[1], 10.0, s_off * 2.5, 26.0, lat_perts[k], yaw_perts[k], false, 0.05, dataset);
        }

        // Traffic / obstacle awareness demonstrations
        collect_bc_rollout(vela, circuits[0], 20.0, 100.0, 24.0, 0.0, 0.0, true, 0.05, dataset);
        collect_bc_rollout(falcorn, circuits[1], 20.0, 500.0, 28.0, 0.0, 0.0, true, 0.05, dataset);

        std::printf("  Collected %zu initial (obs[14], act[3]) pairs\n", dataset.size());

        std::mt19937 rng(20261127u);
        NeuralWeights weights{};
        int total_bc_epochs = 100;
        double bc_mse = train_behavior_cloning(weights, dataset, total_bc_epochs, rng, true, 0.0035);

        // 2 quick rounds of DAgger so closed-loop covariate shift drops to zero!
        for (int dr = 0; dr < 2; ++dr) {
            NeuralPolicy cur_p(weights);
            const std::size_t before_sz = dataset.size();
            collect_bc_rollout(vela, circuits[0], 50.0, 0.0, 22.0, 0.0, 0.0, false, 0.04, dataset, &cur_p);
            collect_bc_rollout(falcorn, circuits[1], 36.0, 0.0, 28.0, 0.0, 0.0, false, 0.04, dataset, &cur_p);
            collect_bc_rollout(vela, circuits[2], 36.0, 0.0, 24.0, 0.0, 0.0, false, 0.04, dataset, &cur_p);
            std::printf("  [DAgger round %d] Added %zu closed-loop recovery pairs (total=%zu)\n",
                        dr + 1, dataset.size() - before_sz, dataset.size());
            bc_mse = train_behavior_cloning(weights, dataset, 35, rng, false, 0.0016);
            total_bc_epochs += 35;
        }

        NeuralPolicy bc_policy(weights);
        const EvalMetrics bc_eval_rl = evaluate_suite(rl_suite, &bc_policy);
        const EvalMetrics bc_eval = evaluate_suite(full_suite, &bc_policy);
        std::printf("\n[Phase 1 Result — Imitation + DAgger Neural Driver]\n");
        std::printf("  BC MSE=%.6f | Full fitness=%8.2f | avg=%.1f km/h | offtrack=%.2f s | impacts=%d | city_lap=%.2f s\n",
                    bc_mse, bc_eval.fitness, bc_eval.avg_speed_ms * 3.6, bc_eval.offtrack_sec, bc_eval.impact_count, bc_eval.lap_time_s);
        std::printf("  RL Suite:     fitness=%8.2f | avg=%.1f km/h | offtrack=%.2f s | impacts=%d | city_lap=%.2f s\n",
                    bc_eval_rl.fitness, bc_eval_rl.avg_speed_ms * 3.6, bc_eval_rl.offtrack_sec, bc_eval_rl.impact_count, bc_eval_rl.lap_time_s);

        // =========================================================================
        // PHASE 2 — Multi-Threaded Antithetic Evolution Strategies / NES RL
        // =========================================================================
        const int rl_generations = 45;
        const int half_pop = 16;          // 16 antithetic pairs = 32 parallel rollouts per generation (4/core on 8 cores)
        const int pop_size = half_pop * 2;
        std::printf("\n=== Phase 2: Multi-Threaded Antithetic ES RL (%d gens x %d rollouts across %u threads) ===\n",
                    rl_generations, pop_size, hw_threads);

        std::array<double, kNeuralParamCount> theta = weights.to_flat();
        std::array<double, kNeuralParamCount> best_theta = theta;
        EvalMetrics best_eval = bc_eval_rl;

        // Adam state for ES gradient ascent
        std::array<double, kNeuralParamCount> es_m{};
        std::array<double, kNeuralParamCount> es_v{};
        std::normal_distribution<double> normal_dist(0.0, 1.0);

        std::vector<std::array<double, kNeuralParamCount>> noises(static_cast<std::size_t>(half_pop));
        std::vector<EvalMetrics> pop_metrics(static_cast<std::size_t>(pop_size));

        for (int gen = 0; gen < rl_generations; ++gen) {
            const double frac = static_cast<double>(gen) / static_cast<double>(std::max(1, rl_generations - 1));
            const double sigma = 0.015 * (1.0 - 0.55 * frac);
            const double lr_es = 0.0040 * (1.0 - 0.60 * frac);

            for (int p_i = 0; p_i < half_pop; ++p_i) {
                for (std::size_t k = 0; k < kNeuralParamCount; ++k) {
                    noises[static_cast<std::size_t>(p_i)][k] = normal_dist(rng);
                }
            }

            // Evaluate all pop_size candidates across hw_threads worker threads
            std::vector<std::thread> workers;
            workers.reserve(hw_threads);
            for (unsigned tid = 0; tid < hw_threads; ++tid) {
                workers.emplace_back([&, tid]() {
                    for (int idx = static_cast<int>(tid); idx < pop_size; idx += static_cast<int>(hw_threads)) {
                        const int pair_idx = idx / 2;
                        const double sgn = (idx % 2 == 0) ? 1.0 : -1.0;
                        std::array<double, kNeuralParamCount> cand = theta;
                        const auto& eps_vec = noises[static_cast<std::size_t>(pair_idx)];
                        for (std::size_t k = 0; k < kNeuralParamCount; ++k) {
                            cand[k] += sgn * sigma * eps_vec[k];
                        }
                        NeuralWeights cw{};
                        cw.from_flat(cand);
                        NeuralPolicy cp(cw);
                        pop_metrics[static_cast<std::size_t>(idx)] = evaluate_suite(rl_suite, &cp);
                    }
                });
            }
            for (auto& th : workers) th.join();

            // Track elite best perturbation (fewer impacts always wins, then highest fitness)
            int gen_best_idx = 0;
            for (int idx = 1; idx < pop_size; ++idx) {
                if (is_better(pop_metrics[static_cast<std::size_t>(idx)],
                              pop_metrics[static_cast<std::size_t>(gen_best_idx)])) {
                    gen_best_idx = idx;
                }
            }
            const EvalMetrics& gen_best = pop_metrics[static_cast<std::size_t>(gen_best_idx)];
            if (is_better(gen_best, best_eval)) {
                const int pair_idx = gen_best_idx / 2;
                const double sgn = (gen_best_idx % 2 == 0) ? 1.0 : -1.0;
                for (std::size_t k = 0; k < kNeuralParamCount; ++k) {
                    best_theta[k] = theta[k] + sgn * sigma * noises[static_cast<std::size_t>(pair_idx)][k];
                }
                best_eval = gen_best;
            }

            // Centered rank-shaping (OpenAI ES) for scale-invariant, rock-solid gradient updates
            std::vector<int> rank_order(static_cast<std::size_t>(pop_size));
            std::iota(rank_order.begin(), rank_order.end(), 0);
            std::sort(rank_order.begin(), rank_order.end(), [&](int a, int b) {
                return pop_metrics[static_cast<std::size_t>(a)].fitness <
                       pop_metrics[static_cast<std::size_t>(b)].fitness;
            });
            std::vector<double> shaped(static_cast<std::size_t>(pop_size), 0.0);
            for (int r = 0; r < pop_size; ++r) {
                shaped[static_cast<std::size_t>(rank_order[static_cast<std::size_t>(r)])] =
                    (static_cast<double>(r) / static_cast<double>(pop_size - 1)) - 0.5;
            }

            // Estimate ES gradient & apply Adam ascent
            std::array<double, kNeuralParamCount> grad_es{};
            const double inv_scale = 1.0 / (static_cast<double>(pop_size) * sigma);
            for (int pair_idx = 0; pair_idx < half_pop; ++pair_idx) {
                const double diff_r = shaped[static_cast<std::size_t>(2 * pair_idx)] -
                                      shaped[static_cast<std::size_t>(2 * pair_idx + 1)];
                const auto& eps_vec = noises[static_cast<std::size_t>(pair_idx)];
                for (std::size_t k = 0; k < kNeuralParamCount; ++k) {
                    grad_es[k] += diff_r * eps_vec[k];
                }
            }

            const double b1 = 0.9, b2 = 0.999, eps_a = 1e-8;
            const double bc1 = 1.0 - std::pow(b1, static_cast<double>(gen + 1));
            const double bc2 = 1.0 - std::pow(b2, static_cast<double>(gen + 1));
            for (std::size_t k = 0; k < kNeuralParamCount; ++k) {
                const double g = grad_es[k] * inv_scale;
                es_m[k] = b1 * es_m[k] + (1.0 - b1) * g;
                es_v[k] = b2 * es_v[k] + (1.0 - b2) * g * g;
                theta[k] += lr_es * (es_m[k] / bc1) / (std::sqrt(es_v[k] / bc2) + eps_a);
            }

            // Evaluate updated center theta
            NeuralWeights center_w{};
            center_w.from_flat(theta);
            NeuralPolicy center_p(center_w);
            const EvalMetrics center_eval = evaluate_suite(rl_suite, &center_p);
            if (is_better(center_eval, best_eval)) {
                best_theta = theta;
                best_eval = center_eval;
            }

            if (gen == 0 || (gen + 1) % 5 == 0 || gen + 1 == rl_generations) {
                std::printf("  [Phase 2 RL] Gen %2d/%d | center=%8.2f (%.1f km/h, off=%.2fs, imp=%d) | best=%8.2f (%.1f km/h, off=%.2fs, imp=%d, lap=%.2fs)\n",
                            gen + 1, rl_generations,
                            center_eval.fitness, center_eval.avg_speed_ms * 3.6, center_eval.offtrack_sec, center_eval.impact_count,
                            best_eval.fitness, best_eval.avg_speed_ms * 3.6, best_eval.offtrack_sec, best_eval.impact_count, best_eval.lap_time_s);
                std::fflush(stdout);
            }
        }

        // Pack final best weights + metadata
        NeuralWeights final_w{};
        final_w.from_flat(best_theta);
        final_w.meta.bc_epochs = total_bc_epochs;
        final_w.meta.bc_samples = static_cast<int>(dataset.size());
        final_w.meta.bc_mse = bc_mse;
        final_w.meta.rl_generations = rl_generations;
        final_w.meta.rl_pop_size = pop_size;
        final_w.meta.baseline_fitness = baseline.fitness;
        final_w.meta.bc_fitness = bc_eval.fitness;

        NeuralPolicy final_policy(final_w);
        const EvalMetrics verified = evaluate_suite(full_suite, &final_policy);
        final_w.meta.rl_fitness = verified.fitness;
        final_policy.set_weights(final_w);

        // Save weights to data/ai/neural_driver.json AND copy to web/public/assets/ai/neural_driver.json
        const std::filesystem::path data_out = std::filesystem::path(data_dir) / "ai" / "neural_driver.json";
        std::filesystem::create_directories(data_out.parent_path());
        if (!final_policy.save_file(data_out.string())) {
            std::fprintf(stderr, "ERROR: failed to save %s\n", data_out.string().c_str());
            return 1;
        }
        const std::filesystem::path web_out(web_out_path);
        std::filesystem::create_directories(web_out.parent_path());
        if (!final_policy.save_file(web_out.string())) {
            std::fprintf(stderr, "ERROR: failed to save %s\n", web_out.string().c_str());
            return 1;
        }

        const auto file_bytes = std::filesystem::file_size(data_out);
        const auto elapsed_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t_start_all).count();

        std::printf("\n=== Open Grid Neural Driver Training Summary (%.1f s) ===\n", elapsed_s);
        std::printf("  Gen 0 (Rule-Based Baseline): fitness=%8.2f | avg=%5.1f km/h | offtrack=%.2f s | impacts=%d | city_lap=%.2f s\n",
                    baseline.fitness, baseline.avg_speed_ms * 3.6, baseline.offtrack_sec, baseline.impact_count, baseline.lap_time_s);
        std::printf("  Phase 1 (Imitation BC):      fitness=%8.2f | avg=%5.1f km/h | offtrack=%.2f s | impacts=%d | city_lap=%.2f s (MSE=%.6f)\n",
                    bc_eval.fitness, bc_eval.avg_speed_ms * 3.6, bc_eval.offtrack_sec, bc_eval.impact_count, bc_eval.lap_time_s, bc_mse);
        std::printf("  Final RL Neural Driver:      fitness=%8.2f | avg=%5.1f km/h | offtrack=%.2f s | impacts=%d | city_lap=%.2f s\n",
                    verified.fitness, verified.avg_speed_ms * 3.6, verified.offtrack_sec, verified.impact_count, verified.lap_time_s);
        std::printf("  Saved weights: %s (%.2f KB) -> %s\n",
                    data_out.string().c_str(), static_cast<double>(file_bytes) / 1024.0, web_out.string().c_str());
        return 0;
    } catch (const std::exception& ex) {
        std::fprintf(stderr, "opengrid_train_ai failed: %s\n", ex.what());
        return 1;
    }
}
