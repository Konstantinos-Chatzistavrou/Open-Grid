// CPU cost benchmark for the 1 kHz / 360 Hz / 240 Hz vehicle runtime: 16 cars, full feature set on
// (matching web/wasm/bridge.cpp rs_create and ue5_plugin OpenGridVehicleComponent), 3-ray contact patch per wheel.
// Reports us/step/car, ms per simulated second per car, and total ms per simulated second for 16 cars.
//   core/build/rs_bench_runtime data/cars/vela_gt.json
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/sim.hpp"
#include "rs/vehicle.hpp"
#include "rs/vehicle_runtime.hpp"

namespace {

using clk = std::chrono::steady_clock;

struct BenchCar {
    std::unique_ptr<rs::Vehicle> vehicle;
    std::unique_ptr<rs::Controls> controls;
    std::unique_ptr<rs::rt::VehicleRuntime<16, 16>> runtime;
    rs::RigidBody body;
};

BenchCar make_car(const rs::CarConfig& cfg, int idx) {
    BenchCar c;
    c.vehicle = std::make_unique<rs::Vehicle>(cfg);
    // Exact web/UE5 feature set (all features on)
    c.vehicle->unsprung_dynamics_enabled = true;
    c.vehicle->tire_zones_enabled = true;
    c.vehicle->aero_wake().yaw_aero_enabled = true;
    c.vehicle->chassis_dynamics().chassis_flex_enabled = true;
    c.vehicle->chassis_dynamics().active_yaw_control_enabled = true;
    c.vehicle->chassis_dynamics().active_aero_enabled = true;
    c.vehicle->chassis_dynamics().brake_fluid_boil_enabled = true;
    c.vehicle->engine_systems().torsional_compliance_enabled = true;
    c.vehicle->engine_systems().dog_box_flat_shift_cut = true;
    c.vehicle->engine_systems().turbo_stage = 1;
    c.vehicle->atmosphere().enabled = true;
    c.vehicle->engine_systems().wear_enabled = true;
    c.vehicle->engine_systems().fuel_consumption_enabled = true;
    c.vehicle->assists().abs = true;
    c.vehicle->assists().tc = true;
    c.vehicle->assists().esc = true;

    c.controls = std::make_unique<rs::Controls>(c.vehicle->config());
    c.controls->settings.auto_gearbox = true;
    c.controls->settings.auto_clutch = true;
    c.runtime = std::make_unique<rs::rt::VehicleRuntime<16, 16>>(*c.vehicle, *c.controls);

    c.body.mass = cfg.mass;
    c.body.inertia = {cfg.inertia_xx, cfg.inertia_yy, cfg.inertia_zz};
    c.body.state.position = {idx * 10.0, (idx % 2) * 4.0, cfg.cg_height};
    c.body.state.velocity = {22.0, 0.0, 0.0};
    c.vehicle->reset_motion(22.0, 3);
    c.controls->set_gear(3);

    rs::rt::VehicleCommand cmd;
    cmd.raw.throttle = 0.85;
    cmd.raw.steer = (idx % 2 ? 0.12 : -0.12);
    cmd.raw.device = rs::InputDevice::Gamepad;
    c.runtime->submit(cmd);
    return c;
}

void bench_rate(const rs::CarConfig& cfg, int n_cars, int rate_hz, double sim_seconds, bool use_patch3) {
    rs::PlaneGround ground;
    std::vector<BenchCar> cars;
    cars.reserve(static_cast<std::size_t>(n_cars));
    for (int i = 0; i < n_cars; ++i) cars.push_back(make_car(cfg, i));

    const double dt = 1.0 / rate_hz;
    const int warmup_ticks = rate_hz / 4;
    const int measure_ticks = static_cast<int>(std::llround(sim_seconds * rate_hz));

    auto step_one = [&](BenchCar& c) {
        std::array<rs::WheelContact, 4> contacts;
        if (use_patch3) {
            const auto patches = c.vehicle->wheel_contact_patch_rays(c.body.state);
            for (int w = 0; w < 4; ++w) {
                std::array<rs::WheelContact, 3> hits;
                for (int j = 0; j < 3; ++j) hits[j] = ground.raycast(patches[w].rays[j]);
                contacts[w] = rs::Vehicle::resolve_contact_patch(patches[w], hits, c.vehicle->config().tire(w).radius);
            }
        } else {
            const auto rays = c.vehicle->wheel_rays(c.body.state);
            for (int w = 0; w < 4; ++w) contacts[w] = ground.raycast(rays[w]);
        }
        const rs::VehicleOutput& out = c.runtime->step(c.body.state, contacts, dt);
        c.body.mass = out.mass_kg;
        c.body.integrate(out.force + rs::Vec3{0, 0, -rs::kGravity * c.body.mass}, out.torque, dt);
        // Drain periodically like a 60 Hz renderer so ring never stays permanently full.
        rs::rt::StepRecord rec;
        c.runtime->latest(rec);
    };

    for (int t = 0; t < warmup_ticks; ++t) {
        for (auto& c : cars) step_one(c);
    }

    const auto t0 = clk::now();
    for (int t = 0; t < measure_ticks; ++t) {
        if (t % (rate_hz / 2) == 0) {
            for (int i = 0; i < n_cars; ++i) {
                rs::rt::VehicleCommand cmd;
                const bool braking = ((t / (rate_hz / 2)) % 3 == 2);
                cmd.raw.throttle = braking ? 0.0 : 0.85;
                cmd.raw.brake = braking ? 0.75 : 0.0;
                cmd.raw.steer = std::sin(0.5 * t * dt + i) * 0.25;
                cmd.raw.device = rs::InputDevice::Gamepad;
                cars[i].runtime->submit(cmd);
            }
        }
        for (auto& c : cars) step_one(c);
    }
    const double elapsed_ms = std::chrono::duration<double, std::milli>(clk::now() - t0).count();

    // Prevent dead-code elimination
    double sink = 0.0;
    for (const auto& c : cars) sink += c.body.state.position.x + c.vehicle->engine_rpm();

    const double total_steps = static_cast<double>(measure_ticks) * n_cars;
    const double us_per_step = (elapsed_ms * 1000.0) / total_steps;
    const double ms_per_sim_s_car = (elapsed_ms / sim_seconds) / n_cars;
    const double ms_per_sim_s_all = elapsed_ms / sim_seconds;
    const double ms_per_60fps_frame = ms_per_sim_s_all / 60.0;
    const double ms_per_30fps_frame = ms_per_sim_s_all / 30.0;

    std::printf("  %4d Hz (%s): %5.2f us/step/car | %6.2f ms/sim-s/car | %d cars: %6.1f ms/sim-s (%4.1f%% of 1 core) | %.2f ms @60fps, %.2f ms @30fps  [sink=%.0f]\n",
                rate_hz, use_patch3 ? "3-ray" : "1-ray", us_per_step, ms_per_sim_s_car, n_cars,
                ms_per_sim_s_all, ms_per_sim_s_all / 10.0, ms_per_60fps_frame, ms_per_30fps_frame, sink);
}

}  // namespace

int main(int argc, char** argv) {
    const char* path = argc > 1 ? argv[1] : "data/cars/vela_gt.json";
    const rs::CarConfig cfg = rs::load_car_config(path);
    std::printf("Native C++17 rs_core runtime benchmark (16 cars, all web/AAA features on, %s)\n", path);
    bench_rate(cfg, 16, 1000, 3.0, true);
    bench_rate(cfg, 16, 360, 3.0, true);
    bench_rate(cfg, 16, 240, 3.0, true);
    bench_rate(cfg, 16, 1000, 3.0, false);
    bench_rate(cfg, 16, 360, 3.0, false);
    return 0;
}
