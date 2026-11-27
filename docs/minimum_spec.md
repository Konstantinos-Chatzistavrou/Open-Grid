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
| potato (phones) | 5 | 0 | 0 | no |
| **low (the minimum)** | 5 | 12 | 0 | no: set by the measurement above once the system exists |
| medium | 5 | 24 | 16 | no |
| high | 5 | 36 | 32 | no |
| ultra | 5 | 48 | 64 | no |
| max | 5 | 64 | 96 | no |

The counts follow the active preset, including when the adaptive tuner steps it up or down while driving. **Only `low` can be measured on the maintainer's laptop**; the numbers above it are budgets until someone runs the probe on a stronger device.
"Rival-grade" cars are the detailed ones (a 28,000-triangle model, damage rig, headlight and physics body each: about 3 ms for five at 720p low); the background traffic is the cheap kind, built for crowds.

## Not tied to the tiers yet

Draw distance: the city streamer fixes how far it loads when it is created (1000 m desktop, 560 m touch, 420 m potato), so it cannot follow the tuner at run time. Tying it to the tiers means making the streamer's radius adjustable.

## Reproducing the measurement

```bash
cd web && npx vite &                                                      # the dev server on 127.0.0.1:5173
HEADLESS=1 node tools/cdp.mjs start "http://127.0.0.1:5173/?menu=0&touch=0&user=drive_test&quality=low&scale=1&cap=0&ai=5" 1280x863
HEADLESS=1 node tools/cdp.mjs file tools/probes/frame_pacing.js
HEADLESS=1 node tools/cdp.mjs stop
```
(`ai=0` is the no-traffic row. A 1280x863 window gives a 1280x720 picture. `?menu=0` is the test shortcut into a free run.)
