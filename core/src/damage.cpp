#include "rs/damage.hpp"
#include <algorithm>
#include <cmath>

namespace rs {

namespace {
// Energy per kg (J/kg) of one crash event that lies in a damage band, as a function of the event's speed change dv:
//   G(dv) = integral over u = 0..dv of  clamp((u - lo) / (hi - lo), 0, 1) * u du
// (d(E/m) = u du, weighted by how far past the band's lower edge the event already is).
double band_energy(double dv, double lo, double hi) {
    if (dv <= lo) return 0.0;
    auto part = [&](double u) { return (u * u * u / 3.0 - lo * u * u / 2.0) / (hi - lo); };
    if (dv <= hi) return part(dv) - part(lo);
    return part(hi) - part(lo) + 0.5 * (dv * dv - hi * hi);
}
// Which wheels sit in a zone: front FL FR, rear RL RR, left FL RL, right FR RR.
bool wheel_in_zone(int w, int zone) {
    switch (zone) {
        case ZoneFront: return w < 2;
        case ZoneRear: return w >= 2;
        case ZoneLeft: return w % 2 == 0;
        default: return w % 2 == 1;
    }
}

int perimeter_node_for_point(const Vec3& pt) {
    if (pt.x > 0.8) {
        return (pt.y > 0.45) ? NodeFLCorner : (pt.y < -0.45 ? NodeFRCorner : NodeFrontCenter);
    }
    if (pt.x < -0.8) {
        return (pt.y > 0.45) ? NodeRLCorner : (pt.y < -0.45 ? NodeRRCorner : NodeRearCenter);
    }
    return (pt.y >= 0.0) ? NodeLeftFlank : NodeRightFlank;
}

std::uint8_t quantize_u8(double v) {
    return static_cast<std::uint8_t>(std::lround(clamp(v, 0.0, 1.0) * 255.0));
}

double dequantize_u8(std::uint8_t q) {
    return static_cast<double>(q) / 255.0;
}
}  // namespace

DamageModel::MaterialFactors DamageModel::material_factors() const {
    MaterialFactors f;
    switch (spec_.material) {
        case ChassisMaterial::MildSteel:
            break;
        case ChassisMaterial::HighStrengthSteel:
            f.panel_stiffness = 1.25;
            f.dent_impulse = 1.20;
            f.structural = 1.25;
            f.cabin = 1.30;
            f.wheel_strength = 1.20;
            f.alignment_bend = 0.90;
            f.brittle_shatter = 0.05;
            break;
        case ChassisMaterial::AluminumSpaceframe:
            f.panel_stiffness = 1.45;
            f.dent_impulse = 1.35;
            f.structural = 1.40;
            f.cabin = 1.45;
            f.wheel_strength = 1.30;
            f.alignment_bend = 0.85;
            f.brittle_shatter = 0.22;
            break;
        case ChassisMaterial::CarbonMonocoque:
            f.panel_stiffness = 2.25;
            f.dent_impulse = 2.40;
            f.structural = 1.85;
            f.cabin = 2.40;
            f.wheel_strength = 1.55;
            f.alignment_bend = 0.72;
            f.brittle_shatter = 0.85;
            break;
    }
    if (spec_.carbon_body_panels) {
        f.panel_stiffness *= 1.55;
        f.dent_impulse *= 1.75;
        f.brittle_shatter = std::max(f.brittle_shatter, 0.72);
    }
    if (spec_.roll_cage) {
        f.cabin *= 1.85;
        f.structural *= 1.35;
    }
    if (spec_.race_suspension) {
        f.wheel_strength *= 1.65;
        f.alignment_bend *= 0.65;
    }
    return f;
}

void DamageModel::sync_spec_to_report() {
    r_.chassis_material = spec_.material;
    r_.carbon_body_panels = spec_.carbon_body_panels;
    r_.roll_cage = spec_.roll_cage;
    r_.race_suspension = spec_.race_suspension;
}

void DamageModel::add_contact(std::uint64_t id, const Vec3& pt, double impulse, double time, double dt) {
    if (impulse <= 0.0) return;
    const double force_g = impulse / (std::max(dt, 1e-6) * mass_ * kGravity);
    // Below scratch_force_g (1.05 g) it is gentle pushing / tyre contact: neither scratch nor dent.
    if (force_g < p_.scratch_force_g) return;

    const int node = perimeter_node_for_point(pt);
    const int zone = std::abs(pt.x) > 1.2 * std::abs(pt.y) ? (pt.x > 0 ? ZoneFront : ZoneRear)
                                                            : (pt.y > 0 ? ZoneLeft : ZoneRight);

    // ---- Layer 0: Glancing paint scratches & clearcoat scuffs (visualized even when panels don't dent!)
    const double hardness = std::max(0.5, spec_.paint_hardness);
    const double scratch_delta = clamp((impulse / (mass_ * 4.5)) / hardness, 0.015, 0.45);
    r_.paint_scratch[node] = clamp(r_.paint_scratch[node] + scratch_delta, 0.0, 1.0);
    r_.last_scratch_point = pt;
    r_.last_scratch_node = node;
    r_.last_scratch_intensity = clamp(scratch_delta * 2.5, 0.08, 1.0);
    ++r_.scratch_events;
    ++impact_seq_;

    // Average contact force over the tick F = J / dt; below min_force_g it only scratches paint, never crushes metal/carbon.
    if (force_g < p_.min_force_g) return;

    const MaterialFactors mf = material_factors();
    Event& e = events_[id];
    if (e.last_time < 0 || time - e.last_time > 0.15) e.j_acc = 0;   // new crash event
    e.last_time = time;
    double j0 = e.j_acc, j1 = e.j_acc + impulse;
    e.j_acc = j1;
    const double eff_min_impulse = p_.min_impulse * mf.dent_impulse;
    auto energy = [&](double j) {                                     // E = (J - J_min)^2 / 2m
        double jj = std::max(0.0, j - eff_min_impulse);
        return jj * jj / (2.0 * mass_);
    };
    double de = energy(j1) - energy(j0);                              // J (joules)
    if (de <= 0) return;
    if (energy(j0) <= 0) ++r_.impacts;
    r_.total_energy_kj += de / 1000.0;
    r_.last_impact_kj = energy(j1) / 1000.0;
    r_.last_impact_point = pt;
    r_.last_zone = zone;

    // ---- Layer 1 (Panels): crush depth scaled by material stiffness (CarbonMonocoque / carbon panels resist denting!)
    zone_energy_[zone] += de;
    const double k_zone = (zone <= ZoneRear ? p_.stiffness_front_rear : p_.stiffness_side) * mf.panel_stiffness;
    r_.crush[zone] = std::sqrt(2.0 * zone_energy_[zone] / k_zone);
    const double full = zone == ZoneFront ? p_.front_max : zone == ZoneRear ? p_.rear_max : p_.side_max;
    r_.zone[zone] = std::min(1.0, r_.crush[zone] / full);

    // Brittle composite delamination / shatter above elastic yield ceiling (CarbonFiber / Aluminum)
    if (mf.brittle_shatter > 0.01) {
        const double yield_kj = (zone <= ZoneRear ? 28.0 : 18.0) * mf.panel_stiffness;
        const double excess = std::max(0.0, zone_energy_[zone] / 1000.0 - yield_kj);
        r_.shatter[zone] = clamp((excess / (yield_kj * 2.2)) * mf.brittle_shatter, 0.0, 1.0);
    }

    // ---- 8-Node Perimeter Structural Crush Grid (UE5 Skeletal Mesh Morph Targets & Chaos constraints)
    node_energy_[node] += de;
    const bool is_side_node = (node == NodeLeftFlank || node == NodeRightFlank);
    const double k_node = (is_side_node ? p_.stiffness_side : p_.stiffness_front_rear) * mf.panel_stiffness;
    const double full_node = (node <= NodeFRCorner) ? p_.front_max
                           : (node >= NodeRLCorner) ? p_.rear_max
                                                    : p_.side_max;
    r_.node_crush_m[node] = std::sqrt(2.0 * node_energy_[node] / k_node);
    r_.node_norm[node] = std::min(1.0, r_.node_crush_m[node] / full_node);

    // Detachable panel & latch failure thresholds
    if (r_.node_norm[NodeFrontCenter] > 0.32 ||
        r_.node_norm[NodeFLCorner] > 0.45 ||
        r_.node_norm[NodeFRCorner] > 0.45) {
        r_.hood_unlatched = true;
    }
    if (r_.node_norm[NodeRearCenter] > 0.35) {
        r_.trunk_unlatched = true;
    }
    if (r_.zone[ZoneFront] > 0.62) {
        r_.front_bumper_detached = true;
    }
    if (r_.zone[ZoneRear] > 0.65) {
        r_.rear_bumper_detached = true;
    }

    // ---- Layer 2 (Structure): only the part of the event above the bands (J/kg), scaled by chassis material & roll cage
    const double dv0 = std::max(0.0, j0 - p_.min_impulse) / mass_, dv1 = std::max(0.0, j1 - p_.min_impulse) / mass_;
    const double heavy = (band_energy(dv1, p_.heavy_dv_lo, p_.heavy_dv_hi) - band_energy(dv0, p_.heavy_dv_lo, p_.heavy_dv_hi))
                       / mf.structural;
    const double wheel_band = band_energy(dv1, p_.wheel_dv_lo, p_.wheel_dv_hi) - band_energy(dv0, p_.wheel_dv_lo, p_.wheel_dv_hi);
    zone_heavy_[zone] += heavy;
    double total_heavy = 0;
    for (double h : zone_heavy_) total_heavy += h;
    r_.structural_kj_per_t = total_heavy;

    // Engine: front hits in full, a share of the rest (mounts, ancillaries, lines).
    const double bay = zone_heavy_[ZoneFront] + p_.engine_other_share * (total_heavy - zone_heavy_[ZoneFront]);
    r_.engine = clamp((bay - p_.engine_start) / (p_.engine_full - p_.engine_start), 0.0, 1.0);

    // ---- Multi-Fluid Puncture Triggers (Coolant, Engine Oil, Fuel)
    // 1. Coolant (front radiator & hoses): punctures above 0.25 front crush
    const double front_rad_crush = std::max(
        r_.node_norm[NodeFrontCenter],
        std::max(r_.node_norm[NodeFLCorner], r_.node_norm[NodeFRCorner]));
    r_.coolant_leak = std::max(r_.coolant_leak, clamp((front_rad_crush - 0.25) / 0.75, 0.0, 1.0));
    r_.radiator_leak = r_.coolant_leak;
    // 2. Engine Oil (oil pan / cooler / lines): punctures on heavy front-center or engine bay hits
    const double oil_trigger = std::max(r_.engine, (r_.node_norm[NodeFrontCenter] - 0.42) / 0.58);
    r_.oil_leak = std::max(r_.oil_leak, clamp((oil_trigger - 0.12) / 0.78, 0.0, 1.0));
    // 3. Fuel Tank (rear bulkhead / lines): punctures on heavy rear hits
    const double rear_tank_crush = std::max(
        r_.node_norm[NodeRearCenter],
        std::max(r_.node_norm[NodeRLCorner], r_.node_norm[NodeRRCorner]));
    r_.fuel_leak = std::max(r_.fuel_leak, clamp((rear_tank_crush - 0.38) / 0.62, 0.0, 1.0));

    // Wheels: direct hits near a wheel (share falling off linearly with plan-view distance), plus the load a heavy
    // crash puts through the suspension of the zone it lands in. Scaled by material & race_suspension strength!
    const double eff_wheel_energy = p_.wheel_energy * mf.wheel_strength;
    for (int w = 0; w < 4; ++w) {
        Vec3 d = pt - wheels_[w];
        double dist = std::hypot(d.x, d.y);
        double e_w = dist < p_.wheel_radius_m ? (1.0 - dist / p_.wheel_radius_m) * wheel_band : 0.0;
        if (wheel_in_zone(w, zone)) e_w += p_.wheel_zone_share * heavy;
        r_.wheel[w] = std::min(1.0, r_.wheel[w] + e_w / eff_wheel_energy);
        r_.wheel_detached[w] = wheel_off(w);
    }

    // Totaled: engine wrecked, cabin crushed (protected by roll cage / carbon tub), three wheels gone, or shell wrecked.
    if (!r_.totaled) {
        int dead_wheels = 0;
        for (int w = 0; w < 4; ++w) dead_wheels += wheel_off(w);
        const double eff_cabin_total = p_.cabin_total * mf.cabin;
        if (r_.engine >= p_.totaled_engine) { r_.totaled = true; r_.totaled_reason = "engine"; }
        else if (std::max(zone_heavy_[ZoneLeft], zone_heavy_[ZoneRight]) >= eff_cabin_total) { r_.totaled = true; r_.totaled_reason = "cabin"; }
        else if (dead_wheels >= 3) { r_.totaled = true; r_.totaled_reason = "wheels"; }
        else if (total_heavy >= p_.severity) { r_.totaled = true; r_.totaled_reason = "structure"; }
    }
}

// Limp-home floor instead of a dead engine: intact driven wheels can crawl home (detached wheels transmit zero drive).
double DamageModel::engine_power_factor() const { return std::max(p_.limp_power, 1.0 - 0.7 * r_.engine); }

double DamageModel::severity() const {
    return clamp(std::max(r_.engine, r_.structural_kj_per_t / p_.severity), 0.0, 1.0);
}

void DamageModel::update(double dt) {
    // ---- Multi-fluid draining (coolant 8.0 L system, oil 5.5 L sump, fuel tank drained via Vehicle/Drivetrain)
    if (r_.coolant_leak > 1e-4 && r_.coolant_level > 0.0) {
        r_.coolant_drip_lps = 0.14 * r_.coolant_leak * (0.25 + 0.75 * r_.coolant_level);
        r_.coolant_level = clamp(r_.coolant_level - (r_.coolant_drip_lps / 8.0) * dt, 0.0, 1.0);
    } else {
        r_.coolant_drip_lps = 0.0;
    }
    if (r_.oil_leak > 1e-4 && r_.oil_level > 0.0) {
        r_.oil_drip_lps = 0.09 * r_.oil_leak * (0.25 + 0.75 * r_.oil_level);
        r_.oil_level = clamp(r_.oil_level - (r_.oil_drip_lps / 5.5) * dt, 0.0, 1.0);
    } else {
        r_.oil_drip_lps = 0.0;
    }
    r_.fuel_drip_lps = (r_.fuel_leak > 1e-4) ? (0.35 * r_.fuel_leak) : 0.0;

    // ---- Overheating, fire, and brake fade (leaking fuel accelerates ignition/flame growth)
    const double s = severity();
    const double fuel_fire_mult = 1.0 + 1.5 * r_.fuel_leak;
    if (r_.fire > 0) {
        r_.fire = std::min(1.0, r_.fire + (dt * fuel_fire_mult) / p_.fire_grow_s);
    } else if (s >= p_.overheat_severity) {                   // steam first; only a wreck goes on to burn
        r_.smoulder = std::min(1.0, r_.smoulder + dt / p_.smoulder_s);
        if (r_.smoulder >= 1.0 && s >= p_.fire_severity) r_.fire = 1e-3;
    }
    double rate = std::max(0.0, s - p_.fade_severity) / (1.0 - p_.fade_severity) / p_.fade_damage_s + r_.fire / p_.fade_fire_s;
    brake_wear_ = std::min(1.0, brake_wear_ + rate * dt);
    r_.brakes_failed = brake_wear_ >= 1.0;
    r_.brakes = r_.brakes_failed ? 0.0 : 1.0 - 0.7 * brake_wear_;
}

NetDamageSnapshot DamageModel::pack_net_snapshot() const {
    NetDamageSnapshot s;
    for (int i = 0; i < 8; ++i) {
        s.crush_nodes[i] = quantize_u8(r_.node_norm[i]);
        s.paint_scratch[i] = quantize_u8(r_.paint_scratch[i]);
    }
    for (int i = 0; i < 4; ++i) {
        s.wheel_damage[i] = quantize_u8(r_.wheel[i]);
        s.shatter[i] = quantize_u8(r_.shatter[i]);
    }
    s.coolant_leak = quantize_u8(r_.coolant_leak);
    s.oil_leak = quantize_u8(r_.oil_leak);
    s.fuel_leak = quantize_u8(r_.fuel_leak);
    s.engine_damage = quantize_u8(r_.engine);
    s.smoulder = quantize_u8(r_.smoulder);
    s.fire = quantize_u8(r_.fire);
    s.brakes_eff = quantize_u8(r_.brakes);
    std::uint8_t fl = static_cast<std::uint8_t>(static_cast<int>(spec_.material) & 0x3);
    if (spec_.carbon_body_panels) fl |= (1u << 2);
    if (spec_.roll_cage) fl |= (1u << 3);
    if (spec_.race_suspension) fl |= (1u << 4);
    if (r_.totaled) fl |= (1u << 5);
    if (r_.brakes_failed) fl |= (1u << 6);
    s.flags = fl;
    std::uint16_t dm = 0;
    for (int w = 0; w < 4; ++w) if (r_.wheel_detached[w]) dm |= static_cast<std::uint16_t>(1u << w);
    if (r_.hood_unlatched) dm |= (1u << 4);
    if (r_.trunk_unlatched) dm |= (1u << 5);
    if (r_.front_bumper_detached) dm |= (1u << 6);
    if (r_.rear_bumper_detached) dm |= (1u << 7);
    s.detach_mask = dm;
    s.impact_seq = impact_seq_;
    return s;
}

void DamageModel::apply_net_snapshot(const NetDamageSnapshot& s) {
    spec_.material = static_cast<ChassisMaterial>(s.flags & 0x3);
    spec_.carbon_body_panels = (s.flags & (1u << 2)) != 0;
    spec_.roll_cage = (s.flags & (1u << 3)) != 0;
    spec_.race_suspension = (s.flags & (1u << 4)) != 0;
    sync_spec_to_report();
    for (int i = 0; i < 8; ++i) {
        r_.node_norm[i] = dequantize_u8(s.crush_nodes[i]);
        const double full_node = (i <= NodeFRCorner) ? p_.front_max
                               : (i >= NodeRLCorner) ? p_.rear_max
                                                     : p_.side_max;
        r_.node_crush_m[i] = r_.node_norm[i] * full_node;
        r_.paint_scratch[i] = dequantize_u8(s.paint_scratch[i]);
    }
    r_.zone[ZoneFront] = std::max(r_.node_norm[NodeFrontCenter], std::max(r_.node_norm[NodeFLCorner], r_.node_norm[NodeFRCorner]));
    r_.zone[ZoneRear] = std::max(r_.node_norm[NodeRearCenter], std::max(r_.node_norm[NodeRLCorner], r_.node_norm[NodeRRCorner]));
    r_.zone[ZoneLeft] = std::max(r_.node_norm[NodeLeftFlank], 0.5 * std::max(r_.node_norm[NodeFLCorner], r_.node_norm[NodeRLCorner]));
    r_.zone[ZoneRight] = std::max(r_.node_norm[NodeRightFlank], 0.5 * std::max(r_.node_norm[NodeFRCorner], r_.node_norm[NodeRRCorner]));
    r_.crush[ZoneFront] = r_.zone[ZoneFront] * p_.front_max;
    r_.crush[ZoneRear] = r_.zone[ZoneRear] * p_.rear_max;
    r_.crush[ZoneLeft] = r_.zone[ZoneLeft] * p_.side_max;
    r_.crush[ZoneRight] = r_.zone[ZoneRight] * p_.side_max;
    for (int i = 0; i < 4; ++i) {
        r_.wheel[i] = dequantize_u8(s.wheel_damage[i]);
        r_.wheel_detached[i] = ((s.detach_mask & (1u << i)) != 0) || wheel_off(i);
        r_.shatter[i] = dequantize_u8(s.shatter[i]);
    }
    r_.coolant_leak = dequantize_u8(s.coolant_leak);
    r_.radiator_leak = r_.coolant_leak;
    r_.oil_leak = dequantize_u8(s.oil_leak);
    r_.fuel_leak = dequantize_u8(s.fuel_leak);
    r_.engine = dequantize_u8(s.engine_damage);
    r_.smoulder = dequantize_u8(s.smoulder);
    r_.fire = dequantize_u8(s.fire);
    r_.brakes = dequantize_u8(s.brakes_eff);
    r_.totaled = (s.flags & (1u << 5)) != 0;
    r_.brakes_failed = (s.flags & (1u << 6)) != 0;
    r_.hood_unlatched = (s.detach_mask & (1u << 4)) != 0;
    r_.trunk_unlatched = (s.detach_mask & (1u << 5)) != 0;
    r_.front_bumper_detached = (s.detach_mask & (1u << 6)) != 0;
    r_.rear_bumper_detached = (s.detach_mask & (1u << 7)) != 0;
    impact_seq_ = s.impact_seq;
}

double DamageModel::drag_factor() const {
    double avg = 0;
    for (double z : r_.zone) avg += z * 0.25;
    return 1.0 + 0.3 * avg;
}

double DamageModel::suspension_factor(int w) const { return 1.0 - 0.4 * r_.wheel[w]; }

// A bent tie rod toes the wheel OUT (left wheels point left, right wheels right): concave pow(w, 0.65)
// so moderate 45-60 km/h hits bend alignment noticeably long before the hub shears off at 0.95!
double DamageModel::toe_offset(int w) const {
    const double bend = std::pow(clamp(r_.wheel[w], 0.0, 1.0), 0.65) * material_factors().alignment_bend;
    const double toe = bend * p_.max_toe_deg * kPi / 180.0;
    return (w % 2 == 0) ? toe : -toe;
}

double DamageModel::camber_offset(int w) const {
    if (w < 0 || w >= 4) return 0.0;
    const double bend = std::pow(clamp(r_.wheel[w], 0.0, 1.0), 0.75) * material_factors().alignment_bend;
    return bend * 2.4 * kPi / 180.0;
}

double DamageModel::caster_offset(int w) const {
    if (w < 0 || w >= 4) return 0.0;
    const double bend = std::pow(clamp(r_.wheel[w], 0.0, 1.0), 0.75) * material_factors().alignment_bend;
    return -bend * 1.8 * kPi / 180.0;
}

double DamageModel::wheel_bearing_drag_nm(int w) const {
    if (w < 0 || w >= 4 || r_.wheel[w] <= 0.10) return 0.0;
    return 55.0 * clamp((r_.wheel[w] - 0.10) / 0.90, 0.0, 1.0);
}

double DamageModel::radiator_cooling_factor() const {
    // Both instantaneous hose puncture AND lost coolant volume degrade cooling capacity down to 0.15
    const double leak_pen = 0.65 * clamp(r_.coolant_leak, 0.0, 1.0);
    const double vol_pen = 0.85 * (1.0 - clamp(r_.coolant_level, 0.0, 1.0));
    return clamp(1.0 - std::max(leak_pen, vol_pen), 0.15, 1.0);
}

double DamageModel::oil_cooling_factor() const {
    const double leak_pen = 0.50 * clamp(r_.oil_leak, 0.0, 1.0);
    const double vol_pen = 0.75 * (1.0 - clamp(r_.oil_level, 0.0, 1.0));
    return clamp(1.0 - std::max(leak_pen, vol_pen), 0.20, 1.0);
}

double DamageModel::oil_starvation_wear_rate() const {
    if (r_.oil_level >= 0.35) return 0.0;
    const double dry = clamp((0.35 - r_.oil_level) / 0.35, 0.0, 1.0);
    return 0.018 * dry * dry; // up to ~1.8% engine health lost per second under total oil starvation
}

// A wheel that is detached provides ZERO tyre grip (replaced by pure steel-on-asphalt hub scraping drag in Vehicle::update).
double DamageModel::grip_factor(int w) const { return wheel_off(w) ? p_.wheel_off_grip : 1.0 - 0.1 * r_.wheel[w]; }

}  // namespace rs
