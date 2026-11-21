// Apache-2.0 — GameInstance subsystem bridging UE 5.8 to the OpenGrid Cloudflare Worker backend (cloud/src/index.ts).
// Uses FHttpModule, FWebSocketsModule, and FJsonSerializer with Bearer <id>.<token> authentication.
#pragma once

#include "CoreMinimal.h"
#include "IWebSocket.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "OpenGridOnlineSubsystem.generated.h"

/** Online career profile mirrored from cloud/src/util.ts profileOf(). */
USTRUCT(BlueprintType)
struct OPENGRID_API FOpenGridOnlineProfile
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FString Id;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FString Name;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FString Username;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    int32 Xp = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    int32 Credits = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    int32 CleanRating = 100;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    int32 Strikes = 0;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    bool bBanned = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    int32 SaveVersion = 1;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    TArray<FString> OwnedCars;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    TArray<FString> OwnedSkins;

    /** Per-car saved customization JSON strings keyed by car ID (e.g. "kestrel_gt" -> "{...}"). */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    TMap<FString, FString> SavedLooksJson;

    /** Full raw JSON response from /v1/me for custom Blueprint parsing. */
    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FString RawProfileJson;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOnOpenGridAccountCreated, bool, bSuccess, const FString&, AccountId, const FString&, ErrorMessage);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOnOpenGridProfileReceived, bool, bSuccess, const FOpenGridOnlineProfile&, Profile, const FString&, ErrorMessage);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOnOpenGridLookSaved, bool, bSuccess, const FString&, CarId, const FString&, ErrorMessage);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_FourParams(FOnOpenGridPurchaseCompleted, bool, bSuccess, const FString&, ItemId, const FOpenGridOnlineProfile&, UpdatedProfile, const FString&, ErrorMessage);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridPresenceAck, bool, bSuccess, const FString&, ErrorMessage);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridRoomConnected, bool, bSuccess, const FString&, PartyCode);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridRoomMessage, const FString&, MessageType, const FString&, RawJson);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnOpenGridRoomClosed, int32, StatusCode, const FString&, Reason);

/**
 * Online REST + WebSocket client for the OpenGrid Cloudflare Worker service.
 * Configure ApiBaseUrl in ue5/Config/DefaultGame.ini under [/Script/OpenGrid.OpenGridOnlineSubsystem].
 */
UCLASS(Config=Game)
class OPENGRID_API UOpenGridOnlineSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    /** Base URL of the Cloudflare Worker backend (no trailing slash), configurable in DefaultGame.ini. */
    UPROPERTY(Config, EditAnywhere, BlueprintReadWrite, Category="OpenGrid|Online")
    FString ApiBaseUrl = TEXT("https://api.opengrid.invalid");

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FString AccountId;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FString AuthToken;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FString ActivePartyCode;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    bool bRaceRoomConnected = false;

    UPROPERTY(BlueprintReadOnly, Category="OpenGrid|Online")
    FOpenGridOnlineProfile CachedProfile;

    // ---- Delegates --------------------------------------------------------------------------------------------------

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridAccountCreated OnAccountCreated;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridProfileReceived OnProfileReceived;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridLookSaved OnLookSaved;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridPurchaseCompleted OnPurchaseCompleted;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridPresenceAck OnPresenceAck;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridRoomConnected OnRoomConnected;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridRoomMessage OnRoomMessage;

    UPROPERTY(BlueprintAssignable, Category="OpenGrid|Online")
    FOnOpenGridRoomClosed OnRoomClosed;

    // ---- Auth & REST API --------------------------------------------------------------------------------------------

    /** Supply previously persisted account credentials (used for Bearer <id>.<token> auth). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void SetCredentials(const FString& InAccountId, const FString& InAuthToken);

    UFUNCTION(BlueprintPure, Category="OpenGrid|Online")
    bool HasCredentials() const { return !AccountId.IsEmpty() && !AuthToken.IsEmpty(); }

    /** Format "Bearer <id>.<token>" matching cloud/src/util.ts accountOf(). */
    UFUNCTION(BlueprintPure, Category="OpenGrid|Online")
    FString GetBearerHeaderValue() const;

    /** POST /v1/account -> creates an anonymous account and caches AccountId + AuthToken. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void CreateAccount();

    /** GET /v1/me -> fetches the online career profile (requires credentials). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void FetchProfile();

    /** POST /v1/look { car, look } -> validates and stores one car's customization JSON. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void SaveCarLook(const FString& CarId, const FString& LookJson);

    /** POST /v1/buy { kind, id, stage } -> purchases a car, upgrade stage (1..3), or driver skin. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void BuyItem(const FString& Kind, const FString& Id, int32 Stage = 0);

    /** POST /v1/presence { party } -> sends online heartbeat and optional 4-10 char party code. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void SendPresence(const FString& PartyCode);

    // ---- Durable Object Race Room WebSocket -------------------------------------------------------------------------

    /** Connect WebSocket to GET /v1/room/:party for authoritative multiplayer race timing & rewards. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void ConnectRaceRoom(const FString& PartyCode);

    /** Gracefully disconnect the active race room WebSocket. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    void DisconnectRaceRoom();

    /** Send a raw JSON payload over the active race room WebSocket. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    bool SendRoomJson(const FString& JsonPayload);

    /** Send a room `join` message declaring car, assists, manual gearbox, and host flag. */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    bool SendRoomJoin(const FString& CarId, int32 AssistsOff, bool bManual, bool bHost);

    /** Stream live car position (UE cm converted to room coordinates) and speed (m/s) to the race room (~4 Hz). */
    UFUNCTION(BlueprintCallable, Category="OpenGrid|Online")
    bool SendRoomPosition(const FVector& WorldLocationCm, float SpeedMetersPerSec);

private:
    FString BuildUrl(const FString& Path) const;
    FString BuildWebSocketUrl(const FString& PathWithQuery) const;
    static FString ExtractErrorMessage(const FString& ResponseBody, int32 StatusCode);
    static bool ParseProfileJson(const FString& JsonBody, FOpenGridOnlineProfile& OutProfile);
    static FString SerializeJsonObject(const TSharedRef<class FJsonObject>& JsonObj);

    TSharedPtr<IWebSocket> RaceRoomSocket_;
};
