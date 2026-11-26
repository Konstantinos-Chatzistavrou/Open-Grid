// Apache-2.0 — OpenGrid 70-player multiplayer server stress test & lockstep determinism proof.
//
// Benchmarks 70 simultaneous rs_core vehicles at 400 Hz with ALL realistic game features enabled:
//   - 3-ray circular-arc contact patches per wheel
//   - 2-DOF unsprung dynamics, 3-zone I/M/O tyre thermals, 4x4 contact patch grid
//   - 3D kingpin FFB wrench + elastic 2-DOF steering column
//   - Chassis torsional flex, active yaw control, active aero, brake fluid boil,
//     elastokinematic bushing compliance, progressive bump stops
//   - Multi-car 3D wind-advected aerodynamic wake/slipstream solver every tick across nearby pack cars
//   - Live crash impulses + 40-byte NetDamageSnapshot packing at 20 Hz
//
// Also proves bit-exact lockstep determinism across two independent worlds AND verifies
// server-authoritative replay with rs::AuthorityServerSim (exits non-zero on any mismatch).
//
// Usage:
//   rs_bench_lobby70 [--car data/cars/vela_gt.json] [--cars 70] [--seconds 2.0] [--rate 400] [--det-ticks 200]

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "rs/authority.hpp"
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/damage.hpp"
#include "rs/sim.hpp"
#include "rs/vehicle.hpp"

namespace {

using SteadyClock = std::chrono::steady_clock;

struct Options {
    std::string car_path = "data/cars/vela_gt.json";
    int n_cars = 70;
    double sim_seconds = 2.0;
    int rate_hz = 400;
    int det_ticks = 200;  // 0.50 s lockstep verification across all cars
};

void print_usage(const char* prog) {
    std::printf(
        "Usage: %s [car_json] [--car <path>] [--cars <N>] [--seconds <S>] [--rate <Hz>] [--det-ticks <T>]\n",
        prog);
}

Options parse_args(int argc, char** argv) {
    Options opt;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto need_value = [&](const char* flag) -> std::string {
            if (i + 1 >= argc) {
                throw std::runtime_error(std::string("missing value for ") + flag);
            }
            return argv[++i];
        };
        if (arg == "-h" || arg == "--help") {
            print_usage(argv[0]);
            std::exit(0);
        } else if (arg == "--car") {
            opt.car_path = need_value("--car");
        } else if (arg == "--cars") {
            opt.n_cars = std::max(2, std::stoi(need_value("--cars")));
        } else if (arg == "--seconds") {
            opt.sim_seconds = std::max(0.1, std::stod(need_value("--seconds")));
        } else if (arg == "--rate") {
            opt.rate_hz = std::max(60, std::stoi(need_value("--rate")));
        } else if (arg == "--det-ticks") {
            opt.det_ticks = std::max(20, std::stoi(need_value("--det-ticks")));
        } else if (!arg.empty() && arg[0] != '-') {
            opt.car_path = arg;
        } else {
            throw std::runtime_error("unknown argument: " + arg);
        }
    }
    return opt;
}

int pick_cruise_gear(const rs::CarConfig& cfg) {
    const int n_gears = static_cast<int>(cfg.drivetrain.gear_ratios.size());
    if (n_gears <= 2) return 2;
    return std::clamp(5, 2, n_gears - 1);  // 4th gear (index 5) when available
}

void enable_full_realism(rs::Vehicle& v) {
    v.unsprung_dynamics_enabled = true;
    v.tire_zones_enabled = true;
    v.tire_patch_grid_enabled = true;
    v.damage_enabled = true;

    v.aero_wake().yaw_aero_enabled = true;

    auto& cd = v.chassis_dynamics();
    cd.chassis_flex_enabled = true;
    cd.active_yaw_control_enabled = true;
    cd.active_aero_enabled = true;
    cd.brake_fluid_boil_enabled = true;
    cd.bushing_compliance_enabled = true;
    cd.progressive_bump_stops_enabled = true;
    cd.kingpin_3d_ffb_enabled = true;
    cd.elastic_column_enabled = true;

    auto& eng = v.engine_systems();
    eng.torsional_compliance_enabled = true;
    eng.dog_box_flat_shift_cut = true;
    eng.turbo_stage = 1;
    eng.wear_enabled = true;
    eng.fuel_consumption_enabled = true;

    auto& atm = v.atmosphere();
    atm.enabled = true;
    atm.altitude_m = 120.0;
    atm.ambient_air_c = 22.0;
    atm.track_surface_c = 30.0;
    atm.humidity_0_to_1 = 0.45;
    atm.wind_world_mps = {0.0, 2.5, 0.0};  // 2.5 m/s crosswind for wind-advected wake cones

    auto& as = v.assists();
    as.abs = true;
    as.tc = true;
    as.esc = true;
}

struct LobbyCar {
    std::unique_ptr<rs::Vehicle> vehicle;
    std::unique_ptr<rs::Controls> controls;
    rs::RigidBody body;
    rs::VehicleOutput last_out{};
    rs::NetDamageSnapshot last_net_damage{};
    rs::Vec3 forward{1.0, 0.0, 0.0};
};

struct LobbyStats {
    double total_wall_ms = 0.0;
    double wake_wall_ms = 0.0;
    double snap_wall_ms = 0.0;
    std::uint64_t wake_neighbor_checks = 0;
    std::uint64_t damage_snaps_packed = 0;
    std::uint64_t damage_snaps_nonzero = 0;
    double min_drag_scale = 1.0;
    double min_front_df_scale = 1.0;
    double max_wake_turbulence = 0.0;
    std::uint64_t checksum = 0;
};

struct LobbyWorld {
    rs::PlaneGround ground;
    std::vector<LobbyCar> cars;
    std::vector<rs::AeroTrafficCar> traffic_all;
    std::vector<rs::AeroTrafficCar> traffic_near;
    double sim_time = 0.0;
    int start_gear = 4;

    LobbyWorld(const rs::CarConfig& cfg, int n_cars) {
        start_gear = pick_cruise_gear(cfg);
        cars.reserve(static_cast<std::size_t>(n_cars));
        traffic_all.resize(static_cast<std::size_t>(n_cars));
        traffic_near.reserve(static_cast<std::size_t>(n_cars));

        // 2-wide staggered racing pack at 48 m/s (~173 km/h), 7.5 m row spacing, 3.6 m lane spacing
        // so every car sits inside realistic slipstream, side-draft, and tandem push-draft envelopes.
        constexpr double kInitSpeed = 48.0;
        for (int i = 0; i < n_cars; ++i) {
            LobbyCar c;
            c.vehicle = std::make_unique<rs::Vehicle>(cfg);
            enable_full_realism(*c.vehicle);

            c.controls = std::make_unique<rs::Controls>(c.vehicle->config());
            c.controls->settings.auto_gearbox = true;
            c.controls->settings.auto_clutch = true;
            c.controls->set_gear(start_gear);

            c.body.mass = cfg.mass;
            c.body.inertia = {cfg.inertia_xx, cfg.inertia_yy, cfg.inertia_zz};

            const int row = i / 2;
            const int col = i % 2;
            const double x = static_cast<double>((n_cars / 2) - row) * 7.5 - static_cast<double>(col) * 1.5;
            const double y = (col == 0 ? 1.80 : -1.80);
            c.body.state.position = {x, y, cfg.cg_height};
            c.body.state.velocity = {kInitSpeed, 0.0, 0.0};
            c.body.state.orientation = rs::Quat{};
            c.body.state.angular_velocity = {0.0, 0.0, 0.0};

            c.vehicle->reset_motion(kInitSpeed, start_gear);
            cars.push_back(std::move(c));
        }
    }

    void step_tick(int tick, double dt, int rate_hz, bool measure, LobbyStats& stats) {
        const std::size_t n = cars.size();
        const int snap_interval = std::max(1, rate_hz / 20);  // 20 Hz damage replication
        const rs::Vec3 ambient_wind{0.0, 2.5, 0.0};
        constexpr double kWakeRangeSq = 65.0 * 65.0;

        // Snapshot pack kinematics for 3D wake solver
        for (std::size_t i = 0; i < n; ++i) {
            auto& c = cars[i];
            c.forward = c.body.state.orientation.rotate({1.0, 0.0, 0.0});
            const auto& cfg = c.vehicle->config();
            traffic_all[i].position = c.body.state.position;
            traffic_all[i].velocity = c.body.state.velocity;
            traffic_all[i].forward = c.forward;
            traffic_all[i].drag_area = cfg.aero.drag_area;
            traffic_all[i].lift_area = cfg.aero.lift_area;
            traffic_all[i].width_m = std::max(cfg.front.track, cfg.rear.track) + 0.25;
            traffic_all[i].height_m = 1.25;
        }

        // 1. Multi-car 3D aerodynamic wake / slipstream / side-draft solver (every tick)
        const auto wake_t0 = measure ? SteadyClock::now() : SteadyClock::time_point{};
        for (std::size_t i = 0; i < n; ++i) {
            traffic_near.clear();
            const rs::Vec3& my_pos = traffic_all[i].position;
            for (std::size_t j = 0; j < n; ++j) {
                if (i == j) continue;
                const rs::Vec3 d = traffic_all[j].position - my_pos;
                const double d2 = d.x * d.x + d.y * d.y + d.z * d.z;
                if (d2 <= kWakeRangeSq) {
                    traffic_near.push_back(traffic_all[j]);
                }
            }
            if (measure) {
                stats.wake_neighbor_checks += static_cast<std::uint64_t>(traffic_near.size());
            }
            rs::AeroWakeState wake = rs::Vehicle::compute_aero_wake_field(
                my_pos, traffic_all[i].velocity, traffic_all[i].forward,
                traffic_near, ambient_wind, sim_time);
            wake.yaw_aero_enabled = true;
            cars[i].vehicle->aero_wake() = wake;
            if (measure) {
                stats.min_drag_scale = std::min(stats.min_drag_scale, wake.drag_scale);
                stats.min_front_df_scale = std::min(stats.min_front_df_scale, wake.dirty_air_front_downforce_scale);
                stats.max_wake_turbulence = std::max(stats.max_wake_turbulence, wake.wake_turbulence_0_to_1);
            }
        }
        if (measure) {
            stats.wake_wall_ms += std::chrono::duration<double, std::milli>(SteadyClock::now() - wake_t0).count();
        }

        // 2. Deterministic scripted pack collisions & glancing rubs
        if (tick == 120 || tick == 320 || tick == 560) {
            for (std::size_t i = 0; i < n; ++i) {
                if (i % 7 == 0) {
                    // Front-quarter pack contact (~11 kN s impulse -> dent + alignment/aero degradation)
                    const rs::Vec3 pt_body{2.1, (i % 2 == 0 ? 0.55 : -0.55), 0.10};
                    cars[i].vehicle->add_contact(1000u + static_cast<std::uint64_t>(tick), pt_body, 11500.0);
                } else if (i % 5 == 0) {
                    // Glancing side rub (~2.2 kN s impulse -> paint scuff / minor panel load)
                    const rs::Vec3 pt_body{0.2, (i % 2 == 0 ? -0.92 : 0.92), 0.05};
                    cars[i].vehicle->add_contact(2000u + static_cast<std::uint64_t>(tick), pt_body, 2200.0);
                }
            }
        }

        // 3. Per-car 3-ray contact patch + controls + 400 Hz physics step + rigid-body integration
        const double t_sec = sim_time;
        for (std::size_t i = 0; i < n; ++i) {
            LobbyCar& c = cars[i];

            rs::RawInput raw;
            raw.device = rs::InputDevice::Wheel;
            const int phase = (tick / std::max(1, rate_hz / 2)) % 4;
            const bool braking = (phase == 2);
            raw.throttle = braking ? 0.0 : 0.90;
            raw.brake = braking ? 0.65 : 0.0;
            // Gentle synchronized pack weave so tyres, steering column FFB, and yaw aero stay active
            raw.steer = std::sin(1.1 * t_sec + 0.07 * static_cast<double>(i % 6)) * 0.06;

            const rs::DriverInput driver_in = c.controls->update(raw, c.last_out, dt);
            c.vehicle->set_input(driver_in);

            std::array<rs::WheelContact, 4> contacts{};
            const auto patches = c.vehicle->wheel_contact_patch_rays(c.body.state);
            for (int w = 0; w < 4; ++w) {
                std::array<rs::WheelContact, 3> hits{};
                for (int r = 0; r < 3; ++r) {
                    hits[r] = ground.raycast(patches[w].rays[r]);
                }
                contacts[w] = rs::Vehicle::resolve_contact_patch(
                    patches[w], hits, c.vehicle->config().tire(w).radius);
            }

            c.last_out = c.vehicle->update(c.body.state, contacts, dt);
            c.body.mass = c.last_out.mass_kg;
            c.body.inertia = c.last_out.effective_inertia;
            c.body.integrate(
                c.last_out.force + rs::Vec3{0.0, 0.0, -rs::kGravity * c.body.mass},
                c.last_out.torque,
                dt);
        }

        // 4. Pack 40-byte NetDamageSnapshot at 20 Hz for network replication
        if ((tick + 1) % snap_interval == 0) {
            const auto snap_t0 = measure ? SteadyClock::now() : SteadyClock::time_point{};
            for (std::size_t i = 0; i < n; ++i) {
                cars[i].last_net_damage = cars[i].vehicle->damage_model().pack_net_snapshot();
                if (measure) {
                    ++stats.damage_snaps_packed;
                    if (cars[i].last_net_damage.impact_seq > 0) {
                        ++stats.damage_snaps_nonzero;
                    }
                    stats.checksum ^= static_cast<std::uint64_t>(cars[i].last_net_damage.impact_seq)
                                      + (static_cast<std::uint64_t>(cars[i].last_net_damage.crush_nodes[0]) << 16)
                                      + (static_cast<std::uint64_t>(cars[i].last_net_damage.front_aero_eff) << 24);
                }
            }
            if (measure) {
                stats.snap_wall_ms += std::chrono::duration<double, std::milli>(SteadyClock::now() - snap_t0).count();
            }
        }

        sim_time += dt;
    }
};

bool bits_equal(double a, double b) {
    std::uint64_t ua = 0;
    std::uint64_t ub = 0;
    std::memcpy(&ua, &a, sizeof(double));
    std::memcpy(&ub, &b, sizeof(double));
    return ua == ub;
}

struct DeterminismReport {
    bool bit_exact = true;
    int cars_checked = 0;
    int ticks_checked = 0;
    int mismatched_fields = 0;
    double max_pos_drift_m = 0.0;
    double max_vel_drift_mps = 0.0;
    double max_rpm_drift = 0.0;
    double max_damage_drift_kj = 0.0;
    bool authority_replay_ok = false;
    double authority_pos_err_m = 0.0;
    double authority_vel_err_mps = 0.0;
    std::uint64_t authority_hash = 0;
};

DeterminismReport verify_lockstep_determinism(const rs::CarConfig& cfg, int n_cars, int rate_hz, int det_ticks) {
    DeterminismReport rep;
    rep.cars_checked = n_cars;
    rep.ticks_checked = det_ticks;

    const double dt = 1.0 / static_cast<double>(rate_hz);
    LobbyWorld world_a(cfg, n_cars);
    LobbyWorld world_b(cfg, n_cars);
    LobbyStats unused_stats_a;
    LobbyStats unused_stats_b;

    for (int t = 0; t < det_ticks; ++t) {
        world_a.step_tick(t, dt, rate_hz, false, unused_stats_a);
        world_b.step_tick(t, dt, rate_hz, false, unused_stats_b);
    }

    for (int i = 0; i < n_cars; ++i) {
        const LobbyCar& ca = world_a.cars[static_cast<std::size_t>(i)];
        const LobbyCar& cb = world_b.cars[static_cast<std::size_t>(i)];

        const double pos_diff = rs::length(ca.body.state.position - cb.body.state.position);
        const double vel_diff = rs::length(ca.body.state.velocity - cb.body.state.velocity);
        const double rpm_diff = std::fabs(ca.vehicle->engine_rpm() - cb.vehicle->engine_rpm());
        const double dmg_diff = std::fabs(
            ca.vehicle->damage_model().report().total_energy_kj
            - cb.vehicle->damage_model().report().total_energy_kj);

        rep.max_pos_drift_m = std::max(rep.max_pos_drift_m, pos_diff);
        rep.max_vel_drift_mps = std::max(rep.max_vel_drift_mps, vel_diff);
        rep.max_rpm_drift = std::max(rep.max_rpm_drift, rpm_diff);
        rep.max_damage_drift_kj = std::max(rep.max_damage_drift_kj, dmg_diff);

        const std::array<double, 16> fa = {
            ca.body.state.position.x, ca.body.state.position.y, ca.body.state.position.z,
            ca.body.state.velocity.x, ca.body.state.velocity.y, ca.body.state.velocity.z,
            ca.body.state.orientation.w, ca.body.state.orientation.x,
            ca.body.state.orientation.y, ca.body.state.orientation.z,
            ca.body.state.angular_velocity.x, ca.body.state.angular_velocity.y, ca.body.state.angular_velocity.z,
            ca.vehicle->engine_rpm(),
            ca.last_out.steering_column_torque_nm,
            ca.last_out.fuel_liters
        };
        const std::array<double, 16> fb = {
            cb.body.state.position.x, cb.body.state.position.y, cb.body.state.position.z,
            cb.body.state.velocity.x, cb.body.state.velocity.y, cb.body.state.velocity.z,
            cb.body.state.orientation.w, cb.body.state.orientation.x,
            cb.body.state.orientation.y, cb.body.state.orientation.z,
            cb.body.state.angular_velocity.x, cb.body.state.angular_velocity.y, cb.body.state.angular_velocity.z,
            cb.vehicle->engine_rpm(),
            cb.last_out.steering_column_torque_nm,
            cb.last_out.fuel_liters
        };
        for (std::size_t k = 0; k < fa.size(); ++k) {
            if (!bits_equal(fa[k], fb[k])) {
                rep.bit_exact = false;
                ++rep.mismatched_fields;
            }
        }

        const auto snap_a = ca.vehicle->damage_model().pack_net_snapshot();
        const auto snap_b = cb.vehicle->damage_model().pack_net_snapshot();
        if (std::memcmp(&snap_a, &snap_b, sizeof(rs::NetDamageSnapshot)) != 0) {
            rep.bit_exact = false;
            ++rep.mismatched_fields;
        }

        const std::uint64_t hash_a = rs::hash_chassis_state(
            ca.body.state, ca.vehicle->engine_rpm(), ca.last_out.gear);
        const std::uint64_t hash_b = rs::hash_chassis_state(
            cb.body.state, cb.vehicle->engine_rpm(), cb.last_out.gear);
        if (hash_a != hash_b) {
            rep.bit_exact = false;
            ++rep.mismatched_fields;
        }
    }

    // Server-authoritative replay proof via rs::AuthorityServerSim
    const int cruise_gear = pick_cruise_gear(cfg);
    auto client_sim = std::make_unique<rs::Simulation>(cfg, std::make_shared<rs::PlaneGround>());
    client_sim->dt = dt;
    client_sim->use_contact_patch = true;
    enable_full_realism(client_sim->vehicle);
    client_sim->reset({0.0, 0.0, 0.0}, 0.0, 38.0, cruise_gear);

    rs::AuthorityServerSim server(cfg, std::make_shared<rs::PlaneGround>());
    server.sim().dt = dt;
    server.sim().use_contact_patch = true;
    enable_full_realism(server.sim().vehicle);
    server.reset({0.0, 0.0, 0.0}, 0.0, 38.0, cruise_gear);

    const auto cfg_ver = server.verify_config_hash(rs::hash_car_config(cfg));

    std::vector<rs::TickInputFrame> frames;
    frames.reserve(static_cast<std::size_t>(det_ticks));
    for (int t = 0; t < det_ticks; ++t) {
        rs::TickInputFrame f;
        f.tick = static_cast<std::uint32_t>(t);
        f.input.gear = cruise_gear;
        f.input.auto_clutch = true;
        f.input.throttle = (t < det_ticks * 3 / 4) ? 0.85 : 0.0;
        f.input.brake = (t >= det_ticks * 3 / 4) ? 0.60 : 0.0;
        f.input.steer = std::sin(0.015 * static_cast<double>(t)) * 0.18;
        client_sim->step(f.input);
        frames.push_back(f);
    }

    rs::ClientStateClaim claim;
    claim.tick = static_cast<std::uint32_t>(det_ticks - 1);
    claim.chassis = client_sim->body.state;
    claim.engine_rpm = client_sim->vehicle.engine_rpm();
    claim.gear = client_sim->last.gear;
    claim.state_hash = rs::hash_chassis_state(claim.chassis, claim.engine_rpm, claim.gear);

    const rs::VerificationResult ver = server.verify_ticks(frames, claim, 1e-9, 1e-9);
    rep.authority_replay_ok =
        cfg_ver.valid && ver.valid && ver.position_error_m == 0.0 && ver.speed_error_ms == 0.0
        && ver.authoritative_hash == claim.state_hash;
    rep.authority_pos_err_m = ver.position_error_m;
    rep.authority_vel_err_mps = ver.speed_error_ms;
    rep.authority_hash = ver.authoritative_hash;

    return rep;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        const Options opt = parse_args(argc, argv);
        const rs::CarConfig cfg = rs::load_car_config(opt.car_path);
        const double dt = 1.0 / static_cast<double>(opt.rate_hz);
        const int warmup_ticks = std::max(20, opt.rate_hz / 4);
        const int measure_ticks = static_cast<int>(std::llround(opt.sim_seconds * static_cast<double>(opt.rate_hz)));

        std::printf("================================================================================\n");
        std::printf("OpenGrid %d-Player Multiplayer Server Stress Test & Determinism Proof\n", opt.n_cars);
        std::printf("================================================================================\n");
        std::printf("  Car config        : %s (%s)\n", cfg.name.c_str(), opt.car_path.c_str());
        std::printf("  Spec config hash  : 0x%016llx\n",
                    static_cast<unsigned long long>(rs::hash_car_config(cfg)));
        std::printf("  Simulation setup  : %d cars @ %d Hz for %.2f sim-s (%d ticks + %d warmup)\n",
                    opt.n_cars, opt.rate_hz, opt.sim_seconds, measure_ticks, warmup_ticks);
        std::printf("  Active subsystems : 3-ray patch, unsprung, 3-zone tyre thermals, 3D kingpin FFB,\n");
        std::printf("                      elastic column, yaw/active aero, 3D multi-car wake field,\n");
        std::printf("                      chassis flex, AYC, brake boil, compliance, live crash damage\n");

        LobbyWorld world(cfg, opt.n_cars);
        LobbyStats warmup_stats;
        for (int t = 0; t < warmup_ticks; ++t) {
            world.step_tick(t, dt, opt.rate_hz, false, warmup_stats);
        }

        LobbyStats stats;
        const auto t0 = SteadyClock::now();
        for (int t = 0; t < measure_ticks; ++t) {
            world.step_tick(t, dt, opt.rate_hz, true, stats);
        }
        stats.total_wall_ms = std::chrono::duration<double, std::milli>(SteadyClock::now() - t0).count();

        // Prevent dead-code elimination across all cars
        double sink = 0.0;
        for (const auto& c : world.cars) {
            sink += c.body.state.position.x + c.vehicle->engine_rpm() + c.last_out.steering_column_torque_nm;
        }

        const double total_car_steps = static_cast<double>(measure_ticks) * static_cast<double>(opt.n_cars);
        const double us_per_step_car = (stats.total_wall_ms * 1000.0) / total_car_steps;
        const double us_per_step_all = (stats.total_wall_ms * 1000.0) / static_cast<double>(measure_ticks);
        const double ms_per_sim_s_car = (stats.total_wall_ms / opt.sim_seconds) / static_cast<double>(opt.n_cars);
        const double ms_per_sim_s_all = stats.total_wall_ms / opt.sim_seconds;
        const double pct_1_core = ms_per_sim_s_all / 10.0;
        const double pct_4_cores = ms_per_sim_s_all / 40.0;
        const double tick_budget_us = 1e6 / static_cast<double>(opt.rate_hz);

        const double wake_us_per_tick = (stats.wake_wall_ms * 1000.0) / static_cast<double>(measure_ticks);
        const double wake_us_per_car = (stats.wake_wall_ms * 1000.0) / total_car_steps;
        const double wake_pct_total = stats.total_wall_ms > 0.0 ? (100.0 * stats.wake_wall_ms / stats.total_wall_ms) : 0.0;
        const double avg_neighbors = static_cast<double>(stats.wake_neighbor_checks) / total_car_steps;

        constexpr std::size_t kNetDamageBytes = sizeof(rs::NetDamageSnapshot);
        static_assert(kNetDamageBytes == 40, "NetDamageSnapshot must remain 40 bytes");
        constexpr double kDamageSyncHz = 20.0;
        const double dmg_client_kbs = (static_cast<double>(opt.n_cars) * static_cast<double>(kNetDamageBytes) * kDamageSyncHz) / 1000.0;
        const double dmg_client_kibs = (static_cast<double>(opt.n_cars) * static_cast<double>(kNetDamageBytes) * kDamageSyncHz) / 1024.0;
        const double dmg_server_fanout_mbs =
            (static_cast<double>(opt.n_cars) * static_cast<double>(std::max(1, opt.n_cars - 1))
             * static_cast<double>(kNetDamageBytes) * kDamageSyncHz) / 1e6;
        const double snap_us_per_broadcast =
            stats.damage_snaps_packed > 0
                ? (stats.snap_wall_ms * 1000.0) / (static_cast<double>(stats.damage_snaps_packed) / static_cast<double>(opt.n_cars))
                : 0.0;

        std::printf("\n[CPU Performance — %d Cars @ %d Hz]\n", opt.n_cars, opt.rate_hz);
        std::printf("  Per-car step time : %6.2f us/step/car  (%6.2f ms/sim-s/car)\n",
                    us_per_step_car, ms_per_sim_s_car);
        std::printf("  Total %2d-car step : %6.1f us/tick      (budget: %.0f us/tick @ %d Hz)\n",
                    opt.n_cars, us_per_step_all, tick_budget_us, opt.rate_hz);
        std::printf("  Total CPU cost    : %6.1f ms/sim-s     (%5.1f%% of 1 core | %5.1f%% of 4 cores)\n",
                    ms_per_sim_s_all, pct_1_core, pct_4_cores);
        std::printf("  Wall-clock run    : %6.1f ms for %.2f sim-s  [sink=%.1f, chk=0x%llx]\n",
                    stats.total_wall_ms, opt.sim_seconds, sink, static_cast<unsigned long long>(stats.checksum));

        std::printf("\n[3D Multi-Car Wake Solver (compute_aero_wake_field)]\n");
        std::printf("  Wake overhead     : %6.2f us/tick (%d cars) | %5.2f us/car/tick (%.1f%% of total CPU)\n",
                    wake_us_per_tick, opt.n_cars, wake_us_per_car, wake_pct_total);
        std::printf("  Pack density      : %.1f nearby cars evaluated/car/tick (<= 65 m radius)\n", avg_neighbors);
        std::printf("  Wake physics peak : min drag_scale=%.3f | min front_df=%.3f | max turbulence=%.3f\n",
                    stats.min_drag_scale, stats.min_front_df_scale, stats.max_wake_turbulence);

        std::printf("\n[Damage Replication Bandwidth (NetDamageSnapshot @ 20 Hz)]\n");
        std::printf("  Snapshot size     : %zu bytes/car (static_assert == 40)\n", kNetDamageBytes);
        std::printf("  Per-client stream : %.2f KB/s (%.2f KiB/s) for %d cars @ %.0f Hz\n",
                    dmg_client_kbs, dmg_client_kibs, opt.n_cars, kDamageSyncHz);
        std::printf("  Server fanout     : %.2f MB/s total egress (%d clients x %d peers @ %.0f Hz)\n",
                    dmg_server_fanout_mbs, opt.n_cars, std::max(1, opt.n_cars - 1), kDamageSyncHz);
        std::printf("  Pack overhead     : %.2f us per 20 Hz broadcast (%llu/%llu snapshots carried live damage)\n",
                    snap_us_per_broadcast,
                    static_cast<unsigned long long>(stats.damage_snaps_nonzero),
                    static_cast<unsigned long long>(stats.damage_snaps_packed));

        const DeterminismReport det = verify_lockstep_determinism(cfg, opt.n_cars, opt.rate_hz, opt.det_ticks);
        std::printf("\n[Bit-Exact Lockstep Determinism & Authority Replay Proof]\n");
        std::printf("  Two-world pack    : %d cars x %d ticks (%.2f sim-s) -> %s (mismatched fields: %d)\n",
                    det.cars_checked, det.ticks_checked,
                    static_cast<double>(det.ticks_checked) * dt,
                    det.bit_exact ? "PASS (BIT-EXACT)" : "FAIL",
                    det.mismatched_fields);
        std::printf("  Max drift (A vs B): pos=%.1e m | vel=%.1e m/s | rpm=%.1e | damage=%.1e kJ\n",
                    det.max_pos_drift_m, det.max_vel_drift_mps, det.max_rpm_drift, det.max_damage_drift_kj);
        std::printf("  AuthorityServerSim: %s (pos_err=%.1e m, vel_err=%.1e m/s, hash=0x%016llx)\n",
                    det.authority_replay_ok ? "PASS (ZERO-ERROR REPLAY)" : "FAIL",
                    det.authority_pos_err_m, det.authority_vel_err_mps,
                    static_cast<unsigned long long>(det.authority_hash));
        std::printf("================================================================================\n");

        if (!det.bit_exact || !det.authority_replay_ok || det.max_pos_drift_m != 0.0
            || det.max_vel_drift_mps != 0.0 || det.max_rpm_drift != 0.0 || det.max_damage_drift_kj != 0.0) {
            std::fprintf(stderr, "ERROR: lockstep determinism verification failed!\n");
            return 1;
        }
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "bench_lobby70 error: %s\n", e.what());
        return 2;
    }
}
