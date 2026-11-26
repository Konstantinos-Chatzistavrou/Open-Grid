// Ultra-realistic 3D multi-car slipstream, crosswind-advected wakes, bidirectional tandem push-draft,
// side-drafting, Bernoulli wheel-to-wheel suction, dirty-air balance shift, unsteady Strouhal wake buffeting,
// thermal radiator/IAT/brake-duct wake starvation, and 6-DOF single-car aerodynamics tests.
#include <cmath>
#include <memory>
#include <vector>

#include "rs/sim.hpp"
#include "harness.hpp"

using namespace rs;

RS_TEST(ultra_aero_slipstream) {
    CarConfig cfg = load_car_config(std::string(RS_DATA_DIR) + "/cars/vela_gt.json");
    auto flat = std::make_shared<PlaneGround>();

    const Vec3 my_pos{0.0, 0.0, 0.0};
    const Vec3 my_fwd{1.0, 0.0, 0.0};
    const Vec3 my_vel{65.0, 0.0, 0.0}; // 234 km/h

    auto make_car = [](Vec3 pos, double speed = 65.0, double cdA = 0.68, double clA = 0.85) {
        AeroTrafficCar c;
        c.position = pos;
        c.velocity = {speed, 0.0, 0.0};
        c.forward = {1.0, 0.0, 0.0};
        c.drag_area = cdA;
        c.lift_area = clA;
        return c;
    };

    // 1. Clean air baseline vs 1-car slipstream vs 2-car & 3-car drafting train stacking
    {
        const AeroWakeState clean = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {});
        const AeroWakeState one = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {
            make_car({10.0, 0.0, 0.0})
        });
        const AeroWakeState two = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {
            make_car({10.0, 0.0, 0.0}),
            make_car({22.0, 0.0, 0.0})
        });
        const AeroWakeState three = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {
            make_car({10.0, 0.0, 0.0}),
            make_car({22.0, 0.0, 0.0}),
            make_car({34.0, 0.0, 0.0})
        });
        test::check("clean air has neutral drag_scale == 1.0 and clean downforce == 1.0",
                    clean.drag_scale == 1.0 && clean.dirty_air_front_downforce_scale == 1.0 &&
                    clean.dirty_air_rear_downforce_scale == 1.0 && clean.cooling_airflow_scale == 1.0);
        test::check("multi-car drafting train stacks deeper than single car (1-car < 0.76, 2-car < 1-car, 3-car < 2-car)",
                    one.drag_scale < 0.76 && two.drag_scale < one.drag_scale - 0.025 &&
                    three.drag_scale < two.drag_scale - 0.005 && three.drag_scale >= 0.58);
        test::check("dirty air cuts front downforce more sharply than rear (authentic cornering understeer)",
                    one.dirty_air_front_downforce_scale < 0.72 &&
                    one.dirty_air_rear_downforce_scale < 0.92 &&
                    one.dirty_air_front_downforce_scale < one.dirty_air_rear_downforce_scale - 0.10);
    }

    // 2. Crosswind-advected slipstream cone shifts downwind (driver must offset downwind to keep peak tow!)
    {
        const Vec3 crosswind{0.0, 12.0, 0.0}; // 12 m/s wind blowing toward +Y (left)
        const std::vector<AeroTrafficCar> lead = {make_car({20.0, 0.0, 0.0}, 50.0)};
        // Directly behind lead car (y = 0) vs offset downwind (y = +2.6 m) vs upwind (y = -2.6 m)
        const AeroWakeState straight_behind = Vehicle::compute_aero_wake_field({0.0, 0.0, 0.0}, {50.0, 0.0, 0.0}, my_fwd, lead, crosswind);
        const AeroWakeState offset_downwind = Vehicle::compute_aero_wake_field({0.0, 2.6, 0.0}, {50.0, 0.0, 0.0}, my_fwd, lead, crosswind);
        const AeroWakeState offset_upwind   = Vehicle::compute_aero_wake_field({0.0, -2.6, 0.0}, {50.0, 0.0, 0.0}, my_fwd, lead, crosswind);
        test::check("crosswind drifts slipstream downwind: downwind lane has stronger tow than center & upwind",
                    offset_downwind.drag_scale < straight_behind.drag_scale - 0.08 &&
                    offset_upwind.drag_scale > 0.99);
    }

    // 3. Bidirectional tandem push-draft: trailing car tucked behind our rear bumper relieves LEAD car drag!
    {
        const AeroWakeState pushed = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {
            make_car({-5.5, 0.0, 0.0})
        });
        test::check("bidirectional tandem push-draft gives lead car -6..-13% drag relief",
                    pushed.tandem_push_drag_delta < -0.08 && pushed.drag_scale < 0.92 &&
                    pushed.dirty_air_front_downforce_scale == 1.0);
    }

    // 4. Side-drafting (drag spike on leader + aero-loose rear wash; slight drag assist for attacking car) & Bernoulli suction
    {
        const AeroWakeState being_sidedrafted = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {
            make_car({-2.8, 2.35, 0.0}) // rival tucked alongside our left-rear quarter
        });
        const AeroWakeState attacking_sidedraft = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {
            make_car({+2.8, 2.35, 0.0}) // our nose tucked alongside rival's right-rear quarter
        });
        const AeroWakeState wheel_to_wheel_left = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {
            make_car({0.0, 2.30, 0.0}) // directly beside our left door
        });
        test::check("being side-drafted spikes drag (+5..+11%) and reduces rear downforce (aero loose)",
                    being_sidedrafted.side_draft_drag_delta > 0.06 &&
                    being_sidedrafted.drag_scale > 1.06 &&
                    being_sidedrafted.dirty_air_rear_downforce_scale < 0.95);
        test::check("attacking side-draft gives slight drag assist to the passing car",
                    attacking_sidedraft.side_draft_drag_delta < -0.025 &&
                    attacking_sidedraft.drag_scale < 0.98);
        test::check("wheel-to-wheel pass generates Bernoulli lateral Venturi suction pulling toward the adjacent car",
                    wheel_to_wheel_left.lateral_suction_n > 60.0 && wheel_to_wheel_left.lateral_suction_n <= 420.0);
    }

    // 5. Thermal wake raises IAT, slows oil/coolant & brake-disc cooling vs clean air
    {
        Simulation sim_clean(cfg, flat), sim_draft(cfg, flat);
        sim_clean.vehicle.atmosphere().enabled = true;
        sim_draft.vehicle.atmosphere().enabled = true;
        sim_clean.vehicle.aero_wake().yaw_aero_enabled = true;
        sim_draft.vehicle.aero_wake().yaw_aero_enabled = true;
        sim_clean.vehicle.engine_systems().turbo_stage = 2;
        sim_draft.vehicle.engine_systems().turbo_stage = 2;
        sim_clean.reset({}, 0.0, 60.0, 7);
        sim_draft.reset({}, 0.0, 60.0, 7);
        sim_clean.vehicle.set_brake_temperature(420.0);
        sim_draft.vehicle.set_brake_temperature(420.0);

        AeroWakeState hot_wake = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {make_car({9.0, 0.0, 0.0})});
        hot_wake.yaw_aero_enabled = true;
        test::check("close draft produces hot wake air (> +6 C) and cooling starvation (< 0.80)",
                    hot_wake.hot_air_delta_c > 6.0 && hot_wake.cooling_airflow_scale < 0.80);

        DriverInput wot;
        wot.throttle = 1.0;
        wot.gear = 7;
        wot.auto_clutch = true;
        for (int i = 0; i < 1000; ++i) { // 2.5 s at 400 Hz in 6th gear (5540 RPM, well below redline)
            hot_wake.wake_phase_s = i * 0.0025;
            sim_draft.vehicle.aero_wake() = hot_wake;
            sim_clean.step(wot);
            sim_draft.step(wot);
        }
        test::check("thermal wake raises IAT, oil/coolant temperatures & slows hot brake-disc cooling vs clean air",
                    sim_draft.last.intake_air_temp_c > sim_clean.last.intake_air_temp_c + 2.0 &&
                    sim_draft.last.oil_temp_c > sim_clean.last.oil_temp_c + 0.05 &&
                    sim_draft.vehicle.engine_systems().coolant_temp_c > sim_clean.vehicle.engine_systems().coolant_temp_c + 0.01 &&
                    sim_draft.last.wheels[FL].brake_temp_c > sim_clean.last.wheels[FL].brake_temp_c + 3.0);
        const double drag_per_v2_clean = sim_clean.last.aero_drag_n / (sim_clean.last.speed * sim_clean.last.speed);
        const double drag_per_v2_draft = sim_draft.last.aero_drag_n / (sim_draft.last.speed * sim_draft.last.speed);
        test::check("slipstream cuts aero drag coefficient & accelerates car faster than clean air at 216+ km/h",
                    sim_draft.last.speed > sim_clean.last.speed + 0.45 &&
                    drag_per_v2_draft < drag_per_v2_clean * 0.78);
    }

    // 6. Unsteady Strouhal wake vortex buffeting injects deterministic yaw/roll/heave & FFB steering nibble
    {
        Vehicle veh(cfg);
        veh.aero_wake().yaw_aero_enabled = true;
        veh.reset_motion(65.0, 5);
        ChassisState cs;
        cs.position = {0.0, 0.0, cfg.cg_height};
        cs.velocity = {65.0, 0.0, 0.0};
        std::array<WheelContact, 4> contacts{};
        const auto rays = veh.wheel_rays(cs);
        for (int w = 0; w < 4; ++w) {
            contacts[w].hit = true;
            contacts[w].point = {rays[w].origin.x, rays[w].origin.y, 0.0};
            contacts[w].distance = rays[w].origin.z;
            contacts[w].normal = {0.0, 0.0, 1.0};
        }
        veh.aero_wake() = Vehicle::compute_aero_wake_field(my_pos, my_vel, my_fwd, {make_car({9.0, 0.5, 0.0})}, {}, 0.12);
        veh.aero_wake().yaw_aero_enabled = true;
        const VehicleOutput o1 = veh.update(cs, contacts, 0.0025);
        veh.aero_wake().wake_phase_s = 0.18;
        const VehicleOutput o2 = veh.update(cs, contacts, 0.0025);
        test::check("unsteady vortex buffeting varies aero yaw moment & FFB steer torque deterministically across phase",
                    o1.wake_turbulence > 0.45 &&
                    std::abs(o1.aero_yaw_moment_nm - o2.aero_yaw_moment_nm) > 25.0 &&
                    std::abs(o1.steer_torque - o2.steer_torque) > 0.5);
    }

    // 7. 6-DOF Single-Car Aerodynamics: still-air yaw side-force, >45 deg spin roof lift, roll seal loss, drag pitch & heave damping
    {
        Vehicle v_base(cfg), v_yaw(cfg), v_spin(cfg), v_roll(cfg), v_heave(cfg);
        for (Vehicle* vp : {&v_base, &v_yaw, &v_spin, &v_roll, &v_heave}) {
            vp->aero_wake().yaw_aero_enabled = true;
            vp->reset_motion(60.0, 5);
        }
        std::array<WheelContact, 4> no_contact{}; // pure airborne aero check (zero tyre noise!)

        ChassisState cs_base;
        cs_base.position = {0.0, 0.0, 2.0};
        cs_base.velocity = {60.0, 0.0, 0.0};
        const VehicleOutput out_base = v_base.update(cs_base, no_contact, 0.0025);

        // Still-air 15 deg sideslip (zero ambient wind!)
        ChassisState cs_yaw = cs_base;
        cs_yaw.velocity = {60.0 * std::cos(0.26), 60.0 * std::sin(0.26), 0.0};
        const VehicleOutput out_yaw = v_yaw.update(cs_yaw, no_contact, 0.0025);

        // High-speed 110 deg spin (backward/sideways slide -> greenhouse roof lift!)
        ChassisState cs_spin = cs_base;
        cs_spin.velocity = {-20.0, 56.5, 0.0};
        const VehicleOutput out_spin = v_spin.update(cs_spin, no_contact, 0.0025);

        // 12 deg body roll -> ground-effect undertray seal loss
        ChassisState cs_roll = cs_base;
        cs_roll.orientation = Quat::from_axis_angle({1.0, 0.0, 0.0}, 0.21);
        const VehicleOutput out_roll = v_roll.update(cs_roll, no_contact, 0.0025);

        // Downward heave velocity (-4 m/s) -> aerodynamic heave damping reduces downforce (upward damping force)
        ChassisState cs_heave = cs_base;
        cs_heave.velocity = {60.0, 0.0, -4.0};
        const VehicleOutput out_heave = v_heave.update(cs_heave, no_contact, 0.0025);

        test::check("still-air yaw produces lateral aero side-force & weathercocking yaw moment without ambient wind",
                    out_yaw.aero_side_force_n < -200.0 && std::abs(out_yaw.aero_yaw_moment_nm) > 20.0);
        test::check("high-speed spin (>45 deg yaw) sheds downforce and generates upward greenhouse roof lift",
                    out_spin.aero_downforce_front_n + out_spin.aero_downforce_rear_n < 0.0);
        test::check("body roll leaks ground-effect undertray seal (less downforce than flat attitude)",
                    out_roll.aero_downforce_front_n + out_roll.aero_downforce_rear_n <
                    (out_base.aero_downforce_front_n + out_base.aero_downforce_rear_n) * 0.97);
        test::check("drag line-of-action above CG generates nose-up pitching torque (-Y in body frame)",
                    out_base.torque.y < -40.0);
        test::check("unsteady downward heave velocity reduces downforce (dissipative aerodynamic heave damping)",
                    out_heave.aero_downforce_front_n < out_base.aero_downforce_front_n * 0.97);
    }
}
