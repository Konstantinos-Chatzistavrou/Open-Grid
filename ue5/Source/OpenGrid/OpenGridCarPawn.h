// Apache-2.0 — the drivable car: a physics box at the CG driven by UOpenGridVehicleComponent, placeholder body and
// wheels from the engine's basic shapes (swap BodyMesh / WheelMesh for the imported car), a low chase camera, and
// keyboard + gamepad input built in code (no input assets to create in the editor).
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "OpenGridVehicleComponent.h"
#include "OpenGridCarPawn.generated.h"

class UBoxComponent;
class UCameraComponent;
class UEnhancedInputComponent;
class UInputAction;
class UInputMappingContext;
class USkeletalMesh;
class USkeletalMeshComponent;
class USpringArmComponent;
class UStaticMesh;
class UStaticMeshComponent;

UCLASS()
class OPENGRID_API AOpenGridCarPawn : public APawn
{
    GENERATED_BODY()

public:
    AOpenGridCarPawn();

    virtual void Tick(float DeltaSeconds) override;
    virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;
    virtual void PawnClientRestart() override;

    /** Physics body: its centre is the car's centre of gravity (the core's chassis origin). */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid")
    TObjectPtr<UBoxComponent> Chassis;

    /** Visible body. A scaled cube until the imported car is assigned (no collision: the box above collides). */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid")
    TObjectPtr<UStaticMeshComponent> BodyMesh;

    /**
     * Optional deformable skeletal body mesh with the 6 directional crash Morph Targets
     * (crush_front, crush_rear, crush_left, crush_right, crush_top, crush_hood).
     */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|Damage")
    TObjectPtr<USkeletalMeshComponent> DeformableBodyMesh;

    /** Modular aftermarket visual parts (ue5/Import/<car>/parts/*.glb) attached to BodyMesh. */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMeshComponent> WidebodyMesh;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMeshComponent> WingMesh;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMeshComponent> SplitterMesh;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMeshComponent> DiffuserMesh;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMeshComponent> SkirtsMesh;

    /** FL, FR, RL, RR. Placed every frame from the physics (centre, steer, spin). */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid")
    TArray<TObjectPtr<UStaticMeshComponent>> Wheels;

    /** FL, FR, RL, RR. Hidden unless CaliperMeshes are set. */
    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid")
    TArray<TObjectPtr<UStaticMeshComponent>> Calipers;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid")
    TObjectPtr<USpringArmComponent> CameraArm;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid")
    TObjectPtr<UCameraComponent> Camera;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="OpenGrid")
    TObjectPtr<UOpenGridVehicleComponent> Vehicle;

    /**
     * The imported car body without its wheels, as exported by tools/ue5/export_cars_for_ue.mjs: origin on the ground
     * at the body's length centre, real size. It is placed from the car's .visual.json so it sits on the physics CG.
     * Empty = a scaled cube.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid")
    TObjectPtr<UStaticMesh> BodyMeshAsset;

    /** Extra rotation for the imported body if the importer brought it in facing the wrong way (nose must point +X). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid")
    FRotator BodyMeshRotation = FRotator(0.0f, 0.0f, 0.0f);

    /** Optional deformable skeletal mesh asset with 6 directional crash morph targets (crush_front..crush_hood). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Damage")
    TObjectPtr<USkeletalMesh> DeformableBodyMeshAsset;

    /** Optional modular aftermarket visual part meshes from ue5/Import/<car>/parts/*.glb. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMesh> WidebodyMeshAsset;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMesh> WingMeshAsset;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMesh> SplitterMeshAsset;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMesh> DiffuserMeshAsset;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Mods")
    TObjectPtr<UStaticMesh> SkirtsMeshAsset;

    /** Snap all assigned modular aftermarket visual parts onto BodyMesh in one call. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Mods")
    void ApplyVisualMods();

    /**
     * Compute the 6 normalized directional crash morph-target weights (crush_front, crush_rear, crush_left,
     * crush_right, crush_top, crush_hood in 0..1) from Vehicle->GetZoneDamage() and 8-node perimeter crush state.
     */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Damage")
    FOpenGridCrushMorphWeights GetCrushMorphWeights() const;

    /** Push the 6 directional crash morph target weights onto DeformableBodyMesh when active. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Damage")
    void UpdateCrushMorphTargets();

    /**
     * Wheel meshes FL, FR, RL, RR (empty entries = placeholder cylinder). Expected centred on the hub with the axle
     * along Y, at real size: a real wheel mesh is not rescaled.
     */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid")
    TArray<TObjectPtr<UStaticMesh>> WheelMeshes;

    /** Brake calipers FL, FR, RL, RR (optional). Pivot on the hub like the wheels; they steer but do not spin. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid")
    TArray<TObjectPtr<UStaticMesh>> CaliperMeshes;

    /** Show speed, gear and rpm in the corner of the screen. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid")
    bool bShowDebugHud = true;

    /** Repair, refuel and put the car back on its wheels one metre up, facing the same way (R / pad B). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid")
    void Recover();

protected:
    virtual void BeginPlay() override;

private:
    void BuildInput();
    UInputAction* MakeAction(const TCHAR* Name, bool bAxis);
    void MapKey(UInputAction* Action, const FKey& Key, bool bNegate = false);
    float ActionValue(const UInputAction* Action) const;
    void PlaceWheels();
    void DrawHud() const;

    void OnShiftUp();
    void OnShiftDown();
    void OnRecover();

    UPROPERTY(Transient)
    TObjectPtr<UInputMappingContext> InputContext;

    // Keyboard (digital: the core ramps them) and gamepad (analog) are separate actions so the core knows the device.
    UPROPERTY(Transient) TObjectPtr<UInputAction> KbSteer;
    UPROPERTY(Transient) TObjectPtr<UInputAction> KbThrottle;
    UPROPERTY(Transient) TObjectPtr<UInputAction> KbBrake;
    UPROPERTY(Transient) TObjectPtr<UInputAction> PadSteer;
    UPROPERTY(Transient) TObjectPtr<UInputAction> PadThrottle;
    UPROPERTY(Transient) TObjectPtr<UInputAction> PadBrake;
    UPROPERTY(Transient) TObjectPtr<UInputAction> Handbrake;
    UPROPERTY(Transient) TObjectPtr<UInputAction> ShiftUpAction;
    UPROPERTY(Transient) TObjectPtr<UInputAction> ShiftDownAction;
    UPROPERTY(Transient) TObjectPtr<UInputAction> RecoverAction;

    UPROPERTY(Transient)
    TObjectPtr<UEnhancedInputComponent> BoundInput;
};
