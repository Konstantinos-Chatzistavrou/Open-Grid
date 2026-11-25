// Apache-2.0 — OpenGrid Real-Time Physical Vehicle Audio Component for Unreal Engine 5.8 (USynthComponent).
//
// Streams 48 kHz stereo audio from rs::VehicleAudioEngine (vendored thermodynamic engine-sim + 4-wheel tyre
// scrub/squeal/225 Hz cavity boom/flat-spot thump/pothole rim-strike/puncture hiss/wet spray/marble pings +
// brake squeal/ABS/driveline clunk/gear grind/aero wind/splitter scrape/crash crunch + 8-ch Householder tunnel
// FDN + 2 ms true-peak lookahead limiter) directly into UE 5.8's AudioMixer with zero audio-thread allocations.
#pragma once

#include "CoreMinimal.h"
#include "Components/SynthComponent.h"

#include <atomic>

#include "rs/spsc_ring.hpp"
#include "rs/vehicle_audio.hpp"

#include "OpenGridAudioComponent.generated.h"

class UOpenGridVehicleComponent;

UENUM(BlueprintType)
enum class EOpenGridEngineVoice : uint8
{
    AutoFromCarSpec = 0,
    V8Crossplane,
    V8Flatplane,
    V8Supercharged,
    V8TwinTurbo,
    V12Na,
    V10Screamer,
    Flat6Na,
    I6Forged,
    V6TwinTurbo,
    Rotary4,
    I4Turbo,
    I5Turbo,
};

UENUM(BlueprintType)
enum class EOpenGridExhaustStage : uint8
{
    Stock = 0,
    Sport = 1,
    RaceTitanium = 2,
};

UENUM(BlueprintType)
enum class EOpenGridAudioPerspective : uint8
{
    ExteriorRear = 0,
    ExteriorChase = 1,
    HoodBumper = 2,
    InteriorCockpit = 3,
};

UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRIDPHYSICS_API UOpenGridAudioComponent : public USynthComponent
{
    GENERATED_BODY()

public:
    UOpenGridAudioComponent(const FObjectInitializer& ObjectInitializer);

    /** Engine voice override (AutoFromCarSpec reads the owning actor's UOpenGridVehicleComponent car config). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio")
    EOpenGridEngineVoice EngineVoice = EOpenGridEngineVoice::AutoFromCarSpec;

    /** Exhaust hardware stage (Stock muffler, Sport, or straight-through Race Titanium with pops & burbles). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio")
    EOpenGridExhaustStage ExhaustStage = EOpenGridExhaustStage::Sport;

    /** Active camera perspective (smooth 40 ms crossfade between Rear, Chase, Hood/Bumper, and Cockpit). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio")
    EOpenGridAudioPerspective Perspective = EOpenGridAudioPerspective::ExteriorChase;

    /** Dynamic urban acoustic environment multipliers (drive from level trigger volumes or raycasts). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Environment", meta=(ClampMin="0.0", ClampMax="1.0"))
    float TunnelReflection = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Environment", meta=(ClampMin="0.0", ClampMax="1.0"))
    float WallProximityLeft = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Environment", meta=(ClampMin="0.0", ClampMax="1.0"))
    float WallProximityRight = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Environment", meta=(ClampMin="0.0", ClampMax="1.0"))
    float OverpassReflection = 0.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio", meta=(ClampMin="0.0", ClampMax="1.5"))
    float MasterGain = 0.92f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Audio")
    bool bExternalWastegate = false;

    /** Trigger a physical starter-crank sequence + catch flare on the audio thread. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Audio")
    void TriggerStarterCrank(float DurationSec = 0.42f);

    /** Trigger an anti-lag / overrun exhaust pop on the audio thread. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Audio")
    void TriggerExhaustPop(float Intensity = 0.85f);

protected:
    virtual void BeginPlay() override;
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;
    virtual bool Init(int32& SampleRate) override;
    virtual int32 OnGenerateAudio(float* OutAudio, int32 NumSamples) override;

private:
    static rs::EngineVoice ResolveVoice(EOpenGridEngineVoice Voice, const UOpenGridVehicleComponent* Vehicle);

    /** True once TickComponent() has activated the synth (activation waits for the car so AutoFromCarSpec sees its spec). */
    bool bStartRequested_ = false;
    float StartWaitSeconds_ = 0.0f;
    static constexpr float kMaxCarWaitSeconds = 5.0f;

    TWeakObjectPtr<UOpenGridVehicleComponent> VehicleComp_;
    rs::VehicleAudioEngine Engine_;
    rs::TripleBuffer<rs::VehicleAudioTelemetry> TelemetryTB_;
    std::atomic<float> PendingStarterSec_{0.0f};
    std::atomic<float> PendingPopIntensity_{0.0f};
    std::atomic<bool> bSynthReady_{false};
    std::array<float, 1024> ScratchL_{};
    std::array<float, 1024> ScratchR_{};
};
