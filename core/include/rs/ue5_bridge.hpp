// Unreal Engine 5 C++ Plugin Coordinate & Unit Bridge for rs_core (OpenGrid).
// Header-only, zero Unreal Engine header dependencies — include directly inside a UE5 UActorComponent
// or Chaos physics callback and construct FVector / FQuat from the plain doubles returned here.
//
// Coordinate & Unit Mapping:
//   rs_core (ISO 8855): Right-Handed, +X forward, +Y left,  +Z up, meters (m), N, N*m, rad/s
//   Unreal Engine 5:    Left-Handed,  +X forward, +Y right, +Z up, centimeters (cm), kg*cm/s^2, kg*cm^2/s^2, rad/s
//
// Reflection matrix M = diag(1, -1, 1) (det = -1):
//   - Polar vectors (pos, vel, force):         ( x, -y,  z) * scale
//   - Axial vectors (omega, torque):           (-x,  y, -z) * scale
//   - Orientation quaternion (w, x, y, z):     ( w, -x,  y, -z)  (exact M * R_rs * M conjugation)
#pragma once
#include "rs/math.hpp"
#include "rs/vehicle.hpp"
#include "rs/vehicle_runtime.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

namespace rs::ue5 {

constexpr double kMetersToCm = 100.0;
constexpr double kCmToMeters = 0.01;
constexpr double kTorqueToUe = 10000.0;  // N*m -> kg*cm^2/s^2 (100^2)

struct UeVec3 {
    double x = 0, y = 0, z = 0;
};

struct UeQuat {
    double x = 0, y = 0, z = 0, w = 1;  // UE5 FQuat constructor order (X, Y, Z, W)
};

// ---- rs_core (m, RH +Y left) -> UE5 (cm, LH +Y right) ------------------------------------------------
inline UeVec3 pos_to_ue(const Vec3& p_m) {
    return {p_m.x * kMetersToCm, -p_m.y * kMetersToCm, p_m.z * kMetersToCm};
}

inline UeVec3 vel_to_ue(const Vec3& v_ms) {
    return {v_ms.x * kMetersToCm, -v_ms.y * kMetersToCm, v_ms.z * kMetersToCm};
}

inline UeVec3 dir_to_ue(const Vec3& d) {
    return {d.x, -d.y, d.z};
}

inline UeVec3 force_to_ue(const Vec3& f_n) {
    return {f_n.x * kMetersToCm, -f_n.y * kMetersToCm, f_n.z * kMetersToCm};
}

inline UeVec3 omega_to_ue(const Vec3& w_rads) {
    return {-w_rads.x, w_rads.y, -w_rads.z};
}

inline UeVec3 torque_to_ue(const Vec3& t_nm) {
    return {-t_nm.x * kTorqueToUe, t_nm.y * kTorqueToUe, -t_nm.z * kTorqueToUe};
}

inline UeQuat quat_to_ue(const Quat& q) {
    return {-q.x, q.y, -q.z, q.w};
}

// ---- UE5 (cm, LH +Y right) -> rs_core (m, RH +Y left) ------------------------------------------------
inline Vec3 pos_from_ue(const UeVec3& p_cm) {
    return {p_cm.x * kCmToMeters, -p_cm.y * kCmToMeters, p_cm.z * kCmToMeters};
}

inline Vec3 vel_from_ue(const UeVec3& v_cms) {
    return {v_cms.x * kCmToMeters, -v_cms.y * kCmToMeters, v_cms.z * kCmToMeters};
}

inline Vec3 dir_from_ue(const UeVec3& d) {
    return {d.x, -d.y, d.z};
}

inline Vec3 omega_from_ue(const UeVec3& w_rads) {
    return {-w_rads.x, w_rads.y, -w_rads.z};
}

inline Quat quat_from_ue(const UeQuat& q) {
    return {q.w, -q.x, q.y, -q.z};
}

// ---- Cached ground planes (async physics stepping) --------------------------------------------------------------
// The engine traces each suspension ray once per rendered frame and keeps the hit as a plane (point + normal). The
// physics thread, stepping several times per frame, intersects its fresh rays with those planes, so suspension
// compression follows the body between frames without physics-thread scene queries. All in core space (m).
//   no hit when: nothing was cached, the ray runs parallel to / away from the plane, the plane lies above the mount by
//   more than `above_tolerance`, or beyond the ray's length (wheel in the air).
inline WheelContact intersect_ground_plane(const WheelRay& ray, bool cached_hit, const Vec3& plane_point,
                                           const Vec3& plane_normal, int surface, double above_tolerance = 0.05) {
    WheelContact c;
    if (!cached_hit) return c;
    const double denom = dot(ray.direction, plane_normal);
    if (denom > -1e-4) return c;
    double t = dot(plane_point - ray.origin, plane_normal) / denom;
    if (t < -above_tolerance || t > ray.length) return c;
    if (t < 0.0) t = 0.0;
    c.hit = true;
    c.distance = t;
    c.point = ray.origin + ray.direction * t;
    c.normal = plane_normal;
    c.surface = surface;
    return c;
}

// ---- Swept ground strip (kerbs between rendered frames) ---------------------------------------------------------
// A per-frame plane per ray only knows the ground where the ray was when the frame started; at 200 km/h and 30 fps a
// wheel travels 1.85 m before the next trace, so a 20 cm kerb is missed or smeared. Instead, once per frame the engine
// traces a strip of samples under each wheel: `lanes` lines across the tread, `count` samples `spacing` apart along
// the direction of travel, covering where the wheel will be until the next frame. The physics thread then asks the
// strip for the ground under each ray at every step: kerb edges resolve at `spacing` (5 cm) whatever the frame rate.
struct GroundSample {
    bool hit = false;
    Vec3 point;            // core space (m)
    Vec3 normal{0, 0, 1};
    int surface = 0;
};

struct GroundStrip {
    Vec3 origin;           // world (m): first sample of the middle lane (or the midpoint between the middle two)
    Vec3 along{1, 0, 0};   // unit, direction of travel
    Vec3 across{0, 1, 0};  // unit, across the tread
    double spacing = 0.05;       // m between samples along
    double lane_spacing = 0.12;  // m between lanes
    int count = 0;               // samples per lane
    int lanes = 0;
    std::vector<GroundSample> samples;   // lanes x count, lane-major: samples[lane * count + i]

    void resize(int n_lanes, int n_count) {
        lanes = n_lanes;
        count = n_count;
        samples.assign(static_cast<std::size_t>(n_lanes) * static_cast<std::size_t>(n_count), GroundSample{});
    }
    /** World position of sample (lane, i): where the engine should trace (straight down its suspension axis). */
    Vec3 position(int lane, int i) const {
        const double lane_offset = (lane - 0.5 * (lanes - 1)) * lane_spacing;
        return origin + along * (i * spacing) + across * lane_offset;
    }
    GroundSample& at(int lane, int i) { return samples[static_cast<std::size_t>(lane) * count + i]; }
    const GroundSample& at(int lane, int i) const { return samples[static_cast<std::size_t>(lane) * count + i]; }

    /**
     * Ground under a suspension ray. Returns false when the ray's footprint is outside the strip (the caller then
     * falls back to its per-ray plane). Otherwise fills `out`: the two samples bracketing the ray along the nearest
     * lane are each treated as a small plane, and the higher hit wins, so a tyre climbs a kerb as soon as its
     * footprint reaches the edge (as a real tyre envelops it) instead of dropping into the gap between samples.
     */
    bool lookup(const WheelRay& ray, WheelContact& out) const {
        out = WheelContact{};
        if (count < 1 || lanes < 1) return false;
        const Vec3 d = ray.origin - origin;
        const double s = dot(d, along) / spacing;
        const double l = dot(d, across) / lane_spacing + 0.5 * (lanes - 1);
        if (s < -0.5 || s > count - 0.5 || l < -0.5 || l > lanes - 0.5) return false;
        const int lane = std::min(lanes - 1, std::max(0, static_cast<int>(std::lround(l))));
        const int i0 = std::min(count - 1, std::max(0, static_cast<int>(std::floor(s))));
        const int i1 = std::min(count - 1, i0 + 1);
        for (int i : {i0, i1}) {
            const GroundSample& g = at(lane, i);
            const WheelContact c = intersect_ground_plane(ray, g.hit, g.point, g.normal, g.surface);
            if (c.hit && (!out.hit || c.distance < out.distance)) out = c;
        }
        return true;   // inside the strip: no hit means the wheel is in the air there
    }

    /**
     * Sample the swept GroundStrip onto a 4x4 ContactPatchProfile under a wheel so kerbs and surface transitions
     * feed directly into the multi-point contact patch tyre solver.
     */
    bool fill_patch_profile(const WheelRay& center_ray, const Vec3& wheel_fwd, const Vec3& wheel_left,
                            double half_len_a, double half_width_b, const Vec3& ref_point, const Vec3& ref_normal,
                            const CarConfig* cfg, ContactPatchProfile& out) const {
        if (count < 1 || lanes < 1) return false;
        static constexpr double kXi[kPatchRows] = {-0.75, -0.25, 0.25, 0.75};
        static constexpr double kEta[kPatchCols] = {-0.75, -0.25, 0.25, 0.75};
        bool any_inside = false, any_nonflat = false;
        double min_dz = 1e9, max_dz = -1e9;
        const double ref_mu = cfg ? cfg->grip_for_surface(0) : 1.0;
        for (int i = 0; i < kPatchRows; ++i) {
            for (int j = 0; j < kPatchCols; ++j) {
                const int idx = i * kPatchCols + j;
                WheelRay sub = center_ray;
                sub.origin = center_ray.origin + wheel_fwd * (kXi[i] * half_len_a) + wheel_left * (kEta[j] * half_width_b);
                WheelContact hit;
                if (!lookup(sub, hit)) continue;
                any_inside = true;
                if (hit.hit) {
                    const double dz = std::clamp(dot(hit.point - ref_point, ref_normal), -0.08, 0.08);
                    out.road_dz_m[idx] = dz;
                    out.contact_mask[idx] = true;
                    const double cell_mu = (cfg && ref_mu > 1e-6) ? (cfg->grip_for_surface(hit.surface) / ref_mu) : 1.0;
                    out.mu_cell[idx] = cell_mu;
                    min_dz = std::min(min_dz, dz);
                    max_dz = std::max(max_dz, dz);
                    if (std::abs(cell_mu - 1.0) > 1e-3) any_nonflat = true;
                } else {
                    out.road_dz_m[idx] = 0.0;
                    out.contact_mask[idx] = false;
                    any_nonflat = true;
                }
            }
        }
        if (any_inside && (any_nonflat || (max_dz - min_dz) > 1e-3)) {
            out.has_height_map = true;
            return true;
        }
        return false;
    }
};

// Standard quaternion vector rotation matching UE5 FQuat::RotateVector(V) = q * V * q^-1.
inline UeVec3 ue_rotate(const UeQuat& q, const UeVec3& v) {
    Vec3 u{q.x, q.y, q.z};
    Vec3 vv{v.x, v.y, v.z};
    Vec3 t = cross(u, vv) * 2.0;
    Vec3 r = vv + t * q.w + cross(u, t);
    return {r.x, r.y, r.z};
}

// ---- Lock-free async physics bridge (game thread <-> Chaos / physics thread) ------------------------------------
// Replaces mutexes between UOpenGridVehicleComponent::TickComponent (game thread) and AsyncPhysicsTickComponent
// (physics thread) with lock-free SPSC rings (commands, impacts, step records via rt::VehicleRuntime) and wait-free
// triple buffers (rays physics -> game, traced ground planes + strips game -> physics). Zero UE dependencies so it
// can be tested directly in core/tests/.
constexpr int kMaxRaysPerWheel = 16;

struct RayFrame {
    int rays_per_wheel = 3;
    bool valid = false;
    std::array<std::array<WheelRay, kMaxRaysPerWheel>, 4> rays{};
};

struct GroundFrame {
    int rays_per_wheel = 3;
    bool has_strips = false;
    bool use_strip = true;
    std::array<std::array<GroundSample, kMaxRaysPerWheel>, 4> planes{};
    std::array<GroundStrip, 4> strips{};
};

class AsyncVehicleBridge {
public:
    AsyncVehicleBridge(Vehicle& vehicle, Controls& controls)
        : vehicle_(&vehicle), runtime_(vehicle, controls) {}
    AsyncVehicleBridge(const AsyncVehicleBridge&) = delete;
    AsyncVehicleBridge& operator=(const AsyncVehicleBridge&) = delete;

    // ---- setup (before physics thread runs, or single-threaded) -------------------------------------------------
    /** Build and publish the initial wheel rays so the first game-thread trace has valid ray origins. */
    void seed_rays(const ChassisState& chassis, int rays_per_wheel) {
        RayFrame& rf = rays_tb_.write_buffer();
        build_rays_into(chassis, rays_per_wheel, rf);
        rays_tb_.publish();
    }

    // ---- game / render thread -----------------------------------------------------------------------------------
    bool submit_command(const rt::VehicleCommand& cmd) { return runtime_.submit(cmd); }
    bool submit_impact(const rt::ImpactCommand& imp) { return runtime_.submit_impact(imp); }

    /** Fetch the newest rays produced by the physics thread; returns true if rays_read() updated. */
    bool fetch_rays() { return rays_tb_.fetch(); }
    const RayFrame& current_rays() const { return rays_tb_.read_buffer(); }

    /** Fill ground planes/strips in place (vectors keep capacity across cycles), then call publish_ground(). */
    GroundFrame& ground_write_buffer() { return ground_tb_.write_buffer(); }
    void publish_ground() { ground_tb_.publish(); }

    template <typename F>
    std::size_t drain_records(F&& f) {
        return runtime_.drain([&](const rt::StepRecord& r) {
            record_history_step(r);
            f(r);
        });
    }
    bool latest_record(rt::StepRecord& out) {
        bool got = false;
        runtime_.drain([&](const rt::StepRecord& r) {
            record_history_step(r);
            out = r;
            got = true;
        });
        return got;
    }

    /**
     * Return an interpolated StepRecord (including all 4 WheelOutput poses and spin[4]) between the previous
     * and latest drained physics step at render blend factor `alpha` in [0, 1] (zero 1-step wheel lag).
     */
    rt::StepRecord interpolate_record(double alpha) const {
        if (!has_latest_) return rt::StepRecord{};
        return rt::blend(prev_record_, latest_record_, alpha);
    }

    bool sample_interpolated(double alpha, rt::StepRecord& out) const {
        if (!has_latest_) return false;
        out = rt::blend(prev_record_, latest_record_, alpha);
        return true;
    }

    /** Sample the render-side StepRecord snapshot ring at fractional tick time `tick_time`. */
    bool sample_at_tick(double tick_time, rt::StepRecord& out, double* alpha_out = nullptr) const {
        return history_.sample(tick_time, out, alpha_out);
    }

    // ---- physics thread (fixed rate, lock-free, wait-free) ------------------------------------------------------
    const VehicleOutput& step(const ChassisState& chassis, double dt) {
        ground_tb_.fetch();
        const GroundFrame& g = ground_tb_.read_buffer();
        const int per_wheel = (g.rays_per_wheel == 16 || g.rays_per_wheel == 3 || g.rays_per_wheel == 1)
                                  ? g.rays_per_wheel
                                  : 3;

        RayFrame& rf = rays_tb_.write_buffer();
        build_rays_into(chassis, per_wheel, rf);
        const std::array<WheelContact, 4> contacts = resolve_contacts(rf, g, per_wheel);
        rays_tb_.publish();

        return runtime_.step(chassis, contacts, dt);
    }

    const rt::RuntimeStats& stats() const { return runtime_.stats; }
    rt::VehicleRuntime<>& runtime() { return runtime_; }
    const rt::VehicleRuntime<>& runtime() const { return runtime_; }

private:
    void build_rays_into(const ChassisState& chassis, int per_wheel, RayFrame& out) {
        out.rays_per_wheel = per_wheel;
        if (per_wheel == 16) {
            footprint_rays_ = vehicle_->wheel_footprint_16_rays(chassis);
            for (int w = 0; w < 4; ++w)
                for (int j = 0; j < 16; ++j) out.rays[w][j] = footprint_rays_[w].rays[j];
        } else if (per_wheel == 3) {
            patch_rays_ = vehicle_->wheel_contact_patch_rays(chassis);
            for (int w = 0; w < 4; ++w)
                for (int j = 0; j < 3; ++j) out.rays[w][j] = patch_rays_[w].rays[j];
        } else {
            const std::array<WheelRay, 4> r = vehicle_->wheel_rays(chassis);
            for (int w = 0; w < 4; ++w) out.rays[w][0] = r[w];
        }
        out.valid = true;
    }

    std::array<WheelContact, 4> resolve_contacts(const RayFrame& rf, const GroundFrame& g, int per_wheel) const {
        std::array<WheelContact, 4> contacts{};
        for (int w = 0; w < 4; ++w) {
            const double radius = vehicle_->config().tire(w).radius;
            auto hit = [&](int j) {
                if (g.has_strips && g.use_strip) {
                    WheelContact from_strip;
                    if (g.strips[w].lookup(rf.rays[w][j], from_strip)) return from_strip;
                }
                const GroundSample& s = g.planes[w][j];
                return intersect_ground_plane(rf.rays[w][j], s.hit, s.point, s.normal, s.surface);
            };
            if (per_wheel == 16) {
                std::array<WheelContact, 16> sub{};
                for (int j = 0; j < 16; ++j) sub[j] = hit(j);
                contacts[w] = Vehicle::resolve_footprint_16(footprint_rays_[w], sub, radius);
            } else if (per_wheel == 3) {
                const std::array<WheelContact, 3> sub = {hit(0), hit(1), hit(2)};
                contacts[w] = Vehicle::resolve_contact_patch(patch_rays_[w], sub, radius);
            } else {
                contacts[w] = hit(0);
            }
        }
        return contacts;
    }

    Vehicle* vehicle_;
    rt::VehicleRuntime<> runtime_;
    TripleBuffer<RayFrame> rays_tb_;
    TripleBuffer<GroundFrame> ground_tb_;
    // game-thread interpolation state (updated by drain_records / latest_record)
    void record_history_step(const rt::StepRecord& r) {
        prev_record_ = has_latest_ ? latest_record_ : r;
        latest_record_ = r;
        has_latest_ = true;
        history_.push(r);
    }
    bool has_latest_ = false;
    rt::StepRecord prev_record_{};
    rt::StepRecord latest_record_{};
    SnapshotHistory<rt::StepRecord, 16> history_{};
    // physics-thread only scratch (kept as members so resolve_contacts avoids recomputing rays)
    std::array<WheelContactPatchRays, 4> patch_rays_{};
    std::array<WheelFootprint16Rays, 4> footprint_rays_{};
};

// ---- UE 5.8 Wheel State, Telemetry, Wheel Interpolation & Crash Morph-Target Helpers ----------------------------

struct UeWheelState {
    bool in_contact = false;
    UeVec3 world_center_cm{};
    UeVec3 contact_point_world_cm{};
    float steer_angle_rad = 0.0f;
    float steer_angle_deg = 0.0f;
    float camber_angle_deg = 0.0f;
    float spin_angle_rad = 0.0f;
    float angular_velocity_rads = 0.0f;
    float normal_load_n = 0.0f;
    float suspension_compression_cm = 0.0f;
    float slip_ratio = 0.0f;
    float slip_angle_deg = 0.0f;
    float surface_temp_c = 80.0f;
    float carcass_temp_c = 80.0f;
    float pressure_kpa = 220.0f;
    float brake_disc_temp_c = 45.0f;
    // Kinematic suspension & 3-node tyre fields exposed on FOpenGridWheelState:
    float toe_angle_deg = 0.0f;
    float caster_angle_deg = 0.0f;
    float kpi_angle_deg = 0.0f;
    float scrub_radius_cm = 0.0f;
    float motion_ratio = 1.0f;
    float inner_air_temp_c = 53.0f;
    float flash_temp_c = 80.0f;
    float flat_spot_depth_mm = 0.0f;
    float cavity_ring_gain = 0.0f;
};

struct UeCrushMorphWeights {
    float crush_front = 0.0f;
    float crush_rear = 0.0f;
    float crush_left = 0.0f;
    float crush_right = 0.0f;
    float crush_top = 0.0f;
    float crush_hood = 0.0f;
};

/**
 * Compute the render interpolation factor alpha in [0, 1] of `render_chassis` between `prev_chassis` and `curr_chassis`.
 */
inline double compute_render_alpha(const ChassisState& prev_chassis, const ChassisState& curr_chassis,
                                   const ChassisState& render_chassis) {
    const Vec3 d = curr_chassis.position - prev_chassis.position;
    const double d2 = dot(d, d);
    if (d2 > 1e-8) {
        return clamp(dot(render_chassis.position - prev_chassis.position, d) / d2, 0.0, 1.0);
    }
    return 1.0;
}

/**
 * Interpolate a wheel's pose in body-local space between `prev` and `curr` StepRecords and transform to world space
 * using `render_chassis` (the game-thread interpolated rigid-body pose) so wheels never lag the chassis by one step.
 */
inline void interpolate_wheel_pose(const rt::StepRecord& prev, const rt::StepRecord& curr,
                                   const ChassisState& render_chassis, double alpha, int wheel_index,
                                   Vec3& out_world_center_m, double& out_steer_rad, double& out_spin_rad,
                                   double& out_toe_rad, double& out_camber_rad) {
    const int w = std::max(0, std::min(3, wheel_index));
    const double t = clamp(alpha, 0.0, 1.0);
    const Vec3 local_prev = prev.chassis.orientation.inv_rotate(prev.out.wheels[w].centre_world - prev.chassis.position);
    const Vec3 local_curr = curr.chassis.orientation.inv_rotate(curr.out.wheels[w].centre_world - curr.chassis.position);
    const Vec3 local_blend = lerp(local_prev, local_curr, t);
    out_world_center_m = render_chassis.position + render_chassis.orientation.rotate(local_blend);
    out_steer_rad = lerp(prev.out.wheels[w].steer_angle, curr.out.wheels[w].steer_angle, t);
    out_toe_rad = lerp(prev.out.wheels[w].toe_angle, curr.out.wheels[w].toe_angle, t);
    out_camber_rad = lerp(prev.out.wheels[w].camber, curr.out.wheels[w].camber, t);
    out_spin_rad = lerp_angle(prev.spin[w], curr.spin[w], t);
}

/**
 * Populate a UeWheelState (backing FOpenGridWheelState) from a WheelOutput and interpolated pose values.
 */
inline UeWheelState make_ue_wheel_state(const WheelOutput& w, double tire_radius_m,
                                        const Vec3& interp_world_center_m, double interp_steer_rad,
                                        double interp_spin_rad, double interp_toe_rad, double interp_camber_rad) {
    constexpr double kRadToDeg = 180.0 / kPi;
    UeWheelState st{};
    st.in_contact = w.contact;
    st.world_center_cm = pos_to_ue(interp_world_center_m);
    st.contact_point_world_cm = pos_to_ue(w.contact_point);
    st.steer_angle_rad = static_cast<float>(interp_steer_rad);
    st.steer_angle_deg = static_cast<float>(interp_steer_rad * kRadToDeg);
    st.camber_angle_deg = static_cast<float>(interp_camber_rad * kRadToDeg);
    st.spin_angle_rad = static_cast<float>(interp_spin_rad);
    st.angular_velocity_rads = static_cast<float>(w.angular_velocity);
    st.normal_load_n = static_cast<float>(w.load);
    st.suspension_compression_cm = static_cast<float>(w.compression * kMetersToCm);
    st.slip_ratio = static_cast<float>(w.slip_ratio);
    st.slip_angle_deg = static_cast<float>(w.slip_angle * kRadToDeg);
    st.surface_temp_c = static_cast<float>(w.condition.surface_c);
    st.carcass_temp_c = static_cast<float>(w.condition.temperature_c);
    st.pressure_kpa = static_cast<float>(w.condition.pressure_kpa > 0.0
                                             ? w.condition.pressure_kpa
                                             : w.condition.ideal_gas_pressure_kpa());
    st.brake_disc_temp_c = static_cast<float>(w.brake_temp_c);
    st.toe_angle_deg = static_cast<float>(interp_toe_rad * kRadToDeg);
    st.caster_angle_deg = static_cast<float>(w.caster_angle * kRadToDeg);
    st.kpi_angle_deg = static_cast<float>(w.kpi_angle * kRadToDeg);
    st.scrub_radius_cm = static_cast<float>(w.scrub_radius_m * kMetersToCm);
    st.motion_ratio = static_cast<float>(w.motion_ratio);
    st.inner_air_temp_c = static_cast<float>(w.condition.inner_air_c);
    st.flash_temp_c = static_cast<float>(w.condition.flash_c);
    st.flat_spot_depth_mm = static_cast<float>(w.condition.flat_spot_depth_mm);
    const TireAcousticSource ac = w.condition.compute_acoustics(
        w.angular_velocity, tire_radius_m, std::abs(w.unsprung_vel_mps));
    st.cavity_ring_gain = static_cast<float>(ac.cavity_ring_gain);
    return st;
}

/**
 * Compute straight-cut / helical transmission gear tooth mesh whine frequency (Hz) from wheel/engine speed and engaged gear ratio.
 */
inline float compute_gear_whine_hz(const VehicleOutput& out, const CarConfig& cfg) {
    if (out.gear == 1 || out.gear < 0 || out.gear >= static_cast<int>(cfg.drivetrain.gear_ratios.size())) {
        return 0.0f;
    }
    const double ratio = std::abs(cfg.drivetrain.gear_ratios[out.gear]);
    if (ratio <= 1e-3) return 0.0f;
    double mean_wheel_omega = 0.0;
    for (int w = 0; w < 4; ++w) mean_wheel_omega += std::abs(out.wheels[w].angular_velocity);
    mean_wheel_omega *= 0.25;
    const double wheel_rps = mean_wheel_omega / (2.0 * kPi);
    const double final_drive = std::max(0.5, cfg.drivetrain.final_drive);
    const double engine_out_rps = (std::max(0.0, out.engine_rpm) / 60.0) / ratio;
    const double driveshaft_rps = std::max(wheel_rps * final_drive, engine_out_rps);
    double driven_teeth = 22.0 + 2.5 * clamp(static_cast<double>(out.gear), 0.0, 7.0);
    if (out.gear < static_cast<int>(cfg.drivetrain.gear_teeth.size()) &&
        cfg.drivetrain.gear_teeth[out.gear][0] > 0) {
        driven_teeth = static_cast<double>(cfg.drivetrain.gear_teeth[out.gear][0]);
    }
    return static_cast<float>(driveshaft_rps * driven_teeth);
}

/**
 * Compute the 6 normalized directional crash morph-target weights (crush_front, crush_rear, crush_left,
 * crush_right, crush_top, crush_hood in 0..1) from zone damage and 8-node perimeter crush weights.
 */
inline UeCrushMorphWeights compute_crush_morph_weights(const std::array<double, 4>& zone,
                                                       const std::array<double, 8>& node_norm,
                                                       bool hood_unlatched = false,
                                                       double top_impact_factor = 0.0) {
    UeCrushMorphWeights m{};
    const double front_nodes = std::max(node_norm[NodeFrontCenter],
                                        0.5 * (node_norm[NodeFLCorner] + node_norm[NodeFRCorner]));
    const double rear_nodes = std::max(node_norm[NodeRearCenter],
                                       0.5 * (node_norm[NodeRLCorner] + node_norm[NodeRRCorner]));
    m.crush_front = static_cast<float>(clamp(std::max(zone[ZoneFront], front_nodes), 0.0, 1.0));
    m.crush_rear = static_cast<float>(clamp(std::max(zone[ZoneRear], rear_nodes), 0.0, 1.0));
    m.crush_left = static_cast<float>(clamp(std::max(zone[ZoneLeft], node_norm[NodeLeftFlank]), 0.0, 1.0));
    m.crush_right = static_cast<float>(clamp(std::max(zone[ZoneRight], node_norm[NodeRightFlank]), 0.0, 1.0));
    const double side_cabin = 0.35 * (static_cast<double>(m.crush_left) + static_cast<double>(m.crush_right));
    m.crush_top = static_cast<float>(clamp(std::max(top_impact_factor, side_cabin), 0.0, 1.0));
    const double hood_raw = std::max(node_norm[NodeFrontCenter] * 1.15,
                                     hood_unlatched ? std::max(0.5, zone[ZoneFront]) : zone[ZoneFront] * 0.85);
    m.crush_hood = static_cast<float>(clamp(hood_raw, 0.0, 1.0));
    return m;
}

inline UeCrushMorphWeights compute_crush_morph_weights(const DamageReport& dmg) {
    const double top_impact = (dmg.last_impact_point.z > 0.35 && dmg.impacts > 0)
                                  ? clamp(dmg.total_energy_kj / 250.0, 0.0, 1.0)
                                  : 0.0;
    return compute_crush_morph_weights(dmg.zone, dmg.node_norm, dmg.hood_unlatched, top_impact);
}

}  // namespace rs::ue5
