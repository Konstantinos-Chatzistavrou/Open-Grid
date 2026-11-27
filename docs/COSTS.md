# What Open Grid costs to run

The goal: the only recurring cost is the **domain name** (about €9 a year). Everything else runs on free plans, and nothing is set up to charge a card automatically. This page says what each service is used for, what the free limit is, and what happens when it is reached.

| Service | Used for | Plan | Cost |
|---|---|---|---|
| Domain `open-grid.racing` | the web address | yearly registration | about €9 a year |
| Cloudflare Workers, D1, Durable Objects (`cloud/`) | online backend: accounts, hotlaps, ratings, online rooms | Free | €0 |
| Vercel | hosts the web build | Hobby (free) | €0 |
| GitHub | the repository, CI (free for public repositories), Sponsors page | Free | €0 |
| Google, GitHub, Discord sign-in | optional login | OAuth apps | €0 |
| PeerJS public broker (`0.peerjs.com`) | introduces players for peer to peer parties | community service | €0 |

Not used: Patreon, ads, paid servers, paid databases.

## What happens at the free limits

Free plans stop; they do not bill. The limits below are what the vendors published when this page was last checked (2026-11-27). Limits change, so the linked pages are the truth.

**Cloudflare (Free plan)**
- Workers: 100,000 requests a day, 10 ms of CPU per request. Past the limit, requests fail until 00:00 UTC. ([limits](https://developers.cloudflare.com/workers/platform/limits/))
- D1 database: 5 million rows read and 100,000 rows written a day, 5 GB stored. Past the limit, queries fail until 00:00 UTC. ([pricing](https://developers.cloudflare.com/d1/platform/pricing/))
- Durable Objects (online rooms): 100,000 requests and 13,000 GB-s a day; only SQLite-backed objects. Incoming WebSocket messages count 20 to 1 as requests, outgoing messages are free. ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/))
- What this means in practice: when the online service runs out for the day, ranked, hotlaps and accounts pause until midnight UTC. Single player, the garage and peer to peer parties keep working. Upgrading is a manual choice in the dashboard; nothing upgrades itself.

**Vercel (Hobby plan)**
- Included each month: 100 GB of data transfer, 1,000,000 CDN requests, 1,000,000 function invocations. ([plan](https://vercel.com/docs/plans/hobby))
- If a limit is exceeded, that feature pauses for up to 30 days instead of billing. The game itself is a static site, so it uses very little.
- Vercel's Hobby plan is meant for personal, non-commercial use (see their [Terms of Service](https://vercel.com/terms) and [fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)). Open Grid is free, ad-free and non-profit, with optional sponsorship that buys nothing. I could not find a clear statement on whether that counts, so if Vercel ever objects, the web build is plain static files and can move to another free static host in an afternoon.

**Sign-in providers.** Creating OAuth apps with Google, GitHub and Discord is free. Keep the requested permissions to basic sign-in (identity and name); Google reviews apps that ask for more.

**GitHub.** Public repositories get free Actions minutes. Sponsorships are optional and buy nothing (see [MAINTENANCE.md](MAINTENANCE.md)).

**PeerJS public broker.** Run by the PeerJS project, no guarantee. If it is down, parties cannot start; the self-hosted broker in `server/` is the fallback.

## Keep it at €9 a year

- Keep every account on its free plan. Do not add a card to Cloudflare or Vercel unless you decide to pay for something.
- Renew the domain yearly (set a reminder; losing it would be the real loss).
- Look at the Cloudflare and Vercel usage pages once a quarter. If a limit is close, the fix is to do less (cache more, send fewer updates), not to pay.
- Big servers are somebody else's cost: anyone can run a room server for large lobbies ([self_hosting.md](self_hosting.md)); it is never part of the official service.
