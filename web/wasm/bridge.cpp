// WebAssembly bridge: exposes the rs_core vehicle to JavaScript with a flat C API.
//
// THE ONLY PLACE where core coordinates are converted to/from the web side's (same role as
// godot_ext/src/axes.hpp). three.js and glTF are Y-up like Godot, so the mapping is identical:
//     three = (x, z, -y)            core = (x, -z, y)
// Car models face +Z: local X = left, Y = up, Z = forward.
//
// Data crosses the boundary through one shared double buffer per car (no allocations per tick).
// Layouts are documented next to each function; web/src/physics/core.ts mirrors them.
#include <emscripten/emscripten.h>

#include <array>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "rs/incandescence.hpp"
#include "rs/dyno.hpp"
#include "rs/cluster.hpp"
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/damage.hpp"
#include "rs/race.hpp"
#include "rs/route.hpp"
#include "rs/vehicle.hpp"

namespace {

rs::Vec3 to_core(double x, double y, double z) { return {x, -z, y}; }
void put(double* o, const rs::Vec3& v) { o[0] = v.x; o[1] = v.z; o[2] = -v.y; }   // core -> three

// core orientation -> three quaternion (x, y, z, w): three body axes are X = left, Y = up, Z = forward.
void put_quat(double* o, const rs::Quat& q) {
    double L[3], U[3], F[3];
    put(L, q.rotate({0, 1, 0}));
    put(U, q.rotate({0, 0, 1}));
    put(F, q.rotate({1, 0, 0}));
    // rotation matrix columns L, U, F -> quaternion
    const double m00 = L[0], m11 = U[1], m22 = F[2], tr = m00 + m11 + m22;
    double x, y, z, w;
    if (tr > 0) { const double s = std::sqrt(tr + 1.0) * 2; w = 0.25 * s; x = (U[2] - F[1]) / s; y = (F[0] - L[2]) / s; z = (L[1] - U[0]) / s; }
    else if (m00 > m11 && m00 > m22) { const double s = std::sqrt(1.0 + m00 - m11 - m22) * 2; w = (U[2] - F[1]) / s; x = 0.25 * s; y = (U[0] + L[1]) / s; z = (F[0] + L[2]) / s; }
    else if (m11 > m22) { const double s = std::sqrt(1.0 + m11 - m00 - m22) * 2; w = (F[0] - L[2]) / s; x = (U[0] + L[1]) / s; y = 0.25 * s; z = (F[1] + U[2]) / s; }
    else { const double s = std::sqrt(1.0 + m22 - m00 - m11) * 2; w = (L[1] - U[0]) / s; x = (F[0] + L[2]) / s; y = (F[1] + U[2]) / s; z = 0.25 * s; }
    o[0] = x; o[1] = y; o[2] = z; o[3] = w;
}

// three quaternion (x, y, z, w) -> core orientation, via the body axes.
rs::Quat quat_to_core(const double* q) {
    const double x = q[0], y = q[1], z = q[2], w = q[3];
    // columns of the three rotation matrix = local X (left), Y (up), Z (forward) in three world
    const double lx[3] = {1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)};
    const double ux[3] = {2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)};
    const double fx[3] = {2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)};
    return rs::Quat::from_axes(to_core(fx[0], fx[1], fx[2]), to_core(lx[0], lx[1], lx[2]),
                               to_core(ux[0], ux[1], ux[2]));
}

struct Car {
    rs::CarConfig cfg;
    std::unique_ptr<rs::Vehicle> vehicle;
    std::unique_ptr<rs::Controls> controls;
    rs::VehicleOutput out;
    rs::ChassisState cs;
    std::array<rs::WheelRay, 4> rays;
    std::array<rs::WheelContactPatchRays, 4> patch_rays;
    std::array<double, 4> spin{};
    std::vector<double> buf = std::vector<double>(448, 0.0);
    std::unique_ptr<rs::DynoRoad> dyno_road;     // garage dyno (rs/dyno.hpp): set between rs_dyno_begin / rs_dyno_end
    std::unique_ptr<rs::DynoMeter> dyno_meter;
    rs::InstrumentCluster cluster;               // dashboard needles (rs/cluster.hpp)
};

std::vector<std::unique_ptr<Car>> g_cars;
std::string g_error;

}  // namespace

extern "C" {

// Parse a car JSON (UTF-8, NUL-terminated). Returns a car id, or -1 (see rs_last_error).
EMSCRIPTEN_KEEPALIVE int rs_create(const char* json) {
    try {
        auto c = std::make_unique<Car>();
        c->cfg = rs::parse_car_config(json);
        c->vehicle = std::make_unique<rs::Vehicle>(c->cfg);
        c->vehicle->unsprung_dynamics_enabled = true;
        c->vehicle->tire_zones_enabled = true;
        c->vehicle->aero_wake().yaw_aero_enabled = true;
        c->vehicle->chassis_dynamics().chassis_flex_enabled = true;
        c->vehicle->chassis_dynamics().active_yaw_control_enabled = true;
        c->vehicle->chassis_dynamics().active_aero_enabled = true;
        c->vehicle->chassis_dynamics().brake_fluid_boil_enabled = true;
        c->vehicle->engine_systems().torsional_compliance_enabled = true;
        c->vehicle->engine_systems().dog_box_flat_shift_cut = true;
        // Street/GT cars without an explicit dog_box/dct spec run the physical H-pattern synchromesh cone clutch.
        if (c->cfg.drivetrain.transmission.empty()) {
            c->vehicle->engine_systems().transmission = rs::TransmissionType::HPatternSynchro;
        }
        c->vehicle->atmosphere().enabled = true;
        // Engine wear (redline / overheating abuse -> misfires) and fuel use; R repairs and refuels (rs_repair).
        // Same set as the Unreal plugin (UOpenGridVehicleComponent::ApplyFeatureFlagsLocked): keep them identical.
        c->vehicle->engine_systems().wear_enabled = true;
        c->vehicle->engine_systems().fuel_consumption_enabled = true;
        c->controls = std::make_unique<rs::Controls>(c->vehicle->config());
        c->buf[92] = -99;                                  // no H-pattern shifter until the page says so
        c->cluster.configure(c->cfg.engine.redline_rpm, 320.0);
        g_cars.push_back(std::move(c));
        return int(g_cars.size()) - 1;
    } catch (const std::exception& e) {
        g_error = e.what();
        return -1;
    }
}

EMSCRIPTEN_KEEPALIVE const char* rs_last_error() { return g_error.c_str(); }
EMSCRIPTEN_KEEPALIVE double* rs_buffer(int id) { return g_cars[id]->buf.data(); }

// Static facts the renderer needs, written to the buffer:
//   [0] mass  [1..3] inertia in three body axes (X left = pitch, Y up = yaw, Z fwd = roll)
//   [4] cg height  [5] wheel radius front  [6] wheel radius rear  [7] redline  [8] idle
//   [9] surface index of "asphalt"  [10] "pavement"  [11] "wall"
EMSCRIPTEN_KEEPALIVE void rs_info(int id) {
    const auto& c = *g_cars[id];
    double* b = g_cars[id]->buf.data();
    b[0] = c.cfg.mass;
    b[1] = c.cfg.inertia_yy;
    b[2] = c.cfg.inertia_zz;
    b[3] = c.cfg.inertia_xx;
    b[4] = c.cfg.cg_height;
    b[5] = c.cfg.tire_front.radius;
    b[6] = c.cfg.tire_rear.radius;
    b[7] = c.cfg.engine.redline_rpm;
    b[8] = c.cfg.engine.idle_rpm;
    b[9] = c.cfg.surface_index("asphalt");
    b[10] = c.cfg.surface_index("pavement");
    b[11] = c.cfg.surface_index("wall");
    b[12] = c.cfg.front.driven ? 1 : 0;   // driven axles (garage dyno drums)
    b[13] = c.cfg.rear.driven ? 1 : 0;
}

// Start rolling at speed (m/s) in a gear (-1 = keep), clearing slips.
EMSCRIPTEN_KEEPALIVE void rs_reset_motion(int id, double speed, int gear) {
    g_cars[id]->vehicle->reset_motion(speed, gear);
    g_cars[id]->out = rs::VehicleOutput{};
    if (speed == 0) g_cars[id]->spin = {};
    if (gear >= 0) g_cars[id]->controls->set_gear(gear);
}

// Set live atmospheric climate & altitude (Celsius, metres, 0..1 humidity) for ISA air density,
// NA/turbo engine output, and solid asphalt-to-tread thermal conduction.
// Key on: the cluster sweeps its needles to full scale and back (self-test) before showing the signals.
EMSCRIPTEN_KEEPALIVE void rs_cluster_sweep(int id) { g_cars[id]->cluster.ignition_sweep(); }

// Incandescence of a hot surface (brake discs): [luminance nits, r, g, b linear sRGB nits] in a static buffer.
EMSCRIPTEN_KEEPALIVE double* rs_incandescence(double temp_c, double emissivity) {
    static double o[4];
    const rs::Incandescence g = rs::incandescence(temp_c, emissivity);
    o[0] = g.luminance_nits; o[1] = g.r; o[2] = g.g; o[3] = g.b;
    return o;
}

// Rain water film on the road in mm (wet grip + aquaplaning; 0 = dry). Puddles per contact add on top.
EMSCRIPTEN_KEEPALIVE void rs_set_road_water(int id, double mm) { g_cars[id]->vehicle->road_water_mm = std::max(0.0, mm); }

EMSCRIPTEN_KEEPALIVE void rs_set_atmosphere(int id, double air_c, double track_c, double altitude_m, double humidity) {
    Car& c = *g_cars[id];
    auto& atm = c.vehicle->atmosphere();
    atm.enabled = true;
    atm.ambient_air_c = air_c;
    atm.track_surface_c = track_c;
    atm.altitude_m = altitude_m;
    atm.humidity_0_to_1 = humidity;
}

// Set forced-induction turbo stage (0 = NA, 1..3 = Stage 1-3 Turbocharger with spool & BOV flutter).
EMSCRIPTEN_KEEPALIVE void rs_set_turbo_stage(int id, int stage) {
    Car& c = *g_cars[id];
    c.vehicle->engine_systems().turbo_stage = std::max(0, std::min(3, stage));
}

// IN  buf[0..12]: chassis state, three world, origin = CG:
//     pos xyz, quat xyzw, linear vel xyz, angular vel xyz
// OUT buf[16 + 6 i]: wheel i ray from xyz, to xyz (three world). Order FL, FR, RL, RR.
EMSCRIPTEN_KEEPALIVE void rs_rays(int id) {
    Car& c = *g_cars[id];
    double* b = c.buf.data();
    c.cs.position = to_core(b[0], b[1], b[2]);
    c.cs.orientation = quat_to_core(b + 3);
    c.cs.velocity = to_core(b[7], b[8], b[9]);
    c.cs.angular_velocity = to_core(b[10], b[11], b[12]);
    c.rays = c.vehicle->wheel_rays(c.cs);
    for (int i = 0; i < 4; ++i) {
        put(b + 16 + 6 * i, c.rays[i].origin);
        put(b + 19 + 6 * i, c.rays[i].origin + c.rays[i].direction * c.rays[i].length);
    }
}

// Multi-point 3-ray longitudinal curb contact patch per wheel (12 rays total).
// IN  buf[0..12]: chassis state (three world)
// OUT buf[280 + 18 i + 6 r]: wheel i (0..3), ray r (0=trailing, 1=center, 2=leading) from xyz, to xyz (three world)
EMSCRIPTEN_KEEPALIVE void rs_rays_patch(int id) {
    Car& c = *g_cars[id];
    double* b = c.buf.data();
    c.cs.position = to_core(b[0], b[1], b[2]);
    c.cs.orientation = quat_to_core(b + 3);
    c.cs.velocity = to_core(b[7], b[8], b[9]);
    c.cs.angular_velocity = to_core(b[10], b[11], b[12]);
    c.patch_rays = c.vehicle->wheel_contact_patch_rays(c.cs);
    for (int i = 0; i < 4; ++i) {
        c.rays[i] = c.patch_rays[i].rays[1];
        for (int r = 0; r < 3; ++r) {
            const auto& ray = c.patch_rays[i].rays[r];
            double* dst = b + 280 + 18 * i + 6 * r;
            put(dst, ray.origin);
            put(dst + 3, ray.origin + ray.direction * ray.length);
        }
    }
}

namespace {
void step_with_contacts(Car& c, const std::array<rs::WheelContact, 4>& contacts, double dt) {
    double* b = c.buf.data();
    rs::RawInput raw;
    raw.steer = b[80];
    raw.throttle = b[81];
    raw.brake = b[82];
    raw.clutch = b[83];
    raw.handbrake = b[84];
    raw.line_lock = b[41];   // line lock: front brakes held (burnout)
    raw.shift_up = b[85] > 0.5;
    raw.shift_down = b[86] > 0.5;
    raw.device = rs::InputDevice(int(b[87]));
    auto& a = c.vehicle->assists();
    a.abs = b[88] > 0.5;
    a.tc = b[89] > 0.5;
    a.esc = b[90] > 0.5;
    c.controls->settings.auto_gearbox = b[91] > 0.5;
    a.abs_slip_target = b[93] > 0 ? b[93] : 0.10;
    a.tc_slip_target = b[94] > 0 ? b[94] : 0.10;
    c.controls->settings.countersteer_assist = b[95] > 0;
    if (b[95] > 0) c.controls->settings.countersteer_gain = b[95];
    raw.direct_gear = int(std::lround(b[92]));
    // buf[40]: auto-clutch assist mode: 0 (default) = Perfect, 1 = Normal, 2 = Poor, -1/3 = Off (manual clutch)
    const int ac_mode = int(std::lround(b[40]));
    if (ac_mode < 0 || ac_mode >= 3) {
        c.controls->settings.auto_clutch = false;
    } else {
        c.controls->settings.auto_clutch = true;
        c.controls->settings.auto_clutch_quality = rs::AutoClutchQuality(ac_mode);
    }

    const rs::DriverInput di = c.controls->update(raw, c.out, dt);
    c.vehicle->set_input(di);
    c.out = c.vehicle->update(c.cs, contacts, dt);

    // Dashboard: needles as a real cluster shows them (CAN 50 Hz + stepper), rev limiter state.
    // [420] tach pointer rpm [421] speedo pointer km/h [422] limiter cut [423] tach dial max rpm [424] speedo dial max km/h
    c.cluster.step(c.vehicle->engine_rpm(), std::abs(c.out.speed) * 3.6, dt);
    b[420] = c.cluster.tach.value();
    b[421] = c.cluster.speedo.value();
    b[422] = c.vehicle->engine_systems().limiter_cut ? 1 : 0;
    b[423] = c.cluster.tach_max_rpm();
    b[424] = c.cluster.speedo.params().full_scale;
    put(b + 96, c.out.force);
    put(b + 99, c.out.torque);
    b[102] = c.out.speed;
    b[103] = c.out.engine_rpm;
    b[104] = c.out.gear;
    b[105] = c.out.sideslip;
    b[106] = c.out.engine_stalled ? 1 : 0;
    b[107] = c.out.throttle_applied;
    b[108] = c.out.brake_applied;
    b[109] = di.steer;
    b[110] = c.out.accel.x;
    b[111] = c.out.accel.y;
    b[112] = c.out.accel.z;
    const auto& as = c.out.assists;
    b[113] = (as.abs_active[0] || as.abs_active[1] || as.abs_active[2] || as.abs_active[3]) ? 1 : 0;
    b[114] = as.tc_cut;
    b[115] = as.esc_mode;
    b[116] = c.out.steer_torque;
    double cav_lo_sum = 0.0, cav_hi_sum = 0.0, pitch_sum = 0.0;
    for (int i = 0; i < 4; ++i) {
        const rs::WheelOutput& w = c.out.wheels[i];
        c.spin[i] = std::fmod(c.spin[i] + w.angular_velocity * dt, 2 * rs::kPi);
        double* o = b + 120 + 12 * i;
        put(o, w.centre_world);
        o[3] = w.steer_angle;
        o[4] = c.spin[i];
        o[5] = w.contact ? 1 : 0;
        o[6] = w.load;
        o[7] = w.slip_ratio;
        o[8] = w.slip_angle;
        o[9] = w.compression;
        o[10] = w.angular_velocity;
        o[11] = contacts[i].surface;
        double* ext = b + 168 + 4 * i;
        ext[0] = w.mz;
        ext[1] = w.camber;
        ext[2] = w.condition.temperature_c;
        ext[3] = w.condition.wear;
        b[184 + i] = w.brake_temp_c;
        b[188 + i] = w.condition.surface_c;
        b[192 + i] = w.condition.pressure_kpa;
        b[196 + i] = w.brake_mu;
        // Extended Simcenter Tire 2606 & 3-Zone I/M/O + WLF telemetry [226..273]
        b[226 + i] = w.condition.inner_c;
        b[230 + i] = w.condition.middle_c;
        b[234 + i] = w.condition.outer_c;
        b[238 + i] = w.condition.flash_c;
        b[242 + i] = w.condition.flat_spot_depth_mm;
        const rs::TireAcousticSource ac = w.condition.compute_acoustics(w.angular_velocity, c.cfg.tire(i).radius, w.unsprung_vel_mps);
        b[246 + i] = ac.cavity_ring_gain;
        if (i < 2) { cav_lo_sum += ac.cavity_mode_low_hz; cav_hi_sum += ac.cavity_mode_high_hz; pitch_sum += ac.tread_block_pitch_hz; }
        b[265 + i] = w.condition.blistering;
        b[269 + i] = w.condition.graining;
        b[376 + i] = w.toe_angle;
        b[382 + i] = w.condition.inner_air_c;
    }
    b[250] = cav_lo_sum * 0.5;
    b[251] = cav_hi_sum * 0.5;
    b[252] = c.out.boost_bar;
    b[253] = c.out.bov_venting ? 1.0 : 0.0;
    b[254] = c.out.shift_cut_active ? 1.0 : 0.0;
    b[255] = c.out.drs_active ? 1.0 : 0.0;
    b[256] = c.out.airbrake_active ? 1.0 : 0.0;
    b[257] = c.out.front_splitter_stalled ? 1.0 : 0.0;
    b[258] = c.out.oil_temp_c;
    b[259] = c.out.intake_air_temp_c;
    b[260] = c.out.fuel_liters;
    b[261] = c.out.chassis_twist_deg;
    b[262] = c.out.brake_vapor_lock_sponge;
    b[263] = c.out.air_density_kg_m3;
    b[264] = c.out.ayc_yaw_moment_nm;
    b[273] = pitch_sum * 0.5;
    b[274] = c.out.mass_kg;   // current mass (fuel burnt off the spec's full-tank mass): world.ts applies it to the body
    // Physical clutch disc & synchromesh gearbox telemetry [275..279]
    b[275] = c.out.clutch_temp_c;
    b[276] = c.out.clutch_health;
    b[277] = c.out.gearbox_health;
    b[278] = c.out.missed_shifts;
    b[279] = c.out.gear_grind ? 1.0 : 0.0;
    b[380] = c.out.roll_centre_front_m;
    b[381] = c.out.roll_centre_rear_m;
}
}  // namespace

// Call after rs_rays with the raycast results and the driver's raw input.
EMSCRIPTEN_KEEPALIVE void rs_step(int id, double dt) {
    Car& c = *g_cars[id];
    double* b = c.buf.data();
    std::array<rs::WheelContact, 4> contacts{};
    for (int i = 0; i < 4; ++i) {
        const double* w = b + 48 + 8 * i;
        if (w[0] < 0.5) continue;
        rs::WheelContact& k = contacts[i];
        k.hit = true;
        k.point = to_core(w[1], w[2], w[3]);
        k.normal = rs::normalized(to_core(w[4], w[5], w[6]));
        k.distance = rs::length(k.point - c.rays[i].origin);
        k.surface = int(w[7]);
    }
    step_with_contacts(c, contacts, dt);
}

// Call after rs_rays_patch with 12 raycast hits in buf[280 + 24 i + 8 r] (r = 0..2).
// Resolves circular-arc curb climb & MF-Swift enveloping slope via Vehicle::resolve_contact_patch.
EMSCRIPTEN_KEEPALIVE void rs_step_patch(int id, double dt) {
    Car& c = *g_cars[id];
    double* b = c.buf.data();
    std::array<rs::WheelContact, 4> contacts{};
    for (int i = 0; i < 4; ++i) {
        std::array<rs::WheelContact, 3> hits{};
        for (int r = 0; r < 3; ++r) {
            const double* w = b + 280 + 24 * i + 8 * r;
            if (w[0] < 0.5) continue;
            rs::WheelContact& k = hits[r];
            k.hit = true;
            k.point = to_core(w[1], w[2], w[3]);
            k.normal = rs::normalized(to_core(w[4], w[5], w[6]));
            k.distance = rs::length(k.point - c.patch_rays[i].rays[r].origin);
            k.surface = int(w[7]);
        }
        contacts[i] = rs::Vehicle::resolve_contact_patch(c.patch_rays[i], hits, c.cfg.tire(i).radius);
    }
    step_with_contacts(c, contacts, dt);
}

// Crash input (call during a tick, after rs_rays): contact point in three world, impulse N s
// (measured from the car's own motion, see world.ts), id of the other object.
EMSCRIPTEN_KEEPALIVE void rs_contact(int id, double x, double y, double z, double impulse, double other) {
    Car& c = *g_cars[id];
    const rs::Vec3 body = c.cs.orientation.inv_rotate(to_core(x, y, z) - c.cs.position);
    c.vehicle->add_contact(std::uint64_t(other), body, impulse);
}

// ---- Garage dyno (road-load chassis dyno, rs/dyno.hpp): the same car on a flat virtual road under straps, so it revs,
// shifts, sounds and reaches its top speed exactly as on the road while the model stays on the rollers.
// rs_dyno_begin(id) -> rs_dyno_step(id, dt) every physics tick (inputs as rs_step: buf[80..95], buf[40..41]; outputs as
// rs_step) -> rs_dyno_end(id). Extra outputs: buf[400..406] body pose (three world: pos xyz, quat xyzw),
// [407] rpm [408] speed m/s [409] wheel power W [410] crank torque est. Nm [411] peak wheel power W [412] at rpm
// [413] peak crank torque Nm [414] at rpm [415] top speed m/s (0 until steady) [416] 0-100 km/h s (< 0 until done)
// [417] rollers turned m [418] wheel force N. rs_dyno_curve(id) -> [n, (rpm, wheel power W, crank torque Nm) x n].
EMSCRIPTEN_KEEPALIVE void rs_dyno_begin(int id) {
    Car& c = *g_cars[id];
    c.dyno_road = std::make_unique<rs::DynoRoad>(c.cfg);
    c.dyno_meter = std::make_unique<rs::DynoMeter>(c.cfg);
    c.dyno_road->reset(*c.vehicle);
    c.spin = {};
}
EMSCRIPTEN_KEEPALIVE void rs_dyno_end(int id) {
    Car& c = *g_cars[id];
    c.dyno_road.reset();
    c.dyno_meter.reset();
    c.vehicle->reset_motion(0.0, -1);
}
EMSCRIPTEN_KEEPALIVE void rs_dyno_reset_meter(int id) { if (g_cars[id]->dyno_meter) g_cars[id]->dyno_meter->reset(); }
EMSCRIPTEN_KEEPALIVE void rs_dyno_step(int id, double dt) {
    Car& c = *g_cars[id];
    if (!c.dyno_road) return;
    c.cs = c.dyno_road->state();
    const auto contacts = c.dyno_road->contacts(*c.vehicle);
    step_with_contacts(c, contacts, dt);
    c.dyno_road->integrate(c.out, dt);
    rs::DynoMeter& m = *c.dyno_meter;
    m.sample(c.out, c.vehicle->engine_rpm(), dt, c.vehicle->input().throttle);
    double* b = c.buf.data();
    put(b + 400, c.dyno_road->state().position);
    put_quat(b + 403, c.dyno_road->state().orientation);
    b[407] = m.rpm; b[408] = m.speed_mps; b[409] = m.wheel_power_w; b[410] = m.crank_torque_nm;
    b[411] = m.peak_wheel_power_w(); b[412] = m.peak_power_rpm(); b[413] = m.peak_crank_torque_nm(); b[414] = m.peak_torque_rpm();
    b[415] = m.top_speed_mps(); b[416] = m.zero_to_100_s(); b[417] = c.dyno_road->distance_m(); b[418] = m.wheel_force_n;
}
EMSCRIPTEN_KEEPALIVE double* rs_dyno_curve(int id) {
    static std::vector<double> v;
    v.assign(1, 0.0);
    if (!g_cars[id]->dyno_meter) return v.data();
    for (const rs::DynoPoint& p : g_cars[id]->dyno_meter->curve())
        if (p.wheel_power_w > 0) { v.push_back(p.rpm); v.push_back(p.wheel_power_w); v.push_back(p.crank_torque_nm); }
    v[0] = double((v.size() - 1) / 3);
    return v.data();
}

// Damage report -> buf[200..]: crush m (front, rear, left, right) [200..203], zone 0..1 [204..207],
// wheel 0..1 FL FR RL RR [208..211], engine 0..1 [212], last impact kJ [213],
// last impact point in the car's LOCAL three frame (X left, Y up, Z fwd; origin CG) [214..216],
// last zone [217], impacts [218], totaled [219] (report only: the car stays drivable), total kJ [220],
// smoulder 0..1 [221], fire 0..1 [222], brake effectiveness 0..1 [223], brakes failed [224],
// severity 0..1 [225]
EMSCRIPTEN_KEEPALIVE void rs_damage(int id) {
    Car& c = *g_cars[id];
    const rs::DamageReport& d = c.out.damage;
    double* b = c.buf.data() + 200;
    for (int i = 0; i < 4; ++i) { b[i] = d.crush[i]; b[4 + i] = d.zone[i]; b[8 + i] = d.wheel[i]; }
    b[12] = d.engine;
    b[13] = d.last_impact_kj;
    const rs::Vec3& p = d.last_impact_point;   // core body: x fwd, y left, z up
    b[14] = p.y; b[15] = p.z; b[16] = p.x;
    b[17] = d.last_zone;
    b[18] = d.impacts;
    b[19] = d.totaled ? 1 : 0;
    b[20] = d.total_energy_kj;
    b[21] = d.smoulder;
    b[22] = d.fire;
    b[23] = d.brakes;
    b[24] = d.brakes_failed ? 1 : 0;
    b[25] = c.vehicle->damage_model().severity();
}

EMSCRIPTEN_KEEPALIVE void rs_repair(int id) {
    g_cars[id]->vehicle->damage_model().repair();
    g_cars[id]->vehicle->service();   // full tank, healthy engine
    g_cars[id]->out.damage = rs::DamageReport{};
}

// ---- race (laps, lap times, positions): one race at a time --------------------------------
namespace {
std::unique_ptr<rs::Route> g_route;
std::unique_ptr<rs::RaceTracker> g_race;
std::vector<double> g_race_buf(16, 0.0);
}

// Route JSON (schema route/1) + lap count (0 = free run, laps counted forever). Returns 0 or -1.
EMSCRIPTEN_KEEPALIVE int rs_race_create(const char* route_json, int laps) {
    try {
        g_race.reset();
        g_route = std::make_unique<rs::Route>(rs::Route::parse(route_json));
        g_race = std::make_unique<rs::RaceTracker>(*g_route, laps > 0 ? laps : 1000000);
        return 0;
    } catch (const std::exception& e) {
        g_error = e.what();
        return -1;
    }
}
EMSCRIPTEN_KEEPALIVE double* rs_race_buffer() { return g_race_buf.data(); }
EMSCRIPTEN_KEEPALIVE int rs_race_add(double x, double y, double z) { return g_race->add_car(to_core(x, y, z)); }

// Position in three world, race time s. Writes buf: [0] laps done, [1] current lap time,
// [2] last lap, [3] best lap, [4] distance m, [5] position, [6] finished, [7] route length m
EMSCRIPTEN_KEEPALIVE void rs_race_update(int car, double x, double y, double z, double time) {
    g_race->update(car, to_core(x, y, z), time);
    g_race->rank();
    const rs::RaceProgress& p = g_race->progress(car);
    double* b = g_race_buf.data();
    b[0] = p.lap;
    b[1] = time - p.lap_start_time;
    b[2] = p.last_lap;
    b[3] = p.best_lap;
    b[4] = p.distance;
    b[5] = p.position;
    b[6] = p.finished ? 1 : 0;
    b[7] = g_route->length();
}

}  // extern "C"
