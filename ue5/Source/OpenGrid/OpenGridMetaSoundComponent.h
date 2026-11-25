// Apache-2.0 — Vehicle audio telemetry bridge for UE 5.8 MetaSounds via UAudioComponent parameter interface.
// Pushes real-time rs_core physical acoustics (RPM, exhaust primary Hz, gear whine Hz, turbo surge, kerb load,
// surface excitation, wheel slip, speed, wetness) without hard-linking optional MetaSound editor/runtime plugins.
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "OpenGridMetaSoundComponent.generated.h"

class UAudioComponent;
class UOpenGridVehicleComponent;
class USoundBase;

/** Per-frame acoustic telemetry snapshot pushed to UAudioComponent / MetaSound graph. */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridAudioTelemetry
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float Rpm = 900.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float Throttle = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float ExhaustPrimaryHz = 45.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float GearWhineHz = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float TurboSurge = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float KerbLoadRatio = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float SurfaceExcitation = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float WheelSlip = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float SpeedKmh = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float IsWet = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float BoostBar = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float TurboWhistleHz = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    float OverrunPopIntensity = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    int32 Gear = 2;
};

/**
 * Consumes UOpenGridVehicleComponent physical telemetry every tick and drives named float & trigger parameters
 * on an attached UAudioComponent (compatible with UE 5.8 MetaSound Source assets out of the box).
 */
UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRID_API UOpenGridMetaSoundComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UOpenGridMetaSoundComponent();

    /** Optional MetaSound Source or SoundCue asset assigned to the attached UAudioComponent at BeginPlay. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio")
    TObjectPtr<USoundBase> EngineSoundAsset;

    /** Attached UAudioComponent receiving float and trigger parameter updates. Created automatically if unset. */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|Audio")
    TObjectPtr<UAudioComponent> AudioComponent;

    /** Automatically start playback on BeginPlay when EngineSoundAsset (or AudioComponent->Sound) is assigned. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio")
    bool bAutoPlay = true;

    /** Road wetness (0 = dry asphalt, 1 = soaked wet street spray & tyre hiss). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio", meta=(ClampMin="0.0", ClampMax="1.0"))
    float Wetness = 0.0f;

    /** Latest acoustic telemetry pushed to AudioComponent. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Audio")
    FOpenGridAudioTelemetry Telemetry;

    /** Explicitly bind the source vehicle component (auto-discovered on owner in BeginPlay if not called). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Audio")
    void BindVehicle(UOpenGridVehicleComponent* InVehicle);

    /** Set road wetness factor (0..1) and push IsWet immediately. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Audio")
    void SetWetness(float InWetness);

    /** Fire a custom MetaSound trigger parameter by name on the attached UAudioComponent. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Audio")
    void FireAudioTrigger(FName TriggerName);

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

private:
    void ResolveComponents();
    void BindVehicleDelegates();
    void UnbindVehicleDelegates();
    void PushFloatParameters() const;

    UFUNCTION()
    void HandleBlowOffValve(float BoostBarReleased);

    UFUNCTION()
    void HandleBackfire(float Intensity);

    UFUNCTION()
    void HandleGearGrind(int32 AttemptedGear);

    UFUNCTION()
    void HandleMissedShift(int32 TotalMissedShifts, float SimTimeSeconds);

    UFUNCTION()
    void HandleScrape(float ImpactEnergyKj);

    TWeakObjectPtr<UOpenGridVehicleComponent> Vehicle_;
    bool bDelegatesBound_ = false;
    int32 LastGear_ = 2;
    float PrevBoostBar_ = 0.0f;
    float PrevThrottle_ = 0.0f;
    float TurboSurgeDecay_ = 0.0f;
    float PrevWheelCompressionCm_[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    bool bHasPrevWheelSample_ = false;
};
