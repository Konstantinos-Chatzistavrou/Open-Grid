// Apache-2.0 — Real-Time Physical Combustion Engine Audio Component for UE 5.8 (USynthComponent).
#include "OpenGridEngineSynthComponent.h"

#include "rs/engine_audio.h"

namespace {

rs::EngineVoice ToCoreVoice(EOpenGridEngineVoice V)
{
    switch (V)
    {
        case EOpenGridEngineVoice::V8Flatplane:    return rs::EngineVoice::V8Flatplane;
        case EOpenGridEngineVoice::V8Supercharged: return rs::EngineVoice::V8Supercharged;
        case EOpenGridEngineVoice::V8TwinTurbo:    return rs::EngineVoice::V8TwinTurbo;
        case EOpenGridEngineVoice::V12Na:          return rs::EngineVoice::V12Na;
        case EOpenGridEngineVoice::V10Screamer:    return rs::EngineVoice::V10Screamer;
        case EOpenGridEngineVoice::Flat6Na:        return rs::EngineVoice::Flat6Na;
        case EOpenGridEngineVoice::I6Forged:       return rs::EngineVoice::I6Forged;
        case EOpenGridEngineVoice::V6TwinTurbo:    return rs::EngineVoice::V6TwinTurbo;
        case EOpenGridEngineVoice::Rotary4:        return rs::EngineVoice::Rotary4;
        case EOpenGridEngineVoice::V8Crossplane:
        default:                                   return rs::EngineVoice::V8Crossplane;
    }
}

rs::ExhaustStage ToCoreStage(EOpenGridExhaustStage S)
{
    switch (S)
    {
        case EOpenGridExhaustStage::Stock:        return rs::ExhaustStage::Stock;
        case EOpenGridExhaustStage::RaceTitanium: return rs::ExhaustStage::RaceTitanium;
        case EOpenGridExhaustStage::Sport:
        default:                                  return rs::ExhaustStage::Sport;
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
    TargetThrottle.store(InThrottle, std::memory_order_relaxed);
    TargetLoad.store(InLoad, std::memory_order_relaxed);
    TargetBoostBar.store(InBoostBar, std::memory_order_relaxed);
    bTargetIgnitionCut.store(bInIgnitionCut, std::memory_order_relaxed);
    TargetReverbMix.store(InReverbMix, std::memory_order_relaxed);
}

void UOpenGridEngineSynthComponent::TriggerExhaustPop(float Intensity)
{
    PendingPopIntensity.store(FMath::Clamp(Intensity, 0.2f, 1.5f), std::memory_order_relaxed);
}

void UOpenGridEngineSynthComponent::TriggerTurboFlutter(float BoostBar)
{
    PendingFlutterBoost.store(FMath::Clamp(BoostBar, 0.2f, 2.4f), std::memory_order_relaxed);
}

void UOpenGridEngineSynthComponent::SetVoice(
    EOpenGridEngineVoice NewVoice, EOpenGridExhaustStage NewStage, bool bHasTurbo)
{
    Voice = NewVoice;
    ExhaustStage = NewStage;
    bAftermarketTurbo = bHasTurbo;
    PendingVoice.store(static_cast<uint8>(NewVoice), std::memory_order_relaxed);
    PendingStage.store(static_cast<uint8>(NewStage), std::memory_order_relaxed);
    bPendingTurbo.store(bHasTurbo, std::memory_order_relaxed);
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
        rs::EngineAudioConfig Cfg{};
        Cfg.voice = ToCoreVoice(static_cast<EOpenGridEngineVoice>(PendingVoice.load(std::memory_order_relaxed)));
        Cfg.sampleRate = ActiveSampleRate;
        Cfg.simFrequency = 8000;
        Cfg.fluidSubsteps = 4;
        Cfg.exhaustStage = ToCoreStage(static_cast<EOpenGridExhaustStage>(PendingStage.load(std::memory_order_relaxed)));
        Cfg.turboEnabled = bPendingTurbo.load(std::memory_order_relaxed);
        Synth->initialize(Cfg);
        Synth->warmup(0.15f, TargetRpm.load(std::memory_order_relaxed), 0.1f);
    }

    const float Pop = PendingPopIntensity.exchange(0.0f, std::memory_order_relaxed);
    if (Pop > 0.05f) Synth->triggerExhaustPop(Pop);

    const float Flut = PendingFlutterBoost.exchange(0.0f, std::memory_order_relaxed);
    if (Flut > 0.05f) Synth->triggerTurboFlutter(Flut);

    rs::EngineAudioControl Ctrl{};
    Ctrl.rpm = TargetRpm.load(std::memory_order_relaxed);
    Ctrl.throttle = TargetThrottle.load(std::memory_order_relaxed);
    Ctrl.load = TargetLoad.load(std::memory_order_relaxed);
    Ctrl.boostBar = TargetBoostBar.load(std::memory_order_relaxed);
    Ctrl.reverbMix = TargetReverbMix.load(std::memory_order_relaxed);
    Ctrl.ignitionCut = bTargetIgnitionCut.load(std::memory_order_relaxed);
    Ctrl.exhaustStage = ToCoreStage(ExhaustStage);
    Ctrl.turboEnabled = bAftermarketTurbo;
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
