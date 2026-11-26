#include "rs/vehicle.hpp"
#include "rs/pinnacle.hpp"
#include <cmath>

namespace rs {

/**
 * Brake pad friction vs. disc temperature, relative to its working range (track-day / sport pad on a vented iron disc).
 * Cold pads bite ~15 % less; 300-650 C is the plateau; past ~700 C the resin gasses out and the pads fade, slowly at
 * first (0.95 at 750 C, 0.85 at 850 C, 0.6 at 1050 C). Brake torque at full pedal = brake_torque_total * this.
 */
double brake_pad_mu(double t, BrakeDiscType type) {
    if (type == BrakeDiscType::CarbonCarbon) {
        // LMU Hypercar / LMP2 / F1 carbon-carbon brakes: glazed low cold bite (0.58), steep non-linear mid-stop bite
        // surge between 300-600 C (peaks at 1.04!), stays strong to 950 C before oxidation fade.
        static const double TC[] = {0, 100, 200, 350, 500, 720, 900, 1050, 1150};
        static const double MC[] = {0.56, 0.62, 0.72, 0.94, 1.04, 1.04, 0.96, 0.80, 0.65};
        if (t <= TC[0]) return MC[0];
        for (int i = 1; i < 9; ++i) if (t <= TC[i]) return MC[i - 1] + (MC[i] - MC[i - 1]) * (t - TC[i - 1]) / (TC[i] - TC[i - 1]);
        return MC[8];
    }
    if (type == BrakeDiscType::CarbonCeramic) {
        static const double TM[] = {0, 100, 200, 300, 780, 900, 1050, 1150};
        static const double MM[] = {0.82, 0.92, 0.99, 1.00, 1.00, 0.94, 0.80, 0.68};
        if (t <= TM[0]) return MM[0];
        for (int i = 1; i < 8; ++i) if (t <= TM[i]) return MM[i - 1] + (MM[i] - MM[i - 1]) * (t - TM[i - 1]) / (TM[i] - TM[i - 1]);
        return MM[7];
    }
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

// The multi-ray resolvers rebuild a contact's GEOMETRY (distance, point, normal, height profile) from several ray hits, but
// the ground also reports non-geometric data on each hit: the water film, the street-surface grip multiplier, rubber marbles
// and the per-cell grip of the patch (wet manhole iron, paint). Carry that over from the hit that set the contact
// (`surface_hit`) and the centre ray, or the same road would grip differently depending on the ray mode. (Heights are not
// copied: the resolvers build them from the ray hits themselves.)
void carry_ground_data(WheelContact& out, const WheelContact& surface_hit, const WheelContact& centre_hit) {
    out.surface_mu_mult = surface_hit.surface_mu_mult;
    out.marble_density = surface_hit.marble_density;
    out.track_temp_c = surface_hit.track_temp_c;
    const ContactPatchProfile& src = centre_hit.patch_profile;
    ContactPatchProfile& dst = out.patch_profile;
    bool uneven = false;
    for (int i = 0; i < kPatchPoints; ++i) {
        dst.mu_cell[i] *= src.mu_cell[i];
        if (!src.contact_mask[i]) dst.contact_mask[i] = false;
        if (src.mu_cell[i] < 0.99 || !src.contact_mask[i]) uneven = true;
    }
    if (uneven) dst.has_height_map = true;   // "non-uniform" covers the grip cells and the mask as well as the heights
}
}  // namespace

Vehicle::Vehicle(const CarConfig& cfg)
    : cfg_(cfg), damage_model_(cfg.mass, wheel_points(cfg)), drivetrain_(cfg_) {
    if (cfg_.torsional_stiffness_nm_per_deg > 0.0) {
        chassis_dyn_.torsional_stiffness_nm_per_deg = cfg_.torsional_stiffness_nm_per_deg;
    }
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

void Vehicle::soak_tyre(int w, double temp_c, double wear) {
    TireCondition& c = tire_condition_[w];
    c.temperature_c = c.surface_c = c.flash_c = c.inner_c = c.middle_c = c.outer_c = temp_c;
    c.inner_air_c = std::min(temp_c, clamp(0.45 * c.ambient_air_c + 0.55 * temp_c, -25.0, 160.0));
    c.last_carcass_c_ = c.temperature_c;
    c.last_inner_air_c_ = c.inner_air_c;
    c.wear = clamp(wear, 0.0, 1.0);
    c.pressure_kpa = c.ideal_gas_pressure_kpa(&cfg_.tire(w));
}

void Vehicle::set_tyres(double temp_c, double wear) {
    for (int w = 0; w < 4; ++w) soak_tyre(w, temp_c, wear);
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
    for (int w = 0; w < 4; ++w) {
        tire_condition_[w].repair_structural(&cfg_.tire(w));
        puncture_deflate_[w] = 0.0;
    }
}

void Vehicle::reset_motion(double v, int gear) {
    for (int w = 0; w < 4; ++w) {
        drivetrain_.wheel_omega[w] = v / cfg_.tire(w).radius;
        kappa_[w] = tan_alpha_[w] = 0;
        tire_condition_[w] = TireCondition{};
        soak_tyre(w, cfg_.tire(w).start_c, 0.0);   // warmed for the compound (like the brakes)
        disc_temp_[w] = cfg_.brake_thermal.start_temp_c;
        wheel_angle_[w] = 0.0;
        unsprung_z_[w] = 0.0;
        unsprung_vz_[w] = 0.0;
        fluid_temp_[w] = 45.0;
        pad_wear_[w] = 0.0;
        brake_water_film_[w] = 0.0;
        puncture_deflate_[w] = 0.0;
    }
    disc_init_ = true;
    EngineSystemState& sys = drivetrain_.systems;
    sys.clutch_temp_c = 40.0;
    sys.clutch_health = 1.0;
    sys.clutch_locked = false;
    sys.tc_slip_ratio = 1.0;
    sys.tc_torque_ratio = 1.0;
    sys.tc_lockup_frac = 0.0;
    sys.tc_lockup_engaged = false;
    sys.torsional_twist_rad = 0.0;
    sys.torsional_twist_mean_rad = 0.0;
    sys.torsional_vel_rads = 0.0;
    sys.driveline_clunk_nm = 0.0;
    sys.last_backlash_side = 0;
    prev_steer_rad_ = 0.0;
    prev_steer_vel_rads_ = 0.0;
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
    sys.shift_cut_active = false;
    sys.shift_cut_timer_s = 0.0;
    sys.auto_blip_active = false;
    sys.auto_blip_throttle = 0.0;
    sys.dog_blip_timer_s = 0.0;
    sys.dog_pending_gear = -1;
    sys.dct_handoff_timer_s = 0.0;
    sys.shift_clunk_impulse_nm = 0.0;
    shift_timer_ = 0.0;
    shift_release_timer_ = 0.0;
    shift_release_duration_ = 0.035;
    amt_downshift_ = false;
    dct_blip_timer_ = 0.0;
    since_shift_timer_ = 10.0;
    missed_recover_timer_ = 0.0;
    recovering_from_miss_ = false;
    const auto& g = cfg_.drivetrain.gear_ratios;
    if (gear >= 0 && gear < (int)g.size() && g[gear] != 0.0) {
        double idle_w = cfg_.engine.idle_rpm * 2.0 * kPi / 60.0;
        double shaft_w = v / cfg_.tire(RL).radius * g[gear] * cfg_.drivetrain.final_drive;
        drivetrain_.engine_omega = std::max(idle_w, shaft_w);
        drivetrain_.stalled = false;
        sys.engaged_gear = gear;
        last_gear_ = gear;
        sys.input_shaft_omega = shaft_w;
    } else if (gear == 1) {
        sys.engaged_gear = 1;
        last_gear_ = 1;
        sys.input_shaft_omega = drivetrain_.engine_omega;
    }
    prev_axle_fy_ = {0, 0};
    prev_fy_ = {0, 0, 0, 0};
    // The rest of the per-step carry-over, so a reset car starts like a fresh Vehicle (a replay after reset() is then
    // repeatable): last step's tyre Fx (anti-dive / anti-squat and bushing compliance), the suspension travel the
    // kinematics lookups start from, and the ABS / traction-control intervention state.
    prev_fx_ = {0, 0, 0, 0};
    dz_ = {0, 0, 0, 0};
    abs_pressure_ = {1, 1, 1, 1};
    tc_cut_ = 0;
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
    const Vec3 body_fwd = s.orientation.rotate({1, 0, 0});
    for (int w = 0; w < 4; ++w) {
        const WheelGeom& g = cfg_.wheels[w];
        // Detached wheel drops the corner onto the bare brake rotor / knuckle (~48% of tyre radius, ~16 cm);
        // bent struts sag the corner up to 4.2 cm even before the wheel detaches.
        const bool off = damage_enabled && damage_model_.wheel_off(w);
        const double sag = (damage_enabled && !off) ? damage_model_.strut_sag_m(w) : 0.0;
        const double r_eff = std::max(0.10, cfg_.tire(w).radius * (off ? 0.48 : 1.0) - sag);
        rays[w].origin = s.position + s.orientation.rotate({g.x, g.y, g.mount_z});
        rays[w].direction = down;
        rays[w].length = cfg_.axle(w).spring_rest_length + r_eff;
        rays[w].forward = body_fwd;
    }
    return rays;
}

std::array<WheelContactPatchRays, 4> Vehicle::wheel_contact_patch_rays(const ChassisState& s) const {
    std::array<WheelContactPatchRays, 4> out;
    const Vec3 down = s.orientation.rotate({0, 0, -1});
    for (int w = 0; w < 4; ++w) {
        const WheelGeom& g = cfg_.wheels[w];
        const bool off = damage_enabled && damage_model_.wheel_off(w);
        const double sag = (damage_enabled && !off) ? damage_model_.strut_sag_m(w) : 0.0;
        const double r = std::max(0.10, cfg_.tire(w).radius * (off ? 0.48 : 1.0) - sag);
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
            out[w].rays[i].forward = wheel_fwd;
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
    int best_i = 0;

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
            best_i = i;
        }
        best.water_depth_mm = std::max(best.water_depth_mm, hits[i].water_depth_mm);   // the deepest film under the patch
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
    carry_ground_data(best, hits[best_i], hits[0].hit ? hits[0] : hits[best_i]);
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
        const bool off = damage_enabled && damage_model_.wheel_off(w);
        const double sag = (damage_enabled && !off) ? damage_model_.strut_sag_m(w) : 0.0;
        const double r = std::max(0.10, cfg_.tire(w).radius * (off ? 0.48 : 1.0) - sag);
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
                out[w].rays[idx].forward = wheel_fwd;
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
        out[w].rays[15].forward = wheel_fwd;
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
    int best_i = 7;

    for (int i = 0; i < 16; ++i) {
        if (!hits[i].hit) continue;
        best.water_depth_mm = std::max(best.water_depth_mm, hits[i].water_depth_mm);   // the deepest film under the footprint
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
            best_i = i;
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
    // MF-Swift-style MF-Swift 3D Tandem Elliptical Cam Obstacle Enveloping Slope:
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
    carry_ground_data(best, hits[best_i], hits[7].hit ? hits[7] : hits[best_i]);
    return best;
}

AeroWakeState Vehicle::compute_aero_wake_field(const Vec3& my_pos, const Vec3& my_vel, const Vec3& my_fwd,
                                               const std::vector<AeroTrafficCar>& nearby_cars,
                                               const Vec3& ambient_wind_world_mps, double sim_time_s) {
    AeroWakeState wake;
    wake.wake_phase_s = sim_time_s;
    const Vec3 fwd = length(my_fwd) > 1e-6 ? normalized(my_fwd) : Vec3{1.0, 0.0, 0.0};
    Vec3 left = cross({0.0, 0.0, 1.0}, fwd);
    left = length(left) > 1e-6 ? normalized(left) : Vec3{0.0, 1.0, 0.0};

    const double my_speed = std::max(0.0, dot(my_vel, fwd));
    const double wind_lat = dot(ambient_wind_world_mps, left);

    double tow_single_max = 0.0;
    double tow_sum = 0.0;
    double dirty_front_accum = 0.0;
    double dirty_rear_accum = 0.0;
    double tandem_push_delta = 0.0;
    double side_draft_delta = 0.0;
    double side_draft_rear_df_loss = 0.0;
    double lateral_suction_n = 0.0;
    double wake_turb = 0.0;
    double hot_air_c = 0.0;
    double cool_loss = 0.0;

    for (const AeroTrafficCar& car : nearby_cars) {
        const Vec3 rel = car.position - my_pos;
        if (std::abs(rel.z) > 3.5) continue; // ignore vehicles on overpasses or bridges
        const double lon = dot(rel, fwd);
        const double lat = dot(rel, left);
        if (lon > 58.0 || lon < -14.0 || std::abs(lat) > 14.0) continue;

        const Vec3 other_fwd = length(car.forward) > 1e-6 ? normalized(car.forward) : fwd;
        const double heading_align = dot(other_fwd, fwd);
        const double other_speed = std::max(0.0, dot(car.velocity, other_fwd));
        const double wake_speed = std::max(my_speed, other_speed);
        const double speed_gate = clamp((wake_speed - 10.0) / 22.0, 0.0, 1.0);
        if (speed_gate <= 1e-4) continue;

        const double car_w = clamp(car.width_m, 1.4, 2.5);
        const double drag_ref = clamp(car.drag_area / 0.68, 0.55, 1.75);
        const double df_ref = clamp((0.35 + std::max(0.0, car.lift_area)) / 0.70, 0.65, 2.25);

        // A. Lead-car slipstream cone (crosswind-advected), multi-car drafting train, dirty-air understeer,
        //    unsteady vortex-shedding buffeting, and thermal exhaust/radiator wake starvation.
        if (heading_align > 0.45 && lon >= 3.2 && lon <= 55.0) {
            const double t_age = lon / std::max(other_speed, 18.0);
            // Crosswind shifts the shed wake downwind (driver must offset downwind to remain inside the tow!)
            const double wake_center_lat = lat + wind_lat * t_age * 0.72;
            const double eff_lat = std::abs(wake_center_lat);
            const double cone_hw = 0.58 * car_w + 0.038 * lon + 0.025 * std::abs(wind_lat) * t_age;
            if (eff_lat < cone_hw) {
                const double u_lat = eff_lat / cone_hw;
                const double lat_f = clamp((1.0 - u_lat * u_lat) * (1.0 - 0.35 * u_lat * u_lat), 0.0, 1.0);
                const double lon_f = (lon < 8.5)
                    ? clamp((lon - 3.2) / 5.3, 0.25, 1.0)
                    : std::exp(-(lon - 8.5) / 24.0) * clamp((55.0 - lon) / 10.0, 0.0, 1.0);
                const double tow_i = clamp(lat_f * lon_f * speed_gate * std::sqrt(drag_ref), 0.0, 1.0);
                tow_single_max = std::max(tow_single_max, tow_i);
                tow_sum += tow_i;

                // Dirty-air downforce loss (front loses ~2x rear -> authentic cornering understeer in dirty air)
                const double dirty_i = clamp(lat_f * lon_f * speed_gate * std::sqrt(df_ref), 0.0, 1.15);
                dirty_front_accum = 1.0 - (1.0 - dirty_front_accum) * (1.0 - clamp(0.36 * dirty_i, 0.0, 0.42));
                dirty_rear_accum = 1.0 - (1.0 - dirty_rear_accum) * (1.0 - clamp(0.18 * dirty_i, 0.0, 0.22));

                // Unsteady wingtip vortex buffeting (peaks along the wake shear layer & close turbulent core)
                const double shear_boost = 0.65 + 0.55 * std::sin(clamp(u_lat, 0.0, 1.0) * kPi);
                const double turb_i = clamp(lat_f * lon_f * shear_boost * speed_gate * std::sqrt(df_ref), 0.0, 1.0);
                wake_turb = std::max(wake_turb, turb_i);

                // Thermal wake (hot exhaust + radiator discharge decays faster than momentum deficit)
                const double lon_therm = std::exp(-std::max(0.0, lon - 4.0) / 14.0) * clamp((lon - 2.8) / 3.5, 0.0, 1.0);
                const double therm_i = clamp(lat_f * lon_therm * speed_gate, 0.0, 1.0);
                hot_air_c += 10.5 * therm_i;
                cool_loss = std::max(cool_loss, 0.30 * therm_i);
            }
        }

        // B. Bidirectional tandem push-draft: trailing car tucked behind our rear bumper fills our low-pressure
        //    rear base wake, giving the LEAD car up to -13% aerodynamic drag relief!
        if (heading_align > 0.45 && lon <= -3.2 && lon >= -11.5) {
            const double d_back = -lon;
            const double rear_hw = 0.56 * car_w + 0.04 * d_back;
            const double lat_abs = std::abs(lat);
            if (lat_abs < rear_hw) {
                const double u = lat_abs / rear_hw;
                const double lat_p = 1.0 - u * u;
                const double lon_p = (d_back < 5.5)
                    ? clamp((d_back - 3.2) / 2.3, 0.35, 1.0)
                    : clamp((11.5 - d_back) / 6.0, 0.0, 1.0);
                const double push_i = clamp(lat_p * lon_p * speed_gate, 0.0, 1.0);
                tandem_push_delta = std::min(tandem_push_delta, -0.13 * push_i);
            }
        }

        // C. Side-drafting & wheel-to-wheel rear-quarter aero wash:
        //    - Rival alongside our rear quarter (lon in [-5.8, -0.3]) spikes OUR drag (+6..+11%) & disturbs rear DF.
        //    - Our nose alongside rival's rear quarter (lon in [+0.3, +5.8]) gives us a small (-4.5%) drag assist.
        const double lat_abs = std::abs(lat);
        if (heading_align > 0.45 && lat_abs >= 1.35 && lat_abs <= 4.2) {
            const double lat_sd = clamp((4.2 - lat_abs) / 2.3, 0.0, 1.0) * clamp((lat_abs - 1.35) / 0.55, 0.0, 1.0);
            if (lon <= -0.3 && lon >= -5.8) {
                const double lon_sd = 1.0 - clamp(std::abs(lon - (-2.8)) / 3.0, 0.0, 1.0);
                const double sd_hit = clamp(lat_sd * lon_sd * speed_gate, 0.0, 1.0);
                side_draft_delta += 0.105 * sd_hit;
                side_draft_rear_df_loss = std::max(side_draft_rear_df_loss, 0.085 * sd_hit);
                wake_turb = std::max(wake_turb, 0.35 * sd_hit);
            } else if (lon >= 0.3 && lon <= 5.8) {
                const double lon_atk = 1.0 - clamp(std::abs(lon - 2.8) / 3.0, 0.0, 1.0);
                const double sd_atk = clamp(lat_sd * lon_atk * speed_gate, 0.0, 1.0);
                side_draft_delta -= 0.045 * sd_atk;
            }
        }

        // D. Bernoulli Venturi lateral suction during close wheel-to-wheel passes (works for same-dir & opposing passes)
        if (std::abs(lon) < 4.8 && lat_abs >= 1.55 && lat_abs <= 4.2) {
            const double gap = std::max(0.25, lat_abs - 0.5 * (1.90 + car_w));
            const double lon_overlap = clamp(1.0 - std::abs(lon) / 4.8, 0.0, 1.0);
            const double v_pass = 0.5 * (my_speed + length(car.velocity));
            const double suction_mag = clamp(0.11 * v_pass * v_pass * lon_overlap / (gap * gap + 0.35), 0.0, 420.0);
            lateral_suction_n += (lat > 0.0 ? 1.0 : -1.0) * suction_mag;
        }
    }

    // Sub-linear multi-car drafting train stacking (1 car ~ -28%, 2-car train ~ -34%, 3+ car train ~ -38%)
    const double extra_train = std::max(0.0, tow_sum - tow_single_max);
    const double eff_train_tow = tow_single_max + 0.36 * (1.0 - std::exp(-1.1 * extra_train));

    wake.tandem_push_drag_delta = clamp(tandem_push_delta, -0.14, 0.0);
    wake.side_draft_drag_delta = clamp(side_draft_delta, -0.06, 0.12);
    wake.drag_scale = clamp(1.0 - 0.29 * eff_train_tow + wake.tandem_push_drag_delta + wake.side_draft_drag_delta, 0.58, 1.16);
    wake.dirty_air_front_downforce_scale = clamp(1.0 - dirty_front_accum, 0.56, 1.0);
    wake.dirty_air_rear_downforce_scale = clamp((1.0 - dirty_rear_accum) * (1.0 - side_draft_rear_df_loss), 0.74, 1.0);
    wake.lateral_suction_n = clamp(lateral_suction_n, -650.0, 650.0);
    wake.wake_turbulence_0_to_1 = clamp(wake_turb, 0.0, 1.0);
    wake.hot_air_delta_c = clamp(hot_air_c, 0.0, 14.0);
    wake.cooling_airflow_scale = clamp(1.0 - cool_loss, 0.65, 1.0);
    return wake;
}

AeroWakeState Vehicle::compute_slipstream_wake(const Vec3& my_pos, const Vec3& my_fwd, const std::vector<Vec3>& lead_car_positions) {
    const Vec3 fwd = length(my_fwd) > 1e-6 ? normalized(my_fwd) : Vec3{1.0, 0.0, 0.0};
    std::vector<AeroTrafficCar> traffic;
    traffic.reserve(lead_car_positions.size());
    for (const Vec3& p : lead_car_positions) {
        AeroTrafficCar c;
        c.position = p;
        c.velocity = fwd * 55.0; // reference racing speed (~198 km/h) for position-only callers
        c.forward = fwd;
        traffic.push_back(c);
    }
    return compute_aero_wake_field(my_pos, fwd * 55.0, fwd, traffic);
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
        damage_.front_downforce = dm.front_downforce_factor();
        damage_.rear_downforce = dm.rear_downforce_factor();
        damage_.chassis_stiffness = dm.chassis_stiffness_factor();
        damage_.radiator_cooling = dm.radiator_cooling_factor();
        damage_.oil_cooling = dm.oil_cooling_factor();
        damage_.oil_starvation_wear_rate = dm.oil_starvation_wear_rate();
        damage_.fuel_leak_lps = dm.fuel_leak_lps();
        for (int w = 0; w < 4; ++w) {
            damage_.suspension_stiffness[w] = dm.suspension_factor(w);
            damage_.damper_scale[w] = dm.damper_factor(w);
            damage_.strut_sag_m[w] = dm.strut_sag_m(w);
            damage_.toe[w] = dm.toe_offset(w);
            damage_.camber[w] = dm.camber_offset(w);
            damage_.caster[w] = dm.caster_offset(w);
            damage_.bearing_drag_nm[w] = dm.wheel_bearing_drag_nm(w);
            damage_.grip[w] = dm.grip_factor(w);
            damage_.wheel_detached[w] = dm.wheel_off(w);
            damage_.tyre_punctured[w] = dm.tyre_punctured(w);
            damage_.brake_line_ruptured[w] = dm.brake_line_ruptured(w);
            damage_.halfshaft_broken[w] = dm.halfshaft_broken(w);
            // Impact-induced tyre blowout / rim-pinch puncture rapidly deflates pressure toward flat rim (25 kPa gauge)!
            if (damage_.tyre_punctured[w] && !damage_.wheel_detached[w]) [[unlikely]] {
                puncture_deflate_[w] = clamp(puncture_deflate_[w] + dt / 0.85, 0.0, 1.0);
                damage_.grip[w] *= (1.0 - 0.38 * puncture_deflate_[w]);
            } else if (!damage_.tyre_punctured[w]) {
                puncture_deflate_[w] = 0.0;
            }
        }
    } else {
        puncture_deflate_ = {0, 0, 0, 0};
        damage_.front_downforce = 1.0;
        damage_.rear_downforce = 1.0;
        damage_.chassis_stiffness = 1.0;
        damage_.damper_scale = {1, 1, 1, 1};
        damage_.strut_sag_m = {0, 0, 0, 0};
        damage_.oil_cooling = 1.0;
        damage_.oil_starvation_wear_rate = 0.0;
        damage_.fuel_leak_lps = 0.0;
        damage_.wheel_detached = {false, false, false, false};
        damage_.tyre_punctured = {false, false, false, false};
        damage_.brake_line_ruptured = {false, false, false, false};
        damage_.halfshaft_broken = {false, false, false, false};
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
        // Compression rate = how fast the ray's hit distance shrinks, ground assumed static. The hit point is a point
        // fixed to the body (the end of the ray), so its velocity along the ground normal, divided by the cosine
        // between ray and normal, is exactly -d(distance)/dt. (Dotting the mount velocity with the RAY direction, as
        // before, also counted forward speed x sin(pitch): at 86 m/s and 0.3 deg of pitch a false 0.45 m/s of
        // "compression" on every damper at once - a speed-proportional force that fed pitch back into heave and drove
        // a growing heave limit cycle above ~300 km/h.)
        const Vec3 v_hit = s.velocity + cross(s.angular_velocity, rays[w].origin + rays[w].direction * c.distance - s.position);
        comp_rate[w] = -dot(v_hit, c.normal) / std::max(cos_n, 0.35);
    }
    for (int w = 0; w < 4; ++w) {
        if (!touching[w]) continue;
        const AxleParams& ax = cfg_.axle(w);
        double k = ax.spring_rate * damage_.suspension_stiffness[w];
        double f = k * comp[w];
        if (ax.spring_progressive_rate > 0.0) {
            const double dz_prog = comp[w] - cfg_.wheels[w].static_compression;
            f += ax.spring_progressive_rate * damage_.suspension_stiffness[w] * dz_prog * std::abs(dz_prog);
        }
        const double bump_start = cfg_.wheels[w].static_compression + ax.max_compression;
        double bs_exp = ax.bump_stop_exponent;
        double bs_gap = ax.bump_stop_gap_m;
        if (chassis_dyn_.progressive_bump_stops_enabled && bs_exp <= 1.001 && bs_gap <= 1e-6) {
            bs_gap = 0.012; // 12 mm progressive polyurethane jounce packer lead-in
            bs_exp = 2.35;  // cellular elastomer exponential stiffening (smooth onset, steep coil-bind ceiling)
        }
        if (bs_exp > 1.001 || bs_gap > 1e-6) {
            const double bump_onset = std::max(0.0, bump_start - bs_gap);
            if (comp[w] > bump_onset) {
                constexpr double kBumpRef = 0.015;
                const double delta = comp[w] - bump_onset;
                f += ax.bump_stop_rate * kBumpRef * std::pow(delta / kBumpRef, std::max(bs_exp, 1.0));
            }
        } else if (comp[w] > bump_start) {
            f += ax.bump_stop_rate * (comp[w] - bump_start);
        }
        {
            // digressive damper: c below the knee speed, c * ratio above it (blow-off valving),
            // scaled by blown-shock damage (damper_scale down to 0.25 -> bouncy wrecked corner),
            // plus a smooth hydraulic top-out / droop buffer in the final 8 mm before full extension.
            double c = (comp_rate[w] > 0 ? ax.damper_bump : ax.damper_rebound) * damage_.damper_scale[w];
            if (comp_rate[w] < 0.0 && comp[w] < 0.008) {
                const double droop_u = clamp((0.008 - comp[w]) / 0.008, 0.0, 1.0);
                c *= (1.0 + 1.15 * droop_u * droop_u);
            }
            const double v = std::abs(comp_rate[w]), knee = ax.damper_knee_mps;
            f += sign(comp_rate[w]) * c * (v <= knee ? v : knee + ax.damper_high_speed_ratio * (v - knee));
            if (ax.damper_hysteresis_n > 0.0) {
                f += ax.damper_hysteresis_n * std::tanh(comp_rate[w] / 0.015);
            }
        }
        int other = w ^ 1;                              // FL<->FR, RL<->RR
        double other_comp = touching[other] ? comp[other] : 0.0;
        // ---- Third / Heave Spring + Heave Damper (GT3 / Hypercar aero platform control decoupled from roll/kerbs!)
        // Acts strictly on symmetric axle heave: dz_heave = 0.5 * (dz_L + dz_R). In pure roll (dz_L = -dz_R),
        // dz_heave == 0 so corner roll and single-wheel kerb compliance remain supple while high-speed downforce stays flat!
        if (ax.heave_spring_rate > 0.0 || ax.heave_damper_bump > 0.0 || ax.heave_damper_rebound > 0.0) {
            const double dz_self = comp[w] - cfg_.wheels[w].static_compression;
            const double dz_other = touching[other] ? (comp[other] - cfg_.wheels[other].static_compression) : 0.0;
            const double dz_heave = 0.5 * (dz_self + dz_other);
            const double v_heave = 0.5 * (comp_rate[w] + (touching[other] ? comp_rate[other] : 0.0));
            double f_heave = 0.0;
            if (ax.heave_spring_rate > 0.0 && dz_heave > ax.heave_gap_m) {
                f_heave += ax.heave_spring_rate * (dz_heave - ax.heave_gap_m);
            }
            const double c_heave = (v_heave >= 0.0 ? ax.heave_damper_bump : ax.heave_damper_rebound)
                                 * 0.5 * (damage_.damper_scale[w] + damage_.damper_scale[other]);
            f_heave += c_heave * v_heave;
            f += 0.5 * f_heave;
        }
        double arb_eff = 1.0;
        if (chassis_dyn_.chassis_flex_enabled) {
            // Finite chassis torsional stiffness (N m/deg) softened by permanent crash frame twist
            const double k_ch = std::max(4000.0, chassis_dyn_.torsional_stiffness_nm_per_deg * damage_.chassis_stiffness);
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
        // Flat-spot geometric radial excitation & rim-flange kerb bottoming impact (ALL 4 wheels):
        const TireParams& tp_s = cfg_.tire(w);
        const double w_dpi_s = tire_condition_[w].dpi(tp_s);
        const double k_t_eff = std::max(60000.0, tp_s.vertical_stiffness * clamp(1.0 + tp_s.pfz1 * w_dpi_s, 0.30, 1.60));
        const bool has_flat = tire_condition_[w].flat_spot_depth_mm > 0.05;
        const double wheel_w_s = drivetrain_.wheel_omega[w];
        const double speed_flat_scale = clamp((std::abs(wheel_w_s) * tp_s.radius - 1.5) / 14.0, 0.0, 1.0);
        // ---- 15 Hz 2-DOF Unsprung Wheel-Hop & Radial Tire Carcass Dynamics
        if (unsprung_dynamics_enabled) {
            // Vehicle-matched unsprung corner mass (carbon GT3 ~31 kg .. road GT ~39 kg .. heavy muscle ~46 kg)
            const double m_u = clamp(16.0 + 2.0 * tp_s.mbelt + 0.009 * cfg_.mass, 26.0, 50.0);
            const double k_t = std::max(80000.0, k_t_eff); // N/m radial tire carcass stiffness (pressure-coupled)
            const double c_t = std::max(800.0, tp_s.vertical_damping); // N s/m radial tire carcass damping
            // Unsprung mass sits between suspension force pushing down (susp_force[w]) and tire carcass pushing up
            const double sub_dt = has_flat ? std::min(dt, 0.0005) : std::min(dt, 0.002);
            const int u_steps = std::max(1, (int)std::ceil(dt / sub_dt));
            const double hu = dt / u_steps;
            double uz = unsprung_z_[w], uv = unsprung_vz_[w];
            double flat_drop_avg = 0.0;
            for (int us = 0; us < u_steps; ++us) {
                // Once-per-revolution flat-spot radial chord drop unloads the carcass and excites 15 Hz wheel hop
                double flat_drop = 0.0;
                if (has_flat && speed_flat_scale > 0.0) {
                    const double theta_u = wheel_angle_[w] + wheel_w_s * ((us + 0.5) * hu);
                    flat_drop = tire_condition_[w].flat_spot_radial_drop_m(theta_u, tp_s.radius) * speed_flat_scale;
                    flat_drop_avg += flat_drop;
                }
                const double f_carcass = std::max(0.0, susp_force[w] - k_t * (uz + flat_drop) - c_t * uv);
                const double a_u = (f_carcass - susp_force[w]) / m_u - 18.0 * comp_rate[w];
                uv = clamp(uv + a_u * hu, -4.5, 4.5);
                uz = clamp(uz + uv * hu, -0.035, 0.035);
            }
            flat_drop_avg /= u_steps;
            unsprung_z_[w] = uz;
            unsprung_vz_[w] = uv;
            out.wheels[w].carcass_deflection_m = std::max(0.0, susp_force[w] / k_t - uz - flat_drop_avg);
            out.wheels[w].unsprung_vel_mps = uv;
            // Effective ground contact normal load modulates with 15 Hz unsprung wheel hop & flat-spot radial drop
            susp_force[w] = std::max(0.0, susp_force[w] - k_t * (uz * 0.45 + flat_drop_avg * 0.75));
        } else if (has_flat && speed_flat_scale > 0.0) {
            // Even with massless wheels, flat spots directly modulate wheel load & chassis vertical acceleration
            const double flat_drop = tire_condition_[w].flat_spot_radial_drop_m(wheel_angle_[w], tp_s.radius) * speed_flat_scale;
            const double flat_dfz = clamp(tire_condition_[w].flat_spot_load_delta_n - k_t_eff * flat_drop * 0.65,
                                          -0.55 * susp_force[w], 0.45 * susp_force[w]);
            susp_force[w] = std::max(0.0, susp_force[w] + flat_dfz);
        }
        if (tire_condition_[w].rim_strike_force_n > 1.0) {
            // Sharp kerb / rim-flange bottoming spike transmitted cleanly into wheel load & chassis heave/roll
            const double rim_cap = cfg_.mass * kGravity * 1.4;
            susp_force[w] += clamp(tire_condition_[w].rim_strike_force_n * 0.35, 0.0, rim_cap);
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
        wheel_kin[wr] = AxleKinematicsTable::mirror_to_right(right_unmirrored);

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
    std::array<double, 4> hub_recession_m{};
    for (int w = 0; w < 4; ++w) {
        const int a = w < 2 ? 0 : 1;
        const bool left_wheel = (w % 2 == 0);
        const double side = left_wheel ? -1.0 : 1.0;   // FL/RL = -1 (left), FR/RR = +1 (right)
        const AxleParams& ax = cfg_.axle(w);
        const TireParams& tp = cfg_.tire(w);
        const WheelKinematicSample& ks = wheel_kin[w];

        // Elastokinematic suspension bushing compliance (rubber street bushings vs spherical race bearings):
        // Uses explicit AxleParams compliance if specified; otherwise falls back to realistic compound-matched
        // compliance only when chassis_dyn_.bushing_compliance_enabled is ON (keeps rigid default tests unchanged).
        double toe_fx_c = ax.toe_compliance_rad_per_kn_fx;
        double toe_fy_c = ax.toe_compliance_rad_per_kn_fy;
        double cam_fy_c = ax.camber_compliance_rad_per_kn_fy;
        double lon_fx_c = ax.longitudinal_compliance_m_per_kn_fx;
        if (chassis_dyn_.bushing_compliance_enabled && toe_fx_c == 0.0 && toe_fy_c == 0.0 && cam_fy_c == 0.0 && lon_fx_c == 0.0) {
            const bool is_race_compound = (tp.temp_optimal_c >= 85.0 && tp.temp_window_c <= 18.0);
            const double bushing_softness = is_race_compound ? 0.18 : 1.0;
            toe_fx_c = (a == 0 ? 0.00055 : 0.00025) * bushing_softness; // braking (-Fx) -> slight stabilizing toe-in
            toe_fy_c = (a == 0 ? 0.00040 : 0.00050) * bushing_softness; // lateral force -> compliance understeer / rear toe-in
            cam_fy_c = 0.00135 * bushing_softness;                      // loaded outer tyre loses ~0.38 deg/5 kN on rubber bushings
            lon_fx_c = 0.00110 * bushing_softness;                      // fore-aft hub recession under braking/kerb impacts
        }
        const double fx_kn = prev_fx_[w] * 1e-3;
        const double fy_kn = prev_fy_[w] * 1e-3;
        // Positive toe-in turns left wheel right (-steer) and right wheel left (+steer): steer_delta = side * toe_in
        // Under braking (fx_kn < 0), positive toe_fx_c produces stabilizing toe-in (-fx_kn * toe_fx_c > 0).
        // Under outward cornering force (left wheel pushed right: fy_kn < 0 -> side * fy_kn > 0), toe_fy_c toes in.
        const double comp_toe_in = clamp((-fx_kn) * toe_fx_c + (side * fy_kn) * toe_fy_c, -0.025, 0.025);
        // Outward cornering Fy tilts wheel top outward (reducing negative camber magnitude): delta_gamma = fy_kn * cam_fy_c
        const double comp_camber = clamp(fy_kn * cam_fy_c, -0.045, 0.045);
        hub_recession_m[w] = clamp(fx_kn * lon_fx_c, -0.018, 0.018);

        double d = ks.steer_rad + side * comp_toe_in + damage_.toe[w];
        if (ax.max_steer_deg > 0) d -= ax.steer_compliance * prev_axle_fy_[a];
        out.wheels[w].steer_angle = d;
        out.wheels[w].toe_angle = ks.toe_rad + comp_toe_in + (left_wheel ? -1.0 : 1.0) * damage_.toe[w];
        out.wheels[w].caster_angle = ks.caster_rad + damage_.caster[w];
        out.wheels[w].kpi_angle = ks.kpi_rad;
        out.wheels[w].scrub_radius_m = ks.scrub_radius_m;
        out.wheels[w].motion_ratio = ks.motion_ratio;
        if (!touching[w]) continue;
        const WheelContact& c = contacts[w];
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
        // Per-wheel Hydroplaning (Aquaplaning Water-Wedge Lift) & Compound-Aware Wet Grip:
        // Asymmetric standing puddles lift and drag only the submerged wheels!
        const double water_mm = std::max(c.water_depth_mm, road_water_mm);
        double wet_mu = 1.0;
        if (water_mm > 0.0) {
            const double p_kpa = tire_condition_[w].pressure_kpa > 0.0 ? tire_condition_[w].pressure_kpa : tp.p_nominal_kpa;
            wet_mu = wet_grip_factor(std::hypot(k.vx, k.vy), p_kpa, tire_condition_[w].wear, water_mm,
                                     tp.tread_depth_new_mm, tp.tread_void_ratio, tp.wet_chemical_grip);
        }
        if (water_mm > 0.05) {
            const double p_kpa = tire_condition_[w].pressure_kpa > 0.0 ? tire_condition_[w].pressure_kpa : tp.p_nominal_kpa;
            const HydroplaningState hydro = compute_hydroplaning(std::hypot(k.vx, k.vy), p_kpa, tire_condition_[w].wear, water_mm,
                                                                 tp.tread_depth_new_mm, tp.tread_void_ratio);
            out.wheels[w].hydroplaning_lift = hydro.wedge_lift_fraction;
            k.load *= hydro.effective_load_scale;
            k.ffb_hydro_scale = hydro.ffb_aligning_torque_scale;
        }
        tire_condition_[w].road_water_mm = water_mm;
        if (atmosphere_.enabled || c.track_temp_c > -100.0) {
            const double air_c = atmosphere_.enabled ? atmosphere_.ambient_air_c : tire_condition_[w].ambient_air_c;
            const double trk_c = c.track_temp_c > -100.0 ? c.track_temp_c
                               : (atmosphere_.enabled ? atmosphere_.track_surface_c : tire_condition_[w].track_surface_c);
            tire_condition_[w].set_environment_celsius(air_c, trk_c);
        }
        tire_condition_[w].rib_contact_shares = c.rib_contact_shares;
        tire_condition_[w].enveloping_slope_tan = c.enveloping_slope_tan;
        tire_condition_[w].brake_disc_temp_c = disc_temp_[w];
        // grip_factor() already incorporates thermal window, greasiness, wear cliff, zone health (blister/grain/flat-spot/
        // sidewall damage/marbles) and sidewall rollover; flat_spot_grip_factor() adds the once-per-rev glazed dip.
        k.mu = cfg_.grip_for_surface(c.surface) * clamp(c.surface_mu_mult, 0.12, 1.25)
             * tire_condition_[w].grip_factor(&cfg_.tire(w))
             * tire_condition_[w].flat_spot_grip_factor(wheel_angle_[w]) * damage_.grip[w] * wet_mu;
        // Dynamic inclination / camber angle gamma in the tyre frame (+ = top tilted toward +left):
        //   - Independent axles (DoubleWishbone, MacPherson, MultiLink): body roll + kinematic camber + bushing compliance + rollover.
        //   - Live SolidAxle: both wheels stay perpendicular to the rigid axle beam (beam roll = atan2(dz_L - dz_R, track)),
        //     independent of body roll relative to the axle!
        const double roll_gamma = std::asin(clamp(dot(up, k.lat), -0.5, 0.5));
        const double rollover_gamma = tire_condition_[w].sidewall_rollover_camber_rad();
        if (ax.kinematics.type == SuspensionType::SolidAxle) {
            const int wl = a * 2, wr = a * 2 + 1;
            const double beam_roll_rel_body = std::atan2(dz_[wl] - dz_[wr], std::max(ax.track, 0.8));
            k.gamma = clamp(roll_gamma - beam_roll_rel_body - side * (ks.camber_rad + damage_.camber[w])
                            + comp_camber + rollover_gamma, -0.35, 0.35);
            k.gamma_rate = -(comp_rate[wl] - comp_rate[wr]) / std::max(ax.track, 0.8);
        } else {
            k.gamma = clamp(roll_gamma - side * (ks.camber_rad + damage_.camber[w]) + damage_.caster[w] * std::sin(d)
                            + comp_camber + rollover_gamma, -0.35, 0.35);
            k.gamma_rate = -side * ks.dcamber_dz * comp_rate[w];
        }
        const double w_dpi = tire_condition_[w].dpi(tp);
        k.re = tire_zones_enabled ? effective_rolling_radius_mf62(tp, k.load, k.gamma, w_dpi, drivetrain_.wheel_omega[w],
                                                                  prev_fx_[w], prev_fy_[w])
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
            // Dynamic rear-axle sideslip (subtracts geometric Ackermann CG sideslip b * r / v so tight
            // low-speed zero-slip turns NEVER falsely trigger ESC oversteer braking!).
            const double beta_rear = std::atan2(v_body.y - yaw_rate * cfg_.dist_cg_rear, v);
            const bool sliding = std::abs(beta_rear) > assists_.esc_sideslip_limit
                              && (beta_rear * yaw_rate < 0.0 || std::abs(yaw_rate) < 0.15);
            // Oversteer: yawing faster than the reference (in either direction), or rear sliding outward.
            // Understeer: yawing slower than the reference by more than the deadband.
            bool over = sliding || (std::abs(err) > band && std::abs(yaw_rate) > std::abs(r_ref));
            bool under = !over && std::abs(err) > band && std::abs(yaw_rate) < std::abs(r_ref) && v > 8.0;
            double mag = clamp(assists_.esc_gain * (std::abs(err) - band), 0.0, assists_.esc_max_brake);
            if (sliding) mag = std::max(mag, clamp(assists_.esc_gain * (std::abs(beta_rear) - assists_.esc_sideslip_limit) * 4.0, 0.0, assists_.esc_max_brake));
            const double sev = clamp(mag / std::max(assists_.esc_max_brake, 1.0), 0.0, 1.0);
            if (over) {
                // yawing left too much (err > 0) -> brake the front RIGHT (outer) wheel
                bool rot_left = (sliding ? (std::abs(yaw_rate) > 0.05 ? yaw_rate : -beta_rear) : err) > 0;
                esc_brake[rot_left ? FR : FL] = mag;
                esc_throttle_cut = 0.30 * sev;
                as.esc_mode = 1;
            } else if (under) {
                // turning left but not enough -> brake the rear LEFT (inner) wheel
                esc_brake[r_ref > 0 ? RL : RR] = mag * 0.6;
                esc_throttle_cut = 0.45 * sev;
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
    std::array<double, 4> fx_sum{}, fy_sum{}, mx_sum{}, mz_sum{}, kerb_ratio_sum{}, adhesion_sum{}, trail_sum{};
    DrivetrainInput din{input_.throttle, input_.clutch, input_.brake, input_.handbrake, input_.gear,
                        damage_.engine_power};
    din.brake_power_scale = damage_.brakes;
    // Line lock (Ford's rule): forward gears only, cancelled above 40 km/h.
    din.line_lock = (input_.gear >= 2 && std::abs(out.speed) < 40.0 / 3.6) ? clamp(input_.line_lock, 0.0, 1.0) : 0.0;
    din.nos_active = input_.nos;
    din.starter_crank = input_.starter;
    din.airspeed_mps = std::abs(out.speed);
    din.radiator_cooling_scale = damage_.radiator_cooling;
    din.oil_cooling_scale = damage_.oil_cooling;
    din.oil_starvation_wear_rate = damage_.oil_starvation_wear_rate;
    din.fuel_leak_lps = damage_.fuel_leak_lps;
    din.bearing_drag_nm = damage_.bearing_drag_nm;
    din.atmosphere_enabled = atmosphere_.enabled;
    din.ambient_air_c = atmosphere_.ambient_air_c;
    din.altitude_m = atmosphere_.altitude_m;
    din.humidity_0_to_1 = atmosphere_.humidity_0_to_1;
    din.wake_cooling_scale = clamp(aero_wake_.cooling_airflow_scale, 0.55, 1.0);
    din.wake_hot_air_c = std::max(0.0, aero_wake_.hot_air_delta_c);
    din.brake_bias_offset = chassis_dyn_.brake_bias_offset;
    din.brake_migration_override = chassis_dyn_.brake_migration_override;
    din.hybrid_deploy_mode = chassis_dyn_.hybrid_deploy_mode;
    // ---- Transmission-specific clutch, shift-interrupt & auto-blip orchestration
    // Every gearbox type behaves like its real-world mechanical counterpart:
    //   * AutomaticTorqueConverter: fluid coupling + TCC lock-up (no clutch pedal management)
    //   * DualClutchDct:            18 ms seamless overlapping twin-clutch upshifts (NO clutch disconnect!),
    //                               45 ms closed-loop downshift rev-match blip, automatic launch/anti-stall
    //   * SequentialDogBox:         ZERO clutch on upshifts (50 ms flat-foot ignition cut in Drivetrain) & ZERO
    //                               clutch on downshifts (pneumatic auto-blip in Drivetrain); auto anti-stall/launch
    //   * AutomatedManual (AMT):    electro-hydraulic single dry clutch: ~68 ms upshift torque-interrupt + crisp
    //                               24 ms re-engagement kick, closed-loop heel-toe auto-blip downshifts, auto launch
    //   * HPatternSynchro:          manual 3-pedal synchromesh with player AutoClutchQuality (Perfect/Normal/Poor)
    since_shift_timer_ += dt;
    const TransmissionType tx = drivetrain_.systems.transmission;
    const auto& ratios = cfg_.drivetrain.gear_ratios;

    // Estimate driven-axle carrier angular speed for closed-loop rev-match blip targets
    auto est_carrier_omega = [&]() -> double {
        double w_f = 0.5 * (drivetrain_.wheel_omega[FL] + drivetrain_.wheel_omega[FR]);
        double w_r = 0.5 * (drivetrain_.wheel_omega[RL] + drivetrain_.wheel_omega[RR]);
        if (cfg_.drivetrain.layout == "fwd") return w_f;
        if (cfg_.drivetrain.layout == "rwd") return w_r;
        const double s_f = cfg_.drivetrain.awd_front_split;
        return s_f * w_f + (1.0 - s_f) * w_r;
    };
    auto apply_standing_launch_clutch = [&]() {
        if (input_.gear >= 0 && input_.gear < (int)ratios.size() && ratios[input_.gear] != 0.0) {
            const bool low_gear_or_slow = (input_.gear <= 2) || (std::abs(out.speed) < 8.0)
                                       || (drivetrain_.engine_rpm() < cfg_.engine.idle_rpm + 450.0);
            if (low_gear_or_slow) {
                double engage = clamp((drivetrain_.engine_rpm() - (cfg_.engine.idle_rpm + 250.0)) / 1500.0, 0.0, 1.0);
                double launch_clutch = lerp(std::min(0.95, cfg_.drivetrain.clutch.bite_point + 0.08), 0.0, engage);
                din.clutch = std::max(din.clutch, launch_clutch);
            }
        }
    };

    if (tx == TransmissionType::DualClutchDct) {
        // Pre-selected odd/even twin clutches: NEVER open clutch to 1.0 on upshifts (zero boost drop, 18 ms swap).
        if (input_.gear != last_gear_) {
            if (input_.gear < last_gear_ && input_.gear >= 2 && last_gear_ >= 2 && std::abs(out.speed) > 4.0) {
                dct_blip_timer_ = 0.045;
            }
            since_shift_timer_ = 0.0;
        }
        if (dct_blip_timer_ > 0.0) {
            dct_blip_timer_ = std::max(0.0, dct_blip_timer_ - dt);
            const double target_ratio = (input_.gear >= 0 && input_.gear < (int)ratios.size())
                                      ? ratios[input_.gear] * cfg_.drivetrain.final_drive : 0.0;
            const double redline_rad = cfg_.engine.redline_rpm * (2.0 * kPi / 60.0);
            const double w_tgt = clamp(target_ratio * est_carrier_omega(), 0.0, 0.96 * redline_rad);
            const double dw = w_tgt - drivetrain_.engine_omega;
            if (dw > 15.0 && dct_blip_timer_ > 0.0) {
                drivetrain_.systems.auto_blip_active = true;
                drivetrain_.systems.auto_blip_throttle = clamp(0.25 + dw * 0.0026, 0.25, 0.85);
            } else {
                drivetrain_.systems.auto_blip_active = false;
                drivetrain_.systems.auto_blip_throttle = 0.0;
                dct_blip_timer_ = 0.0;
            }
        } else {
            drivetrain_.systems.auto_blip_active = false;
            drivetrain_.systems.auto_blip_throttle = 0.0;
        }
        apply_standing_launch_clutch();
    } else if (tx == TransmissionType::SequentialDogBox) {
        // Pneumatic sequential dog-box: flat-foot upshift ignition cut & downshift auto-blip are handled
        // directly in Drivetrain without opening the clutch! Standing starts & anti-stall manage the clutch
        // automatically unless the driver has an explicit manual clutch pedal depressed.
        if (input_.gear != last_gear_) since_shift_timer_ = 0.0;
        const bool is_dog_spec = (cfg_.drivetrain.transmission == "dog_box");
        if (input_.auto_clutch || is_dog_spec) {
            apply_standing_launch_clutch();
        }
    } else if (tx == TransmissionType::AutomatedManual) {
        // Single-clutch electro-hydraulic AMT (Aventador ISR / Ferrari F1): no driver clutch pedal.
        // Distinct 65-70 ms hydraulic torque-interrupt + exhaust crack on upshift, crisp 24 ms clutch snap kick,
        // and closed-loop heel-toe throttle auto-blip on downshifts.
        const AmtParams& ap = cfg_.drivetrain.amt;
        if (input_.gear != last_gear_) {
            if (input_.gear == 1) {
                shift_timer_ = 0.0;
                shift_release_timer_ = 0.0;
                amt_downshift_ = false;
                drivetrain_.systems.auto_blip_active = false;
                drivetrain_.systems.auto_blip_throttle = 0.0;
            } else if (input_.gear < last_gear_ && input_.gear >= 2 && last_gear_ >= 2 && std::abs(out.speed) > 4.0) {
                amt_downshift_ = true;
                shift_timer_ = ap.downshift_blip_max_s;
                shift_release_timer_ = ap.downshift_reengage_s;
                shift_release_duration_ = std::max(ap.downshift_reengage_s, 0.008);
            } else if (input_.gear > last_gear_ && last_gear_ >= 2) {
                amt_downshift_ = false;
                shift_timer_ = ap.upshift_cut_s;
                shift_release_timer_ = ap.upshift_reengage_s;
                shift_release_duration_ = std::max(ap.upshift_reengage_s, 0.008);
                if (din.throttle > 0.25) {
                    drivetrain_.systems.shift_cut_active = true;
                    drivetrain_.systems.shift_cut_timer_s = std::min(0.045, ap.upshift_cut_s);
                }
            } else {
                amt_downshift_ = false;
                shift_timer_ = 0.055;
                shift_release_timer_ = 0.030;
                shift_release_duration_ = 0.030;
            }
            since_shift_timer_ = 0.0;
        }

        const bool sync_hold = drivetrain_.is_synchronizing();
        if (shift_timer_ > 0.0 || sync_hold) {
            shift_timer_ = std::max(0.0, shift_timer_ - dt);
            din.clutch = 1.0;
            din.throttle = 0.0;
            if (amt_downshift_) {
                const double target_ratio = (input_.gear >= 0 && input_.gear < (int)ratios.size())
                                          ? ratios[input_.gear] * cfg_.drivetrain.final_drive : 0.0;
                const double redline_rad = cfg_.engine.redline_rpm * (2.0 * kPi / 60.0);
                const double w_tgt = clamp(target_ratio * est_carrier_omega(), 0.0, 0.96 * redline_rad);
                const double dw = w_tgt - drivetrain_.engine_omega;
                drivetrain_.systems.auto_blip_active = true;
                drivetrain_.systems.auto_blip_throttle = dw > 8.0
                                                       ? clamp(0.28 + dw * ap.blip_throttle_gain, 0.28, 0.92)
                                                       : 0.0;
                // End blip hold immediately once synchro has locked AND engine revs are matched!
                if (!sync_hold && dw <= 55.0) {
                    shift_timer_ = 0.0;
                    drivetrain_.systems.auto_blip_active = false;
                    drivetrain_.systems.auto_blip_throttle = 0.0;
                }
            } else {
                drivetrain_.systems.auto_blip_active = false;
                drivetrain_.systems.auto_blip_throttle = 0.0;
            }
            if (shift_timer_ <= 0.0 && !sync_hold) {
                drivetrain_.systems.auto_blip_active = false;
                drivetrain_.systems.auto_blip_throttle = 0.0;
                drivetrain_.systems.shift_clunk_impulse_nm = std::max(
                    drivetrain_.systems.shift_clunk_impulse_nm,
                    amt_downshift_ ? ap.engage_clunk_nm * 0.65 : ap.engage_clunk_nm);
            }
        } else if (shift_release_timer_ > 0.0) {
            drivetrain_.systems.auto_blip_active = false;
            drivetrain_.systems.auto_blip_throttle = 0.0;
            shift_release_timer_ = std::max(0.0, shift_release_timer_ - dt);
            const double frac = clamp(shift_release_timer_ / std::max(shift_release_duration_, 0.008), 0.0, 1.0);
            din.clutch = std::max(din.clutch, frac * cfg_.drivetrain.clutch.bite_point);
        } else {
            drivetrain_.systems.auto_blip_active = false;
            drivetrain_.systems.auto_blip_throttle = 0.0;
            amt_downshift_ = false;
        }
        apply_standing_launch_clutch();
    } else if (input_.auto_clutch && tx != TransmissionType::AutomaticTorqueConverter) {
        // Traditional H-Pattern manual synchromesh with player AutoClutchQuality (Perfect / Normal / Poor).
        const AutoClutchQuality q = input_.auto_clutch_quality;
        drivetrain_.systems.auto_blip_active = false;
        drivetrain_.systems.auto_blip_throttle = 0.0;
        if (input_.gear != last_gear_) {
            if (input_.gear != 1) {
                if (q == AutoClutchQuality::Perfect) {
                    shift_timer_ = 0.12;
                    shift_release_timer_ = 0.035;
                } else if (q == AutoClutchQuality::Normal) {
                    // Rapid shift-slamming (< 0.35 s between shifts) rushes the clutch release.
                    const bool slammed = (since_shift_timer_ < 0.35);
                    shift_timer_ = slammed ? 0.020 : 0.11;
                    shift_release_timer_ = slammed ? 0.008 : 0.025;
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

        constexpr double kMaxRecoverS = 2.5;
        const SyncState sync_now = drivetrain_.systems.sync_state;
        if (sync_now == SyncState::Missed) recovering_from_miss_ = true;
        else if (sync_now == SyncState::Idle) recovering_from_miss_ = false;
        if (recovering_from_miss_) {
            missed_recover_timer_ += dt;
            if (missed_recover_timer_ >= 0.45) {
                din.clutch = 1.0;
                din.throttle = 0.0;
            }
            if (missed_recover_timer_ > kMaxRecoverS) recovering_from_miss_ = false;
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

        apply_standing_launch_clutch();
    } else if (tx == TransmissionType::HPatternSynchro || tx == TransmissionType::AutomaticTorqueConverter) {
        drivetrain_.systems.auto_blip_active = false;
        drivetrain_.systems.auto_blip_throttle = 0.0;
    }
    last_gear_ = input_.gear;
    const double throttle_after_shift = din.throttle;
    if (!disc_init_) { disc_temp_.fill(cfg_.brake_thermal.start_temp_c); disc_init_ = true; }
    for (int w = 0; w < 4; ++w) din.pad_mu[w] = brake_pad_mu(disc_temp_[w], cfg_.brake_thermal.disc_type);
    bool missed_this_tick = false;
    double max_clunk_this_tick = 0.0;
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
            // Detached wheel: NO tyre rubber on the road — zero drive traction, zero tyre cornering, zero tyre braking!
            // Replaced by bare brake rotor / control-arm Coulomb metal-on-asphalt scraping friction opposing ground velocity.
            if (damage_enabled && damage_.wheel_detached[w]) {
                kappa_[w] = 0.0;
                tan_alpha_[w] = 0.0;
                const double v_scrape = std::hypot(k.vx, k.vy);
                const double mu_scrape = damage_model_.hub_scrape_mu() * clamp(cfg_.grip_for_surface(contacts[w].surface), 0.35, 1.15);
                const double s_reg = clamp(v_scrape / 0.35, 0.0, 1.0);
                const double f_mag = mu_scrape * k.load * s_reg;
                if (v_scrape > 1e-5) {
                    fx_sum[w] += -f_mag * (k.vx / v_scrape);
                    fy_sum[w] += -f_mag * (k.vy / v_scrape);
                }
                tyre_t[w] = 0.0; // sheared hub/halfshaft transmits zero drive torque to asphalt
                roll_t[w] = 0.0;
                continue;
            }
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
            mx_sum[w] += f.mx;
            mz_sum[w] += f.mz;
            kerb_ratio_sum[w] += f.kerb_load_ratio;
            adhesion_sum[w] += f.adhesion_ratio;
            trail_sum[w] += f.pneumatic_trail;
            double slip_power = std::abs(f.fx * v_sx) + std::abs(f.fy * k.vy);
            wheel_angle_[w] += drivetrain_.wheel_omega[w] * h;
            if (tire_zones_enabled) {
                const double side_sign = (w % 2 == 0) ? -1.0 : 1.0;
                tire_condition_[w].step_carcass_ring(f.fx, f.fy, k.load, drivetrain_.wheel_omega[w], wheel_angle_[w],
                                                     k.re, h, &tp, op.patch);
                tire_condition_[w].update_zones(slip_power, k.load, std::hypot(k.vx, k.vy), k.gamma, f.fy,
                                                side_sign, drivetrain_.wheel_omega[w], wheel_angle_[w], h, &tp);
            } else {
                tire_condition_[w].update(slip_power, k.load, std::hypot(k.vx, k.vy), h, &tp);
            }
            if (puncture_deflate_[w] > 1e-4) [[unlikely]] {
                tire_condition_[w].pressure_kpa = lerp(tire_condition_[w].pressure_kpa, 25.0, puncture_deflate_[w]);
            }
            if (contacts[w].marble_density > 0.01) {
                const double v_roll = std::hypot(k.vx, k.vy);
                if (v_roll > 1.0) {
                    const double stickiness = 0.30 + 0.70 * clamp((tire_condition_[w].surface_c - 40.0) / 50.0, 0.0, 1.0);
                    const double pickup_rate = clamp(contacts[w].marble_density, 0.0, 1.0) * stickiness * v_roll * 0.028;
                    tire_condition_[w].marble_pickup = clamp(tire_condition_[w].marble_pickup + pickup_rate * h, 0.0, 1.0);
                }
            }
            // Off-track wet grass / gravel / dirt excursion loads wet mud onto tyre tread (shed back onto asphalt for ~38 m!)
            if (contacts[w].surface >= 0 && contacts[w].surface < static_cast<int>(cfg_.surface_grip.size())) {
                const std::string& sname = cfg_.surface_grip[contacts[w].surface].first;
                if (sname == "grass" || sname == "gravel" || sname == "dirt") {
                    const double w_off = std::max(contacts[w].water_depth_mm, road_water_mm);
                    const double v_roll = std::hypot(k.vx, k.vy);
                    if (w_off > 0.05 && v_roll > 1.5) {
                        const double mud_rate = clamp(w_off / 0.8, 0.25, 1.5) * clamp(v_roll / 12.0, 0.2, 2.0) * 1.4;
                        tire_condition_[w].mud_pickup = clamp(tire_condition_[w].mud_pickup + mud_rate * h, 0.0, 0.95);
                    }
                }
            }
            tyre_t[w] = -f.fx * k.re;                                // road pushes back on the wheel
            double c_rr = rolling_resistance_coeff(tp, k.vx, op.dpi) * (1.0 + 3.5 * puncture_deflate_[w]);
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
            const double line_ok = (damage_enabled && damage_.brake_line_ruptured[w]) ? 0.0 : 1.0;
            din.brake_scale[w] = abs_pressure_[w] * vapor_scale * line_ok;
            din.wheel_drive_severed[w] = damage_enabled && (damage_.wheel_detached[w] || damage_.halfshaft_broken[w]);
            din.extra_brake[w] = esc_brake[w] * line_ok;
        }
        // ---- ASSIST: TC. Cut engine torque in proportion to driven-wheel slip above target,
        // filtered over ~30 ms (like an ignition/throttle cut).
        double cut_target = 0;
        if (assists_.tc) {
            double slip_max = 0.0;
            double slip_weighted = 0.0;
            double load_sum = 0.0;
            for (int w = 0; w < 4; ++w) {
                if (cfg_.axle(w).driven && touching[w]) {
                    const double s_w = std::max(0.0, kappa_[w] * sign(kin[w].vx + 1e-9));
                    slip_max = std::max(slip_max, s_w);
                    slip_weighted += s_w * kin[w].load;
                    load_sum += kin[w].load;
                }
            }
            // Load-weighted blend: identical to max-slip on straight-line launches (both wheels equally loaded),
            // while an unloaded inside wheel in a tight corner cannot choke engine power down to 5%.
            const double slip_avg = load_sum > 10.0 ? (slip_weighted / load_sum) : slip_max;
            const double slip = 0.65 * slip_avg + 0.35 * slip_max;
            cut_target = clamp((slip - assists_.tc_slip_target) * assists_.tc_gain, 0.0, 1.0);
        }
        tc_cut_ += (cut_target - tc_cut_) * std::min(1.0, h / 0.03);
        din.throttle = throttle_after_shift * (1.0 - tc_cut_) * (1.0 - esc_throttle_cut);
        drivetrain_.step(din, tyre_t, roll_t, h);
        missed_this_tick |= drivetrain_.systems.missed_shift_event;
        max_clunk_this_tick = std::max(max_clunk_this_tick, drivetrain_.systems.driveline_clunk_nm);
        // ---- brake discs: heated by the friction power the pads absorb (T_brake |w|; a locked wheel heats the tyre,
        // not the disc), cooled by airflow (vented disc: h = base + k v) and radiation (eps sigma A (T^4 - Ta^4)).
        const BrakeThermal& bt = cfg_.brake_thermal;
        const double v_car = length(s.velocity);
        const double wake_brake_cool = clamp(aero_wake_.cooling_airflow_scale, 0.55, 1.0);
        const double wake_brake_hot_c = std::max(0.0, aero_wake_.hot_air_delta_c);
        const double disc_cp = (bt.disc_type == BrakeDiscType::CarbonCarbon) ? 710.0
                             : (bt.disc_type == BrakeDiscType::CarbonCeramic ? 620.0 : 460.0);
        const double disc_emissivity = (bt.disc_type == BrakeDiscType::CarbonCarbon) ? 0.82
                                     : (bt.disc_type == BrakeDiscType::CarbonCeramic ? 0.72 : 0.55);
        for (int w = 0; w < 4; ++w) {
            const bool front = w < 2;
            const double cap = (front ? bt.disc_mass_front : bt.disc_mass_rear) * disc_cp;
            const double area = front ? bt.disc_area_front : bt.disc_area_rear;
            const double amb_brake_c = (atmosphere_.enabled ? atmosphere_.ambient_air_c : 25.0) + wake_brake_hot_c;
            const double tk = disc_temp_[w] + 273.15, ta = amb_brake_c + 273.15;
            const double heat = drivetrain_.brake_torque[w] * std::abs(drivetrain_.wheel_omega[w]);
            const double w_rotor_mm = touching[w] ? std::max(contacts[w].water_depth_mm, road_water_mm) : road_water_mm;
            // Standing-water spray coats unbraked rotors and quenches hot discs; braking pads wipe & flash-boil the film!
            if (w_rotor_mm > 0.25 && v_car > 8.0 && drivetrain_.brake_torque[w] < 50.0) {
                const double target_film = clamp((w_rotor_mm - 0.20) / 2.0, 0.0, 1.0) * clamp((v_car - 8.0) / 28.0, 0.0, 1.0);
                // Hot rotors (> 220 C) flash-evaporate incoming spray faster than cool cruising rotors
                const double hot_boil_block = clamp((disc_temp_[w] - 180.0) / 320.0, 0.0, 0.75);
                const double eff_target = target_film * (1.0 - hot_boil_block);
                if (eff_target > brake_water_film_[w]) {
                    brake_water_film_[w] += (eff_target - brake_water_film_[w]) * clamp(h / 2.2, 0.0, 1.0);
                }
            } else if (w_rotor_mm <= 0.10) {
                brake_water_film_[w] = std::max(0.0, brake_water_film_[w] - h * (0.25 + 0.01 * v_car));
            }
            if (heat > 1500.0 && brake_water_film_[w] > 0.0) {
                // Pad swipe + thermal flash-boil clears rotor water film in ~0.25-0.45 s of firm braking
                const double wipe_rate = (3.6 + 2.4 * clamp(heat / 50000.0, 0.0, 2.5)) * (1.0 + clamp(disc_temp_[w] / 180.0, 0.0, 2.0));
                brake_water_film_[w] = std::max(0.0, brake_water_film_[w] - wipe_rate * h);
            }
            const double q_spray_quench = (w_rotor_mm > 0.15 && v_car > 5.0 && disc_temp_[w] > amb_brake_c)
                                        ? clamp(w_rotor_mm / 1.8, 0.0, 2.0) * (12.0 + 1.6 * v_car) * (disc_temp_[w] - amb_brake_c)
                                        : 0.0;
            const double cool = (bt.cooling_base + bt.cooling_per_mps * v_car * wake_brake_cool) * (disc_temp_[w] - amb_brake_c)
                              + q_spray_quench
                              + disc_emissivity * 5.670e-8 * area * (tk * tk * tk * tk - ta * ta * ta * ta);
            disc_temp_[w] = clamp(disc_temp_[w] + h * (heat - cool) / cap, -20.0, 1100.0);
            const double wet_bite_scale = 1.0 - 0.34 * brake_water_film_[w];
            din.pad_mu[w] = brake_pad_mu(disc_temp_[w], bt.disc_type) * wet_bite_scale;
            // Caliper DOT 4 brake fluid heat soak from hot rotor through pad + convective airflow cooling
            const double fluid_amb_c = (atmosphere_.enabled ? (atmosphere_.ambient_air_c + 15.0) : 40.0) + wake_brake_hot_c;
            const double d_fluid = 0.025 * std::max(0.0, disc_temp_[w] - fluid_temp_[w])
                                 - (0.012 + 0.0015 * v_car * wake_brake_cool) * (fluid_temp_[w] - fluid_amb_c);
            fluid_temp_[w] = clamp(fluid_temp_[w] + h * d_fluid, -10.0, 360.0);
            pad_wear_[w] = clamp(pad_wear_[w] + heat * 2.5e-10 * h, 0.0, 1.0);
        }
    }
    for (int w = 0; w < 4; ++w) {
        as.abs_pressure[w] = abs_pressure_[w];
        as.abs_active[w] = abs_pressure_[w] < 0.98;
    }
    as.tc_cut = tc_cut_;
    out.throttle_applied = std::max(din.throttle,
                                    drivetrain_.systems.auto_blip_active ? drivetrain_.systems.auto_blip_throttle : 0.0);
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
                        + s.orientation.rotate({wheel_kin[w].wheel_offset.x + hub_recession_m[w], wheel_kin[w].wheel_offset.y, 0.0});
        wo.angular_velocity = drivetrain_.wheel_omega[w];
        wo.slip_ratio = kappa_[w];
        wo.slip_angle = std::atan(tan_alpha_[w]);
        wo.condition = tire_condition_[w];
        wo.brake_temp_c = disc_temp_[w];
        wo.brake_mu = brake_pad_mu(disc_temp_[w], cfg_.brake_thermal.disc_type) * (1.0 - 0.34 * brake_water_film_[w]);
        wo.brake_fluid_temp_c = fluid_temp_[w];
        wo.brake_pad_wear = pad_wear_[w];
        wo.brake_water_film = brake_water_film_[w];
        wo.adhesion_ratio = touching[w] ? clamp(adhesion_sum[w] / n_sub, 0.0, 1.0) : 1.0;
        wo.pneumatic_trail_m = touching[w] ? (trail_sum[w] / n_sub) : 0.0;
        if (!touching[w]) continue;
        const Kin& k = kin[w];
        double fx = fx_sum[w] / n_sub, fy = fy_sum[w] / n_sub, mx = mx_sum[w] / n_sub, mz = mz_sum[w] / n_sub;
        prev_fx_[w] = fx;
        // Low-speed damping (below ~2 m/s): the relaxation-length model acts like an undamped
        // spring at standstill; real tyres have internal damping. Blends out with speed.
        // Detached wheels have NO tyre contact patch, so never let spinning axle stubs push the car at low speed!
        double speed = std::hypot(k.vx, k.vy);
        double blend = clamp(1.0 - speed / 2.0, 0.0, 1.0);
        if (blend > 0) {
            if (damage_enabled && damage_.wheel_detached[w]) {
                const double fmax = damage_model_.hub_scrape_mu() * k.load;
                const double c = 1.5 * k.load;
                fx += blend * c * (-k.vx);
                fy += blend * c * (-k.vy);
                const double fm = std::hypot(fx, fy);
                if (fm > fmax && fm > 1e-6) { fx *= fmax / fm; fy *= fmax / fm; }
            } else {
                double c = 2.0 * k.load;   // N per (m/s)
                fx += blend * c * (drivetrain_.wheel_omega[w] * k.re - k.vx);
                fy += blend * c * (-k.vy);
                double fmax = std::max(tp.mu_x, tp.mu_y) * k.mu * k.load;   // never exceed friction
                double fm = std::hypot(fx, fy);
                if (fm > fmax) { fx *= fmax / fm; fy *= fmax / fm; }
            }
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
        wo.grip_limit = (damage_enabled && damage_.wheel_detached[w])
                      ? (damage_model_.hub_scrape_mu() * k.load)
                      : (std::max(tp.mu_x, tp.mu_y) * k.mu * k.load);
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
        const double flat_excite = clamp(std::abs(tire_condition_[w].flat_spot_load_delta_n) / 1800.0
                                         + tire_condition_[w].rim_strike_force_n / 4000.0, 0.0, 0.85);
        const double hub_scrape_excite = (damage_enabled && damage_.wheel_detached[w] && v_roll > 0.5)
                                       ? clamp(0.65 + 0.35 * clamp(v_roll / 15.0, 0.0, 1.0), 0.0, 1.0)
                                       : 0.0;
        wo.surface_excitation = clamp(vert_excite + kerb_excite + surf_rough + base_rumble + flat_excite + hub_scrape_excite, 0.0, 1.0);
        wo.sidewall_rollover = tire_condition_[w].sidewall_rollover;
        wo.sidewall_damage = tire_condition_[w].sidewall_damage;
        wo.rim_strike_force_n = tire_condition_[w].rim_strike_force_n;
        wo.carcass_hysteresis_w = tire_condition_[w].carcass_hysteresis_w;
        // Suspension force acts along the body's up axis (plus symmetric heave jacking force);
        // longitudinal tyre force at the contact patch; lateral tyre force at the dynamic
        // roll-centre height (handles the roll-moment geometric transfer without double-counting);
        // residual self-aligning torque Mz acts about the contact normal.
        // Per-wheel hydrodynamic standing-water displacement drag (puddle drag):
        // When a wheel ploughs through standing water > 1.2 mm, displaced water mass creates a strong
        // longitudinal drag force F_splash = 0.5 * rho_water * Cd * width * h_excess * v^2.
        // Hitting a puddle with only right-side wheels creates an authentic asymmetric yaw tug + steering jerk!
        const double w_depth_mm = std::max(contacts[w].water_depth_mm, road_water_mm);
        double puddle_drag_fx = 0.0;
        if (w_depth_mm > 1.2 && std::abs(k.vx) > 2.0) {
            const double h_m = (w_depth_mm - 1.2) * 0.001;
            const double f_puddle = 0.5 * 1000.0 * 0.55 * tp.section_width_m * h_m * k.vx * k.vx;
            puddle_drag_fx = -sign(k.vx) * std::min(f_puddle, 0.65 * std::max(susp_force[w], 1500.0));
            fx += puddle_drag_fx;
        }
        // ---- LMU-Grade Full 3D Kingpin Steering-Axis FFB Wrench (computed after puddle drag so ALL Fx terms unify!)
        if (w < 2 && cfg_.axle(w).max_steer_deg > 0) {
            const double trail = wheel_kin[w].caster_trail_m + tp.radius * std::tan(damage_.caster[w]);
            const double flat_thump = tire_zones_enabled
                                    ? tire_condition_[w].flat_spot_ffb_torque_nm(wheel_angle_[w], k.load, std::hypot(k.vx, k.vy))
                                    : 0.0;
            const double side_sign = (w == FL) ? 1.0 : -1.0; // +1 left wheel, -1 right wheel
            const double scrub = std::abs(wheel_kin[w].scrub_radius_m) > 1e-4 ? wheel_kin[w].scrub_radius_m : 0.018;
            if (chassis_dyn_.kingpin_3d_ffb_enabled) {
                // Full 3D kingpin projection tau_kp = ((r_cp x F_tyre) + M_tyre) . a_kp + KPI/caster Fz jacking:
                //   - Mz * cos(caster)*cos(kpi) - Fy * trail * cos(kpi): pneumatic + mechanical caster trail
                //   - -side_sign * Fx * scrub * cos(caster): braking lockup pull, kerb rip, FWD/AWD torque steer & puddle tug!
                //   - -Mx * sin(caster): overturning moment camber kick over kerbs & loaded outer tyre
                //   - -Fz * |scrub| * sin(kpi) * sin(steer): KPI jacking self-centering (feels alive over crests & low speed!)
                const double caster = wheel_kin[w].caster_rad + damage_.caster[w];
                const double kpi = wheel_kin[w].kpi_rad;
                const double cos_c = std::cos(caster), sin_c = std::sin(caster);
                const double cos_k = std::cos(kpi), sin_k = std::sin(kpi);
                const double tau_align = (mz * cos_c * cos_k - fy * trail * cos_k) * k.ffb_hydro_scale;
                const double tau_scrub_fx = -side_sign * fx * scrub * cos_c;
                const double tau_mx = -mx * sin_c * 0.65;
                // Milliken RCVD Ch. 17 KPI jacking torque: steering lifts the spindle by r_offset_wc * sin(kpi) * (1 - cos(steer))
                const double r_kp_wc = std::abs(scrub) + tp.radius * std::abs(sin_k);
                const double tau_kpi_jack = -k.load * r_kp_wc * sin_k * std::sin(wo.steer_angle) * 0.85;
                out.steer_torque += tau_align + tau_scrub_fx + tau_mx + tau_kpi_jack + flat_thump;
            } else {
                out.steer_torque += (mz - fy * trail) * k.ffb_hydro_scale + flat_thump
                                  - side_sign * puddle_drag_fx * scrub;
            }
        }
        Vec3 f_susp = up * (susp_force[w] + 0.5 * axle_jack_heave[a]);
        Vec3 f_long = k.fwd * fx;
        Vec3 f_lat = k.lat * fy;
        Vec3 p_lat = k.point + up * axle_rch[a];
        force += f_susp + f_long + f_lat;
        axle_fy[a] += fy;
        wheel_fy[w] = fy;
        torque += cross(k.point - s.position, f_susp + f_long) + cross(p_lat - s.position, f_lat)
                + k.fwd * mx + k.normal * (0.15 * mz);
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

    // ------------------------------------------------------------------ 6-DOF aerodynamics & multi-car wake field
    // Relative air velocity includes 3D Dynamic Weather wind + gusts (v_air = v_chassis - v_wind when enabled).
    // Includes 2D ride-height aero map, roll ground-effect seal loss, unsteady heave/pitch AoA damping,
    // +0.24 m drag line-of-action pitch torque, 3D yaw polar + high-yaw (>45 deg) spin roof lift,
    // vortex-induced drag coupling, multi-car slipstream/tandem-push/side-draft/dirty-air & unsteady wake buffeting.
    const AeroParams& a = cfg_.aero;
    const Vec3 v_air = atmosphere_.enabled ? (s.velocity - atmosphere_.wind_world_mps) : s.velocity;
    const double v = length(v_air);
    const Vec3 v_air_body = s.orientation.inv_rotate(v_air);
    const Vec3 omega_body_aero = s.orientation.inv_rotate(s.angular_velocity);
    const double aero_beta = (std::abs(v_air_body.x) > 2.0) ? std::atan2(v_air_body.y, std::abs(v_air_body.x)) : out.sideslip;
    const double beta_full = (v > 2.0) ? std::atan2(v_air_body.y, v_air_body.x) : 0.0;
    // Only a car whose spec declares the wing has it (aero.drs / aero.airbrake): road cars and fixed-wing race cars never switch it.
    out.drs_active = chassis_dyn_.active_aero_enabled && a.drs && out.speed > 50.0 && input_.throttle > 0.75
                   && input_.brake < 0.05 && std::abs(input_.steer) < 0.12;
    out.airbrake_active = chassis_dyn_.active_aero_enabled && a.airbrake && out.speed > 22.0 && input_.brake > 0.55;
    const double active_drag_mult = out.drs_active ? kDrsDragMult : (out.airbrake_active ? kAirbrakeDragMult : 1.0);
    const double active_rear_down_mult = out.drs_active ? kDrsRearDownMult : (out.airbrake_active ? kAirbrakeRearDownMult : 1.0);

    const double sin_beta = std::sin(clamp(aero_beta, -1.2, 1.2));
    const double steer_avg_aero = 0.5 * (out.wheels[FL].steer_angle + out.wheels[FR].steer_angle);
    const double steer_sq = steer_avg_aero * steer_avg_aero;
    const double yaw_drag_mult = aero_wake_.yaw_aero_enabled ? (1.0 + 0.35 * sin_beta * sin_beta + a.steer_drag_gain * steer_sq) : 1.0;
    const double yaw_rear_down_mult = aero_wake_.yaw_aero_enabled ? (1.0 - 0.30 * sin_beta * sin_beta) : 1.0;
    const double steer_df_scale = aero_wake_.yaw_aero_enabled ? clamp(1.0 - a.steer_downforce_loss * steer_sq, 0.85, 1.0) : 1.0;
    const double eff_drag_scale = clamp(aero_wake_.drag_scale, 0.55, 1.25) * yaw_drag_mult * active_drag_mult;
    double eff_front_down_scale = clamp(aero_wake_.dirty_air_front_downforce_scale, 0.50, 1.10);
    // Travelling dirty-air wave advection lag: front wing encounters wake changes at t=0, rear wing L/v (~40-60 ms) later!
    const double raw_rear_dirty = clamp(aero_wake_.dirty_air_rear_downforce_scale, 0.65, 1.10);
    if (aero_wake_.yaw_aero_enabled && v > 10.0 && dt > 0.0) {
        const double tau_rear = clamp(cfg_.wheelbase / std::max(v, 15.0), 0.02, 0.18);
        delayed_rear_dirty_air_ += (raw_rear_dirty - delayed_rear_dirty_air_) * clamp(dt / tau_rear, 0.0, 1.0);
    } else {
        delayed_rear_dirty_air_ = raw_rear_dirty;
    }
    const double eff_rear_down_scale = delayed_rear_dirty_air_;

    // Thermal wake slightly reduces local intake/flow air density via ideal-gas T_amb / (T_amb + dT_wake)
    const double wake_hot_c = std::max(0.0, aero_wake_.hot_air_delta_c);
    const double t_amb_aero_k = (atmosphere_.enabled ? atmosphere_.ambient_air_c : 25.0) + 273.15;
    const double rho_air = (atmosphere_.enabled ? atmosphere_.air_density_kg_m3() : a.air_density)
                         * (t_amb_aero_k / (t_amb_aero_k + wake_hot_c));
    out.air_density_kg_m3 = rho_air;

    const double dz_f = 0.5 * (dz_[FL] + dz_[FR]), dz_r = 0.5 * (dz_[RL] + dz_[RR]);
    const double front_rh = std::max(0.0, a.static_ride_height_front_m - dz_f);
    const double rear_rh = std::max(0.0, a.static_ride_height_rear_m - dz_r);
    out.front_ride_height_m = front_rh;
    out.rear_ride_height_m = rear_rh;

    double cd_area = a.drag_area;
    double cl_front_area = 0.0;
    double cl_rear_area = 0.0;
    if (a.map_2d.valid()) {
        // Explicit 2D Front/Rear Ride-Height Aerodynamic Map (ClA_front(h_f, h_r), ClA_rear(h_f, h_r), CdA(h_f, h_r))
        a.map_2d.sample(front_rh, rear_rh, cl_front_area, cl_rear_area, cd_area);
        if (chassis_dyn_.active_aero_enabled && front_rh < 0.018 && out.speed > 35.0) {
            out.front_splitter_stalled = true;
            eff_front_down_scale *= 0.74;
        }
    } else {
        if (chassis_dyn_.active_aero_enabled && dz_f > cfg_.front.max_compression * 0.85 && out.speed > 35.0) {
            out.front_splitter_stalled = true;
            eff_front_down_scale *= 0.74; // -26% front venturi stall when splitter chokes against asphalt
        }
        const double ground = clamp(1.0 + a.ground_effect_per_m * 0.5 * (dz_f + dz_r), 0.6, 1.5);
        const double balance = clamp(a.front_balance + a.pitch_balance_per_m * (dz_f - dz_r), 0.05, 0.95);
        cl_front_area = a.lift_area * ground * balance;
        cl_rear_area = a.lift_area * ground * (1.0 - balance);
    }
    // Diffuser rake stall: excessive rear-high rake breaks the diffuser seal under braking/crests
    double diffuser_scale = 1.0;
    if (chassis_dyn_.active_aero_enabled && (rear_rh - front_rh) > a.diffuser_stall_rake_m && out.speed > 35.0) {
        out.diffuser_stalled = true;
        diffuser_scale = 0.82;
    }

    // Roll-angle ground-effect undertray seal loss & unsteady heave/pitch-rate AoA damping
    const Vec3 body_left_aero = s.orientation.rotate({0.0, 1.0, 0.0});
    const double body_roll_rad = std::asin(clamp(body_left_aero.z, -1.0, 1.0));
    const double roll_seal = aero_wake_.yaw_aero_enabled ? clamp(1.0 - 1.15 * body_roll_rad * body_roll_rad, 0.78, 1.0) : 1.0;
    const double vx_body = v_air_body.x;
    const double v_aoa_denom = std::max(std::abs(vx_body), 15.0);
    const double vz_front_body = v_air_body.z - omega_body_aero.y * cfg_.dist_cg_front;
    const double vz_rear_body = v_air_body.z + omega_body_aero.y * cfg_.dist_cg_rear;
    const double heave_f_scale = aero_wake_.yaw_aero_enabled
                               ? clamp(1.0 + 0.55 * clamp(vz_front_body / v_aoa_denom, -0.35, 0.35), 0.80, 1.20) : 1.0;
    const double heave_r_scale = aero_wake_.yaw_aero_enabled
                               ? clamp(1.0 + 0.55 * clamp(vz_rear_body / v_aoa_denom, -0.35, 0.35), 0.80, 1.20) : 1.0;

    // High-yaw / backward-slide (> 45 deg) greenhouse roof lift transition during high-speed spins
    const double abs_bf = std::abs(beta_full);
    double spin_df_mult = 1.0;
    double roof_lift_n = 0.0;
    if (aero_wake_.yaw_aero_enabled && abs_bf > 0.7854 && v > 12.0) {
        const double spin_t = clamp((abs_bf - 0.7854) / 1.5708, 0.0, 1.0);
        spin_df_mult = 1.0 - 0.85 * spin_t;
        roof_lift_n = 0.5 * rho_air * v * v * (0.28 * cd_area) * spin_t;
    }

    // Apply asymmetric aerodynamic crash damage (crushed nose/splitter kills front downforce; crushed rear kills rear downforce)
    cl_front_area *= damage_.front_downforce;
    cl_rear_area *= damage_.rear_downforce;

    // Vortex-induced drag penalty whenever ride-height ground effect raises downforce above static baseline
    const double cl_excess = std::max(0.0, (cl_front_area + cl_rear_area) - a.lift_area);
    const double induced_cd_delta = aero_wake_.yaw_aero_enabled ? (0.055 * cl_excess) : 0.0;
    const Vec3 f_drag = v_air * (-0.5 * rho_air * (cd_area + induced_cd_delta) * damage_.aero_drag * eff_drag_scale * v);
    force += f_drag;
    // Aerodynamic drag centre of pressure sits ~0.24 m above CG -> authentic nose-up pitch moment at 250-350 km/h
    if (aero_wake_.yaw_aero_enabled && v > 1.0) {
        torque += cross(s.orientation.rotate({0.0, 0.0, 0.24}), f_drag);
    }

    // Full 3D yaw lateral aero side-force & weathercocking (active in both still-air yaw & crosswinds) + Bernoulli suction
    double total_aero_side_n = 0.0;
    double total_aero_yaw_nm = 0.0;
    const bool has_wind = atmosphere_.enabled && length(atmosphere_.wind_world_mps) > 0.1;
    if ((aero_wake_.yaw_aero_enabled && std::abs(aero_beta) > 1e-4 && v > 2.0) || has_wind) {
        const double q_cross = 0.5 * rho_air * v * v;
        const double side_area = 2.6 * cd_area; // approx lateral silhouette area (m^2)
        const double cy = -1.65 * clamp(std::sin(aero_beta), -1.0, 1.0);
        const double fy_yaw = q_cross * side_area * cy;
        total_aero_side_n += fy_yaw;
        const Vec3 f_side = s.orientation.rotate({0.0, fy_yaw, 0.0});
        force += f_side;
        // Centre of lateral pressure sits ~0.12 m ahead of CG -> authentic crosswind / high-speed yaw steering tug
        const Vec3 t_yaw = cross(s.orientation.rotate({0.12, 0.0, 0.0}), f_side);
        torque += t_yaw;
        total_aero_yaw_nm += dot(t_yaw, up);
    }
    if (std::abs(aero_wake_.lateral_suction_n) > 1e-3) {
        total_aero_side_n += aero_wake_.lateral_suction_n;
        force += s.orientation.rotate({0.0, aero_wake_.lateral_suction_n, 0.0});
    }

    const double q_dyn = 0.5 * rho_air * vx_body * vx_body;
    // Front wheel-wake steering shift: turning the front tyres shifts aero balance slightly rearward mid-corner
    const double steer_bal_shift = aero_wake_.yaw_aero_enabled
                                 ? clamp(a.steer_balance_shift * std::abs(steer_avg_aero), -0.04, 0.04) : 0.0;
    const double cl_tot_raw = cl_front_area + cl_rear_area;
    const double cl_f_steered = std::max(0.0, cl_front_area + cl_tot_raw * steer_bal_shift) * steer_df_scale;
    const double cl_r_steered = std::max(0.0, cl_rear_area - cl_tot_raw * steer_bal_shift) * steer_df_scale;
    const double f_down_front = q_dyn * cl_f_steered * eff_front_down_scale * roll_seal * heave_f_scale * spin_df_mult - 0.5 * roof_lift_n;
    const double f_down_rear = q_dyn * cl_r_steered * eff_rear_down_scale * yaw_rear_down_mult * active_rear_down_mult * diffuser_scale * roll_seal * heave_r_scale * spin_df_mult - 0.5 * roof_lift_n;
    const double f_down_tot = f_down_front + f_down_rear;
    out.aero_balance_front = (f_down_tot > 1e-6) ? clamp(f_down_front / f_down_tot, 0.0, 1.0) : a.front_balance;
    Vec3 p_front = s.position + s.orientation.rotate({cfg_.dist_cg_front, 0, 0});
    Vec3 p_rear = s.position + s.orientation.rotate({-cfg_.dist_cg_rear, 0, 0});
    Vec3 f_front = up * (-f_down_front);
    Vec3 f_rear = up * (-f_down_rear);
    force += f_front + f_rear;
    torque += cross(p_front - s.position, f_front) + cross(p_rear - s.position, f_rear);

    // Deterministic multi-harmonic Strouhal vortex-shedding wake buffeting (chassis heave/roll/yaw + FFB steering nibble)
    if (aero_wake_.wake_turbulence_0_to_1 > 1e-3 && v > 15.0) {
        const double t_w = (aero_wake_.wake_phase_s > 0.0) ? aero_wake_.wake_phase_s : time_;
        const double h1 = std::sin(2.0 * kPi * 4.7 * t_w);
        const double h2 = std::sin(2.0 * kPi * 8.3 * t_w + 1.17);
        const double h3 = std::sin(2.0 * kPi * 13.1 * t_w + 2.41);
        const double q_norm = clamp((0.5 * rho_air * v * v) / 2200.0, 0.0, 2.5);
        const double tb = clamp(aero_wake_.wake_turbulence_0_to_1, 0.0, 1.0) * q_norm;
        const double yaw_buffet_nm = 260.0 * tb * (0.60 * h1 + 0.40 * h2);
        const double roll_buffet_nm = 190.0 * tb * (0.50 * h2 + 0.50 * h3);
        const double heave_buffet_n = 220.0 * tb * (0.55 * h1 - 0.45 * h3);
        force += up * heave_buffet_n;
        torque += s.orientation.rotate({roll_buffet_nm, 0.0, yaw_buffet_nm});
        total_aero_yaw_nm += yaw_buffet_nm;
        out.steer_torque += 14.0 * tb * (0.55 * h2 + 0.45 * h3);
    }

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
    out.auto_blip_active = drivetrain_.systems.auto_blip_active;
    out.driveline_clunk_nm = max_clunk_this_tick;
    out.clutch_temp_c = drivetrain_.systems.clutch_temp_c;
    out.clutch_health = drivetrain_.systems.clutch_health;
    out.gearbox_health = drivetrain_.systems.gearbox_health;
    out.missed_shifts = drivetrain_.systems.missed_shifts;
    out.missed_shift_event = missed_this_tick;
    out.clutch_torque_nm = drivetrain_.clutch_torque;
    out.clutch_locked = drivetrain_.systems.clutch_locked;
    out.tc_slip_ratio = drivetrain_.systems.tc_slip_ratio;
    out.tc_torque_ratio = drivetrain_.systems.tc_torque_ratio;
    out.tc_lockup_engaged = drivetrain_.systems.tc_lockup_engaged;

    // ---- Physical Steering Column & Speed-Sensitive Power Steering (EPS / Hydraulic)
    // Preserves raw rack torque in out.steer_torque while computing driver steering-wheel rim torque
    // (N m) after hydraulic/EPS boost + relief-valve saturation + rack Coulomb friction + column damping & inertia.
    {
        const SteeringParams& sp = cfg_.steering;
        const double ratio = std::max(sp.steer_ratio, 4.0);
        const double steer_avg = 0.5 * (out.wheels[FL].steer_angle + out.wheels[FR].steer_angle);
        const double dt_safe = std::max(dt, 1e-4);
        const double omega_sw = ratio * (steer_avg - prev_steer_rad_) / dt_safe;
        const double alpha_sw = clamp((omega_sw - prev_steer_vel_rads_) / dt_safe, -80.0, 80.0);
        prev_steer_rad_ = steer_avg;
        prev_steer_vel_rads_ = omega_sw;

        double boost_frac = 0.0;
        if (sp.assist_mode != PowerSteeringMode::Manual) {
            const double v_u = clamp(std::abs(out.speed) / std::max(sp.assist_speed_ref_mps, 5.0), 0.0, 1.0);
            const double smooth_u = v_u * v_u * (3.0 - 2.0 * v_u);
            boost_frac = clamp(lerp(sp.assist_gain_low_speed, sp.assist_gain_high_speed, smooth_u), 0.0, 0.92);
        }
        const double max_assist = std::max(0.0, sp.max_assist_torque_nm);
        const double assist_rack_nm = -clamp(out.steer_torque * boost_frac, -max_assist, max_assist);
        const double rack_net_nm = out.steer_torque + assist_rack_nm;
        const double fric_rim_nm = (sp.rack_friction_nm / ratio) * std::tanh(omega_sw / 0.25);
        const double damp_rim_nm = (sp.column_damping_nms_per_rad / (ratio * ratio)) * omega_sw;
        const double inert_rim_nm = sp.column_inertia_kgm2 * alpha_sw;
        out.power_steering_gain = boost_frac;
        out.steering_assist_torque_nm = assist_rack_nm;
        out.steering_column_torque_nm = (rack_net_nm / ratio) - fric_rim_nm - damp_rim_nm - inert_rim_nm;
    }

    out.slipstream_drag_scale = eff_drag_scale;
    out.dirty_air_downforce_scale = eff_front_down_scale;
    out.dirty_air_rear_downforce_scale = eff_rear_down_scale;
    out.side_draft_drag_delta = aero_wake_.side_draft_drag_delta;
    out.tandem_push_drag_delta = aero_wake_.tandem_push_drag_delta;
    out.wake_turbulence = aero_wake_.wake_turbulence_0_to_1;
    out.wake_hot_air_c = aero_wake_.hot_air_delta_c;
    out.wake_cooling_scale = aero_wake_.cooling_airflow_scale;
    out.aero_drag_n = length(f_drag);
    out.aero_downforce_front_n = f_down_front;
    out.aero_downforce_rear_n = f_down_rear;
    out.aero_side_force_n = total_aero_side_n;
    out.aero_yaw_moment_nm = total_aero_yaw_nm;
    out.effective_brake_bias_front = drivetrain_.systems.effective_brake_bias_front;
    out.hybrid_soc = drivetrain_.systems.hybrid_soc;
    out.hybrid_deploy_kw = drivetrain_.systems.hybrid_deploy_kw;
    out.hybrid_regen_kw = drivetrain_.systems.hybrid_regen_kw;
    out.hybrid_bbw_active = drivetrain_.systems.hybrid_bbw_active;
    out.front_adhesion_ratio = std::min(out.wheels[FL].adhesion_ratio, out.wheels[FR].adhesion_ratio);
    return out;
}

}  // namespace rs
