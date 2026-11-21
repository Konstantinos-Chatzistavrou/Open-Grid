// Apache-2.0 — see OpenGridRaceSubsystem.h
#include "OpenGridRaceSubsystem.h"

#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Stats/Stats.h"

DEFINE_LOG_CATEGORY_STATIC(LogOpenGridRace, Log, All);

namespace
{
// Quiet time (seconds) before Heat cools down by 1 level (mirrors web/src/heat.ts COOL_MS).
constexpr float kHeatCoolSeconds[6] = {0.0f, 90.0f, 75.0f, 60.0f, 45.0f, 30.0f};

// Mirrors web/src/progression.ts XP_BY_POS and CR_BY_POS.
constexpr int32 kXpByPos[8] = {1500, 1200, 1000, 850, 720, 600, 520, 460};
constexpr int32 kCrByPos[8] = {20000, 14000, 10000, 7500, 5500, 4000, 3000, 2500};

float LapFactor(int32 Laps)
{
    switch (Laps)
    {
        case 1:  return 1.0f;
        case 3:  return 2.4f;
        case 5:  return 3.6f;
        case 10: return 6.5f;
        default: return FMath::Max(1.0f, static_cast<float>(Laps) * 0.65f);
    }
}

// Minimum centre-to-centre distance (cm) for automatic car-to-car contact detection (2.4 m, matching cloud/src/room.ts).
constexpr float kContactThresholdCm = 240.0f;
constexpr float kRolloverDnfSeconds = 5.0f;
constexpr float kStuckDnfSeconds = 30.0f;
constexpr float kStuckSpeedCmPerSec = 50.0f;  // 0.5 m/s
}  // namespace

void UOpenGridRaceSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
    RaceState_ = EOpenGridRaceState::Idle;
    PursuitState_ = FOpenGridPursuitState{};
}

void UOpenGridRaceSubsystem::Deinitialize()
{
    Racers_.Reset();
    Checkpoints_.Reset();
    PursuitState_ = FOpenGridPursuitState{};
    RaceState_ = EOpenGridRaceState::Idle;
    Super::Deinitialize();
}

TStatId UOpenGridRaceSubsystem::GetStatId() const
{
    RETURN_QUICK_DECLARE_CYCLE_STAT(UOpenGridRaceSubsystem, STATGROUP_Tickables);
}

bool UOpenGridRaceSubsystem::IsTickable() const
{
    const UWorld* World = GetWorld();
    return !IsTemplate() && World != nullptr && World->IsGameWorld();
}

void UOpenGridRaceSubsystem::ConfigureRace(const TArray<FOpenGridCheckpoint>& InCheckpoints,
                                           int32 InTotalLaps,
                                           bool bInCopsEnabled,
                                           bool bInMandatoryPatrolDistrict)
{
    Checkpoints_ = InCheckpoints;
    TotalLaps_ = FMath::Max(1, InTotalLaps);
    LapLengthCm_ = 0.0f;

    for (int32 i = 0; i < Checkpoints_.Num(); ++i)
    {
        Checkpoints_[i].RadiusCm = FMath::Max(100.0f, Checkpoints_[i].RadiusCm);
        if (i == 0)
        {
            Checkpoints_[i].CumulativeDistanceCm = 0.0f;
        }
        else
        {
            const float SegDist = FVector::Dist(Checkpoints_[i - 1].Location, Checkpoints_[i].Location);
            LapLengthCm_ += SegDist;
            Checkpoints_[i].CumulativeDistanceCm = LapLengthCm_;
            if (Checkpoints_[i - 1].Forward.IsNearlyZero())
            {
                Checkpoints_[i - 1].Forward = (Checkpoints_[i].Location - Checkpoints_[i - 1].Location).GetSafeNormal();
            }
        }
    }
    if (Checkpoints_.Num() >= 2)
    {
        LapLengthCm_ += FVector::Dist(Checkpoints_.Last().Location, Checkpoints_[0].Location);
        if (Checkpoints_.Last().Forward.IsNearlyZero())
        {
            Checkpoints_.Last().Forward = (Checkpoints_[0].Location - Checkpoints_.Last().Location).GetSafeNormal();
        }
    }

    PursuitState_.bCopsEnabled = bInCopsEnabled;
    PursuitState_.bMandatoryPatrolDistrict = bInMandatoryPatrolDistrict;
}

int32 UOpenGridRaceSubsystem::RegisterRacer(FName RacerId, const FString& DisplayName, AActor* RacerActor,
                                            bool bIsAI, int32 PreferredGridSlot)
{
    if (RacerId.IsNone()) return INDEX_NONE;

    if (FOpenGridRacerEntry* Existing = FindRacer(RacerId))
    {
        Existing->DisplayName = DisplayName.IsEmpty() ? RacerId.ToString() : DisplayName;
        Existing->Actor = RacerActor;
        Existing->bIsAI = bIsAI;
        return Existing->GridPosition;
    }

    if (Racers_.Num() >= MaxGridSize)
    {
        UE_LOG(LogOpenGridRace, Warning, TEXT("RegisterRacer(%s): 6-car grid is already full"), *RacerId.ToString());
        return INDEX_NONE;
    }

    int32 AssignedSlot = 0;
    if (PreferredGridSlot >= 1 && PreferredGridSlot <= MaxGridSize)
    {
        bool bTaken = false;
        for (const FOpenGridRacerEntry& E : Racers_)
        {
            if (E.GridPosition == PreferredGridSlot) { bTaken = true; break; }
        }
        if (!bTaken) AssignedSlot = PreferredGridSlot;
    }
    if (AssignedSlot == 0)
    {
        for (int32 Slot = 1; Slot <= MaxGridSize; ++Slot)
        {
            bool bTaken = false;
            for (const FOpenGridRacerEntry& E : Racers_)
            {
                if (E.GridPosition == Slot) { bTaken = true; break; }
            }
            if (!bTaken) { AssignedSlot = Slot; break; }
        }
    }

    FOpenGridRacerEntry Entry;
    Entry.RacerId = RacerId;
    Entry.DisplayName = DisplayName.IsEmpty() ? RacerId.ToString() : DisplayName;
    Entry.Actor = RacerActor;
    Entry.bIsAI = bIsAI;
    Entry.GridPosition = AssignedSlot;
    Entry.CurrentPosition = AssignedSlot;
    Racers_.Add(Entry);
    return AssignedSlot;
}

bool UOpenGridRaceSubsystem::UnregisterRacer(FName RacerId)
{
    const int32 Removed = Racers_.RemoveAll([RacerId](const FOpenGridRacerEntry& E) { return E.RacerId == RacerId; });
    if (Removed > 0)
    {
        RecomputeStandings();
        return true;
    }
    return false;
}

void UOpenGridRaceSubsystem::ClearRacers()
{
    Racers_.Reset();
}

void UOpenGridRaceSubsystem::StartRace(float CountdownSeconds)
{
    if (Checkpoints_.Num() < 2)
    {
        UE_LOG(LogOpenGridRace, Warning, TEXT("StartRace: at least 2 checkpoints are required"));
        return;
    }

    RaceElapsedSec_ = 0.0f;
    CountdownRemainingSec_ = FMath::Max(0.0f, CountdownSeconds);
    RaceState_ = (CountdownRemainingSec_ > 0.0f) ? EOpenGridRaceState::Countdown : EOpenGridRaceState::Racing;

    for (FOpenGridRacerEntry& R : Racers_)
    {
        R.CurrentPosition = R.GridPosition;
        R.CompletedLaps = 0;
        R.NextCheckpointIndex = 1 % Checkpoints_.Num();
        R.TotalDistanceCm = 0.0f;
        R.LapStartTimeSec = 0.0f;
        R.LastLapTimeSec = 0.0f;
        R.BestLapTimeSec = 0.0f;
        R.FinishTimeSec = 0.0f;
        R.bFinished = false;
        R.bDnf = false;
        R.DnfReason.Reset();
        R.bCleanRace = true;
        R.OvertakesCount = 0;
        R.UpsideDownTimerSec = 0.0f;
        R.StuckTimerSec = 0.0f;
    }

    PursuitState_.bIsRaceEvent = true;
    PursuitState_.bBusted = false;
    PursuitState_.bEscaped = false;
    PursuitState_.BustProgress = 0.0f;
    PursuitState_.EscapeProgress = 0.0f;
    PursuitState_.QuietTimeSec = 0.0f;
    PursuitState_.bActive = IsPursuitAllowed();
    if (PursuitState_.bActive && PursuitState_.HeatLevel == 0)
    {
        SetHeatLevel(1);
    }
    PursuitState_.TargetCopUnits = PursuitState_.bActive ? ComputeTargetCopUnits(PursuitState_.HeatLevel) : 0;
}

void UOpenGridRaceSubsystem::StopRace()
{
    RaceState_ = EOpenGridRaceState::Idle;
    CountdownRemainingSec_ = 0.0f;
    // OpenGrid rule: returning to Free Roam immediately disables police pursuit.
    PursuitState_.bIsRaceEvent = false;
    PursuitState_.bActive = false;
    PursuitState_.BustProgress = 0.0f;
    PursuitState_.EscapeProgress = 0.0f;
    PursuitState_.TargetCopUnits = 0;
}

void UOpenGridRaceSubsystem::ReportCarContact(FName RacerIdA, FName RacerIdB)
{
    FOpenGridRacerEntry* A = FindRacer(RacerIdA);
    FOpenGridRacerEntry* B = FindRacer(RacerIdB);
    if (A) A->bCleanRace = false;
    if (B) B->bCleanRace = false;

    if (PursuitState_.bActive)
    {
        PursuitState_.QuietTimeSec = 0.0f;
    }
}

void UOpenGridRaceSubsystem::MarkRacerDnf(FName RacerId, const FString& Reason)
{
    FOpenGridRacerEntry* R = FindRacer(RacerId);
    if (!R || R->bFinished || R->bDnf) return;

    R->bDnf = true;
    R->DnfReason = Reason.IsEmpty() ? TEXT("out") : Reason;
    RecomputeStandings();
}

FOpenGridRaceReward UOpenGridRaceSubsystem::ComputeRaceReward(FName RacerId, bool bIsMultiplayer, int32 AssistsOffCount,
                                                              bool bManualGearbox, bool bFullRealism) const
{
    FOpenGridRaceReward Reward;
    const FOpenGridRacerEntry* R = FindRacer(RacerId);
    if (!R || R->bDnf || !R->bFinished) return Reward;

    const float Factor = LapFactor(TotalLaps_);
    const int32 PosIdx = FMath::Clamp(R->CurrentPosition - 1, 0, 7);
    const int32 BaseXp = FMath::RoundToInt(static_cast<float>(kXpByPos[PosIdx]) * Factor);

    int32 SumXp = BaseXp;
    const int32 PlacesGained = FMath::Max(0, R->GridPosition - R->CurrentPosition);
    if (PlacesGained > 0)
    {
        SumXp += FMath::RoundToInt(static_cast<float>(PlacesGained) * 80.0f * Factor);
    }
    if (R->bCleanRace)
    {
        SumXp += FMath::RoundToInt(static_cast<float>(BaseXp) * 0.20f);
    }

    const int32 ClampedAssistsOff = FMath::Clamp(AssistsOffCount, 0, 5);
    const float DriverMult = ClampedAssistsOff * 0.05f + (bManualGearbox ? 0.10f : 0.0f) + (bFullRealism ? 0.10f : 0.0f);
    if (DriverMult > 0.0f)
    {
        SumXp += FMath::RoundToInt(static_cast<float>(SumXp) * DriverMult);
    }

    float CrMult = 1.0f;
    const bool bCopRace = PursuitState_.bCopsEnabled || PursuitState_.bMandatoryPatrolDistrict;
    if (bCopRace)
    {
        const int32 Heat = FMath::Clamp(PursuitState_.HeatLevel, 0, MaxHeatLevel);
        const float CopBonus = 0.50f + Heat * 0.15f + (PursuitState_.bEscaped ? 0.25f : 0.0f);
        SumXp += FMath::RoundToInt(static_cast<float>(SumXp) * CopBonus);
        CrMult = 1.0f + CopBonus;
    }

    Reward.TotalXp = SumXp;
    Reward.TotalCredits = bIsMultiplayer
                              ? FMath::RoundToInt(static_cast<float>(kCrByPos[PosIdx]) * Factor * CrMult)
                              : 0;
    Reward.PlacesGained = PlacesGained;
    Reward.bCleanRace = R->bCleanRace;
    Reward.bCopsEnabled = bCopRace;
    Reward.HeatLevel = PursuitState_.HeatLevel;
    Reward.bEscapedCops = PursuitState_.bEscaped;
    return Reward;
}

bool UOpenGridRaceSubsystem::IsPursuitAllowed() const
{
    return PursuitState_.bIsRaceEvent && (PursuitState_.bCopsEnabled || PursuitState_.bMandatoryPatrolDistrict);
}

int32 UOpenGridRaceSubsystem::ComputeTargetCopUnits(int32 HeatLevel) const
{
    if (HeatLevel <= 0) return 0;
    if (HeatLevel == 1) return 1;
    if (HeatLevel <= 3) return 2;
    if (HeatLevel == 4) return 3;
    return 4;
}

int32 UOpenGridRaceSubsystem::AddHeat(int32 Delta)
{
    const int32 Target = FMath::Clamp(PursuitState_.HeatLevel + Delta, 0, MaxHeatLevel);
    if (Delta > 0)
    {
        PursuitState_.QuietTimeSec = 0.0f;
    }
    SetHeatLevel(Target);
    return PursuitState_.HeatLevel;
}

void UOpenGridRaceSubsystem::SetHeatLevel(int32 NewHeatLevel)
{
    const int32 Clamped = FMath::Clamp(NewHeatLevel, 0, MaxHeatLevel);
    const int32 Prev = PursuitState_.HeatLevel;
    if (Clamped == Prev) return;

    PursuitState_.HeatLevel = Clamped;
    PursuitState_.QuietTimeSec = 0.0f;
    PursuitState_.TargetCopUnits = PursuitState_.bActive ? ComputeTargetCopUnits(Clamped) : 0;
    OnHeatLevelChanged.Broadcast(Clamped, Prev);
}

void UOpenGridRaceSubsystem::ClearHeat()
{
    SetHeatLevel(0);
    PursuitState_.BustProgress = 0.0f;
    PursuitState_.EscapeProgress = 0.0f;
    PursuitState_.bBusted = false;
    PursuitState_.bEscaped = false;
}

void UOpenGridRaceSubsystem::UpdatePursuitProximity(float ClosestCopDistanceCm, float PlayerSpeedKmh, float DeltaTime)
{
    if (!PursuitState_.bActive || PursuitState_.bBusted || PursuitState_.bEscaped || DeltaTime <= 0.0f) return;

    // Pinned near cruiser at low speed (< 18 km/h and within 12 m) builds bust progress over ~4.5 seconds.
    if (ClosestCopDistanceCm <= 1200.0f && PlayerSpeedKmh < 18.0f)
    {
        PursuitState_.QuietTimeSec = 0.0f;
        PursuitState_.EscapeProgress = FMath::Max(0.0f, PursuitState_.EscapeProgress - DeltaTime * 0.5f);
        PursuitState_.BustProgress = FMath::Clamp(PursuitState_.BustProgress + DeltaTime / 4.5f, 0.0f, 1.0f);
        if (PursuitState_.BustProgress >= 1.0f)
        {
            PursuitState_.bBusted = true;
            PursuitState_.bActive = false;
            PursuitState_.TargetCopUnits = 0;
            OnPursuitEnded.Broadcast(false);
        }
        return;
    }

    PursuitState_.BustProgress = FMath::Max(0.0f, PursuitState_.BustProgress - DeltaTime * 0.35f);

    // Breaking away beyond 220 m builds escape meter (scales with Heat level).
    const float EscapeDistCm = 18000.0f + PursuitState_.HeatLevel * 2000.0f;
    if (ClosestCopDistanceCm >= EscapeDistCm)
    {
        const float EscapeDurationSec = 6.0f + PursuitState_.HeatLevel * 1.5f;
        PursuitState_.EscapeProgress = FMath::Clamp(PursuitState_.EscapeProgress + DeltaTime / EscapeDurationSec, 0.0f, 1.0f);
        if (PursuitState_.EscapeProgress >= 1.0f)
        {
            PursuitState_.bEscaped = true;
            PursuitState_.bActive = false;
            PursuitState_.TargetCopUnits = 0;
            OnPursuitEnded.Broadcast(true);
        }
    }
    else
    {
        PursuitState_.QuietTimeSec = 0.0f;
        PursuitState_.EscapeProgress = FMath::Max(0.0f, PursuitState_.EscapeProgress - DeltaTime * 0.30f);
    }
}

FOpenGridRacerEntry* UOpenGridRaceSubsystem::FindRacer(FName RacerId)
{
    for (FOpenGridRacerEntry& R : Racers_)
    {
        if (R.RacerId == RacerId) return &R;
    }
    return nullptr;
}

const FOpenGridRacerEntry* UOpenGridRaceSubsystem::FindRacer(FName RacerId) const
{
    for (const FOpenGridRacerEntry& R : Racers_)
    {
        if (R.RacerId == RacerId) return &R;
    }
    return nullptr;
}

TArray<FOpenGridRacerEntry> UOpenGridRaceSubsystem::GetStandings() const
{
    TArray<FOpenGridRacerEntry> Sorted = Racers_;
    Sorted.Sort([](const FOpenGridRacerEntry& A, const FOpenGridRacerEntry& B)
    {
        return A.CurrentPosition < B.CurrentPosition;
    });
    return Sorted;
}

bool UOpenGridRaceSubsystem::GetRacerProgress(FName RacerId, FOpenGridRacerEntry& OutEntry) const
{
    if (const FOpenGridRacerEntry* Found = FindRacer(RacerId))
    {
        OutEntry = *Found;
        return true;
    }
    return false;
}

void UOpenGridRaceSubsystem::UpdateRacerCheckpoints(float DeltaTime)
{
    const int32 NumCP = Checkpoints_.Num();
    if (NumCP < 2) return;

    bool bAllDone = Racers_.Num() > 0;
    for (FOpenGridRacerEntry& R : Racers_)
    {
        if (R.bFinished || R.bDnf) continue;
        bAllDone = false;

        AActor* Actor = R.Actor.Get();
        if (!IsValid(Actor)) continue;

        const FVector Pos = Actor->GetActorLocation();
        const float SpeedCmS = Actor->GetVelocity().Size();
        const bool bUpsideDown = Actor->GetActorUpVector().Z < -0.35;

        if (bUpsideDown)
        {
            R.UpsideDownTimerSec += DeltaTime;
            if (R.UpsideDownTimerSec >= kRolloverDnfSeconds)
            {
                MarkRacerDnf(R.RacerId, TEXT("rolled over"));
                continue;
            }
        }
        else
        {
            R.UpsideDownTimerSec = 0.0f;
        }

        if (SpeedCmS < kStuckSpeedCmPerSec)
        {
            R.StuckTimerSec += DeltaTime;
            if (R.StuckTimerSec >= kStuckDnfSeconds)
            {
                MarkRacerDnf(R.RacerId, TEXT("stuck"));
                continue;
            }
        }
        else
        {
            R.StuckTimerSec = 0.0f;
        }

        const int32 TargetIdx = FMath::Clamp(R.NextCheckpointIndex, 0, NumCP - 1);
        const FOpenGridCheckpoint& TargetCP = Checkpoints_[TargetIdx];
        const float DistToTarget = FVector::Dist2D(Pos, TargetCP.Location);

        if (DistToTarget <= TargetCP.RadiusCm)
        {
            if (TargetIdx == 0)
            {
                // Crossed Start/Finish line after completing all intermediate checkpoints.
                R.CompletedLaps++;
                const float LapTime = RaceElapsedSec_ - R.LapStartTimeSec;
                R.LastLapTimeSec = LapTime;
                if (R.BestLapTimeSec <= 0.0f || LapTime < R.BestLapTimeSec)
                {
                    R.BestLapTimeSec = LapTime;
                }
                R.LapStartTimeSec = RaceElapsedSec_;

                OnLapCompleted.Broadcast(R.RacerId, R.CompletedLaps, R.LastLapTimeSec, R.BestLapTimeSec);

                if (PursuitState_.bActive && !R.bIsAI)
                {
                    // Escalate tactical pursuit heat on lap completion during Cop Mode races.
                    AddHeat(1);
                }

                if (R.CompletedLaps >= TotalLaps_)
                {
                    R.bFinished = true;
                    R.FinishTimeSec = RaceElapsedSec_;
                    R.TotalDistanceCm = LapLengthCm_ * static_cast<float>(TotalLaps_);
                    RecomputeStandings();
                    OnRaceFinished.Broadcast(R.RacerId, R.CurrentPosition, R.FinishTimeSec);
                    continue;
                }
            }
            R.NextCheckpointIndex = (TargetIdx + 1) % NumCP;
        }

        // Compute continuous route progress for smooth live rankings.
        const int32 PrevIdx = (R.NextCheckpointIndex - 1 + NumCP) % NumCP;
        const FOpenGridCheckpoint& PrevCP = Checkpoints_[PrevIdx];
        const FOpenGridCheckpoint& NextCP = Checkpoints_[R.NextCheckpointIndex];
        const float SegLen = FMath::Max(1.0f, FVector::Dist2D(PrevCP.Location, NextCP.Location));
        const float DistToNext = FVector::Dist2D(Pos, NextCP.Location);
        const float SegProgress = FMath::Clamp(SegLen - DistToNext, 0.0f, SegLen);
        const float BaseLapDist = PrevCP.CumulativeDistanceCm;

        R.TotalDistanceCm = static_cast<float>(R.CompletedLaps) * LapLengthCm_ + BaseLapDist + SegProgress;
    }

    if (bAllDone && RaceState_ == EOpenGridRaceState::Racing)
    {
        RaceState_ = EOpenGridRaceState::Finished;
        PursuitState_.bActive = false;
        PursuitState_.TargetCopUnits = 0;
    }
}

void UOpenGridRaceSubsystem::DetectCarContacts()
{
    const int32 Count = Racers_.Num();
    const float ThreshSq = kContactThresholdCm * kContactThresholdCm;
    for (int32 i = 0; i < Count; ++i)
    {
        if (Racers_[i].bFinished || Racers_[i].bDnf) continue;
        AActor* ActorA = Racers_[i].Actor.Get();
        if (!IsValid(ActorA)) continue;

        for (int32 j = i + 1; j < Count; ++j)
        {
            if (Racers_[j].bFinished || Racers_[j].bDnf) continue;
            AActor* ActorB = Racers_[j].Actor.Get();
            if (!IsValid(ActorB)) continue;

            if (FVector::DistSquared(ActorA->GetActorLocation(), ActorB->GetActorLocation()) < ThreshSq)
            {
                ReportCarContact(Racers_[i].RacerId, Racers_[j].RacerId);
            }
        }
    }
}

void UOpenGridRaceSubsystem::RecomputeStandings()
{
    TArray<int32> Order;
    Order.Reserve(Racers_.Num());
    for (int32 i = 0; i < Racers_.Num(); ++i) Order.Add(i);

    Order.Sort([this](int32 IdxA, int32 IdxB)
    {
        const FOpenGridRacerEntry& A = Racers_[IdxA];
        const FOpenGridRacerEntry& B = Racers_[IdxB];
        if (A.bDnf != B.bDnf) return !A.bDnf;
        if (A.bFinished != B.bFinished) return A.bFinished;
        if (A.bFinished && B.bFinished) return A.FinishTimeSec < B.FinishTimeSec;
        if (!FMath::IsNearlyEqual(A.TotalDistanceCm, B.TotalDistanceCm))
        {
            return A.TotalDistanceCm > B.TotalDistanceCm;
        }
        return A.GridPosition < B.GridPosition;
    });

    for (int32 Rank = 0; Rank < Order.Num(); ++Rank)
    {
        FOpenGridRacerEntry& R = Racers_[Order[Rank]];
        const int32 NewPos = Rank + 1;
        if (RaceState_ == EOpenGridRaceState::Racing && NewPos < R.CurrentPosition && !R.bDnf)
        {
            R.OvertakesCount += (R.CurrentPosition - NewPos);
            OnOvertake.Broadcast(R.RacerId, NewPos);
        }
        R.CurrentPosition = NewPos;
    }
}

void UOpenGridRaceSubsystem::TickHeatAndPursuit(float DeltaTime)
{
    if (PursuitState_.HeatLevel <= 0) return;

    // Outside an active pursuit (or during quiet driving), heat cools one tier per kHeatCoolSeconds window.
    PursuitState_.QuietTimeSec += DeltaTime;
    const float CoolWindow = kHeatCoolSeconds[FMath::Clamp(PursuitState_.HeatLevel, 0, MaxHeatLevel)];
    if (CoolWindow > 0.0f && PursuitState_.QuietTimeSec >= CoolWindow)
    {
        SetHeatLevel(PursuitState_.HeatLevel - 1);
    }
}

void UOpenGridRaceSubsystem::Tick(float DeltaTime)
{
    if (DeltaTime <= 0.0f) return;

    if (RaceState_ == EOpenGridRaceState::Countdown)
    {
        CountdownRemainingSec_ = FMath::Max(0.0f, CountdownRemainingSec_ - DeltaTime);
        if (CountdownRemainingSec_ <= 0.0f)
        {
            RaceState_ = EOpenGridRaceState::Racing;
        }
    }
    else if (RaceState_ == EOpenGridRaceState::Racing)
    {
        RaceElapsedSec_ += DeltaTime;
        UpdateRacerCheckpoints(DeltaTime);
        DetectCarContacts();
        RecomputeStandings();
    }

    TickHeatAndPursuit(DeltaTime);
}
