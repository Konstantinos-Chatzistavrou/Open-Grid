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

RS_TEST(cluster_gauges) {
    // Speedometer over-read inside UN R39: 0 <= indicated - true <= true / 10 + 4 km/h, at every speed.
    {
        InstrumentCluster cl;
        cl.configure(7500);
        bool ok = true;
        for (double v = 0; v <= 330; v += 5) {
            ClusterInputs in; in.speed_kmh = v;
            cl.step(in, 1.0 / 240);
            const double d = cl.indicated_speed_kmh() - v;
            if (d < -1e-9 || d > v / 10 + 4 + 1e-9) ok = false;
        }
        ClusterInputs in; in.speed_kmh = 100; cl.step(in, 1.0 / 240);
        std::printf("         speedometer: true 100 km/h reads %.1f km/h\n", cl.indicated_speed_kmh());
        test::check("speedometer never reads low and stays inside UN R39 (0 .. +10 % + 4 km/h)", ok);
    }
    // Water gauge buffered across the normal band; outside it, it moves.
    test::check("water needle mid-scale across 80-105 C", InstrumentCluster::buffered_coolant(82) == 90 && InstrumentCluster::buffered_coolant(104) == 90);
    test::check("water needle moves when cold or overheating", InstrumentCluster::buffered_coolant(40) < 60 && InstrumentCluster::buffered_coolant(120) > 110);
    // Lamps: the bulb check lights them all, then only what applies stays lit.
    {
        InstrumentCluster cl;
        cl.configure(7500);
        cl.ignition_sweep();
        ClusterInputs in; in.rpm = 900; in.handbrake = true;
        cl.step(in, 0.1);
        const unsigned at_key = cl.lamps();
        for (int i = 0; i < 30; ++i) cl.step(in, 0.1);
        std::printf("         lamps at key-on 0x%03x, after 3 s 0x%03x (handbrake on)\n", at_key, cl.lamps());
        test::check("key-on bulb check lights every lamp", at_key == 0x3FFu);
        test::check("after it only the handbrake lamp stays (engine running)", cl.lamps() == LampBrake);
        in.handbrake = false; in.esc_or_tc_active = true;
        int on = 0, off = 0;
        for (int i = 0; i < 240; ++i) { cl.step(in, 1.0 / 240); (cl.lamps() & LampEsc) ? ++on : ++off; }
        test::check("the ESC lamp flashes while it intervenes", on > 60 && off > 60);
        in.esc_or_tc_active = false; in.esc_enabled = false; in.min_tyre_pressure_ratio = 0.6;
        cl.step(in, 0.1);
        test::check("ESC OFF and TPMS lamps", (cl.lamps() & LampEscOff) && (cl.lamps() & LampTpms));
    }
    // Coolant: the thermostat holds ~90 C at idle and on a fast cruise; a holed radiator lets it boil over.
    {
        const CarConfig cfg = test::car();
        auto idle = test::make_sim(cfg);
        for (int i = 0; i < 240 * 120; ++i) { DriverInput in; in.gear = 1; idle->step(in); }
        const double t_idle = idle->vehicle.engine_systems().coolant_temp_c;
        auto cold = test::make_sim(cfg);
        cold->vehicle.engine_systems().coolant_temp_c = 20;
        cold->reset({}, 0, 25, 5);
        test::SpeedController sc;
        while (cold->time < 300) { DriverInput in; in.gear = 5; sc.apply(*cold, 25, in); cold->step(in); }
        const double t_warm = cold->vehicle.engine_systems().coolant_temp_c;
        std::printf("         coolant: idle 2 min %.1f C; from 20 C, 5 min at 90 km/h -> %.1f C\n", t_idle, t_warm);
        test::check_range("thermostat holds idle near 90 C", t_idle, 86, 96, "C");
        test::check("a cold engine warms up while driving", t_warm > 40);
    }
}
