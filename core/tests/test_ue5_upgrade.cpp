// Unit tests for UE5 C++ Core Upgrades:
//   1. Turbocharger Spool, Manifold Boost (bar) & Blow-Off Valve (BOV) Venting
//   2. Nitrous Oxide (N2O) Torque Boost & Liquid Bottle Depletion
//   3. Oil Thermodynamics, Engine Wear & Cylinder Misfire Simulation
//   4. Physical Starter Motor Cranking from Stall
//   5. 3-Ray Circular-Arc Tire Contact Patch Curb Climbing vs Single Ray
#include <cmath>
#include <memory>
#include "harness.hpp"
#include "rs/config.hpp"
#include "rs/sim.hpp"
#include "rs/vehicle.hpp"

RS_TEST(ue5_upgrade) {
    using namespace rs;
    const CarConfig cfg = load_car_config(std::string(RS_DATA_DIR) + "/cars/vela_gt.json");
    auto flat = std::make_shared<PlaneGround>();

    // 1. Turbocharger Spool + Blow-Off Valve (BOV) Venting + Faster Acceleration
    {
        Simulation sim_na(cfg, flat);
        Simulation sim_turbo(cfg, flat);
        sim_turbo.vehicle.engine_systems().turbo_stage = 3; // Stage 3 Race Twin-Scroll (1.65 bar)

        sim_na.reset({}, 0.0, 28.0, 4);
        sim_turbo.reset({}, 0.0, 28.0, 4);

        DriverInput wot;
        wot.throttle = 1.0;
        wot.gear = 4;
        wot.auto_clutch = true;

        for (int i = 0; i < 180; ++i) { // 0.75 s at WOT
            sim_na.step(wot);
            sim_turbo.step(wot);
        }
        test::check("turbo spools positive manifold pressure > 0.8 bar at WOT",
                    sim_turbo.last.boost_bar > 0.80);
        test::check("turbocharged car accelerates faster than naturally aspirated car",
                    sim_turbo.last.speed > sim_na.last.speed + 0.5);

        // Lift throttle abruptly from high boost -> Blow-Off Valve (BOV) vents
        DriverInput lift = wot;
        lift.throttle = 0.0;
        sim_turbo.step(lift);
        test::check("blow-off valve (bov_venting) triggers on throttle lift from boost",
                    sim_turbo.last.bov_venting);
    }

    // 2. Nitrous Oxide (N2O) Torque Boost & Bottle Depletion
    {
        Simulation sim_dry(cfg, flat);
        Simulation sim_nos(cfg, flat);
        sim_dry.reset({}, 0.0, 25.0, 3);
        sim_nos.reset({}, 0.0, 25.0, 3);

        DriverInput in_dry;
        in_dry.throttle = 1.0;
        in_dry.gear = 3;
        in_dry.auto_clutch = true;

        DriverInput in_nos = in_dry;
        in_nos.nos = true;

        const double start_nos = sim_nos.vehicle.engine_systems().nos_bottles_l;
        for (int i = 0; i < 120; ++i) {
            sim_dry.step(in_dry);
            sim_nos.step(in_nos);
        }
        test::check("N2O bottle depletes while spraying at WOT above 2600 RPM",
                    sim_nos.last.nos_remaining_l < start_nos - 0.15);
        test::check("N2O spray yields higher forward velocity than dry WOT run",
                    sim_nos.last.speed > sim_dry.last.speed + 0.4);
    }

    // 3. Engine Wear, Oil Temperature & Misfires
    {
        Simulation sim_healthy(cfg, flat);
        Simulation sim_worn(cfg, flat);
        sim_worn.vehicle.engine_systems().engine_health = 0.40; // severely worn auction engine
        sim_worn.vehicle.engine_systems().oil_temp_c = 142.0;   // overheated oil

        sim_healthy.reset({}, 0.0, 22.0, 3);
        sim_worn.reset({}, 0.0, 22.0, 3);

        DriverInput wot;
        wot.throttle = 1.0;
        wot.gear = 3;
        wot.auto_clutch = true;

        bool saw_misfire = false;
        for (int i = 0; i < 120; ++i) {
            sim_healthy.step(wot);
            sim_worn.step(wot);
            if (sim_worn.last.engine_misfire) saw_misfire = true;
        }
        test::check("worn engine (< 0.65 health) triggers deterministic cylinder misfires", saw_misfire);
        test::check("worn + overheated engine produces less speed than healthy engine",
                    sim_worn.last.speed < sim_healthy.last.speed - 0.4);
    }

    // 4. Physical Starter Motor Cranking Recovery from Stall
    {
        Simulation sim(cfg, flat);
        sim.reset({}, 0.0, 0.0, 2);
        // Force a stall state with clutch engaged in gear
        DriverInput stall_in;
        stall_in.gear = 2;
        stall_in.clutch = 0.0;
        stall_in.brake = 1.0;
        for (int i = 0; i < 60; ++i) sim.step(stall_in);
        test::check("engine stalls when locked in gear at 0 speed with brakes full", sim.last.engine_stalled);

        // Crank starter motor with clutch still partially engaged
        DriverInput crank_in;
        crank_in.gear = 2;
        crank_in.clutch = 0.5;
        crank_in.starter = true;
        for (int i = 0; i < 120; ++i) sim.step(crank_in);
        test::check("physical starter motor cranks stalled engine back to running idle",
                    !sim.last.engine_stalled && sim.last.engine_rpm >= cfg.engine.idle_rpm * 0.85);
    }

    // 5. 3-Ray Circular-Arc Contact Patch Climbing a Curb Step
    {
        // Curb at x = 2.0 m with a 0.10 m (10 cm) step
        auto curb = std::make_shared<CurbGround>(2.0, 0.10);
        Simulation sim(cfg, curb);
        sim.use_contact_patch = true;
        // Position front axle just before the curb lip so the leading sub-ray (+0.52 * R) overhangs the curb step
        const double front_x = cfg.wheels[FL].x;
        const double r = cfg.tire(FL).radius;
        sim.reset({2.0 - front_x - 0.25 * r, 0.0, 0.0}, 0.0, 5.0, 2);

        auto single_rays = sim.vehicle.wheel_rays(sim.body.state);
        auto patch_rays = sim.vehicle.wheel_contact_patch_rays(sim.body.state);

        WheelContact single_hit = curb->raycast(single_rays[FL]);
        std::array<WheelContact, 3> sub_hits = {
            curb->raycast(patch_rays[FL].rays[0]),
            curb->raycast(patch_rays[FL].rays[1]),
            curb->raycast(patch_rays[FL].rays[2]),
        };
        WheelContact patch_hit = Vehicle::resolve_contact_patch(patch_rays[FL], sub_hits, r);

        test::check("leading contact-patch ray detects curb before wheel center arrives",
                    patch_hit.hit && single_hit.hit && patch_hit.distance < single_hit.distance - 0.01);
        test::check("resolved contact patch tilts normal backward to ramp wheel smoothly up curb",
                    patch_hit.normal.x < -0.05 && patch_hit.normal.z > 0.85);
    }
}
