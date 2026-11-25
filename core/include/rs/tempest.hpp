// Apache-2.0 — OpenGrid Tempest: Mesoscale Dynamic Weather, Solar-Thermal Asphalt & 2D Surface Hydrology Engine.
//
// Pure C++17, zero external dependencies, zero per-tick heap allocations, 100% deterministic.
// Transfers identically across Unreal Engine 5.8 (UOpenGridTempestSubsystem -> VolumetricCloud, SkyAtmosphere,
// DirectionalLight, ExponentialHeightFog, Niagara rain/spray, Wetness/Puddle MPC & Chaos vehicle physics)
// and WebGPU (rs_core.wasm).
//
// Physical sub-models (iRacing Tempest-class architecture):
//   1. 2D Mesoscale Storm & Cloud Cell Advection driven by live synoptic wind vector (spatial rain/dry patches).
//   2. Solar Ephemeris (latitude, day-of-year, solar hour) + cloud optical depth -> surface irradiance (W/m^2).
//   3. Asphalt Slab Energy Balance (solar heating, cloud-shadow cooling, wind convection, evaporative rain quenching).
//   4. Synoptic Wind Vector + Dryden-style continuous turbulence gusts feeding vehicle aerodynamics (v_air = v - v_wind).
//   5. Barometric Pressure Fronts, Magnus Dew-Point & Relative Humidity coupled into ISA AtmosphericEnvironment.
//   6. 2D Topographical Surface Hydrology Grid (asphalt porosity, rain fill, Penman evaporation, slope drainage into
//      puddle basins, and passing-car tyre-wake pumping that carves a real drying racing line).
//   7. Weather Radar Reflectivity Grid (16x16 spatial dBZ / mm/hr snapshot) & convective lightning / spray visibility.
#pragma once
#include <array>
#include <cstdint>
#include "rs/drivetrain.hpp"
#include "rs/math.hpp"

namespace rs {

enum class TempestPreset : int {
    Clear = 0,          // High-pressure sunny / clear night, crisp dry asphalt, light breeze
    PartlyCloudy = 1,   // Advecting cumulus clouds casting moving thermal shadows on asphalt
    DynamicFront = 2,   // Approaching mesoscale rain front: dry start -> scattered showers -> passing storm -> drying track
    LightRain = 3,      // Steady light-to-moderate rain (~3-6 mm/hr), damp/wet tarmac & curb puddles
    HeavyStorm = 4,     // Convective thunderstorm cells (14-28 mm/hr), deep puddles (>3 mm aquaplaning), gusts & lightning
    DryingTrack = 5     // Post-storm clearing skies: flooded puddles draining & cars carving a drying racing line
};

struct TempestStormCell {
    bool active = false;
    double x_m = 0.0;                 // world center X (m)
    double y_m = 0.0;                 // world center Y (m)
    double rain_radius_m = 1800.0;    // precipitation core radius (m)
    double cloud_radius_m = 4200.0;   // cloud anvil / shadow radius (m)
    double peak_rain_mm_hr = 0.0;     // core precipitation intensity (mm/hr)
    double peak_cloud_cover = 0.7;    // core cloud opacity (0..1)
    double age_s = 0.0;               // elapsed lifecycle age (s)
    double lifetime_s = 3600.0;       // total cell lifecycle (s)
};

struct TempestConfig {
    TempestPreset preset = TempestPreset::DynamicFront;
    std::uint32_t seed = 1337u;
    double latitude_deg = 40.75;          // geographic latitude (NYC 40.75 N; Brands Hatch 51.35 N; Spa 50.43 N)
    int day_of_year = 172;                // 1..365 (172 = summer solstice, 355 = winter solstice)
    double start_hour_local = 14.0;       // 0..24 local solar time
    double time_scale = 1.0;              // 1.0 = real-time, 4.0 = 4x game clock
    double base_ambient_c = 22.0;         // synoptic baseline air temperature (C)
    double base_humidity = 0.52;          // baseline relative humidity (0..1)
    double base_wind_mps = 4.5;           // baseline synoptic wind speed at 10 m (m/s)
    double wind_direction_deg = 245.0;    // meteorological direction wind blows FROM (deg, 0=N, 90=E, 270=W)
    double domain_half_extent_m = 4000.0; // hydrology & radar local track/city half-extent (m)
    double asphalt_porosity_mm = 0.12;    // micro-texture storage absorbed before free standing film appears
};

// Local weather, atmospheric, aerodynamic wind, hydrology & UE 5.8 rendering state at world position (x, y).
struct TempestSample {
    // Spatial precipitation & sky
    double rain_mm_per_hr = 0.0;          // local rainfall rate at (x, y), mm/hr
    double cloud_cover_0_to_1 = 0.0;      // local overhead cloud coverage (0..1)
    double cloud_shadow_0_to_1 = 0.0;     // solar beam occlusion at (x, y) (0 = full sun, 1 = deep storm shadow)
    double sun_elevation_deg = 45.0;      // solar altitude above horizon (deg; <= 0 at night)
    double sun_azimuth_deg = 180.0;       // solar compass azimuth (deg, 0=N, 90=E, 180=S, 270=W)
    double solar_irradiance_w_m2 = 0.0;   // direct + diffuse shortwave irradiance reaching asphalt (W/m^2)

    // Thermodynamics & Atmosphere (feeds AtmosphericEnvironment)
    double ambient_air_c = 22.0;          // local air temperature (C)
    double track_surface_c = 30.0;        // local asphalt temperature (C) from solar/cloud/rain energy balance
    double dew_point_c = 12.0;            // Magnus dew-point temperature (C)
    double humidity_0_to_1 = 0.50;        // local relative humidity (0..1)
    double barometric_kpa = 101.325;      // local sea-level synoptic barometric pressure (kPa)

    // 3D Wind & Turbulence (feeds Vehicle aero relative air velocity)
    Vec3 wind_world_mps{0.0, 0.0, 0.0};   // instantaneous world wind vector including gusts (m/s)
    double wind_speed_mps = 0.0;          // magnitude of horizontal wind (m/s)
    double gust_intensity_0_to_1 = 0.0;   // turbulent gust factor (0..1)

    // Surface Hydrology (feeds Tire hydroplaning, wet grip & UE 5.8 Wetness/Puddle MPC)
    double surface_water_mm = 0.0;        // total local standing water depth (mm; > 1.5 mm triggers aquaplaning)
    double puddle_depth_mm = 0.0;         // excess pooled water in local drainage basin (mm)
    double wetness_0_to_1 = 0.0;          // shader / MPC visual asphalt wetness (0 = dry, 0.25 = damp, 1.0 = flooded)
    double drying_line_factor = 0.0;      // 0 = uniformly wet, 1 = tyre-pumped drying track groove

    // Atmospheric Optics & Effects (feeds UE 5.8 ExponentialHeightFog, Niagara & Audio)
    double visibility_m = 20000.0;        // meteorological visibility (m; drops to ~350 m in heavy storm spray)
    double fog_density = 0.0001;          // UE 5.8 ExponentialHeightFog density proxy
    double spray_intensity_0_to_1 = 0.0;  // road-spray aerosol intensity factor (0..1)
    double lightning_flash_0_to_1 = 0.0;  // transient sky illumination flash during convective storms (0..1)
    double thunder_delay_s = -1.0;        // > 0 when a thunderclap is scheduled (distance / 343 m/s)
};

// Compact 16x16 weather radar snapshot (for in-cockpit GPS/Tempest radar & UE 5.8 UI widgets).
struct TempestRadarGrid {
    static constexpr int kSize = 16;
    double center_x_m = 0.0;
    double center_y_m = 0.0;
    double range_m = 8000.0;                                // half-width of radar box (m)
    std::array<float, kSize * kSize> rain_mm_hr{};          // row-major [iy * kSize + ix]
    std::array<float, kSize * kSize> cloud_cover{};         // row-major [iy * kSize + ix]
    double rain_chance_15m = 0.0;                           // 0..1 predicted rain probability over center in +15 min
    double rain_chance_30m = 0.0;                           // 0..1 predicted rain probability over center in +30 min
};

class TempestWeather {
public:
    static constexpr int kMaxCells = 8;
    static constexpr int kHydroRes = 32;  // 32x32 local surface hydrology & drainage basin grid

    TempestWeather() { configure(TempestConfig{}); }
    explicit TempestWeather(const TempestConfig& cfg) { configure(cfg); }

    /** Reset and deterministically initialize storm cells, solar clock, wind & 2D hydrology grid. */
    void configure(const TempestConfig& cfg);

    /** Advance storm advection, wind turbulence, solar-thermal asphalt balance, evaporation & 2D drainage by dt (s). */
    void step(double dt);

    /** Sample full weather, thermodynamics, wind & surface hydrology at world position (x_m, y_m). */
    TempestSample sample(double x_m, double y_m) const;

    /** Pump standing water out of a passing tyre's cell (carving a real drying racing line & splashing edges). */
    void deposit_tyre_wake(double x_m, double y_m, double speed_mps, double load_n, double dt);

    /** Apply live Tempest sample at (x_m, y_m) straight into a Vehicle's AtmosphericEnvironment & road_water_mm. */
    void apply_to_atmosphere(double x_m, double y_m, AtmosphericEnvironment& atm, double& out_road_water_mm) const;

    /** Build a 16x16 Tempest radar reflectivity snapshot & 15/30-min upstream wind-advection forecast. */
    TempestRadarGrid sample_radar(double center_x_m, double center_y_m, double range_m = 8000.0) const;

    /** Accessors for inspection, serialization & UE 5.8 multiplayer replication. */
    const TempestConfig& config() const { return cfg_; }
    double sim_time_s() const { return sim_time_s_; }
    double local_hour() const { return local_hour_; }
    const std::array<TempestStormCell, kMaxCells>& cells() const { return cells_; }
    void set_local_hour(double hour) { local_hour_ = std::fmod(std::fmod(hour, 24.0) + 24.0, 24.0); }

private:
    TempestConfig cfg_{};
    double sim_time_s_ = 0.0;
    double local_hour_ = 14.0;
    double baro_kpa_ = 101.325;
    double global_air_c_ = 22.0;
    double global_track_c_ = 28.0;
    double global_humidity_ = 0.52;
    double gust_x_ = 0.0;
    double gust_y_ = 0.0;
    double gust_phase_ = 0.0;
    double lightning_flash_ = 0.0;
    double lightning_cooldown_s_ = 8.0;
    double last_thunder_delay_s_ = -1.0;
    std::uint32_t rng_state_ = 1337u;

    std::array<TempestStormCell, kMaxCells> cells_{};
    // 2D local hydrology grid: water depth (mm), static basin depression depth (mm), tyre-wake drying groove (0..1)
    std::array<double, kHydroRes * kHydroRes> hydro_water_mm_{};
    std::array<double, kHydroRes * kHydroRes> hydro_basin_mm_{};
    std::array<double, kHydroRes * kHydroRes> hydro_groove_{};
    std::array<double, kHydroRes * kHydroRes> hydro_scratch_{};

    double next_rand_01();
    Vec3 synoptic_wind_mps() const;
    void evaluate_cells_at(double x_m, double y_m, double time_offset_s,
                           double& out_rain_mm_hr, double& out_cloud_0_1) const;
    void compute_sun_angles(double& out_elev_deg, double& out_azim_deg) const;
    int hydro_index(double x_m, double y_m, int* out_ix = nullptr, int* out_iy = nullptr) const;
    void spawn_cell(int slot, bool initial_scatter);
};

}  // namespace rs
