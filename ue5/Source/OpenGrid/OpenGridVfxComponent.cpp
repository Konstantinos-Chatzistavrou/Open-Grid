// Apache-2.0 — see OpenGridVfxComponent.h
#include "OpenGridVfxComponent.h"

#include "Components/PointLightComponent.h"
#include "Components/SceneComponent.h"
#include "GameFramework/Actor.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "NiagaraComponent.h"
#include "NiagaraFunctionLibrary.h"
#include "NiagaraSystem.h"

namespace
{
constexpr int32 kNumWheels = 4;
constexpr int32 kNumExhaustPipes = 2;
constexpr int32 kNumSparkPoolSlots = 2;

// Niagara User Parameter names (matching header documentation)
const FName kParamSpawnRate(TEXT("SpawnRate"));
const FName kParamTyreTempC(TEXT("TyreTempC"));
const FName kParamSlipIntensity(TEXT("SlipIntensity"));
const FName kParamVehicleSpeedMps(TEXT("VehicleSpeedMps"));
const FName kParamWetness(TEXT("Wetness"));
const FName kParamFlameIntensity(TEXT("FlameIntensity"));
const FName kParamBlueNos(TEXT("bBlueNos"));
const FName kParamHeatShimmer(TEXT("HeatShimmer"));
const FName kParamSparkVelocity(TEXT("SparkVelocity"));

// Dynamic material parameter names
const FName kMatBrakeDiscTempC(TEXT("BrakeDiscTempC"));
const FName kMatBrakeDiscGlow(TEXT("BrakeDiscGlow"));
const FName kMatBrakeDiscEmissiveColor(TEXT("BrakeDiscEmissiveColor"));
const FName kMatExhaustHeatShimmer(TEXT("ExhaustHeatShimmer"));

// Exhaust backfire ground-bounce light colors
const FLinearColor kBackfireAmberColor(1.0f, 0.42f, 0.10f, 1.0f);
const FLinearColor kBackfireBlueNosColor(0.22f, 0.58f, 1.0f, 1.0f);

void SetEmitterActiveState(UNiagaraComponent* Comp, bool bShouldEmit)
{
    if (!Comp) return;
    if (bShouldEmit)
    {
        if (!Comp->IsActive())
        {
            Comp->Activate(false);
        }
    }
    else
    {
        if (Comp->IsActive())
        {
            // Soft deactivate so already-spawned smoke/spray particles finish their natural lifetime cleanly.
            Comp->Deactivate();
        }
    }
}
}  // namespace

UOpenGridVfxComponent::UOpenGridVfxComponent()
{
    PrimaryComponentTick.bCanEverTick = false;

    WheelSocketNames = {
        FName(TEXT("SOCKET_Wheel_FL")),
        FName(TEXT("SOCKET_Wheel_FR")),
        FName(TEXT("SOCKET_Wheel_RL")),
        FName(TEXT("SOCKET_Wheel_RR")),
    };

    ExhaustSocketNames = {
        FName(TEXT("SOCKET_Exhaust_L")),
        FName(TEXT("SOCKET_Exhaust_R")),
    };

    BrakeThermalStates.SetNum(kNumWheels);
    BrakeRotorMaterials.SetNum(kNumWheels);
}

void UOpenGridVfxComponent::BeginPlay()
{
    Super::BeginPlay();

    if (BrakeThermalStates.Num() < kNumWheels)
    {
        BrakeThermalStates.SetNum(kNumWheels);
    }
    if (BrakeRotorMaterials.Num() < kNumWheels)
    {
        BrakeRotorMaterials.SetNum(kNumWheels);
    }

    InitializePooledComponents();
}

void UOpenGridVfxComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    auto DeactivatePool = [](TArray<TObjectPtr<UNiagaraComponent>>& Pool)
    {
        for (TObjectPtr<UNiagaraComponent>& Comp : Pool)
        {
            if (Comp)
            {
                Comp->DeactivateImmediate();
            }
        }
    };

    DeactivatePool(TyreSmokeComponents);
    DeactivatePool(RainSprayComponents);
    DeactivatePool(RoadDebrisComponents);
    DeactivatePool(ExhaustFlameComponents);
    DeactivatePool(UnderbodySparkComponents);

    if (ExhaustBackfireLight)
    {
        ExhaustBackfireLight->SetIntensity(0.0f);
        ExhaustBackfireLight->SetVisibility(false);
    }

    Super::EndPlay(EndPlayReason);
}

USceneComponent* UOpenGridVfxComponent::ResolveAttachRoot() const
{
    const AActor* Owner = GetOwner();
    return Owner ? Owner->GetRootComponent() : nullptr;
}

UNiagaraComponent* UOpenGridVfxComponent::CreatePooledEmitter(
    UNiagaraSystem* SystemAsset,
    USceneComponent* AttachParent,
    FName SocketName,
    const FVector& RelativeLocation,
    const FRotator& RelativeRotation)
{
    if (!SystemAsset || !AttachParent)
    {
        return nullptr;
    }

    const bool bHasSocket = !SocketName.IsNone() && AttachParent->DoesSocketExist(SocketName);
    const FName EffectiveSocket = bHasSocket ? SocketName : NAME_None;
    const FVector EffectiveOffset = bHasSocket ? FVector::ZeroVector : RelativeLocation;

    return UNiagaraFunctionLibrary::SpawnSystemAttached(
        SystemAsset,
        AttachParent,
        EffectiveSocket,
        EffectiveOffset,
        RelativeRotation,
        EAttachLocation::KeepRelativeOffset,
        /*bAutoDestroy=*/false,
        /*bAutoActivate=*/false,
        ENCPoolMethod::None,
        /*bPreCullCheck=*/false);
}

void UOpenGridVfxComponent::InitializePooledComponents()
{
    if (bPooledInitialized)
    {
        return;
    }
    bPooledInitialized = true;

    AActor* Owner = GetOwner();
    USceneComponent* AttachRoot = ResolveAttachRoot();
    if (!Owner || !AttachRoot)
    {
        return;
    }

    // 1. Per-wheel pooled Niagara systems (FL=0, FR=1, RL=2, RR=3)
    TyreSmokeComponents.SetNum(kNumWheels);
    RainSprayComponents.SetNum(kNumWheels);
    RoadDebrisComponents.SetNum(kNumWheels);

    for (int32 i = 0; i < kNumWheels; ++i)
    {
        const FName WheelSocket = WheelSocketNames.IsValidIndex(i) ? WheelSocketNames[i] : NAME_None;
        TyreSmokeComponents[i] = CreatePooledEmitter(
            TyreSmokeSystem.Get(), AttachRoot, WheelSocket, FVector::ZeroVector, FRotator::ZeroRotator);
        RainSprayComponents[i] = CreatePooledEmitter(
            RainSpraySystem.Get(), AttachRoot, WheelSocket, FVector::ZeroVector, FRotator::ZeroRotator);
        RoadDebrisComponents[i] = CreatePooledEmitter(
            RoadDebrisSystem.Get(), AttachRoot, WheelSocket, FVector::ZeroVector, FRotator::ZeroRotator);
    }

    // 2. Dual-tailpipe pooled exhaust flame & heat shimmer emitters (Left=0, Right=1)
    ExhaustFlameComponents.SetNum(kNumExhaustPipes);
    for (int32 i = 0; i < kNumExhaustPipes; ++i)
    {
        const FName ExhaustSocket = ExhaustSocketNames.IsValidIndex(i) ? ExhaustSocketNames[i] : NAME_None;
        const FVector FallbackOffset = (i == 0) ? ExhaustLeftFallbackOffsetCm : ExhaustRightFallbackOffsetCm;
        // Point rearwards (-X) by default when falling back to chassis offsets
        ExhaustFlameComponents[i] = CreatePooledEmitter(
            ExhaustFlameSystem.Get(), AttachRoot, ExhaustSocket, FallbackOffset, FRotator(0.0f, 180.0f, 0.0f));
    }

    // 3. Pooled underbody / wall-scrape titanium spark emitters (round-robin, zero runtime spawns)
    UnderbodySparkComponents.SetNum(kNumSparkPoolSlots);
    for (int32 i = 0; i < kNumSparkPoolSlots; ++i)
    {
        UnderbodySparkComponents[i] = CreatePooledEmitter(
            UnderbodySparkSystem.Get(), AttachRoot, NAME_None, FVector::ZeroVector, FRotator::ZeroRotator);
    }

    // 4. Pooled rear diffuser exhaust backfire ground-bounce point light (created ONCE, never spawned dynamically)
    if (!ExhaustBackfireLight)
    {
        UPointLightComponent* Light = NewObject<UPointLightComponent>(Owner, TEXT("OpenGridExhaustBackfireLight"));
        if (Light)
        {
            Light->SetMobility(EComponentMobility::Movable);
            Light->SetCastShadows(false);
            Light->SetAttenuationRadius(BackfireLightAttenuationRadiusCm);
            Light->SetSourceRadius(14.0f);
            Light->SetIntensity(0.0f);
            Light->SetLightColor(kBackfireAmberColor);
            Light->SetVisibility(false);
            Light->RegisterComponent();
            Light->AttachToComponent(AttachRoot, FAttachmentTransformRules::KeepRelativeTransform);
            Light->SetRelativeLocation(BackfireLightLocalOffsetCm);
            ExhaustBackfireLight = Light;
        }
    }
    else
    {
        ExhaustBackfireLight->SetCastShadows(false);
        ExhaustBackfireLight->SetIntensity(0.0f);
        ExhaustBackfireLight->SetVisibility(false);
    }
}

void UOpenGridVfxComponent::RegisterBrakeRotorMaterial(int32 WheelIndex, UMaterialInstanceDynamic* Material)
{
    if (WheelIndex < 0 || WheelIndex >= kNumWheels)
    {
        return;
    }
    if (BrakeRotorMaterials.Num() < kNumWheels)
    {
        BrakeRotorMaterials.SetNum(kNumWheels);
    }
    BrakeRotorMaterials[WheelIndex] = Material;
}

void UOpenGridVfxComponent::RegisterExhaustMaterial(UMaterialInstanceDynamic* Material)
{
    if (Material && !ExhaustMaterials.Contains(Material))
    {
        ExhaustMaterials.Add(Material);
    }
}

void UOpenGridVfxComponent::ResetThermalState()
{
    for (int32 i = 0; i < BrakeThermalStates.Num(); ++i)
    {
        BrakeThermalStates[i].TemperatureC = 45.0f;
        BrakeThermalStates[i].GlowAlpha = 0.0f;
        BrakeThermalStates[i].EmissiveColor = FLinearColor::Black;

        if (BrakeRotorMaterials.IsValidIndex(i) && BrakeRotorMaterials[i])
        {
            BrakeRotorMaterials[i]->SetScalarParameterValue(kMatBrakeDiscTempC, 45.0f);
            BrakeRotorMaterials[i]->SetScalarParameterValue(kMatBrakeDiscGlow, 0.0f);
            BrakeRotorMaterials[i]->SetVectorParameterValue(kMatBrakeDiscEmissiveColor, FLinearColor::Black);
        }
    }

    ExhaustGasTempC = 180.0f;
    ExhaustHeatShimmer = 0.0f;
    ActiveFlameIntensity = 0.0f;
    bActiveBlueNos = false;

    for (TObjectPtr<UMaterialInstanceDynamic>& Mat : ExhaustMaterials)
    {
        if (Mat)
        {
            Mat->SetScalarParameterValue(kMatExhaustHeatShimmer, 0.0f);
        }
    }

    if (ExhaustBackfireLight)
    {
        ExhaustBackfireLight->SetIntensity(0.0f);
        ExhaustBackfireLight->SetVisibility(false);
    }
}

FLinearColor UOpenGridVfxComponent::EvaluateBrakeBlackbodyColor(float TemperatureC, float MinTempC, float MaxTempC)
{
    const float Span = FMath::Max(1.0f, MaxTempC - MinTempC);
    const float T = FMath::Clamp((TemperatureC - MinTempC) / Span, 0.0f, 1.0f);
    if (T <= KINDA_SMALL_NUMBER)
    {
        return FLinearColor::Black;
    }

    // Physical blackbody ramp across 360..920 C:
    //   0.00 -> 0.35 : Dark cherry red
    //   0.35 -> 0.70 : Hot glowing crimson-orange
    //   0.70 -> 1.00 : Incandescent bright orange-yellow
    const FLinearColor DarkCherry(0.95f, 0.035f, 0.004f, 1.0f);
    const FLinearColor HotOrange(2.90f, 0.44f, 0.025f, 1.0f);
    const FLinearColor BrightYellowOrange(6.80f, 2.55f, 0.35f, 1.0f);

    if (T < 0.35f)
    {
        const float LocalT = FMath::SmoothStep(0.0f, 0.35f, T);
        return FMath::Lerp(FLinearColor::Black, DarkCherry, LocalT);
    }
    if (T < 0.70f)
    {
        const float LocalT = (T - 0.35f) / 0.35f;
        return FMath::Lerp(DarkCherry, HotOrange, LocalT);
    }
    const float LocalT = (T - 0.70f) / 0.30f;
    return FMath::Lerp(HotOrange, BrightYellowOrange, LocalT);
}

void UOpenGridVfxComponent::UpdateVehicleVfx(float DeltaTime, const FOpenGridVfxTelemetry& Telemetry)
{
    if (DeltaTime <= 0.0f)
    {
        return;
    }

    if (!bPooledInitialized)
    {
        InitializePooledComponents();
    }

    LastVehicleVelocityCms = Telemetry.VehicleVelocityCms;
    LastVehicleSpeedMps = FMath::Max(0.0f, Telemetry.SpeedMps);

    UpdateBrakeThermals(DeltaTime, Telemetry);
    UpdateWheelEmitters(Telemetry);
    UpdateExhaustAndLighting(DeltaTime, Telemetry);
}

void UOpenGridVfxComponent::UpdateBrakeThermals(float DeltaTime, const FOpenGridVfxTelemetry& Telemetry)
{
    if (BrakeThermalStates.Num() < kNumWheels)
    {
        BrakeThermalStates.SetNum(kNumWheels);
    }

    const float AmbientC = FMath::Clamp(Telemetry.AmbientTempC, -30.0f, 60.0f);
    const float SpeedMps = FMath::Max(0.0f, Telemetry.SpeedMps);
    const float ServiceBrake = FMath::Clamp(Telemetry.BrakeInput, 0.0f, 1.0f);
    const float Handbrake = FMath::Clamp(Telemetry.HandbrakeInput, 0.0f, 1.0f);

    // Convective airflow cooling coefficient: (TempC - AmbientC) * (0.045 + 0.011 * SpeedMps^0.8)
    const float ConvectiveCoeff = 0.045f + 0.011f * FMath::Pow(SpeedMps, 0.8f);
    const float GlowSpan = FMath::Max(1.0f, BrakeGlowMaxTempC - BrakeGlowMinTempC);

    for (int32 i = 0; i < kNumWheels; ++i)
    {
        FOpenGridBrakeThermalState& State = BrakeThermalStates[i];
        const bool bRearWheel = (i >= 2);
        const float EffectiveBrake = bRearWheel ? FMath::Max(ServiceBrake * 0.78f, Handbrake) : ServiceBrake;

        float WheelLoadN = 0.0f;
        if (Telemetry.Wheels.IsValidIndex(i) && Telemetry.Wheels[i].bInContact)
        {
            WheelLoadN = FMath::Max(0.0f, Telemetry.Wheels[i].NormalLoadN);
        }

        const float HeatingDegPerSec = EffectiveBrake * WheelLoadN * SpeedMps * BrakeHeatFactor;
        const float CoolingDegPerSec = FMath::Max(0.0f, State.TemperatureC - AmbientC) * ConvectiveCoeff;

        State.TemperatureC = FMath::Clamp(
            State.TemperatureC + (HeatingDegPerSec - CoolingDegPerSec) * DeltaTime,
            20.0f,
            950.0f);

        State.GlowAlpha = FMath::Clamp((State.TemperatureC - BrakeGlowMinTempC) / GlowSpan, 0.0f, 1.0f);
        State.EmissiveColor = EvaluateBrakeBlackbodyColor(State.TemperatureC, BrakeGlowMinTempC, BrakeGlowMaxTempC);

        if (BrakeRotorMaterials.IsValidIndex(i) && BrakeRotorMaterials[i])
        {
            UMaterialInstanceDynamic* Mid = BrakeRotorMaterials[i];
            Mid->SetScalarParameterValue(kMatBrakeDiscTempC, State.TemperatureC);
            Mid->SetScalarParameterValue(kMatBrakeDiscGlow, State.GlowAlpha);
            Mid->SetVectorParameterValue(kMatBrakeDiscEmissiveColor, State.EmissiveColor);
        }
    }
}

void UOpenGridVfxComponent::UpdateWheelEmitters(const FOpenGridVfxTelemetry& Telemetry)
{
    const float SpeedMps = FMath::Max(0.0f, Telemetry.SpeedMps);
    const int32 NumTelemetryWheels = FMath::Min(kNumWheels, Telemetry.Wheels.Num());

    for (int32 i = 0; i < kNumWheels; ++i)
    {
        const bool bHaveWheel = (i < NumTelemetryWheels);
        const FOpenGridWheelVfxTelemetry Wheel = bHaveWheel ? Telemetry.Wheels[i] : FOpenGridWheelVfxTelemetry{};
        const float Wetness = FMath::Clamp(FMath::Max(Telemetry.GlobalWetness, Wheel.Wetness), 0.0f, 1.0f);
        const float Slip = FMath::Max(0.0f, Wheel.SlipIntensity);
        const float LoadFactor = FMath::Clamp(Wheel.NormalLoadN / 3500.0f, 0.25f, 1.4f);

        // 1. Dry drift / burnout tyre smoke (attenuated by standing water on soaked asphalt)
        if (TyreSmokeComponents.IsValidIndex(i) && TyreSmokeComponents[i])
        {
            UNiagaraComponent* Smoke = TyreSmokeComponents[i];
            if (Wheel.bInContact && !Wheel.ContactPointWorldCm.IsNearlyZero())
            {
                Smoke->SetWorldLocation(Wheel.ContactPointWorldCm);
            }

            const float DryMask = 1.0f - FMath::Clamp(Wetness * 0.85f, 0.0f, 0.85f);
            const float TempBoost = FMath::Clamp((Wheel.TyreTempC - 65.0f) / 60.0f, 0.35f, 1.35f);
            const float SlipOverThresh = FMath::Max(0.0f, Slip - 0.16f);
            const float SmokeRate = (Wheel.bInContact && SlipOverThresh > 0.0f)
                ? FMath::Clamp(SlipOverThresh * 1.45f * TempBoost * LoadFactor * DryMask, 0.0f, 2.5f)
                : 0.0f;

            Smoke->SetVariableFloat(kParamSpawnRate, SmokeRate);
            Smoke->SetVariableFloat(kParamTyreTempC, Wheel.TyreTempC);
            Smoke->SetVariableFloat(kParamSlipIntensity, Slip);
            Smoke->SetVariableFloat(kParamVehicleSpeedMps, SpeedMps);
            Smoke->SetVariableFloat(kParamWetness, Wetness);
            SetEmitterActiveState(Smoke, SmokeRate > 0.02f);
        }

        // 2. Wet-road rooster-tail water spray & mist wake
        if (RainSprayComponents.IsValidIndex(i) && RainSprayComponents[i])
        {
            UNiagaraComponent* Spray = RainSprayComponents[i];
            if (Wheel.bInContact && !Wheel.ContactPointWorldCm.IsNearlyZero())
            {
                Spray->SetWorldLocation(Wheel.ContactPointWorldCm);
            }

            const float SpeedSpray = FMath::Clamp((SpeedMps - 4.0f) / 42.0f, 0.0f, 1.5f);
            const float SlipSpray = FMath::Clamp(Slip * 0.55f, 0.0f, 0.85f);
            const float SprayRate = (Wheel.bInContact && Wetness > 0.05f && (SpeedMps > 4.0f || Slip > 0.25f))
                ? FMath::Clamp(Wetness * (SpeedSpray + SlipSpray) * LoadFactor, 0.0f, 2.5f)
                : 0.0f;

            Spray->SetVariableFloat(kParamSpawnRate, SprayRate);
            Spray->SetVariableFloat(kParamSlipIntensity, Slip);
            Spray->SetVariableFloat(kParamVehicleSpeedMps, SpeedMps);
            Spray->SetVariableFloat(kParamWetness, Wetness);
            SetEmitterActiveState(Spray, SprayRate > 0.02f);
        }

        // 3. Gravel / off-road roost & curb dust
        if (RoadDebrisComponents.IsValidIndex(i) && RoadDebrisComponents[i])
        {
            UNiagaraComponent* Debris = RoadDebrisComponents[i];
            if (Wheel.bInContact && !Wheel.ContactPointWorldCm.IsNearlyZero())
            {
                Debris->SetWorldLocation(Wheel.ContactPointWorldCm);
            }

            const float DebrisRate = (Wheel.bInContact && Wheel.DebrisIntensity > 0.05f && SpeedMps > 2.0f)
                ? FMath::Clamp(Wheel.DebrisIntensity * (0.45f + FMath::Clamp(SpeedMps / 35.0f, 0.0f, 1.2f) + Slip * 0.6f), 0.0f, 2.5f)
                : 0.0f;

            Debris->SetVariableFloat(kParamSpawnRate, DebrisRate);
            Debris->SetVariableFloat(kParamSlipIntensity, Slip);
            Debris->SetVariableFloat(kParamVehicleSpeedMps, SpeedMps);
            Debris->SetVariableFloat(kParamWetness, Wetness);
            SetEmitterActiveState(Debris, DebrisRate > 0.02f);
        }
    }
}

void UOpenGridVfxComponent::UpdateExhaustAndLighting(float DeltaTime, const FOpenGridVfxTelemetry& Telemetry)
{
    const float SpeedMps = FMath::Max(0.0f, Telemetry.SpeedMps);
    const float Redline = FMath::Max(3000.0f, Telemetry.RedlineRpm);
    const float RpmNorm = FMath::Clamp(Telemetry.EngineRpm / Redline, 0.0f, 1.15f);
    const float Load = FMath::Clamp(FMath::Max(Telemetry.Throttle, Telemetry.EngineLoad), 0.0f, 1.0f);

    // Continuous NOS flamethrower override when nitrous is actively spraying
    if (Telemetry.bNitrousActive)
    {
        ActiveFlameIntensity = FMath::Max(ActiveFlameIntensity, 0.95f);
        bActiveBlueNos = true;
    }
    else
    {
        // Fast crisp decay for backfire flashes (~150 ms visual tail)
        ActiveFlameIntensity = FMath::FInterpTo(ActiveFlameIntensity, 0.0f, DeltaTime, 12.5f);
        if (ActiveFlameIntensity < 0.02f)
        {
            ActiveFlameIntensity = 0.0f;
            bActiveBlueNos = false;
        }
    }

    // Exhaust Gas Temperature (EGT) drives tailpipe heat shimmer smoothly
    const float TargetEgtC = FMath::Clamp(
        Telemetry.AmbientTempC + 140.0f + RpmNorm * 380.0f + Load * 280.0f + ActiveFlameIntensity * 240.0f - SpeedMps * 1.4f,
        120.0f,
        980.0f);
    const float EgtInterpSpeed = (TargetEgtC > ExhaustGasTempC) ? 2.4f : 0.75f;
    ExhaustGasTempC = FMath::FInterpTo(ExhaustGasTempC, TargetEgtC, DeltaTime, EgtInterpSpeed);

    // Shimmer is most visible when exhaust is hot and airflow speed hasn't completely sheared the plume away
    const float ThermalFactor = FMath::Clamp((ExhaustGasTempC - 220.0f) / 520.0f, 0.0f, 1.0f);
    const float SpeedShearMask = FMath::Clamp(1.0f - (SpeedMps / 75.0f) * 0.55f, 0.35f, 1.0f);
    ExhaustHeatShimmer = FMath::Clamp(ThermalFactor * SpeedShearMask + ActiveFlameIntensity * 0.25f, 0.0f, 1.0f);

    // Push ExhaustHeatShimmer onto registered exhaust material instances
    for (TObjectPtr<UMaterialInstanceDynamic>& Mat : ExhaustMaterials)
    {
        if (Mat)
        {
            Mat->SetScalarParameterValue(kMatExhaustHeatShimmer, ExhaustHeatShimmer);
        }
    }

    // Drive dual-tailpipe Niagara emitters (flame + heat shimmer)
    const bool bEmitExhaust = (ActiveFlameIntensity > 0.02f) || (ExhaustHeatShimmer > 0.08f);
    for (int32 i = 0; i < ExhaustFlameComponents.Num(); ++i)
    {
        UNiagaraComponent* Pipe = ExhaustFlameComponents[i];
        if (!Pipe) continue;

        Pipe->SetVariableFloat(kParamSpawnRate, FMath::Max(ActiveFlameIntensity, ExhaustHeatShimmer * 0.35f));
        Pipe->SetVariableFloat(kParamFlameIntensity, ActiveFlameIntensity);
        Pipe->SetVariableBool(kParamBlueNos, bActiveBlueNos);
        Pipe->SetVariableFloat(kParamHeatShimmer, ExhaustHeatShimmer);
        Pipe->SetVariableFloat(kParamVehicleSpeedMps, SpeedMps);
        SetEmitterActiveState(Pipe, bEmitExhaust);
    }

    // Drive pooled rear diffuser ground-bounce point light (zero runtime allocations)
    if (ExhaustBackfireLight)
    {
        if (ActiveFlameIntensity > 0.015f)
        {
            const float LightIntensity = ActiveFlameIntensity * BackfireLightMaxIntensity;
            ExhaustBackfireLight->SetLightColor(bActiveBlueNos ? kBackfireBlueNosColor : kBackfireAmberColor);
            ExhaustBackfireLight->SetIntensity(LightIntensity);
            if (!ExhaustBackfireLight->IsVisible())
            {
                ExhaustBackfireLight->SetVisibility(true);
            }
        }
        else if (ExhaustBackfireLight->IsVisible())
        {
            ExhaustBackfireLight->SetIntensity(0.0f);
            ExhaustBackfireLight->SetVisibility(false);
        }
    }
}

void UOpenGridVfxComponent::TriggerExhaustBackfire(float Intensity, bool bBlueNos)
{
    if (!bPooledInitialized)
    {
        InitializePooledComponents();
    }

    const float ClampedIntensity = FMath::Clamp(Intensity, 0.15f, 1.5f);
    ActiveFlameIntensity = FMath::Max(ActiveFlameIntensity, ClampedIntensity);
    bActiveBlueNos = bBlueNos;

    // Immediately push spike to tailpipe emitters and pooled bounce light so single-frame bangs never lag a frame
    for (TObjectPtr<UNiagaraComponent>& Pipe : ExhaustFlameComponents)
    {
        if (!Pipe) continue;
        Pipe->SetVariableFloat(kParamSpawnRate, ActiveFlameIntensity);
        Pipe->SetVariableFloat(kParamFlameIntensity, ActiveFlameIntensity);
        Pipe->SetVariableBool(kParamBlueNos, bActiveBlueNos);
        Pipe->SetVariableFloat(kParamHeatShimmer, FMath::Max(ExhaustHeatShimmer, 0.65f));
        Pipe->SetVariableFloat(kParamVehicleSpeedMps, LastVehicleSpeedMps);
        if (!Pipe->IsActive())
        {
            Pipe->Activate(false);
        }
    }

    if (ExhaustBackfireLight)
    {
        ExhaustBackfireLight->SetLightColor(bActiveBlueNos ? kBackfireBlueNosColor : kBackfireAmberColor);
        ExhaustBackfireLight->SetIntensity(ActiveFlameIntensity * BackfireLightMaxIntensity);
        ExhaustBackfireLight->SetVisibility(true);
    }
}

void UOpenGridVfxComponent::TriggerSparkBurst(FVector WorldLoc, FVector WorldNormal, float Intensity)
{
    if (!bPooledInitialized)
    {
        InitializePooledComponents();
    }

    if (UnderbodySparkComponents.Num() == 0)
    {
        return;
    }

    UNiagaraComponent* SparkComp = UnderbodySparkComponents[NextSparkPoolIndex % UnderbodySparkComponents.Num()];
    NextSparkPoolIndex = (NextSparkPoolIndex + 1) % UnderbodySparkComponents.Num();
    if (!SparkComp)
    {
        return;
    }

    const float ClampedIntensity = FMath::Clamp(Intensity, 0.15f, 2.0f);
    const FVector SafeNormal = WorldNormal.IsNearlyZero() ? FVector::UpVector : WorldNormal.GetSafeNormal();
    const FRotator BurstRot = FRotationMatrix::MakeFromZ(SafeNormal).Rotator();

    // Sparks shower backward relative to travel + rebound outward from the struck surface
    const FVector TangentialVel = LastVehicleVelocityCms - FVector::DotProduct(LastVehicleVelocityCms, SafeNormal) * SafeNormal;
    const FVector SparkVelocity = (-TangentialVel * 0.65f) + (SafeNormal * (240.0f + 460.0f * ClampedIntensity));

    SparkComp->SetWorldLocationAndRotation(WorldLoc, BurstRot);
    SparkComp->SetVariableFloat(kParamSpawnRate, ClampedIntensity);
    SparkComp->SetVariableFloat(kParamVehicleSpeedMps, LastVehicleSpeedMps);
    SparkComp->SetVariableVec3(kParamSparkVelocity, SparkVelocity);
    SparkComp->Activate(true);
}
