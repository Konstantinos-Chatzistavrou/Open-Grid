// Apache-2.0 — Unreal Engine 5.8 World Subsystem for OpenGrid Dynamic Weather v2.
//
// Owns one deterministic rs::WeatherSystem instance per UWorld and exposes:
//   - Blueprint / C++ weather presets, seeding, solar clock, latitude & frontal wind control
//   - Sub-meter curvilinear track geometry binding (elevation, banking, crown, static shadows, ideal racing line)
//   - Live spatial weather sampling + sub-meter per-wheel contact-patch sampling (asymmetric puddles,
//     rubber-line wet-grip inversion, ice-slick wet painted kerbs, per-wheel shaded asphalt temperature)
//   - Wind-advected volumetric car spray plumes & Beer-Lambert following-car visibility
//   - Direct UE 5.8 rendering parameters (VolumetricCloud, DirectionalLight / SkyAtmosphere,
//     ExponentialHeightFog, Niagara precipitation/spray plumes, and wet-asphalt MPC)
//   - 16x16 Weather Radar reflectivity grid & +15/+30 min upstream wind-advection forecast
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

UENUM(BlueprintType)
enum class EOpenGridWeatherSurfaceType : uint8
{
    Asphalt = 0,
    PaintedKerb = 1,
    Concrete = 2,
    PaintedLine = 3,
    Grass = 4,
    Gravel = 5,
};

UENUM(BlueprintType)
enum class EOpenGridClimateRegion : uint8
{
    NewYorkMidtown = 0,
    SpaArdennes = 1,
    NurburgringEifel = 2,
    SilverstoneUK = 3,
    BrandsHatchUK = 4,
    MonzaItaly = 5,
    SebringFlorida = 6,
    TokyoWangan = 7,
    LosAngelesCanyons = 8,
    SuzukaJapan = 9,
    LeMansFrance = 10,
    AthensGreece = 11,
    CustomLatLon = 12,
};

/** Real-world live meteorological observation (from Open-Meteo, NOAA, METAR or UE5 HTTP weather API). */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridRealWeatherObservation
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float LatitudeDeg = 40.75f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    int32 DayOfYear = 172;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float LocalHour = 14.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float AmbientAirC = 22.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float Humidity01 = 0.55f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float BarometricKpa = 101.325f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float WindSpeedMps = 4.5f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float WindDirectionDeg = 245.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float CloudCover01 = 0.35f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float RainMmPerHr = 0.0f;

    /** Optional +15 min forecast rain rate (mm/hr; < 0 if unavailable). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float ForecastRain15MinMmPerHr = -1.0f;

    /** Optional +30 min forecast rain rate (mm/hr; < 0 if unavailable). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float ForecastRain30MinMmPerHr = -1.0f;
};

/** One cross-section station along a UE 5.8 track spline for sub-meter 2D shallow-water hydrology & thermal memory. */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridTrackWeatherStation
{
    GENERATED_BODY()

    /** Centerline world location in Unreal cm (X forward/east, Y right/south, Z up). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    FVector CenterLocationCm = FVector::ZeroVector;

    /** Drivable track width between kerbs (cm). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float WidthCm = 1200.0f;

    /** Lateral cross-slope banking angle (deg; + = right edge higher, water drains left). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float BankingDeg = 0.0f;

    /** Parabolic road center crown height (cm; sheds water toward both edge gutters). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float CrownCm = 3.5f;

    /** Static sun occlusion (0 = open sky, 1 = bridge / grandstand / dense tree shade). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float StaticShade01 = 0.0f;

    /** 3D wind shadow occlusion (0 = exposed straight, 1 = behind grandstand / canyon wall / tunnel). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float WindShelter01 = 0.0f;

    /** Ideal racing line lateral offset from centerline (cm; + = right in UE axes). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float IdealOffsetRightCm = 0.0f;

    /** Pre-session rubber deposit along the ideal racing line (0 = green track .. 1 = heavy rubber). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float InitialRubber01 = 0.55f;

    /** Edge storm-drain efficiency multiplier (0.2 = slow-draining puddle zone, 1.5 = fast). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    float DrainRate = 1.0f;
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
    float TrackSubsurfaceC = 25.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    bool bDewCondensing = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Ice01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float WindShelter01 = 0.0f;

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
    float WindDirectionDeg = 245.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SurfaceWaterMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float PuddleDepthMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Wetness01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float DryingLineFactor = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Rubber01 = 0.0f;

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

/** Sub-meter per-wheel contact-patch hydrology, rubber-line wet-grip inversion & local shaded asphalt temperature. */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridWheelWeatherSample
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float WaterDepthMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float PuddleDepthMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Wetness01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float TrackTempC = 28.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Rubber01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float DryingLineFactor = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SurfaceMuMult = 1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float StaticShade01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Ice01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Mud01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SprayGeneration01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    bool bOnPaintedKerb = false;
};

/** One wind-advected volumetric trailing car spray plume for UE 5.8 Niagara / volumetric fog emitters. */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridSprayPlume
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    FVector LocationCm = FVector::ZeroVector;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    FVector VelocityCmS = FVector::ZeroVector;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float RadiusCm = 250.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float Density01 = 0.0f;
};

/** F1 / IMSA Pit-Wall Race Engineer tyre compound crossover advice. */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridWeatherStrategy
{
    GENERATED_BODY()

    /** 0 = Slick, 1 = Intermediate, 2 = Full Wet */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    int32 CurrentBestCompound = 0;

    /** 0 = Slick, 1 = Intermediate, 2 = Full Wet predicted in +15 min */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    int32 Forecast15MinBestCompound = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float CurrentWaterMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float PredictedWater15MinMm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float SlickLapDeltaS = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float InterLapDeltaS = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float WetLapDeltaS = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float CrossoverEtaS = -1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    bool bBoxNow = false;
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

    /** Configure weather preset, deterministic multiplayer seed, solar clock, latitude & synoptic wind. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void ConfigureWeather(EOpenGridWeatherPreset Preset, int32 Seed = 1337, float LocalHour = 14.0f,
                          float LatitudeDeg = 40.75f, int32 DayOfYear = 172, float TimeScale = 1.0f,
                          float BaseAmbientC = 22.0f, float BaseWindMps = 4.5f, float WindDirectionDeg = 245.0f);

    /** Deterministically synthesize weather from real-world NOAA/WMO climatology for a city/circuit, date & seed. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void ConfigureForClimateRegion(EOpenGridClimateRegion Region, int32 DayOfYear = 172, float LocalHour = 14.0f,
                                   int32 Seed = 1337, float TimeScale = 1.0f,
                                   float CustomLatitudeDeg = 40.75f, float CustomLongitudeDeg = -73.99f);

    /** Apply a live real-world meteorological observation (e.g., from Open-Meteo / NOAA / METAR HTTP JSON). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void ApplyLiveWeatherObservation(const FOpenGridRealWeatherObservation& Observation, int32 Seed = 1337,
                                     float TimeScale = 1.0f);

    /** Bind circuit/road spline stations to activate O(1) sub-meter curvilinear 2D shallow-water hydrology & thermal memory. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void BindTrackGeometryCm(const TArray<FOpenGridTrackWeatherStation>& Stations, bool bClosedLoop = true);

    /** Override per-cell elevation heightfield (size == StationCount * 16, values in UE cm) from laser-scanned / Landscape traces. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    bool BindTrackHeightfieldCm(const TArray<float>& CellElevationCm);

    /** Register a 3D wind-shadow box (grandstand, skyscraper, tunnel portal) for crosswind exit shear. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void AddWindShelterBoxCm(const FVector& CenterLocationCm, const FVector2D& HalfExtentCm, float Shelter01 = 0.85f);

    /** Evaluate F1 / IMSA pit-wall compound crossover strategy (0=Slick, 1=Inter, 2=FullWet). */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    FOpenGridWeatherStrategy EvaluatePitStrategyCm(const FVector& WorldLocationCm, float DryLapTimeS = 90.0f,
                                                   int32 MountedCompound = 0) const;

    /** Clear bound circuit spline and fall back to the 1.0 m toroidal open-world hydrology patch. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void ClearTrackGeometry();

    /** Sample full weather, solar, wind & hydrology state at an Unreal world location (cm). */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    FOpenGridWeatherSample SampleAtLocationCm(const FVector& WorldLocationCm) const;

    /** Sample sub-meter per-wheel water depth, rubber-line wet inversion, wet kerb slip & shaded asphalt temp. */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    FOpenGridWheelWeatherSample SampleWheelAtLocationCm(const FVector& WorldLocationCm,
                                                        EOpenGridWeatherSurfaceType SurfaceType = EOpenGridWeatherSurfaceType::Asphalt) const;

    /** Deposit a passing tyre's wake pumping at WorldLocationCm (legacy road-tyre signature). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void DepositWheelWakeCm(const FVector& WorldLocationCm, float SpeedMps, float LoadN, float DeltaTime);

    /** Deposit full tyre passage (water pumping scaled by tread evacuation, lateral splash, rubber deposit & asphalt heat). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void DepositTyrePassageCm(const FVector& WorldLocationCm, float SpeedMps, float LoadN,
                              float SlipPowerW, float TreadEvacScale, float DeltaTime);

    /** Emit a wind-advected volumetric trailing spray plume behind a car moving over standing water. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Weather")
    void DepositCarSprayCm(const FVector& CarLocationCm, const FVector& CarVelocityCmS,
                           float AvgWaterMm, float DiffuserDownforceN, float DeltaTime);

    /** Sample driver forward visibility (m) through rain, fog AND downstream car spray plumes. */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    float SampleDriverVisibilityCm(const FVector& EyeLocationCm, const FVector& LookDirection) const;

    /** Return all active wind-advected trailing spray plumes (for UE 5.8 Niagara volumetric spray emitters). */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    TArray<FOpenGridSprayPlume> GetActiveSprayPlumesCm() const;

    /** Sample a 16x16 weather radar reflectivity grid centered on WorldLocationCm. */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category="OpenGrid|Weather")
    FOpenGridWeatherRadar SampleRadarGridCm(const FVector& WorldLocationCm, float RangeMeters = 8000.0f) const;

    /** Direct C++ access to the underlying deterministic rs::WeatherSystem core for UOpenGridVehicleComponent. */
    rs::WeatherSystem& CoreWeather() { return Weather_; }
    const rs::WeatherSystem& CoreWeather() const { return Weather_; }

private:
    rs::WeatherSystem Weather_;
};
