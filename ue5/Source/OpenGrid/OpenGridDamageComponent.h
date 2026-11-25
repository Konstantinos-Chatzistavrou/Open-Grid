// Apache-2.0 — Visual crash damage component: drives the 6 baked directional morph targets
// (crush_front, crush_rear, crush_left, crush_right, crush_top, crush_hood) from UOpenGridVehicleComponent
// and detaches bumpers, mirrors, and wings into Chaos physics debris once zone crush exceeds thresholds.
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "OpenGridVehicleComponent.h"
#include "OpenGridDamageComponent.generated.h"

class UPrimitiveComponent;
class USceneComponent;
class USkeletalMeshComponent;

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

/**
 * Polls zone damage from UOpenGridVehicleComponent (and optional impact callbacks), drives the 6 baked crash
 * morph targets on the deformable skeletal body mesh, and detaches removable parts into Chaos physics debris.
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

    /** Interpolation speed for smooth morph target response (<= 0 snaps immediately). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage", meta=(ClampMin="0.0"))
    float MorphInterpSpeed = 20.0f;

    /** Automatically reattach detached parts when Vehicle zone damage resets to zero (e.g. after RepairAndService). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    bool bAutoRepairOnVehicleService = true;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage")
    FOnOpenGridPartDetached OnPartDetached;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Damage")
    FOnOpenGridCrushUpdated OnCrushUpdated;

    /** Explicitly bind the owning pawn's vehicle and deformable skeletal mesh components. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    void BindPawnComponents(UOpenGridVehicleComponent* InVehicle, USkeletalMeshComponent* InDeformableBody);

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

    /** Force-detach a specific registered part by PartId into Chaos physics debris. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    bool DetachPartById(FName PartId);

    /** Reset all morph targets to zero and snap detached parts back to their original mounts. */
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
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

private:
    void ResolveOwnerReferences();
    void EnsureDefaultDetachableParts();
    void AutoBindDetachableComponents();
    void CaptureOriginalAttachment(FOpenGridDetachablePart& Part) const;
    void DetachPart(FOpenGridDetachablePart& Part);
    void ReattachPart(FOpenGridDetachablePart& Part);
    FOpenGridCrushMorphWeights SampleTargetMorphWeights() const;
    void ApplyMorphWeightsToMesh(const FOpenGridCrushMorphWeights& Weights);
    float GetZoneValueFromWeights(const FOpenGridCrushMorphWeights& Weights, EOpenGridDamageZone Zone) const;

    TWeakObjectPtr<UOpenGridVehicleComponent> Vehicle_;
    TWeakObjectPtr<USkeletalMeshComponent> DeformableBodyMesh_;

    /** Extra impact damage accumulated outside rs_core (e.g. roof hits or Blueprint callbacks). */
    float ExtraZoneDamage_[6] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
    float PreviousTotalZoneDamage_ = 0.0f;

    /** True from BeginRepairAfterVehicleService() until the vehicle's own zone damage has cleared (or the wait ran out). */
    bool bRepairPending_ = false;
    float RepairPendingSeconds_ = 0.0f;
    static constexpr float MaxRepairWaitSeconds = 1.0f;
};
