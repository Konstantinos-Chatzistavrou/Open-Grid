// Apache-2.0 — Visual crash damage component: drives the 6 baked directional morph targets
// (crush_front, crush_rear, crush_left, crush_right, crush_top, crush_hood), 8-node clearcoat paint
// scratch MID parameters (Scratch_FL..RR), 4-zone carbon delamination/shatter splinter events,
// per-wheel detachment + bare-rotor spark emitters, tyre puncture / mechanical failure events,
// multi-fluid leak Niagara emitters & road-puddle drop delegates, and Chaos physics part detachment.
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "OpenGridVehicleComponent.h"
#include "OpenGridDamageComponent.generated.h"

class UMaterialInstanceDynamic;
class UNiagaraComponent;
class UNiagaraSystem;
class UPrimitiveComponent;
class USceneComponent;
class USkeletalMeshComponent;
class UStaticMeshComponent;

UENUM(BlueprintType)
enum class EOpenGridDamageZone : uint8
{
    Front = 0,
    Rear = 1,
    Left = 2,
    Right = 3,
    Top = 4,
    Hood = 5,
};

UENUM(BlueprintType)
enum class EOpenGridFluidType : uint8
{
    Coolant = 0,
    Oil = 1,
    Fuel = 2,
};

/** Multi-fluid damage leak telemetry & computed Niagara emitter rates for coolant, oil, and fuel drips/puddles. */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridFluidLeakState
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float CoolantLeak01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float CoolantLevel01 = 1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float CoolantDripLps = 0.0f;

    /** Scaled Niagara SpawnRate for coolant drip / radiator steam emitter. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float CoolantEmitterRate = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float OilLeak01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float OilLevel01 = 1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float OilDripLps = 0.0f;

    /** Scaled Niagara SpawnRate for engine sump oil drip emitter. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float OilEmitterRate = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float FuelLeak01 = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float FuelDripLps = 0.0f;

    /** Scaled Niagara SpawnRate for ruptured fuel tank / line drip emitter. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    float FuelEmitterRate = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    bool bAnyFluidLeaking = false;
};

/** Configuration + runtime state for a removable exterior component (bumper, mirror, stock wing). */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridDetachablePart
{
    GENERATED_BODY()

    /** Canonical part ID: bumper_front, bumper_rear, mirror_L, mirror_R, stock_wing, etc. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    FName PartId = NAME_None;

    /** Damage zone governing this part's detachment. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    EOpenGridDamageZone Zone = EOpenGridDamageZone::Front;

    /** Normalized zone crush (0..1) above which the part shears off into Chaos physics debris. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage", meta=(ClampMin="0.01", ClampMax="1.0"))
    float DetachThreshold = 0.30f;

    /** Outward launch direction in the vehicle's local frame (X forward, Y right, Z up). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    FVector LocalLaunchDirection = FVector(1.0, 0.0, 0.45);

    /** Initial detachment ejection speed added to the vehicle's velocity (cm/s). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage", meta=(ClampMin="0.0"))
    float LaunchSpeedCmPerSec = 420.0f;

    /** Angular tumble velocity applied at break-off (deg/s). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage", meta=(ClampMin="0.0"))
    float SpinSpeedDegPerSec = 240.0f;

    /** Primitive component representing this part (auto-resolved by PartId name if unset). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    TObjectPtr<UPrimitiveComponent> Component;

    /** True once detached and simulating freely in the world. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bDetached = false;

    // Cached attachment snapshot so RepairAllDamage() can restore the part cleanly.
    TWeakObjectPtr<USceneComponent> OriginalParent;
    FName OriginalSocket = NAME_None;
    FTransform OriginalRelativeTransform = FTransform::Identity;
    ECollisionEnabled::Type OriginalCollision = ECollisionEnabled::NoCollision;
    bool bOriginalStateCaptured = false;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridPartDetached, FName, PartId, EOpenGridDamageZone, Zone);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridCrushUpdated, const FOpenGridCrushMorphWeights&, MorphWeights);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOnOpenGridZoneShatter, EOpenGridDamageZone, Zone, float, ShatterWeight, float, ShatterDelta);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridWheelDetached, int32, WheelIndex, FVector, WorldLocationCm);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridTyrePunctured, int32, WheelIndex);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridMechanicalFailure, int32, WheelIndex, FName, FailureType);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridFluidLeakUpdated, const FOpenGridFluidLeakState&, FluidState);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_FourParams(FOnOpenGridFluidPuddleDrop, EOpenGridFluidType, FluidType, FVector, WorldLocationCm, float, DripLps, float, LeakIntensity01);

/**
 * Polls structural, material-aware, wheel, and fluid damage telemetry from UOpenGridVehicleComponent,
 * drives the 6 baked crash morph targets, 8-node clearcoat scratch MID parameters (Scratch_FL..RR),
 * 4-zone carbon delamination/shatter splinter events, per-wheel detachment + bare-rotor sparks,
 * multi-fluid leak Niagara emitters & puddle drop delegates, and Chaos physics part detachment.
 */
UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRID_API UOpenGridDamageComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UOpenGridDamageComponent();

    /** Removable exterior parts (populated with bumper_front, bumper_rear, mirror_L, mirror_R, stock_wing by default). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    TArray<FOpenGridDetachablePart> DetachableParts;

    /** Current applied weights for crush_front..crush_hood (0..1). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    FOpenGridCrushMorphWeights CurrentMorphWeights;

    /**
     * 8 localized clearcoat/paint scratch intensities (0..1) in canonical node order:
     * 0=FL, 1=FrontCentre, 2=FR, 3=Left, 4=Right, 5=RL, 6=RearCentre, 7=RR.
     * Pushed to BodyPaintMaterials as Scratch_FL..Scratch_RR plus PaintScratchMax.
     */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Material")
    TArray<float> CurrentPaintScratchWeights;

    /**
     * 4 brittle composite delamination / carbon-fiber shatter intensities (0..1):
     * 0=Front, 1=Rear, 2=Left, 3=Right. Pushed to BodyPaintMaterials as Shatter_Front..Shatter_Right.
     */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Material")
    TArray<float> CurrentZoneShatterWeights;

    /** Per-wheel detachment flags (FL=0, FR=1, RL=2, RR=3). Detached wheels are hidden automatically. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Wheels")
    TArray<bool> WheelDetachedStates;

    /** Per-wheel bare-rotor-on-asphalt spark emitter intensity (0..1) when detached & moving over asphalt. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Wheels")
    TArray<float> WheelRotorSparkIntensity;

    /** Per-wheel impact-induced tyre blowout/puncture flags (FL=0, FR=1, RL=2, RR=3). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Wheels")
    TArray<bool> TyrePuncturedStates;

    /** Per-wheel ruptured hydraulic brake line flags (FL=0, FR=1, RL=2, RR=3). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Wheels")
    TArray<bool> BrakeLineRupturedStates;

    /** Per-wheel snapped CV halfshaft flags (FL=0, FR=1, RL=2, RR=3). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Wheels")
    TArray<bool> HalfshaftBrokenStates;

    /** Live multi-fluid leak telemetry & computed Niagara emitter rates for coolant, oil, and fuel. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage|Fluids")
    FOpenGridFluidLeakState FluidLeakState;

    /** Dynamic body paint material instances driven with Scratch_FL..RR, PaintScratchMax, and Shatter_Front..Right. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Material")
    TArray<TObjectPtr<UMaterialInstanceDynamic>> BodyPaintMaterials;

    /** Body mesh material slots auto-bound into BodyPaintMaterials when none are explicitly registered (default slot 0). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Material")
    TArray<int32> ScratchMaterialSlotIndices;

    // ---- Optional Niagara VFX hooks (pooled once at BeginPlay; zero runtime allocations) ----------------------------

    /** Carbon-fiber delamination / composite splinter burst emitter triggered on zone shatter increments. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|VFX")
    TObjectPtr<UNiagaraSystem> CarbonSplinterSystem;

    /** Per-wheel bare-rotor-on-asphalt spark shower emitter (4 pooled instances at FL..RR hubs). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|VFX")
    TObjectPtr<UNiagaraSystem> RotorSparkSystem;

    /** Under-radiator coolant leak drip / steam emitter driven by FluidLeakState.CoolantEmitterRate. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids")
    TObjectPtr<UNiagaraSystem> CoolantLeakSystem;

    /** Under-sump engine oil leak drip emitter driven by FluidLeakState.OilEmitterRate. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids")
    TObjectPtr<UNiagaraSystem> OilLeakSystem;

    /** Under-tank fuel leak drip emitter driven by FluidLeakState.FuelEmitterRate. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids")
    TObjectPtr<UNiagaraSystem> FuelLeakSystem;

    /** Local chassis offsets (cm) for coolant radiator, engine oil sump, and rear fuel tank leak emitters. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids")
    FVector CoolantLeakLocalOffsetCm = FVector(165.0, 0.0, -22.0);

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids")
    FVector OilLeakLocalOffsetCm = FVector(110.0, 0.0, -24.0);

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids")
    FVector FuelLeakLocalOffsetCm = FVector(-145.0, 0.0, -22.0);

    /** Minimum ZoneShatterWeights increment required to trigger a carbon delamination splinter burst event. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|VFX", meta=(ClampMin="0.01", ClampMax="0.5"))
    float ShatterBurstDeltaThreshold = 0.05f;

    /** Multiplier mapping leak intensity + drip rate (L/s) into Niagara SpawnRate. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids", meta=(ClampMin="1.0"))
    float FluidEmitterRateScale = 40.0f;

    /** Accumulated spilled volume (L) per fluid between OnFluidPuddleDrop road-slick decal broadcasts. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage|Fluids", meta=(ClampMin="0.001"))
    float FluidPuddleDripThresholdLiters = 0.015f;

    /** Interpolation speed for smooth morph target response (<= 0 snaps immediately). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage", meta=(ClampMin="0.0"))
    float MorphInterpSpeed = 20.0f;

    /** Automatically reattach detached parts and restore wheels/materials when Vehicle damage resets to zero. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    bool bAutoRepairOnVehicleService = true;

    // ---- BlueprintAssignable Delegates ------------------------------------------------------------------------------

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage")
    FOnOpenGridPartDetached OnPartDetached;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage")
    FOnOpenGridCrushUpdated OnCrushUpdated;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage|Material")
    FOnOpenGridZoneShatter OnZoneShatter;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage|Wheels")
    FOnOpenGridWheelDetached OnWheelDetached;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage|Wheels")
    FOnOpenGridTyrePunctured OnTyrePunctured;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage|Wheels")
    FOnOpenGridMechanicalFailure OnMechanicalFailure;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage|Fluids")
    FOnOpenGridFluidLeakUpdated OnFluidLeakUpdated;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage|Fluids")
    FOnOpenGridFluidPuddleDrop OnFluidPuddleDrop;

    // ---- Public Blueprint / C++ API ---------------------------------------------------------------------------------

    /** Explicitly bind the owning pawn's vehicle and deformable skeletal mesh components. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    void BindPawnComponents(UOpenGridVehicleComponent* InVehicle, USkeletalMeshComponent* InDeformableBody);

    /** Bind the 4 wheel mesh components (FL=0, FR=1, RL=2, RR=3) so detached wheels are hidden automatically. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage|Wheels")
    void BindWheelMeshes(const TArray<UStaticMeshComponent*>& InWheels);

    /** Register a body paint MaterialInstanceDynamic to receive Scratch_FL..RR and Shatter_Front..Right updates. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage|Material")
    void RegisterBodyPaintMaterial(UMaterialInstanceDynamic* Material);

    /** Register or update a removable component for Chaos detachment. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    void RegisterDetachableComponent(FName PartId, UPrimitiveComponent* InComponent,
                                     EOpenGridDamageZone Zone, float Threshold = 0.30f);

    /** Inject additional localized impact damage (e.g. roof rollover or scripted impact callback). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    void ApplyImpactDamage(EOpenGridDamageZone Zone, float NormalizedDelta);

    /** Query the current normalized damage (0..1) for a specific zone. */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage")
    float GetZoneDamageValue(EOpenGridDamageZone Zone) const;

    /** Query localized clearcoat scratch weight (0..1) for node 0..7 (FL, FrontCentre, FR, Left, Right, RL, RearCentre, RR). */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage|Material")
    float GetPaintScratchWeight(int32 NodeIndex) const;

    /** Query brittle carbon delamination/shatter intensity (0..1) for Front/Rear/Left/Right zones. */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage|Material")
    float GetZoneShatterWeight(EOpenGridDamageZone Zone) const;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage|Wheels")
    bool IsWheelDetached(int32 WheelIndex) const;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage|Wheels")
    bool IsTyrePunctured(int32 WheelIndex) const;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage|Wheels")
    bool IsBrakeLineRuptured(int32 WheelIndex) const;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage|Wheels")
    bool IsHalfshaftBroken(int32 WheelIndex) const;

    /** Force-detach a specific registered part by PartId into Chaos physics debris. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    bool DetachPartById(FName PartId);

    /** Reset morph targets, scratches, shatter, wheels, fluid leaks, and snap detached parts back to their mounts. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    void RepairAllDamage();

    /**
     * Repair that was requested from the vehicle (UOpenGridVehicleComponent::RepairAndService). The vehicle only queues the
     * repair for its physics thread, so for a few frames it still reports the old zone damage: resetting the visuals now
     * would let this component read that stale damage, detach the parts it just reattached and fling them off again.
     * Instead the stale damage is ignored until the vehicle reports it cleared (or MaxRepairWaitSeconds pass), then
     * RepairAllDamage() runs once.
     */
    void BeginRepairAfterVehicleService();

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

private:
    void ResolveOwnerReferences();
    void EnsureDefaultDetachableParts();
    void AutoBindDetachableComponents();
    void EnsureBodyPaintMaterials();
    void InitializePooledDamageVfx();
    UNiagaraComponent* CreatePooledEmitter(UNiagaraSystem* SystemAsset,
                                           USceneComponent* AttachParent,
                                           const FVector& RelativeLocation) const;
    void CaptureOriginalAttachment(FOpenGridDetachablePart& Part) const;
    void DetachPart(FOpenGridDetachablePart& Part);
    void ReattachPart(FOpenGridDetachablePart& Part);
    FOpenGridCrushMorphWeights SampleTargetMorphWeights() const;
    void ApplyMorphWeightsToMesh(const FOpenGridCrushMorphWeights& Weights);
    void ApplyScratchAndShatterMaterials() const;
    void UpdatePaintScratchesAndShatter(const UOpenGridVehicleComponent* Vehicle);
    void UpdateWheelAndMechanicalFailures(const UOpenGridVehicleComponent* Vehicle);
    void UpdateFluidLeaks(float DeltaTime, const UOpenGridVehicleComponent* Vehicle);
    void TriggerCarbonSplinterBurst(EOpenGridDamageZone Zone, float Intensity);
    float GetZoneValueFromWeights(const FOpenGridCrushMorphWeights& Weights, EOpenGridDamageZone Zone) const;
    float ComputeTotalVehicleDamageSignal(const FOpenGridCrushMorphWeights& MorphTarget,
                                          const UOpenGridVehicleComponent* Vehicle) const;

    TWeakObjectPtr<UOpenGridVehicleComponent> Vehicle_;
    TWeakObjectPtr<USkeletalMeshComponent> DeformableBodyMesh_;
    TWeakObjectPtr<UStaticMeshComponent> StaticBodyMesh_;
    TArray<TWeakObjectPtr<UStaticMeshComponent>> WheelMeshes_;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UNiagaraComponent>> RotorSparkComponents_;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UNiagaraComponent>> CarbonSplinterComponents_;

    UPROPERTY(Transient)
    TObjectPtr<UNiagaraComponent> CoolantLeakComponent_;

    UPROPERTY(Transient)
    TObjectPtr<UNiagaraComponent> OilLeakComponent_;

    UPROPERTY(Transient)
    TObjectPtr<UNiagaraComponent> FuelLeakComponent_;

    int32 NextSplinterPoolIndex_ = 0;
    bool bDamageVfxInitialized_ = false;
    bool bPaintMaterialsResolved_ = false;

    /** Extra impact damage accumulated outside rs_core (e.g. roof hits or Blueprint callbacks). */
    float ExtraZoneDamage_[6] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
    float PreviousTotalDamageSignal_ = 0.0f;
    float LastShatterBurstWeight_[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    float FluidPuddleAccumLiters_[3] = {0.0f, 0.0f, 0.0f};

    /** True from BeginRepairAfterVehicleService() until the vehicle's own damage has cleared (or the wait ran out). */
    bool bRepairPending_ = false;
    float RepairPendingSeconds_ = 0.0f;
    static constexpr float MaxRepairWaitSeconds = 1.0f;
};
