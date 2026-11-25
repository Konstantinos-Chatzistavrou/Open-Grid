// Regression tests for the findings of the 2026-11-25 ultrareview of the physics core (tyre / chassis / drivetrain / audio /
// telemetry). One test per finding; each fails on the code as it was before the fix. Names start with ur_.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <vector>
#include "harness.hpp"
#include "../third_party/nlohmann/json.hpp"
#include "rs/controls.hpp"
#include "rs/dyno.hpp"
#include "rs/engine_audio.h"
#include "rs/kinematics.hpp"
#include "rs/street_surface.hpp"
#include "rs/telemetry.hpp"
#include "rs/vehicle_audio.hpp"
#include "rs/vehicle_runtime.hpp"

using namespace rs;

namespace {

float rd_f32(const std::uint8_t* p, std::size_t off) {
    float v;
    std::memcpy(&v, p + off, sizeof v);
    return v;
}

// ---- a tiny runtime rig: one car on a plane, single-ray contacts, no chassis integration (the chassis stays put) ------
struct RuntimeRig {
    CarConfig cfg;
    std::unique_ptr<Vehicle> vehicle;
    std::unique_ptr<Controls> controls;
    std::unique_ptr<rt::VehicleRuntime<64, 256>> runtime;
    RigidBody body;
    PlaneGround ground;
    double dt = 1.0 / 240.0;

    RuntimeRig() : cfg(test::car()) {
        vehicle = std::make_unique<Vehicle>(cfg);
        controls = std::make_unique<Controls>(vehicle->config());
        runtime = std::make_unique<rt::VehicleRuntime<64, 256>>(*vehicle, *controls);
        body.mass = cfg.mass;
        body.inertia = {cfg.inertia_xx, cfg.inertia_yy, cfg.inertia_zz};
        body.state.position = {0, 0, cfg.cg_height};
        vehicle->reset_motion(0, 1);
    }
    const VehicleOutput& step() {
        const auto rays = vehicle->wheel_rays(body.state);
        std::array<WheelContact, 4> contacts;
        for (int i = 0; i < 4; ++i) contacts[i] = ground.raycast(rays[i]);
        return runtime->step(body.state, contacts, dt);
    }
};

SuspensionHardpoints textbook_double_wishbone() {
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
    return hp;
}

}  // namespace

// ---------------------------------------------------------------- controls: pedal reverse never overrides a chosen gear
RS_TEST(ur_pedal_reverse_explicit_gear) {
    CarConfig cfg = test::car();
    Controls c(cfg);
    VehicleOutput last;   // standing still
    const double dt = 1.0 / 240.0;
    RawInput raw;
    raw.device = InputDevice::Wheel;   // pedals are used as they are
    raw.shift_down = true;             // 1st -> N -> R with the paddle
    c.update(raw, last, dt);
    c.update(raw, last, dt);
    raw.shift_down = false;
    test::check("paddle shifts 1st -> N -> R", c.gear() == 0);
    raw.brake = 1.0;
    DriverInput in;
    for (int i = 0; i < 2 * 240; ++i) in = c.update(raw, last, dt);
    test::check("R chosen by paddle, brake held at rest: pedals do NOT swap", !c.pedal_reversing());
    test::check("the brake pedal is still the brake, the throttle is 0", in.brake > 0.99 && in.throttle < 0.01);
}

RS_TEST(ur_pedal_reverse_hshifter) {
    CarConfig cfg = test::car();
    Controls c(cfg);
    VehicleOutput last;
    const double dt = 1.0 / 240.0;
    RawInput raw;
    raw.device = InputDevice::Wheel;
    raw.direct_gear = 2;   // lever in 1st
    raw.brake = 1.0;
    bool gear_changed = false, throttle_seen = false;
    for (int i = 0; i < 3 * 240; ++i) {
        const DriverInput in = c.update(raw, last, dt);
        if (in.gear != 2) gear_changed = true;
        if (in.throttle > 0.5) throttle_seen = true;
    }
    test::check("H-shifter in 1st, brake held at rest: the gear never leaves 1st", !gear_changed);
    test::check("... and the pedals never swap (no brake-as-throttle ticks)", !throttle_seen && !c.pedal_reversing());
}

// ---------------------------------------------------------------- runtime: settings are levels, impacts are tick-stamped
RS_TEST(ur_runtime_road_water) {
    RuntimeRig rig;
    rt::VehicleCommand cmd;
    cmd.has_settings = true;
    cmd.settings.road_water_mm = 1.5;   // street surface stays off (the default)
    rig.runtime->submit(cmd);
    rig.step();
    test::check("settings set the road water", std::abs(rig.vehicle->road_water_mm - 1.5) < 1e-12);
    cmd.settings.road_water_mm = 0.0;   // the rain stops
    rig.runtime->submit(cmd);
    rig.step();
    test::check("settings back to 0 dry the road again (street surface off)", rig.vehicle->road_water_mm == 0.0);
}

RS_TEST(ur_runtime_impact_tick) {
    RuntimeRig rig;
    rt::ImpactCommand imp;
    imp.point_world = {2.0, 0.0, 0.5};
    imp.impulse = 9000.0;
    imp.other = 7;
    imp.apply_tick = 5;
    rig.runtime->submit_impact(imp);
    double energy_before = 0.0;
    for (int i = 0; i < 5; ++i) energy_before = std::max(energy_before, rig.step().damage.total_energy_kj);
    test::check("impact stamped for tick 5 is held back until then", energy_before == 0.0);
    double energy_after = 0.0;
    for (int i = 0; i < 3; ++i) energy_after = std::max(energy_after, rig.step().damage.total_energy_kj);
    test::check("... and applied on that tick", energy_after > 0.0);
    rt::ImpactCommand now = imp;
    now.apply_tick = 0;   // 0 = next step, as before
    RuntimeRig rig2;
    rig2.runtime->submit_impact(now);
    test::check("apply_tick 0 still means the next step", rig2.step().damage.total_energy_kj > 0.0);
}

// ---------------------------------------------------------------- tyre: zone heating is mirror-symmetric
RS_TEST(ur_tire_zone_camber_symmetry) {
    CarConfig cfg = test::car();
    const TireParams& tp = cfg.tire(0);
    auto heat = [&](double side_sign, double gamma) {
        TireCondition t;
        for (int i = 0; i < 1500; ++i)
            t.update_zones(3500.0, 4000.0, 30.0, gamma, 0.0, side_sign, 30.0 / tp.radius, 0.0, 0.01, &tp);
        return t;
    };
    const double g = 0.05;   // rad of camber; + = top tilted toward +left
    // top INWARD: left wheel gamma < 0, right wheel gamma > 0 (the mirror of each other)
    const TireCondition in_l = heat(-1.0, -g), in_r = heat(+1.0, +g);
    test::check_range("inward tilt, left vs right: inner temperature equal", in_l.inner_c - in_r.inner_c, -1e-9, 1e-9, "C");
    test::check_range("inward tilt, left vs right: outer temperature equal", in_l.outer_c - in_r.outer_c, -1e-9, 1e-9, "C");
    test::check("top inward heats the inner rib more", in_l.inner_c > in_l.outer_c + 0.5);
    // top OUTWARD: left wheel gamma > 0, right wheel gamma < 0
    const TireCondition out_l = heat(-1.0, +g), out_r = heat(+1.0, -g);
    test::check_range("outward tilt, left vs right: inner temperature equal", out_l.inner_c - out_r.inner_c, -1e-9, 1e-9, "C");
    test::check_range("outward tilt, left vs right: outer temperature equal", out_l.outer_c - out_r.outer_c, -1e-9, 1e-9, "C");
    test::check("top outward heats the outer rib more (on the right wheel too)", out_r.outer_c > out_r.inner_c + 0.5);
}

// ---------------------------------------------------------------- kinematics: the solve does not depend on the hinge direction
RS_TEST(ur_kinematics_hinge_direction) {
    const SuspensionHardpoints a = textbook_double_wishbone();
    SuspensionHardpoints b = a;   // the same physical arms with front / rear labelled the other way round
    std::swap(b.lca_front, b.lca_rear);
    std::swap(b.uca_front, b.uca_rear);
    const KinematicSolver sa(a), sb(b);
    double worst_z = 0.0, worst_camber = 0.0;
    int valid = 0;
    for (double dz : {-0.06, -0.03, 0.0, 0.03, 0.06}) {
        const KinematicPose pa = sa.solve_pose(dz, 0.0), pb = sb.solve_pose(dz, 0.0);
        if (pa.valid && pb.valid) ++valid;
        worst_z = std::max(worst_z, std::abs(pb.wheel_center.z - (a.wheel_center.z + dz)));
        worst_camber = std::max(worst_camber, std::abs(sa.evaluate(dz, 0.0).camber_rad - sb.evaluate(dz, 0.0).camber_rad));
    }
    test::check("both hinge directions solve at every travel", valid == 5);
    test::check_range("swapped hinge reaches the target wheel height", worst_z, 0.0, 1e-6, "m");
    test::check_range("swapped hinge gives the same camber", worst_camber, 0.0, 1e-6, "rad");
}

// ---------------------------------------------------------------- contact resolvers keep what the ground reports
RS_TEST(ur_contact_resolver_ground_data) {
    CarConfig cfg = test::car();
    Vehicle veh(cfg);
    ChassisState s;
    s.position = {0, 0, cfg.cg_height};
    auto fake_hit = [](const WheelRay& ray) {
        WheelContact h;
        h.hit = true;
        h.distance = ray.length * 0.9;
        h.point = ray.origin + ray.direction * h.distance;
        h.normal = {0, 0, 1};
        h.water_depth_mm = 2.5;
        h.surface_mu_mult = 0.7;
        h.marble_density = 0.3;
        h.patch_profile.mu_cell[5] = 0.5;   // a wet manhole lid under the patch
        return h;
    };
    {
        const auto patches = veh.wheel_contact_patch_rays(s);
        std::array<WheelContact, 3> hits;
        for (int j = 0; j < 3; ++j) hits[j] = fake_hit(patches[FL].rays[j]);
        const WheelContact c = Vehicle::resolve_contact_patch(patches[FL], hits, cfg.tire(FL).radius);
        test::check("3-ray patch keeps the water film", std::abs(c.water_depth_mm - 2.5) < 1e-12);
        test::check("3-ray patch keeps the surface grip multiplier and marbles",
                    std::abs(c.surface_mu_mult - 0.7) < 1e-12 && std::abs(c.marble_density - 0.3) < 1e-12);
        test::check("3-ray patch keeps the per-cell grip", std::abs(c.patch_profile.mu_cell[5] - 0.5) < 1e-12 && c.patch_profile.has_height_map);
    }
    {
        const auto fps = veh.wheel_footprint_16_rays(s);
        std::array<WheelContact, 16> hits;
        for (int j = 0; j < 16; ++j) hits[j] = fake_hit(fps[FL].rays[j]);
        const WheelContact c = Vehicle::resolve_footprint_16(fps[FL], hits, cfg.tire(FL).radius);
        test::check("16-ray footprint keeps the water film", std::abs(c.water_depth_mm - 2.5) < 1e-12);
        test::check("16-ray footprint keeps the surface grip multiplier and marbles",
                    std::abs(c.surface_mu_mult - 0.7) < 1e-12 && std::abs(c.marble_density - 0.3) < 1e-12);
        test::check("16-ray footprint keeps the per-cell grip", std::abs(c.patch_profile.mu_cell[5] - 0.5) < 1e-12 && c.patch_profile.has_height_map);
    }
}

// ---------------------------------------------------------------- street surface
RS_TEST(ur_street_micro_heading) {
    UrbanStreetConfig pc;
    pc.road_class = IsoRoadClass::ClassA_Highway;
    pc.pothole_x_m = 20.0;
    pc.pothole_y_m = 0.0;
    pc.pothole_radius_m = 0.36;
    pc.pothole_depth_m = 0.095;
    const StreetMicroGround ground(pc, 0);
    auto probe = [&](Vec3 forward) {
        WheelRay ray;
        ray.origin = {19.60, 0.0, 0.5};   // the patch centre sits 0.40 m from the pothole centre, just outside its 0.36 m rim
        ray.direction = {0, 0, -1};
        ray.length = 1.0;
        ray.forward = forward;
        return ground.raycast(ray).patch_profile;
    };
    // rows run trailing -> leading (idx = row * 4 + col), columns right -> left
    const ContactPatchProfile along_x = probe({1, 0, 0});
    test::check("heading +X: the pothole shows up in the leading row", along_x.road_dz_m[3 * 4 + 1] < -0.01);
    test::check("heading +X: the trailing row is clear", std::abs(along_x.road_dz_m[0 * 4 + 1]) < 0.01);
    const ContactPatchProfile along_y = probe({0, 1, 0});
    test::check("heading +Y: the pothole shows up in the right-hand column, not the leading row",
                along_y.road_dz_m[1 * 4 + 0] < -0.01 && std::abs(along_y.road_dz_m[3 * 4 + 1]) < 0.01);
}

RS_TEST(ur_street_drainage_symmetry) {
    StreetSurfaceEvolution evo;
    evo.reset(0.0, 1.0, 0.0);   // an even 1 mm film everywhere
    for (int i = 0; i < 200; ++i) evo.step_weather(0.0, 15.0, 0.1);
    double worst = 0.0;
    for (int l = 0; l < StreetSurfaceEvolution::kLanes / 2; ++l) {
        const double left = evo.sample(5.0, evo.lane_center_m(l)).water_mm;
        const double right = evo.sample(5.0, evo.lane_center_m(StreetSurfaceEvolution::kLanes - 1 - l)).water_mm;
        worst = std::max(worst, std::abs(left - right));
    }
    test::check_range("crown drainage leaves mirror-image lanes equally wet", worst, 0.0, 1e-9, "mm");
}

// ---------------------------------------------------------------- a reset car starts like a fresh one
RS_TEST(ur_reset_clears_carryover) {
    CarConfig cfg = test::car();
    DriverInput idle;
    idle.gear = 1;
    auto fresh = test::make_sim(cfg);
    fresh->reset({}, 0.0, 0.0, 1);
    fresh->step(idle);
    const VehicleOutput ref = fresh->last;

    auto driven = test::make_sim(cfg);
    driven->reset({}, 0.0, 30.0, 4);
    DriverInput hard;
    hard.gear = 4;
    hard.brake = 1.0;   // hard braking: big tyre Fx, ABS working, nose dive
    for (int i = 0; i < 2 * 240; ++i) driven->step(hard);
    driven->reset({}, 0.0, 0.0, 1);
    driven->step(idle);
    double worst_load = 0.0, worst_comp = 0.0;
    for (int w = 0; w < 4; ++w) {
        worst_load = std::max(worst_load, std::abs(driven->last.wheels[w].load - ref.wheels[w].load));
        worst_comp = std::max(worst_comp, std::abs(driven->last.wheels[w].compression - ref.wheels[w].compression));
    }
    test::check_range("first step after reset: wheel loads equal a fresh car's", worst_load, 0.0, 0.5, "N");
    test::check_range("first step after reset: suspension compression equals a fresh car's", worst_comp, 0.0, 1e-5, "m");
}

// ---------------------------------------------------------------- telemetry
RS_TEST(ur_telemetry_velocity_frame) {
    CarConfig cfg = test::car();
    VehicleOutput out;
    ChassisState chassis;
    chassis.orientation = Quat::from_axis_angle({0, 0, 1}, kPi / 2.0);   // heading along world +Y
    chassis.velocity = {0.0, 20.0, 0.0};                                  // driving straight ahead at 20 m/s
    DriverInput in;
    const TelemetrySample s = make_telemetry_sample(out, chassis, in, cfg, 1.0);
    test::check("body-frame velocity is straight ahead", std::abs(s.velocity_body.x - 20.0) < 1e-9 && std::abs(s.velocity_body.y) < 1e-9);
    const auto pkt = pack_simhub_udp(s);
    test::check("SimHub velocity Z (forward) = 20 m/s", std::abs(rd_f32(pkt.data(), 40) - 20.0f) < 1e-3f);
    test::check("SimHub velocity X (right) = 0, not the world-frame leak", std::abs(rd_f32(pkt.data(), 32)) < 1e-3f);
}

RS_TEST(ur_telemetry_power_torque) {
    CarConfig cfg = test::car();
    VehicleOutput out;
    out.clutch_torque_nm = 300.0;
    out.engine_rpm = 6000.0;
    ChassisState chassis;
    DriverInput in;
    const TelemetrySample s = make_telemetry_sample(out, chassis, in, cfg, 1.0);
    const double expect_w = 300.0 * 6000.0 * 2.0 * kPi / 60.0;
    const auto pkt = pack_simhub_udp(s);
    test::check("SimHub torque field carries the engine torque", std::abs(rd_f32(pkt.data(), 252) - 300.0f) < 0.01f);
    test::check("SimHub power field = torque x engine speed", std::abs(rd_f32(pkt.data(), 248) - static_cast<float>(expect_w)) < 5.0f);

    // the car-identity fields come from the car, not constants
    auto rd_i32 = [](const std::uint8_t* b, std::size_t off) { std::int32_t v; std::memcpy(&v, b + off, sizeof v); return v; };
    CarConfig awd12 = cfg;
    awd12.drivetrain.layout = "awd";
    awd12.engine.cylinders = 12;
    const auto pkt2 = pack_simhub_udp(make_telemetry_sample(out, chassis, in, awd12, 1.0));
    test::check("SimHub drivetrain type = AWD (2) for an AWD car", rd_i32(pkt2.data(), 224) == 2);
    test::check("SimHub cylinder count = the car's", rd_i32(pkt2.data(), 228) == 12);
    CarConfig fwd4 = cfg;
    fwd4.drivetrain.layout = "fwd";
    fwd4.engine.cylinders = 4;
    const auto pkt3 = pack_simhub_udp(make_telemetry_sample(out, chassis, in, fwd4, 1.0));
    test::check("SimHub drivetrain type = FWD (0) and 4 cylinders for a FWD four",
                rd_i32(pkt3.data(), 224) == 0 && rd_i32(pkt3.data(), 228) == 4);
}

RS_TEST(ur_motec_time_base) {
    auto frames = [](double fps, double seconds, double jitter) {
        TelemetryMeta meta;   // 60 Hz
        MotecLogger log(meta);
        TelemetrySample s;
        double t = 0.0;
        unsigned lcg = 12345;
        while (t < seconds) {
            s.time_s = t;
            s.speed_ms = t;
            log.record(s);
            lcg = lcg * 1664525u + 1013904223u;
            const double wobble = jitter * (static_cast<double>(lcg >> 8) / 16777216.0 - 0.5);
            t += (1.0 / fps) * (1.0 + wobble);
        }
        return log;
    };
    for (double fps : {144.0, 60.0, 30.0}) {
        const MotecLogger log = frames(fps, 10.0, 0.0);
        char what[96];
        std::snprintf(what, sizeof what, "%.0f fps for 10 s -> 600 rows on the 60 Hz time base (got %zu)", fps, log.sample_count());
        test::check(what, log.sample_count() >= 599 && log.sample_count() <= 601);
    }
    {
        const MotecLogger log = frames(97.0, 10.0, 0.6);   // a ragged, varying frame rate
        char what[96];
        std::snprintf(what, sizeof what, "jittered ~97 fps for 10 s -> ~600 rows (got %zu)", log.sample_count());
        test::check(what, log.sample_count() >= 597 && log.sample_count() <= 603);
    }
    {   // the .ld declares 60 Hz, so row count / 60 must be the real duration
        const MotecLogger log = frames(144.0, 5.0, 0.0);
        const auto ld = log.build_ld();
        const std::uint32_t n = static_cast<std::uint32_t>(ld[1762 + 0x0C]) | (static_cast<std::uint32_t>(ld[1762 + 0x0D]) << 8) |
                                (static_cast<std::uint32_t>(ld[1762 + 0x0E]) << 16) | (static_cast<std::uint32_t>(ld[1762 + 0x0F]) << 24);
        const std::uint16_t hz = static_cast<std::uint16_t>(ld[1762 + 0x16] | (ld[1762 + 0x17] << 8));
        test::check_range("exported duration (samples / declared rate)", static_cast<double>(n) / hz, 4.98, 5.02, "s");
    }
    {   // memory stays bounded however long it runs
        TelemetryMeta slow;
        slow.sample_rate_hz = 1.0;
        MotecLogger log(slow);
        TelemetrySample s;
        for (int i = 0; i < 8000; ++i) { s.time_s = i; log.record(s); }
        test::check("log stops growing after kMaxSeconds", log.sample_count() == static_cast<std::size_t>(MotecLogger::kMaxSeconds) && log.full());
    }
    {   // a pause is not back-filled; beacons are relative to the first row
        MotecLogger log;
        TelemetrySample s;
        for (int i = 0; i < 120; ++i) { s.time_s = 10.0 + i / 60.0; log.record(s); }
        s.time_s = 600.0;   // a ten-minute pause
        log.record(s);
        test::check("a long pause adds one row, not 36000 held ones", log.sample_count() == 121);
        log.mark_lap(12.0);
        test::check("lap beacon time is relative to the first sample", log.build_ldx().find("Time=\"2000000\"") != std::string::npos);
    }
}

// ---------------------------------------------------------------- car data: engine sound + cylinders
RS_TEST(ur_engine_voice_data) {
    using nlohmann::json;
    std::ifstream cf(test::data_path("cars/catalog.json"));
    const json catalog = json::parse(cf);
    std::map<std::string, std::string> expect;   // car id -> voice id
    for (const auto& c : catalog.at("cars"))
        if (c.contains("engineVoice")) expect[c.at("id").get<std::string>()] = c.at("engineVoice").get<std::string>();
    // the stock engines of the eight base cars (web/src/brands.ts CAR_STOCK_ENGINE)
    expect["vela_gt"] = "v8_crossplane";
    expect["kestrel_gt"] = "flat6_na";
    expect["harrier_gt"] = "v8_twin_turbo";
    expect["strix_gt7"] = "v12_na";
    expect["hayate"] = "i6_forged";
    expect["basilisk_v12"] = "v12_na";
    expect["tornado_gt"] = "v6_tt";
    expect["tornado_gt3"] = "v8_flatplane";
    auto cylinders_of = [](const std::string& v) {
        if (v == "v12_na") return 12;
        if (v == "v10_screamer") return 10;
        if (v == "v6_tt" || v == "flat6_na" || v == "i6_forged") return 6;
        if (v == "i4_turbo") return 4;
        return 8;   // v8_*, and the rotary's equivalent of 8 firing pulses per two revolutions
    };
    int checked = 0, wrong_voice = 0, wrong_cyl = 0, missing = 0;
    for (const auto& [id, voice] : expect) {
        const CarConfig cfg = load_car_config(test::data_path("cars/" + id + ".json"));
        ++checked;
        if (cfg.engine.voice != voice) { ++wrong_voice; std::printf("         %s: voice '%s', expected '%s'\n", id.c_str(), cfg.engine.voice.c_str(), voice.c_str()); }
        if (cfg.engine.cylinders != cylinders_of(voice)) { ++wrong_cyl; std::printf("         %s: %d cylinders, expected %d\n", id.c_str(), cfg.engine.cylinders, cylinders_of(voice)); }
        if (select_voice_for_car(cfg) != EngineAudioSynth::parseVoice(voice)) { ++wrong_voice; std::printf("         %s: UE auto-voice differs\n", id.c_str()); }
    }
    // every car physics file names a voice
    for (const auto& e : std::filesystem::directory_iterator(test::data_path("cars"))) {
        const std::string name = e.path().filename().string();
        if (e.path().extension() != ".json" || name == "catalog.json" || name.find(".visual.") != std::string::npos) continue;
        const CarConfig cfg = load_car_config(e.path().string());
        if (cfg.engine.voice.empty()) { ++missing; std::printf("         %s has no engine voice\n", name.c_str()); }
    }
    std::printf("         %d cars checked\n", checked);
    test::check("every catalog car's engine voice (and UE auto-voice) matches the catalog / brands table", wrong_voice == 0 && checked >= 24);
    test::check("every car's cylinder count matches its engine", wrong_cyl == 0);
    test::check("every car physics file names its engine voice", missing == 0);
}

// ---------------------------------------------------------------- engine audio
RS_TEST(ur_engine_audio_step_count) {
    EngineAudioSynth synth;
    EngineAudioConfig cfg{};
    cfg.voice = EngineVoice::V8Crossplane;
    cfg.sampleRate = 48000;
    cfg.simFrequency = 5000;
    test::check("synth initialises", synth.initialize(cfg));
    EngineAudioControl c;
    c.rpm = 4200.0f;
    c.throttle = 0.5f;
    c.load = 0.5f;
    synth.setControl(c);
    std::vector<float> L(480), R(480);
    const int blocks = 400;   // 4 s: several cycles of the synthesizer's 1 s input ring that used to steer the step count
    const unsigned long long before = synth.solverStepsRun();
    for (int i = 0; i < blocks; ++i) synth.renderStereo(L.data(), R.data(), 480);
    const double steps = static_cast<double>(synth.solverStepsRun() - before);
    const double expect = static_cast<double>(blocks) * 480.0 * cfg.simFrequency / cfg.sampleRate;
    std::printf("         solver steps %.0f, expected %.0f (%.2f %%)\n", steps, expect, 100.0 * steps / expect);
    test::check_range("solver runs exactly frames x simFrequency / sampleRate steps", steps - expect, -2.0, 2.0, "steps");
    // and a block larger than the scratch reservation still renders (it is chunked, not grown on the audio thread)
    std::vector<float> bigL(9000), bigR(9000);
    synth.renderStereo(bigL.data(), bigR.data(), 9000);
    bool finite = true;
    for (int i = 0; i < 9000; ++i) finite = finite && std::isfinite(bigL[i]) && std::isfinite(bigR[i]);
    test::check("a 9000-frame block renders finite audio", finite);
}

RS_TEST(ur_audio_non_finite) {
    const float nan = std::numeric_limits<float>::quiet_NaN();
    const float inf = std::numeric_limits<float>::infinity();
    auto all_finite = [](const std::vector<float>& a) {
        for (float v : a) if (!std::isfinite(v)) return false;
        return true;
    };
    auto rms = [](const std::vector<float>& a) {
        double s = 0;
        for (float v : a) s += static_cast<double>(v) * v;
        return std::sqrt(s / static_cast<double>(a.size()));
    };
    {   // the engine synth
        EngineAudioSynth synth;
        EngineAudioConfig cfg{};
        cfg.sampleRate = 48000;
        cfg.simFrequency = 5000;
        synth.initialize(cfg);
        EngineAudioControl c;
        c.rpm = 3000.0f;
        c.throttle = 0.4f;
        synth.setControl(c);
        std::vector<float> L(512), R(512);
        for (int i = 0; i < 6; ++i) synth.renderStereo(L.data(), R.data(), 512);
        c.rpm = nan;       // one bad tick of telemetry
        c.boostBar = inf;
        c.throttle = nan;
        synth.setControl(c);
        for (int i = 0; i < 2; ++i) synth.renderStereo(L.data(), R.data(), 512);
        test::check("engine synth: output stays finite through a NaN / inf tick", all_finite(L) && all_finite(R));
        c.rpm = 3500.0f;   // telemetry is sane again
        c.boostBar = 0.0f;
        c.throttle = 0.5f;
        synth.setControl(c);
        for (int i = 0; i < 24; ++i) synth.renderStereo(L.data(), R.data(), 512);
        test::check("engine synth: recovers and is audible again", all_finite(L) && all_finite(R) && rms(L) > 1e-4 && std::isfinite(synth.measuredRpm()));
    }
    {   // the whole vehicle mix
        VehicleAudioEngine eng;
        VehicleAudioConfig cfg{};
        cfg.engine.sampleRate = 48000;
        eng.initialize(cfg);
        VehicleAudioTelemetry t{};
        t.speed_mps = 30.0f;
        for (int w = 0; w < 4; ++w) {
            t.wheels[w].contact = true;
            t.wheels[w].load_n = 3800.0f;
            t.wheels[w].angular_velocity = 90.0f;
        }
        std::vector<float> L(1024), R(1024);
        eng.setTelemetry(t);
        eng.renderStereo(L.data(), R.data(), 1024);
        VehicleAudioTelemetry bad = t;
        bad.rpm = nan;
        bad.wheels[0].angular_velocity = nan;
        bad.wheels[1].load_n = inf;
        bad.speed_mps = nan;
        eng.setTelemetry(bad);
        eng.renderStereo(L.data(), R.data(), 1024);
        test::check("vehicle audio: output stays finite through a NaN / inf tick", all_finite(L) && all_finite(R));
        eng.setTelemetry(t);
        for (int i = 0; i < 8; ++i) eng.renderStereo(L.data(), R.data(), 1024);
        test::check("vehicle audio: recovers and is audible again", all_finite(L) && all_finite(R) && rms(L) > 1e-5);
    }
}

// ---------------------------------------------------------------- dyno: power and rpm are smoothed alike
// A synthetic full-throttle pull with a known power curve (peak at 5500 rpm) while the rpm climbs 1500 rpm/s. The meter
// smooths the power over ~0.5 s; binned against the LIVE rpm the peak read ~750 rpm too high.
RS_TEST(ur_dyno_rpm_alignment) {
    const CarConfig cfg = test::car();
    DynoMeter meter(cfg);
    int driven = 0;
    for (int w = 0; w < 4; ++w) driven += cfg.axle(w).driven ? 1 : 0;
    const double dt = 1.0 / 240.0;
    auto feed = [&](double rpm) {
        const double x = (rpm - 5500.0) / 2500.0;
        const double power_w = 220000.0 * std::max(0.05, 1.0 - x * x);   // wheel power curve, peak at 5500 rpm
        VehicleOutput out;
        out.gear = 3;
        out.throttle_applied = 1.0;
        out.speed = rpm * 0.004;
        for (int w = 0; w < 4; ++w) out.wheels[w].fx = power_w / out.speed / std::max(driven, 1);
        meter.sample(out, rpm, dt, 1.0);
    };
    for (int i = 0; i < 4 * 240; ++i) feed(2800.0);                         // settle past the gear-change hold-off
    for (double rpm = 2800.0; rpm < 8000.0; rpm += 1500.0 * dt) feed(rpm);   // the pull
    std::printf("         synthetic pull: peak power read at %.0f rpm (true 5500), peak %.0f kW (true 220)\n",
                meter.peak_power_rpm(), meter.peak_wheel_power_w() / 1000.0);
    test::check_range("peak power is read at the rpm it was made", meter.peak_power_rpm(), 5300.0, 5700.0, "rpm");
    test::check_range("peak power is only rounded off by the 0.5 s smoothing (not lost)", meter.peak_wheel_power_w() / 220000.0, 0.88, 1.01, "x");
}

// ---------------------------------------------------------------- SimHub gear byte: neutral must not read as reverse
RS_TEST(ur_telemetry_gear_byte) {
    auto byte_for = [](int gear) {
        TelemetrySample s;
        s.gear = gear;   // rs_core: 0 = R, 1 = N, 2 = 1st, ...
        return pack_simhub_udp(s)[307];
    };
    test::check("reverse -> 0", byte_for(0) == 0);
    test::check("neutral -> 1 like Forza (not 0, which dashes show as R)", byte_for(1) == 1);
    test::check("1st -> 1, 2nd -> 2, 3rd -> 3", byte_for(2) == 1 && byte_for(3) == 2 && byte_for(4) == 3);
    test::check("gears above 10 stay on the byte's 10", byte_for(14) == 10);
}
