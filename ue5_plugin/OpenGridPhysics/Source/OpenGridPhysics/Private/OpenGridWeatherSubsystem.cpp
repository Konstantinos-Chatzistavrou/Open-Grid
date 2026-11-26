// Apache-2.0 — Unreal Engine 5.8 World Subsystem implementation for OpenGrid Dynamic Weather v2.
#include "OpenGridWeatherSubsystem.h"

void UOpenGridWeatherSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
    rs::WeatherConfig Cfg;
    Cfg.preset = rs::WeatherPreset::DynamicFront;
    Weather_.configure(Cfg);
}

void UOpenGridWeatherSubsystem::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
    if (DeltaTime > 0.0f)
    {
        Weather_.step(static_cast<double>(FMath::Clamp(DeltaTime, 0.0f, 0.25f)));
    }
}

TStatId UOpenGridWeatherSubsystem::GetStatId() const
{
    RETURN_QUICK_DECLARE_CYCLE_STAT(UOpenGridWeatherSubsystem, STATGROUP_Tickables);
}

void UOpenGridWeatherSubsystem::ConfigureWeather(EOpenGridWeatherPreset Preset, int32 Seed, float LocalHour,
                                                 float LatitudeDeg, int32 DayOfYear, float TimeScale,
                                                 float BaseAmbientC, float BaseWindMps, float WindDirectionDeg)
{
    rs::WeatherConfig Cfg;
    Cfg.preset = static_cast<rs::WeatherPreset>(static_cast<int>(Preset));
    Cfg.seed = static_cast<std::uint32_t>(Seed > 0 ? Seed : 1337);
    Cfg.start_hour_local = static_cast<double>(LocalHour);
    Cfg.latitude_deg = static_cast<double>(LatitudeDeg);
    Cfg.day_of_year = FMath::Clamp(DayOfYear, 1, 365);
    Cfg.time_scale = static_cast<double>(FMath::Max(0.0f, TimeScale));
    Cfg.base_ambient_c = static_cast<double>(BaseAmbientC);
    Cfg.base_wind_mps = static_cast<double>(FMath::Max(0.0f, BaseWindMps));
    Cfg.wind_direction_deg = static_cast<double>(WindDirectionDeg);
    Weather_.configure(Cfg);
}

void UOpenGridWeatherSubsystem::ConfigureForClimateRegion(EOpenGridClimateRegion Region, int32 DayOfYear, float LocalHour,
                                                          int32 Seed, float TimeScale,
                                                          float CustomLatitudeDeg, float CustomLongitudeDeg)
{
    Weather_.configure_for_region(
        static_cast<rs::ClimateRegion>(static_cast<int>(Region)),
        FMath::Clamp(DayOfYear, 1, 365),
        static_cast<double>(LocalHour),
        static_cast<std::uint32_t>(Seed > 0 ? Seed : 1337),
        static_cast<double>(FMath::Max(0.0f, TimeScale)),
        static_cast<double>(CustomLatitudeDeg),
        static_cast<double>(CustomLongitudeDeg));
}

void UOpenGridWeatherSubsystem::ApplyLiveWeatherObservation(const FOpenGridRealWeatherObservation& Observation,
                                                            int32 Seed, float TimeScale)
{
    rs::RealWeatherObservation Obs;
    Obs.latitude_deg = static_cast<double>(Observation.LatitudeDeg);
    Obs.day_of_year = FMath::Clamp(Observation.DayOfYear, 1, 365);
    Obs.local_hour = static_cast<double>(Observation.LocalHour);
    Obs.ambient_air_c = static_cast<double>(Observation.AmbientAirC);
    Obs.humidity_0_to_1 = static_cast<double>(FMath::Clamp(Observation.Humidity01, 0.05f, 1.0f));
    Obs.barometric_kpa = static_cast<double>(Observation.BarometricKpa);
    Obs.wind_speed_mps = static_cast<double>(FMath::Max(0.0f, Observation.WindSpeedMps));
    Obs.wind_direction_deg = static_cast<double>(Observation.WindDirectionDeg);
    Obs.cloud_cover_0_to_1 = static_cast<double>(FMath::Clamp(Observation.CloudCover01, 0.0f, 1.0f));
    Obs.rain_mm_per_hr = static_cast<double>(FMath::Max(0.0f, Observation.RainMmPerHr));
    Obs.forecast_rain_15m_mm_hr = static_cast<double>(Observation.ForecastRain15MinMmPerHr);
    Obs.forecast_rain_30m_mm_hr = static_cast<double>(Observation.ForecastRain30MinMmPerHr);
    Weather_.configure_from_live_observation(Obs, static_cast<std::uint32_t>(Seed > 0 ? Seed : 1337),
                                             static_cast<double>(FMath::Max(0.0f, TimeScale)));
}

void UOpenGridWeatherSubsystem::BindTrackGeometryCm(const TArray<FOpenGridTrackWeatherStation>& Stations, bool bClosedLoop)
{
    std::vector<rs::TrackWeatherStation> CoreStations;
    CoreStations.reserve(static_cast<std::size_t>(Stations.Num()));
    for (const FOpenGridTrackWeatherStation& S : Stations)
    {
        rs::TrackWeatherStation C;
        // Unreal cm (X fwd, Y right, Z up) -> rs_core m (X fwd, Y left, Z up)
        C.x_m = static_cast<double>(S.CenterLocationCm.X) * 0.01;
        C.y_m = -static_cast<double>(S.CenterLocationCm.Y) * 0.01;
        C.z_m = static_cast<double>(S.CenterLocationCm.Z) * 0.01;
        C.width_m = FMath::Max(4.0, static_cast<double>(S.WidthCm) * 0.01);
        C.banking_rad = FMath::DegreesToRadians(static_cast<double>(S.BankingDeg));
        C.crown_m = FMath::Max(0.0, static_cast<double>(S.CrownCm) * 0.01);
        C.shade_0_to_1 = FMath::Clamp(static_cast<double>(S.StaticShade01), 0.0, 1.0);
        C.wind_shelter_0_to_1 = FMath::Clamp(static_cast<double>(S.WindShelter01), 0.0, 1.0);
        C.ideal_offset_m = -static_cast<double>(S.IdealOffsetRightCm) * 0.01; // +left in core = -right in UE
        C.initial_rubber = FMath::Clamp(static_cast<double>(S.InitialRubber01), 0.0, 1.0);
        C.drain_rate = FMath::Max(0.1, static_cast<double>(S.DrainRate));
        CoreStations.push_back(C);
    }
    Weather_.bind_track_geometry(CoreStations, bClosedLoop);
}

bool UOpenGridWeatherSubsystem::BindTrackHeightfieldCm(const TArray<float>& CellElevationCm)
{
    std::vector<double> ElevMm;
    ElevMm.reserve(static_cast<std::size_t>(CellElevationCm.Num()));
    for (float Cm : CellElevationCm)
    {
        ElevMm.push_back(static_cast<double>(Cm) * 10.0); // 1 UE cm = 10 mm
    }
    return Weather_.bind_track_heightfield(ElevMm);
}

void UOpenGridWeatherSubsystem::AddWindShelterBoxCm(const FVector& CenterLocationCm, const FVector2D& HalfExtentCm, float Shelter01)
{
    rs::WindShelterZone Z;
    Z.center_x_m = static_cast<double>(CenterLocationCm.X) * 0.01;
    Z.center_y_m = -static_cast<double>(CenterLocationCm.Y) * 0.01;
    Z.half_x_m = FMath::Max(1.0, static_cast<double>(HalfExtentCm.X) * 0.01);
    Z.half_y_m = FMath::Max(1.0, static_cast<double>(HalfExtentCm.Y) * 0.01);
    Z.shelter_0_to_1 = FMath::Clamp(static_cast<double>(Shelter01), 0.0, 1.0);
    Weather_.add_wind_shelter_zone(Z);
}

FOpenGridWeatherStrategy UOpenGridWeatherSubsystem::EvaluatePitStrategyCm(const FVector& WorldLocationCm, float DryLapTimeS, int32 MountedCompound) const
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    const rs::RecommendedTyreCompound M = static_cast<rs::RecommendedTyreCompound>(FMath::Clamp(MountedCompound, 0, 2));
    const rs::WeatherStrategyAdvice A = Weather_.evaluate_pit_strategy(Xm, Ym, static_cast<double>(DryLapTimeS), M);

    FOpenGridWeatherStrategy Out;
    Out.CurrentBestCompound = static_cast<int32>(A.current_best);
    Out.Forecast15MinBestCompound = static_cast<int32>(A.forecast_15m_best);
    Out.CurrentWaterMm = static_cast<float>(A.current_water_mm);
    Out.PredictedWater15MinMm = static_cast<float>(A.predicted_water_15m_mm);
    Out.SlickLapDeltaS = static_cast<float>(A.slick_lap_delta_s);
    Out.InterLapDeltaS = static_cast<float>(A.inter_lap_delta_s);
    Out.WetLapDeltaS = static_cast<float>(A.wet_lap_delta_s);
    Out.CrossoverEtaS = static_cast<float>(A.crossover_eta_s);
    Out.bBoxNow = A.box_now;
    return Out;
}

void UOpenGridWeatherSubsystem::ClearTrackGeometry()
{
    Weather_.clear_track_geometry();
}

FOpenGridWeatherSample UOpenGridWeatherSubsystem::SampleAtLocationCm(const FVector& WorldLocationCm) const
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    const rs::WeatherSample S = Weather_.sample(Xm, Ym);

    FOpenGridWeatherSample Out;
    Out.RainMmPerHr = static_cast<float>(S.rain_mm_per_hr);
    Out.CloudCover01 = static_cast<float>(S.cloud_cover_0_to_1);
    Out.CloudShadow01 = static_cast<float>(S.cloud_shadow_0_to_1);
    Out.SunElevationDeg = static_cast<float>(S.sun_elevation_deg);
    Out.SunAzimuthDeg = static_cast<float>(S.sun_azimuth_deg);
    Out.SolarIrradianceWm2 = static_cast<float>(S.solar_irradiance_w_m2);
    Out.AmbientAirC = static_cast<float>(S.ambient_air_c);
    Out.TrackSurfaceC = static_cast<float>(S.track_surface_c);
    Out.TrackSubsurfaceC = static_cast<float>(S.track_subsurface_c);
    Out.bDewCondensing = S.dew_condensing;
    Out.Ice01 = static_cast<float>(S.ice_0_to_1);
    Out.WindShelter01 = static_cast<float>(S.wind_shelter_0_to_1);
    Out.DewPointC = static_cast<float>(S.dew_point_c);
    Out.Humidity01 = static_cast<float>(S.humidity_0_to_1);
    Out.BarometricKpa = static_cast<float>(S.barometric_kpa);
    Out.WindVelocityCmS = FVector(
        static_cast<float>(S.wind_world_mps.x * 100.0),
        static_cast<float>(-S.wind_world_mps.y * 100.0),
        static_cast<float>(S.wind_world_mps.z * 100.0));
    Out.WindSpeedMps = static_cast<float>(S.wind_speed_mps);
    Out.WindDirectionDeg = static_cast<float>(S.wind_direction_deg);
    Out.SurfaceWaterMm = static_cast<float>(S.surface_water_mm);
    Out.PuddleDepthMm = static_cast<float>(S.puddle_depth_mm);
    Out.Wetness01 = static_cast<float>(S.wetness_0_to_1);
    Out.DryingLineFactor = static_cast<float>(S.drying_line_factor);
    Out.Rubber01 = static_cast<float>(S.rubber_0_to_1);
    Out.VisibilityM = static_cast<float>(S.visibility_m);
    Out.FogDensity = static_cast<float>(S.fog_density);
    Out.SprayIntensity01 = static_cast<float>(S.spray_intensity_0_to_1);
    Out.LightningFlash01 = static_cast<float>(S.lightning_flash_0_to_1);
    Out.ThunderDelayS = static_cast<float>(S.thunder_delay_s);
    return Out;
}

FOpenGridWheelWeatherSample UOpenGridWeatherSubsystem::SampleWheelAtLocationCm(const FVector& WorldLocationCm,
                                                                               EOpenGridWeatherSurfaceType SurfaceType) const
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    const rs::WeatherWheelSample W = Weather_.sample_wheel(Xm, Ym, static_cast<rs::WeatherSurfaceType>(static_cast<int>(SurfaceType)));

    FOpenGridWheelWeatherSample Out;
    Out.WaterDepthMm = static_cast<float>(W.water_depth_mm);
    Out.PuddleDepthMm = static_cast<float>(W.puddle_depth_mm);
    Out.Wetness01 = static_cast<float>(W.wetness_0_to_1);
    Out.TrackTempC = static_cast<float>(W.track_temp_c);
    Out.Rubber01 = static_cast<float>(W.rubber_0_to_1);
    Out.DryingLineFactor = static_cast<float>(W.drying_line_factor);
    Out.SurfaceMuMult = static_cast<float>(W.surface_mu_mult);
    Out.StaticShade01 = static_cast<float>(W.static_shade_0_to_1);
    Out.Ice01 = static_cast<float>(W.ice_0_to_1);
    Out.Mud01 = static_cast<float>(W.mud_0_to_1);
    Out.SprayGeneration01 = static_cast<float>(W.spray_generation_0_to_1);
    Out.bOnPaintedKerb = W.on_painted_kerb;
    return Out;
}

void UOpenGridWeatherSubsystem::DepositWheelWakeCm(const FVector& WorldLocationCm, float SpeedMps, float LoadN, float DeltaTime)
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    Weather_.deposit_tyre_wake(Xm, Ym, static_cast<double>(SpeedMps), static_cast<double>(LoadN), static_cast<double>(DeltaTime));
}

void UOpenGridWeatherSubsystem::DepositTyrePassageCm(const FVector& WorldLocationCm, float SpeedMps, float LoadN,
                                                     float SlipPowerW, float TreadEvacScale, float DeltaTime)
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    Weather_.deposit_tyre_passage(Xm, Ym, static_cast<double>(SpeedMps), static_cast<double>(LoadN),
                                  static_cast<double>(SlipPowerW), static_cast<double>(TreadEvacScale),
                                  static_cast<double>(DeltaTime));
}

void UOpenGridWeatherSubsystem::DepositCarSprayCm(const FVector& CarLocationCm, const FVector& CarVelocityCmS,
                                                  float AvgWaterMm, float DiffuserDownforceN, float DeltaTime)
{
    const rs::Vec3 Pos{static_cast<double>(CarLocationCm.X) * 0.01, -static_cast<double>(CarLocationCm.Y) * 0.01, static_cast<double>(CarLocationCm.Z) * 0.01};
    const rs::Vec3 Vel{static_cast<double>(CarVelocityCmS.X) * 0.01, -static_cast<double>(CarVelocityCmS.Y) * 0.01, static_cast<double>(CarVelocityCmS.Z) * 0.01};
    Weather_.deposit_car_spray(Pos, Vel, static_cast<double>(AvgWaterMm), static_cast<double>(DiffuserDownforceN), static_cast<double>(DeltaTime));
}

float UOpenGridWeatherSubsystem::SampleDriverVisibilityCm(const FVector& EyeLocationCm, const FVector& LookDirection) const
{
    const rs::Vec3 Eye{static_cast<double>(EyeLocationCm.X) * 0.01, -static_cast<double>(EyeLocationCm.Y) * 0.01, static_cast<double>(EyeLocationCm.Z) * 0.01};
    const rs::Vec3 Dir{static_cast<double>(LookDirection.X), -static_cast<double>(LookDirection.Y), static_cast<double>(LookDirection.Z)};
    return static_cast<float>(Weather_.sample_driver_visibility_m(Eye, Dir));
}

TArray<FOpenGridSprayPlume> UOpenGridWeatherSubsystem::GetActiveSprayPlumesCm() const
{
    TArray<FOpenGridSprayPlume> Out;
    for (const rs::SprayPlume& P : Weather_.spray_plumes())
    {
        if (!P.active) continue;
        FOpenGridSprayPlume S;
        S.LocationCm = FVector(static_cast<float>(P.pos_m.x * 100.0), static_cast<float>(-P.pos_m.y * 100.0), static_cast<float>(P.pos_m.z * 100.0));
        S.VelocityCmS = FVector(static_cast<float>(P.vel_mps.x * 100.0), static_cast<float>(-P.vel_mps.y * 100.0), static_cast<float>(P.vel_mps.z * 100.0));
        S.RadiusCm = static_cast<float>(P.radius_m * 100.0);
        S.Density01 = static_cast<float>(P.density_0_to_1);
        Out.Add(S);
    }
    return Out;
}

FOpenGridWeatherRadar UOpenGridWeatherSubsystem::SampleRadarGridCm(const FVector& WorldLocationCm, float RangeMeters) const
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    const rs::WeatherRadarGrid G = Weather_.sample_radar(Xm, Ym, static_cast<double>(RangeMeters));

    FOpenGridWeatherRadar Out;
    Out.GridSize = rs::WeatherRadarGrid::kSize;
    Out.RangeMeters = static_cast<float>(G.range_m);
    Out.RainMmPerHr.Append(G.rain_mm_hr.data(), static_cast<int32>(G.rain_mm_hr.size()));
    Out.CloudCover01.Append(G.cloud_cover.data(), static_cast<int32>(G.cloud_cover.size()));
    Out.RainChance15Min = static_cast<float>(G.rain_chance_15m);
    Out.RainChance30Min = static_cast<float>(G.rain_chance_30m);
    return Out;
}
