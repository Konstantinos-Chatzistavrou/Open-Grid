// Apache-2.0 — OpenGrid Dynamic Weather Weather Implementation (pure C++17, zero per-tick allocations).
#include "rs/weather.hpp"
#include <algorithm>
#include <cmath>

namespace rs {
namespace {

constexpr double kWeatherDegToRad = kPi / 180.0;
constexpr double kWeatherRadToDeg = 180.0 / kPi;

double magnus_dew_point_c(double temp_c, double rh_0_to_1) {
    const double rh = clamp(rh_0_to_1, 0.05, 1.0);
    constexpr double a = 17.625;
    constexpr double b = 243.04;
    const double gamma = std::log(rh) + (a * temp_c) / (b + temp_c);
    return (b * gamma) / std::max(a - gamma, 1e-4);
}

double saturation_vapor_kpa(double temp_c) {
    return 0.61078 * std::exp((17.27 * temp_c) / (temp_c + 237.3));
}

}  // namespace

double WeatherSystem::next_rand_01() {
    // Xorshift32: fast, portable, 100% deterministic across x64, ARM, MSVC, GCC, Clang & Emscripten WASM
    std::uint32_t x = rng_state_ ? rng_state_ : 2463534242u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    rng_state_ = x;
    return static_cast<double>(x & 0x00FFFFFFu) / static_cast<double>(0x01000000u);
}

Vec3 WeatherSystem::synoptic_wind_mps() const {
    // Meteorological wind direction = direction wind blows FROM; velocity vector points opposite (+180 deg)
    // Core coordinates: +X = East/Forward, +Y = North/Left, +Z = Up
    const double to_rad = (cfg_.wind_direction_deg + 180.0) * kWeatherDegToRad;
    return {cfg_.base_wind_mps * std::sin(to_rad), cfg_.base_wind_mps * std::cos(to_rad), 0.0};
}

int WeatherSystem::hydro_index(double x_m, double y_m, int* out_ix, int* out_iy) const {
    const double span = std::max(2.0 * cfg_.domain_half_extent_m, 100.0);
    auto wrap_idx = [&](double v) {
        double u = std::fmod(v + cfg_.domain_half_extent_m, span);
        if (u < 0.0) u += span;
        return clamp(static_cast<int>((u / span) * kHydroRes), 0, kHydroRes - 1);
    };
    const int ix = wrap_idx(x_m);
    const int iy = wrap_idx(y_m);
    if (out_ix) *out_ix = ix;
    if (out_iy) *out_iy = iy;
    return iy * kHydroRes + ix;
}

void WeatherSystem::spawn_cell(int slot, bool initial_scatter) {
    StormCell& c = cells_[slot];
    c = StormCell{};
    const double domain = std::max(cfg_.domain_half_extent_m * 2.5, 9000.0);
    const Vec3 w = synoptic_wind_mps();
    const double w_len = std::hypot(w.x, w.y);
    const double wx = w_len > 0.2 ? (w.x / w_len) : 1.0;
    const double wy = w_len > 0.2 ? (w.y / w_len) : 0.0;

    if (initial_scatter) {
        c.x_m = (next_rand_01() * 2.0 - 1.0) * domain;
        c.y_m = (next_rand_01() * 2.0 - 1.0) * domain;
        c.age_s = next_rand_01() * 1200.0;
    } else {
        // Respawn upstream of the domain so new fronts roll in naturally with the prevailing wind
        const double cross = (next_rand_01() * 2.0 - 1.0) * domain * 0.85;
        const double upstream = domain * (0.95 + 0.35 * next_rand_01());
        c.x_m = -wx * upstream - wy * cross;
        c.y_m = -wy * upstream + wx * cross;
        c.age_s = 0.0;
    }

    c.lifetime_s = 2200.0 + next_rand_01() * 2600.0;
    c.rain_radius_m = 1600.0 + next_rand_01() * 2400.0;
    c.cloud_radius_m = c.rain_radius_m * (2.1 + 0.7 * next_rand_01());

    switch (cfg_.preset) {
        case WeatherPreset::Clear:
            c.active = (slot < 2);
            c.peak_cloud_cover = 0.14 + 0.12 * next_rand_01();
            c.peak_rain_mm_hr = 0.0;
            break;
        case WeatherPreset::PartlyCloudy:
            c.active = (slot < 6);
            c.peak_cloud_cover = 0.48 + 0.34 * next_rand_01();
            c.peak_rain_mm_hr = 0.0;
            break;
        case WeatherPreset::DynamicFront:
            c.active = (slot < 6);
            if (initial_scatter && slot == 0) {
                // Place primary rain front ~2.8 km upstream so races start dry/damp and transition naturally into rain!
                c.x_m = -wx * 2800.0;
                c.y_m = -wy * 2800.0;
                c.rain_radius_m = 2600.0;
                c.cloud_radius_m = 5400.0;
                c.peak_cloud_cover = 0.92;
                c.peak_rain_mm_hr = 11.5;
                c.age_s = 400.0;
            } else {
                c.peak_cloud_cover = 0.55 + 0.40 * next_rand_01();
                c.peak_rain_mm_hr = (slot < 4) ? (4.0 + 10.0 * next_rand_01()) : 0.0;
            }
            break;
        case WeatherPreset::LightRain:
            c.active = (slot < 7);
            if (initial_scatter && slot == 0) {
                c.x_m = 0.0;
                c.y_m = 0.0;
                c.rain_radius_m = 5200.0;
                c.cloud_radius_m = 9500.0;
                c.peak_cloud_cover = 0.88;
                c.peak_rain_mm_hr = 4.5;
            } else {
                c.peak_cloud_cover = 0.75 + 0.20 * next_rand_01();
                c.peak_rain_mm_hr = 2.5 + 4.0 * next_rand_01();
            }
            break;
        case WeatherPreset::HeavyStorm:
            c.active = true;
            if (initial_scatter && slot == 0) {
                c.x_m = 0.0;
                c.y_m = 0.0;
                c.rain_radius_m = 5600.0;
                c.cloud_radius_m = 10500.0;
                c.peak_cloud_cover = 0.99;
                c.peak_rain_mm_hr = 22.0;
            } else {
                c.peak_cloud_cover = 0.88 + 0.12 * next_rand_01();
                c.peak_rain_mm_hr = 10.0 + 18.0 * next_rand_01();
            }
            break;
        case WeatherPreset::DryingTrack:
            c.active = (slot < 5);
            // Place departing rain cell downstream so rain is ending & track begins drying immediately
            if (initial_scatter && slot == 0) {
                c.x_m = wx * 3600.0;
                c.y_m = wy * 3600.0;
                c.peak_cloud_cover = 0.78;
                c.peak_rain_mm_hr = 3.0;
            } else {
                c.peak_cloud_cover = 0.30 + 0.35 * next_rand_01();
                c.peak_rain_mm_hr = 0.0;
            }
            break;
    }
}

void WeatherSystem::configure(const WeatherConfig& cfg) {
    cfg_ = cfg;
    sim_time_s_ = 0.0;
    local_hour_ = std::fmod(std::fmod(cfg.start_hour_local, 24.0) + 24.0, 24.0);
    rng_state_ = cfg.seed ? cfg.seed : 1337u;
    gust_x_ = gust_y_ = gust_phase_ = 0.0;
    lightning_flash_ = 0.0;
    lightning_cooldown_s_ = 5.0;
    last_thunder_delay_s_ = -1.0;

    // Preset synoptic baseline adjustments (barometric pressure, wind & initial surface water)
    double init_water_mm = 0.0;
    baro_kpa_ = 101.6;
    global_humidity_ = clamp(cfg.base_humidity, 0.15, 0.98);
    if (cfg.preset == WeatherPreset::Clear) {
        baro_kpa_ = 102.2;
        global_humidity_ = std::min(global_humidity_, 0.45);
    } else if (cfg.preset == WeatherPreset::LightRain) {
        baro_kpa_ = 100.3;
        global_humidity_ = std::max(global_humidity_, 0.84);
        init_water_mm = 0.85;
    } else if (cfg.preset == WeatherPreset::HeavyStorm) {
        baro_kpa_ = 99.1;
        global_humidity_ = std::max(global_humidity_, 0.94);
        init_water_mm = 2.60;
        if (cfg_.base_wind_mps < 9.0) cfg_.base_wind_mps = 11.5;
    } else if (cfg.preset == WeatherPreset::DryingTrack) {
        baro_kpa_ = 101.1;
        global_humidity_ = 0.68;
        init_water_mm = 1.45;
    }

    for (int i = 0; i < kMaxCells; ++i) spawn_cell(i, true);

    // Deterministic topographical drainage basins (low-lying puddle pockets across the track/city grid)
    for (int iy = 0; iy < kHydroRes; ++iy) {
        for (int ix = 0; ix < kHydroRes; ++ix) {
            const int k = iy * kHydroRes + ix;
            const double fx = (static_cast<double>(ix) / kHydroRes) * 2.0 * kPi;
            const double fy = (static_cast<double>(iy) / kHydroRes) * 2.0 * kPi;
            // Smooth multi-frequency basin topography (0 = high crown, up to 2.4 mm natural puddle basin)
            const double h = 0.50
                           + 0.30 * std::sin(2.0 * fx + 0.7) * std::cos(2.0 * fy - 0.4)
                           + 0.20 * std::sin(5.0 * fx - 3.0 * fy + 1.1);
            const double basin = clamp((0.52 - h) * 4.5, 0.0, 2.4);
            hydro_basin_mm_[k] = basin;
            // Basins hold extra standing water when starting wet/drying
            hydro_water_mm_[k] = init_water_mm > 0.0 ? clamp(init_water_mm * (0.75 + 0.45 * basin), 0.0, 8.0) : 0.0;
            hydro_groove_[k] = 0.0;
        }
    }

    // Initialize equilibrium asphalt temperature from current solar angle & cloud cover
    double sun_elev = 0.0, sun_azim = 180.0;
    compute_sun_angles(sun_elev, sun_azim);
    double r0 = 0.0, cl0 = 0.0;
    evaluate_cells_at(0.0, 0.0, 0.0, r0, cl0);
    const double sin_e = std::max(0.0, std::sin(sun_elev * kWeatherDegToRad));
    const double solar_w = 960.0 * std::pow(sin_e, 1.15) * (1.0 - 0.78 * cl0 * cl0);
    global_air_c_ = cfg.base_ambient_c;
    const double solar_lift = (init_water_mm > 0.2 ? 0.005 : 0.018) * solar_w;
    global_track_c_ = clamp(global_air_c_ + solar_lift - (r0 > 0.5 ? 2.5 : 0.0), -15.0, 68.0);
}

void WeatherSystem::compute_sun_angles(double& out_elev_deg, double& out_azim_deg) const {
    // NOAA / Spencer solar declination & hour angle approximation (accurate to ~0.5 deg)
    const double lat = clamp(cfg_.latitude_deg, -85.0, 85.0) * kWeatherDegToRad;
    const double decl = 23.44 * kWeatherDegToRad * std::sin((2.0 * kPi / 365.0) * (cfg_.day_of_year - 81));
    const double ha = (local_hour_ - 12.0) * 15.0 * kWeatherDegToRad;
    const double sin_el = clamp(std::sin(lat) * std::sin(decl) + std::cos(lat) * std::cos(decl) * std::cos(ha), -1.0, 1.0);
    const double el = std::asin(sin_el);
    out_elev_deg = el * kWeatherRadToDeg;
    const double cos_el = std::max(std::cos(el), 1e-4);
    const double cos_az = clamp((std::sin(decl) - std::sin(lat) * sin_el) / (std::cos(lat) * cos_el), -1.0, 1.0);
    double az = std::acos(cos_az) * kWeatherRadToDeg;
    if (ha > 0.0) az = 360.0 - az;
    out_azim_deg = az;
}

void WeatherSystem::evaluate_cells_at(double x_m, double y_m, double time_offset_s,
                                       double& out_rain_mm_hr, double& out_cloud_0_1) const {
    const Vec3 w = synoptic_wind_mps();
    // Mesoscale frontal / storm-band translation speed (~0.55x surface wind -> ~2.5-6.5 m/s = 9-23 km/h)
    const double adv_x = w.x * 0.55 * time_offset_s;
    const double adv_y = w.y * 0.55 * time_offset_s;
    double rain_sum = (cfg_.preset == WeatherPreset::HeavyStorm) ? 8.5
                    : (cfg_.preset == WeatherPreset::LightRain)  ? 2.2
                    : 0.0;
    double clear_prod = (cfg_.preset == WeatherPreset::HeavyStorm) ? 0.08
                      : (cfg_.preset == WeatherPreset::LightRain)  ? 0.25
                      : 1.0;

    for (const StormCell& c : cells_) {
        if (!c.active) continue;
        const double age = c.age_s + time_offset_s;
        if (age < 0.0 || age > c.lifetime_s) continue;
        // Smooth bell-shaped storm lifecycle (spin-up 20%, mature plateau 55%, dissipation 25%)
        const double u = age / std::max(c.lifetime_s, 60.0);
        double life = 1.0;
        if (u < 0.20) life = u / 0.20;
        else if (u > 0.75) life = (1.0 - u) / 0.25;
        life = clamp(life * life * (3.0 - 2.0 * life), 0.0, 1.0);

        const double dx = x_m - (c.x_m + adv_x);
        const double dy = y_m - (c.y_m + adv_y);
        const double d2 = dx * dx + dy * dy;

        if (c.cloud_radius_m > 10.0) {
            const double rc2 = c.cloud_radius_m * c.cloud_radius_m;
            if (d2 < 6.0 * rc2) {
                const double cl = clamp(c.peak_cloud_cover * life * std::exp(-d2 / rc2), 0.0, 0.99);
                clear_prod *= (1.0 - cl);
            }
        }
        if (c.peak_rain_mm_hr > 0.01 && c.rain_radius_m > 10.0) {
            const double rr2 = c.rain_radius_m * c.rain_radius_m;
            if (d2 < 6.0 * rr2) {
                rain_sum += c.peak_rain_mm_hr * life * std::exp(-d2 / rr2);
            }
        }
    }

    out_rain_mm_hr = clamp(rain_sum, 0.0, 60.0);
    out_cloud_0_1 = clamp(1.0 - clear_prod, 0.0, 1.0);
}

void WeatherSystem::step(double dt) {
    if (dt <= 0.0) return;
    const double scaled_dt = dt * std::max(cfg_.time_scale, 0.0);
    sim_time_s_ += scaled_dt;
    local_hour_ = std::fmod(local_hour_ + scaled_dt / 3600.0, 24.0);
    if (local_hour_ < 0.0) local_hour_ += 24.0;

    // 1. Advect mesoscale storm cells along frontal translation wind & respawn dissipated cells upstream
    const Vec3 w_syn = synoptic_wind_mps();
    const double steer_x = w_syn.x * 0.55;
    const double steer_y = w_syn.y * 0.55;
    const double max_dist = std::max(cfg_.domain_half_extent_m * 3.8, 14000.0);
    for (int i = 0; i < kMaxCells; ++i) {
        StormCell& c = cells_[i];
        if (!c.active) continue;
        c.x_m += steer_x * scaled_dt;
        c.y_m += steer_y * scaled_dt;
        c.age_s += scaled_dt;
        if (c.age_s >= c.lifetime_s || std::hypot(c.x_m, c.y_m) > max_dist) {
            spawn_cell(i, false);
        }
    }

    // 2. Evaluate central domain sky/rain for synoptic pressure, humidity & thermal balance
    double center_rain = 0.0, center_cloud = 0.0;
    evaluate_cells_at(0.0, 0.0, 0.0, center_rain, center_cloud);

    // 3. Continuous Dryden-like turbulent wind gusts (stronger in convective storms!)
    gust_phase_ += dt * (0.45 + 0.04 * cfg_.base_wind_mps);
    const double storm_gust_amp = cfg_.base_wind_mps * (0.18 + 0.22 * clamp(center_rain / 15.0, 0.0, 1.0));
    const double target_gx = storm_gust_amp * (0.65 * std::sin(gust_phase_ * 1.13 + 0.4) + 0.35 * std::sin(gust_phase_ * 2.87 + 1.9));
    const double target_gy = storm_gust_amp * (0.65 * std::cos(gust_phase_ * 0.91 + 1.2) + 0.35 * std::sin(gust_phase_ * 2.41 - 0.7));
    const double g_alpha = clamp(dt / 2.2, 0.0, 1.0);
    gust_x_ += (target_gx - gust_x_) * g_alpha;
    gust_y_ += (target_gy - gust_y_) * g_alpha;

    // 4. Synoptic barometric pressure & humidity evolution
    const double target_baro = 101.8 - 1.2 * center_cloud - 1.6 * clamp(center_rain / 20.0, 0.0, 1.0);
    baro_kpa_ += (target_baro - baro_kpa_) * clamp(scaled_dt / 600.0, 0.0, 1.0);
    const double target_rh = clamp(cfg_.base_humidity + 0.22 * center_cloud + 0.35 * clamp(center_rain / 8.0, 0.0, 1.0), 0.15, 0.98);
    global_humidity_ += (target_rh - global_humidity_) * clamp(scaled_dt / 180.0, 0.0, 1.0);

    // 5. Solar-thermal asphalt slab energy balance (C_asphalt ~ 18 kJ/(m^2 K) active top 15 mm layer)
    double sun_elev = 0.0, sun_azim = 180.0;
    compute_sun_angles(sun_elev, sun_azim);
    const double sin_e = std::max(0.0, std::sin(sun_elev * kWeatherDegToRad));
    const double solar_w_m2 = 960.0 * std::pow(sin_e, 1.15) * (1.0 - 0.78 * center_cloud * center_cloud);
    // Diurnal air temp swing (+-3.5 C around baseline, cooled by rain downdrafts)
    const double diurnal = -3.5 * std::cos((local_hour_ - 15.0) * (2.0 * kPi / 24.0)) * (1.0 - 0.45 * center_cloud);
    const double rain_chill = -2.8 * clamp(center_rain / 15.0, 0.0, 1.0);
    const double target_air_c = cfg_.base_ambient_c + diurnal + rain_chill;
    global_air_c_ += (target_air_c - global_air_c_) * clamp(scaled_dt / 240.0, 0.0, 1.0);

    const double v_wind = std::hypot(w_syn.x + gust_x_, w_syn.y + gust_y_);
    const double h_conv = 12.0 + 3.8 * v_wind; // W/(m^2 K) surface-to-air convection
    const double q_sun_abs = 0.86 * solar_w_m2; // dark asphalt absorptivity ~0.86
    const double q_conv = h_conv * (global_track_c_ - global_air_c_);
    const double q_rad = (1.0 - 0.75 * center_cloud) * 65.0; // clear-sky longwave radiative cooling at night/dusk
    // Raindrop quenching + latent heat of evaporation cools hot tarmac dramatically!
    const double dew_c = magnus_dew_point_c(global_air_c_, global_humidity_);
    const double q_rain = center_rain * 14.0 * std::max(0.0, global_track_c_ - dew_c);
    const double center_water = hydro_water_mm_[hydro_index(0.0, 0.0)];
    const double q_evap = (center_water > 0.05) ? (140.0 * (1.0 - global_humidity_) * (1.0 + 0.15 * v_wind)) : 0.0;
    constexpr double kAsphaltHeatCap = 22000.0; // J/(m^2 K)
    global_track_c_ = clamp(global_track_c_ + (q_sun_abs - q_conv - q_rad - q_rain - q_evap) * (scaled_dt / kAsphaltHeatCap),
                            -18.0, 72.0);

    // 6. 2D Topographical Surface Hydrology (spatially varying rain, Penman evaporation & slope basin drainage)
    const double vpd_kpa = std::max(0.0, saturation_vapor_kpa(global_track_c_) - global_humidity_ * saturation_vapor_kpa(global_air_c_));
    // Penman-style evaporation rate (mm/s): scales with solar radiation, wind, track warmth & vapor-pressure deficit
    const double evap_mm_per_s = (0.00018 * vpd_kpa * (1.0 + 0.18 * v_wind) + 2.2e-7 * solar_w_m2) * clamp((global_track_c_ + 5.0) / 25.0, 0.15, 2.8);
    const double cell_size_m = (2.0 * cfg_.domain_half_extent_m) / kHydroRes;
    const double drain_k = clamp(0.065 * scaled_dt, 0.0, 0.22);
    const double storm_drain = clamp(0.015 * scaled_dt, 0.0, 0.15);

    for (int iy = 0; iy < kHydroRes; ++iy) {
        const double cy = -cfg_.domain_half_extent_m + (iy + 0.5) * cell_size_m;
        for (int ix = 0; ix < kHydroRes; ++ix) {
            const double cx = -cfg_.domain_half_extent_m + (ix + 0.5) * cell_size_m;
            const int k = iy * kHydroRes + ix;
            double r_cell = 0.0, cl_cell = 0.0;
            evaluate_cells_at(cx, cy, 0.0, r_cell, cl_cell);
            const double rain_add = r_cell * (scaled_dt / 3600.0);
            // Local cloud shadow reduces solar evaporation on shaded cells
            const double evap_cell = (r_cell < 0.25) ? evap_mm_per_s * (1.0 - 0.55 * cl_cell) * scaled_dt : 0.0;
            // Passing-car drying groove decays slowly during heavy rain
            if (r_cell > 0.8) {
                hydro_groove_[k] = std::max(0.0, hydro_groove_[k] - 0.025 * r_cell * (scaled_dt / 60.0));
            }
            hydro_scratch_[k] = clamp(hydro_water_mm_[k] + rain_add - evap_cell, 0.0, 10.0);
        }
    }

    // Gravity flow toward neighboring lower-elevation puddle basins (symmetric 4-neighbor snapshot)
    for (int iy = 0; iy < kHydroRes; ++iy) {
        for (int ix = 0; ix < kHydroRes; ++ix) {
            const int k = iy * kHydroRes + ix;
            double w_cur = hydro_scratch_[k];
            const double z_cur = -hydro_basin_mm_[k] + w_cur; // total water surface elevation (mm)
            double net_flow = 0.0;
            const int nb[4][2] = {{ix - 1, iy}, {ix + 1, iy}, {ix, iy - 1}, {ix, iy + 1}};
            for (int n = 0; n < 4; ++n) {
                const int nx = (nb[n][0] + kHydroRes) % kHydroRes;
                const int ny = (nb[n][1] + kHydroRes) % kHydroRes;
                const int nk = ny * kHydroRes + nx;
                const double z_nb = -hydro_basin_mm_[nk] + hydro_scratch_[nk];
                const double dz = z_nb - z_cur;
                if (dz > 0.0) {
                    // Incoming flow bounded by neighbor's free mobile water above asphalt porosity
                    const double mobile_nb = std::max(0.0, hydro_scratch_[nk] - cfg_.asphalt_porosity_mm);
                    net_flow += std::min(mobile_nb * 0.25, dz * 0.25 * drain_k);
                } else if (dz < 0.0) {
                    const double mobile_cur = std::max(0.0, w_cur - cfg_.asphalt_porosity_mm);
                    net_flow -= std::min(mobile_cur * 0.25, (-dz) * 0.25 * drain_k);
                }
            }
            // Storm-sewer drain removes water exceeding basin lip + 1.4 mm
            const double lip = hydro_basin_mm_[k] + 1.4;
            const double w_next = std::max(0.0, w_cur + net_flow);
            const double overflow = std::max(0.0, w_next - lip);
            hydro_water_mm_[k] = clamp(w_next - overflow * storm_drain, 0.0, 10.0);
        }
    }

    // 7. Convective lightning flash & thunderclap scheduling
    lightning_flash_ = std::max(0.0, lightning_flash_ - dt * 4.5);
    last_thunder_delay_s_ = -1.0;
    if (center_rain > 11.0) {
        lightning_cooldown_s_ -= dt;
        if (lightning_cooldown_s_ <= 0.0) {
            lightning_flash_ = 0.75 + 0.25 * next_rand_01();
            const double strike_dist_m = 450.0 + next_rand_01() * 3200.0;
            last_thunder_delay_s_ = strike_dist_m / 343.0;
            lightning_cooldown_s_ = 4.5 + next_rand_01() * 11.0;
        }
    }
}

void WeatherSystem::deposit_tyre_wake(double x_m, double y_m, double speed_mps, double load_n, double dt) {
    if (dt <= 0.0 || load_n <= 100.0) return;
    const double v = std::abs(speed_mps);
    if (v < 3.0) return;
    int ix = 0, iy = 0;
    const int k = hydro_index(x_m, y_m, &ix, &iy);
    if (hydro_water_mm_[k] <= 0.01) return;

    const double pump = clamp((v / 42.0) * (load_n / 4000.0) * dt * 0.65, 0.0, 0.35);
    const double moved = hydro_water_mm_[k] * pump;
    hydro_water_mm_[k] = std::max(0.0, hydro_water_mm_[k] - moved);
    hydro_groove_[k] = clamp(hydro_groove_[k] + pump * 0.85, 0.0, 1.0);

    // 50% atomizes into trailing road spray mist; 50% splashes into adjacent lateral cells
    const double splash = 0.25 * moved;
    const int k_l = iy * kHydroRes + ((ix - 1 + kHydroRes) % kHydroRes);
    const int k_r = iy * kHydroRes + ((ix + 1) % kHydroRes);
    hydro_water_mm_[k_l] = std::min(10.0, hydro_water_mm_[k_l] + splash);
    hydro_water_mm_[k_r] = std::min(10.0, hydro_water_mm_[k_r] + splash);
}

WeatherSample WeatherSystem::sample(double x_m, double y_m) const {
    WeatherSample s;
    evaluate_cells_at(x_m, y_m, 0.0, s.rain_mm_per_hr, s.cloud_cover_0_to_1);
    s.cloud_shadow_0_to_1 = clamp(s.cloud_cover_0_to_1 * s.cloud_cover_0_to_1 * 0.88, 0.0, 0.92);

    compute_sun_angles(s.sun_elevation_deg, s.sun_azimuth_deg);
    const double sin_e = std::max(0.0, std::sin(s.sun_elevation_deg * kWeatherDegToRad));
    s.solar_irradiance_w_m2 = 960.0 * std::pow(sin_e, 1.15) * (1.0 - s.cloud_shadow_0_to_1);

    // Local micro-climate modulation by local cell rain/shadow
    s.ambient_air_c = global_air_c_ - 1.2 * clamp(s.rain_mm_per_hr / 15.0, 0.0, 1.0);
    s.humidity_0_to_1 = clamp(global_humidity_ + 0.14 * clamp(s.rain_mm_per_hr / 10.0, 0.0, 1.0), 0.15, 0.99);
    s.dew_point_c = magnus_dew_point_c(s.ambient_air_c, s.humidity_0_to_1);
    s.barometric_kpa = baro_kpa_ - 0.35 * clamp(s.rain_mm_per_hr / 20.0, 0.0, 1.0);

    // Local asphalt temperature responds spatially to cloud shadows & local rain quenching
    const double shadow_cool = -5.5 * s.cloud_shadow_0_to_1 * sin_e;
    const double rain_quench = -3.0 * clamp(s.rain_mm_per_hr / 12.0, 0.0, 1.0);
    s.track_surface_c = clamp(global_track_c_ + shadow_cool + rain_quench, -18.0, 72.0);

    // Instantaneous wind + continuous gusts
    const Vec3 w_syn = synoptic_wind_mps();
    s.wind_world_mps = {w_syn.x + gust_x_, w_syn.y + gust_y_, 0.0};
    s.wind_speed_mps = std::hypot(s.wind_world_mps.x, s.wind_world_mps.y);
    s.gust_intensity_0_to_1 = clamp(std::hypot(gust_x_, gust_y_) / std::max(cfg_.base_wind_mps * 0.45, 1.0), 0.0, 1.0);

    // Local 2D hydrology & puddle basin state
    const int k = hydro_index(x_m, y_m);
    const double total_w = hydro_water_mm_[k];
    s.surface_water_mm = std::max(0.0, total_w - cfg_.asphalt_porosity_mm * 0.5);
    s.puddle_depth_mm = std::max(0.0, total_w - 0.85);
    s.drying_line_factor = hydro_groove_[k];
    // Visual wetness ramps from 0 (dry) -> 0.35 (damp pore-fill) -> 1.0 (standing puddle mirror)
    s.wetness_0_to_1 = clamp(total_w / 1.15, 0.0, 1.0);

    // Optical visibility, fog density & road spray intensity
    const double rain_ext = 1.0 + 0.45 * s.rain_mm_per_hr + 0.08 * s.rain_mm_per_hr * s.rain_mm_per_hr;
    const double humid_haze = 1.0 + 2.2 * std::pow(clamp((s.humidity_0_to_1 - 0.72) / 0.28, 0.0, 1.0), 2.0);
    s.visibility_m = clamp(24000.0 / (rain_ext * humid_haze), 250.0, 24000.0);
    s.fog_density = clamp(3.0 / s.visibility_m, 0.00012, 0.015);
    s.spray_intensity_0_to_1 = clamp(s.surface_water_mm / 2.2, 0.0, 1.0);
    s.lightning_flash_0_to_1 = lightning_flash_;
    s.thunder_delay_s = last_thunder_delay_s_;
    return s;
}

void WeatherSystem::apply_to_atmosphere(double x_m, double y_m, AtmosphericEnvironment& atm, double& out_road_water_mm) const {
    const WeatherSample s = sample(x_m, y_m);
    atm.enabled = true;
    atm.ambient_air_c = s.ambient_air_c;
    atm.track_surface_c = s.track_surface_c;
    atm.humidity_0_to_1 = s.humidity_0_to_1;
    atm.wind_world_mps = s.wind_world_mps;
    atm.barometric_offset_kpa = s.barometric_kpa - 101.325;
    out_road_water_mm = s.surface_water_mm;
}

WeatherRadarGrid WeatherSystem::sample_radar(double center_x_m, double center_y_m, double range_m) const {
    WeatherRadarGrid g;
    g.center_x_m = center_x_m;
    g.center_y_m = center_y_m;
    g.range_m = std::max(range_m, 500.0);
    constexpr int N = WeatherRadarGrid::kSize;
    const double step_m = (2.0 * g.range_m) / N;
    for (int iy = 0; iy < N; ++iy) {
        const double y = center_y_m - g.range_m + (iy + 0.5) * step_m;
        for (int ix = 0; ix < N; ++ix) {
            const double x = center_x_m - g.range_m + (ix + 0.5) * step_m;
            double r = 0.0, cl = 0.0;
            evaluate_cells_at(x, y, 0.0, r, cl);
            g.rain_mm_hr[iy * N + ix] = static_cast<float>(r);
            g.cloud_cover[iy * N + ix] = static_cast<float>(cl);
        }
    }
    // Upstream advection nowcast across 0..15 min and 15..30 min windows (matches mesoscale radar advection nowcast)
    double peak_r15 = 0.0, peak_c15 = 0.0, peak_r30 = 0.0, peak_c30 = 0.0;
    for (int k = 1; k <= 5; ++k) {
        double r = 0.0, cl = 0.0;
        evaluate_cells_at(center_x_m, center_y_m, k * 180.0, r, cl);
        peak_r15 = std::max(peak_r15, r);
        peak_c15 = std::max(peak_c15, cl);
    }
    for (int k = 6; k <= 10; ++k) {
        double r = 0.0, cl = 0.0;
        evaluate_cells_at(center_x_m, center_y_m, k * 180.0, r, cl);
        peak_r30 = std::max(peak_r30, r);
        peak_c30 = std::max(peak_c30, cl);
    }
    g.rain_chance_15m = clamp(peak_r15 / 3.0 + 0.25 * peak_c15, 0.0, 1.0);
    g.rain_chance_30m = clamp(peak_r30 / 3.0 + 0.25 * peak_c30, 0.0, 1.0);
    return g;
}

}  // namespace rs
