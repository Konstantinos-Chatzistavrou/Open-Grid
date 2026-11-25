// Apache-2.0 — Unreal Engine 5.8 World Subsystem for OpenGrid Tempest Dynamic Weather.
//
// Owns one deterministic rs::TempestWeather instance per UWorld and exposes:
//   - Blueprint / C++ weather presets, seeding & time-of-day control
//   - Live spatial weather sampling (rain, cloud cover, shadow, sun elevation/azimuth, air/track C, wind, puddles)
//   - Direct UE 5.8 rendering parameters (VolumetricCloud, DirectionalLight / SkyAtmosphere,
//     ExponentialHeightFog, Niagara precipitation/spray, and MPC_OpenGridTempest wet-asphalt material parameters)
//   - 16x16 Tempest Weather Radar grid & +15/+30 min upstream wind-advection forecast
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"

THIRD_PARTY_INCLUDES_START
#include "rs/tempest.hpp"
THIRD_PARTY_INCLUDES_END

#include "OpenGridTempestSubsystem.generated.h"

UENUM(BlueprintType)
enum class EOpenGridTempestPreset : uint8
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
struct OPENGRIDPHYSICS_API FOpenGridTempestSample
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float RainMmPerHr = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float CloudCover01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float CloudShadow01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float SunElevationDeg = 45.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float SunAzimuthDeg = 180.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float SolarIrradianceWm2 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float AmbientAirC = 22.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float TrackSurfaceC = 28.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float DewPointC = 12.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float Humidity01 = 0.50f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float BarometricKpa = 101.325f;

    /** World wind velocity in Unreal axes (cm/s; X=Forward/East, Y=Right/South, Z=Up). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    FVector WindVelocityCmS = FVector::ZeroVector;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float WindSpeedMps = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float SurfaceWaterMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float PuddleDepthMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float Wetness01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float DryingLineFactor = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float VisibilityM = 20000.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float FogDensity = 0.0001f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float SprayIntensity01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float LightningFlash01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float ThunderDelayS = -1.0f;
};

/** Compact 16x16 weather radar reflectivity snapshot for HUD widgets / cockpit displays. */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridTempestRadar
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    int32 GridSize = rs::TempestRadarGrid::kSize;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float RangeMeters = 8000.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    TArray<float> RainMmPerHr;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    TArray<float> CloudCover01;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float RainChance15Min = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Tempest")
    float RainChance30Min = 0.0f;
};

UCLASS()
class OPENGRIDPHYSICS_API UOpenGridTempestSubsystem : public UTickableWorldSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Tick(float DeltaTime) override;
    virtual TStatId GetStatId() const override;

    /** Configure Tempest weather preset, deterministic multiplayer seed, solar clock, latitude & wind. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Tempest")
    void ConfigureTempest(EOpenGridTempestPreset Preset, int32 Seed = 1337, float LocalHour = 14.0f,
                          float LatitudeDeg = 40.75f, int32 DayOfYear = 172, float TimeScale = 1.0f,
                          float BaseAmbientC = 22.0f, float BaseWindMps = 4.5f, float WindDirectionDeg = 245.0f);

    /** Sample full weather, solar, wind & 2D puddle hydrology state at an Unreal world location (cm). */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Tempest")
    FOpenGridTempestSample SampleAtLocationCm(const FVector& WorldLocationCm) const;

    /** Deposit a passing tyre's wake pumping at WorldLocationCm (carves a drying racing line in 2D hydrology). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Tempest")
    void DepositWheelWakeCm(const FVector& WorldLocationCm, float SpeedMps, float LoadN, float DeltaTime);

    /** Sample a 16x16 Tempest radar reflectivity grid centered on WorldLocationCm. */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Tempest")
    FOpenGridTempestRadar SampleRadarGridCm(const FVector& WorldLocationCm, float RangeMeters = 8000.0f) const;

    /** Direct C++ access to the underlying deterministic rs::TempestWeather core for UOpenGridVehicleComponent. */
    rs::TempestWeather& CoreTempest() { return Tempest_; }
    const rs::TempestWeather& CoreTempest() const { return Tempest_; }

private:
    rs::TempestWeather Tempest_;
};
