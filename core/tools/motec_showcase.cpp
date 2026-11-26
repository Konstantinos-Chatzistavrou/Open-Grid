// Apache-2.0 — OpenGrid MoTeC i2 Pro Telemetry Showcase CLI.
//
// Drives any car from data/cars/<car>.json around any circuit route (route/1 JSON from data/tracks/
// or 4-column TUMFTM racetrack-database CSV such as BrandsHatch.csv / Spa.csv) at 400 Hz with ALL
// realistic rs_core physics features enabled, records 60 Hz telemetry via rs::MotecLogger, writes
// real MoTeC i2 Pro <basepath>.ld and <basepath>.ldx files, and prints a telemetry engineering summary.
//
// Usage:
//   motec_showcase [--car data/cars/tornado_gt3.json]
//                  [--track data/validation/racetrack-database/BrandsHatch.csv]
//                  [--laps 2] [--out /tmp/opengrid_motec] [--skill 0.95]

#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "rs/ai.hpp"
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/race.hpp"
#include "rs/racing_line.hpp"
#include "rs/route.hpp"
#include "rs/sim.hpp"
#include "rs/telemetry.hpp"
#include "rs/vehicle.hpp"

namespace {

using SteadyClock = std::chrono::steady_clock;

constexpr double kStdGravity = 9.80665;

struct Options {
    std::string car_path = "data/cars/tornado_gt3.json";
    std::string track_path;
    bool track_explicit = false;
    int laps = 2;
#if defined(_WIN32)
    std::string out_base = "opengrid_motec";
#else
    std::string out_base = "/tmp/opengrid_motec";
#endif
    double skill = 0.95;
    double rate_hz = 60.0;
};

void print_usage(const char* prog) {
    std::printf(
        "Usage: %s [--car <path>] [--track <path>] [--laps <N>] [--out <basepath>] [--skill <0.5..1.0>] [--rate <10..400>]\n"
        "  --car   Car JSON (default: data/cars/tornado_gt3.json)\n"
        "  --track Route JSON (data/tracks/*.json) or TUMFTM CSV (default: BrandsHatch.csv or nyc_route.json)\n"
        "  --laps  Number of timed laps (default: 2)\n"
        "  --out   Output base path without extension (writes .ld and .ldx)\n"
        "  --skill AI skill multiplier 0.50..1.00 (default: 0.95)\n"
        "  --rate  MoTeC .ld log rate in Hz, 10..400 (default: 60; use 200 for pro damper histograms)\n",
        prog);
}

Options parse_args(int argc, char** argv) {
    Options opt;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto need_value = [&](const char* flag) -> std::string {
            if (i + 1 >= argc) {
                throw std::runtime_error(std::string("missing value for ") + flag);
            }
            return argv[++i];
        };
        if (arg == "-h" || arg == "--help") {
            print_usage(argv[0]);
            std::exit(0);
        } else if (arg == "--car") {
            opt.car_path = need_value("--car");
        } else if (arg == "--track") {
            opt.track_path = need_value("--track");
            opt.track_explicit = true;
        } else if (arg == "--laps") {
            opt.laps = std::max(1, std::stoi(need_value("--laps")));
        } else if (arg == "--out") {
            opt.out_base = need_value("--out");
        } else if (arg == "--skill") {
            opt.skill = rs::clamp(std::stod(need_value("--skill")), 0.50, 1.00);
        } else if (arg == "--rate") {
            opt.rate_hz = rs::clamp(std::stod(need_value("--rate")), 10.0, 400.0);
        } else {
            throw std::runtime_error("unknown argument: " + arg);
        }
    }
    return opt;
}

bool file_exists(const std::string& path) {
    std::ifstream f(path);
    return f.good();
}

std::string resolve_default_track() {
    const std::array<const char*, 4> candidates = {
        "data/validation/racetrack-database/BrandsHatch.csv",
        "data/validation/tracks-extra/Spa.csv",
        "data/tracks/nyc_route.json",
        "data/tracks/city_route.json"
    };
    for (const char* p : candidates) {
        if (file_exists(p)) return p;
    }
    return candidates[0];
}

bool ends_with_icase(const std::string& s, const std::string& suffix) {
    if (s.size() < suffix.size()) return false;
    const std::size_t off = s.size() - suffix.size();
    for (std::size_t i = 0; i < suffix.size(); ++i) {
        const unsigned char a = static_cast<unsigned char>(s[off + i]);
        const unsigned char b = static_cast<unsigned char>(suffix[i]);
        if (std::tolower(a) != std::tolower(b)) return false;
    }
    return true;
}

std::string filename_stem(const std::string& path) {
    const std::size_t slash = path.find_last_of("/\\");
    std::string base = (slash == std::string::npos) ? path : path.substr(slash + 1);
    const std::size_t dot = base.find_last_of('.');
    if (dot != std::string::npos) base = base.substr(0, dot);
    return base;
}

// Loads TUMFTM racetrack-database 4-column CSV (# x_m, y_m, w_tr_right_m, w_tr_left_m), matching test_reference_data.cpp.
rs::Route load_tum_csv_route(const std::string& path) {
    std::ifstream f(path);
    if (!f) throw std::runtime_error("cannot open CSV track: " + path);

    std::vector<std::array<double, 4>> pts;
    std::string line;
    while (std::getline(f, line)) {
        const std::size_t first = line.find_first_not_of(" \t\r\n");
        if (first == std::string::npos || line[first] == '#') continue;
        for (char& ch : line) {
            if (ch == ',') ch = ' ';
        }
        std::istringstream iss(line);
        std::array<double, 4> row{};
        if (iss >> row[0] >> row[1] >> row[2] >> row[3]) {
            pts.push_back(row);
        }
    }
    if (pts.size() < 4) {
        throw std::runtime_error("CSV track has fewer than 4 valid samples: " + path);
    }

    const int n = static_cast<int>(pts.size());
    std::vector<rs::RouteSample> samples(static_cast<std::size_t>(n));
    std::vector<double> headings(static_cast<std::size_t>(n), 0.0);
    for (int i = 0; i < n; ++i) {
        const auto& a = pts[static_cast<std::size_t>(i)];
        const auto& b = pts[static_cast<std::size_t>((i + 1) % n)];
        headings[static_cast<std::size_t>(i)] = std::atan2(b[1] - a[1], b[0] - a[0]);
        samples[static_cast<std::size_t>(i)].p = {a[0], a[1], 0.0};
        samples[static_cast<std::size_t>(i)].width_right = a[2];
        samples[static_cast<std::size_t>(i)].width_left = a[3];
        samples[static_cast<std::size_t>(i)].heading = headings[static_cast<std::size_t>(i)];
    }

    auto wrap_angle = [](double d) {
        while (d > rs::kPi) d -= 2.0 * rs::kPi;
        while (d < -rs::kPi) d += 2.0 * rs::kPi;
        return d;
    };
    for (int i = 0; i < n; ++i) {
        const int prev = (i + n - 2) % n;
        const int next = (i + 2) % n;
        const double ds = rs::length(
            samples[static_cast<std::size_t>(next)].p - samples[static_cast<std::size_t>(prev)].p);
        samples[static_cast<std::size_t>(i)].curvature =
            ds > 1e-6 ? wrap_angle(headings[static_cast<std::size_t>(next)] - headings[static_cast<std::size_t>(prev)]) / ds : 0.0;
    }
    return rs::Route::from_samples(std::move(samples), true);
}

rs::Route load_any_track(const std::string& path) {
    if (ends_with_icase(path, ".csv")) {
        return load_tum_csv_route(path);
    }
    return rs::Route::load(path);
}

void enable_full_realism(rs::Simulation& sim) {
    sim.dt = 1.0 / 400.0;
    sim.use_contact_patch = true;

    rs::Vehicle& v = sim.vehicle;
    v.unsprung_dynamics_enabled = true;
    v.tire_zones_enabled = true;
    v.tire_patch_grid_enabled = true;
    v.damage_enabled = true;

    v.aero_wake().yaw_aero_enabled = true;

    auto& cd = v.chassis_dynamics();
    cd.chassis_flex_enabled = true;
    cd.active_yaw_control_enabled = true;
    cd.active_aero_enabled = true;
    cd.brake_fluid_boil_enabled = true;
    cd.bushing_compliance_enabled = true;
    cd.progressive_bump_stops_enabled = true;
    cd.kingpin_3d_ffb_enabled = true;
    cd.elastic_column_enabled = true;

    auto& eng = v.engine_systems();
    eng.torsional_compliance_enabled = true;
    eng.dog_box_flat_shift_cut = true;
    eng.wear_enabled = true;
    eng.fuel_consumption_enabled = true;

    auto& atm = v.atmosphere();
    atm.enabled = true;
    atm.altitude_m = 100.0;
    atm.ambient_air_c = 22.0;
    atm.track_surface_c = 30.0;
    atm.humidity_0_to_1 = 0.45;

    auto& as = v.assists();
    as.abs = true;
    as.tc = true;
    as.esc = false;
}

std::string format_lap_time(double seconds) {
    if (seconds <= 0.0 || !std::isfinite(seconds)) return "--:--.---";
    const int mins = static_cast<int>(seconds / 60.0);
    const double rem = seconds - static_cast<double>(mins) * 60.0;
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%d:%06.3f", mins, rem);
    return buf;
}

std::size_t file_size_bytes(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) return 0;
    const auto sz = f.tellg();
    return sz > 0 ? static_cast<std::size_t>(sz) : 0;
}

struct SessionStats {
    double top_speed_kmh = 0.0;
    double min_corner_speed_kmh = std::numeric_limits<double>::infinity();
    double peak_lat_g = 0.0;
    double peak_brake_g = 0.0;
    double peak_accel_g = 0.0;
    std::array<double, 4> peak_brake_temp_c{};
    std::array<double, 4> end_tire_inner_c{};
    std::array<double, 4> end_tire_middle_c{};
    std::array<double, 4> end_tire_outer_c{};
    std::array<double, 4> end_tire_pressure_kpa{};
    double rh_front_sum_m = 0.0;
    double rh_rear_sum_m = 0.0;
    double rh_front_min_m = std::numeric_limits<double>::infinity();
    double rh_rear_min_m = std::numeric_limits<double>::infinity();
    double aero_bal_sum = 0.0;
    double peak_df_front_n = 0.0;
    double peak_df_rear_n = 0.0;
    double peak_drag_n = 0.0;
    std::uint64_t high_speed_samples = 0;
    double peak_col_ffb_nm = 0.0;
    double peak_rack_ffb_nm = 0.0;
    double max_track_excursion_m = -1e9;
    std::vector<double> lap_times_s;
};

}  // namespace

int main(int argc, char** argv) {
    try {
        Options opt = parse_args(argc, argv);
        if (!opt.track_explicit) {
            opt.track_path = resolve_default_track();
        }

        const rs::CarConfig cfg = rs::load_car_config(opt.car_path);
        const rs::Route route = load_any_track(opt.track_path);
        const std::string venue_name = filename_stem(opt.track_path);

        const int n_gears = static_cast<int>(cfg.drivetrain.gear_ratios.size());
        const int start_gear = std::clamp(4, 2, std::max(2, n_gears - 1));

        rs::Simulation sim(cfg, std::make_shared<rs::PlaneGround>());
        enable_full_realism(sim);

        const rs::RouteSample s0 = route.at(0.0);
        sim.reset(s0.p, s0.heading, 25.0, start_gear);
        sim.settle(0.20);

        rs::Controls ctl(sim.vehicle.config());
        ctl.settings.auto_gearbox = true;
        ctl.settings.auto_clutch = true;
        ctl.set_gear(start_gear);

        rs::AIParams ai_params;
        ai_params.skill = opt.skill;
        ai_params.racing_line = true;
        rs::AIDriver ai(sim.vehicle.config(), route, ai_params);

        rs::RaceTracker tracker(route, opt.laps);
        const int car_idx = tracker.add_car(sim.body.state.position);

        rs::TelemetryMeta meta;
        meta.driver = "OpenGrid AI Driver";
        meta.vehicle = cfg.name;
        meta.venue = venue_name;
        meta.event = "OpenGrid MoTeC Showcase";
        meta.sample_rate_hz = opt.rate_hz;
        rs::MotecLogger logger(meta);

        SessionStats st;
        const double max_sim_time_s =
            static_cast<double>(opt.laps) * std::max(260.0, route.length() / 12.0) + 60.0;
        const std::vector<rs::OtherCar> no_traffic;

        int prev_lap = 0;
        int proj_hint = 0;
        const auto wall_t0 = SteadyClock::now();

        while (!tracker.progress(car_idx).finished && sim.time < max_sim_time_s) {
            const rs::AIOutput ai_out = ai.update(sim.body.state, sim.last, no_traffic, sim.dt);
            if (ai_out.gear_request >= 0) {
                ctl.set_gear(ai_out.gear_request);
            }
            const rs::DriverInput driver_in = ctl.update(ai_out.raw, sim.last, sim.dt);
            sim.step(driver_in);
            tracker.update(car_idx, sim.body.state.position, sim.time);

            const rs::RaceProgress& prog = tracker.progress(car_idx);
            if (prog.lap > prev_lap) {
                logger.mark_lap(sim.time);
                st.lap_times_s.push_back(prog.last_lap);
                prev_lap = prog.lap;
            }

            const double cur_lap_s = std::max(0.0, sim.time - prog.lap_start_time);
            const rs::TelemetrySample sample = rs::make_telemetry_sample(
                sim.last, sim.body.state, driver_in, cfg, sim.time,
                prog.lap, cur_lap_s, prog.last_lap, prog.best_lap, prog.distance);
            logger.record(sample);

            // Accumulate engineering summary metrics
            const double speed_kmh = std::fabs(sim.last.speed) * 3.6;
            const rs::Vec3 acc_b = sim.accel_body();
            const double lat_g = std::fabs(acc_b.y) / kStdGravity;
            const double long_g = acc_b.x / kStdGravity;

            st.top_speed_kmh = std::max(st.top_speed_kmh, speed_kmh);
            if (sim.time > 2.0 && lat_g > 0.35 && speed_kmh > 10.0) {
                st.min_corner_speed_kmh = std::min(st.min_corner_speed_kmh, speed_kmh);
            }
            st.peak_lat_g = std::max(st.peak_lat_g, lat_g);
            st.peak_brake_g = std::max(st.peak_brake_g, -long_g);
            st.peak_accel_g = std::max(st.peak_accel_g, long_g);

            for (std::size_t w = 0; w < 4; ++w) {
                const auto& wh = sim.last.wheels[w];
                st.peak_brake_temp_c[w] = std::max(st.peak_brake_temp_c[w], wh.brake_temp_c);
                st.end_tire_inner_c[w] = wh.condition.inner_c;
                st.end_tire_middle_c[w] = wh.condition.middle_c;
                st.end_tire_outer_c[w] = wh.condition.outer_c;
                st.end_tire_pressure_kpa[w] = wh.condition.pressure_kpa;
            }

            if (speed_kmh >= 100.0) {
                st.rh_front_sum_m += sim.last.front_ride_height_m;
                st.rh_rear_sum_m += sim.last.rear_ride_height_m;
                st.rh_front_min_m = std::min(st.rh_front_min_m, sim.last.front_ride_height_m);
                st.rh_rear_min_m = std::min(st.rh_rear_min_m, sim.last.rear_ride_height_m);
                st.aero_bal_sum += sim.last.aero_balance_front;
                ++st.high_speed_samples;
            }
            st.peak_df_front_n = std::max(st.peak_df_front_n, sim.last.aero_downforce_front_n);
            st.peak_df_rear_n = std::max(st.peak_df_rear_n, sim.last.aero_downforce_rear_n);
            st.peak_drag_n = std::max(st.peak_drag_n, sim.last.aero_drag_n);
            st.peak_col_ffb_nm = std::max(st.peak_col_ffb_nm, std::fabs(sim.last.steering_column_torque_nm));
            st.peak_rack_ffb_nm = std::max(st.peak_rack_ffb_nm, std::fabs(sim.last.steer_torque));

            const rs::Route::Projection pr = route.project(sim.body.state.position, proj_hint);
            proj_hint = pr.index;
            const rs::RouteSample sp = route.at(pr.s);
            const double half_w = (pr.lateral >= 0.0) ? sp.width_left : sp.width_right;
            st.max_track_excursion_m = std::max(st.max_track_excursion_m, std::fabs(pr.lateral) - half_w);
        }

        const double wall_s = std::chrono::duration<double>(SteadyClock::now() - wall_t0).count();

        if (!logger.write_files(opt.out_base)) {
            std::fprintf(stderr, "motec_showcase error: failed to write %s.ld / %s.ldx\n",
                         opt.out_base.c_str(), opt.out_base.c_str());
            return 1;
        }

        const std::string ld_path = opt.out_base + ".ld";
        const std::string ldx_path = opt.out_base + ".ldx";
        const std::size_t ld_bytes = file_size_bytes(ld_path);
        const std::size_t ldx_bytes = file_size_bytes(ldx_path);

        const rs::RaceProgress& final_prog = tracker.progress(car_idx);
        const double mean_rh_f_mm = st.high_speed_samples > 0
            ? (st.rh_front_sum_m / static_cast<double>(st.high_speed_samples)) * 1000.0
            : sim.last.front_ride_height_m * 1000.0;
        const double mean_rh_r_mm = st.high_speed_samples > 0
            ? (st.rh_rear_sum_m / static_cast<double>(st.high_speed_samples)) * 1000.0
            : sim.last.rear_ride_height_m * 1000.0;
        const double min_rh_f_mm = std::isfinite(st.rh_front_min_m) ? st.rh_front_min_m * 1000.0 : mean_rh_f_mm;
        const double min_rh_r_mm = std::isfinite(st.rh_rear_min_m) ? st.rh_rear_min_m * 1000.0 : mean_rh_r_mm;
        const double mean_aero_bal_pct = st.high_speed_samples > 0
            ? (st.aero_bal_sum / static_cast<double>(st.high_speed_samples)) * 100.0
            : cfg.aero.front_balance * 100.0;
        const double min_corner_kmh = std::isfinite(st.min_corner_speed_kmh) ? st.min_corner_speed_kmh : 0.0;

        std::printf("================================================================================\n");
        std::printf("OpenGrid MoTeC i2 Pro Telemetry Showcase (400 Hz Physics -> %.0f Hz .ld/.ldx)\n", opt.rate_hz);
        std::printf("================================================================================\n");
        std::printf("  Vehicle           : %s (%s)\n", cfg.name.c_str(), opt.car_path.c_str());
        std::printf("  Circuit           : %s (%.3f km) [%s]\n",
                    venue_name.c_str(), route.length() / 1000.0, opt.track_path.c_str());
        std::printf("  Session           : %d / %d laps completed | AI skill %.2f | %.2f sim-s in %.2f s (%.1fx RT)\n",
                    final_prog.lap, opt.laps, opt.skill, sim.time, wall_s,
                    wall_s > 1e-6 ? (sim.time / wall_s) : 0.0);
        std::printf("--------------------------------------------------------------------------------\n");
        std::printf("  LAP TIMES\n");
        for (std::size_t i = 0; i < st.lap_times_s.size(); ++i) {
            std::printf("    Lap %2zu          : %s  (%.3f s, avg %.1f km/h)\n",
                        i + 1, format_lap_time(st.lap_times_s[i]).c_str(), st.lap_times_s[i],
                        st.lap_times_s[i] > 1e-6 ? (route.length() / st.lap_times_s[i]) * 3.6 : 0.0);
        }
        std::printf("    Best Lap        : %s  (%.3f s)\n",
                    format_lap_time(final_prog.best_lap).c_str(), final_prog.best_lap);
        std::printf("--------------------------------------------------------------------------------\n");
        std::printf("  SPEED & G-FORCE ENVELOPE\n");
        std::printf("    Top Speed       : %6.1f km/h\n", st.top_speed_kmh);
        std::printf("    Min Corner Spd  : %6.1f km/h\n", min_corner_kmh);
        std::printf("    Peak Lateral G  : %6.2f G\n", st.peak_lat_g);
        std::printf("    Peak Braking G  : %6.2f G   (Peak Accel: %.2f G)\n", st.peak_brake_g, st.peak_accel_g);
        std::printf("    Max Track Edge  : %+6.2f m  (<= 0.00 m = CG strictly inside track limits)\n",
                    st.max_track_excursion_m);
        std::printf("--------------------------------------------------------------------------------\n");
        std::printf("  TYRES (End-of-Stint Inner / Middle / Outer Tread C & Hot Pressure)\n");
        const std::array<const char*, 4> wnames = {"FL", "FR", "RL", "RR"};
        for (std::size_t w = 0; w < 4; ++w) {
            std::printf("    %s              : I %5.1f C | M %5.1f C | O %5.1f C  | P %5.1f kPa\n",
                        wnames[w],
                        st.end_tire_inner_c[w], st.end_tire_middle_c[w], st.end_tire_outer_c[w],
                        st.end_tire_pressure_kpa[w]);
        }
        std::printf("  BRAKES (Peak Rotor Disc Temp)\n");
        std::printf("    Front FL / FR   : %5.1f C / %5.1f C\n", st.peak_brake_temp_c[0], st.peak_brake_temp_c[1]);
        std::printf("    Rear  RL / RR   : %5.1f C / %5.1f C\n", st.peak_brake_temp_c[2], st.peak_brake_temp_c[3]);
        std::printf("--------------------------------------------------------------------------------\n");
        std::printf("  AERO PLATFORM & FORCE FEEDBACK\n");
        std::printf("    Front Ride Ht   : mean %5.1f mm | min %5.1f mm  (>= 100 km/h)\n", mean_rh_f_mm, min_rh_f_mm);
        std::printf("    Rear  Ride Ht   : mean %5.1f mm | min %5.1f mm  (>= 100 km/h)\n", mean_rh_r_mm, min_rh_r_mm);
        std::printf("    Aero Balance    : %5.1f%% front  (Peak DF: %.0f N F / %.0f N R | Peak Drag: %.0f N)\n",
                    mean_aero_bal_pct, st.peak_df_front_n, st.peak_df_rear_n, st.peak_drag_n);
        std::printf("    Peak FFB Torque : %5.2f Nm steering column  (Peak rack: %.1f Nm)\n",
                    st.peak_col_ffb_nm, st.peak_rack_ffb_nm);
        std::printf("--------------------------------------------------------------------------------\n");
        std::printf("  MOTEC I2 PRO OUTPUT\n");
        std::printf("    Binary log (.ld): %s  (%.1f KB, %zu samples @ %.0f Hz, %zu channels)\n",
                    ld_path.c_str(), static_cast<double>(ld_bytes) / 1024.0,
                    logger.sample_count(), meta.sample_rate_hz, rs::MotecLogger::kChannelCount);
        std::printf("    Beacons   (.ldx): %s  (%zu bytes, %zu lap beacons)\n",
                    ldx_path.c_str(), ldx_bytes, logger.lap_beacons().size());
        std::printf("================================================================================\n");

        if (final_prog.lap < opt.laps) {
            std::fprintf(stderr, "WARNING: completed %d of %d requested laps before timeout.\n",
                         final_prog.lap, opt.laps);
            return 1;
        }
        return 0;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "motec_showcase error: %s\n", e.what());
        return 2;
    }
}
