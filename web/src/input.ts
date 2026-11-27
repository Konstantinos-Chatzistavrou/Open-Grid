// Every input device -> core RawInput (shaping happens in the core's Controls, not here). The last device touched
// drives: keyboard, gamepad (Xbox / PlayStation / Switch / generic, standard mapping), steering wheel (calibrated axes,
// paddles, H-shifter; force feedback in ffb/), touch or tilt on phones. See devices.ts.
import { OUT, type AssistToggles, type RawInput } from './physics/core';
import type { TouchControls } from './touch';
import { BTN, PAD_LABELS, axisValue, classify, defaultCalibration, deviceKey, loadSettings, saveSettings,
  type ControlsSettings, type DeviceKind, type PadFamily, type WheelModel } from './devices';

type RumblePad = Gamepad & { vibrationActuator?: { playEffect(t: string, o: object): Promise<unknown> } };

export type BindAction =
  | 'throttle' | 'brake' | 'steerLeft' | 'steerRight'
  | 'shiftUp' | 'shiftDown' | 'handbrake' | 'clutch' | 'lineLock'
  | 'reset' | 'camera' | 'lights' | 'flash' | 'stake' | 'board'
  | 'photo' | 'replay' | 'carMeet' | 'stepOut' | 'interact'
  | 'hud' | 'map' | 'garage' | 'pause';

export const DEFAULT_KEY_BINDS: Record<BindAction, string> = {
  throttle: 'KeyW',
  brake: 'KeyS',
  steerLeft: 'KeyA',
  steerRight: 'KeyD',
  shiftUp: 'KeyE',
  shiftDown: 'KeyQ',
  handbrake: 'Space',
  lineLock: 'KeyK',
  clutch: 'ShiftLeft',
  reset: 'KeyR',
  camera: 'KeyC',
  lights: 'KeyL',
  flash: 'KeyF',
  stake: 'KeyV',
  board: 'KeyB',
  photo: 'KeyP',
  replay: 'KeyT',
  carMeet: 'KeyU',
  stepOut: 'KeyO',
  interact: 'Enter',
  hud: 'KeyH',
  map: 'KeyM',
  garage: 'KeyG',
  pause: 'Escape',
};

export const DEFAULT_PAD_BINDS: Record<BindAction, number> = {
  throttle: BTN.rt,
  brake: BTN.lt,
  steerLeft: -1,
  steerRight: -1,
  shiftUp: BTN.rb,
  shiftDown: BTN.lb,
  handbrake: BTN.a,
  lineLock: -1,
  clutch: -1,
  reset: BTN.b,
  camera: BTN.y,
  lights: BTN.x,
  flash: BTN.ls,
  stake: BTN.left,
  board: BTN.right,
  photo: BTN.up,
  replay: BTN.down,
  carMeet: BTN.rs,
  stepOut: -1,
  interact: BTN.a,
  hud: BTN.back,
  map: -1,
  garage: -1,
  pause: BTN.start,
};

const BINDS_KEY = 'nr.binds.v1';

export class Input {
  readonly raw: RawInput = { steer: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0, lineLock: 0, shiftUp: false, shiftDown: false, device: 0, directGear: -99 };
  readonly assists: AssistToggles = { abs: true, tc: true, esc: false, autoGearbox: true };
  readonly settings: ControlsSettings = loadSettings();
  keyBinds: Record<BindAction, string> = { ...DEFAULT_KEY_BINDS };
  padBinds: Record<BindAction, number> = { ...DEFAULT_PAD_BINDS };
  /** When set by ControlsUi, the next key or pad button press remaps this action instead of driving. */
  listeningBind: { kind: 'key' | 'pad'; action: BindAction; onDone: () => void } | null = null;
  private keys = new Set<string>();
  private pending = { up: false, down: false };
  private padPrev = new Map<number, boolean[]>();
  private padCur = new Map<number, boolean[]>();
  private padsBuf: Gamepad[] = [];
  /** After a spawn the car is held on the brake until the first throttle input (start on a hill). */
  hold = true;
  /** Keeps the hold on (throttle ignored) while the renderer calibrates its resolution. */
  locked = false;
  touch: TouchControls | null = null;
  private source: DeviceKind = 'keys';
  /** the pad / wheel that last moved (Gamepad API index) */
  activeIndex = -1;
  private activeId = '';
  private anchors = new Map<number, { id: string; axes: number[]; buttons: number[] }>();
  family: PadFamily = 'generic';
  wheel: { model: WheelModel; key: string } | null = null;
  /** steering wheel position as a fraction of the car's lock (+ left; beyond +-1 = past the lock) and its speed */
  wheelPos = 0;
  wheelVel = 0;
  onAnyInput = () => {};
  onReset = () => {};
  onCamera = () => {};
  onHud = () => {};
  onLights = () => {};
  /** Headlight flash (KeyF or double-tap KeyL): triggers spontaneous 1v1 street drag wagers in Free Roam. */
  onFlash = () => {};
  /** Toggle spontaneous wager stake between Cash ($5,000) and Pink Slip (KeyV). */
  onStakeToggle = () => {};
  /** Toggle the Speed Trap & Drift Zone leaderboard overlay (KeyB). */
  onBoard = () => {};
  /** Open / close 4K Photo Mode (KeyP). */
  onPhoto = () => {};
  /** Open / close 5-minute Cinematic Replay Editor (KeyT). */
  onReplay = () => {};
  /** Toggle 5-Floor Car Meet RP Hub / Hood / Trunk / Radio panel (KeyU). */
  onCarMeet = () => {};
  /** Step out of car / get back in (walkable driver avatar in Car Meet, KeyO). */
  onStepOut = () => {};
  /** Open Underground Street Radio chat transmit bar (KeyY). */
  onRadioChat = () => {};
  /** Interact with nearby Free Roam Race Node to enter Matchmaking Lobby (Enter). */
  onInteract = () => {};
  /** Expand / collapse full-screen interactive map for GPS waypoints (Tab). */
  onFullMap = () => {};
  /** Walkie-talkie voice Push-to-Talk down/up (KeyZ). */
  onVoicePtt: (down: boolean) => void = () => {};
  onGarage = () => {};
  private lastLightTap = 0;
  onPause = () => {};
  onMap = () => {};
  /** an assist quick key (1 2 3 5) changed input.assists */
  onAssistKey = () => {};
  /** the active device changed (HUD help line, menus) */
  onDevice = () => {};
  /** set by the controls menu while it calibrates: game actions from pads / wheels are off */
  suspended = false;
  /** When 2-player local split-screen is active, P1 uses Pad #1 (with 2+ pads) or WASD (leaving Arrows + Pad #2 for P2). */
  splitScreen = false;
  /** Right analog stick deflection (-1..1) for smooth TV/couch free-look camera orbit. */
  rightStick = { x: 0, y: 0 };

  constructor() {
    this.loadBinds();
    addEventListener('keydown', (e) => {
      if (e.repeat || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (this.listeningBind?.kind === 'key') {
        e.preventDefault();
        if (e.code !== 'Escape') { this.keyBinds[this.listeningBind.action] = e.code; this.saveBinds(); }
        const done = this.listeningBind.onDone;
        this.listeningBind = null;
        done();
        return;
      }
      this.keys.add(e.code);
      this.setSource('keys');
      this.onAnyInput();
      const b = this.keyBinds;
      if (e.code === b.shiftUp) this.pending.up = true;
      else if (e.code === b.shiftDown) this.pending.down = true;
      else if (e.code === b.reset) this.onReset();
      else if (e.code === b.camera) this.onCamera();
      else if (e.code === b.hud) this.onHud();
      else if (e.code === b.map) this.onMap();
      else if (e.code === b.lights) {
        const now = performance.now();
        if (now - this.lastLightTap < 450) { this.lastLightTap = 0; this.onFlash(); }
        else { this.lastLightTap = now; this.onLights(); }
      }
      else if (e.code === b.flash) this.onFlash();
      else if (e.code === b.stake) this.onStakeToggle();
      else if (e.code === b.board) this.onBoard();
      else if (e.code === b.photo) this.onPhoto();
      else if (e.code === b.replay) this.onReplay();
      else if (e.code === b.carMeet) this.onCarMeet();
      else if (e.code === b.stepOut) this.onStepOut();
      else if (e.code === b.interact) this.onInteract();
      else if (e.code === 'Tab') { e.preventDefault(); this.onFullMap(); }
      else if (e.code === 'KeyY') { e.preventDefault(); this.onRadioChat(); }
      else if (e.code === 'KeyZ') this.onVoicePtt(true);
      else if (e.code === b.garage) this.onGarage();
      else if (e.code === 'Digit1') { this.assists.abs = !this.assists.abs; this.onAssistKey(); }
      else if (e.code === 'Digit2') { this.assists.tc = !this.assists.tc; this.onAssistKey(); }
      else if (e.code === 'Digit3') { this.assists.esc = !this.assists.esc; this.onAssistKey(); }
      else if (e.code === 'Digit5') { this.assists.autoGearbox = !this.assists.autoGearbox; this.onAssistKey(); }
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyZ') this.onVoicePtt(false);
    });
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', () => this.onDevice());
    addEventListener('gamepaddisconnected', (e) => { if ((e as GamepadEvent).gamepad.index === this.activeIndex) { this.activeIndex = -1; this.setSource('keys'); } });
  }

  private loadBinds() {
    try {
      const s = JSON.parse(localStorage.getItem(BINDS_KEY) ?? 'null');
      if (s?.key && typeof s.key === 'object') Object.assign(this.keyBinds, s.key);
      if (s?.pad && typeof s.pad === 'object') Object.assign(this.padBinds, s.pad);
    } catch { /* blocked */ }
  }
  saveBinds() {
    try { localStorage.setItem(BINDS_KEY, JSON.stringify({ key: this.keyBinds, pad: this.padBinds })); } catch { /* blocked */ }
  }
  resetBinds() {
    this.keyBinds = { ...DEFAULT_KEY_BINDS };
    this.padBinds = { ...DEFAULT_PAD_BINDS };
    this.saveBinds();
  }
  /** Poll for a gamepad button press while remapping controller controls in ControlsUi. */
  pollPadRebind() {
    if (this.listeningBind?.kind !== 'pad') return;
    for (const p of navigator.getGamepads?.() ?? []) {
      if (!p || !p.connected) continue;
      for (let i = 0; i < p.buttons.length; i++) {
        if (p.buttons[i]?.pressed || (p.buttons[i]?.value ?? 0) > 0.55) {
          this.padBinds[this.listeningBind.action] = i;
          this.saveBinds();
          const done = this.listeningBind.onDone;
          this.listeningBind = null;
          this.syncPads();
          done();
          return;
        }
      }
    }
  }
  /** Check if a raw key code is currently held down (used by Photo Mode & Car Meet walkable avatar). */
  isKeyDown(code: string): boolean { return this.keys.has(code); }

  get device(): DeviceKind { return this.source; }
  saveSettings() { saveSettings(this.settings); }
  private setSource(s: DeviceKind) {
    if (s === this.source) return;
    this.source = s;
    this.onDevice();
  }

  // ---- tilt steering (phones): gravity in screen coordinates, angle relative to where the phone was when enabled ----
  private tilt = { on: false, angle: 0, neutral: NaN, listening: false };
  /** Enable tilt steering (call from a click: iOS asks for motion permission). */
  async enableTilt(): Promise<boolean> {
    const DM = (globalThis as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    try { if (DM?.requestPermission && (await DM.requestPermission()) !== 'granted') return false; } catch { return false; }
    if (!this.tilt.listening) {
      this.tilt.listening = true;
      addEventListener('devicemotion', (e) => {
        const g = (e as DeviceMotionEvent).accelerationIncludingGravity;
        if (!g || g.x === null || g.y === null) return;
        const a = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
        const sx = g.x * Math.cos(a) - g.y * Math.sin(a), sy = g.x * Math.sin(a) + g.y * Math.cos(a);
        this.tilt.angle = Math.atan2(sx, sy);   // clockwise from screen-up; a sign flip of g (iOS) turns it by pi only
        if (Number.isNaN(this.tilt.neutral)) this.tilt.neutral = this.tilt.angle;
      });
    }
    this.tilt.on = true;
    this.tilt.neutral = NaN;
    return true;
  }
  disableTilt() { this.tilt.on = false; }
  /** Hold the phone the way you want "straight" and call this. */
  recentreTilt() { this.tilt.neutral = this.tilt.angle; }

  /** Call once per frame (or tick). Edge events (shifts) are delivered exactly once. */
  poll(): RawInput {
    const r = this.raw;
    r.directGear = -99;
    const pads = this.padsBuf;
    pads.length = 0;
    const rawPads = navigator.getGamepads?.();
    if (rawPads) {
      for (let i = 0; i < rawPads.length; i++) {
        const p = rawPads[i];
        if (p && p.connected) pads.push(p);
      }
    }
    const allCount = pads.length;
    // In 2-Player Split-Screen:
    //  - 2+ controllers: P1 ONLY listens to pads[0] (pads[1] belongs exclusively to Player 2!)
    //  - 1 controller: P1 uses WASD keyboard so the single controller drives Player 2 cleanly!
    if (this.splitScreen) {
      if (allCount >= 2) {
        const p0 = pads[0];
        pads.length = 1;
        if (this.activeIndex !== p0.index) {
          this.activeIndex = p0.index;
          this.activeId = p0.id;
          const c0 = this.kindOf(p0);
          if (c0.kind === 'wheel') { this.wheel = { model: c0.model, key: deviceKey(p0) }; this.setSource('wheel'); }
          else { this.family = c0.family; this.wheel = null; this.setSource('pad'); }
        }
      } else {
        pads.length = 0;
        if (this.source === 'pad' || this.source === 'wheel') this.setSource('keys');
      }
    }
    this.rightStick.x = 0; this.rightStick.y = 0;
    // which pad / wheel was moved? (it becomes the driving device) "Moved" = changed since it last drove or was first
    // seen, so a wheel left turned, a pedal resting at full scale or a drifting stick never steals control back.
    let pad: Gamepad | undefined;
    for (let pi = 0; pi < pads.length; pi++) {
      const p = pads[pi];
      const c = this.kindOf(p);
      let anchor = this.anchors.get(p.index);
      if (!anchor || anchor.id !== p.id) {
        anchor = { id: p.id, axes: new Array<number>(p.axes.length).fill(0), buttons: new Array<number>(p.buttons.length).fill(0) };
        this.anchors.set(p.index, anchor);
      }
      const thresh = c.kind === 'wheel' ? 0.06 : 0.25;
      let moved = false;
      for (let i = 0; i < p.axes.length; i++) {
        if (Math.abs(p.axes[i] - (anchor.axes[i] ?? 0)) > thresh) { moved = true; break; }
      }
      if (!moved) {
        for (let i = 0; i < p.buttons.length; i++) {
          if (p.buttons[i].value - (anchor.buttons[i] ?? 0) > 0.3) { moved = true; break; }
        }
      }
      if ((p.index === this.activeIndex && (this.source === 'pad' || this.source === 'wheel')) || moved) {
        anchor.axes.length = p.axes.length;
        for (let i = 0; i < p.axes.length; i++) anchor.axes[i] = p.axes[i];
        anchor.buttons.length = p.buttons.length;
        for (let i = 0; i < p.buttons.length; i++) anchor.buttons[i] = p.buttons[i].value;
      }
      // a different device (index), or another device plugged into the same slot (id), or coming back from keys / touch
      if (moved && !this.suspended && (p.index !== this.activeIndex || p.id !== this.activeId || (this.source !== 'pad' && this.source !== 'wheel'))) {
        this.activeIndex = p.index;
        this.activeId = p.id;
        if (c.kind === 'wheel') { this.wheel = { model: c.model, key: deviceKey(p) }; this.setSource('wheel'); }
        else { this.family = c.family; this.wheel = null; this.setSource('pad'); }
        this.onDevice();
      }
      if (p.index === this.activeIndex) pad = p;
    }
    const t = this.touch?.state;
    if (t?.active) { this.setSource('touch'); t.active = false; }   // a new touch: touch drives until keys/pad
    if (this.suspended) { r.steer = r.throttle = r.brake = r.clutch = r.handbrake = r.lineLock = 0; r.shiftUp = r.shiftDown = false; return r; }

    if (this.source === 'touch' && this.touch) {
      // analog steering pad (or tilt) -> gamepad-style shaping in the core; pedals are full on/off
      const ts = this.touch.state;
      r.device = 1;
      this.touch.setTilt(this.tilt.on && this.settings.touchSteering === 'tilt');
      let steer = ts.steer;
      if (this.tilt.on && this.settings.touchSteering === 'tilt' && !Number.isNaN(this.tilt.neutral)) {
        let d = this.tilt.angle - this.tilt.neutral;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        steer = Math.max(-1, Math.min(1, d / (35 * Math.PI / 180)));   // 35 deg of tilt = full lock
      }
      r.steer = steer; r.throttle = ts.throttle; r.brake = ts.brake; r.handbrake = ts.handbrake; r.clutch = 0;
      const sh = this.touch.takeShifts();
      if (sh.up) this.pending.up = true;
      if (sh.down) this.pending.down = true;
    } else if (this.source === 'wheel' && pad) {
      this.readWheel(pad, r);
    } else if (this.source === 'pad' && pad) {
      r.device = 1;
      const pb = this.padBinds;
      const dz = (x: number) => (Math.abs(x) < 0.06 ? 0 : x);
      r.steer = -dz(pad.axes[0] ?? 0);
      const rdz = (v: number) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      this.rightStick.x = rdz(pad.axes[2] ?? 0);
      this.rightStick.y = rdz(pad.axes[3] ?? 0);
      r.throttle = pb.throttle >= 0 ? (pad.buttons[pb.throttle]?.value ?? 0) : 0;
      r.brake = pb.brake >= 0 ? (pad.buttons[pb.brake]?.value ?? 0) : 0;
      r.handbrake = pb.handbrake >= 0 && pad.buttons[pb.handbrake]?.pressed ? 1 : 0;
      r.lineLock = pb.lineLock >= 0 && pad.buttons[pb.lineLock]?.pressed ? 1 : 0;
      r.clutch = pb.clutch >= 0 ? (pad.buttons[pb.clutch]?.value ?? 0) : 0;
      const edge = this.edges(pad);
      const hit = (i: number) => i >= 0 && edge(i);
      if (hit(pb.shiftUp)) this.pending.up = true;
      if (hit(pb.shiftDown)) this.pending.down = true;
      if (hit(pb.reset)) this.onReset();
      if (hit(pb.camera)) this.onCamera();
      if (hit(pb.lights)) this.onLights();
      if (hit(pb.flash)) this.onFlash();
      if (hit(pb.stake)) this.onStakeToggle();
      if (hit(pb.board)) this.onBoard();
      if (hit(pb.photo)) this.onPhoto();
      if (hit(pb.replay)) this.onReplay();
      if (hit(pb.carMeet)) this.onCarMeet();
      if (hit(pb.stepOut)) this.onStepOut();
      if (hit(pb.hud)) this.onHud();
      if (hit(pb.pause)) this.onPause();
    } else {
      r.device = 0;
      const kb = this.keyBinds;
      const keys = this.keys;
      if (this.splitScreen) {
        // Split-Screen: P1 uses WASD + Space ONLY (Arrow Keys & Right Shift belong exclusively to Player 2!)
        r.steer = (keys.has(kb.steerLeft) ? 1 : 0) - (keys.has(kb.steerRight) ? 1 : 0);
        r.throttle = keys.has(kb.throttle) ? 1 : 0;
        r.brake = keys.has(kb.brake) ? 1 : 0;
        r.handbrake = keys.has(kb.handbrake) ? 1 : 0;
        r.lineLock = keys.has(kb.lineLock) ? 1 : 0;
        r.clutch = keys.has(kb.clutch) ? 1 : 0;
      } else {
        r.steer = (keys.has(kb.steerLeft) || keys.has('ArrowLeft') ? 1 : 0) - (keys.has(kb.steerRight) || keys.has('ArrowRight') ? 1 : 0);
        r.throttle = keys.has(kb.throttle) || keys.has('ArrowUp') ? 1 : 0;
        r.brake = keys.has(kb.brake) || keys.has('ArrowDown') ? 1 : 0;
        r.handbrake = keys.has(kb.handbrake) ? 1 : 0;
        r.lineLock = keys.has(kb.lineLock) ? 1 : 0;
        r.clutch = keys.has(kb.clutch) || keys.has('ShiftRight') ? 1 : 0;
      }
    }
    if (this.hold) {
      if (r.throttle > 0.05 && !this.locked) this.hold = false;
      else { r.throttle = 0; r.brake = Math.max(r.brake, 0.5); }
    }
    r.shiftUp = this.pending.up;
    r.shiftDown = this.pending.down;
    this.pending.up = this.pending.down = false;
    return r;
  }

  /** While a menu is up (every frame): a wheel's own Pause button closes the pause menu (pads use Start, menu-nav.ts). */
  menuPoll() {
    if (this.source !== 'wheel') return;
    const pad = (navigator.getGamepads?.() ?? []).find((p) => p?.index === this.activeIndex);
    if (!pad) return;
    const edge = this.edges(pad), i = this.cal(pad).buttons.pause;
    if (i !== undefined && edge(i)) this.onPause();
  }

  /** Forget buttons held right now (call when driving resumes: the button that closed a menu is not a game press). */
  syncPads() {
    const rawPads = navigator.getGamepads?.();
    if (rawPads) {
      for (let pi = 0; pi < rawPads.length; pi++) {
        const p = rawPads[pi];
        if (!p) continue;
        const n = p.buttons.length;
        let cur = this.padCur.get(p.index);
        if (!cur) { cur = new Array<boolean>(n); this.padCur.set(p.index, cur); }
        cur.length = n;
        for (let i = 0; i < n; i++) cur[i] = p.buttons[i].pressed;
      }
    }
    this.pending.up = this.pending.down = false;
  }

  /** Pressed-this-poll test for buttons of one pad. */
  private edges(pad: Gamepad) {
    const n = pad.buttons.length;
    let prev = this.padPrev.get(pad.index);
    let cur = this.padCur.get(pad.index);
    if (!prev) { prev = new Array<boolean>(n).fill(false); this.padPrev.set(pad.index, prev); }
    if (!cur) { cur = new Array<boolean>(n).fill(false); this.padCur.set(pad.index, cur); }
    prev.length = n;
    cur.length = n;
    for (let i = 0; i < n; i++) {
      prev[i] = cur[i] ?? false;
      cur[i] = pad.buttons[i].pressed;
    }
    const cRef = cur, pRef = prev;
    return (i: number) => !!cRef[i] && !pRef[i];
  }

  private kinds = new Map<string, ReturnType<typeof classify>>();
  kindOf(p: Gamepad) {
    let c = this.kinds.get(p.id + p.mapping);
    if (!c) { c = classify(p); this.kinds.set(p.id + p.mapping, c); }
    return c;
  }

  cal(pad: Gamepad) { return this.settings.calibration[deviceKey(pad)] ?? defaultCalibration(); }
  rotation(pad: Gamepad) {
    const c = this.kindOf(pad);
    return this.settings.wheelRotation[deviceKey(pad)] ?? (c.kind === 'wheel' ? c.model.rotation : 900);
  }

  /**
   * Steering wheel: the calibrated axis gives the wheel angle (rotation / 2 at full lock of the HARDWARE); the car's
   * steering ratio maps that to the road wheels: full car lock at wheelLockToLock / 2 degrees of wheel. A wheel
   * turned past that point is past the car's lock (the force feedback pushes back there). Device = Wheel: the core
   * applies it 1:1, no filtering, no speed-sensitive scaling.
   */
  private lastWheel = 0;
  private readWheel(pad: Gamepad, r: RawInput) {
    const cal = this.cal(pad);
    r.device = 2;
    const raw = pad.axes[cal.steer.index] ?? cal.steer.rest, span = cal.steer.full - cal.steer.rest;
    const frac = Math.abs(span) < 1e-3 ? 0 : (raw - cal.steer.rest) / span;     // +1 = hardware full left
    const deg = frac * this.rotation(pad) / 2;
    const pos = deg / (this.settings.wheelLockToLock / 2);
    const now = performance.now();
    if (this.lastWheel) { const dt = Math.max(1e-3, (now - this.lastWheel) / 1000); this.wheelVel += ((pos - this.wheelPos) / dt - this.wheelVel) * Math.min(1, dt / 0.03); }
    this.lastWheel = now;
    this.wheelPos = pos;
    r.steer = Math.max(-1, Math.min(1, pos));
    r.throttle = axisValue(pad, cal.throttle);
    r.brake = axisValue(pad, cal.brake);
    r.clutch = axisValue(pad, cal.clutch);
    const b = (i?: number) => i !== undefined && !!pad.buttons[i]?.pressed;
    r.handbrake = b(cal.buttons.handbrake) ? 1 : 0;
    const edge = this.edges(pad);
    const e = (i?: number) => i !== undefined && edge(i);
    if (e(cal.buttons.up)) this.pending.up = true;
    if (e(cal.buttons.down)) this.pending.down = true;
    if (e(cal.buttons.recover)) this.onReset();
    if (e(cal.buttons.camera)) this.onCamera();
    if (e(cal.buttons.pause)) this.onPause();
    if (this.settings.hShifter && Object.keys(cal.hShifter).length) {
      r.directGear = 1;                                                    // no gate button held = neutral
      this.assists.autoGearbox = false;                                    // the lever is the gearbox
      for (const [gear, btn] of Object.entries(cal.hShifter)) if (b(btn)) r.directGear = Number(gear);
    }
  }

  /** Help line for the HUD, for the device in use. */
  helpHtml(): string {
    const kb = (k: string) => `<kbd>${k}</kbd>`;
    if (this.source === 'pad') {
      const L = PAD_LABELS[this.family];
      return `${kb('L stick')} Steer &nbsp; ${kb(L.rt)} Throttle &nbsp; ${kb(L.lt)} Brake &nbsp; ${kb(L.rb)}${kb(L.lb)} Shift &nbsp; ${kb(L.a)} Handbrake &nbsp; ${kb(L.b)} Recover &nbsp; ${kb(L.y)} Camera &nbsp; ${kb(L.x)} Lights &nbsp; ${kb(L.start)} Pause`;
    }
    if (this.source === 'wheel') return `${this.wheel?.model.name ?? 'Wheel'} &nbsp; · &nbsp; paddles shift &nbsp; · &nbsp; calibrate and set force feedback in <b>Controls</b> on the main menu`;
    if (this.source === 'touch') return '';
    return `${kb('W')}${kb('S')} Throttle / Brake &nbsp; ${kb('A')}${kb('D')} Steer &nbsp; ${kb('Q')}${kb('E')} Shift &nbsp; ${kb('Space')} Handbrake &nbsp; ${kb('R')} Recover / Repair &nbsp; ${kb('C')} Camera &nbsp; ${kb('L')} Lights &nbsp; ${kb('G')} Menu &nbsp; ${kb('M')} Map &nbsp; ${kb('1-3,5')} Assists &nbsp; ${kb('H')} Hide HUD`;
  }

  /**
   * Gamepad rumble from the physics (Chrome dual-rumble pads: Xbox / DualShock / DualSense), once per frame:
   *  - weak (high-frequency) motor: the front tyres scrubbing past their peak slip angle (understeer), ABS pulsing;
   *  - strong (low-frequency) motor: the rear sliding or spinning up (oversteer, wheelspin), and crash impacts.
   * Phones: the vibration motor for crashes and hard slides (Android; iOS has no web vibration).
   */
  private rumbleAt = 0;
  private absPhase = 0;
  rumble(now: number, out: Float64Array, impact = 0) {
    if (now - this.rumbleAt < 50) return;
    const PEAK = 0.19;   // rad: where the fitted tyre's lateral force peaks (data/tires)
    const sa = (i: number) => Math.abs(out[OUT.wheel(i) + 8]), sr = (i: number) => Math.abs(out[OUT.wheel(i) + 7]);
    const contact = (i: number) => out[OUT.wheel(i) + 5] > 0.5;
    const speed = Math.abs(out[OUT.speed]);
    let weak = 0, strong = 0;
    if (speed > 2) {
      const front = Math.max(contact(0) ? sa(0) : 0, contact(1) ? sa(1) : 0) / PEAK;
      const rearSlide = Math.max(contact(2) ? sa(2) : 0, contact(3) ? sa(3) : 0) / PEAK;
      const spin = Math.max(sr(2), sr(3));
      weak = Math.min(1, Math.max(0, (front - 0.75) * 1.6));
      strong = Math.min(1, Math.max(0, (rearSlide - 0.9) * 1.2) + Math.max(0, (spin - 0.18) * 2));
      if (out[OUT.abs] > 0.5) { this.absPhase = (this.absPhase + 1) % 2; weak = Math.max(weak, this.absPhase ? 0.7 : 0.15); }
    }
    if (impact > 0) strong = Math.max(strong, Math.min(1, 0.3 + impact / 120));
    if (this.source === 'touch') {
      if (this.settings.haptics && (impact > 0 || strong > 0.6)) { this.rumbleAt = now; navigator.vibrate?.(impact > 0 ? Math.min(250, 40 + impact * 2) : 25); }
      return;
    }
    if (this.source !== 'pad' || !this.settings.padVibration) return;
    const pad = (navigator.getGamepads?.() ?? []).find((p) => p?.index === this.activeIndex) as RumblePad | undefined;
    const act = pad?.vibrationActuator;
    if (!act) return;
    this.rumbleAt = now;
    if (weak < 0.02 && strong < 0.02) return;
    act.playEffect('dual-rumble', { startDelay: 0, duration: 70, weakMagnitude: weak, strongMagnitude: strong }).catch(() => {});
  }
}
