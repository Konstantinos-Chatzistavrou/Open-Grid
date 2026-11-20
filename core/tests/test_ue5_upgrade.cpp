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

    // 6. 15 Hz 2-DOF Unsprung Mass Wheel-Hop & Radial Tire Carcass Deflection over Curb Step
    {
        auto curb = std::make_shared<CurbGround>(2.0, 0.08);
        Simulation sim(cfg, curb);
        sim.use_contact_patch = true;
        sim.vehicle.unsprung_dynamics_enabled = true;
        sim.reset({0.0, 0.0, 0.0}, 0.0, 14.0, 3);

        DriverInput drive;
        drive.throttle = 0.5;
        drive.gear = 3;
        drive.auto_clutch = true;

        double max_hop_vel = 0.0;
        double max_carcass_defl = 0.0;
        for (int i = 0; i < 60; ++i) {
            sim.step(drive);
            max_hop_vel = std::max(max_hop_vel, std::abs(sim.last.wheels[FL].unsprung_vel_mps));
            max_carcass_defl = std::max(max_carcass_defl, sim.last.wheels[FL].carcass_deflection_m);
        }
        test::check("2-DOF unsprung wheel mass exhibits vertical wheel-hop velocity & radial carcass deflection",
                    max_hop_vel > 0.02 && max_carcass_defl > 0.005);
    }

    // 7. 3-Zone Tire Tread Thermals (Inner / Middle / Outer) & Brake-Lockup Flat-Spotting + FFB Thump
    {
        TireCondition tc;
        // Negative camber on left wheel (side_sign = -1.0 -> top tilted inward toward car centerline has gamma = -0.07 rad)
        for (int i = 0; i < 40; ++i) {
            tc.update_zones(18000.0, 4200.0, 35.0, -0.07, 0.0, -1.0, 105.0, i * 0.5, 0.05, &cfg.tire_front);
        }
        test::check("negative camber on straight heats Inner tread shoulder above Outer shoulder",
                    tc.inner_c > tc.outer_c + 1.5);

        // Hard locked-wheel skid (omega = 0 at 30 m/s) grinds a flat spot and generates FFB thump torque
        TireCondition locked_tire;
        for (int i = 0; i < 30; ++i) {
            locked_tire.update_zones(35000.0, 4500.0, 30.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.05, &cfg.tire_front);
        }
        const double thump_at_spot = std::abs(locked_tire.flat_spot_ffb_torque_nm(1.0, 4500.0, 25.0));
        const double thump_opposite = std::abs(locked_tire.flat_spot_ffb_torque_nm(1.0 + kPi, 4500.0, 25.0));
        test::check("locked-wheel skid grinds flat spot (> 0.2 mm) & produces once-per-rev FFB thump pulse",
                    locked_tire.flat_spot_depth_mm > 0.2 && thump_at_spot > thump_opposite + 0.5);
    }

    // 8. Transmission Archetypes (H-Pattern Synchro Grind vs Sequential Dog-Box Flat-Shift Cut) & Torsional Backlash Clunk
    {
        Simulation sim_h(cfg, flat);
        sim_h.vehicle.engine_systems().transmission = TransmissionType::HPatternSynchro;
        sim_h.vehicle.engine_systems().strict_h_pattern_synchro = true;
        sim_h.reset({}, 0.0, 20.0, 2);

        // Attempt raw clutchless shift from 2nd to 5th without pressing clutch -> grinds synchros and drops to Neutral
        DriverInput raw_shift;
        raw_shift.throttle = 0.9;
        raw_shift.clutch = 0.0;
        raw_shift.gear = 5;
        raw_shift.auto_clutch = false;
        sim_h.step(raw_shift);
        test::check("clutchless un-matched H-pattern shift grinds synchros (gear_grind) & kicks to neutral",
                    sim_h.last.gear_grind && sim_h.last.gear == 1);

        // Sequential Dog-Box flat-shift upshift triggers 55 ms ignition cut
        Simulation sim_dog(cfg, flat);
        sim_dog.vehicle.engine_systems().transmission = TransmissionType::SequentialDogBox;
        sim_dog.vehicle.engine_systems().dog_box_flat_shift_cut = true;
        sim_dog.vehicle.engine_systems().torsional_compliance_enabled = true;
        sim_dog.reset({}, 0.0, 22.0, 2);

        DriverInput g2;
        g2.throttle = 1.0;
        g2.gear = 2;
        g2.auto_clutch = false;
        sim_dog.step(g2);

        DriverInput g3 = g2;
        g3.gear = 3;
        sim_dog.step(g3);
        test::check("sequential dog-box flat-shift triggers 55 ms ignition cut (shift_cut_active)",
                    sim_dog.last.shift_cut_active);
    }

    // 9. Aerodynamic Slipstream Tow (-28% Drag) & Dirty-Air Front Downforce Loss (-30%) + Yaw Drag
    {
        AeroWakeState clean = Vehicle::compute_slipstream_wake({0, 0, 0}, {1, 0, 0}, {{100, 0, 0}});
        AeroWakeState tow = Vehicle::compute_slipstream_wake({0, 0, 0}, {1, 0, 0}, {{12, 0.2, 0}});
        test::check("slipstream behind lead car (12 m ahead) cuts aero drag & reduces front downforce (dirty air)",
                    clean.drag_scale == 1.0 && tow.drag_scale < 0.80 && tow.dirty_air_front_downforce_scale < 0.78);
    }

    // 10. Intercooler Heat Soak (IAT), Radiator Puncture Thermal Runaway & BSFC Fuel Consumption
    {
        Simulation sim_f(cfg, flat);
        sim_f.vehicle.engine_systems().turbo_stage = 3;
        sim_f.vehicle.engine_systems().fuel_consumption_enabled = true;
        sim_f.reset({}, 0.0, 30.0, 4);

        const double start_fuel = sim_f.vehicle.engine_systems().fuel_liters;
        const double start_iat = sim_f.vehicle.engine_systems().intake_air_temp_c;
        // Inflict a front-center crash to puncture the radiator
        sim_f.vehicle.add_contact(99, {2.1, 0.0, 0.4}, 18000.0);

        DriverInput wot;
        wot.throttle = 1.0;
        wot.gear = 4;
        wot.auto_clutch = true;
        for (int i = 0; i < 180; ++i) sim_f.step(wot);

        test::check("turbo boost heats intake air temperature (IAT) & WOT load burns fuel",
                    sim_f.last.intake_air_temp_c > start_iat + 4.0 && sim_f.last.fuel_liters < start_fuel - 0.001);
        test::check("front-center crash populates 8-node morph target crush, unlatches hood & leaks radiator",
                    sim_f.last.damage.node_norm[NodeFrontCenter] > 0.32 &&
                    sim_f.last.damage.hood_unlatched &&
                    sim_f.last.damage.radiator_leak > 0.05);
    }

    // 11. Bent Wishbone Camber & Caster Offsets + Hub Bearing Drag on Wheel Impact
    {
        Simulation sim_w(cfg, flat);
        sim_w.reset({}, 0.0, 10.0, 2);
        // Heavy direct hit on Front-Left wheel (> 0.35 wheel damage threshold)
        const Vec3 fl_pt{cfg.wheels[FL].x, cfg.wheels[FL].y, 0.3};
        sim_w.vehicle.add_contact(42, fl_pt, 22000.0);
        test::check("direct wheel impact bends wishbone camber & caster and adds hub bearing drag",
                    sim_w.vehicle.damage_model().camber_offset(FL) > 0.005 &&
                    sim_w.vehicle.damage_model().caster_offset(FL) < -0.004 &&
                    sim_w.vehicle.damage_model().wheel_bearing_drag_nm(FL) > 1.0);
    }

    // 12. Chassis Torsional Flex (Strut Bar / Roll Cage Stiffening) & Active Torque-Vectoring E-Diff (AYC)
    {
        Simulation sim_soft_ch(cfg, flat);
        Simulation sim_cage_ch(cfg, flat);
        sim_soft_ch.vehicle.chassis_dynamics().chassis_flex_enabled = true;
        sim_soft_ch.vehicle.chassis_dynamics().torsional_stiffness_nm_per_deg = 12000.0; // fatigued unibody
        sim_cage_ch.vehicle.chassis_dynamics().chassis_flex_enabled = true;
        sim_cage_ch.vehicle.chassis_dynamics().torsional_stiffness_nm_per_deg = 48000.0; // Strut Bar + Roll Cage
        sim_cage_ch.vehicle.chassis_dynamics().active_yaw_control_enabled = true;

        sim_soft_ch.reset({}, 0.0, 26.0, 3);
        sim_cage_ch.reset({}, 0.0, 26.0, 3);

        DriverInput turn;
        turn.steer = 0.45;
        turn.throttle = 0.75;
        turn.gear = 3;
        turn.auto_clutch = true;

        for (int i = 0; i < 90; ++i) {
            sim_soft_ch.step(turn);
            sim_cage_ch.step(turn);
        }
        test::check("roll-caged chassis twists less under cornering load than fatigued unibody",
                    std::abs(sim_cage_ch.last.chassis_twist_deg) < std::abs(sim_soft_ch.last.chassis_twist_deg));
        test::check("Active Torque-Vectoring E-Diff (AYC) generates pro-rotation yaw moment in corners",
                    std::abs(sim_cage_ch.last.ayc_yaw_moment_nm) > 10.0);
    }

    // 13. Active Aerodynamics (DRS Low-Drag Straight Mode + 35-Deg Braking Airbrake) & DOT 4 Brake Fluid Vapor Lock
    {
        Simulation sim_aero(cfg, flat);
        sim_aero.vehicle.chassis_dynamics().active_aero_enabled = true;
        sim_aero.vehicle.chassis_dynamics().brake_fluid_boil_enabled = true;
        sim_aero.reset({}, 0.0, 56.0, 5); // 201.6 km/h

        DriverInput fast_straight;
        fast_straight.throttle = 1.0;
        fast_straight.gear = 5;
        fast_straight.auto_clutch = true;
        sim_aero.step(fast_straight);
        test::check("Active Aero engages DRS low-drag wing above 180 km/h on straight WOT",
                    sim_aero.last.drs_active && !sim_aero.last.airbrake_active && sim_aero.last.slipstream_drag_scale < 0.90);

        // Overheat caliper brake fluid past DOT 4 boiling point (295 C > 260 C) and slam brakes
        sim_aero.vehicle.set_brake_fluid_temperature(295.0);
        DriverInput hard_brake;
        hard_brake.brake = 1.0;
        hard_brake.gear = 5;
        hard_brake.auto_clutch = true;
        sim_aero.step(hard_brake);
        test::check("Active Aero deploys high-downforce Airbrake under hard high-speed braking",
                    sim_aero.last.airbrake_active && !sim_aero.last.drs_active && sim_aero.last.slipstream_drag_scale > 1.15);
        test::check("boiled DOT 4 caliper fluid (> 260 C) causes vapor-lock spongy brake pressure loss",
                    sim_aero.last.brake_vapor_lock_sponge > 0.20);
    }

    // 14. 4-Wheel Asymmetric Split-Mu Hydroplaning & Braking Yaw Pull
    {
        Vehicle veh(cfg);
        veh.reset_motion(62.0, 6); // 223.2 km/h high-speed wet highway puddle hit
        ChassisState s;
        s.position = {0, 0, cfg.cg_height};
        s.velocity = {62.0, 0, 0};

        auto rays = veh.wheel_rays(s);
        std::array<WheelContact, 4> contacts;
        for (int w = 0; w < 4; ++w) {
            contacts[w] = flat->raycast(rays[w]);
            // Left wheels (FL=0, RL=2) hit a 5.5 mm standing water puddle; right wheels (FR=1, RR=3) are on dry asphalt
            contacts[w].water_depth_mm = (w % 2 == 0) ? 5.5 : 0.0;
        }

        DriverInput brake_in;
        brake_in.brake = 0.85;
        brake_in.gear = 6;
        brake_in.auto_clutch = true;
        veh.set_input(brake_in);

        VehicleOutput out;
        for (int i = 0; i < 15; ++i) out = veh.update(s, contacts, 1.0 / 240.0);

        test::check("left wheels in 5.5 mm standing puddle hydroplane while right wheels stay planted",
                    out.wheels[FL].hydroplaning_lift > 0.25 && out.wheels[FR].hydroplaning_lift == 0.0 &&
                    out.wheels[FL].load < out.wheels[FR].load * 0.78);
        test::check("asymmetric left-puddle braking induces split-mu yaw torque pulling toward dry right side",
                    out.torque.z < -250.0);
    }

    // 15. Pacejka MF 6.2 Camber-Conicity + WLF Millisecond Flash-Temperature + 3-Rib Contact-Patch Hybrid
    {
        const TireParams& tp = cfg.tire_front;
        const double re_flat = effective_rolling_radius(tp, 4200.0);
        const double re_camber = effective_rolling_radius_mf62(tp, 4200.0, 0.08);
        test::check("MF 6.2 camber-conicity reduces effective rolling radius on tilted shoulder",
                    re_camber < re_flat - 0.0005);

        TireCondition tc;
        // Sudden 12 ms high-power slide (38 kW) spikes micro-asperity WLF flash temperature while bulk surface barely moves
        tc.update_zones(38000.0, 4200.0, 35.0, -0.05, 3200.0, -1.0, 100.0, 1.0, 0.012, &tp);
        const double flash_spike = tc.flash_c;
        test::check("WLF micro-asperity flash temperature spikes >20 C above bulk surface within 12 ms of slide",
                    flash_spike > tc.surface_c + 20.0);

        // Slide stops (0 W slip power for 20 ms): flash temperature cools rapidly back toward surface_c
        tc.update_zones(0.0, 4200.0, 35.0, -0.05, 200.0, -1.0, 105.0, 2.0, 0.020, &tp);
        test::check("WLF flash temperature cools rapidly back toward surface temperature within 20 ms",
                    tc.flash_c < flash_spike - 15.0);

        // 3-Rib + MF 6.2 hybrid evaluation inside magic_formula
        tc.inner_c = 92.0;
        tc.middle_c = 94.0;
        tc.outer_c = 152.0; // overheated outer shoulder mid-corner
        tc.flash_c = 165.0;
        TireOperating op;
        op.enable_mf62_hybrid = true;
        op.wheel_side_sign = -1.0;
        op.condition = &tc;
        TireForces f_hybrid = magic_formula(tp, -0.08, 0.12, 4500.0, 1.0, -0.06, op);
        test::check("3-Rib + MF 6.2 + WLF hybrid evaluates load-weighted rib grip and conicity/3-rib aligning moment",
                    f_hybrid.effective_rib_mu < 0.99 && f_hybrid.effective_rib_mu > 0.80 && std::abs(f_hybrid.mz) > 1.0);
    }

    // 16. 16-Point 2D Cylindrical Tire Footprint on Lateral Apex Curb (Beating Single-Ray & 3-Ray Centerline)
    {
        // Front-Right wheel (FR) is at y = -0.805 m; its Inner rib (-0.095 m inward -> y = -0.710 m) clips a lateral apex curb at y >= -0.74 m!
        // Both 1-ray and 3-ray centerline queries lie along y = -0.805 m (< -0.74 m) and completely miss the lateral curb,
        // while the 16-Point 2D Footprint detects the inner-shoulder strike and concentrates >60% load onto the Inner rib!
        const double fr_y = cfg.wheels[FR].y; // -0.805 m
        auto lat_curb = std::make_shared<LateralCurbGround>(fr_y + 0.06, 0.055);
        Simulation sim16(cfg, lat_curb);
        sim16.use_footprint_16 = true;
        sim16.reset({}, 0.0, 12.0, 2);

        auto center_rays = sim16.vehicle.wheel_rays(sim16.body.state);
        auto patch3_rays = sim16.vehicle.wheel_contact_patch_rays(sim16.body.state);
        auto fp16_rays = sim16.vehicle.wheel_footprint_16_rays(sim16.body.state);

        WheelContact c1 = lat_curb->raycast(center_rays[FR]);
        std::array<WheelContact, 3> h3 = {
            lat_curb->raycast(patch3_rays[FR].rays[0]),
            lat_curb->raycast(patch3_rays[FR].rays[1]),
            lat_curb->raycast(patch3_rays[FR].rays[2]),
        };
        WheelContact c3 = Vehicle::resolve_contact_patch(patch3_rays[FR], h3, cfg.tire(FR).radius);

        std::array<WheelContact, 16> h16;
        for (int j = 0; j < 16; ++j) h16[j] = lat_curb->raycast(fp16_rays[FR].rays[j]);
        WheelContact c16 = Vehicle::resolve_footprint_16(fp16_rays[FR], h16, cfg.tire(FR).radius);

        test::check("16-point 2D tire footprint detects inner-shoulder lateral curb missed by 1-ray and 3-ray centerline",
                    c16.distance < c1.distance - 0.03 && c16.distance < c3.distance - 0.03);
        test::check("16-point 2D tire footprint concentrates normal load onto the curb-striking Inner rib (> 65%)",
                    c16.rib_contact_shares[0] > 0.65 && c16.rib_contact_shares[0] > c16.rib_contact_shares[2] * 3.0);
    }

    // 17. Live Barometric Altitude (0 m vs 2,400 m Mountain Pass) & Ambient/Track Celsius Thermodynamics
    {
        AtmosphericEnvironment sea_cold;
        sea_cold.enabled = true;
        sea_cold.altitude_m = 0.0;
        sea_cold.ambient_air_c = 2.0;    // 2 C crisp winter night at sea level
        sea_cold.track_surface_c = 4.0;

        AtmosphericEnvironment mountain_hot;
        mountain_hot.enabled = true;
        mountain_hot.altitude_m = 2400.0; // 2,400 m high-altitude mountain pass
        mountain_hot.ambient_air_c = 36.0;
        mountain_hot.track_surface_c = 54.0; // 54 C sun-baked asphalt

        test::check("ISA barometric pressure & air density drop by >22% at 2,400m hot altitude vs 2C sea level",
                    mountain_hot.barometric_pressure_kpa() < 78.0 &&
                    mountain_hot.air_density_kg_m3() < sea_cold.air_density_kg_m3() * 0.72);
        test::check("turbocharged wastegate retains significantly more power at 2,400m altitude than naturally aspirated engine",
                    mountain_hot.turbo_altitude_power_factor(1.15) > mountain_hot.na_engine_power_factor() + 0.12);

        // Asphalt-to-tread solid conduction: rolling on 54 C asphalt vs 4 C winter asphalt over 10 seconds
        TireCondition tire_winter, tire_summer;
        tire_winter.set_environment_celsius(2.0, 4.0);
        tire_summer.set_environment_celsius(36.0, 54.0);
        for (int i = 0; i < 200; ++i) {
            tire_winter.update_zones(6000.0, 4000.0, 30.0, -0.03, 500.0, -1.0, 95.0, i * 0.4, 0.05, &cfg.tire_front);
            tire_summer.update_zones(6000.0, 4000.0, 30.0, -0.03, 500.0, -1.0, 95.0, i * 0.4, 0.05, &cfg.tire_front);
        }
        test::check("hot 54C asphalt & 36C air heat tire tread and inflation pressure higher than 4C winter asphalt",
                    tire_summer.surface_c > tire_winter.surface_c + 12.0 &&
                    tire_summer.pressure_kpa > tire_winter.pressure_kpa + 8.0);
    }

    // 18. Simcenter Tire 2606 (MF-Tyre / MF-Swift 2606): T&V Thermal Stiffness, Rigid-Ring Belt Dynamics,
    //     3D Tandem-Cam Obstacle Enveloping & Broadband Toroidal Cavity Resonance Doppler Acoustics
    {
        const TireParams& tp = cfg.tire_front;
        TireCondition cold_t, hot_t;
        cold_t.temperature_c = 38.0; cold_t.surface_c = 36.0;
        hot_t.temperature_c = 128.0; hot_t.surface_c = 138.0;
        test::check("Simcenter 2606 T&V: cold rubber has higher small-slip shear modulus stiffness than overheated rubber",
                    cold_t.thermal_stiffness_factor(&tp) > 1.05 &&
                    hot_t.thermal_stiffness_factor(&tp) < 0.93);

        // MF-Swift Rigid-Ring Belt Dynamics (~72 Hz in-plane torsional & ~45 Hz out-of-plane lateral modes)
        TireCondition ring_t;
        ring_t.step_rigid_ring_belt(3800.0, 2900.0, tp.radius, 0.004);
        test::check("Simcenter 2606 MF-Swift Rigid-Ring belt deflects torsionally and laterally under transient force",
                    std::abs(ring_t.belt_torsion_rad) > 1e-4 && std::abs(ring_t.belt_lateral_m) > 1e-4);

        // Simcenter 2606 Broadband Transient Tire-Road NVH & Toroidal Air-Cavity Doppler Split (~225 Hz doublet)
        TireAcousticSource ac_slow = ring_t.compute_acoustics(5.0, tp.radius, 0.05);
        TireAcousticSource ac_fast = ring_t.compute_acoustics(110.0, tp.radius, 0.65);
        test::check("Simcenter 2606 Tire Acoustics: toroidal air-cavity resonance (~225 Hz) exhibits rotational Doppler split & transient volume acceleration",
                    (ac_fast.cavity_mode_high_hz - ac_fast.cavity_mode_low_hz) > (ac_slow.cavity_mode_high_hz - ac_slow.cavity_mode_low_hz) + 40.0 &&
                    ac_fast.tread_block_pitch_hz > 900.0 &&
                    ac_fast.transient_volume_accel > ac_slow.transient_volume_accel);
    }
}
