// Apache-2.0 — OpenGrid Unreal Engine 5 UActorComponent implementation. See the header for the stepping model.
#include "OpenGridVehicleComponent.h"

#include "Components/PrimitiveComponent.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Misc/EngineVersionComparison.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "PhysicalMaterials/PhysicalMaterial.h"
#include "PhysicsEngine/BodyInstance.h"
#include "PhysicsEngine/PhysicsSettings.h"
#include "PhysicsProxy/SingleParticlePhysicsProxy.h"

THIRD_PARTY_INCLUDES_START
#include "nlohmann/json.hpp"
THIRD_PARTY_INCLUDES_END

#include <cmath>
#include <exception>

DEFINE_LOG_CATEGORY_STATIC(LogOpenGrid, Log, All);

// Physics-thread rigid body accessors (Chaos::FRigidBodyHandle_Internal). Written without a UE install: Chaos moved
// from X()/R()/V()/W() to GetX()/GetR()/GetV()/GetW() around 5.4, and the exact version could not be confirmed.
// If the first compile fails on these four lines, swap the two branches: nothing else depends on it.
#if UE_VERSION_NEWER_THAN(5, 3, 99)
    #define OG_PT_X(H) (H)->GetX()
    #define OG_PT_R(H) (H)->GetR()
    #define OG_PT_V(H) (H)->GetV()
    #define OG_PT_W(H) (H)->GetW()
#else
    #define OG_PT_X(H) (H)->X()
    #define OG_PT_R(H) (H)->R()
    #define OG_PT_V(H) (H)->V()
    #define OG_PT_W(H) (H)->W()
#endif

namespace
{
constexpr double kTwoPi = 6.283185307179586;
constexpr double kMaxFrameStep = 1.0 / 30.0;   // frame-tick fallback only
constexpr double kTraceExtraUp = 0.30;         // m: start traces above the mount so a sunk car still finds the ground
constexpr double kTraceExtraDown = 0.50;       // m: look below full droop so the cached plane is ready on landing

FVector ToFVector(const rs::ue5::UeVec3& V) { return FVector(V.x, V.y, V.z); }
rs::ue5::UeVec3 ToUe(const FVector& V) { return {V.X, V.Y, V.Z}; }
}  // namespace

UOpenGridVehicleComponent::UOpenGridVehicleComponent()
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PrePhysics;   // inputs and traces are ready before physics runs
    CrushNodeWeights.Init(0.0f, 8);
    WheelCentresWorld.Init(FVector::ZeroVector, 4);
    WheelSteerRad.Init(0.0f, 4);
    WheelSpinRad.Init(0.0f, 4);
    WheelRadiusCm.Init(33.0f, 4);
    WheelWidthCm.Init(24.5f, 4);
}

// ---- Setup -------------------------------------------------------------------------------------------------------

bool UOpenGridVehicleComponent::FindDataFile(const FString& Rel, FString& OutFull) const
{
    const TArray<FString> Candidates = {
        FPaths::Combine(FPaths::ProjectContentDir(), TEXT("OpenGridData"), Rel),
        FPaths::Combine(FPaths::ProjectDir(), TEXT(".."), TEXT("data"), Rel),
        FPaths::Combine(FPaths::ProjectDir(), TEXT("data"), Rel),
    };
    for (const FString& C : Candidates)
    {
        const FString Full = FPaths::ConvertRelativePathToFull(C);
        if (FPaths::FileExists(Full)) { OutFull = Full; return true; }
    }
    return false;
}

bool UOpenGridVehicleComponent::EnsureCarLoaded()
{
    if (!bLoadAttempted_)
    {
        bLoadAttempted_ = true;
        bLoadOk_ = LoadCar();
        if (bLoadOk_)
        {
            CgHeightCm = static_cast<float>(Config_.cg_height * rs::ue5::kMetersToCm);
            LoadVisualSpec();
        }
    }
    return bLoadOk_;
}

void UOpenGridVehicleComponent::LoadVisualSpec()
{
    VisualSpec = FOpenGridVisualSpec{};
    FString Rel = CarConfigRelativePath;
    if (!Rel.EndsWith(TEXT(".json"))) return;
    Rel = Rel.LeftChop(5) + TEXT(".visual.json");
    FString Found, Text;
    if (!FindDataFile(Rel, Found) || !FFileHelper::LoadFileToString(Text, *Found)) return;
    try
    {
        const FTCHARToUTF8 Utf8(*Text);
        const nlohmann::json J = nlohmann::json::parse(std::string(Utf8.Get(), Utf8.Length()));
        // glTF model space (+X left, +Y up, +Z forward, m) -> Unreal (X forward, Y right, Z up, cm)
        auto ToUeCm = [](const nlohmann::json& A) {
            return FVector(A.at(2).get<double>() * 100.0, -A.at(0).get<double>() * 100.0, A.at(1).get<double>() * 100.0);
        };
        VisualSpec.ModelPath = UTF8_TO_TCHAR(J.value("model", std::string()).c_str());
        if (J.contains("cg_in_model_m")) VisualSpec.CgInModelCm = ToUeCm(J.at("cg_in_model_m"));
        if (J.contains("collision_box"))
        {
            const nlohmann::json& B = J.at("collision_box");
            const FVector Size = ToUeCm(B.at("size_m"));
            VisualSpec.CollisionBoxExtentCm = FVector(FMath::Abs(Size.X), FMath::Abs(Size.Y), FMath::Abs(Size.Z)) * 0.5;
            VisualSpec.CollisionBoxCentreInModelCm = ToUeCm(B.at("centre_in_model_m"));
        }
        if (J.contains("wheel_nodes"))
        {
            const nlohmann::json& W = J.at("wheel_nodes");
            for (const char* K : {"fl", "fr", "rl", "rr"})
                VisualSpec.WheelNodes.Add(UTF8_TO_TCHAR(W.value(K, std::string()).c_str()));
        }
        VisualSpec.bValid = true;
    }
    catch (const std::exception& E)
    {
        UE_LOG(LogOpenGrid, Warning, TEXT("Visual spec %s: %s"), *Found, UTF8_TO_TCHAR(E.what()));
    }
}

bool UOpenGridVehicleComponent::LoadCar()
{
    const FString Rel = CarConfigRelativePath;
    FString Found;
    if (!FindDataFile(Rel, Found))
    {
        LoadError = FString::Printf(TEXT("Car spec '%s' not found in Content/OpenGridData, ../data or data"), *Rel);
        return false;
    }
    FString Text;
    if (!FFileHelper::LoadFileToString(Text, *Found))
    {
        LoadError = FString::Printf(TEXT("Could not read %s"), *Found);
        return false;
    }
    try
    {
        const FTCHARToUTF8 Utf8(*Text);
        Config_ = rs::parse_car_config(std::string(Utf8.Get(), Utf8.Length()));
    }
    catch (const std::exception& E)
    {
        LoadError = FString::Printf(TEXT("%s: %s"), *Found, UTF8_TO_TCHAR(E.what()));
        return false;
    }
    UE_LOG(LogOpenGrid, Log, TEXT("Loaded car spec %s"), *Found);
    return true;
}

void UOpenGridVehicleComponent::ApplyFeatureFlagsLocked()
{
    // The web build's set (web/wasm/bridge.cpp rs_create): keep the two in step so handling matches.
    Vehicle_->unsprung_dynamics_enabled = true;
    Vehicle_->tire_zones_enabled = true;
    Vehicle_->aero_wake().yaw_aero_enabled = true;
    Vehicle_->chassis_dynamics().chassis_flex_enabled = true;
    Vehicle_->chassis_dynamics().active_yaw_control_enabled = true;
    Vehicle_->chassis_dynamics().active_aero_enabled = true;
    Vehicle_->chassis_dynamics().brake_fluid_boil_enabled = true;
    Vehicle_->engine_systems().torsional_compliance_enabled = true;
    Vehicle_->engine_systems().dog_box_flat_shift_cut = true;
    Vehicle_->atmosphere().enabled = true;
    // Not in the web build: long-run wear and fuel.
    Vehicle_->engine_systems().wear_enabled = !bMatchWebBuild;
    Vehicle_->engine_systems().fuel_consumption_enabled = !bMatchWebBuild;
}

void UOpenGridVehicleComponent::CreateVehicleLocked()
{
    Vehicle_ = MakeUnique<rs::Vehicle>(Config_);
    ApplyFeatureFlagsLocked();
    Controls_ = MakeUnique<rs::Controls>(Vehicle_->config());   // Controls keeps a reference: use the vehicle's copy
    LastOut_ = rs::VehicleOutput{};
    LastIn_ = rs::DriverInput{};
    Spin_ = {};
    bHaveOutput_ = false;
    bHaveRays_ = false;
}

void UOpenGridVehicleComponent::ApplyMassFromSpec(UPrimitiveComponent* Body) const
{
    FBodyInstance* BI = Body->GetBodyInstance();
    if (!BI) return;
    BI->SetMassOverride(static_cast<float>(Config_.mass), true);
    BI->InertiaTensorScale = FVector::OneVector;
    BI->UpdateMassProperties();
    // Scale the shape's own inertia to the spec's (roll / pitch / yaw about X / Y / Z, the same axes in both frames).
    const FVector Current = BI->GetBodyInertiaTensor();   // kg cm^2
    const FVector Wanted = FVector(Config_.inertia_xx, Config_.inertia_yy, Config_.inertia_zz) * 1.0e4;
    if (Current.X > 0.0 && Current.Y > 0.0 && Current.Z > 0.0)
    {
        BI->InertiaTensorScale = FVector(Wanted.X / Current.X, Wanted.Y / Current.Y, Wanted.Z / Current.Z);
        BI->UpdateMassProperties();
    }
}

void UOpenGridVehicleComponent::BeginPlay()
{
    Super::BeginPlay();

    UPrimitiveComponent* Body = Cast<UPrimitiveComponent>(GetOwner()->GetRootComponent());
    if (!Body)
    {
        LoadError = TEXT("The owner's root component is not a UPrimitiveComponent with physics");
        UE_LOG(LogOpenGrid, Error, TEXT("%s"), *LoadError);
        return;
    }
    if (!EnsureCarLoaded())
    {
        UE_LOG(LogOpenGrid, Error, TEXT("%s"), *LoadError);
        return;
    }

    {
        FScopeLock L(&Lock_);
        try
        {
            CreateVehicleLocked();
        }
        catch (const std::exception& E)
        {
            LoadError = FString::Printf(TEXT("rs::Vehicle: %s"), UTF8_TO_TCHAR(E.what()));
            UE_LOG(LogOpenGrid, Error, TEXT("%s"), *LoadError);
            return;
        }
    }

    for (int32 w = 0; w < 4; ++w)
    {
        WheelRadiusCm[w] = static_cast<float>(Config_.tire(w).radius * rs::ue5::kMetersToCm);
        WheelWidthCm[w] = static_cast<float>(Config_.tire(w).section_width_m * rs::ue5::kMetersToCm);
    }

    const rs::PerformanceIndexReport PiReport = rs::compute_performance_index(Config_);
    PerformanceIndex = PiReport.pi;
    VirtualBenchmarkLapSeconds = static_cast<float>(PiReport.virtual_benchmark_lap_s);

    Body_ = Body;
    BodyRaw_ = Body;
    if (!Body->IsSimulatingPhysics()) Body->SetSimulatePhysics(true);
    if (bApplyMassFromSpec) ApplyMassFromSpec(Body);
    Body->SetNotifyRigidBodyCollision(true);
    Body->OnComponentHit.AddDynamic(this, &UOpenGridVehicleComponent::HandleBodyHit);

    if (bEnableSimHubUdp) UdpSender_.open("127.0.0.1", 20777);

    // Rays for the first frame's traces, from where the body starts.
    {
        FScopeLock L(&Lock_);
        Pending_.RaysPerWheel = RaysPerWheel();
        BuildRaysLocked(ChassisFromUe(Body->GetComponentLocation(), Body->GetComponentQuat(),
                                      Body->GetPhysicsLinearVelocity(),
                                      FMath::DegreesToRadians(Body->GetPhysicsAngularVelocityInDegrees())));
    }

    const UPhysicsSettings* PS = UPhysicsSettings::Get();
    const bool bProjectAsync = PS && PS->bTickPhysicsAsync;
    bAsyncPhysicsActive = bUseAsyncPhysicsTick && bProjectAsync;
    if (bUseAsyncPhysicsTick && !bProjectAsync)
    {
        UE_LOG(LogOpenGrid, Warning, TEXT("Tick Physics Async is off in Project Settings > Physics: using the frame-tick fallback (handling will depend on frame rate)"));
    }
    bCarLoaded = true;
    bAsyncRun_.store(bAsyncPhysicsActive);
    SetAsyncPhysicsTickEnabled(bAsyncPhysicsActive);
}

void UOpenGridVehicleComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    bAsyncRun_.store(false);
    SetAsyncPhysicsTickEnabled(false);
    if (UPrimitiveComponent* Body = Body_.Get())
    {
        Body->OnComponentHit.RemoveDynamic(this, &UOpenGridVehicleComponent::HandleBodyHit);
    }
    UdpSender_.close();
    Super::EndPlay(EndPlayReason);
}

int32 UOpenGridVehicleComponent::RaysPerWheel() const
{
    if (bUse16PointTireFootprint) return 16;
    if (bUseThreeRayContactPatch) return 3;
    return 1;
}

int32 UOpenGridVehicleComponent::SurfaceFromPhysicalMaterial(UPhysicalMaterial* Material) const
{
    const int32 Asphalt = FMath::Max(0, Config_.surface_index("asphalt"));
    if (!Material) return Asphalt;
    if (const FName* Name = SurfaceByPhysicalMaterial.Find(Material))
    {
        const int32 Index = Config_.surface_index(TCHAR_TO_UTF8(*Name->ToString().ToLower()));
        return Index >= 0 ? Index : Asphalt;
    }
    const FString MaterialName = Material->GetName().ToLower();
    for (int32 i = 0; i < static_cast<int32>(Config_.surface_grip.size()); ++i)
    {
        const FString Surface = UTF8_TO_TCHAR(Config_.surface_grip[i].first.c_str());
        if (MaterialName.Contains(Surface)) return i;
    }
    return Asphalt;
}

rs::ChassisState UOpenGridVehicleComponent::ChassisFromUe(const FVector& PosCm, const FQuat& Rot, const FVector& VelCms, const FVector& OmegaRad)
{
    rs::ChassisState C;
    C.position = rs::ue5::pos_from_ue(ToUe(PosCm));
    C.orientation = rs::ue5::quat_from_ue({Rot.X, Rot.Y, Rot.Z, Rot.W});
    C.velocity = rs::ue5::vel_from_ue(ToUe(VelCms));
    C.angular_velocity = rs::ue5::omega_from_ue(ToUe(OmegaRad));
    return C;
}

// ---- Rays, ground, contacts ---------------------------------------------------------------------------------------

void UOpenGridVehicleComponent::BuildRaysLocked(const rs::ChassisState& Chassis)
{
    const int32 PerWheel = Pending_.RaysPerWheel;
    if (PerWheel == 16)
    {
        FootprintRays_ = Vehicle_->wheel_footprint_16_rays(Chassis);
        for (int32 w = 0; w < 4; ++w)
            for (int32 j = 0; j < 16; ++j) Rays_[w][j] = FootprintRays_[w].rays[j];
    }
    else if (PerWheel == 3)
    {
        PatchRays_ = Vehicle_->wheel_contact_patch_rays(Chassis);
        for (int32 w = 0; w < 4; ++w)
            for (int32 j = 0; j < 3; ++j) Rays_[w][j] = PatchRays_[w].rays[j];
    }
    else
    {
        const std::array<rs::WheelRay, 4> R = Vehicle_->wheel_rays(Chassis);
        for (int32 w = 0; w < 4; ++w) Rays_[w][0] = R[w];
    }
    bHaveRays_ = true;
}

void UOpenGridVehicleComponent::TraceGround(const std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4>& Rays, int32 PerWheel,
                                            std::array<std::array<FGroundSample, MaxRaysPerWheel>, 4>& OutGround) const
{
    UWorld* World = GetWorld();
    if (!World) return;
    FCollisionQueryParams Params(SCENE_QUERY_STAT(OpenGridWheelTrace), false, GetOwner());
    Params.bReturnPhysicalMaterial = true;
    for (int32 w = 0; w < 4; ++w)
    {
        for (int32 j = 0; j < PerWheel; ++j)
        {
            const rs::WheelRay& Ray = Rays[w][j];
            const rs::Vec3 From = Ray.origin - Ray.direction * kTraceExtraUp;
            const rs::Vec3 To = Ray.origin + Ray.direction * (Ray.length + kTraceExtraDown);
            FHitResult Hit;
            FGroundSample& G = OutGround[w][j];
            G = FGroundSample{};
            if (World->LineTraceSingleByChannel(Hit, ToFVector(rs::ue5::pos_to_ue(From)), ToFVector(rs::ue5::pos_to_ue(To)),
                                                WheelTraceChannel.GetValue(), Params))
            {
                G.bHit = true;
                G.Point = rs::ue5::pos_from_ue(ToUe(Hit.ImpactPoint));
                G.Normal = rs::normalized(rs::ue5::dir_from_ue(ToUe(Hit.ImpactNormal)));
                G.Surface = SurfaceFromPhysicalMaterial(Hit.PhysMaterial.Get());
            }
        }
    }
}

std::array<rs::WheelContact, 4> UOpenGridVehicleComponent::ResolveContactsLocked() const
{
    std::array<rs::WheelContact, 4> Contacts{};
    const int32 PerWheel = Pending_.RaysPerWheel;
    for (int32 w = 0; w < 4; ++w)
    {
        const double Radius = Vehicle_->config().tire(w).radius;
        auto Hit = [&](int32 j) {
            const FGroundSample& G = Ground_[w][j];
            return rs::ue5::intersect_ground_plane(Rays_[w][j], G.bHit, G.Point, G.Normal, G.Surface);
        };
        if (PerWheel == 16)
        {
            std::array<rs::WheelContact, 16> Sub{};
            for (int32 j = 0; j < 16; ++j) Sub[j] = Hit(j);
            Contacts[w] = rs::Vehicle::resolve_footprint_16(FootprintRays_[w], Sub, Radius);
        }
        else if (PerWheel == 3)
        {
            const std::array<rs::WheelContact, 3> Sub = {Hit(0), Hit(1), Hit(2)};
            Contacts[w] = rs::Vehicle::resolve_contact_patch(PatchRays_[w], Sub, Radius);
        }
        else
        {
            Contacts[w] = Hit(0);
        }
    }
    return Contacts;
}

// ---- Stepping -----------------------------------------------------------------------------------------------------

const rs::VehicleOutput& UOpenGridVehicleComponent::StepLocked(const rs::ChassisState& Chassis, double Dt)
{
    LastChassis_ = Chassis;
    BuildRaysLocked(Chassis);
    const std::array<rs::WheelContact, 4> Contacts = ResolveContactsLocked();

    for (const FPendingImpact& Impact : Impacts_)
    {
        const rs::Vec3 Body = Chassis.orientation.inv_rotate(rs::ue5::pos_from_ue(ToUe(Impact.PointUe)) - Chassis.position);
        Vehicle_->add_contact(Impact.OtherId, Body, Impact.ImpulseNs);
    }
    Impacts_.Reset();

    rs::DriverInput In;
    if (Pending_.bCoreControls)
    {
        rs::RawInput Raw = Pending_.Raw;
        Raw.shift_up = Pending_.bShiftUp;
        Raw.shift_down = Pending_.bShiftDown;
        Pending_.bShiftUp = Pending_.bShiftDown = false;
        In = Controls_->update(Raw, LastOut_, Dt);
        In.nos = Pending_.Direct.nos;           // rs::Controls has no nitrous / starter inputs: pass them through
        In.starter = Pending_.Direct.starter;
    }
    else
    {
        In = Pending_.Direct;
    }
    Vehicle_->set_input(In);
    LastIn_ = In;
    LastOut_ = Vehicle_->update(Chassis, Contacts, Dt);
    for (int32 w = 0; w < 4; ++w)
    {
        Spin_[w] = std::fmod(Spin_[w] + LastOut_.wheels[w].angular_velocity * Dt, kTwoPi);
    }
    bHaveOutput_ = true;
    return LastOut_;
}

void UOpenGridVehicleComponent::AsyncPhysicsTickComponent(float DeltaTime, float SimTime)
{
    Super::AsyncPhysicsTickComponent(DeltaTime, SimTime);
    if (!bAsyncRun_.load() || !BodyRaw_ || DeltaTime <= 0.0f) return;

    FBodyInstanceAsyncPhysicsTickHandle Handle = BodyRaw_->GetBodyInstanceAsyncPhysicsTickHandle(NAME_None, true, -1);
    if (!Handle.IsValid()) return;
    Chaos::FRigidBodyHandle_Internal* RB = Handle.operator->();
    if (!RB) return;

    const Chaos::FVec3 X = OG_PT_X(RB);
    const Chaos::FRotation3 R = OG_PT_R(RB);
    const Chaos::FVec3 V = OG_PT_V(RB);
    const Chaos::FVec3 W = OG_PT_W(RB);
    const rs::ChassisState Chassis = ChassisFromUe(FVector(X.X, X.Y, X.Z), FQuat(R.X, R.Y, R.Z, R.W),
                                                   FVector(V.X, V.Y, V.Z), FVector(W.X, W.Y, W.Z));

    rs::ue5::UeVec3 Force, Torque;
    {
        FScopeLock L(&Lock_);
        if (!Vehicle_.IsValid()) return;
        const rs::VehicleOutput& Out = StepLocked(Chassis, DeltaTime);
        Force = rs::ue5::force_to_ue(Out.force);
        Torque = rs::ue5::torque_to_ue(Out.torque);
    }
    RB->AddForce(Chaos::FVec3(Force.x, Force.y, Force.z));
    RB->AddTorque(Chaos::FVec3(Torque.x, Torque.y, Torque.z));
}

void UOpenGridVehicleComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
    Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
    UPrimitiveComponent* Body = Body_.Get();
    if (!bCarLoaded || !Body || DeltaTime <= 0.0f) return;
    if (!Body->RigidBodyIsAwake()) Body->WakeRigidBody();   // a driven car must never fall asleep

    // 1. Hand this frame's input and settings to the simulation.
    std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4> Rays{};
    int32 PerWheel = 1;
    {
        FScopeLock L(&Lock_);
        if (!Vehicle_.IsValid()) return;
        Pending_.bCoreControls = bUseCoreControls;
        Pending_.RaysPerWheel = RaysPerWheel();
        rs::RawInput& Raw = Pending_.Raw;
        Raw.steer = SteerInput;
        Raw.throttle = ThrottleInput;
        Raw.brake = BrakeInput;
        Raw.clutch = ClutchInput;
        Raw.handbrake = HandbrakeInput;
        Raw.device = static_cast<rs::InputDevice>(static_cast<int32>(InputDevice));
        Pending_.bShiftUp |= bShiftUpRequested_;
        Pending_.bShiftDown |= bShiftDownRequested_;
        rs::DriverInput& D = Pending_.Direct;
        D.steer = SteerInput;
        D.throttle = ThrottleInput;
        D.brake = BrakeInput;
        D.clutch = ClutchInput;
        D.handbrake = HandbrakeInput;
        D.gear = GearIndex;
        D.auto_clutch = bAutoClutch;
        D.nos = bNitrousActive;
        D.starter = bStarterCrank;

        Vehicle_->engine_systems().turbo_stage = FMath::Clamp(TurboStage, 0, 3);
        rs::AtmosphericEnvironment& Atm = Vehicle_->atmosphere();
        Atm.altitude_m = AltitudeMeters;
        Atm.ambient_air_c = AmbientAirCelsius;
        Atm.track_surface_c = TrackSurfaceCelsius;
        Atm.humidity_0_to_1 = RelativeHumidity;
        rs::AssistSettings& A = Vehicle_->assists();
        A.abs = bAbs;
        A.tc = bTractionControl;
        A.esc = bStabilityControl;
        Controls_->settings.auto_gearbox = bAutoGearbox;
        Controls_->settings.auto_clutch = true;

        Rays = Rays_;
        PerWheel = Pending_.RaysPerWheel;
    }
    bShiftUpRequested_ = bShiftDownRequested_ = false;

    // 2. Ground under the rays.
    std::array<std::array<FGroundSample, MaxRaysPerWheel>, 4> Ground{};
    if (bAsyncPhysicsActive)
    {
        // The physics thread steps on its own clock; give it fresh ground planes for its next steps.
        TraceGround(Rays, PerWheel, Ground);
        FScopeLock L(&Lock_);
        Ground_ = Ground;
    }
    else
    {
        // Frame-tick fallback: rays from the body's state now, trace, step once.
        const rs::ChassisState Chassis = ChassisFromUe(Body->GetComponentLocation(), Body->GetComponentQuat(),
                                                       Body->GetPhysicsLinearVelocity(),
                                                       FMath::DegreesToRadians(Body->GetPhysicsAngularVelocityInDegrees()));
        {
            FScopeLock L(&Lock_);
            BuildRaysLocked(Chassis);
            Rays = Rays_;
        }
        TraceGround(Rays, PerWheel, Ground);
        rs::ue5::UeVec3 Force, Torque;
        {
            FScopeLock L(&Lock_);
            Ground_ = Ground;
            const rs::VehicleOutput& Out = StepLocked(Chassis, FMath::Min(static_cast<double>(DeltaTime), kMaxFrameStep));
            Force = rs::ue5::force_to_ue(Out.force);
            Torque = rs::ue5::torque_to_ue(Out.torque);
        }
        Body->AddForce(FVector(Force.x, Force.y, Force.z));
        Body->AddTorqueInRadians(FVector(Torque.x, Torque.y, Torque.z));
    }

    // 3. Publish the latest step to Blueprint, audio, visuals and telemetry.
    rs::VehicleOutput Out;
    rs::DriverInput In;
    rs::ChassisState Chassis;
    std::array<double, 4> Spin{};
    {
        FScopeLock L(&Lock_);
        if (!bHaveOutput_) return;
        Out = LastOut_;
        In = LastIn_;
        Chassis = LastChassis_;
        Spin = Spin_;
    }
    ElapsedTimeS_ += DeltaTime;
    PublishOutputs(Out, Spin);

    const rs::TelemetrySample Sample = rs::make_telemetry_sample(Out, Chassis, In, Config_, ElapsedTimeS_);
    MotecLogger_.record(Sample);
    if (bEnableSimHubUdp && UdpSender_.is_open()) UdpSender_.send(Sample);
}

void UOpenGridVehicleComponent::PublishOutputs(const rs::VehicleOutput& Out, const std::array<double, 4>& Spin)
{
    SpeedKmh = static_cast<float>(Out.speed * 3.6);
    EngineRpm = static_cast<float>(Out.engine_rpm);
    CurrentGear = Out.gear;
    BoostBar = static_cast<float>(Out.boost_bar);
    bBovVenting = Out.bov_venting;
    NosRemainingLiters = static_cast<float>(Out.nos_remaining_l);
    OilTempC = static_cast<float>(Out.oil_temp_c);
    EngineHealth = static_cast<float>(Out.engine_health);
    SteerTorqueNm = static_cast<float>(Out.steer_torque);
    IntakeAirTempC = static_cast<float>(Out.intake_air_temp_c);
    FuelLiters = static_cast<float>(Out.fuel_liters);
    bGearGrind = Out.gear_grind;
    bShiftCutActive = Out.shift_cut_active;
    DrivelineClunkNm = static_cast<float>(Out.driveline_clunk_nm);
    ChassisTwistDeg = static_cast<float>(Out.chassis_twist_deg);
    AycYawMomentNm = static_cast<float>(Out.ayc_yaw_moment_nm);
    bDrsActive = Out.drs_active;
    bAirbrakeActive = Out.airbrake_active;
    bFrontSplitterStalled = Out.front_splitter_stalled;
    AirDensityKgPerM3 = static_cast<float>(Out.air_density_kg_m3);
    BrakeVaporLockSponge = static_cast<float>(Out.brake_vapor_lock_sponge);

    for (int32 w = 0; w < 4; ++w)
    {
        WheelCentresWorld[w] = ToFVector(rs::ue5::pos_to_ue(Out.wheels[w].centre_world));
        WheelSteerRad[w] = static_cast<float>(Out.wheels[w].steer_angle);
        WheelSpinRad[w] = static_cast<float>(Spin[w]);
    }

    const rs::EngineAcousticState Acoustics = rs::compute_engine_acoustics(
        rs::EngineAcousticLayout::Inline6, Out.engine_rpm, Out.throttle_applied,
        Out.boost_bar, Out.bov_venting, Out.shift_cut_active, Out.gear, Out.speed);
    FundamentalFiringHz = static_cast<float>(Acoustics.fundamental_firing_hz);
    TurboImpellerRpm = static_cast<float>(Acoustics.turbo_impeller_rpm);
    TurboWhistleHz = static_cast<float>(Acoustics.turbo_whistle_hz);
    TransmissionWhineHz = static_cast<float>(Acoustics.transmission_whine_hz);
    OverrunPopIntensity = static_cast<float>(Acoustics.overrun_pop_intensity);

    if (CrushNodeWeights.Num() != 8) CrushNodeWeights.SetNumZeroed(8);
    for (int32 i = 0; i < 8; ++i) CrushNodeWeights[i] = static_cast<float>(Out.damage.node_norm[i]);
    bHoodUnlatched = Out.damage.hood_unlatched;
    bTrunkUnlatched = Out.damage.trunk_unlatched;
    bFrontBumperDetached = Out.damage.front_bumper_detached;
    bRearBumperDetached = Out.damage.rear_bumper_detached;

    if (Out.bov_venting && !bPrevBov_) OnBlowOffValveVent.Broadcast(FMath::Max(0.35f, BoostBar));
    bPrevBov_ = Out.bov_venting;
}

// ---- Events and Blueprint calls -----------------------------------------------------------------------------------

void UOpenGridVehicleComponent::HandleBodyHit(UPrimitiveComponent* HitComponent, AActor* OtherActor, UPrimitiveComponent* OtherComp,
                                              FVector NormalImpulse, const FHitResult& Hit)
{
    const double ImpulseNs = NormalImpulse.Size() * rs::ue5::kCmToMeters;   // kg cm/s -> N s
    if (ImpulseNs < 1.0) return;
    FPendingImpact Impact;
    Impact.PointUe = Hit.ImpactPoint;
    Impact.ImpulseNs = ImpulseNs;
    Impact.OtherId = OtherActor ? static_cast<uint64>(OtherActor->GetUniqueID()) : 0;
    FScopeLock L(&Lock_);
    Impacts_.Add(Impact);
}

void UOpenGridVehicleComponent::ShiftUp() { bShiftUpRequested_ = true; }

void UOpenGridVehicleComponent::ShiftDown() { bShiftDownRequested_ = true; }

bool UOpenGridVehicleComponent::ExportMotecLog(const FString& OutputBasePath)
{
    return MotecLogger_.write_files(TCHAR_TO_UTF8(*OutputBasePath));
}

void UOpenGridVehicleComponent::ApplyBopEqualizer(int32 TargetPi)
{
    if (!bCarLoaded) return;
    FScopeLock L(&Lock_);
    const rs::BopAdjustment Bop = rs::compute_bop_equalizer(Config_, TargetPi);
    Config_ = Bop.balanced_config;
    PerformanceIndex = Bop.balanced_report.pi;
    VirtualBenchmarkLapSeconds = static_cast<float>(Bop.balanced_report.virtual_benchmark_lap_s);
    CreateVehicleLocked();
    if (UPrimitiveComponent* Body = Body_.Get())
    {
        BuildRaysLocked(ChassisFromUe(Body->GetComponentLocation(), Body->GetComponentQuat(),
                                      Body->GetPhysicsLinearVelocity(),
                                      FMath::DegreesToRadians(Body->GetPhysicsAngularVelocityInDegrees())));
        if (bApplyMassFromSpec) ApplyMassFromSpec(Body);
    }
}
