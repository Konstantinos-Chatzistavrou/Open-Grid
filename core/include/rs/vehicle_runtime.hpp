// Threaded vehicle runtime: rs::Vehicle on a physics thread, driven and read from a game / render thread through
// lock-free rings (header-only, C++17, std::thread only; no engine dependencies).
//
//   game / render thread                         physics thread (fixed rate: 1000, 400, 360 or 240 Hz)
//   --------------------                         ----------------------------------------------
//   submit(VehicleCommand)  --SpscRing-->        step(chassis, contacts, dt):
//   submit_impact(...)      --SpscRing-->          apply due commands, crash impulses
//                                                  Controls -> Vehicle::update  (unchanged physics)
//   drain(records) / latest  <--SpscRing--         publish a StepRecord for this tick
//
// The single-threaded API is untouched: Vehicle::update, Controls::update and rs::Simulation work exactly as before.
// This layer only decides WHEN they run and how data crosses threads. Nothing here allocates per tick, takes a lock,
// or waits on the other thread: a full ring makes try_push fail (counted), never blocks the physics.
//
// Determinism: commands carry the tick they apply to (apply_tick). The physics holds a command back until that tick,
// so a script or replay produces the same states bit for bit whatever the render rate or thread timing. Live input is
// stamped "now" (apply_tick 0): it lands on the next step, as on a single thread.
//
// Engines that already own a fixed-rate physics thread (Unreal's async physics tick) call step() from it. Elsewhere
// FixedRateThread below is that thread (native tools, a dedicated server, tests).
#pragma once
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <thread>
#include "rs/controls.hpp"
#include "rs/fixed_step.hpp"
#include "rs/spsc_ring.hpp"
#include "rs/vehicle.hpp"

namespace rs::rt {

/** Settings the game can change while driving (applied on the physics thread with the next command). */
struct VehicleSettings {
    int turbo_stage = 0;
    double altitude_m = 10.0;
    double ambient_air_c = 18.0;
    double track_surface_c = 22.0;
    double humidity = 0.45;
    bool abs = true, tc = true, esc = true;
    bool auto_gearbox = true;
};

/** Game / render thread -> physics thread. Levels (axes, settings) replace the previous command's; edges add up. */
struct VehicleCommand {
    std::uint64_t apply_tick = 0;   // first physics tick this applies to; 0 = the next step
    bool core_controls = true;      // true: `raw` goes through rs::Controls; false: `direct` goes to the vehicle as is
    RawInput raw;                   // raw.shift_up / shift_down are EDGES: each acts on exactly one step
    DriverInput direct;             // direct.nos / starter are used in both modes (Controls has no such inputs)
    bool repair = false;            // edge: damage repair + service (full tank, healthy engine)
    bool has_settings = false;
    VehicleSettings settings;
};

/** A crash impulse measured by the engine (world point, N s, the other object's id). */
struct ImpactCommand {
    Vec3 point_world;
    double impulse = 0;
    std::uint64_t other = 0;
};

/** Physics thread -> game / render thread: everything one tick produced. */
struct StepRecord {
    std::uint64_t tick = 0;          // tick number of this step (0, 1, 2, ...)
    double dt = 0;
    ChassisState chassis;            // the chassis state the step started from (what the rays were cast from)
    DriverInput input;               // after Controls
    VehicleOutput out;               // forces, wheels, telemetry
    std::array<double, 4> spin{};    // accumulated wheel rotation angle mod 2 pi, rad (for wheel visuals)
};

/**
 * Interpolate two physics StepRecords at render blend factor `alpha` in [0, 1].
 * Eliminates the 1-step wheel pose lag relative to the interpolated chassis by blending each wheel's
 * centre_world, steer_angle, camber, toe_angle, compression, angular_velocity, load, slip_ratio, slip_angle,
 * and spin[i] (using lerp_angle for wrap-around across 2*pi).
 */
inline StepRecord blend(const StepRecord& a, const StepRecord& b, double alpha) {
    const double t = rs::clamp(alpha, 0.0, 1.0);
    StepRecord r = (t < 0.5) ? a : b;
    r.dt = rs::lerp(a.dt, b.dt, t);

    r.chassis.position = rs::lerp(a.chassis.position, b.chassis.position, t);
    r.chassis.orientation = rs::nlerp(a.chassis.orientation, b.chassis.orientation, t);
    r.chassis.velocity = rs::lerp(a.chassis.velocity, b.chassis.velocity, t);
    r.chassis.angular_velocity = rs::lerp(a.chassis.angular_velocity, b.chassis.angular_velocity, t);

    r.input.steer = rs::lerp(a.input.steer, b.input.steer, t);
    r.input.throttle = rs::lerp(a.input.throttle, b.input.throttle, t);
    r.input.brake = rs::lerp(a.input.brake, b.input.brake, t);
    r.input.clutch = rs::lerp(a.input.clutch, b.input.clutch, t);
    r.input.handbrake = rs::lerp(a.input.handbrake, b.input.handbrake, t);

    r.out.force = rs::lerp(a.out.force, b.out.force, t);
    r.out.torque = rs::lerp(a.out.torque, b.out.torque, t);
    r.out.steer_torque = rs::lerp(a.out.steer_torque, b.out.steer_torque, t);
    r.out.speed = rs::lerp(a.out.speed, b.out.speed, t);
    r.out.sideslip = rs::lerp(a.out.sideslip, b.out.sideslip, t);
    r.out.yaw_rate = rs::lerp(a.out.yaw_rate, b.out.yaw_rate, t);
    r.out.accel = rs::lerp(a.out.accel, b.out.accel, t);
    r.out.throttle_applied = rs::lerp(a.out.throttle_applied, b.out.throttle_applied, t);
    r.out.brake_applied = rs::lerp(a.out.brake_applied, b.out.brake_applied, t);
    r.out.engine_rpm = rs::lerp(a.out.engine_rpm, b.out.engine_rpm, t);
    r.out.boost_bar = rs::lerp(a.out.boost_bar, b.out.boost_bar, t);
    r.out.fuel_liters = rs::lerp(a.out.fuel_liters, b.out.fuel_liters, t);
    r.out.mass_kg = rs::lerp(a.out.mass_kg, b.out.mass_kg, t);
    r.out.effective_inertia = rs::lerp(a.out.effective_inertia, b.out.effective_inertia, t);
    r.out.exhaust_primary_hz = rs::lerp(a.out.exhaust_primary_hz, b.out.exhaust_primary_hz, t);
    r.out.gear_whine_hz = rs::lerp(a.out.gear_whine_hz, b.out.gear_whine_hz, t);
    r.out.turbo_surge = rs::lerp(a.out.turbo_surge, b.out.turbo_surge, t);
    r.out.roll_centre_front_m = rs::lerp(a.out.roll_centre_front_m, b.out.roll_centre_front_m, t);
    r.out.roll_centre_rear_m = rs::lerp(a.out.roll_centre_rear_m, b.out.roll_centre_rear_m, t);

    for (std::size_t i = 0; i < 4; ++i) {
        WheelOutput& w = r.out.wheels[i];
        const WheelOutput& wa = a.out.wheels[i];
        const WheelOutput& wb = b.out.wheels[i];
        w.contact = (t < 0.5) ? wa.contact : wb.contact;
        w.centre_world = rs::lerp(wa.centre_world, wb.centre_world, t);
        w.contact_point = rs::lerp(wa.contact_point, wb.contact_point, t);
        w.force_world = rs::lerp(wa.force_world, wb.force_world, t);
        w.steer_angle = rs::lerp(wa.steer_angle, wb.steer_angle, t);
        w.camber = rs::lerp(wa.camber, wb.camber, t);
        w.toe_angle = rs::lerp(wa.toe_angle, wb.toe_angle, t);
        w.caster_angle = rs::lerp(wa.caster_angle, wb.caster_angle, t);
        w.kpi_angle = rs::lerp(wa.kpi_angle, wb.kpi_angle, t);
        w.scrub_radius_m = rs::lerp(wa.scrub_radius_m, wb.scrub_radius_m, t);
        w.motion_ratio = rs::lerp(wa.motion_ratio, wb.motion_ratio, t);
        w.compression = rs::lerp(wa.compression, wb.compression, t);
        w.angular_velocity = rs::lerp(wa.angular_velocity, wb.angular_velocity, t);
        w.load = rs::lerp(wa.load, wb.load, t);
        w.slip_ratio = rs::lerp(wa.slip_ratio, wb.slip_ratio, t);
        w.slip_angle = rs::lerp(wa.slip_angle, wb.slip_angle, t);
        w.fx = rs::lerp(wa.fx, wb.fx, t);
        w.fy = rs::lerp(wa.fy, wb.fy, t);
        w.mz = rs::lerp(wa.mz, wb.mz, t);
        w.carcass_deflection_m = rs::lerp(wa.carcass_deflection_m, wb.carcass_deflection_m, t);
        w.unsprung_vel_mps = rs::lerp(wa.unsprung_vel_mps, wb.unsprung_vel_mps, t);
        w.kerb_load_ratio = rs::lerp(wa.kerb_load_ratio, wb.kerb_load_ratio, t);
        w.surface_excitation = rs::lerp(wa.surface_excitation, wb.surface_excitation, t);
        r.spin[i] = rs::lerp_angle(a.spin[i], b.spin[i], t);
    }
    return r;
}

/** Counters for the game's debug overlay. Written by the physics thread, read anywhere (relaxed). */
struct RuntimeStats {
    std::atomic<std::uint64_t> steps{0};
    std::atomic<std::uint64_t> records_dropped{0};   // ring full: the game thread did not drain for > capacity ticks
    std::atomic<std::uint64_t> commands_applied{0};
    std::atomic<std::uint64_t> commands_late{0};      // arrived after their apply_tick had been simulated
};

template <std::size_t CommandCapacity = 64, std::size_t RecordCapacity = 256>
class VehicleRuntime {
public:
    /** The runtime drives `vehicle` with `controls` (both owned by the caller and used ONLY via step() from now on). */
    VehicleRuntime(Vehicle& vehicle, Controls& controls) : vehicle_(&vehicle), controls_(&controls) {}
    VehicleRuntime(const VehicleRuntime&) = delete;
    VehicleRuntime& operator=(const VehicleRuntime&) = delete;

    // ---- game / render thread ------------------------------------------------------------------------------------
    /** Queue a command. False when the ring is full: keep any edges and send them with the next command. */
    bool submit(const VehicleCommand& c) { return commands_.try_push(c); }
    bool submit_impact(const ImpactCommand& c) { return impacts_.try_push(c); }
    /** Pop every finished step in tick order: f(const StepRecord&). Returns how many. */
    template <typename F>
    std::size_t drain(F&& f) {
        std::size_t n = 0;
        while (const StepRecord* r = records_.front()) {
            f(*r);
            records_.pop();
            ++n;
        }
        return n;
    }
    /** Drain, keeping only the newest record in `out`. False when no step finished since the last call. */
    bool latest(StepRecord& out) {
        bool got = false;
        drain([&](const StepRecord& r) { out = r; got = true; });
        return got;
    }

    // ---- physics thread --------------------------------------------------------------------------------------------
    /** One physics step from `chassis` with these wheel contacts. Returns the output (forces to apply now). */
    const VehicleOutput& step(const ChassisState& chassis, const std::array<WheelContact, 4>& contacts, double dt) {
        apply_due_commands();
        ImpactCommand imp;
        while (impacts_.try_pop(imp)) {
            const Vec3 body = chassis.orientation.inv_rotate(imp.point_world - chassis.position);
            vehicle_->add_contact(imp.other, body, imp.impulse);
        }
        if (repair_) {
            vehicle_->damage_model().repair();
            vehicle_->service();
            repair_ = false;
        }

        DriverInput in;
        if (cmd_.core_controls) {
            RawInput raw = cmd_.raw;
            raw.shift_up = shift_up_;
            raw.shift_down = shift_down_;
            in = controls_->update(raw, out_, dt);
            in.nos = cmd_.direct.nos;
            in.starter = cmd_.direct.starter;
        } else {
            in = cmd_.direct;
        }
        shift_up_ = shift_down_ = false;
        vehicle_->set_input(in);
        out_ = vehicle_->update(chassis, contacts, dt);
        for (int w = 0; w < 4; ++w) spin_[w] = std::fmod(spin_[w] + out_.wheels[w].angular_velocity * dt, 2 * kPi);

        if (StepRecord* r = records_.prepare()) {
            r->tick = tick_;
            r->dt = dt;
            r->chassis = chassis;
            r->input = in;
            r->out = out_;
            r->spin = spin_;
            records_.commit();
        } else {
            stats.records_dropped.fetch_add(1, std::memory_order_relaxed);
        }
        ++tick_;
        stats.steps.fetch_add(1, std::memory_order_relaxed);
        return out_;
    }
    /** Tick number the next step() will get (physics thread). */
    std::uint64_t next_tick() const { return tick_; }
    /** Last output (physics thread). */
    const VehicleOutput& output() const { return out_; }
    /** Accumulated wheel spin angles mod 2 pi (physics thread). */
    const std::array<double, 4>& spin() const { return spin_; }
    /** Settings of the command in force (physics thread). */
    const VehicleCommand& current_command() const { return cmd_; }

    RuntimeStats stats;

private:
    void apply_due_commands() {
        while (const VehicleCommand* c = commands_.front()) {
            if (c->apply_tick > tick_) break;   // scripted for later: keep it (and everything queued after it)
            if (c->apply_tick != 0 && c->apply_tick < tick_) stats.commands_late.fetch_add(1, std::memory_order_relaxed);
            cmd_ = *c;
            shift_up_ = shift_up_ || c->raw.shift_up;
            shift_down_ = shift_down_ || c->raw.shift_down;
            repair_ = repair_ || c->repair;
            if (c->has_settings) apply_settings(c->settings);
            commands_.pop();
            stats.commands_applied.fetch_add(1, std::memory_order_relaxed);
        }
    }
    void apply_settings(const VehicleSettings& s) {
        vehicle_->engine_systems().turbo_stage = std::max(0, std::min(3, s.turbo_stage));
        AtmosphericEnvironment& atm = vehicle_->atmosphere();
        atm.altitude_m = s.altitude_m;
        atm.ambient_air_c = s.ambient_air_c;
        atm.track_surface_c = s.track_surface_c;
        atm.humidity_0_to_1 = s.humidity;
        AssistSettings& a = vehicle_->assists();
        a.abs = s.abs;
        a.tc = s.tc;
        a.esc = s.esc;
        controls_->settings.auto_gearbox = s.auto_gearbox;
    }

    Vehicle* vehicle_;
    Controls* controls_;
    SpscRing<VehicleCommand, CommandCapacity> commands_;
    SpscRing<ImpactCommand, CommandCapacity> impacts_;
    SpscRing<StepRecord, RecordCapacity> records_;
    // physics-thread state
    VehicleCommand cmd_;
    bool shift_up_ = false, shift_down_ = false, repair_ = false;
    VehicleOutput out_;
    std::array<double, 4> spin_{};
    std::uint64_t tick_ = 0;
};

/**
 * A thread that calls step(tick, dt) at exactly `rate_hz` steps per second of wall time on average (FixedStepClock:
 * late wake-ups run two steps, a long stall drops the backlog beyond max_steps_per_wake). Between steps it sleeps;
 * `spin_ns` > 0 busy-waits the last part of each wait for lower jitter (costs a core).
 * The epoch (start time) lets another thread find the current fractional tick for interpolation: tick_time_now().
 */
class FixedRateThread {
public:
    using StepFn = std::function<void(std::uint64_t tick, double dt)>;
    using clock = std::chrono::steady_clock;

    FixedRateThread(int rate_hz, StepFn step, int max_steps_per_wake = 0, std::int64_t spin_ns = 0)
        : clock_(rate_hz, max_steps_per_wake), step_(std::move(step)), spin_ns_(spin_ns) {}
    ~FixedRateThread() { stop(); }
    FixedRateThread(const FixedRateThread&) = delete;
    FixedRateThread& operator=(const FixedRateThread&) = delete;

    void start() {
        if (thread_.joinable()) return;
        running_.store(true);
        epoch_ns_.store(now_ns());
        thread_ = std::thread([this] { loop(); });
    }
    void stop() {
        running_.store(false);
        if (thread_.joinable()) thread_.join();
    }

    int rate_hz() const { return clock_.rate_hz(); }
    /** Fractional tick of wall-clock now since start (any thread). Ticks run AT these times or slightly after. */
    double tick_time_now() const {
        return static_cast<double>(now_ns() - epoch_ns_.load()) * clock_.rate_hz() / 1e9 -
               static_cast<double>(dropped_.load(std::memory_order_relaxed));
    }
    std::uint64_t ticks() const { return ticks_.load(std::memory_order_relaxed); }
    std::uint64_t dropped_steps() const { return dropped_.load(std::memory_order_relaxed); }
    /** Wall time spent inside step(), ns (divide by ticks() for the cost per step). */
    std::uint64_t busy_ns() const { return busy_ns_.load(std::memory_order_relaxed); }
    /** Largest number of steps one wake-up had to run (1 = always on time). */
    int max_batch() const { return max_batch_.load(std::memory_order_relaxed); }

private:
    static std::int64_t now_ns() {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(clock::now().time_since_epoch()).count();
    }
    void loop() {
        std::int64_t last = epoch_ns_.load();
        while (running_.load(std::memory_order_relaxed)) {
            const std::int64_t now = now_ns();
            const std::int64_t t0 = now;
            const int n = clock_.run(now - last, step_);
            last = now;
            if (n > 0) {
                busy_ns_.fetch_add(static_cast<std::uint64_t>(now_ns() - t0), std::memory_order_relaxed);
                ticks_.store(clock_.ticks(), std::memory_order_relaxed);
                dropped_.store(clock_.dropped_steps(), std::memory_order_relaxed);
                if (n > max_batch_.load(std::memory_order_relaxed)) max_batch_.store(n, std::memory_order_relaxed);
            }
            // Sleep until the next step is due (measured from `last`, the time the clock has accounted up to).
            const std::int64_t wait = static_cast<std::int64_t>((1.0 - clock_.alpha()) * 1e9 / clock_.rate_hz());
            const std::int64_t due = last + wait;
            const std::int64_t sleep_until = due - spin_ns_;
            const std::int64_t now2 = now_ns();
            if (sleep_until > now2) std::this_thread::sleep_for(std::chrono::nanoseconds(sleep_until - now2));
            while (spin_ns_ > 0 && now_ns() < due) std::this_thread::yield();
        }
    }

    FixedStepClock clock_;          // physics-thread only
    StepFn step_;
    std::int64_t spin_ns_;
    std::thread thread_;
    std::atomic<bool> running_{false};
    std::atomic<std::int64_t> epoch_ns_{0};
    std::atomic<std::uint64_t> ticks_{0};
    std::atomic<std::uint64_t> dropped_{0};
    std::atomic<std::uint64_t> busy_ns_{0};
    std::atomic<int> max_batch_{0};
};

}  // namespace rs::rt
