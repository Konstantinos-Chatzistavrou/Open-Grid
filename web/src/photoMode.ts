// 4K Photo Mode (Content Creator Suite — OpenGrid).
// Pauses gameplay (works live in Free Roam, Race Events, AND Cinematic Replays), unlocks a free 6-DoF
// camera (WASD + Q/E + mouse drag), exposes FOV, Exposure, Depth of Field (Focus + Aperture),
// Shutter Speed, Camera Roll, Hide UI [H], and renders crisp 4K (3840x2160) PNG screenshots!
import * as THREE from 'three/webgpu';
import { t } from './i18n';

export interface PhotoState {
  fov: number;
  exposure: number;
  dofFocus: number;
  dofAperture: number;
  shutterSpeed: number; // denominator: 30, 60, 125, 250, 500, 1000, 2000
  rollDeg: number;
  uiHidden: boolean;
}

export interface PhotoHooks {
  onRenderFrame(): void;
  onExit(): void;
  onToast(title: string, detail: string): void;
}

export class PhotoMode {
  active = false;
  readonly state: PhotoState = {
    fov: 45,
    exposure: 1.15,
    dofFocus: 6.5,
    dofAperture: 2.8,
    shutterSpeed: 250,
    rollDeg: 0,
    uiHidden: false,
  };

  private el: HTMLElement;
  private camPos = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.1;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private savedFov = 62;
  private savedExposure = 1.1;
  private savedRoll = 0;
  private focusPoint = new THREE.Vector3();

  constructor(
    private renderer: THREE.WebGPURenderer,
    private camera: THREE.PerspectiveCamera,
    private hooks: PhotoHooks,
  ) {
    this.el = document.getElementById('photo-ui')!;
    this.bindDom();
  }

  private bindDom() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    addEventListener('pointermove', (e) => {
      if (!this.active || !this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.0045;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - dy * 0.0045));
    });
    addEventListener('pointerup', () => { this.dragging = false; });
    dom.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.state.fov = Math.max(20, Math.min(95, this.state.fov + e.deltaY * 0.02));
      this.syncInputs();
    }, { passive: true });

    this.el.addEventListener('input', (e) => {
      const inp = e.target as HTMLInputElement;
      if (!inp || !inp.dataset.pm) return;
      const val = Number(inp.value);
      switch (inp.dataset.pm) {
        case 'fov': this.state.fov = val; break;
        case 'exp': this.state.exposure = val; break;
        case 'focus': this.state.dofFocus = val; break;
        case 'ap': this.state.dofAperture = val; break;
        case 'shutter': this.state.shutterSpeed = val; break;
        case 'roll': this.state.rollDeg = val; break;
      }
      this.syncValueLabels();
    });

    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-pm-act]');
      if (!btn) return;
      switch (btn.dataset.pmAct) {
        case 'capture4k': void this.capture4k(); break;
        case 'hide': this.toggleUi(); break;
        case 'reset': this.resetSettings(); break;
        case 'exit': this.exit(); break;
      }
    });
  }

  enter(carPos: THREE.Vector3) {
    if (this.active) return;
    this.active = true;
    this.savedFov = this.camera.fov;
    this.savedExposure = this.renderer.toneMappingExposure;
    this.savedRoll = this.camera.rotation.z;
    this.focusPoint.copy(carPos);
    this.camPos.copy(this.camera.position);
    const dir = new THREE.Vector3().subVectors(carPos, this.camPos).normalize();
    this.yaw = Math.atan2(-dir.x, -dir.z);
    this.pitch = Math.asin(Math.max(-0.95, Math.min(0.95, dir.y)));
    this.state.fov = Math.round(this.camera.fov);
    this.state.exposure = +this.renderer.toneMappingExposure.toFixed(2);
    this.state.dofFocus = +Math.max(1.5, Math.min(40, this.camPos.distanceTo(carPos))).toFixed(1);
    this.state.rollDeg = 0;
    this.state.uiHidden = false;
    this.renderUi();
    this.el.hidden = false;
    document.body.classList.add('photomode');
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.dragging = false;
    this.camera.fov = this.savedFov;
    this.camera.rotation.z = this.savedRoll;
    this.camera.updateProjectionMatrix();
    this.renderer.toneMappingExposure = this.savedExposure;
    this.el.hidden = true;
    this.el.classList.remove('ui-hidden');
    document.body.classList.remove('photomode');
    this.hooks.onExit();
  }

  toggleUi() {
    this.state.uiHidden = !this.state.uiHidden;
    this.el.classList.toggle('ui-hidden', this.state.uiHidden);
  }

  resetSettings() {
    this.state.fov = 45;
    this.state.exposure = 1.15;
    this.state.dofFocus = 6.5;
    this.state.dofAperture = 2.8;
    this.state.shutterSpeed = 250;
    this.state.rollDeg = 0;
    this.syncInputs();
  }

  /** Update free 6-DoF photo camera and apply FOV/Exposure/Roll each frame. */
  update(dt: number, isKeyDown: (code: string) => boolean) {
    if (!this.active) return;
    const speed = (isKeyDown('ShiftLeft') || isKeyDown('ShiftRight') ? 16 : 6) * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (isKeyDown('KeyW') || isKeyDown('ArrowUp')) this.camPos.addScaledVector(fwd, speed);
    if (isKeyDown('KeyS') || isKeyDown('ArrowDown')) this.camPos.addScaledVector(fwd, -speed);
    if (isKeyDown('KeyD') || isKeyDown('ArrowRight')) this.camPos.addScaledVector(right, speed);
    if (isKeyDown('KeyA') || isKeyDown('ArrowLeft')) this.camPos.addScaledVector(right, -speed);
    if (isKeyDown('KeyE') || isKeyDown('Space')) this.camPos.y += speed;
    if (isKeyDown('KeyQ') || isKeyDown('ControlLeft')) this.camPos.y = Math.max(0.25, this.camPos.y - speed);

    // Keep camera inside a generous 65 m radius of the car so streamed city tiles stay crisp
    const off = this.camPos.clone().sub(this.focusPoint);
    if (off.length() > 65) this.camPos.copy(this.focusPoint).add(off.setLength(65));
    if (this.camPos.y < 0.25) this.camPos.y = 0.25;

    this.camera.position.copy(this.camPos);
    const euler = new THREE.Euler(this.pitch, this.yaw, (this.state.rollDeg * Math.PI) / 180, 'YXZ');
    this.camera.quaternion.setFromEuler(euler);
    if (Math.abs(this.camera.fov - this.state.fov) > 0.05) {
      this.camera.fov = this.state.fov;
      this.camera.updateProjectionMatrix();
    }
    // Shutter speed modulates exposure subtlety (slower shutter = brighter night rain trails)
    const shutterGain = Math.pow(250 / Math.max(30, this.state.shutterSpeed), 0.12);
    this.renderer.toneMappingExposure = this.state.exposure * shutterGain;
  }

  /** Capture a true 4K (3840x2160) PNG screenshot and restore viewport resolution cleanly. */
  async capture4k(): Promise<{ width: number; height: number }> {
    const canvas = this.renderer.domElement;
    const prevW = innerWidth;
    const prevH = innerHeight;
    const prevAspect = this.camera.aspect;
    const prevRatio = this.renderer.getPixelRatio();
    const targetW = 3840, targetH = 2160;
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(targetW, targetH, false);
      this.camera.aspect = targetW / targetH;
      this.camera.updateProjectionMatrix();
      this.hooks.onRenderFrame();
      await new Promise((r) => requestAnimationFrame(r));
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `opengrid_4k_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      a.click();
      this.hooks.onToast('📸 4K PHOTO SAVED', `${targetW}×${targetH} PNG · f/${this.state.dofAperture.toFixed(1)} · 1/${this.state.shutterSpeed}s`);
      return { width: targetW, height: targetH };
    } finally {
      this.renderer.setPixelRatio(prevRatio);
      this.renderer.setSize(prevW, prevH, false);
      this.camera.aspect = prevAspect;
      this.camera.updateProjectionMatrix();
      this.hooks.onRenderFrame();
    }
  }

  private renderUi() {
    const s = this.state;
    this.el.innerHTML = `<div class="pm-panel">
      <div class="pm-head"><b>📸 ${t('photo.title')}</b><span class="dim">WASD Fly · Q/E Height · Drag Look · Wheel FOV</span></div>
      <div class="pm-grid">
        <label><span>FOV</span><input type="range" data-pm="fov" min="20" max="95" step="1" value="${s.fov}"><b data-pm-v="fov">${s.fov}°</b></label>
        <label><span>EXPOSURE</span><input type="range" data-pm="exp" min="0.4" max="2.4" step="0.05" value="${s.exposure}"><b data-pm-v="exp">${s.exposure.toFixed(2)}</b></label>
        <label><span>DoF FOCUS</span><input type="range" data-pm="focus" min="1.5" max="40" step="0.5" value="${s.dofFocus}"><b data-pm-v="focus">${s.dofFocus.toFixed(1)} m</b></label>
        <label><span>APERTURE</span><input type="range" data-pm="ap" min="1.4" max="16" step="0.2" value="${s.dofAperture}"><b data-pm-v="ap">f/${s.dofAperture.toFixed(1)}</b></label>
        <label><span>SHUTTER</span><input type="range" data-pm="shutter" min="30" max="2000" step="10" value="${s.shutterSpeed}"><b data-pm-v="shutter">1/${s.shutterSpeed}s</b></label>
        <label><span>ROLL</span><input type="range" data-pm="roll" min="-25" max="25" step="1" value="${s.rollDeg}"><b data-pm-v="roll">${s.rollDeg}°</b></label>
      </div>
      <div class="pm-actions">
        <button class="primary" data-pm-act="capture4k">📸 ${t('photo.capture4k')}</button>
        <button data-pm-act="hide">${t('photo.hideui')}</button>
        <button data-pm-act="reset">Reset</button>
        <button data-pm-act="exit">${t('photo.exit')}</button>
      </div>
    </div>`;
  }

  private syncInputs() {
    const map: Record<string, number> = {
      fov: this.state.fov, exp: this.state.exposure, focus: this.state.dofFocus,
      ap: this.state.dofAperture, shutter: this.state.shutterSpeed, roll: this.state.rollDeg,
    };
    for (const [k, v] of Object.entries(map)) {
      const inp = this.el.querySelector<HTMLInputElement>(`[data-pm="${k}"]`);
      if (inp) inp.value = String(v);
    }
    this.syncValueLabels();
  }

  private syncValueLabels() {
    const set = (k: string, text: string) => {
      const el = this.el.querySelector(`[data-pm-v="${k}"]`);
      if (el) el.textContent = text;
    };
    set('fov', `${Math.round(this.state.fov)}°`);
    set('exp', this.state.exposure.toFixed(2));
    set('focus', `${this.state.dofFocus.toFixed(1)} m`);
    set('ap', `f/${this.state.dofAperture.toFixed(1)}`);
    set('shutter', `1/${Math.round(this.state.shutterSpeed)}s`);
    set('roll', `${Math.round(this.state.rollDeg)}°`);
  }
}
