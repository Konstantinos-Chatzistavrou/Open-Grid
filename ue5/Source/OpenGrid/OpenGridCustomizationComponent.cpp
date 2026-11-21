// Apache-2.0 — see OpenGridCustomizationComponent.h
#include "OpenGridCustomizationComponent.h"

#include "Components/MeshComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Engine/StaticMesh.h"
#include "GameFramework/Actor.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogOpenGridCustomization, Log, All);

namespace
{
struct FPaintFinishPreset
{
    float Clearcoat = 1.0f;
    float ClearcoatRoughness = 0.020f;
    float Roughness = 0.22f;
    float Metallic = 0.45f;
    float FlakeStrength = 0.18f;
    float FlopStrength = 0.32f;
};

// Mirrors CAR_PAINT_FINISHES in web/src/gpu/materials/carPaint.ts.
FPaintFinishPreset ResolvePaintFinish(const FString& FinishName)
{
    const FString Lower = FinishName.ToLower();
    if (Lower == TEXT("satin"))    return {0.35f, 0.120f, 0.42f, 0.32f, 0.08f, 0.18f};
    if (Lower == TEXT("metallic")) return {1.00f, 0.028f, 0.18f, 0.88f, 0.48f, 0.58f};
    if (Lower == TEXT("pearl"))    return {1.00f, 0.020f, 0.20f, 0.65f, 0.36f, 0.85f};
    if (Lower == TEXT("candy"))    return {1.00f, 0.012f, 0.14f, 0.94f, 0.55f, 0.72f};
    if (Lower == TEXT("matte"))    return {0.04f, 0.500f, 0.72f, 0.15f, 0.00f, 0.06f};
    return {1.00f, 0.020f, 0.22f, 0.45f, 0.18f, 0.32f};   // gloss default
}

void ResolveRimFinish(const FString& RimFinishName, float& OutMetallic, float& OutRoughness)
{
    const FString Lower = RimFinishName.ToLower();
    if (Lower == TEXT("gloss"))      { OutMetallic = 0.55f; OutRoughness = 0.18f; }
    else if (Lower == TEXT("satin")) { OutMetallic = 0.70f; OutRoughness = 0.38f; }
    else if (Lower == TEXT("matte")) { OutMetallic = 0.35f; OutRoughness = 0.70f; }
    else                             { OutMetallic = 1.00f; OutRoughness = 0.05f; }   // chrome default
}

// Arch flare width (m) matching WIDEBODY in web/src/scene/parts/widebody.ts.
float WidebodyArchWidthMeters(const FString& FendersId)
{
    const FString Key = FendersId.ToLower();
    if (Key == TEXT("fender-smooth"))        return 0.022f;
    if (Key == TEXT("fender-plus"))          return 0.038f;
    if (Key == TEXT("fender-wide") || Key == TEXT("widebody_street")) return 0.060f;
    if (Key == TEXT("fender-bolt"))          return 0.070f;
    if (Key == TEXT("fender-rs-louvre"))     return 0.082f;
    if (Key == TEXT("fender-race") || Key == TEXT("widebody_race"))   return 0.086f;
    if (Key == TEXT("fender-integrale-box")) return 0.092f;
    if (Key == TEXT("fender-extreme") || Key == TEXT("widebody_gt"))  return 0.110f;
    return 0.0f;
}

bool IsStockOrEmpty(const FString& Id)
{
    return Id.IsEmpty() || Id.Equals(TEXT("stock"), ESearchCase::IgnoreCase);
}

bool IsNoneId(const FString& Id)
{
    return Id.Equals(TEXT("none"), ESearchCase::IgnoreCase);
}

const FName kSocketWing(TEXT("SOCKET_Wing"));
const FName kSocketSplitter(TEXT("SOCKET_Splitter"));
const FName kSocketDiffuser(TEXT("SOCKET_Diffuser"));
const FName kSocketSkirtL(TEXT("SOCKET_Skirt_L"));
const FName kSocketSkirtR(TEXT("SOCKET_Skirt_R"));
const FName kSocketHood(TEXT("SOCKET_Hood"));
const FName kWheelSockets[4] = {
    FName(TEXT("SOCKET_Wheel_FL")),
    FName(TEXT("SOCKET_Wheel_FR")),
    FName(TEXT("SOCKET_Wheel_RL")),
    FName(TEXT("SOCKET_Wheel_RR")),
};
const FName kMorphWidebodyStreet(TEXT("widebody_street"));
const FName kMorphWidebodyRace(TEXT("widebody_race"));
}  // namespace

UOpenGridCustomizationComponent::UOpenGridCustomizationComponent()
{
    PrimaryComponentTick.bCanEverTick = false;
    PaintMaterialSlotIndices.Add(0);
}

void UOpenGridCustomizationComponent::BeginPlay()
{
    Super::BeginPlay();
    ResolveOwnerMeshes();
    ApplyLook(CurrentLook);
}

void UOpenGridCustomizationComponent::BindPawnMeshes(USkeletalMeshComponent* InDeformableBody,
                                                     UStaticMeshComponent* InStaticBody,
                                                     UStaticMeshComponent* InStockWing,
                                                     const TArray<UStaticMeshComponent*>& InWheels,
                                                     const TArray<UStaticMeshComponent*>& InCalipers)
{
    DeformableBodyMesh_ = InDeformableBody;
    StaticBodyMesh_ = InStaticBody;
    if (InStockWing)
    {
        StockWingMesh = InStockWing;
    }

    WheelMeshes_.Reset();
    for (UStaticMeshComponent* W : InWheels)
    {
        WheelMeshes_.Add(W);
    }

    CaliperMeshes_.Reset();
    for (UStaticMeshComponent* C : InCalipers)
    {
        CaliperMeshes_.Add(C);
    }
}

void UOpenGridCustomizationComponent::ResolveOwnerMeshes()
{
    AActor* Owner = GetOwner();
    if (!Owner) return;

    if (!DeformableBodyMesh_.IsValid())
    {
        DeformableBodyMesh_ = Owner->FindComponentByClass<USkeletalMeshComponent>();
    }

    if (!StaticBodyMesh_.IsValid() || !StockWingMesh)
    {
        TArray<UStaticMeshComponent*> StaticMeshes;
        Owner->GetComponents<UStaticMeshComponent>(StaticMeshes);
        for (UStaticMeshComponent* SM : StaticMeshes)
        {
            if (!SM) continue;
            const FString CompName = SM->GetName();
            if (!StaticBodyMesh_.IsValid() && CompName.Contains(TEXT("BodyMesh")))
            {
                StaticBodyMesh_ = SM;
            }
            if (!StockWingMesh && (CompName.Equals(TEXT("StockWingMesh"), ESearchCase::IgnoreCase) ||
                                   CompName.Equals(TEXT("stock_wing"), ESearchCase::IgnoreCase)))
            {
                StockWingMesh = SM;
            }
        }
    }
}

USceneComponent* UOpenGridCustomizationComponent::GetAttachmentRoot() const
{
    if (USkeletalMeshComponent* Skel = DeformableBodyMesh_.Get())
    {
        if (Skel->GetSkeletalMeshAsset() && Skel->IsVisible())
        {
            return Skel;
        }
    }
    if (UStaticMeshComponent* Static = StaticBodyMesh_.Get())
    {
        return Static;
    }
    if (AActor* Owner = GetOwner())
    {
        return Owner->GetRootComponent();
    }
    return nullptr;
}

UMeshComponent* UOpenGridCustomizationComponent::GetActiveBodyMesh() const
{
    if (USkeletalMeshComponent* Skel = DeformableBodyMesh_.Get())
    {
        if (Skel->GetSkeletalMeshAsset() && Skel->IsVisible())
        {
            return Skel;
        }
    }
    return StaticBodyMesh_.Get();
}

UStaticMesh* UOpenGridCustomizationComponent::ResolvePartMesh(const FString& PartId, const TCHAR* Suffix) const
{
    if (IsStockOrEmpty(PartId) || IsNoneId(PartId)) return nullptr;

    if (Suffix && Suffix[0] != TEXT('\0'))
    {
        const FName SuffixedKey(*(PartId + Suffix));
        if (const TSoftObjectPtr<UStaticMesh>* Found = PartMeshRegistry.Find(SuffixedKey))
        {
            return Found->LoadSynchronous();
        }
    }

    const FName DirectKey(*PartId);
    if (const TSoftObjectPtr<UStaticMesh>* Found = PartMeshRegistry.Find(DirectKey))
    {
        return Found->LoadSynchronous();
    }
    return nullptr;
}

UStaticMeshComponent* UOpenGridCustomizationComponent::GetOrCreatePartComponent(
    TObjectPtr<UStaticMeshComponent>& Slot, FName ComponentName)
{
    if (Slot) return Slot.Get();
    AActor* Owner = GetOwner();
    if (!Owner) return nullptr;

    UStaticMeshComponent* Comp = NewObject<UStaticMeshComponent>(Owner, ComponentName);
    if (!Comp) return nullptr;

    Comp->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    Comp->SetGenerateOverlapEvents(false);
    Comp->SetVisibility(false);
    Comp->RegisterComponent();
    Slot = Comp;
    return Comp;
}

void UOpenGridCustomizationComponent::ApplySocketPart(TObjectPtr<UStaticMeshComponent>& Slot,
                                                      FName ComponentName,
                                                      FName SocketName,
                                                      const FString& PartId,
                                                      const TCHAR* Suffix)
{
    UStaticMesh* MeshAsset = ResolvePartMesh(PartId, Suffix);
    if (!MeshAsset)
    {
        if (Slot)
        {
            Slot->SetStaticMesh(nullptr);
            Slot->SetVisibility(false);
        }
        return;
    }

    UStaticMeshComponent* Comp = GetOrCreatePartComponent(Slot, ComponentName);
    if (!Comp) return;

    USceneComponent* Parent = GetAttachmentRoot();
    if (Parent)
    {
        const FName EffectiveSocket = (SocketName != NAME_None && Parent->DoesSocketExist(SocketName))
                                          ? SocketName
                                          : NAME_None;
        Comp->AttachToComponent(Parent, FAttachmentTransformRules::SnapToTargetNotIncludingScale, EffectiveSocket);
    }

    Comp->SetStaticMesh(MeshAsset);
    Comp->SetRelativeLocation(FVector::ZeroVector);
    Comp->SetRelativeRotation(FRotator::ZeroRotator);
    Comp->SetRelativeScale3D(FVector::OneVector);
    Comp->SetVisibility(true);
}

void UOpenGridCustomizationComponent::ApplyRimParts(const FString& RimsId)
{
    UStaticMesh* RimMesh = ResolvePartMesh(RimsId);
    const bool bUseCustomRims = (RimMesh != nullptr);

    if (RimPartMeshes_.Num() < 4)
    {
        RimPartMeshes_.SetNum(4);
    }

    USceneComponent* BodyRoot = GetAttachmentRoot();
    static const TCHAR* RimCompNames[4] = {
        TEXT("CustomRimFL"), TEXT("CustomRimFR"), TEXT("CustomRimRL"), TEXT("CustomRimRR")
    };

    for (int32 i = 0; i < 4; ++i)
    {
        UStaticMeshComponent* WheelComp = WheelMeshes_.IsValidIndex(i) ? WheelMeshes_[i].Get() : nullptr;

        if (!bUseCustomRims)
        {
            if (RimPartMeshes_[i])
            {
                RimPartMeshes_[i]->SetStaticMesh(nullptr);
                RimPartMeshes_[i]->SetVisibility(false);
            }
            if (WheelComp)
            {
                WheelComp->SetVisibility(true);
            }
            continue;
        }

        UStaticMeshComponent* RimComp = GetOrCreatePartComponent(RimPartMeshes_[i], FName(RimCompNames[i]));
        if (!RimComp) continue;

        // Prefer attaching to the live spinning wheel component so custom rims spin & steer with physics;
        // fall back to SOCKET_Wheel_FL..RR on the body mesh for static garage/showcase actors.
        USceneComponent* AttachParent = WheelComp ? static_cast<USceneComponent*>(WheelComp) : BodyRoot;
        if (AttachParent)
        {
            const FName SocketName = AttachParent->DoesSocketExist(kWheelSockets[i]) ? kWheelSockets[i] : NAME_None;
            RimComp->AttachToComponent(AttachParent, FAttachmentTransformRules::SnapToTargetNotIncludingScale, SocketName);
        }

        RimComp->SetStaticMesh(RimMesh);
        RimComp->SetRelativeLocation(FVector::ZeroVector);
        RimComp->SetRelativeRotation(FRotator::ZeroRotator);
        RimComp->SetRelativeScale3D(FVector::OneVector);
        RimComp->SetVisibility(true);
    }
}

void UOpenGridCustomizationComponent::ApplyWidebodyMorphs(const FString& FendersId)
{
    USkeletalMeshComponent* Skel = DeformableBodyMesh_.Get();
    if (!Skel || !Skel->GetSkeletalMeshAsset()) return;

    float StreetWeight = 0.0f;
    float RaceWeight = 0.0f;
    const FString Key = FendersId.ToLower();

    if (Key == TEXT("fender-smooth"))
    {
        StreetWeight = 0.40f;
    }
    else if (Key == TEXT("fender-plus"))
    {
        StreetWeight = 0.70f;
    }
    else if (Key == TEXT("fender-wide") || Key == TEXT("widebody_street"))
    {
        StreetWeight = 1.00f;
    }
    else if (Key == TEXT("fender-bolt"))
    {
        StreetWeight = 1.00f;
        RaceWeight = 0.25f;
    }
    else if (Key == TEXT("fender-rs-louvre"))
    {
        RaceWeight = 0.90f;
    }
    else if (Key == TEXT("fender-race") || Key == TEXT("widebody_race") ||
             Key == TEXT("fender-integrale-box") || Key == TEXT("fender-extreme") || Key == TEXT("widebody_gt"))
    {
        RaceWeight = 1.00f;
    }

    Skel->SetMorphTarget(kMorphWidebodyStreet, StreetWeight);
    Skel->SetMorphTarget(kMorphWidebodyRace, RaceWeight);
}

UMaterialInstanceDynamic* UOpenGridCustomizationComponent::GetOrCreateDynamicMaterial(UMeshComponent* Mesh, int32 SlotIndex)
{
    if (!Mesh || SlotIndex < 0 || SlotIndex >= Mesh->GetNumMaterials()) return nullptr;
    if (UMaterialInstanceDynamic* Existing = Cast<UMaterialInstanceDynamic>(Mesh->GetMaterial(SlotIndex)))
    {
        return Existing;
    }
    return Mesh->CreateAndSetMaterialInstanceDynamic(SlotIndex);
}

void UOpenGridCustomizationComponent::ApplyMaterialParameters()
{
    PaintMaterials_.Reset();
    AeroMaterials_.Reset();
    RimMaterials_.Reset();
    CaliperMaterials_.Reset();

    const FLinearColor BaseColor = ParseHexColor(CurrentLook.PaintHex, FLinearColor(0.53f, 0.01f, 0.01f, 1.0f));
    const FLinearColor LiveryColor = ParseHexColor(CurrentLook.LiveryColorHex, FLinearColor::White);
    const bool bGlowEnabled = !CurrentLook.UnderglowHex.IsEmpty();
    const FLinearColor UnderglowColor = bGlowEnabled
                                            ? ParseHexColor(CurrentLook.UnderglowHex, FLinearColor::Black)
                                            : FLinearColor::Black;
    const FPaintFinishPreset Finish = ResolvePaintFinish(CurrentLook.Finish);

    auto UpdatePaintMid = [&](UMeshComponent* Mesh)
    {
        if (!Mesh) return;
        const TArray<int32>& Slots = PaintMaterialSlotIndices;
        if (Slots.Num() == 0)
        {
            if (UMaterialInstanceDynamic* Mid = GetOrCreateDynamicMaterial(Mesh, 0))
            {
                PaintMaterials_.AddUnique(Mid);
            }
        }
        else
        {
            for (int32 SlotIdx : Slots)
            {
                if (UMaterialInstanceDynamic* Mid = GetOrCreateDynamicMaterial(Mesh, SlotIdx))
                {
                    PaintMaterials_.AddUnique(Mid);
                }
            }
        }
    };

    UpdatePaintMid(DeformableBodyMesh_.Get());
    UpdatePaintMid(StaticBodyMesh_.Get());
    UpdatePaintMid(HoodPartMesh_.Get());

    for (UMaterialInstanceDynamic* Mid : PaintMaterials_)
    {
        if (!Mid) continue;
        Mid->SetVectorParameterValue(TEXT("BaseColor"), BaseColor);
        Mid->SetVectorParameterValue(TEXT("LiveryColor"), LiveryColor);
        Mid->SetVectorParameterValue(TEXT("UnderglowColor"), UnderglowColor);

        Mid->SetScalarParameterValue(TEXT("Clearcoat"), Finish.Clearcoat);
        Mid->SetScalarParameterValue(TEXT("ClearcoatRoughness"), Finish.ClearcoatRoughness);
        Mid->SetScalarParameterValue(TEXT("Roughness"), Finish.Roughness);
        Mid->SetScalarParameterValue(TEXT("Metallic"), Finish.Metallic);
        Mid->SetScalarParameterValue(TEXT("FlakeStrength"), Finish.FlakeStrength);
        Mid->SetScalarParameterValue(TEXT("FlopStrength"), Finish.FlopStrength);
        Mid->SetScalarParameterValue(TEXT("LiveryStyle"), static_cast<float>(FMath::Clamp(CurrentLook.Livery, 0, 4)));
        Mid->SetScalarParameterValue(TEXT("DirtWear"), FMath::Clamp(DirtWear, 0.0f, 1.0f));
        Mid->SetScalarParameterValue(TEXT("ScuffWear"), FMath::Clamp(ScuffWear, 0.0f, 1.0f));
        Mid->SetScalarParameterValue(TEXT("UnderglowStrength"), bGlowEnabled ? 1.0f : 0.0f);
        Mid->SetScalarParameterValue(TEXT("WindowTint"), static_cast<float>(FMath::Clamp(CurrentLook.WindowTint, 0, 2)));
        Mid->SetScalarParameterValue(TEXT("SmokedTails"), CurrentLook.SmokedTails ? 1.0f : 0.0f);
    }

    // Aero modular parts material parameters (carbon / gloss / matte / body colour)
    const FString AeroLower = CurrentLook.AeroFinish.ToLower();
    FLinearColor AeroColor(0.04f, 0.045f, 0.05f, 1.0f);
    float AeroRoughness = 0.28f;
    float AeroMetallic = 0.20f;
    float AeroFlat = 0.0f;
    if (AeroLower == TEXT("gloss"))      { AeroRoughness = 0.14f; AeroFlat = 1.0f; }
    else if (AeroLower == TEXT("matte")) { AeroRoughness = 0.65f; AeroFlat = 1.0f; }
    else if (AeroLower == TEXT("body"))  { AeroColor = BaseColor; AeroRoughness = Finish.Roughness; AeroMetallic = Finish.Metallic; AeroFlat = 1.0f; }

    UStaticMeshComponent* AeroParts[] = {
        WingPartMesh_.Get(), SplitterPartMesh_.Get(), DiffuserPartMesh_.Get(),
        SkirtLeftPartMesh_.Get(), SkirtRightPartMesh_.Get()
    };
    for (UStaticMeshComponent* Part : AeroParts)
    {
        if (!Part || !Part->IsVisible()) continue;
        if (UMaterialInstanceDynamic* Mid = GetOrCreateDynamicMaterial(Part, 0))
        {
            Mid->SetVectorParameterValue(TEXT("BaseColor"), AeroColor);
            Mid->SetScalarParameterValue(TEXT("Roughness"), AeroRoughness);
            Mid->SetScalarParameterValue(TEXT("Metallic"), AeroMetallic);
            Mid->SetScalarParameterValue(TEXT("AeroFlat"), AeroFlat);
            AeroMaterials_.Add(Mid);
        }
    }

    // Rim colour & finish
    const FLinearColor RimColor = ParseHexColor(CurrentLook.RimColorHex, FLinearColor(0.32f, 0.35f, 0.40f, 1.0f));
    float RimMetallic = 1.0f;
    float RimRoughness = 0.05f;
    ResolveRimFinish(CurrentLook.RimFinish, RimMetallic, RimRoughness);

    auto UpdateRimComp = [&](UStaticMeshComponent* RimComp)
    {
        if (!RimComp || !RimComp->IsVisible()) return;
        if (UMaterialInstanceDynamic* Mid = GetOrCreateDynamicMaterial(RimComp, 0))
        {
            Mid->SetVectorParameterValue(TEXT("BaseColor"), RimColor);
            Mid->SetScalarParameterValue(TEXT("Metallic"), RimMetallic);
            Mid->SetScalarParameterValue(TEXT("Roughness"), RimRoughness);
            RimMaterials_.Add(Mid);
        }
    };
    for (TObjectPtr<UStaticMeshComponent>& RimComp : RimPartMeshes_) UpdateRimComp(RimComp.Get());
    for (const TWeakObjectPtr<UStaticMeshComponent>& WheelComp : WheelMeshes_) UpdateRimComp(WheelComp.Get());

    // Brake caliper colour
    const FLinearColor CaliperColor = ParseHexColor(CurrentLook.CaliperHex, FLinearColor(0.53f, 0.01f, 0.01f, 1.0f));
    for (const TWeakObjectPtr<UStaticMeshComponent>& CaliperWeak : CaliperMeshes_)
    {
        if (UStaticMeshComponent* CaliperComp = CaliperWeak.Get())
        {
            if (UMaterialInstanceDynamic* Mid = GetOrCreateDynamicMaterial(CaliperComp, 0))
            {
                Mid->SetVectorParameterValue(TEXT("BaseColor"), CaliperColor);
                CaliperMaterials_.Add(Mid);
            }
        }
    }
}

void UOpenGridCustomizationComponent::ApplyLook(const FOpenGridCarLook& Look)
{
    CurrentLook = Look;
    CurrentLook.Livery = FMath::Clamp(CurrentLook.Livery, 0, 4);
    CurrentLook.WindowTint = FMath::Clamp(CurrentLook.WindowTint, 0, 2);

    ResolveOwnerMeshes();

    // Hide StockWingMesh when a custom wing or "none" is selected; show it for "stock".
    const bool bKeepStockWing = IsStockOrEmpty(CurrentLook.WingId);
    if (StockWingMesh)
    {
        StockWingMesh->SetVisibility(bKeepStockWing);
    }

    ApplySocketPart(WingPartMesh_, TEXT("CustomWingMesh"), kSocketWing, CurrentLook.WingId);
    ApplySocketPart(SplitterPartMesh_, TEXT("CustomSplitterMesh"), kSocketSplitter, CurrentLook.SplitterId);
    ApplySocketPart(DiffuserPartMesh_, TEXT("CustomDiffuserMesh"), kSocketDiffuser, CurrentLook.DiffuserId);
    ApplySocketPart(SkirtLeftPartMesh_, TEXT("CustomSkirtLeftMesh"), kSocketSkirtL, CurrentLook.SkirtId, TEXT("_L"));
    ApplySocketPart(SkirtRightPartMesh_, TEXT("CustomSkirtRightMesh"), kSocketSkirtR, CurrentLook.SkirtId, TEXT("_R"));
    ApplySocketPart(HoodPartMesh_, TEXT("CustomHoodMesh"), kSocketHood, CurrentLook.HoodId);

    ApplyRimParts(CurrentLook.RimsId);
    ApplyWidebodyMorphs(CurrentLook.FendersId);
    ApplyMaterialParameters();

    OnLookApplied.Broadcast(CurrentLook);
}

bool UOpenGridCustomizationComponent::ApplyLookFromJson(const FString& JsonString)
{
    if (JsonString.IsEmpty()) return false;

    TSharedPtr<FJsonObject> Obj;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonString);
    if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
    {
        UE_LOG(LogOpenGridCustomization, Warning, TEXT("ApplyLookFromJson: failed to parse JSON"));
        return false;
    }

    FOpenGridCarLook Parsed = CurrentLook;
    auto ReadStr = [&](const TCHAR* PrimaryKey, const TCHAR* AltKey, FString& Target)
    {
        FString Val;
        if (Obj->TryGetStringField(PrimaryKey, Val) || (AltKey && Obj->TryGetStringField(AltKey, Val)))
        {
            Target = Val;
        }
    };

    ReadStr(TEXT("paint"), TEXT("PaintHex"), Parsed.PaintHex);
    ReadStr(TEXT("finish"), TEXT("Finish"), Parsed.Finish);

    int32 IntVal = 0;
    if (Obj->TryGetNumberField(TEXT("livery"), IntVal) || Obj->TryGetNumberField(TEXT("Livery"), IntVal))
    {
        Parsed.Livery = FMath::Clamp(IntVal, 0, 4);
    }
    ReadStr(TEXT("liveryColor"), TEXT("LiveryColorHex"), Parsed.LiveryColorHex);
    ReadStr(TEXT("wing"), TEXT("WingId"), Parsed.WingId);
    ReadStr(TEXT("splitter"), TEXT("SplitterId"), Parsed.SplitterId);
    ReadStr(TEXT("diffuser"), TEXT("DiffuserId"), Parsed.DiffuserId);
    ReadStr(TEXT("skirt"), TEXT("SkirtId"), Parsed.SkirtId);
    ReadStr(TEXT("frontB"), TEXT("FrontBumperId"), Parsed.FrontBumperId);
    ReadStr(TEXT("rearB"), TEXT("RearBumperId"), Parsed.RearBumperId);
    ReadStr(TEXT("hood"), TEXT("HoodId"), Parsed.HoodId);
    ReadStr(TEXT("fenders"), TEXT("FendersId"), Parsed.FendersId);
    ReadStr(TEXT("rims"), TEXT("RimsId"), Parsed.RimsId);
    ReadStr(TEXT("aero"), TEXT("AeroFinish"), Parsed.AeroFinish);
    ReadStr(TEXT("rimColor"), TEXT("RimColorHex"), Parsed.RimColorHex);
    ReadStr(TEXT("rimFinish"), TEXT("RimFinish"), Parsed.RimFinish);
    ReadStr(TEXT("caliper"), TEXT("CaliperHex"), Parsed.CaliperHex);
    ReadStr(TEXT("headlights"), TEXT("Headlights"), Parsed.Headlights);

    bool BoolVal = false;
    if (Obj->TryGetBoolField(TEXT("smokedTails"), BoolVal) || Obj->TryGetBoolField(TEXT("SmokedTails"), BoolVal))
    {
        Parsed.SmokedTails = BoolVal;
    }
    ReadStr(TEXT("underglow"), TEXT("UnderglowHex"), Parsed.UnderglowHex);

    if (Obj->TryGetNumberField(TEXT("tint"), IntVal) || Obj->TryGetNumberField(TEXT("WindowTint"), IntVal))
    {
        Parsed.WindowTint = FMath::Clamp(IntVal, 0, 2);
    }
    ReadStr(TEXT("exhaust"), TEXT("ExhaustFinish"), Parsed.ExhaustFinish);

    ApplyLook(Parsed);
    return true;
}

FString UOpenGridCustomizationComponent::SerializeLookToJson() const
{
    const TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
    Obj->SetStringField(TEXT("paint"), CurrentLook.PaintHex);
    Obj->SetStringField(TEXT("finish"), CurrentLook.Finish);
    Obj->SetNumberField(TEXT("livery"), FMath::Clamp(CurrentLook.Livery, 0, 4));
    Obj->SetStringField(TEXT("liveryColor"), CurrentLook.LiveryColorHex);
    Obj->SetStringField(TEXT("wing"), CurrentLook.WingId);
    Obj->SetStringField(TEXT("splitter"), CurrentLook.SplitterId);
    Obj->SetStringField(TEXT("diffuser"), CurrentLook.DiffuserId);
    Obj->SetStringField(TEXT("skirt"), CurrentLook.SkirtId);
    Obj->SetStringField(TEXT("frontB"), CurrentLook.FrontBumperId);
    Obj->SetStringField(TEXT("rearB"), CurrentLook.RearBumperId);
    Obj->SetStringField(TEXT("hood"), CurrentLook.HoodId);
    Obj->SetStringField(TEXT("fenders"), CurrentLook.FendersId);
    Obj->SetStringField(TEXT("rims"), CurrentLook.RimsId);
    Obj->SetStringField(TEXT("aero"), CurrentLook.AeroFinish);
    Obj->SetStringField(TEXT("rimColor"), CurrentLook.RimColorHex);
    Obj->SetStringField(TEXT("rimFinish"), CurrentLook.RimFinish);
    Obj->SetStringField(TEXT("caliper"), CurrentLook.CaliperHex);
    Obj->SetStringField(TEXT("headlights"), CurrentLook.Headlights);
    Obj->SetBoolField(TEXT("smokedTails"), CurrentLook.SmokedTails);
    Obj->SetStringField(TEXT("underglow"), CurrentLook.UnderglowHex);
    Obj->SetNumberField(TEXT("tint"), FMath::Clamp(CurrentLook.WindowTint, 0, 2));
    Obj->SetStringField(TEXT("exhaust"), CurrentLook.ExhaustFinish);

    FString OutJson;
    const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&OutJson);
    FJsonSerializer::Serialize(Obj, Writer);
    return OutJson;
}

void UOpenGridCustomizationComponent::SetWear(float InDirtWear, float InScuffWear)
{
    DirtWear = FMath::Clamp(InDirtWear, 0.0f, 1.0f);
    ScuffWear = FMath::Clamp(InScuffWear, 0.0f, 1.0f);
    for (UMaterialInstanceDynamic* Mid : PaintMaterials_)
    {
        if (!Mid) continue;
        Mid->SetScalarParameterValue(TEXT("DirtWear"), DirtWear);
        Mid->SetScalarParameterValue(TEXT("ScuffWear"), ScuffWear);
    }
}

float UOpenGridCustomizationComponent::GetWidebodyTrackOffsetCm() const
{
    const float ArchWidthM = WidebodyArchWidthMeters(CurrentLook.FendersId);
    if (ArchWidthM <= 0.0f) return 0.0f;
    // Exact match to web/src/scene/parts/widebody.ts: widebodyTrack = min(0.095, w * 0.85) m -> cm
    return FMath::Min(0.095f, ArchWidthM * 0.85f) * 100.0f;
}

FLinearColor UOpenGridCustomizationComponent::ParseHexColor(const FString& HexString, const FLinearColor& DefaultColor)
{
    FString Clean = HexString.TrimStartAndEnd();
    if (Clean.StartsWith(TEXT("#")))
    {
        Clean.RightChopInline(1);
    }
    if (Clean.Len() != 6 && Clean.Len() != 8)
    {
        return DefaultColor;
    }
    for (TCHAR Ch : Clean)
    {
        if (!FChar::IsHexDigit(Ch))
        {
            return DefaultColor;
        }
    }
    return FLinearColor(FColor::FromHex(Clean));
}
