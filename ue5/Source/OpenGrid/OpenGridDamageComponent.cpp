// Apache-2.0 — see OpenGridDamageComponent.h
#include "OpenGridDamageComponent.h"

#include "Components/PrimitiveComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "GameFramework/Actor.h"

DEFINE_LOG_CATEGORY_STATIC(LogOpenGridDamage, Log, All);

namespace
{
const FName kMorphCrushFront(TEXT("crush_front"));
const FName kMorphCrushRear(TEXT("crush_rear"));
const FName kMorphCrushLeft(TEXT("crush_left"));
const FName kMorphCrushRight(TEXT("crush_right"));
const FName kMorphCrushTop(TEXT("crush_top"));
const FName kMorphCrushHood(TEXT("crush_hood"));

float TotalMorphSum(const FOpenGridCrushMorphWeights& W)
{
    return W.crush_front + W.crush_rear + W.crush_left + W.crush_right + W.crush_top + W.crush_hood;
}
}  // namespace

UOpenGridDamageComponent::UOpenGridDamageComponent()
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PostPhysics;
    EnsureDefaultDetachableParts();
}

void UOpenGridDamageComponent::EnsureDefaultDetachableParts()
{
    if (DetachableParts.Num() > 0) return;

    auto MakePart = [](const TCHAR* Id, EOpenGridDamageZone Zone, float Threshold, const FVector& Dir, float Speed)
    {
        FOpenGridDetachablePart P;
        P.PartId = FName(Id);
        P.Zone = Zone;
        P.DetachThreshold = Threshold;
        P.LocalLaunchDirection = Dir.GetSafeNormal();
        P.LaunchSpeedCmPerSec = Speed;
        P.SpinSpeedDegPerSec = 260.0f;
        return P;
    };

    // Thresholds mirror BREAK_CRUSH in web/src/scene/damage.ts plus stock_wing rear shear.
    DetachableParts.Add(MakePart(TEXT("bumper_front"), EOpenGridDamageZone::Front, 0.30f, FVector(1.0, 0.0, 0.45), 420.0f));
    DetachableParts.Add(MakePart(TEXT("bumper_rear"),  EOpenGridDamageZone::Rear,  0.30f, FVector(-1.0, 0.0, 0.45), 420.0f));
    DetachableParts.Add(MakePart(TEXT("mirror_L"),     EOpenGridDamageZone::Left,  0.12f, FVector(0.2, -1.0, 0.55), 360.0f));
    DetachableParts.Add(MakePart(TEXT("mirror_R"),     EOpenGridDamageZone::Right, 0.12f, FVector(0.2, 1.0, 0.55), 360.0f));
    DetachableParts.Add(MakePart(TEXT("stock_wing"),   EOpenGridDamageZone::Rear,  0.35f, FVector(-0.75, 0.0, 0.85), 480.0f));
}

void UOpenGridDamageComponent::BindPawnComponents(UOpenGridVehicleComponent* InVehicle,
                                                  USkeletalMeshComponent* InDeformableBody)
{
    Vehicle_ = InVehicle;
    DeformableBodyMesh_ = InDeformableBody;
}

void UOpenGridDamageComponent::RegisterDetachableComponent(FName PartId, UPrimitiveComponent* InComponent,
                                                           EOpenGridDamageZone Zone, float Threshold)
{
    if (PartId.IsNone() || !InComponent) return;

    for (FOpenGridDetachablePart& Part : DetachableParts)
    {
        if (Part.PartId == PartId)
        {
            Part.Component = InComponent;
            Part.Zone = Zone;
            Part.DetachThreshold = FMath::Clamp(Threshold, 0.01f, 1.0f);
            CaptureOriginalAttachment(Part);
            return;
        }
    }

    FOpenGridDetachablePart NewPart;
    NewPart.PartId = PartId;
    NewPart.Zone = Zone;
    NewPart.DetachThreshold = FMath::Clamp(Threshold, 0.01f, 1.0f);
    NewPart.Component = InComponent;
    CaptureOriginalAttachment(NewPart);
    DetachableParts.Add(NewPart);
}

void UOpenGridDamageComponent::ResolveOwnerReferences()
{
    AActor* Owner = GetOwner();
    if (!Owner) return;

    if (!Vehicle_.IsValid())
    {
        Vehicle_ = Owner->FindComponentByClass<UOpenGridVehicleComponent>();
    }
    if (!DeformableBodyMesh_.IsValid())
    {
        DeformableBodyMesh_ = Owner->FindComponentByClass<USkeletalMeshComponent>();
    }
}

void UOpenGridDamageComponent::AutoBindDetachableComponents()
{
    AActor* Owner = GetOwner();
    if (!Owner) return;

    TArray<UPrimitiveComponent*> Primitives;
    Owner->GetComponents<UPrimitiveComponent>(Primitives);

    for (FOpenGridDetachablePart& Part : DetachableParts)
    {
        if (!IsValid(Part.Component))
        {
            const FString TargetName = Part.PartId.ToString();
            for (UPrimitiveComponent* Prim : Primitives)
            {
                if (!Prim) continue;
                const FString PrimName = Prim->GetName();
                if (PrimName.Equals(TargetName, ESearchCase::IgnoreCase) ||
                    (Part.PartId == TEXT("stock_wing") && PrimName.Equals(TEXT("StockWingMesh"), ESearchCase::IgnoreCase)))
                {
                    Part.Component = Prim;
                    break;
                }
            }
        }
        CaptureOriginalAttachment(Part);
    }
}

void UOpenGridDamageComponent::CaptureOriginalAttachment(FOpenGridDetachablePart& Part) const
{
    UPrimitiveComponent* Comp = Part.Component.Get();
    if (!Comp || Part.bOriginalStateCaptured) return;

    Part.OriginalParent = Comp->GetAttachParent();
    Part.OriginalSocket = Comp->GetAttachSocketName();
    Part.OriginalRelativeTransform = Comp->GetRelativeTransform();
    Part.OriginalCollision = Comp->GetCollisionEnabled();
    Part.bOriginalStateCaptured = true;
}

void UOpenGridDamageComponent::BeginPlay()
{
    Super::BeginPlay();
    ResolveOwnerReferences();
    EnsureDefaultDetachableParts();
    AutoBindDetachableComponents();
}

void UOpenGridDamageComponent::ApplyImpactDamage(EOpenGridDamageZone Zone, float NormalizedDelta)
{
    const int32 Idx = static_cast<int32>(Zone);
    if (Idx < 0 || Idx >= 6 || NormalizedDelta <= 0.0f) return;
    ExtraZoneDamage_[Idx] = FMath::Clamp(ExtraZoneDamage_[Idx] + NormalizedDelta, 0.0f, 1.0f);
}

float UOpenGridDamageComponent::GetZoneValueFromWeights(const FOpenGridCrushMorphWeights& Weights,
                                                        EOpenGridDamageZone Zone) const
{
    switch (Zone)
    {
        case EOpenGridDamageZone::Front: return Weights.crush_front;
        case EOpenGridDamageZone::Rear:  return Weights.crush_rear;
        case EOpenGridDamageZone::Left:  return Weights.crush_left;
        case EOpenGridDamageZone::Right: return Weights.crush_right;
        case EOpenGridDamageZone::Top:   return Weights.crush_top;
        case EOpenGridDamageZone::Hood:  return Weights.crush_hood;
        default:                         return 0.0f;
    }
}

float UOpenGridDamageComponent::GetZoneDamageValue(EOpenGridDamageZone Zone) const
{
    return GetZoneValueFromWeights(CurrentMorphWeights, Zone);
}

FOpenGridCrushMorphWeights UOpenGridDamageComponent::SampleTargetMorphWeights() const
{
    FOpenGridCrushMorphWeights Target;

    if (const UOpenGridVehicleComponent* Vehicle = Vehicle_.Get())
    {
        // Prefer precomputed 6-zone crush weights from rs_core, combined with raw 4-zone values.
        Target = Vehicle->GetCrushMorphWeights();
        const TArray<float> Zones = Vehicle->GetZoneDamage();
        if (Zones.Num() >= 4)
        {
            Target.crush_front = FMath::Max(Target.crush_front, FMath::Clamp(Zones[0], 0.0f, 1.0f));
            Target.crush_rear  = FMath::Max(Target.crush_rear,  FMath::Clamp(Zones[1], 0.0f, 1.0f));
            Target.crush_left  = FMath::Max(Target.crush_left,  FMath::Clamp(Zones[2], 0.0f, 1.0f));
            Target.crush_right = FMath::Max(Target.crush_right, FMath::Clamp(Zones[3], 0.0f, 1.0f));
        }
        if (Vehicle->bHoodUnlatched)
        {
            Target.crush_hood = FMath::Max(Target.crush_hood, 0.65f);
        }
    }

    Target.crush_front = FMath::Clamp(FMath::Max(Target.crush_front, ExtraZoneDamage_[0]), 0.0f, 1.0f);
    Target.crush_rear  = FMath::Clamp(FMath::Max(Target.crush_rear,  ExtraZoneDamage_[1]), 0.0f, 1.0f);
    Target.crush_left  = FMath::Clamp(FMath::Max(Target.crush_left,  ExtraZoneDamage_[2]), 0.0f, 1.0f);
    Target.crush_right = FMath::Clamp(FMath::Max(Target.crush_right, ExtraZoneDamage_[3]), 0.0f, 1.0f);
    Target.crush_top   = FMath::Clamp(FMath::Max(Target.crush_top,   ExtraZoneDamage_[4]), 0.0f, 1.0f);
    Target.crush_hood  = FMath::Clamp(FMath::Max(Target.crush_hood,  ExtraZoneDamage_[5]), 0.0f, 1.0f);
    return Target;
}

void UOpenGridDamageComponent::ApplyMorphWeightsToMesh(const FOpenGridCrushMorphWeights& Weights)
{
    USkeletalMeshComponent* Skel = DeformableBodyMesh_.Get();
    if (!Skel || !Skel->GetSkeletalMeshAsset()) return;

    Skel->SetMorphTarget(kMorphCrushFront, Weights.crush_front);
    Skel->SetMorphTarget(kMorphCrushRear,  Weights.crush_rear);
    Skel->SetMorphTarget(kMorphCrushLeft,  Weights.crush_left);
    Skel->SetMorphTarget(kMorphCrushRight, Weights.crush_right);
    Skel->SetMorphTarget(kMorphCrushTop,   Weights.crush_top);
    Skel->SetMorphTarget(kMorphCrushHood,  Weights.crush_hood);
}

void UOpenGridDamageComponent::DetachPart(FOpenGridDetachablePart& Part)
{
    if (Part.bDetached) return;
    UPrimitiveComponent* Comp = Part.Component.Get();
    if (!Comp || !Comp->IsVisible()) return;

    CaptureOriginalAttachment(Part);

    const AActor* Owner = GetOwner();
    const FVector OwnerVelCm = Owner ? Owner->GetVelocity() : FVector::ZeroVector;
    const FQuat OwnerQuat = Owner ? Owner->GetActorQuat() : FQuat::Identity;

    Comp->DetachFromComponent(FDetachmentTransformRules::KeepWorldTransform);
    Comp->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
    Comp->SetCollisionProfileName(TEXT("PhysicsActor"));
    Comp->SetSimulatePhysics(true);
    Comp->WakeAllRigidBodies();

    const FVector WorldLaunchDir = OwnerQuat.RotateVector(Part.LocalLaunchDirection.GetSafeNormal());
    const FVector LaunchVelocity = OwnerVelCm + WorldLaunchDir * Part.LaunchSpeedCmPerSec;
    Comp->AddImpulse(LaunchVelocity, NAME_None, true);

    const FVector SpinAxis = FVector::CrossProduct(WorldLaunchDir, FVector::UpVector).GetSafeNormal();
    const FVector AngularImpulse = (SpinAxis.IsNearlyZero() ? FVector(0.0, 1.0, 0.3) : SpinAxis) * Part.SpinSpeedDegPerSec;
    Comp->AddAngularImpulseInDegrees(AngularImpulse, NAME_None, true);

    Part.bDetached = true;
    UE_LOG(LogOpenGridDamage, Log, TEXT("Detached part '%s' (zone %d)"), *Part.PartId.ToString(), static_cast<int32>(Part.Zone));
    OnPartDetached.Broadcast(Part.PartId, Part.Zone);
}

void UOpenGridDamageComponent::ReattachPart(FOpenGridDetachablePart& Part)
{
    if (!Part.bDetached) return;
    UPrimitiveComponent* Comp = Part.Component.Get();
    Part.bDetached = false;
    if (!Comp) return;

    Comp->SetSimulatePhysics(false);
    Comp->SetPhysicsLinearVelocity(FVector::ZeroVector);
    Comp->SetPhysicsAngularVelocityInDegrees(FVector::ZeroVector);
    Comp->SetCollisionEnabled(Part.OriginalCollision);

    if (USceneComponent* OrigParent = Part.OriginalParent.Get())
    {
        Comp->AttachToComponent(OrigParent, FAttachmentTransformRules::KeepRelativeTransform, Part.OriginalSocket);
        Comp->SetRelativeTransform(Part.OriginalRelativeTransform);
    }
}

bool UOpenGridDamageComponent::DetachPartById(FName PartId)
{
    for (FOpenGridDetachablePart& Part : DetachableParts)
    {
        if (Part.PartId == PartId)
        {
            if (Part.bDetached) return false;
            DetachPart(Part);
            return Part.bDetached;
        }
    }
    return false;
}

void UOpenGridDamageComponent::RepairAllDamage()
{
    for (int32 i = 0; i < 6; ++i)
    {
        ExtraZoneDamage_[i] = 0.0f;
    }
    CurrentMorphWeights = FOpenGridCrushMorphWeights{};
    PreviousTotalZoneDamage_ = 0.0f;
    ApplyMorphWeightsToMesh(CurrentMorphWeights);

    for (FOpenGridDetachablePart& Part : DetachableParts)
    {
        ReattachPart(Part);
    }
    OnCrushUpdated.Broadcast(CurrentMorphWeights);
}

void UOpenGridDamageComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
    Super::TickComponent(DeltaTime, TickType, ThisTickFunction);

    if (!Vehicle_.IsValid() || !DeformableBodyMesh_.IsValid())
    {
        ResolveOwnerReferences();
    }

    const FOpenGridCrushMorphWeights Target = SampleTargetMorphWeights();
    const float TargetSum = TotalMorphSum(Target);

    // Detect rs::Vehicle::service() resetting zone damage back to 0.
    if (bAutoRepairOnVehicleService && PreviousTotalZoneDamage_ > 0.05f && TargetSum <= KINDA_SMALL_NUMBER)
    {
        RepairAllDamage();
        return;
    }
    PreviousTotalZoneDamage_ = TargetSum;

    auto StepWeight = [DeltaTime, this](float Current, float Goal) -> float
    {
        if (MorphInterpSpeed <= 0.0f) return Goal;
        return FMath::FInterpTo(Current, Goal, DeltaTime, MorphInterpSpeed);
    };

    const FOpenGridCrushMorphWeights Prev = CurrentMorphWeights;
    CurrentMorphWeights.crush_front = StepWeight(CurrentMorphWeights.crush_front, Target.crush_front);
    CurrentMorphWeights.crush_rear  = StepWeight(CurrentMorphWeights.crush_rear,  Target.crush_rear);
    CurrentMorphWeights.crush_left  = StepWeight(CurrentMorphWeights.crush_left,  Target.crush_left);
    CurrentMorphWeights.crush_right = StepWeight(CurrentMorphWeights.crush_right, Target.crush_right);
    CurrentMorphWeights.crush_top   = StepWeight(CurrentMorphWeights.crush_top,   Target.crush_top);
    CurrentMorphWeights.crush_hood  = StepWeight(CurrentMorphWeights.crush_hood,  Target.crush_hood);

    const bool bChanged =
        FMath::Abs(CurrentMorphWeights.crush_front - Prev.crush_front) > 1e-4f ||
        FMath::Abs(CurrentMorphWeights.crush_rear  - Prev.crush_rear)  > 1e-4f ||
        FMath::Abs(CurrentMorphWeights.crush_left  - Prev.crush_left)  > 1e-4f ||
        FMath::Abs(CurrentMorphWeights.crush_right - Prev.crush_right) > 1e-4f ||
        FMath::Abs(CurrentMorphWeights.crush_top   - Prev.crush_top)   > 1e-4f ||
        FMath::Abs(CurrentMorphWeights.crush_hood  - Prev.crush_hood)  > 1e-4f;

    if (bChanged)
    {
        ApplyMorphWeightsToMesh(CurrentMorphWeights);
        OnCrushUpdated.Broadcast(CurrentMorphWeights);
    }

    const UOpenGridVehicleComponent* Vehicle = Vehicle_.Get();
    for (FOpenGridDetachablePart& Part : DetachableParts)
    {
        if (Part.bDetached || !IsValid(Part.Component)) continue;

        const float ZoneDamageVal = GetZoneValueFromWeights(Target, Part.Zone);
        const bool bCoreForceDetach =
            Vehicle && ((Part.PartId == TEXT("bumper_front") && Vehicle->bFrontBumperDetached) ||
                        (Part.PartId == TEXT("bumper_rear") && Vehicle->bRearBumperDetached));

        if (ZoneDamageVal >= Part.DetachThreshold || bCoreForceDetach)
        {
            DetachPart(Part);
        }
    }
}
