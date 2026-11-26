// Apache-2.0 — see OpenGridDamageComponent.h
#include "OpenGridDamageComponent.h"

#include "Components/MeshComponent.h"
#include "Components/PrimitiveComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/Actor.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "NiagaraComponent.h"
#include "NiagaraFunctionLibrary.h"
#include "NiagaraSystem.h"

DEFINE_LOG_CATEGORY_STATIC(LogOpenGridDamage, Log, All);

namespace
{
constexpr int32 kNumScratchNodes = 8;
constexpr int32 kNumShatterZones = 4;
constexpr int32 kNumWheels = 4;
constexpr int32 kNumSplinterPoolSlots = 2;

const FName kMorphCrushFront(TEXT("crush_front"));
const FName kMorphCrushRear(TEXT("crush_rear"));
const FName kMorphCrushLeft(TEXT("crush_left"));
const FName kMorphCrushRight(TEXT("crush_right"));
const FName kMorphCrushTop(TEXT("crush_top"));
const FName kMorphCrushHood(TEXT("crush_hood"));

// 8-node clearcoat/paint scratch dynamic material scalar parameters (canonical rs_core perimeter node order).
const FName kMatScratchParams[kNumScratchNodes] = {
    FName(TEXT("Scratch_FL")),
    FName(TEXT("Scratch_FrontCentre")),
    FName(TEXT("Scratch_FR")),
    FName(TEXT("Scratch_Left")),
    FName(TEXT("Scratch_Right")),
    FName(TEXT("Scratch_RL")),
    FName(TEXT("Scratch_RearCentre")),
    FName(TEXT("Scratch_RR")),
};
const FName kMatPaintScratchMax(TEXT("PaintScratchMax"));

// 4-zone composite delamination / carbon shatter material scalar parameters.
const FName kMatShatterParams[kNumShatterZones] = {
    FName(TEXT("Shatter_Front")),
    FName(TEXT("Shatter_Rear")),
    FName(TEXT("Shatter_Left")),
    FName(TEXT("Shatter_Right")),
};

// Niagara User Parameters for damage VFX emitters.
const FName kParamSpawnRate(TEXT("SpawnRate"));
const FName kParamLeakIntensity(TEXT("LeakIntensity"));
const FName kParamDripLps(TEXT("DripLps"));
const FName kParamVehicleSpeedMps(TEXT("VehicleSpeedMps"));
const FName kParamSparkVelocity(TEXT("SparkVelocity"));
const FName kParamSplinterIntensity(TEXT("SplinterIntensity"));

// Mechanical failure identifiers broadcast via OnMechanicalFailure.
const FName kFailureWheelDetached(TEXT("WheelDetached"));
const FName kFailureTyrePunctured(TEXT("TyrePunctured"));
const FName kFailureBrakeLineRuptured(TEXT("BrakeLineRuptured"));
const FName kFailureHalfshaftBroken(TEXT("HalfshaftBroken"));

float TotalMorphSum(const FOpenGridCrushMorphWeights& W)
{
    return W.crush_front + W.crush_rear + W.crush_left + W.crush_right + W.crush_top + W.crush_hood;
}

void SetDamageEmitterActive(UNiagaraComponent* Comp, bool bShouldEmit)
{
    if (!Comp) return;
    if (bShouldEmit)
    {
        if (!Comp->IsActive())
        {
            Comp->Activate(false);
        }
    }
    else if (Comp->IsActive())
    {
        Comp->Deactivate();
    }
}

FVector ZoneLocalOffsetCm(EOpenGridDamageZone Zone)
{
    switch (Zone)
    {
        case EOpenGridDamageZone::Front: return FVector(205.0, 0.0, 15.0);
        case EOpenGridDamageZone::Rear:  return FVector(-205.0, 0.0, 20.0);
        case EOpenGridDamageZone::Left:  return FVector(0.0, -90.0, 15.0);
        case EOpenGridDamageZone::Right: return FVector(0.0, 90.0, 15.0);
        case EOpenGridDamageZone::Top:   return FVector(0.0, 0.0, 75.0);
        case EOpenGridDamageZone::Hood:  return FVector(120.0, 0.0, 42.0);
        default:                         return FVector::ZeroVector;
    }
}

FVector ZoneLocalNormal(EOpenGridDamageZone Zone)
{
    switch (Zone)
    {
        case EOpenGridDamageZone::Front: return FVector(1.0, 0.0, 0.25).GetSafeNormal();
        case EOpenGridDamageZone::Rear:  return FVector(-1.0, 0.0, 0.25).GetSafeNormal();
        case EOpenGridDamageZone::Left:  return FVector(0.0, -1.0, 0.25).GetSafeNormal();
        case EOpenGridDamageZone::Right: return FVector(0.0, 1.0, 0.25).GetSafeNormal();
        case EOpenGridDamageZone::Top:   return FVector::UpVector;
        case EOpenGridDamageZone::Hood:  return FVector(0.35, 0.0, 0.94).GetSafeNormal();
        default:                         return FVector::UpVector;
    }
}
}  // namespace

UOpenGridDamageComponent::UOpenGridDamageComponent()
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PostPhysics;

    CurrentPaintScratchWeights.SetNumZeroed(kNumScratchNodes);
    CurrentZoneShatterWeights.SetNumZeroed(kNumShatterZones);
    WheelDetachedStates.Init(false, kNumWheels);
    WheelRotorSparkIntensity.SetNumZeroed(kNumWheels);
    TyrePuncturedStates.Init(false, kNumWheels);
    BrakeLineRupturedStates.Init(false, kNumWheels);
    HalfshaftBrokenStates.Init(false, kNumWheels);
    ScratchMaterialSlotIndices.Add(0);

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
    bPaintMaterialsResolved_ = false;
}

void UOpenGridDamageComponent::BindWheelMeshes(const TArray<UStaticMeshComponent*>& InWheels)
{
    WheelMeshes_.SetNum(kNumWheels);
    for (int32 i = 0; i < kNumWheels; ++i)
    {
        WheelMeshes_[i] = InWheels.IsValidIndex(i) ? InWheels[i] : nullptr;
    }
}

void UOpenGridDamageComponent::RegisterBodyPaintMaterial(UMaterialInstanceDynamic* Material)
{
    if (Material && !BodyPaintMaterials.Contains(Material))
    {
        BodyPaintMaterials.Add(Material);
    }
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

    if (WheelMeshes_.Num() < kNumWheels)
    {
        WheelMeshes_.SetNum(kNumWheels);
    }

    bool bNeedWheels = false;
    for (int32 i = 0; i < kNumWheels; ++i)
    {
        if (!WheelMeshes_[i].IsValid())
        {
            bNeedWheels = true;
            break;
        }
    }

    if (!StaticBodyMesh_.IsValid() || bNeedWheels)
    {
        static const TCHAR* kWheelNames[kNumWheels] = {TEXT("WheelFL"), TEXT("WheelFR"), TEXT("WheelRL"), TEXT("WheelRR")};
        TArray<UStaticMeshComponent*> StaticMeshes;
        Owner->GetComponents<UStaticMeshComponent>(StaticMeshes);
        for (UStaticMeshComponent* SM : StaticMeshes)
        {
            if (!SM) continue;
            const FString CompName = SM->GetName();
            if (!StaticBodyMesh_.IsValid() && CompName.Equals(TEXT("BodyMesh"), ESearchCase::IgnoreCase))
            {
                StaticBodyMesh_ = SM;
            }
            for (int32 i = 0; i < kNumWheels; ++i)
            {
                if (!WheelMeshes_[i].IsValid() && CompName.Equals(kWheelNames[i], ESearchCase::IgnoreCase))
                {
                    WheelMeshes_[i] = SM;
                }
            }
        }
    }
}

void UOpenGridDamageComponent::EnsureBodyPaintMaterials()
{
    if (bPaintMaterialsResolved_) return;
    bPaintMaterialsResolved_ = true;

    if (BodyPaintMaterials.Num() > 0) return;

    UMeshComponent* ActiveBody = nullptr;
    if (USkeletalMeshComponent* Skel = DeformableBodyMesh_.Get(); Skel && Skel->GetSkeletalMeshAsset())
    {
        ActiveBody = Skel;
    }
    else if (UStaticMeshComponent* Stat = StaticBodyMesh_.Get())
    {
        ActiveBody = Stat;
    }

    if (!ActiveBody) return;

    const int32 NumMats = ActiveBody->GetNumMaterials();
    TArray<int32> Slots = ScratchMaterialSlotIndices;
    if (Slots.Num() == 0)
    {
        Slots.Add(0);
    }

    for (const int32 Slot : Slots)
    {
        if (Slot < 0 || Slot >= NumMats) continue;
        UMaterialInterface* BaseMat = ActiveBody->GetMaterial(Slot);
        if (!BaseMat) continue;

        UMaterialInstanceDynamic* Mid = Cast<UMaterialInstanceDynamic>(BaseMat);
        if (!Mid)
        {
            Mid = ActiveBody->CreateAndSetMaterialInstanceDynamic(Slot);
        }
        if (Mid && !BodyPaintMaterials.Contains(Mid))
        {
            BodyPaintMaterials.Add(Mid);
        }
    }
}

UNiagaraComponent* UOpenGridDamageComponent::CreatePooledEmitter(
    UNiagaraSystem* SystemAsset,
    USceneComponent* AttachParent,
    const FVector& RelativeLocation) const
{
    if (!SystemAsset || !AttachParent) return nullptr;

    return UNiagaraFunctionLibrary::SpawnSystemAttached(
        SystemAsset,
        AttachParent,
        NAME_None,
        RelativeLocation,
        FRotator::ZeroRotator,
        EAttachLocation::KeepRelativeOffset,
        /*bAutoDestroy=*/false,
        /*bAutoActivate=*/false,
        ENCPoolMethod::None,
        /*bPreCullCheck=*/false);
}

void UOpenGridDamageComponent::InitializePooledDamageVfx()
{
    if (bDamageVfxInitialized_) return;
    bDamageVfxInitialized_ = true;

    AActor* Owner = GetOwner();
    USceneComponent* Root = Owner ? Owner->GetRootComponent() : nullptr;
    if (!Root) return;

    RotorSparkComponents_.SetNum(kNumWheels);
    for (int32 i = 0; i < kNumWheels; ++i)
    {
        RotorSparkComponents_[i] = CreatePooledEmitter(RotorSparkSystem.Get(), Root, FVector::ZeroVector);
    }

    CarbonSplinterComponents_.SetNum(kNumSplinterPoolSlots);
    for (int32 i = 0; i < kNumSplinterPoolSlots; ++i)
    {
        CarbonSplinterComponents_[i] = CreatePooledEmitter(CarbonSplinterSystem.Get(), Root, FVector::ZeroVector);
    }

    CoolantLeakComponent_ = CreatePooledEmitter(CoolantLeakSystem.Get(), Root, CoolantLeakLocalOffsetCm);
    OilLeakComponent_ = CreatePooledEmitter(OilLeakSystem.Get(), Root, OilLeakLocalOffsetCm);
    FuelLeakComponent_ = CreatePooledEmitter(FuelLeakSystem.Get(), Root, FuelLeakLocalOffsetCm);
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
    EnsureBodyPaintMaterials();
    InitializePooledDamageVfx();
}

void UOpenGridDamageComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    for (TObjectPtr<UNiagaraComponent>& Comp : RotorSparkComponents_)
    {
        if (Comp) Comp->DeactivateImmediate();
    }
    for (TObjectPtr<UNiagaraComponent>& Comp : CarbonSplinterComponents_)
    {
        if (Comp) Comp->DeactivateImmediate();
    }
    if (CoolantLeakComponent_) CoolantLeakComponent_->DeactivateImmediate();
    if (OilLeakComponent_) OilLeakComponent_->DeactivateImmediate();
    if (FuelLeakComponent_) FuelLeakComponent_->DeactivateImmediate();

    Super::EndPlay(EndPlayReason);
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

float UOpenGridDamageComponent::GetPaintScratchWeight(int32 NodeIndex) const
{
    return CurrentPaintScratchWeights.IsValidIndex(NodeIndex) ? CurrentPaintScratchWeights[NodeIndex] : 0.0f;
}

float UOpenGridDamageComponent::GetZoneShatterWeight(EOpenGridDamageZone Zone) const
{
    const int32 Idx = static_cast<int32>(Zone);
    return (Idx >= 0 && Idx < CurrentZoneShatterWeights.Num()) ? CurrentZoneShatterWeights[Idx] : 0.0f;
}

bool UOpenGridDamageComponent::IsWheelDetached(int32 WheelIndex) const
{
    return WheelDetachedStates.IsValidIndex(WheelIndex) ? WheelDetachedStates[WheelIndex] : false;
}

bool UOpenGridDamageComponent::IsTyrePunctured(int32 WheelIndex) const
{
    return TyrePuncturedStates.IsValidIndex(WheelIndex) ? TyrePuncturedStates[WheelIndex] : false;
}

bool UOpenGridDamageComponent::IsBrakeLineRuptured(int32 WheelIndex) const
{
    return BrakeLineRupturedStates.IsValidIndex(WheelIndex) ? BrakeLineRupturedStates[WheelIndex] : false;
}

bool UOpenGridDamageComponent::IsHalfshaftBroken(int32 WheelIndex) const
{
    return HalfshaftBrokenStates.IsValidIndex(WheelIndex) ? HalfshaftBrokenStates[WheelIndex] : false;
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

float UOpenGridDamageComponent::ComputeTotalVehicleDamageSignal(
    const FOpenGridCrushMorphWeights& MorphTarget,
    const UOpenGridVehicleComponent* Vehicle) const
{
    float Sum = TotalMorphSum(MorphTarget);
    if (!Vehicle) return Sum;

    for (int32 i = 0; i < Vehicle->PaintScratchWeights.Num(); ++i)
    {
        Sum += FMath::Max(0.0f, Vehicle->PaintScratchWeights[i]);
    }
    for (int32 i = 0; i < Vehicle->ZoneShatterWeights.Num(); ++i)
    {
        Sum += FMath::Max(0.0f, Vehicle->ZoneShatterWeights[i]);
    }
    for (int32 i = 0; i < kNumWheels; ++i)
    {
        if (Vehicle->WheelDetached.IsValidIndex(i) && Vehicle->WheelDetached[i]) Sum += 1.0f;
        if (Vehicle->TyrePunctured.IsValidIndex(i) && Vehicle->TyrePunctured[i]) Sum += 0.5f;
        if (Vehicle->BrakeLineRuptured.IsValidIndex(i) && Vehicle->BrakeLineRuptured[i]) Sum += 0.5f;
        if (Vehicle->HalfshaftBroken.IsValidIndex(i) && Vehicle->HalfshaftBroken[i]) Sum += 0.5f;
    }
    Sum += FMath::Max(0.0f, Vehicle->CoolantLeak01)
         + FMath::Max(0.0f, Vehicle->OilLeak01)
         + FMath::Max(0.0f, Vehicle->FuelLeak01);
    return Sum;
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

void UOpenGridDamageComponent::ApplyScratchAndShatterMaterials() const
{
    if (BodyPaintMaterials.Num() == 0) return;

    float MaxScratch = 0.0f;
    for (int32 i = 0; i < kNumScratchNodes && i < CurrentPaintScratchWeights.Num(); ++i)
    {
        MaxScratch = FMath::Max(MaxScratch, CurrentPaintScratchWeights[i]);
    }

    for (const TObjectPtr<UMaterialInstanceDynamic>& Mat : BodyPaintMaterials)
    {
        if (!Mat) continue;

        for (int32 i = 0; i < kNumScratchNodes && i < CurrentPaintScratchWeights.Num(); ++i)
        {
            Mat->SetScalarParameterValue(kMatScratchParams[i], CurrentPaintScratchWeights[i]);
        }
        Mat->SetScalarParameterValue(kMatPaintScratchMax, MaxScratch);

        for (int32 z = 0; z < kNumShatterZones && z < CurrentZoneShatterWeights.Num(); ++z)
        {
            Mat->SetScalarParameterValue(kMatShatterParams[z], CurrentZoneShatterWeights[z]);
        }
    }
}

void UOpenGridDamageComponent::TriggerCarbonSplinterBurst(EOpenGridDamageZone Zone, float Intensity)
{
    if (CarbonSplinterComponents_.Num() == 0) return;
    AActor* Owner = GetOwner();
    if (!Owner) return;

    UNiagaraComponent* Splinter = CarbonSplinterComponents_[NextSplinterPoolIndex_ % CarbonSplinterComponents_.Num()];
    NextSplinterPoolIndex_ = (NextSplinterPoolIndex_ + 1) % CarbonSplinterComponents_.Num();
    if (!Splinter) return;

    const FTransform OwnerTx = Owner->GetActorTransform();
    const FVector WorldLoc = OwnerTx.TransformPosition(ZoneLocalOffsetCm(Zone));
    const FVector WorldNormal = OwnerTx.TransformVectorNoScale(ZoneLocalNormal(Zone)).GetSafeNormal();
    const FRotator BurstRot = FRotationMatrix::MakeFromZ(WorldNormal).Rotator();

    const float Clamped = FMath::Clamp(Intensity, 0.15f, 1.5f);
    Splinter->SetWorldLocationAndRotation(WorldLoc, BurstRot);
    Splinter->SetVariableFloat(kParamSpawnRate, Clamped);
    Splinter->SetVariableFloat(kParamSplinterIntensity, Clamped);
    Splinter->Activate(true);
}

void UOpenGridDamageComponent::UpdatePaintScratchesAndShatter(const UOpenGridVehicleComponent* Vehicle)
{
    if (!Vehicle) return;

    EnsureBodyPaintMaterials();

    if (CurrentPaintScratchWeights.Num() != kNumScratchNodes)
    {
        CurrentPaintScratchWeights.SetNumZeroed(kNumScratchNodes);
    }
    if (CurrentZoneShatterWeights.Num() != kNumShatterZones)
    {
        CurrentZoneShatterWeights.SetNumZeroed(kNumShatterZones);
    }

    bool bMaterialDirty = false;
    const int32 ScratchCount = FMath::Min(kNumScratchNodes, Vehicle->PaintScratchWeights.Num());
    for (int32 i = 0; i < ScratchCount; ++i)
    {
        const float NewScratch = FMath::Clamp(Vehicle->PaintScratchWeights[i], 0.0f, 1.0f);
        if (FMath::Abs(NewScratch - CurrentPaintScratchWeights[i]) > 1e-4f)
        {
            CurrentPaintScratchWeights[i] = NewScratch;
            bMaterialDirty = true;
        }
    }

    const int32 ShatterCount = FMath::Min(kNumShatterZones, Vehicle->ZoneShatterWeights.Num());
    for (int32 z = 0; z < ShatterCount; ++z)
    {
        const float NewShatter = FMath::Clamp(Vehicle->ZoneShatterWeights[z], 0.0f, 1.0f);
        if (FMath::Abs(NewShatter - CurrentZoneShatterWeights[z]) > 1e-4f)
        {
            CurrentZoneShatterWeights[z] = NewShatter;
            bMaterialDirty = true;
        }

        const float ShatterDelta = NewShatter - LastShatterBurstWeight_[z];
        if (ShatterDelta >= ShatterBurstDeltaThreshold)
        {
            LastShatterBurstWeight_[z] = NewShatter;
            const EOpenGridDamageZone ZoneEnum = static_cast<EOpenGridDamageZone>(z);
            TriggerCarbonSplinterBurst(ZoneEnum, FMath::Clamp(ShatterDelta * 3.0f + NewShatter * 0.45f, 0.25f, 1.5f));
            OnZoneShatter.Broadcast(ZoneEnum, NewShatter, ShatterDelta);
        }
        else if (NewShatter < LastShatterBurstWeight_[z])
        {
            LastShatterBurstWeight_[z] = NewShatter;
        }
    }

    if (bMaterialDirty)
    {
        ApplyScratchAndShatterMaterials();
    }
}

void UOpenGridDamageComponent::UpdateWheelAndMechanicalFailures(const UOpenGridVehicleComponent* Vehicle)
{
    if (!Vehicle) return;

    if (WheelDetachedStates.Num() != kNumWheels) WheelDetachedStates.Init(false, kNumWheels);
    if (WheelRotorSparkIntensity.Num() != kNumWheels) WheelRotorSparkIntensity.SetNumZeroed(kNumWheels);
    if (TyrePuncturedStates.Num() != kNumWheels) TyrePuncturedStates.Init(false, kNumWheels);
    if (BrakeLineRupturedStates.Num() != kNumWheels) BrakeLineRupturedStates.Init(false, kNumWheels);
    if (HalfshaftBrokenStates.Num() != kNumWheels) HalfshaftBrokenStates.Init(false, kNumWheels);

    const float SpeedKmh = FMath::Max(0.0f, Vehicle->SpeedKmh);
    const float SpeedMps = SpeedKmh / 3.6f;
    const AActor* Owner = GetOwner();
    const FVector OwnerVelCms = Owner ? Owner->GetVelocity() : FVector::ZeroVector;
    const FVector OwnerUp = Owner ? Owner->GetActorUpVector() : FVector::UpVector;

    int32 GroundedCount = 0;
    for (int32 i = 0; i < kNumWheels && i < Vehicle->WheelStates.Num(); ++i)
    {
        if (Vehicle->WheelStates[i].bInContact)
        {
            ++GroundedCount;
        }
    }

    for (int32 i = 0; i < kNumWheels; ++i)
    {
        // 1. Per-wheel detachment: hide wheel mesh & drive bare-rotor-on-asphalt spark emitter state.
        const bool bDetached = Vehicle->WheelDetached.IsValidIndex(i) && Vehicle->WheelDetached[i];
        const bool bWasDetached = WheelDetachedStates[i];
        WheelDetachedStates[i] = bDetached;

        FVector HubWorldLoc = Owner ? Owner->GetActorLocation() : FVector::ZeroVector;
        bool bCornerGrounded = (GroundedCount > 0);
        if (Vehicle->WheelStates.IsValidIndex(i))
        {
            const FOpenGridWheelState& WS = Vehicle->WheelStates[i];
            HubWorldLoc = !WS.ContactPointWorldCm.IsNearlyZero() ? WS.ContactPointWorldCm : WS.WorldCenterCm;
            bCornerGrounded = WS.bInContact || (GroundedCount > 0);
        }
        else if (Vehicle->WheelCentresWorld.IsValidIndex(i))
        {
            HubWorldLoc = Vehicle->WheelCentresWorld[i];
        }

        if (bDetached && !bWasDetached)
        {
            if (WheelMeshes_.IsValidIndex(i))
            {
                if (UStaticMeshComponent* WheelMesh = WheelMeshes_[i].Get())
                {
                    WheelMesh->SetVisibility(false, true);
                }
            }
            UE_LOG(LogOpenGridDamage, Log, TEXT("Wheel %d detached onto bare rotor"), i);
            OnWheelDetached.Broadcast(i, HubWorldLoc);
            OnMechanicalFailure.Broadcast(i, kFailureWheelDetached);
        }
        else if (!bDetached && bWasDetached)
        {
            if (WheelMeshes_.IsValidIndex(i))
            {
                if (UStaticMeshComponent* WheelMesh = WheelMeshes_[i].Get())
                {
                    WheelMesh->SetVisibility(true, true);
                }
            }
        }
        else if (bDetached && WheelMeshes_.IsValidIndex(i))
        {
            if (UStaticMeshComponent* WheelMesh = WheelMeshes_[i].Get(); WheelMesh && WheelMesh->IsVisible())
            {
                WheelMesh->SetVisibility(false, true);
            }
        }

        const float RotorSparks = (bDetached && bCornerGrounded && SpeedKmh > 2.0f)
            ? FMath::Clamp((SpeedKmh - 2.0f) / 65.0f, 0.0f, 1.0f)
            : 0.0f;
        WheelRotorSparkIntensity[i] = RotorSparks;

        if (RotorSparkComponents_.IsValidIndex(i) && RotorSparkComponents_[i])
        {
            UNiagaraComponent* Spark = RotorSparkComponents_[i];
            if (RotorSparks > 0.02f)
            {
                const FVector TangentialVel = OwnerVelCms - FVector::DotProduct(OwnerVelCms, OwnerUp) * OwnerUp;
                const FVector SparkVelocity = (-TangentialVel * 0.65f) + (OwnerUp * (180.0f + 360.0f * RotorSparks));
                Spark->SetWorldLocation(HubWorldLoc);
                Spark->SetVariableFloat(kParamSpawnRate, RotorSparks);
                Spark->SetVariableFloat(kParamVehicleSpeedMps, SpeedMps);
                Spark->SetVariableVec3(kParamSparkVelocity, SparkVelocity);
            }
            else
            {
                Spark->SetVariableFloat(kParamSpawnRate, 0.0f);
            }
            SetDamageEmitterActive(Spark, RotorSparks > 0.02f);
        }

        // 2. Impact-induced tyre puncture / blowout.
        const bool bPunctured = Vehicle->TyrePunctured.IsValidIndex(i) && Vehicle->TyrePunctured[i];
        if (bPunctured && !TyrePuncturedStates[i])
        {
            OnTyrePunctured.Broadcast(i);
            OnMechanicalFailure.Broadcast(i, kFailureTyrePunctured);
        }
        TyrePuncturedStates[i] = bPunctured;

        // 3. Ruptured hydraulic brake line.
        const bool bBrakeLine = Vehicle->BrakeLineRuptured.IsValidIndex(i) && Vehicle->BrakeLineRuptured[i];
        if (bBrakeLine && !BrakeLineRupturedStates[i])
        {
            OnMechanicalFailure.Broadcast(i, kFailureBrakeLineRuptured);
        }
        BrakeLineRupturedStates[i] = bBrakeLine;

        // 4. Snapped CV halfshaft.
        const bool bHalfshaft = Vehicle->HalfshaftBroken.IsValidIndex(i) && Vehicle->HalfshaftBroken[i];
        if (bHalfshaft && !HalfshaftBrokenStates[i])
        {
            OnMechanicalFailure.Broadcast(i, kFailureHalfshaftBroken);
        }
        HalfshaftBrokenStates[i] = bHalfshaft;
    }
}

void UOpenGridDamageComponent::UpdateFluidLeaks(float DeltaTime, const UOpenGridVehicleComponent* Vehicle)
{
    if (!Vehicle || DeltaTime <= 0.0f) return;

    const FOpenGridFluidLeakState Prev = FluidLeakState;
    const float SpeedMps = FMath::Max(0.0f, Vehicle->SpeedKmh / 3.6f);

    const float CoolantLeak = FMath::Clamp(Vehicle->CoolantLeak01, 0.0f, 1.0f);
    const float CoolantLevel = FMath::Clamp(Vehicle->CoolantLevel01, 0.0f, 1.0f);
    const float CoolantDrip = FMath::Max(0.0f, Vehicle->CoolantDripLps);

    const float OilLeak = FMath::Clamp(Vehicle->OilLeak01, 0.0f, 1.0f);
    const float OilLevel = FMath::Clamp(Vehicle->OilLevel01, 0.0f, 1.0f);
    const float OilDrip = FMath::Max(0.0f, Vehicle->OilDripLps);

    const float FuelLeak = FMath::Clamp(Vehicle->FuelLeak01, 0.0f, 1.0f);
    const float FuelDrip = FMath::Max(0.0f, Vehicle->FuelDripLps);

    auto ComputeEmitterRate = [this](float Leak01, float DripLps, float RemainingLevel01) -> float
    {
        if ((Leak01 <= 0.005f && DripLps <= 1e-4f) || RemainingLevel01 <= 0.001f)
        {
            return 0.0f;
        }
        const float EffectiveIntensity = FMath::Max(Leak01 * 0.35f, FMath::Clamp(DripLps * 6.0f, 0.0f, 1.5f));
        return EffectiveIntensity * FluidEmitterRateScale;
    };

    FluidLeakState.CoolantLeak01 = CoolantLeak;
    FluidLeakState.CoolantLevel01 = CoolantLevel;
    FluidLeakState.CoolantDripLps = CoolantDrip;
    FluidLeakState.CoolantEmitterRate = ComputeEmitterRate(CoolantLeak, CoolantDrip, CoolantLevel);

    FluidLeakState.OilLeak01 = OilLeak;
    FluidLeakState.OilLevel01 = OilLevel;
    FluidLeakState.OilDripLps = OilDrip;
    FluidLeakState.OilEmitterRate = ComputeEmitterRate(OilLeak, OilDrip, OilLevel);

    FluidLeakState.FuelLeak01 = FuelLeak;
    FluidLeakState.FuelDripLps = FuelDrip;
    const float FuelHasVolume = (Vehicle->FuelLiters > 0.05f) ? 1.0f : 0.0f;
    FluidLeakState.FuelEmitterRate = ComputeEmitterRate(FuelLeak, FuelDrip, FuelHasVolume);

    FluidLeakState.bAnyFluidLeaking =
        (FluidLeakState.CoolantEmitterRate > 0.01f) ||
        (FluidLeakState.OilEmitterRate > 0.01f) ||
        (FluidLeakState.FuelEmitterRate > 0.01f);

    auto DriveFluidEmitter = [SpeedMps](UNiagaraComponent* Comp, float Rate, float Leak01, float DripLps)
    {
        if (!Comp) return;
        Comp->SetVariableFloat(kParamSpawnRate, Rate);
        Comp->SetVariableFloat(kParamLeakIntensity, Leak01);
        Comp->SetVariableFloat(kParamDripLps, DripLps);
        Comp->SetVariableFloat(kParamVehicleSpeedMps, SpeedMps);
        SetDamageEmitterActive(Comp, Rate > 0.05f);
    };

    DriveFluidEmitter(CoolantLeakComponent_.Get(), FluidLeakState.CoolantEmitterRate, CoolantLeak, CoolantDrip);
    DriveFluidEmitter(OilLeakComponent_.Get(), FluidLeakState.OilEmitterRate, OilLeak, OilDrip);
    DriveFluidEmitter(FuelLeakComponent_.Get(), FluidLeakState.FuelEmitterRate, FuelLeak, FuelDrip);

    const bool bLeakStateChanged =
        FluidLeakState.bAnyFluidLeaking != Prev.bAnyFluidLeaking ||
        FMath::Abs(FluidLeakState.CoolantLeak01 - Prev.CoolantLeak01) > 1e-3f ||
        FMath::Abs(FluidLeakState.CoolantDripLps - Prev.CoolantDripLps) > 1e-4f ||
        FMath::Abs(FluidLeakState.OilLeak01 - Prev.OilLeak01) > 1e-3f ||
        FMath::Abs(FluidLeakState.OilDripLps - Prev.OilDripLps) > 1e-4f ||
        FMath::Abs(FluidLeakState.FuelLeak01 - Prev.FuelLeak01) > 1e-3f ||
        FMath::Abs(FluidLeakState.FuelDripLps - Prev.FuelDripLps) > 1e-4f;

    if (bLeakStateChanged)
    {
        OnFluidLeakUpdated.Broadcast(FluidLeakState);
    }

    // Accumulate spilled liters per fluid and fire road-puddle / slick decal drops cleanly.
    const AActor* Owner = GetOwner();
    if (Owner && FluidPuddleDripThresholdLiters > 0.0f)
    {
        const FTransform OwnerTx = Owner->GetActorTransform();
        auto StepPuddleAccumulator = [&](int32 FluidIdx, EOpenGridFluidType FluidType,
                                         float DripLps, float Leak01, float EmitterRate,
                                         const FVector& LocalOffset)
        {
            if (EmitterRate <= 0.01f)
            {
                FluidPuddleAccumLiters_[FluidIdx] = 0.0f;
                return;
            }
            const float EffectiveLps = (DripLps > 1e-4f) ? DripLps : (Leak01 * 0.04f);
            FluidPuddleAccumLiters_[FluidIdx] += EffectiveLps * DeltaTime;
            if (FluidPuddleAccumLiters_[FluidIdx] >= FluidPuddleDripThresholdLiters)
            {
                FluidPuddleAccumLiters_[FluidIdx] = FMath::Fmod(FluidPuddleAccumLiters_[FluidIdx], FluidPuddleDripThresholdLiters);
                const FVector WorldLoc = OwnerTx.TransformPosition(LocalOffset);
                OnFluidPuddleDrop.Broadcast(FluidType, WorldLoc, DripLps, Leak01);
            }
        };

        StepPuddleAccumulator(0, EOpenGridFluidType::Coolant, CoolantDrip, CoolantLeak, FluidLeakState.CoolantEmitterRate, CoolantLeakLocalOffsetCm);
        StepPuddleAccumulator(1, EOpenGridFluidType::Oil,     OilDrip,     OilLeak,     FluidLeakState.OilEmitterRate,     OilLeakLocalOffsetCm);
        StepPuddleAccumulator(2, EOpenGridFluidType::Fuel,    FuelDrip,    FuelLeak,    FluidLeakState.FuelEmitterRate,    FuelLeakLocalOffsetCm);
    }
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
    PreviousTotalDamageSignal_ = 0.0f;
    ApplyMorphWeightsToMesh(CurrentMorphWeights);

    CurrentPaintScratchWeights.Init(0.0f, kNumScratchNodes);
    CurrentZoneShatterWeights.Init(0.0f, kNumShatterZones);
    for (int32 z = 0; z < kNumShatterZones; ++z)
    {
        LastShatterBurstWeight_[z] = 0.0f;
    }
    ApplyScratchAndShatterMaterials();

    WheelDetachedStates.Init(false, kNumWheels);
    WheelRotorSparkIntensity.Init(0.0f, kNumWheels);
    TyrePuncturedStates.Init(false, kNumWheels);
    BrakeLineRupturedStates.Init(false, kNumWheels);
    HalfshaftBrokenStates.Init(false, kNumWheels);

    for (int32 i = 0; i < kNumWheels; ++i)
    {
        if (WheelMeshes_.IsValidIndex(i))
        {
            if (UStaticMeshComponent* WheelMesh = WheelMeshes_[i].Get())
            {
                WheelMesh->SetVisibility(true, true);
            }
        }
        if (RotorSparkComponents_.IsValidIndex(i) && RotorSparkComponents_[i])
        {
            RotorSparkComponents_[i]->SetVariableFloat(kParamSpawnRate, 0.0f);
            SetDamageEmitterActive(RotorSparkComponents_[i].Get(), false);
        }
    }

    FluidLeakState = FOpenGridFluidLeakState{};
    for (int32 f = 0; f < 3; ++f)
    {
        FluidPuddleAccumLiters_[f] = 0.0f;
    }
    if (CoolantLeakComponent_)
    {
        CoolantLeakComponent_->SetVariableFloat(kParamSpawnRate, 0.0f);
        SetDamageEmitterActive(CoolantLeakComponent_.Get(), false);
    }
    if (OilLeakComponent_)
    {
        OilLeakComponent_->SetVariableFloat(kParamSpawnRate, 0.0f);
        SetDamageEmitterActive(OilLeakComponent_.Get(), false);
    }
    if (FuelLeakComponent_)
    {
        FuelLeakComponent_->SetVariableFloat(kParamSpawnRate, 0.0f);
        SetDamageEmitterActive(FuelLeakComponent_.Get(), false);
    }

    for (FOpenGridDetachablePart& Part : DetachableParts)
    {
        ReattachPart(Part);
    }
    OnCrushUpdated.Broadcast(CurrentMorphWeights);
    OnFluidLeakUpdated.Broadcast(FluidLeakState);
}

void UOpenGridDamageComponent::BeginRepairAfterVehicleService()
{
    for (int32 i = 0; i < 6; ++i)
    {
        ExtraZoneDamage_[i] = 0.0f;
    }
    bRepairPending_ = true;
    RepairPendingSeconds_ = 0.0f;
}

void UOpenGridDamageComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
    Super::TickComponent(DeltaTime, TickType, ThisTickFunction);

    if (!Vehicle_.IsValid() || !DeformableBodyMesh_.IsValid())
    {
        ResolveOwnerReferences();
    }
    if (!bDamageVfxInitialized_)
    {
        InitializePooledDamageVfx();
    }

    const UOpenGridVehicleComponent* Vehicle = Vehicle_.Get();
    const FOpenGridCrushMorphWeights Target = SampleTargetMorphWeights();
    const float TotalDamageSignal = ComputeTotalVehicleDamageSignal(Target, Vehicle);

    // A repair was requested but the physics thread has not processed it yet, so the vehicle still reports the old
    // damage. Do not morph, detach or launch anything from that stale damage: wait for it to clear, then repair once.
    if (bRepairPending_)
    {
        RepairPendingSeconds_ += DeltaTime;
        if (TotalDamageSignal <= KINDA_SMALL_NUMBER || RepairPendingSeconds_ >= MaxRepairWaitSeconds)
        {
            bRepairPending_ = false;
            RepairAllDamage();
        }
        return;
    }

    // Detect rs::Vehicle::service() resetting vehicle damage back to 0.
    if (bAutoRepairOnVehicleService && PreviousTotalDamageSignal_ > 0.05f && TotalDamageSignal <= KINDA_SMALL_NUMBER)
    {
        RepairAllDamage();
        return;
    }
    PreviousTotalDamageSignal_ = TotalDamageSignal;

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

    UpdatePaintScratchesAndShatter(Vehicle);
    UpdateWheelAndMechanicalFailures(Vehicle);
    UpdateFluidLeaks(DeltaTime, Vehicle);

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
