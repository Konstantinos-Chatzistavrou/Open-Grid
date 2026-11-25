// Apache-2.0 — Unreal Engine 5.8 World Subsystem implementation for OpenGrid Tempest.
#include "OpenGridTempestSubsystem.h"

void UOpenGridTempestSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
    rs::TempestConfig Cfg;
    Cfg.preset = rs::TempestPreset::DynamicFront;
    Tempest_.configure(Cfg);
}

void UOpenGridTempestSubsystem::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);
    if (DeltaTime > 0.0f)
    {
        Tempest_.step(static_cast<double>(FMath::Clamp(DeltaTime, 0.0f, 0.25f)));
    }
}

TStatId UOpenGridTempestSubsystem::GetStatId() const
{
    RETURN_QUICK_DECLARE_CYCLE_STAT(UOpenGridTempestSubsystem, STATGROUP_Tickables);
}

void UOpenGridTempestSubsystem::ConfigureTempest(EOpenGridTempestPreset Preset, int32 Seed, float LocalHour,
                                                 float LatitudeDeg, int32 DayOfYear, float TimeScale,
                                                 float BaseAmbientC, float BaseWindMps, float WindDirectionDeg)
{
    rs::TempestConfig Cfg;
    Cfg.preset = static_cast<rs::TempestPreset>(static_cast<int>(Preset));
    Cfg.seed = static_cast<std::uint32_t>(Seed > 0 ? Seed : 1337);
    Cfg.start_hour_local = static_cast<double>(LocalHour);
    Cfg.latitude_deg = static_cast<double>(LatitudeDeg);
    Cfg.day_of_year = FMath::Clamp(DayOfYear, 1, 365);
    Cfg.time_scale = static_cast<double>(FMath::Max(0.0f, TimeScale));
    Cfg.base_ambient_c = static_cast<double>(BaseAmbientC);
    Cfg.base_wind_mps = static_cast<double>(FMath::Max(0.0f, BaseWindMps));
    Cfg.wind_direction_deg = static_cast<double>(WindDirectionDeg);
    Tempest_.configure(Cfg);
}

FOpenGridTempestSample UOpenGridTempestSubsystem::SampleAtLocationCm(const FVector& WorldLocationCm) const
{
    // Unreal cm (left-handed: X fwd, Y right, Z up) -> rs_core m (right-handed: X fwd, Y left, Z up)
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    const rs::TempestSample S = Tempest_.sample(Xm, Ym);

    FOpenGridTempestSample Out;
    Out.RainMmPerHr = static_cast<float>(S.rain_mm_per_hr);
    Out.CloudCover01 = static_cast<float>(S.cloud_cover_0_to_1);
    Out.CloudShadow01 = static_cast<float>(S.cloud_shadow_0_to_1);
    Out.SunElevationDeg = static_cast<float>(S.sun_elevation_deg);
    Out.SunAzimuthDeg = static_cast<float>(S.sun_azimuth_deg);
    Out.SolarIrradianceWm2 = static_cast<float>(S.solar_irradiance_w_m2);
    Out.AmbientAirC = static_cast<float>(S.ambient_air_c);
    Out.TrackSurfaceC = static_cast<float>(S.track_surface_c);
    Out.DewPointC = static_cast<float>(S.dew_point_c);
    Out.Humidity01 = static_cast<float>(S.humidity_0_to_1);
    Out.BarometricKpa = static_cast<float>(S.barometric_kpa);
    Out.WindVelocityCmS = FVector(
        static_cast<float>(S.wind_world_mps.x * 100.0),
        static_cast<float>(-S.wind_world_mps.y * 100.0),
        static_cast<float>(S.wind_world_mps.z * 100.0));
    Out.WindSpeedMps = static_cast<float>(S.wind_speed_mps);
    Out.SurfaceWaterMm = static_cast<float>(S.surface_water_mm);
    Out.PuddleDepthMm = static_cast<float>(S.puddle_depth_mm);
    Out.Wetness01 = static_cast<float>(S.wetness_0_to_1);
    Out.DryingLineFactor = static_cast<float>(S.drying_line_factor);
    Out.VisibilityM = static_cast<float>(S.visibility_m);
    Out.FogDensity = static_cast<float>(S.fog_density);
    Out.SprayIntensity01 = static_cast<float>(S.spray_intensity_0_to_1);
    Out.LightningFlash01 = static_cast<float>(S.lightning_flash_0_to_1);
    Out.ThunderDelayS = static_cast<float>(S.thunder_delay_s);
    return Out;
}

void UOpenGridTempestSubsystem::DepositWheelWakeCm(const FVector& WorldLocationCm, float SpeedMps, float LoadN, float DeltaTime)
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    Tempest_.deposit_tyre_wake(Xm, Ym, static_cast<double>(SpeedMps), static_cast<double>(LoadN), static_cast<double>(DeltaTime));
}

FOpenGridTempestRadar UOpenGridTempestSubsystem::SampleRadarGridCm(const FVector& WorldLocationCm, float RangeMeters) const
{
    const double Xm = static_cast<double>(WorldLocationCm.X) * 0.01;
    const double Ym = -static_cast<double>(WorldLocationCm.Y) * 0.01;
    const rs::TempestRadarGrid G = Tempest_.sample_radar(Xm, Ym, static_cast<double>(RangeMeters));

    FOpenGridTempestRadar Out;
    Out.GridSize = rs::TempestRadarGrid::kSize;
    Out.RangeMeters = static_cast<float>(G.range_m);
    Out.RainMmPerHr.Append(G.rain_mm_hr.data(), static_cast<int32>(G.rain_mm_hr.size()));
    Out.CloudCover01.Append(G.cloud_cover.data(), static_cast<int32>(G.cloud_cover.size()));
    Out.RainChance15Min = static_cast<float>(G.rain_chance_15m);
    Out.RainChance30Min = static_cast<float>(G.rain_chance_30m);
    return Out;
}
