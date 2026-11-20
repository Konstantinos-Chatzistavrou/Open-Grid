// Apache-2.0 — OpenGrid Unreal Engine 5 UActorComponent wrapper for rs_core.
//
// Put this on an actor whose ROOT is a simulating UPrimitiveComponent with its centre of mass at the root's origin
// (the core's chassis origin is the CG). Each physics step the component reads the body's state, builds the wheel rays
// in the core, finds the ground under each ray, steps rs::Vehicle and applies the resulting force and torque at the CG.
//
// Two stepping paths:
//   - Async physics tick (default, needs Project Settings > Physics > "Tick Physics Async"): the core runs once per
//     fixed physics step on the physics thread with fresh body state. Line traces stay on the game thread: every frame
//     the component traces the latest rays and caches the ground plane under each one; the physics thread intersects
//     its fresh rays with those planes. That keeps suspension compression exact between frames without physics-thread
//     scene queries.
//   - Frame tick (fallback when async physics is off): one trace + one step per rendered frame, dt capped at 1/30 s.
//     Handling then depends on frame rate; use it only to get something on screen.
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "HAL/CriticalSection.h"

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


    /** Set the car's mass and inertia on the root body from the car spec at BeginPlay. */
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

    // ---- Atmosphere -------------------------------------------------------------------------------------------------

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float AltitudeMeters = 10.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float AmbientAirCelsius = 18.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float TrackSurfaceCelsius = 22.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Atmosphere")
    float RelativeHumidity = 0.45f;

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

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float SteerTorqueNm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float IntakeAirTempC = 28.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float FuelLiters = 55.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bGearGrind = false;

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
    float AirDensityKgPerM3 = 1.225f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float BrakeVaporLockSponge = 0.0f;

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

    /** Write the recorded lap telemetry as MoTeC i2 Pro files (.ld + .ldx). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Telemetry")
    bool ExportMotecLog(const FString& OutputBasePath);

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;
    virtual void AsyncPhysicsTickComponent(float DeltaTime, float SimTime) override;

private:
    static constexpr int32 MaxRaysPerWheel = 16;

    struct FGroundSample
    {
        bool bHit = false;
        rs::Vec3 Point;          // core space (m)
        rs::Vec3 Normal{0, 0, 1};
        int32 Surface = 0;
    };

    struct FPendingInput
    {
        bool bCoreControls = true;
        rs::RawInput Raw;        // with core controls
        rs::DriverInput Direct;  // without
        bool bShiftUp = false;   // one-shot: consumed by the next step
        bool bShiftDown = false;
        int32 RaysPerWheel = 3;
    };

    struct FPendingImpact
    {
        FVector PointUe;
        double ImpulseNs = 0.0;
        uint64 OtherId = 0;
    };

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

private:
    void CreateVehicleLocked();
    void ApplyFeatureFlagsLocked();
    void ApplyMassFromSpec(UPrimitiveComponent* Body) const;
    int32 RaysPerWheel() const;
    int32 SurfaceFromPhysicalMaterial(UPhysicalMaterial* Material) const;

    /** Rays for this chassis state into Rays_ (caller holds Lock_). */
    void BuildRaysLocked(const rs::ChassisState& Chassis);
    /** Game thread: trace Rays_ (copied under lock) and store the ground under each in Ground_. */
    void TraceGround(const std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4>& Rays, int32 PerWheel,
                     std::array<std::array<FGroundSample, MaxRaysPerWheel>, 4>& OutGround) const;
    /** Contacts for the current Rays_ against Ground_ (caller holds Lock_). */
    std::array<rs::WheelContact, 4> ResolveContactsLocked() const;
    /** One core step (caller holds Lock_). Returns the output to apply. */
    const rs::VehicleOutput& StepLocked(const rs::ChassisState& Chassis, double Dt);
    void PublishOutputs(const rs::VehicleOutput& Out, const std::array<double, 4>& Spin);
    static rs::ChassisState ChassisFromUe(const FVector& PosCm, const FQuat& Rot, const FVector& VelCms, const FVector& OmegaRad);

    UFUNCTION()
    void HandleBodyHit(UPrimitiveComponent* HitComponent, AActor* OtherActor, UPrimitiveComponent* OtherComp,
                       FVector NormalImpulse, const FHitResult& Hit);

    // Everything below is shared between the game thread and the physics thread: guard with Lock_.
    mutable FCriticalSection Lock_;
    rs::CarConfig Config_;
    TUniquePtr<rs::Vehicle> Vehicle_;
    TUniquePtr<rs::Controls> Controls_;
    rs::VehicleOutput LastOut_;
    rs::DriverInput LastIn_;
    FPendingInput Pending_;
    TArray<FPendingImpact> Impacts_;
    rs::ChassisState LastChassis_;
    std::array<rs::WheelContactPatchRays, 4> PatchRays_{};
    std::array<rs::WheelFootprint16Rays, 4> FootprintRays_{};
    std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4> Rays_{};
    std::array<std::array<FGroundSample, MaxRaysPerWheel>, 4> Ground_{};
    std::array<double, 4> Spin_{};
    bool bHaveRays_ = false;
    bool bHaveOutput_ = false;

    // Read by the physics thread without the lock.
    std::atomic<bool> bAsyncRun_{false};
    UPrimitiveComponent* BodyRaw_ = nullptr;   // the owner's root; it outlives this component's play session

    // Game thread only.
    TWeakObjectPtr<UPrimitiveComponent> Body_;
    bool bShiftUpRequested_ = false;
    bool bShiftDownRequested_ = false;
    rs::UdpTelemetrySender UdpSender_;
    rs::MotecLogger MotecLogger_;
    double ElapsedTimeS_ = 0.0;
    bool bPrevBov_ = false;
};
