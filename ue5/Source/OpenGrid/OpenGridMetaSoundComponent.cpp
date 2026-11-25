// Apache-2.0 — see OpenGridMetaSoundComponent.h
#include "OpenGridMetaSoundComponent.h"

#include "Components/AudioComponent.h"
#include "GameFramework/Actor.h"
#include "OpenGridVehicleComponent.h"
#include "Sound/SoundBase.h"

namespace
{
// Named MetaSound float parameters
const FName kParamRpm(TEXT("Rpm"));
const FName kParamThrottle(TEXT("Throttle"));
const FName kParamExhaustPrimaryHz(TEXT("ExhaustPrimaryHz"));
const FName kParamGearWhineHz(TEXT("GearWhineHz"));
const FName kParamTurboSurge(TEXT("TurboSurge"));
const FName kParamKerbLoadRatio(TEXT("KerbLoadRatio"));
const FName kParamSurfaceExcitation(TEXT("SurfaceExcitation"));
const FName kParamWheelSlip(TEXT("WheelSlip"));
const FName kParamSpeedKmh(TEXT("SpeedKmh"));
const FName kParamIsWet(TEXT("IsWet"));
const FName kParamBoostBar(TEXT("BoostBar"));
const FName kParamTurboWhistleHz(TEXT("TurboWhistleHz"));
const FName kParamOverrunPopIntensity(TEXT("OverrunPopIntensity"));
const FName kParamGear(TEXT("Gear"));

// Named MetaSound trigger parameters
const FName kTriggerBlowOffValve(TEXT("OnBlowOffValve"));
const FName kTriggerBackfire(TEXT("OnBackfire"));
const FName kTriggerGearGrind(TEXT("OnGearGrind"));
const FName kTriggerMissedShift(TEXT("OnMissedShift"));
const FName kTriggerScrape(TEXT("OnScrape"));
const FName kTriggerGearShift(TEXT("OnGearShift"));
}  // namespace

UOpenGridMetaSoundComponent::UOpenGridMetaSoundComponent()
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PostPhysics;
}

void UOpenGridMetaSoundComponent::BindVehicle(UOpenGridVehicleComponent* InVehicle)
{
    if (Vehicle_.Get() == InVehicle) return;
    UnbindVehicleDelegates();
    Vehicle_ = InVehicle;
    if (HasBegunPlay())
    {
        BindVehicleDelegates();
    }
}

void UOpenGridMetaSoundComponent::SetWetness(float InWetness)
{
    Wetness = FMath::Clamp(InWetness, 0.0f, 1.0f);
    Telemetry.IsWet = Wetness;
    if (AudioComponent)
    {
        AudioComponent->SetFloatParameter(kParamIsWet, Telemetry.IsWet);
    }
}

void UOpenGridMetaSoundComponent::FireAudioTrigger(FName TriggerName)
{
    if (AudioComponent && !TriggerName.IsNone())
    {
        AudioComponent->SetTriggerParameter(TriggerName);
    }
}

void UOpenGridMetaSoundComponent::ResolveComponents()
{
    AActor* Owner = GetOwner();
    if (!Owner) return;

    if (!Vehicle_.IsValid())
    {
        Vehicle_ = Owner->FindComponentByClass<UOpenGridVehicleComponent>();
    }

    if (!AudioComponent)
    {
        AudioComponent = Owner->FindComponentByClass<UAudioComponent>();
    }

    if (!AudioComponent)
    {
        UAudioComponent* NewAudio = NewObject<UAudioComponent>(Owner, TEXT("OpenGridEngineAudio"));
        if (NewAudio)
        {
            NewAudio->bAutoActivate = false;
            NewAudio->bAllowSpatialization = true;
            NewAudio->RegisterComponent();
            if (USceneComponent* Root = Owner->GetRootComponent())
            {
                NewAudio->AttachToComponent(Root, FAttachmentTransformRules::SnapToTargetNotIncludingScale);
            }
            AudioComponent = NewAudio;
        }
    }

    if (AudioComponent && EngineSoundAsset && AudioComponent->Sound != EngineSoundAsset)
    {
        AudioComponent->SetSound(EngineSoundAsset);
    }
}

void UOpenGridMetaSoundComponent::BindVehicleDelegates()
{
    if (bDelegatesBound_) return;
    UOpenGridVehicleComponent* Vehicle = Vehicle_.Get();
    if (!Vehicle) return;

    Vehicle->OnBlowOffValveVent.AddDynamic(this, &UOpenGridMetaSoundComponent::HandleBlowOffValve);
    Vehicle->OnBackfire.AddDynamic(this, &UOpenGridMetaSoundComponent::HandleBackfire);
    Vehicle->OnGearGrind.AddDynamic(this, &UOpenGridMetaSoundComponent::HandleGearGrind);
    Vehicle->OnMissedShift.AddDynamic(this, &UOpenGridMetaSoundComponent::HandleMissedShift);
    Vehicle->OnScrape.AddDynamic(this, &UOpenGridMetaSoundComponent::HandleScrape);
    bDelegatesBound_ = true;
    LastGear_ = Vehicle->CurrentGear;
}

void UOpenGridMetaSoundComponent::UnbindVehicleDelegates()
{
    if (!bDelegatesBound_) return;
    if (UOpenGridVehicleComponent* Vehicle = Vehicle_.Get())
    {
        Vehicle->OnBlowOffValveVent.RemoveDynamic(this, &UOpenGridMetaSoundComponent::HandleBlowOffValve);
        Vehicle->OnBackfire.RemoveDynamic(this, &UOpenGridMetaSoundComponent::HandleBackfire);
        Vehicle->OnGearGrind.RemoveDynamic(this, &UOpenGridMetaSoundComponent::HandleGearGrind);
        Vehicle->OnMissedShift.RemoveDynamic(this, &UOpenGridMetaSoundComponent::HandleMissedShift);
        Vehicle->OnScrape.RemoveDynamic(this, &UOpenGridMetaSoundComponent::HandleScrape);
    }
    bDelegatesBound_ = false;
}

void UOpenGridMetaSoundComponent::BeginPlay()
{
    Super::BeginPlay();
    ResolveComponents();
    BindVehicleDelegates();

    if (bAutoPlay && AudioComponent && AudioComponent->Sound && !AudioComponent->IsPlaying())
    {
        AudioComponent->Play();
    }
}

void UOpenGridMetaSoundComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    UnbindVehicleDelegates();
    if (AudioComponent && AudioComponent->IsPlaying())
    {
        AudioComponent->Stop();
    }
    Super::EndPlay(EndPlayReason);
}

void UOpenGridMetaSoundComponent::HandleBlowOffValve(float BoostBarReleased)
{
    TurboSurgeDecay_ = FMath::Max(TurboSurgeDecay_, FMath::Clamp(BoostBarReleased / 1.5f, 0.25f, 1.0f));
    FireAudioTrigger(kTriggerBlowOffValve);
}

void UOpenGridMetaSoundComponent::HandleBackfire(float /*Intensity*/)
{
    FireAudioTrigger(kTriggerBackfire);
}

void UOpenGridMetaSoundComponent::HandleGearGrind(int32 /*AttemptedGear*/)
{
    FireAudioTrigger(kTriggerGearGrind);
}

void UOpenGridMetaSoundComponent::HandleMissedShift(int32 /*TotalMissedShifts*/, float /*SimTimeSeconds*/)
{
    FireAudioTrigger(kTriggerMissedShift);
}

void UOpenGridMetaSoundComponent::HandleScrape(float /*ImpactEnergyKj*/)
{
    FireAudioTrigger(kTriggerScrape);
}

void UOpenGridMetaSoundComponent::PushFloatParameters() const
{
    if (!AudioComponent) return;

    AudioComponent->SetFloatParameter(kParamRpm, Telemetry.Rpm);
    AudioComponent->SetFloatParameter(kParamThrottle, Telemetry.Throttle);
    AudioComponent->SetFloatParameter(kParamExhaustPrimaryHz, Telemetry.ExhaustPrimaryHz);
    AudioComponent->SetFloatParameter(kParamGearWhineHz, Telemetry.GearWhineHz);
    AudioComponent->SetFloatParameter(kParamTurboSurge, Telemetry.TurboSurge);
    AudioComponent->SetFloatParameter(kParamKerbLoadRatio, Telemetry.KerbLoadRatio);
    AudioComponent->SetFloatParameter(kParamSurfaceExcitation, Telemetry.SurfaceExcitation);
    AudioComponent->SetFloatParameter(kParamWheelSlip, Telemetry.WheelSlip);
    AudioComponent->SetFloatParameter(kParamSpeedKmh, Telemetry.SpeedKmh);
    AudioComponent->SetFloatParameter(kParamIsWet, Telemetry.IsWet);
    AudioComponent->SetFloatParameter(kParamBoostBar, Telemetry.BoostBar);
    AudioComponent->SetFloatParameter(kParamTurboWhistleHz, Telemetry.TurboWhistleHz);
    AudioComponent->SetFloatParameter(kParamOverrunPopIntensity, Telemetry.OverrunPopIntensity);
    AudioComponent->SetIntParameter(kParamGear, Telemetry.Gear);
}

void UOpenGridMetaSoundComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
    Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
    if (DeltaTime <= 0.0f) return;

    if (!Vehicle_.IsValid() || !AudioComponent)
    {
        ResolveComponents();
        BindVehicleDelegates();
    }

    const UOpenGridVehicleComponent* Vehicle = Vehicle_.Get();
    if (!Vehicle || !Vehicle->bCarLoaded) return;

    const float SpeedKmh = FMath::Max(0.0f, Vehicle->SpeedKmh);
    const float Throttle = FMath::Clamp(Vehicle->ThrottleInput, 0.0f, 1.0f);
    const float BoostBar = FMath::Max(0.0f, Vehicle->BoostBar);

    // Turbo surge: peaks when lifting off throttle under boost or while BOV is venting.
    const float ThrottleDrop = FMath::Max(0.0f, PrevThrottle_ - Throttle);
    const float BoostDrop = FMath::Max(0.0f, PrevBoostBar_ - BoostBar);
    if (Vehicle->bBovVenting || (ThrottleDrop > 0.25f && PrevBoostBar_ > 0.25f))
    {
        const float Impulse = FMath::Clamp(FMath::Max(PrevBoostBar_, BoostBar) * 0.7f + BoostDrop * 1.5f, 0.0f, 1.0f);
        TurboSurgeDecay_ = FMath::Max(TurboSurgeDecay_, Impulse);
    }
    TurboSurgeDecay_ = FMath::FInterpTo(TurboSurgeDecay_, 0.0f, DeltaTime, 4.5f);
    PrevBoostBar_ = BoostBar;
    PrevThrottle_ = Throttle;

    // Derive KerbLoadRatio, SurfaceExcitation, and WheelSlip across all 4 wheels from rs_core WheelStates.
    float MaxWheelSlip = 0.0f;
    float MaxCavityRing = 0.0f;
    float MaxFlatSpot = 0.0f;
    float KerbRateAccum = 0.0f;
    int32 GroundedCount = 0;

    const int32 NumWheels = FMath::Min(4, Vehicle->WheelStates.Num());
    for (int32 i = 0; i < NumWheels; ++i)
    {
        const FOpenGridWheelState& W = Vehicle->WheelStates[i];
        if (W.bInContact)
        {
            ++GroundedCount;
            const float LongSlip = FMath::Abs(W.SlipRatio);
            const float LatSlip = FMath::Abs(W.SlipAngleDeg) / 14.0f;
            const float CombinedSlip = FMath::Sqrt(LongSlip * LongSlip + LatSlip * LatSlip);
            MaxWheelSlip = FMath::Max(MaxWheelSlip, CombinedSlip);

            MaxCavityRing = FMath::Max(MaxCavityRing, FMath::Clamp(W.CavityRingGain, 0.0f, 1.0f));
            MaxFlatSpot = FMath::Max(MaxFlatSpot, FMath::Clamp(W.FlatSpotDepthMm / 1.5f, 0.0f, 1.0f));

            if (bHasPrevWheelSample_)
            {
                const float CompRateCmS = FMath::Abs(W.SuspensionCompressionCm - PrevWheelCompressionCm_[i]) / DeltaTime;
                // High-frequency suspension chatter (> 30 cm/s) + cavity ring characterizes rumble strips / kerbs.
                const float WheelKerb = FMath::Clamp((CompRateCmS - 18.0f) / 110.0f, 0.0f, 1.0f);
                KerbRateAccum = FMath::Max(KerbRateAccum, WheelKerb);
            }
        }
        PrevWheelCompressionCm_[i] = W.SuspensionCompressionCm;
    }
    bHasPrevWheelSample_ = (NumWheels == 4);

    const float SpeedNorm = FMath::Clamp(SpeedKmh / 240.0f, 0.0f, 1.0f);
    const float KerbLoadRatio = FMath::Clamp(FMath::Max(KerbRateAccum, MaxCavityRing * 0.85f) * (GroundedCount > 0 ? 1.0f : 0.0f), 0.0f, 1.0f);
    const float BaseRoadExcitation = (GroundedCount > 0) ? (SpeedNorm * 0.55f + MaxCavityRing * 0.35f + MaxFlatSpot * 0.25f) : 0.0f;
    const float SurfaceExcitation = FMath::Clamp(BaseRoadExcitation + (Vehicle->bScrapeActive ? 0.45f : 0.0f), 0.0f, 1.0f);

    Telemetry.Rpm = Vehicle->EngineRpm;
    Telemetry.Throttle = Throttle;
    Telemetry.ExhaustPrimaryHz = (Vehicle->ExhaustPrimaryHz > 0.0f) ? Vehicle->ExhaustPrimaryHz : Vehicle->FundamentalFiringHz;
    Telemetry.GearWhineHz = (Vehicle->GearWhineHz > 0.0f) ? Vehicle->GearWhineHz : Vehicle->TransmissionWhineHz;
    Telemetry.TurboSurge = FMath::Clamp(TurboSurgeDecay_, 0.0f, 1.0f);
    Telemetry.KerbLoadRatio = KerbLoadRatio;
    Telemetry.SurfaceExcitation = SurfaceExcitation;
    Telemetry.WheelSlip = FMath::Clamp(MaxWheelSlip, 0.0f, 1.0f);
    Telemetry.SpeedKmh = SpeedKmh;
    Telemetry.IsWet = FMath::Clamp(Wetness, 0.0f, 1.0f);
    Telemetry.BoostBar = BoostBar;
    Telemetry.TurboWhistleHz = Vehicle->TurboWhistleHz;
    Telemetry.OverrunPopIntensity = Vehicle->OverrunPopIntensity;
    Telemetry.Gear = Vehicle->CurrentGear;

    if (Vehicle->CurrentGear != LastGear_)
    {
        LastGear_ = Vehicle->CurrentGear;
        FireAudioTrigger(kTriggerGearShift);
    }

    PushFloatParameters();
}
