// Apache-2.0 — OpenGrid Unreal Engine 5 UActorComponent implementation. See the header for the stepping model.
#include "OpenGridVehicleComponent.h"
#include "OpenGridWeatherSubsystem.h"

#include "Components/PrimitiveComponent.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "HAL/PlatformProcess.h"
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
constexpr double kMaxFrameStep = 1.0 / 30.0;   // frame-tick fallback only
constexpr double kTraceExtraUp = 0.30;         // m: start traces above the mount so a sunk car still finds the ground
constexpr double kTraceExtraDown = 0.50;       // m: look below full droop so the cached plane is ready on landing

FVector ToFVector(const rs::ue5::UeVec3& V) { return FVector(V.x, V.y, V.z); }
rs::ue5::UeVec3 ToUe(const FVector& V) { return {V.X, V.Y, V.Z}; }
}  // namespace

TArray<TWeakObjectPtr<UOpenGridVehicleComponent>> UOpenGridVehicleComponent::ActiveVehicles_;

UOpenGridVehicleComponent::UOpenGridVehicleComponent()
{
    PrimaryComponentTick.bCanEverTick = true;
    PrimaryComponentTick.TickGroup = TG_PrePhysics;   // inputs and traces are ready before physics runs
    ZoneDamage.Init(0.0f, 4);
    CrushNodeWeights.Init(0.0f, 8);
    PaintScratchWeights.Init(0.0f, 8);
    ZoneShatterWeights.Init(0.0f, 4);
    WheelDetached.Init(false, 4);
    TyrePunctured.Init(false, 4);
    BrakeLineRuptured.Init(false, 4);
    HalfshaftBroken.Init(false, 4);
    WheelStates.Init(FOpenGridWheelState{}, 4);
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

void UOpenGridVehicleComponent::ApplyFeatureFlags()
{
    // Exactly the web build's set (web/wasm/bridge.cpp rs_create): keep the two identical so they feel the same.
    Vehicle_->unsprung_dynamics_enabled = true;
    Vehicle_->tire_zones_enabled = true;
    Vehicle_->aero_wake().yaw_aero_enabled = true;
    Vehicle_->chassis_dynamics().chassis_flex_enabled = true;
    Vehicle_->chassis_dynamics().active_yaw_control_enabled = true;
    Vehicle_->chassis_dynamics().active_aero_enabled = true;
    Vehicle_->chassis_dynamics().brake_fluid_boil_enabled = true;
    Vehicle_->chassis_dynamics().bushing_compliance_enabled = true;
    Vehicle_->chassis_dynamics().progressive_bump_stops_enabled = true;
    Vehicle_->chassis_dynamics().kingpin_3d_ffb_enabled = true;
    Vehicle_->chassis_dynamics().elastic_column_enabled = true;
    Vehicle_->engine_systems().torsional_compliance_enabled = true;
    Vehicle_->engine_systems().dog_box_flat_shift_cut = true;
    // A car whose file does not name its gearbox gets the manual synchromesh box, exactly as in the browser build (web/wasm/bridge.cpp
    // rs_create). The core's own default is the sequential dog-box, so without this the two builds shifted differently.
    if (Config_.drivetrain.transmission.empty())
    {
        Vehicle_->engine_systems().transmission = rs::TransmissionType::HPatternSynchro;
    }
    Vehicle_->atmosphere().enabled = true;
    Vehicle_->engine_systems().wear_enabled = true;               // redline / overheating abuse -> misfires
    Vehicle_->engine_systems().fuel_consumption_enabled = true;   // empty tank cuts the throttle; RepairAndService refuels
}

void UOpenGridVehicleComponent::CreateVehicle()
{
    Vehicle_ = MakeUnique<rs::Vehicle>(Config_);
    ApplyFeatureFlags();
    Controls_ = MakeUnique<rs::Controls>(Vehicle_->config());   // Controls keeps a reference: use the vehicle's copy
    Controls_->settings.auto_clutch = true;
    Bridge_ = MakeUnique<rs::ue5::AsyncVehicleBridge>(*Vehicle_, *Controls_);
    PrevRecord_ = rs::rt::StepRecord{};
    LastRecord_ = rs::rt::StepRecord{};
    bHavePrevRecord_ = false;
    bHaveRecord_ = false;
}

void UOpenGridVehicleComponent::QuiesceAsyncPhysics()
{
    bAsyncRun_.store(false, std::memory_order_seq_cst);
    while (bInAsyncStep_.load(std::memory_order_acquire))
    {
        FPlatformProcess::YieldThread();
    }
}

void UOpenGridVehicleComponent::ApplyMass(UPrimitiveComponent* Body, double MassKg)
{
    FBodyInstance* BI = Body->GetBodyInstance();
    if (!BI) return;
    BI->SetMassOverride(static_cast<float>(MassKg), true);
    BI->InertiaTensorScale = FVector::OneVector;
    BI->UpdateMassProperties();
    // Scale the shape's own inertia to the spec's (roll / pitch / yaw about X / Y / Z, the same axes in both frames).
    // Inertia stays the spec's as fuel burns (the tank sits near the CG), as in the web build.
    const FVector Current = BI->GetBodyInertiaTensor();   // kg cm^2
    const FVector Wanted = FVector(Config_.inertia_xx, Config_.inertia_yy, Config_.inertia_zz) * 1.0e4;
    if (Current.X > 0.0 && Current.Y > 0.0 && Current.Z > 0.0)
    {
        BI->InertiaTensorScale = FVector(Wanted.X / Current.X, Wanted.Y / Current.Y, Wanted.Z / Current.Z);
        BI->UpdateMassProperties();
    }
    AppliedMassKg_ = MassKg;
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

    try
    {
        CreateVehicle();
    }
    catch (const std::exception& E)
    {
        LoadError = FString::Printf(TEXT("rs::Vehicle: %s"), UTF8_TO_TCHAR(E.what()));
        UE_LOG(LogOpenGrid, Error, TEXT("%s"), *LoadError);
        return;
    }

    for (int32 w = 0; w < 4; ++w)
    {
        WheelRadiusCm[w] = static_cast<float>(Config_.tire(w).radius * rs::ue5::kMetersToCm);
        WheelWidthCm[w] = static_cast<float>(Config_.tire(w).section_width_m * rs::ue5::kMetersToCm);
    }

    const rs::PerformanceIndexReport PiReport = rs::compute_performance_index(Config_);
    PerformanceIndex = PiReport.pi;
    VirtualBenchmarkLapSeconds = static_cast<float>(PiReport.virtual_benchmark_lap_s);

    // The MoTeC log runs on a fixed time base (sample_rate_hz, 60 Hz): record() resamples the per-game-frame samples
    // below to it, so the exported time axis is right at any frame rate, and it keeps only a bounded amount of data.
    {
        rs::TelemetryMeta LogMeta;
        LogMeta.vehicle = Config_.name;
        MotecLogger_.reset(LogMeta);
        ElapsedTimeS_ = 0.0;
    }

    Body_ = Body;
    BodyRaw_ = Body;
    if (!Body->IsSimulatingPhysics()) Body->SetSimulatePhysics(true);
    if (bApplyMassFromSpec) ApplyMass(Body, Config_.mass);
    Body->SetNotifyRigidBodyCollision(true);
    Body->OnComponentHit.AddDynamic(this, &UOpenGridVehicleComponent::HandleBodyHit);

    if (bEnableSimHubUdp) UdpSender_.open("127.0.0.1", 20777);

    // Seed rays for the first frame's traces before the async physics thread starts.
    Bridge_->seed_rays(ChassisFromUe(Body->GetComponentLocation(), Body->GetComponentQuat(),
                                     Body->GetPhysicsLinearVelocity(),
                                     FMath::DegreesToRadians(Body->GetPhysicsAngularVelocityInDegrees())),
                       RaysPerWheel());

    const UPhysicsSettings* PS = UPhysicsSettings::Get();
    const bool bProjectAsync = PS && PS->bTickPhysicsAsync;
    bAsyncPhysicsActive = bUseAsyncPhysicsTick && bProjectAsync;
    if (bUseAsyncPhysicsTick && !bProjectAsync)
    {
        UE_LOG(LogOpenGrid, Warning, TEXT("Tick Physics Async is off in Project Settings > Physics: using the frame-tick fallback (handling will depend on frame rate)"));
    }
    bCarLoaded = true;
    ActiveVehicles_.AddUnique(this);
    bAsyncRun_.store(bAsyncPhysicsActive, std::memory_order_release);
    SetAsyncPhysicsTickEnabled(bAsyncPhysicsActive);
}

void UOpenGridVehicleComponent::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    ActiveVehicles_.Remove(this);
    QuiesceAsyncPhysics();
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

void UOpenGridVehicleComponent::TraceGround(const std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4>& Rays, int32 PerWheel,
                                            std::array<std::array<rs::ue5::GroundSample, MaxRaysPerWheel>, 4>& OutGround) const
{
    UWorld* World = GetWorld();
    if (!World) return;
    const UOpenGridWeatherSubsystem* WeatherSub = bAutoSyncWorldWeather ? World->GetSubsystem<UOpenGridWeatherSubsystem>() : nullptr;
    auto SurfaceToWeather = [&](int32 SurfIdx) -> rs::WeatherSurfaceType {
        if (SurfIdx >= 0 && SurfIdx < static_cast<int32>(Config_.surface_grip.size()))
        {
            const std::string& Name = Config_.surface_grip[SurfIdx].first;
            if (Name == "kerb" || Name == "curb" || Name == "paint") return rs::WeatherSurfaceType::PaintedKerb;
            if (Name == "concrete" || Name == "pavement") return rs::WeatherSurfaceType::Concrete;
            if (Name == "grass") return rs::WeatherSurfaceType::Grass;
            if (Name == "gravel" || Name == "dirt") return rs::WeatherSurfaceType::Gravel;
        }
        return rs::WeatherSurfaceType::Asphalt;
    };
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
            rs::ue5::GroundSample& G = OutGround[w][j];
            G = rs::ue5::GroundSample{};
            if (World->LineTraceSingleByChannel(Hit, ToFVector(rs::ue5::pos_to_ue(From)), ToFVector(rs::ue5::pos_to_ue(To)),
                                                WheelTraceChannel.GetValue(), Params))
            {
                G.hit = true;
                G.point = rs::ue5::pos_from_ue(ToUe(Hit.ImpactPoint));
                G.normal = rs::normalized(rs::ue5::dir_from_ue(ToUe(Hit.ImpactNormal)));
                G.surface = SurfaceFromPhysicalMaterial(Hit.PhysMaterial.Get());
                if (WeatherSub)
                {
                    const rs::WeatherWheelSample WS = WeatherSub->CoreWeather().sample_wheel(G.point.x, G.point.y, SurfaceToWeather(G.surface));
                    G.water_depth_mm = WS.water_depth_mm;
                    G.surface_mu_mult = WS.surface_mu_mult;
                    G.track_temp_c = WS.track_temp_c;
                }
            }
        }
    }
}

int32 UOpenGridVehicleComponent::TraceGroundStrips(UPrimitiveComponent* Body, float FrameDt,
                                                    const std::array<std::array<rs::WheelRay, MaxRaysPerWheel>, 4>& Rays,
                                                    int32 PerWheel, std::array<rs::ue5::GroundStrip, 4>& OutStrips) const
{
    UWorld* World = GetWorld();
    if (!World) return 0;
    const UOpenGridWeatherSubsystem* WeatherSub = bAutoSyncWorldWeather ? World->GetSubsystem<UOpenGridWeatherSubsystem>() : nullptr;
    auto SurfaceToWeather = [&](int32 SurfIdx) -> rs::WeatherSurfaceType {
        if (SurfIdx >= 0 && SurfIdx < static_cast<int32>(Config_.surface_grip.size()))
        {
            const std::string& Name = Config_.surface_grip[SurfIdx].first;
            if (Name == "kerb" || Name == "curb" || Name == "paint") return rs::WeatherSurfaceType::PaintedKerb;
            if (Name == "concrete" || Name == "pavement") return rs::WeatherSurfaceType::Concrete;
            if (Name == "grass") return rs::WeatherSurfaceType::Grass;
            if (Name == "gravel" || Name == "dirt") return rs::WeatherSurfaceType::Gravel;
        }
        return rs::WeatherSurfaceType::Asphalt;
    };
    FCollisionQueryParams Params(SCENE_QUERY_STAT(OpenGridGroundStrip), false, GetOwner());
    Params.bReturnPhysicalMaterial = true;

    const rs::Vec3 Vel = rs::ue5::vel_from_ue(ToUe(Body->GetPhysicsLinearVelocity()));
    const rs::Vec3 Fwd = rs::ue5::dir_from_ue(ToUe(Body->GetForwardVector()));
    const double Spacing = FMath::Max(0.01, static_cast<double>(GroundStripSpacingCm) * rs::ue5::kCmToMeters);
    const int32 Lanes = FMath::Clamp(GroundStripLanes, 1, 5);
    const int32 MaxSamples = FMath::Clamp(GroundStripMaxSamples, 4, 256);
    // Cover where the wheel will be until the next frame (this frame's dt as the estimate, plus half again).
    const double Horizon = FMath::Max(static_cast<double>(FrameDt), 1.0 / 400.0) * 1.5;
    constexpr double Behind = 0.30, Margin = 0.30;   // m: the 3-ray patch and 16-point footprint reach ~0.15-0.3 m

    int32 Traces = 0;
    for (int32 w = 0; w < 4; ++w)
    {
        const rs::Vec3 Down = Rays[w][0].direction;
        const double Reach = Rays[w][0].length;
        rs::Vec3 Mount{0, 0, 0};
        for (int32 j = 0; j < PerWheel; ++j) Mount = Mount + Rays[w][j].origin;
        Mount = Mount * (1.0 / PerWheel);

        // Direction of travel in the plane across the suspension axis; the car's nose when nearly stopped.
        const rs::Vec3 VPlane = Vel - Down * rs::dot(Vel, Down);
        const double Speed = rs::length(VPlane);
        const rs::Vec3 FPlane = Fwd - Down * rs::dot(Fwd, Down);
        const rs::Vec3 Along = Speed > 1.0 ? VPlane * (1.0 / Speed) : rs::normalized(FPlane);
        const rs::Vec3 Across = rs::normalized(rs::cross(Down, Along));

        const double Length = Behind + Speed * Horizon + Margin;
        int32 Count = static_cast<int32>(FMath::CeilToDouble(Length / Spacing)) + 1;
        double Step = Spacing;
        if (Count > MaxSamples) { Count = MaxSamples; Step = Length / (Count - 1); }

        rs::ue5::GroundStrip& S = OutStrips[w];
        S.origin = Mount - Along * Behind;
        S.along = Along;
        S.across = Across;
        S.spacing = Step;
        S.lane_spacing = Config_.tire(w).section_width_m * 0.5;   // 3 lanes span 1.5 x the tread: room for steering
        S.resize(Lanes, Count);
        for (int32 l = 0; l < Lanes; ++l)
        {
            for (int32 i = 0; i < Count; ++i)
            {
                const rs::Vec3 P = S.position(l, i);
                const rs::Vec3 From = P - Down * kTraceExtraUp;
                const rs::Vec3 To = P + Down * (Reach + kTraceExtraDown);
                FHitResult Hit;
                rs::ue5::GroundSample& G = S.at(l, i);
                ++Traces;
                if (World->LineTraceSingleByChannel(Hit, ToFVector(rs::ue5::pos_to_ue(From)), ToFVector(rs::ue5::pos_to_ue(To)),
                                                    WheelTraceChannel.GetValue(), Params))
                {
                    G.hit = true;
                    G.point = rs::ue5::pos_from_ue(ToUe(Hit.ImpactPoint));
                    G.normal = rs::normalized(rs::ue5::dir_from_ue(ToUe(Hit.ImpactNormal)));
                    G.surface = SurfaceFromPhysicalMaterial(Hit.PhysMaterial.Get());
                    if (WeatherSub)
                    {
                        const rs::WeatherWheelSample WS = WeatherSub->CoreWeather().sample_wheel(G.point.x, G.point.y, SurfaceToWeather(G.surface));
                        G.water_depth_mm = WS.water_depth_mm;
                        G.surface_mu_mult = WS.surface_mu_mult;
                        G.track_temp_c = WS.track_temp_c;
                    }
                }
            }
        }
    }
    return Traces;
}

// ---- Stepping -----------------------------------------------------------------------------------------------------

void UOpenGridVehicleComponent::AsyncPhysicsTickComponent(float DeltaTime, float SimTime)
{
    Super::AsyncPhysicsTickComponent(DeltaTime, SimTime);
    if (!BodyRaw_ || DeltaTime <= 0.0f) return;

    // Lock-free lifecycle gate (pairs with QuiesceAsyncPhysics on EndPlay / ApplyBopEqualizer).
    bInAsyncStep_.store(true, std::memory_order_seq_cst);
    struct FStepGuard {
        std::atomic<bool>& Flag;
        ~FStepGuard() { Flag.store(false, std::memory_order_release); }
    } Guard{bInAsyncStep_};
    if (!bAsyncRun_.load(std::memory_order_seq_cst) || !Bridge_.IsValid()) return;

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

    const rs::VehicleOutput& Out = Bridge_->step(Chassis, DeltaTime);
    const rs::ue5::UeVec3 Force = rs::ue5::force_to_ue(Out.force);
    const rs::ue5::UeVec3 Torque = rs::ue5::torque_to_ue(Out.torque);
    RB->AddForce(Chaos::FVec3(Force.x, Force.y, Force.z));
    RB->AddTorque(Chaos::FVec3(Torque.x, Torque.y, Torque.z));
}

void UOpenGridVehicleComponent::TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction)
{
    Super::TickComponent(DeltaTime, TickType, ThisTickFunction);
    UPrimitiveComponent* Body = Body_.Get();
    if (!bCarLoaded || !Body || !Bridge_.IsValid() || DeltaTime <= 0.0f) return;
    if (!Body->RigidBodyIsAwake()) Body->WakeRigidBody();   // a driven car must never fall asleep

    // 1. Hand this frame's input and settings to the physics thread through the lock-free command ring.
    rs::rt::VehicleCommand Cmd;
    Cmd.apply_tick = 0;
    Cmd.core_controls = bUseCoreControls;
    Cmd.raw.steer = SteerInput;
    Cmd.raw.throttle = ThrottleInput;
    Cmd.raw.brake = BrakeInput;
    Cmd.raw.clutch = ClutchInput;
    Cmd.raw.handbrake = HandbrakeInput;
    Cmd.raw.shift_up = bShiftUpRequested_;
    Cmd.raw.shift_down = bShiftDownRequested_;
    Cmd.raw.device = static_cast<rs::InputDevice>(static_cast<int32>(InputDevice));
    Cmd.direct.steer = SteerInput;
    Cmd.direct.throttle = ThrottleInput;
    Cmd.direct.brake = BrakeInput;
    Cmd.direct.clutch = ClutchInput;
    Cmd.direct.handbrake = HandbrakeInput;
    Cmd.direct.gear = GearIndex;
    Cmd.direct.auto_clutch = bAutoClutch;
    Cmd.direct.nos = bNitrousActive;
    Cmd.direct.starter = bStarterCrank;
    Cmd.repair = bRepairRequested_;
    Cmd.has_settings = true;
    Cmd.settings.turbo_stage = FMath::Clamp(TurboStage, 0, 3);
    Cmd.settings.altitude_m = AltitudeMeters;
    Cmd.settings.ambient_air_c = AmbientAirCelsius;
    Cmd.settings.track_surface_c = TrackSurfaceCelsius;
    Cmd.settings.humidity = RelativeHumidity;
    Cmd.settings.abs = bAbs;
    Cmd.settings.tc = bTractionControl;
    Cmd.settings.esc = bStabilityControl;
    Cmd.settings.auto_gearbox = bAutoGearbox;
    Cmd.settings.street_surface_enabled = bEnableDynamicStreetSurface;
    Cmd.settings.street_micro_roughness_enabled = bEnableUrbanMicroRoughness;
    Cmd.settings.street_road_class = FMath::Clamp(UrbanRoadClass, 0, 3);
    Cmd.settings.rain_mm_per_hr = FMath::Max(0.0f, RainRateMmPerHr);
    Cmd.settings.road_water_mm = FMath::Max(0.0f, RoadWaterMm);
    Cmd.settings.chassis_material = static_cast<int32>(ChassisMaterial);
    Cmd.settings.carbon_body_panels = bCarbonBodyPanels;
    Cmd.settings.roll_cage = bRollCage;
    Cmd.settings.race_suspension = bRaceSuspension;
    Cmd.settings.brake_bias_offset = FMath::Clamp(BrakeBiasOffset, -0.20f, 0.20f);
    Cmd.settings.brake_migration_override = (BrakeMigrationOverride >= -0.5f) ? static_cast<double>(BrakeMigrationOverride) : -999.0;
    Cmd.settings.hybrid_deploy_mode = FMath::Clamp(HybridDeployMode, 0.0f, 1.0f);
    Cmd.settings.engine_braking_scale = FMath::Clamp(EngineBrakingScale, 0.4f, 1.6f);
    Cmd.settings.throttle_map_gamma = FMath::Clamp(ThrottleMapGamma, 0.5f, 2.2f);
    Cmd.settings.brake_duct_open = FMath::Clamp(BrakeDuctOpen, 0.25f, 1.0f);
    UOpenGridWeatherSubsystem* WeatherSub = (bAutoSyncWorldWeather && GetWorld())
        ? GetWorld()->GetSubsystem<UOpenGridWeatherSubsystem>() : nullptr;
    if (WeatherSub)
    {
        const rs::Vec3 CarCorePos = rs::ue5::pos_from_ue(ToUe(Body->GetComponentLocation()));
        const rs::WeatherSample WS = WeatherSub->CoreWeather().sample(CarCorePos.x, CarCorePos.y);
        Cmd.settings.ambient_air_c = WS.ambient_air_c;
        Cmd.settings.track_surface_c = WS.track_surface_c;
        Cmd.settings.humidity = WS.humidity_0_to_1;
        Cmd.settings.rain_mm_per_hr = WS.rain_mm_per_hr;
        Cmd.settings.wind_world_mps = WS.wind_world_mps;
        Cmd.settings.barometric_offset_kpa = WS.barometric_kpa - 101.325;
        // Per-wheel GroundSamples carry exact sub-meter water_depth_mm so asymmetric puddles lift/drag only submerged wheels.
        Cmd.settings.road_water_mm = 0.0;
        AmbientAirCelsius = static_cast<float>(WS.ambient_air_c);
        TrackSurfaceCelsius = static_cast<float>(WS.track_surface_c);
        RelativeHumidity = static_cast<float>(WS.humidity_0_to_1);
        RainRateMmPerHr = static_cast<float>(WS.rain_mm_per_hr);
        RoadWaterMm = static_cast<float>(WS.surface_water_mm);
    }
    if (bAutoComputeAeroWake || !ManualAeroTraffic_.empty())
    {
        std::vector<rs::AeroTrafficCar> Nearby = ManualAeroTraffic_;
        if (bAutoComputeAeroWake)
        {
            UWorld* MyWorld = GetWorld();
            for (int32 i = ActiveVehicles_.Num() - 1; i >= 0; --i)
            {
                UOpenGridVehicleComponent* Other = ActiveVehicles_[i].Get();
                if (!Other) { ActiveVehicles_.RemoveAtSwap(i); continue; }
                if (Other == this || Other->GetWorld() != MyWorld || !Other->bCarLoaded) continue;
                UPrimitiveComponent* OtherBody = Other->Body_.Get();
                if (!OtherBody) continue;
                rs::AeroTrafficCar TC;
                TC.position = rs::ue5::pos_from_ue(ToUe(OtherBody->GetComponentLocation()));
                TC.velocity = rs::ue5::vel_from_ue(ToUe(OtherBody->GetPhysicsLinearVelocity()));
                TC.forward = rs::normalized(rs::ue5::dir_from_ue(ToUe(OtherBody->GetForwardVector())));
                TC.drag_area = Other->Config_.aero.drag_area;
                TC.lift_area = Other->Config_.aero.lift_area;
                Nearby.push_back(TC);
            }
        }
        const rs::Vec3 MyPos = rs::ue5::pos_from_ue(ToUe(Body->GetComponentLocation()));
        const rs::Vec3 MyVel = rs::ue5::vel_from_ue(ToUe(Body->GetPhysicsLinearVelocity()));
        const rs::Vec3 MyFwd = rs::normalized(rs::ue5::dir_from_ue(ToUe(Body->GetForwardVector())));
        Cmd.settings.has_aero_wake = true;
        Cmd.settings.aero_wake = rs::Vehicle::compute_aero_wake_field(
            MyPos, MyVel, MyFwd, Nearby, Cmd.settings.wind_world_mps, ElapsedTimeS_);
    }
    if (Bridge_->submit_command(Cmd))
    {
        bShiftUpRequested_ = bShiftDownRequested_ = bRepairRequested_ = false;
    }

    // 2. Trace ground under the latest wheel rays and publish into the wait-free ground triple buffer.
    const int32 PerWheel = RaysPerWheel();
    if (bAsyncPhysicsActive)
    {
        Bridge_->fetch_rays();
        const rs::ue5::RayFrame& RF = Bridge_->current_rays();
        rs::ue5::GroundFrame& GF = Bridge_->ground_write_buffer();
        GF.rays_per_wheel = PerWheel;
        GF.use_strip = bUseGroundStrip;
        int32 Traces = 0;
        if (RF.valid)
        {
            const int32 TraceCount = FMath::Min(PerWheel, RF.rays_per_wheel);
            TraceGround(RF.rays, TraceCount, GF.planes);
            Traces = 4 * TraceCount;
            if (bUseGroundStrip) Traces += TraceGroundStrips(Body, DeltaTime, RF.rays, TraceCount, GF.strips);
            GF.has_strips = bUseGroundStrip;
        }
        else
        {
            GF.has_strips = false;
        }
        GroundTracesLastFrame = Traces;
        Bridge_->publish_ground();
    }
    else
    {
        // Frame-tick fallback: seed fresh rays from the body's state now, trace, publish, step once.
        const rs::ChassisState Chassis = ChassisFromUe(Body->GetComponentLocation(), Body->GetComponentQuat(),
                                                       Body->GetPhysicsLinearVelocity(),
                                                       FMath::DegreesToRadians(Body->GetPhysicsAngularVelocityInDegrees()));
        Bridge_->seed_rays(Chassis, PerWheel);
        Bridge_->fetch_rays();
        rs::ue5::GroundFrame& GF = Bridge_->ground_write_buffer();
        GF.rays_per_wheel = PerWheel;
        GF.has_strips = false;   // fresh traces every step here: no strip needed
        GF.use_strip = false;
        TraceGround(Bridge_->current_rays().rays, PerWheel, GF.planes);
        GroundTracesLastFrame = 4 * PerWheel;
        Bridge_->publish_ground();
        const rs::VehicleOutput& Out = Bridge_->step(Chassis, FMath::Min(static_cast<double>(DeltaTime), kMaxFrameStep));
        const rs::ue5::UeVec3 Force = rs::ue5::force_to_ue(Out.force);
        const rs::ue5::UeVec3 Torque = rs::ue5::torque_to_ue(Out.torque);
        Body->AddForce(FVector(Force.x, Force.y, Force.z));
        Body->AddTorqueInRadians(FVector(Torque.x, Torque.y, Torque.z));
    }

    // 3. Drain the physics->game record ring (keeping both the previous and latest StepRecord snapshots for wheel pose
    //    interpolation, and latching any single-tick events that fired on intermediate physics sub-steps).
    bool bSawMissedShiftEdge = false;
    bool bSawGearGrindEdge = false;
    bool bSawBovEdge = false;
    Bridge_->drain_records([&](const rs::rt::StepRecord& Rec)
    {
        if (bHaveRecord_)
        {
            PrevRecord_ = LastRecord_;
            bHavePrevRecord_ = true;
        }
        LastRecord_ = Rec;
        bHaveRecord_ = true;
        if (Rec.out.missed_shift_event) bSawMissedShiftEdge = true;
        if (Rec.out.gear_grind) bSawGearGrindEdge = true;
        if (Rec.out.bov_venting) bSawBovEdge = true;
    });
    if (!bHaveRecord_) return;
    if (bSawMissedShiftEdge) LastRecord_.out.missed_shift_event = true;
    if (bSawGearGrindEdge) LastRecord_.out.gear_grind = true;
    if (bSawBovEdge) LastRecord_.out.bov_venting = true;

    const rs::ChassisState RenderChassis = ChassisFromUe(
        Body->GetComponentLocation(), Body->GetComponentQuat(),
        Body->GetPhysicsLinearVelocity(),
        FMath::DegreesToRadians(Body->GetPhysicsAngularVelocityInDegrees()));

    ElapsedTimeS_ += DeltaTime;
    if (WeatherSub)
    {
        const double VCar = rs::length(RenderChassis.velocity);
        double WaterSum = 0.0;
        int32 ContactCount = 0;
        for (int32 w = 0; w < 4; ++w)
        {
            const rs::WheelOutput& WO = LastRecord_.out.wheels[w];
            if (!WO.contact) continue;
            const double SlipP = std::abs(WO.fx * WO.slip_ratio * std::max(VCar, 1.0))
                               + std::abs(WO.fy * std::sin(WO.slip_angle) * std::max(VCar, 1.0));
            const double EvacScale = rs::clamp(Config_.tire(w).tread_void_ratio / 0.28, 0.25, 2.5);
            WeatherSub->CoreWeather().deposit_tyre_passage(WO.contact_point.x, WO.contact_point.y,
                                                           VCar, WO.load, SlipP, EvacScale, static_cast<double>(DeltaTime),
                                                           WO.condition.mud_pickup);
            WaterSum += WO.condition.road_water_mm;
            ++ContactCount;
        }
        if (ContactCount > 0)
        {
            const double AvgW = WaterSum / ContactCount;
            const double DiffuserDownN = 0.5 * LastRecord_.out.air_density_kg_m3 * Config_.aero.lift_area * VCar * VCar;
            WeatherSub->CoreWeather().deposit_car_spray(RenderChassis.position, RenderChassis.velocity, AvgW, DiffuserDownN, static_cast<double>(DeltaTime));
        }
        const rs::Vec3 EyePos = RenderChassis.position + rs::Vec3{0.0, 0.0, 1.05};
        const rs::Vec3 FwdDir = RenderChassis.orientation.rotate({1.0, 0.0, 0.0});
        DriverVisibilityMeters = static_cast<float>(WeatherSub->CoreWeather().sample_driver_visibility_m(EyePos, FwdDir));
    }
    PublishOutputs(LastRecord_.out, LastRecord_.spin, &RenderChassis);
    // Burnt fuel makes the car lighter: refresh the body every 0.25 kg (game thread; rare, so cheap).
    if (bApplyMassFromSpec && LastRecord_.out.mass_kg > 0.0 && FMath::Abs(LastRecord_.out.mass_kg - AppliedMassKg_) > 0.25)
    {
        ApplyMass(Body, LastRecord_.out.mass_kg);
    }

    const rs::TelemetrySample Sample = rs::make_telemetry_sample(LastRecord_.out, LastRecord_.chassis, LastRecord_.input, Config_, ElapsedTimeS_);
    MotecLogger_.record(Sample);
    if (bEnableSimHubUdp && UdpSender_.is_open()) UdpSender_.send(Sample);
}

FOpenGridWheelState UOpenGridVehicleComponent::GetWheelState(int32 WheelIndex) const
{
    return WheelStates.IsValidIndex(WheelIndex) ? WheelStates[WheelIndex] : FOpenGridWheelState{};
}

void UOpenGridVehicleComponent::PublishOutputs(const rs::VehicleOutput& Out, const std::array<double, 4>& Spin,
                                               const rs::ChassisState* RenderChassis)
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
    MassKg = static_cast<float>(Out.mass_kg);
    bGearGrind = Out.gear_grind;
    bMissedShiftEvent = Out.missed_shift_event;
    RollCentreFrontCm = static_cast<float>(Out.roll_centre_front_m * rs::ue5::kMetersToCm);
    RollCentreRearCm = static_cast<float>(Out.roll_centre_rear_m * rs::ue5::kMetersToCm);
    ClutchTempC = static_cast<float>(Out.clutch_temp_c);
    ClutchHealth = static_cast<float>(Out.clutch_health);
    GearboxHealth = static_cast<float>(Out.gearbox_health);
    MissedShifts = Out.missed_shifts;
    ExhaustPrimaryHz = static_cast<float>(EngineRpm * 6.0 / 120.0);
    GearWhineHz = rs::ue5::compute_gear_whine_hz(Out, Config_);
    bShiftCutActive = Out.shift_cut_active;
    DrivelineClunkNm = static_cast<float>(Out.driveline_clunk_nm);
    ChassisTwistDeg = static_cast<float>(Out.chassis_twist_deg);
    AycYawMomentNm = static_cast<float>(Out.ayc_yaw_moment_nm);
    bDrsActive = Out.drs_active;
    bAirbrakeActive = Out.airbrake_active;
    bFrontSplitterStalled = Out.front_splitter_stalled;
    bDiffuserStalled = Out.diffuser_stalled;
    FrontRideHeightCm = static_cast<float>(Out.front_ride_height_m * rs::ue5::kMetersToCm);
    RearRideHeightCm = static_cast<float>(Out.rear_ride_height_m * rs::ue5::kMetersToCm);
    AeroBalanceFront = static_cast<float>(Out.aero_balance_front);
    SlipstreamDragScale = static_cast<float>(Out.slipstream_drag_scale);
    DirtyAirFrontScale = static_cast<float>(Out.dirty_air_downforce_scale);
    DirtyAirRearScale = static_cast<float>(Out.dirty_air_rear_downforce_scale);
    SideDraftDragDelta = static_cast<float>(Out.side_draft_drag_delta);
    TandemPushDragDelta = static_cast<float>(Out.tandem_push_drag_delta);
    WakeTurbulence = static_cast<float>(Out.wake_turbulence);
    WakeHotAirCelsius = static_cast<float>(Out.wake_hot_air_c);
    WakeCoolingScale = static_cast<float>(Out.wake_cooling_scale);
    AeroDragN = static_cast<float>(Out.aero_drag_n);
    AeroDownforceFrontN = static_cast<float>(Out.aero_downforce_front_n);
    AeroDownforceRearN = static_cast<float>(Out.aero_downforce_rear_n);
    AeroSideForceN = static_cast<float>(Out.aero_side_force_n);
    AeroYawMomentNm = static_cast<float>(Out.aero_yaw_moment_nm);
    if (Bridge_.IsValid())
    {
        StreetRubberAtCar = static_cast<float>(Bridge_->street_rubber_at_car());
        StreetMarblesAtCar = static_cast<float>(Bridge_->street_marbles_at_car());
    }
    SteeringColumnTorqueNm = static_cast<float>(Out.steering_column_torque_nm);
    SteeringAssistTorqueNm = static_cast<float>(Out.steering_assist_torque_nm);
    PowerSteeringGain = static_cast<float>(Out.power_steering_gain);
    TorqueConverterSlipRatio = static_cast<float>(Out.tc_slip_ratio);
    TorqueConverterTorqueRatio = static_cast<float>(Out.tc_torque_ratio);
    bTorqueConverterLocked = Out.tc_lockup_engaged;
    AirDensityKgPerM3 = static_cast<float>(Out.air_density_kg_m3);
    BrakeVaporLockSponge = static_cast<float>(Out.brake_vapor_lock_sponge);
    EffectiveBrakeBiasFront = static_cast<float>(Out.effective_brake_bias_front);
    HybridSoc = static_cast<float>(Out.hybrid_soc);
    HybridDeployKw = static_cast<float>(Out.hybrid_deploy_kw);
    HybridRegenKw = static_cast<float>(Out.hybrid_regen_kw);
    bHybridBbwActive = Out.hybrid_bbw_active;
    FrontAdhesionRatio = static_cast<float>(Out.front_adhesion_ratio);
    WakeAsymmetry = static_cast<float>(Out.wake_asymmetry);

    // Interpolate wheel poses in body-local space between PrevRecord_ and LastRecord_ and transform by the live
    // game-thread RenderChassis so wheels in UE 5.8 never lag the interpolated chassis by one step.
    const rs::rt::StepRecord& Prev = bHavePrevRecord_ ? PrevRecord_ : LastRecord_;
    const rs::ChassisState& PoseForWheels = RenderChassis ? *RenderChassis : LastRecord_.chassis;
    const double Alpha = (bHavePrevRecord_ && RenderChassis)
                             ? rs::ue5::compute_render_alpha(Prev.chassis, LastRecord_.chassis, *RenderChassis)
                             : 1.0;

    if (WheelStates.Num() != 4) WheelStates.Init(FOpenGridWheelState{}, 4);
    for (int32 w = 0; w < 4; ++w)
    {
        rs::Vec3 InterpWorldCenter = Out.wheels[w].centre_world;
        double InterpSteerRad = Out.wheels[w].steer_angle;
        double InterpSpinRad = Spin[w];
        double InterpToeRad = Out.wheels[w].toe_angle;
        double InterpCamberRad = Out.wheels[w].camber;
        if (bHaveRecord_)
        {
            rs::ue5::interpolate_wheel_pose(Prev, LastRecord_, PoseForWheels, Alpha, w,
                                            InterpWorldCenter, InterpSteerRad, InterpSpinRad,
                                            InterpToeRad, InterpCamberRad);
        }

        const rs::ue5::UeWheelState WS = rs::ue5::make_ue_wheel_state(
            Out.wheels[w], Config_.tire(w).radius, InterpWorldCenter,
            InterpSteerRad, InterpSpinRad, InterpToeRad, InterpCamberRad);

        FOpenGridWheelState& Dst = WheelStates[w];
        Dst.bInContact = WS.in_contact;
        Dst.WorldCenterCm = ToFVector(WS.world_center_cm);
        Dst.ContactPointWorldCm = ToFVector(WS.contact_point_world_cm);
        Dst.SteerAngleRad = WS.steer_angle_rad;
        Dst.SteerAngleDeg = WS.steer_angle_deg;
        Dst.CamberAngleDeg = WS.camber_angle_deg;
        Dst.SpinAngleRad = WS.spin_angle_rad;
        Dst.AngularVelocityRadS = WS.angular_velocity_rads;
        Dst.NormalLoadN = WS.normal_load_n;
        Dst.SuspensionCompressionCm = WS.suspension_compression_cm;
        Dst.SlipRatio = WS.slip_ratio;
        Dst.SlipAngleDeg = WS.slip_angle_deg;
        Dst.SurfaceTempC = WS.surface_temp_c;
        Dst.CarcassTempC = WS.carcass_temp_c;
        Dst.PressureKpa = WS.pressure_kpa;
        Dst.BrakeDiscTempC = WS.brake_disc_temp_c;
        Dst.ToeAngleDeg = WS.toe_angle_deg;
        Dst.CasterAngleDeg = WS.caster_angle_deg;
        Dst.KpiAngleDeg = WS.kpi_angle_deg;
        Dst.ScrubRadiusCm = WS.scrub_radius_cm;
        Dst.MotionRatio = WS.motion_ratio;
        Dst.InnerAirTempC = WS.inner_air_temp_c;
        Dst.FlashTempC = WS.flash_temp_c;
        Dst.FlatSpotDepthMm = WS.flat_spot_depth_mm;
        Dst.CavityRingGain = WS.cavity_ring_gain;
        Dst.SidewallRollover = WS.sidewall_rollover;
        Dst.SidewallDamage = WS.sidewall_damage;
        Dst.RimStrikeForceN = WS.rim_strike_force_n;
        Dst.CarcassHysteresisW = WS.carcass_hysteresis_w;
        Dst.AdhesionRatio = WS.adhesion_ratio;
        Dst.PneumaticTrailCm = WS.pneumatic_trail_cm;

        WheelCentresWorld[w] = Dst.WorldCenterCm;
        WheelSteerRad[w] = Dst.SteerAngleRad;
        WheelSpinRad[w] = Dst.SpinAngleRad;
    }

    const rs::EngineAcousticState Acoustics = rs::compute_engine_acoustics(
        rs::EngineAcousticLayout::Inline6, Out.engine_rpm, Out.throttle_applied,
        Out.boost_bar, Out.bov_venting, Out.shift_cut_active, Out.gear, Out.speed);
    FundamentalFiringHz = static_cast<float>(Acoustics.fundamental_firing_hz);
    TurboImpellerRpm = static_cast<float>(Acoustics.turbo_impeller_rpm);
    TurboWhistleHz = static_cast<float>(Acoustics.turbo_whistle_hz);
    TransmissionWhineHz = GearWhineHz > 0.0f ? GearWhineHz : static_cast<float>(Acoustics.transmission_whine_hz);
    OverrunPopIntensity = static_cast<float>(Acoustics.overrun_pop_intensity);

    if (ZoneDamage.Num() != 4) ZoneDamage.SetNumZeroed(4);
    for (int32 i = 0; i < 4; ++i) ZoneDamage[i] = static_cast<float>(Out.damage.zone[i]);

    if (CrushNodeWeights.Num() != 8) CrushNodeWeights.SetNumZeroed(8);
    if (PaintScratchWeights.Num() != 8) PaintScratchWeights.SetNumZeroed(8);
    for (int32 i = 0; i < 8; ++i)
    {
        CrushNodeWeights[i] = static_cast<float>(Out.damage.node_norm[i]);
        PaintScratchWeights[i] = static_cast<float>(Out.damage.paint_scratch[i]);
    }

    if (ZoneShatterWeights.Num() != 4) ZoneShatterWeights.SetNumZeroed(4);
    if (WheelDetached.Num() != 4) WheelDetached.Init(false, 4);
    if (TyrePunctured.Num() != 4) TyrePunctured.Init(false, 4);
    if (BrakeLineRuptured.Num() != 4) BrakeLineRuptured.Init(false, 4);
    if (HalfshaftBroken.Num() != 4) HalfshaftBroken.Init(false, 4);
    for (int32 i = 0; i < 4; ++i)
    {
        ZoneShatterWeights[i] = static_cast<float>(Out.damage.shatter[i]);
        WheelDetached[i] = Out.damage.wheel_detached[i];
        TyrePunctured[i] = Out.damage.tyre_punctured[i];
        BrakeLineRuptured[i] = Out.damage.brake_line_ruptured[i];
        HalfshaftBroken[i] = Out.damage.halfshaft_broken[i];
    }
    FrontAeroEfficiency = static_cast<float>(Out.damage.front_aero_efficiency);
    RearAeroEfficiency = static_cast<float>(Out.damage.rear_aero_efficiency);
    ChassisStiffnessFactor = static_cast<float>(Out.damage.chassis_stiffness_factor);

    CoolantLeak01 = static_cast<float>(Out.damage.coolant_leak);
    CoolantLevel01 = static_cast<float>(Out.damage.coolant_level);
    CoolantDripLps = static_cast<float>(Out.damage.coolant_drip_lps);
    OilLeak01 = static_cast<float>(Out.damage.oil_leak);
    OilLevel01 = static_cast<float>(Out.damage.oil_level);
    OilDripLps = static_cast<float>(Out.damage.oil_drip_lps);
    FuelLeak01 = static_cast<float>(Out.damage.fuel_leak);
    FuelDripLps = static_cast<float>(Out.damage.fuel_drip_lps);

    const rs::ue5::UeCrushMorphWeights Morph = rs::ue5::compute_crush_morph_weights(Out.damage);
    CrushMorphWeights.crush_front = Morph.crush_front;
    CrushMorphWeights.crush_rear = Morph.crush_rear;
    CrushMorphWeights.crush_left = Morph.crush_left;
    CrushMorphWeights.crush_right = Morph.crush_right;
    CrushMorphWeights.crush_top = Morph.crush_top;
    CrushMorphWeights.crush_hood = Morph.crush_hood;

    bHoodUnlatched = Out.damage.hood_unlatched;
    bTrunkUnlatched = Out.damage.trunk_unlatched;
    bFrontBumperDetached = Out.damage.front_bumper_detached;
    bRearBumperDetached = Out.damage.rear_bumper_detached;

    // Event notifications & counters (MissedShift, GearGrind, Backfire, Scrape, BlowOffValve)
    // A missed shift is announced once: on the rising edge of the event flag, or when the missed-shift count goes up (two in a
    // row keep the flag high). TickComponent publishes the same LastRecord_ again on every frame that drains no new physics
    // step, and that record keeps its latched event flag, so testing the flag as a level would re-fire the event (and the
    // grind sound / UI bound to it) on each of those frames and over-count OnMissedShiftCount.
    const bool bMissedShiftEdge = (Out.missed_shift_event && !bPrevMissedShiftEvent_) || Out.missed_shifts > PrevMissedShifts_;
    bPrevMissedShiftEvent_ = Out.missed_shift_event;
    if (bMissedShiftEdge)
    {
        OnMissedShiftCount = FMath::Max(OnMissedShiftCount + 1, Out.missed_shifts);
        LastMissedShiftTime = static_cast<float>(ElapsedTimeS_);
        OnMissedShift.Broadcast(OnMissedShiftCount, LastMissedShiftTime);
    }
    PrevMissedShifts_ = Out.missed_shifts;

    if (Out.gear_grind && !bPrevGearGrind_)
    {
        OnGearGrind.Broadcast(Out.gear);
    }
    bPrevGearGrind_ = Out.gear_grind;

    bBackfireActive = (OverrunPopIntensity > 0.35f) || Out.shift_cut_active || Out.engine_misfire;
    if (bBackfireActive && !bPrevBackfire_)
    {
        OnBackfire.Broadcast(FMath::Max(OverrunPopIntensity, Out.shift_cut_active ? 0.8f : 0.5f));
    }
    bPrevBackfire_ = bBackfireActive;

    const bool bNewDamageEnergy = Out.damage.total_energy_kj > PrevDamageEnergyKj_ + 1e-4;
    bScrapeActive = bNewDamageEnergy || Out.front_splitter_stalled;
    if (bScrapeActive && !bPrevScrape_)
    {
        OnScrape.Broadcast(static_cast<float>(FMath::Max(0.1, Out.damage.last_impact_kj)));
    }
    bPrevScrape_ = bScrapeActive;
    PrevDamageEnergyKj_ = Out.damage.total_energy_kj;

    if (Out.bov_venting && !bPrevBov_) OnBlowOffValveVent.Broadcast(FMath::Max(0.35f, BoostBar));
    bPrevBov_ = Out.bov_venting;
}

// ---- Events and Blueprint calls -----------------------------------------------------------------------------------

void UOpenGridVehicleComponent::HandleBodyHit(UPrimitiveComponent* HitComponent, AActor* OtherActor, UPrimitiveComponent* OtherComp,
                                              FVector NormalImpulse, const FHitResult& Hit)
{
    if (!Bridge_.IsValid()) return;
    const double ImpulseNs = NormalImpulse.Size() * rs::ue5::kCmToMeters;   // kg cm/s -> N s
    if (ImpulseNs < 1.0) return;
    rs::rt::ImpactCommand Impact;
    Impact.point_world = rs::ue5::pos_from_ue(ToUe(Hit.ImpactPoint));
    Impact.impulse = ImpulseNs;
    Impact.other = OtherActor ? static_cast<uint64>(OtherActor->GetUniqueID()) : 0;
    Bridge_->submit_impact(Impact);
}

void UOpenGridVehicleComponent::UpdateAeroTraffic(const TArray<FOpenGridAeroTrafficCar>& NearbyCars)
{
    ManualAeroTraffic_.clear();
    ManualAeroTraffic_.reserve(static_cast<std::size_t>(NearbyCars.Num()));
    for (const FOpenGridAeroTrafficCar& C : NearbyCars)
    {
        rs::AeroTrafficCar TC;
        TC.position = rs::ue5::pos_from_ue(ToUe(C.PositionCm));
        TC.velocity = rs::ue5::vel_from_ue(ToUe(C.VelocityCms));
        TC.forward = rs::normalized(rs::ue5::dir_from_ue(ToUe(C.Forward)));
        TC.drag_area = C.DragArea;
        TC.lift_area = C.LiftArea;
        TC.width_m = C.WidthCm * rs::ue5::kCmToMeters;
        TC.height_m = C.HeightCm * rs::ue5::kCmToMeters;
        ManualAeroTraffic_.push_back(TC);
    }
}

void UOpenGridVehicleComponent::RepairAndService()
{
    bRepairRequested_ = true;
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
    const bool bWasAsync = bAsyncPhysicsActive;
    if (bWasAsync) QuiesceAsyncPhysics();

    const rs::BopAdjustment Bop = rs::compute_bop_equalizer(Config_, TargetPi);
    Config_ = Bop.balanced_config;
    PerformanceIndex = Bop.balanced_report.pi;
    VirtualBenchmarkLapSeconds = static_cast<float>(Bop.balanced_report.virtual_benchmark_lap_s);
    CreateVehicle();
    if (UPrimitiveComponent* Body = Body_.Get())
    {
        Bridge_->seed_rays(ChassisFromUe(Body->GetComponentLocation(), Body->GetComponentQuat(),
                                         Body->GetPhysicsLinearVelocity(),
                                         FMath::DegreesToRadians(Body->GetPhysicsAngularVelocityInDegrees())),
                           RaysPerWheel());
        if (bApplyMassFromSpec) ApplyMass(Body, Config_.mass);
    }

    if (bWasAsync) bAsyncRun_.store(true, std::memory_order_release);
}
