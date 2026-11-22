// Instrument cluster needles (rs/cluster.hpp) and the rev limiter bounce they show.
#include <cmath>
#include <cstdio>
#include "harness.hpp"
#include "rs/cluster.hpp"

using namespace rs;

RS_TEST(cluster) {
    // Step 0 -> full scale: stepper top speed and no overshoot.
    {
        GaugeNeedle n;
        n.reset(0);
        double t = 0, max_rate = 0, prev = n.angle_deg(), peak = 0;
        while (t < 2.0) {
            n.step(8000, 1.0 / 1000);
            t += 1.0 / 1000;
            max_rate = std::max(max_rate, std::abs(n.angle_deg() - prev) * 1000);
            prev = n.angle_deg();
            peak = std::max(peak, n.angle_deg());
            if (n.angle_deg() >= 270 - 1e-9) break;
        }
        std::printf("         0 -> full scale (270 deg): %.3f s, max %.0f deg/s, peak %.2f deg\n", t, max_rate, peak);
        test::check("stepper top speed respected (<= 600 deg/s)", max_rate <= 600.0 + 1e-6);
        test::check_range("full-scale move takes the stepper's time (270 / 600 s + ramps + one CAN frame)", t, 0.45, 0.56, "s");
        test::check("no overshoot", peak <= 270.0 + 1e-9);
        for (int i = 0; i < 500; ++i) n.step(8000, 1.0 / 1000);
        test::check("holds a steady signal exactly", std::abs(n.value() - 8000) < 1e-9);
    }
    // The rev limiter: free revving in neutral bounces the engine at ~20 Hz; the needle twitches with it.
    {
        const CarConfig cfg = test::car();
        auto s = test::make_sim(cfg);
        InstrumentCluster cl;
        cl.configure(cfg.engine.redline_rpm);
        double rmin = 1e9, rmax = 0, nmin = 1e9, nmax = 0;
        int cuts = 0;
        bool prev = false;
        while (s->time < 6) {
            DriverInput in; in.gear = 1; in.throttle = 1;
            s->step(in);
            const double rpm = s->vehicle.engine_rpm();
            cl.step(rpm, 0, s->dt);
            if (s->time > 3) {
                rmin = std::min(rmin, rpm); rmax = std::max(rmax, rpm);
                nmin = std::min(nmin, cl.tach.value()); nmax = std::max(nmax, cl.tach.value());
                const bool cut = s->vehicle.engine_systems().limiter_cut;
                if (cut && !prev) ++cuts;
                prev = cut;
            }
        }
        const double deg = 270.0 / cl.tach_max_rpm();
        std::printf("         free rev on the limiter: engine %.0f..%.0f rpm, %.1f cuts/s; tach needle %.0f..%.0f rpm (%.1f deg twitch of %.1f)\n",
                    rmin, rmax, cuts / 3.0, nmin, nmax, (nmax - nmin) * deg, (rmax - rmin) * deg);
        test::check_range("limiter bounce band (hysteresis 100 rpm + overshoot)", rmax - rmin, 60, 300, "rpm");
        test::check_range("limiter cut rate, free revving", cuts / 3.0, 8, 40, "Hz");
        test::check("the needle twitches visibly (> 1 deg)", (nmax - nmin) * deg > 1.0);
        test::check("but less than the engine's own bounce (stepper + CAN)", nmax - nmin <= rmax - rmin + 1e-6);
    }
    // Key-on sweep: full scale and back to zero.
    {
        InstrumentCluster cl;
        cl.configure(7500);
        cl.ignition_sweep();
        double t = 0, peak = 0;
        while (t < 3) { cl.step(900, 0, 1.0 / 240); t += 1.0 / 240; peak = std::max(peak, cl.tach.fraction()); if (t > 0.7 && std::abs(cl.tach.value() - 900) < 1.0) break; }
        std::printf("         key-on sweep: tach reached %.0f %% of the dial, back to idle after %.2f s\n", peak * 100, t);
        test::check("sweep reaches full scale", peak > 0.999);
        test::check_range("sweep and back to the idle reading", t, 1.0, 2.0, "s");
    }
}
