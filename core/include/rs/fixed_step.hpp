// Fixed-timestep clock and render interpolation (header-only, C++17, no engine dependencies).
//
// The physics always advances in steps of exactly 1 / rate seconds (1000, 360 or 240 Hz), whatever the frame rate.
// The renderer runs at its own rate and shows the state BETWEEN the last two physics states (alpha = how far real
// time has moved past the last step), so motion is smooth at 30, 60 or 144 fps and the simulation result never
// depends on the frame rate.
//
//   FixedStepClock clock(1000);
//   every frame:  int n = clock.advance_ns(frame_ns);        // how many physics steps are due
//                 for (i < n) physics_step(clock.dt());
//                 render(blend(prev_state, state, clock.alpha()));
//
// Exact time: the accumulator counts nanoseconds x rate in 64-bit integers, so 1/360 s (not a whole number of ns)
// costs nothing in rounding and the number of steps after T seconds of frames is exactly floor(T x rate) however the
// frames split T (a double accumulator drifts by one step now and then). That, plus inputs addressed by tick number,
// makes a run repeatable at any render rate (tests/test_runtime.cpp checks it bit for bit).
//
// Spiral of death: when a frame took so long that more than max_steps_per_advance steps are due (a stall, a slow
// device), the clock runs max_steps and DROPS the rest of the backlog (the game slows down for that frame instead of
// trying to catch up, which would make the next frame even longer). dropped_steps() counts it.
#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include "rs/math.hpp"

namespace rs {

class FixedStepClock {
public:
    static constexpr std::int64_t kNsPerSecond = 1000000000;

    explicit FixedStepClock(int rate_hz = 1000, int max_steps_per_advance = 0) { set_rate(rate_hz, max_steps_per_advance); }

    /**
     * Change the step rate (keeps the tick count, clears the fraction of a step in progress). max_steps <= 0 picks a
     * default of 100 ms worth of steps (100 at 1000 Hz, 36 at 360 Hz, 24 at 240 Hz: the same 0.1 s cap main.ts uses).
     */
    void set_rate(int rate_hz, int max_steps_per_advance = 0) {
        rate_ = rate_hz > 0 ? rate_hz : 1000;
        max_steps_ = max_steps_per_advance > 0 ? max_steps_per_advance : (rate_ + 9) / 10;
        acc_ = 0;
    }
    int rate_hz() const { return rate_; }
    int max_steps_per_advance() const { return max_steps_; }
    double dt() const { return 1.0 / rate_; }

    /** Add elapsed wall time (ns, >= 0) and return how many steps to run now (0 .. max_steps_per_advance). */
    int advance_ns(std::int64_t elapsed_ns) {
        if (elapsed_ns > 0) acc_ += elapsed_ns * rate_;   // units: ns x Hz; one step = kNsPerSecond units
        std::int64_t due = acc_ / kNsPerSecond;
        acc_ -= due * kNsPerSecond;
        if (due > max_steps_) {
            dropped_ += static_cast<std::uint64_t>(due - max_steps_);
            due = max_steps_;
        }
        ticks_ += static_cast<std::uint64_t>(due);
        return static_cast<int>(due);
    }
    /** Seconds version (rounded to the nearest ns): for engines that hand out float frame times. */
    int advance(double elapsed_s) {
        return advance_ns(elapsed_s > 0 ? static_cast<std::int64_t>(std::llround(elapsed_s * 1e9)) : 0);
    }

    /** Fraction of the next step already elapsed, in [0, 1): the render blend between the last two states. */
    double alpha() const { return static_cast<double>(acc_) / static_cast<double>(kNsPerSecond); }
    /** Steps issued so far (the tick number of the next step to run is ticks() - steps still to run this frame). */
    std::uint64_t ticks() const { return ticks_; }
    /** Simulated time of ticks() steps, s. */
    double sim_time() const { return static_cast<double>(ticks_) / rate_; }
    /** Steps thrown away by the spiral-of-death clamp. */
    std::uint64_t dropped_steps() const { return dropped_; }
    void reset() { acc_ = 0; ticks_ = 0; dropped_ = 0; }

    /** Run the due steps: step(tick, dt) for each tick number in order. Returns how many ran. */
    template <typename StepFn>
    int run(std::int64_t elapsed_ns, StepFn&& step) {
        const int n = advance_ns(elapsed_ns);
        const std::uint64_t first = ticks_ - static_cast<std::uint64_t>(n);
        const double h = dt();
        for (int i = 0; i < n; ++i) step(first + static_cast<std::uint64_t>(i), h);
        return n;
    }

private:
    int rate_ = 1000;
    int max_steps_ = 100;
    std::int64_t acc_ = 0;        // ns x rate, always < kNsPerSecond after advance
    std::uint64_t ticks_ = 0;
    std::uint64_t dropped_ = 0;
};

// ---- interpolation helpers ---------------------------------------------------------------------------------------

inline Vec3 lerp(const Vec3& a, const Vec3& b, double t) { return a + (b - a) * t; }

/** Shortest-arc normalized lerp: what a renderer needs between two physics steps (1-4 ms apart, tiny angles). */
inline Quat nlerp(const Quat& a, const Quat& b, double t) {
    const double d = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
    const double s = d < 0 ? -1.0 : 1.0;   // q and -q are the same rotation: take the short way round
    Quat q{a.w + (s * b.w - a.w) * t, a.x + (s * b.x - a.x) * t, a.y + (s * b.y - a.y) * t, a.z + (s * b.z - a.z) * t};
    return q.normalized();
}

/** Shortest-arc spherical lerp (constant angular speed); falls back to nlerp for nearly equal rotations. */
inline Quat slerp(const Quat& a, const Quat& b0, double t) {
    double d = a.w * b0.w + a.x * b0.x + a.y * b0.y + a.z * b0.z;
    Quat b = b0;
    if (d < 0) { d = -d; b = {-b0.w, -b0.x, -b0.y, -b0.z}; }
    if (d > 0.9995) return nlerp(a, b, t);
    const double th = std::acos(d), s = std::sin(th);
    const double wa = std::sin((1 - t) * th) / s, wb = std::sin(t * th) / s;
    return Quat{wa * a.w + wb * b.w, wa * a.x + wb * b.x, wa * a.y + wb * b.y, wa * a.z + wb * b.z}.normalized();
}

/** Angle blend the short way round (wheel spin is kept mod 2 pi, so 6.2 -> 0.1 must not spin backwards). */
inline double lerp_angle(double a, double b, double t) {
    double d = std::fmod(b - a, 2 * kPi);
    if (d > kPi) d -= 2 * kPi;
    if (d < -kPi) d += 2 * kPi;
    return a + d * t;
}

/** Rigid-body state at one physics tick: what the renderer interpolates. */
struct BodySnapshot {
    std::uint64_t tick = 0;
    Vec3 position;
    Quat orientation;
    Vec3 velocity;
    Vec3 angular_velocity;
};

inline BodySnapshot blend(const BodySnapshot& a, const BodySnapshot& b, double t) {
    BodySnapshot r;
    r.tick = t < 0.5 ? a.tick : b.tick;
    r.position = lerp(a.position, b.position, t);
    r.orientation = nlerp(a.orientation, b.orientation, t);
    r.velocity = lerp(a.velocity, b.velocity, t);
    r.angular_velocity = lerp(a.angular_velocity, b.angular_velocity, t);
    return r;
}

/**
 * Render-side history of the last N snapshots of one object, sampled at a fractional tick time. With the physics on
 * its own thread the renderer does not share the physics clock's alpha; it samples at
 *     render_tick = (now - epoch) x rate - delay_ticks
 * (one tick of delay: the newest snapshot is usually only part of a tick old), and gets the blend of the two
 * snapshots around that time. Needs blend(const T&, const T&, double) and a `tick` field on T.
 */
template <typename T, std::size_t N = 8>
class SnapshotHistory {
    static_assert(N >= 2, "need two snapshots to interpolate");

public:
    void push(const T& s) {
        if (count_ > 0 && s.tick <= items_[(start_ + count_ - 1) % N].tick) return;   // stale or duplicate: ignore
        if (count_ < N) {
            items_[(start_ + count_) % N] = s;
            ++count_;
        } else {
            items_[start_] = s;
            start_ = (start_ + 1) % N;
        }
    }
    std::size_t size() const { return count_; }
    const T& newest() const { return items_[(start_ + count_ - 1) % N]; }
    const T& oldest() const { return items_[start_]; }
    void clear() { count_ = 0; start_ = 0; }

    /**
     * State at fractional tick time `tick_time`. Clamps to the oldest / newest snapshot outside the history (never
     * extrapolates: a physics hitch freezes the picture for a moment instead of overshooting). False when empty.
     * `alpha_out` (optional) gets the blend factor used.
     */
    bool sample(double tick_time, T& out, double* alpha_out = nullptr) const {
        if (count_ == 0) return false;
        const T& first = oldest();
        const T& last = newest();
        if (count_ == 1 || tick_time <= static_cast<double>(first.tick)) {
            out = count_ == 1 ? last : first;
            if (alpha_out) *alpha_out = 0.0;
            return true;
        }
        if (tick_time >= static_cast<double>(last.tick)) {
            out = last;
            if (alpha_out) *alpha_out = 1.0;
            return true;
        }
        for (std::size_t i = 1; i < count_; ++i) {
            const T& a = items_[(start_ + i - 1) % N];
            const T& b = items_[(start_ + i) % N];
            if (tick_time <= static_cast<double>(b.tick)) {
                const double span = static_cast<double>(b.tick - a.tick);
                const double t = span > 0 ? (tick_time - static_cast<double>(a.tick)) / span : 1.0;
                out = blend(a, b, t);
                if (alpha_out) *alpha_out = t;
                return true;
            }
        }
        out = last;
        return true;
    }

private:
    std::array<T, N> items_{};
    std::size_t start_ = 0, count_ = 0;
};

}  // namespace rs
