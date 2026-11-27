// Apache-2.0 — Open Grid Neural Driver implementation (pure C++20, zero runtime allocations in infer).
#include "rs/neural_driver.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
#include "nlohmann/json.hpp"

namespace rs {
namespace detail_neural {

inline double round5(double x) noexcept {
    if (!std::isfinite(x)) return 0.0;
    return std::round(x * 100000.0) / 100000.0;
}

template <std::size_t N>
bool read_array_exact(const nlohmann::json& j, const char* key, std::array<double, N>& dst) {
    if (!j.contains(key) || !j[key].is_array()) return false;
    const auto& arr = j[key];
    if (arr.size() != N) return false;
    for (std::size_t idx = 0; idx < N; ++idx) {
        if (!arr[idx].is_number()) return false;
        const double val = arr[idx].get<double>();
        if (!std::isfinite(val)) return false;
        dst[idx] = val;
    }
    return true;
}

template <std::size_t N>
void write_array_compact(std::ostringstream& oss, const char* key, const std::array<double, N>& src, bool trailing_comma) {
    oss << '"' << key << "\":[";
    for (std::size_t idx = 0; idx < N; ++idx) {
        if (idx > 0) oss << ',';
        const double v = round5(src[idx]);
        if (v == 0.0) {
            oss << '0';
        } else {
            oss << v;
        }
    }
    oss << (trailing_comma ? "]," : "]");
}

}  // namespace detail_neural

std::array<double, kNeuralParamCount> NeuralWeights::to_flat() const noexcept {
    std::array<double, kNeuralParamCount> flat{};
    std::size_t off = 0;
    std::copy(w1.begin(), w1.end(), flat.begin() + static_cast<std::ptrdiff_t>(off)); off += w1.size();
    std::copy(b1.begin(), b1.end(), flat.begin() + static_cast<std::ptrdiff_t>(off)); off += b1.size();
    std::copy(w2.begin(), w2.end(), flat.begin() + static_cast<std::ptrdiff_t>(off)); off += w2.size();
    std::copy(b2.begin(), b2.end(), flat.begin() + static_cast<std::ptrdiff_t>(off)); off += b2.size();
    std::copy(w3.begin(), w3.end(), flat.begin() + static_cast<std::ptrdiff_t>(off)); off += w3.size();
    std::copy(b3.begin(), b3.end(), flat.begin() + static_cast<std::ptrdiff_t>(off));
    return flat;
}

void NeuralWeights::from_flat(const std::array<double, kNeuralParamCount>& flat) noexcept {
    std::size_t off = 0;
    std::copy_n(flat.begin() + static_cast<std::ptrdiff_t>(off), w1.size(), w1.begin()); off += w1.size();
    std::copy_n(flat.begin() + static_cast<std::ptrdiff_t>(off), b1.size(), b1.begin()); off += b1.size();
    std::copy_n(flat.begin() + static_cast<std::ptrdiff_t>(off), w2.size(), w2.begin()); off += w2.size();
    std::copy_n(flat.begin() + static_cast<std::ptrdiff_t>(off), b2.size(), b2.begin()); off += b2.size();
    std::copy_n(flat.begin() + static_cast<std::ptrdiff_t>(off), w3.size(), w3.begin()); off += w3.size();
    std::copy_n(flat.begin() + static_cast<std::ptrdiff_t>(off), b3.size(), b3.begin());
}

bool NeuralPolicy::load_file(const std::string& path) {
    std::ifstream ifs(path);
    if (!ifs) return false;
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return parse_json(oss.str());
}

bool NeuralPolicy::parse_json(const std::string& json_text) {
    try {
        const nlohmann::json j = nlohmann::json::parse(json_text);
        if (!j.is_object()) return false;
        if (j.contains("arch") && j["arch"].is_array() && j["arch"].size() == 4) {
            if (j["arch"][0].get<int>() != kNeuralObsDim ||
                j["arch"][1].get<int>() != kNeuralHidden1 ||
                j["arch"][2].get<int>() != kNeuralHidden2 ||
                j["arch"][3].get<int>() != kNeuralActDim) {
                return false;
            }
        }
        NeuralWeights parsed{};
        if (!detail_neural::read_array_exact(j, "w1", parsed.w1)) return false;
        if (!detail_neural::read_array_exact(j, "b1", parsed.b1)) return false;
        if (!detail_neural::read_array_exact(j, "w2", parsed.w2)) return false;
        if (!detail_neural::read_array_exact(j, "b2", parsed.b2)) return false;
        if (!detail_neural::read_array_exact(j, "w3", parsed.w3)) return false;
        if (!detail_neural::read_array_exact(j, "b3", parsed.b3)) return false;
        if (j.contains("training") && j["training"].is_object()) {
            const auto& tr = j["training"];
            parsed.meta.bc_epochs = tr.value("bc_epochs", 0);
            parsed.meta.bc_samples = tr.value("bc_samples", 0);
            parsed.meta.bc_mse = tr.value("bc_mse", 0.0);
            parsed.meta.rl_generations = tr.value("rl_generations", 0);
            parsed.meta.rl_pop_size = tr.value("rl_pop_size", 0);
            parsed.meta.baseline_fitness = tr.value("baseline_fitness", 0.0);
            parsed.meta.bc_fitness = tr.value("bc_fitness", 0.0);
            parsed.meta.rl_fitness = tr.value("rl_fitness", 0.0);
        }
        weights_ = parsed;
        loaded_ = true;
        return true;
    } catch (...) {
        return false;
    }
}

std::string NeuralPolicy::to_json() const {
    std::ostringstream oss;
    oss << std::setprecision(6);
    oss << '{';
    oss << "\"schema\":\"open-grid-neural-driver/1\",";
    oss << "\"name\":\"Open Grid Neural Driver\",";
    oss << "\"license\":\"Apache-2.0\",";
    oss << "\"arch\":[" << kNeuralObsDim << ',' << kNeuralHidden1 << ',' << kNeuralHidden2 << ',' << kNeuralActDim << "],";
    oss << "\"activations\":[\"tanh\",\"tanh\",\"tanh_sig_sig\"],";
    oss << "\"training\":{"
        << "\"bc_epochs\":" << weights_.meta.bc_epochs << ','
        << "\"bc_samples\":" << weights_.meta.bc_samples << ','
        << "\"bc_mse\":" << detail_neural::round5(weights_.meta.bc_mse) << ','
        << "\"rl_generations\":" << weights_.meta.rl_generations << ','
        << "\"rl_pop_size\":" << weights_.meta.rl_pop_size << ','
        << "\"baseline_fitness\":" << detail_neural::round5(weights_.meta.baseline_fitness) << ','
        << "\"bc_fitness\":" << detail_neural::round5(weights_.meta.bc_fitness) << ','
        << "\"rl_fitness\":" << detail_neural::round5(weights_.meta.rl_fitness)
        << "},";
    detail_neural::write_array_compact(oss, "w1", weights_.w1, true);
    detail_neural::write_array_compact(oss, "b1", weights_.b1, true);
    detail_neural::write_array_compact(oss, "w2", weights_.w2, true);
    detail_neural::write_array_compact(oss, "b2", weights_.b2, true);
    detail_neural::write_array_compact(oss, "w3", weights_.w3, true);
    detail_neural::write_array_compact(oss, "b3", weights_.b3, false);
    oss << "}\n";
    return oss.str();
}

bool NeuralPolicy::save_file(const std::string& path) const {
    std::ofstream ofs(path);
    if (!ofs) return false;
    ofs << to_json();
    return ofs.good();
}

void NeuralPolicy::infer(const NeuralObs& obs, NeuralAction& out) const noexcept {
    std::array<double, kNeuralHidden1> h1{};
    std::array<double, kNeuralHidden2> h2{};

    for (int i = 0; i < kNeuralHidden1; ++i) {
        double acc = weights_.b1[static_cast<std::size_t>(i)];
        const std::size_t row = static_cast<std::size_t>(i * kNeuralObsDim);
        for (int j = 0; j < kNeuralObsDim; ++j) {
            acc += weights_.w1[row + static_cast<std::size_t>(j)] * obs[static_cast<std::size_t>(j)];
        }
        h1[static_cast<std::size_t>(i)] = std::tanh(acc);
    }

    for (int i = 0; i < kNeuralHidden2; ++i) {
        double acc = weights_.b2[static_cast<std::size_t>(i)];
        const std::size_t row = static_cast<std::size_t>(i * kNeuralHidden1);
        for (int j = 0; j < kNeuralHidden1; ++j) {
            acc += weights_.w2[row + static_cast<std::size_t>(j)] * h1[static_cast<std::size_t>(j)];
        }
        h2[static_cast<std::size_t>(i)] = std::tanh(acc);
    }

    double z3[kNeuralActDim]{};
    for (int i = 0; i < kNeuralActDim; ++i) {
        double acc = weights_.b3[static_cast<std::size_t>(i)];
        const std::size_t row = static_cast<std::size_t>(i * kNeuralHidden2);
        for (int j = 0; j < kNeuralHidden2; ++j) {
            acc += weights_.w3[row + static_cast<std::size_t>(j)] * h2[static_cast<std::size_t>(j)];
        }
        z3[i] = acc;
    }

    out.steer = std::tanh(z3[0]);
    out.throttle = 0.5 + 0.5 * std::tanh(z3[1]);
    out.brake = 0.5 + 0.5 * std::tanh(z3[2]);
}

NeuralAction NeuralPolicy::infer(const NeuralObs& obs) const noexcept {
    NeuralAction act{};
    infer(obs, act);
    return act;
}

NeuralObs NeuralPolicy::mirror_obs(const NeuralObs& obs) noexcept {
    NeuralObs m = obs;
    m[1] = -obs[1];   // lat_err_norm
    m[2] = -obs[2];   // heading_err
    m[3] = -obs[3];   // yaw_rate_norm
    m[4] = -obs[4];   // slip_angle_norm
    m[5] = -obs[5];   // curv_15m
    m[6] = -obs[6];   // curv_35m
    m[7] = -obs[7];   // curv_65m
    m[8] = -obs[8];   // curv_110m
    m[9] = obs[10];   // room_left <-> room_right
    m[10] = obs[9];
    m[13] = -obs[13]; // obs_lat_norm
    return m;
}

NeuralAction NeuralPolicy::mirror_action(const NeuralAction& act) noexcept {
    return {-act.steer, act.throttle, act.brake};
}

std::vector<double> NeuralDriver::build_speed_profile(const CarConfig& cfg, const Route& route,
                                                      const RacingLine& line, double skill) {
    double p_max = 0.0;
    for (const auto& pt : cfg.engine.torque_curve) {
        p_max = std::max(p_max, pt[1] * pt[0] * 2.0 * kPi / 60.0);
    }
    p_max *= cfg.drivetrain.efficiency;
    const double mu = std::min(cfg.tire_front.mu_y, cfg.tire_rear.mu_y);
    const double a_lat = skill * 0.82 * mu * kGravity;
    const double a_brake = skill * 0.85 * cfg.tire_front.mu_x * kGravity;
    const auto& samples = route.samples();
    const int n = static_cast<int>(samples.size());
    std::vector<double> vprof(static_cast<std::size_t>(n), 0.0);

    for (int i = 0; i < n; ++i) {
        const double width_factor = clamp((samples[static_cast<std::size_t>(i)].width_left +
                                           samples[static_cast<std::size_t>(i)].width_right - 2.0) / 6.0, 0.7, 1.0);
        const double curv = !line.empty() ? line.curvature(samples[static_cast<std::size_t>(i)].s)
                                          : samples[static_cast<std::size_t>(i)].curvature;
        vprof[static_cast<std::size_t>(i)] =
            std::min(75.0, std::sqrt(a_lat * width_factor / std::max(std::abs(curv), 1e-4)));
    }

    auto ellipse = [&](int idx, double vel) {
        const double curv = !line.empty() ? line.curvature(samples[static_cast<std::size_t>(idx)].s)
                                          : samples[static_cast<std::size_t>(idx)].curvature;
        const double used = std::min(1.0, vel * vel * std::abs(curv) / std::max(a_lat, 1e-3));
        return std::sqrt(std::max(0.0, 1.0 - used * used));
    };

    for (int pass = 0; pass < 2; ++pass) {
        for (int k = n - 1; k >= 0; --k) {
            const int j = (k + 1) % n;
            if (!route.closed() && j == 0) continue;
            const double ds = (j == 0 ? route.length() : samples[static_cast<std::size_t>(j)].s) -
                              samples[static_cast<std::size_t>(k)].s;
            const double vj = vprof[static_cast<std::size_t>(j)];
            vprof[static_cast<std::size_t>(k)] =
                std::min(vprof[static_cast<std::size_t>(k)],
                         std::sqrt(vj * vj + 2.0 * a_brake * ellipse(j, vj) * std::max(ds, 0.0)));
        }
        for (int k = 0; k < n; ++k) {
            const int prev = (k - 1 + n) % n;
            if (!route.closed() && k == 0) continue;
            const double ds = (k == 0 ? route.length() : samples[static_cast<std::size_t>(k)].s) -
                              samples[static_cast<std::size_t>(prev)].s;
            const double vi = vprof[static_cast<std::size_t>(prev)];
            const double accel = std::min(0.8 * kGravity, p_max / (cfg.mass * std::max(vi, 5.0))) * ellipse(prev, vi);
            vprof[static_cast<std::size_t>(k)] =
                std::min(vprof[static_cast<std::size_t>(k)],
                         std::sqrt(vi * vi + 2.0 * accel * std::max(ds, 0.0)));
        }
    }
    return vprof;
}

double NeuralDriver::sample_speed_profile(const Route& route, const std::vector<double>& vprof, double s) {
    const auto& samples = route.samples();
    if (samples.empty() || vprof.empty()) return 0.0;
    int lo = 0;
    int hi = static_cast<int>(samples.size()) - 1;
    const double wrapped = route.wrap(s);
    while (hi - lo > 1) {
        const int mid = (lo + hi) / 2;
        if (samples[static_cast<std::size_t>(mid)].s <= wrapped) lo = mid;
        else hi = mid;
    }
    return vprof[static_cast<std::size_t>(lo)];
}

NeuralObs NeuralDriver::extract_observation(const Route& route, const RacingLine& line,
                                            const std::vector<double>& vprof,
                                            const ChassisState& chassis, const VehicleOutput& last,
                                            const std::vector<OtherCar>& others,
                                            int& hint_io, Route::Projection* out_proj,
                                            double* out_v_ref) {
    NeuralObs obs{};
    const Vec3 fwd = chassis.orientation.rotate({1.0, 0.0, 0.0});
    const double v = dot(chassis.velocity, fwd);
    const Route::Projection pr = route.project(chassis.position, hint_io);
    hint_io = pr.index;
    if (out_proj != nullptr) *out_proj = pr;

    const RouteSample here = route.at(pr.s);
    const double opt_lat = !line.empty() ? line.lateral(pr.s) : 0.0;

    // Heading error relative to the optimal racing line tangent at pr.s
    auto line_pt = [&](double sq) {
        const double l_lat = !line.empty() ? line.lateral(sq) : 0.0;
        return route.at(sq).p + route.left(sq) * l_lat;
    };
    const Vec3 tangent_vec = line_pt(pr.s + 3.0) - line_pt(pr.s - 3.0);
    const double psi_path = std::atan2(tangent_vec.y, tangent_vec.x);
    double heading_err = std::atan2(fwd.y, fwd.x) - psi_path;
    while (heading_err > kPi) heading_err -= 2.0 * kPi;
    while (heading_err < -kPi) heading_err += 2.0 * kPi;

    auto signed_curv = [&](double sq) {
        return !line.empty() ? line.curvature(sq) : route.at(sq).curvature;
    };

    const double v_ref = std::min(sample_speed_profile(route, vprof, pr.s),
                                  sample_speed_profile(route, vprof, pr.s + std::max(v, 0.0) * 0.5));
    if (out_v_ref != nullptr) *out_v_ref = v_ref;

    // Nearest obstacle ahead within 60 m along the route
    double obs_ds = 60.0;
    double obs_rel_lat = 0.0;
    bool found_obs = false;
    for (const OtherCar& other : others) {
        if (length(other.position - chassis.position) > 75.0) continue;
        const Route::Projection op = route.project(other.position, hint_io);
        const double ds = route.delta(pr.s, op.s);
        if (ds <= 0.5 || ds >= 60.0) continue;
        const RouteSample at_o = route.at(op.s);
        if (std::abs(op.lateral) > std::max(at_o.width_left, at_o.width_right) + 2.0) continue;
        if (ds < obs_ds) {
            obs_ds = ds;
            obs_rel_lat = op.lateral - pr.lateral;
            found_obs = true;
        }
    }

    const double room_left = std::max(0.0, here.width_left - pr.lateral);
    const double room_right = std::max(0.0, here.width_right + pr.lateral);

    obs[0] = clamp(v / 80.0, -1.0, 1.0);
    obs[1] = clamp((pr.lateral - opt_lat) / 5.0, -2.0, 2.0);
    obs[2] = std::sin(heading_err);
    obs[3] = clamp(last.yaw_rate / 2.0, -2.0, 2.0);
    obs[4] = clamp(last.sideslip / 0.5, -2.0, 2.0);
    obs[5] = clamp(signed_curv(pr.s + 15.0) * 40.0, -1.0, 1.0);
    obs[6] = clamp(signed_curv(pr.s + 35.0) * 40.0, -1.0, 1.0);
    obs[7] = clamp(signed_curv(pr.s + 65.0) * 40.0, -1.0, 1.0);
    obs[8] = clamp(signed_curv(pr.s + 110.0) * 40.0, -1.0, 1.0);
    obs[9] = clamp(room_left / 8.0, 0.0, 1.0);
    obs[10] = clamp(room_right / 8.0, 0.0, 1.0);
    obs[11] = clamp((v - v_ref) / 25.0, -1.0, 1.0);
    obs[12] = found_obs ? clamp(obs_ds / 60.0, 0.0, 1.0) : 1.0;
    obs[13] = found_obs ? clamp(obs_rel_lat / 5.0, -1.0, 1.0) : 0.0;
    return obs;
}

NeuralDriver::NeuralDriver(const CarConfig& cfg, const Route& route, const NeuralPolicy& policy, double skill)
    : cfg_(cfg), route_(route), policy_(policy), line_(route) {
    vprof_ = build_speed_profile(cfg_, route_, line_, skill);
}

double NeuralDriver::speed_profile(double s) const {
    return sample_speed_profile(route_, vprof_, s);
}

AIOutput NeuralDriver::update(const ChassisState& chassis, const VehicleOutput& last,
                              const std::vector<OtherCar>& others, double dt) {
    (void)dt;
    Route::Projection pr{};
    double v_ref = 0.0;
    last_obs = extract_observation(route_, line_, vprof_, chassis, last, others, hint_, &pr, &v_ref);
    route_s = pr.s;
    last_lateral = pr.lateral;
    target_speed = v_ref;

    policy_.infer(last_obs, last_action);

    AIOutput out{};
    out.raw.device = InputDevice::Wheel;
    out.raw.steer = clamp(last_action.steer, -1.0, 1.0);
    out.raw.throttle = clamp(last_action.throttle, 0.0, 1.0);
    out.raw.brake = clamp(last_action.brake, 0.0, 1.0);
    return out;
}

}  // namespace rs
