// Dual-Rating Esports Matchmaking and Virtual-Track Performance Index / BoP Equalizer.
#include "rs/esports.hpp"
#include <algorithm>
#include <cmath>
#include "rs/tire.hpp"

namespace rs {

DriverGrade DriverRatingProfile::driver_grade() const {
    if (skill_mmr >= 2600.0) return DriverGrade::S;
    if (skill_mmr >= 2250.0) return DriverGrade::APlus;
    if (skill_mmr >= 1900.0) return DriverGrade::A;
    if (skill_mmr >= 1500.0) return DriverGrade::B;
    if (skill_mmr >= 1200.0) return DriverGrade::C;
    if (skill_mmr >= 950.0) return DriverGrade::D;
    return DriverGrade::E;
}

SafetyGrade DriverRatingProfile::safety_grade() const {
    if (bad_sport_quarantined || safety_score < 25.0) return SafetyGrade::E_BadSport;
    if (safety_score >= 90.0) return SafetyGrade::S_Clean;
    if (safety_score >= 80.0) return SafetyGrade::A;
    if (safety_score >= 65.0) return SafetyGrade::B;
    if (safety_score >= 45.0) return SafetyGrade::C;
    return SafetyGrade::D;
}

void record_corner_evaluation(DriverRatingProfile& p, bool off_track_cut, double contact_impact_kj) {
    const bool is_clean = (!off_track_cut && contact_impact_kj <= 12.0);
    if (is_clean) {
        ++p.clean_corners_streak;
        p.safety_score = clamp(p.safety_score + 0.55, 0.0, 100.0);
        p.rolling_cpi = clamp(p.rolling_cpi * 0.96 + 2.2, 1.0, 200.0);
        if (p.bad_sport_quarantined && p.clean_corners_streak >= 15) {
            p.safety_score = std::max(p.safety_score, 30.0);
            if (p.safety_score >= 30.0) {
                p.bad_sport_quarantined = false;
            }
        }
    } else {
        p.clean_corners_streak = 0;
        const double penalty = (contact_impact_kj > 22.0) ? 7.0 : 2.2;
        p.safety_score = clamp(p.safety_score - penalty, 0.0, 100.0);
        const double cpi_decay = (contact_impact_kj > 22.0) ? 0.68 : 0.85;
        p.rolling_cpi = clamp(p.rolling_cpi * cpi_decay, 1.0, 200.0);
        if (p.safety_score < 25.0) {
            p.bad_sport_quarantined = true;
        }
    }
}

void update_race_ratings(std::vector<DriverRatingProfile>& finishers_in_order) {
    const std::size_t n = finishers_in_order.size();
    if (n < 2) return;

    std::vector<double> old_mmr(n);
    std::vector<double> old_rd(n);
    for (std::size_t i = 0; i < n; ++i) {
        old_mmr[i] = finishers_in_order[i].skill_mmr;
        old_rd[i] = finishers_in_order[i].rating_deviation;
    }

    const double pair_norm = static_cast<double>(n - 1);
    for (std::size_t i = 0; i < n; ++i) {
        const double k_factor = clamp(old_rd[i] * 0.18, 12.0, 42.0);
        double score_delta_sum = 0.0;

        for (std::size_t j = 0; j < n; ++j) {
            if (i == j) continue;
            // Glicko-2 opponent uncertainty attenuation g(RD_j)
            const double q_rd = old_rd[j] / 400.0;
            const double g_rd = 1.0 / std::sqrt(1.0 + (3.0 * q_rd * q_rd) / (kPi * kPi));
            const double expected = 1.0 / (1.0 + std::pow(10.0, -g_rd * (old_mmr[i] - old_mmr[j]) / 400.0));
            const double actual = (i < j) ? 1.0 : 0.0;
            score_delta_sum += (actual - expected);
        }

        const double mmr_delta = k_factor * (score_delta_sum / pair_norm);
        finishers_in_order[i].skill_mmr = clamp(old_mmr[i] + mmr_delta, 800.0, 3200.0);
        finishers_in_order[i].rating_deviation = std::max(45.0, old_rd[i] * 0.92);
    }
}

bool can_matchmake_pair(const DriverRatingProfile& a, const DriverRatingProfile& b, double max_mmr_gap) {
    if (a.bad_sport_quarantined != b.bad_sport_quarantined) {
        return false;
    }
    if (std::abs(a.skill_mmr - b.skill_mmr) > max_mmr_gap) {
        return false;
    }
    const int sr_diff = std::abs(static_cast<int>(a.safety_grade()) - static_cast<int>(b.safety_grade()));
    return sr_diff <= 2;
}

namespace {

PiClass classify_pi(int pi_val) {
    if (pi_val >= 900) return PiClass::X;
    if (pi_val >= 800) return PiClass::S2;
    if (pi_val >= 700) return PiClass::S1;
    if (pi_val >= 600) return PiClass::A;
    if (pi_val >= 500) return PiClass::B;
    if (pi_val >= 400) return PiClass::C;
    return PiClass::D;
}

double compute_wheel_peak_power_kw(const CarConfig& cfg) {
    const double eff = clamp(cfg.drivetrain.efficiency, 0.5, 1.0);
    if (cfg.engine.torque_curve.empty()) {
        return 220.0 * eff;
    }
    double max_kw = 0.0;
    for (const auto& pt : cfg.engine.torque_curve) {
        const double rpm = std::max(0.0, pt[0]);
        const double torque_nm = std::max(0.0, pt[1]);
        const double omega = rpm * (2.0 * kPi / 60.0);
        const double kw = (torque_nm * omega * eff) / 1000.0;
        if (kw > max_kw) {
            max_kw = kw;
        }
    }
    return std::max(25.0, max_kw);
}

// Effective peak friction using Pacejka load sensitivity (pdx2 / pdy2).
double effective_mu_long(const TireParams& t, double fz_per_tire) {
    const double fz0 = std::max(500.0, t.fz0);
    const double dfz = (fz_per_tire - fz0) / fz0;
    const double sens = (t.pdx2 < 0.0) ? t.pdx2 : -0.08;
    return clamp(t.mu_x + sens * dfz, 0.35, 3.0);
}

double effective_mu_lat(const TireParams& t, double fz_per_tire, double cg_height, double track) {
    const double fz0 = std::max(500.0, t.fz0);
    const double dfz = (fz_per_tire - fz0) / fz0;
    const double sens = (t.pdy2 < 0.0) ? t.pdy2 : -0.10;
    const double roll_penalty = 0.10 * std::abs(sens) * (2.0 * cg_height / std::max(1.0, track));
    return clamp(t.mu_y + sens * dfz - roll_penalty, 0.35, 3.0);
}

}  // namespace

PerformanceIndexReport compute_performance_index(const CarConfig& cfg) {
    PerformanceIndexReport rep;
    const double mass = std::max(400.0, cfg.mass);
    const double weight_n = mass * kGravity;
    const double wf = clamp(cfg.weight_front, 0.25, 0.75);
    const double wr = 1.0 - wf;
    const double rho = std::max(0.5, cfg.aero.air_density);
    const double cda = std::max(0.20, cfg.aero.drag_area);
    const double cla = cfg.aero.lift_area;
    const double aero_front = clamp(cfg.aero.front_balance, 0.1, 0.9);
    const double c_rr = 0.5 * (cfg.tire_front.rolling_resistance + cfg.tire_rear.rolling_resistance);

    // 1. Peak wheel power (kW) and power-to-weight (kW / tonne)
    rep.peak_power_kw = compute_wheel_peak_power_kw(cfg);
    rep.power_to_weight_kw_per_t = rep.peak_power_kw / (mass / 1000.0);
    const double peak_power_w = rep.peak_power_kw * 1000.0;

    // 2. Aero drag-limited top speed (km/h)
    double v_lo = 15.0;
    double v_hi = 145.0;
    for (int iter = 0; iter < 30; ++iter) {
        const double v_mid = 0.5 * (v_lo + v_hi);
        const double q_dyn = 0.5 * rho * v_mid * v_mid;
        const double f_drag = q_dyn * cda;
        const double f_down = std::max(0.0, q_dyn * cla);
        const double f_rr = c_rr * (weight_n + f_down);
        const double p_req = (f_drag + f_rr) * v_mid;
        if (p_req < peak_power_w) {
            v_lo = v_mid;
        } else {
            v_hi = v_mid;
        }
    }
    rep.top_speed_kmh = 0.5 * (v_lo + v_hi) * 3.6;

    // 3. Traction + power-integrated 0 to 100 km/h (27.7778 m/s) acceleration time (s)
    const bool is_awd = (cfg.drivetrain.layout == "awd") || (cfg.front.driven && cfg.rear.driven);
    const bool is_fwd = (!is_awd) && ((cfg.drivetrain.layout == "fwd") || (cfg.front.driven && !cfg.rear.driven));
    const double v_target = 100.0 / 3.6;
    const int n_steps = 80;
    const double dv = v_target / static_cast<double>(n_steps);
    double t_0_100 = 0.24; // clutch release & shift transient overhead
    const double avg_band_power_w = 0.87 * peak_power_w;
    const double h_over_l = clamp(cfg.cg_height / std::max(1.5, cfg.wheelbase), 0.10, 0.35);

    for (int i = 0; i < n_steps; ++i) {
        const double v = (static_cast<double>(i) + 0.5) * dv;
        const double q_dyn = 0.5 * rho * v * v;
        const double f_down = q_dyn * cla;
        const double f_drag = q_dyn * cda;
        const double f_rr = c_rr * (weight_n + std::max(0.0, f_down));

        double f_trac = 0.0;
        if (is_awd) {
            const double fz_f = weight_n * wf + f_down * aero_front;
            const double fz_r = weight_n * wr + f_down * (1.0 - aero_front);
            const double mu_f = effective_mu_long(cfg.tire_front, 0.5 * fz_f);
            const double mu_r = effective_mu_long(cfg.tire_rear, 0.5 * fz_r);
            f_trac = mu_f * fz_f + mu_r * fz_r;
        } else if (is_fwd) {
            const double fz_f = std::max(500.0, weight_n * (wf - 0.35 * h_over_l) + f_down * aero_front);
            const double mu_f = effective_mu_long(cfg.tire_front, 0.5 * fz_f);
            f_trac = mu_f * fz_f;
        } else {
            const double fz_r = weight_n * (wr + 0.45 * h_over_l) + f_down * (1.0 - aero_front);
            const double mu_r = effective_mu_long(cfg.tire_rear, 0.5 * fz_r);
            f_trac = mu_r * fz_r;
        }

        const double f_pow = avg_band_power_w / std::max(v, 4.2);
        const double f_net = std::max(300.0, std::min(f_trac, f_pow) - f_drag - f_rr);
        const double accel = f_net / (1.05 * mass);
        t_0_100 += dv / accel;
    }
    rep.sim_0_to_100_kmh_s = t_0_100;

    // 4. Pacejka + aero downforce 100 to 0 km/h braking distance (m)
    const double mean_radius = std::max(0.22, 0.5 * (cfg.tire_front.radius + cfg.tire_rear.radius));
    const double f_brake_hw = std::max(4000.0, cfg.brake_torque_total / mean_radius);
    double brake_dist_m = 0.0;
    for (int i = 0; i < n_steps; ++i) {
        const double v = (static_cast<double>(i) + 0.5) * dv;
        const double q_dyn = 0.5 * rho * v * v;
        const double f_down = q_dyn * cla;
        const double f_drag = q_dyn * cda;
        const double f_rr = c_rr * (weight_n + std::max(0.0, f_down));

        const double transfer_n = weight_n * 0.95 * h_over_l;
        const double fz_f = std::max(400.0, weight_n * wf + f_down * aero_front + transfer_n);
        const double fz_r = std::max(300.0, weight_n * wr + f_down * (1.0 - aero_front) - transfer_n);

        // Evaluate Pacejka pure longitudinal peak force on front and rear axles
        const double fx_f1 = std::abs(mf_pure_fx(cfg.tire_front, -0.14, 0.5 * fz_f, 1.0));
        const double fx_r1 = std::abs(mf_pure_fx(cfg.tire_rear, -0.14, 0.5 * fz_r, 1.0));
        const double f_tire_mf = 2.0 * (fx_f1 + fx_r1);
        const double f_tire_emp = effective_mu_long(cfg.tire_front, 0.5 * fz_f) * fz_f +
                                  effective_mu_long(cfg.tire_rear, 0.5 * fz_r) * fz_r;
        const double f_tire_brake = 0.5 * (f_tire_mf + f_tire_emp);

        const double f_decel = std::min(f_tire_brake, 1.45 * f_brake_hw) + f_drag + f_rr;
        const double decel = std::max(2.0, f_decel / mass);
        brake_dist_m += (v * dv) / decel;
    }
    rep.sim_100_to_0_braking_m = brake_dist_m;

    // 5. Steady-state lateral G on a 120 m radius corner at 40 m/s
    const double v_corner_ref = 40.0;
    const double q_corner = 0.5 * rho * v_corner_ref * v_corner_ref;
    const double f_down_corner = q_corner * cla;
    const double fz_f_corner = std::max(300.0, weight_n * wf + f_down_corner * aero_front);
    const double fz_r_corner = std::max(300.0, weight_n * wr + f_down_corner * (1.0 - aero_front));

    const double mu_yf = effective_mu_lat(cfg.tire_front, 0.5 * fz_f_corner, cfg.cg_height, cfg.front.track);
    const double mu_yr = effective_mu_lat(cfg.tire_rear, 0.5 * fz_r_corner, cfg.cg_height, cfg.rear.track);
    const double fy_total = mu_yf * fz_f_corner + mu_yr * fz_r_corner;
    rep.cornering_g_120m = clamp(fy_total / weight_n, 0.40, 3.50);

    // 6. Standardized 2.4 km virtual benchmark circuit lap time (s)
    // Combines cornering speed (120 m & medium corners), acceleration out of corners,
    // high-speed straight sector, and braking zones (~52 s hypercars to ~95 s slow street cars).
    const double v_apex = std::sqrt(rep.cornering_g_120m * kGravity * 85.0);
    const double t_corners = 890.0 / v_apex;
    const double t_accel = 2.05 * rep.sim_0_to_100_kmh_s + 920.0 / (rep.power_to_weight_kw_per_t + 35.0);
    const double t_straights = 820.0 / (0.68 * (rep.top_speed_kmh / 3.6) + 0.32 * v_apex);
    const double t_braking = 0.18 * rep.sim_100_to_0_braking_m + 8.8;

    rep.virtual_benchmark_lap_s = clamp(t_corners + t_accel + t_straights + t_braking, 48.0, 105.0);

    // Map virtual_benchmark_lap_s monotonically to PI (100..999):
    // 95.0 s -> PI 100, 67.5 s -> PI 650, 50.05 s -> PI 999 (20.0 PI points per second).
    const double pi_cont = 100.0 + (95.0 - rep.virtual_benchmark_lap_s) * 20.0;
    rep.pi = static_cast<int>(clamp(std::floor(pi_cont + 0.5), 100.0, 999.0));
    rep.pi_class = classify_pi(rep.pi);
    return rep;
}

BopAdjustment compute_bop_equalizer(const CarConfig& cfg, int target_pi) {
    const int clamped_target_pi = static_cast<int>(clamp(static_cast<double>(target_pi), 100.0, 999.0));
    const double target_lap_s = 95.0 - (static_cast<double>(clamped_target_pi) - 100.0) / 20.0;

    CarConfig base_cfg = cfg;
    if (base_cfg.engine.torque_curve.empty()) {
        base_cfg.engine.torque_curve = {{1000.0, 350.0}, {4500.0, 480.0}, {7000.0, 430.0}};
    }

    auto make_candidate = [&](double ballast, double power_scale) {
        BopAdjustment cand;
        cand.ballast_kg = clamp(ballast, 0.0, 200.0);
        cand.power_restrictor_scale = clamp(power_scale, 0.65, 1.15);
        cand.balanced_config = base_cfg;
        cand.balanced_config.mass = base_cfg.mass + cand.ballast_kg;
        for (auto& pt : cand.balanced_config.engine.torque_curve) {
            pt[1] *= cand.power_restrictor_scale;
        }
        cand.balanced_report = compute_performance_index(cand.balanced_config);
        return cand;
    };

    const BopAdjustment nominal = make_candidate(0.0, 1.0);
    if (std::abs(nominal.balanced_report.virtual_benchmark_lap_s - target_lap_s) <= 0.01 &&
        std::abs(nominal.balanced_report.pi - clamped_target_pi) <= 1) {
        return nominal;
    }

    // Parameterize BoP over u in [-1.0, +1.0]:
    // u < 0 slows the car down (adds up to +200 kg ballast and restricts torque down to 0.65x).
    // u > 0 speeds the car up (0 kg ballast and boosts torque up to 1.15x).
    auto eval_u = [&](double u) {
        if (u < 0.0) {
            const double t = clamp(-u, 0.0, 1.0);
            const double ballast = 200.0 * t;
            const double scale = 1.0 - 0.35 * t;
            return make_candidate(ballast, scale);
        } else {
            const double t = clamp(u, 0.0, 1.0);
            const double scale = 1.0 + 0.15 * t;
            return make_candidate(0.0, scale);
        }
    };

    double lo_u = -1.0;
    double hi_u = 1.0;
    BopAdjustment best = nominal;
    double best_err = std::abs(nominal.balanced_report.virtual_benchmark_lap_s - target_lap_s);

    for (int iter = 0; iter < 36; ++iter) {
        const double mid_u = 0.5 * (lo_u + hi_u);
        BopAdjustment cur = eval_u(mid_u);
        const double lap = cur.balanced_report.virtual_benchmark_lap_s;
        const double err = std::abs(lap - target_lap_s);
        if (err < best_err) {
            best_err = err;
            best = cur;
        }
        // Higher u -> more power / less mass -> smaller (faster) lap time.
        if (lap > target_lap_s) {
            lo_u = mid_u; // car is too slow, increase u
        } else {
            hi_u = mid_u; // car is too fast, decrease u
        }
    }

    // Also check boundary endpoints in case target lies near extremes
    for (double boundary_u : {-1.0, 1.0}) {
        BopAdjustment bound_cand = eval_u(boundary_u);
        const double err = std::abs(bound_cand.balanced_report.virtual_benchmark_lap_s - target_lap_s);
        if (err < best_err) {
            best_err = err;
            best = bound_cand;
        }
    }

    return best;
}

}  // namespace rs
