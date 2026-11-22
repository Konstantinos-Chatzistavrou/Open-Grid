// Apache-2.0. Headless helpers for open-grid-physics: a minimal rigid body on flat ground (no engine needed), and a
// bot race on a route/1 centreline with lap timing. Same integration scheme as web/tools/check_core.mjs.
//
// This is for tests, tuning and bot competitions. In a game, let your physics engine (Rapier, cannon-es, Ammo,
// Jolt...) own the body and do the raycasts; see examples/three-rapier/.

// ---- tiny vector / quaternion helpers (arrays, three.js conventions: quat = [x, y, z, w]) -------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
function qRotate(q, v) {
  const [x, y, z, w] = q, u = [x, y, z];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, w)), cross(u, t));
}
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
function qMul(a, b) {
  return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
function qNormalize(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]); return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; }
function qFromYaw(yaw) { return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]; }

export const GRAVITY = 9.81;

/**
 * One car as a free rigid body on the plane y = groundY. Fixed-step semi-implicit Euler with the spec's principal
 * inertia (body frame), the core's suspension rays raycast against the plane.
 */
export class FlatGroundCar {
  constructor(car, { position = [0, null, 0], yaw = 0, groundY = 0, surface = 0 } = {}) {
    this.car = car;
    this.groundY = groundY;
    this.surface = surface;
    this.pos = [position[0], position[1] ?? groundY + car.info.cgHeight, position[2]];
    this.quat = qFromYaw(yaw);
    this.vel = [0, 0, 0];
    this.angVel = [0, 0, 0];
    this.state = new Float64Array(13);
    this.contacts = new Float64Array(32);
    this.time = 0;
  }

  /** World direction the car points (+Z local) and its left (+X local). */
  forward() { return qRotate(this.quat, [0, 0, 1]); }
  left() { return qRotate(this.quat, [1, 0, 0]); }

  /**
   * Place the car at forward speed v (m/s) along its heading, wheels spinning to match. gear is a gearbox index
   * (0 reverse, 1 neutral, 2 first, ...); by default the highest gear that keeps the engine above ~55% of redline.
   */
  setSpeed(v, gear = this.car.gearFor(v)) {
    this.vel = scale(this.forward(), v);
    this.car.resetMotion(v, gear);
  }

  step(input, dt = 1 / 240, assists) {
    const s = this.state;
    s.set([...this.pos, ...this.quat, ...this.vel, ...this.angVel]);
    const r = this.car.rays(s);
    const c = this.contacts;
    for (let i = 0; i < 4; i++) {
      const fy = r[6 * i + 1], ty = r[6 * i + 4], o = 8 * i;
      const a = fy - this.groundY, b = ty - this.groundY;
      if (a > 0 && b <= 0) {
        const t = a / (a - b);
        c[o] = 1;
        c[o + 1] = r[6 * i] + (r[6 * i + 3] - r[6 * i]) * t;
        c[o + 2] = this.groundY;
        c[o + 3] = r[6 * i + 2] + (r[6 * i + 5] - r[6 * i + 2]) * t;
        c[o + 4] = 0; c[o + 5] = 1; c[o + 6] = 0; c[o + 7] = this.surface;
      } else {
        c[o] = 0;
      }
    }
    const out = this.car.step(c, input, dt, assists);
    const m = out.massKg > 0 ? out.massKg : this.car.info.mass;
    const I = this.car.info.inertia;
    // linear
    const F = [out.force[0], out.force[1] - m * GRAVITY, out.force[2]];
    this.vel = add(this.vel, scale(F, dt / m));
    // angular, in the body frame: I dw/dt = tau - w x Iw
    const qi = qConj(this.quat);
    const wb = qRotate(qi, this.angVel);
    const tb = qRotate(qi, out.torque);
    const Iw = [I[0] * wb[0], I[1] * wb[1], I[2] * wb[2]];
    const rhs = [tb[0] - cross(wb, Iw)[0], tb[1] - cross(wb, Iw)[1], tb[2] - cross(wb, Iw)[2]];
    const wb2 = [wb[0] + rhs[0] / I[0] * dt, wb[1] + rhs[1] / I[1] * dt, wb[2] + rhs[2] / I[2] * dt];
    this.angVel = qRotate(this.quat, wb2);
    this.pos = add(this.pos, scale(this.vel, dt));
    const ang = len(this.angVel) * dt;
    if (ang > 0) {
      const ax = scale(this.angVel, 1 / len(this.angVel));
      const h = Math.sin(ang / 2);
      this.quat = qNormalize(qMul([ax[0] * h, ax[1] * h, ax[2] * h, Math.cos(ang / 2)], this.quat));
    }
    this.time += dt;
    return out;
  }
}

// ---- Routes ------------------------------------------------------------------------------------------------------

/**
 * A route/1 centreline (core frame: Z up, right-handed) flattened onto the y = 0 plane in three.js axes:
 * three (x, y, z) = core (x, z, -y). Heading h becomes the direction (cos h, 0, -sin h); + curvature = left.
 */
export class FlatRoute {
  constructor(routeJson) {
    const r = typeof routeJson === 'string' ? JSON.parse(routeJson) : routeJson;
    if (r.schema !== 'route/1') throw new Error('not a route/1 file');
    this.name = r.name;
    this.closed = !!r.closed;
    this.samples = r.samples.map((p) => ({
      p: [p.x, 0, -p.y],
      dir: [Math.cos(p.heading), 0, -Math.sin(p.heading)],
      curvature: p.curvature,
      widthLeft: p.width_left,
      widthRight: p.width_right,
      s: 0,
    }));
    let s = 0;
    for (let i = 0; i < this.samples.length; i++) {
      if (i > 0) s += len(add(this.samples[i].p, scale(this.samples[i - 1].p, -1)));
      this.samples[i].s = s;
    }
    const n = this.samples.length;
    this.length = this.closed ? s + len(add(this.samples[0].p, scale(this.samples[n - 1].p, -1))) : s;
  }

  /** Start pose: on the first sample, facing along the route. */
  start() {
    const a = this.samples[0];
    return { position: [a.p[0], null, a.p[2]], yaw: Math.atan2(a.dir[0], a.dir[2]) };
  }

  /** Closest centreline point near index hint: { s, lateral (+ left), index, sample }. */
  project(p, hint = 0, window = 80) {
    const n = this.samples.length;
    let best = { d2: Infinity };
    const from = hint < 0 ? 0 : hint - 10, to = hint < 0 ? n : hint + window;
    for (let k = from; k < to; k++) {
      const i = ((k % n) + n) % n, j = (i + 1) % n;
      if (!this.closed && j === 0) continue;
      const a = this.samples[i].p, b = this.samples[j].p;
      const ab = [b[0] - a[0], 0, b[2] - a[2]], ap = [p[0] - a[0], 0, p[2] - a[2]];
      const L2 = ab[0] * ab[0] + ab[2] * ab[2];
      const t = L2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[2] * ab[2]) / L2)) : 0;
      const q = [a[0] + ab[0] * t, 0, a[2] + ab[2] * t];
      const d2 = (p[0] - q[0]) ** 2 + (p[2] - q[2]) ** 2;
      if (d2 < best.d2) best = { d2, i, t, q };
    }
    const smp = this.samples[best.i];
    const leftDir = [smp.dir[2], 0, -smp.dir[0]];   // rotate dir by +90 deg about +Y: (dx, dz) -> (dz, -dx)
    const lateral = (p[0] - best.q[0]) * leftDir[0] + (p[2] - best.q[2]) * leftDir[2];
    const segLen = len(add(this.samples[(best.i + 1) % this.samples.length].p, scale(smp.p, -1)));
    return { s: smp.s + best.t * segLen, lateral, index: best.i, sample: smp };
  }

  /** Sample at distance s along the route (nearest sample; wraps when closed). */
  at(s) {
    const L = this.length;
    let x = this.closed ? ((s % L) + L) % L : Math.max(0, Math.min(L, s));
    let lo = 0, hi = this.samples.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.samples[mid].s <= x) lo = mid; else hi = mid - 1; }
    return this.samples[lo];
  }
}

// ---- Bot race ----------------------------------------------------------------------------------------------------

const LOOKAHEAD_M = [5, 10, 15, 20, 30, 40, 50, 65, 80, 100, 125, 150, 200];

/**
 * What a bot sees each step. Car-frame vectors: x = left, z = forward (metres).
 * @returns observation object (see harness.d.ts)
 */
function observe(sim, out, route, proj, lap, info) {
  const fwd = sim.forward(), lft = sim.left();
  const toCar = (p) => {
    const d = [p[0] - sim.pos[0], 0, p[2] - sim.pos[2]];
    return { x: d[0] * lft[0] + d[2] * lft[2], z: d[0] * fwd[0] + d[2] * fwd[2] };
  };
  const smp = proj.sample;
  const carHeading = Math.atan2(fwd[0], fwd[2]), routeHeading = Math.atan2(smp.dir[0], smp.dir[2]);
  let headingError = carHeading - routeHeading;
  headingError = Math.atan2(Math.sin(headingError), Math.cos(headingError));
  return {
    time: sim.time,
    lap, s: proj.s, routeLength: route.length,
    speed: out.speed, rpm: out.rpm, gear: out.gear, redline: info.redline,
    lateral: proj.lateral, widthLeft: smp.widthLeft, widthRight: smp.widthRight,
    headingError,
    yawRate: sim.angVel[1],
    sideslip: out.sideslip,
    ahead: LOOKAHEAD_M.map((d) => {
      const a = route.at(proj.s + d), c = toCar(a.p);
      return { distance: d, curvature: a.curvature, x: c.x, z: c.z, widthLeft: a.widthLeft, widthRight: a.widthRight };
    }),
    wheels: out.wheels.map((w) => ({ slipRatio: w.slipRatio, slipAngle: w.slipAngle, load: w.load, contact: w.contact })),
    car: { wheelbase: info.wheelbase, maxSteerDeg: info.maxSteerDeg, mass: out.massKg },
  };
}

/**
 * Race one bot alone on a route, headless. bot = { name, drive(obs) -> {steer, throttle, brake, handbrake?,
 * shiftUp?, shiftDown?}, reset?(info) }. The ground is flat (route elevation ignored); being further off the
 * centreline than the road width plus 1 m counts as off track, and each second off track adds a 2 s penalty.
 */
export function runBotRace({ physics, carSpec, route, bot, laps = 1, dt = 1 / 240, maxTime = 600, assists }) {
  const car = physics.createCar(carSpec);
  const rt = route instanceof FlatRoute ? route : new FlatRoute(route);
  const start = rt.start();
  const sim = new FlatGroundCar(car, start);
  if (bot.reset) bot.reset({ car: car.info, route: { name: rt.name, length: rt.length, closed: rt.closed } });
  // settle on the springs (no pedals: with the automatic gearbox, brake at a standstill selects reverse)
  let out = null;
  for (let i = 0; i < Math.round(1 / dt); i++) out = sim.step({ handbrake: 1, device: 2 }, dt, assists);

  let hint = 0, lap = 0, lastS = 0, travelled = 0, offTrack = 0;
  const lapTimes = [];
  let lapStart = sim.time;
  let input = { steer: 0, throttle: 0, brake: 0 };
  while (sim.time < maxTime && lap < laps) {
    const proj = rt.project(sim.pos, hint);
    hint = proj.index;
    let ds = proj.s - lastS;
    if (rt.closed) { if (ds < -rt.length / 2) ds += rt.length; if (ds > rt.length / 2) ds -= rt.length; }
    travelled += ds;
    lastS = proj.s;
    if (travelled >= (lap + 1) * rt.length) {
      lapTimes.push(sim.time - lapStart);
      lapStart = sim.time;
      lap++;
      if (lap >= laps) break;
    }
    const halfWidth = proj.lateral >= 0 ? proj.sample.widthLeft : proj.sample.widthRight;
    if (Math.abs(proj.lateral) > halfWidth + 1.0) offTrack += dt;
    input = bot.drive(observe(sim, out, rt, proj, lap, car.info)) || input;
    // device 2 (wheel) passes steer straight through; the gamepad and keyboard devices add speed-sensitive filtering
    out = sim.step({ device: 2, ...input }, dt, assists);
    if (!Number.isFinite(sim.pos[0]) || sim.pos[1] < -50) break;
  }
  const finished = lap >= laps;
  const raceTime = lapTimes.reduce((a, b) => a + b, 0);
  return {
    bot: bot.name || 'bot', car: car.info.name, route: rt.name, finished, laps: lapTimes.length, lapTimes,
    bestLap: lapTimes.length ? Math.min(...lapTimes) : null,
    raceTime: finished ? raceTime : null, offTrackSeconds: offTrack,
    score: finished ? raceTime + 2 * offTrack : null,
    distance: travelled,
  };
}
