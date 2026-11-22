// Physics runtime: lock-free rings between threads, the fixed-step clock, and determinism at any render rate.
//   spsc_ring          ring semantics + a 2-thread stress test (no loss, no tearing, order kept)
//   triple_buffer      latest-value exchange under a 2-thread stress test (no tearing, never goes back in time)
//   fixed_step         exact step counts (1000 / 360 / 240 Hz) for any frame split, alpha, spiral-of-death clamp
//   runtime_determinism  a scripted drive gives bit-identical states at 30, 60, 144 fps, jittered and stalling frames
//   runtime_threaded   physics on a real 1000 Hz thread, a render thread interpolating snapshots from the ring:
//                      in order, no gaps, and the state at tick N equals the single-threaded run bit for bit
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <memory>
#include <thread>
#include <vector>
#include "harness.hpp"
#include "rs/fixed_step.hpp"
#include "rs/spsc_ring.hpp"
#include "rs/ue5_bridge.hpp"
#include "rs/vehicle_runtime.hpp"

namespace {

// ---- ring stress payload: every field derived from seq, so a torn read shows up as a mismatch ----------------------
struct Item {
    std::uint64_t seq = 0;
    std::uint64_t a = 0, b = 0, c = 0;
    double d[4] = {0, 0, 0, 0};
};
Item make_item(std::uint64_t s) {
    Item it;
    it.seq = s;
    it.a = s * 0x9E3779B97F4A7C15ull;
    it.b = ~s;
    it.c = s ^ 0xA5A5A5A5DEADBEEFull;
    for (int i = 0; i < 4; ++i) it.d[i] = static_cast<double>(s) * (i + 1) + 0.5;
    return it;
}
bool consistent(const Item& it) {
    const Item ref = make_item(it.seq);
    return it.a == ref.a && it.b == ref.b && it.c == ref.c && std::memcmp(it.d, ref.d, sizeof it.d) == 0;
}

inline void cpu_relax() { std::this_thread::yield(); }

// ---- a car on flat ground driven through the runtime: exactly the per-tick work of the game, minus the renderer ----
struct CarWorld {
    rs::CarConfig cfg;
    std::unique_ptr<rs::Vehicle> vehicle;
    std::unique_ptr<rs::Controls> controls;
    std::unique_ptr<rs::rt::VehicleRuntime<64, 256>> runtime;
    rs::RigidBody body;
    rs::PlaneGround ground;
    double dt;

    CarWorld(const rs::CarConfig& c, int rate_hz) : cfg(c), dt(1.0 / rate_hz) {
        vehicle = std::make_unique<rs::Vehicle>(cfg);
        // the web build's feature set (web/wasm/bridge.cpp rs_create)
        vehicle->unsprung_dynamics_enabled = true;
        vehicle->tire_zones_enabled = true;
        vehicle->aero_wake().yaw_aero_enabled = true;
        vehicle->chassis_dynamics().chassis_flex_enabled = true;
        vehicle->chassis_dynamics().active_yaw_control_enabled = true;
        vehicle->chassis_dynamics().active_aero_enabled = true;
        vehicle->chassis_dynamics().brake_fluid_boil_enabled = true;
        vehicle->engine_systems().torsional_compliance_enabled = true;
        vehicle->engine_systems().dog_box_flat_shift_cut = true;
        vehicle->atmosphere().enabled = true;
        vehicle->engine_systems().wear_enabled = true;
        vehicle->engine_systems().fuel_consumption_enabled = true;
        controls = std::make_unique<rs::Controls>(vehicle->config());
        controls->settings.auto_gearbox = true;
        runtime = std::make_unique<rs::rt::VehicleRuntime<64, 256>>(*vehicle, *controls);
        body.mass = cfg.mass;
        body.inertia = {cfg.inertia_xx, cfg.inertia_yy, cfg.inertia_zz};
        body.state.position = {0, 0, cfg.cg_height};
        vehicle->reset_motion(0, 2);
        controls->set_gear(2);
    }
    // one physics tick: 3-ray contact patch per wheel (as the web build), runtime step, chassis integration
    void step() {
        const auto patches = vehicle->wheel_contact_patch_rays(body.state);
        std::array<rs::WheelContact, 4> contacts;
        for (int i = 0; i < 4; ++i) {
            std::array<rs::WheelContact, 3> hits;
            for (int j = 0; j < 3; ++j) hits[j] = ground.raycast(patches[i].rays[j]);
            contacts[i] = rs::Vehicle::resolve_contact_patch(patches[i], hits, vehicle->config().tire(i).radius);
        }
        const rs::VehicleOutput& out = runtime->step(body.state, contacts, dt);
        body.mass = out.mass_kg;
        body.integrate(out.force + rs::Vec3{0, 0, -rs::kGravity * body.mass}, out.torque, dt);
    }
};

// The scripted drive: settle on the brake, launch, a left curve, a shift request, brake into a right curve.
// Commands carry the tick they apply to, so their effect cannot depend on when frames happen.
std::vector<rs::rt::VehicleCommand> script(int rate_hz) {
    auto at = [rate_hz](double s) { return static_cast<std::uint64_t>(std::llround(s * rate_hz)); };
    std::vector<rs::rt::VehicleCommand> v;
    auto cmd = [&](double t, double thr, double brk, double steer, bool up = false) {
        rs::rt::VehicleCommand c;
        c.apply_tick = at(t);
        c.raw.throttle = thr;
        c.raw.brake = brk;
        c.raw.steer = steer;
        c.raw.shift_up = up;
        c.raw.device = rs::InputDevice::Gamepad;
        c.has_settings = true;
        c.settings.turbo_stage = 1;
        v.push_back(c);
    };
    cmd(0.0, 0.0, 0.3, 0.0);
    cmd(0.4, 1.0, 0.0, 0.0);
    cmd(1.6, 0.8, 0.0, 0.35);
    cmd(1.9, 0.8, 0.0, 0.35, true);
    cmd(2.4, 0.0, 0.7, -0.25);
    cmd(2.8, 0.4, 0.0, 0.1);
    return v;
}

struct Final {
    rs::ChassisState s;
    double rpm = 0;
    std::array<double, 4> spin{};
    std::uint64_t ticks = 0;
};
bool same_bits(const Final& a, const Final& b) {
    auto eq = [](const void* x, const void* y, std::size_t n) { return std::memcmp(x, y, n) == 0; };
    const rs::ChassisState &p = a.s, &q = b.s;
    return eq(&p.position, &q.position, sizeof p.position) && eq(&p.orientation, &q.orientation, sizeof p.orientation) &&
           eq(&p.velocity, &q.velocity, sizeof p.velocity) &&
           eq(&p.angular_velocity, &q.angular_velocity, sizeof p.angular_velocity) && eq(&a.rpm, &b.rpm, sizeof a.rpm) &&
           eq(a.spin.data(), b.spin.data(), sizeof a.spin) && a.ticks == b.ticks;
}

// Frame-time patterns (ns): render rates the physics must not care about.
std::int64_t frame_ns(int pattern, int i, std::uint64_t& rng) {
    switch (pattern) {
        case 0: return 33333333;                        // 30 fps
        case 1: return 16666667;                        // 60 fps
        case 2: return 6944444;                         // 144 fps
        case 3: {                                       // jittered 4 .. 45 ms (xorshift: repeatable)
            rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
            return 4000000 + static_cast<std::int64_t>(rng % 41000000);
        }
        default: return (i % 40 == 39) ? 250000000 : 11000000;   // 90 fps with a 250 ms stall every 40 frames
    }
}

Final run_render_pattern(const rs::CarConfig& cfg, int rate_hz, std::uint64_t n_ticks, int pattern, std::uint64_t* dropped) {
    CarWorld w(cfg, rate_hz);
    for (const auto& c : script(rate_hz)) w.runtime->submit(c);
    rs::FixedStepClock clock(rate_hz);
    std::uint64_t rng = 0x12345678u;
    std::uint64_t done = 0;
    for (int i = 0; done < n_ticks; ++i) {
        const int n = clock.advance_ns(frame_ns(pattern, i, rng));
        for (int k = 0; k < n && done < n_ticks; ++k, ++done) w.step();
        // the renderer would blend the last two states with clock.alpha() here: it never feeds back into the physics
    }
    if (dropped) *dropped = clock.dropped_steps();
    return {w.body.state, w.vehicle->engine_rpm(), w.runtime->spin(), done};
}

Final run_reference(const rs::CarConfig& cfg, int rate_hz, std::uint64_t n_ticks, double* speed = nullptr) {
    CarWorld w(cfg, rate_hz);
    for (const auto& c : script(rate_hz)) w.runtime->submit(c);
    for (std::uint64_t i = 0; i < n_ticks; ++i) w.step();
    if (speed) *speed = rs::length(w.body.state.velocity);
    return {w.body.state, w.vehicle->engine_rpm(), w.runtime->spin(), n_ticks};
}

}  // namespace

RS_TEST(spsc_ring) {
    // single-thread semantics
    rs::SpscRing<int, 8> r;
    bool ok = true;
    for (int i = 0; i < 8; ++i) ok = ok && r.try_push(i);
    test::check("all 8 slots usable", ok);
    test::check("push into a full ring fails", !r.try_push(99));
    int v = -1;
    ok = true;
    for (int i = 0; i < 8; ++i) ok = ok && r.try_pop(v) && v == i;
    test::check("pops come out in push order", ok);
    test::check("pop from an empty ring fails", !r.try_pop(v));
    for (int round = 0; round < 50; ++round) {   // wrap the indices many times
        r.try_push(round);
        r.try_push(round + 1000);
        int a = 0, b = 0;
        ok = ok && r.try_pop(a) && r.try_pop(b) && a == round && b == round + 1000;
    }
    test::check("order kept across wrap-around", ok);

    // two threads, small ring (64): it is full / empty constantly, every index wraps ~30000 times
    constexpr std::uint64_t kN = 2000000;
    rs::SpscRing<Item, 64> ring;
    std::atomic<bool> go{false};
    std::uint64_t full_spins = 0;
    std::thread producer([&] {
        while (!go.load()) {}
        for (std::uint64_t s = 0; s < kN; ++s) {
            const Item it = make_item(s);
            while (!ring.try_push(it)) { ++full_spins; cpu_relax(); }
        }
    });
    std::uint64_t expected = 0, out_of_order = 0, torn = 0;
    const auto t0 = std::chrono::steady_clock::now();
    go.store(true);
    while (expected < kN) {
        Item it;
        if (!ring.try_pop(it)) { cpu_relax(); continue; }
        if (it.seq != expected) ++out_of_order;
        if (!consistent(it)) ++torn;
        expected = it.seq + 1;
    }
    producer.join();
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    std::printf("  %llu items through a 64-slot ring in %.1f ms (%.1f M/s), producer found it full %llu times\n",
                static_cast<unsigned long long>(kN), ms, kN / ms / 1000.0, static_cast<unsigned long long>(full_spins));
    test::check("2 threads: every item arrived, in order (no loss, no duplicates)", out_of_order == 0 && expected == kN);
    test::check("2 threads: no torn item (all fields consistent)", torn == 0);
    test::check("ring empty at the end", ring.empty_approx());

    // zero-copy API (prepare / commit, front / pop) under the same stress
    constexpr std::uint64_t kM = 1000000;
    rs::SpscRing<Item, 16> ring2;
    std::thread producer2([&] {
        for (std::uint64_t s = 0; s < kM; ++s) {
            Item* slot;
            while (!(slot = ring2.prepare())) cpu_relax();
            *slot = make_item(s);
            ring2.commit();
        }
    });
    std::uint64_t next = 0, bad = 0;
    while (next < kM) {
        const Item* it = ring2.front();
        if (!it) { cpu_relax(); continue; }
        if (it->seq != next || !consistent(*it)) ++bad;
        next = it->seq + 1;
        ring2.pop();
    }
    producer2.join();
    test::check("zero-copy prepare/commit + front/pop: in order, untorn", bad == 0 && next == kM);
}

RS_TEST(triple_buffer) {
    rs::TripleBuffer<Item> tb;
    Item seen;
    test::check("nothing to fetch before the first publish", !tb.fetch());
    tb.write_buffer() = make_item(7);
    tb.publish();
    test::check("fetch after publish gets it", tb.fetch() && tb.read_buffer().seq == 7);
    test::check("no second fetch of the same value", !tb.fetch());

    constexpr std::uint64_t kN = 1000000;
    rs::TripleBuffer<Item> tb2;
    std::atomic<bool> done{false};
    std::thread writer([&] {
        for (std::uint64_t s = 1; s <= kN; ++s) {
            tb2.write_buffer() = make_item(s);
            tb2.publish();
        }
        done.store(true);
    });
    std::uint64_t last = 0, back_in_time = 0, torn = 0, fetches = 0;
    while (last < kN) {
        if (!tb2.fetch()) { cpu_relax(); continue; }
        ++fetches;
        const Item& it = tb2.read_buffer();
        if (!consistent(it)) ++torn;
        if (it.seq <= last) ++back_in_time;
        last = it.seq;
    }
    writer.join();
    std::printf("  writer published %llu values, reader fetched %llu of them (it may skip: latest value wins)\n",
                static_cast<unsigned long long>(kN), static_cast<unsigned long long>(fetches));
    test::check("2 threads: no torn value", torn == 0);
    test::check("2 threads: values only move forward, the last one arrives", back_in_time == 0 && last == kN);
}

RS_TEST(fixed_step) {
    // Exact step counts: 7 s of frames at several frame rates give floor(7 x rate) steps, whatever the split.
    for (int rate : {1000, 360, 240}) {
        bool exact = true;
        for (int pattern = 0; pattern < 4; ++pattern) {
            rs::FixedStepClock c(rate, 1000000);   // no clamp here
            std::uint64_t rng = 99;
            std::int64_t total = 0;
            for (int i = 0; total < 7000000000ll; ++i) {
                const std::int64_t f = frame_ns(pattern, i, rng);
                total += f;
                c.advance_ns(f);
                if (c.alpha() < 0.0 || c.alpha() >= 1.0) exact = false;
            }
            const std::uint64_t want = (static_cast<std::uint64_t>(total) * static_cast<std::uint64_t>(rate)) / 1000000000ull;
            if (c.ticks() != want) exact = false;
        }
        char what[96];
        std::snprintf(what, sizeof what, "%d Hz: steps = floor(time x rate) exactly at 30/60/144/jittered fps", rate);
        test::check(what, exact);
    }
    // 1/360 s is not a whole number of ns: a double accumulator would drift, this one is exact
    rs::FixedStepClock c360(360);
    int steps = 0;
    for (int i = 0; i < 360; ++i) steps += c360.advance_ns(2777778);   // 1/360 s rounded up to the next ns
    test::check("360 Hz: 360 frames of 2777778 ns give 360 steps", steps == 360);

    // alpha = fraction of the next step elapsed
    rs::FixedStepClock c(1000);
    const int n = c.advance_ns(2500000);
    test::check_range("2.5 ms at 1000 Hz: steps", n, 2, 2, "");
    test::check_range("2.5 ms at 1000 Hz: alpha", c.alpha(), 0.5, 0.5, "");

    // spiral of death: a 2 s stall runs at most 100 steps (0.1 s) and drops the rest
    rs::FixedStepClock s(1000);
    const int burst = s.advance_ns(2000000000ll);
    test::check_range("2 s stall at 1000 Hz: steps run", burst, 100, 100, "");
    test::check_range("2 s stall at 1000 Hz: steps dropped", static_cast<double>(s.dropped_steps()), 1900, 1900, "");
    test::check("default clamp is 0.1 s at 360 Hz (36) and 240 Hz (24)",
                rs::FixedStepClock(360).max_steps_per_advance() == 36 && rs::FixedStepClock(240).max_steps_per_advance() == 24);

    // interpolation helpers
    rs::BodySnapshot a, b;
    a.tick = 10; b.tick = 11;
    a.position = {0, 0, 0}; b.position = {2, 0, 0};
    a.orientation = rs::Quat::from_axis_angle({0, 0, 1}, 0.0);
    b.orientation = rs::Quat::from_axis_angle({0, 0, 1}, 0.2);
    const rs::BodySnapshot m = rs::blend(a, b, 0.25);
    const rs::Vec3 fwd = m.orientation.rotate({1, 0, 0});
    test::check_range("blend position at alpha 0.25", m.position.x, 0.5, 0.5, "m");
    test::check_range("blend yaw at alpha 0.25", std::atan2(fwd.y, fwd.x), 0.0499, 0.0501, "rad");
    rs::Quat neg = b.orientation;
    neg = {-neg.w, -neg.x, -neg.y, -neg.z};   // the same rotation, other sign: must not swing the long way round
    const rs::Vec3 f2 = rs::nlerp(a.orientation, neg, 0.5).rotate({1, 0, 0});
    test::check_range("nlerp takes the short arc for -q", std::atan2(f2.y, f2.x), 0.099, 0.101, "rad");
    test::check_range("wheel spin blends across 2 pi (6.2 -> 0.1)", rs::lerp_angle(6.2, 0.1, 0.5), 6.2 + 0.0916 - 0.001, 6.2 + 0.0916 + 0.001, "rad");

    rs::SnapshotHistory<rs::BodySnapshot, 4> h;
    for (std::uint64_t t = 0; t < 6; ++t) {
        rs::BodySnapshot snap;
        snap.tick = t;
        snap.position = {static_cast<double>(t), 0, 0};
        h.push(snap);
    }
    rs::BodySnapshot out;
    double al = 0;
    h.sample(4.25, out, &al);
    test::check_range("history: sample between ticks 4 and 5", out.position.x, 4.25, 4.25, "m");
    h.sample(9.0, out);
    test::check_range("history: never extrapolates past the newest", out.position.x, 5, 5, "m");
    h.sample(0.0, out);
    test::check_range("history: clamps to the oldest kept (tick 2)", out.position.x, 2, 2, "m");

    // Per-wheel pose interpolation via rs::rt::blend(const StepRecord&, const StepRecord&, double alpha)
    rs::rt::StepRecord ra, rb;
    ra.tick = 20; rb.tick = 21;
    ra.dt = 0.001; rb.dt = 0.001;
    ra.chassis.position = {10.0, 0.0, 0.47};
    rb.chassis.position = {10.04, 0.0, 0.47};
    for (int w = 0; w < 4; ++w) {
        ra.out.wheels[w].contact = true;
        rb.out.wheels[w].contact = true;
        ra.out.wheels[w].centre_world = {10.0 + (w < 2 ? 1.3 : -1.3), (w % 2 == 0 ? 0.8 : -0.8), 0.33};
        rb.out.wheels[w].centre_world = {10.04 + (w < 2 ? 1.3 : -1.3), (w % 2 == 0 ? 0.8 : -0.8), 0.35};
        ra.out.wheels[w].steer_angle = 0.10;
        rb.out.wheels[w].steer_angle = 0.18;
        ra.out.wheels[w].camber = -0.020;
        rb.out.wheels[w].camber = -0.028;
        ra.out.wheels[w].toe_angle = 0.002;
        rb.out.wheels[w].toe_angle = 0.006;
        ra.out.wheels[w].compression = 0.030;
        rb.out.wheels[w].compression = 0.050;
        ra.out.wheels[w].angular_velocity = 80.0;
        rb.out.wheels[w].angular_velocity = 84.0;
        ra.out.wheels[w].load = 3600.0;
        rb.out.wheels[w].load = 4000.0;
        ra.out.wheels[w].slip_ratio = 0.04;
        rb.out.wheels[w].slip_ratio = 0.08;
        ra.out.wheels[w].slip_angle = -0.02;
        rb.out.wheels[w].slip_angle = -0.06;
        ra.spin[w] = 6.20;
        rb.spin[w] = 0.10; // wraps across 2*pi (delta = +0.1831853 rad)
    }
    bool wheel_blend_ok = true;
    const double spin_delta = (0.10 + 2.0 * rs::kPi) - 6.20;
    for (double alpha : {0.25, 0.50, 0.75}) {
        const rs::rt::StepRecord rm = rs::rt::blend(ra, rb, alpha);
        const rs::WheelOutput& w0 = rm.out.wheels[0];
        const double exp_x = 11.30 + 0.04 * alpha;
        const double exp_z = 0.33 + 0.02 * alpha;
        const double exp_steer = 0.10 + 0.08 * alpha;
        const double exp_cam = -0.020 - 0.008 * alpha;
        const double exp_toe = 0.002 + 0.004 * alpha;
        const double exp_comp = 0.030 + 0.020 * alpha;
        const double exp_spin = 6.20 + spin_delta * alpha;
        if (std::abs(w0.centre_world.x - exp_x) > 1e-9 || std::abs(w0.centre_world.z - exp_z) > 1e-9 ||
            std::abs(w0.steer_angle - exp_steer) > 1e-9 || std::abs(w0.camber - exp_cam) > 1e-9 ||
            std::abs(w0.toe_angle - exp_toe) > 1e-9 || std::abs(w0.compression - exp_comp) > 1e-9 ||
            std::abs(rm.spin[0] - exp_spin) > 1e-9) {
            wheel_blend_ok = false;
        }
    }
    test::check("rs::rt::blend interpolates wheel centre_world, steer, camber, toe & spin at alpha=0.25,0.5,0.75",
                wheel_blend_ok);
}

RS_TEST(runtime_determinism) {
    const rs::CarConfig cfg = test::car();
    const char* names[] = {"30 fps", "60 fps", "144 fps", "jittered 4-45 ms", "90 fps + 250 ms stalls"};
    for (int rate : {1000, 360}) {
        const std::uint64_t n = static_cast<std::uint64_t>(3.2 * rate);
        double v_end = 0;
        const Final ref = run_reference(cfg, rate, n, &v_end);
        std::printf("  %d Hz reference after %llu ticks: x %.4f m, speed %.3f m/s, rpm %.0f\n", rate,
                    static_cast<unsigned long long>(n), ref.s.position.x, v_end, ref.rpm);
        test::check("the scripted drive really drives (moved > 15 m)", ref.s.position.x > 15.0 && std::isfinite(ref.s.position.y));
        for (int p = 0; p < 5; ++p) {
            std::uint64_t dropped = 0;
            const Final r = run_render_pattern(cfg, rate, n, p, &dropped);
            char what[128];
            std::snprintf(what, sizeof what, "%d Hz at %s: bit-identical state at tick %llu%s", rate, names[p],
                          static_cast<unsigned long long>(n), dropped ? " (clamp dropped wall time)" : "");
            test::check(what, same_bits(r, ref));
        }
    }
    // The same drive at 240, 360 and 1000 Hz: different step sizes, so not bit-identical, but the core sub-steps its
    // stiff parts at >= 1 kHz anyway, so the car must do the same thing to within a few per cent.
    double v240 = 0, v360 = 0, v1000 = 0;
    const Final a = run_reference(cfg, 240, static_cast<std::uint64_t>(3.2 * 240), &v240);
    const Final b = run_reference(cfg, 360, static_cast<std::uint64_t>(3.2 * 360), &v360);
    const Final c = run_reference(cfg, 1000, static_cast<std::uint64_t>(3.2 * 1000), &v1000);
    std::printf("  speed after 3.2 s: 240 Hz %.3f, 360 Hz %.3f, 1000 Hz %.3f m/s; x %.3f / %.3f / %.3f m\n", v240, v360, v1000,
                a.s.position.x, b.s.position.x, c.s.position.x);
    test::check_range("360 vs 1000 Hz: speed after the drive", v360 / v1000, 0.97, 1.03, "ratio");
    test::check_range("240 vs 1000 Hz: speed after the drive", v240 / v1000, 0.97, 1.03, "ratio");

    // A fully engaged clutch must stay locked while the car drives: the clutch solve and the driveline must agree on
    // the inertia behind the clutch, or every locked-step correction overshoots and the clutch chatters lock / slip
    // each step. That chatter amplified rounding into whole-percent changes of this drive between compilers.
    {
        CarWorld w(cfg, 1000);
        for (const auto& cmd : script(1000)) w.runtime->submit(cmd);
        int flips = 0;
        bool prev = false;
        for (int i = 1; i <= 3200; ++i) {
            w.step();
            const bool locked = w.vehicle->engine_systems().clutch_locked;
            if (i > 1600 && locked != prev) ++flips;
            prev = locked;
        }
        std::printf("  clutch lock / slip changes from 1.6 to 3.2 s (clutch engaged, a shift at 1.9 s): %d\n", flips);
        test::check_range("an engaged clutch does not chatter between lock and slip", flips, 0, 12, "changes");
    }
}

RS_TEST(runtime_threaded) {
    // The physics runs on a real 1000 Hz thread (FixedRateThread), a render thread drains StepRecords from the ring,
    // keeps a snapshot history and interpolates at its own rate. Commands are scripted by tick, so the state at tick N
    // must equal the single-threaded run bit for bit, whatever the thread timing.
    const rs::CarConfig cfg = test::car();
    constexpr int kRate = 1000;
    constexpr std::uint64_t kN = 400;   // compare at tick 400 (0.4 s of real time per run)
    double v = 0;
    const Final ref = run_reference(cfg, kRate, kN, &v);

    for (int render_hz : {60, 144}) {
        CarWorld w(cfg, kRate);
        for (const auto& c : script(kRate)) w.runtime->submit(c);
        rs::rt::FixedRateThread phys(kRate, [&](std::uint64_t, double) { w.step(); });
        std::uint64_t expect_tick = 0, gaps = 0, frames = 0, bad_alpha = 0;
        bool have_n = false;
        Final at_n;
        rs::SnapshotHistory<rs::BodySnapshot, 64> hist;
        phys.start();
        const auto t_end = std::chrono::steady_clock::now() + std::chrono::milliseconds(600);
        while (std::chrono::steady_clock::now() < t_end && !have_n) {
            std::this_thread::sleep_for(std::chrono::microseconds(1000000 / render_hz));
            ++frames;
            w.runtime->drain([&](const rs::rt::StepRecord& r) {
                if (r.tick != expect_tick) ++gaps;
                expect_tick = r.tick + 1;
                rs::BodySnapshot s;
                s.tick = r.tick;   // r.chassis = state at the START of tick r.tick
                s.position = r.chassis.position;
                s.orientation = r.chassis.orientation;
                s.velocity = r.chassis.velocity;
                s.angular_velocity = r.chassis.angular_velocity;
                hist.push(s);
                if (r.tick == kN - 1) {
                    at_n.rpm = r.out.engine_rpm;
                    at_n.spin = r.spin;
                }
                if (r.tick == kN) {   // state after kN steps
                    at_n.s = r.chassis;
                    at_n.ticks = kN;
                    have_n = true;
                }
            });
            rs::BodySnapshot pose;
            double alpha = 0;
            if (hist.sample(phys.tick_time_now() - 1.0, pose, &alpha) && (alpha < 0.0 || alpha > 1.0)) ++bad_alpha;
        }
        phys.stop();
        char what[128];
        std::snprintf(what, sizeof what, "render %d Hz: %llu frames, snapshots in order with no gaps", render_hz,
                      static_cast<unsigned long long>(frames));
        test::check(what, have_n && gaps == 0);
        std::snprintf(what, sizeof what, "render %d Hz: interpolation alpha always within [0, 1]", render_hz);
        test::check(what, bad_alpha == 0);
        std::snprintf(what, sizeof what, "render %d Hz: chassis, rpm & wheel spin at tick %llu bit-identical to 1-thread run", render_hz,
                      static_cast<unsigned long long>(kN));
        test::check(what, have_n && same_bits(at_n, ref));
        std::printf("  physics thread: %llu ticks, %.2f us per step, worst batch %d, records dropped %llu, late commands %llu\n",
                    static_cast<unsigned long long>(phys.ticks()),
                    phys.ticks() ? phys.busy_ns() / 1000.0 / phys.ticks() : 0.0, phys.max_batch(),
                    static_cast<unsigned long long>(w.runtime->stats.records_dropped.load()),
                    static_cast<unsigned long long>(w.runtime->stats.commands_late.load()));
    }
}

RS_TEST(ue5_async_bridge) {
    // Lock-free UE5 async bridge: 60 Hz game thread traces ground planes + strips and submits commands/impacts/repair,
    // while a 1000 Hz physics thread steps rs::ue5::AsyncVehicleBridge and integrates the rigid body.
    const rs::CarConfig cfg = test::car();
    auto vehicle = std::make_unique<rs::Vehicle>(cfg);
    vehicle->unsprung_dynamics_enabled = true;
    vehicle->tire_zones_enabled = true;
    auto controls = std::make_unique<rs::Controls>(vehicle->config());
    controls->settings.auto_gearbox = true;
    controls->settings.auto_clutch = true;
    rs::ue5::AsyncVehicleBridge bridge(*vehicle, *controls);

    rs::RigidBody body;
    body.mass = cfg.mass;
    body.inertia = {cfg.inertia_xx, cfg.inertia_yy, cfg.inertia_zz};
    body.state.position = {0, 0, cfg.cg_height};
    vehicle->reset_motion(0, 2);
    controls->set_gear(2);
    bridge.seed_rays(body.state, 3);

    // Seed initial flat ground before starting the physics thread.
    auto publish_flat_ground = [&](bool use_strip) {
        bridge.fetch_rays();
        const rs::ue5::RayFrame& rf = bridge.current_rays();
        rs::ue5::GroundFrame& gf = bridge.ground_write_buffer();
        gf.rays_per_wheel = 3;
        gf.use_strip = use_strip;
        gf.has_strips = use_strip;
        if (rf.valid) {
            for (int w = 0; w < 4; ++w) {
                for (int j = 0; j < 3; ++j) {
                    rs::ue5::GroundSample& g = gf.planes[w][j];
                    g.hit = true;
                    g.point = {rf.rays[w][j].origin.x, rf.rays[w][j].origin.y, 0.0};
                    g.normal = {0, 0, 1};
                    g.surface = 0;
                }
                if (use_strip) {
                    rs::ue5::GroundStrip& s = gf.strips[w];
                    s.origin = {rf.rays[w][0].origin.x - 0.5, rf.rays[w][0].origin.y, 0.0};
                    s.along = {1, 0, 0};
                    s.across = {0, 1, 0};
                    s.spacing = 0.2;
                    s.lane_spacing = 0.15;
                    s.resize(3, 16);
                    for (int l = 0; l < 3; ++l) {
                        for (int i = 0; i < 16; ++i) {
                            const rs::Vec3 p = s.position(l, i);
                            s.at(l, i) = {true, {p.x, p.y, 0.0}, {0, 0, 1}, 0};
                        }
                    }
                }
            }
        }
        bridge.publish_ground();
    };
    publish_flat_ground(true);

    constexpr int kRate = 1000;
    rs::rt::FixedRateThread phys(kRate, [&](std::uint64_t, double dt) {
        const rs::VehicleOutput& out = bridge.step(body.state, dt);
        body.mass = out.mass_kg;
        body.integrate(out.force + rs::Vec3{0, 0, -rs::kGravity * body.mass}, out.torque, dt);
    });

    phys.start();
    std::uint64_t expect_tick = 0, gaps = 0, got = 0;
    rs::rt::StepRecord latest;
    const auto t_end = std::chrono::steady_clock::now() + std::chrono::milliseconds(450);
    int frame = 0;
    while (std::chrono::steady_clock::now() < t_end) {
        std::this_thread::sleep_for(std::chrono::milliseconds(16));
        rs::rt::VehicleCommand cmd;
        cmd.apply_tick = 0;
        cmd.raw.throttle = frame >= 3 ? 0.9 : 0.0;
        cmd.raw.brake = frame < 3 ? 0.2 : 0.0;
        cmd.raw.device = rs::InputDevice::Gamepad;
        cmd.has_settings = true;
        cmd.settings.turbo_stage = 1;
        bridge.submit_command(cmd);
        if (frame == 10) {
            rs::rt::ImpactCommand imp;
            imp.point_world = {latest.chassis.position.x + 1.5, latest.chassis.position.y, 0.5};
            imp.impulse = 2500.0;
            imp.other = 42;
            bridge.submit_impact(imp);
        }
        publish_flat_ground(true);
        bridge.drain_records([&](const rs::rt::StepRecord& r) {
            if (r.tick != expect_tick) ++gaps;
            expect_tick = r.tick + 1;
            latest = r;
            ++got;
        });
        ++frame;
    }
    phys.stop();

    test::check("ue5 async bridge ran > 250 ticks with zero record gaps", got > 250 && gaps == 0);
    test::check("ue5 async bridge accelerated forward on flat ground", latest.chassis.position.x > 0.12 && latest.out.speed > 0.8);
    test::check("ue5 async bridge wheels grounded and telemetry finite",
                latest.out.wheels[0].contact && std::isfinite(latest.out.engine_rpm) && latest.out.engine_rpm > 500.0);
    test::check("ue5 async bridge processed commands and zero dropped records",
                bridge.stats().commands_applied.load() > 0 && bridge.stats().records_dropped.load() == 0);
    const rs::rt::StepRecord interp_mid = bridge.interpolate_record(0.5);
    test::check("ue5 async bridge interpolate_record(0.5) produces valid interpolated wheel poses",
                interp_mid.out.wheels[0].contact && std::isfinite(interp_mid.out.wheels[0].centre_world.x) &&
                std::isfinite(interp_mid.spin[0]));
    std::printf("  ue5 async bridge: %llu records drained, speed %.2f m/s, x %.2f m, rpm %.0f\n",
                static_cast<unsigned long long>(got), latest.out.speed, latest.chassis.position.x, latest.out.engine_rpm);
}
