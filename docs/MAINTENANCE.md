# Maintenance & support

Open Grid is an **independent, open-source hobby project**, built for the love of racing and maintained in spare time. It is free, non-profit and ad-free. This page says plainly what that means, so nobody is surprised.

## What you can expect

- **The game stays free.** All cars, tracks, single player, the garage, split-screen and private P2P lobbies cost nothing. There is no paid tier.
- **The code and physics keep improving** whenever time allows, with CI guarding the physics core (`core/`) so changes don't silently break handling.
- **Honest limits.** The physics are validated against published data where possible, and what isn't validated is listed in [docs/physics.md](physics.md) and [docs/validation.md](validation.md).

## What is not promised

- No release dates, roadmap commitments or response-time guarantees.
- No uptime guarantee for any online service (see below).
- No paid support, no SLA, no refunds (there is nothing to refund).
- Issues and pull requests are read when time allows. A clear report (browser, GPU, steps to reproduce, wheel model for force-feedback problems) gets fixed sooner than a vague one.

## Online services

- **Free and best-effort.** The online backend (`cloud/`) runs on the Cloudflare Workers free plan. If it hits the free limits, is being changed, or is simply down, online features pause and single player keeps working.
- **Private P2P lobbies** are casual and unranked, and there is no trusted server, so cheating cannot be fully prevented there.
- **Ranked splits, ratings, championships and hotlaps** are free for every account while the service runs. They are automated community features run on a best-effort basis, not a guaranteed live service — there is no human stewarding team (penalties, fault scoring, and replay checks are automated). Ratings and seasons may be reset or changed.
- **Support the project:** optional **[Patreon](https://www.patreon.com/Open_Grid)** (no trials, no paywalls: the game and servers do not check for it). Support is optional and creates no obligations either way; the Patreon page says what a pledge includes.
- **Big lobbies are self-hosted.** The official setup stays on free plans (a domain is the only recurring cost, see [COSTS.md](COSTS.md)), so peer to peer parties are about 16 players. Anyone with a server can run the **room server** for much larger Free Roam lobbies: [self_hosting.md](self_hosting.md). It is theirs to run and pay for, like a Minecraft server.
- **Run your own.** Everything needed to host your own league or servers is in the repo (`cloud/` for the backend, `server/` for the PeerJS broker and the room server). Community-run leagues are welcome. Forks must use their own name and logo (see [LICENSING.md](../LICENSING.md)).

## Accounts

Playing as a guest always works. Signing in with Google, GitHub or Discord is optional and only adds saving and online features. Account data is kept to the minimum needed to run those features.

## Contributing

[CONTRIBUTING.md](../CONTRIBUTING.md) explains how to help. Small, focused pull requests with tests (physics changes especially) are the easiest to review. Drivers with force-feedback wheels are the most useful contributors of all: see the [testing program](testing_program.md).
