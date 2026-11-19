// 5-Minute Cinematic Replay System & Camera Track Editor (Content Creator Suite — OpenGrid).
// Records a rolling 300-second circular buffer at 20 Hz (~6,000 frames, < 1 MB RAM) of the player car
// and nearby AI/traffic cars. Supports Play/Pause, scrubbing, speed (0.25x..2x), Chase/Bumper/TV Panning/
// Orbit/Custom Keyframe Camera Track (Catmull-Rom spline), Photo Mode jump-in, and WebM video export!
import * as THREE from 'three/webgpu';
import { t } from './i18n';

export type ReplayCamMode = 'chase' | 'bumper' | 'tv' | 'orbit' | 'track';

export interface ReplayFrame {
  t: number;
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  speed: number;
  rpm: number;
  steer: number;
  brake: number;
  ai: { x: number; y: number; z: number; yaw: number }[];
}

export interface CameraKeyframe {
  frameIdx: number;
  pos: THREE.Vector3;
  lookAt: THREE.Vector3;
  fov: number;
}

export interface ReplayHooks {
  onApplyFrame(f: ReplayFrame): void;
  onOpenPhoto(): void;
  onExportMotec(): void;
  onExit(): void;
  onToast(title: string, detail: string): void;
}

const SAMPLE_HZ = 20;
const MAX_SECONDS = 300; // 5-minute rolling replay buffer
const MAX_FRAMES = SAMPLE_HZ * MAX_SECONDS;

export class CinematicReplay {
  active = false;
  playing = true;
  speed = 1.0;
  camMode: ReplayCamMode = 'tv';
  cursor = 0; // float frame index
  keyframes: CameraKeyframe[] = [];

  private frames: ReplayFrame[] = [];
  private recAcc = 0;
  private recTime = 0;
  private el: HTMLElement;
  private orbitAz = 0.85;
  private tvAnchor = new THREE.Vector3();
  private tvAnchorFrame = -999;
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private lastUiAt = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: THREE.PerspectiveCamera,
    private hooks: ReplayHooks,
  ) {
    this.el = document.getElementById('replay-ui')!;
    this.bindDom();
  }

  get frameCount() { return this.frames.length; }
  get durationSec() { return this.frames.length / SAMPLE_HZ; }
  get isRecordingVideo() { return this.recorder?.state === 'recording'; }

  clear() {
    this.frames.length = 0;
    this.keyframes.length = 0;
    this.recAcc = 0;
    this.recTime = 0;
    this.cursor = 0;
  }

  /** Capture 20 Hz rolling 5-minute buffer while driving. */
  record(
    dt: number,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    speed: number,
    rpm: number,
    steer: number,
    brake: number,
    aiCars: { pos: THREE.Vector3; yaw: number }[],
  ) {
    if (this.active) return;
    this.recTime += dt;
    this.recAcc += dt;
    const step = 1 / SAMPLE_HZ;
    if (this.recAcc < step) return;
    this.recAcc = Math.min(this.recAcc - step, step);
    const frame: ReplayFrame = {
      t: this.recTime,
      px: pos.x, py: pos.y, pz: pos.z,
      qx: quat.x, qy: quat.y, qz: quat.z, qw: quat.w,
      speed, rpm, steer, brake,
      ai: aiCars.slice(0, 5).map((c) => ({ x: c.pos.x, y: c.pos.y, z: c.pos.z, yaw: c.yaw })),
    };
    if (this.frames.length >= MAX_FRAMES) this.frames.shift();
    this.frames.push(frame);
  }

  enter(): boolean {
    if (this.frames.length < 2) {
      this.hooks.onToast('REPLAY BUFFER EMPTY', 'Drive for a few seconds first to record a replay');
      return false;
    }
    this.active = true;
    this.playing = true;
    this.speed = 1.0;
    // Start 15 seconds before the end (or from start if shorter)
    this.cursor = Math.max(0, this.frames.length - SAMPLE_HZ * 15);
    this.tvAnchorFrame = -999;
    this.renderUi();
    this.el.hidden = false;
    document.body.classList.add('replaymode');
    return true;
  }

  exit() {
    if (!this.active) return;
    if (this.isRecordingVideo) this.stopVideoExport();
    this.active = false;
    this.el.hidden = true;
    document.body.classList.remove('replaymode');
    this.hooks.onExit();
  }

  /** Step replay playback & position the cinematic camera. */
  update(dt: number): ReplayFrame | null {
    if (!this.active || this.frames.length < 2) return null;
    if (this.playing) {
      this.cursor += dt * SAMPLE_HZ * this.speed;
      if (this.cursor >= this.frames.length - 1) {
        this.cursor = 0; // loop smoothly
      }
    }
    const i0 = Math.max(0, Math.min(this.frames.length - 2, Math.floor(this.cursor)));
    const i1 = i0 + 1;
    const f = this.cursor - i0;
    const a = this.frames[i0], b = this.frames[i1];

    const qa = new THREE.Quaternion(a.qx, a.qy, a.qz, a.qw);
    const qb = new THREE.Quaternion(b.qx, b.qy, b.qz, b.qw);
    qa.slerp(qb, f);
    const interp: ReplayFrame = {
      t: a.t + (b.t - a.t) * f,
      px: a.px + (b.px - a.px) * f,
      py: a.py + (b.py - a.py) * f,
      pz: a.pz + (b.pz - a.pz) * f,
      qx: qa.x, qy: qa.y, qz: qa.z, qw: qa.w,
      speed: a.speed + (b.speed - a.speed) * f,
      rpm: a.rpm + (b.rpm - a.rpm) * f,
      steer: a.steer + (b.steer - a.steer) * f,
      brake: a.brake + (b.brake - a.brake) * f,
      ai: a.ai.map((c, idx) => {
        const d = b.ai[idx] ?? c;
        return { x: c.x + (d.x - c.x) * f, y: c.y + (d.y - c.y) * f, z: c.z + (d.z - c.z) * f, yaw: d.yaw };
      }),
    };

    this.hooks.onApplyFrame(interp);
    this.updateCamera(dt, interp, qa);

    const now = performance.now();
    if (now - this.lastUiAt > 120) {
      this.lastUiAt = now;
      const scrub = this.el.querySelector<HTMLInputElement>('#rp-scrub');
      if (scrub) scrub.value = String(Math.round(this.cursor));
      const lbl = this.el.querySelector('#rp-time');
      if (lbl) lbl.textContent = `${(this.cursor / SAMPLE_HZ).toFixed(1)}s / ${(this.frames.length / SAMPLE_HZ).toFixed(1)}s · ${Math.round(Math.abs(interp.speed) * 3.6)} km/h`;
    }
    return interp;
  }

  private updateCamera(dt: number, fr: ReplayFrame, q: THREE.Quaternion) {
    const carPos = new THREE.Vector3(fr.px, fr.py, fr.pz);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0).normalize();

    if (this.camMode === 'track' && this.keyframes.length >= 2) {
      const sorted = [...this.keyframes].sort((x, y) => x.frameIdx - y.frameIdx);
      const pts = sorted.map((k) => k.pos);
      const looks = sorted.map((k) => k.lookAt);
      const minF = sorted[0].frameIdx, maxF = Math.max(minF + 1, sorted[sorted.length - 1].frameIdx);
      const u = Math.max(0, Math.min(1, (this.cursor - minF) / (maxF - minF)));
      const posCurve = new THREE.CatmullRomCurve3(pts);
      const lookCurve = new THREE.CatmullRomCurve3(looks);
      this.camera.position.copy(posCurve.getPoint(u));
      this.camera.lookAt(lookCurve.getPoint(u));
      return;
    }

    if (this.camMode === 'bumper') {
      this.camera.position.copy(carPos).addScaledVector(fwd, 2.05).add(new THREE.Vector3(0, 0.42, 0));
      this.camera.lookAt(carPos.clone().addScaledVector(fwd, 24).add(new THREE.Vector3(0, 0.4, 0)));
      this.camera.fov = 68;
      this.camera.updateProjectionMatrix();
      return;
    }

    if (this.camMode === 'chase') {
      this.camera.position.copy(carPos).addScaledVector(fwd, -5.6).add(new THREE.Vector3(0, 1.85, 0));
      this.camera.lookAt(carPos.clone().addScaledVector(fwd, 8).add(new THREE.Vector3(0, 0.65, 0)));
      this.camera.fov = 60;
      this.camera.updateProjectionMatrix();
      return;
    }

    if (this.camMode === 'orbit') {
      this.orbitAz += dt * 0.42;
      this.camera.position.set(
        carPos.x + Math.sin(this.orbitAz) * 6.5,
        carPos.y + 1.9,
        carPos.z + Math.cos(this.orbitAz) * 6.5,
      );
      this.camera.lookAt(carPos.x, carPos.y + 0.55, carPos.z);
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
      return;
    }

    // TV Trackside Panning camera: elevated sidewalk broadcast sweep (avoids direct headlight bloom glare)
    if (Math.abs(this.cursor - this.tvAnchorFrame) > SAMPLE_HZ * 5 || this.tvAnchor.distanceTo(carPos) > 55) {
      this.tvAnchorFrame = this.cursor;
      const side = (Math.floor(this.cursor / 60) % 2 === 0 ? 1 : -1) * 9.5;
      this.tvAnchor.copy(carPos).addScaledVector(fwd, 18).addScaledVector(right, side).add(new THREE.Vector3(0, 3.6, 0));
    }
    this.camera.position.copy(this.tvAnchor);
    this.camera.lookAt(carPos.x, carPos.y + 0.6, carPos.z);
    const dist = this.tvAnchor.distanceTo(carPos);
    this.camera.fov = Math.max(26, Math.min(54, 58 - dist * 0.45));
    this.camera.updateProjectionMatrix();
  }

  addKeyframe() {
    const idx = Math.round(this.cursor);
    const fr = this.frames[Math.min(this.frames.length - 1, Math.max(0, idx))];
    if (!fr) return;
    this.keyframes.push({
      frameIdx: idx,
      pos: this.camera.position.clone(),
      lookAt: new THREE.Vector3(fr.px, fr.py + 0.6, fr.pz),
      fov: this.camera.fov,
    });
    this.hooks.onToast('🎥 KEYFRAME ADDED', `${this.keyframes.length} camera points on spline track`);
    this.renderUi();
  }

  toggleVideoExport() {
    if (this.isRecordingVideo) { this.stopVideoExport(); return; }
    if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream) {
      this.hooks.onToast('EXPORT UNSUPPORTED', 'Browser MediaRecorder not available');
      return;
    }
    try {
      const stream = this.canvas.captureStream(30);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      this.recChunks = [];
      this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
      this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.recChunks.push(e.data); };
      this.recorder.onstop = () => {
        const blob = new Blob(this.recChunks, { type: 'video/webm' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `opengrid_replay_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        this.hooks.onToast('🎬 VIDEO EXPORTED', `${(blob.size / 1e6).toFixed(1)} MB WebM saved`);
        this.renderUi();
      };
      this.recorder.start(250);
      this.playing = true;
      this.hooks.onToast('🔴 RECORDING REPLAY', 'Click Stop Export when finished to download .webm');
      this.renderUi();
    } catch {
      this.hooks.onToast('EXPORT FAILED', 'Could not start canvas video capture');
    }
  }

  stopVideoExport() {
    if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
  }

  private bindDom() {
    this.el.addEventListener('input', (e) => {
      const inp = e.target as HTMLInputElement;
      if (inp?.id === 'rp-scrub') {
        this.cursor = Number(inp.value);
        this.playing = false;
      }
    });
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rp]');
      if (!b) return;
      const act = b.dataset.rp!;
      const v = b.dataset.v ?? '';
      if (act === 'play') { this.playing = !this.playing; this.renderUi(); }
      else if (act === 'spd') { this.speed = Number(v); this.renderUi(); }
      else if (act === 'cam') { this.camMode = v as ReplayCamMode; this.renderUi(); }
      else if (act === 'kf-add') { this.addKeyframe(); }
      else if (act === 'kf-clear') { this.keyframes.length = 0; this.renderUi(); }
      else if (act === 'photo') { this.playing = false; this.hooks.onOpenPhoto(); }
      else if (act === 'motec') { this.hooks.onExportMotec(); }
      else if (act === 'export') { this.toggleVideoExport(); }
      else if (act === 'exit') { this.exit(); }
    });
  }

  private renderUi() {
    const camBtn = (m: ReplayCamMode, lbl: string) =>
      `<button class="chip ${this.camMode === m ? 'on' : ''}" data-rp="cam" data-v="${m}">${lbl}</button>`;
    const spdBtn = (s: number) =>
      `<button class="chip ${this.speed === s ? 'on' : ''}" data-rp="spd" data-v="${s}">${s}×</button>`;
    this.el.innerHTML = `<div class="rp-bar">
      <div class="rp-top">
        <b>🎬 ${t('replay.title')}</b>
        <span id="rp-time">${(this.cursor / SAMPLE_HZ).toFixed(1)}s / ${(this.frames.length / SAMPLE_HZ).toFixed(1)}s</span>
        <div class="rp-btns">
          <button class="chip" data-rp="photo">📸 Photo</button>
          <button class="chip" data-rp="motec">📊 MoTeC .ld</button>
          <button class="chip ${this.isRecordingVideo ? 'on' : ''}" data-rp="export">${this.isRecordingVideo ? '⏹ Stop & Save .webm' : `🎥 ${t('replay.export_video')}`}</button>
          <button class="chip" data-rp="exit">Exit [T / Esc]</button>
        </div>
      </div>
      <input id="rp-scrub" type="range" min="0" max="${Math.max(1, this.frames.length - 1)}" value="${Math.round(this.cursor)}" />
      <div class="rp-row">
        <button class="primary small" data-rp="play">${this.playing ? '⏸ Pause' : '▶ Play'}</button>
        <span class="dim">SPEED</span>${[0.25, 0.5, 1, 2].map(spdBtn).join('')}
        <span class="dim">CAMERA</span>
        ${camBtn('tv', 'TV Pan')}${camBtn('chase', 'Chase')}${camBtn('bumper', 'Bumper')}${camBtn('orbit', 'Orbit')}${camBtn('track', `Track (${this.keyframes.length})`)}
        <button class="chip" data-rp="kf-add">+ Keyframe</button>
        ${this.keyframes.length ? '<button class="chip" data-rp="kf-clear">Clear</button>' : ''}
      </div>
    </div>`;
  }
}
