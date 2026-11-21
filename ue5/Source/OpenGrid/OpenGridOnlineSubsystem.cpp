// Apache-2.0 — see OpenGridOnlineSubsystem.h
#include "OpenGridOnlineSubsystem.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Modules/ModuleManager.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WebSocketsModule.h"

DEFINE_LOG_CATEGORY_STATIC(LogOpenGridOnline, Log, All);

void UOpenGridOnlineSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
    bRaceRoomConnected = false;
}

void UOpenGridOnlineSubsystem::Deinitialize()
{
    DisconnectRaceRoom();
    Super::Deinitialize();
}

void UOpenGridOnlineSubsystem::SetCredentials(const FString& InAccountId, const FString& InAuthToken)
{
    AccountId = InAccountId.TrimStartAndEnd();
    AuthToken = InAuthToken.TrimStartAndEnd();
}

FString UOpenGridOnlineSubsystem::GetBearerHeaderValue() const
{
    if (!HasCredentials()) return FString();
    return FString::Printf(TEXT("Bearer %s.%s"), *AccountId, *AuthToken);
}

FString UOpenGridOnlineSubsystem::BuildUrl(const FString& Path) const
{
    FString Base = ApiBaseUrl.TrimStartAndEnd();
    while (Base.EndsWith(TEXT("/")))
    {
        Base.LeftChopInline(1);
    }
    return Base + Path;
}

FString UOpenGridOnlineSubsystem::BuildWebSocketUrl(const FString& PathWithQuery) const
{
    FString Base = BuildUrl(PathWithQuery);
    if (Base.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase))
    {
        return TEXT("wss://") + Base.Mid(8);
    }
    if (Base.StartsWith(TEXT("http://"), ESearchCase::IgnoreCase))
    {
        return TEXT("ws://") + Base.Mid(7);
    }
    return Base;
}

FString UOpenGridOnlineSubsystem::SerializeJsonObject(const TSharedRef<FJsonObject>& JsonObj)
{
    FString Out;
    const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
    FJsonSerializer::Serialize(JsonObj, Writer);
    return Out;
}

FString UOpenGridOnlineSubsystem::ExtractErrorMessage(const FString& ResponseBody, int32 StatusCode)
{
    TSharedPtr<FJsonObject> Obj;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseBody);
    if (FJsonSerializer::Deserialize(Reader, Obj) && Obj.IsValid())
    {
        FString Err;
        if (Obj->TryGetStringField(TEXT("error"), Err) && !Err.IsEmpty())
        {
            return Err;
        }
    }
    return FString::Printf(TEXT("HTTP %d"), StatusCode);
}

bool UOpenGridOnlineSubsystem::ParseProfileJson(const FString& JsonBody, FOpenGridOnlineProfile& OutProfile)
{
    TSharedPtr<FJsonObject> Obj;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonBody);
    if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
    {
        return false;
    }

    FOpenGridOnlineProfile Profile;
    Profile.RawProfileJson = JsonBody;
    Obj->TryGetStringField(TEXT("id"), Profile.Id);
    Obj->TryGetStringField(TEXT("name"), Profile.Name);
    Obj->TryGetStringField(TEXT("username"), Profile.Username);
    Obj->TryGetNumberField(TEXT("xp"), Profile.Xp);
    Obj->TryGetNumberField(TEXT("credits"), Profile.Credits);
    Obj->TryGetNumberField(TEXT("clean"), Profile.CleanRating);
    Obj->TryGetNumberField(TEXT("strikes"), Profile.Strikes);
    Obj->TryGetBoolField(TEXT("banned"), Profile.bBanned);
    Obj->TryGetNumberField(TEXT("saveVersion"), Profile.SaveVersion);

    const TArray<TSharedPtr<FJsonValue>>* CarsArr = nullptr;
    if (Obj->TryGetArrayField(TEXT("cars"), CarsArr) && CarsArr)
    {
        for (const TSharedPtr<FJsonValue>& Val : *CarsArr)
        {
            FString CarId;
            if (Val.IsValid() && Val->TryGetString(CarId))
            {
                Profile.OwnedCars.Add(CarId);
            }
        }
    }

    const TArray<TSharedPtr<FJsonValue>>* SkinsArr = nullptr;
    if (Obj->TryGetArrayField(TEXT("skins"), SkinsArr) && SkinsArr)
    {
        for (const TSharedPtr<FJsonValue>& Val : *SkinsArr)
        {
            FString SkinId;
            if (Val.IsValid() && Val->TryGetString(SkinId))
            {
                Profile.OwnedSkins.Add(SkinId);
            }
        }
    }

    const TSharedPtr<FJsonObject>* LooksObj = nullptr;
    if (Obj->TryGetObjectField(TEXT("looks"), LooksObj) && LooksObj && LooksObj->IsValid())
    {
        for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*LooksObj)->Values)
        {
            if (Pair.Value.IsValid() && Pair.Value->Type == EJson::Object)
            {
                const TSharedPtr<FJsonObject> LookEntry = Pair.Value->AsObject();
                if (LookEntry.IsValid())
                {
                    Profile.SavedLooksJson.Add(Pair.Key, SerializeJsonObject(LookEntry.ToSharedRef()));
                }
            }
        }
    }

    OutProfile = MoveTemp(Profile);
    return !OutProfile.Id.IsEmpty();
}

void UOpenGridOnlineSubsystem::CreateAccount()
{
    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(BuildUrl(TEXT("/v1/account")));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetContentAsString(TEXT("{}"));

    TWeakObjectPtr<UOpenGridOnlineSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda(
        [WeakThis](FHttpRequestPtr /*Req*/, FHttpResponsePtr Resp, bool bConnected)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;

            if (!bConnected || !Resp.IsValid())
            {
                Self->OnAccountCreated.Broadcast(false, FString(), TEXT("Network connection failed"));
                return;
            }

            const int32 Code = Resp->GetResponseCode();
            const FString Body = Resp->GetContentAsString();
            if (!EHttpResponseCodes::IsOk(Code))
            {
                Self->OnAccountCreated.Broadcast(false, FString(), ExtractErrorMessage(Body, Code));
                return;
            }

            TSharedPtr<FJsonObject> Obj;
            const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);
            FString NewId, NewToken;
            if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid() ||
                !Obj->TryGetStringField(TEXT("id"), NewId) ||
                !Obj->TryGetStringField(TEXT("token"), NewToken))
            {
                Self->OnAccountCreated.Broadcast(false, FString(), TEXT("Invalid /v1/account response payload"));
                return;
            }

            Self->SetCredentials(NewId, NewToken);
            UE_LOG(LogOpenGridOnline, Log, TEXT("Created online account %s"), *Self->AccountId);
            Self->OnAccountCreated.Broadcast(true, Self->AccountId, FString());
        });

    Request->ProcessRequest();
}

void UOpenGridOnlineSubsystem::FetchProfile()
{
    if (!HasCredentials())
    {
        OnProfileReceived.Broadcast(false, FOpenGridOnlineProfile{}, TEXT("Not signed in (missing account credentials)"));
        return;
    }

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(BuildUrl(TEXT("/v1/me")));
    Request->SetVerb(TEXT("GET"));
    Request->SetHeader(TEXT("Authorization"), GetBearerHeaderValue());

    TWeakObjectPtr<UOpenGridOnlineSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda(
        [WeakThis](FHttpRequestPtr /*Req*/, FHttpResponsePtr Resp, bool bConnected)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;

            if (!bConnected || !Resp.IsValid())
            {
                Self->OnProfileReceived.Broadcast(false, FOpenGridOnlineProfile{}, TEXT("Network connection failed"));
                return;
            }

            const int32 Code = Resp->GetResponseCode();
            const FString Body = Resp->GetContentAsString();
            if (!EHttpResponseCodes::IsOk(Code))
            {
                Self->OnProfileReceived.Broadcast(false, FOpenGridOnlineProfile{}, ExtractErrorMessage(Body, Code));
                return;
            }

            FOpenGridOnlineProfile Parsed;
            if (!ParseProfileJson(Body, Parsed))
            {
                Self->OnProfileReceived.Broadcast(false, FOpenGridOnlineProfile{}, TEXT("Invalid /v1/me profile JSON"));
                return;
            }

            Self->CachedProfile = Parsed;
            Self->OnProfileReceived.Broadcast(true, Self->CachedProfile, FString());
        });

    Request->ProcessRequest();
}

void UOpenGridOnlineSubsystem::SaveCarLook(const FString& CarId, const FString& LookJson)
{
    if (!HasCredentials())
    {
        OnLookSaved.Broadcast(false, CarId, TEXT("Not signed in"));
        return;
    }

    TSharedPtr<FJsonObject> LookObj;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(LookJson);
    if (!FJsonSerializer::Deserialize(Reader, LookObj) || !LookObj.IsValid())
    {
        OnLookSaved.Broadcast(false, CarId, TEXT("LookJson is not a valid JSON object"));
        return;
    }

    const TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("car"), CarId);
    Payload->SetObjectField(TEXT("look"), LookObj);

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(BuildUrl(TEXT("/v1/look")));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("Authorization"), GetBearerHeaderValue());
    Request->SetContentAsString(SerializeJsonObject(Payload));

    TWeakObjectPtr<UOpenGridOnlineSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda(
        [WeakThis, CarId](FHttpRequestPtr /*Req*/, FHttpResponsePtr Resp, bool bConnected)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;

            if (!bConnected || !Resp.IsValid())
            {
                Self->OnLookSaved.Broadcast(false, CarId, TEXT("Network connection failed"));
                return;
            }

            const int32 Code = Resp->GetResponseCode();
            const FString Body = Resp->GetContentAsString();
            if (!EHttpResponseCodes::IsOk(Code))
            {
                Self->OnLookSaved.Broadcast(false, CarId, ExtractErrorMessage(Body, Code));
                return;
            }

            FOpenGridOnlineProfile Updated;
            if (ParseProfileJson(Body, Updated))
            {
                Self->CachedProfile = Updated;
                Self->OnProfileReceived.Broadcast(true, Self->CachedProfile, FString());
            }
            Self->OnLookSaved.Broadcast(true, CarId, FString());
        });

    Request->ProcessRequest();
}

void UOpenGridOnlineSubsystem::BuyItem(const FString& Kind, const FString& Id, int32 Stage)
{
    if (!HasCredentials())
    {
        OnPurchaseCompleted.Broadcast(false, Id, CachedProfile, TEXT("Not signed in"));
        return;
    }

    const TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("kind"), Kind);
    Payload->SetStringField(TEXT("id"), Id);
    if (Stage > 0)
    {
        Payload->SetNumberField(TEXT("stage"), Stage);
    }

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(BuildUrl(TEXT("/v1/buy")));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("Authorization"), GetBearerHeaderValue());
    Request->SetContentAsString(SerializeJsonObject(Payload));

    TWeakObjectPtr<UOpenGridOnlineSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda(
        [WeakThis, Id](FHttpRequestPtr /*Req*/, FHttpResponsePtr Resp, bool bConnected)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;

            if (!bConnected || !Resp.IsValid())
            {
                Self->OnPurchaseCompleted.Broadcast(false, Id, Self->CachedProfile, TEXT("Network connection failed"));
                return;
            }

            const int32 Code = Resp->GetResponseCode();
            const FString Body = Resp->GetContentAsString();
            if (!EHttpResponseCodes::IsOk(Code))
            {
                Self->OnPurchaseCompleted.Broadcast(false, Id, Self->CachedProfile, ExtractErrorMessage(Body, Code));
                return;
            }

            FOpenGridOnlineProfile Updated;
            if (ParseProfileJson(Body, Updated))
            {
                Self->CachedProfile = Updated;
            }
            Self->OnPurchaseCompleted.Broadcast(true, Id, Self->CachedProfile, FString());
        });

    Request->ProcessRequest();
}

void UOpenGridOnlineSubsystem::SendPresence(const FString& PartyCode)
{
    if (!HasCredentials())
    {
        OnPresenceAck.Broadcast(false, TEXT("Not signed in"));
        return;
    }

    const TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    if (!PartyCode.IsEmpty())
    {
        Payload->SetStringField(TEXT("party"), PartyCode.ToUpper());
    }

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
    Request->SetURL(BuildUrl(TEXT("/v1/presence")));
    Request->SetVerb(TEXT("POST"));
    Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
    Request->SetHeader(TEXT("Authorization"), GetBearerHeaderValue());
    Request->SetContentAsString(SerializeJsonObject(Payload));

    TWeakObjectPtr<UOpenGridOnlineSubsystem> WeakThis(this);
    Request->OnProcessRequestComplete().BindLambda(
        [WeakThis](FHttpRequestPtr /*Req*/, FHttpResponsePtr Resp, bool bConnected)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;

            if (!bConnected || !Resp.IsValid())
            {
                Self->OnPresenceAck.Broadcast(false, TEXT("Network connection failed"));
                return;
            }

            const int32 Code = Resp->GetResponseCode();
            if (!EHttpResponseCodes::IsOk(Code))
            {
                Self->OnPresenceAck.Broadcast(false, ExtractErrorMessage(Resp->GetContentAsString(), Code));
                return;
            }
            Self->OnPresenceAck.Broadcast(true, FString());
        });

    Request->ProcessRequest();
}

void UOpenGridOnlineSubsystem::ConnectRaceRoom(const FString& PartyCode)
{
    const FString CleanParty = PartyCode.TrimStartAndEnd().ToUpper();
    if (CleanParty.Len() < 4 || CleanParty.Len() > 10)
    {
        UE_LOG(LogOpenGridOnline, Warning, TEXT("ConnectRaceRoom: party code '%s' must be 4-10 alphanumeric characters"), *CleanParty);
        OnRoomConnected.Broadcast(false, CleanParty);
        return;
    }
    if (!HasCredentials())
    {
        UE_LOG(LogOpenGridOnline, Warning, TEXT("ConnectRaceRoom: missing account credentials"));
        OnRoomConnected.Broadcast(false, CleanParty);
        return;
    }

    DisconnectRaceRoom();

    if (!FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets")))
    {
        FModuleManager::Get().LoadModule(TEXT("WebSockets"));
    }

    const FString AuthPair = FString::Printf(TEXT("%s.%s"), *AccountId, *AuthToken);
    const FString WsUrl = BuildWebSocketUrl(FString::Printf(TEXT("/v1/room/%s?auth=%s"), *CleanParty, *AuthPair));

    TMap<FString, FString> UpgradeHeaders;
    UpgradeHeaders.Add(TEXT("Authorization"), GetBearerHeaderValue());

    ActivePartyCode = CleanParty;
    RaceRoomSocket_ = FWebSocketsModule::Get().CreateWebSocket(WsUrl, TEXT(""), UpgradeHeaders);
    if (!RaceRoomSocket_.IsValid())
    {
        OnRoomConnected.Broadcast(false, CleanParty);
        return;
    }

    TWeakObjectPtr<UOpenGridOnlineSubsystem> WeakThis(this);
    RaceRoomSocket_->OnConnected().AddLambda(
        [WeakThis, CleanParty]()
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;
            Self->bRaceRoomConnected = true;
            UE_LOG(LogOpenGridOnline, Log, TEXT("Connected to race room %s"), *CleanParty);
            Self->OnRoomConnected.Broadcast(true, CleanParty);
        });

    RaceRoomSocket_->OnConnectionError().AddLambda(
        [WeakThis, CleanParty](const FString& Error)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;
            Self->bRaceRoomConnected = false;
            UE_LOG(LogOpenGridOnline, Warning, TEXT("Race room %s connection error: %s"), *CleanParty, *Error);
            Self->OnRoomConnected.Broadcast(false, CleanParty);
        });

    RaceRoomSocket_->OnClosed().AddLambda(
        [WeakThis](int32 StatusCode, const FString& Reason, bool /*bWasClean*/)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;
            Self->bRaceRoomConnected = false;
            Self->OnRoomClosed.Broadcast(StatusCode, Reason);
        });

    RaceRoomSocket_->OnMessage().AddLambda(
        [WeakThis](const FString& Message)
        {
            UOpenGridOnlineSubsystem* Self = WeakThis.Get();
            if (!Self) return;

            FString MsgType;
            TSharedPtr<FJsonObject> Obj;
            const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
            if (FJsonSerializer::Deserialize(Reader, Obj) && Obj.IsValid())
            {
                Obj->TryGetStringField(TEXT("t"), MsgType);
            }
            Self->OnRoomMessage.Broadcast(MsgType, Message);
        });

    RaceRoomSocket_->Connect();
}

void UOpenGridOnlineSubsystem::DisconnectRaceRoom()
{
    bRaceRoomConnected = false;
    ActivePartyCode.Reset();
    if (RaceRoomSocket_.IsValid())
    {
        if (RaceRoomSocket_->IsConnected())
        {
            RaceRoomSocket_->Close();
        }
        RaceRoomSocket_.Reset();
    }
}

bool UOpenGridOnlineSubsystem::SendRoomJson(const FString& JsonPayload)
{
    if (!RaceRoomSocket_.IsValid() || !RaceRoomSocket_->IsConnected())
    {
        return false;
    }
    RaceRoomSocket_->Send(JsonPayload);
    return true;
}

bool UOpenGridOnlineSubsystem::SendRoomJoin(const FString& CarId, int32 AssistsOff, bool bManual, bool bHost)
{
    const TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("t"), TEXT("join"));
    Payload->SetStringField(TEXT("car"), CarId);
    Payload->SetNumberField(TEXT("assistsOff"), FMath::Clamp(AssistsOff, 0, 5));
    Payload->SetBoolField(TEXT("manual"), bManual);
    Payload->SetBoolField(TEXT("host"), bHost);
    return SendRoomJson(SerializeJsonObject(Payload));
}

bool UOpenGridOnlineSubsystem::SendRoomPosition(const FVector& WorldLocationCm, float SpeedMetersPerSec)
{
    // Convert UE (X forward, Y right, Z up, cm) -> room.ts expected Three-space (x = core_x, y = up, z = -core_y, m).
    // Since core_x = ue_x * 0.01 and core_y = -ue_y * 0.01, three_z = -core_y = ue_y * 0.01.
    const TSharedRef<FJsonObject> Payload = MakeShared<FJsonObject>();
    Payload->SetStringField(TEXT("t"), TEXT("pos"));
    Payload->SetNumberField(TEXT("x"), WorldLocationCm.X * 0.01);
    Payload->SetNumberField(TEXT("y"), WorldLocationCm.Z * 0.01);
    Payload->SetNumberField(TEXT("z"), WorldLocationCm.Y * 0.01);
    Payload->SetNumberField(TEXT("v"), SpeedMetersPerSec);
    return SendRoomJson(SerializeJsonObject(Payload));
}
