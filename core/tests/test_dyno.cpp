// Chassis dyno (road-load): the same Vehicle on a flat virtual road under straps. Its readings must agree with the
// car's own engine data and with a real road run.
#include <cmath>
#include <cstdio>
#include "harness.hpp"
#include "rs/controls.hpp"
#include "rs/dyno.hpp"

using namespace rs;

namespace {
// Full throttle from rest with the auto gearbox until the speed stops rising (or max_s).
// A longer pull than the original 90 s: the EPA-derived drag areas lowered CdA, so the car reaches a
// higher top speed and needs more time to settle. This lengthens the run; it does not relax any check.
template <class Step>
void flat_out(const CarConfig& cfg, double max_s, Step step) {
    Controls c(cfg);
    c.settings.auto_gearbox = true;
    VehicleOutput last;
    RawInput raw;
    raw.device = InputDevice::Wheel;
    raw.throttle = 1.0;
    for (double t = 0; t < max_s; t += 1.0 / 240.0) last = step(c.update(raw, last, 1.0 / 240.0));
}
}  // namespace

RS_TEST(dyno) {
    const CarConfig cfg = test::car();
    // the car's own engine: peak power from its torque curve
    double p_peak = 0, p_rpm = 0;
    for (const auto& pt : cfg.engine.torque_curve)
        if (pt[1] * pt[0] * 2 * kPi / 60 > p_peak) { p_peak = pt[1] * pt[0] * 2 * kPi / 60; p_rpm = pt[0]; }

    Vehicle v(cfg);
    v.assists().tc = true;
    DynoRoad road(cfg);
    DynoMeter meter(cfg);
    road.reset(v);
    double heading_err = 0, side = 0;
    flat_out(cfg, 150, [&](const DriverInput& in) {
        v.set_input(in);
        const auto contacts = road.contacts(v);
        const VehicleOutput out = v.update(road.state(), contacts, 1.0 / 240.0);
        road.integrate(out, 1.0 / 240.0);
        meter.sample(out, v.engine_rpm(), 1.0 / 240.0, in.throttle);
        const Vec3 f = road.state().orientation.rotate({1, 0, 0});
        heading_err = std::max(heading_err, std::abs(std::atan2(f.y, f.x)));
        side = std::max(side, std::abs(road.state().position.y));
        return out;
    });
    std::printf("         dyno: peak %.0f kW at the wheels at %.0f rpm (engine data %.0f kW at %.0f rpm, x %.2f efficiency = %.0f kW), "
                "peak crank torque est. %.0f Nm at %.0f rpm\n", meter.peak_wheel_power_w() / 1000, meter.peak_power_rpm(), p_peak / 1000, p_rpm,
                cfg.drivetrain.efficiency, p_peak * cfg.drivetrain.efficiency / 1000, meter.peak_crank_torque_nm(), meter.peak_torque_rpm());
    std::printf("         dyno: 0-100 km/h %.2f s, top speed %.1f km/h (max seen %.1f), rollers turned %.0f m; straps: heading %.3f deg, side %.3f m\n",
                meter.zero_to_100_s(), meter.top_speed_mps() * 3.6, meter.max_speed_mps() * 3.6, road.distance_m(), heading_err * 180 / kPi, side);
    // Wheel power: the engine's power through the drivetrain, minus what the tyres lose (rolling resistance, slip)
    // and what accelerating the engine and wheels takes during a pull: a few per cent under engine x efficiency.
    test::check_range("peak wheel power vs engine data x drivetrain efficiency", meter.peak_wheel_power_w() / (p_peak * cfg.drivetrain.efficiency), 0.85, 1.02, "x");
    test::check_range("peak power rpm vs engine data", meter.peak_power_rpm() / p_rpm, 0.92, 1.08, "x");
    test::check("the straps hold it straight", heading_err < 1e-6 && side < 1e-9);

    // The game's feature set (web bridge rs_create = Unreal ApplyFeatureFlagsLocked): driveline torsion, chassis flex,
    // engine wear, H-pattern synchros... must not change the energy balance either.
    {
        Vehicle g(cfg);
        g.assists().tc = true;
        g.unsprung_dynamics_enabled = true;
        g.tire_zones_enabled = true;
        g.aero_wake().yaw_aero_enabled = true;
        g.chassis_dynamics().chassis_flex_enabled = true;
        g.chassis_dynamics().active_yaw_control_enabled = true;
        g.chassis_dynamics().active_aero_enabled = true;
        g.chassis_dynamics().brake_fluid_boil_enabled = true;
        g.engine_systems().torsional_compliance_enabled = true;
        g.engine_systems().dog_box_flat_shift_cut = true;
        g.engine_systems().transmission = TransmissionType::HPatternSynchro;
        g.atmosphere().enabled = true;
        g.engine_systems().wear_enabled = true;
        g.engine_systems().fuel_consumption_enabled = true;
        DynoRoad groad(cfg);
        DynoMeter gm(cfg);
        groad.reset(g);
        flat_out(cfg, 60, [&](const DriverInput& in) {
            g.set_input(in);
            const auto contacts = groad.contacts(g);
            const VehicleOutput out = g.update(groad.state(), contacts, 1.0 / 240.0);
            groad.integrate(out, 1.0 / 240.0);
            gm.sample(out, g.engine_rpm(), 1.0 / 240.0, in.throttle);
            return out;
        });
        std::printf("         dyno, game feature set: peak %.0f kW at the wheels at %.0f rpm\n", gm.peak_wheel_power_w() / 1000, gm.peak_power_rpm());
        test::check_range("game feature set: peak wheel power vs engine x efficiency", gm.peak_wheel_power_w() / (p_peak * cfg.drivetrain.efficiency), 0.85, 1.02, "x");
    }

    // The same car on a real (flat) road: same 0-100 and top speed, because it is the same physics.
    auto s = test::make_sim(cfg);
    s->vehicle.assists().tc = true;
    DynoMeter road_meter(cfg);
    flat_out(cfg, 150, [&](const DriverInput& in) {
        s->step(in);
        road_meter.sample(s->last, s->vehicle.engine_rpm(), s->dt, in.throttle);
        return s->last;
    });
    std::printf("         road: 0-100 km/h %.2f s, top speed %.1f km/h\n", road_meter.zero_to_100_s(), road_meter.top_speed_mps() * 3.6);
    test::check("the dyno reached a steady top speed", meter.top_speed_mps() > 0);
    test::check_range("dyno vs road top speed", meter.top_speed_mps() / std::max(road_meter.top_speed_mps(), 1.0), 0.99, 1.01, "x");
    test::check_range("dyno vs road 0-100 km/h", meter.zero_to_100_s() / std::max(road_meter.zero_to_100_s(), 0.1), 0.97, 1.03, "x");
}
