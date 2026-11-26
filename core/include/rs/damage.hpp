// Crash damage: impacts in, crush depth per zone and physical consequences out.
//
// ENERGY. A body of mass m receiving impulse J loses kinetic energy  E = J^2 / (2 m)  (exact for a
// full stop against a rigid wall). Impulses arrive over several physics ticks, so they are summed
// per "crash event" (same object, < 0.15 s apart) and damage is charged on the energy INCREMENT.
// Contact forces below 3 g are pushing/scraping, not crashing, and are ignored.
//
// TWO LAYERS.
//  1. PANELS (what you see): crush depth per zone from ALL the energy the zone took,
//       x = sqrt(2 E / k),  k ~ 1.0 MN/m front/rear, softer sides.
//     Bumpers, lights, dents and a little drag. Scrapes and bumps add up here and nowhere else.
//  2. STRUCTURE (what breaks the car): only the part of a crash above what bumper, crash boxes and
//     crumple zone are built to take. Per event, with dv = J / m the speed change so far, the
//     energy increment is weighted by  w(dv) = clamp((dv - lo) / (hi - lo), 0, 1):
//       structural band  lo = 9 m/s (32 km/h), hi = 18 m/s (65 km/h)
//       wheel band       lo = 5 m/s (18 km/h), hi = 11 m/s (40 km/h)   (suspension arms are weaker)
//     so a hit below `lo` never reaches engine, cabin or suspension however often it happens, and a
//     hit above `hi` counts in full. All structural energies are per kg of car (J/kg = kJ/t), which
//     makes the thresholds speeds, not masses. For one full stop against a wall from speed v the
//     structural energy is  v^2 / 2 - 94.5  kJ/t  (v >= 65 km/h):
//        60 km/h   46      80 km/h  152     100 km/h  291     130 km/h  557     150 km/h  774
//     ENGINE  0 at 150, wrecked at 600 kJ/t reaching the engine bay (front hits in full, others 25 %):
//        one 80 km/h wall leaves it intact, 100 km/h costs ~30 %, ~130 km/h wrecks it.
//     CABIN   300 kJ/t into one side (a ~100 km/h slide into a wall, or several 70 km/h ones).
//     WHEELS  75 kJ/t (wheel band) of direct hits tears a wheel off; a heavy crash also loads the
//        wheels of the zone it lands in (15 % of the structural energy), so the wreck that kills the
//        engine takes the front wheels with it.
//
// NEVER IMMOVABLE (game rule). "Totaled" is a report flag (race DNF, HUD), not a dead car: the
// engine keeps a limp-home floor of limp_power and the controls are never cut, so the player can
// always crawl forward (or reverse) after any amount of damage. R repairs.
//
// OVERHEATING, FIRE, BRAKES. Severity s = max(engine damage, total structural energy / severity).
//   s >= overheat_severity  the cooling system is gone: steam builds over smoulder_s and stays.
//   s >= fire_severity      (a wreck) once it is steaming fully it catches; flames grow over fire_grow_s.
// Crash damage alone hardly touches the brakes; a fire under the car does (pads glaze, fluid boils):
//   d(wear)/dt = max(0, s - fade_severity) / (1 - fade_severity) / fade_damage_s + fire / fade_fire_s
//   brake effectiveness = 1 - 0.7 wear   while wear < 1   (fade: down to 30 %)
//                       = 0               once wear >= 1  (fluid boiled: pedal to the floor)
// Hot-disc fade from hard braking is a separate model (Vehicle, brake_pad_mu).
// No explosion. Everything resets on repair.
#pragma once
#include <array>
#include <cstdint>
#include <map>
#include <string>
#include "rs/math.hpp"

namespace rs {

enum DamageZone { ZoneFront = 0, ZoneRear = 1, ZoneLeft = 2, ZoneRight = 3 };

// Chassis & body structural material archetypes for material-aware crash deformation.
enum class ChassisMaterial : int {
    MildSteel = 0,          // Classic/street steel unibody: ductile crumple, progressive denting
    HighStrengthSteel = 1,  // Modern sports/rally reinforced steel: stiffer panels & cabin
    AluminumSpaceframe = 2, // Supercar aluminum spaceframe: higher stiffness, lighter, tears at high energy
    CarbonMonocoque = 3     // Carbon-fiber tub / composite race shell: high elastic yield, brittle delamination/shatter above limit
};

// Material & aftermarket structural tuning reinforcements (100% deterministic & UE 5.8 transferable).
struct StructuralSpec {
    ChassisMaterial material = ChassisMaterial::MildSteel;
    bool carbon_body_panels = false;  // Tuned carbon-fiber hood/fenders/bumpers (+55% stiffness, higher dent threshold, brittle shatter)
    bool roll_cage = false;           // FIA/street welded roll cage (+85% cabin survival strength, +35% structural integrity)
    bool race_suspension = false;     // Forged billet uprights / chromoly wishbones (+65% wheel shear resistance, less alignment bend)
    double paint_hardness = 1.0;      // 1.0 standard clearcoat, 1.35+ ceramic/PPF coating (resists light scratches)
};

// Compact 36-byte fixed network snapshot for 60-70 player free-roam lobby replication (hybrid rigid-body authority).
// Server simulates deterministic rigid-body + low-dimensional DamageModel; clients unpack this to drive local GPU/morph visuals.
struct NetDamageSnapshot {
    std::array<std::uint8_t, 8> crush_nodes{};    // 8 perimeter crush weights quantized 0..255
    std::array<std::uint8_t, 8> paint_scratch{};  // 8 perimeter paint scratch intensities quantized 0..255
    std::array<std::uint8_t, 4> wheel_damage{};   // 4 wheel structural damage quantized 0..255
    std::array<std::uint8_t, 4> shatter{};        // 4 zone brittle composite shatter quantized 0..255
    std::uint8_t coolant_leak = 0;                // 0..255
    std::uint8_t oil_leak = 0;                    // 0..255
    std::uint8_t fuel_leak = 0;                   // 0..255
    std::uint8_t engine_damage = 0;               // 0..255
    std::uint8_t smoulder = 0;                    // 0..255
    std::uint8_t fire = 0;                        // 0..255
    std::uint8_t brakes_eff = 255;                // 0..255
    std::uint8_t flags = 0;                       // bits 0-1: material, 2: carbon_panels, 3: roll_cage, 4: race_susp, 5: totaled, 6: brakes_failed
    std::uint16_t detach_mask = 0;                // bits 0-3: wheels FL..RR, 4: hood, 5: trunk, 6: front_bumper, 7: rear_bumper
    std::uint16_t impact_seq = 0;                 // monotonically increments on impacts / scratch events
};
static_assert(sizeof(NetDamageSnapshot) == 36, "NetDamageSnapshot must stay compact (36 bytes) for 70-player lobbies");

// 8-Node Perimeter Structural Crush Grid for Unreal Engine 5 Skeletal Mesh Morph Targets.
enum CrushNode : int {
    NodeFLCorner = 0,
    NodeFrontCenter = 1,
    NodeFRCorner = 2,
    NodeLeftFlank = 3,
    NodeRightFlank = 4,
    NodeRLCorner = 5,
    NodeRearCenter = 6,
    NodeRRCorner = 7
};

struct DamageParams {
    // ---- panels (visible crush & paint scratches)
    double stiffness_front_rear = 1.0e6;   // N/m (crash-test calibrated, see above)
    double stiffness_side = 0.35e6;        // N/m
    double front_max = 0.65;               // m of front crush for "zone fully crushed"
    double side_max = 0.40;                // m of side crush for "zone fully crushed"
    double rear_max = 0.70;                // m of rear crush for "zone fully crushed"
    double min_impulse = 600.0;            // N s ignored for panel denting (~1.5 km/h dv)
    double min_force_g = 3.0;              // per-tick contact force below this does not dent panels
    double scratch_force_g = 1.05;         // glancing contacts >= 1.05 g scuff clearcoat/paint without denting (0.8 g push = clean)
    // ---- structure (energies in kJ per tonne = J/kg)
    double heavy_dv_lo = 9.0;              // m/s: an event below this speed change does no structural damage
    double heavy_dv_hi = 18.0;             // m/s: above this all further energy is structural
    double engine_start = 150.0;           // structural energy in the engine bay before the engine is touched
    double engine_full = 600.0;            // ...at which it is wrecked
    double engine_other_share = 0.25;      // share of rear / side structural energy that reaches the engine
    double cabin_total = 300.0;            // structural energy into one side: car totaled (cabin intrusion)
    double wheel_dv_lo = 8.5;              // m/s (~31 km/h): glancing hits never snap hubs; hard hits bend alignment first
    double wheel_dv_hi = 17.5;             // m/s (~63 km/h)
    double wheel_energy = 165.0;           // wheel-band energy (kJ/t) into one wheel that shears it off (2.2x tougher for racing!)
    double wheel_radius_m = 0.7;           // impacts this close (plan view) to a wheel hit it directly
    double wheel_zone_share = 0.28;        // share of a zone's structural energy carried by each of its wheels (135 km/h wall shears front)
    double wheel_off = 0.95;               // wheel damage from which the wheel is detached
    double wheel_off_grip = 0.0;           // zero tyre grip when wheel is gone (replaced by steel-on-asphalt hub scraping drag)
    double hub_scrape_mu = 0.42;           // Coulomb scraping friction coefficient of bare rotor/control-arm on asphalt
    double max_toe_deg = 2.2;              // bent steering arm at a heavily damaged wheel
    double totaled_engine = 0.9;           // engine damage at which the car is totaled
    double limp_power = 0.25;              // engine power floor: intact driven wheels can limp home
    double severity = 1200.0;              // total structural energy that counts as "wrecked" (s = 1)
    // ---- overheating, fire, brakes
    double overheat_severity = 0.5;        // cooling system gone: steam
    double fire_severity = 0.9;            // a wreck: the steaming engine bay catches fire
    double smoulder_s = 20.0;              // steam builds this long (and precedes any flames)
    double fire_grow_s = 45.0;             // flames grow from nothing to full over this
    double fade_severity = 0.9;            // crash damage starts to cost brakes above this severity
    double fade_damage_s = 240.0;          // s to brake failure from damage alone at s = 1
    double fade_fire_s = 40.0;             // s to brake failure in a full fire (adds to damage)
};

struct DamageReport {
    std::array<double, 4> crush{};     // m of crush per zone (front, rear, left, right)
    std::array<double, 4> zone{};      // 0..1 = crush relative to "fully crushed" for that zone
    std::array<double, 4> wheel{};     // 0..1 per wheel (FL, FR, RL, RR)
    std::array<bool, 4> wheel_detached{}; // true once that wheel has sheared off the hub
    double engine = 0;                 // 0..1
    double total_energy_kj = 0;        // every crash that dented panels (light paint-only scrapes excluded)
    double structural_kj_per_t = 0;    // the part that reached the structure (see TWO LAYERS)
    double last_impact_kj = 0;         // size of the most recent crash event so far
    Vec3 last_impact_point;            // body frame
    int last_zone = 0;
    int impacts = 0;                   // crash events that caused dent/structural damage
    bool totaled = false;
    std::string totaled_reason;        // "engine", "cabin", "wheels", "structure"
    double smoulder = 0;               // 0..1 steam from a cooked engine (overheating); at 1 a wreck ignites
    double fire = 0;                   // 0 = no fire, (0..1] flame size (grows over time)
    double brakes = 1;                 // brake effectiveness 1..0.3, 0 once failed
    bool brakes_failed = false;
    // ---- 8-Node Perimeter Structural Crush Grid (UE5 Skeletal Mesh Morph Targets)
    std::array<double, 8> node_crush_m{};  // m of deformation at each of the 8 perimeter morph-target nodes
    std::array<double, 8> node_norm{};     // 0..1 normalized deformation per node for UE5 Morph Target weights
    // ---- Glancing Paint Scratch & Clearcoat Scuff Layer (zero geometry denting on light brushes)
    std::array<double, 8> paint_scratch{}; // 0..1 localized clearcoat/paint scuffing per perimeter node
    Vec3 last_scratch_point{};             // body frame position of most recent paint scrape
    int last_scratch_node = 0;             // perimeter node [0..7] of most recent paint scrape
    double last_scratch_intensity = 0.0;   // 0..1 strength of most recent scrape
    int scratch_events = 0;                // monotonically increments on any paint scrape
    // ---- Material-Aware Brittle Composite Delamination / Shatter (CarbonFiber / Aluminum)
    std::array<double, 4> shatter{};       // 0..1 composite shatter/splintering severity per zone
    ChassisMaterial chassis_material = ChassisMaterial::MildSteel;
    bool carbon_body_panels = false;
    bool roll_cage = false;
    bool race_suspension = false;
    // ---- Detachable Panel & Latch Failure States (UE5 Chaos breakable constraints)
    bool hood_unlatched = false;           // triggers when node_norm[NodeFrontCenter] > 0.32 or front corner > 0.45
    bool trunk_unlatched = false;          // triggers when node_norm[NodeRearCenter] > 0.35
    bool front_bumper_detached = false;    // triggers when front zone > 0.62
    bool rear_bumper_detached = false;     // triggers when rear zone > 0.65
    // ---- Multi-Fluid Leak Physics (Coolant, Engine Oil, Fuel)
    double radiator_leak = 0.0;            // 0..1 alias of coolant_leak (kept for backward compatibility)
    double coolant_leak = 0.0;             // 0..1 radiator/hose puncture severity
    double coolant_level = 1.0;            // 1..0 remaining coolant volume fraction (8.0 L system)
    double coolant_drip_lps = 0.0;         // L/s live coolant drip rate for VFX & decals
    double oil_leak = 0.0;                 // 0..1 engine oil sump/line puncture severity
    double oil_level = 1.0;                // 1..0 remaining engine oil fraction (5.5 L sump; < 0.35 -> oil starvation!)
    double oil_drip_lps = 0.0;             // L/s live oil drip rate for VFX & road slicks
    double fuel_leak = 0.0;                // 0..1 rear fuel tank/line puncture severity
    double fuel_drip_lps = 0.0;            // L/s live fuel drain rate (drains Drivetrain fuel_liters & raises fire risk!)
};

class DamageModel {
public:
    DamageModel(double mass, std::array<Vec3, 4> wheel_positions_body, DamageParams p = {}, StructuralSpec spec = {})
        : mass_(mass), wheels_(wheel_positions_body), p_(p), spec_(spec) {
        sync_spec_to_report();
    }

    // One contact for one physics tick. point in the BODY frame, impulse in N s, object_id
    // identifies the other object, time = simulation time, dt = tick length.
    void add_contact(std::uint64_t object_id, const Vec3& point_body, double impulse, double time, double dt);

    const DamageReport& report() const { return r_; }
    const DamageParams& params() const { return p_; }
    const StructuralSpec& structural_spec() const { return spec_; }
    void set_structural_spec(const StructuralSpec& spec) {
        spec_ = spec;
        sync_spec_to_report();
    }

    void repair() {
        r_ = DamageReport{};
        sync_spec_to_report();
        events_.clear();
        zone_energy_ = {};
        zone_heavy_ = {};
        node_energy_ = {};
        brake_wear_ = 0;
        impact_seq_ = 0;
    }
    // Time-driven effects (fire, brake fade, fluid draining). Call once per physics tick.
    void update(double dt);
    double severity() const;                    // 0..1, see OVERHEATING, FIRE, BRAKES above

    // Compact 36-byte network replication for 60-70 player free-roam lobbies (hybrid rigid-body authority).
    NetDamageSnapshot pack_net_snapshot() const;
    void apply_net_snapshot(const NetDamageSnapshot& snap);

    // Physical consequences (fed into Vehicle each tick):
    double engine_power_factor() const;         // 1 .. 0.3 from engine damage, never below limp_power
    double drag_factor() const;                 // 1 .. 1.3 (crumpled body, open panels)
    double suspension_factor(int wheel) const;  // 1 .. 0.6 spring stiffness
    bool wheel_off(int wheel) const { return r_.wheel[wheel] >= p_.wheel_off; }
    double hub_scrape_mu() const { return p_.hub_scrape_mu; }
    double toe_offset(int wheel) const;         // rad, bent steering/suspension arm
    double camber_offset(int wheel) const;      // rad, bent wishbone/strut knocking wheel into positive camber
    double caster_offset(int wheel) const;      // rad, front impact knocking caster back (asymmetric steering pull)
    double wheel_bearing_drag_nm(int wheel) const; // N m, damaged hub bearing parasitic rolling drag
    double radiator_cooling_factor() const;     // 1.0 intact down to 0.15 when coolant drains out
    double oil_cooling_factor() const;          // 1.0 intact down to 0.25 when oil sump drains
    double oil_starvation_wear_rate() const;    // extra engine_health wear/s when oil_level < 0.35
    double fuel_leak_lps() const { return r_.fuel_drip_lps; }
    double grip_factor(int wheel) const;        // 1 .. 0.9 (misaligned tyre); 0.0 once the wheel is gone
    double brake_factor() const { return r_.brakes; }   // 1 .. 0 (fade, then failure)

private:
    struct MaterialFactors {
        double panel_stiffness = 1.0;
        double dent_impulse = 1.0;
        double structural = 1.0;
        double cabin = 1.0;
        double wheel_strength = 1.0;
        double alignment_bend = 1.0;
        double brittle_shatter = 0.0;
    };
    MaterialFactors material_factors() const;
    void sync_spec_to_report();

    struct Event { double j_acc = 0, last_time = -1; };
    double mass_;
    std::array<Vec3, 4> wheels_;
    DamageParams p_;
    StructuralSpec spec_;
    DamageReport r_;
    std::array<double, 4> zone_energy_{};   // J absorbed per zone (panels)
    std::array<double, 4> zone_heavy_{};    // J/kg of structural energy per zone
    std::array<double, 8> node_energy_{};   // J absorbed per 8-node perimeter crush grid cell
    std::map<std::uint64_t, Event> events_;
    double brake_wear_ = 0;                 // 0..1, 1 = brakes failed
    std::uint16_t impact_seq_ = 0;
};

}  // namespace rs
