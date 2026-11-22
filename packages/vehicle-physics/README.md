# open-grid-physics

Drop-in realistic vehicle physics for the web. This is the C++ core that drives the cars in
[Open Grid](https://github.com/Konstantinos-Chatzistavrou/Open-Grid), compiled to WebAssembly (~370 KB), with a
small JS wrapper, a headless test harness and a bot API.

What the core models: Pacejka Magic Formula tyres fitted to real tyre data, with combined slip, load and camber
sensitivity, relaxation length and a 4 x 4 contact patch; heat and wear in the tyres; double-wishbone suspension
kinematics, anti-roll bars and bump stops; an engine torque curve with friction and inertia; clutch, synchronised
gearbox and a limited-slip differential; ABS, traction control and stability control as optional assists; aero
drag and downforce; fuel load; wet roads and aquaplaning; air density from temperature and altitude; crash damage.
It runs in fixed steps (240 Hz recommended) and costs well under a millisecond per car per frame.

The handling is checked against published road-test numbers on every change; see
[docs/validation.md](../../docs/validation.md) in the main repo.

**Status: 0.1, early.** The API can still change. Not yet on npm: install from the repo (below).

## How it fits into your game

Your physics engine (Rapier, cannon-es, Ammo, Jolt, your own) owns the car's rigid body and the world. Each fixed step:

1. Give the core the body's state (position, rotation, velocity, angular velocity).
2. It returns four suspension rays; raycast them in your world.
3. Give it the hits; it returns **one force and one torque** at the centre of gravity, in world space.
4. Apply them to the body. Add gravity yourself (or let your engine do it).

```js
import { loadPhysics } from 'open-grid-physics';

const physics = await loadPhysics();
const car = physics.createCar(await (await fetch('example_coupe.json')).text());
car.info;   // mass, principal inertia, CG height, redline, wheelbase... set your body up from these

const state = new Float64Array(13), contacts = new Float64Array(32);
function fixedStep(dt) {                      // dt = 1/240
  state.set([px, py, pz, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz]);   // world frame, quaternion x y z w
  const rays = car.rays(state);               // 4 wheels (FL, FR, RL, RR) x [from xyz, to xyz]
  for (let i = 0; i < 4; i++) {
    const hit = yourRaycast(rays.subarray(6 * i, 6 * i + 3), rays.subarray(6 * i + 3, 6 * i + 6));
    contacts.set(hit ? [1, ...hit.point, ...hit.normal, car.info.surfaces.asphalt] : [0, 0, 0, 0, 0, 0, 0, 0], 8 * i);
  }
  const out = car.step(contacts, { steer, throttle, brake, device: 0 }, dt);
  body.addForce(out.force);  body.addTorque(out.torque);           // world frame, at the CG
  // out.speed, out.rpm, out.gear, out.wheels[i].centre / steer / spin for drawing, .slipRatio, .load ...
}
```

Axes are three.js world axes: **Y up**, the car drives along its local **+Z**, and local **+X is the car's left**.
Steer +1 is full left. Units are SI.

The body's centre of mass must be at the origin of the car's frame, with the inertia from `car.info.inertia`
(principal axes: x left, y up, z forward). A complete working example with Rapier and three.js is in
[examples/three-rapier/](examples/three-rapier/).

Inputs (`car.step(contacts, input, dt, assists)`):

| input | range | notes |
|---|---|---|
| `steer` | -1 right .. +1 left | |
| `throttle`, `brake`, `clutch`, `handbrake` | 0 .. 1 | clutch 1 = pedal down |
| `shiftUp`, `shiftDown` | boolean | sequential shifts |
| `device` | 0 keyboard, 1 gamepad, 2 wheel | 0 and 1 get speed-sensitive steering filtering like a game; 2 passes steer straight through (use it for wheels and bots) |

Assists default to ABS and traction control on, automatic gearbox and clutch, stability control off:
`{ abs: true, tc: true, esc: false, autoGearbox: true, autoClutch: 'perfect' }`. With the automatic gearbox, holding
the brake at a standstill selects reverse, like most racing games.

Other calls: `car.resetMotion(speed, gear)` after you teleport the body, `car.repair()`, `car.setRoadWater(mm)`,
`car.setAtmosphere(airC, trackC, altitudeM, humidity)`, `car.contact(point, impulse, otherId)` for crashes.
Types are in [index.d.ts](index.d.ts).

## Cars

A car is a JSON file (`car/1`): chassis mass and inertia, both axles' suspension and hardpoints, tyres, brakes,
engine torque curve, gearbox, differential, aero. Start from [cars/example_coupe.json](cars/example_coupe.json), a
made-up 1.3 t rear-drive coupe: copy it, rename it, change the numbers. The game's own cars in
[data/cars/](../../data/cars/) use the same format (those are CC BY-NC 4.0).

## Bots

You can write a driver in plain JS and race it headless, no browser and no engine:

```js
export default function createBot() {
  return {
    name: 'my-bot',
    drive(o) {
      // o.speed, o.lateral (m, + = left of the centreline), o.headingError, o.yawRate, o.ahead[] (centreline points
      // 5..200 m ahead with curvature and position in the car's frame), o.wheels[] (slip, load), o.rpm, o.gear ...
      return { steer: -0.5 * o.headingError, throttle: 0.6, brake: 0 };
    },
  };
}
```

```sh
node examples/bot-race.mjs path/to/my-bot.js 3      # 3 laps of the example circuit
```

The race runs on flat ground at 240 Hz (a 3-lap race simulates in about a second and a half). Lap time counts; each
second spent more than a metre past the road edge adds two seconds. [bots/example_bot.js](bots/example_bot.js) does
about 1:04.2 per lap in the example coupe. Beat it. The full observation is documented in
[harness.d.ts](harness.d.ts) (`BotObservation`).

## Install and run

```sh
git clone --filter=blob:none https://github.com/Konstantinos-Chatzistavrou/Open-Grid.git
cd Open-Grid/packages/vehicle-physics
npm test                  # copies the WebAssembly build into dist/ and runs the checks
npm run brake-test        # 0-100 km/h, 60-0 mph, top speed of the example car
npm run bot-race          # the example bot, 3 laps
npx serve .               # then open http://localhost:3000/examples/three-rapier/
```

The `.wasm` is built from `core/` and `web/wasm/bridge.cpp` with `bash web/wasm/build.sh` (Emscripten); a prebuilt
copy is committed in `web/src/physics/`, so you only need Emscripten if you change the C++.

## Licences

- Code (this package, the core): Apache-2.0.
- `cars/example_coupe.json`, `routes/example_circuit.json`, `bots/example_bot.js`: CC0-1.0, except the Pacejka
  coefficients inside the example car's tyres, which come from Project Chrono's tyre data (BSD-3-Clause,
  [cars/LICENSE-projectchrono.txt](cars/LICENSE-projectchrono.txt)).
- Open Grid's own cars, maps and art are CC BY-NC 4.0 and are not part of this package.
