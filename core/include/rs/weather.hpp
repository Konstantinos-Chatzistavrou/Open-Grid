// Apache-2.0 — OpenGrid Dynamic Weather v2:
// Mesoscale Frontal Meteorology, Sub-Meter Curvilinear Track Hydrology, Persistent Asphalt Thermal Memory,
// Rubber-Line Wet-Grip Inversion ("The Rain Line"), Per-Wheel Aquaplaning/Puddle Physics & Volumetric Spray Plumes.
//
// Pure C++17, zero external dependencies, zero per-tick heap allocations, 100% deterministic.
// Transfers identically across Unreal Engine 5.8 (UOpenGridWeatherSubsystem -> VolumetricCloud, SkyAtmosphere,
// DirectionalLight, ExponentialHeightFog, Niagara rain/spray plumes, Wetness/Puddle MPC & Chaos vehicle physics)
// and WebGPU (rs_core.wasm).
//
// Physical sub-models:
//   1. Anisotropic Mesoscale Frontal Rain Bands & Convective Storm Cells advected by live wind with vertical shear.
//   2. Synoptic Barometric Pressure Troughs, Veering/Backing Wind Direction & 3D Spatially-Varying Dryden Gusts
//      (including convective storm downdraft bursts).
//   3. NOAA Solar Ephemeris + Cloud Optical Depth + Static Track Occlusion (bridges, grandstands, trees).
//   4. Persistent Per-Cell Asphalt Thermal Memory (solar heating, cloud/static shade cooling, wind convection,
//      evaporative cooling, raindrop quenching, and passing-tyre friction heat).
//   5. Sub-Meter Curvilinear Track-Space 2D Shallow-Water Hydrology (N_stations x 16 lanes, ~0.6 m lateral resolution:
//      real elevation slope + banking + road crown drainage into puddles & gutters + left/right painted kerbs)
//      PLUS a 1.0 m toroidal fine world patch (48x48 m) for open-world / free-roam sub-meter tyre tracks.
//   6. Persistent 2D Rubber Deposit + Wet-Line Grip Inversion (rubber boosts dry grip +8%, inverts to -24% slick
//      hydrophobic sheen when wet; painted kerbs/lines drop to ~0.46x when damp).
//   7. Wind-Advected Volumetric Car Spray Plumes & Beer-Lambert Following-Car Visibility Extinction.
//   8. 16x16 Weather Radar Reflectivity Grid & +15/+30 min upstream wind-advection nowcast.
#pragma once
#include <array>
#include <cstdint>
#include <vector>
#include "rs/drivetrain.hpp"
#include "rs/math.hpp"

namespace rs {

struct WheelContact;
struct CarConfig;

enum class WeatherPreset : int {
    Clear = 0,          // High-pressure sunny / clear night, crisp dry asphalt, light breeze
    PartlyCloudy = 1,   // Advecting cumulus clouds casting moving thermal shadows on asphalt
    DynamicFront = 2,   // Approaching mesoscale rain front: dry start -> scattered showers -> passing storm -> drying track
    LightRain = 3,      // Steady light-to-moderate rain (~3-6 mm/hr), damp/wet tarmac & curb puddles
    HeavyStorm = 4,     // Convective thunderstorm cells (14-28 mm/hr), deep puddles (>3 mm aquaplaning), gusts & lightning
    DryingTrack = 5     // Post-storm clearing skies: flooded puddles draining & cars carving a drying racing line
};

enum class WeatherSurfaceType : int {
    Asphalt = 0,        // Standard macro-textured racing / street tarmac (porosity ~0.12 mm)
    PaintedKerb = 1,    // Painted apex / exit kerb (zero porosity, ice-slick when damp/wet!)
    Concrete = 2,       // Low-porosity concrete slab / pit lane / bridge deck (~0.04 mm)
    PaintedLine = 3,    // Track-limit white line / crosswalk paint (zero porosity, slick when wet)
    Grass = 4,          // Verge grass / turf (very slick when wet)
    Gravel = 5          // Gravel trap / loose shoulder
};

// Real-world city & circuit meteorological climatology regions (NOAA / WMO 30-year seasonal normals).
enum class ClimateRegion : int {
    NewYorkMidtown = 0,     // 40.75 N, -73.99 W — Atlantic humid subtropical, coastal fronts
    SpaArdennes = 1,        // 50.43 N,   5.97 E — Ardennes microclimate: sudden showers & cool damp valleys
    NurburgringEifel = 2,   // 50.33 N,   6.95 E — Eifel mountains: rapid frontal shifts, fog & mountain mist
    SilverstoneUK = 3,      // 52.07 N,  -1.02 W — British oceanic: gusty SW winds & passing squall bands
    BrandsHatchUK = 4,      // 51.35 N,   0.26 E — Kentish Downs: variable maritime fronts & cool shade
    MonzaItaly = 5,         // 45.62 N,   9.28 E — Po Valley / Lombardy: hot summer tarmac & alpine storms
    SebringFlorida = 6,     // 27.45 N, -81.35 W — Central Florida: humid subtropical afternoon thunderstorms
    TokyoWangan = 7,        // 35.65 N, 139.77 E — Tokyo Bay maritime: humid summer rain bands, crisp winter
    LosAngelesCanyons = 8,  // 34.10 N,-118.41 W — Mediterranean dry summer, warm Santa Ana gusts, rare winter rain
    SuzukaJapan = 9,        // 34.84 N, 136.54 E — Coastal Mie: humid maritime fronts & heavy monsoon squalls
    LeMansFrance = 10,      // 47.95 N,   0.21 E — Loire valley: cool night dew & sudden dawn/night showers
    AthensGreece = 11,      // 37.98 N,  23.73 E — Aegean Mediterranean: blazing dry summer tarmac, Meltemi NNE winds
    CustomLatLon = 12       // Procedural Koppen-like climate synthesized from any (lat, lon, day_of_year)
};

struct ClimateProfile {
    ClimateRegion region = ClimateRegion::NewYorkMidtown;
    double latitude_deg = 40.75;
    double longitude_deg = -73.99;
    double jan_mean_c = 0.5;          // January daily mean temperature (C)
    double jul_mean_c = 25.0;         // July daily mean temperature (C)
    double diurnal_swing_c = 8.0;     // typical afternoon-to-dawn temperature range (C)
    double mean_humidity = 0.64;      // climatological mean relative humidity (0..1)
    double winter_rain_prob = 0.34;   // probability of active rain / passing front in winter (0..1)
    double summer_rain_prob = 0.30;   // probability of active rain / convective storm in summer (0..1)
    double storm_intensity_mm_hr = 12.0; // typical peak rainfall rate when raining (mm/hr)
    double mean_wind_mps = 5.2;       // mean 10 m wind speed (m/s)
    double prevailing_wind_deg = 250.0; // prevailing wind-from compass bearing (deg)
    double frontal_variability = 0.55;// 0..1 likelihood of dynamic changing fronts vs steady sky
};

// Live real-world meteorological observation (ingested from Open-Meteo, NOAA, METAR, or UE5 HTTP weather API).
struct RealWeatherObservation {
    double latitude_deg = 40.75;
    int day_of_year = 172;
    double local_hour = 14.0;
    double ambient_air_c = 22.0;          // measured 2 m air temperature (C)
    double humidity_0_to_1 = 0.55;        // measured 2 m relative humidity (0..1)
    double barometric_kpa = 101.325;      // measured sea-level / surface pressure (kPa; e.g. hPa * 0.1)
    double wind_speed_mps = 4.5;          // measured 10 m wind speed (m/s)
    double wind_direction_deg = 245.0;    // measured 10 m wind direction FROM (deg)
    double cloud_cover_0_to_1 = 0.35;     // measured total cloud fraction (0..1)
    double rain_mm_per_hr = 0.0;          // measured current precipitation rate (mm/hr)
    double forecast_rain_15m_mm_hr = -1.0;// optional short-term upstream forecast (+15 min, < 0 = unknown)
    double forecast_rain_30m_mm_hr = -1.0;// optional short-term upstream forecast (+30 min, < 0 = unknown)
};

struct StormCell {
    bool active = false;
    double x_m = 0.0;                 // world center X (m)
    double y_m = 0.0;                 // world center Y (m)
    double rain_radius_m = 1800.0;    // precipitation core minor semi-axis (m)
    double cloud_radius_m = 4200.0;   // cloud anvil / shadow minor semi-axis (m)
    double band_angle_rad = 0.0;      // frontal squall-band orientation angle (rad)
    double aspect_ratio = 1.0;        // 1.0 = circular convective cell, 2.2..4.2 = elongated frontal rain band
    double pressure_drop_kpa = 0.4;   // mesoscale low-pressure core anomaly (kPa)
    double vertical_shear_mps = 0.0;  // upper-level cloud steering wind shear speed (m/s)
    double peak_rain_mm_hr = 0.0;     // core precipitation intensity (mm/hr)
    double peak_cloud_cover = 0.7;    // core cloud opacity (0..1)
    double age_s = 0.0;               // elapsed lifecycle age (s)
    double lifetime_s = 3600.0;       // total cell lifecycle (s)
};

// One cross-section station along a circuit / road spline for sub-meter curvilinear track hydrology & thermal memory.
// Feed directly from UE 5.8 spline + landscape elevation/banking traces or rs::Route.
struct TrackWeatherStation {
    double x_m = 0.0;                 // centerline world X (m)
    double y_m = 0.0;                 // centerline world Y (m)
    double z_m = 0.0;                 // centerline elevation Z (m; drives longitudinal downhill drainage)
    double width_m = 12.0;            // drivable road width between kerbs (m)
    double banking_rad = 0.0;         // road lateral cross-slope (+ = right edge higher, water drains left)
    double crown_m = 0.035;           // parabolic center crown height (m; sheds water toward both gutters)
    double shade_0_to_1 = 0.0;        // static sun occlusion (0 = open sky, 1 = under bridge / grandstand / dense trees)
    double wind_shelter_0_to_1 = 0.0; // 3D wind shadow (0 = exposed airfield, 1 = behind grandstand / canyon wall / tunnel)
    double ideal_offset_m = 0.0;      // racing line lateral offset from centerline (+ = left, m)
    double initial_rubber = 0.55;     // pre-session rubber saturation along the ideal racing line (0..1)
    double drain_rate = 1.0;          // edge storm-drain efficiency multiplier (0.2 = poor drainage puddle zone, 1.5 = fast)
};

// 3D Wind Shadow / Canyon / Grandstand / Building Shelter Volume for open-world or circuit crosswind shear.
struct WindShelterZone {
    double center_x_m = 0.0;
    double center_y_m = 0.0;
    double half_x_m = 25.0;
    double half_y_m = 25.0;
    double shelter_0_to_1 = 0.85;     // 0 = open, 1 = full blockage (creates sharp crosswind shear on exit!)
};

// F1 / IMSA Pit-Wall Race Engineer Weather Strategy & Tyre Compound Crossover Prediction.
enum class RecommendedTyreCompound : int {
    Slick = 0,
    Intermediate = 1,
    FullWet = 2
};

struct WeatherStrategyAdvice {
    RecommendedTyreCompound current_best = RecommendedTyreCompound::Slick;
    RecommendedTyreCompound forecast_15m_best = RecommendedTyreCompound::Slick;
    double current_water_mm = 0.0;
    double predicted_water_15m_mm = 0.0;
    double slick_lap_delta_s = 0.0;   // predicted lap time penalty vs dry slick baseline (s)
    double inter_lap_delta_s = 0.0;   // predicted lap time penalty vs dry slick baseline (s)
    double wet_lap_delta_s = 0.0;     // predicted lap time penalty vs dry slick baseline (s)
    double crossover_eta_s = -1.0;    // seconds until optimal compound switches (-1 = no change imminent in 30 min)
    bool box_now = false;             // true when current compound is no longer optimal or crossover is < 1 lap away
};

struct WeatherConfig {
    WeatherPreset preset = WeatherPreset::DynamicFront;
    std::uint32_t seed = 1337u;
    double latitude_deg = 40.75;          // geographic latitude (NYC 40.75 N; Brands Hatch 51.35 N; Spa 50.43 N)
    int day_of_year = 172;                // 1..365 (172 = summer solstice, 355 = winter solstice)
    double start_hour_local = 14.0;       // 0..24 local solar time
    double time_scale = 1.0;              // 1.0 = real-time, 4.0 = 4x game clock
    double base_ambient_c = 22.0;         // synoptic baseline air temperature (C)
    double base_humidity = 0.52;          // baseline relative humidity (0..1)
    double base_wind_mps = 4.5;           // baseline synoptic wind speed at 10 m (m/s)
    double wind_direction_deg = 245.0;    // meteorological direction wind blows FROM (deg, 0=N, 90=E, 270=W)
    double domain_half_extent_m = 4000.0; // macro hydrology & radar local track/city half-extent (m)
    double asphalt_porosity_mm = 0.12;    // micro-texture storage absorbed before free standing film appears
};

// Local weather, atmospheric, aerodynamic wind, hydrology & UE 5.8 rendering state at world position (x, y).
struct WeatherSample {
    // Spatial precipitation & sky
    double rain_mm_per_hr = 0.0;          // local rainfall rate at (x, y), mm/hr
    double cloud_cover_0_to_1 = 0.0;      // local overhead cloud coverage (0..1)
    double cloud_shadow_0_to_1 = 0.0;     // solar beam occlusion at (x, y) (0 = full sun, 1 = deep storm shadow)
    double sun_elevation_deg = 45.0;      // solar altitude above horizon (deg; <= 0 at night)
    double sun_azimuth_deg = 180.0;       // solar compass azimuth (deg, 0=N, 90=E, 180=S, 270=W)
    double solar_irradiance_w_m2 = 0.0;   // direct + diffuse shortwave irradiance reaching asphalt (W/m^2)

    // Thermodynamics & Atmosphere (feeds AtmosphericEnvironment)
    double ambient_air_c = 22.0;          // local air temperature (C)
    double track_surface_c = 30.0;        // local top 4 mm asphalt skin temperature (C; fast cloud-shadow response)
    double track_subsurface_c = 26.0;     // deep 50 mm asphalt thermal-mass base temperature (C; evening heat retention)
    double dew_point_c = 12.0;            // Magnus dew-point temperature (C)
    double humidity_0_to_1 = 0.50;        // local relative humidity (0..1)
    double barometric_kpa = 101.325;      // local sea-level synoptic barometric pressure (kPa)
    bool dew_condensing = false;          // true when clear-sky cooling drops skin_c <= dew_point_c (zero-rain dawn dew!)
    double ice_0_to_1 = 0.0;              // 0..1 black ice / surface frost fraction when wet asphalt freezes (<= 0 C)

    // 3D Wind & Turbulence (feeds Vehicle aero relative air velocity)
    Vec3 wind_world_mps{0.0, 0.0, 0.0};   // instantaneous 3D world wind vector incl. veering, gusts & downdrafts (m/s)
    double wind_speed_mps = 0.0;          // magnitude of horizontal wind (m/s)
    double wind_direction_deg = 245.0;    // live meteorological wind-from direction after frontal veering (deg)
    double wind_shelter_0_to_1 = 0.0;     // local 3D wind shadow occlusion (grandstand / skyscraper / canyon wall)
    double gust_intensity_0_to_1 = 0.0;   // turbulent gust factor (0..1)

    // Surface Hydrology (feeds Tire hydroplaning, wet grip & UE 5.8 Wetness/Puddle MPC)
    double surface_water_mm = 0.0;        // total local standing water depth (mm; > 1.5 mm triggers aquaplaning)
    double puddle_depth_mm = 0.0;         // excess pooled water in local drainage basin (mm)
    double wetness_0_to_1 = 0.0;          // shader / MPC visual asphalt wetness (0 = dry, 0.25 = damp, 1.0 = flooded)
    double drying_line_factor = 0.0;      // 0 = uniformly wet, 1 = tyre-pumped drying track groove
    double rubber_0_to_1 = 0.0;           // local laid-down tyre rubber saturation (0 = green, 1 = heavy racing line)

    // Atmospheric Optics & Effects (feeds UE 5.8 ExponentialHeightFog, Niagara & Audio)
    double visibility_m = 20000.0;        // meteorological visibility (m; drops to ~250 m in heavy storm)
    double fog_density = 0.0001;          // UE 5.8 ExponentialHeightFog density proxy
    double spray_intensity_0_to_1 = 0.0;  // road-spray aerosol intensity factor (0..1)
    double lightning_flash_0_to_1 = 0.0;  // transient sky illumination flash during convective storms (0..1)
    double thunder_delay_s = -1.0;        // > 0 when a thunderclap is scheduled (distance / 343 m/s)
};

// High-resolution sub-meter per-wheel contact-patch weather sample (drives asymmetric aquaplaning,
// wet rubber-line grip inversion, painted-kerb ice slip, and per-wheel shaded asphalt temperature).
struct WeatherWheelSample {
    double water_depth_mm = 0.0;          // exact standing water film under this tyre contact patch (mm)
    double puddle_depth_mm = 0.0;         // standing puddle excess depth under this tyre (mm)
    double wetness_0_to_1 = 0.0;          // local surface wetness (0..1)
    double track_temp_c = 28.0;           // persistent local asphalt temperature under this tyre (C)
    double rubber_0_to_1 = 0.0;           // laid-down rubber at this sub-meter lane (0..1)
    double drying_line_factor = 0.0;      // 0 = un-cleared wet, 1 = tyre-pumped drying groove
    double surface_mu_mult = 1.0;         // dry rubber bonus (+8%) vs wet rubber inversion (-24%) vs wet painted kerb (0.46)
    double static_shade_0_to_1 = 0.0;     // static track occlusion at this wheel (bridge/grandstand/trees)
    double ice_0_to_1 = 0.0;              // 0..1 black ice / surface frost at this wheel (drops grip toward ~0.15x!)
    double mud_0_to_1 = 0.0;              // 0..1 dragged-on wet mud / off-track dirt at this wheel (drops grip up to -42%)
    double spray_generation_0_to_1 = 0.0; // relative water volume atomized into spray by this wheel
    bool on_painted_kerb = false;         // true when wheel sits on painted kerb lane
};

// Wind-advected volumetric spray plume shed by a speeding car on wet asphalt (blinds following drivers & drives UE 5.8 Niagara).
struct SprayPlume {
    bool active = false;
    Vec3 pos_m{0.0, 0.0, 0.0};            // current plume world center (m, advected downwind)
    Vec3 vel_mps{0.0, 0.0, 0.0};          // plume drift velocity (m/s)
    double radius_m = 2.5;                // plume optical radius (m, expands over lifetime)
    double density_0_to_1 = 0.0;          // optical spray density (0..1, decays over ~4.5 s)
    double age_s = 0.0;
    double lifetime_s = 4.5;
};

// Compact 16x16 weather radar snapshot (for in-cockpit GPS/Dynamic Weather radar & UE 5.8 UI widgets).
struct WeatherRadarGrid {
    static constexpr int kSize = 16;
    double center_x_m = 0.0;
    double center_y_m = 0.0;
    double range_m = 8000.0;                                // half-width of radar box (m)
    std::array<float, kSize * kSize> rain_mm_hr{};          // row-major [iy * kSize + ix]
    std::array<float, kSize * kSize> cloud_cover{};         // row-major [iy * kSize + ix]
    double rain_chance_15m = 0.0;                           // 0..1 predicted rain probability over center in +15 min
    double rain_chance_30m = 0.0;                           // 0..1 predicted rain probability over center in +30 min
};

class WeatherSystem {
public:
    static constexpr int kMaxCells = 8;
    static constexpr int kHydroRes = 32;        // 32x32 macro domain hydrology & drainage basin grid
    static constexpr int kFineRes = 48;         // 48x48 x 1.0 m toroidal fine open-world hydrology / rubber / thermal tile
    static constexpr int kTrackLanes = 16;      // 16 lateral lanes across bound track (0=L kerb, 1..14=~0.7 m asphalt, 15=R kerb)
    static constexpr int kMaxSprayPlumes = 32;  // wind-advected volumetric trailing spray plumes
    static constexpr int kSpatialBuckets = 4096;// O(1) spatial grid hash table for 20 km+ high-res tracks
    static constexpr double kSpatialBucketM = 25.0;

    WeatherSystem() { configure(WeatherConfig{}); }
    explicit WeatherSystem(const WeatherConfig& cfg) { configure(cfg); }

    /** Reset and deterministically initialize frontal storm bands, solar clock, veering wind & hydrology grids. */
    void configure(const WeatherConfig& cfg);

    /** Return NOAA/WMO 30-year seasonal climate normals for a real city or circuit (or synthesized CustomLatLon). */
    static ClimateProfile climate_profile(ClimateRegion region, double custom_lat_deg = 40.75, double custom_lon_deg = -73.99);

    /** Deterministically synthesize realistic weather for a real city / circuit, date, local hour & seed. */
    void configure_for_region(ClimateRegion region, int day_of_year, double local_hour,
                              std::uint32_t seed = 1337u, double time_scale = 1.0,
                              double custom_lat_deg = 40.75, double custom_lon_deg = -73.99);

    /** Configure live storm cells, synoptic baro, wind & initial surface wetness directly from real-world weather data
     *  (Open-Meteo / NOAA / METAR observation). */
    void configure_from_live_observation(const RealWeatherObservation& obs, std::uint32_t seed = 1337u,
                                         double time_scale = 1.0);

    /** Bind real circuit / road spline geometry (elevation, banking, crown, static shade, ideal racing line)
     *  and build an O(1) spatial lookup grid for sub-meter curvilinear 2D shallow-water hydrology. */
    void bind_track_geometry(const std::vector<TrackWeatherStation>& stations, bool closed_loop = true);

    /** Override per-cell elevation heightfield (size == track_station_count() * kTrackLanes, values in mm)
     *  with a real laser-scanned / UE 5.8 Landscape mesh raycast bake so puddles pool in exact centimeter dips. */
    bool bind_track_heightfield(const std::vector<double>& cell_elev_mm);

    /** Register a 3D wind-shadow volume (grandstand, skyscraper block, canyon wall, bridge) for crosswind exit shear. */
    void add_wind_shelter_zone(const WindShelterZone& zone);
    void clear_wind_shelter_zones() { wind_shelters_.clear(); }

    void clear_track_geometry();
    bool has_track_geometry() const { return track_stations_.size() >= 2; }
    int track_station_count() const { return static_cast<int>(track_stations_.size()); }

    /** Advance storm advection, veering wind, 3D gusts, 2-layer thermal balance, dew/ice, drainage & spray plumes. */
    void step(double dt);

    /** Sample macro + local weather, thermodynamics, 3D wind & hydrology at world position (x_m, y_m). */
    WeatherSample sample(double x_m, double y_m) const;

    /** Sample sub-meter per-wheel hydrology, rubber-line wet-grip inversion, ice, mud, wet kerb slip & local asphalt temp. */
    WeatherWheelSample sample_wheel(double x_m, double y_m,
                                    WeatherSurfaceType surface = WeatherSurfaceType::Asphalt) const;

    /** Legacy wake pumping entry point (forwards to deposit_tyre_passage with road-tyre evacuation scale). */
    void deposit_tyre_wake(double x_m, double y_m, double speed_mps, double load_n, double dt);

    /** Sub-meter per-tyre passage: pumps standing water (scaled by tread_evac_scale: wet > road > slick),
     *  splashes laterally, lays rubber on dry/damp cells, sheds off-track mud onto asphalt & injects tyre friction heat. */
    void deposit_tyre_passage(double x_m, double y_m, double speed_mps, double load_n,
                              double slip_power_w, double tread_evac_scale, double dt,
                              double tyre_mud_0_to_1 = 0.0);

    /** Emit a wind-advected volumetric spray plume behind a car moving over standing water. */
    void deposit_car_spray(const Vec3& car_pos, const Vec3& car_vel, double avg_water_mm,
                           double diffuser_downforce_n, double dt);

    /** Evaluate driver forward line-of-sight visibility (m) through rain, fog AND downstream car spray plumes. */
    double sample_driver_visibility_m(const Vec3& eye_pos, const Vec3& look_dir) const;

    /** F1 / IMSA Pit-Wall Weather Engineer: predicts optimal compound (Slick / Inter / Wet), lap-time deltas & crossover ETA. */
    WeatherStrategyAdvice evaluate_pit_strategy(double x_m, double y_m, double lap_time_dry_s = 90.0,
                                                RecommendedTyreCompound mounted = RecommendedTyreCompound::Slick) const;

    /** Apply live weather at car_pos straight into AtmosphericEnvironment & scalar road_water_mm. */
    void apply_to_atmosphere(double x_m, double y_m, AtmosphericEnvironment& atm, double& out_road_water_mm) const;

    /** Full per-wheel weather coupling: updates AtmosphericEnvironment AND populates per-wheel water_depth_mm,
     *  track_temp_c and rubber/kerb surface_mu_mult directly on all 4 WheelContacts (shared by UE 5.8 & WASM). */
    void apply_to_vehicle(const Vec3& car_pos, std::array<WheelContact, 4>& contacts,
                          AtmosphericEnvironment& atm, double& out_road_water_mm,
                          const CarConfig* cfg = nullptr) const;

    /** Build a 16x16 weather radar reflectivity snapshot & +15/+30 min upstream wind-advection nowcast. */
    WeatherRadarGrid sample_radar(double center_x_m, double center_y_m, double range_m = 8000.0) const;

    /** Accessors for inspection, serialization & UE 5.8 multiplayer replication / Niagara spray emitters. */
    const WeatherConfig& config() const { return cfg_; }
    double sim_time_s() const { return sim_time_s_; }
    double local_hour() const { return local_hour_; }
    double live_wind_direction_deg() const;
    const std::array<StormCell, kMaxCells>& cells() const { return cells_; }
    const std::array<SprayPlume, kMaxSprayPlumes>& spray_plumes() const { return spray_plumes_; }
    void set_local_hour(double hour) { local_hour_ = std::fmod(std::fmod(hour, 24.0) + 24.0, 24.0); }

private:
    struct FineCell {
        int32_t world_ix = -999999;
        int32_t world_iy = -999999;
        double water_mm = 0.0;
        double basin_mm = 0.0;
        double rubber = 0.0;
        double mud = 0.0;
        double ice = 0.0;
        double temp_c = 25.0;       // top 4 mm asphalt skin
        double base_temp_c = 24.0;  // deep 50 mm asphalt thermal-mass base
        double groove = 0.0;
        double last_sync_s = 0.0;
    };

    struct TrackStationPrecomp {
        TrackWeatherStation st{};
        double tx = 1.0, ty = 0.0;   // unit tangent along track
        double lx = 0.0, ly = 1.0;   // unit left normal (+d direction)
        double seg_len_m = 10.0;
    };

    WeatherConfig cfg_{};
    double sim_time_s_ = 0.0;
    double local_hour_ = 14.0;
    double baro_kpa_ = 101.325;
    double global_air_c_ = 22.0;
    double global_track_c_ = 28.0;      // global top 4 mm asphalt skin (C)
    double global_base_c_ = 25.0;       // global deep 50 mm subsurface asphalt base (C)
    double global_ice_ = 0.0;           // global black-ice / frost fraction (0..1)
    double global_humidity_ = 0.52;
    double wind_veer_deg_ = 0.0;       // frontal synoptic wind direction shift (deg)
    double gust_x_ = 0.0;
    double gust_y_ = 0.0;
    double gust_z_ = 0.0;
    double gust_phase_ = 0.0;
    double lightning_flash_ = 0.0;
    double lightning_cooldown_s_ = 8.0;
    double last_thunder_delay_s_ = -1.0;
    int spray_cursor_ = 0;
    double spray_emit_accum_s_ = 0.0;
    std::uint32_t rng_state_ = 1337u;

    std::array<StormCell, kMaxCells> cells_{};
    std::array<SprayPlume, kMaxSprayPlumes> spray_plumes_{};

    // Layer 1: 32x32 Macro domain hydrology grid
    std::array<double, kHydroRes * kHydroRes> hydro_water_mm_{};
    std::array<double, kHydroRes * kHydroRes> hydro_basin_mm_{};
    std::array<double, kHydroRes * kHydroRes> hydro_groove_{};
    std::array<double, kHydroRes * kHydroRes> hydro_scratch_{};

    // Layer 2: 48x48 x 1.0 m toroidal fine world patch (open-world sub-meter tyre tracks & puddles)
    mutable std::array<FineCell, kFineRes * kFineRes> fine_cells_{};

    // Layer 3: Sub-meter curvilinear track surface strip (allocated once on bind_track_geometry, zero allocs in step)
    bool track_closed_loop_ = true;
    std::vector<TrackStationPrecomp> track_stations_;
    std::array<int32_t, kSpatialBuckets> spatial_heads_{}; // O(1) spatial hash bucket heads (-1 = empty)
    std::vector<int32_t> spatial_next_;                    // intrusive singly-linked next station per station
    std::vector<double> track_water_mm_;
    std::vector<double> track_water_scratch_;
    std::vector<double> track_rubber_;
    std::vector<double> track_mud_;         // dragged-on wet grass/gravel mud per cell (0..1)
    std::vector<double> track_ice_;         // black ice / frost fraction per cell (0..1)
    std::vector<double> track_temp_c_;      // top 4 mm asphalt skin temperature (C)
    std::vector<double> track_base_temp_c_; // deep 50 mm asphalt base temperature (C)
    std::vector<double> track_groove_;
    std::vector<double> track_elev_mm_; // static cell elevation (mm) from z_m + banking + crown or laser-scan heightfield
    std::vector<WindShelterZone> wind_shelters_;

    double next_rand_01();
    Vec3 synoptic_wind_mps() const;
    double wind_shelter_at(double x_m, double y_m, double* out_edge_shear = nullptr) const;
    Vec3 wind_at(double x_m, double y_m, double local_rain_mm_hr) const;
    void evaluate_cells_at(double x_m, double y_m, double time_offset_s,
                           double& out_rain_mm_hr, double& out_cloud_0_1,
                           double* out_pressure_drop_kpa = nullptr) const;
    void compute_sun_angles(double& out_elev_deg, double& out_azim_deg) const;
    int hydro_index(double x_m, double y_m, int* out_ix = nullptr, int* out_iy = nullptr) const;
    void spawn_cell(int slot, bool initial_scatter);
    void rebuild_spatial_index();
    bool project_to_track(double x_m, double y_m, int& out_station, int& out_lane, double& out_d_m) const;
    FineCell& ensure_fine_cell(int32_t wix, int32_t wiy) const;
    void init_track_cells_from_preset(double init_water_mm);
    static double compute_surface_mu_mult(double water_mm, double rubber, WeatherSurfaceType surface,
                                          double ice_0_to_1 = 0.0, double mud_0_to_1 = 0.0);
};

}  // namespace rs
