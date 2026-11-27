# Minimum configuration and free-roam feature tiers

**The minimum is the maintainer's laptop: 1280x720, the `low` preset, held at 30 fps** (an Intel i3-1315U with 7.4 GiB of memory and integrated graphics). Everything the game adds beyond it, such as more traffic and people, belongs to a higher tier, so features scale with
the hardware instead of requiring it. There is no published minimum for other machines: that needs measurements from other devices (the README says so).

## What was measured (2026-11-27, headless Chrome with WebGPU on that laptop, `web/tools/probes/frame_pacing.js`)

1280x720, `quality=low`, `scale=1`, `cap=0` (the 30 fps lock removed so the headroom shows), free roam:

| | frame rate (the game's own readout) | 300-frame median | p95 |
|---|---|---|---|
| no traffic cars | 52 fps, 18 ms | 16.7 ms | 33.3 to 34 ms |
| the 5 rival-grade traffic cars | 46 fps, 21 ms | 16.7 ms | 33.3 to 35 ms |

How to read it: against a 33.3 ms (30 fps) deadline the median has roughly 12 ms of headroom, **but the slowest 5 % of frames already sit at the deadline** (streaming and uploads cause the spikes) and the five cars cost about 3 ms. So the minimum has room, not a lot,
and a feature that adds a little to every frame can still push the tail over. The budget for anything added to the `low` tier is therefore a couple of milliseconds, checked against the p95, not the median.
Limits of the numbers: headless Chrome on one machine, one scene and one camera position, run to run noise of about a millisecond, GPU time not measured separately.

## The tiers (`web/src/tiers.ts`)

| preset | rival-grade cars | instanced background traffic | pedestrians | measured |
|---|---|---|---|---|
| potato (phones) | 5 | 8 | 0 | no: not run on a phone |
| **low (the minimum)** | 5 | 32 | 0 | **yes**, traffic only: see the next section. Pedestrians do not exist yet |
| medium | 5 | 48 | 16 | no |
| high | 5 | 64 | 32 | no |
| ultra | 5 | 96 | 64 | no |
| max | 5 | 128 | 96 | no |

The counts follow the active preset, including when the adaptive tuner steps it up or down while driving, and are scaled by the time of day (`worldClock.trafficDensity`: full at night, 10 % in the small hours). **Only `low` can be measured on the maintainer's laptop**; the numbers above it are budgets until someone runs the probe on a stronger device.
"Rival-grade" cars are the detailed ones (a 28,000-triangle model, damage rig, headlight and physics body each: about 3 ms for five at 720p low); the background traffic is the cheap kind, built for crowds.

## What the background traffic costs (measured 2026-11-27, `web/tools/probes/traffic_cost.js`)

Background cars are one instanced low-poly body plus one lights mesh (200 + 8 triangles per car, 2 draw calls in total, `web/src/cityTraffic.ts`), driven on the city's street graph by `web/src/trafficSim.ts`.
London, 1280x720, `low`, the main thread slowed 4x (`CPU_THROTTLE=4`) so small costs show, one page, counts 0 / 64 / 256 / 0 / 64 / 256:

| cars | mean frame, run 1 | mean frame, run 2 | traffic update (CPU, at 4x slowdown) | the same at real speed |
|---|---|---|---|---|
| 0 | 63.3 ms | 55.2 ms | 0.01 ms | |
| 64 | 56.2 ms | 57.8 ms | 0.46 ms | about 0.11 ms |
| 256 | 57.7 ms | 57.8 ms | 1.33 to 1.38 ms | about 0.34 ms |

The two 0-car runs differ by 8 ms, so that is the noise floor of this test: **the frame-time cost of up to 256 cars is smaller than the noise (about 2 ms at real speed), not zero.** The simulation itself is the only cost measured reliably (about 0.1 ms for 64 cars, about 0.3 ms for 256).
One scene, one standing camera, headless Chrome, GPU time not measured separately. The 12 cars of the first version also showed no difference (median 16.7 ms every run, p95 18 to 34 ms in runs of the same setting).
So `low` carries 32 and the cost is not what limits the count: believable density is.

## What the traffic does and does not do

Does: drive the real street graph of the city (one-way streets, the driving side of the country, posted limits), follow the car in front, slow for turns and for a slower road ahead, take junctions one at a time, stop for the player in their lane,
appear 150 to 300 m from the player and go away beyond 380 m, and glow tail and head lights at night. **The 8 cars nearest the player (within 40 m) are solid**: the player is stopped by them (tested with Rapier in `web/tools/test_traffic.mjs`:
20 m/s to 0 with no penetration) and takes damage from the core's crash model (277 kJ for a 20 m/s hit in the game, `core.damage()`). The car that was hit is shoved along its lane and waits 12 s.

Does not (yet): a hit car does not deform, spin or move sideways (it only takes the impact along its own lane, so a side hit leaves it where it is), cars follow no traffic lights, do not change lanes or overtake, and exist only in the browser that draws them:
other players of a party do not see them or collide with them. The ground height comes from the terrain, so a car on a bridge or in a tunnel sits at the terrain's height. Pedestrians do not exist yet.

## Not tied to the tiers yet

Draw distance: the city streamer fixes how far it loads when it is created (1000 m desktop, 560 m touch, 420 m potato), so it cannot follow the tuner at run time. Tying it to the tiers means making the streamer's radius adjustable.

## Reproducing the measurement

```bash
cd web && npx vite &                                                      # the dev server on 127.0.0.1:5173
HEADLESS=1 node tools/cdp.mjs start "http://127.0.0.1:5173/?menu=0&touch=0&user=drive_test&quality=low&scale=1&cap=0&ai=5" 1280x863
HEADLESS=1 node tools/cdp.mjs file tools/probes/frame_pacing.js
CPU_THROTTLE=4 HEADLESS=1 node tools/cdp.mjs file tools/probes/traffic_cost.js    # needs &city=london&traffic=1 on the URL
HEADLESS=1 node tools/cdp.mjs stop
```
(`ai=0` is the no-traffic row. A 1280x863 window gives a 1280x720 picture. `?menu=0` is the test shortcut into a free run.)
