// Multi-point 4x4 contact patch, 3-node thermal & gas-law pressure, Stribeck sliding friction,
// and physically grounded steady-state drift verification.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <memory>
#include "harness.hpp"
#include "rs/sim.hpp"
#include "rs/street_surface.hpp"
#include "rs/telemetry.hpp"
#include "rs/tire.hpp"
#include "rs/ue5_bridge.hpp"

using namespace rs;

RS_TEST(tire_patch) {
    const CarConfig cfg = test::car();
    const TireParams& p = cfg.tire_front;
    const double deg = kPi / 180.0;

    // =========================================================================
    // 1. Flat-road 4x4 grid calibration against fitted Pacejka MF curves
    // =========================================================================
    {
        double max_rel_err_fy = 0.0;
        double max_rel_err_fx = 0.0;
        double max_rel_err_fy_camber = 0.0;

        for (double fz : {2500.0, 4000.0, 6500.0}) {
            for (double a_deg = 0.5; a_deg <= 24.0; a_deg += 0.5) {
                const double a = a_deg * deg;
                TireOperating op;
                op.slip_speed = p.lmuv_ref_mps;
                op.force_full_patch_grid = true;
                ContactPatchOutput po;
                op.patch_out = &po;
                const TireForces tf = evaluate_contact_patch_grid(p, 0.0, std::tan(a), fz, 1.0, 0.0, op);
                const double ref = mf_pure_fy(p, a, fz, 1.0, 0.0, 0.0);
                const double rel = std::abs(tf.fy - ref) / std::max(std::abs(ref), 50.0);
                max_rel_err_fy = std::max(max_rel_err_fy, rel);
                if (a_deg == 4.0 && fz == 4000.0) {
                    double fz_sum = 0.0;
                    for (double c : po.cell_fz) fz_sum += c;
                    test::check("4x4 grid conserves total vertical load on flat road",
                                std::abs(fz_sum - fz) < 1e-6 && po.loaded_cells == 16 && po.used_full_grid);
                }

                // Also check with -2.5 deg realistic road camber
                const TireForces tf_c = evaluate_contact_patch_grid(p, 0.0, std::tan(a), fz, 1.0, -2.5 * deg, op);
                const double ref_c = mf_pure_fy(p, a, fz, 1.0, -2.5 * deg, 0.0);
                const double rel_c = std::abs(tf_c.fy - ref_c) / std::max(std::abs(ref_c), 100.0);
                max_rel_err_fy_camber = std::max(max_rel_err_fy_camber, rel_c);
            }
            for (double k = 0.01; k <= 0.45; k += 0.02) {
                TireOperating op;
                op.slip_speed = p.lmuv_ref_mps;
                op.force_full_patch_grid = true;
                const TireForces tf = evaluate_contact_patch_grid(p, k, 0.0, fz, 1.0, 0.0, op);
                const double ref = mf_pure_fx(p, k, fz, 1.0, 0.0, 0.0);
                const double rel = std::abs(tf.fx - ref) / std::max(std::abs(ref), 50.0);
                max_rel_err_fx = std::max(max_rel_err_fx, rel);
            }
        }

        // Check brush adhesion ratio progression (high in grip, collapses in slide)
        TireOperating op_adh;
        op_adh.slip_speed = p.lmuv_ref_mps;
        op_adh.force_full_patch_grid = true;
        const double adh_1deg = evaluate_contact_patch_grid(p, 0.0, std::tan(1.0 * deg), 4000.0, 1.0, 0.0, op_adh).adhesion_ratio;
        const double adh_20deg = evaluate_contact_patch_grid(p, 0.0, std::tan(20.0 * deg), 4000.0, 1.0, 0.0, op_adh).adhesion_ratio;

        std::printf("         flat-road 4x4 max error vs fitted MF: Fy %.4f%%, Fx %.4f%%, Fy(-2.5 deg camber) %.3f%%; adhesion 1deg=%.3f -> 20deg=%.3f\n",
                    max_rel_err_fy * 100.0, max_rel_err_fx * 100.0, max_rel_err_fy_camber * 100.0, adh_1deg, adh_20deg);
        test::check("flat-road 4x4 grid matches fitted MF Fy within 0.5%", max_rel_err_fy < 0.005);
        test::check("flat-road 4x4 grid matches fitted MF Fx within 0.5%", max_rel_err_fx < 0.005);
        test::check("flat-road 4x4 grid with -2.5 deg camber matches fitted MF Fy within 2.5%", max_rel_err_fy_camber < 0.025);
        test::check("brush adhesion ratio transitions from grip (>0.85 at 1 deg) to sliding (<0.20 at 20 deg)",
                    adh_1deg > 0.85 && adh_20deg < 0.20);
    }

    // =========================================================================
    // 2. Kerb under half the contact patch width + partial drop-off + GroundStrip
    // =========================================================================
    {
        const double fz = 4000.0;
        TireOperating op_flat, op_kerb, op_drop;
        op_flat.slip_speed = op_kerb.slip_speed = op_drop.slip_speed = p.lmuv_ref_mps;
        op_flat.force_full_patch_grid = true;

        // 15 mm painted kerb (mu=0.92) under left half of contact patch (cols 2 & 3, +y)
        ContactPatchProfile kerb;
        kerb.has_height_map = true;
        for (int i = 0; i < kPatchRows; ++i) {
            for (int j = 0; j < kPatchCols; ++j) {
                const int idx = i * kPatchCols + j;
                if (j >= 2) {
                    kerb.road_dz_m[idx] = 0.015;
                    kerb.mu_cell[idx] = 0.92;
                } else {
                    kerb.road_dz_m[idx] = 0.0;
                    kerb.mu_cell[idx] = 1.0;
                }
            }
        }
        op_kerb.patch = &kerb;

        // Partial contact: right half (cols 0 & 1) hanging off a ledge (no ground)
        ContactPatchProfile drop;
        drop.has_height_map = true;
        for (int i = 0; i < kPatchRows; ++i) {
            for (int j = 0; j < kPatchCols; ++j) {
                drop.contact_mask[i * kPatchCols + j] = (j >= 2);
            }
        }
        op_drop.patch = &drop;

        ContactPatchOutput po_flat, po_kerb, po_drop;
        op_flat.patch_out = &po_flat;
        op_kerb.patch_out = &po_kerb;
        op_drop.patch_out = &po_drop;

        // Cornering at peak slip angle (~9 deg)
        const TireForces f_flat_lat = evaluate_contact_patch_grid(p, 0.0, std::tan(9.0 * deg), fz, 1.0, 0.0, op_flat);
        const TireForces f_kerb_lat = evaluate_contact_patch_grid(p, 0.0, std::tan(9.0 * deg), fz, 1.0, 0.0, op_kerb);
        const TireForces f_drop_lat = evaluate_contact_patch_grid(p, 0.0, std::tan(9.0 * deg), fz, 1.0, 0.0, op_drop);

        double kerb_side_load = 0.0, road_side_load = 0.0;
        for (int i = 0; i < kPatchRows; ++i) {
            for (int j = 0; j < kPatchCols; ++j) {
                if (j >= 2) kerb_side_load += po_kerb.cell_fz[i * kPatchCols + j];
                else road_side_load += po_kerb.cell_fz[i * kPatchCols + j];
            }
        }

        // Braking on half-kerb (-10% slip): concentrated braking at +y pulls steering left (+Mz)
        const TireForces f_flat_brk = evaluate_contact_patch_grid(p, -0.10, 0.0, fz, 1.0, 0.0, op_flat);
        const TireForces f_kerb_brk = evaluate_contact_patch_grid(p, -0.10, 0.0, fz, 1.0, 0.0, op_kerb);

        std::printf("         half-patch 15mm kerb load: kerb=%.0f N (%.1f%%), road=%.0f N; Fy flat=%.0f -> kerb=%.0f -> drop=%.0f N; braking Mz flat=%.1f -> kerb=%.1f Nm\n",
                    kerb_side_load, 100.0 * kerb_side_load / fz, road_side_load,
                    f_flat_lat.fy, f_kerb_lat.fy, f_drop_lat.fy, f_flat_brk.mz, f_kerb_brk.mz);

        test::check("half-patch kerb concentrates >75% of vertical load onto kerb cells",
                    kerb_side_load > 0.75 * fz && std::abs((kerb_side_load + road_side_load) - fz) < 1e-6);
        test::check("half-patch kerb reduces peak lateral force plausibly via load sensitivity & kerb mu",
                    f_kerb_lat.fy < f_flat_lat.fy * 0.94 && f_kerb_lat.fy > f_flat_lat.fy * 0.70);
        test::check("partial-contact drop-off loads only 8 cells and reduces peak lateral grip",
                    po_drop.loaded_cells == 8 && f_drop_lat.fy < f_flat_lat.fy * 0.94 && f_drop_lat.fy > f_flat_lat.fy * 0.72);
        test::check("asymmetric braking on half-kerb generates physical kerb-pull steering torque Mz",
                    f_kerb_brk.mz > f_flat_brk.mz + 25.0);

        // GroundStrip -> ContactPatchProfile bridge test
        ue5::GroundStrip strip;
        strip.origin = {0.0, 0.0, 0.6};
        strip.along = {1, 0, 0};
        strip.across = {0, 1, 0};
        strip.spacing = 0.05;
        strip.lane_spacing = 0.07;
        strip.resize(5, 16);
        for (int l = 0; l < strip.lanes; ++l) {
            for (int i = 0; i < strip.count; ++i) {
                const Vec3 pos = strip.position(l, i);
                ue5::GroundSample g;
                g.hit = true;
                const bool on_kerb = (pos.y > 0.01);
                g.point = {pos.x, pos.y, on_kerb ? 0.020 : 0.0};
                g.normal = {0, 0, 1};
                g.surface = on_kerb ? cfg.surface_index("kerb") : cfg.surface_index("asphalt");
                strip.at(l, i) = g;
            }
        }
        WheelRay center_ray{{0.30, 0.0, 0.6}, {0, 0, -1}, 0.7};
        ContactPatchProfile strip_prof;
        const bool filled = strip.fill_patch_profile(center_ray, {1, 0, 0}, {0, 1, 0}, 0.095, 0.105,
                                                     {0.30, 0.0, 0.0}, {0, 0, 1}, &cfg, strip_prof);
        test::check("GroundStrip populates 4x4 ContactPatchProfile with kerb elevation and per-cell mu",
                    filled && strip_prof.has_height_map && strip_prof.road_dz_m[3] > 0.015 && strip_prof.mu_cell[3] < 0.95);
    }

    // =========================================================================
    // 3. Explicit 3-node thermal (surface <-> carcass <-> inner air) & gas law
    // =========================================================================
    {
        TireCondition tc;
        tc.set_environment_celsius(20.0, 20.0);
        tc.surface_c = tc.inner_c = tc.middle_c = tc.outer_c = tc.flash_c = 20.0;
        tc.temperature_c = 20.0;
        tc.inner_air_c = 20.0;
        tc.update(0.0, 4000.0, 0.0, 1e-4, &p);

        const double p_cold = tc.pressure_kpa;
        const double dpi_cold = tc.dpi(p);
        const double len_cold = 2.0 * contact_patch_half_length(p, 4000.0, dpi_cold);
        const double crr_cold = rolling_resistance_coeff(p, 30.0, dpi_cold);

        test::check("cold inner air (20 C) produces exact cold set pressure via ideal gas law",
                    std::abs(p_cold - p.p_cold_kpa) < 0.15);

        // Heat tyre via 25 s of energetic cornering/sliding (20 kW slip power, 4000 N, 30 m/s)
        for (int i = 0; i < 500; ++i) {
            tc.update_zones(20000.0, 4000.0, 30.0, -0.04, 2400.0, -1.0, 92.0, i * 0.4, 0.05, &p);
        }
        const double expected_p_gas = (p.p_cold_kpa + 101.325) * (tc.inner_air_c + 273.15) / 293.15 - 101.325;
        const double dpi_hot = tc.dpi(p);
        const double len_hot = 2.0 * contact_patch_half_length(p, 4000.0, dpi_hot);
        const double crr_hot = rolling_resistance_coeff(p, 30.0, dpi_hot);

        std::printf("         3-node thermal after 25s @ 20kW: surf=%.1f C, carcass=%.1f C, air=%.1f C; P %.1f -> %.1f kPa; patch_len %.1f -> %.1f mm; Crr %.4f -> %.4f\n",
                    tc.surface_c, tc.carcass_c(), tc.inner_air_c, p_cold, tc.pressure_kpa,
                    len_cold * 1000.0, len_hot * 1000.0, crr_cold, crr_hot);

        // Heat flows surface -> carcass -> inner air -> ambient (20 C); the air warms only through the carcass, so after
        // 25 s it has risen ~10 C (the carcass ~20 C: energy balance, no pull toward a set running temperature).
        test::check("3-node thermal gradient: surface > carcass > inner air > ambient",
                    tc.surface_c > tc.carcass_c() + 5.0 && tc.carcass_c() > tc.inner_air_c + 3.0 && tc.inner_air_c > 25.0);
        test::check("inflation pressure obeys ideal gas law directly from inner_air_c",
                    std::abs(tc.pressure_kpa - expected_p_gas) < 1e-6 && tc.pressure_kpa > p_cold + 5.0);
        test::check("higher inflation pressure shortens contact patch length 2a",
                    len_hot < len_cold - 0.003);
        test::check("higher inflation pressure lowers rolling resistance C_rr",
                    crr_hot < crr_cold && rolling_resistance_coeff(p, 30.0, 0.10) < rolling_resistance_coeff(p, 30.0, 0.0) * 0.97);

        // Immediate surface overheating grip loss (greasy rubber) with carcass unchanged
        TireCondition cool_surf, hot_surf;
        cool_surf.temperature_c = hot_surf.temperature_c = 90.0;
        cool_surf.surface_c = 90.0;
        hot_surf.surface_c = 165.0;
        const double g_cool = cool_surf.grip_factor(&p);
        const double g_hot = hot_surf.grip_factor(&p);
        test::check("overheated surface (165 C) reduces grip immediately (greasy tread)",
                    g_hot < g_cool * 0.90);
    }

    // =========================================================================
    // 4. Smooth continuous Stribeck sliding friction transition vs sliding speed
    // =========================================================================
    {
        constexpr int kSteps = 300;
        constexpr double dv = 0.1; // 0.0 .. 30.0 m/s
        double prev = stribeck_friction_factor(p, 0.0);
        double prev_d = 0.0;
        double max_jump = 0.0;
        double max_d2 = 0.0;
        bool monotone = true;
        double prev_fy = 0.0;
        double max_fy_jump = 0.0;

        for (int i = 0; i <= kSteps; ++i) {
            const double vs = i * dv;
            const double cur = stribeck_friction_factor(p, vs);
            TireOperating op;
            op.slip_speed = vs;
            const double fy = magic_formula(p, 0.0, std::tan(18.0 * deg), 4000.0, 1.0, 0.0, op).fy;
            if (i > 0) {
                if (cur > prev + 1e-12) monotone = false;
                const double d1 = cur - prev;
                max_jump = std::max(max_jump, std::abs(d1));
                if (i > 1) max_d2 = std::max(max_d2, std::abs(d1 - prev_d));
                prev_d = d1;
                max_fy_jump = std::max(max_fy_jump, std::abs(fy - prev_fy));
            }
            prev = cur;
            prev_fy = fy;
        }
        const double f0 = stribeck_friction_factor(p, 0.0);
        const double f5 = stribeck_friction_factor(p, 5.0);
        const double f15 = stribeck_friction_factor(p, 15.0);
        const double f25 = stribeck_friction_factor(p, 25.0);
        const double f15_hot = stribeck_friction_factor(p, 15.0, 155.0, 190.0);

        std::printf("         Stribeck curve: v=0:%.4f, v=5:%.4f, v=15:%.4f, v=25:%.4f, v=15(hot 155/190C):%.4f; max_step=%.5f, max_d2=%.6f, max_Fy_step=%.2f N\n",
                    f0, f5, f15, f25, f15_hot, max_jump, max_d2, max_fy_jump);

        test::check("Stribeck sliding friction is monotonically decreasing with sliding speed", monotone);
        test::check("Stribeck transition has no step discontinuity (max 0.1 m/s jump < 0.005, max d2 < 0.0005)",
                    max_jump < 0.005 && max_d2 < 0.0005 && max_fy_jump < 25.0);
        test::check("Stribeck produces smooth ~12-18% static->kinetic drop + thermal greasiness",
                    f25 < f0 * 0.88 && f25 > f0 * 0.78 && f15_hot < f15 * 0.94);
    }

    // =========================================================================
    // 5. Sustained steady-state drift (>= 3 s, NO arcade assists) with trace
    // =========================================================================
    {
        auto flat = std::make_shared<PlaneGround>(Vec3{0, 0, 1});
        Simulation sim(cfg, flat);
        sim.dt = 1.0 / 240.0;
        sim.vehicle.tire_zones_enabled = true;
        sim.vehicle.unsprung_dynamics_enabled = true;
        sim.vehicle.tire_patch_grid_enabled = true;
        // All electronic stability/traction assists OFF: pure tyre & chassis physics
        sim.vehicle.assists().abs = false;
        sim.vehicle.assists().tc = false;
        sim.vehicle.assists().esc = false;
        sim.reset({}, 0.0, 23.0, 3); // 82.8 km/h in 2nd gear (RWD Vela GT)

        // Settle briefly (0.25 s) rolling straight
        for (int i = 0; i < 60; ++i) {
            DriverInput in;
            in.throttle = 0.25;
            in.gear = 3;
            in.auto_clutch = true;
            sim.step(in);
        }

        // Phase A (0.0 .. 0.40 s): turn-in left + handbrake pull to initiate rear breakaway
        // Phase B (0.40 .. 5.20 s): release handbrake, modulate countersteer + throttle like a driver
        // targeting a steady 24 deg drift angle (beta < 0 for a left-hand drift: nose left of velocity vector).
        const double target_beta = -24.0 * deg; // rad (-24 deg sideslip = nose pointing left in left-hand drift)
        double drift_streak_s = 0.0;
        double max_drift_streak_s = 0.0;
        double steer_cmd = 0.0;
        double thr_cmd = 0.5;
        double min_beta_in_streak = 999.0, max_beta_in_streak = 0.0;
        double min_spd_in_streak = 999.0;

        std::printf("         [DRIFT TRACE] t(s) | speed(km/h) | beta(deg) | yaw(deg/s) | steer | thr | RL surf/carc/air(C) | RL P(kPa)\n");
        const int total_steps = 240 * 5 + 48; // 5.2 s
        for (int step = 0; step < total_steps; ++step) {
            const double t = step * sim.dt;
            const double beta = sim.last.sideslip;
            const double yaw = sim.last.yaw_rate;
            const double spd = std::hypot(sim.velocity_body().x, sim.velocity_body().y);

            DriverInput in;
            in.gear = 3; // hold 2nd gear (high torque for sustaining wheelspin)
            in.auto_clutch = true;

            if (t < 0.25) {
                // Turn in left
                steer_cmd = 0.55;
                thr_cmd = 0.45;
            } else if (t < 0.60) {
                // Handbrake flick initiation to break rear traction smoothly
                steer_cmd = 0.55;
                thr_cmd = 0.15;
                in.handbrake = 0.95;
            } else {
                // Physically realistic drift driver:
                //   1. Countersteer feedforward tracks front-axle velocity angle (beta + a * yaw / v)
                //      so the front wheels point into the slide like a real drifter.
                //   2. Feedback on drift-angle error & yaw rate modulates countersteer and throttle.
                const double v_eff = std::max(spd, 8.0);
                const double beta_front = beta + cfg.dist_cg_front * yaw / v_eff;
                const double max_delta = cfg.front.max_steer_deg * deg;
                const double beta_err = beta - target_beta; // >0: too little drift angle -> steer left / add gas
                const double desired_delta = beta_front + 0.085 + 1.35 * beta_err - 0.42 * (yaw - 0.52);
                const double desired_steer = clamp(desired_delta / max_delta, -0.95, 0.85);
                steer_cmd += (desired_steer - steer_cmd) * clamp(sim.dt / 0.03, 0.0, 1.0);

                // Throttle maintains rear wheelspin & balances drift angle (more gas = more angle, lift = tuck in)
                const double desired_thr = clamp(0.66 + 1.35 * beta_err - 0.25 * (yaw - 0.52), 0.20, 0.98);
                thr_cmd += (desired_thr - thr_cmd) * clamp(sim.dt / 0.05, 0.0, 1.0);
            }
            in.steer = steer_cmd;
            in.throttle = thr_cmd;
            sim.step(in);

            const double abs_beta_deg = std::abs(sim.last.sideslip) / deg;
            const bool in_drift = (t >= 0.55 && abs_beta_deg >= 12.0 && abs_beta_deg <= 48.0
                                   && sim.last.yaw_rate > 0.25 && spd > 10.0);
            if (in_drift) {
                drift_streak_s += sim.dt;
                if (drift_streak_s > max_drift_streak_s) {
                    max_drift_streak_s = drift_streak_s;
                    min_beta_in_streak = std::min(min_beta_in_streak, abs_beta_deg);
                    max_beta_in_streak = std::max(max_beta_in_streak, abs_beta_deg);
                    min_spd_in_streak = std::min(min_spd_in_streak, spd);
                }
            } else {
                drift_streak_s = 0.0;
            }

            if (step % 60 == 0) { // every 0.25 s
                const TireCondition& rl = sim.last.wheels[RL].condition;
                std::printf("           %4.2f | %11.1f | %9.1f | %10.1f | %+5.2f | %3.2f | %5.1f / %5.1f / %4.1f | %6.1f\n",
                            t, spd * 3.6, sim.last.sideslip / deg, sim.last.yaw_rate / deg,
                            in.steer, in.throttle, rl.surface_c, rl.carcass_c(), rl.inner_air_c, rl.pressure_kpa);
            }
        }
        const TireCondition& rl_end = sim.last.wheels[RL].condition;
        const TireCondition& fl_end = sim.last.wheels[FL].condition;
        std::printf("         sustained drift streak: %.2f s (beta range %.1f..%.1f deg, min speed %.1f km/h); RL surf %.1f C vs FL surf %.1f C\n",
                    max_drift_streak_s, min_beta_in_streak, max_beta_in_streak, min_spd_in_streak * 3.6,
                    rl_end.surface_c, fl_end.surface_c);
        test::check("sustained steady-state drift held for >= 3.0 s without spinning out",
                    max_drift_streak_s >= 3.0);
        test::check("rear tyres heat substantially above front tyres during sustained RWD drift",
                    rl_end.surface_c > fl_end.surface_c + 15.0);

        // Verify TelemetrySample exposes all 3 thermal nodes + pressure + patch length
        const TelemetrySample tel = make_telemetry_sample(sim.last, sim.body.state, sim.vehicle.input(), cfg, 5.2);
        // the drifting rear tyre's own state, passed through unchanged (and plausibly heated)
        test::check("TelemetrySample exposes surface, carcass, inner-air temps, pressure & patch length",
                    tel.tire_temp_c[RL] == rl_end.surface_c && tel.tire_carcass_temp_c[RL] == rl_end.temperature_c &&
                    tel.tire_inner_air_temp_c[RL] == rl_end.inner_air_c && tel.tire_pressure_kpa[RL] == rl_end.pressure_kpa &&
                    tel.tire_patch_length_m[RL] == rl_end.contact_patch_length_m &&
                    tel.tire_temp_c[RL] > tel.tire_carcass_temp_c[RL] && tel.tire_pressure_kpa[RL] > cfg.tire_rear.p_cold_kpa &&
                    tel.tire_patch_length_m[RL] > 0.10);
    }

    // =========================================================================
    // 6. 24-node deformable flexible-ring carcass (flattening, pressure, hyst)
    // =========================================================================
    {
        TireCondition ring_nom, ring_low_p, ring_fast;
        ring_nom.pressure_kpa = p.p_nominal_kpa;
        ring_low_p.pressure_kpa = 105.0; // severely under-inflated
        ring_fast.pressure_kpa = p.p_nominal_kpa;

        double ang = 0.0;
        for (int i = 0; i < 200; ++i) {
            ang += 95.0 * 0.001;
            ring_nom.step_carcass_ring(0.0, 5200.0, 4500.0, 95.0, ang, p.radius, 0.001, &p, nullptr);
            ring_low_p.step_carcass_ring(0.0, 5200.0, 4500.0, 95.0, ang, p.radius, 0.001, &p, nullptr);
        }
        // High-speed unloaded centrifugal expansion check (250 rad/s ~ 300 km/h)
        double ang_f = 0.0;
        for (int i = 0; i < 200; ++i) {
            ang_f += 250.0 * 0.001;
            ring_fast.step_carcass_ring(0.0, 0.0, 0.0, 250.0, ang_f, p.radius, 0.001, &p, nullptr);
        }
        double mean_ur_fast = 0.0;
        for (double u : ring_fast.carcass.u_r) mean_ur_fast += u / kCarcassNodes;

        // Straight rolling with zero lateral/longitudinal shear dissipates near-zero lateral/tangential flexing power
        TireCondition ring_straight;
        ring_straight.pressure_kpa = p.p_nominal_kpa;
        double ang_s = 0.0;
        for (int i = 0; i < 200; ++i) {
            ang_s += 75.0 * 0.001;
            ring_straight.step_carcass_ring(0.0, 0.0, 3600.0, 75.0, ang_s, p.radius, 0.001, &p, nullptr);
        }

        std::printf("         24-node carcass: nom nodes=%d patch=%.1f mm lat=%.1f mm hyst=%.0f W | low-P(105kPa) lat=%.1f mm rollover=%.2f hyst=%.0f W | 300km/h cent_ur=%.2f mm | straight hyst=%.1f W\n",
                    ring_nom.carcass.contact_nodes, ring_nom.carcass.deformed_patch_length_m * 1000.0,
                    ring_nom.carcass.contact_lateral_m * 1000.0, ring_nom.carcass_hysteresis_w,
                    ring_low_p.carcass.contact_lateral_m * 1000.0, ring_low_p.sidewall_rollover,
                    ring_low_p.carcass_hysteresis_w, mean_ur_fast * 1000.0, ring_straight.carcass_hysteresis_w);

        test::check("24-node carcass flattens into a multi-node contact footprint under load",
                    ring_nom.carcass.contact_nodes >= 2 && ring_nom.carcass.deformed_patch_length_m > 0.08 &&
                    ring_nom.carcass.contact_radial_max_m > 0.008);
        test::check("under-inflation softens lateral belt stiffness, increases rollover & flexing hysteresis",
                    std::abs(ring_low_p.carcass.contact_lateral_m) > std::abs(ring_nom.carcass.contact_lateral_m) * 1.25 &&
                    ring_low_p.sidewall_rollover > ring_nom.sidewall_rollover + 0.15 &&
                    ring_low_p.carcass_hysteresis_w > ring_nom.carcass_hysteresis_w * 1.25);
        test::check("high-speed rotation expands flexible carcass ring radially outward by ~1.5-5.5 mm at 300 km/h",
                    mean_ur_fast < -0.0015 && mean_ur_fast > -0.0055);
        test::check("viscoelastic flexing hysteresis is near zero in straight rolling and substantial under cornering",
                    ring_straight.carcass_hysteresis_w < 10.0 && ring_nom.carcass_hysteresis_w > 400.0);
    }

    // =========================================================================
    // 7. Flat spots reduce grip AND shake wheel load + chassis (all 4 wheels)
    // =========================================================================
    {
        TireCondition clean_c, flat_c;
        flat_c.flat_spot_depth_mm = 2.5;
        flat_c.flat_spot_phase_rad = 0.0;
        const double g_clean = clean_c.grip_factor(&p) * clean_c.flat_spot_grip_factor(0.0);
        const double g_flat_off = flat_c.grip_factor(&p) * flat_c.flat_spot_grip_factor(kPi);
        const double g_flat_on = flat_c.grip_factor(&p) * flat_c.flat_spot_grip_factor(0.0);
        test::check("2.5 mm flat spot reduces both steady grip and instantaneous grip as flat passes footprint",
                    g_flat_off < g_clean * 0.94 && g_flat_on < g_flat_off * 0.93);

        // Full vehicle test: lock rear wheels via handbrake at 100 km/h to grind rear flat spots, then roll straight
        // and verify once-per-revolution rear wheel load ripple and chassis vertical vibration (not just front FFB!)
        auto measure_shake = [&](bool unsprung_on, bool create_rear_flat) {
            auto flat_g = std::make_shared<PlaneGround>(Vec3{0, 0, 1});
            Simulation s(cfg, flat_g);
            s.dt = 1.0 / 240.0;
            s.vehicle.unsprung_dynamics_enabled = unsprung_on;
            s.vehicle.tire_zones_enabled = true;
            s.vehicle.assists().abs = false;
            s.reset({}, 0.0, 28.0, 4);
            if (create_rear_flat) {
                // Lock rear wheels for 1.6 s with handbrake to grind real rear flat spots
                for (int i = 0; i < 384; ++i) {
                    DriverInput in;
                    in.gear = 4; in.clutch = 1.0; in.handbrake = 1.0;
                    s.step(in);
                }
            }
            // Cruise smoothly for 1.0 s and measure RL load & chassis vertical accel oscillation
            double rl_min = 1e9, rl_max = 0.0, az_min = 1e9, az_max = -1e9, flat_mm = 0.0;
            for (int i = 0; i < 240; ++i) {
                DriverInput in;
                in.gear = 4; in.throttle = 0.25; in.auto_clutch = true;
                s.step(in);
                if (i >= 48 && s.last.wheels[RL].contact) {
                    rl_min = std::min(rl_min, s.last.wheels[RL].load);
                    rl_max = std::max(rl_max, s.last.wheels[RL].load);
                    az_min = std::min(az_min, s.last.accel.z);
                    az_max = std::max(az_max, s.last.accel.z);
                    flat_mm = std::max(flat_mm, s.last.wheels[RL].condition.flat_spot_depth_mm);
                }
            }
            return std::array<double, 3>{rl_max - rl_min, az_max - az_min, flat_mm};
        };

        const auto smooth_u = measure_shake(true, false);
        const auto flat_u = measure_shake(true, true);
        const auto flat_no_u = measure_shake(false, true);
        std::printf("         flat-spot chassis shake (RL): smooth dFz=%.1f N dAz=%.3f m/s^2 | flat(%.2f mm, unsprung ON) dFz=%.0f N dAz=%.2f m/s^2 | flat(unsprung OFF) dFz=%.0f N dAz=%.2f m/s^2\n",
                    smooth_u[0], smooth_u[1], flat_u[2], flat_u[0], flat_u[1], flat_no_u[0], flat_no_u[1]);
        test::check("handbrake lockup grinds rear flat spot and shakes rear wheel load & chassis (unsprung ON)",
                    flat_u[2] > 0.35 && flat_u[0] > smooth_u[0] + 350.0 && flat_u[1] > smooth_u[1] + 0.25);
        test::check("flat spot shakes rear wheel load & chassis even with unsprung dynamics OFF",
                    flat_no_u[0] > smooth_u[0] + 250.0 && flat_no_u[1] > smooth_u[1] + 0.20);
    }

    // =========================================================================
    // 8. Sidewall rollover, kerb rim-flange strike & puncture deflation
    // =========================================================================
    {
        TireCondition kerb_t;
        kerb_t.pressure_kpa = p.p_nominal_kpa;
        // Sharp 7.5 cm vertical kerb step under high cornering & vertical load -> pinches sidewall to rim!
        ContactPatchProfile sharp_kerb;
        sharp_kerb.has_height_map = true;
        for (int i = 0; i < kPatchRows; ++i) {
            for (int j = 0; j < kPatchCols; ++j) {
                sharp_kerb.road_dz_m[i * kPatchCols + j] = (i >= 2) ? 0.075 : 0.0;
            }
        }
        double max_rim_f = 0.0;
        double ang = 0.0;
        for (int i = 0; i < 400; ++i) {
            ang += 100.0 * 0.001;
            kerb_t.step_carcass_ring(0.0, 5800.0, 6200.0, 100.0, ang, p.radius, 0.001, &p, &sharp_kerb);
            max_rim_f = std::max(max_rim_f, kerb_t.rim_strike_force_n);
        }
        const double dmg_after_hit = kerb_t.sidewall_damage;
        const double leak_rate = kerb_t.puncture_leak_rate;
        const double p_before_leak = kerb_t.pressure_kpa;
        // Roll for 30 s after the sidewall cut -> pressure deflates smoothly via ideal gas law
        for (int i = 0; i < 600; ++i) {
            kerb_t.update(500.0, 3800.0, 25.0, 0.05, &p);
        }
        const double p_after_leak = kerb_t.pressure_kpa;
        const double grip_flat_tyre = kerb_t.grip_factor(&p);

        std::printf("         sharp 7.5 cm kerb strike: peak rim force=%.0f N, sidewall_dmg=%.2f, leak=%.3f/s, P %.1f -> %.1f kPa, flat grip=%.3f\n",
                    max_rim_f, dmg_after_hit, leak_rate, p_before_leak, p_after_leak, grip_flat_tyre);
        test::check("violent 7.5 cm kerb strike bottoms to rim, damages sidewall & triggers puncture leak",
                    max_rim_f > 2000.0 && dmg_after_hit > 0.15 && leak_rate > 0.01);
        test::check("punctured tyre deflates via ideal gas law and loses substantial grip",
                    p_after_leak < p_before_leak - 60.0 && grip_flat_tyre < 0.78);

        kerb_t.repair_structural(&p);
        test::check("repair_structural restores sealed pressure, zero sidewall damage and full health",
                    kerb_t.sidewall_damage == 0.0 && kerb_t.puncture_leak_rate == 0.0 &&
                    kerb_t.air_mass_ratio == 1.0 && kerb_t.pressure_kpa > 180.0);
    }

    // =========================================================================
    // 9. Slick compound thermal calibration, blistering & late-stint wear cliff
    // =========================================================================
    {
        TireParams slick = p;
        apply_compound(slick, "slick");
        // Verify late-stint wear cliff on slicks (past 70% wear drops steeper than first 50%)
        TireCondition w0, w50, w70, w95;
        w0.temperature_c = w50.temperature_c = w70.temperature_c = w95.temperature_c = 90.0;
        w0.surface_c = w50.surface_c = w70.surface_c = w95.surface_c = 90.0;
        w0.wear = 0.0; w50.wear = 0.50; w70.wear = 0.70; w95.wear = 0.95;
        const double g0 = w0.grip_factor(&slick), g50 = w50.grip_factor(&slick);
        const double g70 = w70.grip_factor(&slick), g95 = w95.grip_factor(&slick);
        const double drop_per_pct_early = (g0 - g50) / 50.0;
        const double drop_per_pct_cliff = (g70 - g95) / 25.0;

        // Sustained thermal abuse (>125 C carcass/surface) activates blistering on slicks
        TireCondition hot_slick;
        hot_slick.set_environment_celsius(35.0, 50.0);
        hot_slick.temperature_c = hot_slick.surface_c = hot_slick.inner_c = hot_slick.middle_c = hot_slick.outer_c = 126.0;
        hot_slick.inner_air_c = 95.0;
        for (int i = 0; i < 400; ++i) {
            hot_slick.update_zones(14000.0, 5000.0, 38.0, -0.04, 5500.0, -1.0, 115.0, i * 0.5, 0.05, &slick);
        }

        std::printf("         slick wear cliff: new=%.3f, 50%%=%.3f, 70%%=%.3f, 95%%=%.3f (cliff slope %.2fx early); hot abuse core=%.1f C blister=%.2f grip=%.3f\n",
                    g0, g50, g70, g95, drop_per_pct_cliff / std::max(drop_per_pct_early, 1e-6),
                    hot_slick.carcass_c(), hot_slick.blistering, hot_slick.grip_factor(&slick));
        test::check("slick exhibits realistic late-stint wear cliff past 70% wear",
                    g95 < g70 - 0.12 && drop_per_pct_cliff > drop_per_pct_early * 2.5);
        test::check("sustained slick overheating above working ceiling activates blistering and cuts grip",
                    hot_slick.blistering > 0.05 && hot_slick.grip_factor(&slick) < 0.90);
    }

    // =========================================================================
    // 10. Full Pacejka MF 6.2: Overturning Moment Mx, pressure trail/residual, force-coupled Re
    // =========================================================================
    {
        TireOperating op_nom{};
        op_nom.dpi = 0.0;
        op_nom.enable_mf62_hybrid = true;
        TireOperating op_hi = op_nom;
        op_hi.dpi = 0.25;
        const TireForces f_nom = magic_formula(p, 0.0, std::tan(5.0 * deg), 4500.0, 1.0, 0.0, op_nom);
        const TireForces f_hi = magic_formula(p, 0.0, std::tan(5.0 * deg), 4500.0, 1.0, 0.0, op_hi);
        const double mx_cam_pos = mf_overturning_moment(p, 4500.0, 0.0, 4.0 * deg, 0.0);
        const double mx_cam_neg = mf_overturning_moment(p, 4500.0, 0.0, -4.0 * deg, 0.0);
        const double re_free = effective_rolling_radius_mf62(p, 4500.0, 0.0, 0.0, 60.0, 0.0, 0.0);
        const double re_loaded = effective_rolling_radius_mf62(p, 4500.0, 0.0, 0.0, 60.0, -5000.0, 5000.0);

        std::printf("         MF 6.2: Mx(Fy)=%.1f Nm, Mx(+4deg)=%.1f vs (-4deg)=%.1f Nm | trail nom=%.4f vs hiP=%.4f m | Re free=%.4f vs Fx/Fy=%.4f m\n",
                    f_nom.mx, mx_cam_pos, mx_cam_neg, f_nom.pneumatic_trail, f_hi.pneumatic_trail, re_free, re_loaded);
        test::check("MF 6.2 overturning moment Mx is nonzero and antisymmetric with camber",
                    f_nom.mx > 15.0 && mx_cam_pos > 15.0 && mx_cam_neg < -15.0);
        test::check("MF 6.2 higher inflation pressure shortens pneumatic trail via pPz1",
                    f_hi.pneumatic_trail < f_nom.pneumatic_trail - 0.001);
        test::check("MF 6.2 Q_FCX/Q_FCY force coupling slightly compresses loaded rolling radius under hard Fx/Fy",
                    re_loaded < re_free - 0.00005 && re_loaded > re_free - 0.004);
    }

    // =========================================================================
    // 11. Dynamic City-Street Surface Evolution (rubber, marbles, wet wake drying & crown drainage)
    // =========================================================================
    {
        StreetSurfaceEvolution evo(2000.0, 100, 6.75, 0.02);
        evo.reset(0.0, 0.0, 0.08);
        const StreetSurfaceSample green = evo.sample(100.0, 0.0);
        // Simulate 40 passes of hard cornering on the center lane (lat = 0)
        for (int pass = 0; pass < 40; ++pass) {
            evo.deposit_wheel(100.0, 0.0, 18000.0, 35.0, 4800.0, 0.4);
        }
        const StreetSurfaceSample rubbered_dry = evo.sample(100.0, 0.0);
        const StreetSurfaceSample offline_marbles = evo.sample(100.0, 1.5);

        // Now rain falls on the rubbered street -> rubbered line becomes slicker in wet than clean off-line asphalt,
        // and crown drains water toward outer curb gutters, while passing traffic dries the driven lane!
        evo.step_weather(24.0, 18.0, 300.0); // 5 min of heavy rain (24 mm/hr -> ~2 mm)
        const StreetSurfaceSample wet_rubbered = evo.sample(100.0, 0.0);
        const StreetSurfaceSample wet_gutter = evo.sample(100.0, 6.2);
        const StreetSurfaceSample wet_clean_mid = evo.sample(500.0, 0.0); // un-rubbered section
        for (int pass = 0; pass < 25; ++pass) {
            evo.deposit_wheel(100.0, 0.0, 4000.0, 35.0, 4500.0, 0.25);
        }
        const StreetSurfaceSample wet_after_wake = evo.sample(100.0, 0.0);

        // Marble pickup on tyre scrubs off over ~90 m of clean asphalt
        TireCondition mt;
        mt.temperature_c = mt.surface_c = 85.0;
        mt.marble_pickup = 0.85;
        const double g_dirty = mt.grip_factor(&p);
        for (int i = 0; i < 40; ++i) mt.update(400.0, 4000.0, 30.0, 0.2, &p); // 240 m rolling
        const double g_cleaned = mt.grip_factor(&p);

        std::printf("         street evo: dry mu %.3f -> rubbered %.3f (r=%.2f) | offline marbles=%.2f (mu=%.3f) | wet rubbered %.3f vs clean %.3f | water center %.2f -> wake %.2f, gutter %.2f mm\n",
                    green.effective_mu_mult, rubbered_dry.effective_mu_mult, rubbered_dry.rubber_0_to_1,
                    offline_marbles.marbles_0_to_1, offline_marbles.effective_mu_mult,
                    wet_rubbered.wet_mu_mult, wet_clean_mid.wet_mu_mult,
                    wet_rubbered.water_mm, wet_after_wake.water_mm, wet_gutter.water_mm);
        test::check("rubber laydown increases dry street grip and sheds marbles into adjacent off-line lane",
                    rubbered_dry.effective_mu_mult > green.effective_mu_mult + 0.015 &&
                    offline_marbles.marbles_0_to_1 > 0.08 && offline_marbles.effective_mu_mult < green.effective_mu_mult);
        test::check("rubbered-in line is slicker in wet than un-rubbered asphalt; crown drains water into gutters; traffic wake dries line",
                    wet_rubbered.wet_mu_mult < wet_clean_mid.wet_mu_mult - 0.02 &&
                    wet_gutter.water_mm > wet_rubbered.water_mm + 0.2 &&
                    wet_after_wake.water_mm < wet_rubbered.water_mm * 0.65);
        test::check("off-line marble pickup cuts tyre grip and scrubs off cleanly on clean asphalt",
                    g_dirty < 0.94 && g_cleaned > g_dirty + 0.04 && mt.marble_pickup < 0.15);
    }

    // =========================================================================
    // 12. Procedural ISO 8608 Urban Micro-Roughness, Road Crown, Wet Manholes & Crosswalks
    // =========================================================================
    {
        UrbanStreetConfig u_smooth; u_smooth.road_class = IsoRoadClass::ClassA_Highway; u_smooth.base_water_mm = 0.0;
        UrbanStreetConfig u_rough;  u_rough.road_class = IsoRoadClass::ClassD_BrokenCobble; u_rough.base_water_mm = 1.5;
        StreetMicroGround g_smooth(u_smooth), g_rough(u_rough);

        double rms_a = 0.0, rms_d = 0.0;
        for (int i = 0; i < 200; ++i) {
            const double x = i * 0.35;
            const double ha = g_smooth.height_at(x, 0.0), hd = g_rough.height_at(x, 0.0);
            rms_a += ha * ha; rms_d += hd * hd;
        }
        rms_a = std::sqrt(rms_a / 200.0);
        rms_d = std::sqrt(rms_d / 200.0);
        const double crown_center = g_smooth.height_at(5.0, 0.0);
        const double crown_curb = g_smooth.height_at(5.0, 5.5);
        const double mu_manhole_wet = g_rough.cell_mu_at(15.0, 1.75);
        const double mu_paint_wet = g_rough.cell_mu_at(40.0, 0.15);
        ContactPatchProfile manhole_patch;
        g_rough.fill_patch_profile({15.0, 1.75, 0.0}, {1, 0, 0}, {0, 1, 0}, 0.10, 0.11, manhole_patch);

        std::printf("         ISO 8608 urban street: RMS ClassA=%.2f mm vs ClassD=%.2f mm | crown center=%.1f vs curb=%.1f mm | wet manhole mu=%.2f, crosswalk mu=%.2f\n",
                    rms_a * 1000.0, rms_d * 1000.0, crown_center * 1000.0, crown_curb * 1000.0,
                    mu_manhole_wet, mu_paint_wet);
        test::check("ISO 8608 Class D broken street is substantially rougher than Class A highway",
                    rms_d > rms_a * 5.0 && rms_d > 0.004);
        test::check("2% urban drainage crown slopes down from centerline toward gutters",
                    crown_curb < crown_center - 0.06 && g_rough.water_depth_at(5.0, 5.5) > g_rough.water_depth_at(5.0, 0.0) * 1.5);
        test::check("wet cast-iron manhole & crosswalk paint drop 4x4 patch mu sharply",
                    mu_manhole_wet < 0.52 && mu_paint_wet < 0.65 && manhole_patch.has_height_map && manhole_patch.mu_cell[5] < 0.55);
    }

    // =========================================================================
    // 13. 2D Front/Rear Ride-Height & Pitch Aero Map + Diffuser Rake Stall
    // =========================================================================
    {
        CarConfig acfg = cfg;
        acfg.aero.static_ride_height_front_m = 0.080;
        acfg.aero.static_ride_height_rear_m = 0.100;
        acfg.aero.map_2d.front_rh_m = {0.04, 0.08, 0.12};
        acfg.aero.map_2d.rear_rh_m  = {0.06, 0.10, 0.14};
        // Lower front ride height increases front ClA (ground-effect suction) and shifts aero balance forward
        acfg.aero.map_2d.cl_front = {
            1.40, 1.55, 1.35,   // h_f = 0.04 (low nose -> high front suction)
            0.95, 1.05, 0.90,   // h_f = 0.08 (nominal)
            0.55, 0.60, 0.50    // h_f = 0.12 (high nose -> less ground effect)
        };
        acfg.aero.map_2d.cl_rear = {
            1.45, 1.30, 1.05,
            1.35, 1.25, 1.00,
            1.15, 1.05, 0.85
        };
        acfg.aero.map_2d.cd = {
            0.95, 0.98, 1.02,
            0.90, 0.92, 0.95,
            0.88, 0.89, 0.91
        };
        double clf_mid = 0, clr_mid = 0, cd_mid = 0;
        acfg.aero.map_2d.sample(0.06, 0.08, clf_mid, clr_mid, cd_mid);

        auto s_aero = test::make_sim(acfg, 1.0 / 400.0);
        s_aero->vehicle.chassis_dynamics().active_aero_enabled = true;
        s_aero->reset({}, 0.0, 55.0, 5);
        DriverInput cruise; cruise.throttle = 0.35; cruise.gear = 5; cruise.auto_clutch = true;
        for (int i = 0; i < 80; ++i) s_aero->step(cruise);
        const double bal_cruise = s_aero->last.aero_balance_front;
        const double rh_f_cruise = s_aero->last.front_ride_height_m;
        // Hard brake -> nose dives -> front ride height drops -> 2D map shifts aero balance forward!
        DriverInput brk; brk.brake = 0.90; brk.gear = 5; brk.auto_clutch = true;
        for (int i = 0; i < 100; ++i) s_aero->step(brk);
        const double bal_brake = s_aero->last.aero_balance_front;
        const double rh_f_brake = s_aero->last.front_ride_height_m;

        std::printf("         2D aero map: bilerp(0.06,0.08) ClF=%.2f ClR=%.2f Cd=%.2f | cruise h_f=%.1f mm bal=%.3f -> braking h_f=%.1f mm bal=%.3f\n",
                    clf_mid, clr_mid, cd_mid, rh_f_cruise * 1000.0, bal_cruise, rh_f_brake * 1000.0, bal_brake);
        test::check("2D aero map bilinear interpolation exact at grid midpoint",
                    std::abs(clf_mid - 1.2375) < 1e-6 && std::abs(cd_mid - 0.9375) < 1e-6);
        test::check("braking nose-dive lowers front ride height and shifts 2D aero balance forward",
                    rh_f_brake < rh_f_cruise - 0.005 && bal_brake > bal_cruise + 0.02);
    }

    // =========================================================================
    // 14. Elastokinematic Bushing Compliance + Multi-Link & Solid-Axle Layouts
    // =========================================================================
    {
        // A. Rubber-bushed compliance vs rigid hardpoints under braking & cornering
        CarConfig c_rigid = cfg;
        CarConfig c_bush = cfg;
        c_bush.front.toe_compliance_rad_per_kn_fx = 0.0008;
        c_bush.front.camber_compliance_rad_per_kn_fy = 0.0018;
        c_bush.front.longitudinal_compliance_m_per_kn_fx = 0.0015;
        auto s_r = test::make_sim(c_rigid, 1.0 / 400.0);
        auto s_b = test::make_sim(c_bush, 1.0 / 400.0);
        s_r->vehicle.chassis_dynamics().bushing_compliance_enabled = false;
        s_r->reset({}, 0.0, 32.0, 4);
        s_b->reset({}, 0.0, 32.0, 4);
        DriverInput brk_turn; brk_turn.brake = 0.75; brk_turn.steer = 0.35; brk_turn.gear = 4; brk_turn.auto_clutch = true;
        for (int i = 0; i < 80; ++i) { s_r->step(brk_turn); s_b->step(brk_turn); }
        const double d_toe_fl = s_b->last.wheels[FL].toe_angle - s_r->last.wheels[FL].toe_angle;
        const double d_cam_fr = s_b->last.wheels[FR].camber - s_r->last.wheels[FR].camber;

        // B. SolidAxle live beam + Panhard rod kinematics & MultiLink 5-link solver
        CarConfig c_solid = cfg;
        c_solid.rear.kinematics.type = SuspensionType::SolidAxle;
        c_solid.rear.kinematics.explicit_in_config = true;
        c_solid.rear.kinematics.panhard_height_m = 0.24;
        c_solid.rear.kinematics.panhard_length_m = 1.20;
        c_solid.rear.kinematics.wheel_center = {0.0, 0.5 * c_solid.rear.track, c_solid.tire_rear.radius};
        c_solid.rear.kinematics.tire_radius = c_solid.tire_rear.radius;
        c_solid.finalize();
        const WheelKinematicSample sa_bump = c_solid.axle_kinematics[1]->sample_left(0.06, 0.0);
        const AxleRollCentre sa_rc = c_solid.axle_kinematics[1]->roll_centre(0.02, -0.02, 0.0);

        CarConfig c_ml = cfg;
        c_ml.rear.kinematics = synthesize_fitted_hardpoints(c_ml.rear, c_ml.tire_rear, c_ml.wheelbase);
        c_ml.rear.kinematics.type = SuspensionType::MultiLink;
        c_ml.rear.kinematics.explicit_in_config = true;
        c_ml.finalize();
        const WheelKinematicSample ml_bump = c_ml.axle_kinematics[1]->sample_left(0.05, 0.0);

        std::printf("         elastokinematics: braking/turn dToe_FL=%.3f deg, dCamber_FR=%.3f deg | SolidAxle Panhard dy=%.2f mm RC=%.3f m | MultiLink bump camber=%.2f deg\n",
                    d_toe_fl * 180.0 / kPi, d_cam_fr * 180.0 / kPi,
                    sa_bump.wheel_offset.y * 1000.0, sa_rc.height_m, ml_bump.camber_rad * 180.0 / kPi);
        test::check("elastokinematic bushings induce braking toe-in and lateral camber compliance deflection",
                    d_toe_fl > 0.001 && std::abs(d_cam_fr) > 0.002);
        test::check("SolidAxle produces exact Panhard lateral arc shift and anchors roll centre at Panhard height",
                    sa_bump.wheel_offset.y < -0.001 && std::abs(sa_rc.height_m - 0.24) < 0.03);
        test::check("MultiLink 5-link suspension solves negative camber gain in bump",
                    ml_bump.camber_rad < c_ml.rear.static_camber_deg * deg - 0.01);
    }

    // =========================================================================
    // 15. Stress Test: High-Speed Kerb-Hop Resonance & Recovery at 160 km/h (400 Hz)
    // =========================================================================
    {
        struct SawtoothKerbGround : Ground {
            WheelContact raycast(const WheelRay& ray) const override {
                WheelContact c;
                if (ray.direction.z >= -1e-6) return c;
                double z = 0.0;
                // 8 repeated 45 mm sawtooth apex kerbs on the left wheels (y > 0.2 m) between x = 15..55 m
                if (ray.origin.y > 0.2 && ray.origin.x > 15.0 && ray.origin.x < 55.0) {
                    const double phase = std::fmod(ray.origin.x - 15.0, 5.0);
                    if (phase < 1.2) z = 0.045 * (phase / 1.2);
                    else if (phase < 1.8) z = 0.045 * (1.0 - (phase - 1.2) / 0.6);
                }
                const double t = (z - ray.origin.z) / ray.direction.z;
                if (t < 0.0 || t > ray.length) return c;
                c.hit = true;
                c.distance = t;
                c.point = ray.origin + ray.direction * t;
                c.normal = {0, 0, 1};
                c.surface = (z > 0.005) ? 1 : 0;
                return c;
            }
        };
        Simulation s_kerb(cfg, std::make_shared<SawtoothKerbGround>());
        s_kerb.dt = 1.0 / 400.0;
        test::enable_game_models(s_kerb.vehicle);
        s_kerb.reset({0, 0, 0}, 0.0, 44.5, 5); // ~160 km/h
        DriverInput drv; drv.throttle = 0.35; drv.gear = 5; drv.auto_clutch = true;
        bool all_finite = true;
        double max_load = 0.0, max_roll_rad = 0.0;
        for (int i = 0; i < 900; ++i) { // 2.25 s (~100 m, crossing all 8 kerbs + 45 m recovery)
            s_kerb.step(drv);
            const Vec3 up = s_kerb.body.state.orientation.rotate({0, 0, 1});
            max_roll_rad = std::max(max_roll_rad, std::acos(clamp(up.z, -1.0, 1.0)));
            for (int w = 0; w < 4; ++w) {
                const auto& wo = s_kerb.last.wheels[w];
                max_load = std::max(max_load, wo.load);
                if (!std::isfinite(wo.load) || !std::isfinite(wo.fx) || !std::isfinite(wo.fy)) all_finite = false;
            }
            if (!std::isfinite(s_kerb.body.state.position.z) || !std::isfinite(s_kerb.last.speed)) all_finite = false;
        }
        const bool recovered = s_kerb.last.wheels[FL].contact && s_kerb.last.wheels[FR].contact &&
                               s_kerb.last.wheels[RL].contact && s_kerb.last.wheels[RR].contact &&
                               s_kerb.body.state.orientation.rotate({0, 0, 1}).z > 0.98;
        std::printf("         kerb-hop 160 km/h stress: finite=%d maxFz=%.0f N maxTilt=%.1f deg recovered=%d\n",
                    all_finite ? 1 : 0, max_load, max_roll_rad * 180.0 / kPi, recovered ? 1 : 0);
        test::check("160 km/h repeated sawtooth kerb-hop stays finite, upright, bounded and recovers cleanly",
                    all_finite && max_load > 4500.0 && max_load < 45000.0 && max_roll_rad < 0.35 && recovered);
    }

    // =========================================================================
    // 16. Stress Test: Live StreetSurfaceEvolution + WheelContact + AsyncVehicleBridge Integration
    // =========================================================================
    {
        // Verify Vehicle::update consumes WheelContact::surface_mu_mult & marble_density, AND AsyncVehicleBridge
        // drives StreetSurfaceEvolution + StreetMicroGround cleanly with zero allocations on step().
        Vehicle v_live(cfg);
        test::enable_game_models(v_live);
        Controls ctl(v_live.config());
        rs::ue5::AsyncVehicleBridge bridge(v_live, ctl);
        ChassisState cs{};
        cs.position = {0.0, 0.0, cfg.cg_height};
        cs.velocity = {25.0, 0.0, 0.0};
        v_live.reset_motion(25.0, 4);

        // Pre-rubber centerline (lat=0) and leave off-line dirty with marbles
        bridge.street_surface().reset(0.0, 0.0, 0.15);
        for (int pass = 0; pass < 35; ++pass) {
            bridge.street_surface().deposit_wheel_world(15.0, 0.0, 20000.0, 35.0, 4800.0, 0.35);
        }

        rs::rt::VehicleCommand cmd{};
        cmd.core_controls = false;
        cmd.direct.throttle = 0.55;
        cmd.direct.gear = 4;
        cmd.direct.auto_clutch = true;
        cmd.has_settings = true;
        cmd.settings.street_surface_enabled = true;
        cmd.settings.street_micro_roughness_enabled = true;
        cmd.settings.street_road_class = 1; // ClassB_CityAvenue
        cmd.settings.rain_mm_per_hr = 0.0;
        bridge.submit_command(cmd);

        bridge.seed_rays(cs, 3);
        bridge.fetch_rays();
        auto& gf = bridge.ground_write_buffer();
        gf.rays_per_wheel = 3;
        gf.has_strips = false;
        gf.use_strip = false;
        for (int w = 0; w < 4; ++w) {
            for (int j = 0; j < 3; ++j) {
                gf.planes[w][j].hit = true;
                gf.planes[w][j].point = {cs.position.x, cs.position.y, 0.0};
                gf.planes[w][j].normal = {0, 0, 1};
                gf.planes[w][j].surface = 0;
            }
        }
        bridge.publish_ground();

        double peak_grip_dry = 0.0, peak_marble_pickup = 0.0;
        for (int i = 0; i < 160; ++i) {
            cs.position.x = 15.0; // drive over the rubbered manhole/street zone
            cs.position.y = (i < 80) ? 0.0 : 5.8; // first dry rubbered center, then dusty curb edge
            const VehicleOutput& out = bridge.step(cs, 1.0 / 400.0);
            if (i == 40) peak_grip_dry = out.wheels[RL].grip_limit;
            peak_marble_pickup = std::max(peak_marble_pickup, out.wheels[RL].condition.marble_pickup);
        }
        const double rubber_seen = bridge.street_rubber_at_car();
        const double marbles_seen = bridge.street_marbles_at_car();
        std::printf("         AsyncVehicleBridge live street: dry gripLimit=%.0f N | rubber=%.2f marbles=%.2f tirePickup=%.3f\n",
                    peak_grip_dry, rubber_seen, marbles_seen, peak_marble_pickup);
        test::check("AsyncVehicleBridge wires live StreetSurfaceEvolution + StreetMicroGround + hot-tyre marble pickup",
                    peak_grip_dry > 2500.0 && marbles_seen > 0.05 && peak_marble_pickup > 0.002);
    }

    // =========================================================================
    // 17. Stress Test: Urban Pothole Rim-Strike -> Puncture -> 10s Limp-Home Stability (400 Hz)
    // =========================================================================
    {
        UrbanStreetConfig pot_cfg;
        pot_cfg.road_class = IsoRoadClass::ClassC_WornStreet;
        pot_cfg.pothole_x_m = 20.0;
        pot_cfg.pothole_y_m = 0.78; // hits left wheels (FL/RL, half-track 0.78 m) dead-center
        pot_cfg.pothole_radius_m = 0.36;
        pot_cfg.pothole_depth_m = 0.095;
        auto pot_ground = std::make_shared<StreetMicroGround>(pot_cfg, 0);
        Simulation s_pot(cfg, pot_ground);
        s_pot.dt = 1.0 / 400.0;
        test::enable_game_models(s_pot.vehicle);
        s_pot.reset({0, 0, 0}, 0.0, 24.0, 3); // ~86 km/h straight into pothole
        DriverInput drv; drv.throttle = 0.25; drv.gear = 3; drv.auto_clutch = true;

        bool finite_all = true;
        double peak_rim_n = 0.0;
        // 1.5 s approach + impact + 10 s limp-home driving at 400 Hz (4,600 ticks)
        for (int i = 0; i < 4600; ++i) {
            if (i > 600) drv.throttle = 0.18; // gentle limp-home cruise
            s_pot.step(drv);
            for (int w = 0; w < 4; ++w) {
                peak_rim_n = std::max(peak_rim_n, s_pot.last.wheels[w].rim_strike_force_n);
                if (!std::isfinite(s_pot.last.wheels[w].load) || !std::isfinite(s_pot.last.wheels[w].fx) ||
                    !std::isfinite(s_pot.last.wheels[w].condition.pressure_kpa)) finite_all = false;
            }
            if (!std::isfinite(s_pot.body.state.position.z) || !std::isfinite(s_pot.last.speed)) finite_all = false;
        }
        const double fl_p = s_pot.last.wheels[FL].condition.pressure_kpa;
        const double fl_dmg = s_pot.last.wheels[FL].sidewall_damage;
        std::printf("         pothole limp-home 10s (400Hz): finite=%d peakRim=%.0f N FL_dmg=%.2f FL_p=%.1f kPa speed=%.1f m/s\n",
                    finite_all ? 1 : 0, peak_rim_n, fl_dmg, fl_p, s_pot.last.speed);
        test::check("urban pothole rim-strike + 10s limp-home stays 100% finite, upright and stable at 400 Hz",
                    finite_all && s_pot.body.state.orientation.rotate({0, 0, 1}).z > 0.95 && s_pot.last.speed > 5.0);
    }

    // =========================================================================
    // 18. Stress Test: Low-Speed Standstill Hold, Clutch Creep & Reverse-to-1st at 400 Hz
    // =========================================================================
    {
        auto s_low = test::make_sim(cfg, 1.0 / 400.0);
        test::enable_game_models(s_low->vehicle);
        s_low->reset({0, 0, 0}, 0.0, 0.0, 1); // Neutral standstill
        DriverInput hold; hold.gear = 1; hold.brake = 0.0; hold.handbrake = 0.0; hold.auto_clutch = true;
        bool finite_low = true;
        // 2 s untouched neutral standstill -> must not drift or oscillate
        for (int i = 0; i < 800; ++i) {
            s_low->step(hold);
            if (!std::isfinite(s_low->last.speed) || !std::isfinite(s_low->body.state.position.x)) finite_low = false;
        }
        const double standstill_drift_m = std::hypot(s_low->body.state.position.x, s_low->body.state.position.y);

        // Engage Reverse (gear 0) with light throttle -> back up smoothly
        DriverInput rev; rev.gear = 0; rev.throttle = 0.25; rev.auto_clutch = true;
        for (int i = 0; i < 800; ++i) s_low->step(rev);
        const double rev_speed = s_low->last.speed;

        // Brake to stop, then shift into 1st (gear 2) and launch cleanly
        DriverInput stop_in; stop_in.gear = 1; stop_in.brake = 0.8; stop_in.auto_clutch = true;
        for (int i = 0; i < 600; ++i) s_low->step(stop_in);
        DriverInput launch; launch.gear = 2; launch.throttle = 0.45; launch.auto_clutch = true;
        for (int i = 0; i < 1000; ++i) {
            s_low->step(launch);
            if (!std::isfinite(s_low->last.speed) || !std::isfinite(s_low->last.engine_rpm)) finite_low = false;
        }
        const double fwd_speed = s_low->last.speed;
        std::printf("         low-speed 400Hz stress: drift=%.4f m | rev=%.2f m/s -> 1st=%.2f m/s | rpm=%.0f finite=%d\n",
                    standstill_drift_m, rev_speed, fwd_speed, s_low->last.engine_rpm, finite_low ? 1 : 0);
        test::check("400 Hz standstill hold has zero drift and reverse-to-1st transition launches cleanly without chatter/NaN",
                    finite_low && standstill_drift_m < 0.08 && rev_speed < -2.0 && fwd_speed > 6.0 && !s_low->last.engine_stalled);
    }

    // =========================================================================
    // 19. Stress Test: Tornado GT3 2D Aero Map Bottoming (Splitter Stall) & Diffuser Rake-Stall Stability
    // =========================================================================
    {
        CarConfig gt3 = rs::load_car_config(test::data_path("cars/tornado_gt3.json"));
        test::check("tornado_gt3.json loads explicit 2D front/rear ride-height aero map", gt3.aero.map_2d.valid());

        // Road with a smooth compression dip at x = 40 m to compress the front splitter at 250 km/h, then flat
        struct HighSpeedDipGround : Ground {
            WheelContact raycast(const WheelRay& ray) const override {
                WheelContact c;
                if (ray.direction.z >= -1e-6) return c;
                double z = 0.0;
                if (ray.origin.x > 30.0 && ray.origin.x < 70.0) {
                    const double u = (ray.origin.x - 30.0) / 40.0;
                    z = 0.18 * std::sin(kPi * u) * std::sin(kPi * u);
                }
                const double t = (z - ray.origin.z) / ray.direction.z;
                if (t < 0.0 || t > ray.length) return c;
                c.hit = true;
                c.distance = t;
                c.point = ray.origin + ray.direction * t;
                c.normal = {0, 0, 1};
                c.surface = 0;
                return c;
            }
        };
        Simulation s_gt3(gt3, std::make_shared<HighSpeedDipGround>());
        s_gt3.dt = 1.0 / 400.0;
        test::enable_game_models(s_gt3.vehicle);
        s_gt3.reset({0, 0, 0}, 0.0, 69.5, 6); // 250 km/h
        DriverInput drv; drv.throttle = 0.70; drv.gear = 6; drv.auto_clutch = true;

        bool saw_splitter_stall = false, saw_diffuser_stall = false, finite_gt3 = true;
        double min_frh = 1.0, max_bal = 0.0, min_bal = 1.0;
        for (int i = 0; i < 1200; ++i) { // 3 s at 400 Hz: compression dip + braking rake + recovery
            if (i >= 500 && i < 820) { drv.throttle = 0.0; drv.brake = 0.95; }
            else if (i >= 820) { drv.throttle = 0.40; drv.brake = 0.0; }
            s_gt3.step(drv);
            min_frh = std::min(min_frh, s_gt3.last.front_ride_height_m);
            max_bal = std::max(max_bal, s_gt3.last.aero_balance_front);
            min_bal = std::min(min_bal, s_gt3.last.aero_balance_front);
            if (s_gt3.last.front_splitter_stalled) saw_splitter_stall = true;
            if (s_gt3.last.diffuser_stalled) saw_diffuser_stall = true;
            if (!std::isfinite(s_gt3.last.front_ride_height_m) || !std::isfinite(s_gt3.last.aero_balance_front) ||
                !std::isfinite(s_gt3.body.state.position.z)) finite_gt3 = false;
        }
        const bool settled = finite_gt3 && s_gt3.body.state.orientation.rotate({0, 0, 1}).z > 0.99 &&
                             !s_gt3.last.front_splitter_stalled && !s_gt3.last.diffuser_stalled;
        std::printf("         GT3 250 km/h 2D aero stress: minFrontRH=%.1f mm bal=[%.3f..%.3f] splitterStall=%d diffuserStall=%d settled=%d\n",
                    min_frh * 1000.0, min_bal, max_bal, saw_splitter_stall ? 1 : 0, saw_diffuser_stall ? 1 : 0, settled ? 1 : 0);
        test::check("GT3 2D aero map shifts balance dynamically through dip/braking and settles without porpoising blow-up",
                    settled && (max_bal - min_bal) > 0.03 && (saw_splitter_stall || min_frh < 0.035));
    }

    // =========================================================================
    // 20. Physical Steering Column + Speed-Sensitive Power Steering (Manual vs Hydraulic vs EPS)
    // =========================================================================
    {
        CarConfig c_man = cfg;
        c_man.steering.assist_mode = PowerSteeringMode::Manual;
        CarConfig c_eps = cfg;
        c_eps.steering.assist_mode = PowerSteeringMode::ElectricEps;
        c_eps.steering.assist_gain_low_speed = 0.72;
        c_eps.steering.assist_gain_high_speed = 0.30;
        c_eps.steering.assist_speed_ref_mps = 35.0;

        auto s_man = test::make_sim(c_man, 1.0 / 400.0);
        auto s_eps_lo = test::make_sim(c_eps, 1.0 / 400.0);
        auto s_eps_hi = test::make_sim(c_eps, 1.0 / 400.0);
        s_man->reset({}, 0.0, 12.0, 2);
        s_eps_lo->reset({}, 0.0, 12.0, 2);
        s_eps_hi->reset({}, 0.0, 42.0, 5);

        DriverInput turn_lo; turn_lo.steer = 0.25; turn_lo.throttle = 0.15; turn_lo.gear = 2; turn_lo.auto_clutch = true;
        DriverInput turn_hi; turn_hi.steer = 0.06; turn_hi.throttle = 0.35; turn_hi.gear = 5; turn_hi.auto_clutch = true;
        for (int i = 0; i < 160; ++i) {
            s_man->step(turn_lo);
            s_eps_lo->step(turn_lo);
            s_eps_hi->step(turn_hi);
        }
        const double rim_man = std::abs(s_man->last.steering_column_torque_nm);
        const double rim_eps_lo = std::abs(s_eps_lo->last.steering_column_torque_nm);
        const double gain_lo = s_eps_lo->last.power_steering_gain;
        const double gain_hi = s_eps_hi->last.power_steering_gain;

        // Straight line must produce zero column buzz/offset
        auto s_str = test::make_sim(c_eps, 1.0 / 400.0);
        s_str->reset({}, 0.0, 40.0, 5);
        DriverInput straight; straight.throttle = 0.25; straight.gear = 5; straight.auto_clutch = true;
        for (int i = 0; i < 120; ++i) s_str->step(straight);
        const double straight_rim = std::abs(s_str->last.steering_column_torque_nm);

        std::printf("         power steering: manual rim=%.2f Nm vs EPS(low v) rim=%.2f Nm | boost lo=%.2f -> hi=%.2f | straight=%.4f Nm\n",
                    rim_man, rim_eps_lo, gain_lo, gain_hi, straight_rim);
        test::check("EPS reduces low-speed steering-wheel rim torque vs unassisted manual rack",
                    rim_man > 3.0 && rim_eps_lo < rim_man * 0.55);
        test::check("speed-sensitive EPS reduces boost gain at highway speed and stays silent on a straight",
                    gain_lo > gain_hi + 0.25 && straight_rim < 0.05);
    }

    // =========================================================================
    // 21. Hydraulic Torque Converter (Fluid Coupling + Stator Multiplication + TCC Lock-Up)
    // =========================================================================
    {
        CarConfig c_tc = cfg;
        c_tc.drivetrain.transmission = "auto_tc";
        auto s_tc = test::make_sim(c_tc, 1.0 / 400.0);
        s_tc->reset({}, 0.0, 0.0, 2); // 1st gear at standstill

        // A. Brake held in Drive -> engine idles smoothly without stalling!
        DriverInput hold_brk; hold_brk.gear = 2; hold_brk.brake = 0.6;
        for (int i = 0; i < 400; ++i) s_tc->step(hold_brk);
        const double hold_rpm = s_tc->last.engine_rpm;
        const bool no_stall = !s_tc->last.engine_stalled && hold_rpm > 500.0 && hold_rpm < 1500.0;

        // B. Lift off brake with zero throttle -> realistic automatic idle creep!
        DriverInput creep; creep.gear = 2; creep.brake = 0.0; creep.throttle = 0.0;
        for (int i = 0; i < 800; ++i) s_tc->step(creep);
        const double creep_speed = s_tc->last.speed;

        // C. Full-throttle launch from rest (1.5 s, TC on so 2.1x torque doesn't just light up the rears) -> TR > 1.7!
        s_tc->reset({}, 0.0, 0.0, 2);
        s_tc->vehicle.assists().tc = true;
        DriverInput wot; wot.gear = 2; wot.throttle = 1.0;
        double peak_tr = 1.0;
        for (int i = 0; i < 600; ++i) {
            s_tc->step(wot);
            peak_tr = std::max(peak_tr, s_tc->last.tc_torque_ratio);
        }
        const double launch_speed = s_tc->last.speed;

        // D. Highway cruise in 4th gear -> TCC lock-up clutch engages cleanly, then unlocks on full kickdown!
        s_tc->reset({}, 0.0, 28.0, 5); // 100 km/h in 4th (gear index 5)
        DriverInput cruise; cruise.gear = 5; cruise.throttle = 0.25;
        for (int i = 0; i < 400; ++i) s_tc->step(cruise);
        const bool locked_cruise = s_tc->last.tc_lockup_engaged && s_tc->last.tc_slip_ratio > 0.98;
        DriverInput kick; kick.gear = 5; kick.throttle = 1.0;
        for (int i = 0; i < 200; ++i) s_tc->step(kick);
        const bool unlocked_kickdown = !s_tc->last.tc_lockup_engaged;

        std::printf("         torque converter: holdRPM=%.0f noStall=%d | creep=%.2f m/s | peakTR=%.2fx launch=%.1f m/s | lockup=%d kickUnlock=%d\n",
                    hold_rpm, no_stall ? 1 : 0, creep_speed, peak_tr, launch_speed,
                    locked_cruise ? 1 : 0, unlocked_kickdown ? 1 : 0);
        test::check("torque converter never stalls at brake-held idle and creeps forward on brake release",
                    no_stall && creep_speed > 0.8 && creep_speed < 8.0);
        test::check("torque converter multiplies launch torque (>1.7x), locks TCC at cruise and unlocks on kickdown",
                    peak_tr > 1.70 && launch_speed > 8.0 && locked_cruise && unlocked_kickdown);
    }

    // =========================================================================
    // 22. Nonlinear Progressive Coil Springs & Exponential Polyurethane Bump-Stop Packers
    // =========================================================================
    {
        CarConfig c_lin = cfg;
        CarConfig c_prog = cfg;
        c_prog.front.spring_progressive_rate = 450000.0; // N/m^2 progressive stiffening
        c_prog.front.bump_stop_gap_m = 0.015;
        c_prog.front.bump_stop_exponent = 2.5;
        c_prog.rear.spring_progressive_rate = 450000.0;
        c_prog.rear.bump_stop_gap_m = 0.015;
        c_prog.rear.bump_stop_exponent = 2.5;

        auto s_lin = test::make_sim(c_lin, 1.0 / 400.0);
        auto s_prog = test::make_sim(c_prog, 1.0 / 400.0);
        s_lin->vehicle.chassis_dynamics().progressive_bump_stops_enabled = false;
        s_lin->reset({}, 0.0, 0.0, 1);
        s_prog->reset({}, 0.0, 0.0, 1);
        DriverInput idle; idle.gear = 1; idle.handbrake = 1.0;
        for (int i = 0; i < 400; ++i) { s_lin->step(idle); s_prog->step(idle); }
        const double z_diff_static = std::abs(s_prog->body.state.position.z - s_lin->body.state.position.z);

        // Drop test from +0.25 m above static ride height -> compresses deeply into bump stops with smooth exponential stiffening
        s_lin->reset({}, 0.0, 0.0, 1);
        s_prog->reset({}, 0.0, 0.0, 1);
        s_lin->body.state.position.z += 0.25;
        s_prog->body.state.position.z += 0.25;
        double max_comp_lin = 0.0, max_comp_prog = 0.0;
        bool finite_drop = true;
        for (int i = 0; i < 400; ++i) {
            s_lin->step(idle);
            s_prog->step(idle);
            max_comp_lin = std::max(max_comp_lin, s_lin->last.wheels[FL].compression);
            max_comp_prog = std::max(max_comp_prog, s_prog->last.wheels[FL].compression);
            if (!std::isfinite(s_prog->last.wheels[FL].load)) finite_drop = false;
        }
        std::printf("         progressive springs/bump-stops: static dZ=%.4f m | drop maxComp lin=%.1f mm vs prog=%.1f mm\n",
                    z_diff_static, max_comp_lin * 1000.0, max_comp_prog * 1000.0);
        test::check("progressive springs & exponential polyurethane bump stops preserve static ride height and resist bottoming smoothly",
                    finite_drop && z_diff_static < 0.002 && max_comp_prog < max_comp_lin - 0.003);
    }
}
