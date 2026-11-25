// Apache-2.0 — Unreal Engine 5.8 World Subsystem for OpenGrid Dynamic Weather Dynamic Weather.
//
// Owns one deterministic rs::WeatherSystem instance per UWorld and exposes:
//   - Blueprint / C++ weather presets, seeding & time-of-day control
//   - Live spatial weather sampling (rain, cloud cover, shadow, sun elevation/azimuth, air/track C, wind, puddles)
//   - Direct UE 5.8 rendering parameters (VolumetricCloud, DirectionalLight / SkyAtmosphere,
//     ExponentialHeightFog, Niagara precipitation/spray, and MPC_OpenGridDynamic Weather wet-asphalt material parameters)
//   - 16x16 Dynamic Weather Weather Radar grid & +15/+30 min upstream wind-advection forecast
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"

THIRD_PARTY_INCLUDES_START
#include "rs/weather.hpp"
THIRD_PARTY_INCLUDES_END

#include "OpenGridWeatherSubsystem.generated.h"

UENUM(BlueprintType)
enum class EOpenGridWeatherPreset : uint8
{
    Clear = 0,
    PartlyCloudy = 1,
    DynamicFront = 2,
    LightRain = 3,
    HeavyStorm = 4,
    DryingTrack = 5,
};

/** Spatial weather, atmosphere, wind, and hydrology state sampled at a UE 5.8 world location (Unreal cm / deg / C). */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridWeatherSample
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float RainMmPerHr = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float CloudCover01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float CloudShadow01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SunElevationDeg = 45.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SunAzimuthDeg = 180.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SolarIrradianceWm2 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float AmbientAirC = 22.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float TrackSurfaceC = 28.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float DewPointC = 12.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Humidity01 = 0.50f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float BarometricKpa = 101.325f;

    /** World wind velocity in Unreal axes (cm/s; X=Forward/East, Y=Right/South, Z=Up). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    FVector WindVelocityCmS = FVector::ZeroVector;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float WindSpeedMps = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SurfaceWaterMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float PuddleDepthMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Wetness01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float DryingLineFactor = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float VisibilityM = 20000.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float FogDensity = 0.0001f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SprayIntensity01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float LightningFlash01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float ThunderDelayS = -1.0f;
};

/** Compact 16x16 weather radar reflectivity snapshot for HUD widgets / cockpit displays. */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridWeatherRadar
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    int32 GridSize = rs::WeatherRadarGrid::kSize;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float RangeMeters = 8000.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    TArray<float> RainMmPerHr;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    TArray<float> CloudCover01;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float RainChance15Min = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float RainChance30Min = 0.0f;
};

UCLASS()
class OPENGRIDPHYSICS_API UOpenGridWeatherSubsystem : public UTickableWorldSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Tick(float DeltaTime) override;
    virtual TStatId GetStatId() const override;

    /** Configure Dynamic Weather weather preset, deterministic multiplayer seed, solar clock, latitude & wind. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void ConfigureWeather(EOpenGridWeatherPreset Preset, int32 Seed = 1337, float LocalHour = 14.0f,
                          float LatitudeDeg = 40.75f, int32 DayOfYear = 172, float TimeScale = 1.0f,
                          float BaseAmbientC = 22.0f, float BaseWindMps = 4.5f, float WindDirectionDeg = 245.0f);

    /** Sample full weather, solar, wind & 2D puddle hydrology state at an Unreal world location (cm). */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    FOpenGridWeatherSample SampleAtLocationCm(const FVector& WorldLocationCm) const;

    /** Deposit a passing tyre's wake pumping at WorldLocationCm (carves a drying racing line in 2D hydrology). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void DepositWheelWakeCm(const FVector& WorldLocationCm, float SpeedMps, float LoadN, float DeltaTime);

    /** Sample a 16x16 Dynamic Weather radar reflectivity grid centered on WorldLocationCm. */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    FOpenGridWeatherRadar SampleRadarGridCm(const FVector& WorldLocationCm, float RangeMeters = 8000.0f) const;

    /** Direct C++ access to the underlying deterministic rs::WeatherSystem core for UOpenGridVehicleComponent. */
    rs::WeatherSystem& CoreWeather() { return Weather_; }
    const rs::WeatherSystem& CoreWeather() const { return Weather_; }

private:
    rs::WeatherSystem Weather_;
};
