#include "rs/vehicle.hpp"
#include "rs/pinnacle.hpp"
#include <cmath>

namespace rs {

/**
 * Brake pad friction vs. disc temperature, relative to its working range (track-day / sport pad on a vented iron disc).
 * Cold pads bite ~15 % less; 300-650 C is the plateau; past ~700 C the resin gasses out and the pads fade, slowly at
 * first (0.95 at 750 C, 0.85 at 850 C, 0.6 at 1050 C). Brake torque at full pedal = brake_torque_total * this.
 */
double brake_pad_mu(double t) {
    static const double T[] = {0, 100, 200, 300, 650, 750, 850, 950, 1050, 1100};
    static const double M[] = {0.86, 0.95, 0.99, 1.0, 1.0, 0.95, 0.85, 0.72, 0.60, 0.55};
    if (t <= T[0]) return M[0];
    for (int i = 1; i < 10; ++i) if (t <= T[i]) return M[i - 1] + (M[i] - M[i - 1]) * (t - T[i - 1]) / (T[i] - T[i - 1]);
    return M[9];
}


namespace {
std::array<Vec3, 4> wheel_points(const CarConfig& c) {
    std::array<Vec3, 4> p;
    for (int w = 0; w < 4; ++w) p[w] = {c.wheels[w].x, c.wheels[w].y, 0};
    return p;
}
}  // namespace

Vehicle::Vehicle(const CarConfig& cfg)
    : cfg_(cfg), damage_model_(cfg.mass, wheel_points(cfg)), drivetrain_(cfg_) {
    // Ensure precomputed kinematic tables exist even if a test constructed CarConfig without finalize().
    for (int a = 0; a < 2; ++a) {
        if (!cfg_.axle_kinematics[a]) {
            AxleParams& ax = (a == 0) ? cfg_.front : cfg_.rear;
            const TireParams& t = (a == 0) ? cfg_.tire_front : cfg_.tire_rear;
            if (!ax.kinematics.explicit_in_config) ax.kinematics = synthesize_fitted_hardpoints(ax, t, cfg_.wheelbase);
            else {
                ax.kinematics.wheel_center = {0.0, 0.5 * ax.track, t.radius};
                ax.kinematics.tire_radius = t.radius;
                ax.kinematics.static_camber_rad = ax.static_camber_deg * kPi / 180.0;
                ax.kinematics.static_toe_rad = ax.static_toe_deg * kPi / 180.0;
            }
            cfg_.axle_kinematics[a] = AxleKinematicsTable::build(ax.kinematics, ax.max_steer_deg);
        }
    }
}

void Vehicle::add_contact(std::uint64_t id, const Vec3& point_body, double impulse) {
    if (damage_enabled) damage_model_.add_contact(id, point_body, impulse, time_, last_dt_);
}

double Vehicle::current_mass() const {
    const EngineSystemState& sys = drivetrain_.systems;
    const double burnt_l = std::max(0.0, sys.fuel_capacity_liters - sys.fuel_liters);
    return std::max(0.5 * cfg_.mass, cfg_.mass - burnt_l * 0.745);
}

Vec3 Vehicle::current_inertia() const {
    const double m_cur = current_mass();
    const double dm = std::max(0.0, cfg_.mass - m_cur);
    // Parallel-axis theorem around the rear fuel tank offset {-1.1 m, 0.0 m, -0.15 m}
    // plus proportional mass ratio, clamped safely to [0.5 * I_spec, I_spec].
    constexpr double rx = -1.1, ry = 0.0, rz = -0.15;
    const double mass_frac = cfg_.mass > 1e-3 ? (dm / cfg_.mass) : 0.0;
    const double d_ixx = dm * (ry * ry + rz * rz) + 0.35 * mass_frac * cfg_.inertia_xx;
    const double d_iyy = dm * (rx * rx + rz * rz) + 0.35 * mass_frac * cfg_.inertia_yy;
    const double d_izz = dm * (rx * rx + ry * ry) + 0.35 * mass_frac * cfg_.inertia_zz;
    return {
        clamp(cfg_.inertia_xx - d_ixx, 0.5 * cfg_.inertia_xx, cfg_.inertia_xx),
        clamp(cfg_.inertia_yy - d_iyy, 0.5 * cfg_.inertia_yy, cfg_.inertia_yy),
        clamp(cfg_.inertia_zz - d_izz, 0.5 * cfg_.inertia_zz, cfg_.inertia_zz)
    };
}

void Vehicle::service() {
    EngineSystemState& sys = drivetrain_.systems;
    sys.fuel_liters = sys.fuel_capacity_liters;
    sys.engine_health = 1.0;
    sys.misfiring = false;
    sys.misfire_phase = 0.0;
    sys.clutch_temp_c = 40.0;
    sys.clutch_health = 1.0;
    sys.gearbox_health = 1.0;
    sys.missed_shifts = 0;
    sys.missed_shift_event = false;
    sys.gear_grind = false;
    sys.grind_timer_s = 0.0;
    sys.sync_state = SyncState::Idle;
    sys.sync_target_gear = -1;
    sys.popout_stress_s = 0.0;
    sys.turbo_surge = 0.0;
    sys.surge_boost_bar = 0.0;
}

void Vehicle::reset_motion(double v, int gear) {
    for (int w = 0; w < 4; ++w) {
        drivetrain_.wheel_omega[w] = v / cfg_.tire(w).radius;
        kappa_[w] = tan_alpha_[w] = 0;
        tire_condition_[w] = TireCondition{};
        disc_temp_[w] = cfg_.brake_thermal.start_temp_c;
        wheel_angle_[w] = 0.0;
        unsprung_z_[w] = 0.0;
        unsprung_vz_[w] = 0.0;
        fluid_temp_[w] = 45.0;
        pad_wear_[w] = 0.0;
    }
    disc_init_ = true;
    EngineSystemState& sys = drivetrain_.systems;
    sys.clutch_temp_c = 40.0;
    sys.clutch_health = 1.0;
    sys.clutch_locked = false;
    sys.gearbox_health = 1.0;
    sys.missed_shifts = 0;
    sys.missed_shift_event = false;
    sys.gear_grind = false;
    sys.grind_timer_s = 0.0;
    sys.sync_state = SyncState::Idle;
    sys.sync_target_gear = -1;
    sys.sync_timer_s = 0.0;
    sys.clash_timer_s = 0.0;
    sys.clutch_opened_during_sync = false;
    sys.popout_stress_s = 0.0;
    sys.turbo_surge = 0.0;
    sys.surge_boost_bar = 0.0;
    shift_timer_ = 0.0;
    shift_release_timer_ = 0.0;
    since_shift_timer_ = 10.0;
    missed_recover_timer_ = 0.0;
    const auto& g = cfg_.drivetrain.gear_ratios;
    if (gear >= 0 && gear < (int)g.size() && g[gear] != 0.0) {
        double idle_w = cfg_.engine.idle_rpm * 2.0 * kPi / 60.0;
        double shaft_w = v / cfg_.tire(RL).radius * g[gear] * cfg_.drivetrain.final_drive;
        drivetrain_.engine_omega = std::max(idle_w, shaft_w);
        drivetrain_.stalled = false;
        sys.engaged_gear = gear;
        sys.input_shaft_omega = shaft_w;
    } else if (gear == 1) {
        sys.engaged_gear = 1;
        sys.input_shaft_omega = drivetrain_.engine_omega;
    }
    prev_axle_fy_ = {0, 0};
    prev_fy_ = {0, 0, 0, 0};
}

// Steering: evaluated from the precomputed 3D suspension kinematics table (incorporates
// static toe, dynamic bump steer, and true geometric Ackermann from the steering linkage),
// plus suspension damage and bushing/rack compliance steer.
double Vehicle::steer_angle(int w) const {
    const AxleParams& ax = cfg_.axle(w);
    const int a = w < 2 ? 0 : 1;
    const bool left_wheel = (w % 2 == 0);
    const double u_rack = ax.max_steer_deg > 0 ? clamp(input_.steer, -1.0, 1.0) : 0.0;
    const WheelKinematicSample ks = cfg_.axle_kinematics[a]->sample_wheel(left_wheel, dz_[w], u_rack);
    double d = ks.steer_rad + damage_.toe[w];
    if (ax.max_steer_deg > 0) d -= ax.steer_compliance * prev_axle_fy_[a];
    return d;
}

double Vehicle::roll_centre(int w) const {
    const int a = w < 2 ? 0 : 1;
    const double u_rack = cfg_.axle(w).max_steer_deg > 0 ? clamp(input_.steer, -1.0, 1.0) : 0.0;
    const AxleRollCentre rc = cfg_.axle_kinematics[a]->roll_centre(dz_[a * 2], dz_[a * 2 + 1], u_rack);
    return clamp(rc.height_m, -0.25, 0.45);
}

std::array<WheelRay, 4> Vehicle::wheel_rays(const ChassisState& s) const {
    std::array<WheelRay, 4> rays;
    Vec3 down = s.orientation.rotate({0, 0, -1});
    for (int w = 0; w < 4; ++w) {
        const WheelGeom& g = cfg_.wheels[w];
        rays[w].origin = s.position + s.orientation.rotate({g.x, g.y, g.mount_z});
        rays[w].direction = down;
        rays[w].length = cfg_.axle(w).spring_rest_length + cfg_.tire(w).radius;
    }
    return rays;
}

std::array<WheelContactPatchRays, 4> Vehicle::wheel_contact_patch_rays(const ChassisState& s) const {
    std::array<WheelContactPatchRays, 4> out;
    const Vec3 down = s.orientation.rotate({0, 0, -1});
    for (int w = 0; w < 4; ++w) {
        const WheelGeom& g = cfg_.wheels[w];
        const double r = cfg_.tire(w).radius;
        const double len = cfg_.axle(w).spring_rest_length + r;
        const Vec3 mount = s.position + s.orientation.rotate({g.x, g.y, g.mount_z});
        const double st = steer_angle(w);
        const Vec3 wheel_fwd = s.orientation.rotate({std::cos(st), std::sin(st), 0.0});
        const double dx = 0.52 * r;
        out[w].longitudinal_offsets_m = {0.0, dx, -dx};
        for (int i = 0; i < 3; ++i) {
            out[w].rays[i].origin = mount + wheel_fwd * out[w].longitudinal_offsets_m[i];
            out[w].rays[i].direction = down;
            out[w].rays[i].length = len;
        }
    }
    return out;
}

WheelContact Vehicle::resolve_contact_patch(const WheelContactPatchRays& patch,
                                            const std::array<WheelContact, 3>& hits,
                                            double tire_radius) {
    WheelContact best;
    const double r = std::max(tire_radius, 0.10);
    double best_eff_dist = 1e9;
    Vec3 normal_acc{0, 0, 0};
    double weight_sum = 0.0;

    for (int i = 0; i < 3; ++i) {
        if (!hits[i].hit) continue;
        const double dx = patch.longitudinal_offsets_m[i];
        // Circular tire tread profile: point at horizontal offset dx sits dz higher than the bottom of the wheel
        const double dz = r - std::sqrt(std::max(0.0, r * r - dx * dx));
        const double eff_dist = hits[i].distance + dz;
        if (eff_dist < best_eff_dist) {
            best_eff_dist = eff_dist;
            best.hit = true;
            best.distance = eff_dist;
            best.point = patch.rays[0].origin + patch.rays[0].direction * eff_dist;
            best.surface = hits[i].surface;
        }
        const double w = (i == 0) ? 1.0 : 0.65;
        normal_acc += hits[i].normal * w;
        weight_sum += w;
    }
    if (!best.hit) return best;

    // If leading ray hits a higher step (curb lip) than center ray, tilt effective normal slightly back along ramp
    if (hits[1].hit && hits[0].hit && hits[1].distance + 0.005 < hits[0].distance) {
        const Vec3 step_vec = hits[1].point - hits[0].point;
        const double step_len2 = dot(step_vec, step_vec);
        if (step_len2 > 1e-6) {
            const Vec3 up_dir = patch.rays[0].direction * -1.0;
            Vec3 ramp_n = normalized(up_dir - normalized(step_vec) * 0.35);
            if (dot(ramp_n, up_dir) > 0.4) normal_acc += ramp_n * 0.85;
        }
    }
    best.normal = weight_sum > 0.0 ? normalized(normal_acc) : Vec3{0, 0, 1};

    // Populate 4x4 contact patch longitudinal height profile from the 3 patch rays (0=center, 1=leading, 2=trailing).
    // Measure each hit's signed elevation above the reference road plane so body pitch/roll on a flat or sloped road
    // produces zero false elevation while real kerb lips and potholes show their true height.
    const Vec3 p_ref = hits[0].hit ? hits[0].point : best.point;
    const Vec3 n_ref = hits[0].hit ? hits[0].normal : best.normal;
    double dz_lead = 0.0, dz_cent = 0.0, dz_trail = 0.0;
    bool any_nonflat = false;
    if (hits[1].hit) {
        dz_lead = clamp(dot(hits[1].point - p_ref, n_ref), -0.08, 0.08);
        if (std::abs(dz_lead) > 1e-3 || hits[1].surface != best.surface) any_nonflat = true;
    } else any_nonflat = true;
    if (hits[2].hit) {
        dz_trail = clamp(dot(hits[2].point - p_ref, n_ref), -0.08, 0.08);
        if (std::abs(dz_trail) > 1e-3 || hits[2].surface != best.surface) any_nonflat = true;
    } else any_nonflat = true;
    if (any_nonflat) {
        best.patch_profile.has_height_map = true;
        // Rows 0..3 = trailing (-0.75a) .. leading (+0.75a); interpolate smoothly from trailing -> center -> leading
        const double row_dz[4] = {
            0.75 * dz_trail + 0.25 * dz_cent,
            0.25 * dz_trail + 0.75 * dz_cent,
            0.75 * dz_cent + 0.25 * dz_lead,
            0.25 * dz_cent + 0.75 * dz_lead
        };
        const bool row_hit[4] = {hits[2].hit || hits[0].hit, hits[0].hit || hits[2].hit,
                                 hits[0].hit || hits[1].hit, hits[1].hit || hits[0].hit};
        for (int i = 0; i < kPatchRows; ++i) {
            for (int j = 0; j < kPatchCols; ++j) {
                const int idx = i * kPatchCols + j;
                best.patch_profile.road_dz_m[idx] = row_dz[i];
                best.patch_profile.contact_mask[idx] = row_hit[i];
            }
        }
    }
    return best;
}

std::array<WheelFootprint16Rays, 4> Vehicle::wheel_footprint_16_rays(const ChassisState& s) const {
    std::array<WheelFootprint16Rays, 4> out;
    const Vec3 down = s.orientation.rotate({0, 0, -1});
    // 5 longitudinal stations (-0.54 R .. +0.54 R) x 3 lateral ribs (Inner, Middle, Outer) + 1 leading apex = 16 points
    static constexpr double kLonFracs[5] = {-0.54, -0.27, 0.0, 0.27, 0.54};
    static constexpr double kLatOffsetsM[3] = {-0.095, 0.0, 0.095}; // ~245-285 mm tread width across 3 ribs
    for (int w = 0; w < 4; ++w) {
        const WheelGeom& g = cfg_.wheels[w];
        const double r = cfg_.tire(w).radius;
        const double len = cfg_.axle(w).spring_rest_length + r;
        const Vec3 mount = s.position + s.orientation.rotate({g.x, g.y, g.mount_z});
        const double st = steer_angle(w);
        const Vec3 wheel_fwd = s.orientation.rotate({std::cos(st), std::sin(st), 0.0});
        // Wheel lateral direction pointing from Inner rib toward Outer rib (FL/RL: outer is +Y left; FR/RR: outer is -Y right)
        const double out_sign = (w % 2 == 0) ? 1.0 : -1.0;
        out[w].outward_sign = out_sign;
        const Vec3 wheel_outward = s.orientation.rotate({-std::sin(st) * out_sign, std::cos(st) * out_sign, 0.0});

        int idx = 0;
        for (int ilon = 0; ilon < 5; ++ilon) {
            const double dx = kLonFracs[ilon] * r;
            for (int irib = 0; irib < 3; ++irib) {
                const double dy = kLatOffsetsM[irib];
                out[w].longitudinal_offsets_m[idx] = dx;
                out[w].lateral_offsets_m[idx] = dy;
                out[w].rib_index[idx] = irib; // 0 = Inner, 1 = Middle, 2 = Outer
                out[w].rays[idx].origin = mount + wheel_fwd * dx + wheel_outward * dy;
                out[w].rays[idx].direction = down;
                out[w].rays[idx].length = len;
                ++idx;
            }
        }
        // 16th point: high-resolution leading centerline curb-strike probe (+0.40 R, Middle rib)
        out[w].longitudinal_offsets_m[15] = 0.40 * r;
        out[w].lateral_offsets_m[15] = 0.0;
        out[w].rib_index[15] = 1;
        out[w].rays[15].origin = mount + wheel_fwd * (0.40 * r);
        out[w].rays[15].direction = down;
        out[w].rays[15].length = len;
    }
    return out;
}

WheelContact Vehicle::resolve_footprint_16(const WheelFootprint16Rays& footprint,
                                           const std::array<WheelContact, 16>& hits,
                                           double tire_radius) {
    WheelContact best;
    const double r = std::max(tire_radius, 0.10);
    double best_eff_dist = 1e9;
    Vec3 normal_acc{0, 0, 0};
    double weight_sum = 0.0;
    std::array<double, 3> rib_min_dist{1e9, 1e9, 1e9};

    for (int i = 0; i < 16; ++i) {
        if (!hits[i].hit) continue;
        const double dx = footprint.longitudinal_offsets_m[i];
        const double dy = footprint.lateral_offsets_m[i];
        // 3D cylindrical tire arc + lateral shoulder crown profile
        const double dz_x = r - std::sqrt(std::max(0.0, r * r - dx * dx));
        const double dz_y = 0.0028 * (dy / 0.095) * (dy / 0.095);
        const double eff_dist = hits[i].distance + dz_x + dz_y;
        const int rib = std::clamp(footprint.rib_index[i], 0, 2);
        rib_min_dist[rib] = std::min(rib_min_dist[rib], eff_dist);

        if (eff_dist < best_eff_dist) {
            best_eff_dist = eff_dist;
            best.hit = true;
            best.distance = eff_dist;
            best.point = footprint.rays[7].origin + footprint.rays[7].direction * eff_dist; // ray[7] is (0,0) center
            best.surface = hits[i].surface;
            best.water_depth_mm = std::max(best.water_depth_mm, hits[i].water_depth_mm);
        }
        const double w = (std::abs(dx) < 0.01 && std::abs(dy) < 0.01) ? 1.2 : 0.6;
        normal_acc += hits[i].normal * w;
        weight_sum += w;
    }
    if (!best.hit) return best;

    // Compute per-rib (Inner=0, Middle=1, Outer=2) 3D geometric load distribution from relative curb/camber penetration:
    // A rib that strikes a raised curb has a smaller eff_dist than the other ribs and carries proportionally more load!
    std::array<double, 3> rib_w{};
    double rib_sum = 0.0;
    for (int irib = 0; irib < 3; ++irib) {
        if (rib_min_dist[irib] > 1e8) {
            rib_w[irib] = 0.05;
        } else {
            const double penetration_above_best = std::max(0.0, rib_min_dist[irib] - best_eff_dist);
            // Carcass lateral compliance (~0.018 m characteristic decay across ribs): a 3 cm curb step concentrates load on that rib
            rib_w[irib] = std::exp(-penetration_above_best / 0.016);
        }
        rib_sum += rib_w[irib];
    }
    if (rib_sum > 1e-6) {
        for (int irib = 0; irib < 3; ++irib) best.rib_contact_shares[irib] = rib_w[irib] / rib_sum;
    }

    // Ramp normal backward if leading row (indices 12..15) hits a higher curb step than center row (indices 6..8)
    const double lead_dist = std::min({hits[12].hit ? hits[12].distance : 1e9,
                                       hits[13].hit ? hits[13].distance : 1e9,
                                       hits[14].hit ? hits[14].distance : 1e9});
    const double cent_dist = hits[7].hit ? hits[7].distance : 1e9;
    if (lead_dist + 0.005 < cent_dist && cent_dist < 1e8) {
        const Vec3 up_dir = footprint.rays[7].direction * -1.0;
        const Vec3 step_vec = footprint.rays[13].origin - footprint.rays[7].origin;
        if (dot(step_vec, step_vec) > 1e-6) {
            Vec3 ramp_n = normalized(up_dir - normalized(step_vec) * 0.35);
            if (dot(ramp_n, up_dir) > 0.4) normal_acc += ramp_n * 1.6;
        }
    }
    // Simcenter Tire 2606 MF-Swift 3D Tandem Elliptical Cam Obstacle Enveloping Slope:
    // Compares effective enveloped height of the front cam (rows 3-4) vs rear cam (rows 0-1) across contact length 2a
    const double trail_dist = std::min({hits[0].hit ? hits[0].distance : 1e9,
                                        hits[1].hit ? hits[1].distance : 1e9,
                                        hits[2].hit ? hits[2].distance : 1e9});
    if (lead_dist < 1e8 && trail_dist < 1e8) {
        const double cam_base_m = std::max(0.10, 1.08 * r);
        best.enveloping_slope_tan = clamp((trail_dist - lead_dist) / cam_base_m, -0.30, 0.30);
    }
    best.normal = weight_sum > 0.0 ? normalized(normal_acc) : Vec3{0, 0, 1};

    // Map 5x3 cylindrical footprint ray heights onto the 4x4 multi-point contact patch grid (ISO +Y left / -Y right).
    // Measure each ray hit's signed elevation above the reference road plane so body roll/pitch on a flat or banked
    // road produces zero false elevation while lateral/longitudinal kerbs and ledges show their exact height.
    const Vec3 p_ref = hits[7].hit ? hits[7].point : best.point;
    const Vec3 n_ref = hits[7].hit ? hits[7].normal : best.normal;
    bool any_nonflat = false;
    double min_dz = 1e9, max_dz = -1e9;
    std::array<double, kPatchPoints> grid_dz{};
    std::array<bool, kPatchPoints> grid_mask{};
    for (int i = 0; i < kPatchRows; ++i) {
        const int ilon0 = i;
        const int ilon1 = i + 1;
        for (int j = 0; j < kPatchCols; ++j) {
            const double eta_iso = -0.75 + 0.5 * j;
            const double rib_pos = eta_iso * footprint.outward_sign;
            double wr0 = 0.0, wr1 = 0.0, wr2 = 0.0;
            if (rib_pos <= 0.0) {
                wr0 = clamp(-rib_pos / 0.75, 0.0, 1.0);
                wr1 = 1.0 - wr0;
            } else {
                wr2 = clamp(rib_pos / 0.75, 0.0, 1.0);
                wr1 = 1.0 - wr2;
            }
            const double w_rib[3] = {wr0, wr1, wr2};
            double dz_acc = 0.0, w_acc = 0.0;
            for (int il : {ilon0, ilon1}) {
                for (int ir = 0; ir < 3; ++ir) {
                    if (w_rib[ir] <= 0.0) continue;
                    const WheelContact& h = hits[il * 3 + ir];
                    if (!h.hit) continue;
                    const double dz_h = clamp(dot(h.point - p_ref, n_ref), -0.08, 0.08);
                    dz_acc += w_rib[ir] * dz_h;
                    w_acc += w_rib[ir];
                }
            }
            const int idx = i * kPatchCols + j;
            if (w_acc > 1e-6) {
                const double dz = dz_acc / w_acc;
                grid_dz[idx] = dz;
                grid_mask[idx] = true;
                min_dz = std::min(min_dz, dz);
                max_dz = std::max(max_dz, dz);
            } else {
                grid_dz[idx] = 0.0;
                grid_mask[idx] = false;
                any_nonflat = true;
            }
        }
    }
    if (any_nonflat || (max_dz - min_dz) > 1e-3) {
        best.patch_profile.has_height_map = true;
        best.patch_profile.road_dz_m = grid_dz;
        best.patch_profile.contact_mask = grid_mask;
    }
    return best;
}

AeroWakeState Vehicle::compute_slipstream_wake(const Vec3& my_pos, const Vec3& my_fwd, const std::vector<Vec3>& lead_car_positions) {
    AeroWakeState wake;
    const Vec3 fwd = length(my_fwd) > 1e-6 ? normalized(my_fwd) : Vec3{1, 0, 0};
    double best_tow = 0.0;
    for (const Vec3& lead : lead_car_positions) {
        const Vec3 rel = lead - my_pos;
        const double lon = dot(rel, fwd);
        if (lon < 3.5 || lon > 42.0) continue; // slipstream wake cone: 3.5 m .. 42 m ahead
        const Vec3 lat_v = rel - fwd * lon;
        const double lat = length(lat_v);
        const double cone_half_width = 1.15 + 0.035 * lon;
        if (lat >= cone_half_width) continue;
        const double lat_factor = 1.0 - (lat / cone_half_width) * (lat / cone_half_width);
        // Peak tow at ~9-16 m behind lead bumper, tapering smoothly to 42 m
        const double lon_factor = lon < 9.0 ? (lon - 3.5) / 5.5 : 1.0 - (lon - 9.0) / 33.0;
        best_tow = std::max(best_tow, clamp(lat_factor * lon_factor, 0.0, 1.0));
    }
    wake.drag_scale = 1.0 - 0.28 * best_tow;                      // up to -28% drag reduction in tow
    wake.dirty_air_front_downforce_scale = 1.0 - 0.30 * best_tow; // up to -30% front downforce loss (dirty-air understeer)
    return wake;
}

VehicleOutput Vehicle::update(const ChassisState& s, const std::array<WheelContact, 4>& contacts, double dt) {
    VehicleOutput out;
    time_ += dt;
    last_dt_ = dt;
    // ---- crash damage -> physical effects
    if (damage_enabled) {
        damage_model_.update(dt);
        const DamageModel& dm = damage_model_;
        damage_.brakes = dm.brake_factor();
        damage_.engine_power = dm.engine_power_factor();
        damage_.aero_drag = dm.drag_factor();
        damage_.radiator_cooling = dm.radiator_cooling_factor();
        for (int w = 0; w < 4; ++w) {
            damage_.suspension_stiffness[w] = dm.suspension_factor(w);
            damage_.toe[w] = dm.toe_offset(w);
            damage_.camber[w] = dm.camber_offset(w);
            damage_.caster[w] = dm.caster_offset(w);
            damage_.bearing_drag_nm[w] = dm.wheel_bearing_drag_nm(w);
            damage_.grip[w] = dm.grip_factor(w);
        }
    }
    out.damage = damage_model_.report();
    const Vec3 up = s.orientation.rotate({0, 0, 1});
    const std::array<WheelRay, 4> rays = wheel_rays(s);

    // ------------------------------------------------------------------ suspension
    // Compression c = rest_length + radius - hit_distance (0 = full droop).
    // Spring  F_s = k c          (Hooke's law, wheel rate)
    // Damper  F_d = c_b/r * dc/dt (separate bump / rebound coefficients)
    // Bump stop: extra stiff spring beyond static + max_compression.
    // Anti-roll bar: F = k_arb (c_left - c_right), pushing the more compressed side up and the
    // other side down. It transfers load across an axle, which is how roll stiffness
    // distribution (front vs rear) tunes understeer/oversteer.
    std::array<double, 4> comp{}, comp_rate{}, susp_force{};
    std::array<bool, 4> touching{};
    for (int w = 0; w < 4; ++w) {
        const WheelContact& c = contacts[w];
        const double cos_n = -dot(c.normal, rays[w].direction);
        touching[w] = c.hit && c.distance <= rays[w].length && cos_n >= 0.35;
        if (!touching[w]) continue;
        const AxleParams& ax = cfg_.axle(w);
        const double max_phys_comp = std::min(ax.spring_rest_length,
            cfg_.wheels[w].static_compression + ax.max_compression + 0.025);
        comp[w] = clamp(rays[w].length - c.distance, 0.0, max_phys_comp);
        // Compression rate = speed of the mount along the suspension axis toward the ground
        // (ground assumed static).
        Vec3 v_mount = s.velocity + cross(s.angular_velocity, rays[w].origin - s.position);
        comp_rate[w] = dot(v_mount, rays[w].direction);
    }
    for (int w = 0; w < 4; ++w) {
        if (!touching[w]) continue;
        const AxleParams& ax = cfg_.axle(w);
        double k = ax.spring_rate * damage_.suspension_stiffness[w];
        double f = k * comp[w];
        double bump_start = cfg_.wheels[w].static_compression + ax.max_compression;
        if (comp[w] > bump_start) f += ax.bump_stop_rate * (comp[w] - bump_start);
        {
            // digressive damper: c below the knee speed, c * ratio above it (blow-off valving)
            const double c = comp_rate[w] > 0 ? ax.damper_bump : ax.damper_rebound, v = std::abs(comp_rate[w]), knee = ax.damper_knee_mps;
            f += sign(comp_rate[w]) * c * (v <= knee ? v : knee + ax.damper_high_speed_ratio * (v - knee));
        }
        int other = w ^ 1;                              // FL<->FR, RL<->RR
        double other_comp = touching[other] ? comp[other] : 0.0;
        double arb_eff = 1.0;
        if (chassis_dyn_.chassis_flex_enabled) {
            // Finite chassis torsional stiffness (N m/deg) between front and rear strut towers attenuates ARB roll transfer
            const double k_ch = std::max(4000.0, chassis_dyn_.torsional_stiffness_nm_per_deg);
            const double k_arb_deg = (ax.anti_roll_rate * ax.track * ax.track) * (kPi / 180.0);
            arb_eff = k_ch / (k_ch + k_arb_deg);
        }
        f += ax.anti_roll_rate * arb_eff * (comp[w] - other_comp);
        // Anti-dive / anti-squat / anti-lift: the links' side-view geometry carries part of the longitudinal load
        // transfer straight into the body (F = anti * Fx * h_cg / L along body up), so the springs see less of it and
        // the body pitches less; the wheel's load is unchanged in the steady state. Front: braking (Fx < 0) pushes up
        // (anti-dive), front drive pulls down (anti-lift). Rear: drive pushes up (anti-squat), braking pulls down.
        const double hl = cfg_.cg_height / cfg_.wheelbase, fx = prev_fx_[w];
        const double anti = w < 2 ? -ax.anti_pitch * fx : (fx > 0 ? ax.anti_pitch : ax.anti_lift_rear_braking) * fx;
        f += anti * hl;
        susp_force[w] = std::max(0.0, f);               // a spring can push, not pull the ground
        // ---- 15 Hz 2-DOF Unsprung Wheel-Hop & Radial Tire Carcass Dynamics
        if (unsprung_dynamics_enabled) {
            const double m_u = 42.0; // kg unsprung wheel/tire/hub/brake assembly mass
            const double w_dpi = tire_condition_[w].dpi(cfg_.tire(w));
            const double k_t = std::max(140000.0, cfg_.tire(w).vertical_stiffness * (1.0 + cfg_.tire(w).pfz1 * w_dpi)); // N/m radial tire carcass stiffness (MF 6.2 / Simcenter 2606 pressure-coupled)
            const double c_t = std::max(800.0, cfg_.tire(w).vertical_damping); // N s/m radial tire carcass damping (from PAC2002 VERTICAL_DAMPING = 2000)
            // Unsprung mass sits between suspension force pushing down (susp_force[w]) and tire carcass pushing up
            const double sub_dt = std::min(dt, 0.002);
            const int u_steps = std::max(1, (int)std::ceil(dt / sub_dt));
            const double hu = dt / u_steps;
            double uz = unsprung_z_[w], uv = unsprung_vz_[w];
            for (int us = 0; us < u_steps; ++us) {
                // Static carcass deflection balances static suspension force; uz is dynamic offset (+ = hub hopped up)
                const double f_carcass = std::max(0.0, susp_force[w] - k_t * uz - c_t * uv);
                const double a_u = (f_carcass - susp_force[w]) / m_u - 18.0 * comp_rate[w];
                uv = clamp(uv + a_u * hu, -4.5, 4.5);
                uz = clamp(uz + uv * hu, -0.035, 0.035);
            }
            unsprung_z_[w] = uz;
            unsprung_vz_[w] = uv;
            out.wheels[w].carcass_deflection_m = std::max(0.0, susp_force[w] / k_t - uz);
            out.wheels[w].unsprung_vel_mps = uv;
            // Effective ground contact normal load modulates with 15 Hz unsprung wheel hop
            susp_force[w] = std::max(0.0, susp_force[w] - k_t * uz * 0.45);
        }
    }
    for (int w = 0; w < 4; ++w) dz_[w] = touching[w] ? comp[w] - cfg_.wheels[w].static_compression : dz_[w] * 0.9;
    if (chassis_dyn_.chassis_flex_enabled) {
        const double front_roll_m = (susp_force[FR] - susp_force[FL]) * 0.5 * cfg_.front.track;
        const double rear_roll_m = (susp_force[RR] - susp_force[RL]) * 0.5 * cfg_.rear.track;
        const double k_ch = std::max(4000.0, chassis_dyn_.torsional_stiffness_nm_per_deg);
        out.chassis_twist_deg = clamp((front_roll_m - rear_roll_m) / k_ch, -6.0, 6.0);
    }

    // ------------------------------------------------------------------ tyre kinematics
    struct Kin {
        Vec3 fwd, lat, normal{0, 0, 1}, point;
        double vx = 0, vy = 0, load = 0, mu = 1, gamma = 0, gamma_rate = 0, re = 0.33, sigma_x = 0.12, sigma_y = 0.30;
        double ffb_hydro_scale = 1.0;
    };
    // Precompute per-wheel kinematic lookup and dynamic axle roll centres ONCE for this tick.
    std::array<WheelKinematicSample, 4> wheel_kin{};
    std::array<AxleRollCentre, 2> axle_rc{};
    std::array<double, 2> axle_rch{};
    std::array<double, 2> axle_jack_heave{};
    for (int a = 0; a < 2; ++a) {
        const AxleParams& ax = (a == 0) ? cfg_.front : cfg_.rear;
        const double u_rack = ax.max_steer_deg > 0 ? clamp(input_.steer, -1.0, 1.0) : 0.0;
        const int wl = a * 2, wr = a * 2 + 1;
        const WheelKinematicSample left_s = cfg_.axle_kinematics[a]->sample_left(dz_[wl], u_rack);
        const WheelKinematicSample right_unmirrored = cfg_.axle_kinematics[a]->sample_left(dz_[wr], -u_rack);
        wheel_kin[wl] = left_s;
        wheel_kin[wr] = right_unmirrored;
        wheel_kin[wr].steer_rad = -right_unmirrored.steer_rad;
        wheel_kin[wr].wheel_offset.y = -right_unmirrored.wheel_offset.y;
        wheel_kin[wr].cp_y = -right_unmirrored.cp_y;
        wheel_kin[wr].fvic_y = -right_unmirrored.fvic_y;

        axle_rc[a] = compute_axle_roll_centre(left_s, right_unmirrored);
        axle_rch[a] = clamp(axle_rc[a].height_m, -0.25, 0.45);
        // Symmetric heave jacking force from unequal left/right lateral tyre forces acting through the
        // kinematic swing-arm angles (roll-moment part is already handled via p_lat = k.point + up * rch).
        if (touching[wl] && touching[wr]) {
            const double sl = clamp(axle_rc[a].left_swing_slope, -0.5, 0.5);
            const double sr = clamp(axle_rc[a].right_swing_slope, -0.5, 0.5);
            axle_jack_heave[a] = prev_fy_[wr] * sr - prev_fy_[wl] * sl;
        }
    }
    out.roll_centre_front_m = axle_rch[0];
    out.roll_centre_rear_m = axle_rch[1];

    std::array<Kin, 4> kin;
    for (int w = 0; w < 4; ++w) {
        const int a = w < 2 ? 0 : 1;
        const bool left_wheel = (w % 2 == 0);
        const AxleParams& ax = cfg_.axle(w);
        const WheelKinematicSample& ks = wheel_kin[w];
        double d = ks.steer_rad + damage_.toe[w];
        if (ax.max_steer_deg > 0) d -= ax.steer_compliance * prev_axle_fy_[a];
        out.wheels[w].steer_angle = d;
        out.wheels[w].toe_angle = ks.toe_rad + (left_wheel ? -1.0 : 1.0) * damage_.toe[w];
        out.wheels[w].caster_angle = ks.caster_rad + damage_.caster[w];
        out.wheels[w].kpi_angle = ks.kpi_rad;
        out.wheels[w].scrub_radius_m = ks.scrub_radius_m;
        out.wheels[w].motion_ratio = ks.motion_ratio;
        if (!touching[w]) continue;
        const WheelContact& c = contacts[w];
        const TireParams& tp = cfg_.tire(w);
        Kin& k = kin[w];
        Vec3 heading = s.orientation.rotate({std::cos(d), std::sin(d), 0});
        k.fwd = normalized(heading - c.normal * dot(heading, c.normal));   // in the contact plane
        k.lat = cross(c.normal, k.fwd);                                    // left
        k.normal = c.normal;
        k.point = c.point;
        Vec3 v_c = s.velocity + cross(s.angular_velocity, c.point - s.position);
        k.vx = dot(v_c, k.fwd);
        k.vy = dot(v_c, k.lat);
        k.load = susp_force[w] * std::max(dot(up, c.normal), 0.0);       // normal component
        // Geometric (roll-centre) load transfer + kinematic heave jacking force through the suspension links:
        //   dFz_geo = Fy_axle * h_rc / track (roll transfer) + 0.5 * F_jack_heave (symmetric heave component).
        const double rch = axle_rch[a];
        const double geo = prev_axle_fy_[a] * rch / ax.track;
        k.load = std::max(0.0, k.load + (left_wheel ? -geo : geo) + 0.5 * axle_jack_heave[a]);
        // Per-wheel Hydroplaning (Aquaplaning Water-Wedge Lift): asymmetric standing puddles lift only the submerged wheels
        if (c.water_depth_mm > 0.05) {
            const double p_kpa = tire_condition_[w].pressure_kpa > 0.0 ? tire_condition_[w].pressure_kpa : tp.p_nominal_kpa;
            const HydroplaningState hydro = compute_hydroplaning(std::hypot(k.vx, k.vy), p_kpa, tire_condition_[w].wear, c.water_depth_mm);
            out.wheels[w].hydroplaning_lift = hydro.wedge_lift_fraction;
            k.load *= hydro.effective_load_scale;
            k.ffb_hydro_scale = hydro.ffb_aligning_torque_scale;
        }
        if (atmosphere_.enabled) {
            tire_condition_[w].set_environment_celsius(atmosphere_.ambient_air_c, atmosphere_.track_surface_c);
        }
        tire_condition_[w].rib_contact_shares = c.rib_contact_shares;
        tire_condition_[w].enveloping_slope_tan = c.enveloping_slope_tan;
        k.mu = cfg_.grip_for_surface(c.surface) * tire_condition_[w].grip_factor(&cfg_.tire(w))
             * (tire_zones_enabled ? tire_condition_[w].zone_health_grip_factor() : 1.0) * damage_.grip[w];
        // Dynamic inclination / camber angle gamma in the tyre frame (+ = top tilted toward +left):
        //   1. Chassis roll relative to the road normal (dot(up, k.lat))
        //   2. 3D kinematic camber ks.camber_rad (includes static camber, nonlinear bump/droop camber curve,
        //      and steering-induced caster + KPI inclination) + bent wishbone/caster damage.
        const double roll_gamma = std::asin(clamp(dot(up, k.lat), -0.5, 0.5));
        const double side = left_wheel ? -1.0 : 1.0;   // FL/RL = -1 (left), FR/RR = +1 (right)
        k.gamma = clamp(roll_gamma - side * (ks.camber_rad + damage_.camber[w]) + damage_.caster[w] * std::sin(d), -0.35, 0.35);
        k.gamma_rate = -side * ks.dcamber_dz * comp_rate[w];
        const double w_dpi = tire_condition_[w].dpi(tp);
        k.re = tire_zones_enabled ? effective_rolling_radius_mf62(tp, k.load, k.gamma, w_dpi, drivetrain_.wheel_omega[w])
                                  : effective_rolling_radius(tp, k.load);
        relaxation_lengths(tp, k.load, k.gamma, k.sigma_x, k.sigma_y, w_dpi);
    }

    // ------------------------------------------------------------------ chassis telemetry
    const Vec3 v_body = s.orientation.inv_rotate(s.velocity);
    const double yaw_rate = s.orientation.inv_rotate(s.angular_velocity).z;
    out.speed = v_body.x;
    out.sideslip = std::abs(v_body.x) > 2.0 ? std::atan2(v_body.y, std::abs(v_body.x)) : 0.0;
    out.yaw_rate = yaw_rate;
    AssistStatus& as = out.assists;
    as.yaw_rate = yaw_rate;

    // ------------------------------------------------------------------ ASSIST: ESC (stability)
    // Reference yaw rate from the linear bicycle model with understeer gradient K:
    //   r_ref = v delta / (L + K v^2),  capped at the friction limit |r| <= mu g / v.
    // Oversteer (yawing more than the driver asked, or sliding: |beta| large) -> brake the OUTER
    // front wheel, creating a yaw moment out of the turn. Understeer (yawing less) -> brake the
    // INNER rear wheel and cut power, turning the car in. Same strategy as production ESC.
    std::array<double, 4> esc_brake{};
    double esc_throttle_cut = 0;
    {
        double delta = 0.5 * (out.wheels[FL].steer_angle + out.wheels[FR].steer_angle);
        double v = std::max(out.speed, 0.0);
        double r_ref = v * delta / (cfg_.wheelbase + assists_.esc_understeer_gradient * v * v);
        double r_max = 1.0 * kGravity / std::max(v, 1.0);
        r_ref = clamp(r_ref, -r_max, r_max);
        as.yaw_rate_ref = r_ref;
        if (assists_.esc && v > 5.0) {
            double err = yaw_rate - r_ref;                      // + = yawing more to the left
            double band = assists_.esc_yaw_deadband + 0.1 * std::abs(r_ref);
            bool sliding = std::abs(out.sideslip) > assists_.esc_sideslip_limit;
            // Oversteer: yawing faster than the reference (in either direction), or sliding.
            // Understeer: yawing slower than the reference by more than the deadband.
            bool over = sliding || (std::abs(err) > band && std::abs(yaw_rate) > std::abs(r_ref));
            bool under = !over && std::abs(err) > band && std::abs(yaw_rate) < std::abs(r_ref) && v > 8.0;
            double mag = clamp(assists_.esc_gain * (std::abs(err) - band), 0.0, assists_.esc_max_brake);
            if (sliding) mag = std::max(mag, clamp(assists_.esc_gain * (std::abs(out.sideslip) - assists_.esc_sideslip_limit) * 4.0, 0.0, assists_.esc_max_brake));
            if (over) {
                // yawing left too much (err > 0) -> brake the front RIGHT (outer) wheel
                bool rot_left = (sliding ? yaw_rate : err) > 0;
                esc_brake[rot_left ? FR : FL] = mag;
                esc_throttle_cut = 0.3;
                as.esc_mode = 1;
            } else if (under) {
                // turning left but not enough -> brake the rear LEFT (inner) wheel
                esc_brake[r_ref > 0 ? RL : RR] = mag * 0.6;
                esc_throttle_cut = 0.5;
                as.esc_mode = -1;
            }
        }
        as.esc_brake = esc_brake;
    }

    // ------------------------------------------------------------------ sub-stepped spin dynamics
    // Slip with relaxation length (first-order transient tyre model):
    //   d kappa / dt  = (v_sx - |v_x| kappa) / sigma_x,   v_sx = w r - v_x (slip velocity)
    //   d tanA / dt   = (-v_y - |v_x| tanA) / sigma_y
    // In steady state these give the textbook kappa = v_sx/|v_x| and tanA = -v_y/|v_x|, but they
    // stay finite and smooth at standstill (no divide by zero, a parked car holds still).
    // Integrated with implicit Euler:  k_{n+1} = (k_n + h v_sx / s) / (1 + h |v_x| / s)  (stable
    // for any step size).
    const int n_sub = std::max(1, (int)std::ceil(dt / max_substep - 1e-9));
    const double h = dt / n_sub;
    std::array<double, 4> fx_sum{}, fy_sum{}, mz_sum{}, kerb_ratio_sum{};
    DrivetrainInput din{input_.throttle, input_.clutch, input_.brake, input_.handbrake, input_.gear,
                        damage_.engine_power};
    din.brake_power_scale = damage_.brakes;
    din.nos_active = input_.nos;
    din.starter_crank = input_.starter;
    din.airspeed_mps = std::abs(out.speed);
    din.radiator_cooling_scale = damage_.radiator_cooling;
    din.bearing_drag_nm = damage_.bearing_drag_nm;
    din.atmosphere_enabled = atmosphere_.enabled;
    din.ambient_air_c = atmosphere_.ambient_air_c;
    din.altitude_m = atmosphere_.altitude_m;
    din.humidity_0_to_1 = atmosphere_.humidity_0_to_1;
    // ---- ASSIST: auto-clutch (sits on top of the physical clutch disc; drivetrain only sees a pedal value)
    // Modulates around the physical bite point for smooth launches & anti-stall, and declutches on shifts
    // according to AutoClutchQuality:
    //   Perfect: full declutch held until synchromesh completes + smooth release (zero missed shifts)
    //   Normal:  clean normal shifts; slamming rapid shifts shortens hold and can slow-sync / grind
    //   Poor:    brief / sloppy declutch while keeping partial throttle -> can miss shifts & damage gearbox
    since_shift_timer_ += dt;
    if (input_.auto_clutch) {
        const AutoClutchQuality q = input_.auto_clutch_quality;
        if (input_.gear != last_gear_) {
            if (input_.gear != 1) {
                if (q == AutoClutchQuality::Perfect) {
                    shift_timer_ = 0.12;
                    shift_release_timer_ = 0.035;
                } else if (q == AutoClutchQuality::Normal) {
                    // Rapid shift-slamming (< 0.35 s between shifts) rushes the clutch release.
                    shift_timer_ = (since_shift_timer_ < 0.35) ? 0.032 : 0.11;
                    shift_release_timer_ = 0.025;
                } else {
                    // Poor auto-clutch: too brief for synchromesh under load.
                    shift_timer_ = 0.022;
                    shift_release_timer_ = 0.0;
                }
            } else {
                shift_timer_ = 0.0;
                shift_release_timer_ = 0.0;
            }
            since_shift_timer_ = 0.0;
        }

        // Recover after a missed shift penalty window so auto-clutch drivers aren't soft-locked in Neutral.
        if (drivetrain_.systems.sync_state == SyncState::Missed) {
            missed_recover_timer_ += dt;
            if (missed_recover_timer_ >= 0.45) {
                din.clutch = 1.0;
                din.throttle = 0.0;
            }
        } else {
            missed_recover_timer_ = 0.0;
        }

        const bool sync_hold = (q == AutoClutchQuality::Perfect) && drivetrain_.is_synchronizing();
        if (shift_timer_ > 0.0 || sync_hold) {
            shift_timer_ = std::max(0.0, shift_timer_ - dt);
            if (q == AutoClutchQuality::Poor) {
                din.clutch = std::max(din.clutch, 0.72);
                din.throttle *= 0.65;
            } else {
                din.clutch = 1.0;
                din.throttle = 0.0;
            }
        } else if (shift_release_timer_ > 0.0) {
            shift_release_timer_ = std::max(0.0, shift_release_timer_ - dt);
            const double frac = clamp(shift_release_timer_ / 0.035, 0.0, 1.0);
            din.clutch = std::max(din.clutch, frac * cfg_.drivetrain.clutch.bite_point);
        }

        const auto& ratios = cfg_.drivetrain.gear_ratios;
        if (input_.gear >= 0 && input_.gear < (int)ratios.size() && ratios[input_.gear] != 0.0) {
            double engage = clamp((drivetrain_.engine_rpm() - (cfg_.engine.idle_rpm + 250.0)) / 1500.0, 0.0, 1.0);
            double launch_clutch = lerp(std::min(0.95, cfg_.drivetrain.clutch.bite_point + 0.08), 0.0, engage);
            din.clutch = std::max(din.clutch, launch_clutch);
        }
    }
    last_gear_ = input_.gear;
    const double throttle_after_shift = din.throttle;
    if (!disc_init_) { disc_temp_.fill(cfg_.brake_thermal.start_temp_c); disc_init_ = true; }
    for (int w = 0; w < 4; ++w) din.pad_mu[w] = brake_pad_mu(disc_temp_[w]);
    bool missed_this_tick = false;
    for (int step = 0; step < n_sub; ++step) {
        std::array<double, 4> tyre_t{}, roll_t{};
        for (int w = 0; w < 4; ++w) {
            const TireParams& tp = cfg_.tire(w);
            if (!touching[w]) {
                kappa_[w] *= 0.9;
                tan_alpha_[w] *= 0.9;
                tire_condition_[w].update(0.0, 0.0, length(s.velocity), h, &tp);
                continue;
            }
            const Kin& k = kin[w];
            double v_sx = drivetrain_.wheel_omega[w] * k.re - k.vx;
            kappa_[w] = (kappa_[w] + h * v_sx / k.sigma_x) / (1.0 + h * std::abs(k.vx) / k.sigma_x);
            tan_alpha_[w] = (tan_alpha_[w] + h * (-k.vy) / k.sigma_y) / (1.0 + h * std::abs(k.vx) / k.sigma_y);
            TireOperating op;
            op.slip_speed = std::hypot(v_sx, k.vy);           // contact patch sliding speed
            op.dpi = tire_condition_[w].dpi(tp);              // hot inflation pressure vs. nominal
            op.phi = -yaw_rate / std::max(std::abs(k.vx), 0.5);       // turn slip: patch spin / rolling speed
            op.enable_mf62_hybrid = tire_zones_enabled;
            op.enable_contact_patch_grid = tire_patch_grid_enabled;
            op.wheel_side_sign = (w % 2 == 0) ? -1.0 : 1.0;
            op.gamma_rate_rads = k.gamma_rate;
            op.rolling_speed_mps = k.vx;
            op.yaw_rate_rads = yaw_rate;
            op.condition = &tire_condition_[w];
            op.patch = contacts[w].patch_profile.has_height_map ? &contacts[w].patch_profile : nullptr;
            TireForces f = magic_formula(tp, kappa_[w], tan_alpha_[w], k.load, k.mu, k.gamma, op);
            tire_condition_[w].contact_patch_length_m = f.contact_patch_length_m;
            fx_sum[w] += f.fx;
            fy_sum[w] += f.fy;
            mz_sum[w] += f.mz;
            kerb_ratio_sum[w] += f.kerb_load_ratio;
            double slip_power = std::abs(f.fx * v_sx) + std::abs(f.fy * k.vy);
            wheel_angle_[w] += drivetrain_.wheel_omega[w] * h;
            if (tire_zones_enabled) {
                const double side_sign = (w % 2 == 0) ? -1.0 : 1.0;
                tire_condition_[w].update_zones(slip_power, k.load, std::hypot(k.vx, k.vy), k.gamma, f.fy,
                                                side_sign, drivetrain_.wheel_omega[w], wheel_angle_[w], h, &tp);
                tire_condition_[w].step_rigid_ring_belt(f.fx, f.fy, k.re, h, &tp);
            } else {
                tire_condition_[w].update(slip_power, k.load, std::hypot(k.vx, k.vy), h, &tp);
            }
            tyre_t[w] = -f.fx * k.re;                                // road pushes back on the wheel
            double c_rr = rolling_resistance_coeff(tp, k.vx, op.dpi);
            roll_t[w] = c_rr * k.load * k.re;
        }
        // ---- ASSIST: ABS. Per wheel, adjust brake pressure to hold the slip ratio at the target
        // (near the tyre's force peak). Integral control on slip error:
        //   p += h * gain * (kappa + target)   (kappa < -target -> too much slip -> release)
        for (int w = 0; w < 4; ++w) {
            if (assists_.abs && input_.brake > 0.01 && touching[w] && std::abs(kin[w].vx) > 2.0) {
                abs_pressure_[w] = clamp(abs_pressure_[w] + h * assists_.abs_gain * (kappa_[w] + assists_.abs_slip_target), 0.0, 1.0);
            } else {
                abs_pressure_[w] = 1.0;
            }
            double vapor_scale = 1.0;
            if (chassis_dyn_.brake_fluid_boil_enabled && fluid_temp_[w] > 260.0) {
                const double sponge = clamp((fluid_temp_[w] - 260.0) / 85.0, 0.0, 0.55);
                vapor_scale = 1.0 - sponge;
                out.brake_vapor_lock_sponge = std::max(out.brake_vapor_lock_sponge, sponge);
            }
            din.brake_scale[w] = abs_pressure_[w] * vapor_scale;
            din.extra_brake[w] = esc_brake[w];
        }
        // ---- ASSIST: TC. Cut engine torque in proportion to driven-wheel slip above target,
        // filtered over ~30 ms (like an ignition/throttle cut).
        double cut_target = 0;
        if (assists_.tc) {
            double slip = 0;
            for (int w = 0; w < 4; ++w)
                if (cfg_.axle(w).driven && touching[w]) slip = std::max(slip, kappa_[w] * sign(kin[w].vx + 1e-9));
            cut_target = clamp((slip - assists_.tc_slip_target) * assists_.tc_gain, 0.0, 1.0);
        }
        tc_cut_ += (cut_target - tc_cut_) * std::min(1.0, h / 0.03);
        din.throttle = throttle_after_shift * (1.0 - tc_cut_) * (1.0 - esc_throttle_cut);
        drivetrain_.step(din, tyre_t, roll_t, h);
        missed_this_tick |= drivetrain_.systems.missed_shift_event;
        // ---- brake discs: heated by the friction power the pads absorb (T_brake |w|; a locked wheel heats the tyre,
        // not the disc), cooled by airflow (vented disc: h = base + k v) and radiation (eps sigma A (T^4 - Ta^4)).
        const BrakeThermal& bt = cfg_.brake_thermal;
        const double v_car = length(s.velocity);
        for (int w = 0; w < 4; ++w) {
            const bool front = w < 2;
            const double cap = (front ? bt.disc_mass_front : bt.disc_mass_rear) * 460.0;
            const double area = front ? bt.disc_area_front : bt.disc_area_rear;
            const double amb_brake_c = atmosphere_.enabled ? atmosphere_.ambient_air_c : 25.0;
            const double tk = disc_temp_[w] + 273.15, ta = amb_brake_c + 273.15;
            const double heat = drivetrain_.brake_torque[w] * std::abs(drivetrain_.wheel_omega[w]);
            const double cool = (bt.cooling_base + bt.cooling_per_mps * v_car) * (disc_temp_[w] - amb_brake_c)
                              + 0.55 * 5.670e-8 * area * (tk * tk * tk * tk - ta * ta * ta * ta);
            disc_temp_[w] = clamp(disc_temp_[w] + h * (heat - cool) / cap, -20.0, 1100.0);
            din.pad_mu[w] = brake_pad_mu(disc_temp_[w]);
            // Caliper DOT 4 brake fluid heat soak from hot rotor through pad + convective airflow cooling
            const double fluid_amb_c = atmosphere_.enabled ? (atmosphere_.ambient_air_c + 15.0) : 40.0;
            const double d_fluid = 0.025 * std::max(0.0, disc_temp_[w] - fluid_temp_[w])
                                 - (0.012 + 0.0015 * v_car) * (fluid_temp_[w] - fluid_amb_c);
            fluid_temp_[w] = clamp(fluid_temp_[w] + h * d_fluid, -10.0, 360.0);
            pad_wear_[w] = clamp(pad_wear_[w] + heat * 2.5e-10 * h, 0.0, 1.0);
        }
    }
    for (int w = 0; w < 4; ++w) {
        as.abs_pressure[w] = abs_pressure_[w];
        as.abs_active[w] = abs_pressure_[w] < 0.98;
    }
    as.tc_cut = tc_cut_;
    out.throttle_applied = din.throttle;
    out.brake_applied = input_.brake;

    // ------------------------------------------------------------------ forces on the chassis
    Vec3 force, torque;
    std::array<double, 2> axle_fy{};
    std::array<double, 4> wheel_fy{};
    for (int w = 0; w < 4; ++w) {
        WheelOutput& wo = out.wheels[w];
        const TireParams& tp = cfg_.tire(w);
        const int a = w < 2 ? 0 : 1;
        double droop = cfg_.axle(w).spring_rest_length - comp[w];
        wo.centre_world = rays[w].origin + rays[w].direction * droop
                        + s.orientation.rotate({wheel_kin[w].wheel_offset.x, wheel_kin[w].wheel_offset.y, 0.0});
        wo.angular_velocity = drivetrain_.wheel_omega[w];
        wo.slip_ratio = kappa_[w];
        wo.slip_angle = std::atan(tan_alpha_[w]);
        wo.condition = tire_condition_[w];
        wo.brake_temp_c = disc_temp_[w];
        wo.brake_mu = brake_pad_mu(disc_temp_[w]);
        wo.brake_fluid_temp_c = fluid_temp_[w];
        wo.brake_pad_wear = pad_wear_[w];
        if (!touching[w]) continue;
        const Kin& k = kin[w];
        double fx = fx_sum[w] / n_sub, fy = fy_sum[w] / n_sub, mz = mz_sum[w] / n_sub;
        prev_fx_[w] = fx;
        if (w < 2 && cfg_.axle(w).max_steer_deg > 0) {
            // Rack torque about the steering axis: the tyre's aligning moment plus the lateral force acting on the
            // kinematic caster trail + speed-synchronous flat-spot FFB thump when a front tyre is flat-spotted.
            const double trail = wheel_kin[w].caster_trail_m + tp.radius * std::tan(damage_.caster[w]);
            const double flat_thump = tire_zones_enabled
                                    ? tire_condition_[w].flat_spot_ffb_torque_nm(wheel_angle_[w], k.load, std::hypot(k.vx, k.vy))
                                    : 0.0;
            out.steer_torque += (mz - fy * trail) * k.ffb_hydro_scale + flat_thump;
        }
        // Low-speed damping (below ~2 m/s): the relaxation-length model acts like an undamped
        // spring at standstill; real tyres have internal damping. Blends out with speed.
        double speed = std::hypot(k.vx, k.vy);
        double blend = clamp(1.0 - speed / 2.0, 0.0, 1.0);
        if (blend > 0) {
            double c = 2.0 * k.load;   // N per (m/s)
            fx += blend * c * (drivetrain_.wheel_omega[w] * k.re - k.vx);
            fy += blend * c * (-k.vy);
            double fmax = std::max(tp.mu_x, tp.mu_y) * k.mu * k.load;   // never exceed friction
            double fm = std::hypot(fx, fy);
            if (fm > fmax) { fx *= fmax / fm; fy *= fmax / fm; }
        }
        wo.contact = true;
        wo.load = k.load;
        wo.compression = comp[w];
        wo.camber = k.gamma;
        wo.fx = fx;
        wo.fy = fy;
        wo.mz = mz;
        wo.contact_point = k.point;
        wo.force_world = k.fwd * fx + k.lat * fy;
        wo.grip_limit = std::max(tp.mu_x, tp.mu_y) * k.mu * k.load;
        double kerb_ratio = kerb_ratio_sum[w] / n_sub;
        if (contacts[w].surface >= 0 && contacts[w].surface < static_cast<int>(cfg_.surface_grip.size())
            && cfg_.surface_grip[contacts[w].surface].first == "kerb"
            && !contacts[w].patch_profile.has_height_map) {
            kerb_ratio = std::max(kerb_ratio, 1.0);
        }
        if (std::abs(contacts[w].enveloping_slope_tan) > 0.01) {
            kerb_ratio = std::max(kerb_ratio, clamp(std::abs(contacts[w].enveloping_slope_tan) / 0.15, 0.0, 1.0));
        }
        wo.kerb_load_ratio = clamp(kerb_ratio, 0.0, 1.0);
        const double v_roll = std::hypot(k.vx, k.vy);
        const double vert_excite = clamp((std::abs(comp_rate[w]) + 0.6 * std::abs(wo.unsprung_vel_mps)) / 1.2, 0.0, 1.0);
        const double kerb_excite = wo.kerb_load_ratio * (0.25 + 0.55 * clamp(v_roll / 25.0, 0.0, 1.0))
                                 + clamp(std::abs(contacts[w].enveloping_slope_tan) * 2.5, 0.0, 0.6);
        const double surf_rough = clamp(1.0 - cfg_.grip_for_surface(contacts[w].surface), 0.0, 0.5) * clamp(v_roll / 20.0, 0.0, 1.0)
                                + clamp(contacts[w].water_depth_mm / 6.0, 0.0, 0.4) * clamp(v_roll / 20.0, 0.0, 1.0);
        const double base_rumble = 0.05 * clamp(v_roll / 50.0, 0.0, 1.0);
        wo.surface_excitation = clamp(vert_excite + kerb_excite + surf_rough + base_rumble, 0.0, 1.0);
        // Suspension force acts along the body's up axis (plus symmetric heave jacking force);
        // longitudinal tyre force at the contact patch; lateral tyre force at the dynamic
        // roll-centre height (handles the roll-moment geometric transfer without double-counting);
        // residual self-aligning torque Mz acts about the contact normal.
        Vec3 f_susp = up * (susp_force[w] + 0.5 * axle_jack_heave[a]);
        Vec3 f_long = k.fwd * fx;
        Vec3 f_lat = k.lat * fy;
        Vec3 p_lat = k.point + up * axle_rch[a];
        force += f_susp + f_long + f_lat;
        axle_fy[a] += fy;
        wheel_fy[w] = fy;
        torque += cross(k.point - s.position, f_susp + f_long) + cross(p_lat - s.position, f_lat) + k.normal * (0.15 * mz);
    }

    prev_axle_fy_ = axle_fy;
    prev_fy_ = wheel_fy;

    // ---- Active Torque-Vectoring E-Diff / Active Yaw Control (AYC)
    if (chassis_dyn_.active_yaw_control_enabled && out.speed > 4.0 && input_.throttle > 0.12 && (touching[RL] || touching[RR])) {
        const double yaw_err = as.yaw_rate_ref - yaw_rate;
        out.ayc_yaw_moment_nm = clamp(yaw_err * 2600.0 * input_.throttle,
                                      -chassis_dyn_.ayc_max_yaw_moment_nm,
                                      chassis_dyn_.ayc_max_yaw_moment_nm);
        torque += up * out.ayc_yaw_moment_nm;
    }

    // ------------------------------------------------------------------ aerodynamics
    // Drag:      F = -1/2 rho CdA |v| v * slipstream_drag_scale * yaw_drag_mult * active_aero_drag_mult
    // Downforce: F = 1/2 rho ClA v_x^2, split between the axles by aero balance (with dirty-air front loss, yaw stall & Active Aero).
    const AeroParams& a = cfg_.aero;
    double v = length(s.velocity);
    out.drs_active = chassis_dyn_.active_aero_enabled && out.speed > 50.0 && input_.throttle > 0.75
                   && input_.brake < 0.05 && std::abs(input_.steer) < 0.12;
    out.airbrake_active = chassis_dyn_.active_aero_enabled && out.speed > 22.0 && input_.brake > 0.55;
    const double active_drag_mult = out.drs_active ? 0.86 : (out.airbrake_active ? 1.24 : 1.0);
    const double active_rear_down_mult = out.drs_active ? 0.82 : (out.airbrake_active ? 1.22 : 1.0);

    const double sin_beta = std::sin(clamp(out.sideslip, -1.2, 1.2));
    const double yaw_drag_mult = aero_wake_.yaw_aero_enabled ? (1.0 + 0.35 * sin_beta * sin_beta) : 1.0;
    const double yaw_rear_down_mult = aero_wake_.yaw_aero_enabled ? (1.0 - 0.30 * sin_beta * sin_beta) : 1.0;
    const double eff_drag_scale = clamp(aero_wake_.drag_scale, 0.65, 1.2) * yaw_drag_mult * active_drag_mult;
    double eff_front_down_scale = clamp(aero_wake_.dirty_air_front_downforce_scale, 0.55, 1.1);
    const double rho_air = atmosphere_.enabled ? atmosphere_.air_density_kg_m3() : a.air_density;
    out.air_density_kg_m3 = rho_air;

    force += s.velocity * (-0.5 * rho_air * a.drag_area * damage_.aero_drag * eff_drag_scale * v);
    double vx_body = dot(s.velocity, s.orientation.rotate({1, 0, 0}));
    // Ride height & 2D Non-Linear Ground-Effect Aero Map:
    // Lower ride height increases underbody venturi downforce until the front splitter bottoms out past its choke threshold
    // (dz_f > 0.88 * max_compression), where underbody airflow partially stalls (aero porpoising / high-speed bottoming push).
    const double dz_f = 0.5 * (dz_[FL] + dz_[FR]), dz_r = 0.5 * (dz_[RL] + dz_[RR]);
    if (chassis_dyn_.active_aero_enabled && dz_f > cfg_.front.max_compression * 0.85 && out.speed > 35.0) {
        out.front_splitter_stalled = true;
        eff_front_down_scale *= 0.74; // -26% front venturi stall when splitter chokes against asphalt
    }
    const double ground = clamp(1.0 + a.ground_effect_per_m * 0.5 * (dz_f + dz_r), 0.6, 1.5);
    const double balance = clamp(a.front_balance + a.pitch_balance_per_m * (dz_f - dz_r), 0.05, 0.95);
    double down = 0.5 * rho_air * a.lift_area * ground * vx_body * vx_body;
    Vec3 p_front = s.position + s.orientation.rotate({cfg_.dist_cg_front, 0, 0});
    Vec3 p_rear = s.position + s.orientation.rotate({-cfg_.dist_cg_rear, 0, 0});
    Vec3 f_front = up * (-down * balance * eff_front_down_scale);
    Vec3 f_rear = up * (-down * (1 - balance) * yaw_rear_down_mult * active_rear_down_mult);
    force += f_front + f_rear;
    torque += cross(p_front - s.position, f_front) + cross(p_rear - s.position, f_rear);

    out.force = force;
    out.torque = torque;
    out.mass_kg = current_mass();
    out.effective_inertia = current_inertia();
    out.accel = s.orientation.inv_rotate(force) / out.mass_kg;
    out.engine_rpm = drivetrain_.engine_rpm();
    out.gear = drivetrain_.systems.engaged_gear >= 0 ? drivetrain_.systems.engaged_gear : input_.gear;
    out.engine_stalled = drivetrain_.stalled;
    const int cyl = cfg_.engine.cylinders > 0 ? cfg_.engine.cylinders : 8;
    out.exhaust_primary_hz = (!out.engine_stalled && out.engine_rpm > 0.0)
                           ? (out.engine_rpm * static_cast<double>(cyl) / 120.0)
                           : 0.0;
    int active_drive_teeth = 0;
    if (out.gear >= 0 && out.gear != 1) {
        if (out.gear < static_cast<int>(cfg_.drivetrain.gear_teeth.size())) {
            active_drive_teeth = std::abs(cfg_.drivetrain.gear_teeth[out.gear][1]);
        } else if (out.gear < static_cast<int>(cfg_.drivetrain.gear_ratios.size())
                   && std::abs(cfg_.drivetrain.gear_ratios[out.gear]) > 1e-6) {
            active_drive_teeth = std::clamp(static_cast<int>(std::lround(65.0 / (1.0 + std::abs(cfg_.drivetrain.gear_ratios[out.gear])))), 12, 42);
        }
    }
    out.gear_whine_hz = (active_drive_teeth > 0)
                      ? (std::abs(drivetrain_.systems.input_shaft_omega) * static_cast<double>(active_drive_teeth) / (2.0 * kPi))
                      : 0.0;
    out.turbo_surge = clamp(drivetrain_.systems.turbo_surge, 0.0, 1.0);
    out.boost_bar = drivetrain_.systems.boost_bar;
    out.bov_venting = drivetrain_.systems.bov_venting;
    out.intake_air_temp_c = drivetrain_.systems.intake_air_temp_c;
    out.nos_remaining_l = drivetrain_.systems.nos_bottles_l;
    out.oil_temp_c = drivetrain_.systems.oil_temp_c;
    out.engine_health = drivetrain_.systems.engine_health;
    out.engine_misfire = drivetrain_.systems.misfiring;
    out.fuel_liters = drivetrain_.systems.fuel_liters;
    out.gear_grind = drivetrain_.systems.gear_grind;
    out.shift_cut_active = drivetrain_.systems.shift_cut_active;
    out.driveline_clunk_nm = drivetrain_.systems.driveline_clunk_nm;
    out.clutch_temp_c = drivetrain_.systems.clutch_temp_c;
    out.clutch_health = drivetrain_.systems.clutch_health;
    out.gearbox_health = drivetrain_.systems.gearbox_health;
    out.missed_shifts = drivetrain_.systems.missed_shifts;
    out.missed_shift_event = missed_this_tick;
    out.clutch_torque_nm = drivetrain_.clutch_torque;
    out.clutch_locked = drivetrain_.systems.clutch_locked;
    out.slipstream_drag_scale = eff_drag_scale;
    out.dirty_air_downforce_scale = eff_front_down_scale;
    return out;
}

}  // namespace rs
