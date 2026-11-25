// Apache-2.0 — Real-Time Physical Combustion Engine Audio Component for UE 5.8 (USynthComponent).
#include "OpenGridEngineSynthComponent.h"

#include "rs/engine_audio.h"

namespace {

rs::EngineVoice ToCoreVoice(EOpenGridSynthVoice V)
{
    switch (V)
    {
        case EOpenGridSynthVoice::V8Flatplane:    return rs::EngineVoice::V8Flatplane;
        case EOpenGridSynthVoice::V8Supercharged: return rs::EngineVoice::V8Supercharged;
        case EOpenGridSynthVoice::V8TwinTurbo:    return rs::EngineVoice::V8TwinTurbo;
        case EOpenGridSynthVoice::V12Na:          return rs::EngineVoice::V12Na;
        case EOpenGridSynthVoice::V10Screamer:    return rs::EngineVoice::V10Screamer;
        case EOpenGridSynthVoice::Flat6Na:        return rs::EngineVoice::Flat6Na;
        case EOpenGridSynthVoice::I6Forged:       return rs::EngineVoice::I6Forged;
        case EOpenGridSynthVoice::V6TwinTurbo:    return rs::EngineVoice::V6TwinTurbo;
        case EOpenGridSynthVoice::Rotary4:        return rs::EngineVoice::Rotary4;
        case EOpenGridSynthVoice::V8Crossplane:
        default:                                   return rs::EngineVoice::V8Crossplane;
    }
}

rs::ExhaustStage ToCoreStage(EOpenGridSynthExhaustStage S)
{
    switch (S)
    {
        case EOpenGridSynthExhaustStage::Stock:        return rs::ExhaustStage::Stock;
        case EOpenGridSynthExhaustStage::RaceTitanium: return rs::ExhaustStage::RaceTitanium;
        case EOpenGridSynthExhaustStage::Sport:
        default:                                  return rs::ExhaustStage::Sport;
    }
}

rs::CameraPerspective ToCorePerspective(EOpenGridCameraPerspective P)
{
    switch (P)
    {
        case EOpenGridCameraPerspective::ExteriorRear:    return rs::CameraPerspective::ExteriorRear;
        case EOpenGridCameraPerspective::HoodBumper:      return rs::CameraPerspective::HoodBumper;
        case EOpenGridCameraPerspective::InteriorCockpit: return rs::CameraPerspective::InteriorCockpit;
        case EOpenGridCameraPerspective::ExteriorChase:
        default:                                          return rs::CameraPerspective::ExteriorChase;
    }
}

void StoreMaxAtomic(std::atomic<float>& Atom, float Candidate)
{
    float Current = Atom.load(std::memory_order_relaxed);
    while (Candidate > Current &&
           !Atom.compare_exchange_weak(Current, Candidate, std::memory_order_relaxed, std::memory_order_relaxed))
    {
    }
}

}  // namespace

UOpenGridEngineSynthComponent::UOpenGridEngineSynthComponent(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    NumChannels = 2;
}

UOpenGridEngineSynthComponent::~UOpenGridEngineSynthComponent() = default;

bool UOpenGridEngineSynthComponent::Init(int32& SampleRate)
{
    NumChannels = 2;
    ActiveSampleRate = (SampleRate > 0) ? SampleRate : 48000;

    TargetPerspective.store(static_cast<uint8>(CameraPerspective), std::memory_order_relaxed);
    ActiveStage.store(static_cast<uint8>(ExhaustStage), std::memory_order_relaxed);
    bActiveTurbo.store(bAftermarketTurbo, std::memory_order_relaxed);

    Synth = std::make_unique<rs::EngineAudioSynth>();
    rs::EngineAudioConfig Cfg{};
    Cfg.voice = ToCoreVoice(Voice);
    Cfg.sampleRate = ActiveSampleRate;
    Cfg.simFrequency = 8000;  // Numerically rock-solid thermodynamic combustion + 3-6x faster than real-time on desktop CPU
    Cfg.fluidSubsteps = 4;
    Cfg.exhaustStage = ToCoreStage(ExhaustStage);
    Cfg.turboEnabled = bAftermarketTurbo;
    if (!Synth->initialize(Cfg))
    {
        return false;
    }
    Synth->warmup(0.25f, 950.0f, 0.08f);
    return true;
}

void UOpenGridEngineSynthComponent::SetEngineTelemetry(
    float InRpm, float InThrottle, float InLoad, float InBoostBar, bool bInIgnitionCut, float InReverbMix)
{
    TargetRpm.store(InRpm, std::memory_order_relaxed);
    TargetThrottle.store(FMath::Clamp(InThrottle, 0.0f, 1.0f), std::memory_order_relaxed);
    TargetLoad.store(FMath::Clamp(InLoad, 0.0f, 1.0f), std::memory_order_relaxed);
    TargetBoostBar.store(FMath::Max(0.0f, InBoostBar), std::memory_order_relaxed);
    bTargetIgnitionCut.store(bInIgnitionCut, std::memory_order_relaxed);
    TargetReverbMix.store(FMath::Clamp(InReverbMix, 0.0f, 1.0f), std::memory_order_relaxed);
}

void UOpenGridEngineSynthComponent::SetCameraPerspective(EOpenGridCameraPerspective NewPerspective)
{
    CameraPerspective = NewPerspective;
    TargetPerspective.store(static_cast<uint8>(NewPerspective), std::memory_order_relaxed);
}

void UOpenGridEngineSynthComponent::SetAcousticEnvironment(
    float TunnelReflection, float WallProximityL, float WallProximityR)
{
    TargetTunnelReflection.store(FMath::Clamp(TunnelReflection, 0.0f, 1.0f), std::memory_order_relaxed);
    TargetWallProximityL.store(FMath::Clamp(WallProximityL, 0.0f, 1.0f), std::memory_order_relaxed);
    TargetWallProximityR.store(FMath::Clamp(WallProximityR, 0.0f, 1.0f), std::memory_order_relaxed);
}

void UOpenGridEngineSynthComponent::SetDrivetrainAcoustics(float GearWhineLevel, float VehicleSpeedMps)
{
    TargetGearWhineLevel.store(FMath::Clamp(GearWhineLevel, 0.0f, 1.0f), std::memory_order_relaxed);
    TargetVehicleSpeedMps.store(FMath::Max(0.0f, VehicleSpeedMps), std::memory_order_relaxed);
}

void UOpenGridEngineSynthComponent::TriggerExhaustPop(float Intensity)
{
    StoreMaxAtomic(PendingPopIntensity, FMath::Clamp(Intensity, 0.2f, 1.5f));
}

void UOpenGridEngineSynthComponent::TriggerTurboFlutter(float BoostBar)
{
    StoreMaxAtomic(PendingFlutterBoost, FMath::Clamp(BoostBar, 0.2f, 2.4f));
}

void UOpenGridEngineSynthComponent::TriggerStarterCrank(float DurationSec)
{
    StoreMaxAtomic(PendingStarterCrankSec, FMath::Clamp(DurationSec, 0.1f, 2.5f));
}

void UOpenGridEngineSynthComponent::TriggerOverrunBurble(float Intensity)
{
    StoreMaxAtomic(PendingOverrunBurbleIntensity, FMath::Clamp(Intensity, 0.1f, 1.25f));
}

void UOpenGridEngineSynthComponent::SetVoice(
    EOpenGridSynthVoice NewVoice, EOpenGridSynthExhaustStage NewStage, bool bHasTurbo)
{
    Voice = NewVoice;
    ExhaustStage = NewStage;
    bAftermarketTurbo = bHasTurbo;
    PendingVoice.store(static_cast<uint8>(NewVoice), std::memory_order_relaxed);
    PendingStage.store(static_cast<uint8>(NewStage), std::memory_order_relaxed);
    bPendingTurbo.store(bHasTurbo, std::memory_order_relaxed);
    ActiveStage.store(static_cast<uint8>(NewStage), std::memory_order_relaxed);
    bActiveTurbo.store(bHasTurbo, std::memory_order_relaxed);
    bPendingReinit.store(true, std::memory_order_release);
}

int32 UOpenGridEngineSynthComponent::OnGenerateAudio(float* OutAudio, int32 NumSamples)
{
    const int32 NumFrames = NumSamples / 2;
    if (!Synth || NumFrames <= 0)
    {
        FMemory::Memzero(OutAudio, sizeof(float) * NumSamples);
        return NumSamples;
    }

    if (bPendingReinit.exchange(false, std::memory_order_acquire))
    {
        const uint8 StageRaw = PendingStage.load(std::memory_order_relaxed);
        const bool bTurbo = bPendingTurbo.load(std::memory_order_relaxed);

        rs::EngineAudioConfig Cfg{};
        Cfg.voice = ToCoreVoice(static_cast<EOpenGridSynthVoice>(PendingVoice.load(std::memory_order_relaxed)));
        Cfg.sampleRate = ActiveSampleRate;
        Cfg.simFrequency = 8000;
        Cfg.fluidSubsteps = 4;
        Cfg.exhaustStage = ToCoreStage(static_cast<EOpenGridSynthExhaustStage>(StageRaw));
        Cfg.turboEnabled = bTurbo;
        Synth->initialize(Cfg);
        Synth->warmup(0.15f, TargetRpm.load(std::memory_order_relaxed), 0.1f);
    }

    const float CrankSec = PendingStarterCrankSec.exchange(0.0f, std::memory_order_relaxed);
    if (CrankSec > 0.05f) Synth->triggerStarterCrank(CrankSec);

    const float Pop = PendingPopIntensity.exchange(0.0f, std::memory_order_relaxed);
    if (Pop > 0.05f) Synth->triggerExhaustPop(Pop);

    const float Burble = PendingOverrunBurbleIntensity.exchange(0.0f, std::memory_order_relaxed);
    if (Burble > 0.05f) Synth->triggerOverrunBurble(Burble);

    const float Flut = PendingFlutterBoost.exchange(0.0f, std::memory_order_relaxed);
    if (Flut > 0.05f) Synth->triggerTurboFlutter(Flut);

    rs::EngineAudioControl Ctrl{};
    Ctrl.rpm = TargetRpm.load(std::memory_order_relaxed);
    Ctrl.throttle = TargetThrottle.load(std::memory_order_relaxed);
    Ctrl.load = TargetLoad.load(std::memory_order_relaxed);
    Ctrl.boostBar = TargetBoostBar.load(std::memory_order_relaxed);
    Ctrl.reverbMix = TargetReverbMix.load(std::memory_order_relaxed);
    Ctrl.ignitionCut = bTargetIgnitionCut.load(std::memory_order_relaxed);
    Ctrl.exhaustStage = ToCoreStage(static_cast<EOpenGridSynthExhaustStage>(ActiveStage.load(std::memory_order_relaxed)));
    Ctrl.turboEnabled = bActiveTurbo.load(std::memory_order_relaxed);
    Ctrl.perspective = ToCorePerspective(static_cast<EOpenGridCameraPerspective>(TargetPerspective.load(std::memory_order_relaxed)));
    Ctrl.tunnelReflection = TargetTunnelReflection.load(std::memory_order_relaxed);
    Ctrl.wallProximityL = TargetWallProximityL.load(std::memory_order_relaxed);
    Ctrl.wallProximityR = TargetWallProximityR.load(std::memory_order_relaxed);
    Ctrl.gearWhineLevel = TargetGearWhineLevel.load(std::memory_order_relaxed);
    Ctrl.vehicleSpeedMps = TargetVehicleSpeedMps.load(std::memory_order_relaxed);
    Synth->setControl(Ctrl);

    if (ScratchL.Num() < NumFrames)
    {
        ScratchL.SetNumUninitialized(NumFrames);
        ScratchR.SetNumUninitialized(NumFrames);
    }
    Synth->renderStereo(ScratchL.GetData(), ScratchR.GetData(), NumFrames);
    for (int32 i = 0; i < NumFrames; ++i)
    {
        OutAudio[i * 2 + 0] = ScratchL[i];
        OutAudio[i * 2 + 1] = ScratchR[i];
    }
    return NumFrames * 2;
}
