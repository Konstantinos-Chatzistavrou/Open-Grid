// LMU-beating Pro-Driver Direct-Drive & Motorsport Physics Test Suite:
//   1. Full 3D Kingpin Axis FFB Wrench (split-mu braking Fx*scrub pull, KPI Fz jacking, symmetric straight-line zero)
//   2. Pre-Peak Brush Pneumatic Trail Collapse & Front Adhesion Scrub Telemetry
//   3. Heave (Third) Springs + Packers + Heave Dampers (stiff aero heave vs supple pure roll)
//   4. Dynamic Brake Migration (BMIG), Carbon-Carbon Brake Thermal Curve & Lockup Stiction Hysteresis
//   5. Steering-Angle Wheel-Wake Aero Shift & Travelling Dirty-Air Wave Delay (front -> rear L/v)
//   6. Hybrid MGU-K / Brake-by-Wire Regen Blending / Speed-Gated Front e-AWD
//   7. Permanent Tyre Thermal Heat-Cycle Curing / Hardening
#include <cmath>
#include <memory>
#include <vector>

#include "harness.hpp"
#include "rs/sim.hpp"
#include "rs/ue5_bridge.hpp"

using namespace rs;

RS_TEST(lmu_pro_physics) {
    CarConfig base_cfg = load_car_config(std::string(RS_DATA_DIR) + "/cars/vela_gt.json");
    auto flat = std::make_shared<PlaneGround>();

    // 1. Full 3D Kingpin Axis FFB Wrench: symmetric straight-line, split-mu braking scrub pull & KPI Fz jacking
    {
        Vehicle veh(base_cfg);
        veh.chassis_dynamics().kingpin_3d_ffb_enabled = true;
        veh.reset_motion(40.0, 5);

        ChassisState cs;
        cs.position = {0.0, 0.0, base_cfg.cg_height};
        cs.velocity = {40.0, 0.0, 0.0};
        auto make_contacts = [&](double mu_fl, double mu_fr) {
            std::array<WheelContact, 4> c{};
            const auto rays = veh.wheel_rays(cs);
            for (int w = 0; w < 4; ++w) {
                c[w].hit = true;
                c[w].point = {rays[w].origin.x, rays[w].origin.y, 0.0};
                c[w].distance = rays[w].origin.z;
                c[w].normal = {0.0, 0.0, 1.0};
                c[w].surface_mu_mult = (w == FL) ? mu_fl : (w == FR ? mu_fr : 1.0);
            }
            return c;
        };

        // Straight-line coasting: symmetric FL/FR kingpin torques cancel cleanly near 0
        DriverInput straight;
        straight.gear = 5;
        veh.set_input(straight);
        const VehicleOutput o_straight = veh.update(cs, make_contacts(1.0, 1.0), 0.0025);
        test::check("3D kingpin FFB wrench stays symmetric (~0 Nm) in straight-line driving",
                    std::abs(o_straight.steer_torque) < 2.0);

        // Split-mu hard braking: FL on dry asphalt (1.0), FR on slick ice (0.20) -> FL brakes much harder ->
        // longitudinal Fx * scrub_radius immediately tugs the steering wheel toward the high-grip FL side!
        DriverInput brake_in;
        brake_in.brake = 0.85;
        brake_in.gear = 5;
        veh.set_input(brake_in);
        VehicleOutput o_split{};
        for (int i = 0; i < 8; ++i) {
            o_split = veh.update(cs, make_contacts(1.0, 0.20), 0.0025);
        }
        test::check("3D kingpin FFB transmits split-mu braking scrub-radius torque pull (LMU lockup/brake feel)",
                    std::abs(o_split.steer_torque) > 15.0);

        // KPI jacking self-centering at standstill with wheel turned +0.5 left (zero tyre slip speed)
        Vehicle v_kpi(base_cfg);
        v_kpi.chassis_dynamics().kingpin_3d_ffb_enabled = true;
        v_kpi.reset_motion(0.0, 1);
        ChassisState cs_stop;
        cs_stop.position = {0.0, 0.0, base_cfg.cg_height};
        DriverInput steer_left;
        steer_left.steer = 0.55;
        v_kpi.set_input(steer_left);
        const auto rays_stop = v_kpi.wheel_rays(cs_stop);
        std::array<WheelContact, 4> c_stop{};
        for (int w = 0; w < 4; ++w) {
            c_stop[w].hit = true;
            c_stop[w].point = {rays_stop[w].origin.x, rays_stop[w].origin.y, 0.0};
            c_stop[w].distance = rays_stop[w].origin.z;
            c_stop[w].normal = {0.0, 0.0, 1.0};
        }
        const VehicleOutput o_kpi = v_kpi.update(cs_stop, c_stop, 0.0025);
        test::check("3D kingpin KPI jacking generates restoring self-centering torque even at standstill",
                    o_kpi.steer_torque < -5.0);
    }

    // 2. Pre-Peak Brush Pneumatic Trail Collapse & Front Adhesion Scrub Telemetry
    {
        const TireParams& tp = base_cfg.tire_front;
        TireCondition cond;
        TireOperating op;
        op.enable_mf62_hybrid = true;
        op.condition = &cond;
        op.rolling_speed_mps = 35.0;

        // Compare pneumatic trail & adhesion at 2.5 deg (high adhesion) vs 6.5 deg (pre-peak micro-slide) vs peak Fy
        const TireForces f_low = magic_formula(tp, 0.0, std::tan(2.5 * kPi / 180.0), 4200.0, 1.0, 0.0, op);
        const TireForces f_mid = magic_formula(tp, 0.0, std::tan(6.5 * kPi / 180.0), 4200.0, 1.0, 0.0, op);
        const TireForces f_hi  = magic_formula(tp, 0.0, std::tan(11.0 * kPi / 180.0), 4200.0, 1.0, 0.0, op);
        test::check("brush adhesion_ratio drops progressively from linear cornering to limit slide (LMU scrub cue)",
                    f_low.adhesion_ratio > 0.72 && f_mid.adhesion_ratio < f_low.adhesion_ratio - 0.15 &&
                    f_hi.adhesion_ratio < f_mid.adhesion_ratio);
        test::check("pneumatic trail collapses ahead of full lateral saturation so DD wheel lightens before understeer",
                    f_low.pneumatic_trail > 0.015 && f_mid.pneumatic_trail < f_low.pneumatic_trail * 0.78);
    }

    // 3. Heave (Third) Springs + Packers + Heave Dampers: stiff in pure aero heave, unchanged in pure roll!
    {
        CarConfig cfg_no_heave = base_cfg;
        CarConfig cfg_heave = base_cfg;
        cfg_heave.front.heave_spring_rate = 160000.0; // stiff GT3/Hypercar third spring (N/m)
        cfg_heave.front.heave_gap_m = 0.005;          // 5 mm packer gap
        cfg_heave.front.heave_damper_bump = 8000.0;

        Vehicle v0(cfg_no_heave), v1(cfg_heave);
        ChassisState cs;
        cs.position = {0.0, 0.0, base_cfg.cg_height - 0.025}; // 25 mm symmetric heave compression!
        auto make_level = [&](const Vehicle& v) {
            std::array<WheelContact, 4> c{};
            const auto rays = v.wheel_rays(cs);
            for (int w = 0; w < 4; ++w) {
                c[w].hit = true;
                c[w].point = {rays[w].origin.x, rays[w].origin.y, 0.0};
                c[w].distance = rays[w].origin.z;
                c[w].normal = {0.0, 0.0, 1.0};
            }
            return c;
        };
        const VehicleOutput o_heave0 = v0.update(cs, make_level(v0), 0.0025);
        const VehicleOutput o_heave1 = v1.update(cs, make_level(v1), 0.0025);
        // Pure roll test on fresh vehicles: FL compressed +20 mm, FR drooped -20 mm -> dz_heave == 0!
        Vehicle vr0(cfg_no_heave), vr1(cfg_heave);
        ChassisState cs_roll;
        cs_roll.position = {0.0, 0.0, base_cfg.cg_height};
        auto make_roll = [&](const Vehicle& v) {
            std::array<WheelContact, 4> c{};
            const auto rays = v.wheel_rays(cs_roll);
            for (int w = 0; w < 4; ++w) {
                const double dz_off = (w == FL) ? -0.020 : (w == FR ? +0.020 : 0.0);
                c[w].hit = true;
                c[w].point = {rays[w].origin.x, rays[w].origin.y, -dz_off};
                c[w].distance = rays[w].origin.z + dz_off;
                c[w].normal = {0.0, 0.0, 1.0};
            }
            return c;
        };
        const VehicleOutput o_roll0 = vr0.update(cs_roll, make_roll(vr0), 0.0025);
        const VehicleOutput o_roll1 = vr1.update(cs_roll, make_roll(vr1), 0.0025);

        test::check("third/heave spring resists symmetric aero heave compression strongly (> +1200 N per front corner)",
                    o_heave1.wheels[FL].load > o_heave0.wheels[FL].load + 1200.0 &&
                    o_heave1.wheels[FR].load > o_heave0.wheels[FR].load + 1200.0);
        test::check("third/heave spring adds ZERO stiffness in pure body roll (decouples aero platform from roll/kerbs)",
                    std::abs(o_roll1.wheels[FL].load - o_roll0.wheels[FL].load) < 1.0 &&
                    std::abs(o_roll1.wheels[FR].load - o_roll0.wheels[FR].load) < 1.0);
    }

    // 4. Dynamic Brake Migration (BMIG), Carbon-Carbon Brake Curve & Lockup Stiction Hysteresis
    {
        CarConfig cfg_cc = base_cfg;
        cfg_cc.brake_migration_front = 0.05; // 5% rearward migration as driver trails off pedal
        cfg_cc.brake_thermal.disc_type = BrakeDiscType::CarbonCarbon;

        test::check("carbon-carbon brake curve shows cold glaze (<0.65 @ 100C) and hot mid-stop bite surge (>1.02 @ 550C)",
                    brake_pad_mu(100.0, BrakeDiscType::CarbonCarbon) < 0.65 &&
                    brake_pad_mu(550.0, BrakeDiscType::CarbonCarbon) > 1.02 &&
                    brake_pad_mu(550.0, BrakeDiscType::CarbonCarbon) > brake_pad_mu(100.0, BrakeDiscType::CarbonCarbon) + 0.38);

        Simulation sim_bmig(cfg_cc, flat);
        sim_bmig.reset({}, 0.0, 45.0, 5);
        DriverInput full_b, trail_b;
        full_b.brake = 1.0; full_b.gear = 5;
        trail_b.brake = 0.20; trail_b.gear = 5;
        sim_bmig.step(full_b);
        const double bias_full = sim_bmig.last.effective_brake_bias_front;
        sim_bmig.step(trail_b);
        const double bias_trail = sim_bmig.last.effective_brake_bias_front;
        test::check("dynamic Brake Migration (BMIG) shifts brake bias rearward as driver bleeds off pedal pressure",
                    bias_full > bias_trail + 0.035 && bias_full >= cfg_cc.brake_bias_front - 1e-6);

        // Lockup stiction: locked wheel under firm braking without ABS gets +8% static caliper torque
        Drivetrain dt_lock(base_cfg);
        DrivetrainInput din;
        din.brake = 0.60;
        din.airspeed_mps = 30.0;
        dt_lock.wheel_omega = {1.0, 40.0, 40.0, 40.0}; // FL locked (~1 rad/s), FR rolling (40 rad/s)
        dt_lock.step(din, {}, {}, 0.001);
        test::check("locked front wheel exhibits ~8% static pad stiction hysteresis vs rolling wheel",
                    dt_lock.brake_torque[FL] > dt_lock.brake_torque[FR] * 1.06);
    }

    // 5. Steering-Angle Wheel-Wake Aero Shift & Travelling Dirty-Air Wave Delay (front -> rear L/v)
    {
        Vehicle v_st(base_cfg), v_turn(base_cfg);
        v_st.aero_wake().yaw_aero_enabled = true;
        v_turn.aero_wake().yaw_aero_enabled = true;
        v_st.reset_motion(60.0, 6);
        v_turn.reset_motion(60.0, 6);
        ChassisState cs;
        cs.position = {0.0, 0.0, 2.0};
        cs.velocity = {60.0, 0.0, 0.0};
        std::array<WheelContact, 4> no_c{};
        DriverInput d0, d_steer;
        d_steer.steer = 0.70;
        v_st.set_input(d0);
        v_turn.set_input(d_steer);
        const VehicleOutput o_st = v_st.update(cs, no_c, 0.0025);
        const VehicleOutput o_tr = v_turn.update(cs, no_c, 0.0025);
        test::check("front-wheel steering wake trims downforce, shifts aero balance rearward & adds exposed-tyre drag",
                    o_tr.aero_balance_front < o_st.aero_balance_front - 0.008 &&
                    o_tr.aero_drag_n > o_st.aero_drag_n * 1.005);

        // Travelling dirty-air wave: sudden step into dirty air hits front wing immediately while rear lags by L/v!
        Vehicle v_wave(base_cfg);
        v_wave.aero_wake().yaw_aero_enabled = true;
        v_wave.reset_motion(60.0, 6);
        v_wave.update(cs, no_c, 0.0025); // clean air baseline
        v_wave.aero_wake().dirty_air_front_downforce_scale = 0.65;
        v_wave.aero_wake().dirty_air_rear_downforce_scale = 0.80;
        const VehicleOutput o_t0 = v_wave.update(cs, no_c, 0.0025); // 2.5 ms after entering wake
        VehicleOutput o_t1{};
        for (int i = 0; i < 60; ++i) o_t1 = v_wave.update(cs, no_c, 0.0025); // 150 ms later (settled)
        test::check("travelling dirty-air wave hits front wing before rear wing (L/v advection lag ~45 ms)",
                    o_t0.dirty_air_downforce_scale < 0.66 &&
                    o_t0.dirty_air_rear_downforce_scale > 0.95 &&
                    o_t1.dirty_air_rear_downforce_scale < 0.83);
    }

    // 6. Hybrid MGU-K / Brake-by-Wire Regen Blending / Speed-Gated Front e-AWD
    {
        CarConfig cfg_hyb = base_cfg;
        cfg_hyb.drivetrain.hybrid.enabled = true;
        cfg_hyb.drivetrain.hybrid.max_deploy_kw = 200.0;
        cfg_hyb.drivetrain.hybrid.max_regen_kw = 200.0;
        cfg_hyb.drivetrain.hybrid.max_torque_nm = 2200.0; // wheel-side e-axle torque (motor x reduction gear)
        cfg_hyb.drivetrain.hybrid.front_deploy_min_speed_mps = 25.0; // e-AWD gate at 90 km/h
        cfg_hyb.drivetrain.hybrid.front_axle_motor = true;
        cfg_hyb.drivetrain.hybrid.brake_by_wire = true;

        Simulation sim_ice(base_cfg, flat), sim_hyb(cfg_hyb, flat);
        sim_ice.reset({}, 0.0, 35.0, 5);
        sim_hyb.reset({}, 0.0, 35.0, 5);
        const double soc_start = sim_hyb.vehicle.engine_systems().hybrid_soc;

        DriverInput wot;
        wot.throttle = 1.0; wot.gear = 5; wot.auto_clutch = true;
        for (int i = 0; i < 400; ++i) { // 1.0 s WOT pull
            sim_ice.step(wot);
            sim_hyb.step(wot);
        }
        const double soc_after_deploy = sim_hyb.last.hybrid_soc;
        test::check("hybrid MGU-K deploys electric power (>100 kW), drains HV SoC & out-accelerates pure ICE",
                    sim_hyb.last.hybrid_deploy_kw > 100.0 &&
                    soc_after_deploy < soc_start - 0.01 &&
                    sim_hyb.last.speed > sim_ice.last.speed + 0.8);

        // Hard braking from identical 55 m/s with ABS: MGU-K harvests energy (SoC rises) and BBW subtracts caliper torque!
        sim_ice.vehicle.assists().abs = true;
        sim_hyb.vehicle.assists().abs = true;
        sim_ice.reset({}, 0.0, 55.0, 5);
        sim_hyb.reset({}, 0.0, 55.0, 5);
        sim_hyb.vehicle.engine_systems().hybrid_soc = soc_after_deploy;
        sim_ice.vehicle.set_brake_temperature(200.0);
        sim_hyb.vehicle.set_brake_temperature(200.0);
        DriverInput brk;
        brk.brake = 0.85; brk.gear = 5; brk.auto_clutch = true;
        for (int i = 0; i < 400; ++i) {
            sim_ice.step(brk);
            sim_hyb.step(brk);
        }
        test::check("MGU-K regenerative braking harvests energy (SoC rises) & BBW keeps front brake rotors cooler",
                    sim_hyb.last.hybrid_bbw_active &&
                    sim_hyb.last.hybrid_soc > soc_after_deploy + 0.005 &&
                    sim_hyb.last.wheels[FL].brake_temp_c < sim_ice.last.wheels[FL].brake_temp_c - 15.0);
    }

    // 7. Permanent Tyre Thermal Heat-Cycle Curing / Hardening
    {
        const TireParams& tp = base_cfg.tire_front;
        TireCondition fresh, aged;
        fresh.temperature_c = aged.temperature_c = tp.temp_optimal_c;
        fresh.surface_c = aged.surface_c = tp.temp_optimal_c;
        // Simulate 4 full heat cycles (overheat -> cool down)
        for (int c = 0; c < 4; ++c) {
            aged.temperature_c = tp.temp_optimal_c + 18.0;
            aged.update_zones(500.0, 4000.0, 30.0, 0.0, 0.0, -1.0, 90.0, 0.0, 0.05, &tp);
            aged.temperature_c = tp.temp_optimal_c - 22.0;
            aged.update_zones(0.0, 4000.0, 5.0, 0.0, 0.0, -1.0, 15.0, 0.0, 0.05, &tp);
        }
        aged.temperature_c = tp.temp_optimal_c;
        aged.surface_c = tp.temp_optimal_c;
        test::check("repeated thermal heat cycles cure/harden rubber (higher stiffness, slightly lower peak grip)",
                    aged.heat_cycle_age > 0.45 &&
                    aged.thermal_stiffness_factor(&tp) > fresh.thermal_stiffness_factor(&tp) + 0.02 &&
                    aged.zone_health_grip_factor() < fresh.zone_health_grip_factor() - 0.015);
    }

    // 8. Asymmetric Off-Center Dirty-Air Wake Yaw/Roll/Steering Pull (peeking half a car-width out to overtake!)
    {
        const Vec3 my_pos{0.0, 0.0, 0.0};
        const Vec3 my_vel{65.0, 0.0, 0.0};
        const Vec3 my_fwd{1.0, 0.0, 0.0};
        AeroTrafficCar lead;
        lead.position = {11.0, 0.0, 0.0};
        lead.velocity = {65.0, 0.0, 0.0};
        lead.forward = {1.0, 0.0, 0.0};

        const AeroWakeState centered = Vehicle::compute_aero_wake_field({0.0, 0.0, 0.0}, my_vel, my_fwd, {lead});
        // Peek RIGHT (y = -0.85 m): lead wake core is to our LEFT (+Y) -> right half of nose enters clean air!
        const AeroWakeState peek_right = Vehicle::compute_aero_wake_field({0.0, -0.85, 0.0}, my_vel, my_fwd, {lead});
        test::check("off-center overtake peek creates strong wake_lateral_asymmetry (0 when centered, > 0.4 when peeking right)",
                    std::abs(centered.wake_lateral_asymmetry) < 1e-6 &&
                    peek_right.wake_lateral_asymmetry > 0.40);

        Vehicle v_asym(base_cfg);
        v_asym.aero_wake() = peek_right;
        v_asym.aero_wake().wake_turbulence_0_to_1 = 0.0; // isolate steady off-center wake pull from unsteady Strouhal phase
        v_asym.aero_wake().yaw_aero_enabled = true;
        v_asym.reset_motion(65.0, 6);
        ChassisState cs;
        cs.position = {0.0, 0.0, 2.0};
        cs.velocity = {65.0, 0.0, 0.0};
        std::array<WheelContact, 4> no_c{};
        const VehicleOutput o_asym = v_asym.update(cs, no_c, 0.0025);
        test::check("asymmetric wake pulls yaw moment & steering rack toward the clean-air lane on overtake peek",
                    o_asym.wake_asymmetry > 0.40 &&
                    o_asym.aero_yaw_moment_nm < -40.0 &&
                    o_asym.steer_torque < -5.0);
    }

    // 9. Elastic 2-DOF Steering Column Compliance Oscillator (shapes 400 Hz spikes, exact steady-state torque)
    {
        Vehicle v_rigid(base_cfg), v_elastic(base_cfg);
        v_rigid.chassis_dynamics().kingpin_3d_ffb_enabled = true;
        v_elastic.chassis_dynamics().kingpin_3d_ffb_enabled = true;
        v_elastic.chassis_dynamics().elastic_column_enabled = true;
        v_rigid.reset_motion(35.0, 4);
        v_elastic.reset_motion(35.0, 4);

        ChassisState cs;
        cs.position = {0.0, 0.0, base_cfg.cg_height};
        cs.velocity = {35.0, 0.0, 0.0};
        DriverInput turn;
        turn.steer = 0.25;
        turn.gear = 4;
        v_rigid.set_input(turn);
        v_elastic.set_input(turn);
        const auto rays = v_rigid.wheel_rays(cs);
        std::array<WheelContact, 4> c{};
        for (int w = 0; w < 4; ++w) {
            c[w].hit = true;
            c[w].point = {rays[w].origin.x, rays[w].origin.y, 0.0};
            c[w].distance = rays[w].origin.z;
            c[w].normal = {0.0, 0.0, 1.0};
        }
        const VehicleOutput o_r0 = v_rigid.update(cs, c, 0.0025);
        const VehicleOutput o_e0 = v_elastic.update(cs, c, 0.0025);
        VehicleOutput o_r1{}, o_e1{};
        for (int i = 0; i < 120; ++i) { // 300 ms settle to steady state
            o_r1 = v_rigid.update(cs, c, 0.0025);
            o_e1 = v_elastic.update(cs, c, 0.0025);
        }
        test::check("elastic 2-DOF steering column damps step-tick spikes initially and converges to steady-state rim torque",
                    std::abs(o_e0.steering_column_torque_nm) < std::abs(o_r0.steering_column_torque_nm) * 0.65 &&
                    std::abs(o_e1.steering_column_torque_nm - o_r1.steering_column_torque_nm) < 0.6);
    }

    // 10. In-Car MFD Controls (Engine Braking EBR, Throttle Map Gamma, Brake Duct Cooling vs Drag) + GT3 Spec Load
    {
        Simulation sim_ebr_lo(base_cfg, flat), sim_ebr_hi(base_cfg, flat);
        sim_ebr_lo.vehicle.chassis_dynamics().engine_braking_scale = 0.45;
        sim_ebr_hi.vehicle.chassis_dynamics().engine_braking_scale = 1.55;
        sim_ebr_lo.reset({}, 0.0, 42.0, 4);
        sim_ebr_hi.reset({}, 0.0, 42.0, 4);
        DriverInput coast;
        coast.throttle = 0.0; coast.gear = 4; coast.auto_clutch = true;
        for (int i = 0; i < 400; ++i) { sim_ebr_lo.step(coast); sim_ebr_hi.step(coast); }
        test::check("higher Engine Braking (EBR) coast map decelerates car more strongly off-throttle",
                    sim_ebr_hi.last.speed < sim_ebr_lo.last.speed - 0.25);

        // Throttle map gamma: wet progressive (1.65) delivers less mid-pedal torque than quali (0.65)
        Simulation sim_wet(base_cfg, flat), sim_quali(base_cfg, flat);
        sim_wet.vehicle.chassis_dynamics().throttle_map_gamma = 1.65;
        sim_quali.vehicle.chassis_dynamics().throttle_map_gamma = 0.65;
        sim_wet.reset({}, 0.0, 30.0, 4);
        sim_quali.reset({}, 0.0, 30.0, 4);
        DriverInput half_thr;
        half_thr.throttle = 0.50; half_thr.gear = 4; half_thr.auto_clutch = true;
        for (int i = 0; i < 300; ++i) { sim_wet.step(half_thr); sim_quali.step(half_thr); }
        test::check("throttle map gamma shapes half-pedal acceleration (quali > progressive wet)",
                    sim_quali.last.speed > sim_wet.last.speed + 1.2);

        // Brake duct trade-off: closed ducts (0.30) cut aero drag but run discs hotter than open ducts (1.0)
        Simulation sim_open(base_cfg, flat), sim_closed(base_cfg, flat);
        sim_open.vehicle.chassis_dynamics().brake_duct_open = 1.0;
        sim_closed.vehicle.chassis_dynamics().brake_duct_open = 0.30;
        sim_open.reset({}, 0.0, 60.0, 7);
        sim_closed.reset({}, 0.0, 60.0, 7);
        sim_open.vehicle.set_brake_temperature(500.0);
        sim_closed.vehicle.set_brake_temperature(500.0);
        DriverInput cruise;
        cruise.throttle = 0.5; cruise.gear = 7; cruise.auto_clutch = true;
        for (int i = 0; i < 400; ++i) { sim_open.step(cruise); sim_closed.step(cruise); }
        test::check("closing brake ducts trims straight-line aero drag (-1.5%) while reducing disc convective cooling",
                    sim_closed.last.aero_drag_n < sim_open.last.aero_drag_n * 0.99 &&
                    sim_closed.last.wheels[FL].brake_temp_c > sim_open.last.wheels[FL].brake_temp_c + 8.0);

        // Verify GT3 & Hypercar class specs loaded heave springs, BMIG & carbon-ceramic brakes cleanly
        const CarConfig gt3 = load_car_config(std::string(RS_DATA_DIR) + "/cars/tornado_gt3.json");
        const CarConfig borealis = load_car_config(std::string(RS_DATA_DIR) + "/cars/aether_borealis.json");
        const CarConfig sp3 = load_car_config(std::string(RS_DATA_DIR) + "/cars/valenza_sp3.json");
        test::check("GT3 & flagship hypercar/supercar JSONs load heave springs, 2D aero maps, BMIG & carbon-ceramic brakes",
                    gt3.front.heave_spring_rate > 100000.0 && gt3.brake_migration_front > 0.02 &&
                    gt3.brake_thermal.disc_type == BrakeDiscType::CarbonCeramic &&
                    borealis.front.heave_spring_rate > 80000.0 && borealis.aero.map_2d.valid() &&
                    sp3.aero.map_2d.valid() && sp3.brake_thermal.disc_type == BrakeDiscType::CarbonCeramic);
    }

    // 11. Lock-Free 400 Hz Direct-Drive FFB Shaper & AsyncVehicleBridge SPSC Stream
    {
        rt::FfbShaperConfig fcfg;
        fcfg.gain = 1.0;
        fcfg.max_wheel_torque_nm = 15.0;
        fcfg.soft_clip_start = 0.80;
        VehicleOutput o_lin, o_knee, o_peak;
        o_lin.steering_column_torque_nm = 7.5;   // 50% -> strictly linear
        o_knee.steering_column_torque_nm = 15.0; // 100% -> softly compressed < 1.0
        o_peak.steering_column_torque_nm = 30.0; // 200% -> clipping flag set, smooth < 1.0
        const rt::FfbSample s_lin = rt::shape_ffb_sample(o_lin, 1, 0.0025, fcfg);
        const rt::FfbSample s_knee = rt::shape_ffb_sample(o_knee, 2, 0.0050, fcfg);
        const rt::FfbSample s_peak = rt::shape_ffb_sample(o_peak, 3, 0.0075, fcfg);
        test::check("Direct-Drive FFB shaper is linear below knee and C^1 soft-clips smoothly without flat-topping",
                    std::abs(s_lin.normalized - 0.5f) < 1e-4f && !s_lin.clipping &&
                    s_knee.normalized > 0.90f && s_knee.normalized < 0.98f &&
                    s_peak.clipping && s_peak.normalized > s_knee.normalized && s_peak.normalized <= 1.0f);

        Vehicle v_ffb(base_cfg);
        v_ffb.chassis_dynamics().kingpin_3d_ffb_enabled = true;
        v_ffb.chassis_dynamics().elastic_column_enabled = true;
        Controls ctrl(v_ffb.config());
        ue5::AsyncVehicleBridge bridge(v_ffb, ctrl);
        ChassisState cs;
        cs.position = {0.0, 0.0, base_cfg.cg_height};
        cs.velocity = {35.0, 0.0, 0.0};
        bridge.seed_rays(cs, 1);
        bridge.fetch_rays();
        auto& gf = bridge.ground_write_buffer();
        gf.rays_per_wheel = 1;
        gf.has_strips = false;
        for (int w = 0; w < 4; ++w) {
            gf.planes[w][0].hit = true;
            gf.planes[w][0].point = {bridge.current_rays().rays[w][0].origin.x, bridge.current_rays().rays[w][0].origin.y, 0.0};
            gf.planes[w][0].normal = {0.0, 0.0, 1.0};
        }
        bridge.publish_ground();
        rt::VehicleCommand cmd;
        cmd.core_controls = false;
        cmd.direct.steer = 0.25;
        cmd.direct.gear = 4;
        bridge.submit_command(cmd);
        for (int i = 0; i < 8; ++i) bridge.step(cs, 0.0025);
        std::size_t drained = 0;
        float last_norm = 0.0f;
        bridge.drain_ffb_samples([&](const rt::FfbSample& s) {
            ++drained;
            last_norm = s.normalized;
        });
        test::check("AsyncVehicleBridge pushes every 400 Hz physics tick into lock-free Direct-Drive FFB ring",
                    drained == 8 && std::abs(last_norm) > 0.01f);
    }

    // 17. Cold-tyre glass-transition micro-steps, deeper cold-slick drop, out-lap skin-over-core decoupling,
    //     3-rib independent camber wear & cord-through delamination/puncture
    {
        CarConfig cfg = load_car_config(test::data_path("cars/tornado_gt3.json"));
        const TireParams& tp = cfg.tire_front;

        TireCondition cold_slick, warm_slick, skin_hot_core_cold;
        cold_slick.temperature_c = cold_slick.surface_c = cold_slick.flash_c = 25.0;
        cold_slick.inner_c = cold_slick.middle_c = cold_slick.outer_c = 25.0;
        warm_slick.temperature_c = warm_slick.surface_c = warm_slick.flash_c = 90.0;
        warm_slick.inner_c = warm_slick.middle_c = warm_slick.outer_c = 90.0;
        skin_hot_core_cold.temperature_c = 30.0;
        skin_hot_core_cold.surface_c = skin_hot_core_cold.inner_c = skin_hot_core_cold.middle_c = skin_hot_core_cold.outer_c = 72.0;
        skin_hot_core_cold.flash_c = 78.0;

        TireCondition uniform_72 = warm_slick;
        uniform_72.temperature_c = uniform_72.surface_c = uniform_72.inner_c = uniform_72.middle_c = uniform_72.outer_c = 72.0;

        const double g_cold = cold_slick.grip_factor(&tp);
        const double g_warm = warm_slick.grip_factor(&tp);
        const double g_skin = skin_hot_core_cold.grip_factor(&tp);
        const double g_unif = uniform_72.grip_factor(&tp);
        test::check("stone-cold no-warmer slick (25 C) loses 25-33% grip vs warm (90 C)",
                    g_cold >= 0.67 && g_cold <= 0.76 && g_warm > 0.999);
        test::check("out-lap warm skin (72 C) over cold carcass (30 C) grips less than uniformly warmed tyre",
                    g_skin < g_unif - 0.08);
        test::check("cold slick exhibits steeper glass-transition post-peak breakaway shape than warm slick",
                    cold_slick.cold_glassiness(&tp) > 0.8 && cold_slick.post_peak_shape_scale(&tp) > warm_slick.post_peak_shape_scale(&tp) + 0.08);

        // Deterministic stick-slip micro-steps across wheel rotation on cold slick vs zero chatter on warm slick
        double max_cold_chatter = 0.0, min_cold_chatter = 0.0, max_warm_chatter = 0.0;
        for (int i = 0; i < 40; ++i) {
            TireOperating op;
            op.enable_mf62_hybrid = true;
            op.rolling_speed_mps = 35.0;
            op.slip_speed = 4.5;
            op.wheel_angle_rad = i * 0.04;
            op.condition = &cold_slick;
            const TireForces fc = magic_formula(tp, 0.0, 0.16, 4500.0, g_cold, -0.04, op);
            max_cold_chatter = std::max(max_cold_chatter, fc.cold_micro_step_chatter);
            min_cold_chatter = std::min(min_cold_chatter, fc.cold_micro_step_chatter);
            op.condition = &warm_slick;
            const TireForces fw = magic_formula(tp, 0.0, 0.16, 4500.0, g_warm, -0.04, op);
            max_warm_chatter = std::max(max_warm_chatter, std::abs(fw.cold_micro_step_chatter));
        }
        test::check("cold slick generates bidirectional stick-slip micro-steps near/past limit while warm slick has zero chatter",
                    max_cold_chatter > 0.35 && min_cold_chatter < -0.35 && max_warm_chatter < 1e-9);

        // 3-rib independent camber wear & cord-through delamination/puncture
        TireCondition camber_tyre = warm_slick;
        camber_tyre.pressure_kpa = tp.p_nominal_kpa;
        // Heavy negative camber (-4.5 deg top-inward on left wheel -> gamma = +0.0785 rad when side_sign = -1? top_inward = side_sign * gamma -> gamma = -0.0785 for side_sign = -1!)
        for (int i = 0; i < 200; ++i) {
            camber_tyre.update_zones(18000.0, 4200.0, 50.0, -0.0785, 0.0, -1.0, 150.0, i * 0.2, 0.1, &tp);
        }
        test::check("heavy negative camber wears inner tread rib substantially faster than outer rib",
                    camber_tyre.wear_inner > camber_tyre.wear_outer * 1.45 && camber_tyre.wear_inner > 0.01);

        // Push inner rib to cord exposure (>= 98.5%) and verify corded flag + delamination puncture leak
        camber_tyre.wear_inner = 0.99;
        camber_tyre.wear_middle = 0.55;
        camber_tyre.wear_outer = 0.45;
        camber_tyre.wear = (camber_tyre.wear_inner + camber_tyre.wear_middle + camber_tyre.wear_outer) / 3.0;
        camber_tyre.last_wear_ = camber_tyre.wear;
        camber_tyre.update_zones(12000.0, 4000.0, 45.0, -0.05, 0.0, -1.0, 135.0, 1.0, 0.25, &tp);
        test::check("wearing a single rib through to cords sets corded=true and opens progressive delamination puncture leak",
                    camber_tyre.corded && camber_tyre.puncture_leak_rate >= 0.05 && camber_tyre.grip_factor(&tp) < 0.78);
    }
}
