// Apache-2.0 — OpenGrid Unreal Engine 5 UActorComponent wrapper for rs_core.
//
// Put this on an actor whose ROOT is a simulating UPrimitiveComponent with its centre of mass at the root's origin
// (the core's chassis origin is the CG). Each physics step the component reads the body's state, builds the wheel rays
// in the core, finds the ground under each ray, steps rs::Vehicle and applies the resulting force and torque at the CG.
//
// Two stepping paths:
//   - Async physics tick (default, needs Project Settings > Physics > "Tick Physics Async" at 400 Hz / 0.0025 s):
//     the core runs once per fixed physics step on the physics thread with fresh body state. Line traces stay on the game
//     thread: every frame the component traces the latest rays and caches the ground plane under each one; the physics
//     thread intersects its fresh rays with those planes. That keeps suspension compression exact between frames without
//     physics-thread scene queries.
//   - Frame tick (fallback when async physics is off): one trace + one step per rendered frame, dt capped at 1/30 s.
//     Handling then depends on frame rate; use it only to get something on screen.
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"

THIRD_PARTY_INCLUDES_START
#include "rs/config.hpp"
#include "rs/controls.hpp"
#include "rs/vehicle.hpp"
#include "rs/telemetry.hpp"
#include "rs/pinnacle.hpp"
#include "rs/esports.hpp"
#include "rs/ue5_bridge.hpp"
THIRD_PARTY_INCLUDES_END

#include <array>
#include <atomic>

#include "OpenGridVehicleComponent.generated.h"

class UPhysicalMaterial;
class UPrimitiveComponent;

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnBlowOffValveVent, float, BoostBarReleased);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridMissedShift, int32, TotalMissedShifts, float, SimTimeSeconds);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridGearGrind, int32, AttemptedGear);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridBackfire, float, Intensity);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridScrape, float, ImpactEnergyKj);

/**
 * Per-wheel kinematic, thermal, acoustic, and interpolated visual pose state exposed to UE 5.8 Blueprints,
 * AnimInstances, MetaSounds, and Niagara systems.
 */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridWheelState
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    bool bInContact = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    FVector WorldCenterCm = FVector::ZeroVector;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    FVector ContactPointWorldCm = FVector::ZeroVector;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SteerAngleRad = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SteerAngleDeg = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float CamberAngleDeg = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SpinAngleRad = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float AngularVelocityRadS = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float NormalLoadN = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SuspensionCompressionCm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SlipRatio = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SlipAngleDeg = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SurfaceTempC = 80.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float CarcassTempC = 80.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float PressureKpa = 220.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float BrakeDiscTempC = 45.0f;

    /** Dynamic toe-in angle (deg, w.toe_angle * 180 / pi): static toe + bump steer + damage. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float ToeAngleDeg = 0.0f;

    /** Instantaneous 3D steering-axis caster angle (deg, w.caster_angle * 180 / pi). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float CasterAngleDeg = 0.0f;

    /** Instantaneous 3D kingpin inclination angle (deg, w.kpi_angle * 180 / pi). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float KpiAngleDeg = 0.0f;

    /** Instantaneous kingpin scrub radius at the road plane (cm, w.scrub_radius_m * 100). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float ScrubRadiusCm = 0.0f;

    /** Wheel-to-shock kinematic motion ratio |dL_shock / dz| (w.motion_ratio). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float MotionRatio = 1.0f;

    /** 3-node tyre thermal network Node 3 enclosed cavity inner air temperature (C, w.condition.inner_air_c). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float InnerAirTempC = 53.0f;

    /** WLF micro-asperity flash temperature (~8 ms response, C, w.condition.flash_c). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float FlashTempC = 80.0f;

    /** Local tread flat-spot depth ground during locked-wheel skids (mm, w.condition.flat_spot_depth_mm). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float FlatSpotDepthMm = 0.0f;

    /** Simcenter 2606 ~225 Hz toroidal tire cavity resonance excitation gain (0..1). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float CavityRingGain = 0.0f;

    /** Lateral sidewall tuck-under / shoulder rollover index (0..1, w.sidewall_rollover). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SidewallRollover = 0.0f;

    /** Structural sidewall / bead damage from violent kerb/rim pinch strikes (0..1, w.sidewall_damage). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float SidewallDamage = 0.0f;

    /** Rim-flange bottoming vertical impact force on sharp kerbs / potholes (N, w.rim_strike_force_n). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float RimStrikeForceN = 0.0f;

    /** Viscoelastic carcass flexing heat dissipation from the 24-node flexible ring (W, w.carcass_hysteresis_w). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    float CarcassHysteresisW = 0.0f;
};

/**
 * 6 directional crash morph-target weights (0..1) for driving GPU morph targets on AOpenGridCarPawn.
 */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridCrushMorphWeights
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    float crush_front = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    float crush_rear = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    float crush_left = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    float crush_right = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    float crush_top = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    float crush_hood = 0.0f;
};

/**
 * The parts of data/cars/<car>.visual.json a renderer needs, in Unreal axes (X forward, Y right, Z up, cm).
 * Model space in those files is glTF's: +X left, +Y up, +Z forward, origin on the ground at the body's length centre.
 */
USTRUCT(BlueprintType)
struct OPENGRIDPHYSICS_API FOpenGridVisualSpec
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid")
    bool bValid = false;

    /** The web model this car uses (res://assets/cars/...): the GLB to export for Unreal. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid")
    FString ModelPath;

    /** Centre of gravity measured from the model's origin. The body mesh goes at minus this, relative to the CG. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid")
    FVector CgInModelCm = FVector::ZeroVector;

    /** Collision box half size. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid")
    FVector CollisionBoxExtentCm = FVector(210.0, 88.0, 25.0);

    /** Collision box centre measured from the model's origin. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid")
    FVector CollisionBoxCentreInModelCm = FVector::ZeroVector;

    /** Wheel node names in the model, FL FR RL RR. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid")
    TArray<FString> WheelNodes;
};

UENUM(BlueprintType)
enum class EOpenGridInputDevice : uint8
{
    Keyboard = 0,
    Gamepad = 1,
    Wheel = 2,
};

UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRIDPHYSICS_API UOpenGridVehicleComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UOpenGridVehicleComponent();

    // ---- Car --------------------------------------------------------------------------------------------------------

    /**
     * Car spec relative to a data folder, e.g. "cars/kestrel_gt.json". Looked up in this order:
     *   1. <Project>/Content/OpenGridData/<path>   (what a packaged game uses)
     *   2. <Project>/../data/<path>                (the repo's data/ folder when the project is ue5/ inside the repo)
     *   3. <Project>/data/<path>
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Config")
    FString CarConfigRelativePath = TEXT("cars/vela_gt.json");

    /** True once the car spec loaded; false with LoadError set if it did not (the component then does nothing). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Config")
    bool bCarLoaded = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Config")
    FString LoadError;

    /** From the matching <car>.visual.json next to the car spec (bValid false if there is none). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Config")
    FOpenGridVisualSpec VisualSpec;

    /** Static ride height of the CG above the ground from the car spec (cm). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Config")
    float CgHeightCm = 47.0f;


    /** Set the car's mass and inertia on the root body from the car spec, and keep the mass current as fuel burns. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Config")
    bool bApplyMassFromSpec = true;

    // ---- Stepping ---------------------------------------------------------------------------------------------------

    /** Step the core on the fixed-rate physics thread (needs "Tick Physics Async" in Project Settings > Physics). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Stepping")
    bool bUseAsyncPhysicsTick = true;

    /** Which path is actually running (async needs the project setting; otherwise the frame-tick fallback). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Stepping")
    bool bAsyncPhysicsActive = false;

    /** Trace channel used for the wheel rays. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Stepping")
    TEnumAsByte<ECollisionChannel> WheelTraceChannel = ECC_Visibility;

    // ---- Tyre contact -----------------------------------------------------------------------------------------------

    /** 16-point tyre footprint per wheel (5 x 3 ribs + leading apex). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension")
    bool bUse16PointTireFootprint = false;

    /** 3-ray circular-arc contact patch per wheel (what the web build uses) when the 16-point footprint is off. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension")
    bool bUseThreeRayContactPatch = true;

    /**
     * Physical material -> surface name in the car spec's "surface_grip" (asphalt, kerb, pavement, grass, wall).
     * Materials not listed here match by name: a physical material called e.g. "PM_Grass" counts as "grass".
     * Anything unmatched is asphalt.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension")
    TMap<TObjectPtr<UPhysicalMaterial>, FName> SurfaceByPhysicalMaterial;

    /**
     * Kerbs between rendered frames (async stepping only). Each frame, trace a strip of ground samples under each
     * wheel along its path until the next frame; every physics step reads the ground from it. Kerb edges then resolve
     * at GroundStripSpacingCm whatever the frame rate. Off = one plane per ray per frame (kerbs smear at speed).
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension")
    bool bUseGroundStrip = true;

    /** Distance between strip samples along the path (cm). Smaller = sharper kerbs, more traces. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension", meta=(ClampMin="1.0", ClampMax="50.0"))
    float GroundStripSpacingCm = 5.0f;

    /** Lines of samples across each tyre's tread. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension", meta=(ClampMin="1", ClampMax="5"))
    int32 GroundStripLanes = 3;

    /** Cap on samples per lane per frame (at very high speed or low fps the spacing grows instead). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension", meta=(ClampMin="4", ClampMax="256"))
    int32 GroundStripMaxSamples = 64;

    /** Ground traces this component made last frame (strip + per-ray planes): measure the cost in session one. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Suspension")
    int32 GroundTracesLastFrame = 0;

    // ---- Atmosphere -------------------------------------------------------------------------------------------------

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float AltitudeMeters = 10.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float AmbientAirCelsius = 18.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float TrackSurfaceCelsius = 22.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float RelativeHumidity = 0.45f;

    // ---- Dynamic City-Street Surface & Urban Micro-Roughness --------------------------------------------------------

    /** Enable live rubber laydown, off-line marbles/grit, rain wake drying & 2% crown gutter drainage. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|StreetSurface")
    bool bEnableDynamicStreetSurface = true;

    /** Enable procedural ISO 8608 urban roughness, wet cast-iron manholes & thermoplastic crosswalk stripes. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|StreetSurface")
    bool bEnableUrbanMicroRoughness = true;

    /** ISO 8608 urban road class (0 = Highway, 1 = CityAvenue, 2 = WornStreet, 3 = BrokenCobble). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|StreetSurface", meta=(ClampMin="0", ClampMax="3"))
    int32 UrbanRoadClass = 1;

    /** Live rainfall rate (mm/hr) feeding the dynamic street surface evolution grid. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|StreetSurface", meta=(ClampMin="0.0", ClampMax="80.0"))
    float RainRateMmPerHr = 0.0f;

    /** Ambient standing water film depth on the street (mm; 0 = dry, ~0.1 = damp, ~1.0+ = heavy rain). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|StreetSurface", meta=(ClampMin="0.0", ClampMax="12.0"))
    float RoadWaterMm = 0.0f;

    /** Automatically sync atmosphere, wind, per-wheel puddles, wet-line inversion, tyre wake & spray plumes with UOpenGridWeatherSubsystem. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Weather")
    bool bAutoSyncWorldWeather = true;

    // ---- Drivetrain and assists -------------------------------------------------------------------------------------

    /** Turbocharger stage (0 = naturally aspirated, 1 = 0.7 bar, 2 = 1.15 bar, 3 = 1.65 bar). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Drivetrain")
    int32 TurboStage = 0;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Assists")
    bool bAbs = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Assists")
    bool bTractionControl = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Assists")
    bool bStabilityControl = true;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Assists")
    bool bAutoGearbox = true;

    // ---- Telemetry --------------------------------------------------------------------------------------------------

    /** Stream Forza Dash V2 UDP packets to 127.0.0.1:20777 for SimHub / motion rigs. Off unless you use SimHub. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Telemetry")
    bool bEnableSimHubUdp = false;

    // ---- Driver input -----------------------------------------------------------------------------------------------
    //
    // With bUseCoreControls (default) these are RAW device values and the core's rs::Controls shapes them exactly as
    // in the web build (keyboard ramps, speed-sensitive steering, auto gearbox, pedal reverse). Without it they go to
    // the vehicle unchanged.

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Input")
    bool bUseCoreControls = true;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    EOpenGridInputDevice InputDevice = EOpenGridInputDevice::Keyboard;

    /** -1 = full right .. +1 = full left (the core's convention). */
    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float SteerInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float ThrottleInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float BrakeInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float ClutchInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float HandbrakeInput = 0.0f;

    /** Used only without bUseCoreControls: 0 = reverse, 1 = neutral, 2 = 1st ... */
    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    int32 GearIndex = 2;

    /** Used only without bUseCoreControls. */
    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    bool bAutoClutch = true;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    bool bNitrousActive = false;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    bool bStarterCrank = false;

    /** Gear up / down as one-shot events (paddles, Q/E). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Input")
    void ShiftUp();

    UFUNCTION(BlueprintCallable, Category="OpenGrid|Input")
    void ShiftDown();

    /** Repair key, as in the web build: fixes damage, refuels, restores the engine (rs::Vehicle::service). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    void RepairAndService();

    // ---- Live outputs (HUD, audio, visuals) -------------------------------------------------------------------------

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float SpeedKmh = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float EngineRpm = 900.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    int32 CurrentGear = 2;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float BoostBar = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bBovVenting = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float NosRemainingLiters = 4.5f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float OilTempC = 85.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float EngineHealth = 1.0f;

    /** Live driver forward visibility (m) through rain, fog and trailing car spray plumes from UOpenGridWeatherSubsystem. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Weather")
    float DriverVisibilityMeters = 20000.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float SteerTorqueNm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float IntakeAirTempC = 28.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float FuelLiters = 55.0f;

    /** Current total mass (spec mass is with a full tank; burnt fuel comes off). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float MassKg = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bGearGrind = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bMissedShiftEvent = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float RollCentreFrontCm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float RollCentreRearCm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float ClutchTempC = 40.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float ClutchHealth = 1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float GearboxHealth = 1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    int32 MissedShifts = 0;

    /** Primary exhaust firing pulse frequency (Hz, EngineRpm * 6.0 / 120.0). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float ExhaustPrimaryHz = 0.0f;

    /** Engaged gear tooth-mesh whine frequency (Hz, computed from wheel/engine speed and engaged gear ratio). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float GearWhineHz = 0.0f;

    /** Cumulative missed-shift notification counter and timestamp (s) for HUD / audio triggers. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    int32 OnMissedShiftCount = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float LastMissedShiftTime = -1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bBackfireActive = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bScrapeActive = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bShiftCutActive = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float DrivelineClunkNm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float ChassisTwistDeg = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float AycYawMomentNm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bDrsActive = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bAirbrakeActive = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bFrontSplitterStalled = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bDiffuserStalled = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float FrontRideHeightCm = 11.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float RearRideHeightCm = 12.5f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float AeroBalanceFront = 0.45f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float StreetRubberAtCar = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float StreetMarblesAtCar = 0.0f;

    /** Driver steering-wheel rim torque (N m) after hydraulic/EPS power steering, rack friction & column damping. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float SteeringColumnTorqueNm = 0.0f;

    /** Hydraulic / EPS power-steering assist torque applied at the rack (N m). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float SteeringAssistTorqueNm = 0.0f;

    /** Active speed-sensitive power-steering boost share (0 = unassisted .. 0.92). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float PowerSteeringGain = 0.0f;

    /** Hydraulic torque converter turbine/pump speed ratio SR (0 at stall .. 1.0 locked). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float TorqueConverterSlipRatio = 1.0f;

    /** Hydraulic torque converter torque multiplication ratio TR(SR) (up to ~2.15 at stall). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float TorqueConverterTorqueRatio = 1.0f;

    /** True when the automatic transmission's TCC mechanical lock-up clutch is engaged. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bTorqueConverterLocked = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float AirDensityKgPerM3 = 1.225f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float BrakeVaporLockSponge = 0.0f;

    /** Per-wheel kinematic, thermal, acoustic, and interpolated pose state (FL=0, FR=1, RL=2, RR=3). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    TArray<FOpenGridWheelState> WheelStates;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Wheels")
    FOpenGridWheelState GetWheelState(int32 WheelIndex) const;

    /** Wheel visuals, FL FR RL RR: centre in world space (cm), steer angle (rad, + = left), spin angle (rad). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    TArray<FVector> WheelCentresWorld;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    TArray<float> WheelSteerRad;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    TArray<float> WheelSpinRad;

    /** Tyre radius per wheel from the car spec (cm). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    TArray<float> WheelRadiusCm;

    /** Tyre width per wheel from the car spec (cm). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Wheels")
    TArray<float> WheelWidthCm;

    /** Performance Index (100..999) and predicted benchmark lap time (s). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Esports")
    int32 PerformanceIndex = 500;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Esports")
    float VirtualBenchmarkLapSeconds = 70.0f;

    /** Balance of Performance: ballast and restrictor to bring this car to TargetPi (100..999). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Esports")
    void ApplyBopEqualizer(int32 TargetPi);

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Acoustics")
    float FundamentalFiringHz = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Acoustics")
    float TurboImpellerRpm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Acoustics")
    float TurboWhistleHz = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Acoustics")
    float TransmissionWhineHz = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Acoustics")
    float OverrunPopIntensity = 0.0f;

    /** 4 directional zone crush levels (0..1): Front=0, Rear=1, Left=2, Right=3. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    TArray<float> ZoneDamage;

    /** 6 normalized directional crash morph-target weights (crush_front..crush_hood in 0..1). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    FOpenGridCrushMorphWeights CrushMorphWeights;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage")
    TArray<float> GetZoneDamage() const { return ZoneDamage; }

    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage")
    FOpenGridCrushMorphWeights GetCrushMorphWeights() const { return CrushMorphWeights; }

    /** 8 crush nodes (0..1) for morph targets: FL, FrontCentre, FR, Left, Right, RL, RearCentre, RR. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    TArray<float> CrushNodeWeights;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bHoodUnlatched = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bTrunkUnlatched = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bFrontBumperDetached = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bRearBumperDetached = false;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Audio")
    FOnBlowOffValveVent OnBlowOffValveVent;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Audio")
    FOnOpenGridMissedShift OnMissedShift;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Audio")
    FOnOpenGridGearGrind OnGearGrind;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Audio")
    FOnOpenGridBackfire OnBackfire;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Audio")
    FOnOpenGridScrape OnScrape;

    /** Write the recorded lap telemetry as MoTeC i2 Pro files (.ld + .ldx). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Telemetry")
    bool ExportMotecLog(const FString& OutputBasePath);

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;
    virtual void AsyncPhysicsTickComponent(float DeltaTime, float SimTime) override;

private:
    static constexpr int32 MaxRaysPerWheel = rs::ue5::kMaxRaysPerWheel;

    bool LoadCar();
    /** Load the car spec as early as possible (the owner may need VisualSpec in its own BeginPlay). Idempotent. */
    bool EnsureCarLoaded();
    bool FindDataFile(const FString& Rel, FString& OutFull) const;
    void LoadVisualSpec();
    bool bLoadAttempted_ = false;
    bool bLoadOk_ = false;

public:
    /** Load the car spec now (normally done in BeginPlay); lets the owning actor read VisualSpec early. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Config")
    bool PreloadCarSpec() { return EnsureCarLoaded(); }

    /** Native C++ accessors for sibling UE5 components (e.g., UOpenGridAudioComponent). */
    const rs::CarConfig& GetCarConfig() const { return Config_; }
    const rs::VehicleOutput& GetLastVehicleOutput() const { return LastRecord_.out; }

private:
    void CreateVehicle();
    void ApplyFeatureFlags();
    void QuiesceAsyncPhysics();
    void ApplyMass(UPrimitiveComponent* Body, double MassKg);
    int32 RaysPerWheel() const;
    int32 SurfaceFromPhysicalMaterial(UPhysicalMaterial* Material) const;

    /** Game thread: trace Rays and store the ground plane under each in OutGround. */
    void TraceGround(const std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4>& Rays, int32 PerWheel,
                     std::array<std::array<rs::ue5::GroundSample, MaxRaysPerWheel>, 4>& OutGround) const;
    /** Game thread: trace a ground strip under each wheel along its path until the next frame. Returns traces made. */
    int32 TraceGroundStrips(UPrimitiveComponent* Body, float FrameDt,
                            const std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4>& Rays, int32 PerWheel,
                            std::array<rs::ue5::GroundStrip, 4>& OutStrips) const;
    void PublishOutputs(const rs::VehicleOutput& Out, const std::array<double, 4>& Spin,
                        const rs::ChassisState* RenderChassis = nullptr);
    static rs::ChassisState ChassisFromUe(const FVector& PosCm, const FQuat& Rot, const FVector& VelCms, const FVector& OmegaRad);

    UFUNCTION()
    void HandleBodyHit(UPrimitiveComponent* HitComponent, AActor* OtherActor, UPrimitiveComponent* OtherComp,
                       FVector NormalImpulse, const FHitResult& Hit);

    // Lock-free cross-thread bridge: SPSC rings (commands, impacts, step records) + wait-free triple buffers
    // (rays physics -> game, ground planes + strips game -> physics). Zero mutexes on the hot async path.
    rs::CarConfig Config_;
    TUniquePtr<rs::Vehicle> Vehicle_;
    TUniquePtr<rs::Controls> Controls_;
    TUniquePtr<rs::ue5::AsyncVehicleBridge> Bridge_;

    // Atomic lifecycle gate for BeginPlay / EndPlay / ApplyBopEqualizer (never locks during normal stepping).
    std::atomic<bool> bAsyncRun_{false};
    std::atomic<bool> bInAsyncStep_{false};
    UPrimitiveComponent* BodyRaw_ = nullptr;   // the owner's root; it outlives this component's play session

    // Game thread only.
    TWeakObjectPtr<UPrimitiveComponent> Body_;
    double AppliedMassKg_ = 0.0;
    bool bShiftUpRequested_ = false;
    bool bShiftDownRequested_ = false;
    bool bRepairRequested_ = false;
    rs::rt::StepRecord PrevRecord_{};
    rs::rt::StepRecord LastRecord_{};
    bool bHavePrevRecord_ = false;
    bool bHaveRecord_ = false;
    rs::UdpTelemetrySender UdpSender_;
    rs::MotecLogger MotecLogger_;
    double ElapsedTimeS_ = 0.0;
    bool bPrevBov_ = false;
    bool bPrevGearGrind_ = false;
    bool bPrevMissedShiftEvent_ = false;
    bool bPrevBackfire_ = false;
    bool bPrevScrape_ = false;
    int32 PrevMissedShifts_ = 0;
    double PrevDamageEnergyKj_ = 0.0;
};
