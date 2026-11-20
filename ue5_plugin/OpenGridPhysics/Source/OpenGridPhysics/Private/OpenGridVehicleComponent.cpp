// Apache-2.0 — OpenGrid Unreal Engine 5 UActorComponent Implementation.
#include "OpenGridVehicleComponent.h"
#include "Components/PrimitiveComponent.h"
#include "Engine/World.h"
#include "Misc/Paths.h"

UOpenGridVehicleComponent::UOpenGridVehicleComponent()
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PrePhysics;
}

void UOpenGridVehicleComponent::BeginPlay()
{
    Super::BeginPlay();

    const FString FullPath = FPaths::Combine(FPaths::ProjectContentDir(), TEXT("OpenGridData"), CarConfigRelativePath);
    Config_ = rs::load_car_config(TCHAR_TO_UTF8(*FullPath));
    Vehicle_ = MakeUnique<rs::Vehicle>(Config_);
    Vehicle_->engine_systems().turbo_stage = TurboStage;
    Vehicle_->engine_systems().wear_enabled = true;

    if (bEnableSimHubUdp)
    {
        UdpSender_.open("127.0.0.1", 20777);
    }
}

void UOpenGridVehicleComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    UdpSender_.close();
    Super::EndPlay(EndPlayReason);
}

void UOpenGridVehicleComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
    Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
    if (!Vehicle_.IsValid() || DeltaTime <= 0.0f) return;

    UPrimitiveComponent* RootBody = Cast<UPrimitiveComponent>(GetOwner()->GetRootComponent());
    if (!RootBody) return;

    // 1. Read UE5 chassis state (cm, LH +Y right) and convert to rs_core SI (m, RH +Y left)
    const FVector UePos = RootBody->GetComponentLocation();
    const FQuat UeRot = RootBody->GetComponentQuat();
    const FVector UeVel = RootBody->GetPhysicsLinearVelocity();
    const FVector UeAngVelRad = FMath::DegreesToRadians(RootBody->GetPhysicsAngularVelocityInDegrees());

    rs::ChassisState Chassis;
    Chassis.position = rs::ue5::pos_from_ue({UePos.X, UePos.Y, UePos.Z});
    Chassis.orientation = rs::ue5::quat_from_ue({UeRot.X, UeRot.Y, UeRot.Z, UeRot.W});
    Chassis.velocity = rs::ue5::vel_from_ue({UeVel.X, UeVel.Y, UeVel.Z});
    Chassis.angular_velocity = rs::ue5::omega_from_ue({UeAngVelRad.X, UeAngVelRad.Y, UeAngVelRad.Z});

    // 2. Feed driver inputs
    rs::DriverInput In;
    In.steer = SteerInput;
    In.throttle = ThrottleInput;
    In.brake = BrakeInput;
    In.clutch = ClutchInput;
    In.handbrake = HandbrakeInput;
    In.gear = GearIndex;
    In.auto_clutch = bAutoClutch;
    In.nos = bNitrousActive;
    In.starter = bStarterCrank;
    Vehicle_->engine_systems().turbo_stage = TurboStage;
    Vehicle_->set_input(In);

    // 3. Cast suspension rays in UE5 World (3-ray circular-arc curb contact patch or single ray)
    FCollisionQueryParams TraceParams(SCENE_QUERY_STAT(OpenGridWheelTrace), false, GetOwner());
    auto TraceSingleRay = [&](const rs::WheelRay& Ray) -> rs::WheelContact
    {
        rs::WheelContact Contact;
        const rs::ue5::UeVec3 StartUe = rs::ue5::pos_to_ue(Ray.origin);
        const rs::ue5::UeVec3 EndUe = rs::ue5::pos_to_ue(Ray.origin + Ray.direction * Ray.length);
        FHitResult Hit;
        if (GetWorld()->LineTraceSingleByChannel(
                Hit,
                FVector(StartUe.x, StartUe.y, StartUe.z),
                FVector(EndUe.x, EndUe.y, EndUe.z),
                ECC_Visibility,
                TraceParams))
        {
            Contact.hit = true;
            Contact.distance = Hit.Distance * rs::ue5::kCmToMeters;
            Contact.point = rs::ue5::pos_from_ue({Hit.ImpactPoint.X, Hit.ImpactPoint.Y, Hit.ImpactPoint.Z});
            Contact.normal = rs::ue5::dir_from_ue({Hit.ImpactNormal.X, Hit.ImpactNormal.Y, Hit.ImpactNormal.Z});
            Contact.surface = 0;
        }
        return Contact;
    };

    std::array<rs::WheelContact, 4> Contacts;
    if (bUseThreeRayContactPatch)
    {
        const auto Patches = Vehicle_->wheel_contact_patch_rays(Chassis);
        for (int w = 0; w < 4; ++w)
        {
            std::array<rs::WheelContact, 3> SubHits = {
                TraceSingleRay(Patches[w].rays[0]),
                TraceSingleRay(Patches[w].rays[1]),
                TraceSingleRay(Patches[w].rays[2]),
            };
            Contacts[w] = rs::Vehicle::resolve_contact_patch(Patches[w], SubHits, Config_.tire(w).radius);
        }
    }
    else
    {
        const auto Rays = Vehicle_->wheel_rays(Chassis);
        for (int w = 0; w < 4; ++w) Contacts[w] = TraceSingleRay(Rays[w]);
    }

    // 4. Step rs::Vehicle physics (sub-stepped internally at >= 1 kHz) and apply UE5 forces/torques
    const double Dt = FMath::Min(static_cast<double>(DeltaTime), 1.0 / 30.0);
    const rs::VehicleOutput Out = Vehicle_->update(Chassis, Contacts, Dt);
    ElapsedTimeS_ += Dt;

    const rs::ue5::UeVec3 ForceUe = rs::ue5::force_to_ue(Out.force);
    const rs::ue5::UeVec3 TorqueUe = rs::ue5::torque_to_ue(Out.torque);
    RootBody->AddForce(FVector(ForceUe.x, ForceUe.y, ForceUe.z));
    RootBody->AddTorqueInRadians(FVector(TorqueUe.x, TorqueUe.y, TorqueUe.z));

    // 5. Update Blueprint / MetaSounds / HUD properties
    SpeedKmh = static_cast<float>(Out.speed * 3.6);
    EngineRpm = static_cast<float>(Out.engine_rpm);
    BoostBar = static_cast<float>(Out.boost_bar);
    bBovVenting = Out.bov_venting;
    NosRemainingLiters = static_cast<float>(Out.nos_remaining_l);
    OilTempC = static_cast<float>(Out.oil_temp_c);
    EngineHealth = static_cast<float>(Out.engine_health);
    SteerTorqueNm = static_cast<float>(Out.steer_torque);

    if (Out.bov_venting && !bPrevBov_)
    {
        OnBlowOffValveVent.Broadcast(FMath::Max(0.35f, BoostBar));
    }
    bPrevBov_ = Out.bov_venting;

    // 6. Stream SimHub UDP & record MoTeC i2 Pro telemetry
    const rs::TelemetrySample Sample = rs::make_telemetry_sample(Out, Chassis, In, Config_, ElapsedTimeS_);
    MotecLogger_.record(Sample);
    if (bEnableSimHubUdp && UdpSender_.is_open())
    {
        UdpSender_.send(Sample);
    }
}

bool UOpenGridVehicleComponent::ExportMotecLog(const FString& OutputBasePath)
{
    return MotecLogger_.write_files(TCHAR_TO_UTF8(*OutputBasePath));
}
