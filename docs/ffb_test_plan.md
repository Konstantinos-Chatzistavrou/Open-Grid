# Force feedback: what is checked, and the session to run with a borrowed wheel

Nobody on this project owns a steering wheel, so force feedback (FFB) has never run on hardware. Two layers are checked
without one; the third needs a wheel in the hands.

| layer | check | status |
|---|---|---|
| the bytes the wheel receives (Logitech classic commands, HID PID reports, report packing) | `node web/tools/test_ffb.mjs` | passes without hardware; follows the Logitech and USB PID 1.0 specifications, **not verified on a real wheel** |
| the force signal the physics produces | `node web/tools/ffb_signal_check.mjs` (needs `npm run sync-wasm` in `packages/vehicle-physics` once) | passes for the Vela GT and the Tornado GT3 (2026-11-25): torque sign, build-up with load, lightening past the grip limit, left/right symmetry, no slamming on a quick step, a quiet straight |
| how it feels, and what a given wheel does with it | this page | **never done** |

The signal check runs the game's own WebAssembly with the game's models switched on. It uses flat ground, so it says
nothing about road texture, kerbs or the "road effects" slider, and nothing about latency.

## Before the session (10 minutes)

1. Chrome or Edge on a desktop (WebHID). Linux: the udev rule in the README (`/etc/udev/rules.d/70-opengrid-wheels.rules`),
   replug the wheel afterwards.
2. Note the wheel: make, model, firmware / compatibility mode (Logitech wheels have a PlayStation and a native mode),
   cable or base. The game drives Logitech wheels that speak the classic protocol (the product IDs in `src/ffb/index.ts`, for example G25, G27, G29) and any wheel
   that exposes a USB PID force-feedback interface; it recognises Logitech, Thrustmaster, Fanatec, Moza, Simucube, Simagic, Asetek, Cammus, PXN,
   OpenFFBoard and Heusinkveld devices (`src/devices.ts`). Whether a particular model's PID interface is accepted is exactly what step 1 finds out.
   A wheel it cannot drive still steers and reads the pedals, it just gets no force.
3. `cd web && npm run dev`, open the game, Settings -> Controls. Keep one game window only.
4. Hands off the rim while the wheel connects and calibrates: it can swing to its limits.

## The session (about an hour)

Write the result of each step in the table at the end. "Pass" is a guide, the notes matter more.

| # | step | what to look at | pass |
|---|---|---|---|
| 1 | Connect (the browser's device picker) | the status line names the wheel and the driver (`... Logitech classic` or `... PID`) | it connects, steering and pedals both work |
| 2 | The menu's "test pulse" | a 0.6 s push **to the left** | pushes left; if it pushes right use the Invert option and note it |
| 3 | Rotation range | the wheel's lock-to-lock against the car's steering lock | soft stop where the car's wheels stop, no hard clunk |
| 4 | Parked, hands off, then turn the wheel slowly | heavy and slow when parked (damping), no oscillation, no self-rotation | no buzz or drift at standstill |
| 5 | Drive straight at 50, 100, 200 km/h | light, centred, **quiet**; no pull to one side | no vibration the car does not cause |
| 6 | Vela GT, a steady medium corner at 100 km/h | the wheel gets heavier as you turn in and the load builds | clearly more weight than on the straight |
| 7 | Same corner, add more lock until the car understeers | the wheel goes **light** as the front tyres pass their peak (the signal check shows 64-82 % lighter) | the lightness is noticeable and tells you to back off |
| 8 | Tornado GT3 at its limit, then a lift-off in the corner | weight at the limit (strength 75 % of full force at 1 g in the signal check), a countering force when the rear steps out | you can catch a slide from the wheel alone |
| 9 | A wall hit at 40 km/h (free roam) | a short sharp jolt, not a lasting shake | it stops within about 0.3 s |
| 10 | Strength, Max, Damper, Friction, Road-effects sliders | the defaults feel right; Max stops the wheel clipping at the peak | note the values you would ship |
| 11 | Safety: switch tab, unplug the wheel mid-corner, press pause | force ramps to zero, never a spike | all three go to zero smoothly |

Things to watch for specifically (each is a guess about what could be wrong, not a known fault):
- **Latency / rubber band.** The game limits the change of force to the full range per 30 ms and sends one report at a time;
  that is deliberate for safety but may feel soft. Compare quick left-right flicks against the picture on screen.
- **Clipping.** The scale is `tanh(torque / 450 N m)`; the GT3 reaches 75 % of full force at its limit and 58 % for the Vela GT.
  If the wheel feels dead at 100 % strength, or if it saturates early with the default Max, the 450 N m reference needs changing.
- **Centring when the game is paused** and when the page loses focus.
- **Which Logitech mode** (some wheels only accept the classic commands in native mode).

## Results (fill in)

| field | value |
|---|---|
| date, wheel, firmware / mode | |
| connected, driver named | |
| test pulse direction | |
| lock-to-lock, soft stop | |
| parked / straight quiet | |
| build-up with load | |
| understeer lightening | |
| slide catching | |
| crash jolt | |
| best Strength / Max / Damper / Friction / Road effects | |
| latency, clipping, other | |

When the table is filled in, change the "never done" row above and fix whatever the notes show (the code is
`web/src/ffb/`; the torque comes from `core/src/vehicle.cpp`, output buffer `[116]`).
