// Apache-2.0 — World subsystem managing 6-car race grids, checkpoint/lap progression, AI rival registration,
// clean-race & overtake tracking, race rewards (matching web/src/progression.ts), and Heat 0-5 tactical police
// pursuit state (matching web/src/heat.ts and core/include/rs/cops.hpp).
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "OpenGridRaceSubsystem.generated.h"

class AActor;

UENUM(BlueprintType)
enum class EOpenGridRaceState : uint8
{
    Idle = 0,
    Countdown = 1,
    Racing = 2,
    Finished = 3,
};

/** Ordered gate defining a circuit or sprint route in UE world space (cm). */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridCheckpoint
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Race")
    FVector Location = FVector::ZeroVector;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Race")
    FVector Forward = FVector::ForwardVector;

    /** Gate trigger radius in cm (default 12 m street width). */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Race", meta=(ClampMin="100.0"))
    float RadiusCm = 1200.0f;

    /** Cumulative distance from the start line to this checkpoint (cm), computed on ConfigureRace. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    float CumulativeDistanceCm = 0.0f;
};

/** Live progression, timing, and clean-race state for one car on the 6-car grid. */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridRacerEntry
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    FName RacerId = NAME_None;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    FString DisplayName;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    TObjectPtr<AActor> Actor;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    bool bIsAI = false;

    /** Starting grid slot (1..6). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 GridPosition = 1;

    /** Live race standing (1 = leader). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 CurrentPosition = 1;

    /** Completed laps (0 .. TotalLaps). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 CompletedLaps = 0;

    /** Next checkpoint index the car must cross. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 NextCheckpointIndex = 0;

    /** Total progress distance along the route (cm), used for live ranking. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    float TotalDistanceCm = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    float LapStartTimeSec = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    float LastLapTimeSec = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    float BestLapTimeSec = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    float FinishTimeSec = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    bool bFinished = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    bool bDnf = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    FString DnfReason;

    /** True until car-to-car contact is reported or detected. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    bool bCleanRace = true;

    /** Number of forward position passes made during the race. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 OvertakesCount = 0;

    float UpsideDownTimerSec = 0.0f;
    float StuckTimerSec = 0.0f;
};

/** Post-race XP & Credits breakdown matching web/src/progression.ts raceReward(). */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridRaceReward
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 TotalXp = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 TotalCredits = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 PlacesGained = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    bool bCleanRace = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    bool bCopsEnabled = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    int32 HeatLevel = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Race")
    bool bEscapedCops = false;
};

/** Tactical Heat 0-5 police pursuit state (active ONLY in Race Events, never in Free Roam). */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridPursuitState
{
    GENERATED_BODY()

    /** True while police pursuit is actively engaged. Always false outside Race Events. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    bool bActive = false;

    /** True when the current event is a Race Event (OpenGrid rule: no cops in Free Roam). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    bool bIsRaceEvent = false;

    /** True if Cop Mode was toggled on for this race. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    bool bCopsEnabled = false;

    /** True if the route passes through a mandatory patrol district. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    bool bMandatoryPatrolDistrict = false;

    /** Wanted level (0..5). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    int32 HeatLevel = 0;

    /** 0..1 bust meter (reaches 1.0 when pinned at low speed by cruisers). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    float BustProgress = 0.0f;

    /** 0..1 cooldown escape meter (reaches 1.0 after breaking line-of-sight / distance). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    float EscapeProgress = 0.0f;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    bool bBusted = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    bool bEscaped = false;

    /** Recommended active cruiser count scaling with Heat 1..5 (0..4). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    int32 TargetCopUnits = 0;

    /** Seconds elapsed since the last heat-raising offence (drives automatic cooling). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Cops")
    float QuietTimeSec = 0.0f;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_FourParams(FOnOpenGridLapCompleted, FName, RacerId, int32, CompletedLap, float, LapTimeSec, float, BestLapTimeSec);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOnOpenGridRaceFinished, FName, RacerId, int32, FinalPosition, float, FinishTimeSec);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridHeatLevelChanged, int32, NewHeatLevel, int32, PreviousHeatLevel);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridOvertake, FName, PassingRacerId, int32, NewPosition);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnOpenGridPursuitEnded, bool, bEscaped);

/**
 * World subsystem coordinating 6-car street races, checkpoint/lap timing, AI rival registration,
 * clean-race & overtake tracking, and tactical Heat 0-5 police pursuit escalation.
 */
UCLASS()
class OPENGRID_API UOpenGridRaceSubsystem : public UTickableWorldSubsystem
{
    GENERATED_BODY()

public:
    static constexpr int32 MaxGridSize = 6;
    static constexpr int32 MaxHeatLevel = 5;

    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;
    virtual void Tick(float DeltaTime) override;
    virtual TStatId GetStatId() const override;
    virtual bool IsTickable() const override;

    // ---- Delegates --------------------------------------------------------------------------------------------------

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Race")
    FOnOpenGridLapCompleted OnLapCompleted;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Race")
    FOnOpenGridRaceFinished OnRaceFinished;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Cops")
    FOnOpenGridHeatLevelChanged OnHeatLevelChanged;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Race")
    FOnOpenGridOvertake OnOvertake;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Cops")
    FOnOpenGridPursuitEnded OnPursuitEnded;

    // ---- Race Setup & Lifecycle -------------------------------------------------------------------------------------

    /** Configure route checkpoints, total laps, and whether tactical police pursuits are active for this race event. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    void ConfigureRace(const TArray<FOpenGridCheckpoint>& InCheckpoints,
                       int32 InTotalLaps,
                       bool bInCopsEnabled = false,
                       bool bInMandatoryPatrolDistrict = false);

    /**
     * Register a player or AI rival (#Bot1..#Bot5) onto the 6-car grid.
     * Returns the assigned 1-based grid slot, or INDEX_NONE if the grid is full.
     */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    int32 RegisterRacer(FName RacerId, const FString& DisplayName, AActor* RacerActor,
                        bool bIsAI = false, int32 PreferredGridSlot = 0);

    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    bool UnregisterRacer(FName RacerId);

    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    void ClearRacers();

    /** Begin race countdown (0 = immediate green light). Activates pursuit rules if CopsEnabled or patrol district. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    void StartRace(float CountdownSeconds = 3.0f);

    /** Abort or conclude the active race and return to Free Roam (immediately disengages police pursuit). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    void StopRace();

    // ---- Live Race Events & Rules -----------------------------------------------------------------------------------

    /** Mark car-to-car contact between two racers (clears CleanRace flag and escalates heat if cops are enabled). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    void ReportCarContact(FName RacerIdA, FName RacerIdB);

    /** Rule a car out of the race (totaled, rolled over, stuck). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Race")
    void MarkRacerDnf(FName RacerId, const FString& Reason);

    /** Compute XP and multiplayer credits for a racer using the exact web/src/progression.ts formula. */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Race")
    FOpenGridRaceReward ComputeRaceReward(FName RacerId, bool bIsMultiplayer, int32 AssistsOffCount,
                                          bool bManualGearbox, bool bFullRealism) const;

    // ---- Tactical Police Pursuit & Heat 0-5 -------------------------------------------------------------------------

    /** Raise or lower heat by Delta (clamped 0..5). Resets quiet-time cooling timer on increase. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Cops")
    int32 AddHeat(int32 Delta = 1);

    /** Set Heat explicitly (0..5) and broadcast OnHeatLevelChanged when changed. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Cops")
    void SetHeatLevel(int32 NewHeatLevel);

    /** Clear Heat back to 0 (e.g. safehouse / pay to lay low). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Cops")
    void ClearHeat();

    /**
     * Feed closest police cruiser distance (cm) and player speed (km/h) to advance BustProgress / EscapeProgress.
     * No-op unless a Race Event pursuit is active.
     */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Cops")
    void UpdatePursuitProximity(float ClosestCopDistanceCm, float PlayerSpeedKmh, float DeltaTime);

    /** True only when inside a Race Event with Cop Mode enabled or in a mandatory patrol district. */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Cops")
    bool IsPursuitAllowed() const;

    // ---- Queries ----------------------------------------------------------------------------------------------------

    UFUNCTION(BlueprintPure, Category="OpenGrid|Race")
    EOpenGridRaceState GetRaceState() const { return RaceState_; }

    UFUNCTION(BlueprintPure, Category="OpenGrid|Race")
    float GetRaceElapsedTimeSec() const { return RaceElapsedSec_; }

    UFUNCTION(BlueprintPure, Category="OpenGrid|Race")
    float GetCountdownRemainingSec() const { return CountdownRemainingSec_; }

    UFUNCTION(BlueprintPure, Category="OpenGrid|Race")
    int32 GetTotalLaps() const { return TotalLaps_; }

    UFUNCTION(BlueprintPure, Category="OpenGrid|Race")
    TArray<FOpenGridRacerEntry> GetStandings() const;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Race")
    bool GetRacerProgress(FName RacerId, FOpenGridRacerEntry& OutEntry) const;

    UFUNCTION(BlueprintPure, Category="OpenGrid|Cops")
    int32 GetHeatLevel() const { return PursuitState_.HeatLevel; }

    UFUNCTION(BlueprintPure, Category="OpenGrid|Cops")
    FOpenGridPursuitState GetPursuitState() const { return PursuitState_; }

private:
    FOpenGridRacerEntry* FindRacer(FName RacerId);
    const FOpenGridRacerEntry* FindRacer(FName RacerId) const;
    void UpdateRacerCheckpoints(float DeltaTime);
    void DetectCarContacts();
    void RecomputeStandings();
    void TickHeatAndPursuit(float DeltaTime);
    int32 ComputeTargetCopUnits(int32 HeatLevel) const;

    EOpenGridRaceState RaceState_ = EOpenGridRaceState::Idle;
    int32 TotalLaps_ = 3;
    float CountdownRemainingSec_ = 0.0f;
    float RaceElapsedSec_ = 0.0f;
    float LapLengthCm_ = 0.0f;

    TArray<FOpenGridCheckpoint> Checkpoints_;

    UPROPERTY(Transient)
    TArray<FOpenGridRacerEntry> Racers_;

    FOpenGridPursuitState PursuitState_;
};
