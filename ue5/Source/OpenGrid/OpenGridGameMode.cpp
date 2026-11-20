// Apache-2.0 — see OpenGridGameMode.h
#include "OpenGridGameMode.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerStart.h"
#include "OpenGridCarPawn.h"

AOpenGridGameMode::AOpenGridGameMode()
{
    DefaultPawnClass = AOpenGridCarPawn::StaticClass();
}

void AOpenGridGameMode::StartPlay()
{
    UWorld* World = GetWorld();
    if (bSpawnTestGroundIfEmpty && World)
    {
        FVector Start = FVector::ZeroVector;
        for (TActorIterator<APlayerStart> It(World); It; ++It) { Start = It->GetActorLocation(); break; }

        // Static geometry only: the car may already be standing on the start point.
        FHitResult Hit;
        const bool bGround = World->LineTraceSingleByObjectType(Hit, Start + FVector(0, 0, 200), Start - FVector(0, 0, 10000),
                                                                FCollisionObjectQueryParams(ECC_WorldStatic));
        if (!bGround)
        {
            UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
            const FVector FloorCentre(Start.X, Start.Y, Start.Z - 150.0f - 50.0f);   // top face 1.5 m below the start
            if (AStaticMeshActor* Floor = World->SpawnActor<AStaticMeshActor>(FloorCentre, FRotator::ZeroRotator))
            {
                UStaticMeshComponent* M = Floor->GetStaticMeshComponent();
                M->SetMobility(EComponentMobility::Movable);
                M->SetStaticMesh(Cube);
                M->SetWorldScale3D(FVector(2000.0f, 2000.0f, 1.0f));   // 2 km x 2 km x 1 m
                M->SetCollisionProfileName(TEXT("BlockAll"));
            }
            bool bHasSun = false;
            for (TActorIterator<ADirectionalLight> It(World); It; ++It) { bHasSun = true; break; }
            if (!bHasSun)
            {
                if (ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 1000), FRotator(-35.0f, 30.0f, 0.0f)))
                {
                    Sun->GetLightComponent()->SetMobility(EComponentMobility::Movable);
                    Sun->GetLightComponent()->SetIntensity(8.0f);
                }
            }
            UE_LOG(LogTemp, Warning, TEXT("OpenGrid: no ground under the start point, spawned a test floor (File > New Level > Basic gives a proper one)"));
        }
    }
    Super::StartPlay();
}
