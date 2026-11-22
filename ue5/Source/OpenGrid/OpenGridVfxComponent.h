// Apache-2.0 — Forza Horizon 6-grade real-time Vehicle VFX Director for UE 5.8.
//
// Manages pooled, zero-runtime-allocation Niagara VFX emitters, physically simulated carbon-ceramic
// brake rotor blackbody glow, pooled dynamic exhaust backfire ground-bounce lighting, and exhaust
// heat-shimmer material parameters driven by UOpenGridVehicleComponent telemetry.
//
// Documented Niagara User Parameters pushed by this component:
//   - SpawnRate       (float)   : Continuous emission multiplier / burst count (0..1+ or scaled rate)
//   - TyreTempC       (float)   : Per-wheel tyre surface temperature in Celsius
//   - SlipIntensity   (float)   : Combined longitudinal + lateral wheel slip magnitude (0..1+)
//   - VehicleSpeedMps (float)   : Forward vehicle speed in metres per second
//   - Wetness         (float)   : Surface wetness factor (0 = dry asphalt, 1 = soaked)
//   - FlameIntensity  (float)   : Exhaust backfire / NOS flame intensity (0..1.5)
//   - bBlueNos        (bool)    : True for blue nitrous purge / flame, false for amber fuel backfire
//   - HeatShimmer     (float)   : Exhaust plume heat distortion strength (0..1)
//   - SparkVelocity   (FVector) : World-space directional velocity vector for titanium spark bursts (cm/s)
//
// Documented MaterialInstanceDynamic Parameters pushed by this component:
//   - BrakeRotorMaterials[0..3]:
//       * BrakeDiscTempC        (Scalar) : Rotor core temperature (20..950 C)
//       * BrakeDiscGlow         (Scalar) : Normalized blackbody glow factor (0..1 over 360..920 C)
//       * BrakeDiscEmissiveColor(Vector) : Linear HDR blackbody RGB glow (dark cherry -> bright orange-yellow)
//   - ExhaustMaterials[...]:
//       * ExhaustHeatShimmer    (Scalar) : Exhaust heat shimmer & thermal glow factor (0..1)
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "OpenGridVfxComponent.generated.h"

class UMaterialInstanceDynamic;
class UNiagaraComponent;
class UNiagaraSystem;
class UPointLightComponent;
class USceneComponent;

/** Per-wheel physical thermal and blackbody emissive state for carbon-ceramic / iron brake rotors. */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridBrakeThermalState
{
    GENERATED_BODY()

    /** Simulated brake rotor temperature in Celsius (clamped 20..950 C). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX|Brakes")
    float TemperatureC = 45.0f;

    /** Normalized visible incandescence factor (0 below 360 C, 1 at 920 C). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX|Brakes")
    float GlowAlpha = 0.0f;

    /** Physically inspired HDR blackbody emissive color (dark cherry red -> bright orange-yellow). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX|Brakes")
    FLinearColor EmissiveColor = FLinearColor::Black;
};

/** Per-wheel VFX telemetry input (FL=0, FR=1, RL=2, RR=3). */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridWheelVfxTelemetry
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    bool bInContact = false;

    /** Tyre contact patch location in world space (cm). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    FVector ContactPointWorldCm = FVector::ZeroVector;

    /** Road / kerb surface normal at contact patch. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    FVector ContactNormalWorld = FVector::UpVector;

    /** Combined longitudinal + lateral slip intensity (0 = pure roll, 1+ = heavy drift/burnout). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float SlipIntensity = 0.0f;

    /** Tyre tread surface temperature (C). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float TyreTempC = 80.0f;

    /** Vertical tyre normal load (Newtons). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float NormalLoadN = 0.0f;

    /** Surface wetness at this wheel (0 = dry, 1 = soaked). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float Wetness = 0.0f;

    /** Gravel / off-road roost / kerb dust excitation factor (0..1). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float DebrisIntensity = 0.0f;
};

/** Per-frame vehicle VFX telemetry snapshot consumed by UOpenGridVfxComponent::UpdateVehicleVfx. */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridVfxTelemetry
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float EngineRpm = 900.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float RedlineRpm = 7800.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float Throttle = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float EngineLoad = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float BrakeInput = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float HandbrakeInput = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float SpeedMps = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float AmbientTempC = 20.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    float GlobalWetness = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    bool bNitrousActive = false;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    bool bScrapeActive = false;

    /** Vehicle chassis linear velocity in world space (cm/s). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    FVector VehicleVelocityCms = FVector::ZeroVector;

    /** Four wheel telemetry entries in canonical order: FL=0, FR=1, RL=2, RR=3. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX")
    TArray<FOpenGridWheelVfxTelemetry> Wheels;
};

/**
 * Forza Horizon 6-level real-time vehicle VFX director.
 * Pools all Niagara emitters and the rear diffuser exhaust bounce light once during BeginPlay so runtime
 * updates incur zero UObject/shader allocations.
 */
UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRID_API UOpenGridVfxComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UOpenGridVfxComponent();

    // ---- Blueprint-assignable Niagara System assets -----------------------------------------------------------------

    /** Per-wheel dry drift / burnout tyre smoke (4 pooled instances at FL, FR, RL, RR). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Assets")
    TObjectPtr<UNiagaraSystem> TyreSmokeSystem;

    /** Per-wheel wet-road rooster-tail water spray & mist wake (4 pooled instances at FL, FR, RL, RR). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Assets")
    TObjectPtr<UNiagaraSystem> RainSpraySystem;

    /** Dual-tailpipe Mach-diamond backfire / NOS flamethrower + heat shimmer (2 pooled instances at L/R tailpipes). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Assets")
    TObjectPtr<UNiagaraSystem> ExhaustFlameSystem;

    /** Titanium chassis bottoming / curb-strike / wall-scrape spark bursts (pooled). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Assets")
    TObjectPtr<UNiagaraSystem> UnderbodySparkSystem;

    /** Gravel / off-road roost & curb dust (4 pooled instances at FL, FR, RL, RR). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Assets")
    TObjectPtr<UNiagaraSystem> RoadDebrisSystem;

    // ---- Attachment sockets & fallback offsets ----------------------------------------------------------------------

    /** Wheel sockets in canonical order FL, FR, RL, RR (contact world positions override when grounded). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Sockets")
    TArray<FName> WheelSocketNames;

    /** Exhaust tailpipe sockets (Left, Right). Falls back to ExhaustLeft/RightFallbackOffsetCm when absent. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Sockets")
    TArray<FName> ExhaustSocketNames;

    /** Fallback left tailpipe offset relative to owner root/body (cm, -X rear, -Y left). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Sockets")
    FVector ExhaustLeftFallbackOffsetCm = FVector(-215.0, -42.0, -10.0);

    /** Fallback right tailpipe offset relative to owner root/body (cm, -X rear, +Y right). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Sockets")
    FVector ExhaustRightFallbackOffsetCm = FVector(-215.0, 42.0, -10.0);

    /** Rear diffuser ground-bounce point light offset relative to owner root/body (cm). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Sockets")
    FVector BackfireLightLocalOffsetCm = FVector(-245.0, 0.0, -8.0);

    // ---- Thermal & lighting calibration -----------------------------------------------------------------------------

    /** Brake power-to-temperature scale converting (BrakeInput * WheelLoadN * SpeedMps) into degC/s. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Thermal", meta=(ClampMin="0.0001", ClampMax="0.02"))
    float BrakeHeatFactor = 0.00125f;

    /** Temperature (C) at which carbon-ceramic brake rotors begin glowing dark cherry red. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Thermal")
    float BrakeGlowMinTempC = 360.0f;

    /** Temperature (C) at which brake rotors reach peak incandescent orange-yellow. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Thermal")
    float BrakeGlowMaxTempC = 920.0f;

    /** Peak candela / lumen intensity multiplier for the pooled rear exhaust backfire ground-bounce light. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Lighting", meta=(ClampMin="0.0"))
    float BackfireLightMaxIntensity = 6500.0f;

    /** Attenuation radius (cm) of the rear exhaust backfire ground-bounce light. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Lighting", meta=(ClampMin="50.0"))
    float BackfireLightAttenuationRadiusCm = 460.0f;

    // ---- Dynamic material hooks -------------------------------------------------------------------------------------

    /** Per-wheel brake rotor MIDs (FL=0, FR=1, RL=2, RR=3) driven with BrakeDiscTempC, BrakeDiscGlow, BrakeDiscEmissiveColor. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Materials")
    TArray<TObjectPtr<UMaterialInstanceDynamic>> BrakeRotorMaterials;

    /** Optional exhaust tip / heat-shield MIDs driven with ExhaustHeatShimmer (0..1). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|VFX|Materials")
    TArray<TObjectPtr<UMaterialInstanceDynamic>> ExhaustMaterials;

    // ---- Live runtime telemetry & pooled components -----------------------------------------------------------------

    /** Simulated thermal + emissive state for all 4 brake rotors (FL=0, FR=1, RL=2, RR=3). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX|Brakes")
    TArray<FOpenGridBrakeThermalState> BrakeThermalStates;

    /** Normalized exhaust heat-shimmer & thermal valve intensity (0..1). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX")
    float ExhaustHeatShimmer = 0.0f;

    /** Simulated exhaust gas temperature at tailpipes (C). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX")
    float ExhaustGasTempC = 180.0f;

    /** Current decaying exhaust flame intensity (0..1.5). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX")
    float ActiveFlameIntensity = 0.0f;

    /** True when the active exhaust flame / light is in blue NOS mode. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|VFX")
    bool bActiveBlueNos = false;

    /** Pooled rear diffuser ground-bounce point light (created once in BeginPlay, never dynamically spawned). */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|VFX|Lighting")
    TObjectPtr<UPointLightComponent> ExhaustBackfireLight;

    // ---- Public Blueprint / C++ API ---------------------------------------------------------------------------------

    /** Update all vehicle VFX emitters, brake rotor thermal glow, heat shimmer, and backfire lighting for this frame. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|VFX")
    void UpdateVehicleVfx(float DeltaTime, const FOpenGridVfxTelemetry& Telemetry);

    /** Fire a synchronized dual-tailpipe backfire or blue NOS flame pulse + rear ground-bounce light flash. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|VFX")
    void TriggerExhaustBackfire(float Intensity = 0.85f, bool bBlueNos = false);

    /** Fire a pooled directional titanium spark burst at a bottoming, kerb-strike, or wall-scrape contact point. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|VFX")
    void TriggerSparkBurst(FVector WorldLoc, FVector WorldNormal, float Intensity = 1.0f);

    /** Register a brake rotor MaterialInstanceDynamic for wheel index 0..3 (FL, FR, RL, RR). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|VFX|Materials")
    void RegisterBrakeRotorMaterial(int32 WheelIndex, UMaterialInstanceDynamic* Material);

    /** Register an exhaust / diffuser MaterialInstanceDynamic to receive ExhaustHeatShimmer updates. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|VFX|Materials")
    void RegisterExhaustMaterial(UMaterialInstanceDynamic* Material);

    /** Reset brake rotor temperatures, exhaust heat shimmer, and active flame decay (e.g. on vehicle Recover). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|VFX")
    void ResetThermalState();

    /** Evaluate physical HDR blackbody glow color (dark cherry red -> bright orange-yellow) for a given rotor temperature. */
    UFUNCTION(BlueprintPure, Category="OpenGrid|VFX|Brakes")
    static FLinearColor EvaluateBrakeBlackbodyColor(float TemperatureC, float MinTempC = 360.0f, float MaxTempC = 920.0f);

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    USceneComponent* ResolveAttachRoot() const;
    void InitializePooledComponents();
    UNiagaraComponent* CreatePooledEmitter(UNiagaraSystem* SystemAsset,
                                           USceneComponent* AttachParent,
                                           FName SocketName,
                                           const FVector& RelativeLocation,
                                           const FRotator& RelativeRotation);
    void UpdateBrakeThermals(float DeltaTime, const FOpenGridVfxTelemetry& Telemetry);
    void UpdateWheelEmitters(const FOpenGridVfxTelemetry& Telemetry);
    void UpdateExhaustAndLighting(float DeltaTime, const FOpenGridVfxTelemetry& Telemetry);

    UPROPERTY(Transient)
    TArray<TObjectPtr<UNiagaraComponent>> TyreSmokeComponents;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UNiagaraComponent>> RainSprayComponents;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UNiagaraComponent>> RoadDebrisComponents;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UNiagaraComponent>> ExhaustFlameComponents;

    UPROPERTY(Transient)
    TArray<TObjectPtr<UNiagaraComponent>> UnderbodySparkComponents;

    int32 NextSparkPoolIndex = 0;
    FVector LastVehicleVelocityCms = FVector::ZeroVector;
    float LastVehicleSpeedMps = 0.0f;
    bool bPooledInitialized = false;
};
