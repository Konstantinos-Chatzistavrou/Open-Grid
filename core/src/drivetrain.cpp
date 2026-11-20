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

void Drivetrain::step(const DrivetrainInput& in, const std::array<double, 4>& tyre_torque,
                      const std::array<double, 4>& rolling_torque, double h) {
    const EngineParams& e = cfg_.engine;
    const double idle_w = e.idle_rpm * kRpmToRad;
    std::array<double, 4> drive{};
    Ctx x{nodes_, cfg_, wheel_omega, tyre_torque, drive, h};

    // ---- Transmission Archetype: H-Pattern Synchro Grind, Sequential Dog-Box Ignition Cut, or Dual-Clutch (DCT)
    if (systems.engaged_gear < 0) systems.engaged_gear = in.gear;
    if (systems.grind_timer_s > 0.0) {
        systems.grind_timer_s = std::max(0.0, systems.grind_timer_s - h);
        if (systems.grind_timer_s <= 0.0) systems.gear_grind = false;
    }
    if (systems.shift_cut_timer_s > 0.0) {
        systems.shift_cut_timer_s = std::max(0.0, systems.shift_cut_timer_s - h);
        if (systems.shift_cut_timer_s <= 0.0) systems.shift_cut_active = false;
    }

    if (in.gear != systems.engaged_gear) {
        if (systems.transmission == TransmissionType::HPatternSynchro && systems.strict_h_pattern_synchro && in.gear > 1) {
            const double target_g = gear_ratio(in.gear);
            const double target_rpm = std::abs(target_g * speed(x, root_)) / kRpmToRad;
            const double rpm_diff = std::abs(engine_rpm() - target_rpm);
            // Without clutch (> 0.50) OR close rev-match (< 750 RPM diff), synchro dogs clash and grind!
            if (in.clutch < 0.50 && rpm_diff > 750.0) {
                systems.gear_grind = true;
                systems.grind_timer_s = 0.28;
                systems.engaged_gear = 1; // kicked out to Neutral
            } else {
                systems.engaged_gear = in.gear;
                systems.gear_grind = false;
            }
        } else {
            if (in.gear > systems.engaged_gear && systems.engaged_gear >= 2 && in.throttle > 0.35) {
                if (systems.transmission == TransmissionType::SequentialDogBox && systems.dog_box_flat_shift_cut) {
                    systems.shift_cut_active = true;
                    systems.shift_cut_timer_s = 0.055; // 55 ms dog-box flat-shift ignition cut
                } else if (systems.transmission == TransmissionType::DualClutchDct) {
                    systems.shift_cut_active = false;
                    systems.shift_cut_timer_s = 0.015; // 15 ms DCT overlap
                }
            }
            systems.engaged_gear = in.gear;
        }
    }

    const double G = gear_ratio(systems.engaged_gear);
    // Holding the starter button disengages the clutch interlock so the starter motor doesn't crank against locked wheels
    const double eff_clutch = in.starter_crank ? 1.0 : in.clutch;
    const double clutch_cap = cfg_.drivetrain.clutch_max_torque * clamp(1.0 - eff_clutch, 0.0, 1.0);

    // ---- engine torque & physical starter cranking
    if (stalled && (eff_clutch > 0.9 || G == 0.0 || in.starter_crank)) {
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
        if (rpm > e.redline_rpm) thr = 0;               // rev limiter (fuel cut)
        if (systems.shift_cut_active) thr = 0;          // sequential dog-box flat-shift ignition cut
        if (systems.fuel_consumption_enabled && systems.fuel_liters <= 0.0) thr = 0; // out of fuel

        // ---- Turbocharger spool, boost pressure, Blow-Off Valve (BOV) & Intercooler Heat Soak (IAT)
        double turbo_mult = 1.0;
        if (systems.turbo_stage > 0) {
            const double max_boost = max_boost_for_stage(systems.turbo_stage);
            const double rpm_norm = clamp((rpm - e.idle_rpm) / std::max(e.redline_rpm - e.idle_rpm, 1000.0), 0.0, 1.0);
            // DCT shifts keep throttle plate/boost pre-loaded; normal throttle lift vents BOV
            const double eff_thr_for_boost = (systems.transmission == TransmissionType::DualClutchDct && systems.shift_cut_timer_s > 0.0)
                                           ? std::max(thr, in.throttle) : thr;
            const double exhaust_flow = clamp((rpm_norm - 0.18) / 0.55, 0.0, 1.0) * eff_thr_for_boost;
            const double target_boost = eff_thr_for_boost > 0.15 ? exhaust_flow * max_boost : -0.35 * (1.0 - eff_thr_for_boost);
            const double tau_spool = (target_boost > systems.boost_bar) ? (0.14 + 0.05 * systems.turbo_stage) : 0.065;
            if (eff_thr_for_boost < 0.12 && systems.boost_bar > 0.32) {
                systems.bov_venting = true;
                systems.bov_timer_s = 0.22;
            }
            systems.boost_bar += (target_boost - systems.boost_bar) * std::min(1.0, h / tau_spool);
            if (systems.bov_timer_s > 0.0) {
                systems.bov_timer_s = std::max(0.0, systems.bov_timer_s - h);
                if (systems.bov_timer_s <= 0.0) systems.bov_venting = false;
            }
            // Adiabatic compressor heating + air-to-air intercooler heat soak:
            // Compressor discharge temp rises with pressure ratio PR = 1 + boost; airflow cools the intercooler core
            const double pr = 1.0 + std::max(0.0, systems.boost_bar);
            const double t_comp_c = 25.0 + 298.15 * (std::pow(pr, 0.286) - 1.0) / 0.72;
            const double airflow_eff = clamp(systems.intercooler_eff * (0.45 + 0.55 * std::min(1.0, std::abs(in.airspeed_mps) / 38.0))
                                             * in.radiator_cooling_scale, 0.15, 0.92);
            const double target_iat = t_comp_c - airflow_eff * (t_comp_c - 25.0);
            systems.intake_air_temp_c += (target_iat - systems.intake_air_temp_c) * std::min(1.0, h * 0.45);
            systems.iat_power_factor = systems.intake_air_temp_c > 52.0
                                     ? clamp(1.0 - (systems.intake_air_temp_c - 52.0) * 0.0025, 0.85, 1.0) : 1.0;

            if (systems.boost_bar > 0.0) {
                turbo_mult += systems.boost_bar * 0.24;
            }
            turbo_mult *= systems.iat_power_factor;
        } else {
            systems.boost_bar = 0.0;
            systems.bov_venting = false;
            systems.bov_timer_s = 0.0;
            systems.intake_air_temp_c = 28.0;
            systems.iat_power_factor = 1.0;
        }

        // ---- Nitrous Oxide (N2O) injection (requires WOT > 0.70, RPM > 2600, bottle > 0)
        double nos_mult = 1.0;
        if (in.nos_active && systems.nos_bottles_l > 0.0 && thr > 0.70 && rpm > 2600.0) {
            const double consumed = std::min(systems.nos_bottles_l, 0.42 * h);
            systems.nos_bottles_l = std::max(0.0, systems.nos_bottles_l - consumed);
            nos_mult = 1.26;
        }

        // ---- Engine Oil Thermodynamics (scaled by Radiator Puncture Factor) & Mechanical Health / Misfires
        const double rpm_frac = clamp(rpm / std::max(e.redline_rpm, 1000.0), 0.0, 1.2);
        const double heat_load = (14.0 * rpm_frac * rpm_frac * (0.3 + 0.7 * thr))
                               * (1.0 + 0.35 * std::max(0.0, systems.boost_bar))
                               * (nos_mult > 1.0 ? 1.45 : 1.0);
        const double cooling = (0.16 + 0.008 * std::max(0.0, in.airspeed_mps))
                             * clamp(in.radiator_cooling_scale, 0.15, 1.0)
                             * (systems.oil_temp_c - 82.0);
        systems.oil_temp_c = clamp(systems.oil_temp_c + h * (heat_load - cooling) * 0.12, 20.0, 165.0);

        if (systems.wear_enabled && (systems.oil_temp_c > 128.0 || rpm > e.redline_rpm * 0.985)) {
            const double abuse = (systems.oil_temp_c > 128.0 ? (systems.oil_temp_c - 128.0) * 0.00015 : 0.0)
                               + (rpm > e.redline_rpm * 0.985 ? 0.00025 : 0.0);
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

        // ---- BSFC Fuel Consumption (~250 g/kWh under load + idle flow)
        if (systems.fuel_consumption_enabled && systems.fuel_liters > 0.0) {
            const double pos_power_kw = std::max(0.0, t_engine * engine_omega) / 1000.0;
            const double fuel_kg_per_s = 0.00022 + pos_power_kw * (0.255 / 3600.0) * (1.0 + 0.18 * std::max(0.0, systems.boost_bar));
            systems.fuel_liters = std::max(0.0, systems.fuel_liters - (fuel_kg_per_s / 0.745) * h);
        }
    }

    // ---- clutch & optional torsional halfshaft wind-up / mechanical backlash clunk
    clutch_torque = 0;
    systems.driveline_clunk_nm = 0.0;
    if (G != 0.0 && clutch_cap > 0 && !stalled) {
        double i_shaft = cfg_.drivetrain.driveline_inertia + inertia(x, root_) / (G * G);
        double w_carrier = speed(x, root_);
        double w_shaft = G * w_carrier;
        double a_shaft = G * free_accel(x, root_) * (inertia(x, root_) / (G * G)) / i_shaft;
        clutch_torque = coulomb(engine_omega, t_engine / e.inertia, e.inertia, w_shaft, a_shaft, i_shaft, h, clutch_cap);
        double prop_torque = clutch_torque * G * cfg_.drivetrain.efficiency;

        if (systems.torsional_compliance_enabled) {
            // Integrate torsional twist between diff output and halfshafts with +-backlash_rad deadzone
            const double i_ax = std::max(inertia(x, root_), 0.5);
            const double d_omega = (engine_omega / G) - w_carrier;
            systems.torsional_twist_rad = clamp(systems.torsional_twist_rad + d_omega * h, -0.35, 0.35);
            systems.torsional_vel_rads = d_omega;
            const double lash = systems.backlash_rad;
            double eff_twist = 0.0;
            int cur_side = 0;
            if (systems.torsional_twist_rad > lash) {
                eff_twist = systems.torsional_twist_rad - lash;
                cur_side = 1;
            } else if (systems.torsional_twist_rad < -lash) {
                eff_twist = systems.torsional_twist_rad + lash;
                cur_side = -1;
            }
            if (cur_side != 0 && cur_side != systems.last_backlash_side) {
                // Crossed the backlash gap and struck the opposite gear tooth face!
                systems.driveline_clunk_nm = std::min(650.0, std::abs(d_omega) * 55.0 + std::abs(prop_torque) * 0.25);
                systems.last_backlash_side = cur_side;
            }
            if (cur_side == 0) {
                prop_torque = 0.0; // free-floating inside backlash deadzone
            } else {
                const double spring_t = eff_twist * systems.torsional_stiffness_nm_per_rad
                                      + d_omega * systems.torsional_damping_nms_per_rad;
                prop_torque = 0.65 * prop_torque + 0.35 * clamp(spring_t, -std::abs(prop_torque) * 1.6 - 400.0, std::abs(prop_torque) * 1.6 + 400.0);
                (void)i_ax;
            }
        }
        distribute(x, root_, prop_torque);
    }

    // ---- engine speed
    if (!stalled) {
        engine_omega += h * (t_engine - clutch_torque) / e.inertia;
        if (engine_omega < 0.3 * idle_w) {                // dragged below ~300 rpm: stall
            stalled = true;
            engine_omega = 0;
        }
    }

    // ---- wheels: I dw/dt = T_drive + T_tyre, then brakes/rolling resistance + damaged bearing drag
    const double bias = cfg_.brake_bias_front;
    for (int w = 0; w < 4; ++w) {
        const double I = cfg_.tire(w).inertia;
        wheel_omega[w] += h * (drive[w] + tyre_torque[w]) / I;
        double t_brake = in.brake * cfg_.brake_torque_total * (w < 2 ? bias : 1 - bias) * 0.5 * in.brake_scale[w];
        t_brake += in.handbrake * cfg_.axle(w).handbrake_torque + in.extra_brake[w];
        t_brake *= in.brake_power_scale * in.pad_mu[w];  // cooked brakes (damage) and pad temperature
        brake_torque[w] = t_brake;
        double dw = h * (t_brake + rolling_torque[w] + in.bearing_drag_nm[w]) / I;
        wheel_omega[w] = std::abs(wheel_omega[w]) <= dw ? 0.0 : wheel_omega[w] - sign(wheel_omega[w]) * dw;
    }
}

}  // namespace rs
