// Apache-2.0 — see OpenGridCarPawn.h
#include "OpenGridCarPawn.h"

#include "Camera/CameraComponent.h"
#include "Components/BoxComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/LocalPlayer.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "OpenGridVehicleComponent.h"
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
    Super::BeginPlay();
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

void AOpenGridCarPawn::Recover()
{
    Vehicle->RepairAndService();   // as the web build's R: fix damage, refuel, restore the engine
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
    UpdateCrushMorphTargets();
    if (bShowDebugHud) DrawHud();
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
    for (int32 i = 0; i < 4; ++i)
    {
        // Core: steer + = left, spin + = rolling forward. Unreal: yaw + = right, pitch + = nose up.
        const float SteerDeg = -FMath::RadiansToDegrees(Vehicle->WheelSteerRad[i]);
        const float SpinDeg = -FMath::RadiansToDegrees(Vehicle->WheelSpinRad[i]);
        const FQuat Steered = Body * FQuat(FRotator(0.0f, SteerDeg, 0.0f));
        Calipers[i]->SetWorldLocationAndRotation(Vehicle->WheelCentresWorld[i], Steered);
        FQuat Q = Steered * FQuat(FRotator(SpinDeg, 0.0f, 0.0f));
        const bool bRealWheel = i < WheelMeshes.Num() && WheelMeshes[i] != nullptr;
        if (!bRealWheel)
        {
            // The placeholder cylinder stands along Z: lay it on its side (axle along Y) and size it to the tyre.
            Q = Q * FQuat(FRotator(0.0f, 0.0f, 90.0f));
            const float D = 2.0f * Vehicle->WheelRadiusCm[i] / 100.0f;
            Wheels[i]->SetWorldScale3D(FVector(D, D, Vehicle->WheelWidthCm[i] / 100.0f));
        }
        Wheels[i]->SetWorldLocationAndRotation(Vehicle->WheelCentresWorld[i], Q);
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
