# Hosting a big Free Roam server

The game's normal parties are peer to peer: the leader's browser relays everyone's cars, which is fine for about 16 friends and no more. If you have a server and want a bigger lobby (50, 100 players), you can run the **room server** (`server/rooms.js`). It is the same relay as a small standalone program with no browser in the middle, so the only limits are your machine and its bandwidth.

Think of Minecraft: "Open to LAN" is our party, `server.jar` is this. The official game never needs it, nobody has to run one, and it is not part of the free online service. If you run one, you are the one who pays for it and looks after it.

## What it does

- **One room per city.** Players only see players in the same city. A city room takes up to `MAX_PLAYERS` (default 64).
- **Only nearby cars are sent.** Each player gets the cars within `AOI_RADIUS_M` (400 m); cars farther than `NEAR_RADIUS_M` (120 m) arrive at a third of the rate. A car that drives out of view is removed on your screen, and comes back when it returns. This is what makes big lobbies possible.
- **Ghost cars.** On a room server, other players' cars are drawn and name-tagged, but they do not collide. (Collision bodies for dozens of cars are the other big cost on the player's side.)
- **Free Roam only.** Races, the co-op garage and WebRTC voice chat are not relayed. Use Discord or similar for voice.
- **Abuse limits.** 8 KB messages, per-connection rate limits, a connection limit per address, heartbeat timeout, optional password, optional allowed web origins.
- **No accounts, no ranked results, no anti-cheat.** Everything a client sends is checked for shape and range (a pose must be a real position and rotation, speeds are capped), but the server cannot know a player isn't cheating. Treat it as a casual server.
- **No logs of players.** Addresses are kept in memory only, for the connection limit.

## Run it

```bash
cd server
npm install
npm run rooms                     # port 9100
```

Settings are environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 9100 | listening port |
| `SERVER_NAME` | Open Grid Server | shown in `/status` |
| `SERVER_PASSWORD` | (none) | players must add `&pw=...` to the join link |
| `MAX_PLAYERS` | 64 | players per city room |
| `MAX_TOTAL` | 0 (no limit) | players on the whole server |
| `MAX_PER_IP` | 4 | connections from one address |
| `AOI_RADIUS_M` | 400 | how far a player sees other cars |
| `NEAR_RADIUS_M` | 120 | closer than this, cars update at full rate |
| `FAR_EVERY` | 3 | beyond near, send every Nth update |
| `RADIO_RANGE_M` | 5000 | street radio range |
| `ALLOWED_ORIGINS` | (any) | comma separated web origins, e.g. `https://open-grid.racing` |
| `PROXIED` | (off) | `1` behind a reverse proxy: trust `X-Forwarded-For` for the per-address limit |

`GET /health` returns counters and `GET /status` returns the name, player counts and whether a password is needed (both allow any origin; useful for a future server list).

## Put it on the internet

The game is served over `https`, so the browser only talks to `wss://`. The simplest way is a reverse proxy that handles the certificate. With [Caddy](https://caddyserver.com) (automatic certificates, WebSocket works without extra settings), a `Caddyfile`:

```
play.example.com {
    reverse_proxy 127.0.0.1:9100
}
```

Start the server with `PROXIED=1` and keep port 9100 closed to the outside. Docker works too:

```bash
docker build -f Dockerfile.rooms -t open-grid-rooms .
docker run -d --restart unless-stopped -p 127.0.0.1:9100:9100 \
  -e SERVER_NAME="My Open Grid Server" -e PROXIED=1 \
  -e ALLOWED_ORIGINS=https://open-grid.racing open-grid-rooms
```

Players join with a link:

```
https://open-grid.racing/?server=play.example.com
https://open-grid.racing/?server=play.example.com&pw=secret      (password-protected server)
```

They see the usual invite banner with your server's address, click **Join Party**, and load into Free Roam. For local testing, `?server=localhost:9100` works over plain `ws://`.

## What it costs

You need one small virtual server. Prices vary and change, but a basic VPS is roughly €4–6 a month at common providers, and traffic is usually the limit, not CPU. These numbers come from `npm run loadtest` (bots that drive and send poses at 20 Hz like the real client), run on a 2-core test machine with the bots on the same machine:

| Scenario | Server sends | Per player download | Server CPU |
|---|---|---|---|
| 64 players, all within view of each other (worst case) | 36 Mbit/s | 70 KB/s | 18% of one core |
| 64 players spread over a city (3 km) | 0.7 Mbit/s | 1.4 KB/s | 3% |
| 200 players spread over a city (3 km) | 6.8 Mbit/s | 4.2 KB/s | 13% |

So CPU is not the problem. Bandwidth is, and only when many players are close together. A completely full, always-in-view lobby 24/7 would be about 11 TB a month, which is more than many cheap plans include, but real lobbies are spread out. Measure your own case before you rent anything:

```bash
MAX_PER_IP=1000 MAX_PLAYERS=200 npm run rooms                      # terminal 1
npm run loadtest -- --bots 64 --seconds 20 --spread 300            # terminal 2 (--spread: metres the bots are scattered over)
```

The players' own computers have limits too: a client that sees 60 cars at once is limited by its graphics card, not the network. Lower `AOI_RADIUS_M` if players on weaker machines struggle.

## Ideas for contributors

Good first projects, all in `server/rooms.js` and `web/src/party.ts`:

- **Binary poses.** Poses are JSON today (about 190 bytes); a packed binary format could be 5–6 times smaller and would cut the worst-case bandwidth the same way.
- **A spatial grid** instead of checking every player on each pose, for rooms of several hundred.
- **A server list** that reads `/status` from addresses people share.
- **Light server-side checks**, such as a maximum speed between poses, to catch the crudest teleport cheats.
- **Race rooms** on the server, with the same protocol the peer to peer party already uses.

## The protocol, briefly

The server speaks the same messages as `web/src/party.ts` over WebSocket (JSON), playing the party leader. On connect it sends `welcome` (your id, the player cap); the client answers `hello` (name, car, paint, city, password); the server sends `lobby` (members) and `start`, and `go` once the client says `loaded`. Then `pose`, `gone`, `flash`, `pole`, `breach`, `wager`, `zone` and `radio` are relayed as in a party. Messages that only make sense in a race (`prog`) or the co-op garage (`gstate`, `gevent`, `gwalk`) are ignored.
