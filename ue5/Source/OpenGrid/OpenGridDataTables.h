// Apache-2.0 — OpenGrid UE 5.8 UDataTable row structs matching data/ue5/car_catalog_dt.csv
// and data/ue5/parts_catalog_dt.csv (imported by tools/ue5/ue5_import_all.py as
// /Script/OpenGrid.OpenGridCarCatalogRow and /Script/OpenGrid.OpenGridPartCatalogRow).
#pragma once

#include "CoreMinimal.h"
#include "Engine/DataTable.h"
#include "OpenGridDataTables.generated.h"

/**
 * Row struct for DT_CarCatalog (/Game/OpenGrid/Data/DT_CarCatalog).
 * Generated from data/cars/catalog.json and data/cars/<id>.json by
 * tools/ue5/generate_ue5_datatables.mjs.
 */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridCarCatalogRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	FName Name = NAME_None;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	FString DisplayName;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	FString Brand;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	FString Tag;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	FString PaintHex = TEXT("#ffffff");

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	int32 Price = 0;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	int32 SpLevel = 1;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	int32 MpLevel = 1;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	float VmaxKmh = 300.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	FString EngineVoice = TEXT("v8_crossplane");

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Catalog")
	FString EngineLabel;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	float MassKg = 1400.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	float PeakPowerKw = 350.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	FString Drivetrain = TEXT("RWD");

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	FString Transmission = TEXT("manual");

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	FString BrakeDiscType = TEXT("iron");

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	float BrakeMigrationFront = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	float HeaveSpringFrontNPerM = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	float HeaveSpringRearNPerM = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Physics")
	bool HasAeroMap2D = false;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Assets")
	FString PhysicsJsonPath;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Assets")
	FString VisualJsonPath;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Assets")
	FString BodyMeshAsset;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Assets")
	bool HasStockWing = false;
};

/**
 * Row struct for DT_PartsCatalog (/Game/OpenGrid/Data/DT_PartsCatalog).
 * Generated from web/src/parts-names.ts and web/src/parts-metrics.ts by
 * tools/ue5/generate_ue5_datatables.mjs.
 */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridPartCatalogRow : public FTableRowBase
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Parts")
	FName PartId = NAME_None;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Parts")
	FString DisplayName;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Parts")
	FString Category;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Parts")
	float Downforce = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Parts")
	float Drag = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Parts")
	float MassKg = 0.0f;

	UPROPERTY(EditAnywhere, BlueprintReadOnly, Category = "OpenGrid|Parts")
	FName SocketName = TEXT("Root");
};
