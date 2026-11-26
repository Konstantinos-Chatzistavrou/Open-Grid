#include "rs/config.hpp"
#include "rs/math.hpp"
#include <fstream>
#include <sstream>
#include <stdexcept>
#include "nlohmann/json.hpp"

namespace rs {

// Tyre compound classes (thermal window, reset temperature, tread wear per MJ of friction work). Sources and the
// reasoning behind every number: docs/physics.md, "Tyre compounds".
//   road        summer UHP street tyre: full grip from ~10 C (makers: summer compounds harden below ~7 C) to ~90 C
//   semi_slick  road-legal track tyre (Cup 2 / Trofeo R class): needs some heat, ~50-100 C
//   slick       racing slick: a ~30 C wide window (Pirelli: "a working range of about 30 degrees"), 75-105 C
// Wear rates: calibrated so road tyres last ~1000 km of hard track driving, semi-slicks ~450 km, and GT3 slicks
// wear ~60-85% over a ~155 km (40-lap Brands Hatch GP / 1-hour GT3) stint with a late-stint wear cliff past 70%
// as the soft outer rubber wears down toward the hard base ply.
void apply_compound(TireParams& t, const std::string& c, const std::string& ctx) {
    if (c == "road") {
        t.temp_optimal_c = 50; t.temp_window_c = 40; t.start_c = 45;
        t.wear_per_mj = 1.0 / 150.0; t.wear_grip_loss = 0.15; t.wear_cliff_loss = 0.02;
        t.hysteresis_loss_factor = 0.65; t.tread_cooling_scale = 1.00;
        t.tread_depth_new_mm = 7.5; t.tread_void_ratio = 0.28; t.wet_chemical_grip = 1.00; t.dry_overheat_wear_mult = 1.0;
    } else if (c == "semi_slick") {
        t.temp_optimal_c = 75; t.temp_window_c = 25; t.start_c = 70;
        t.wear_per_mj = 1.0 / 80.0; t.wear_grip_loss = 0.17; t.wear_cliff_loss = 0.08;
        t.hysteresis_loss_factor = 0.70; t.tread_cooling_scale = 1.00;
        t.tread_depth_new_mm = 4.5; t.tread_void_ratio = 0.16; t.wet_chemical_grip = 0.86; t.dry_overheat_wear_mult = 1.0;
    } else if (c == "slick") {
        t.temp_optimal_c = 90; t.temp_window_c = 15; t.start_c = 85;
        t.wear_per_mj = 1.0 / 22.0; t.wear_grip_loss = 0.18; t.wear_cliff_loss = 0.14;
        t.hysteresis_loss_factor = 1.65; t.tread_cooling_scale = 0.94;
        t.tread_depth_new_mm = 0.5; t.tread_void_ratio = 0.02; t.wet_chemical_grip = 0.72; t.dry_overheat_wear_mult = 1.0;
    } else if (c == "intermediate") {
        t.temp_optimal_c = 55; t.temp_window_c = 20; t.start_c = 45;
        t.wear_per_mj = 1.0 / 48.0; t.wear_grip_loss = 0.16; t.wear_cliff_loss = 0.08;
        t.hysteresis_loss_factor = 1.05; t.tread_cooling_scale = 1.08;
        t.tread_depth_new_mm = 6.2; t.tread_void_ratio = 0.34; t.wet_chemical_grip = 1.12; t.dry_overheat_wear_mult = 2.0;
    } else if (c == "wet") {
        t.temp_optimal_c = 42; t.temp_window_c = 16; t.start_c = 36;
        t.wear_per_mj = 1.0 / 32.0; t.wear_grip_loss = 0.18; t.wear_cliff_loss = 0.12;
        t.hysteresis_loss_factor = 1.30; t.tread_cooling_scale = 1.15;
        t.tread_depth_new_mm = 8.8; t.tread_void_ratio = 0.45; t.wet_chemical_grip = 1.24; t.dry_overheat_wear_mult = 3.2;
    } else throw std::runtime_error("car config: '" + ctx + ".compound' must be road, semi_slick, slick, intermediate or wet (got '" + c + "')");
}

using nlohmann::json;

namespace {

double num(const json& j, const char* key, const std::string& ctx) {
    if (!j.contains(key)) throw std::runtime_error("car config: missing '" + ctx + "." + key + "'");
    if (!j.at(key).is_number()) throw std::runtime_error("car config: '" + ctx + "." + key + "' must be a number");
    return j.at(key).get<double>();
}
double num_or(const json& j, const char* key, double fallback) {
    return j.contains(key) ? j.at(key).get<double>() : fallback;
}

Vec3 vec3_req(const json& j, const char* key, const std::string& ctx) {
    if (!j.contains(key)) throw std::runtime_error("car config: missing '" + ctx + "." + key + "'");
    const json& v = j.at(key);
    if (!v.is_array() || v.size() != 3 || !v[0].is_number() || !v[1].is_number() || !v[2].is_number())
        throw std::runtime_error("car config: '" + ctx + "." + key + "' must be [x, y, z]");
    return {v[0].get<double>(), v[1].get<double>(), v[2].get<double>()};
}

SuspensionHardpoints parse_kinematics(const json& j, const std::string& ctx) {
    SuspensionHardpoints hp;
    const std::string t = j.value("type", "double_wishbone");
    if (t == "double_wishbone") hp.type = SuspensionType::DoubleWishbone;
    else if (t == "macpherson") hp.type = SuspensionType::MacPherson;
    else if (t == "multi_link") hp.type = SuspensionType::MultiLink;
    else if (t == "solid_axle") hp.type = SuspensionType::SolidAxle;
    else throw std::runtime_error("car config: '" + ctx + ".type' must be double_wishbone|macpherson|multi_link|solid_axle, got '" + t + "'");
    if (hp.type == SuspensionType::SolidAxle) {
        hp.panhard_height_m = num_or(j, "panhard_height_m", hp.panhard_height_m);
        hp.panhard_length_m = num_or(j, "panhard_length_m", hp.panhard_length_m);
        if (j.contains("lca_front")) hp.lca_front = vec3_req(j, "lca_front", ctx);
        if (j.contains("lca_rear")) hp.lca_rear = vec3_req(j, "lca_rear", ctx);
        if (j.contains("lca_outer")) hp.lca_outer = vec3_req(j, "lca_outer", ctx);
        if (j.contains("tie_inner")) hp.tie_inner = vec3_req(j, "tie_inner", ctx);
        if (j.contains("tie_outer")) hp.tie_outer = vec3_req(j, "tie_outer", ctx);
        hp.explicit_in_config = true;
        return hp;
    }
    hp.lca_front = vec3_req(j, "lca_front", ctx);
    hp.lca_rear = vec3_req(j, "lca_rear", ctx);
    hp.lca_outer = vec3_req(j, "lca_outer", ctx);
    hp.tie_inner = vec3_req(j, "tie_inner", ctx);
    hp.tie_outer = vec3_req(j, "tie_outer", ctx);
    if (hp.type == SuspensionType::DoubleWishbone || hp.type == SuspensionType::MultiLink) {
        hp.uca_front = vec3_req(j, "uca_front", ctx);
        hp.uca_rear = vec3_req(j, "uca_rear", ctx);
        hp.uca_outer = vec3_req(j, "uca_outer", ctx);
        if (j.contains("shock_upper") && j.contains("shock_lower")) {
            hp.has_shock_mounts = true;
            hp.shock_upper = vec3_req(j, "shock_upper", ctx);
            hp.shock_lower = vec3_req(j, "shock_lower", ctx);
        }
    } else {
        hp.strut_top = vec3_req(j, "strut_top", ctx);
    }
    hp.explicit_in_config = true;
    return hp;
}

AxleParams parse_axle(const json& j, const std::string& ctx) {
    AxleParams a;
    a.track = num(j, "track_m", ctx);
    a.spring_rate = num(j, "spring_rate_n_per_m", ctx);
    a.spring_rest_length = num(j, "spring_rest_length_m", ctx);
    a.max_compression = num(j, "max_compression_m", ctx);
    a.bump_stop_rate = num_or(j, "bump_stop_rate_n_per_m", 300000);
    a.spring_progressive_rate = num_or(j, "spring_progressive_rate_n_per_m2", 0.0);
    a.bump_stop_gap_m = num_or(j, "bump_stop_gap_m", 0.0);
    a.bump_stop_exponent = num_or(j, "bump_stop_exponent", 1.0);
    a.damper_bump = num(j, "damper_bump_ns_per_m", ctx);
    a.damper_rebound = num(j, "damper_rebound_ns_per_m", ctx);
    a.anti_roll_rate = num(j, "anti_roll_rate_n_per_m", ctx);
    a.roll_centre_height = num(j, "roll_centre_height_m", ctx);
    a.max_steer_deg = num_or(j, "max_steer_deg", 0);
    a.steer_compliance = num_or(j, "steer_compliance_deg_per_kn", 0) * kPi / 180.0 / 1000.0;
    a.ackermann = num_or(j, "ackermann", 0);
    a.static_camber_deg = num_or(j, "static_camber_deg", a.max_steer_deg > 0 ? -1.5 : -1.6);
    a.camber_gain_rad_per_m = num_or(j, "camber_gain_deg_per_m", -45.0) * kPi / 180.0;
    a.caster_deg = num_or(j, "caster_deg", a.max_steer_deg > 0 ? 6.8 : 0.0);
    a.kpi_deg = num_or(j, "kpi_deg", a.max_steer_deg > 0 ? 7.0 : 0.0);
    a.handbrake_torque = num_or(j, "handbrake_torque_nm", 0);
    a.camber_gain2_rad_per_m2 = num_or(j, "camber_gain2_deg_per_m2", a.camber_gain2_rad_per_m2 * 180.0 / kPi) * kPi / 180.0;
    a.static_toe_deg = num_or(j, "static_toe_deg", a.static_toe_deg);
    a.bump_steer_deg_per_m = num_or(j, "bump_steer_deg_per_m", a.bump_steer_deg_per_m);
    a.roll_centre_gain = num_or(j, "roll_centre_gain", a.roll_centre_gain);
    a.anti_pitch = num_or(j, "anti_pitch", a.anti_pitch);
    a.anti_lift_rear_braking = num_or(j, "anti_lift_braking", a.anti_lift_rear_braking);
    a.damper_knee_mps = num_or(j, "damper_knee_mps", a.damper_knee_mps);
    a.damper_high_speed_ratio = num_or(j, "damper_high_speed_ratio", a.damper_high_speed_ratio);
    a.toe_compliance_rad_per_kn_fx = num_or(j, "toe_compliance_deg_per_kn_fx", 0.0) * kPi / 180.0;
    a.toe_compliance_rad_per_kn_fy = num_or(j, "toe_compliance_deg_per_kn_fy", 0.0) * kPi / 180.0;
    a.camber_compliance_rad_per_kn_fy = num_or(j, "camber_compliance_deg_per_kn_fy", 0.0) * kPi / 180.0;
    a.longitudinal_compliance_m_per_kn_fx = num_or(j, "longitudinal_compliance_mm_per_kn_fx", 0.0) * 1e-3;
    if (j.contains("kinematics")) a.kinematics = parse_kinematics(j.at("kinematics"), ctx + ".kinematics");
    return a;
}

TireParams parse_tire(const json& j, const std::string& ctx) {
    TireParams t;
    if (j.contains("compound")) apply_compound(t, j.at("compound").get<std::string>(), ctx);
    t.radius = num(j, "radius_m", ctx);
    t.inertia = num(j, "inertia_kgm2", ctx);
    t.fz0 = num(j, "fz0_n", ctx);
    t.vertical_stiffness = num_or(j, "vertical_stiffness_n_per_m", 220000);
    t.lmuv = num_or(j, "friction_speed_decay", t.lmuv);
    t.p_nominal_kpa = num_or(j, "pressure_nominal_kpa", t.p_nominal_kpa);
    t.p_cold_kpa = num_or(j, "pressure_cold_kpa", t.p_cold_kpa);
    t.temp_optimal_c = num_or(j, "temp_optimal_c", t.temp_optimal_c);
    t.temp_window_c = num_or(j, "temp_window_c", t.temp_window_c);
    t.start_c = num_or(j, "start_temp_c", t.start_c);
    t.wear_per_mj = num_or(j, "wear_per_mj", t.wear_per_mj);
    t.wear_grip_loss = num_or(j, "wear_grip_loss", t.wear_grip_loss);
    t.wear_cliff_loss = num_or(j, "wear_cliff_loss", t.wear_cliff_loss);
    t.hysteresis_loss_factor = num_or(j, "hysteresis_loss_factor", t.hysteresis_loss_factor);
    t.tread_cooling_scale = num_or(j, "tread_cooling_scale", t.tread_cooling_scale);
    t.tread_depth_new_mm = num_or(j, "tread_depth_new_mm", t.tread_depth_new_mm);
    t.tread_void_ratio = num_or(j, "tread_void_ratio", t.tread_void_ratio);
    t.wet_chemical_grip = num_or(j, "wet_chemical_grip", t.wet_chemical_grip);
    t.dry_overheat_wear_mult = num_or(j, "dry_overheat_wear_mult", t.dry_overheat_wear_mult);
    const json& lo = j.at("longitudinal");
    t.cx = num(lo, "C", ctx + ".longitudinal");
    t.mu_x = num(lo, "mu", ctx + ".longitudinal");
    t.pdx2 = num(lo, "load_sensitivity", ctx + ".longitudinal");
    t.pdx3 = num_or(lo, "camber_sensitivity", t.pdx3);
    t.ex = num(lo, "E", ctx + ".longitudinal");
    t.pex2 = num_or(lo, "pEx2", t.pex2);
    t.pex3 = num_or(lo, "pEx3", t.pex3);
    t.pex4 = num_or(lo, "pEx4", t.pex4);
    t.kx = num(lo, "slip_stiffness_per_load", ctx + ".longitudinal");
    t.pkx2 = num_or(lo, "pKx2", t.pkx2);
    t.pkx3 = num_or(lo, "pKx3", t.pkx3);
    t.phx1 = num_or(lo, "pHx1", t.phx1);
    t.phx2 = num_or(lo, "pHx2", t.phx2);
    t.pvx1 = num_or(lo, "pVx1", t.pvx1);
    t.pvx2 = num_or(lo, "pVx2", t.pvx2);
    const json& la = j.at("lateral");
    t.cy = num(la, "C", ctx + ".lateral");
    t.mu_y = num(la, "mu", ctx + ".lateral");
    t.pdy2 = num(la, "load_sensitivity", ctx + ".lateral");
    t.pdy3 = num_or(la, "camber_sensitivity", t.pdy3);
    t.ey = num(la, "E", ctx + ".lateral");
    t.pey2 = num_or(la, "pEy2", t.pey2);
    t.pey3 = num_or(la, "pEy3", t.pey3);
    t.pey4 = num_or(la, "pEy4", t.pey4);
    t.pky1 = num(la, "cornering_stiffness_per_fz0", ctx + ".lateral");
    t.pky2 = num(la, "cornering_stiffness_peak_load", ctx + ".lateral");
    t.pky3 = num_or(la, "camber_stiffness_factor", t.pky3);
    t.phy1 = num_or(la, "pHy1", t.phy1);
    t.phy2 = num_or(la, "pHy2", t.phy2);
    t.phy3 = num_or(la, "pHy3", t.phy3);
    t.pvy1 = num_or(la, "pVy1", t.pvy1);
    t.pvy2 = num_or(la, "pVy2", t.pvy2);
    t.pvy3 = num_or(la, "pVy3", t.pvy3);
    t.pvy4 = num_or(la, "pVy4", t.pvy4);
    const json& c = j.at("combined");
    t.rbx1 = num(c, "rBx1", ctx); t.rbx2 = num(c, "rBx2", ctx); t.rcx1 = num(c, "rCx1", ctx);
    t.rbx3 = num_or(c, "rBx3", t.rbx3); t.rex1 = num_or(c, "rEx1", t.rex1); t.rex2 = num_or(c, "rEx2", t.rex2); t.rhx1 = num_or(c, "rHx1", t.rhx1);
    t.rby1 = num(c, "rBy1", ctx); t.rby2 = num(c, "rBy2", ctx); t.rcy1 = num(c, "rCy1", ctx);
    t.rby3 = num_or(c, "rBy3", t.rby3); t.rby4 = num_or(c, "rBy4", t.rby4); t.rey1 = num_or(c, "rEy1", t.rey1); t.rey2 = num_or(c, "rEy2", t.rey2);
    t.rhy1 = num_or(c, "rHy1", t.rhy1); t.rhy2 = num_or(c, "rHy2", t.rhy2);
    t.rvy1 = num_or(c, "rVy1", t.rvy1); t.rvy2 = num_or(c, "rVy2", t.rvy2); t.rvy3 = num_or(c, "rVy3", t.rvy3);
    t.rvy4 = num_or(c, "rVy4", t.rvy4); t.rvy5 = num_or(c, "rVy5", t.rvy5); t.rvy6 = num_or(c, "rVy6", t.rvy6);
    if (j.contains("aligning")) {
        const json& al = j.at("aligning");
        t.qbz1 = num_or(al, "qBz1", t.qbz1); t.qbz2 = num_or(al, "qBz2", t.qbz2); t.qbz3 = num_or(al, "qBz3", t.qbz3);
        t.qbz4 = num_or(al, "qBz4", t.qbz4); t.qbz5 = num_or(al, "qBz5", t.qbz5);
        t.qcz1 = num_or(al, "qCz1", t.qcz1);
        t.qdz1 = num_or(al, "qDz1", t.qdz1); t.qdz2 = num_or(al, "qDz2", t.qdz2); t.qdz3 = num_or(al, "qDz3", t.qdz3); t.qdz4 = num_or(al, "qDz4", t.qdz4);
        t.qez1 = num_or(al, "qEz1", t.qez1); t.qez2 = num_or(al, "qEz2", t.qez2); t.qez3 = num_or(al, "qEz3", t.qez3);
        t.qez4 = num_or(al, "qEz4", t.qez4); t.qez5 = num_or(al, "qEz5", t.qez5);
        t.qhz1 = num_or(al, "qHz1", t.qhz1); t.qhz2 = num_or(al, "qHz2", t.qhz2); t.qhz3 = num_or(al, "qHz3", t.qhz3); t.qhz4 = num_or(al, "qHz4", t.qhz4);
        t.qbz9 = num_or(al, "qBz9", t.qbz9); t.qbz10 = num_or(al, "qBz10", t.qbz10);
        t.qdz6 = num_or(al, "qDz6", t.qdz6); t.qdz7 = num_or(al, "qDz7", t.qdz7); t.qdz8 = num_or(al, "qDz8", t.qdz8); t.qdz9 = num_or(al, "qDz9", t.qdz9);
        t.ssz1 = num_or(al, "sSz1", t.ssz1); t.ssz2 = num_or(al, "sSz2", t.ssz2); t.ssz3 = num_or(al, "sSz3", t.ssz3); t.ssz4 = num_or(al, "sSz4", t.ssz4);
    }
    if (j.contains("turn_slip")) {   // MF 6.1 turn slip (tools/tir2car.mjs copies it from files that have it)
        const json& ts = j.at("turn_slip");
        t.pdyp1 = num_or(ts, "pDyp1", t.pdyp1); t.pdyp2 = num_or(ts, "pDyp2", t.pdyp2);
        t.pdyp3 = num_or(ts, "pDyp3", t.pdyp3); t.pdyp4 = num_or(ts, "pDyp4", t.pdyp4); t.pkyp1 = num_or(ts, "pKyp1", t.pkyp1);
    }
    t.relax_x = num(j, "relaxation_length_long_m", ctx);
    t.relax_y = num(j, "relaxation_length_lat_m", ctx);
    t.rolling_resistance = num(j, "rolling_resistance", ctx);
    t.rolling_resistance_v2 = num_or(j, "rolling_resistance_v2", 0.001);
    t.vertical_damping = num_or(j, "vertical_damping_ns_per_m", t.vertical_damping);
    t.breff = num_or(j, "breff", t.breff);
    t.dreff = num_or(j, "dreff", t.dreff);
    t.freff = num_or(j, "freff", t.freff);
    t.pfz1 = num_or(j, "pfz1", t.pfz1);
    t.ptx1 = num_or(lo, "pTx1", t.ptx1);
    t.ptx2 = num_or(lo, "pTx2", t.ptx2);
    t.ptx3 = num_or(lo, "pTx3", t.ptx3);
    t.pty1 = num_or(la, "pTy1", t.pty1);
    t.pty2 = num_or(la, "pTy2", t.pty2);
    t.ppx1 = num_or(lo, "pPx1", t.ppx1);
    t.ppx2 = num_or(lo, "pPx2", t.ppx2);
    t.ppx3 = num_or(lo, "pPx3", t.ppx3);
    t.ppx4 = num_or(lo, "pPx4", t.ppx4);
    t.ppy1 = num_or(la, "pPy1", t.ppy1);
    t.ppy2 = num_or(la, "pPy2", t.ppy2);
    t.ppy3 = num_or(la, "pPy3", t.ppy3);
    t.ppy4 = num_or(la, "pPy4", t.ppy4);
    t.ppy5 = num_or(la, "pPy5", t.ppy5);
    t.pey5 = num_or(la, "pEy5", t.pey5);
    if (j.contains("aligning")) {
        const json& al = j.at("aligning");
        t.qtz1 = num_or(al, "qTz1", t.qtz1);
        t.ppz1 = num_or(al, "pPz1", t.ppz1);
        t.ppz2 = num_or(al, "pPz2", t.ppz2);
    }
    if (j.contains("overturning")) {
        const json& ov = j.at("overturning");
        t.qsx1 = num_or(ov, "qSx1", t.qsx1);
        t.qsx2 = num_or(ov, "qSx2", t.qsx2);
        t.qsx3 = num_or(ov, "qSx3", t.qsx3);
        t.qsx13 = num_or(ov, "qSx13", t.qsx13);
        t.ppmx1 = num_or(ov, "pPmx1", t.ppmx1);
    }
    t.qfcx = num_or(j, "qFcx", t.qfcx);
    t.qfcy = num_or(j, "qFcy", t.qfcy);
    t.mbelt = num_or(j, "mbelt_kg", t.mbelt);
    t.section_width_m = num_or(j, "section_width_m", t.section_width_m);
    t.aspect_ratio = num_or(j, "aspect_ratio", t.aspect_ratio);
    return t;
}

DiffParams parse_diff(const json& j) {
    DiffParams d;
    d.type = j.value("type", "open");
    d.preload = num_or(j, "preload_nm", 0);
    d.power_ramp = num_or(j, "power_ramp", 0);
    d.coast_ramp = num_or(j, "coast_ramp", 0);
    if (d.type != "open" && d.type != "locked" && d.type != "lsd")
        throw std::runtime_error("car config: diff type must be open|locked|lsd, got '" + d.type + "'");
    return d;
}

}  // namespace

CarConfig parse_car_config(const std::string& text) {
    json j = json::parse(text);
    if (j.value("schema", "") != "car/1")
        throw std::runtime_error("car config: expected \"schema\": \"car/1\"");
    CarConfig c;
    c.name = j.value("name", "unnamed");
    const json& ch = j.at("chassis");
    c.mass = num(ch, "mass_kg", "chassis");
    c.cg_height = num(ch, "cg_height_m", "chassis");
    c.weight_front = num(ch, "weight_front", "chassis");
    c.wheelbase = num(ch, "wheelbase_m", "chassis");
    c.inertia_xx = num(ch, "inertia_roll_kgm2", "chassis");
    c.inertia_yy = num(ch, "inertia_pitch_kgm2", "chassis");
    c.inertia_zz = num(ch, "inertia_yaw_kgm2", "chassis");
    c.torsional_stiffness_nm_per_deg = num_or(ch, "torsional_stiffness_nm_per_deg", 0.0);
    c.front = parse_axle(j.at("front_axle"), "front_axle");
    c.rear = parse_axle(j.at("rear_axle"), "rear_axle");
    c.tire_front = parse_tire(j.at("tire_front"), "tire_front");
    c.tire_rear = j.contains("tire_rear") ? parse_tire(j.at("tire_rear"), "tire_rear") : c.tire_front;
    c.brake_bias_front = num(j.at("brakes"), "bias_front", "brakes");
    c.brake_torque_total = num(j.at("brakes"), "max_total_torque_nm", "brakes");
    {
        const json& b = j.at("brakes");
        BrakeThermal& bt = c.brake_thermal;
        bt.disc_mass_front = num_or(b, "disc_mass_front_kg", bt.disc_mass_front);
        bt.disc_mass_rear = num_or(b, "disc_mass_rear_kg", bt.disc_mass_rear);
        bt.cooling_per_mps = num_or(b, "cooling_w_per_k_per_mps", bt.cooling_per_mps);
    }

    const json& e = j.at("engine");
    for (const auto& pt : e.at("torque_curve")) c.engine.torque_curve.push_back({pt.at(0).get<double>(), pt.at(1).get<double>()});
    if (c.engine.torque_curve.size() < 2) throw std::runtime_error("car config: torque_curve needs >= 2 points");
    c.engine.idle_rpm = num(e, "idle_rpm", "engine");
    c.engine.redline_rpm = num(e, "redline_rpm", "engine");
    c.engine.limiter_hysteresis_rpm = num_or(e, "rev_limiter_hysteresis_rpm", c.engine.limiter_hysteresis_rpm);
    c.engine.inertia = num(e, "inertia_kgm2", "engine");
    c.engine.friction_const = num(e, "friction_const_nm", "engine");
    c.engine.friction_linear = num(e, "friction_linear_nm_per_radps", "engine");
    if (e.contains("voice") && e.at("voice").is_string()) c.engine.voice = e.at("voice").get<std::string>();
    if (e.contains("cylinders") && e.at("cylinders").is_number_integer()) {
        c.engine.cylinders = std::max(1, e.at("cylinders").get<int>());
    } else {
        const std::string meta = c.name + " " + j.value("notes", "");
        if (meta.find("V12") != std::string::npos || meta.find("Strix") != std::string::npos ||
            meta.find("Basilisk") != std::string::npos || meta.find("Taurus") != std::string::npos ||
            meta.find("Corsa") != std::string::npos) {
            c.engine.cylinders = 12;
        } else if (meta.find("V10") != std::string::npos || meta.find("Fulmine") != std::string::npos) {
            c.engine.cylinders = 10;
        } else if (meta.find("Flat-6") != std::string::npos || meta.find("9R") != std::string::npos ||
                   meta.find("I6") != std::string::npos || meta.find("Ryujin") != std::string::npos ||
                   meta.find("Hayate") != std::string::npos) {
            c.engine.cylinders = 6;
        } else {
            c.engine.cylinders = 8;
        }
    }

    const json& d = j.at("drivetrain");
    if (d.contains("gear_ratios")) {
        c.drivetrain.gear_ratios = d.at("gear_ratios").get<std::vector<double>>();
    }
    // Optional physical gear tooth pairs: [[driven, drive], ...] for [R, N, 1st, 2nd, ...].
    // When provided, tooth ratios (driven / drive, negative for reverse idler at index 0) become the
    // authoritative gear_ratios; when absent, explicit gear_ratios remain the source of truth.
    if (d.contains("gear_teeth")) {
        const json& gt = d.at("gear_teeth");
        if (!gt.is_array() || gt.size() < 3)
            throw std::runtime_error("car config: gear_teeth must have >= 3 [driven, drive] pairs");
        c.drivetrain.gear_teeth.clear();
        c.drivetrain.gear_ratios.clear();
        for (size_t i = 0; i < gt.size(); ++i) {
            int driven = gt[i].at(0).get<int>();
            int drive = gt[i].at(1).get<int>();
            c.drivetrain.gear_teeth.push_back({driven, drive});
            if (i == 1 || drive == 0 || driven == 0) {
                c.drivetrain.gear_ratios.push_back(0.0);
            } else {
                double ratio = std::abs(static_cast<double>(driven)) / std::abs(static_cast<double>(drive));
                c.drivetrain.gear_ratios.push_back(i == 0 ? -ratio : ratio);
            }
        }
    }
    if (c.drivetrain.gear_ratios.size() < 3 || c.drivetrain.gear_ratios[1] != 0.0)
        throw std::runtime_error("car config: gear_ratios = [reverse, 0 (neutral), 1st, ...]");
    if (d.contains("final_drive_teeth")) {
        const json& ft = d.at("final_drive_teeth");
        int ring = ft.at(0).get<int>(), pinion = ft.at(1).get<int>();
        if (ring <= 0 || pinion <= 0)
            throw std::runtime_error("car config: final_drive_teeth must be positive [ring, pinion]");
        c.drivetrain.final_drive_teeth = {ring, pinion};
    }
    if (d.contains("final_drive")) {
        // Keep explicit final_drive authoritative when present so garage gearing tunes (setup.cpp) take effect.
        c.drivetrain.final_drive = num(d, "final_drive", "drivetrain");
    } else if (c.drivetrain.final_drive_teeth[1] > 0) {
        c.drivetrain.final_drive = static_cast<double>(c.drivetrain.final_drive_teeth[0])
                                 / static_cast<double>(c.drivetrain.final_drive_teeth[1]);
    } else {
        throw std::runtime_error("car config: missing 'drivetrain.final_drive'");
    }
    c.drivetrain.efficiency = num(d, "efficiency", "drivetrain");
    c.drivetrain.clutch_max_torque = num(d, "clutch_max_torque_nm", "drivetrain");
    c.drivetrain.driveline_inertia = num(d, "driveline_inertia_kgm2", "drivetrain");
    c.drivetrain.layout = d.at("layout").get<std::string>();
    c.drivetrain.transmission = d.value("transmission", std::string(""));
    c.drivetrain.awd_front_split = num_or(d, "awd_front_split", 0.4);
    if (d.contains("clutch")) {
        const json& cl = d.at("clutch");
        ClutchParams& cp = c.drivetrain.clutch;
        cp.bite_point = num_or(cl, "bite_point", cp.bite_point);
        cp.full_engage_point = num_or(cl, "full_engage_point", cp.full_engage_point);
        cp.effective_radius_m = num_or(cl, "effective_radius_m", cp.effective_radius_m);
        cp.num_surfaces = cl.value("num_surfaces", cp.num_surfaces);
        cp.mu_static = num_or(cl, "mu_static", cp.mu_static);
        cp.mu_kinetic = num_or(cl, "mu_kinetic", cp.mu_kinetic);
        cp.max_clamp_force_n = num_or(cl, "max_clamp_force_n", cp.max_clamp_force_n);
        cp.thermal_capacity_j_per_k = num_or(cl, "thermal_capacity_j_per_k", cp.thermal_capacity_j_per_k);
        cp.cooling_base_w_per_k = num_or(cl, "cooling_base_w_per_k", cp.cooling_base_w_per_k);
        cp.cooling_per_mps_w_per_k = num_or(cl, "cooling_per_mps_w_per_k", cp.cooling_per_mps_w_per_k);
        cp.cooling_per_rads_w_per_k = num_or(cl, "cooling_per_rads_w_per_k", cp.cooling_per_rads_w_per_k);
        cp.wear_per_joule = num_or(cl, "wear_per_joule", cp.wear_per_joule);
        cp.input_shaft_inertia_kgm2 = num_or(cl, "input_shaft_inertia_kgm2", cp.input_shaft_inertia_kgm2);
    }
    if (d.contains("synchro")) {
        const json& sy = d.at("synchro");
        SynchroParams& sp = c.drivetrain.synchro;
        sp.mu_sync = num_or(sy, "mu_sync", sp.mu_sync);
        sp.shift_fork_force_n = num_or(sy, "shift_fork_force_n", sp.shift_fork_force_n);
        sp.cone_radius_m = num_or(sy, "cone_radius_m", sp.cone_radius_m);
        sp.cone_angle_deg = num_or(sy, "cone_angle_deg", sp.cone_angle_deg);
        sp.num_cones = sy.value("num_cones", sp.num_cones);
        sp.engage_tol_rads = num_or(sy, "engage_tol_rads", sp.engage_tol_rads);
        sp.dog_engage_tol_rads = num_or(sy, "dog_engage_tol_rads", sp.dog_engage_tol_rads);
    }
    if (d.contains("torque_converter")) {
        const json& tc = d.at("torque_converter");
        TorqueConverterParams& tp = c.drivetrain.torque_converter;
        tp.stall_torque_ratio = num_or(tc, "stall_torque_ratio", tp.stall_torque_ratio);
        tp.coupling_speed_ratio = num_or(tc, "coupling_speed_ratio", tp.coupling_speed_ratio);
        tp.stall_k_factor = num_or(tc, "stall_k_factor", tp.stall_k_factor);
        tp.lockup_speed_ratio = num_or(tc, "lockup_speed_ratio", tp.lockup_speed_ratio);
        tp.lockup_min_speed_mps = num_or(tc, "lockup_min_speed_mps", tp.lockup_min_speed_mps);
        tp.lockup_min_gear = tc.value("lockup_min_gear", tp.lockup_min_gear);
    }
    if (d.contains("dog_box")) {
        const json& db = d.at("dog_box");
        DogBoxParams& dp = c.drivetrain.dog_box;
        dp.upshift_cut_s = num_or(db, "upshift_cut_s", dp.upshift_cut_s);
        dp.downshift_unload_s = num_or(db, "downshift_unload_s", dp.downshift_unload_s);
        dp.downshift_blip_max_s = num_or(db, "downshift_blip_max_s", dp.downshift_blip_max_s);
        dp.blip_throttle_gain = num_or(db, "blip_throttle_gain", dp.blip_throttle_gain);
        dp.engage_clunk_nm = num_or(db, "engage_clunk_nm", dp.engage_clunk_nm);
        dp.auto_blip = db.value("auto_blip", dp.auto_blip);
    }
    if (d.contains("amt")) {
        const json& am = d.at("amt");
        AmtParams& ap = c.drivetrain.amt;
        ap.upshift_cut_s = num_or(am, "upshift_cut_s", ap.upshift_cut_s);
        ap.upshift_reengage_s = num_or(am, "upshift_reengage_s", ap.upshift_reengage_s);
        ap.downshift_blip_max_s = num_or(am, "downshift_blip_max_s", ap.downshift_blip_max_s);
        ap.downshift_reengage_s = num_or(am, "downshift_reengage_s", ap.downshift_reengage_s);
        ap.blip_throttle_gain = num_or(am, "blip_throttle_gain", ap.blip_throttle_gain);
        ap.fork_force_n = num_or(am, "fork_force_n", ap.fork_force_n);
        ap.engage_clunk_nm = num_or(am, "engage_clunk_nm", ap.engage_clunk_nm);
    }
    if (j.contains("steering")) {
        const json& st = j.at("steering");
        SteeringParams& sp = c.steering;
        const std::string mode = st.value("power_steering", std::string("hydraulic"));
        if (mode == "none" || mode == "manual") sp.assist_mode = PowerSteeringMode::Manual;
        else if (mode == "eps" || mode == "electric") sp.assist_mode = PowerSteeringMode::ElectricEps;
        else sp.assist_mode = PowerSteeringMode::Hydraulic;
        sp.steer_ratio = num_or(st, "steer_ratio", sp.steer_ratio);
        sp.assist_gain_low_speed = num_or(st, "assist_gain_low_speed", sp.assist_gain_low_speed);
        sp.assist_gain_high_speed = num_or(st, "assist_gain_high_speed", sp.assist_gain_high_speed);
        sp.assist_speed_ref_mps = num_or(st, "assist_speed_ref_mps", sp.assist_speed_ref_mps);
        sp.max_assist_torque_nm = num_or(st, "max_assist_torque_nm", sp.max_assist_torque_nm);
        sp.rack_friction_nm = num_or(st, "rack_friction_nm", sp.rack_friction_nm);
        sp.column_damping_nms_per_rad = num_or(st, "column_damping_nms_per_rad", sp.column_damping_nms_per_rad);
        sp.column_inertia_kgm2 = num_or(st, "column_inertia_kgm2", sp.column_inertia_kgm2);
    }
    if (d.contains("front_diff")) c.drivetrain.front_diff = parse_diff(d.at("front_diff"));
    if (d.contains("rear_diff")) c.drivetrain.rear_diff = parse_diff(d.at("rear_diff"));
    if (d.contains("centre_diff")) c.drivetrain.centre_diff = parse_diff(d.at("centre_diff"));
    const std::string& lay = c.drivetrain.layout;
    if (lay != "rwd" && lay != "fwd" && lay != "awd") throw std::runtime_error("car config: layout must be rwd|fwd|awd");
    c.front.driven = (lay == "fwd" || lay == "awd");
    c.rear.driven = (lay == "rwd" || lay == "awd");

    const json& a = j.at("aero");
    c.aero.drag_area = num(a, "drag_area_m2", "aero");
    c.aero.lift_area = num(a, "downforce_area_m2", "aero");
    c.aero.front_balance = num(a, "front_balance", "aero");
    if (a.contains("drs")) c.aero.drs = a.at("drs").get<bool>();             // optional: only cars that have such a wing say so
    if (a.contains("airbrake")) c.aero.airbrake = a.at("airbrake").get<bool>();
    c.aero.air_density = num_or(a, "air_density", 1.225);
    c.aero.ground_effect_per_m = num_or(a, "ground_effect_per_m", c.aero.ground_effect_per_m);
    c.aero.pitch_balance_per_m = num_or(a, "pitch_balance_per_m", c.aero.pitch_balance_per_m);
    c.aero.static_ride_height_front_m = num_or(a, "static_ride_height_front_m", c.aero.static_ride_height_front_m);
    c.aero.static_ride_height_rear_m = num_or(a, "static_ride_height_rear_m", c.aero.static_ride_height_rear_m);
    c.aero.diffuser_stall_rake_m = num_or(a, "diffuser_stall_rake_m", c.aero.diffuser_stall_rake_m);
    if (a.contains("map_2d")) {
        const json& m2 = a.at("map_2d");
        c.aero.map_2d.front_rh_m = m2.at("front_rh_m").get<std::vector<double>>();
        c.aero.map_2d.rear_rh_m = m2.at("rear_rh_m").get<std::vector<double>>();
        c.aero.map_2d.cl_front = m2.at("cl_front").get<std::vector<double>>();
        c.aero.map_2d.cl_rear = m2.at("cl_rear").get<std::vector<double>>();
        c.aero.map_2d.cd = m2.at("cd").get<std::vector<double>>();
    }

    for (auto it = j.at("surface_grip").begin(); it != j.at("surface_grip").end(); ++it)
        c.surface_grip.push_back({it.key(), it.value().get<double>()});

    c.finalize();
    return c;
}

CarConfig load_car_config(const std::string& path) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("car config: cannot open " + path);
    std::stringstream ss;
    ss << f.rdbuf();
    try {
        return parse_car_config(ss.str());
    } catch (const nlohmann::json::exception& e) {
        throw std::runtime_error(std::string("car config ") + path + ": " + e.what());
    }
}

void AeroMap2D::sample(double h_f, double h_r, double& out_clf, double& out_clr, double& out_cd) const {
    if (!valid()) { out_clf = out_clr = out_cd = 0.0; return; }
    const std::size_t nr = rear_rh_m.size();
    auto locate = [](const std::vector<double>& grid, double x, std::size_t& i0, std::size_t& i1, double& t) {
        if (x <= grid.front()) { i0 = i1 = 0; t = 0.0; return; }
        if (x >= grid.back()) { i0 = i1 = grid.size() - 1; t = 0.0; return; }
        for (std::size_t i = 0; i + 1 < grid.size(); ++i) {
            if (x >= grid[i] && x <= grid[i + 1]) {
                i0 = i; i1 = i + 1;
                const double span = grid[i + 1] - grid[i];
                t = span > 1e-12 ? (x - grid[i]) / span : 0.0;
                return;
            }
        }
        i0 = i1 = grid.size() - 1; t = 0.0;
    };
    std::size_t f0 = 0, f1 = 0, r0 = 0, r1 = 0;
    double tf = 0.0, tr = 0.0;
    locate(front_rh_m, h_f, f0, f1, tf);
    locate(rear_rh_m, h_r, r0, r1, tr);
    auto bilerp = [&](const std::vector<double>& tab) {
        const double v00 = tab[f0 * nr + r0], v01 = tab[f0 * nr + r1];
        const double v10 = tab[f1 * nr + r0], v11 = tab[f1 * nr + r1];
        const double v0 = v00 + (v01 - v00) * tr;
        const double v1 = v10 + (v11 - v10) * tr;
        return v0 + (v1 - v0) * tf;
    };
    out_clf = bilerp(cl_front);
    out_clr = bilerp(cl_rear);
    out_cd = bilerp(cd);
}

void CarConfig::finalize() {
    // Static axle loads from the weight distribution: the CG sits b = weight_front * L ahead of
    // the rear axle (moment balance about the rear contact patch: W_f L = m g b).
    dist_cg_rear = weight_front * wheelbase;
    dist_cg_front = wheelbase - dist_cg_rear;
    const double corner_load[2] = {mass * kGravity * weight_front * 0.5, mass * kGravity * (1 - weight_front) * 0.5};
    for (int w = 0; w < 4; ++w) {
        const AxleParams& ax = axle(w);
        const TireParams& t = tire(w);
        int a = w < 2 ? 0 : 1;
        double static_compression = corner_load[a] / ax.spring_rate;   // Hooke: x = F / k
        if (static_compression >= ax.spring_rest_length)
            throw std::runtime_error("car config: springs too soft, static compression exceeds rest length");
        wheels[w].x = (w < 2) ? dist_cg_front : -dist_cg_rear;
        wheels[w].y = (w % 2 == 0 ? 0.5 : -0.5) * ax.track;          // FL/RL on +Y (left)
        // At rest the wheel centre is `radius` above the ground and the CG is cg_height above it.
        double wheel_centre_z = t.radius - cg_height;
        wheels[w].mount_z = wheel_centre_z + (ax.spring_rest_length - static_compression);
        wheels[w].static_compression = static_compression;
    }
    // Precompute 3D suspension kinematic lookup tables (2D for steered axles, 1D for non-steered).
    for (int a = 0; a < 2; ++a) {
        AxleParams& ax = (a == 0) ? front : rear;
        const TireParams& t = (a == 0) ? tire_front : tire_rear;
        if (ax.kinematics.explicit_in_config) {
            ax.kinematics.wheel_center = {0.0, 0.5 * ax.track, t.radius};
            ax.kinematics.tire_radius = t.radius;
            ax.kinematics.static_camber_rad = ax.static_camber_deg * kPi / 180.0;
            ax.kinematics.static_toe_rad = ax.static_toe_deg * kPi / 180.0;
        } else {
            ax.kinematics = synthesize_fitted_hardpoints(ax, t, wheelbase);
        }
        const double dz_min = -std::max(0.12, wheels[a * 2].static_compression + 0.02);
        const double dz_max = std::max(0.12, ax.max_compression + 0.04);
        axle_kinematics[a] = AxleKinematicsTable::build(ax.kinematics, ax.max_steer_deg, dz_min, dz_max);
    }
}

double CarConfig::grip_for_surface(int i) const {
    return (i >= 0 && i < (int)surface_grip.size()) ? surface_grip[i].second : 1.0;
}

int CarConfig::surface_index(const std::string& surface_name) const {
    for (size_t i = 0; i < surface_grip.size(); ++i)
        if (surface_grip[i].first == surface_name) return (int)i;
    return -1;
}

}  // namespace rs
