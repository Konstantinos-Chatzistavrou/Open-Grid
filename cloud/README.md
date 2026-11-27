# Open Grid Online Service (`cloud/`)

The server-authoritative backend for **Open Grid's competitive online network**, running on **Cloudflare Workers + D1 + SQLite-backed Durable Objects (Free Plan, $0/month fixed cost)**.

- **Live instance:** `https://opengrid.opengrid-racing.workers.dev` (region `EEUR`; ready for custom domain `https://api.open-grid.racing` once the `open-grid.racing` zone is added to Cloudflare)
- **Frontend integration:** Vercel project `opengrid` builds `web/` with `VITE_CLOUD_URL` set to the live Worker URL on every push to `main`.
- **Licence:** `Apache-2.0` (100% open source; self-hostable by leagues and communities).
- **Funding Philosophy:** **100% Free Hobby Project & Ad-Free.** All cars, tracks, single player, garage, friends, ranked splits, championships, hotlaps, leagues, and private P2P lobbies are free for every account on the Cloudflare free plan (best-effort). There is no 7-day trial and no human-in-the-loop stewarding; optional support is on **[Patreon](https://www.patreon.com/Open_Grid)** and the servers do not check for it. Legacy pass-gating code in `cloud/` is switched off (`REQUIRE_SUPPORTER_PASS = "0"`).

---

## Architecture & Features

### 1. Authentication & Accounts (`src/auth.ts`, `src/index.ts`)
- **Real Email + Password Login & Registration:** WebCrypto `PBKDF2-HMAC-SHA256` (100,000 iterations, 16-byte random salt, constant-time verification). Registering upgrades an existing anonymous guest account **in-place** with zero lost progress.
- **Brute-Force & Abuse Protection:** Login rate-limited to `10 attempts / 15 min` per salted network hash; signups capped at `5 / day` per network hash. Raw IPs are never stored.
- **Guest Fallback & Recovery Codes:** Instant guest play (`POST /v1/account`) with device-transfer recovery codes; bearer tokens rotate on login/password change/logout.
- **Unique Usernames & Friends:** Case-insensitive unique usernames (3–16 chars, 30-day change cooldown, `#` reserved for bots), bidirectional friend requests, and 60 s online/party presence heartbeats.

### 2. Non-Profit Patreon Online Pass (`src/patreon.ts`)
- **Zero Business Entity / $0 Fixed Cost:** Patreon acts as Merchant of Record (VAT, tax, recurring billing, cancellations).
- **Automated Webhooks (`POST /v1/patreon/webhook`):** Pure-TypeScript RFC 1321 MD5 + RFC 2104 HMAC-MD5 verifies Patreon's `X-Patreon-Signature` header natively on Cloudflare Workers. Handles `members:pledge:create`, `update`, and `delete`, matching accounts by linked Patreon ID **or matching email address** and granting a rolling 35-day window (`pro` ≥ `$5/mo`, `team_pro` ≥ `$10/mo`, configurable via `PATREON_PRO_CENTS` / `PATREON_TEAM_CENTS`).
- **1-Click OAuth2 Connect (`GET /v1/patreon/connect` → `/v1/patreon/callback`):** CSRF-signed state token links Patreon accounts even when emails differ and activates the pass immediately in D1.

### 3. Competitive Rating, Licenses & Scheduled Splits (`src/ratings.ts`, `src/room.ts`)
- **Dual Rating:** Glicko-2 Driver Rating (`DR 800–3500`, Grade `E → S`, dynamic `RD` convergence) + Fault-Aware Safety Rating (`SR 0.00–4.99`, `0x Victim Shield` for blameless contact vs `4x` for at-fault collisions).
- **License Ladder & Bad-Sport Quarantine:** `R → D → C → B → A → PRO` with MPR promotion/demotion, automatic Bad-Sport quarantine (`splitNo = -1`) for habitual rammers, and **2 Season Disconnect Jokers** (`POST /v1/joker`) to restore lost DR/SR after an unfair disconnect/crash.
- **Official Series & Balanced SOF Splits:** Automated recurring schedules (`rookie_sprint` 20m, `gt3_championship` 45m, `hypercar_pro` 60m, `endurance_special` 120m), balanced Strength-of-Field split seeding, and deterministic party codes.
- **Seasonal Championships:** SOF-weighted points, car-lock tracking, and best-8-of-12 drop-week standings (`GET /v1/championships`).
- **Restorative Protests (`POST /v1/protests`, `POST /v1/protests/:id/resolve`):** Upheld steward protests automatically refund 100% of lost victim DR & SR from `race_rating_ledger` and quarantine intentional wreckers.
- **Global Hotlaps, Endurance Teams & Hosted Private Leagues:** Verified per-track/car/weather hotlap leaderboards (`GET /v1/leaderboards`, `POST /v1/hotlap`), Endurance Teams (`GET/POST /v1/teams`), and PBKDF2 password-protected Private Leagues (`GET/POST /v1/leagues`, `POST /v1/leagues/join`).

### 4. Server-Authoritative Economy, Escrow & Race Rooms
- **Cloud Saves (`GET/POST /v1/save`):** Monotonic `save_version` check (`409 Conflict` on stale/rollback writes) prevents local save-scumming.
- **Two-Party Wager Escrow (`POST /v1/wager/lock`, `/v1/wager/settle`):** Locks Cash or Pink Slip stakes server-side and requires mutual settlement agreement (or server-verified race outcome).
- **Durable Object `RaceRoom` (`src/room.ts`):** Times ranked races from 4 Hz telemetry, enforces ownership of raced car/mods, pace/teleport/flood plausibility checks, 6+ active drivers (max 2 per household network), and requests replay uploads from top-3/flagged finishers.
- **Automated C++20 Replay Anti-Cheat (`opengrid_replay_verifier`):** Free GitHub Actions cron (`.github/workflows/replay_verifier.yml`) polls `GET /v1/replays/pending`, replays inputs at 400 Hz through `rs::AuthorityServerSim` + `rs::AntiBotAnalyzer`, and posts verdicts to `POST /v1/replays/:race/:account`.

---

## API Route Summary

| Method & Path | Auth | Purpose |
|---|---|---|
| `GET /v1` | Public | Health check, active season ID, `adFree: true` |
| `POST /v1/account` | Public | Create anonymous guest account (includes 7-day trial) |
| `POST /v1/auth/register` / `login` | Public / Optional | Real Email+Password signup (upgrades guest in-place) & login |
| `POST /v1/auth/logout` / `password` | Bearer | Rotate bearer token / change password |
| `GET /v1/me`, `GET/POST /v1/save` | Bearer | Profile, DR/SR/License, monotonic cross-progression save |
| `GET /v1/subscription` | Bearer | Online pass status, Patreon URL, OAuth flag, benefits |
| `GET /v1/patreon/connect`, `GET /v1/patreon/callback` | Bearer / OAuth | 1-click Patreon OAuth2 account linking |
| `POST /v1/patreon/webhook` | `X-Patreon-Signature` | Automated Patreon pledge create/update/delete sync |
| `POST /v1/billing/webhook` | `X-OpenGrid-Signature` | Admin HMAC-SHA256 manual grant webhook |
| `GET /v1/schedule`, `POST /v1/schedule/{register,withdraw,seed}` | Public / Bearer | Official series calendar, registration & SOF split seeding |
| `GET /v1/championships` | Public | Official seasonal championship standings |
| `GET /v1/leaderboards`, `POST /v1/hotlap` | Public / Bearer | Verified Global Hotlap Leaderboard & PB upload |
| `GET/POST /v1/protests`, `POST /v1/protests/:id/resolve` | Bearer / `VERIFIER_KEY` | File & resolve Restorative Protests (auto DR/SR refund) |
| `POST /v1/joker` | Bearer | Redeem Season Disconnect Joker to restore lost DR/SR |
| `GET/POST /v1/teams` | Bearer | List & create Endurance Teams |
| `GET/POST /v1/leagues`, `POST /v1/leagues/join` | Public / Bearer | Browse, host & join password-protected Private Leagues |
| `GET/POST /v1/friends`, `POST /v1/presence`, `POST /v1/username` | Bearer | Social graph, presence & unique usernames |
| `POST /v1/buy`, `POST /v1/look`, `POST /v1/wager/{lock,settle}` | Bearer | Atomic shop purchases, livery sync, Pink Slip/Cash escrow |
| `WS /v1/room/:party` | Bearer (`?auth=`) | Server-timed Durable Object `RaceRoom` |
| `POST /v1/replay/:race`, `GET /v1/replays/pending`, `POST /v1/replays/:r/:a` | Bearer / `VERIFIER_KEY` | Replay upload & C++20 verifier queue |

---

## Local Development & Tests

```bash
cd cloud
npm install
npm run db:local             # apply all D1 migrations locally (0001..0006)
npm run dev                  # http://127.0.0.1:8787
npx tsc --noEmit
npm run test:pace            # 17 pace plausibility checks
npm run test:competitive     # 11 auth, Patreon MD5/HMAC, DR/SR, SOF, championship & protest checks
npm test                     # 17 simulated players, full end-to-end RaceRoom sim (~2 min)
npm run test:social          # usernames & friends tests
```

For local `.dev.vars` (never committed): `ALLOW_TEST_IP=1`, `IP_SALT=dev-salt`, `VERIFIER_KEY=dev-verifier`. **Never set `ALLOW_TEST_IP` in production.**

---

## Production Deployment & OAuth2 Setup (`$0/month`)

```bash
cd cloud
npx wrangler login
npm run db:remote            # applies migrations 0001..0007 on remote D1
npm run deploy               # deploys Worker + Durable Objects
```

Required Cloudflare secrets (`wrangler secret put <NAME>`):
- `IP_SALT` — random salt for anonymous network hashing
- `VERIFIER_KEY` — shared secret for GitHub Actions `opengrid_replay_verifier`

### 1-Click OAuth2 Login (Google, GitHub & Discord — $0/mo, Zero Dependencies)
Buttons automatically appear on **Desktop Profile** and the **Mobile Companion** as soon as each provider's secrets are configured via `wrangler secret put` (or `node tools/setup_oauth.mjs`):
- **Google** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`): Callback `https://opengrid.opengrid-racing.workers.dev/v1/auth/oauth/google/callback` (scopes: `openid email profile`)
- **GitHub** (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`): Callback `https://opengrid.opengrid-racing.workers.dev/v1/auth/oauth/github/callback` (scopes: `read:user user:email`)
- **Discord** (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`): Callback `https://opengrid.opengrid-racing.workers.dev/v1/auth/oauth/discord/callback` (scopes: `identify email`)

All three support **in-place guest account upgrade** (keeps cars, credits, DR/SR) and **verified email matching** (same OpenGrid profile across Google, GitHub, Discord, Email+Password, and UE 5.8 via `opengrid://auth`).

---

## Saved Follow-Up Wires (Planned Next Pass)
1. Hook live collision/offtrack events in `web/src/main.ts` into `ranked.incident(...)` (the `RaceRoom` already scores them).
2. Wire top-3 replay input-log upload in `web/src/main.ts` when `rankedRes.you.replay === true` (backend + C++20 verifier already live).
3. Add downloadable 3D Ghost Car playback from `hotlaps.ghost_data`.
