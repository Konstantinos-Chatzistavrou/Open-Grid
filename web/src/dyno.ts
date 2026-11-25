// Garage dyno: the car on a road-load chassis dyno, driven by the SAME physics as the road (core rs/dyno.hpp through
// CoreCar.dynoStep): it revs, shifts, sounds and reaches its true top speed while it stands on the rollers. A low
// steel platform under each axle, a drum under the driven wheels that turns at road speed, live readings and a
// power / torque graph. Keys: throttle / brake / shift as when driving, R a new run, Esc or the button to leave.
import * as THREE from 'three/webgpu';
import { OUT, type AssistToggles, type CoreCar, type RawInput } from './physics/core';

const STEP = 1 / 400;
const PLATFORM_H = 0.12;   // the car stands on the platforms this high
const DRUM_R = 0.32;       // drum radius (m); its top is flush with the platform

export class GarageDyno {
  active = false;
  /** metres the car visual is raised while on the dyno (the platforms) */
  lift = 0;
  readonly physPos = new THREE.Vector3();
  readonly physQuat = new THREE.Quaternion();
  private group = new THREE.Group();
  private drums: THREE.Object3D[] = [];
  private panel: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private fields: Record<string, HTMLElement> = {};
  private acc = 0;
  private uiAt = 0;
  private graphAt = 0;
  private redline = 8000;

  constructor(private onExit: () => void) {
    this.group.name = 'garage_dyno';
  }

  /**
   * Put the car on the dyno. parent: the garage scene, where the car model stands at the origin on the floor (y 0), nose
   * toward +z, in model space; cg: the model's CG offset (body frame -> model space). The host raises the model by
   * `lift` (the platforms).
   */
  enter(core: CoreCar, parent: THREE.Object3D, cg: THREE.Vector3) {
    core.dynoBegin();
    this.active = true;
    this.acc = 0;
    this.redline = core.info.redline;
    const idle: RawInput = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, shiftUp: false, shiftDown: false, device: 2 };
    const out = core.dynoStep(idle, { abs: true, tc: true, esc: true, autoGearbox: true }, STEP);
    this.readPose(core);
    this.buildRig(core, out, parent, cg);
    this.buildPanel();
  }

  exit(core: CoreCar) {
    if (!this.active) return;
    core.dynoEnd();
    this.active = false;
    this.lift = 0;
    this.group.removeFromParent();
    for (const m of this.group.children) (m as THREE.Mesh).geometry?.dispose();
    this.group.clear();
    this.drums = [];
    this.panel?.remove();
    this.panel = null;
  }

  /** Fixed 400 Hz steps for this frame. Returns the output buffer (same layout as a road step: audio, wheels, HUD). */
  step(core: CoreCar, raw: RawInput, assists: AssistToggles, frameDt: number): Float64Array {
    this.acc = Math.min(this.acc + frameDt, 0.1);
    let out = core.buf;
    let first = true;
    while (this.acc >= STEP) {
      out = core.dynoStep(first ? raw : { ...raw, shiftUp: false, shiftDown: false }, assists, STEP);
      first = false;
      this.acc -= STEP;
    }
    this.readPose(core);
    return out;
  }

  /** Per frame: turn the drums, refresh the readings (10 Hz) and the graph (4 Hz). */
  frame(core: CoreCar, out: Float64Array, frameDt: number, now: number) {
    const v = out[OUT.speed] || 0;
    for (const d of this.drums) d.rotateX((-v / DRUM_R) * frameDt);
    if (now - this.uiAt > 100) { this.uiAt = now; this.refreshReadings(core, out); }
    if (now - this.graphAt > 250) { this.graphAt = now; this.drawGraph(core); }
  }

  newRun(core: CoreCar) { core.dynoResetMeter(); this.drawGraph(core); }

  // ---------------------------------------------------------------- internals
  private readPose(core: CoreCar) {
    const p = core.dynoPose();
    this.physPos.set(p[0], p[1], p[2]);
    this.physQuat.set(p[3], p[4], p[5], p[6]);
  }

  /** Platforms under both axles, a drum under each driven axle, placed from the wheel centres the physics reports. */
  private buildRig(core: CoreCar, out: Float64Array, parent: THREE.Object3D, cg: THREE.Vector3) {
    this.lift = PLATFORM_H;
    const inv = this.physQuat.clone().invert();
    const local = [0, 1, 2, 3].map((i) => {
      const o = OUT.wheel(i);
      // body frame (three: x left, y up, z forward) -> model space (+ the CG offset)
      return new THREE.Vector3(out[o], out[o + 1], out[o + 2]).sub(this.physPos).applyQuaternion(inv).add(cg);
    });
    const axle = (a: number, b: number) => ({ mid: local[a].clone().add(local[b]).multiplyScalar(0.5), track: local[a].distanceTo(local[b]) });
    const front = axle(0, 1), rear = axle(2, 3);
    const steel = new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.75, roughness: 0.42 });
    const drumMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.95, roughness: 0.28 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.4, roughness: 0.6 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe6b422, metalness: 0.2, roughness: 0.55 });
    const add = (m: THREE.Mesh) => { m.castShadow = m.receiveShadow = true; this.group.add(m); return m; };
    const build = (ax: { mid: THREE.Vector3; track: number }, driven: boolean) => {
      const width = ax.track + 0.9, depth = 1.25;
      if (driven) {
        const gap = DRUM_R * 1.25;   // slot the drum shows through
        for (const s of [-1, 1]) {
          const len = (depth - gap) / 2;
          const slab = add(new THREE.Mesh(new THREE.BoxGeometry(width, PLATFORM_H, len), steel));
          slab.position.set(ax.mid.x, PLATFORM_H / 2, ax.mid.z + s * (gap / 2 + len / 2));
        }
        const drum = new THREE.Group();
        drum.add(add(new THREE.Mesh(new THREE.CylinderGeometry(DRUM_R, DRUM_R, width - 0.1, 48).rotateZ(Math.PI / 2), drumMat)));
        for (let k = 0; k < 8; k++) {   // knurl stripes, so the drum is seen to turn
          const st = new THREE.Mesh(new THREE.BoxGeometry(width - 0.08, 0.012, 0.05), stripeMat);
          const a = (k / 8) * Math.PI * 2;
          st.position.set(0, Math.cos(a) * (DRUM_R + 0.001), Math.sin(a) * (DRUM_R + 0.001));
          st.rotation.x = a;
          drum.add(st);
        }
        drum.position.set(ax.mid.x, PLATFORM_H - DRUM_R, ax.mid.z);
        this.group.add(drum);
        this.drums.push(drum);
      } else {
        add(new THREE.Mesh(new THREE.BoxGeometry(width, PLATFORM_H, depth), steel)).position.set(ax.mid.x, PLATFORM_H / 2, ax.mid.z);
      }
      for (const s of [-1, 1]) {   // yellow safety edges along the platform sides
        add(new THREE.Mesh(new THREE.BoxGeometry(0.06, PLATFORM_H + 0.004, depth), yellow)).position.set(ax.mid.x + s * (width / 2 - 0.03), PLATFORM_H / 2, ax.mid.z);
      }
    };
    build(front, core.info.driven.front);
    build(rear, core.info.driven.rear);
    // ramps in front of the front platform and behind the rear one
    const ramp = (z: number, dir: number, width: number) => {
      const len = 0.9;
      const r = add(new THREE.Mesh(new THREE.BoxGeometry(width, 0.025, Math.hypot(len, PLATFORM_H)), steel));
      r.position.set(front.mid.x, PLATFORM_H / 2, z + dir * len / 2);
      r.rotation.x = dir * Math.atan2(PLATFORM_H, len);
    };
    ramp(front.mid.z + 1.25 / 2, 1, front.track + 0.9);
    ramp(rear.mid.z - 1.25 / 2, -1, rear.track + 0.9);
    parent.add(this.group);   // model space = the garage's car spot (floor at y 0)
  }

  private buildPanel() {
    const el = document.createElement('div');
    el.id = 'dyno-panel';
    el.style.cssText = 'position:fixed;right:16px;top:72px;width:min(420px,calc(100vw - 32px));z-index:40;padding:14px 16px;'
      + 'background:rgba(12,13,16,.86);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e9ecf1;'
      + 'font:13px/1.35 system-ui,sans-serif;backdrop-filter:blur(6px)';
    const row = (k: string, label: string) => `<div style="display:flex;justify-content:space-between"><span style="opacity:.7">${label}</span><b data-k="${k}" style="font-variant-numeric:tabular-nums">-</b></div>`;
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="letter-spacing:.08em">DYNO</b><span style="opacity:.6;font-size:12px">road-load · same physics as the road</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;margin-bottom:10px">
        ${row('rpm', 'RPM')}${row('kmh', 'Speed')}${row('gear', 'Gear')}${row('kw', 'Wheel power')}
        ${row('nm', 'Torque (crank est.)')}${row('top', 'Top speed')}${row('pk', 'Peak power')}${row('pt', 'Peak torque')}
        ${row('t100', '0-100 km/h')}${row('dist', 'Rollers')}</div>
      <canvas width="388" height="190" style="width:100%;height:auto;background:rgba(255,255,255,.03);border-radius:6px"></canvas>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:8px">
        <span style="opacity:.6;font-size:12px">Throttle / brake / shift as driving · R new run</span>
        <span><button data-dyno="run" class="chip">New run</button> <button data-dyno="exit" class="primary">Exit dyno</button></span></div>`;
    el.querySelectorAll<HTMLElement>('[data-k]').forEach((n) => { this.fields[n.dataset.k!] = n; });
    this.canvas = el.querySelector('canvas');
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dyno]');
      if (b?.dataset.dyno === 'exit') this.onExit();
      if (b?.dataset.dyno === 'run') this.runRequested = true;
    });
    document.body.appendChild(el);
    this.panel = el;
  }
  runRequested = false;

  private refreshReadings(core: CoreCar, out: Float64Array) {
    const r = core.dynoReadout();
    const f = this.fields, kw = (w: number) => `${(w / 1000).toFixed(0)} kW · ${(w / 745.7).toFixed(0)} hp`;
    const g = out[OUT.gear];
    f.rpm.textContent = r.rpm.toFixed(0);
    f.kmh.textContent = `${(r.speed * 3.6).toFixed(1)} km/h`;
    f.gear.textContent = g === 0 ? 'R' : g === 1 ? 'N' : String(g - 1);
    f.kw.textContent = kw(Math.max(0, r.wheelPower));
    f.nm.textContent = `${Math.max(0, r.crankTorque).toFixed(0)} Nm`;
    f.top.textContent = r.topSpeed > 0 ? `${(r.topSpeed * 3.6).toFixed(1)} km/h` : '-';
    f.pk.textContent = r.peakPower > 0 ? `${kw(r.peakPower)} @ ${r.peakPowerRpm.toFixed(0)}` : '-';
    f.pt.textContent = r.peakTorque > 0 ? `${r.peakTorque.toFixed(0)} Nm @ ${r.peakTorqueRpm.toFixed(0)}` : '-';
    f.t100.textContent = r.zeroTo100 > 0 ? `${r.zeroTo100.toFixed(2)} s` : '-';
    f.dist.textContent = `${(r.distance / 1000).toFixed(2)} km`;
  }

  /** Wheel power (kW, left axis) and crank torque estimate (Nm, right axis) against rpm. */
  private drawGraph(core: CoreCar) {
    const c = this.canvas;
    if (!c) return;
    const g = c.getContext('2d')!;
    const W = c.width, H = c.height, L = 40, R = 44, T = 10, B = 24;
    g.clearRect(0, 0, W, H);
    const pts = core.dynoCurve();
    const maxP = Math.max(100, ...pts.map((p) => p[1] / 1000)) * 1.1, maxT = Math.max(100, ...pts.map((p) => p[2])) * 1.1;
    const x = (rpm: number) => L + (rpm / this.redline) * (W - L - R), yP = (kw: number) => T + (1 - kw / maxP) * (H - T - B), yT = (nm: number) => T + (1 - nm / maxT) * (H - T - B);
    g.strokeStyle = 'rgba(255,255,255,.08)'; g.fillStyle = 'rgba(233,236,241,.55)'; g.font = '11px system-ui'; g.lineWidth = 1;
    for (let rpm = 0; rpm <= this.redline; rpm += 1000) {
      g.beginPath(); g.moveTo(x(rpm), T); g.lineTo(x(rpm), H - B); g.stroke();
      if (rpm % 2000 === 0) g.fillText(String(rpm / 1000) + 'k', x(rpm) - 6, H - 8);
    }
    g.fillText(`${maxP.toFixed(0)} kW`, 2, T + 9); g.fillText(`${maxT.toFixed(0)} Nm`, W - R + 4, T + 9);
    const line = (col: string, y: (v: number) => number, k: 1 | 2) => {
      g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(x(p[0]), y(k === 1 ? p[1] / 1000 : p[2])) : g.moveTo(x(p[0]), y(k === 1 ? p[1] / 1000 : p[2]))));
      g.stroke();
    };
    if (pts.length > 1) { line('#ff5a3c', yP, 1); line('#4fb3ff', yT, 2); }
    g.fillStyle = '#ff5a3c'; g.fillText('power', L + 4, H - B - 6); g.fillStyle = '#4fb3ff'; g.fillText('torque', L + 50, H - B - 6);
  }
}
