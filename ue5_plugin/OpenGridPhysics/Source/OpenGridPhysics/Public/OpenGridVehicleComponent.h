// Apache-2.0 — OpenGrid Unreal Engine 5 UActorComponent Wrapper for rs_core.
// Drop onto any AActor / APawn with a root UPrimitiveComponent body to run the 1 kHz sub-stepped
// Pacejka MF 6.1 vehicle simulation, 3-ray circular-arc curb contact patch, forced induction (Turbo + BOV + N2O),
// and SimHub UDP / MoTeC i2 Pro telemetry inside Unreal Engine 5.
#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "rs/config.hpp"
#include "rs/vehicle.hpp"
#include "rs/telemetry.hpp"
#include "rs/ue5_bridge.hpp"
#include "OpenGridVehicleComponent.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnBlowOffValveVent, float, BoostBarReleased);

UCLASS(ClassGroup=(OpenGrid), meta=(BlueprintSpawnableComponent))
class OPENGRIDPHYSICS_API UOpenGridVehicleComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UOpenGridVehicleComponent();

    /** Path to the OpenGrid JSON car spec (e.g. "cars/vela_gt.json") relative to Content/OpenGridData/. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Config")
    FString CarConfigRelativePath = TEXT("cars/vela_gt.json");

    /** Turbocharger stage (0 = Naturally Aspirated, 1 = Street 0.7 bar, 2 = Sport 1.15 bar, 3 = Race 1.65 bar). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Drivetrain")
    int32 TurboStage = 0;

    /** Use 3-ray circular-arc tire contact patch per wheel for smooth street curb climbing. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Suspension")
    bool bUseThreeRayContactPatch = true;

    /** Stream live 311-byte Forza Dash V2 UDP packets to 127.0.0.1:20777 for SimHub / motion rigs. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Telemetry")
    bool bEnableSimHubUdp = true;

    // ---- Driver Inputs (bind from EnhancedInput in Blueprint or C++) -----------------------------------
    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float SteerInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float ThrottleInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float BrakeInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float ClutchInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    float HandbrakeInput = 0.0f;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    int32 GearIndex = 2;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    bool bAutoClutch = true;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    bool bNitrousActive = false;

    UPROPERTY(BlueprintReadWrite, Category="OpenGrid|Input")
    bool bStarterCrank = false;

    // ---- Live Telemetry Outputs (drive UMG HUD, Substrate Paint Wear MPC, and MetaSounds) --------------
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float SpeedKmh = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float EngineRpm = 900.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float BoostBar = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bBovVenting = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float NosRemainingLiters = 4.5f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float OilTempC = 85.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float EngineHealth = 1.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float SteerTorqueNm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float IntakeAirTempC = 28.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float FuelLiters = 55.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bGearGrind = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    bool bShiftCutActive = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Telemetry")
    float DrivelineClunkNm = 0.0f;

    /** 8-Node Normalized Structural Crush Weights (0..1) for UE5 Skeletal Mesh Morph Targets (FL, FrontCenter, FR, Left, Right, RL, RearCenter, RR). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    TArray<float> CrushNodeWeights;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bHoodUnlatched = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bTrunkUnlatched = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bFrontBumperDetached = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Damage")
    bool bRearBumperDetached = false;

    /** Fired when the Blow-Off Valve vents compressed turbo charge on throttle lift (hook straight to MetaSounds). */
    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Audio")
    FOnBlowOffValveVent OnBlowOffValveVent;

    /** Export recorded lap telemetry to MoTeC i2 Pro (.ld + .ldx) on disk. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Telemetry")
    bool ExportMotecLog(const FString& OutputBasePath);

protected:
    virtual void BeginPlay() override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
    virtual void TickComponent(float DeltaTime, ELevelTick TickType, FActorComponentTickFunction* ThisTickFunction) override;

private:
    rs::CarConfig Config_;
    TUniquePtr<rs::Vehicle> Vehicle_;
    rs::UdpTelemetrySender UdpSender_;
    rs::MotecLogger MotecLogger_;
    double ElapsedTimeS_ = 0.0;
    bool bPrevBov_ = false;
};
