// Apache-2.0 — OpenGrid Real-Time Physical Vehicle Audio Component for Unreal Engine 5.8 (USynthComponent).
#include "OpenGridAudioComponent.h"
#include "OpenGridVehicleComponent.h"

#include <algorithm>
#include <cstring>

UOpenGridAudioComponent::UOpenGridAudioComponent(const FObjectInitializer& ObjectInitializer)
    : Super(ObjectInitializer)
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PostPhysics;
    bAutoActivate = true;
}

rs::EngineVoice UOpenGridAudioComponent::ResolveVoice(EOpenGridEngineVoice Voice, const UOpenGridVehicleComponent* Vehicle)
{
    switch (Voice)
    {
        case EOpenGridEngineVoice::V8Crossplane:   return rs::EngineVoice::V8Crossplane;
        case EOpenGridEngineVoice::V8Flatplane:    return rs::EngineVoice::V8Flatplane;
        case EOpenGridEngineVoice::V8Supercharged: return rs::EngineVoice::V8Supercharged;
        case EOpenGridEngineVoice::V8TwinTurbo:    return rs::EngineVoice::V8TwinTurbo;
        case EOpenGridEngineVoice::V12Na:          return rs::EngineVoice::V12Na;
        case EOpenGridEngineVoice::V10Screamer:    return rs::EngineVoice::V10Screamer;
        case EOpenGridEngineVoice::Flat6Na:        return rs::EngineVoice::Flat6Na;
        case EOpenGridEngineVoice::I6Forged:       return rs::EngineVoice::I6Forged;
        case EOpenGridEngineVoice::V6TwinTurbo:    return rs::EngineVoice::V6TwinTurbo;
        case EOpenGridEngineVoice::Rotary4:        return rs::EngineVoice::Rotary4;
        case EOpenGridEngineVoice::I4Turbo:        return rs::EngineVoice::I4Turbo;
        case EOpenGridEngineVoice::I5Turbo:        return rs::EngineVoice::I5Turbo;
        case EOpenGridEngineVoice::AutoFromCarSpec:
        default:
            if (Vehicle && Vehicle->bCarLoaded)
            {
                return rs::select_voice_for_car(Vehicle->GetCarConfig());
            }
            return rs::EngineVoice::V8Crossplane;
    }
}

void UOpenGridAudioComponent::BeginPlay()
{
    Super::BeginPlay();
    if (AActor* Owner = GetOwner())
    {
        VehicleComp_ = Owner->FindComponentByClass<UOpenGridVehicleComponent>();
    }
}

bool UOpenGridAudioComponent::Init(int32& SampleRate)
{
    NumChannels = 2;
    SampleRate = (SampleRate > 0) ? SampleRate : 48000;

    rs::VehicleAudioConfig Cfg{};
    Cfg.engine.voice = ResolveVoice(EngineVoice, VehicleComp_.Get());
    Cfg.engine.sampleRate = SampleRate;
    Cfg.engine.simFrequency = 5000;
    Cfg.engine.fluidSubsteps = 4;
    Cfg.engine.exhaustStage = static_cast<rs::ExhaustStage>(static_cast<uint8>(ExhaustStage));
    Cfg.masterGain = FMath::Clamp(MasterGain, 0.0f, 1.5f);

    if (Engine_.initialize(Cfg))
    {
        Engine_.warmup(0.05f, 1000.0f, 0.08f);
        bSynthReady_.store(true, std::memory_order_release);
        return true;
    }
    bSynthReady_.store(false, std::memory_order_release);
    return false;
}

void UOpenGridAudioComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
    Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
    UOpenGridVehicleComponent* Veh = VehicleComp_.Get();
    if (!Veh || !Veh->bCarLoaded) return;

    // Build lock-free telemetry snapshot from the latest physics output and publish via wait-free triple buffer.
    rs::VehicleAudioTelemetry& Dst = TelemetryTB_.write_buffer();
    Dst = rs::VehicleAudioTelemetry::from_vehicle_output(
        Veh->GetLastVehicleOutput(), Veh->GetCarConfig(), {0, 0, 0, 0},
        static_cast<double>(Veh->RoadWaterMm), static_cast<double>(Veh->StreetMarblesAtCar));
    Dst.starter_crank = Veh->bStarterCrank;
    Dst.exhaust_stage = static_cast<rs::ExhaustStage>(static_cast<uint8>(ExhaustStage));
    Dst.perspective = static_cast<rs::CameraPerspective>(static_cast<uint8>(Perspective));
    Dst.tunnel_reflection = FMath::Clamp(TunnelReflection, 0.0f, 1.0f);
    Dst.wall_proximity_l = FMath::Clamp(WallProximityLeft, 0.0f, 1.0f);
    Dst.wall_proximity_r = FMath::Clamp(WallProximityRight, 0.0f, 1.0f);
    Dst.overpass_reflection = FMath::Clamp(OverpassReflection, 0.0f, 1.0f);
    Dst.external_wastegate = bExternalWastegate;
    TelemetryTB_.publish();
}

void UOpenGridAudioComponent::TriggerStarterCrank(float DurationSec)
{
    PendingStarterSec_.store(FMath::Clamp(DurationSec, 0.15f, 2.5f), std::memory_order_relaxed);
}

void UOpenGridAudioComponent::TriggerExhaustPop(float Intensity)
{
    PendingPopIntensity_.store(FMath::Clamp(Intensity, 0.2f, 1.5f), std::memory_order_relaxed);
}

int32 UOpenGridAudioComponent::OnGenerateAudio(float* OutAudio, int32 NumSamples)
{
    if (!OutAudio || NumSamples <= 0) return 0;
    if (!bSynthReady_.load(std::memory_order_acquire))
    {
        std::memset(OutAudio, 0, sizeof(float) * static_cast<size_t>(NumSamples));
        return NumSamples;
    }

    if (TelemetryTB_.fetch())
    {
        Engine_.setTelemetry(TelemetryTB_.read_buffer());
    }
    const float Crank = PendingStarterSec_.exchange(0.0f, std::memory_order_relaxed);
    if (Crank > 0.0f) Engine_.triggerStarterCrank(Crank);
    const float Pop = PendingPopIntensity_.exchange(0.0f, std::memory_order_relaxed);
    if (Pop > 0.0f) Engine_.triggerExhaustPop(Pop);

    const int32 TotalFrames = NumSamples / 2;
    int32 FrameOffset = 0;
    while (FrameOffset < TotalFrames)
    {
        const int32 Chunk = FMath::Min(TotalFrames - FrameOffset, static_cast<int32>(ScratchL_.size()));
        Engine_.renderStereo(ScratchL_.data(), ScratchR_.data(), Chunk);
        for (int32 i = 0; i < Chunk; ++i)
        {
            OutAudio[(FrameOffset + i) * 2 + 0] = ScratchL_[i];
            OutAudio[(FrameOffset + i) * 2 + 1] = ScratchR_[i];
        }
        FrameOffset += Chunk;
    }
    return NumSamples;
}
