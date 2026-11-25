// Multi-point 4x4 contact patch, 3-node thermal & gas-law pressure, Stribeck sliding friction,
// and physically grounded steady-state drift verification.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <memory>
#include "harness.hpp"
#include "rs/sim.hpp"
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
}
