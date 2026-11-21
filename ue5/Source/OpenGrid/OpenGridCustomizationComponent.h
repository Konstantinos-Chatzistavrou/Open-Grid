// Apache-2.0 — Visual car customization component (paint, finishes, liveries, widebody morphs, modular aero/rims).
// Mirrors web/src/custom-data.ts, web/src/gpu/materials/carPaint.ts, and web/src/scene/parts/widebody.ts.
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "OpenGridCustomizationComponent.generated.h"

class UMaterialInstanceDynamic;
class UMeshComponent;
class USceneComponent;
class USkeletalMeshComponent;
class UStaticMesh;
class UStaticMeshComponent;

/**
 * Complete car visual configuration mirroring `Custom` in web/src/custom-data.ts plus body paint & finish.
 * Serializes cleanly to/from the Cloudflare Worker `/v1/look` JSON schema.
 */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridCarLook
{
    GENERATED_BODY()

    /** Primary body paint sRGB hex (#RRGGBB). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString PaintHex = TEXT("#c0160f");

    /** Paint finish preset: gloss | satin | metallic | pearl | candy | matte. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString Finish = TEXT("gloss");

    /** Livery style index: 0 none, 1 twin stripes, 2 wide stripe, 3 side stripe, 4 two-tone. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look", meta=(ClampMin="0", ClampMax="4"))
    int32 Livery = 0;

    /** Livery accent sRGB hex (#RRGGBB). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString LiveryColorHex = TEXT("#f4f4f6");

    /** Wing ID: "stock", "none", or a registered wing asset key (e.g. "wing_gt", "wing_ducktail"). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString WingId = TEXT("stock");

    /** Front splitter ID: "stock" or a registered splitter asset key. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString SplitterId = TEXT("stock");

    /** Rear diffuser ID: "stock" or a registered diffuser asset key. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString DiffuserId = TEXT("stock");

    /** Side skirt ID: "stock" or a registered skirt asset key (resolves <id>_L / <id>_R or <id>). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString SkirtId = TEXT("stock");

    /** Front bumper ID (matches `frontB` in custom-data.ts): "stock" or registered key. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString FrontBumperId = TEXT("stock");

    /** Rear bumper ID (matches `rearB` in custom-data.ts): "stock" or registered key. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString RearBumperId = TEXT("stock");

    /** Hood ID: "stock" or registered hood key. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString HoodId = TEXT("stock");

    /** Widebody / fender flare ID: "stock", "fender-smooth", "fender-plus", "fender-wide", "fender-bolt", "fender-race", "fender-extreme", etc. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString FendersId = TEXT("stock");

    /** Wheel rim ID: "stock" or registered rim key. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString RimsId = TEXT("stock");

    /** Aero finish: carbon | gloss | matte | body. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString AeroFinish = TEXT("carbon");

    /** Rim sRGB hex (#RRGGBB). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString RimColorHex = TEXT("#9aa0aa");

    /** Rim finish: chrome | gloss | satin | matte. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString RimFinish = TEXT("chrome");

    /** Brake caliper sRGB hex (#RRGGBB). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString CaliperHex = TEXT("#c0160f");

    /** Headlight tint: white | ice | yellow. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString Headlights = TEXT("white");

    /** Smoked taillight lenses. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    bool SmokedTails = false;

    /** Underglow neon sRGB hex (#RRGGBB), or empty string when disabled. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString UnderglowHex;

    /** Window tint level: 0 light, 1 dark, 2 limo. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look", meta=(ClampMin="0", ClampMax="2"))
    int32 WindowTint = 1;

    /** Exhaust tip finish: chrome | black | titanium. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Look")
    FString ExhaustFinish = TEXT("chrome");
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridLookApplied, const FOpenGridCarLook&, AppliedLook);

/**
 * Drives modular part attachment on UE 5.8 sockets (SOCKET_Wing, SOCKET_Splitter, SOCKET_Diffuser,
 * SOCKET_Skirt_L/R, SOCKET_Wheel_FL..RR), seamless widebody morph targets (widebody_street / widebody_race),
 * and dual-layer PBR car paint MaterialInstanceDynamic parameters.
 */
UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRID_API UOpenGridCustomizationComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UOpenGridCustomizationComponent();

    /** Active look applied to this vehicle. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Customization")
    FOpenGridCarLook CurrentLook;

    /**
     * Asset registry mapping modular part IDs (e.g. "wing_gt", "splitter_race", "diffuser_gt",
     * "skirt_aero_L", "skirt_aero_R", "rim_te37") to imported StaticMesh assets.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Customization")
    TMap<FName, TSoftObjectPtr<UStaticMesh>> PartMeshRegistry;

    /** Optional reference to the factory stock wing mesh (hidden automatically when a custom wing or "none" is chosen). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Customization")
    TObjectPtr<UStaticMeshComponent> StockWingMesh;

    /** Material slot indices on the body mesh that use the dual-layer car paint shader (defaults to slot 0 if empty). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Customization")
    TArray<int32> PaintMaterialSlotIndices;

    /** Runtime road grime / wet-street splatter wear (0..1). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Customization", meta=(ClampMin="0.0", ClampMax="1.0"))
    float DirtWear = 0.0f;

    /** Runtime wall-scrape & dent matte scuff wear (0..1). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Customization", meta=(ClampMin="0.0", ClampMax="1.0"))
    float ScuffWear = 0.0f;

    /** Broadcast whenever ApplyLook finishes updating meshes, morphs, and materials. */
    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Customization")
    FOnOpenGridLookApplied OnLookApplied;

    /**
     * Bind the owning pawn's body, stock wing, wheel, and caliper mesh components.
     * Safe to call in BeginPlay or Blueprints; automatically discovers components on the owner if not called explicitly.
     */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Customization")
    void BindPawnMeshes(USkeletalMeshComponent* InDeformableBody,
                        UStaticMeshComponent* InStaticBody,
                        UStaticMeshComponent* InStockWing,
                        const TArray<UStaticMeshComponent*>& InWheels,
                        const TArray<UStaticMeshComponent*>& InCalipers);

    /** Apply a full car look: modular socket meshes, widebody morphs, and dynamic paint/rim/caliper/aero materials. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Customization")
    void ApplyLook(const FOpenGridCarLook& Look);

    /** Parse a JSON look string (matching web/src/custom-data.ts) and apply it. Returns true if JSON parsed cleanly. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Customization")
    bool ApplyLookFromJson(const FString& JsonString);

    /** Serialize CurrentLook to JSON compatible with web/src/custom-data.ts and cloud /v1/look. */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Customization")
    FString SerializeLookToJson() const;

    /** Update gameplay-driven DirtWear and ScuffWear parameters on body paint MIDs without rebuilding parts. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Customization")
    void SetWear(float InDirtWear, float InScuffWear);

    /**
     * Outward wheel-track spacer offset in cm matching widebodyTrack() in web/src/scene/parts/widebody.ts:
     * min(9.5 cm, archWidthCm * 0.85). Zero for stock fenders.
     */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Customization")
    float GetWidebodyTrackOffsetCm() const;

    /** Helper to parse "#RRGGBB" into an sRGB-corrected FLinearColor (falls back to DefaultColor on invalid hex). */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Customization")
    static FLinearColor ParseHexColor(const FString& HexString, const FLinearColor& DefaultColor);

protected:
    virtual void BeginPlay() override;

private:
    void ResolveOwnerMeshes();
    USceneComponent* GetAttachmentRoot() const;
    UMeshComponent* GetActiveBodyMesh() const;
    UStaticMesh* ResolvePartMesh(const FString& PartId, const TCHAR* Suffix = nullptr) const;
    UStaticMeshComponent* GetOrCreatePartComponent(TObjectPtr<UStaticMeshComponent>& Slot, FName ComponentName);
    void ApplySocketPart(TObjectPtr<UStaticMeshComponent>& Slot, FName ComponentName, FName SocketName,
                         const FString& PartId, const TCHAR* Suffix = nullptr);
    void ApplyRimParts(const FString& RimsId);
    void ApplyWidebodyMorphs(const FString& FendersId);
    void ApplyMaterialParameters();
    UMaterialInstanceDynamic* GetOrCreateDynamicMaterial(UMeshComponent* Mesh, int32 SlotIndex);

    TWeakObjectPtr<USkeletalMeshComponent> DeformableBodyMesh_;
    TWeakObjectPtr<UStaticMeshComponent> StaticBodyMesh_;
    TArray<TWeakObjectPtr<UStaticMeshComponent>> WheelMeshes_;
    TArray<TWeakObjectPtr<UStaticMeshComponent>> CaliperMeshes_;

    UPROPERTY(Transient)
    TObjectPtr<UStaticMeshComponent> WingPartMesh_;

    UPROPERTY(Transient)
    TObjectPtr<UStaticMeshComponent> SplitterPartMesh_;

    UPROPERTY(Transient)
    TObjectPtr<UStaticMeshComponent> DiffuserPartMesh_;

    UPROPERTY(Transient)
    TObjectPtr<UStaticMeshComponent> SkirtLeftPartMesh_;

    UPROPERTY(Transient)
    TObjectPtr<UStaticMeshComponent> SkirtRightPartMesh_;

    UPROPERTY(Transient)
    TObjectPtr<UStaticMeshComponent> HoodPartMesh_;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UStaticMeshComponent>> RimPartMeshes_;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UMaterialInstanceDynamic>> PaintMaterials_;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UMaterialInstanceDynamic>> AeroMaterials_;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UMaterialInstanceDynamic>> RimMaterials_;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UMaterialInstanceDynamic>> CaliperMaterials_;
};
