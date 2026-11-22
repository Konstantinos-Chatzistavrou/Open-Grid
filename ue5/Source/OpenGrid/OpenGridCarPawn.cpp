// Apache-2.0 — see OpenGridCarPawn.h
#include "OpenGridCarPawn.h"

#include "Camera/CameraComponent.h"
#include "CollisionQueryParams.h"
#include "Components/BoxComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/HitResult.h"
#include "Engine/LocalPlayer.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "OpenGridAudioComponent.h"
#include "OpenGridCustomizationComponent.h"
#include "OpenGridDamageComponent.h"
#include "OpenGridEngineSynthComponent.h"
#include "OpenGridVehicleComponent.h"
#include "OpenGridVfxComponent.h"
#include "UObject/ConstructorHelpers.h"

DEFINE_LOG_CATEGORY_STATIC(LogOpenGridPawn, Log, All);

AOpenGridCarPawn::AOpenGridCarPawn()
{
    PrimaryActorTick.bCanEverTick = true;
    PrimaryActorTick.TickGroup = TG_PostPhysics;   // place wheels and camera after the physics step

    static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeMesh(TEXT("/Engine/BasicShapes/Cube.Cube"));
    static ConstructorHelpers::FObjectFinder<UStaticMesh> CylinderMesh(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));

    // Chassis box centred on the CG (so the body's centre of mass is the root's origin). Its bottom sits ~20 cm above
    // the road at rest: the suspension carries the car, the box only collides with walls, kerbs and other cars.
    Chassis = CreateDefaultSubobject<UBoxComponent>(TEXT("Chassis"));
    Chassis->SetBoxExtent(FVector(210.0f, 88.0f, 25.0f));
    Chassis->SetCollisionProfileName(TEXT("PhysicsActor"));
    Chassis->SetSimulatePhysics(true);
    Chassis->SetLinearDamping(0.0f);    // the core models drag and rolling resistance itself
    Chassis->SetAngularDamping(0.0f);
    Chassis->SetNotifyRigidBodyCollision(true);
    RootComponent = Chassis;

    BodyMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("BodyMesh"));
    BodyMesh->SetupAttachment(Chassis);
    BodyMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    if (CubeMesh.Succeeded())
    {
        BodyMesh->SetStaticMesh(CubeMesh.Object);
        BodyMesh->SetRelativeScale3D(FVector(4.4f, 1.85f, 0.75f));   // 4.4 x 1.85 x 0.75 m
        BodyMesh->SetRelativeLocation(FVector(0.0f, 0.0f, 20.0f));
    }

    DeformableBodyMesh = CreateDefaultSubobject<USkeletalMeshComponent>(TEXT("DeformableBodyMesh"));
    DeformableBodyMesh->SetupAttachment(Chassis);
    DeformableBodyMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
    DeformableBodyMesh->SetVisibility(false);

    auto MakeModPart = [&](const TCHAR* Name) -> UStaticMeshComponent*
    {
        UStaticMeshComponent* Part = CreateDefaultSubobject<UStaticMeshComponent>(Name);
        Part->SetupAttachment(BodyMesh);
        Part->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Part->SetVisibility(false);
        return Part;
    };
    WidebodyMesh = MakeModPart(TEXT("WidebodyMesh"));
    StockWingMesh = MakeModPart(TEXT("StockWingMesh"));
    WingMesh = MakeModPart(TEXT("WingMesh"));
    SplitterMesh = MakeModPart(TEXT("SplitterMesh"));
    DiffuserMesh = MakeModPart(TEXT("DiffuserMesh"));
    SkirtsMesh = MakeModPart(TEXT("SkirtsMesh"));

    static const TCHAR* WheelNames[4] = {TEXT("WheelFL"), TEXT("WheelFR"), TEXT("WheelRL"), TEXT("WheelRR")};
    static const TCHAR* CaliperNames[4] = {TEXT("CaliperFL"), TEXT("CaliperFR"), TEXT("CaliperRL"), TEXT("CaliperRR")};
    for (int32 i = 0; i < 4; ++i)
    {
        UStaticMeshComponent* W = CreateDefaultSubobject<UStaticMeshComponent>(WheelNames[i]);
        W->SetupAttachment(Chassis);
        W->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        if (CylinderMesh.Succeeded()) W->SetStaticMesh(CylinderMesh.Object);
        Wheels.Add(W);

        UStaticMeshComponent* C = CreateDefaultSubobject<UStaticMeshComponent>(CaliperNames[i]);
        C->SetupAttachment(Chassis);
        C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        C->SetVisibility(false);
        Calipers.Add(C);
    }

    // Low and close, like the NFS Heat chase camera (docs/heat-reference-comparison.md).
    CameraArm = CreateDefaultSubobject<USpringArmComponent>(TEXT("CameraArm"));
    CameraArm->SetupAttachment(Chassis);
    CameraArm->TargetArmLength = 560.0f;
    CameraArm->SocketOffset = FVector(0.0f, 0.0f, 95.0f);
    CameraArm->SetRelativeRotation(FRotator(-7.0f, 0.0f, 0.0f));
    CameraArm->bEnableCameraLag = true;
    CameraArm->CameraLagSpeed = 12.0f;
    CameraArm->bEnableCameraRotationLag = true;
    CameraArm->CameraRotationLagSpeed = 8.0f;
    CameraArm->bInheritRoll = false;
    CameraArm->bInheritPitch = false;
    CameraArm->bDoCollisionTest = true;

    Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
    Camera->SetupAttachment(CameraArm, USpringArmComponent::SocketName);
    Camera->SetFieldOfView(75.0f);

    Vehicle = CreateDefaultSubobject<UOpenGridVehicleComponent>(TEXT("Vehicle"));
    Vehicle->CarConfigRelativePath = TEXT("cars/kestrel_gt.json");

    Customization = CreateDefaultSubobject<UOpenGridCustomizationComponent>(TEXT("Customization"));
    Damage = CreateDefaultSubobject<UOpenGridDamageComponent>(TEXT("Damage"));
    Audio = CreateDefaultSubobject<UOpenGridAudioComponent>(TEXT("Audio"));

    EngineSynth = CreateDefaultSubobject<UOpenGridEngineSynthComponent>(TEXT("EngineSynth"));
    EngineSynth->SetupAttachment(Chassis);
    EngineSynth->SetRelativeLocation(FVector(-180.0f, 0.0f, 10.0f));
    EngineSynth->bAutoActivate = true;

    VehicleVfx = CreateDefaultSubobject<UOpenGridVfxComponent>(TEXT("VehicleVfx"));
}

void AOpenGridCarPawn::BeginPlay()
{
    // Size the body from the car's visual spec before the vehicle component sets mass and inertia from the shape.
    if (Vehicle->PreloadCarSpec() && Vehicle->VisualSpec.bValid)
    {
        const FOpenGridVisualSpec& V = Vehicle->VisualSpec;
        // The box stays centred on the CG (the body's centre of mass must be the root's origin, which is the core's
        // chassis origin); its depth is limited so its bottom clears the road at ride height.
        FVector Extent = V.CollisionBoxExtentCm;
        Extent.Z = FMath::Min(Extent.Z, FMath::Max(10.0, static_cast<double>(Vehicle->CgHeightCm) - 12.0));
        Chassis->SetBoxExtent(Extent);
        if (BodyMeshAsset)
        {
            BodyMesh->SetStaticMesh(BodyMeshAsset);
            BodyMesh->SetRelativeScale3D(FVector::OneVector);
            BodyMesh->SetRelativeLocation(FVector::ZeroVector - V.CgInModelCm);
            BodyMesh->SetRelativeRotation(BodyMeshRotation);
        }
        else
        {
            BodyMesh->SetRelativeScale3D(FVector(Extent.X * 2.0 / 100.0, Extent.Y * 2.0 / 100.0, 0.75));
        }
        if (DeformableBodyMesh && DeformableBodyMeshAsset)
        {
            DeformableBodyMesh->SetSkeletalMeshAsset(DeformableBodyMeshAsset);
            DeformableBodyMesh->SetRelativeScale3D(FVector::OneVector);
            DeformableBodyMesh->SetRelativeLocation(FVector::ZeroVector - V.CgInModelCm);
            DeformableBodyMesh->SetRelativeRotation(BodyMeshRotation);
            DeformableBodyMesh->SetVisibility(true);
            BodyMesh->SetVisibility(false);
        }
    }
    ApplyVisualMods();
    for (int32 i = 0; i < 4 && i < WheelMeshes.Num(); ++i)
    {
        if (WheelMeshes[i]) Wheels[i]->SetStaticMesh(WheelMeshes[i]);
    }
    for (int32 i = 0; i < 4 && i < CaliperMeshes.Num(); ++i)
    {
        if (CaliperMeshes[i])
        {
            Calipers[i]->SetStaticMesh(CaliperMeshes[i]);
            Calipers[i]->SetVisibility(true);
        }
    }

    if (StockWingMesh && StockWingMeshAsset)
    {
        USceneComponent* ParentComp = (DeformableBodyMesh && DeformableBodyMesh->IsVisible())
                                          ? static_cast<USceneComponent*>(DeformableBodyMesh.Get())
                                          : static_cast<USceneComponent*>(BodyMesh.Get());
        const FName WingSocket(TEXT("SOCKET_Wing"));
        const FName AttachSocket = (ParentComp && ParentComp->DoesSocketExist(WingSocket)) ? WingSocket : NAME_None;
        if (ParentComp)
        {
            StockWingMesh->AttachToComponent(ParentComp, FAttachmentTransformRules::SnapToTargetNotIncludingScale, AttachSocket);
        }
        StockWingMesh->SetStaticMesh(StockWingMeshAsset);
        StockWingMesh->SetRelativeLocation(FVector::ZeroVector);
        StockWingMesh->SetRelativeRotation(FRotator::ZeroRotator);
        StockWingMesh->SetRelativeScale3D(FVector::OneVector);
        StockWingMesh->SetVisibility(true);
    }

    if (Customization)
    {
        TArray<UStaticMeshComponent*> WheelPtrs;
        for (const TObjectPtr<UStaticMeshComponent>& W : Wheels) WheelPtrs.Add(W.Get());
        TArray<UStaticMeshComponent*> CaliperPtrs;
        for (const TObjectPtr<UStaticMeshComponent>& C : Calipers) CaliperPtrs.Add(C.Get());
        Customization->BindPawnMeshes(DeformableBodyMesh.Get(), BodyMesh.Get(), StockWingMesh.Get(), WheelPtrs, CaliperPtrs);
    }

    if (Damage)
    {
        Damage->BindPawnComponents(Vehicle.Get(), DeformableBodyMesh.Get());
        if (StockWingMesh)
        {
            Damage->RegisterDetachableComponent(TEXT("stock_wing"), StockWingMesh.Get(), EOpenGridDamageZone::Rear, 0.35f);
        }
    }

    if (Audio)
    {
        Audio->BindVehicle(Vehicle.Get());
    }

    Super::BeginPlay();

    if (EngineSynth)
    {
        EngineSynth->SetCameraPerspective(ActiveCameraPerspective);
        if (!EngineSynth->IsPlaying())
        {
            EngineSynth->Start();
        }
    }
}

// ---- Input ----------------------------------------------------------------------------------------------------------

UInputAction* AOpenGridCarPawn::MakeAction(const TCHAR* Name, bool bAxis)
{
    UInputAction* A = NewObject<UInputAction>(this, FName(Name));
    A->ValueType = bAxis ? EInputActionValueType::Axis1D : EInputActionValueType::Boolean;
    return A;
}

void AOpenGridCarPawn::MapKey(UInputAction* Action, const FKey& Key, bool bNegate)
{
    FEnhancedActionKeyMapping& Mapping = InputContext->MapKey(Action, Key);
    if (bNegate) Mapping.Modifiers.Add(NewObject<UInputModifierNegate>(this));
}

void AOpenGridCarPawn::BuildInput()
{
    if (InputContext) return;
    InputContext = NewObject<UInputMappingContext>(this, TEXT("OpenGridDriving"));

    KbSteer = MakeAction(TEXT("KbSteer"), true);
    KbThrottle = MakeAction(TEXT("KbThrottle"), true);
    KbBrake = MakeAction(TEXT("KbBrake"), true);
    PadSteer = MakeAction(TEXT("PadSteer"), true);
    PadThrottle = MakeAction(TEXT("PadThrottle"), true);
    PadBrake = MakeAction(TEXT("PadBrake"), true);
    Handbrake = MakeAction(TEXT("Handbrake"), true);
    ShiftUpAction = MakeAction(TEXT("ShiftUp"), false);
    ShiftDownAction = MakeAction(TEXT("ShiftDown"), false);
    RecoverAction = MakeAction(TEXT("Recover"), false);

    // The core's steering convention is +1 = left, so right-hand inputs are negated.
    MapKey(KbSteer, EKeys::A);
    MapKey(KbSteer, EKeys::Left);
    MapKey(KbSteer, EKeys::D, true);
    MapKey(KbSteer, EKeys::Right, true);
    MapKey(KbThrottle, EKeys::W);
    MapKey(KbThrottle, EKeys::Up);
    MapKey(KbBrake, EKeys::S);
    MapKey(KbBrake, EKeys::Down);
    MapKey(PadSteer, EKeys::Gamepad_LeftX, true);
    MapKey(PadThrottle, EKeys::Gamepad_RightTriggerAxis);
    MapKey(PadBrake, EKeys::Gamepad_LeftTriggerAxis);
    MapKey(Handbrake, EKeys::SpaceBar);
    MapKey(Handbrake, EKeys::Gamepad_FaceButton_Bottom);
    MapKey(ShiftUpAction, EKeys::E);
    MapKey(ShiftUpAction, EKeys::Gamepad_RightShoulder);
    MapKey(ShiftDownAction, EKeys::Q);
    MapKey(ShiftDownAction, EKeys::Gamepad_LeftShoulder);
    MapKey(RecoverAction, EKeys::R);
    MapKey(RecoverAction, EKeys::Gamepad_FaceButton_Right);
}

void AOpenGridCarPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);
    UEnhancedInputComponent* EIC = Cast<UEnhancedInputComponent>(PlayerInputComponent);
    if (!EIC)
    {
        UE_LOG(LogOpenGridPawn, Error, TEXT("Input component is not UEnhancedInputComponent: check Config/DefaultInput.ini"));
        return;
    }
    BuildInput();
    BoundInput = EIC;
    for (UInputAction* A : {KbSteer.Get(), KbThrottle.Get(), KbBrake.Get(), PadSteer.Get(), PadThrottle.Get(),
                            PadBrake.Get(), Handbrake.Get()})
    {
        EIC->BindActionValue(A);
    }
    EIC->BindAction(ShiftUpAction, ETriggerEvent::Started, this, &AOpenGridCarPawn::OnShiftUp);
    EIC->BindAction(ShiftDownAction, ETriggerEvent::Started, this, &AOpenGridCarPawn::OnShiftDown);
    EIC->BindAction(RecoverAction, ETriggerEvent::Started, this, &AOpenGridCarPawn::OnRecover);
}

void AOpenGridCarPawn::PawnClientRestart()
{
    Super::PawnClientRestart();
    BuildInput();
    if (APlayerController* PC = Cast<APlayerController>(GetController()))
    {
        if (UEnhancedInputLocalPlayerSubsystem* Sub = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
        {
            Sub->ClearAllMappings();
            Sub->AddMappingContext(InputContext, 0);
        }
    }
}

float AOpenGridCarPawn::ActionValue(const UInputAction* Action) const
{
    return BoundInput && Action ? BoundInput->GetBoundActionValue(Action).Get<float>() : 0.0f;
}

void AOpenGridCarPawn::OnShiftUp() { Vehicle->ShiftUp(); }
void AOpenGridCarPawn::OnShiftDown() { Vehicle->ShiftDown(); }
void AOpenGridCarPawn::OnRecover() { Recover(); }

void AOpenGridCarPawn::SetCameraPerspective(EOpenGridCameraPerspective NewPerspective)
{
    ActiveCameraPerspective = NewPerspective;
    if (EngineSynth)
    {
        EngineSynth->SetCameraPerspective(NewPerspective);
    }
}

void AOpenGridCarPawn::Recover()
{
    Vehicle->RepairAndService();   // as the web build's R: fix damage, refuel, restore the engine
    if (Damage) Damage->RepairAllDamage();
    if (VehicleVfx) VehicleVfx->ResetThermalState();
    const FRotator Yaw(0.0f, GetActorRotation().Yaw, 0.0f);
    Chassis->SetWorldLocationAndRotation(GetActorLocation() + FVector(0.0f, 0.0f, 100.0f), Yaw, false, nullptr, ETeleportType::TeleportPhysics);
    Chassis->SetPhysicsLinearVelocity(FVector::ZeroVector);
    Chassis->SetPhysicsAngularVelocityInDegrees(FVector::ZeroVector);
}

// ---- Per frame ------------------------------------------------------------------------------------------------------

void AOpenGridCarPawn::Tick(float DeltaSeconds)
{
    Super::Tick(DeltaSeconds);

    // Inputs for the vehicle's next steps. A pad that is being used wins over the keyboard; the device tells the core
    // how to shape the input (keyboard ramps vs analog curve).
    const float PadSteerV = ActionValue(PadSteer);
    const float PadThrottleV = ActionValue(PadThrottle);
    const float PadBrakeV = ActionValue(PadBrake);
    const bool bPad = FMath::Abs(PadSteerV) > 0.05f || PadThrottleV > 0.05f || PadBrakeV > 0.05f;
    Vehicle->InputDevice = bPad ? EOpenGridInputDevice::Gamepad : EOpenGridInputDevice::Keyboard;
    Vehicle->SteerInput = bPad ? PadSteerV : FMath::Clamp(ActionValue(KbSteer), -1.0f, 1.0f);
    Vehicle->ThrottleInput = bPad ? PadThrottleV : FMath::Clamp(ActionValue(KbThrottle), 0.0f, 1.0f);
    Vehicle->BrakeInput = bPad ? PadBrakeV : FMath::Clamp(ActionValue(KbBrake), 0.0f, 1.0f);
    Vehicle->HandbrakeInput = FMath::Clamp(ActionValue(Handbrake), 0.0f, 1.0f);

    PlaceWheels();
    UpdateAcousticEnvironmentProbes(DeltaSeconds);
    UpdateEngineAudioAndVfx(DeltaSeconds);
    if (!Damage || !Damage->IsComponentTickEnabled())
    {
        UpdateCrushMorphTargets();
    }
    if (bShowDebugHud) DrawHud();
}

void AOpenGridCarPawn::UpdateAcousticEnvironmentProbes(float DeltaSeconds)
{
    if (DeltaSeconds <= 0.0f || !Chassis)
    {
        return;
    }

    constexpr float kAcousticProbeIntervalSec = 1.0f / 15.0f;  // ~15 Hz throttle
    constexpr float kAcousticProbeRangeCm = 1500.0f;           // 15 m range

    AcousticProbeTimer_ += DeltaSeconds;
    if (AcousticProbeTimer_ >= kAcousticProbeIntervalSec)
    {
        AcousticProbeTimer_ = 0.0f;

        if (UWorld* World = GetWorld())
        {
            const FVector ProbeOrigin = Chassis->GetComponentLocation() + Chassis->GetUpVector() * 45.0f;
            const FVector RightAxis = Chassis->GetRightVector();

            FCollisionQueryParams QueryParams(SCENE_QUERY_STAT(OpenGridAcousticProbe), /*bTraceComplex=*/false, this);

            auto ProbeRay = [&](const FVector& Direction) -> float
            {
                FHitResult Hit;
                const FVector End = ProbeOrigin + Direction * kAcousticProbeRangeCm;
                if (!World->LineTraceSingleByChannel(Hit, ProbeOrigin, End, ECC_Visibility, QueryParams))
                {
                    return 0.0f;
                }
                const float LinearProximity = 1.0f - FMath::Clamp(Hit.Distance / kAcousticProbeRangeCm, 0.0f, 1.0f);
                return FMath::Pow(LinearProximity, 1.35f);
            };

            TargetTunnelReflection_ = ProbeRay(FVector::UpVector);
            TargetWallProximityL_ = ProbeRay(-RightAxis);
            TargetWallProximityR_ = ProbeRay(RightAxis);
        }
    }

    constexpr float kAcousticInterpSpeed = 8.0f;
    SmoothedTunnelReflection_ = FMath::FInterpTo(SmoothedTunnelReflection_, TargetTunnelReflection_, DeltaSeconds, kAcousticInterpSpeed);
    SmoothedWallProximityL_ = FMath::FInterpTo(SmoothedWallProximityL_, TargetWallProximityL_, DeltaSeconds, kAcousticInterpSpeed);
    SmoothedWallProximityR_ = FMath::FInterpTo(SmoothedWallProximityR_, TargetWallProximityR_, DeltaSeconds, kAcousticInterpSpeed);

    if (EngineSynth)
    {
        EngineSynth->SetAcousticEnvironment(SmoothedTunnelReflection_, SmoothedWallProximityL_, SmoothedWallProximityR_);
    }
}

void AOpenGridCarPawn::UpdateEngineAudioAndVfx(float DeltaSeconds)
{
    if (DeltaSeconds <= 0.0f || !Vehicle || !Vehicle->bCarLoaded)
    {
        return;
    }

    BackfireCooldown_ = FMath::Max(0.0f, BackfireCooldown_ - DeltaSeconds);
    OverrunCooldown_ = FMath::Max(0.0f, OverrunCooldown_ - DeltaSeconds);
    SparkCooldown_ = FMath::Max(0.0f, SparkCooldown_ - DeltaSeconds);

    const float Rpm = Vehicle->EngineRpm;
    const float Throttle = FMath::Clamp(Vehicle->ThrottleInput, 0.0f, 1.0f);
    const float Brake = FMath::Clamp(Vehicle->BrakeInput, 0.0f, 1.0f);
    const float Handbrake = FMath::Clamp(Vehicle->HandbrakeInput, 0.0f, 1.0f);
    const float SpeedMps = FMath::Max(0.0f, Vehicle->SpeedKmh / 3.6f);
    const float BoostBar = FMath::Max(0.0f, Vehicle->BoostBar);
    const int32 CurrentGear = Vehicle->CurrentGear;
    const bool bShiftCut = Vehicle->bShiftCutActive;
    const bool bBackfire = Vehicle->bBackfireActive;
    const bool bBovVenting = Vehicle->bBovVenting;
    const bool bStarterCrank = Vehicle->bStarterCrank;
    const bool bNosActive = Vehicle->bNitrousActive;
    const float Wetness = Audio ? FMath::Clamp(Audio->Wetness, 0.0f, 1.0f) : 0.0f;

    const float EngineLoad = bShiftCut
        ? 0.05f
        : FMath::Clamp(Throttle * 0.85f + FMath::Clamp(BoostBar * 0.25f, 0.0f, 0.25f), 0.0f, 1.0f);

    const float WhineHz = (Vehicle->GearWhineHz > 0.0f) ? Vehicle->GearWhineHz : Vehicle->TransmissionWhineHz;
    const bool bInGear = (CurrentGear != 1);
    const float GearWhineLevel = bInGear
        ? FMath::Clamp((WhineHz / 2400.0f) * (0.25f + 0.75f * FMath::Max(Throttle, Brake)), 0.0f, 1.0f)
        : 0.0f;

    const float ReverbMix = FMath::Clamp(
        0.14f + SmoothedTunnelReflection_ * 0.48f + 0.18f * FMath::Max(SmoothedWallProximityL_, SmoothedWallProximityR_),
        0.08f,
        0.85f);

    // 1. Push continuous telemetry to live physical combustion synthesizer
    if (EngineSynth)
    {
        EngineSynth->SetCameraPerspective(ActiveCameraPerspective);
        EngineSynth->SetEngineTelemetry(Rpm, Throttle, EngineLoad, BoostBar, bShiftCut, ReverbMix);
        EngineSynth->SetDrivetrainAcoustics(GearWhineLevel, SpeedMps);
    }

    // 2. Synced audio + VFX impulse events (skip edge triggers on very first frame after spawn)
    if (bHasPrevAudioVfxSample_)
    {
        // Starter motor crank rising edge
        if (bStarterCrank && !bPrevStarterCrank_ && EngineSynth)
        {
            EngineSynth->TriggerStarterCrank(0.42f);
        }

        // High-RPM upshift bang (flat-foot / DCT ignition-cut crack + dual-tailpipe flame)
        const bool bHighRpmUpshift =
            ((CurrentGear > PrevGear_) && (PrevGear_ >= 2) && (Rpm > 4800.0f)) ||
            (bShiftCut && !bPrevShiftCut_ && (Rpm > 5000.0f));
        if (bHighRpmUpshift && BackfireCooldown_ <= 0.0f)
        {
            const float ShiftIntensity = FMath::Clamp((Rpm - 4400.0f) / 3400.0f, 0.50f, 1.25f);
            if (EngineSynth)
            {
                EngineSynth->TriggerExhaustPop(ShiftIntensity);
            }
            if (VehicleVfx)
            {
                VehicleVfx->TriggerExhaustBackfire(FMath::Min(ShiftIntensity, 1.0f), bNosActive);
            }
            BackfireCooldown_ = 0.14f;
        }

        // Lift-off overrun burble / crackle + hot exhaust flames at high RPM
        const float ThrottleDrop = PrevThrottle_ - Throttle;
        const bool bLiftOffOverrun =
            (ThrottleDrop > 0.30f && Throttle < 0.12f && Rpm > 3500.0f) ||
            (Vehicle->OverrunPopIntensity > 0.30f && Throttle < 0.15f && Rpm > 3200.0f);
        if (bLiftOffOverrun && OverrunCooldown_ <= 0.0f)
        {
            const float BurbleIntensity = FMath::Clamp(
                FMath::Max((Rpm - 3200.0f) / 4500.0f, Vehicle->OverrunPopIntensity),
                0.35f,
                1.0f);
            if (EngineSynth)
            {
                EngineSynth->TriggerOverrunBurble(BurbleIntensity);
            }
            if (VehicleVfx && Rpm > 4900.0f && BackfireCooldown_ <= 0.0f)
            {
                VehicleVfx->TriggerExhaustBackfire(BurbleIntensity * 0.72f, false);
                BackfireCooldown_ = 0.18f;
            }
            OverrunCooldown_ = 0.26f;
        }

        // Physics-core backfire event
        if (bBackfire && !bPrevBackfire_ && BackfireCooldown_ <= 0.0f)
        {
            const float CorePopIntensity = FMath::Clamp(FMath::Max(0.85f, Vehicle->OverrunPopIntensity), 0.5f, 1.2f);
            if (EngineSynth)
            {
                EngineSynth->TriggerExhaustPop(CorePopIntensity);
            }
            if (VehicleVfx)
            {
                VehicleVfx->TriggerExhaustBackfire(FMath::Min(CorePopIntensity, 1.0f), bNosActive);
            }
            BackfireCooldown_ = 0.14f;
        }

        // Compressor-surge BOV flutter on boosted lift-off
        if (EngineSynth && ((bBovVenting && !bPrevBovVenting_) || (ThrottleDrop > 0.30f && PrevBoostBar_ > 0.45f)))
        {
            EngineSynth->TriggerTurboFlutter(FMath::Max(PrevBoostBar_, BoostBar));
        }

        // Underbody titanium spark bursts on chassis scrape / bottoming
        if (VehicleVfx && Chassis && Vehicle->bScrapeActive && SpeedMps > 3.0f && SparkCooldown_ <= 0.0f)
        {
            const FVector UpAxis = Chassis->GetUpVector();
            const FVector SparkLoc = Chassis->GetComponentLocation() - UpAxis * Chassis->GetScaledBoxExtent().Z;
            const float SparkIntensity = FMath::Clamp(SpeedMps / 28.0f, 0.45f, 1.5f);
            VehicleVfx->TriggerSparkBurst(SparkLoc, UpAxis, SparkIntensity);
            SparkCooldown_ = 0.08f;
        }
    }

    bHasPrevAudioVfxSample_ = true;
    PrevGear_ = CurrentGear;
    PrevThrottle_ = Throttle;
    PrevBoostBar_ = BoostBar;
    bPrevShiftCut_ = bShiftCut;
    bPrevBackfire_ = bBackfire;
    bPrevBovVenting_ = bBovVenting;
    bPrevStarterCrank_ = bStarterCrank;

    // 3. Push full vehicle & 4-wheel telemetry into Niagara VFX Director
    if (VehicleVfx)
    {
        FOpenGridVfxTelemetry VfxTel;
        VfxTel.EngineRpm = Rpm;
        VfxTel.RedlineRpm = 7800.0f;
        VfxTel.Throttle = Throttle;
        VfxTel.EngineLoad = EngineLoad;
        VfxTel.BrakeInput = Brake;
        VfxTel.HandbrakeInput = Handbrake;
        VfxTel.SpeedMps = SpeedMps;
        VfxTel.AmbientTempC = Vehicle->AmbientAirCelsius;
        VfxTel.GlobalWetness = Wetness;
        VfxTel.bNitrousActive = bNosActive;
        VfxTel.bScrapeActive = Vehicle->bScrapeActive;
        VfxTel.VehicleVelocityCms = Chassis ? Chassis->GetPhysicsLinearVelocity() : FVector::ZeroVector;

        VfxTel.Wheels.SetNum(4);
        const int32 NumWheelStates = FMath::Min(4, Vehicle->WheelStates.Num());
        for (int32 i = 0; i < 4; ++i)
        {
            FOpenGridWheelVfxTelemetry& Dst = VfxTel.Wheels[i];
            Dst.Wetness = Wetness;

            if (i < NumWheelStates)
            {
                const FOpenGridWheelState& Src = Vehicle->WheelStates[i];
                Dst.bInContact = Src.bInContact;
                Dst.ContactPointWorldCm = !Src.ContactPointWorldCm.IsNearlyZero() ? Src.ContactPointWorldCm : Src.WorldCenterCm;
                Dst.ContactNormalWorld = Chassis ? Chassis->GetUpVector() : FVector::UpVector;

                const float LongSlip = FMath::Abs(Src.SlipRatio);
                const float LatSlip = FMath::Abs(Src.SlipAngleDeg) / 12.0f;
                Dst.SlipIntensity = FMath::Sqrt(LongSlip * LongSlip + LatSlip * LatSlip);
                Dst.TyreTempC = Src.SurfaceTempC;
                Dst.NormalLoadN = Src.NormalLoadN;
                Dst.DebrisIntensity = FMath::Clamp(Src.CavityRingGain * 0.9f, 0.0f, 1.0f);
            }
            else if (Vehicle->WheelCentresWorld.IsValidIndex(i))
            {
                Dst.ContactPointWorldCm = Vehicle->WheelCentresWorld[i];
            }
        }

        VehicleVfx->UpdateVehicleVfx(DeltaSeconds, VfxTel);
    }
}

void AOpenGridCarPawn::ApplyVisualMods()
{
    struct FModSlot
    {
        UStaticMeshComponent* Comp;
        UStaticMesh* Asset;
        const TCHAR* SocketName;
    };
    const FModSlot Slots[] = {
        {WidebodyMesh.Get(), WidebodyMeshAsset.Get(), NAME_None},
        {WingMesh.Get(), WingMeshAsset.Get(), TEXT("SOCKET_Wing")},
        {SplitterMesh.Get(), SplitterMeshAsset.Get(), TEXT("SOCKET_Splitter")},
        {DiffuserMesh.Get(), DiffuserMeshAsset.Get(), TEXT("SOCKET_Diffuser")},
        {SkirtsMesh.Get(), SkirtsMeshAsset.Get(), TEXT("SOCKET_Skirts")},
    };
    USceneComponent* ParentComp = (DeformableBodyMesh && DeformableBodyMesh->IsVisible())
                                      ? static_cast<USceneComponent*>(DeformableBodyMesh.Get())
                                      : static_cast<USceneComponent*>(BodyMesh.Get());
    for (const FModSlot& S : Slots)
    {
        if (!S.Comp) continue;
        if (S.Asset)
        {
            const FName Socket(S.SocketName);
            const FName AttachSocket = (ParentComp && Socket != NAME_None && ParentComp->DoesSocketExist(Socket))
                                           ? Socket
                                           : NAME_None;
            if (ParentComp)
            {
                S.Comp->AttachToComponent(ParentComp, FAttachmentTransformRules::SnapToTargetNotIncludingScale, AttachSocket);
            }
            S.Comp->SetStaticMesh(S.Asset);
            S.Comp->SetRelativeLocation(FVector::ZeroVector);
            S.Comp->SetRelativeRotation(FRotator::ZeroRotator);
            S.Comp->SetRelativeScale3D(FVector::OneVector);
            S.Comp->SetVisibility(true);
        }
        else
        {
            S.Comp->SetStaticMesh(nullptr);
            S.Comp->SetVisibility(false);
        }
    }
}

FOpenGridCrushMorphWeights AOpenGridCarPawn::GetCrushMorphWeights() const
{
    if (!Vehicle) return FOpenGridCrushMorphWeights{};
    const TArray<float> Zones = Vehicle->GetZoneDamage();
    std::array<double, 4> ZoneArr{0.0, 0.0, 0.0, 0.0};
    for (int32 i = 0; i < 4 && i < Zones.Num(); ++i) ZoneArr[i] = Zones[i];
    std::array<double, 8> NodeArr{};
    for (int32 i = 0; i < 8 && i < Vehicle->CrushNodeWeights.Num(); ++i) NodeArr[i] = Vehicle->CrushNodeWeights[i];
    const rs::ue5::UeCrushMorphWeights Computed = rs::ue5::compute_crush_morph_weights(
        ZoneArr, NodeArr, Vehicle->bHoodUnlatched, static_cast<double>(Vehicle->CrushMorphWeights.crush_top));
    FOpenGridCrushMorphWeights Out;
    Out.crush_front = Computed.crush_front;
    Out.crush_rear = Computed.crush_rear;
    Out.crush_left = Computed.crush_left;
    Out.crush_right = Computed.crush_right;
    Out.crush_top = Computed.crush_top;
    Out.crush_hood = Computed.crush_hood;
    return Out;
}

void AOpenGridCarPawn::UpdateCrushMorphTargets()
{
    if (!DeformableBodyMesh || !DeformableBodyMesh->GetSkeletalMeshAsset()) return;
    const FOpenGridCrushMorphWeights W = GetCrushMorphWeights();
    DeformableBodyMesh->SetMorphTarget(TEXT("crush_front"), W.crush_front);
    DeformableBodyMesh->SetMorphTarget(TEXT("crush_rear"), W.crush_rear);
    DeformableBodyMesh->SetMorphTarget(TEXT("crush_left"), W.crush_left);
    DeformableBodyMesh->SetMorphTarget(TEXT("crush_right"), W.crush_right);
    DeformableBodyMesh->SetMorphTarget(TEXT("crush_top"), W.crush_top);
    DeformableBodyMesh->SetMorphTarget(TEXT("crush_hood"), W.crush_hood);
}

void AOpenGridCarPawn::PlaceWheels()
{
    if (!Vehicle->bCarLoaded) return;
    const FQuat Body = Chassis->GetComponentQuat();
    const FVector RightAxis = Body.GetRightVector();
    const float WidebodyTrackCm = Customization ? Customization->GetWidebodyTrackOffsetCm() : 0.0f;
    for (int32 i = 0; i < 4; ++i)
    {
        // Core: steer + = left, spin + = rolling forward. Unreal: yaw + = right, pitch + = nose up.
        const float SteerDeg = -FMath::RadiansToDegrees(Vehicle->WheelSteerRad[i]);
        const float SpinDeg = -FMath::RadiansToDegrees(Vehicle->WheelSpinRad[i]);
        const FQuat Steered = Body * FQuat(FRotator(0.0f, SteerDeg, 0.0f));
        // FL=0, RL=2 push left (-Y); FR=1, RR=3 push right (+Y) to fill widened arches.
        const float SideSign = (i == 0 || i == 2) ? -1.0f : 1.0f;
        const FVector WheelCentre = Vehicle->WheelCentresWorld[i] + RightAxis * (SideSign * WidebodyTrackCm);
        Calipers[i]->SetWorldLocationAndRotation(WheelCentre, Steered);
        FQuat Q = Steered * FQuat(FRotator(SpinDeg, 0.0f, 0.0f));
        const bool bRealWheel = i < WheelMeshes.Num() && WheelMeshes[i] != nullptr;
        if (!bRealWheel)
        {
            // The placeholder cylinder stands along Z: lay it on its side (axle along Y) and size it to the tyre.
            Q = Q * FQuat(FRotator(0.0f, 0.0f, 90.0f));
            const float D = 2.0f * Vehicle->WheelRadiusCm[i] / 100.0f;
            Wheels[i]->SetWorldScale3D(FVector(D, D, Vehicle->WheelWidthCm[i] / 100.0f));
        }
        Wheels[i]->SetWorldLocationAndRotation(WheelCentre, Q);
    }
}

void AOpenGridCarPawn::DrawHud() const
{
    if (!GEngine) return;
    if (!Vehicle->bCarLoaded)
    {
        GEngine->AddOnScreenDebugMessage(4201, 0.0f, FColor::Red, FString::Printf(TEXT("OpenGrid: %s"), *Vehicle->LoadError));
        return;
    }
    const int32 G = Vehicle->CurrentGear;
    const FString Gear = G == 0 ? TEXT("R") : G == 1 ? TEXT("N") : FString::FromInt(G - 1);
    GEngine->AddOnScreenDebugMessage(4201, 0.0f, FColor::White,
        FString::Printf(TEXT("%3.0f km/h   gear %s   %5.0f rpm   fuel %4.1f L   %s   %d ground traces/frame"),
                        Vehicle->SpeedKmh, *Gear, Vehicle->EngineRpm, Vehicle->FuelLiters,
                        Vehicle->bAsyncPhysicsActive ? TEXT("fixed-step physics") : TEXT("FRAME-TICK FALLBACK"),
                        Vehicle->GroundTracesLastFrame));
}
