// Apache-2.0 — OpenGrid Dynamic Weather v2 Implementation (pure C++17, zero per-tick allocations).
#include "rs/weather.hpp"
#include "rs/vehicle.hpp"
#include <algorithm>
#include <cmath>

namespace rs {
namespace {

constexpr double kWeatherDegToRad = kPi / 180.0;
constexpr double kWeatherRadToDeg = 180.0 / kPi;

double weather_magnus_dew_point_c(double temp_c, double rh_0_to_1) {
    const double rh = clamp(rh_0_to_1, 0.05, 1.0);
    constexpr double a = 17.625;
    constexpr double b = 243.04;
    const double gamma = std::log(rh) + (a * temp_c) / (b + temp_c);
    return (b * gamma) / std::max(a - gamma, 1e-4);
}

double weather_sat_vapor_kpa(double temp_c) {
    return 0.61078 * std::exp((17.27 * temp_c) / (temp_c + 237.3));
}

double weather_smoothstep(double edge0, double edge1, double x) {
    const double t = clamp((x - edge0) / std::max(edge1 - edge0, 1e-9), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// Deterministic integer 2D hash -> [0, 1] for repeatable sub-meter micro-basin topography.
double weather_hash_2d(int32_t ix, int32_t iy, std::uint32_t seed) {
    std::uint32_t h = static_cast<std::uint32_t>(ix) * 374761393u
                    ^ static_cast<std::uint32_t>(iy) * 668265263u
                    ^ (seed * 1274126177u);
    h = (h ^ (h >> 13)) * 1274126177u;
    h ^= (h >> 16);
    return static_cast<double>(h & 0x00FFFFFFu) / static_cast<double>(0x01000000u);
}

double weather_fine_basin_mm(int32_t wix, int32_t wiy, std::uint32_t seed) {
    // Smooth 4 m puddle pockets superimposed on 1 m micro-texture variations (0..2.2 mm natural depression)
    const double h_coarse = weather_hash_2d(wix >> 2, wiy >> 2, seed ^ 0x51F2A3u);
    const double h_fine = weather_hash_2d(wix, wiy, seed ^ 0x9E3779B9u);
    const double blend = 0.72 * h_coarse + 0.28 * h_fine;
    return clamp((blend - 0.42) * 3.8, 0.0, 2.2);
}

int weather_spatial_bucket(int32_t bx, int32_t by) {
    const std::uint32_t h = (static_cast<std::uint32_t>(bx) * 73856093u)
                          ^ (static_cast<std::uint32_t>(by) * 19349663u);
    return static_cast<int>(h & static_cast<std::uint32_t>(WeatherSystem::kSpatialBuckets - 1));
}

}  // namespace

ClimateProfile WeatherSystem::climate_profile(ClimateRegion region, double custom_lat_deg, double custom_lon_deg) {
    ClimateProfile p;
    p.region = region;
    switch (region) {
        case ClimateRegion::NewYorkMidtown:
            p.latitude_deg = 40.75; p.longitude_deg = -73.99;
            p.jan_mean_c = 0.6; p.jul_mean_c = 25.0; p.diurnal_swing_c = 7.8;
            p.mean_humidity = 0.63; p.winter_rain_prob = 0.33; p.summer_rain_prob = 0.34;
            p.storm_intensity_mm_hr = 13.5; p.mean_wind_mps = 5.4; p.prevailing_wind_deg = 255.0; p.frontal_variability = 0.58;
            break;
        case ClimateRegion::SpaArdennes:
            p.latitude_deg = 50.43; p.longitude_deg = 5.97;
            p.jan_mean_c = 1.2; p.jul_mean_c = 17.4; p.diurnal_swing_c = 8.4;
            p.mean_humidity = 0.80; p.winter_rain_prob = 0.56; p.summer_rain_prob = 0.48;
            p.storm_intensity_mm_hr = 14.0; p.mean_wind_mps = 5.6; p.prevailing_wind_deg = 235.0; p.frontal_variability = 0.84;
            break;
        case ClimateRegion::NurburgringEifel:
            p.latitude_deg = 50.33; p.longitude_deg = 6.95;
            p.jan_mean_c = 0.4; p.jul_mean_c = 16.8; p.diurnal_swing_c = 8.8;
            p.mean_humidity = 0.81; p.winter_rain_prob = 0.54; p.summer_rain_prob = 0.46;
            p.storm_intensity_mm_hr = 13.0; p.mean_wind_mps = 5.8; p.prevailing_wind_deg = 240.0; p.frontal_variability = 0.86;
            break;
        case ClimateRegion::SilverstoneUK:
            p.latitude_deg = 52.07; p.longitude_deg = -1.02;
            p.jan_mean_c = 3.8; p.jul_mean_c = 17.5; p.diurnal_swing_c = 7.6;
            p.mean_humidity = 0.78; p.winter_rain_prob = 0.48; p.summer_rain_prob = 0.40;
            p.storm_intensity_mm_hr = 10.5; p.mean_wind_mps = 6.4; p.prevailing_wind_deg = 240.0; p.frontal_variability = 0.78;
            break;
        case ClimateRegion::BrandsHatchUK:
            p.latitude_deg = 51.35; p.longitude_deg = 0.26;
            p.jan_mean_c = 4.5; p.jul_mean_c = 18.2; p.diurnal_swing_c = 7.4;
            p.mean_humidity = 0.77; p.winter_rain_prob = 0.46; p.summer_rain_prob = 0.36;
            p.storm_intensity_mm_hr = 10.0; p.mean_wind_mps = 5.8; p.prevailing_wind_deg = 235.0; p.frontal_variability = 0.74;
            break;
        case ClimateRegion::MonzaItaly:
            p.latitude_deg = 45.62; p.longitude_deg = 9.28;
            p.jan_mean_c = 2.8; p.jul_mean_c = 24.4; p.diurnal_swing_c = 10.2;
            p.mean_humidity = 0.69; p.winter_rain_prob = 0.28; p.summer_rain_prob = 0.31;
            p.storm_intensity_mm_hr = 16.5; p.mean_wind_mps = 3.2; p.prevailing_wind_deg = 215.0; p.frontal_variability = 0.52;
            break;
        case ClimateRegion::SebringFlorida:
            p.latitude_deg = 27.45; p.longitude_deg = -81.35;
            p.jan_mean_c = 16.2; p.jul_mean_c = 28.4; p.diurnal_swing_c = 9.5;
            p.mean_humidity = 0.75; p.winter_rain_prob = 0.20; p.summer_rain_prob = 0.56;
            p.storm_intensity_mm_hr = 24.0; p.mean_wind_mps = 4.6; p.prevailing_wind_deg = 125.0; p.frontal_variability = 0.66;
            break;
        case ClimateRegion::TokyoWangan:
            p.latitude_deg = 35.65; p.longitude_deg = 139.77;
            p.jan_mean_c = 5.4; p.jul_mean_c = 25.8; p.diurnal_swing_c = 7.2;
            p.mean_humidity = 0.67; p.winter_rain_prob = 0.20; p.summer_rain_prob = 0.44;
            p.storm_intensity_mm_hr = 18.0; p.mean_wind_mps = 5.2; p.prevailing_wind_deg = 185.0; p.frontal_variability = 0.60;
            break;
        case ClimateRegion::LosAngelesCanyons:
            p.latitude_deg = 34.10; p.longitude_deg = -118.41;
            p.jan_mean_c = 14.0; p.jul_mean_c = 23.6; p.diurnal_swing_c = 9.8;
            p.mean_humidity = 0.54; p.winter_rain_prob = 0.18; p.summer_rain_prob = 0.03;
            p.storm_intensity_mm_hr = 8.5; p.mean_wind_mps = 4.2; p.prevailing_wind_deg = 265.0; p.frontal_variability = 0.22;
            break;
        case ClimateRegion::SuzukaJapan:
            p.latitude_deg = 34.84; p.longitude_deg = 136.54;
            p.jan_mean_c = 4.8; p.jul_mean_c = 26.2; p.diurnal_swing_c = 7.8;
            p.mean_humidity = 0.72; p.winter_rain_prob = 0.24; p.summer_rain_prob = 0.48;
            p.storm_intensity_mm_hr = 21.0; p.mean_wind_mps = 5.5; p.prevailing_wind_deg = 165.0; p.frontal_variability = 0.68;
            break;
        case ClimateRegion::LeMansFrance:
            p.latitude_deg = 47.95; p.longitude_deg = 0.21;
            p.jan_mean_c = 4.6; p.jul_mean_c = 20.1; p.diurnal_swing_c = 9.6;
            p.mean_humidity = 0.75; p.winter_rain_prob = 0.42; p.summer_rain_prob = 0.30;
            p.storm_intensity_mm_hr = 11.5; p.mean_wind_mps = 4.6; p.prevailing_wind_deg = 245.0; p.frontal_variability = 0.64;
            break;
        case ClimateRegion::AthensGreece:
            p.latitude_deg = 37.98; p.longitude_deg = 23.73;
            p.jan_mean_c = 9.8; p.jul_mean_c = 29.4; p.diurnal_swing_c = 9.2;
            p.mean_humidity = 0.52; p.winter_rain_prob = 0.26; p.summer_rain_prob = 0.05;
            p.storm_intensity_mm_hr = 11.0; p.mean_wind_mps = 5.6; p.prevailing_wind_deg = 25.0; p.frontal_variability = 0.26;
            break;
        case ClimateRegion::CustomLatLon:
        default: {
            const double lat = clamp(custom_lat_deg, -75.0, 75.0);
            const double abs_lat = std::abs(lat);
            p.latitude_deg = lat;
            p.longitude_deg = clamp(custom_lon_deg, -180.0, 180.0);
            const double mean_c = clamp(30.0 - 0.38 * abs_lat, -6.0, 29.0);
            const double seasonal_amp = clamp(0.18 * abs_lat, 1.5, 11.5);
            p.jan_mean_c = (lat >= 0.0) ? (mean_c - seasonal_amp) : (mean_c + seasonal_amp);
            p.jul_mean_c = (lat >= 0.0) ? (mean_c + seasonal_amp) : (mean_c - seasonal_amp);
            p.diurnal_swing_c = 8.5;
            p.mean_humidity = clamp(0.76 - 0.005 * std::abs(abs_lat - 25.0), 0.45, 0.82);
            const double belt_rain = (abs_lat < 18.0 || abs_lat > 44.0) ? 0.42 : 0.24;
            p.winter_rain_prob = belt_rain;
            p.summer_rain_prob = (abs_lat < 25.0) ? 0.48 : belt_rain * 0.85;
            p.storm_intensity_mm_hr = (abs_lat < 30.0) ? 19.0 : 12.0;
            p.mean_wind_mps = 4.8 + 0.03 * abs_lat;
            p.prevailing_wind_deg = (abs_lat < 30.0) ? 105.0 : 250.0; // trade winds vs mid-latitude westerlies
            p.frontal_variability = (abs_lat > 38.0) ? 0.70 : 0.42;
            break;
        }
    }
    return p;
}

void WeatherSystem::configure_for_region(ClimateRegion region, int day_of_year, double local_hour,
                                         std::uint32_t seed, double time_scale,
                                         double custom_lat_deg, double custom_lon_deg) {
    const ClimateProfile cp = climate_profile(region, custom_lat_deg, custom_lon_deg);
    const int doy = clamp(day_of_year, 1, 365);
    // Seasonal phase: 0 in mid-January (doy ~15), 1 in mid-July (doy ~197)
    const double season_0_1 = 0.5 - 0.5 * std::cos((2.0 * kPi / 365.0) * (doy - 15));
    const double mean_c = lerp(cp.jan_mean_c, cp.jul_mean_c, season_0_1);
    const double rain_prob = lerp(cp.winter_rain_prob, cp.summer_rain_prob, season_0_1);

    // Deterministic seeded rolls from regional normals
    std::uint32_t s = seed ? seed : 1337u;
    auto roll = [&]() {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return static_cast<double>(s & 0x00FFFFFFu) / static_cast<double>(0x01000000u);
    };
    const double r_sky = roll();
    const double r_temp = (roll() - 0.5) * 6.0;
    const double r_wind = 0.65 + 0.75 * roll();
    const double r_dir = (roll() - 0.5) * 55.0;

    WeatherConfig cfg;
    cfg.seed = seed ? seed : 1337u;
    cfg.latitude_deg = cp.latitude_deg;
    cfg.day_of_year = doy;
    cfg.start_hour_local = local_hour;
    cfg.time_scale = std::max(0.0, time_scale);
    cfg.base_ambient_c = clamp(mean_c + r_temp, -12.0, 44.0);
    cfg.base_humidity = clamp(cp.mean_humidity + (roll() - 0.5) * 0.16, 0.20, 0.96);
    cfg.base_wind_mps = clamp(cp.mean_wind_mps * r_wind, 0.8, 22.0);
    cfg.wind_direction_deg = std::fmod(cp.prevailing_wind_deg + r_dir + 360.0, 360.0);

    // Pick realistic weather regime matching this city/circuit's seasonal rain probability & frontal variability
    if (r_sky < rain_prob * 0.25) {
        cfg.preset = WeatherPreset::HeavyStorm;
    } else if (r_sky < rain_prob * 0.60) {
        cfg.preset = WeatherPreset::LightRain;
    } else if (r_sky < rain_prob * (0.60 + 0.55 * cp.frontal_variability)) {
        cfg.preset = WeatherPreset::DynamicFront;
    } else if (r_sky < rain_prob + 0.14) {
        cfg.preset = WeatherPreset::DryingTrack;
    } else if (r_sky < rain_prob + 0.45) {
        cfg.preset = WeatherPreset::PartlyCloudy;
    } else {
        cfg.preset = WeatherPreset::Clear;
    }
    configure(cfg);
}

void WeatherSystem::configure_from_live_observation(const RealWeatherObservation& obs, std::uint32_t seed,
                                                    double time_scale) {
    WeatherConfig cfg;
    cfg.seed = seed ? seed : 1337u;
    cfg.latitude_deg = clamp(obs.latitude_deg, -85.0, 85.0);
    cfg.day_of_year = clamp(obs.day_of_year, 1, 365);
    cfg.start_hour_local = obs.local_hour;
    cfg.time_scale = std::max(0.0, time_scale);
    cfg.base_ambient_c = clamp(obs.ambient_air_c, -30.0, 52.0);
    cfg.base_humidity = clamp(obs.humidity_0_to_1, 0.10, 0.99);
    cfg.base_wind_mps = clamp(obs.wind_speed_mps, 0.2, 35.0);
    cfg.wind_direction_deg = std::fmod(std::fmod(obs.wind_direction_deg, 360.0) + 360.0, 360.0);

    const double rain = std::max(0.0, obs.rain_mm_per_hr);
    const double f15 = obs.forecast_rain_15m_mm_hr >= 0.0 ? obs.forecast_rain_15m_mm_hr : rain;
    const double f30 = obs.forecast_rain_30m_mm_hr >= 0.0 ? obs.forecast_rain_30m_mm_hr : f15;
    const double cloud = clamp(obs.cloud_cover_0_to_1, 0.0, 1.0);

    if (rain >= 10.0) {
        cfg.preset = WeatherPreset::HeavyStorm;
    } else if (rain >= 0.6) {
        cfg.preset = WeatherPreset::LightRain;
    } else if (f15 >= 0.8 || f30 >= 1.2) {
        cfg.preset = WeatherPreset::DynamicFront;
    } else if (cloud >= 0.35) {
        cfg.preset = WeatherPreset::PartlyCloudy;
    } else {
        cfg.preset = WeatherPreset::Clear;
    }
    configure(cfg);

    // Pin synoptic barometric pressure, air temp, humidity & primary cell intensity directly to the real observation!
    global_air_c_ = cfg.base_ambient_c;
    global_humidity_ = cfg.base_humidity;

    // Anchor primary cell[0] to exact live rain/cloud and cell[1] upstream to the short-term forecast if provided
    const Vec3 w = synoptic_wind_mps();
    const double w_len = std::hypot(w.x, w.y);
    const double wx = w_len > 0.2 ? (w.x / w_len) : 1.0;
    const double wy = w_len > 0.2 ? (w.y / w_len) : 0.0;
    const double wind_angle = std::atan2(wy, wx);

    cells_[0].active = (rain > 0.05 || cloud > 0.10);
    cells_[0].x_m = 0.0;
    cells_[0].y_m = 0.0;
    cells_[0].rain_radius_m = 4800.0;
    cells_[0].cloud_radius_m = 8800.0;
    cells_[0].band_angle_rad = wind_angle + 0.5 * kPi;
    cells_[0].aspect_ratio = 2.4;
    cells_[0].age_s = 900.0;
    cells_[0].lifetime_s = 3600.0;
    cells_[0].peak_cloud_cover = cloud;
    const double preset_base_rain = (cfg.preset == WeatherPreset::HeavyStorm) ? 8.5
                                  : (cfg.preset == WeatherPreset::LightRain)  ? 2.2
                                  : 0.0;
    cells_[0].peak_rain_mm_hr = std::max(0.0, rain - preset_base_rain);

    if (obs.forecast_rain_15m_mm_hr >= 0.5 || obs.forecast_rain_30m_mm_hr >= 0.5) {
        const double f_peak = std::max(f15, f30);
        const double lead_s = (f15 >= f30) ? 900.0 : 1800.0;
        const double upstream_m = std::max(1200.0, w_len * 0.55 * lead_s);
        cells_[1].active = true;
        cells_[1].x_m = -wx * upstream_m;
        cells_[1].y_m = -wy * upstream_m;
        cells_[1].rain_radius_m = 2800.0;
        cells_[1].cloud_radius_m = 5600.0;
        cells_[1].band_angle_rad = wind_angle + 0.5 * kPi;
        cells_[1].aspect_ratio = 3.0;
        cells_[1].age_s = 300.0;
        cells_[1].lifetime_s = 4200.0;
        cells_[1].peak_cloud_cover = clamp(0.65 + 0.30 * clamp(f_peak / 10.0, 0.0, 1.0), 0.0, 0.99);
        cells_[1].peak_rain_mm_hr = clamp(f_peak, 0.0, 45.0);
    }

    // Offset base barometric pressure by local cell p_drop so sample(0,0).barometric_kpa matches the real gauge reading!
    double r_chk = 0.0, c_chk = 0.0, p_drop_chk = 0.0;
    evaluate_cells_at(0.0, 0.0, 0.0, r_chk, c_chk, &p_drop_chk);
    baro_kpa_ = clamp(obs.barometric_kpa + 0.35 * p_drop_chk, 94.0, 105.0);

    // Scale initial standing water proportionally to real observed rain rate
    const double init_w = rain > 0.1 ? clamp(0.25 + 0.14 * rain, 0.0, 3.8) : 0.0;
    for (int k = 0; k < kHydroRes * kHydroRes; ++k) {
        hydro_water_mm_[k] = init_w > 0.0 ? clamp(init_w * (0.75 + 0.45 * hydro_basin_mm_[k]), 0.0, 8.0) : 0.0;
    }
    for (auto& fc : fine_cells_) fc = FineCell{};
    if (has_track_geometry()) init_track_cells_from_preset(init_w);
}

double WeatherSystem::next_rand_01() {
    // Xorshift32: fast, portable, 100% deterministic across x64, ARM, MSVC, GCC, Clang & Emscripten WASM
    std::uint32_t x = rng_state_ ? rng_state_ : 2463534242u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    rng_state_ = x;
    return static_cast<double>(x & 0x00FFFFFFu) / static_cast<double>(0x01000000u);
}

double WeatherSystem::live_wind_direction_deg() const {
    double dir = std::fmod(cfg_.wind_direction_deg + wind_veer_deg_, 360.0);
    if (dir < 0.0) dir += 360.0;
    return dir;
}

Vec3 WeatherSystem::synoptic_wind_mps() const {
    // Meteorological wind direction = direction wind blows FROM; velocity vector points opposite (+180 deg)
    // Core coordinates: +X = East/Forward, +Y = North/Left, +Z = Up
    const double to_rad = (live_wind_direction_deg() + 180.0) * kWeatherDegToRad;
    return {cfg_.base_wind_mps * std::sin(to_rad), cfg_.base_wind_mps * std::cos(to_rad), 0.0};
}

void WeatherSystem::add_wind_shelter_zone(const WindShelterZone& zone) {
    wind_shelters_.push_back(zone);
}

double WeatherSystem::wind_shelter_at(double x_m, double y_m, double* out_edge_shear) const {
    double shelter = 0.0;
    double edge_shear = 0.0;
    int st_i = -1, lane_j = -1;
    double d_m = 0.0;
    if (project_to_track(x_m, y_m, st_i, lane_j, d_m)) {
        const double st_sh = clamp(track_stations_[st_i].st.wind_shelter_0_to_1, 0.0, 1.0);
        shelter = std::max(shelter, st_sh);
        // Check longitudinal neighbor shelter transition for grandstand/canyon exit shear!
        const int n_st = static_cast<int>(track_stations_.size());
        const int prev_i = (st_i > 0) ? (st_i - 1) : (track_closed_loop_ ? n_st - 1 : 0);
        const int next_i = (st_i + 1 < n_st) ? (st_i + 1) : (track_closed_loop_ ? 0 : n_st - 1);
        const double grad = std::max(std::abs(st_sh - track_stations_[prev_i].st.wind_shelter_0_to_1),
                                     std::abs(st_sh - track_stations_[next_i].st.wind_shelter_0_to_1));
        edge_shear = std::max(edge_shear, clamp(grad, 0.0, 1.0));
    }
    for (const WindShelterZone& z : wind_shelters_) {
        const double dx = std::abs(x_m - z.center_x_m);
        const double dy = std::abs(y_m - z.center_y_m);
        const double hx = std::max(z.half_x_m, 1.0);
        const double hy = std::max(z.half_y_m, 1.0);
        const double margin = 8.0; // 8 m turbulent wake-shear transition band around building/grandstand edges
        if (dx < hx + margin && dy < hy + margin) {
            const double fx = 1.0 - weather_smoothstep(hx - 2.0, hx + margin, dx);
            const double fy = 1.0 - weather_smoothstep(hy - 2.0, hy + margin, dy);
            const double s_zone = clamp(z.shelter_0_to_1, 0.0, 1.0) * fx * fy;
            shelter = std::max(shelter, s_zone);
            if (s_zone > 0.08 && s_zone < 0.85) {
                edge_shear = std::max(edge_shear, 4.0 * s_zone * (1.0 - s_zone));
            }
        }
    }
    if (out_edge_shear) *out_edge_shear = clamp(edge_shear, 0.0, 1.0);
    return clamp(shelter, 0.0, 1.0);
}

Vec3 WeatherSystem::wind_at(double x_m, double y_m, double local_rain_mm_hr) const {
    const Vec3 w_syn = synoptic_wind_mps();
    double edge_shear = 0.0;
    const double shelter = wind_shelter_at(x_m, y_m, &edge_shear);
    const double open_scale = 1.0 - 0.82 * shelter;

    // Spatial phase modulation so distant sectors on a circuit experience asynchronous turbulent gusts
    const double spatial_p = x_m * 0.0042 + y_m * 0.0037;
    const double c = std::cos(spatial_p);
    const double s = std::sin(spatial_p);
    const double gx = gust_x_ * (0.72 + 0.28 * c) - gust_y_ * (0.28 * s);
    const double gy = gust_y_ * (0.72 + 0.28 * c) + gust_x_ * (0.28 * s);
    // Convective downdraft / cross-burst enhancement inside heavy storm cores + grandstand/building exit eddy shear
    const double storm_scale = 1.0 + 0.35 * clamp(local_rain_mm_hr / 18.0, 0.0, 1.0) + 0.65 * edge_shear;
    const double shear_burst = edge_shear * cfg_.base_wind_mps * 0.38 * std::sin(gust_phase_ * 3.1 + spatial_p * 5.0);
    const double gz = gust_z_ * storm_scale - 0.65 * clamp((local_rain_mm_hr - 10.0) / 18.0, 0.0, 1.0);
    return {w_syn.x * open_scale + gx * storm_scale * (0.35 + 0.65 * open_scale) + shear_burst,
            w_syn.y * open_scale + gy * storm_scale * (0.35 + 0.65 * open_scale) - shear_burst * 0.7,
            gz * (0.4 + 0.6 * open_scale)};
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

WeatherSystem::FineCell& WeatherSystem::ensure_fine_cell(int32_t wix, int32_t wiy) const {
    const int lx = ((wix % kFineRes) + kFineRes) % kFineRes;
    const int ly = ((wiy % kFineRes) + kFineRes) % kFineRes;
    FineCell& fc = fine_cells_[ly * kFineRes + lx];
    if (fc.world_ix != wix || fc.world_iy != wiy) {
        const double cx = static_cast<double>(wix) + 0.5;
        const double cy = static_cast<double>(wiy) + 0.5;
        const int mk = hydro_index(cx, cy);
        fc.world_ix = wix;
        fc.world_iy = wiy;
        fc.basin_mm = weather_fine_basin_mm(wix, wiy, cfg_.seed);
        const double macro_w = hydro_water_mm_[mk];
        // Pool extra standing water inside local 1 m depressions when macro road is wet
        fc.water_mm = macro_w > 0.02 ? clamp(macro_w * (0.72 + 0.38 * fc.basin_mm), 0.0, 10.0) : 0.0;
        fc.rubber = 0.0;
        fc.mud = 0.0;
        fc.ice = (global_track_c_ <= 0.1 && fc.water_mm > 0.03) ? clamp(global_ice_, 0.0, 1.0) : 0.0;
        fc.groove = hydro_groove_[mk];
        fc.temp_c = global_track_c_;
        fc.base_temp_c = global_base_c_;
        fc.last_sync_s = sim_time_s_;
    }
    return fc;
}

double WeatherSystem::compute_surface_mu_mult(double water_mm, double rubber, WeatherSurfaceType surface,
                                              double ice_0_to_1, double mud_0_to_1) {
    const double r = clamp(rubber, 0.0, 1.0);
    const double w = std::max(0.0, water_mm);
    double mu = 1.0;
    switch (surface) {
        case WeatherSurfaceType::PaintedKerb:
        case WeatherSurfaceType::PaintedLine: {
            // Paint has zero macro-texture porosity: a thin 0.03-0.18 mm film turns painted kerbs/lines ice-slick (~0.46x)
            const double slick_blend = weather_smoothstep(0.02, 0.16, w);
            mu = lerp(0.96, 0.46, slick_blend);
            break;
        }
        case WeatherSurfaceType::Concrete: {
            const double wet_blend = weather_smoothstep(0.03, 0.20, w);
            const double dry_mu = 0.98 + 0.05 * r;
            const double wet_mu = 0.82 - 0.14 * r;
            mu = clamp(lerp(dry_mu, wet_mu, wet_blend), 0.50, 1.08);
            break;
        }
        case WeatherSurfaceType::Grass:
            mu = lerp(1.0, 0.62, weather_smoothstep(0.03, 0.25, w));
            break;
        case WeatherSurfaceType::Gravel:
            mu = lerp(1.0, 0.84, weather_smoothstep(0.05, 0.40, w));
            break;
        case WeatherSurfaceType::Asphalt:
        default: {
            // Real-world "Rain Line" physics:
            //   Dry (< 0.04 mm): laid-down rubber raises peak grip up to +8% over green off-line tarmac.
            //   Wet (>= 0.08 mm): smooth rubber fills asphalt micro-texture pores -> hydrophobic sheen (-24% vs clean tarmac),
            //                     making the off-line wet line genuinely faster than the rubbered dry line!
            const double wet_inv = weather_smoothstep(0.04, 0.22, w);
            const double dry_mu = 1.0 + 0.08 * r;
            const double wet_mu = 1.0 - 0.24 * r;
            mu = clamp(lerp(dry_mu, wet_mu, wet_inv), 0.65, 1.12);
            break;
        }
    }
    // Dragged-on wet mud / off-track dirt drops asphalt grip up to -42% until washed/scrubbed clean
    const double mud = clamp(mud_0_to_1, 0.0, 1.0);
    if (mud > 0.005) {
        mu = lerp(mu, std::min(mu, 0.54), mud);
    }
    // Black ice / frozen standing water drops surface friction catastrophically toward ~0.15x!
    const double ice = clamp(ice_0_to_1, 0.0, 1.0);
    if (ice > 0.005) {
        mu = lerp(mu, 0.15, ice);
    }
    return clamp(mu, 0.14, 1.15);
}

void WeatherSystem::spawn_cell(int slot, bool initial_scatter) {
    StormCell& c = cells_[slot];
    c = StormCell{};
    const double domain = std::max(cfg_.domain_half_extent_m * 2.5, 9000.0);
    const Vec3 w = synoptic_wind_mps();
    const double w_len = std::hypot(w.x, w.y);
    const double wx = w_len > 0.2 ? (w.x / w_len) : 1.0;
    const double wy = w_len > 0.2 ? (w.y / w_len) : 0.0;
    const double wind_angle = std::atan2(wy, wx);

    if (initial_scatter) {
        c.x_m = (next_rand_01() * 2.0 - 1.0) * domain;
        c.y_m = (next_rand_01() * 2.0 - 1.0) * domain;
        c.age_s = next_rand_01() * 1200.0;
    } else {
        // Respawn upstream of the domain so new frontal bands roll in naturally with the prevailing wind
        const double cross = (next_rand_01() * 2.0 - 1.0) * domain * 0.85;
        const double upstream = domain * (0.95 + 0.35 * next_rand_01());
        c.x_m = -wx * upstream - wy * cross;
        c.y_m = -wy * upstream + wx * cross;
        c.age_s = 0.0;
    }

    c.lifetime_s = 2200.0 + next_rand_01() * 2600.0;
    c.rain_radius_m = 1600.0 + next_rand_01() * 2400.0;
    c.cloud_radius_m = c.rain_radius_m * (2.1 + 0.7 * next_rand_01());
    // Frontal rain bands align roughly perpendicular to steering wind (+-35 deg)
    c.band_angle_rad = wind_angle + 0.5 * kPi + (next_rand_01() - 0.5) * 1.1;
    c.aspect_ratio = 1.15 + 1.85 * next_rand_01();
    c.vertical_shear_mps = 0.8 + 2.4 * next_rand_01();
    c.pressure_drop_kpa = 0.25 + 0.65 * next_rand_01();

    switch (cfg_.preset) {
        case WeatherPreset::Clear:
            c.active = (slot < 2);
            c.peak_cloud_cover = 0.14 + 0.12 * next_rand_01();
            c.peak_rain_mm_hr = 0.0;
            c.aspect_ratio = 1.2;
            c.pressure_drop_kpa = 0.05;
            break;
        case WeatherPreset::PartlyCloudy:
            c.active = (slot < 6);
            c.peak_cloud_cover = 0.48 + 0.34 * next_rand_01();
            c.peak_rain_mm_hr = 0.0;
            c.aspect_ratio = 1.3 + 1.1 * next_rand_01();
            c.pressure_drop_kpa = 0.15;
            break;
        case WeatherPreset::DynamicFront:
            c.active = (slot < 6);
            if (initial_scatter && slot == 0) {
                // Elongated mesoscale cold-front rain band ~2.8 km upstream: dry start -> rain arrives -> clears!
                c.x_m = -wx * 2800.0;
                c.y_m = -wy * 2800.0;
                c.rain_radius_m = 2400.0;
                c.cloud_radius_m = 5200.0;
                c.band_angle_rad = wind_angle + 0.5 * kPi;
                c.aspect_ratio = 3.2;
                c.pressure_drop_kpa = 1.65;
                c.peak_cloud_cover = 0.92;
                c.peak_rain_mm_hr = 11.5;
                c.age_s = 400.0;
            } else {
                c.peak_cloud_cover = 0.55 + 0.40 * next_rand_01();
                c.peak_rain_mm_hr = (slot < 4) ? (4.0 + 10.0 * next_rand_01()) : 0.0;
                c.aspect_ratio = 1.8 + 1.8 * next_rand_01();
                c.pressure_drop_kpa = 0.55 + 0.95 * next_rand_01();
            }
            break;
        case WeatherPreset::LightRain:
            c.active = (slot < 7);
            if (initial_scatter && slot == 0) {
                c.x_m = 0.0;
                c.y_m = 0.0;
                c.rain_radius_m = 5200.0;
                c.cloud_radius_m = 9500.0;
                c.aspect_ratio = 2.4;
                c.pressure_drop_kpa = 1.1;
                c.peak_cloud_cover = 0.88;
                c.peak_rain_mm_hr = 4.5;
            } else {
                c.peak_cloud_cover = 0.75 + 0.20 * next_rand_01();
                c.peak_rain_mm_hr = 2.5 + 4.0 * next_rand_01();
                c.aspect_ratio = 1.8 + 1.4 * next_rand_01();
            }
            break;
        case WeatherPreset::HeavyStorm:
            c.active = true;
            if (initial_scatter && slot == 0) {
                c.x_m = 0.0;
                c.y_m = 0.0;
                c.rain_radius_m = 5600.0;
                c.cloud_radius_m = 10500.0;
                c.aspect_ratio = 2.8;
                c.pressure_drop_kpa = 2.4;
                c.peak_cloud_cover = 0.99;
                c.peak_rain_mm_hr = 22.0;
            } else {
                c.peak_cloud_cover = 0.88 + 0.12 * next_rand_01();
                c.peak_rain_mm_hr = 10.0 + 18.0 * next_rand_01();
                c.aspect_ratio = 1.5 + 2.2 * next_rand_01();
                c.pressure_drop_kpa = 1.4 + 1.1 * next_rand_01();
            }
            break;
        case WeatherPreset::DryingTrack:
            c.active = (slot < 5);
            if (initial_scatter && slot == 0) {
                c.x_m = wx * 3600.0;
                c.y_m = wy * 3600.0;
                c.aspect_ratio = 2.6;
                c.pressure_drop_kpa = 0.6;
                c.peak_cloud_cover = 0.78;
                c.peak_rain_mm_hr = 3.0;
            } else {
                c.peak_cloud_cover = 0.30 + 0.35 * next_rand_01();
                c.peak_rain_mm_hr = 0.0;
            }
            break;
    }
}

void WeatherSystem::init_track_cells_from_preset(double init_water_mm) {
    const std::size_t n_st = track_stations_.size();
    if (n_st < 2) return;
    const std::size_t total = n_st * static_cast<std::size_t>(kTrackLanes);
    track_water_mm_.assign(total, 0.0);
    track_water_scratch_.assign(total, 0.0);
    track_rubber_.assign(total, 0.0);
    track_mud_.assign(total, 0.0);
    track_ice_.assign(total, 0.0);
    track_temp_c_.assign(total, global_track_c_);
    track_base_temp_c_.assign(total, global_base_c_);
    track_groove_.assign(total, 0.0);
    track_elev_mm_.assign(total, 0.0);

    for (std::size_t i = 0; i < n_st; ++i) {
        const TrackWeatherStation& st = track_stations_[i].st;
        const double half_w = 0.5 * std::max(st.width_m, 4.0);
        for (int j = 0; j < kTrackLanes; ++j) {
            const std::size_t idx = i * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(j);
            // Lateral position d across road (-half_w = right kerb .. +half_w = left kerb)
            // Lane 0 = Left Painted Kerb (+half_w), Lane 15 = Right Painted Kerb (-half_w)
            const double frac = (static_cast<double>(j) + 0.5) / static_cast<double>(kTrackLanes);
            const double d_m = (0.5 - frac) * (2.0 * half_w);
            const double norm_d = clamp(d_m / half_w, -1.0, 1.0);
            // Physical surface height (mm): centerline elevation + lateral banking + parabolic center crown - micro-basin
            // Positive banking_rad = right edge (-d) higher, so water drains toward +d (left inside)
            const double bank_z_m = -d_m * std::sin(st.banking_rad);
            const double crown_z_m = st.crown_m * (1.0 - norm_d * norm_d);
            const double micro_dip_mm = 1.6 * weather_hash_2d(static_cast<int32_t>(i), static_cast<int32_t>(j), cfg_.seed ^ 0xA17Bu);
            // Kerb gutter sits slightly lower than crown so puddles can pool right next to kerbs
            const double kerb_lip_mm = (j == 0 || j == kTrackLanes - 1) ? 14.0 : 0.0;
            track_elev_mm_[idx] = (st.z_m + bank_z_m + crown_z_m) * 1000.0 + kerb_lip_mm - micro_dip_mm;

            // Pre-session rubber distribution centered on st.ideal_offset_m (Gaussian ~1.6 m half-width)
            const double dist_ideal = d_m - st.ideal_offset_m;
            const double rub = (j == 0 || j == kTrackLanes - 1)
                             ? 0.0
                             : clamp(st.initial_rubber * std::exp(-(dist_ideal * dist_ideal) / (1.8 * 1.8)), 0.0, 1.0);
            track_rubber_[idx] = rub;

            // Shaded stations start cooler than sunlit stations (both 4 mm skin & 50 mm subsurface base)
            track_temp_c_[idx] = clamp(global_track_c_ - 6.5 * clamp(st.shade_0_to_1, 0.0, 1.0), -18.0, 72.0);
            track_base_temp_c_[idx] = clamp(global_base_c_ - 3.5 * clamp(st.shade_0_to_1, 0.0, 1.0), -18.0, 62.0);
            // Initial standing water pools deeper in low spots & poor-drainage zones
            if (init_water_mm > 0.0) {
                const double low_bias = clamp(1.0 + 0.25 * micro_dip_mm - 0.15 * (crown_z_m / std::max(st.crown_m, 0.01)), 0.6, 1.8);
                track_water_mm_[idx] = clamp(init_water_mm * low_bias, 0.0, 10.0);
                if (track_temp_c_[idx] <= 0.0 && track_water_mm_[idx] > 0.04) {
                    track_ice_[idx] = clamp(-track_temp_c_[idx] / 3.0, 0.2, 1.0);
                }
            }
        }
    }
}

void WeatherSystem::configure(const WeatherConfig& cfg) {
    cfg_ = cfg;
    sim_time_s_ = 0.0;
    local_hour_ = std::fmod(std::fmod(cfg.start_hour_local, 24.0) + 24.0, 24.0);
    rng_state_ = cfg.seed ? cfg.seed : 1337u;
    wind_veer_deg_ = 0.0;
    gust_x_ = gust_y_ = gust_z_ = gust_phase_ = 0.0;
    lightning_flash_ = 0.0;
    lightning_cooldown_s_ = 5.0;
    last_thunder_delay_s_ = -1.0;
    spray_cursor_ = 0;
    spray_emit_accum_s_ = 0.0;
    for (auto& sp : spray_plumes_) sp = SprayPlume{};

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

    // Deterministic macro topographical drainage basins
    for (int iy = 0; iy < kHydroRes; ++iy) {
        for (int ix = 0; ix < kHydroRes; ++ix) {
            const int k = iy * kHydroRes + ix;
            const double fx = (static_cast<double>(ix) / kHydroRes) * 2.0 * kPi;
            const double fy = (static_cast<double>(iy) / kHydroRes) * 2.0 * kPi;
            const double h = 0.50
                           + 0.30 * std::sin(2.0 * fx + 0.7) * std::cos(2.0 * fy - 0.4)
                           + 0.20 * std::sin(5.0 * fx - 3.0 * fy + 1.1);
            const double basin = clamp((0.52 - h) * 4.5, 0.0, 2.4);
            hydro_basin_mm_[k] = basin;
            hydro_water_mm_[k] = init_water_mm > 0.0 ? clamp(init_water_mm * (0.75 + 0.45 * basin), 0.0, 8.0) : 0.0;
            hydro_groove_[k] = 0.0;
        }
    }
    // Reset 1.0 m toroidal fine open-world cells so they lazily hydrate from fresh macro/preset state
    for (auto& fc : fine_cells_) fc = FineCell{};

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
    global_base_c_ = clamp(global_air_c_ + 0.55 * solar_lift, -15.0, 58.0);
    global_ice_ = (global_track_c_ <= 0.0 && init_water_mm > 0.04) ? clamp(-global_track_c_ / 3.0, 0.2, 1.0) : 0.0;

    if (has_track_geometry()) {
        init_track_cells_from_preset(init_water_mm);
    }
}

void WeatherSystem::bind_track_geometry(const std::vector<TrackWeatherStation>& stations, bool closed_loop) {
    track_closed_loop_ = closed_loop;
    track_stations_.clear();
    if (stations.size() < 2) {
        clear_track_geometry();
        return;
    }
    track_stations_.resize(stations.size());
    const std::size_t n = stations.size();
    for (std::size_t i = 0; i < n; ++i) {
        TrackStationPrecomp& p = track_stations_[i];
        p.st = stations[i];
        const std::size_t prev = (i == 0) ? (closed_loop ? n - 1 : 0) : i - 1;
        const std::size_t next = (i + 1 == n) ? (closed_loop ? 0 : n - 1) : i + 1;
        const double dx = stations[next].x_m - stations[prev].x_m;
        const double dy = stations[next].y_m - stations[prev].y_m;
        const double len = std::hypot(dx, dy);
        if (len > 1e-4) {
            p.tx = dx / len;
            p.ty = dy / len;
        }
        p.lx = -p.ty;
        p.ly = p.tx;
        const std::size_t fwd_i = (i + 1 < n) ? i + 1 : (closed_loop ? 0 : i);
        p.seg_len_m = std::max(1.0, std::hypot(stations[fwd_i].x_m - stations[i].x_m,
                                               stations[fwd_i].y_m - stations[i].y_m));
    }
    const double init_w = hydro_water_mm_[hydro_index(0.0, 0.0)];
    init_track_cells_from_preset(init_w);
    rebuild_spatial_index();
}

bool WeatherSystem::bind_track_heightfield(const std::vector<double>& cell_elev_mm) {
    const std::size_t expected = track_stations_.size() * static_cast<std::size_t>(kTrackLanes);
    if (expected == 0 || cell_elev_mm.size() != expected) return false;
    track_elev_mm_ = cell_elev_mm;
    return true;
}

void WeatherSystem::rebuild_spatial_index() {
    spatial_heads_.fill(-1);
    const int n = static_cast<int>(track_stations_.size());
    spatial_next_.assign(static_cast<std::size_t>(n), -1);
    for (int i = 0; i < n; ++i) {
        const int32_t bx = static_cast<int32_t>(std::floor(track_stations_[i].st.x_m / kSpatialBucketM));
        const int32_t by = static_cast<int32_t>(std::floor(track_stations_[i].st.y_m / kSpatialBucketM));
        const int b = weather_spatial_bucket(bx, by);
        spatial_next_[i] = spatial_heads_[b];
        spatial_heads_[b] = i;
    }
}

void WeatherSystem::clear_track_geometry() {
    track_stations_.clear();
    spatial_heads_.fill(-1);
    spatial_next_.clear();
    track_water_mm_.clear();
    track_water_scratch_.clear();
    track_rubber_.clear();
    track_mud_.clear();
    track_ice_.clear();
    track_temp_c_.clear();
    track_base_temp_c_.clear();
    track_groove_.clear();
    track_elev_mm_.clear();
}

bool WeatherSystem::project_to_track(double x_m, double y_m, int& out_station, int& out_lane, double& out_d_m) const {
    if (track_stations_.size() < 2) return false;
    double best_d2 = 1e18;
    int best_i = -1;

    // O(1) 3x3 spatial bucket lookup (~50 m radius around query point): handles 20 km+ / 10,000-station tracks at 400 Hz!
    const int32_t bx0 = static_cast<int32_t>(std::floor(x_m / kSpatialBucketM));
    const int32_t by0 = static_cast<int32_t>(std::floor(y_m / kSpatialBucketM));
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            const int b = weather_spatial_bucket(bx0 + dx, by0 + dy);
            for (int i = spatial_heads_[b]; i >= 0; i = spatial_next_[i]) {
                const double ex = x_m - track_stations_[i].st.x_m;
                const double ey = y_m - track_stations_[i].st.y_m;
                const double d2 = ex * ex + ey * ey;
                if (d2 < best_d2) {
                    best_d2 = d2;
                    best_i = i;
                }
            }
        }
    }
    // Fallback for sparse stations spaced > 25 m apart
    if (best_i < 0 && track_stations_.size() <= 512) {
        const int n = static_cast<int>(track_stations_.size());
        for (int i = 0; i < n; ++i) {
            const double ex = x_m - track_stations_[i].st.x_m;
            const double ey = y_m - track_stations_[i].st.y_m;
            const double d2 = ex * ex + ey * ey;
            if (d2 < best_d2) {
                best_d2 = d2;
                best_i = i;
            }
        }
    }
    if (best_i < 0) return false;
    const TrackStationPrecomp& p = track_stations_[best_i];
    const double dx = x_m - p.st.x_m;
    const double dy = y_m - p.st.y_m;
    const double d_lat = dx * p.lx + dy * p.ly;
    const double d_lon = dx * p.tx + dy * p.ty;
    const double half_w = 0.5 * std::max(p.st.width_m, 4.0);
    // Allow 2.2 m kerb/verge margin outside nominal half_w
    if (std::abs(d_lat) > half_w + 2.2 || std::abs(d_lon) > p.seg_len_m * 1.5 + 15.0) {
        return false;
    }
    // Map d_lat in [+half_w .. -half_w] -> lane [0 .. kTrackLanes - 1]
    const double frac = 0.5 - d_lat / (2.0 * half_w);
    const int lane = clamp(static_cast<int>(std::floor(frac * kTrackLanes)), 0, kTrackLanes - 1);
    out_station = best_i;
    out_lane = lane;
    out_d_m = d_lat;
    return true;
}

void WeatherSystem::compute_sun_angles(double& out_elev_deg, double& out_azim_deg) const {
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
                                      double& out_rain_mm_hr, double& out_cloud_0_1,
                                      double* out_pressure_drop_kpa) const {
    const Vec3 w = synoptic_wind_mps();
    const double adv_x = w.x * 0.55 * time_offset_s;
    const double adv_y = w.y * 0.55 * time_offset_s;
    double rain_sum = (cfg_.preset == WeatherPreset::HeavyStorm) ? 8.5
                    : (cfg_.preset == WeatherPreset::LightRain)  ? 2.2
                    : 0.0;
    double clear_prod = (cfg_.preset == WeatherPreset::HeavyStorm) ? 0.08
                      : (cfg_.preset == WeatherPreset::LightRain)  ? 0.25
                      : 1.0;
    double p_drop_sum = 0.0;

    for (const StormCell& c : cells_) {
        if (!c.active) continue;
        const double age = c.age_s + time_offset_s;
        if (age < 0.0 || age > c.lifetime_s) continue;
        const double u = age / std::max(c.lifetime_s, 60.0);
        double life = 1.0;
        if (u < 0.20) life = u / 0.20;
        else if (u > 0.75) life = (1.0 - u) / 0.25;
        life = clamp(life * life * (3.0 - 2.0 * life), 0.0, 1.0);

        // Anisotropic elliptical frontal rain band in rotated storm-band coordinates
        const double dx = x_m - (c.x_m + adv_x);
        const double dy = y_m - (c.y_m + adv_y);
        const double cb = std::cos(c.band_angle_rad);
        const double sb = std::sin(c.band_angle_rad);
        const double along = dx * cb + dy * sb;    // along squall band (major axis)
        const double across = -dx * sb + dy * cb;  // across squall band (minor axis)
        const double inv_ar = 1.0 / std::max(c.aspect_ratio, 1.0);
        const double d2_ellip = across * across + (along * inv_ar) * (along * inv_ar);

        if (c.cloud_radius_m > 10.0) {
            const double rc2 = c.cloud_radius_m * c.cloud_radius_m;
            if (d2_ellip < 6.0 * rc2) {
                const double env = std::exp(-d2_ellip / rc2);
                const double cl = clamp(c.peak_cloud_cover * life * env, 0.0, 0.99);
                clear_prod *= (1.0 - cl);
                p_drop_sum += c.pressure_drop_kpa * life * env;
            }
        }
        if (c.peak_rain_mm_hr > 0.01 && c.rain_radius_m > 10.0) {
            const double rr2 = c.rain_radius_m * c.rain_radius_m;
            if (d2_ellip < 6.0 * rr2) {
                rain_sum += c.peak_rain_mm_hr * life * std::exp(-d2_ellip / rr2);
            }
        }
    }

    out_rain_mm_hr = clamp(rain_sum, 0.0, 60.0);
    out_cloud_0_1 = clamp(1.0 - clear_prod, 0.0, 1.0);
    if (out_pressure_drop_kpa) *out_pressure_drop_kpa = clamp(p_drop_sum, 0.0, 4.0);
}

void WeatherSystem::step(double dt) {
    if (dt <= 0.0) return;
    const double scaled_dt = dt * std::max(cfg_.time_scale, 0.0);
    sim_time_s_ += scaled_dt;
    local_hour_ = std::fmod(local_hour_ + scaled_dt / 3600.0, 24.0);
    if (local_hour_ < 0.0) local_hour_ += 24.0;

    // 1. Advect mesoscale frontal bands along steering wind (+ vertical shear) & respawn upstream
    const Vec3 w_syn = synoptic_wind_mps();
    const double max_dist = std::max(cfg_.domain_half_extent_m * 3.8, 14000.0);
    for (int i = 0; i < kMaxCells; ++i) {
        StormCell& c = cells_[i];
        if (!c.active) continue;
        const double shear_x = c.vertical_shear_mps * 0.25 * std::cos(c.band_angle_rad);
        const double shear_y = c.vertical_shear_mps * 0.25 * std::sin(c.band_angle_rad);
        c.x_m += (w_syn.x * 0.55 + shear_x) * scaled_dt;
        c.y_m += (w_syn.y * 0.55 + shear_y) * scaled_dt;
        c.age_s += scaled_dt;
        if (c.age_s >= c.lifetime_s || std::hypot(c.x_m, c.y_m) > max_dist) {
            spawn_cell(i, false);
        }
    }

    // 2. Evaluate central domain sky/rain/pressure trough & veer synoptic wind as fronts cross
    double center_rain = 0.0, center_cloud = 0.0, center_pdrop = 0.0;
    evaluate_cells_at(0.0, 0.0, 0.0, center_rain, center_cloud, &center_pdrop);
    // Mesoscale frontal veering: approaching/passing pressure trough rotates wind direction up to +-38 deg
    const double target_veer = 24.0 * std::sin(sim_time_s_ / 900.0) + 14.0 * clamp(center_pdrop / 1.5, 0.0, 1.5);
    wind_veer_deg_ += (target_veer - wind_veer_deg_) * clamp(scaled_dt / 240.0, 0.0, 1.0);

    // 3. Continuous 3D Dryden-like turbulent wind gusts (stronger in convective storms!)
    gust_phase_ += dt * (0.45 + 0.04 * cfg_.base_wind_mps);
    const double storm_gust_amp = cfg_.base_wind_mps * (0.18 + 0.22 * clamp(center_rain / 15.0, 0.0, 1.0));
    const double target_gx = storm_gust_amp * (0.65 * std::sin(gust_phase_ * 1.13 + 0.4) + 0.35 * std::sin(gust_phase_ * 2.87 + 1.9));
    const double target_gy = storm_gust_amp * (0.65 * std::cos(gust_phase_ * 0.91 + 1.2) + 0.35 * std::sin(gust_phase_ * 2.41 - 0.7));
    const double target_gz = storm_gust_amp * 0.22 * std::sin(gust_phase_ * 1.73 + 0.8);
    const double g_alpha = clamp(dt / 2.2, 0.0, 1.0);
    gust_x_ += (target_gx - gust_x_) * g_alpha;
    gust_y_ += (target_gy - gust_y_) * g_alpha;
    gust_z_ += (target_gz - gust_z_) * g_alpha;

    // 4. Synoptic barometric pressure & humidity evolution
    const double target_baro = 101.8 - 0.85 * center_cloud - 0.90 * center_pdrop - 1.1 * clamp(center_rain / 20.0, 0.0, 1.0);
    baro_kpa_ += (target_baro - baro_kpa_) * clamp(scaled_dt / 600.0, 0.0, 1.0);
    const double target_rh = clamp(cfg_.base_humidity + 0.22 * center_cloud + 0.35 * clamp(center_rain / 8.0, 0.0, 1.0), 0.15, 0.98);
    global_humidity_ += (target_rh - global_humidity_) * clamp(scaled_dt / 180.0, 0.0, 1.0);

    // 5. Solar-thermal asphalt slab energy balance (C_asphalt ~ 22 kJ/(m^2 K) active top 15 mm layer)
    double sun_elev = 0.0, sun_azim = 180.0;
    compute_sun_angles(sun_elev, sun_azim);
    const double sin_e = std::max(0.0, std::sin(sun_elev * kWeatherDegToRad));
    const double solar_clear_w = 960.0 * std::pow(sin_e, 1.15);
    const double solar_w_m2 = solar_clear_w * (1.0 - 0.78 * center_cloud * center_cloud);
    const double diurnal = -3.5 * std::cos((local_hour_ - 15.0) * (2.0 * kPi / 24.0)) * (1.0 - 0.45 * center_cloud);
    const double rain_chill = -2.8 * clamp(center_rain / 15.0, 0.0, 1.0);
    const double target_air_c = cfg_.base_ambient_c + diurnal + rain_chill;
    global_air_c_ += (target_air_c - global_air_c_) * clamp(scaled_dt / 240.0, 0.0, 1.0);

    const double v_wind = std::hypot(w_syn.x + gust_x_, w_syn.y + gust_y_);
    const double h_conv = 12.0 + 3.8 * v_wind;
    const double dew_c = weather_magnus_dew_point_c(global_air_c_, global_humidity_);
    // 2-Layer Asphalt Slab Thermal Model (top 4 mm wearing skin + deep 50 mm thermal-mass base)
    constexpr double kSkinHeatCap = 9500.0;     // J/(m^2 K) fast-responding top 4 mm asphalt skin
    constexpr double kBaseHeatCap = 85000.0;    // J/(m^2 K) deep 50 mm subsurface thermal reservoir
    constexpr double kSkinBaseG   = 14.0;       // W/(m^2 K) skin <-> subsurface conduction (k_asphalt ~ 1.0 W/mK over ~7 cm)
    constexpr double kBaseSoilG   = 6.0;        // W/(m^2 K) subsurface <-> deep earth baseline

    auto step_two_layer_thermal = [&](double& skin_c, double& base_c, double& water_mm, double& ice_f,
                                      double solar_abs_w, double cloud_0_1, double shade_0_1, double rain_mm_hr) {
        const double q_sun = 0.86 * solar_abs_w;
        const double q_conv = h_conv * (skin_c - global_air_c_);
        const double q_rad = (1.0 - 0.75 * cloud_0_1) * (1.0 - 0.65 * shade_0_1) * 85.0;
        const double q_rain = rain_mm_hr * 14.0 * std::max(0.0, skin_c - dew_c);
        const double q_evap = (water_mm > 0.04) ? (145.0 * (1.0 - global_humidity_) * (1.0 + 0.15 * v_wind)) : 0.0;
        const double q_sb = kSkinBaseG * (skin_c - base_c);
        const double q_soil = kBaseSoilG * (base_c - cfg_.base_ambient_c);
        const double d_skin = (q_sun - q_conv - q_rad - q_rain - q_evap - q_sb) * (scaled_dt / kSkinHeatCap);
        const double d_base = (q_sb - q_soil) * (scaled_dt / kBaseHeatCap);
        skin_c = clamp(skin_c + d_skin, -18.0, 72.0);
        base_c = clamp(base_c + d_base, -18.0, 62.0);

        // Zero-rain dawn dew condensation when clear-sky radiative cooling drops skin_c <= dew_point_c
        if (rain_mm_hr < 0.05 && skin_c <= dew_c && water_mm < 0.18) {
            const double dew_add = 0.00018 * (dew_c - skin_c + 0.35) * global_humidity_ * scaled_dt;
            water_mm = std::min(0.18, water_mm + dew_add);
        }
        // Black ice / surface frost formation when wet asphalt drops <= 0.2 C (and melt when > 0.4 C)
        if (skin_c <= 0.2 && water_mm > 0.03) {
            const double freeze_rate = (0.0035 + 0.0025 * std::max(0.0, -skin_c)) * scaled_dt;
            ice_f = clamp(ice_f + freeze_rate, 0.0, 1.0);
        } else if (skin_c > 0.4 && ice_f > 0.0) {
            const double melt_rate = (0.0045 + 0.0030 * (skin_c - 0.4)) * scaled_dt;
            ice_f = std::max(0.0, ice_f - melt_rate);
        } else if (water_mm <= 0.015) {
            ice_f = std::max(0.0, ice_f - 0.01 * scaled_dt);
        }
    };

    {
        double center_water = hydro_water_mm_[hydro_index(0.0, 0.0)];
        step_two_layer_thermal(global_track_c_, global_base_c_, center_water, global_ice_,
                               solar_w_m2, center_cloud, 0.0, center_rain);
        hydro_water_mm_[hydro_index(0.0, 0.0)] = center_water;
    }

    // 6. Layer 1: Macro 32x32 Domain Surface Hydrology
    const double vpd_kpa = std::max(0.0, weather_sat_vapor_kpa(global_track_c_) - global_humidity_ * weather_sat_vapor_kpa(global_air_c_));
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
            const double evap_cell = (r_cell < 0.25) ? evap_mm_per_s * (1.0 - 0.55 * cl_cell) * scaled_dt : 0.0;
            if (r_cell > 0.8) {
                hydro_groove_[k] = std::max(0.0, hydro_groove_[k] - 0.025 * r_cell * (scaled_dt / 60.0));
            }
            hydro_scratch_[k] = clamp(hydro_water_mm_[k] + rain_add - evap_cell, 0.0, 10.0);
        }
    }

    for (int iy = 0; iy < kHydroRes; ++iy) {
        for (int ix = 0; ix < kHydroRes; ++ix) {
            const int k = iy * kHydroRes + ix;
            const double w_cur = hydro_scratch_[k];
            const double z_cur = -hydro_basin_mm_[k] + w_cur;
            double net_flow = 0.0;
            const int nb[4][2] = {{ix - 1, iy}, {ix + 1, iy}, {ix, iy - 1}, {ix, iy + 1}};
            for (int n = 0; n < 4; ++n) {
                const int nx = (nb[n][0] + kHydroRes) % kHydroRes;
                const int ny = (nb[n][1] + kHydroRes) % kHydroRes;
                const int nk = ny * kHydroRes + nx;
                const double z_nb = -hydro_basin_mm_[nk] + hydro_scratch_[nk];
                const double dz = z_nb - z_cur;
                if (dz > 0.0) {
                    const double mobile_nb = std::max(0.0, hydro_scratch_[nk] - cfg_.asphalt_porosity_mm);
                    net_flow += std::min(mobile_nb * 0.25, dz * 0.25 * drain_k);
                } else if (dz < 0.0) {
                    const double mobile_cur = std::max(0.0, w_cur - cfg_.asphalt_porosity_mm);
                    net_flow -= std::min(mobile_cur * 0.25, (-dz) * 0.25 * drain_k);
                }
            }
            const double lip = hydro_basin_mm_[k] + 1.4;
            const double w_next = std::max(0.0, w_cur + net_flow);
            const double overflow = std::max(0.0, w_next - lip);
            hydro_water_mm_[k] = clamp(w_next - overflow * storm_drain, 0.0, 10.0);
        }
    }

    // 7. Layer 2: Update active 1.0 m toroidal fine world cells (rain fill, Penman evap, thermal balance)
    for (FineCell& fc : fine_cells_) {
        if (fc.world_ix == -999999) continue;
        const double fx = static_cast<double>(fc.world_ix) + 0.5;
        const double fy = static_cast<double>(fc.world_iy) + 0.5;
        double r_f = 0.0, cl_f = 0.0;
        evaluate_cells_at(fx, fy, 0.0, r_f, cl_f);
        const double rain_add = r_f * (scaled_dt / 3600.0);
        const double local_vpd = std::max(0.0, weather_sat_vapor_kpa(fc.temp_c) - global_humidity_ * weather_sat_vapor_kpa(global_air_c_));
        const double local_evap = (r_f < 0.25)
            ? (0.00018 * local_vpd * (1.0 + 0.18 * v_wind) + 2.2e-7 * solar_clear_w * (1.0 - 0.78 * cl_f * cl_f)) * scaled_dt
            : 0.0;
        const double w_next = clamp(fc.water_mm + rain_add - local_evap, 0.0, 10.0);
        // Gentle drainage toward local basin lip
        const double lip = fc.basin_mm + 1.3;
        const double overflow = std::max(0.0, w_next - lip);
        fc.water_mm = clamp(w_next - overflow * clamp(0.025 * scaled_dt, 0.0, 0.20), 0.0, 10.0);
        if (r_f > 0.8) {
            fc.groove = std::max(0.0, fc.groove - 0.03 * r_f * (scaled_dt / 60.0));
        }
        // Heavy rain washes off rubber over ~25-45 min ("green track reset") and washes dragged-on mud off asphalt
        if (r_f > 3.5) {
            fc.rubber = std::max(0.0, fc.rubber - 0.000035 * (r_f - 3.0) * scaled_dt);
        }
        if (r_f > 1.0 && fc.mud > 0.0) {
            fc.mud = std::max(0.0, fc.mud - 0.0018 * r_f * scaled_dt);
        }
        // Persistent 2-layer cell asphalt temperature + dawn dew condensation + black ice
        step_two_layer_thermal(fc.temp_c, fc.base_temp_c, fc.water_mm, fc.ice,
                               solar_clear_w * (1.0 - 0.78 * cl_f * cl_f), cl_f, 0.0, r_f);
        fc.last_sync_s = sim_time_s_;
    }

    // 8. Layer 3: Sub-Meter Curvilinear Track Surface 2D Shallow-Water Hydrology & Per-Cell Thermal Memory
    if (has_track_geometry()) {
        const std::size_t n_st = track_stations_.size();
        const double track_drain_lat = clamp(0.18 * scaled_dt, 0.0, 0.30);
        const double track_drain_lon = clamp(0.04 * scaled_dt, 0.0, 0.18);

        // 8a. Rain fill, per-cell persistent solar/shade thermal balance & local Penman evaporation
        for (std::size_t i = 0; i < n_st; ++i) {
            const TrackWeatherStation& st = track_stations_[i].st;
            double r_st = 0.0, cl_st = 0.0;
            evaluate_cells_at(st.x_m, st.y_m, 0.0, r_st, cl_st);
            const double shade = clamp(st.shade_0_to_1, 0.0, 1.0);
            const double solar_st = solar_clear_w * (1.0 - 0.78 * cl_st * cl_st) * (1.0 - 0.85 * shade);
            const double rain_add = r_st * (scaled_dt / 3600.0);

            for (int j = 0; j < kTrackLanes; ++j) {
                const std::size_t idx = i * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(j);
                double& tc = track_temp_c_[idx];
                double& tb = track_base_temp_c_[idx];
                double w_cur = track_water_mm_[idx];

                // Persistent 2-layer skin + deep-base thermal integration + zero-rain dawn dew + black ice!
                step_two_layer_thermal(tc, tb, w_cur, track_ice_[idx], solar_st, cl_st, shade, r_st);

                // Post-storm "green track" wash-off (heavy rain washes rubber off tarmac over ~25-45 min & clears mud)
                if (r_st > 3.5) {
                    track_rubber_[idx] = std::max(0.0, track_rubber_[idx] - 0.000035 * (r_st - 3.0) * scaled_dt);
                }
                if (r_st > 1.0 && track_mud_[idx] > 0.0) {
                    track_mud_[idx] = std::max(0.0, track_mud_[idx] - 0.0018 * r_st * scaled_dt);
                }

                // Local Penman evaporation driven by THIS cell's skin temperature & shade (paused while frozen/dew)
                const double cell_vpd = std::max(0.0, weather_sat_vapor_kpa(tc) - global_humidity_ * weather_sat_vapor_kpa(global_air_c_));
                const double evap_rate = (0.00022 * cell_vpd * (1.0 + 0.18 * v_wind) + 2.8e-7 * solar_st)
                                       * clamp((tc + 5.0) / 25.0, 0.15, 2.8);
                const double evap_mm = (r_st < 0.25 && tc > dew_c && track_ice_[idx] < 0.5) ? evap_rate * scaled_dt : 0.0;
                if (r_st > 0.8) {
                    track_groove_[idx] = std::max(0.0, track_groove_[idx] - 0.03 * r_st * (scaled_dt / 60.0));
                }
                track_water_scratch_[idx] = clamp(w_cur + rain_add - evap_mm, 0.0, 12.0);
            }
        }

        // 8b. 2D Shallow-Water Gravity Flow across real elevation, banking, road crown & edge storm drains
        for (std::size_t i = 0; i < n_st; ++i) {
            const TrackWeatherStation& st = track_stations_[i].st;
            const double edge_drain = clamp(0.045 * std::max(st.drain_rate, 0.1) * scaled_dt, 0.0, 0.25);
            for (int j = 0; j < kTrackLanes; ++j) {
                const std::size_t idx = i * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(j);
                const double w_cur = track_water_scratch_[idx];
                const double z_cur = track_elev_mm_[idx] + w_cur;
                // Surface-tension clinging water film prevents raised kerbs/crowns from draining to 0.000 mm while wet
                const double cling_film = (j == 0 || j == kTrackLanes - 1) ? 0.22 : std::max(cfg_.asphalt_porosity_mm, 0.14);
                double net = 0.0;

                // Lateral neighbors (banking + crown flow!)
                for (int dj = -1; dj <= 1; dj += 2) {
                    const int nj = j + dj;
                    if (nj < 0 || nj >= kTrackLanes) continue;
                    const std::size_t nidx = i * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(nj);
                    const double z_nb = track_elev_mm_[nidx] + track_water_scratch_[nidx];
                    const double dz = z_nb - z_cur;
                    const double nb_cling = (nj == 0 || nj == kTrackLanes - 1) ? 0.22 : std::max(cfg_.asphalt_porosity_mm, 0.14);
                    if (dz > 0.0) {
                        const double mob = std::max(0.0, track_water_scratch_[nidx] - nb_cling);
                        net += std::min(mob * 0.28, dz * 0.0075 * track_drain_lat);
                    } else if (dz < 0.0) {
                        const double mob = std::max(0.0, w_cur - cling_film);
                        net -= std::min(mob * 0.28, (-dz) * 0.0075 * track_drain_lat);
                    }
                }
                // Longitudinal neighbors (real uphill/downhill track slope flow!)
                for (int di = -1; di <= 1; di += 2) {
                    int ni = static_cast<int>(i) + di;
                    if (ni < 0) {
                        if (!track_closed_loop_) continue;
                        ni = static_cast<int>(n_st) - 1;
                    } else if (ni >= static_cast<int>(n_st)) {
                        if (!track_closed_loop_) continue;
                        ni = 0;
                    }
                    const std::size_t nidx = static_cast<std::size_t>(ni) * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(j);
                    const double z_nb = track_elev_mm_[nidx] + track_water_scratch_[nidx];
                    const double dz = z_nb - z_cur;
                    if (dz > 0.0) {
                        const double mob = std::max(0.0, track_water_scratch_[nidx] - cling_film);
                        net += std::min(mob * 0.20, dz * 0.008 * track_drain_lon);
                    } else if (dz < 0.0) {
                        const double mob = std::max(0.0, w_cur - cling_film);
                        net -= std::min(mob * 0.20, (-dz) * 0.008 * track_drain_lon);
                    }
                }

                double w_next = std::max(0.0, w_cur + net);
                // Road-edge gutter drains remove excess pooled water above realistic puddle depth at track boundaries
                if (j == 0 || j == kTrackLanes - 1) {
                    w_next = std::max(0.0, w_next - std::max(0.0, w_next - 0.55) * edge_drain);
                } else if (j == 1 || j == kTrackLanes - 2) {
                    w_next = std::max(0.0, w_next - std::max(0.0, w_next - 2.40) * edge_drain * 0.85);
                }
                track_water_mm_[idx] = clamp(w_next, 0.0, 6.5);
            }
        }
    }

    // 9. Advance wind-advected volumetric trailing spray plumes
    for (SprayPlume& sp : spray_plumes_) {
        if (!sp.active) continue;
        sp.age_s += dt;
        if (sp.age_s >= sp.lifetime_s) {
            sp.active = false;
            continue;
        }
        const Vec3 w_plume = wind_at(sp.pos_m.x, sp.pos_m.y, center_rain);
        // Plume velocity relaxes from initial car-wake entrainment toward ambient wind
        const double relax = clamp(dt / 0.85, 0.0, 1.0);
        sp.vel_mps.x += (w_plume.x - sp.vel_mps.x) * relax;
        sp.vel_mps.y += (w_plume.y - sp.vel_mps.y) * relax;
        sp.vel_mps.z += (0.25 - sp.vel_mps.z) * relax;
        sp.pos_m.x += sp.vel_mps.x * dt;
        sp.pos_m.y += sp.vel_mps.y * dt;
        sp.pos_m.z = std::max(0.2, sp.pos_m.z + sp.vel_mps.z * dt);
        sp.radius_m += (1.35 + 0.12 * v_wind) * dt;
        const double life_left = clamp(1.0 - sp.age_s / std::max(sp.lifetime_s, 0.5), 0.0, 1.0);
        sp.density_0_to_1 *= std::exp(-dt * (0.45 + 0.04 * v_wind));
        sp.density_0_to_1 = std::min(sp.density_0_to_1, life_left);
        if (sp.density_0_to_1 < 0.01) sp.active = false;
    }

    // 10. Convective lightning flash & thunderclap scheduling
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
    deposit_tyre_passage(x_m, y_m, speed_mps, load_n, 0.0, 1.0, dt);
}

void WeatherSystem::deposit_tyre_passage(double x_m, double y_m, double speed_mps, double load_n,
                                         double slip_power_w, double tread_evac_scale, double dt,
                                         double tyre_mud_0_to_1) {
    if (dt <= 0.0 || load_n <= 100.0) return;
    const double v = std::abs(speed_mps);
    if (v < 3.0) return;
    const double evac_mult = clamp(tread_evac_scale, 0.25, 2.8);
    const double mud_in = clamp(tyre_mud_0_to_1, 0.0, 1.0);

    // 1. Sub-meter curvilinear track surface strip (if on bound track)
    int st_i = -1, lane_j = -1;
    double d_m = 0.0;
    if (project_to_track(x_m, y_m, st_i, lane_j, d_m)) {
        const std::size_t idx = static_cast<std::size_t>(st_i) * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(lane_j);
        const double w_cur = track_water_mm_[idx];
        if (w_cur > 0.005) {
            const double pump = clamp((v / 32.0) * (load_n / 4000.0) * evac_mult * dt * 1.35, 0.0, 0.45);
            const double moved = w_cur * pump;
            track_water_mm_[idx] = std::max(0.0, w_cur - moved);
            track_groove_[idx] = clamp(track_groove_[idx] + pump * 0.95, 0.0, 1.0);
            // 55% atomizes into spray; 45% splashes laterally into immediate adjacent ~0.7 m lanes!
            const double splash = 0.225 * moved;
            if (lane_j > 0) {
                track_water_mm_[idx - 1] = std::min(12.0, track_water_mm_[idx - 1] + splash);
            }
            if (lane_j + 1 < kTrackLanes) {
                track_water_mm_[idx + 1] = std::min(12.0, track_water_mm_[idx + 1] + splash);
            }
        }
        // Off-track mud drag-on: muddy tyres shed slippery dirt onto the apex; clean tyres scrub existing mud off!
        if (mud_in > 0.05) {
            track_mud_[idx] = clamp(track_mud_[idx] + mud_in * clamp(v / 25.0, 0.3, 1.8) * dt * 1.8, 0.0, 1.0);
        } else if (track_mud_[idx] > 0.0) {
            track_mud_[idx] = std::max(0.0, track_mud_[idx] - clamp(v / 35.0, 0.2, 1.5) * dt * 0.22);
        }
        // Deposit rubber onto asphalt lanes when dry/damp (water_mm < 0.18 mm)
        if (lane_j > 0 && lane_j + 1 < kTrackLanes && track_water_mm_[idx] < 0.18) {
            const double dry_f = clamp((0.18 - track_water_mm_[idx]) / 0.18, 0.0, 1.0);
            const double rub_add = (0.0012 * (v / 35.0) + 1.8e-7 * std::max(0.0, slip_power_w)) * dry_f * dt;
            track_rubber_[idx] = clamp(track_rubber_[idx] + rub_add, 0.0, 1.0);
        }
        // Tyre friction & rolling hysteresis warms the 4 mm asphalt skin (and helps thaw black ice!)
        const double heat_w = std::max(0.0, slip_power_w) * 0.35 + 0.006 * load_n * v;
        track_temp_c_[idx] = clamp(track_temp_c_[idx] + (heat_w * dt) / 9500.0, -18.0, 72.0);
        if (track_ice_[idx] > 0.0) {
            track_ice_[idx] = std::max(0.0, track_ice_[idx] - (heat_w * dt) / 45000.0);
        }
    }

    // 2. 1.0 m toroidal fine world patch (open-world sub-meter tyre tracks!)
    const int32_t wix = static_cast<int32_t>(std::floor(x_m));
    const int32_t wiy = static_cast<int32_t>(std::floor(y_m));
    FineCell& fc = ensure_fine_cell(wix, wiy);
    if (fc.water_mm > 0.005) {
        const double pump = clamp((v / 34.0) * (load_n / 4000.0) * evac_mult * dt * 1.15, 0.0, 0.42);
        const double moved = fc.water_mm * pump;
        fc.water_mm = std::max(0.0, fc.water_mm - moved);
        fc.groove = clamp(fc.groove + pump * 0.90, 0.0, 1.0);
        const double splash = 0.22 * moved;
        FineCell& f_l = ensure_fine_cell(wix, wiy + 1);
        FineCell& f_r = ensure_fine_cell(wix, wiy - 1);
        f_l.water_mm = std::min(10.0, f_l.water_mm + splash);
        f_r.water_mm = std::min(10.0, f_r.water_mm + splash);
    }
    if (mud_in > 0.05) {
        fc.mud = clamp(fc.mud + mud_in * clamp(v / 25.0, 0.3, 1.8) * dt * 1.6, 0.0, 1.0);
    } else if (fc.mud > 0.0) {
        fc.mud = std::max(0.0, fc.mud - clamp(v / 35.0, 0.2, 1.5) * dt * 0.20);
    }
    if (fc.water_mm < 0.18) {
        const double dry_f = clamp((0.18 - fc.water_mm) / 0.18, 0.0, 1.0);
        fc.rubber = clamp(fc.rubber + (0.0010 * (v / 35.0) + 1.5e-7 * std::max(0.0, slip_power_w)) * dry_f * dt, 0.0, 1.0);
    }
    const double fine_heat = std::max(0.0, slip_power_w) * 0.30 + 0.005 * load_n * v;
    fc.temp_c = clamp(fc.temp_c + (fine_heat * dt) / 9500.0, -18.0, 72.0);
    if (fc.ice > 0.0) fc.ice = std::max(0.0, fc.ice - (fine_heat * dt) / 45000.0);

    // 3. Macro 32x32 domain grid wake update (area-weighted so one tyre does not drain an entire 250 m city block)
    int ix = 0, iy = 0;
    const int k = hydro_index(x_m, y_m, &ix, &iy);
    if (hydro_water_mm_[k] > 0.01) {
        const double pump = clamp((v / 42.0) * (load_n / 4000.0) * evac_mult * dt * 0.06, 0.0, 0.08);
        const double moved = hydro_water_mm_[k] * pump;
        hydro_water_mm_[k] = std::max(0.0, hydro_water_mm_[k] - moved);
        hydro_groove_[k] = clamp(hydro_groove_[k] + pump * 1.4, 0.0, 1.0);
        const double splash = 0.25 * moved;
        const int k_l = iy * kHydroRes + ((ix - 1 + kHydroRes) % kHydroRes);
        const int k_r = iy * kHydroRes + ((ix + 1) % kHydroRes);
        hydro_water_mm_[k_l] = std::min(10.0, hydro_water_mm_[k_l] + splash);
        hydro_water_mm_[k_r] = std::min(10.0, hydro_water_mm_[k_r] + splash);
    }
}

void WeatherSystem::deposit_car_spray(const Vec3& car_pos, const Vec3& car_vel, double avg_water_mm,
                                      double diffuser_downforce_n, double dt) {
    if (dt <= 0.0 || avg_water_mm <= 0.12) return;
    const double speed = length(car_vel);
    if (speed < 12.0) return;

    spray_emit_accum_s_ += dt;
    if (spray_emit_accum_s_ < 0.12) return;
    spray_emit_accum_s_ = 0.0;

    const Vec3 dir = car_vel * (1.0 / speed);
    const double diffuser_boost = 1.0 + clamp(diffuser_downforce_n / 6000.0, 0.0, 0.85);
    const double density = clamp((avg_water_mm / 1.8) * (speed / 55.0) * (speed / 55.0) * diffuser_boost, 0.0, 1.0);
    if (density < 0.04) return;

    SprayPlume& sp = spray_plumes_[spray_cursor_];
    spray_cursor_ = (spray_cursor_ + 1) % kMaxSprayPlumes;
    sp.active = true;
    sp.pos_m = {car_pos.x - dir.x * 3.0, car_pos.y - dir.y * 3.0, std::max(0.7, car_pos.z + 0.8)};
    sp.vel_mps = {car_vel.x * 0.25, car_vel.y * 0.25, 0.65 * diffuser_boost};
    sp.radius_m = 2.4 + 0.6 * diffuser_boost;
    sp.density_0_to_1 = density;
    sp.age_s = 0.0;
    sp.lifetime_s = 3.8 + 1.8 * density;
}

double WeatherSystem::sample_driver_visibility_m(const Vec3& eye_pos, const Vec3& look_dir) const {
    const WeatherSample s = sample(eye_pos.x, eye_pos.y);
    const double base_vis = s.visibility_m;
    const double dir_len = length(look_dir);
    if (dir_len < 1e-6) return base_vis;
    const Vec3 fwd = look_dir * (1.0 / dir_len);

    // Beer-Lambert optical extinction through all active trailing spray plumes ahead of the driver
    double optical_depth = 0.0;
    for (const SprayPlume& sp : spray_plumes_) {
        if (!sp.active || sp.density_0_to_1 < 0.01) continue;
        const Vec3 rel = sp.pos_m - eye_pos;
        const double along = dot(rel, fwd);
        if (along < 1.5 || along > 140.0) continue;
        const Vec3 perp = rel - fwd * along;
        const double d_perp2 = dot(perp, perp);
        const double r2 = sp.radius_m * sp.radius_m;
        if (d_perp2 < 3.0 * r2) {
            const double hit = std::exp(-d_perp2 / std::max(r2, 1.0));
            const double near_weight = clamp(1.0 - along / 140.0, 0.15, 1.0);
            optical_depth += sp.density_0_to_1 * hit * near_weight * 3.2;
        }
    }
    if (optical_depth <= 1e-4) return base_vis;
    // Heavy spray ahead can slash visibility from ~900 m down to ~14-35 m!
    const double spray_vis = 240.0 / (1.0 + optical_depth * 6.5);
    return clamp(std::min(base_vis, spray_vis), 12.0, base_vis);
}

WeatherWheelSample WeatherSystem::sample_wheel(double x_m, double y_m, WeatherSurfaceType surface) const {
    WeatherWheelSample ws;
    double rain_local = 0.0, cloud_local = 0.0;
    evaluate_cells_at(x_m, y_m, 0.0, rain_local, cloud_local);

    int st_i = -1, lane_j = -1;
    double d_m = 0.0;
    if (project_to_track(x_m, y_m, st_i, lane_j, d_m)) {
        const std::size_t idx = static_cast<std::size_t>(st_i) * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(lane_j);
        const double total_w = track_water_mm_[idx];
        const bool is_kerb_lane = (lane_j == 0 || lane_j == kTrackLanes - 1);
        const WeatherSurfaceType eff_surface = (surface == WeatherSurfaceType::Asphalt && is_kerb_lane)
                                             ? WeatherSurfaceType::PaintedKerb
                                             : surface;
        const double porosity = (eff_surface == WeatherSurfaceType::PaintedKerb || eff_surface == WeatherSurfaceType::PaintedLine)
                              ? 0.0
                              : (eff_surface == WeatherSurfaceType::Concrete ? 0.04 : cfg_.asphalt_porosity_mm * 0.5);
        ws.water_depth_mm = std::max(0.0, total_w - porosity);
        ws.puddle_depth_mm = std::max(0.0, total_w - 0.85);
        ws.wetness_0_to_1 = clamp(total_w / 1.15, 0.0, 1.0);
        ws.track_temp_c = track_temp_c_[idx];
        ws.rubber_0_to_1 = track_rubber_[idx];
        ws.drying_line_factor = track_groove_[idx];
        ws.static_shade_0_to_1 = clamp(track_stations_[st_i].st.shade_0_to_1, 0.0, 1.0);
        ws.ice_0_to_1 = track_ice_[idx];
        ws.mud_0_to_1 = track_mud_[idx];
        ws.on_painted_kerb = (eff_surface == WeatherSurfaceType::PaintedKerb);
        ws.surface_mu_mult = compute_surface_mu_mult(ws.water_depth_mm, ws.rubber_0_to_1, eff_surface, ws.ice_0_to_1, ws.mud_0_to_1);
        ws.spray_generation_0_to_1 = clamp(ws.water_depth_mm / 2.0, 0.0, 1.0);
        return ws;
    }

    // Open-world / off-track: use 1.0 m toroidal fine patch
    const int32_t wix = static_cast<int32_t>(std::floor(x_m));
    const int32_t wiy = static_cast<int32_t>(std::floor(y_m));
    const FineCell& fc = ensure_fine_cell(wix, wiy);
    const double porosity = (surface == WeatherSurfaceType::PaintedKerb || surface == WeatherSurfaceType::PaintedLine)
                          ? 0.0
                          : (surface == WeatherSurfaceType::Concrete ? 0.04 : cfg_.asphalt_porosity_mm * 0.5);
    ws.water_depth_mm = std::max(0.0, fc.water_mm - porosity);
    ws.puddle_depth_mm = std::max(0.0, fc.water_mm - 0.85);
    ws.wetness_0_to_1 = clamp(fc.water_mm / 1.15, 0.0, 1.0);
    ws.track_temp_c = fc.temp_c;
    ws.rubber_0_to_1 = fc.rubber;
    ws.drying_line_factor = fc.groove;
    ws.ice_0_to_1 = fc.ice;
    ws.mud_0_to_1 = fc.mud;
    ws.on_painted_kerb = (surface == WeatherSurfaceType::PaintedKerb);
    ws.surface_mu_mult = compute_surface_mu_mult(ws.water_depth_mm, ws.rubber_0_to_1, surface, ws.ice_0_to_1, ws.mud_0_to_1);
    ws.spray_generation_0_to_1 = clamp(ws.water_depth_mm / 2.0, 0.0, 1.0);
    return ws;
}

WeatherSample WeatherSystem::sample(double x_m, double y_m) const {
    WeatherSample s;
    double p_drop = 0.0;
    evaluate_cells_at(x_m, y_m, 0.0, s.rain_mm_per_hr, s.cloud_cover_0_to_1, &p_drop);
    s.cloud_shadow_0_to_1 = clamp(s.cloud_cover_0_to_1 * s.cloud_cover_0_to_1 * 0.88, 0.0, 0.92);

    compute_sun_angles(s.sun_elevation_deg, s.sun_azimuth_deg);
    const double sin_e = std::max(0.0, std::sin(s.sun_elevation_deg * kWeatherDegToRad));
    s.solar_irradiance_w_m2 = 960.0 * std::pow(sin_e, 1.15) * (1.0 - s.cloud_shadow_0_to_1);

    // Local micro-climate modulation by local cell rain/shadow/pressure trough
    s.ambient_air_c = global_air_c_ - 1.2 * clamp(s.rain_mm_per_hr / 15.0, 0.0, 1.0);
    s.humidity_0_to_1 = clamp(global_humidity_ + 0.14 * clamp(s.rain_mm_per_hr / 10.0, 0.0, 1.0), 0.15, 0.99);
    s.dew_point_c = weather_magnus_dew_point_c(s.ambient_air_c, s.humidity_0_to_1);
    s.barometric_kpa = clamp(baro_kpa_ - 0.35 * p_drop, 94.0, 105.0);

    // Instantaneous 3D wind + veering + 3D wind shadows + spatially varying gusts + storm downdrafts
    s.wind_shelter_0_to_1 = wind_shelter_at(x_m, y_m);
    s.wind_world_mps = wind_at(x_m, y_m, s.rain_mm_per_hr);
    s.wind_speed_mps = std::hypot(s.wind_world_mps.x, s.wind_world_mps.y);
    s.wind_direction_deg = live_wind_direction_deg();
    s.gust_intensity_0_to_1 = clamp(std::hypot(gust_x_, gust_y_) / std::max(cfg_.base_wind_mps * 0.45, 1.0), 0.0, 1.0);

    // Surface hydrology & 2-layer persistent asphalt temperature (prefer bound sub-meter track strip, else macro)
    int st_i = -1, lane_j = -1;
    double d_m = 0.0;
    if (project_to_track(x_m, y_m, st_i, lane_j, d_m)) {
        const std::size_t idx = static_cast<std::size_t>(st_i) * static_cast<std::size_t>(kTrackLanes) + static_cast<std::size_t>(lane_j);
        const double total_w = track_water_mm_[idx];
        s.surface_water_mm = std::max(0.0, total_w - cfg_.asphalt_porosity_mm * 0.5);
        s.puddle_depth_mm = std::max(0.0, total_w - 0.85);
        s.drying_line_factor = track_groove_[idx];
        s.rubber_0_to_1 = track_rubber_[idx];
        s.wetness_0_to_1 = clamp(total_w / 1.15, 0.0, 1.0);
        s.track_surface_c = track_temp_c_[idx];
        s.track_subsurface_c = track_base_temp_c_[idx];
        s.ice_0_to_1 = track_ice_[idx];
    } else {
        const double shadow_cool = -5.5 * s.cloud_shadow_0_to_1 * sin_e;
        const double rain_quench = -3.0 * clamp(s.rain_mm_per_hr / 12.0, 0.0, 1.0);
        s.track_surface_c = clamp(global_track_c_ + shadow_cool + rain_quench, -18.0, 72.0);
        s.track_subsurface_c = global_base_c_;
        const int k = hydro_index(x_m, y_m);
        const double total_w = hydro_water_mm_[k];
        s.surface_water_mm = std::max(0.0, total_w - cfg_.asphalt_porosity_mm * 0.5);
        s.puddle_depth_mm = std::max(0.0, total_w - 0.85);
        s.drying_line_factor = hydro_groove_[k];
        s.wetness_0_to_1 = clamp(total_w / 1.15, 0.0, 1.0);
        s.ice_0_to_1 = global_ice_;
    }
    s.dew_condensing = (s.rain_mm_per_hr < 0.05 && s.track_surface_c <= s.dew_point_c);

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

void WeatherSystem::apply_to_vehicle(const Vec3& car_pos, std::array<WheelContact, 4>& contacts,
                                     AtmosphericEnvironment& atm, double& out_road_water_mm,
                                     const CarConfig* cfg) const {
    const WeatherSample s = sample(car_pos.x, car_pos.y);
    atm.enabled = true;
    atm.ambient_air_c = s.ambient_air_c;
    atm.track_surface_c = s.track_surface_c;
    atm.humidity_0_to_1 = s.humidity_0_to_1;
    atm.wind_world_mps = s.wind_world_mps;
    atm.barometric_offset_kpa = s.barometric_kpa - 101.325;
    // Keep scalar road_water_mm = 0 when per-wheel contacts carry their own exact sub-meter water_depth_mm,
    // so asymmetric puddles lift/drag ONLY the submerged wheels!
    out_road_water_mm = 0.0;

    for (int w = 0; w < 4; ++w) {
        WheelContact& c = contacts[w];
        if (!c.hit) continue;
        WeatherSurfaceType surf = WeatherSurfaceType::Asphalt;
        if (cfg && c.surface >= 0 && c.surface < static_cast<int>(cfg->surface_grip.size())) {
            const std::string& name = cfg->surface_grip[c.surface].first;
            if (name == "kerb" || name == "curb" || name == "paint") surf = WeatherSurfaceType::PaintedKerb;
            else if (name == "concrete" || name == "pavement") surf = WeatherSurfaceType::Concrete;
            else if (name == "grass") surf = WeatherSurfaceType::Grass;
            else if (name == "gravel" || name == "dirt") surf = WeatherSurfaceType::Gravel;
        }
        const WeatherWheelSample ws = sample_wheel(c.point.x, c.point.y, surf);
        c.water_depth_mm = std::max(c.water_depth_mm, ws.water_depth_mm);
        c.track_temp_c = ws.track_temp_c;
        c.surface_mu_mult = clamp(c.surface_mu_mult * ws.surface_mu_mult, 0.14, 1.25);
    }
}

WeatherStrategyAdvice WeatherSystem::evaluate_pit_strategy(double x_m, double y_m, double lap_time_dry_s,
                                                           RecommendedTyreCompound mounted) const {
    WeatherStrategyAdvice adv;
    const WeatherSample now = sample(x_m, y_m);
    const double dry_lap = std::max(lap_time_dry_s, 30.0);
    adv.current_water_mm = now.surface_water_mm;

    // Predict lap-time delta vs dry slick baseline for Slick, Intermediate, and Full-Wet at a given water depth (mm)
    auto lap_deltas = [&](double water_mm, double& d_slick, double& d_inter, double& d_wet) {
        const double w = std::max(0.0, water_mm);
        // Slick: fastest when dry (<0.28 mm), falls off a cliff above 0.5 mm (aquaplaning)
        d_slick = (w < 0.15) ? (dry_lap * 0.04 * (w / 0.15))
                             : (dry_lap * (0.04 + 0.19 * (w - 0.15) + 0.08 * (w - 0.15) * (w - 0.15)));
        // Inter: ~3.5% slower than slick on bone-dry (block squirm/overheat), optimal across 0.30..1.55 mm
        d_inter = dry_lap * (0.035 + 0.055 * std::max(0.0, w - 0.25) + 0.045 * std::pow(std::max(0.0, w - 1.35), 2.0));
        // Full Wet: ~7.5% slower than slick on dry (severe squirm), supreme above ~1.6 mm standing water
        d_wet   = dry_lap * (0.078 + 0.032 * std::max(0.0, w - 0.40));
    };
    auto pick_best = [&](double water_mm) -> RecommendedTyreCompound {
        double ds = 0, di = 0, dw = 0;
        lap_deltas(water_mm, ds, di, dw);
        if (ds <= di && ds <= dw) return RecommendedTyreCompound::Slick;
        return (di <= dw) ? RecommendedTyreCompound::Intermediate : RecommendedTyreCompound::FullWet;
    };

    lap_deltas(now.surface_water_mm, adv.slick_lap_delta_s, adv.inter_lap_delta_s, adv.wet_lap_delta_s);
    adv.current_best = pick_best(now.surface_water_mm);

    // Forward-integrate expected standing water depth along upstream storm advection over next 30 minutes (30 x 60 s steps)
    const double vpd_kpa = std::max(0.0, weather_sat_vapor_kpa(now.track_surface_c) - now.humidity_0_to_1 * weather_sat_vapor_kpa(now.ambient_air_c));
    const double evap_mm_s = 0.00020 * vpd_kpa * (1.0 + 0.18 * now.wind_speed_mps) + 2.2e-7 * now.solar_irradiance_w_m2;
    double w_sim = now.surface_water_mm;
    adv.predicted_water_15m_mm = w_sim;
    adv.crossover_eta_s = -1.0;

    for (int m = 1; m <= 30; ++m) {
        const double t_off = m * 60.0;
        double r_m = 0.0, cl_m = 0.0;
        evaluate_cells_at(x_m, y_m, t_off, r_m, cl_m);
        const double rain_add = r_m * (60.0 / 3600.0);
        const double drain = std::max(0.0, w_sim - 0.35) * 0.055;
        const double evap = (r_m < 0.25) ? (evap_mm_s * (1.0 - 0.55 * cl_m) * 60.0) : 0.0;
        w_sim = clamp(w_sim + rain_add - drain - evap, 0.0, 6.0);
        if (m == 15) adv.predicted_water_15m_mm = w_sim;
        const RecommendedTyreCompound best_m = pick_best(w_sim);
        if (adv.crossover_eta_s < 0.0 && best_m != mounted) {
            adv.crossover_eta_s = t_off;
        }
    }
    adv.forecast_15m_best = pick_best(adv.predicted_water_15m_mm);
    adv.box_now = (adv.current_best != mounted)
               || (adv.crossover_eta_s >= 0.0 && adv.crossover_eta_s <= dry_lap * 1.15);
    return adv;
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
