// Chase camera and a bumper camera.
//
// The spring acts on the camera's offset RELATIVE to the car, not on its world position: a world
// spring trails further behind the faster the car goes (~9 m at 144 km/h); a relative spring only
// reacts to ACCELERATION (the car pulls away under power, the camera closes in under braking) and
// to heading changes (the camera swings wide in corners and shows the car rotating).
//   r'' = k (r_target - r) - c r' - a_car
// a_car comes from the 400 Hz physics (low-passed there), not from per-frame differences, which
// jump whenever the number of physics ticks per frame changes.
// On top of the spring (ideas from Threejs-Punk Drive, docs/threejspunk_notes.md):
// - offset smoothing `o.lerp(target, 1 - exp(-SPRING_STRENGTH dt))` = the framerate-independent
//   form of `lerp(target, dt * k)`, applied to the car-RELATIVE offset (a world-space lerp would
//   trail with speed again). It mainly eases the camera back out after a wall pull-in, which used
//   to pop; pulling IN stays instant so the camera never clips into a wall.
// - FOV punch: +0..5 deg on throttle (weighted by forward acceleration), ~1 s in, slower out.
// - Redline shake: ROTATION only, 3-7 Hz smoothed noise, <= 0.15 deg, only within 3 % of the
//   redline. The old high-frequency shake aliased into judder at 30 fps; at <= 7 Hz a 30 fps
//   frame rate still samples each wobble 4+ times, so it reads as engine strain, not stutter.
import * as THREE from 'three/webgpu';
import { GROUP_VIEW, type PhysicsWorld } from './physics/world';
import type RAPIER from '@dimforge/rapier3d-compat';
import { OUT } from './physics/core';

const UP = new THREE.Vector3(0, 1, 0);
const OMEGA = 7.2;          // rad/s: spring natural frequency (tighter response so steering never feels rubbery)
const ZETA = 0.88;          // damping ratio
const MAX_LAG = 1.1;        // m: cap on how far the camera can stray from its rest offset
const DIST = 6.2, HEIGHT = 2.0, LOOK_AHEAD = 2.5, LOOK_HEIGHT = 0.9;
const SPRING_STRENGTH = 20; // 1/s: relative-offset smoothing
const PUNCH_DEG = 4, PUNCH_IN = 3, PUNCH_OUT = 2;   // FOV punch: max, attack/release rates
const FOV_EXTRA_MAX = 11;   // deg: cap on speed FOV + punch together (keeps high-speed frustum expansion reasonable)
const SHAKE_DEG = 0.15, SHAKE_BAND = 0.03;          // redline shake: max amplitude, rpm window below redline
const D2R = Math.PI / 180;

/** Smooth 1D value noise in [-1, 1]: random values at integer knots, smoothstep between them.
 *  Sampled at t * f it has its energy at and below ~f Hz (no high-frequency content). */
function vnoise(x: number, seed: number) {
  const h = (i: number) => { const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}

export type CamMode = 'chase' | 'far' | 'cinematic' | 'drift' | 'free' | 'hood' | 'cockpit' | 'bumper' | 'orbit';
/** Every view the rig offers, in the order C cycles them: NFS-style chase, a wider chase, a low
 *  cinematic, a drift cam, a persistent Free Cam (stays where you drag it), hood, bumper, and orbit. */
const MODES: CamMode[] = ['chase', 'far', 'cinematic', 'drift', 'free', 'hood', 'cockpit', 'bumper', 'orbit'];
const MODE_CFG: Record<CamMode, { dist: number; height: number; kind: 'chase' | 'bumper' | 'orbit'; drift?: boolean; holdFree?: boolean }> = {
  chase: { dist: DIST, height: HEIGHT, kind: 'chase' },
  far: { dist: DIST * 1.45, height: HEIGHT + 0.35, kind: 'chase' },
  cinematic: { dist: DIST * 1.85, height: HEIGHT * 0.45, kind: 'chase' },
  // drift: the chase spring, but the heading follows the VELOCITY direction, so a sliding car
  // stays broadside in frame instead of the camera snapping round to face where it points
  drift: { dist: DIST * 1.12, height: HEIGHT * 0.78, kind: 'chase', drift: true },
  // free: AAA free-orbit driving camera — drag by mouse/touch to lock any angle & zoom without auto-recenter
  free: { dist: DIST * 1.08, height: HEIGHT * 0.96, kind: 'chase', holdFree: true },
  hood: { dist: 0, height: 0, kind: 'bumper' },
  cockpit: { dist: 0, height: 0, kind: 'bumper' },
  bumper: { dist: 0, height: 0, kind: 'bumper' },
  orbit: { dist: 7.6, height: 2.3, kind: 'orbit' },
};
export { MODES };

export class CameraRig {
  mode: CamMode = 'chase';
  private first = true;
  private heading = new THREE.Vector3(0, 0, 1);   // lagged ground-plane heading
  private r = new THREE.Vector3();                // camera offset from the car (world axes)
  private rv = new THREE.Vector3();
  private fov = 60;
  private o = new THREE.Vector3();                // smoothed relative offset (after wall pull-in)
  private fwd = new THREE.Vector3();
  private flat = new THREE.Vector3();
  private rTarget = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private want = new THREE.Vector3();
  private head = new THREE.Vector3();
  private bumperQ = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
  /** cockpit view: a touch of downward pitch so the dash and screen sit in frame */
  private cockpitTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.07);
  private punch = 0;                              // deg
  private shake = 0;                              // 0..1 redline shake envelope
  private t = 0;
  /** orbit showcase: radians per second the camera walks around the car */
  orbitSpeed = 0.18;
  private orbitAngle = 0;
  // Interactive AAA free-look offsets (mouse/touch drag & wheel zoom while driving)
  private freeYaw = 0;
  private freePitch = 0;
  private freeZoom = 0;
  private freeDragging = false;
  private freeHoldUntil = 0;
  private lookQ = new THREE.Quaternion();
  private lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(readonly camera: THREE.PerspectiveCamera, private pw: PhysicsWorld, private car: RAPIER.RigidBody, private redline = 7000) {}

  /** A different car (garage swap): follow its body, snap to it. */
  setTarget(car: RAPIER.RigidBody, redline: number) { this.car = car; this.redline = redline; this.first = true; }
  snap() { this.first = true; }

  setMode(m: CamMode) { this.mode = m; this.first = true; this.resetFreeLook(); }
  toggle() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); }

  /** Interactive free-look controls (mouse or touch drag on canvas while driving). */
  beginFreeLook() { this.freeDragging = true; this.freeHoldUntil = performance.now() + 2600; }
  dragFreeLook(dx: number, dy: number) {
    const cfg = MODE_CFG[this.mode];
    if (cfg.kind === 'orbit') {
      this.orbitAngle -= dx * 0.007;
      this.freePitch = Math.max(-0.22, Math.min(0.65, this.freePitch + dy * 0.0045));
    } else if (cfg.kind === 'bumper') {
      this.freeYaw = Math.max(-1.85, Math.min(1.85, this.freeYaw - dx * 0.0055));
      this.freePitch = Math.max(-0.22, Math.min(0.42, this.freePitch - dy * 0.004));
    } else {
      this.freeYaw -= dx * 0.007;
      // Keep yaw wrapped in [-PI, PI] for shortest-path auto-recenter
      while (this.freeYaw > Math.PI) this.freeYaw -= Math.PI * 2;
      while (this.freeYaw < -Math.PI) this.freeYaw += Math.PI * 2;
      this.freePitch = Math.max(-0.18, Math.min(0.72, this.freePitch + dy * 0.0045));
    }
    this.freeHoldUntil = performance.now() + 2600;
  }
  endFreeLook() { this.freeDragging = false; this.freeHoldUntil = performance.now() + 2600; }
  zoomFreeLook(deltaY: number) {
    this.freeZoom = Math.max(-2.2, Math.min(4.5, this.freeZoom + deltaY * 0.004));
  }
  resetFreeLook() { this.freeYaw = 0; this.freePitch = 0; this.freeZoom = 0; this.freeDragging = false; this.freeHoldUntil = 0; }

  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, carAcc: THREE.Vector3, out: Float64Array) {
    dt = Math.min(dt, 1 / 20);
    const cam = this.camera;
    const speed = out[OUT.speed];
    this.t += dt;
    const fwd = this.fwd.set(0, 0, 1).applyQuaternion(carQuat);

    // FOV punch: throttle, weighted by forward acceleration so it fades at top speed / on the limiter
    const aFwd = carAcc.dot(fwd);
    const punchTarget = PUNCH_DEG * Math.max(0, out[OUT.throttle]) * (0.35 + 0.65 * Math.min(1, Math.max(0, aFwd / 4)));
    this.punch += (punchTarget - this.punch) * (1 - Math.exp(-dt * (punchTarget > this.punch ? PUNCH_IN : PUNCH_OUT)));
    // redline shake envelope: eases in/out (~0.15 s) so a brief touch of the limiter is a nudge
    const onRedline = out[OUT.rpm] >= this.redline * (1 - SHAKE_BAND) ? 1 : 0;
    this.shake += (onRedline - this.shake) * (1 - Math.exp(-dt * 7));

    const cfg = MODE_CFG[this.mode];
    // Auto-recenter free-look gently when driving forward after ~2.6 s idle (never in persistent 'free' mode!)
    if (!this.freeDragging && !cfg.holdFree && performance.now() > this.freeHoldUntil && Math.abs(speed) > 3.5) {
      const k = 1 - Math.exp(-dt * 2.8);
      this.freeYaw *= 1 - k;
      this.freePitch *= 1 - k;
      if (Math.abs(this.freeYaw) < 0.003) this.freeYaw = 0;
      if (Math.abs(this.freePitch) < 0.003) this.freePitch = 0;
    }

    if (cfg.kind === 'bumper') {
      const hood = this.mode === 'hood';
      const cockpit = this.mode === 'cockpit';
      // cockpit: behind the wheel at driver eye height (~1.1 m above the road: carPos is the body centre, ~0.45 m up), so the dash-mounted nav screen is in frame
      cam.position.copy(carPos).add(this.tmp.set(cockpit ? 0.33 : 0, cockpit ? 0.66 : hood ? 1.05 : 0.62, cockpit ? 0.02 : hood ? 0.95 : 0.25).applyQuaternion(carQuat));
      cam.quaternion.copy(carQuat).multiply(this.bumperQ);
      if (cockpit) cam.quaternion.multiply(this.cockpitTilt);
      if (Math.abs(this.freeYaw) > 1e-4 || Math.abs(this.freePitch) > 1e-4) {
        this.lookEuler.set(this.freePitch, this.freeYaw, 0, 'YXZ');
        this.lookQ.setFromEuler(this.lookEuler);
        cam.quaternion.multiply(this.lookQ);
      }
      this.applyShake(hood ? 0.35 : 0.45);     // subtler: the view already moves with the body
      this.setFov(hood ? 68 : 72, this.speedFov(speed) * 0.6, this.punch * 0.6, FOV_EXTRA_MAX * 0.6, dt);
      this.first = true;
      return;
    }

    // orbit: walk around the car at a fixed radius/height and look at it. Dragging overrides the angle interactively!
    if (cfg.kind === 'orbit') {
      if (!this.freeDragging) this.orbitAngle += this.orbitSpeed * dt;
      const head = this.head.copy(carPos).addScaledVector(UP, 1.0);
      const dist = Math.max(3.6, cfg.dist + this.freeZoom);
      const h = Math.max(0.7, cfg.height + Math.sin(this.freePitch) * dist * 0.7);
      const want = this.want.copy(carPos).addScaledVector(UP, h)
        .add(this.tmp.set(Math.sin(this.orbitAngle) * dist, 0, Math.cos(this.orbitAngle) * dist));
      const hit = this.pw.raycast(head, want, this.car, true, GROUP_VIEW);
      if (hit) {
        const d = head.distanceTo(want);
        const f = Math.max(0.15, Math.min(1, (hit.toi - 0.4) / d));
        want.lerpVectors(head, want, f);
      }
      cam.position.copy(want);
      cam.lookAt(this.tmp.copy(carPos).addScaledVector(UP, LOOK_HEIGHT));
      this.applyShake(0.4);
      this.setFov(55, 0, 0, 0, dt);
      this.first = true;
      return;
    }

    // heading (lagged): a car on its nose/tail has no ground heading; keep the last
    const flat = this.flat.set(fwd.x, 0, fwd.z);
    // drift cam: follow where the car is GOING (velocity), not where it points, so a slide reads
    // as the car rotating in frame. Below walking pace the velocity direction is noise, so fall
    // back to the car's facing.
    if (cfg.drift && Math.abs(speed) >= 3) {
      const lv = this.car.linvel();
      flat.set(lv.x, 0, lv.z);
    }
    if (flat.lengthSq() > 0.04) {
      flat.normalize();
      if (this.first) this.heading.copy(flat);
      else this.heading.lerp(flat, 1 - Math.exp(-dt * 10)).normalize();
    }
    const baseDist = Math.max(3.4, cfg.dist + this.freeZoom);
    const basePitch = Math.atan2(cfg.height, baseDist);
    const effPitch = Math.max(0.05, Math.min(1.08, basePitch + this.freePitch));
    const horizDist = Math.cos(effPitch) * baseDist;
    const vertH = Math.sin(effPitch) * baseDist;
    const baseYaw = Math.atan2(-this.heading.x, -this.heading.z) + this.freeYaw;
    const rTarget = this.rTarget.set(Math.sin(baseYaw) * horizDist, vertH, Math.cos(baseYaw) * horizDist);

    const freeActive = this.freeDragging || Math.abs(this.freeYaw) > 0.01 || Math.abs(this.freePitch) > 0.01 || cfg.holdFree;
    if (this.first || freeActive) {
      // Responsive direct orbit tracking when player drags the free camera (zero sluggish rubber-banding)
      const follow = this.first ? 1 : 1 - Math.exp(-dt * 18);
      this.r.lerp(rTarget, follow);
      this.rv.set(0, 0, 0);
    } else {
      // semi-implicit Euler in sub-steps of <= 1/120 s: stable at any frame rate
      const k = OMEGA * OMEGA, c = 2 * ZETA * OMEGA;
      const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
      for (let i = 0; i < n; i++) {
        const f = this.tmp.copy(rTarget).sub(this.r).multiplyScalar(k).addScaledVector(this.rv, -c).sub(carAcc);
        this.rv.addScaledVector(f, h);
        this.r.addScaledVector(this.rv, h);
      }
      const err = this.tmp.copy(this.r).sub(rTarget);
      if (err.length() > MAX_LAG) this.r.copy(rTarget).add(err.setLength(MAX_LAG));
    }
    const want = this.want.copy(carPos).add(this.r);

    // keep the camera out of walls: pull it in along the car->camera line
    const head = this.head.copy(carPos).addScaledVector(UP, 1.0);
    const hit = this.pw.raycast(head, want, this.car, true, GROUP_VIEW);   // poles / trees don't yank the camera in
    let wall = Infinity;                         // max allowed distance from `head`
    if (hit) {
      const dist = head.distanceTo(want);
      const f = Math.max(0.15, Math.min(1, (hit.toi - 0.4) / dist));   // measure BEFORE moving want
      wall = f * dist;
      want.lerpVectors(head, want, f);
    }

    // relative-offset smoothing: o.lerp(target, 1 - exp(-k dt)); in towards a wall is instant
    const rel = want.sub(head);
    if (this.first) this.o.copy(rel);
    else this.o.lerp(rel, 1 - Math.exp(-dt * SPRING_STRENGTH));
    if (this.o.length() > wall) this.o.setLength(wall);

    cam.position.copy(head).add(this.o);
    // When looking sideways/backwards via free-look, center the aim cleanly on the car instead of ahead of the hood
    const lookAheadScale = Math.max(0, Math.cos(this.freeYaw));
    cam.lookAt(this.tmp.copy(carPos).addScaledVector(this.heading, LOOK_AHEAD * lookAheadScale).addScaledVector(UP, LOOK_HEIGHT));
    this.applyShake(1);
    this.setFov(60, this.speedFov(speed), this.punch, FOV_EXTRA_MAX, dt);
    this.first = false;
  }

  /** Low-frequency rotational shake (never position): two octaves of value noise at 3.5 and
   *  6.5 Hz, independent per axis, scaled by the redline envelope. */
  private applyShake(gain: number) {
    const a = this.shake * gain * SHAKE_DEG * D2R;
    if (a < 1e-6) return;
    const n = (seed: number) => (vnoise(this.t * 3.5, seed) * 0.7 + vnoise(this.t * 6.5, seed + 9) * 0.3);
    this.camera.rotateX(n(1) * a);
    this.camera.rotateY(n(2) * a * 0.8);
    this.camera.rotateZ(n(3) * a * 0.6);
  }

  /** +0..10 degrees from 60 km/h up (sense of speed). */
  private speedFov(speed: number) { return Math.min(10, Math.max(0, Math.abs(speed) * 3.6 - 60) * 0.06); }

  /** base + speed FOV is eased here; `punch` arrives already eased (own attack/release). Speed
   *  FOV + punch together never exceed `cap` degrees above the mode's base. */
  private setFov(base: number, speedExtra: number, punch: number, cap: number, dt: number) {
    this.fov += (base + speedExtra - this.fov) * (1 - Math.exp(-dt * 3));
    const fov = Math.min(this.fov + punch, base + cap);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
