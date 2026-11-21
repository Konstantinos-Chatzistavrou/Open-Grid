// Unit tests for 3D kinematic suspension geometry (double wishbone, MacPherson strut,
// roll centre, Ackermann, bump steer, and default-fitted hardpoints).
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include "harness.hpp"
#include "../third_party/nlohmann/json.hpp"
#include "rs/kinematics.hpp"
#include "rs/telemetry.hpp"

using namespace rs;

namespace {

SuspensionHardpoints make_textbook_dw() {
    // Textbook SLA double wishbone (Milliken & Milliken Ch. 17 proportions):
    // Track 1.60 m (half-track 0.80 m), tyre radius 0.33 m, zero static camber/toe for clean analytical check.
    // Lower arm horizontal at z = 0.20 m (length ~0.40 m).
    // Upper arm shorter (~0.26 m) sloping down inboard: outer (0.72, 0.46), inner (0.46, 0.41) -> slope dz/dy = 0.05/0.26 = 0.1923.
    // Analytical FVIC intersection of z = 0.20 and z = 0.46 + (0.05/0.26)*(y - 0.72):
    //   y_ic = 0.72 - 0.26 * (0.26 / 0.05) = 0.72 - 1.352 = -0.632 m, z_ic = 0.20 m.
    // Analytical symmetric roll centre height (CP at y = 0.80, z = 0):
    //   h_rc = z_ic * (0.80 / (0.80 - (-0.632))) = 0.20 * (0.80 / 1.432) = 0.11173184 m!
    // Analytical static camber gain:
    //   d(camber)/dz = -1 / (0.80 - (-0.632)) = -1 / 1.432 = -0.6983 rad/m (-40.01 deg/m)!
    SuspensionHardpoints hp;
    hp.type = SuspensionType::DoubleWishbone;
    hp.explicit_in_config = true;
    hp.lca_front = {0.16, 0.35, 0.20};
    hp.lca_rear = {-0.18, 0.35, 0.20};
    hp.lca_outer = {0.005, 0.75, 0.20};
    hp.uca_front = {0.12, 0.46, 0.41};
    hp.uca_rear = {-0.14, 0.46, 0.41};
    hp.uca_outer = {-0.025, 0.72, 0.46};
    hp.tie_inner = {-0.11, 0.37, 0.23};
    hp.tie_outer = {-0.11, 0.725, 0.24};
    hp.has_shock_mounts = true;
    hp.shock_lower = {0.0, 0.63, 0.20};
    hp.shock_upper = {0.0, 0.52, 0.62};
    hp.wheel_center = {0.0, 0.80, 0.33};
    hp.tire_radius = 0.33;
    hp.static_camber_rad = 0.0;
    hp.static_toe_rad = 0.0;
    return hp;
}

SuspensionHardpoints make_textbook_macpherson() {
    // Textbook MacPherson strut (Milliken & Milliken Ch. 17.3 / Dixon Ch. 5.5):
    // Track 1.465 m (half-track 0.7325 m), tyre radius 0.347 m.
    // Lower arm horizontal at z = 0.22 m, strut top at (x=-0.055, y=0.56, z=0.78).
    // Analytical KPI = atan2(0.71 - 0.56, 0.78 - 0.22) = atan2(0.15, 0.56) = 14.995 deg.
    // Analytical Caster = atan2(0.005 - (-0.055), 0.78 - 0.22) = atan2(0.06, 0.56) = 6.116 deg.
    // Analytical FVIC: line through strut_top perp to (T-LBJ)_yz intersects z=0.22 at:
    //   -0.15*(y - 0.56) + 0.56*(0.22 - 0.78) = 0 -> y_ic = 0.56 - 0.56*0.56/0.15 = -1.53067 m, z_ic = 0.22 m.
    // Analytical static roll centre height (CP at y=0.7325, z=0):
    //   h_rc = 0.22 * (0.7325 / (0.7325 + 1.53067)) = 0.071206 m!
    SuspensionHardpoints hp;
    hp.type = SuspensionType::MacPherson;
    hp.explicit_in_config = true;
    hp.lca_front = {0.14, 0.33, 0.22};
    hp.lca_rear = {-0.18, 0.33, 0.22};
    hp.lca_outer = {0.005, 0.71, 0.22};
    hp.strut_top = {-0.055, 0.56, 0.78};
    hp.tie_inner = {-0.11, 0.35, 0.255};
    hp.tie_outer = {-0.11, 0.695, 0.255};
    hp.wheel_center = {0.0, 0.7325, 0.347};
    hp.tire_radius = 0.347;
    hp.static_camber_rad = -1.0 * kPi / 180.0;
    hp.static_toe_rad = 0.0;
    return hp;
}

}  // namespace

RS_TEST(kinematics) {
    constexpr double kRadToDeg = 180.0 / kPi;

    // ---------------------------------------------------------------- 1. Constant link lengths (< 1e-6 m)
    // Sweep full vertical travel (-0.10 .. +0.10 m) x full steering rack travel (-0.06 .. +0.06 m)
    // for BOTH Double Wishbone and MacPherson Strut.
    {
        const SuspensionHardpoints dw_hp = make_textbook_dw();
        const KinematicSolver dw(dw_hp);
        double max_err_dw = 0.0;
        bool all_dw_valid = true;
        for (int iz = -10; iz <= 10; ++iz) {
            const double dz = iz * 0.01;
            for (int ir = -6; ir <= 6; ++ir) {
                const double yr = ir * 0.01;
                const KinematicPose p = dw.solve_pose(dz, yr);
                all_dw_valid &= p.valid;
                if (!p.valid) continue;
                max_err_dw = std::max(max_err_dw, std::abs(length(p.lca_outer - dw_hp.lca_front) - dw.lca_front_len()));
                max_err_dw = std::max(max_err_dw, std::abs(length(p.lca_outer - dw_hp.lca_rear) - dw.lca_rear_len()));
                max_err_dw = std::max(max_err_dw, std::abs(length(p.uca_outer - dw_hp.uca_front) - dw.uca_front_len()));
                max_err_dw = std::max(max_err_dw, std::abs(length(p.uca_outer - dw_hp.uca_rear) - dw.uca_rear_len()));
                max_err_dw = std::max(max_err_dw, std::abs(length(p.uca_outer - p.lca_outer) - dw.knuckle_len()));
                max_err_dw = std::max(max_err_dw, std::abs(length(p.tie_outer - p.tie_inner) - dw.tie_rod_len()));
                max_err_dw = std::max(max_err_dw, std::abs(length(p.tie_outer - p.lca_outer) - dw.lca_to_tie_len()));
                max_err_dw = std::max(max_err_dw, std::abs(length(p.tie_outer - p.uca_outer) - dw.uca_to_tie_len()));
                max_err_dw = std::max(max_err_dw, std::abs(p.wheel_center.z - (dw_hp.wheel_center.z + dz)));
            }
        }
        std::printf("         DW max link-length + travel residual across 273 poses: %.3e m\n", max_err_dw);
        test::check("DW all 273 travel/steer poses valid", all_dw_valid);
        test::check("DW link lengths constant to < 1e-6 m", max_err_dw < 1e-6);

        const SuspensionHardpoints mp_hp = make_textbook_macpherson();
        const KinematicSolver mp(mp_hp);
        double max_err_mp = 0.0;
        bool all_mp_valid = true;
        for (int iz = -10; iz <= 10; ++iz) {
            const double dz = iz * 0.01;
            for (int ir = -6; ir <= 6; ++ir) {
                const double yr = ir * 0.01;
                const KinematicPose p = mp.solve_pose(dz, yr);
                all_mp_valid &= p.valid;
                if (!p.valid) continue;
                max_err_mp = std::max(max_err_mp, std::abs(length(p.lca_outer - mp_hp.lca_front) - mp.lca_front_len()));
                max_err_mp = std::max(max_err_mp, std::abs(length(p.lca_outer - mp_hp.lca_rear) - mp.lca_rear_len()));
                max_err_mp = std::max(max_err_mp, std::abs(length(p.tie_outer - p.tie_inner) - mp.tie_rod_len()));
                max_err_mp = std::max(max_err_mp, std::abs(length(p.tie_outer - p.lca_outer) - mp.lca_to_tie_len()));
                max_err_mp = std::max(max_err_mp, std::abs(p.wheel_center.z - (mp_hp.wheel_center.z + dz)));
            }
        }
        std::printf("         MacPherson max link-length + travel residual across 273 poses: %.3e m\n", max_err_mp);
        test::check("MacPherson all 273 travel/steer poses valid", all_mp_valid);
        test::check("MacPherson link lengths constant to < 1e-6 m", max_err_mp < 1e-6);
    }

    // ---------------------------------------------------------------- 2. Textbook Double Wishbone camber gain
    // Hand calculation: FVSAL = 0.80 - (-0.632) = 1.432 m -> d(camber)/dz = -1 / 1.432 = -0.6983 rad/m (-40.01 deg/m).
    {
        const SuspensionHardpoints dw_hp = make_textbook_dw();
        const KinematicSolver dw(dw_hp);
        const WheelKinematicSample s0 = dw.evaluate(0.0, 0.0);
        const WheelKinematicSample sp = dw.evaluate(0.05, 0.0);
        const WheelKinematicSample sm = dw.evaluate(-0.05, 0.0);

        const double expected_gain = -1.0 / 1.432; // rad/m (-40.01 deg/m)
        std::printf("         Textbook DW: camber(0)=%.3f deg, camber(+50mm)=%.3f deg, camber(-50mm)=%.3f deg, slope=%.2f deg/m (analytical %.2f deg/m), MR=%.3f\n",
                    s0.camber_rad * kRadToDeg, sp.camber_rad * kRadToDeg, sm.camber_rad * kRadToDeg,
                    s0.dcamber_dz * kRadToDeg, expected_gain * kRadToDeg, s0.motion_ratio);
        test::check("DW gains negative camber in bump", sp.camber_rad < -0.02);
        test::check("DW gains positive camber in droop", sm.camber_rad > 0.02);
        test::check_range("DW camber gain matches textbook -1/FVSAL within 5%",
                          s0.dcamber_dz / expected_gain, 0.95, 1.05, "x");
        test::check_range("DW motion ratio realistic (0.55..0.90)", s0.motion_ratio, 0.55, 0.90, "-");
    }

    // ---------------------------------------------------------------- 3. Analytical symmetric Roll Centre height
    // Textbook DW analytical h_rc = 0.20 * (0.80 / 1.432) = 0.11173184 m.
    // Also verify dynamic heave drop: compressing both sides by +40 mm drops RC height substantially.
    {
        const SuspensionHardpoints dw_hp = make_textbook_dw();
        const KinematicSolver dw(dw_hp);
        const WheelKinematicSample s0 = dw.evaluate(0.0, 0.0);
        const AxleRollCentre rc0 = compute_axle_roll_centre(s0, s0);
        const double analytical_rc = 0.20 * (0.80 / 1.432);
        const WheelKinematicSample sb = dw.evaluate(0.04, 0.0);
        const AxleRollCentre rcb = compute_axle_roll_centre(sb, sb);
        const double rc_gain = (rcb.height_m - rc0.height_m) / 0.04;

        std::printf("         Symmetric DW RC: computed %.6f m vs analytical %.6f m (err %.2e m); heave +40mm -> %.4f m (gain %.2f)\n",
                    rc0.height_m, analytical_rc, std::abs(rc0.height_m - analytical_rc), rcb.height_m, rc_gain);
        test::check("Symmetric DW RC matches hand calculation to < 1e-4 m",
                    std::abs(rc0.height_m - analytical_rc) < 1e-4);
        test::check("Symmetric DW RC lateral offset is zero", std::abs(rc0.lateral_offset_m) < 1e-9);
        test::check_range("DW RC drops in bump (typical roll_centre_gain -2.5..-1.0)", rc_gain, -2.8, -0.8, "-");

        // Also check asymmetric roll (left bump +30 mm, right droop -30 mm): RC migrates laterally
        const WheelKinematicSample sl = dw.evaluate(0.03, 0.0);
        const WheelKinematicSample sr = dw.evaluate(-0.03, 0.0);
        const AxleRollCentre rca = compute_axle_roll_centre(sl, sr);
        test::check("Asymmetric roll keeps finite RC height", std::isfinite(rca.height_m) && std::abs(rca.height_m) < 0.5);
    }

    // ---------------------------------------------------------------- 4. MacPherson strut sanity (camber, KPI, caster, RC, MR)
    {
        const SuspensionHardpoints mp_hp = make_textbook_macpherson();
        const KinematicSolver mp(mp_hp);
        const WheelKinematicSample s0 = mp.evaluate(0.0, 0.0);
        const WheelKinematicSample sb = mp.evaluate(0.05, 0.0);
        const WheelKinematicSample sdeep = mp.evaluate(0.10, 0.0);
        const WheelKinematicSample sd = mp.evaluate(-0.05, 0.0);
        const AxleRollCentre rc0 = compute_axle_roll_centre(s0, s0);
        const AxleRollCentre rcb = compute_axle_roll_centre(sb, sb);

        const double expected_kpi_deg = std::atan2(0.15, 0.56) * kRadToDeg;
        const double expected_caster_deg = std::atan2(0.06, 0.56) * kRadToDeg;
        // Analytical RC with -1 deg static camber: cp_y = 0.7325 + 0.347*sin(1 deg) = 0.738556 m
        const double expected_rc = 0.22 * (s0.cp_y / (s0.cp_y + 1.5306667));

        std::printf("         MacPherson: KPI=%.2f deg (exp %.2f), Caster=%.2f deg (exp %.2f), RC=%.5f m (exp %.5f), MR=%.3f\n",
                    s0.kpi_rad * kRadToDeg, expected_kpi_deg,
                    s0.caster_rad * kRadToDeg, expected_caster_deg,
                    rc0.height_m, expected_rc, s0.motion_ratio);
        std::printf("         MacPherson camber: droop(-50mm)=%.2f, static=%.2f, bump(+50mm)=%.2f, deep(+100mm)=%.2f deg | RC(+50mm)=%.4f m\n",
                    sd.camber_rad * kRadToDeg, s0.camber_rad * kRadToDeg,
                    sb.camber_rad * kRadToDeg, sdeep.camber_rad * kRadToDeg, rcb.height_m);

        test::check("MacPherson KPI matches geometry (< 0.05 deg)", std::abs(s0.kpi_rad * kRadToDeg - expected_kpi_deg) < 0.05);
        test::check("MacPherson caster matches geometry (< 0.05 deg)", std::abs(s0.caster_rad * kRadToDeg - expected_caster_deg) < 0.05);
        test::check("MacPherson RC matches analytical (< 1e-4 m)", std::abs(rc0.height_m - expected_rc) < 1e-4);
        test::check("MacPherson gains negative camber in moderate bump", sb.camber_rad < s0.camber_rad);
        test::check("MacPherson camber gain flattens in deep bump vs moderate bump",
                    (sdeep.camber_rad - sb.camber_rad) > (sb.camber_rad - s0.camber_rad));
        test::check("MacPherson RC drops in bump", rcb.height_m < rc0.height_m);
        test::check_range("MacPherson strut motion ratio near 1 (0.85..1.00)", s0.motion_ratio, 0.85, 1.00, "-");
    }

    // ---------------------------------------------------------------- 5. Default-fitted hardpoints vs old linear/quadratic curve
    // Prove that when a car has NO explicit hardpoints, synthesized hardpoints reproduce the
    // old camber curve, roll centre height, caster, KPI, static toe, bump steer, and Ackermann tightly.
    {
        CarConfig cfg = test::car();
        // Test pure linear curve (g2 = 0) AND Vela's quadratic curve (g2 = -230 deg/m^2)
        AxleParams lin_ax = cfg.front;
        lin_ax.camber_gain2_rad_per_m2 = 0.0;
        const SuspensionHardpoints lin_hp = synthesize_fitted_hardpoints(lin_ax, cfg.tire_front, cfg.wheelbase);
        const auto lin_tbl = AxleKinematicsTable::build(lin_hp, lin_ax.max_steer_deg);

        double max_lin_err_deg = 0.0;
        for (int i = -6; i <= 6; ++i) {
            const double dz = i * 0.01; // -60 .. +60 mm (normal working travel)
            const double old_cam = lin_ax.static_camber_deg * kPi / 180.0 + lin_ax.camber_gain_rad_per_m * dz;
            const double new_cam = lin_tbl->sample_left(dz, 0.0).camber_rad;
            max_lin_err_deg = std::max(max_lin_err_deg, std::abs(new_cam - old_cam) * kRadToDeg);
        }
        const AxleRollCentre lin_rc = lin_tbl->roll_centre(0.0, 0.0, 0.0);
        std::printf("         Fitted linear curve max error over +/-60 mm: %.3f deg | RC=%.4f m (spec %.4f m)\n",
                    max_lin_err_deg, lin_rc.height_m, lin_ax.roll_centre_height);
        test::check("Fitted linear camber matches old linear curve within 0.15 deg over +/-60 mm",
                    max_lin_err_deg < 0.15);
        test::check("Fitted static RC matches roll_centre_height_m within 0.002 m",
                    std::abs(lin_rc.height_m - lin_ax.roll_centre_height) < 0.002);

        // Quadratic curve match (standard car config with camber_gain2 = -230 deg/m^2)
        const SuspensionHardpoints quad_hp = synthesize_fitted_hardpoints(cfg.front, cfg.tire_front, cfg.wheelbase);
        const auto quad_tbl = AxleKinematicsTable::build(quad_hp, cfg.front.max_steer_deg);
        double max_quad_err_deg = 0.0;
        for (int i = -6; i <= 6; ++i) {
            const double dz = i * 0.01;
            const double old_cam = cfg.front.static_camber_deg * kPi / 180.0
                                 + cfg.front.camber_gain_rad_per_m * dz
                                 + cfg.front.camber_gain2_rad_per_m2 * dz * dz;
            const double new_cam = quad_tbl->sample_left(dz, 0.0).camber_rad;
            max_quad_err_deg = std::max(max_quad_err_deg, std::abs(new_cam - old_cam) * kRadToDeg);
        }
        const WheelKinematicSample q0 = quad_tbl->sample_left(0.0, 0.0);
        const WheelKinematicSample qp = quad_tbl->sample_left(0.03, 0.0);
        const double bs_deg_m = (qp.toe_rad - q0.toe_rad) / 0.03 * kRadToDeg;
        const WheelKinematicSample stl = quad_tbl->sample_wheel(true, 0.0, 1.0);
        const WheelKinematicSample str = quad_tbl->sample_wheel(false, 0.0, 1.0);
        const double mean_steer_deg = 0.5 * (stl.steer_rad + str.steer_rad) * kRadToDeg;

        std::printf("         Fitted quad curve max err: %.3f deg | bump steer=%.2f deg/m (spec %.2f) | full left steer L=%.2f R=%.2f mean=%.2f deg (spec %.1f)\n",
                    max_quad_err_deg, bs_deg_m, cfg.front.bump_steer_deg_per_m,
                    stl.steer_rad * kRadToDeg, str.steer_rad * kRadToDeg, mean_steer_deg, cfg.front.max_steer_deg);
        test::check("Fitted quadratic camber matches old curve within 0.25 deg over +/-60 mm",
                    max_quad_err_deg < 0.25);
        test::check("Fitted bump steer matches spec within 0.15 deg/m",
                    std::abs(bs_deg_m - cfg.front.bump_steer_deg_per_m) < 0.15);
        test::check("Full left steer calibrates mean front lock within 0.2 deg",
                    std::abs(mean_steer_deg - cfg.front.max_steer_deg) < 0.2);
        test::check("Positive Ackermann: inner (left) wheel steers more than outer (right) wheel",
                    stl.steer_rad > str.steer_rad);
    }

    // ---------------------------------------------------------------- 6. Lookup table vs direct solver accuracy
    {
        const SuspensionHardpoints dw_hp = make_textbook_dw();
        const KinematicSolver direct(dw_hp);
        const auto tbl = AxleKinematicsTable::build(dw_hp, 32.0);
        double max_cam_err_deg = 0.0, max_st_err_deg = 0.0, max_rc_err = 0.0;
        for (double dz : {-0.073, -0.025, 0.017, 0.064}) {
            for (double u : {-0.73, -0.21, 0.0, 0.37, 0.85}) {
                const WheelKinematicSample ref = direct.evaluate(dz, u * tbl->max_rack_travel_m());
                const WheelKinematicSample interp = tbl->sample_left(dz, u);
                max_cam_err_deg = std::max(max_cam_err_deg, std::abs(ref.camber_rad - interp.camber_rad) * kRadToDeg);
                max_st_err_deg = std::max(max_st_err_deg, std::abs(ref.steer_rad - interp.steer_rad) * kRadToDeg);
                const AxleRollCentre rc_ref = compute_axle_roll_centre(ref, ref);
                const AxleRollCentre rc_int = compute_axle_roll_centre(interp, interp);
                max_rc_err = std::max(max_rc_err, std::abs(rc_ref.height_m - rc_int.height_m));
            }
        }
        std::printf("         Table vs direct off-grid max err: camber %.4f deg, steer %.4f deg, RC %.5f m\n",
                    max_cam_err_deg, max_st_err_deg, max_rc_err);
        test::check("Lookup table camber matches direct solver (< 0.05 deg)", max_cam_err_deg < 0.05);
        test::check("Lookup table steer matches direct solver (< 0.05 deg)", max_st_err_deg < 0.05);
        test::check("Lookup table RC matches direct solver (< 0.002 m)", max_rc_err < 0.002);
    }

    // ---------------------------------------------------------------- 7. Explicit car JSON configs + Vehicle telemetry
    {
        const CarConfig vela = load_car_config(test::data_path("cars/vela_gt.json"));
        test::check("Vela GT front uses explicit DoubleWishbone",
                    vela.front.kinematics.explicit_in_config && vela.front.kinematics.type == SuspensionType::DoubleWishbone);
        test::check("Vela GT rear uses explicit DoubleWishbone",
                    vela.rear.kinematics.explicit_in_config && vela.rear.kinematics.type == SuspensionType::DoubleWishbone);
        const WheelKinematicSample vf0 = vela.axle_kinematics[0]->sample_left(0.0, 0.0);
        const AxleRollCentre vfrc0 = vela.axle_kinematics[0]->roll_centre(0.0, 0.0, 0.0);
        const AxleRollCentre vrrc0 = vela.axle_kinematics[1]->roll_centre(0.0, 0.0, 0.0);
        std::printf("         Vela GT explicit DW front: slope=%.1f deg/m, caster=%.2f deg, KPI=%.2f deg, scrub=%.1f mm, RC_f=%.4f m, RC_r=%.4f m, MR=%.3f\n",
                    vf0.dcamber_dz * kRadToDeg, vf0.caster_rad * kRadToDeg, vf0.kpi_rad * kRadToDeg,
                    vf0.scrub_radius_m * 1000.0, vfrc0.height_m, vrrc0.height_m, vf0.motion_ratio);
        test::check_range("Vela GT front camber gain", vf0.dcamber_dz * kRadToDeg, -55.0, -35.0, "deg/m");
        test::check_range("Vela GT front static RC", vfrc0.height_m, 0.045, 0.075, "m");
        test::check_range("Vela GT rear static RC", vrrc0.height_m, 0.085, 0.115, "m");

        const CarConfig hayate = load_car_config(test::data_path("cars/hayate.json"));
        test::check("Hayate front uses explicit MacPherson",
                    hayate.front.kinematics.explicit_in_config && hayate.front.kinematics.type == SuspensionType::MacPherson);
        test::check("Hayate rear uses explicit DoubleWishbone",
                    hayate.rear.kinematics.explicit_in_config && hayate.rear.kinematics.type == SuspensionType::DoubleWishbone);
        const WheelKinematicSample hf0 = hayate.axle_kinematics[0]->sample_left(0.0, 0.0);
        const AxleRollCentre hfrc0 = hayate.axle_kinematics[0]->roll_centre(0.0, 0.0, 0.0);
        std::printf("         Hayate explicit MacPherson front: slope=%.1f deg/m, caster=%.2f deg, KPI=%.2f deg, scrub=%.1f mm, RC_f=%.4f m, MR=%.3f\n",
                    hf0.dcamber_dz * kRadToDeg, hf0.caster_rad * kRadToDeg, hf0.kpi_rad * kRadToDeg,
                    hf0.scrub_radius_m * 1000.0, hfrc0.height_m, hf0.motion_ratio);
        test::check_range("Hayate MacPherson KPI", hf0.kpi_rad * kRadToDeg, 11.0, 16.0, "deg");
        test::check_range("Hayate MacPherson RC", hfrc0.height_m, 0.045, 0.085, "m");
        test::check_range("Hayate MacPherson MR", hf0.motion_ratio, 0.88, 1.00, "-");

        // Verify VehicleOutput + TelemetrySample expose dynamic camber, toe, and axle roll centres
        auto sim = test::make_sim(vela);
        sim->settle(1.0);
        const TelemetrySample ts = make_telemetry_sample(sim->last, sim->body.state, DriverInput{}, vela, sim->time);
        test::check("Telemetry exposes non-zero settled camber FL", std::abs(ts.wheel_camber_rad[FL]) > 0.01);
        test::check("Telemetry exposes rear static toe RL", std::abs(ts.wheel_toe_rad[RL] * kRadToDeg - vela.rear.static_toe_deg) < 0.1);
        test::check("Telemetry exposes front & rear roll centre heights",
                    std::abs(ts.roll_centre_front_m - vfrc0.height_m) < 0.01 &&
                    std::abs(ts.roll_centre_rear_m - vrrc0.height_m) < 0.01);
    }

    // ---------------------------------------------------------------- 8. All 24 cars explicit kinematics & gear_teeth verification
    {
        static const char* kAllCars[24] = {
            "aether_borealis", "aether_solis", "basilisk_v12", "falcorn_9r",
            "falcorn_9r_rs", "falcorn_hellhound", "harrier_gt", "hayate",
            "kaze_kurogane", "kaze_kurogane_re", "kaze_ryujin", "kaze_senkou_tr",
            "kestrel_gt", "kronos_fulmine", "kronos_taurus", "strix_gt7",
            "tornado_gt", "tornado_gt3", "valenza_corsa", "valenza_evo37",
            "valenza_fiamma", "valenza_integrale", "valenza_sp3", "vela_gt"
        };
        int explicit_kin_count = 0;
        int explicit_teeth_count = 0;
        double worst_link_err_m = 0.0;
        double worst_gear_rel_err = 0.0;
        double worst_fd_rel_err = 0.0;
        bool all_poses_ok = true;

        for (const char* id : kAllCars) {
            const std::string path = test::data_path(std::string("cars/") + id + ".json");
            std::ifstream jf(path);
            const nlohmann::json raw = nlohmann::json::parse(jf);
            const auto raw_ratios = raw.at("drivetrain").at("gear_ratios").get<std::vector<double>>();
            const double raw_fd = raw.at("drivetrain").at("final_drive").get<double>();

            const CarConfig c = load_car_config(path);
            if (c.front.kinematics.explicit_in_config && c.rear.kinematics.explicit_in_config) {
                ++explicit_kin_count;
            }
            if (c.drivetrain.gear_teeth.size() == raw_ratios.size() &&
                c.drivetrain.final_drive_teeth[0] > 0 && c.drivetrain.final_drive_teeth[1] > 0) {
                ++explicit_teeth_count;
            }
            for (std::size_t gi = 0; gi < raw_ratios.size() && gi < c.drivetrain.gear_teeth.size(); ++gi) {
                if (gi == 1 || std::abs(raw_ratios[gi]) < 1e-6) continue;
                const double tooth_ratio = (gi == 0 ? -1.0 : 1.0)
                    * std::abs(static_cast<double>(c.drivetrain.gear_teeth[gi][0]))
                    / std::abs(static_cast<double>(c.drivetrain.gear_teeth[gi][1]));
                const double rel = std::abs(tooth_ratio - raw_ratios[gi]) / std::abs(raw_ratios[gi]);
                worst_gear_rel_err = std::max(worst_gear_rel_err, rel);
            }
            const double fd_tooth_ratio = static_cast<double>(c.drivetrain.final_drive_teeth[0])
                                        / static_cast<double>(c.drivetrain.final_drive_teeth[1]);
            worst_fd_rel_err = std::max(worst_fd_rel_err, std::abs(fd_tooth_ratio - raw_fd) / raw_fd);

            for (int a = 0; a < 2; ++a) {
                const SuspensionHardpoints& hp = (a == 0) ? c.front.kinematics : c.rear.kinematics;
                const KinematicSolver sol(hp);
                for (double dz : {-0.06, -0.03, 0.0, 0.03, 0.06}) {
                    for (double yr : (a == 0 ? std::vector<double>{-0.04, 0.0, 0.04} : std::vector<double>{0.0})) {
                        const KinematicPose p = sol.solve_pose(dz, yr);
                        all_poses_ok &= p.valid;
                        if (!p.valid) continue;
                        worst_link_err_m = std::max(worst_link_err_m, std::abs(length(p.lca_outer - hp.lca_front) - sol.lca_front_len()));
                        worst_link_err_m = std::max(worst_link_err_m, std::abs(length(p.lca_outer - hp.lca_rear) - sol.lca_rear_len()));
                        worst_link_err_m = std::max(worst_link_err_m, std::abs(length(p.tie_outer - p.tie_inner) - sol.tie_rod_len()));
                        worst_link_err_m = std::max(worst_link_err_m, std::abs(length(p.tie_outer - p.lca_outer) - sol.lca_to_tie_len()));
                        if (hp.type == SuspensionType::DoubleWishbone) {
                            worst_link_err_m = std::max(worst_link_err_m, std::abs(length(p.uca_outer - hp.uca_front) - sol.uca_front_len()));
                            worst_link_err_m = std::max(worst_link_err_m, std::abs(length(p.uca_outer - hp.uca_rear) - sol.uca_rear_len()));
                            worst_link_err_m = std::max(worst_link_err_m, std::abs(length(p.uca_outer - p.lca_outer) - sol.knuckle_len()));
                        }
                    }
                }
            }
        }
        std::printf("         All 24 cars: explicit_kin=%d/24, explicit_teeth=%d/24, max_link_err=%.3e m, max_gear_err=%.3f%%, max_fd_err=%.3f%%\n",
                    explicit_kin_count, explicit_teeth_count, worst_link_err_m,
                    worst_gear_rel_err * 100.0, worst_fd_rel_err * 100.0);
        test::check("All 24 cars have explicit front & rear 3D suspension hardpoints", explicit_kin_count == 24);
        test::check("All 24 cars have explicit gear_teeth and final_drive_teeth", explicit_teeth_count == 24);
        test::check("All 24 cars maintain constant link lengths (< 1e-6 m) across travel & steer",
                    all_poses_ok && worst_link_err_m < 1e-6);
        test::check("All 24 cars gear tooth ratios match gear_ratios within 0.5%",
                    worst_gear_rel_err < 0.005 && worst_fd_rel_err < 0.005);
    }
}
