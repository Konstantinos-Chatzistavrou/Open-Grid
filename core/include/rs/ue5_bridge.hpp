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

// Standard quaternion vector rotation matching UE5 FQuat::RotateVector(V) = q * V * q^-1.
inline UeVec3 ue_rotate(const UeQuat& q, const UeVec3& v) {
    Vec3 u{q.x, q.y, q.z};
    Vec3 vv{v.x, v.y, v.z};
    Vec3 t = cross(u, vv) * 2.0;
    Vec3 r = vv + t * q.w + cross(u, t);
    return {r.x, r.y, r.z};
}

}  // namespace rs::ue5
