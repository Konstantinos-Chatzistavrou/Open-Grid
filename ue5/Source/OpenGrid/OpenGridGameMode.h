// Apache-2.0 — spawns the car; in an empty level, also a test floor and a sun so Play works on day one.
#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "OpenGridGameMode.generated.h"

UCLASS()
class OPENGRID_API AOpenGridGameMode : public AGameModeBase
{
    GENERATED_BODY()

public:
    AOpenGridGameMode();
    virtual void StartPlay() override;

    /** Spawn a 2 km test floor (and a sun if the level has none) when nothing is under the start point. */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category="OpenGrid")
    bool bSpawnTestGroundIfEmpty = true;
};
