// Apache-2.0 — Real-Time Physical Combustion Engine Audio Component for UE 5.8 (USynthComponent).
//
// Streams 48 kHz stereo audio directly from OpenGrid's vendored & enhanced MIT engine-sim C++ core
// (`rs::EngineAudioSynth` in core/src/engine_audio.cpp) on Unreal's Audio Mixer render thread with
// zero loop crossfading, true dual-mic exhaust + intake roar, physical exhaust stage swaps,
// unburnt-fuel overrun anti-lag detonations, turbo surge flutter, supercharger whine, 4-rotor Wankel,
// camera-perspective EQ/mic routing, and live 3-ray tunnel/wall acoustic reflections.
#pragma once

#include "CoreMinimal.h"
#include "Components/SynthComponent.h"
#include <atomic>
#include <memory>
#include "OpenGridEngineSynthComponent.generated.h"

namespace rs { class EngineAudioSynth; }

UENUM(BlueprintType)
enum class EOpenGridEngineVoice : uint8
{
    V8Crossplane    UMETA(DisplayName="6.2L Cross-Plane V8"),
    V8Flatplane     UMETA(DisplayName="4.5L Flat-Plane V8"),
    V8Supercharged  UMETA(DisplayName="6.2L Supercharged V8"),
    V8TwinTurbo     UMETA(DisplayName="4.0L Twin-Turbo V8"),
    V12Na           UMETA(DisplayName="6.5L NA V12"),
    V10Screamer     UMETA(DisplayName="5.2L Odd-Fire V10"),
    Flat6Na         UMETA(DisplayName="4.0L GT3 Flat-6"),
    I6Forged        UMETA(DisplayName="2.8L Forged TT I6"),
    V6TwinTurbo     UMETA(DisplayName="3.5L Twin-Turbo V6"),
    Rotary4         UMETA(DisplayName="2.6L 4-Rotor 26B Wankel"),
};

UENUM(BlueprintType)
enum class EOpenGridExhaustStage : uint8
{
    Stock           UMETA(DisplayName="Stock Muffler"),
    Sport           UMETA(DisplayName="Sport Exhaust"),
    RaceTitanium    UMETA(DisplayName="Race Titanium Straight-Pipe"),
};

UENUM(BlueprintType)
enum class EOpenGridCameraPerspective : uint8
{
    ExteriorRear    UMETA(DisplayName="Exterior Rear"),
    ExteriorChase   UMETA(DisplayName="Exterior Chase"),
    HoodBumper      UMETA(DisplayName="Hood / Bumper"),
    InteriorCockpit UMETA(DisplayName="Interior Cockpit"),
};

UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRID_API UOpenGridEngineSynthComponent : public USynthComponent
{
    GENERATED_BODY()

public:
    UOpenGridEngineSynthComponent(const FObjectInitializer& ObjectInitializer);
    virtual ~UOpenGridEngineSynthComponent() override;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|EngineAudio")
    EOpenGridEngineVoice Voice = EOpenGridEngineVoice::V8Crossplane;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|EngineAudio")
    EOpenGridExhaustStage ExhaustStage = EOpenGridExhaustStage::Sport;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|EngineAudio")
    EOpenGridCameraPerspective CameraPerspective = EOpenGridCameraPerspective::ExteriorChase;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|EngineAudio")
    bool bAftermarketTurbo = false;

    /** Push real-time vehicle state from the game thread (lock-free, allocation-free). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void SetEngineTelemetry(float InRpm, float InThrottle, float InLoad, float InBoostBar, bool bInIgnitionCut, float InReverbMix = 0.16f);

    /** Set active listener camera perspective for intake/exhaust balance and cabin filtering (lock-free). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void SetCameraPerspective(EOpenGridCameraPerspective NewPerspective);

    /** Push real-time environmental reflection weights from tunnel ceiling and L/R wall proximity probes (0..1, lock-free). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void SetAcousticEnvironment(float TunnelReflection, float WallProximityL, float WallProximityR);

    /** Push straight-cut gear whine intensity (0..1) and forward vehicle speed (m/s) for drivetrain acoustics (lock-free). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void SetDrivetrainAcoustics(float GearWhineLevel, float VehicleSpeedMps);

    /** Trigger a physical unburnt-fuel exhaust detonation (anti-lag / flat-foot upshift bang). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void TriggerExhaustPop(float Intensity = 0.9f);

    /** Trigger a compressor-surge BOV flutter burst on high-boost lift-off. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void TriggerTurboFlutter(float BoostBar = 1.0f);

    /** Trigger an electric starter motor crank + cold-fire flare (duration in seconds). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void TriggerStarterCrank(float DurationSec = 0.42f);

    /** Trigger a multi-pulse lift-off overrun exhaust burble / crackle burst (intensity 0..1). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void TriggerOverrunBurble(float Intensity = 0.55f);

    /** Switch engine architecture (re-initializes thermodynamic solver cleanly on next audio block). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|EngineAudio")
    void SetVoice(EOpenGridEngineVoice NewVoice, EOpenGridExhaustStage NewStage, bool bHasTurbo);

protected:
    virtual bool Init(int32& SampleRate) override;
    virtual int32 OnGenerateAudio(float* OutAudio, int32 NumSamples) override;

private:
    std::unique_ptr<rs::EngineAudioSynth> Synth;
    int32 ActiveSampleRate = 48000;

    // Lock-free game-thread -> audio-thread control atoms
    std::atomic<float> TargetRpm{ 950.0f };
    std::atomic<float> TargetThrottle{ 0.06f };
    std::atomic<float> TargetLoad{ 0.08f };
    std::atomic<float> TargetBoostBar{ 0.0f };
    std::atomic<float> TargetReverbMix{ 0.16f };
    std::atomic<bool> bTargetIgnitionCut{ false };

    std::atomic<uint8> TargetPerspective{ static_cast<uint8>(EOpenGridCameraPerspective::ExteriorChase) };
    std::atomic<float> TargetTunnelReflection{ 0.0f };
    std::atomic<float> TargetWallProximityL{ 0.0f };
    std::atomic<float> TargetWallProximityR{ 0.0f };
    std::atomic<float> TargetGearWhineLevel{ 0.0f };
    std::atomic<float> TargetVehicleSpeedMps{ 0.0f };

    std::atomic<float> PendingPopIntensity{ 0.0f };
    std::atomic<float> PendingFlutterBoost{ 0.0f };
    std::atomic<float> PendingStarterCrankSec{ 0.0f };
    std::atomic<float> PendingOverrunBurbleIntensity{ 0.0f };

    std::atomic<bool> bPendingReinit{ false };
    std::atomic<uint8> PendingVoice{ 0 };
    std::atomic<uint8> PendingStage{ 1 };
    std::atomic<bool> bPendingTurbo{ false };
    std::atomic<uint8> ActiveStage{ static_cast<uint8>(EOpenGridExhaustStage::Sport) };
    std::atomic<bool> bActiveTurbo{ false };

    TArray<float> ScratchL;
    TArray<float> ScratchR;
};
