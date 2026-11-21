#include "rs/sim.hpp"

namespace rs {

WheelContact PlaneGround::raycast(const WheelRay& ray) const {
    // Ray-plane intersection: origin + t dir lies on the plane dot(p, n) = 0
    //   t = -dot(origin, n) / dot(dir, n)
    WheelContact c;
    double denom = dot(ray.direction, n_);
    if (denom >= -1e-9) return c;              // parallel or pointing away
    double t = -dot(ray.origin, n_) / denom;
    if (t < 0 || t > ray.length) return c;
    c.hit = true;
    c.distance = t;
    c.point = ray.origin + ray.direction * t;
    c.normal = n_;
    c.surface = surface_;
    return c;
}

WheelContact CurbGround::raycast(const WheelRay& ray) const {
    WheelContact c;
    if (std::abs(ray.direction.z) < 1e-9) return c;
    // Test intersection with upper curb plane z = curb_h_ first, then lower road z = 0
    const double z_top = (ray.origin.x >= curb_x_) ? curb_h_ : 0.0;
    const double t = (z_top - ray.origin.z) / ray.direction.z;
    if (t < 0.0 || t > ray.length) return c;
    c.hit = true;
    c.distance = t;
    c.point = ray.origin + ray.direction * t;
    c.normal = {0, 0, 1};
    c.surface = surface_;
    return c;
}

WheelContact LateralCurbGround::raycast(const WheelRay& ray) const {
    WheelContact c;
    if (std::abs(ray.direction.z) < 1e-9) return c;
    const double z_top = (ray.origin.y >= curb_y_) ? curb_h_ : 0.0;
    const double t = (z_top - ray.origin.z) / ray.direction.z;
    if (t < 0.0 || t > ray.length) return c;
    c.hit = true;
    c.distance = t;
    c.point = ray.origin + ray.direction * t;
    c.normal = {0, 0, 1};
    c.surface = surface_;
    return c;
}

void RigidBody::integrate(const Vec3& f, const Vec3& tau, double dt) {
    ChassisState& s = state;
    s.velocity += f * (dt / mass);
    // Angular: work in body axes where the inertia tensor is diagonal.
    Vec3 w = s.orientation.inv_rotate(s.angular_velocity);
    Vec3 t = s.orientation.inv_rotate(tau);
    Vec3 Iw{inertia.x * w.x, inertia.y * w.y, inertia.z * w.z};
    Vec3 gyro = cross(w, Iw);                  // w x (I w): gyroscopic term
    w += Vec3{(t.x - gyro.x) / inertia.x, (t.y - gyro.y) / inertia.y, (t.z - gyro.z) / inertia.z} * dt;
    s.angular_velocity = s.orientation.rotate(w);
    s.position += s.velocity * dt;
    // Orientation: dq/dt = 1/2 (0, w_world) q
    Quat wq{0, s.angular_velocity.x, s.angular_velocity.y, s.angular_velocity.z};
    Quat dq = wq * s.orientation;
    s.orientation = Quat{s.orientation.w + 0.5 * dt * dq.w, s.orientation.x + 0.5 * dt * dq.x,
                         s.orientation.y + 0.5 * dt * dq.y, s.orientation.z + 0.5 * dt * dq.z}.normalized();
}

Simulation::Simulation(const CarConfig& cfg, std::shared_ptr<const Ground> ground)
    : vehicle(cfg), ground_(std::move(ground)) {
    body.mass = cfg.mass;
    body.inertia = {cfg.inertia_xx, cfg.inertia_yy, cfg.inertia_zz};
    reset();
}

void Simulation::reset(const Vec3& p, double yaw, double forward_speed, int gear) {
    body.state = ChassisState{};
    body.state.orientation = Quat::from_axis_angle({0, 0, 1}, yaw);
    body.state.position = {p.x, p.y, vehicle.config().cg_height};
    body.state.velocity = body.state.orientation.rotate({forward_speed, 0, 0});
    vehicle.reset_motion(forward_speed, gear);
    time = 0;
}

void Simulation::step(const DriverInput& in) {
    vehicle.set_input(in);
    std::array<WheelContact, 4> contacts;
    if (use_footprint_16) {
        auto footprints = vehicle.wheel_footprint_16_rays(body.state);
        for (int i = 0; i < 4; ++i) {
            std::array<WheelContact, 16> sub_hits;
            for (int j = 0; j < 16; ++j) sub_hits[j] = ground_->raycast(footprints[i].rays[j]);
            contacts[i] = Vehicle::resolve_footprint_16(footprints[i], sub_hits, vehicle.config().tire(i).radius);
        }
    } else if (use_contact_patch) {
        auto patches = vehicle.wheel_contact_patch_rays(body.state);
        for (int i = 0; i < 4; ++i) {
            std::array<WheelContact, 3> sub_hits;
            for (int j = 0; j < 3; ++j) sub_hits[j] = ground_->raycast(patches[i].rays[j]);
            contacts[i] = Vehicle::resolve_contact_patch(patches[i], sub_hits, vehicle.config().tire(i).radius);
        }
    } else {
        auto rays = vehicle.wheel_rays(body.state);
        for (int i = 0; i < 4; ++i) contacts[i] = ground_->raycast(rays[i]);
    }
    last = vehicle.update(body.state, contacts, dt);
    body.mass = last.mass_kg;   // burnt fuel makes the car lighter
    body.inertia = last.effective_inertia;
    Vec3 gravity{0, 0, -kGravity * body.mass};
    Vec3 f = last.force + gravity;
    Vec3 v0 = body.state.velocity;
    body.integrate(f, last.torque, dt);
    accel_body_ = body.state.orientation.inv_rotate((body.state.velocity - v0) / dt);
    time += dt;
}

void Simulation::settle(double seconds) {
    DriverInput idle;
    idle.brake = 0.3;
    int n = (int)(seconds / dt);
    for (int i = 0; i < n; ++i) step(idle);
}

Vec3 Simulation::velocity_body() const { return body.state.orientation.inv_rotate(body.state.velocity); }

}  // namespace rs
