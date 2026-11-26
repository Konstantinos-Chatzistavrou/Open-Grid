#include "rs/drivetrain.hpp"
#include "rs/math.hpp"
#include <cmath>
#include <limits>
#include <vector>

namespace rs {
namespace {

constexpr double kRpmToRad = 2.0 * kPi / 60.0;

// Differential tree (see Drivetrain::Node). For an open differential with split s:
//   torques:    T_a = s T_in,   T_b = (1 - s) T_in
//   kinematics: w_carrier = s w_a + (1 - s) w_b          (power balance T_in w_c = T_a w_a + T_b w_b)
using Node = Drivetrain::Node;

// Per-substep context for the tree walk.
struct Ctx {
    const std::vector<Node>& nodes;
    const CarConfig& c;
    const std::array<double, 4>& omega;
    const std::array<double, 4>& ext;      // external (tyre) torque per wheel
    std::array<double, 4>& drive;          // output: drive torque per wheel
    double h;
};

double speed(const Ctx& x, int n) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) return x.omega[nd.wheel];
    return nd.split * speed(x, nd.a) + (1 - nd.split) * speed(x, nd.b);
}

// Effective inertia seen at a node's input:  1/I = s^2/I_a + (1-s)^2/I_b
// (derived from w_c = s w_a + (1-s) w_b with T_a = s T, T_b = (1-s) T).
double inertia(const Ctx& x, int n) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) return x.c.tire(nd.wheel).inertia;
    double s = nd.split;
    return 1.0 / (s * s / inertia(x, nd.a) + (1 - s) * (1 - s) / inertia(x, nd.b));
}

// Angular acceleration of a node's input if no drive torque were applied (tyre torques only).
double free_accel(const Ctx& x, int n) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) return x.ext[nd.wheel] / x.c.tire(nd.wheel).inertia;
    return nd.split * free_accel(x, nd.a) + (1 - nd.split) * free_accel(x, nd.b);
}

// "Coulomb coupling" between two rotating bodies, solved exactly for one time step h.
// The coupling torque T (applied +T to body 1, -T to body 2... here: taken FROM 1 and GIVEN to 2)
// that makes both speeds equal at the end of the step is
//     T_req = (w1 - w2 + h (a1 - a2)) / (h (1/I1 + 1/I2))
// where a1, a2 are each body's acceleration without the coupling. If |T_req| fits within the
// friction capacity the coupling is LOCKED (apply T_req); otherwise it SLIPS (apply +-capacity).
// Used for the clutch and for limited-slip / locked differentials. Unconditionally stable.
double coulomb(double w1, double a1, double i1, double w2, double a2, double i2, double h, double capacity) {
    double t_req = (w1 - w2 + h * (a1 - a2)) / (h * (1.0 / i1 + 1.0 / i2));
    return clamp(t_req, -capacity, capacity);
}

void distribute(const Ctx& x, int n, double torque) {
    const Node& nd = x.nodes[n];
    if (nd.wheel >= 0) {
        x.drive[nd.wheel] += torque;
        return;
    }
    double ta = nd.split * torque, tb = (1 - nd.split) * torque;
    const DiffParams& p = *nd.diff;
    if (p.type != "open") {
        double limit = std::numeric_limits<double>::infinity();          // locked
        if (p.type == "lsd") {
            // Clutch-pack LSD: locking capacity = preload + ramp * |input torque|.
            bool on_power = torque * speed(x, n) >= 0;
            limit = p.preload + (on_power ? p.power_ramp : p.coast_ramp) * std::abs(torque);
        }
        double ia = inertia(x, nd.a), ib = inertia(x, nd.b);
        double t_lock = coulomb(speed(x, nd.a), free_accel(x, nd.a) + ta / ia, ia,
                                speed(x, nd.b), free_accel(x, nd.b) + tb / ib, ib, x.h, limit);
        ta -= t_lock;   // torque moves from the faster side to the slower side
        tb += t_lock;
    }
    distribute(x, nd.a, ta);
    distribute(x, nd.b, tb);
}

}  // namespace

Drivetrain::Drivetrain(const CarConfig& cfg) : cfg_(cfg) {
    engine_omega = cfg.engine.idle_rpm * kRpmToRad;
    systems.input_shaft_omega = engine_omega;
    peak_engine_torque_ = 100.0;
    for (const auto& pt : cfg.engine.torque_curve)
        peak_engine_torque_ = std::max(peak_engine_torque_, pt[1]);
    if (cfg.drivetrain.transmission == "h_pattern") {
        systems.transmission = TransmissionType::HPatternSynchro;
    } else if (cfg.drivetrain.transmission == "dog_box") {
        systems.transmission = TransmissionType::SequentialDogBox;
        systems.dog_box_flat_shift_cut = true;
    } else if (cfg.drivetrain.transmission == "dct") {
        systems.transmission = TransmissionType::DualClutchDct;
    } else if (cfg.drivetrain.transmission == "auto_tc") {
        systems.transmission = TransmissionType::AutomaticTorqueConverter;
    } else if (cfg.drivetrain.transmission == "amt") {
        systems.transmission = TransmissionType::AutomatedManual;
    }
    auto leaf = [&](int w) { nodes_.push_back(Node{w}); return (int)nodes_.size() - 1; };
    auto diff = [&](int a, int b, double s, const DiffParams* p) {
        Node n; n.a = a; n.b = b; n.split = s; n.diff = p;
        nodes_.push_back(n);
        return (int)nodes_.size() - 1;
    };
    const auto& d = cfg.drivetrain;
    if (d.layout == "rwd") root_ = diff(leaf(RL), leaf(RR), 0.5, &d.rear_diff);
    else if (d.layout == "fwd") root_ = diff(leaf(FL), leaf(FR), 0.5, &d.front_diff);
    else {
        int f = diff(leaf(FL), leaf(FR), 0.5, &d.front_diff);
        int r = diff(leaf(RL), leaf(RR), 0.5, &d.rear_diff);
        root_ = diff(f, r, d.awd_front_split, &d.centre_diff);   // centre diff: front share = split
    }
}

double Drivetrain::clutch_temp_mu_factor(double temp_c) {
    // Dry organic / semi-metallic clutch facing friction vs temperature:
    // slight warm-up below 50 C, flat plateau 50..260 C, resin outgassing fade above 260 C.
    static const double T[] = {0.0, 50.0, 260.0, 340.0, 440.0, 550.0};
    static const double M[] = {0.97, 1.00, 1.00, 0.85, 0.55, 0.35};
    if (temp_c <= T[0]) return M[0];
    for (int i = 1; i < 6; ++i) {
        if (temp_c <= T[i])
            return M[i - 1] + (M[i] - M[i - 1]) * (temp_c - T[i - 1]) / (T[i] - T[i - 1]);
    }
    return M[5];
}

double Drivetrain::clutch_clamp_force(double pedal) const {
    const ClutchParams& cp = cfg_.drivetrain.clutch;
    const double p = clamp(pedal, 0.0, 1.0);
    const double health = clamp(systems.clutch_health, 0.0, 1.0);
    const double wear = 1.0 - health;
    // Worn lining lets the diaphragm spring fingers move outward, shifting the bite point higher
    // (smaller pedal depression from top) and reducing clamp force when heavily worn.
    const double eff_bite = clamp(cp.bite_point - 0.18 * wear, cp.full_engage_point + 0.08, 0.95);
    if (p >= eff_bite) return 0.0;   // floor free play: throw-out bearing has fully lifted pressure plate
    const double u = clamp((eff_bite - p) / std::max(eff_bite - cp.full_engage_point, 1e-4), 0.0, 1.0);
    // Smooth diaphragm + cushion-disc ("Marcel" wave spring) progressive clamp ramp: 3u^2 - 2u^3
    const double ramp = u * u * (3.0 - 2.0 * u);
    const double health_scale = health >= 0.7
        ? (0.94 + 0.06 * (health - 0.7) / 0.3)
        : (0.25 + 0.69 * (health / 0.7));
    const double denom = std::max(cp.mu_static * cp.effective_radius_m * std::max(cp.num_surfaces, 1), 1e-6);
    // Match factory/stage clutch rating to forced-induction boost stage and ensure kinetic capacity
    // (mu_kinetic / mu_static ~ 0.81) comfortably exceeds peak engine torque so a fully engaged
    // clutch never enters a spontaneous thermal-slip death spiral during a race.
    const double turbo_headroom = systems.turbo_stage > 0
                                ? (1.0 + max_boost_for_stage(systems.turbo_stage) * 0.24)
                                : 1.0;
    const double rated_torque = std::max(cfg_.drivetrain.clutch_max_torque, peak_engine_torque_ * 1.55) * turbo_headroom;
    const double f_max = cp.max_clamp_force_n > 0.0 ? (cp.max_clamp_force_n * turbo_headroom) : (rated_torque / denom);
    return f_max * ramp * health_scale;
}

double Drivetrain::clutch_torque_capacity(double pedal, bool static_mu) const {
    const ClutchParams& cp = cfg_.drivetrain.clutch;
    const double mu = (static_mu ? cp.mu_static : cp.mu_kinetic) * clutch_temp_mu_factor(systems.clutch_temp_c);
    return mu * clutch_clamp_force(pedal) * cp.effective_radius_m * std::max(cp.num_surfaces, 1);
}

double Drivetrain::synchro_torque_capacity() const {
    // Physical baulk-ring synchromesh cone clutch (Naunheimer et al., "Automotive Transmissions", Ch. 7):
    //   T_sync = n_cones * mu_sync * F_shift * r_cone / sin(alpha_cone)
    // Worn synchros (lower gearbox_health) lose friction effectiveness and synchronize slower.
    const SynchroParams& sp = cfg_.drivetrain.synchro;
    const double sin_alpha = std::max(std::sin(sp.cone_angle_deg * kPi / 180.0), 0.05);
    const double health_eff = 0.25 + 0.75 * clamp(systems.gearbox_health, 0.0, 1.0);
    const double fork_force = (systems.transmission == TransmissionType::AutomatedManual)
                            ? std::max(sp.shift_fork_force_n, cfg_.drivetrain.amt.fork_force_n)
                            : sp.shift_fork_force_n;
    return std::max(sp.num_cones, 1) * sp.mu_sync * fork_force * sp.cone_radius_m / sin_alpha * health_eff;
}

double Drivetrain::engine_rpm() const { return engine_omega / kRpmToRad; }

double Drivetrain::engine_torque_full(double rpm) const {
    const auto& c = cfg_.engine.torque_curve;
    if (rpm <= c.front()[0]) return c.front()[1] * std::max(rpm, 0.0) / std::max(c.front()[0], 1.0);
    for (size_t i = 1; i < c.size(); ++i)
        if (rpm <= c[i][0]) return lerp(c[i - 1][1], c[i][1], (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]));
    return c.back()[1];
}

double Drivetrain::gear_ratio(int gear) const {
    const auto& g = cfg_.drivetrain.gear_ratios;
    if (gear < 0 || gear >= (int)g.size()) return 0.0;
    return g[gear] * cfg_.drivetrain.final_drive;      // total ratio engine : wheel
}

double Drivetrain::max_boost_for_stage(int stage) {
    switch (stage) {
        case 1: return 0.70;   // Stage 1 Street Turbo (0.70 bar)
        case 2: return 1.15;   // Stage 2 Sport Turbo  (1.15 bar)
        case 3: return 1.65;   // Stage 3 Race Twin-Scroll (1.65 bar)
        default: return 0.0;
    }
}

double AtmosphericEnvironment::barometric_pressure_kpa() const {
    const double h = clamp(altitude_m, -200.0, 5500.0);
    // ISA barometric formula + live synoptic pressure front anomaly (Dynamic Weather storm lows / high pressure)
    const double isa_kpa = 101.325 * std::pow(1.0 - (0.0065 * h) / 288.15, 5.25588);
    return clamp(isa_kpa + barometric_offset_kpa, 45.0, 108.0);
}

double AtmosphericEnvironment::air_density_kg_m3() const {
    const double p_kpa = barometric_pressure_kpa();
    const double t_k = clamp(ambient_air_c, -40.0, 65.0) + 273.15;
    // Tetens saturation vapor pressure (kPa) & moist-air density (dry air R_d = 287.05, water vapor R_v = 461.5 J/(kg K))
    const double p_sat_kpa = 0.61078 * std::exp((17.27 * ambient_air_c) / (ambient_air_c + 237.3));
    const double p_vapor_kpa = clamp(humidity_0_to_1, 0.0, 1.0) * p_sat_kpa;
    const double p_dry_kpa = std::max(10.0, p_kpa - p_vapor_kpa);
    return (p_dry_kpa * 1000.0) / (287.05 * t_k) + (p_vapor_kpa * 1000.0) / (461.5 * t_k);
}

double AtmosphericEnvironment::na_engine_power_factor() const {
    if (!enabled) return 1.0;
    // SAE J1349 dry-air mass density & charge temperature correction relative to 25 C sea level (101.325 kPa)
    const double p_kpa = barometric_pressure_kpa();
    const double p_sat_kpa = 0.61078 * std::exp((17.27 * ambient_air_c) / (ambient_air_c + 237.3));
    const double p_dry_kpa = std::max(10.0, p_kpa - clamp(humidity_0_to_1, 0.0, 1.0) * p_sat_kpa);
    const double t_k = clamp(ambient_air_c, -40.0, 65.0) + 273.15;
    return clamp((p_dry_kpa / 100.2) * std::sqrt(298.15 / t_k), 0.55, 1.12);
}

double AtmosphericEnvironment::turbo_altitude_power_factor(double boost_bar, double* out_compressor_pr) const {
    const double p_atm_bar = barometric_pressure_kpa() / 100.0;
    const double abs_target_bar = 1.01325 + std::max(0.0, boost_bar);
    // Closed-loop wastegate raises pressure ratio PR = P_abs / P_atm to maintain manifold pressure at altitude,
    // capped at compressor choke / 155,000 RPM overspeed ceiling (max PR ~ 3.15)
    const double max_pr = 3.15;
    const double req_pr = abs_target_bar / std::max(p_atm_bar, 0.45);
    const double actual_pr = std::min(req_pr, max_pr);
    if (out_compressor_pr) *out_compressor_pr = actual_pr;
    if (!enabled) return 1.0;
    const double achieved_abs_bar = p_atm_bar * actual_pr;
    const double t_k = clamp(ambient_air_c, -40.0, 65.0) + 273.15;
    return clamp((achieved_abs_bar / abs_target_bar) * std::sqrt(298.15 / t_k), 0.72, 1.08);
}

void Drivetrain::step(const DrivetrainInput& in, const std::array<double, 4>& tyre_torque,
                      const std::array<double, 4>& rolling_torque, double h) {
    const EngineParams& e = cfg_.engine;
    const ClutchParams& cp = cfg_.drivetrain.clutch;
    const SynchroParams& sp = cfg_.drivetrain.synchro;
    const double idle_w = e.idle_rpm * kRpmToRad;
    std::array<double, 4> drive{};
    Ctx x{nodes_, cfg_, wheel_omega, tyre_torque, drive, h};
    const double w_carrier = speed(x, root_);

    // Holding the starter button disengages the clutch interlock so the starter motor doesn't crank against locked wheels.
    const double eff_clutch = in.starter_crank ? 1.0 : clamp(in.clutch, 0.0, 1.0);
    double T_s = clutch_torque_capacity(eff_clutch, true);
    double T_k = clutch_torque_capacity(eff_clutch, false);
    const double T_s_full = clutch_torque_capacity(0.0, true);
    systems.clutch_clamp_frac = T_s_full > 1e-6 ? clamp(T_s / T_s_full, 0.0, 1.0) : 0.0;
    systems.missed_shift_event = false;

    // ---- Transmission Archetype: Physical H-Pattern Synchromesh Cone Clutch, Sequential Dog-Box, or DCT
    if (systems.engaged_gear < 0) {
        systems.engaged_gear = in.gear;
        const double g_init = gear_ratio(systems.engaged_gear);
        systems.input_shaft_omega = (g_init != 0.0) ? (g_init * w_carrier) : engine_omega;
    }
    if (systems.engaged_gear != 1) {
        systems.input_shaft_omega = gear_ratio(systems.engaged_gear) * w_carrier;
    }
    if (systems.grind_timer_s > 0.0) {
        systems.grind_timer_s = std::max(0.0, systems.grind_timer_s - h);
        if (systems.grind_timer_s <= 0.0) systems.gear_grind = false;
    }
    if (systems.shift_cut_timer_s > 0.0) {
        systems.shift_cut_timer_s = std::max(0.0, systems.shift_cut_timer_s - h);
        if (systems.shift_cut_timer_s <= 0.0) systems.shift_cut_active = false;
    }
    if (systems.dct_handoff_timer_s > 0.0) {
        systems.dct_handoff_timer_s = std::max(0.0, systems.dct_handoff_timer_s - h);
    }

    auto trigger_missed_shift = [&](int target_gear, double dw_rads) {
        systems.engaged_gear = 1; // kicked out to Neutral
        systems.sync_state = SyncState::Missed;
        systems.sync_target_gear = target_gear;
        systems.gear_grind = true;
        systems.grind_timer_s = 0.35;
        systems.missed_shifts += 1;
        systems.missed_shift_event = true;
        systems.clash_timer_s = 0.0;
        systems.clutch_opened_during_sync = false;
        const double severity = clamp(std::abs(dw_rads) / 300.0, 0.25, 2.5);
        systems.gearbox_health = clamp(systems.gearbox_health - 0.035 * severity, 0.0, 1.0);
    };

    if (systems.transmission == TransmissionType::HPatternSynchro ||
        systems.transmission == TransmissionType::AutomatedManual) {
        const bool is_amt = (systems.transmission == TransmissionType::AutomatedManual);
        const double T_sync = synchro_torque_capacity();
        if (in.gear == 1) {
            systems.engaged_gear = 1;
            systems.sync_state = SyncState::Idle;
            systems.sync_target_gear = -1;
            systems.sync_timer_s = 0.0;
            systems.clash_timer_s = 0.0;
            systems.clutch_opened_during_sync = false;
        } else if (in.gear != systems.engaged_gear) {
            const bool clutch_free = (T_s <= 0.5 * T_sync);
            if (systems.sync_state == SyncState::Missed && systems.sync_target_gear == in.gear) {
                // Stay in Neutral after a missed shift until the driver depresses the clutch to retry.
                if (clutch_free) {
                    systems.sync_state = SyncState::Synchronizing;
                    systems.sync_timer_s = 0.0;
                    systems.clash_timer_s = 0.0;
                    systems.clutch_opened_during_sync = true;
                }
            } else if (systems.sync_state != SyncState::Synchronizing || systems.sync_target_gear != in.gear) {
                // Disengage previous gear across the neutral gate and begin baulk-ring synchronization.
                systems.engaged_gear = 1;
                systems.sync_state = SyncState::Synchronizing;
                systems.sync_target_gear = in.gear;
                systems.sync_timer_s = 0.0;
                systems.clash_timer_s = 0.0;
                systems.clutch_opened_during_sync = clutch_free;
            }

            if (systems.sync_state == SyncState::Synchronizing) {
                const double w_target = gear_ratio(systems.sync_target_gear) * w_carrier;
                const double dw = w_target - systems.input_shaft_omega;
                if (std::abs(dw) <= sp.engage_tol_rads) {
                    // Shafts matched within synchro tolerance -> dog sleeve locks cleanly!
                    systems.engaged_gear = systems.sync_target_gear;
                    systems.input_shaft_omega = w_target;
                    systems.sync_state = SyncState::Idle;
                    systems.sync_target_gear = -1;
                    systems.gear_grind = false;
                    systems.clash_timer_s = 0.0;
                } else if (clutch_free) {
                    // Clutch unloaded: synchromesh cone clutch accelerates input shaft toward w_target.
                    systems.clutch_opened_during_sync = true;
                    systems.clash_timer_s = 0.0;
                    systems.sync_timer_s += h;
                    const double I_in = std::max(cp.input_shaft_inertia_kgm2, 0.002);
                    const double max_dw = (T_sync / I_in) * h;
                    if (std::abs(dw) <= max_dw) {
                        systems.input_shaft_omega = w_target;
                        systems.engaged_gear = systems.sync_target_gear;
                        systems.sync_state = SyncState::Idle;
                        systems.sync_target_gear = -1;
                        systems.gear_grind = false;
                    } else {
                        systems.input_shaft_omega += sign(dw) * max_dw;
                    }
                } else if (!is_amt) {
                    // H-pattern manual: clutch is still clamped (or dropped too early before sync finished) while |dw| > tol.
                    systems.clash_timer_s += h;
                    const double grace_s = systems.strict_h_pattern_synchro ? 0.0 : 0.020;
                    if (systems.clutch_opened_during_sync || systems.clash_timer_s >= grace_s) {
                        trigger_missed_shift(systems.sync_target_gear, dw);
                    }
                } else {
                    // Electro-hydraulic AMT TCU never forces a clash; waits for hydraulic clutch to open cleanly.
                    systems.sync_timer_s += h;
                }
            }
        } else {
            systems.sync_state = SyncState::Idle;
            systems.sync_target_gear = -1;
            systems.clash_timer_s = 0.0;
        }
    } else if (systems.transmission == TransmissionType::SequentialDogBox) {
        const DogBoxParams& dp = cfg_.drivetrain.dog_box;
        if (in.gear == 1) {
            systems.engaged_gear = 1;
            systems.sync_state = SyncState::Idle;
            systems.sync_target_gear = -1;
            systems.dog_pending_gear = -1;
            systems.dog_blip_timer_s = 0.0;
            systems.auto_blip_active = false;
            systems.auto_blip_throttle = 0.0;
        } else if (systems.dog_pending_gear >= 2) {
            // Active pneumatic auto-blip downshift in progress: stay in neutral while DBW throttle
            // accelerates the crank & input shaft up to the lower gear's speed, then snap the dog ring in!
            if (in.gear != systems.dog_pending_gear) {
                systems.dog_pending_gear = in.gear;
            }
            systems.dog_blip_timer_s += h;
            const double w_target = clamp(gear_ratio(systems.dog_pending_gear) * w_carrier,
                                          idle_w, e.redline_rpm * 0.97 * kRpmToRad);
            const double dw = w_target - engine_omega;
            systems.auto_blip_active = true;
            systems.auto_blip_throttle = (dw > 10.0)
                                       ? clamp(0.28 + dw * dp.blip_throttle_gain, 0.28, 0.92)
                                       : 0.0;
            const bool matched = std::abs(w_target - engine_omega) <= sp.dog_engage_tol_rads;
            const bool ready = (systems.dog_blip_timer_s >= dp.downshift_unload_s && matched)
                            || (systems.dog_blip_timer_s >= dp.downshift_blip_max_s);
            if (ready) {
                systems.engaged_gear = systems.dog_pending_gear;
                systems.input_shaft_omega = gear_ratio(systems.engaged_gear) * w_carrier;
                systems.sync_state = SyncState::Idle;
                systems.sync_target_gear = -1;
                systems.dog_pending_gear = -1;
                systems.dog_blip_timer_s = 0.0;
                systems.auto_blip_active = false;
                systems.auto_blip_throttle = 0.0;
                systems.gear_grind = false;
                systems.shift_clunk_impulse_nm = std::max(systems.shift_clunk_impulse_nm, dp.engage_clunk_nm * 0.85);
            }
        } else if (in.gear != systems.engaged_gear) {
            const bool is_upshift = (in.gear > systems.engaged_gear && systems.engaged_gear >= 2);
            const bool is_downshift = (in.gear < systems.engaged_gear && in.gear >= 2 && systems.engaged_gear >= 2);
            if (is_upshift && systems.dog_box_flat_shift_cut) {
                // Motorsport dog-box flat-foot upshift: ignition cut unloads undercut dog rings cleanly without clutch pedal.
                if (in.throttle > 0.25) {
                    systems.shift_cut_active = true;
                    systems.shift_cut_timer_s = dp.upshift_cut_s;
                }
                systems.engaged_gear = in.gear;
                systems.input_shaft_omega = gear_ratio(in.gear) * w_carrier;
                systems.sync_state = SyncState::Idle;
                systems.gear_grind = false;
                systems.shift_clunk_impulse_nm = std::max(systems.shift_clunk_impulse_nm, dp.engage_clunk_nm);
            } else if (is_downshift && systems.dog_box_flat_shift_cut && dp.auto_blip && std::abs(w_carrier) > 3.0) {
                // Pneumatic paddle downshift: unload across neutral and fire closed-loop electronic throttle auto-blip.
                systems.engaged_gear = 1;
                systems.sync_state = SyncState::Synchronizing;
                systems.sync_target_gear = in.gear;
                systems.dog_pending_gear = in.gear;
                systems.dog_blip_timer_s = 0.0;
                systems.auto_blip_active = true;
                const double w_target = clamp(gear_ratio(in.gear) * w_carrier,
                                              idle_w, e.redline_rpm * 0.97 * kRpmToRad);
                const double dw = std::max(0.0, w_target - engine_omega);
                systems.auto_blip_throttle = dw > 10.0 ? clamp(0.28 + dw * dp.blip_throttle_gain, 0.28, 0.92) : 0.0;
                systems.gear_grind = false;
            } else if (!systems.dog_box_flat_shift_cut) {
                systems.engaged_gear = in.gear;
                systems.sync_state = SyncState::Idle;
            } else {
                const double w_target = gear_ratio(in.gear) * w_carrier;
                const double dw = w_target - systems.input_shaft_omega;
                const bool unloaded = (T_s <= 10.0) || systems.shift_cut_active || (in.throttle < 0.20)
                                   || (std::abs(dw) <= sp.dog_engage_tol_rads) || (std::abs(w_carrier) <= 3.0);
                if (systems.sync_state == SyncState::Missed && systems.sync_target_gear == in.gear && !unloaded) {
                    // Stay in neutral until unloaded or re-selected.
                } else if (unloaded) {
                    systems.engaged_gear = in.gear;
                    systems.input_shaft_omega = w_target;
                    systems.sync_state = SyncState::Idle;
                    systems.gear_grind = false;
                    systems.shift_clunk_impulse_nm = std::max(systems.shift_clunk_impulse_nm, dp.engage_clunk_nm * 0.5);
                } else {
                    trigger_missed_shift(in.gear, dw);
                }
            }
        }
    } else if (in.gear != systems.engaged_gear) {
        if (in.gear == 1) {
            systems.engaged_gear = 1;
            systems.sync_state = SyncState::Idle;
            systems.sync_target_gear = -1;
        } else if (systems.transmission == TransmissionType::DualClutchDct) {
            // Dual-Clutch (DCT): pre-selected odd/even twin clutch packs overlap-swap in 18 ms with zero boost drop.
            if (in.gear > systems.engaged_gear && systems.engaged_gear >= 2 && in.throttle > 0.35) {
                systems.shift_cut_active = true;
                systems.shift_cut_timer_s = 0.018;   // crisp 18 ms ignition torque-trim ("DSG/PDK crack")
                systems.dct_handoff_timer_s = 0.025; // keep turbo throttle/boost pre-loaded throughout swap
            }
            systems.engaged_gear = in.gear;
            systems.input_shaft_omega = gear_ratio(in.gear) * w_carrier;
            systems.sync_state = SyncState::Idle;
            systems.gear_grind = false;
        } else {
            // Planetary AutomaticTorqueConverter: wet bands/clutches swap ratio smoothly under hydraulic pressure.
            systems.engaged_gear = in.gear;
            systems.input_shaft_omega = gear_ratio(in.gear) * w_carrier;
            systems.sync_state = SyncState::Idle;
            systems.gear_grind = false;
        }
    }

    const double G = gear_ratio(systems.engaged_gear);

    // ---- engine torque & physical starter cranking
    if (stalled && (T_s <= 1.0 || eff_clutch > 0.9 || G == 0.0 || in.starter_crank)) {
        if (in.starter_crank) {
            // Physical starter motor cranks flywheel up toward idle speed
            engine_omega += h * (220.0 / std::max(e.inertia, 0.08));
            if (engine_omega >= idle_w) {
                stalled = false;
                engine_omega = idle_w;
            }
        } else {
            stalled = false;
            engine_omega = idle_w;
        }
    }
    double t_engine = 0;
    if (!stalled) {
        double rpm = engine_rpm();
        // Idle controller: opens the throttle a little when revs fall below idle.
        double thr = std::max(in.throttle, clamp((e.idle_rpm - rpm) / 300.0, 0.0, 1.0) * 0.5);
        // Closed-loop electronic throttle auto-blip on downshifts (SequentialDogBox, AutomatedManual, DualClutchDct).
        if (systems.auto_blip_active && systems.auto_blip_throttle > 0.0) {
            thr = std::max(thr, clamp(systems.auto_blip_throttle, 0.0, 1.0));
        }
        // Rev limiter, hard fuel cut with hysteresis: cut at redline, refuel below redline - band. (A cut that refuels the
        // moment rpm dips under redline holds the revs glued to it; the band gives the real bounce.)
        if (rpm >= e.redline_rpm) systems.limiter_cut = true;
        else if (rpm < e.redline_rpm - std::max(e.limiter_hysteresis_rpm, 1.0)) systems.limiter_cut = false;
        if (systems.limiter_cut) thr = 0;
        if (systems.shift_cut_active && !systems.auto_blip_active) thr = 0; // ignition cut during upshift
        if (systems.fuel_consumption_enabled && systems.fuel_liters <= 0.0) thr = 0; // out of fuel

        // ---- Turbocharger spool, boost pressure, Blow-Off Valve (BOV) & Intercooler Heat Soak (IAT + Altitude + Wake)
        const double wake_hot_c = std::max(0.0, in.wake_hot_air_c);
        const double wake_cool = clamp(in.wake_cooling_scale, 0.55, 1.0);
        const double eff_cool_air_v = std::abs(in.airspeed_mps) * wake_cool;
        AtmosphericEnvironment env;
        env.enabled = in.atmosphere_enabled;
        env.ambient_air_c = in.ambient_air_c + wake_hot_c;
        env.altitude_m = in.altitude_m;
        env.humidity_0_to_1 = in.humidity_0_to_1;

        double turbo_mult = 1.0;
        if (systems.turbo_stage > 0) {
            const double max_boost = max_boost_for_stage(systems.turbo_stage);
            const double rpm_norm = clamp((rpm - e.idle_rpm) / std::max(e.redline_rpm - e.idle_rpm, 1000.0), 0.0, 1.0);
            // DCT and flat-foot dog-box ignition-cut shifts keep the throttle plate & turbo boost pre-loaded!
            const bool keep_boost_loaded = (systems.transmission == TransmissionType::DualClutchDct && systems.dct_handoff_timer_s > 0.0)
                                        || (systems.transmission == TransmissionType::SequentialDogBox && systems.shift_cut_active);
            const double eff_thr_for_boost = keep_boost_loaded ? std::max(thr, in.throttle) : thr;
            const double exhaust_flow = clamp((rpm_norm - 0.18) / 0.55, 0.0, 1.0) * eff_thr_for_boost;
            const double target_boost = eff_thr_for_boost > 0.15 ? exhaust_flow * max_boost : -0.35 * (1.0 - eff_thr_for_boost);
            const double tau_spool = (target_boost > systems.boost_bar) ? (0.14 + 0.05 * systems.turbo_stage) : 0.065;
            if (eff_thr_for_boost < 0.12 && systems.boost_bar > 0.25) {
                systems.surge_boost_bar = systems.bov_venting
                                        ? std::max(systems.surge_boost_bar, systems.boost_bar)
                                        : systems.boost_bar;
                systems.bov_venting = true;
                systems.bov_timer_s = 0.22;
            }
            systems.boost_bar += (target_boost - systems.boost_bar) * std::min(1.0, h / tau_spool);
            if (systems.bov_timer_s > 0.0 && eff_thr_for_boost < 0.35) {
                systems.bov_timer_s = std::max(0.0, systems.bov_timer_s - h);
                if (systems.bov_timer_s <= 0.0) {
                    systems.bov_venting = false;
                    systems.turbo_surge = 0.0;
                    systems.surge_boost_bar = 0.0;
                } else {
                    const double surge_env = clamp(systems.bov_timer_s / 0.22, 0.0, 1.0)
                                           * clamp(systems.surge_boost_bar / std::max(0.5, max_boost), 0.2, 1.0);
                    const double flutter = 0.65 + 0.35 * std::sin((0.22 - systems.bov_timer_s) * 28.0 * 2.0 * kPi);
                    systems.turbo_surge = clamp(surge_env * flutter, 0.0, 1.0);
                }
            } else {
                systems.bov_timer_s = 0.0;
                systems.bov_venting = false;
                systems.turbo_surge = 0.0;
                systems.surge_boost_bar = 0.0;
            }
            // Adiabatic compressor heating + air-to-air intercooler heat soak (at altitude, compressor works at higher PR):
            const double t_amb_c = env.enabled ? env.ambient_air_c : (25.0 + wake_hot_c);
            const double t_amb_k = t_amb_c + 273.15;
            double pr = 1.0 + std::max(0.0, systems.boost_bar);
            const double alt_turbo_factor = env.turbo_altitude_power_factor(systems.boost_bar, &pr);
            const double t_comp_c = t_amb_c + t_amb_k * (std::pow(pr, 0.286) - 1.0) / 0.72;
            const double airflow_eff = clamp(systems.intercooler_eff * (0.45 + 0.55 * std::min(1.0, eff_cool_air_v / 38.0))
                                             * in.radiator_cooling_scale, 0.15, 0.92);
            const double target_iat = t_comp_c - airflow_eff * (t_comp_c - t_amb_c);
            systems.intake_air_temp_c += (target_iat - systems.intake_air_temp_c) * std::min(1.0, h * 0.45);
            systems.iat_power_factor = systems.intake_air_temp_c > 52.0
                                     ? clamp(1.0 - (systems.intake_air_temp_c - 52.0) * 0.0025, 0.85, 1.0) : 1.0;

            if (systems.boost_bar > 0.0) {
                turbo_mult += systems.boost_bar * 0.24;
            }
            turbo_mult *= systems.iat_power_factor * alt_turbo_factor;
        } else {
            if (thr < 0.12 && systems.boost_bar > 0.25) {
                systems.surge_boost_bar = std::max(systems.surge_boost_bar, systems.boost_bar);
                systems.bov_venting = true;
                systems.bov_timer_s = 0.22;
            }
            systems.boost_bar = 0.0;
            if (systems.bov_timer_s > 0.0 && thr < 0.35) {
                systems.bov_timer_s = std::max(0.0, systems.bov_timer_s - h);
                if (systems.bov_timer_s <= 0.0) {
                    systems.bov_venting = false;
                    systems.turbo_surge = 0.0;
                    systems.surge_boost_bar = 0.0;
                } else {
                    const double surge_env = clamp(systems.bov_timer_s / 0.22, 0.0, 1.0)
                                           * clamp(systems.surge_boost_bar / 0.70, 0.2, 1.0);
                    const double flutter = 0.65 + 0.35 * std::sin((0.22 - systems.bov_timer_s) * 28.0 * 2.0 * kPi);
                    systems.turbo_surge = clamp(surge_env * flutter, 0.0, 1.0);
                }
            } else {
                systems.bov_venting = false;
                systems.bov_timer_s = 0.0;
                systems.turbo_surge = 0.0;
                systems.surge_boost_bar = 0.0;
            }
            systems.intake_air_temp_c = env.enabled ? (env.ambient_air_c + 3.0) : (28.0 + wake_hot_c);
            systems.iat_power_factor = 1.0;
            turbo_mult *= env.na_engine_power_factor();
        }

        // ---- Nitrous Oxide (N2O) injection (requires WOT > 0.70, RPM > 2600, bottle > 0)
        double nos_mult = 1.0;
        if (in.nos_active && systems.nos_bottles_l > 0.0 && thr > 0.70 && rpm > 2600.0) {
            const double consumed = std::min(systems.nos_bottles_l, 0.42 * h);
            systems.nos_bottles_l = std::max(0.0, systems.nos_bottles_l - consumed);
            nos_mult = 1.26;
        }

        // ---- Engine Oil Thermodynamics (scaled by Radiator & Oil Pan Puncture) & Mechanical Health / Misfires
        const double rpm_frac = clamp(rpm / std::max(e.redline_rpm, 1000.0), 0.0, 1.2);
        const double oil_heat_mult = 1.0 + 0.85 * (1.0 - clamp(in.oil_cooling_scale, 0.20, 1.0));
        const double heat_load = (14.0 * rpm_frac * rpm_frac * (0.3 + 0.7 * thr))
                               * (1.0 + 0.35 * std::max(0.0, systems.boost_bar))
                               * (nos_mult > 1.0 ? 1.45 : 1.0)
                               * oil_heat_mult;
        const double oil_eq_c = env.enabled ? (82.0 + 0.45 * (env.ambient_air_c - 25.0)) : (82.0 + 0.45 * std::max(0.0, in.wake_hot_air_c));
        const double cooling = (0.16 + 0.008 * eff_cool_air_v)
                             * clamp(in.radiator_cooling_scale * in.oil_cooling_scale * clamp(in.wake_cooling_scale, 0.55, 1.0), 0.12, 1.0)
                             * (systems.oil_temp_c - oil_eq_c);
        systems.oil_temp_c = clamp(systems.oil_temp_c + h * (heat_load - cooling) * 0.12, 20.0, 165.0);

        if (systems.wear_enabled && (systems.oil_temp_c > 128.0 || rpm > e.redline_rpm * 0.985 || in.oil_starvation_wear_rate > 0.0)) {
            const double abuse = (systems.oil_temp_c > 128.0 ? (systems.oil_temp_c - 128.0) * 0.00015 : 0.0)
                               + (rpm > e.redline_rpm * 0.985 ? 0.00025 : 0.0)
                               + std::max(0.0, in.oil_starvation_wear_rate);
            systems.engine_health = clamp(systems.engine_health - h * abuse, 0.15, 1.0);
        }

        double health_mult = 1.0;
        systems.misfiring = false;
        if (systems.engine_health < 0.999 || systems.oil_temp_c > 130.0) {
            health_mult = (0.55 + 0.45 * systems.engine_health)
                        * (systems.oil_temp_c > 130.0 ? clamp(1.0 - (systems.oil_temp_c - 130.0) * 0.008, 0.70, 1.0) : 1.0);
            if (systems.engine_health < 0.65) {
                systems.misfire_phase += h * (18.0 + 25.0 * (0.65 - systems.engine_health));
                if (std::sin(systems.misfire_phase * 2.0 * kPi) > (0.35 + 0.85 * systems.engine_health)) {
                    systems.misfiring = true;
                    health_mult *= 0.38;
                }
            }
        }

        t_engine = thr * engine_torque_full(rpm) * in.engine_power_scale * turbo_mult * nos_mult * health_mult
                   - (1 - thr) * (e.friction_const + e.friction_linear * engine_omega);

        // ---- BSFC Fuel Consumption (~250 g/kWh under load + idle flow) + Physical Fuel Tank Leak Drain
        if (systems.fuel_liters > 0.0) {
            double drain_l = std::max(0.0, in.fuel_leak_lps) * h;
            if (systems.fuel_consumption_enabled) {
                const double pos_power_kw = std::max(0.0, t_engine * engine_omega) / 1000.0;
                const double fuel_kg_per_s = 0.00022 + pos_power_kw * (0.255 / 3600.0) * (1.0 + 0.18 * std::max(0.0, systems.boost_bar));
                drain_l += (fuel_kg_per_s / 0.745) * h;
            }
            systems.fuel_liters = std::max(0.0, systems.fuel_liters - drain_l);
        }
    }

    // ---- Engine coolant (water): a wax thermostat (opens ~87 C, fully ~97 C) holds it near 90 C; it climbs when the heat
    // into the coolant (~0.7 x brake power + idle) outruns the radiator (airflow, the fan when stopped, damage) and falls
    // in the cold. Estimates: 60 kJ/K (coolant + the metal it wets), radiator 1.0 + 0.045 v kW/K.
    {
        const double amb = (in.atmosphere_enabled ? in.ambient_air_c : 25.0) + std::max(0.0, in.wake_hot_air_c);
        const double p_kw = std::max(0.0, t_engine * engine_omega) / 1000.0;
        const double q_in = (stalled ? 0.0 : 2.5) + 0.7 * p_kw;
        const double open = clamp((systems.coolant_temp_c - 87.0) / 10.0, 0.0, 1.0);
        const double wake_cool = clamp(in.wake_cooling_scale, 0.55, 1.0);
        const double ua = (1.0 + 0.045 * std::max(0.0, in.airspeed_mps) * wake_cool) * clamp(in.radiator_cooling_scale, 0.1, 1.0);
        const double q_out = (ua * open + 0.04) * (systems.coolant_temp_c - amb);
        systems.coolant_temp_c = clamp(systems.coolant_temp_c + h * (q_in - q_out) / 60.0, amb - 1.0, 135.0);
    }

    // ---- Physical Clutch Friction Disc (Karnopp stick/slip) & Gearbox Tooth Integrity
    // Reference: D. Karnopp (1985), "Computer Simulation of Stick-Slip Friction in Mechanical Dynamic Systems",
    // ASME J. Dyn. Syst. Meas. Control 107(1):100-103.
    constexpr double kStickBand = 2.0;    // rad/s (~19 RPM) Karnopp zero-velocity deadband
    constexpr double kStribeckVel = 18.0; // rad/s Stribeck static->kinetic transition speed
    clutch_torque = 0.0;
    systems.driveline_clunk_nm = systems.shift_clunk_impulse_nm;
    systems.shift_clunk_impulse_nm = 0.0;
    double slip_power_w = 0.0;

    auto solve_karnopp = [&](double w1, double a1, double i1, double w2, double a2, double i2,
                             double cap_static, double cap_kinetic) -> double {
        const double dv = w1 - w2;
        const double t_req = (dv + h * (a1 - a2)) / (h * (1.0 / i1 + 1.0 / i2));
        if (systems.clutch_locked || std::abs(dv) <= kStickBand) {
            if (std::abs(t_req) <= cap_static) {
                systems.clutch_locked = true;
                return t_req;
            }
            systems.clutch_locked = false;
            return sign(t_req) * cap_kinetic;
        }
        const double stribeck = std::exp(-(dv * dv) / (kStribeckVel * kStribeckVel));
        const double t_slip = cap_kinetic + (cap_static - cap_kinetic) * stribeck;
        if (t_req * dv > 0.0 && std::abs(t_req) <= t_slip) {
            // Kinetic torque would reverse slip direction within substep h -> catch cleanly into stick (zero chatter).
            systems.clutch_locked = true;
            return t_req;
        }
        systems.clutch_locked = false;
        return sign(dv) * t_slip;
    };

    if (G != 0.0 && systems.transmission == TransmissionType::AutomaticTorqueConverter && !stalled) {
        // ---- Hydraulic Torque Converter (Kotwicki fluid coupling + stator multiplication) & TCC Lock-Up Clutch
        const TorqueConverterParams& tc = cfg_.drivetrain.torque_converter;
        const double eta = std::max(cfg_.drivetrain.efficiency, 0.1);
        const double i_wheels = inertia(x, root_) / (G * G);
        const double i_shaft = cfg_.drivetrain.driveline_inertia + i_wheels;
        const double w_shaft = G * w_carrier;
        const double a_shaft = G * free_accel(x, root_) * i_wheels / i_shaft;
        const double w_pump = std::max(engine_omega, 1.0);
        const double sr = clamp(w_shaft / std::max(w_pump, 10.0), 0.0, 1.30);
        const double k_rad = std::max(tc.stall_k_factor, 40.0) * kRpmToRad;
        const double c_stall = 1.0 / (k_rad * k_rad);
        const double c_sr = std::max(tc.coupling_speed_ratio, 0.25);
        const double tr_fluid = (sr < c_sr)
                              ? (1.0 + (std::max(1.0, tc.stall_torque_ratio) - 1.0) * (1.0 - sr / c_sr))
                              : 1.0;

        double t_pump_fluid = 0.0;
        double t_turb_fluid = 0.0;
        if (sr <= 1.0) {
            const double c_p = c_stall * clamp(1.0 - 0.92 * sr * sr, 0.02, 1.0);
            t_pump_fluid = c_p * w_pump * w_pump;
            // Unconditional substep stability cap: fluid coupling cannot overshoot pump/turbine equilibrium in step h.
            const double denom = h * (1.0 / e.inertia + tr_fluid * eta / i_shaft);
            const double t_eq = ((w_pump - w_shaft) + h * (t_engine / e.inertia - a_shaft)) / std::max(denom, 1e-9);
            if (t_eq > 0.0) t_pump_fluid = std::min(t_pump_fluid, t_eq);
            else t_pump_fluid = 0.0;
            t_turb_fluid = t_pump_fluid * tr_fluid;
        } else {
            // Overrun / coast engine braking: turbine drives pump with ~35% reverse fluid coupling
            const double c_coast = 0.35 * c_stall * (sr - 1.0);
            t_pump_fluid = -c_coast * w_shaft * std::abs(w_shaft);
            const double denom = h * (1.0 / e.inertia + eta / i_shaft);
            const double t_eq = ((w_pump - w_shaft) + h * (t_engine / e.inertia - a_shaft)) / std::max(denom, 1e-9);
            if (t_eq < 0.0) t_pump_fluid = std::max(t_pump_fluid, t_eq);
            else t_pump_fluid = 0.0;
            t_turb_fluid = t_pump_fluid;
        }

        // Hydraulic TCC mechanical lock-up clutch (engages smoothly in 3rd+ at cruise, unlocks on kickdown/brake)
        const double sr_thresh = systems.tc_lockup_engaged ? (tc.lockup_speed_ratio - 0.06) : tc.lockup_speed_ratio;
        const bool want_lock = (systems.engaged_gear >= tc.lockup_min_gear) && (sr >= sr_thresh)
                            && (std::abs(in.airspeed_mps) >= tc.lockup_min_speed_mps)
                            && (in.brake < 0.15) && (in.clutch < 0.1)
                            && (in.throttle < 0.88 || systems.engaged_gear >= static_cast<int>(cfg_.drivetrain.gear_ratios.size()) - 2);
        // A full-throttle stab (kickdown) opens the lock-up in the lower gears, but in the top two gears a modern lock-up clutch holds
        // at full throttle. Refusing to lock there left the converter slipping all the way up the box and cost ~3 % of top speed.
        const double ramp_step = 4.0 * h; // 0.25 s smooth lock-up / unlock
        systems.tc_lockup_frac = clamp(systems.tc_lockup_frac + (want_lock ? ramp_step : -ramp_step), 0.0, 1.0);

        double t_pump_total = t_pump_fluid;
        double t_turb_total = t_turb_fluid;
        double tcc_slip_w = 0.0;   // power burnt in the lock-up CLUTCH while it is not yet fully locked
        if (systems.tc_lockup_frac > 0.01) {
            const double lock_cap = systems.tc_lockup_frac * cfg_.drivetrain.clutch_max_torque;
            const double t_lock = solve_karnopp(engine_omega, t_engine / e.inertia, e.inertia,
                                                w_shaft, a_shaft, i_shaft / eta, lock_cap, lock_cap * 0.85);
            const double f = systems.tc_lockup_frac;
            t_pump_total = (1.0 - f) * t_pump_fluid + f * t_lock;
            t_turb_total = (1.0 - f) * t_turb_fluid + f * t_lock;
            systems.tc_lockup_engaged = (f > 0.90 && systems.clutch_locked);
            if (!systems.tc_lockup_engaged) tcc_slip_w = f * std::abs(t_lock * (engine_omega - w_shaft));
        } else {
            systems.clutch_locked = false;
            systems.tc_lockup_engaged = false;
        }

        clutch_torque = t_pump_total;
        systems.clutch_slip_rads = systems.tc_lockup_engaged ? 0.0 : (engine_omega - w_shaft);
        systems.tc_slip_ratio = systems.tc_lockup_engaged ? 1.0 : sr;
        systems.tc_torque_ratio = systems.tc_lockup_engaged ? 1.0 : lerp(tr_fluid, 1.0, systems.tc_lockup_frac);
        // Only the lock-up clutch's own slip heats and wears a friction lining. The fluid coupling's slip (pump power minus turbine
        // power) goes into the transmission fluid: feeding it to the dry-clutch wear model wore a converter's "clutch" out during
        // ordinary acceleration (clutch health 63 % after one 30 s pull).
        slip_power_w = tcc_slip_w;

        const double r_w = i_wheels / i_shaft;
        const double t_tyre_c = free_accel(x, root_) * inertia(x, root_);
        const double prop_torque = r_w * t_turb_total * G * eta - (1.0 - r_w) * t_tyre_c;
        distribute(x, root_, prop_torque);
    } else if (G != 0.0 && T_s > 0.0 && !stalled) {
        systems.tc_slip_ratio = 1.0;
        systems.tc_torque_ratio = 1.0;
        systems.tc_lockup_frac = 0.0;
        systems.tc_lockup_engaged = false;
        // Heavily damaged gearbox teeth cap transmitted torque (gearbox_health < 0.45).
        double t_gb_cap = std::numeric_limits<double>::infinity();
        if (systems.gearbox_health < 0.45) {
            const double cap_scale = clamp(0.35 + 0.65 * (systems.gearbox_health / 0.45), 0.35, 1.0);
            t_gb_cap = std::max(peak_engine_torque_, cfg_.drivetrain.clutch_max_torque * 0.6) * cap_scale;
            T_s = std::min(T_s, t_gb_cap);
            T_k = std::min(T_k, t_gb_cap);
        }

        const double eta = std::max(cfg_.drivetrain.efficiency, 0.1);
        const double i_wheels = inertia(x, root_) / (G * G);              // the wheels' inertia seen at the gearbox input
        const double i_shaft = cfg_.drivetrain.driveline_inertia + i_wheels;
        const double w_shaft = G * w_carrier;
        const double a_shaft = G * free_accel(x, root_) * i_wheels / i_shaft;
        const double dv = engine_omega - w_shaft;
        // the shaft side receives eta x the clutch torque (gear losses): to the solve it is 1/eta times heavier
        clutch_torque = solve_karnopp(engine_omega, t_engine / e.inertia, e.inertia,
                                      w_shaft, a_shaft, i_shaft / eta, T_s, T_k);
        systems.clutch_slip_rads = systems.clutch_locked ? 0.0 : dv;
        if (!systems.clutch_locked) {
            slip_power_w = std::abs(clutch_torque * dv);
        }

        // Severely worn gear teeth (gearbox_health < 0.30) can pop out of gear under sustained peak torque
        // near the weakened tooth load limit.
        bool popped_out = false;
        if (systems.gearbox_health < 0.30 && systems.engaged_gear >= 2) {
            const double pop_thresh = 0.85 * t_gb_cap;
            if (std::abs(clutch_torque) >= pop_thresh) {
                systems.popout_stress_s += h;
                if (systems.popout_stress_s >= 0.18) {
                    systems.popout_stress_s = 0.0;
                    trigger_missed_shift(in.gear, 120.0);
                    clutch_torque = 0.0;
                    systems.clutch_locked = false;
                    popped_out = true;
                }
            } else {
                systems.popout_stress_s = std::max(0.0, systems.popout_stress_s - 2.0 * h);
            }
        } else {
            systems.popout_stress_s = 0.0;
        }

        if (!popped_out) {
            // The driveline (gearbox shafts, propshaft) turns with the gearbox input, so part of the clutch torque goes into
            // spinning it up and never reaches the carrier. With the tyre torque at the carrier T_c and
            // r = (wheels' inertia at the input) / (all inertia at the input):   T_prop = r eta G T_clutch - (1 - r) T_c,
            // which makes the carrier accelerate exactly as the clutch solve above planned. (Integrating the wheels without
            // the driveline inertia made the shaft side react ~4x harder than planned: every locked-clutch correction
            // overshot, and a fully engaged clutch chattered lock / slip every step at any step rate.)
            const double r_w = i_wheels / i_shaft;
            const double t_tyre_c = free_accel(x, root_) * inertia(x, root_);
            double prop_torque = r_w * clutch_torque * G * eta - (1.0 - r_w) * t_tyre_c;

            if (systems.torsional_compliance_enabled) {
                // Passive 2nd-order half-shaft / propshaft torsional spring-damper with +-backlash_rad deadzone.
                // Driven by transmitted axle torque (prop_torque), NOT clutch slip:
                //   I_eq * theta_dd = T_in - T_out,  T_out = k * eff_twist + c * theta_dot  (outside backlash gap).
                // In steady state theta_dd = theta_dot = 0 => T_out == T_in identically (exact energy conservation,
                // zero phantom power, zero steady-state loss), while tip-in/tip-out and shifts produce authentic
                // ~10-14 Hz driveline shunt oscillations and gear-tooth backlash clunk impulses.
                const double i_ax = std::max(inertia(x, root_), 0.5);
                const double i_eq = std::max(0.5 * i_ax, 0.85);
                const double k_sh = std::max(systems.torsional_stiffness_nm_per_rad, 500.0);
                const double c_sh = std::max(systems.torsional_damping_nms_per_rad, 20.0);
                const double lash = std::max(0.0, systems.backlash_rad);

                double theta = systems.torsional_twist_rad;
                double v_th = systems.torsional_vel_rads;

                double eff_twist = 0.0;
                int cur_side = 0;
                if (theta > lash) {
                    eff_twist = theta - lash;
                    cur_side = 1;
                } else if (theta < -lash) {
                    eff_twist = theta + lash;
                    cur_side = -1;
                }

                // Unconditionally stable semi-implicit update for both in-lash (k=0) and engaged (k=k_sh) regimes.
                const double k_eff = (cur_side != 0) ? k_sh : 0.0;
                const double c_eff = (cur_side != 0) ? c_sh : (0.25 * c_sh);
                const double t_in = prop_torque;
                const double denom = 1.0 + (h / i_eq) * (c_eff + h * k_eff);
                v_th = (v_th + (h / i_eq) * (t_in - k_eff * eff_twist)) / denom;
                theta = clamp(theta + h * v_th, -0.45, 0.45);

                // Re-evaluate contact face after advancing theta so backlash impacts register on the exact substep.
                eff_twist = 0.0;
                cur_side = 0;
                if (theta > lash) {
                    eff_twist = theta - lash;
                    cur_side = 1;
                } else if (theta < -lash) {
                    eff_twist = theta + lash;
                    cur_side = -1;
                }
                if (cur_side != 0 && cur_side != systems.last_backlash_side) {
                    // Crossed the backlash gap and struck the opposite gear tooth face!
                    systems.driveline_clunk_nm = std::min(650.0, std::abs(v_th) * 35.0 + std::abs(t_in) * 0.20);
                    systems.last_backlash_side = cur_side;
                }

                systems.torsional_twist_rad = theta;
                systems.torsional_vel_rads = v_th;
                systems.torsional_twist_mean_rad += (eff_twist - systems.torsional_twist_mean_rad) * std::min(1.0, h / 0.3);

                if (cur_side == 0) {
                    prop_torque = 0.0; // free-floating briefly while traversing +-lash tooth gap
                } else {
                    const double t_shaft = k_sh * eff_twist + c_sh * v_th;
                    // Guard against wild overshoot on sudden step changes while preserving exact steady-state torque
                    const double cap = std::max(std::abs(t_in) * 1.45 + 350.0, 600.0);
                    prop_torque = clamp(t_shaft, -cap, cap);
                }
            }
            distribute(x, root_, prop_torque);
        }
    } else if (G == 0.0 && !stalled) {
        // Neutral / synchronizing: couple engine to free gearbox input shaft if clutch is clamped,
        // otherwise coast input shaft with light gear-oil churning drag (unless synchro cone is driving it).
        const double I_in = std::max(cp.input_shaft_inertia_kgm2, 0.002);
        if (T_s > 0.0) {
            const double oil_drag = -0.015 * systems.input_shaft_omega;
            const double dv = engine_omega - systems.input_shaft_omega;
            clutch_torque = solve_karnopp(engine_omega, t_engine / e.inertia, e.inertia,
                                          systems.input_shaft_omega, oil_drag / I_in, I_in, T_s, T_k);
            systems.input_shaft_omega += h * (clutch_torque + oil_drag) / I_in;
            systems.clutch_slip_rads = systems.clutch_locked ? 0.0 : dv;
            if (!systems.clutch_locked) slip_power_w = std::abs(clutch_torque * dv);
        } else {
            systems.clutch_locked = false;
            systems.clutch_slip_rads = engine_omega - systems.input_shaft_omega;
            if (systems.sync_state != SyncState::Synchronizing) {
                systems.input_shaft_omega *= std::max(0.0, 1.0 - h * 0.015 / I_in);
            }
        }
    } else {
        systems.clutch_locked = false;
        systems.clutch_slip_rads = engine_omega - systems.input_shaft_omega;
    }

    // ---- Clutch Disc Thermal & Wear Model
    // Slip power P = |T_clutch * delta_omega| heats the disc; convective airflow + flywheel windage cools it.
    // Overheating (> 260 C) causes lining friction fade; high-power slip accumulates wear (clutch_health).
    {
        const double amb_c = in.atmosphere_enabled ? in.ambient_air_c : 25.0;
        const double h_cool = cp.cooling_base_w_per_k
                            + cp.cooling_per_mps_w_per_k * std::abs(in.airspeed_mps)
                            + cp.cooling_per_rads_w_per_k * std::abs(engine_omega);
        const double p_cool = h_cool * (systems.clutch_temp_c - amb_c);
        const double c_th = std::max(cp.thermal_capacity_j_per_k, 100.0);
        systems.clutch_temp_c = clamp(systems.clutch_temp_c + h * (slip_power_w - p_cool) / c_th, amb_c, 650.0);
        if (slip_power_w > 1.0) {
            const double overheat = std::max(0.0, (systems.clutch_temp_c - 240.0) / 40.0);
            const double temp_mult = 1.0 + overheat * overheat;
            systems.clutch_health = clamp(systems.clutch_health - slip_power_w * h * cp.wear_per_joule * temp_mult, 0.0, 1.0);
        }
    }

    // ---- engine speed
    if (!stalled) {
        engine_omega += h * (t_engine - clutch_torque) / e.inertia;
        if (engine_omega < 0.3 * idle_w) {                // dragged below ~300 rpm: stall
            stalled = true;
            engine_omega = 0;
            systems.clutch_locked = false;
        }
    }

    // ---- Hybrid ERS / MGU-K electric deployment, Brake-by-Wire (BBW) regen & Dynamic Brake Migration (BMIG)
    const double bmig = (in.brake_migration_override >= -0.5) ? in.brake_migration_override : cfg_.brake_migration_front;
    const double bias = clamp(cfg_.brake_bias_front + in.brake_bias_offset - bmig * (1.0 - clamp(in.brake, 0.0, 1.0)), 0.35, 0.85);
    systems.effective_brake_bias_front = bias;

    std::array<double, 4> hybrid_drive_nm{};
    std::array<double, 4> hybrid_regen_nm{};
    systems.hybrid_deploy_kw = 0.0;
    systems.hybrid_regen_kw = 0.0;
    systems.hybrid_bbw_active = false;

    const HybridParams& hy = cfg_.drivetrain.hybrid;
    if (hy.enabled) {
        const int w0 = hy.front_axle_motor ? FL : RL;
        const int w1 = hy.front_axle_motor ? FR : RR;
        const double w_ax = 0.5 * (wheel_omega[w0] + wheel_omega[w1]);
        const double abs_w_ax = std::max(std::abs(w_ax), 1.0);
        const double cap_j = std::max(hy.battery_capacity_mj * 1.0e6, 2.0e5);
        // Thermal derating above 58 C (protects HV lithium cells during repeated hot laps)
        const double batt_derate = systems.hybrid_battery_temp_c > 58.0
                                 ? clamp(1.0 - (systems.hybrid_battery_temp_c - 58.0) / 28.0, 0.35, 1.0) : 1.0;

        // 1. Electric motor deployment (e-AWD front motor or rear MGU-K)
        const bool speed_ok = (!hy.front_axle_motor) || (in.airspeed_mps >= hy.front_deploy_min_speed_mps);
        const double deploy_cmd = clamp(in.hybrid_deploy_mode, 0.0, 1.0) * clamp(in.throttle, 0.0, 1.0);
        if (speed_ok && deploy_cmd > 0.05 && in.brake < 0.05 && systems.hybrid_soc > 0.02 && in.gear >= 2) {
            const double p_max_w = hy.max_deploy_kw * 1000.0 * batt_derate * deploy_cmd;
            const double t_ax = std::min(hy.max_torque_nm * deploy_cmd * batt_derate, p_max_w / abs_w_ax);
            hybrid_drive_nm[w0] = 0.5 * t_ax;
            hybrid_drive_nm[w1] = 0.5 * t_ax;
            const double p_act_w = t_ax * std::max(0.0, w_ax);
            systems.hybrid_deploy_kw = p_act_w * 0.001;
            systems.hybrid_soc = clamp(systems.hybrid_soc - (p_act_w / 0.92) * h / cap_j, 0.0, 1.0);
        }

        // 2. MGU-K regenerative braking harvest & Brake-by-Wire hydraulic torque blending
        if (in.brake > 0.03 && systems.hybrid_soc < 0.995 && w_ax > 2.5) {
            const double p_reg_max_w = hy.max_regen_kw * 1000.0 * batt_derate * clamp(in.brake, 0.0, 1.0);
            const double ax_share = hy.front_axle_motor ? bias : (1.0 - bias);
            const double req_ax_brake_nm = in.brake * cfg_.brake_torque_total * ax_share * in.brake_power_scale;
            // Respect per-wheel ABS pressure reduction so regen never locks the axle over bumps!
            const double abs_min = std::min(in.brake_scale[w0], in.brake_scale[w1]);
            const double t_reg_ax = std::min({hy.max_torque_nm * batt_derate, p_reg_max_w / abs_w_ax, req_ax_brake_nm * abs_min});
            if (t_reg_ax > 1.0) {
                hybrid_regen_nm[w0] = 0.5 * t_reg_ax;
                hybrid_regen_nm[w1] = 0.5 * t_reg_ax;
                const double p_harv_w = t_reg_ax * w_ax;
                systems.hybrid_regen_kw = p_harv_w * 0.001;
                systems.hybrid_soc = clamp(systems.hybrid_soc + (p_harv_w * 0.88) * h / cap_j, 0.0, 1.0);
                systems.hybrid_bbw_active = hy.brake_by_wire;
            }
        }

        // 3. HV battery pack thermal balance (I^2*R ohmic heating vs coolant loop)
        const double batt_amb = in.atmosphere_enabled ? in.ambient_air_c : 25.0;
        const double p_loss_kw = (systems.hybrid_deploy_kw + systems.hybrid_regen_kw) * 0.09;
        const double d_tb = (p_loss_kw * 0.85 - (0.04 + 0.0012 * std::abs(in.airspeed_mps)) * (systems.hybrid_battery_temp_c - batt_amb)) * h;
        systems.hybrid_battery_temp_c = clamp(systems.hybrid_battery_temp_c + d_tb, batt_amb, 90.0);
    }

    // ---- wheels: I dw/dt = T_drive + T_tyre, then brakes/rolling resistance + damaged bearing drag
    for (int w = 0; w < 4; ++w) {
        const double I = cfg_.tire(w).inertia;
        const double eff_drive = in.wheel_drive_severed[w] ? 0.0 : (drive[w] + hybrid_drive_nm[w]);
        wheel_omega[w] += h * (eff_drive + tyre_torque[w]) / I;
        double t_brake = in.brake * cfg_.brake_torque_total * (w < 2 ? bias : 1 - bias) * 0.5 * in.brake_scale[w];
        // Line lock: a solenoid holds the front calipers at a set pressure (not modulated by ABS); the rears stay free.
        if (w < 2 && in.line_lock > 0) t_brake = std::max(t_brake, in.line_lock * cfg_.brake_torque_total * bias * 0.5);
        t_brake += in.handbrake * cfg_.axle(w).handbrake_torque + in.extra_brake[w];
        t_brake *= in.brake_power_scale * in.pad_mu[w];  // cooked brakes (damage) and pad temperature
        // Brake-by-Wire (BBW): subtract MGU-K regen torque from hydraulic disc torque so total stopping torque stays constant
        // (and hydraulic discs run noticeably cooler under regen!)
        const double t_hyd = systems.hybrid_bbw_active ? std::max(0.0, t_brake - hybrid_regen_nm[w]) : t_brake;
        // Wheel-lock rotational pad stiction hysteresis: once a wheel locks under firm braking without ABS, static pad
        // friction is ~8% higher than kinetic friction so the driver must bleed pressure slightly to unlock the wheel.
        const bool locked_stiction = (in.brake > 0.15 && in.brake_scale[w] > 0.98 && in.airspeed_mps > 5.0 && std::abs(wheel_omega[w]) < 2.2);
        const double t_hyd_eff = locked_stiction ? (t_hyd * 1.08) : t_hyd;
        brake_torque[w] = t_hyd_eff; // hydraulic caliper friction heats the rotor (MGU-K regen does not heat brake discs!)
        double dw = h * (t_hyd_eff + hybrid_regen_nm[w] + rolling_torque[w] + in.bearing_drag_nm[w]) / I;
        wheel_omega[w] = std::abs(wheel_omega[w]) <= dw ? 0.0 : wheel_omega[w] - sign(wheel_omega[w]) * dw;
    }
}

}  // namespace rs
