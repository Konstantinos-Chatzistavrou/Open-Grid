// The Controls screen: every input device in one place.
//   devices     what is connected and which one drives (the last one touched)
//   keyboard    the key list
//   controller  Xbox / PlayStation / Switch / generic layout with that pad's own button names, vibration
//   wheel       calibration wizard (axes, pedals, paddles, buttons, H-shifter gates), rotation, the car's lock-to-lock,
//               force feedback: connect (WebHID), strength, safety cap, direction, test pulse
//   phone       touch pad or tilt steering, recentre, vibration
// Rendered by Menu (menu.ts) as HTML; live readouts (pedal bars, calibration feedback) update every frame in tick().
import { Calibration } from './calibrate';
import { PAD_BINDINGS, PAD_LABELS, axisValue, classify, defaultSettings, deviceKey, type PadFamily } from './devices';
import { ForceFeedback } from './ffb';
import type { BindAction, Input } from './input';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const FAMILY_NAME: Record<PadFamily, string> = { xbox: 'Xbox', playstation: 'PlayStation', switch: 'Switch Pro', generic: 'Generic' };
const ROTATIONS = [270, 540, 900, 1080];
const LOCKS = [360, 540, 720, 900];
type RumblePad = Gamepad & { vibrationActuator?: { playEffect(t: string, o: object): Promise<unknown> } };

export class ControlsUi {
  cal: Calibration | null = null;
  note = '';
  /** pad family whose layout is shown (follows the pad in use; chips switch it) */
  layout: PadFamily | null = null;
  private wheelIndex = -1;

  constructor(private input: Input, readonly ffb: ForceFeedback, private rerender: () => void, private gears: () => number) {
    ffb.onChange = () => { this.applyRange(); this.rerender(); };
    addEventListener('gamepadconnected', () => this.rerender());
    addEventListener('gamepaddisconnected', () => this.rerender());
  }

  private pads() { return (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected); }
  private wheelPad(): Gamepad | null {
    const ws = this.pads().filter((p) => classify(p).kind === 'wheel');
    return ws.find((p) => p.index === this.wheelIndex) ?? ws[0] ?? null;
  }
  private s() { return this.input.settings; }
  private save() { this.input.saveSettings(); }
  /** Hardware rotation range = the rotation setting (soft lock at the car's lock is done by the force feedback). */
  applyRange() {
    const w = this.wheelPad();
    if (w && this.ffb.driver) void this.ffb.setRange(this.input.rotation(w));
  }

  get calibrating() { return !!this.cal; }

  html(): string {
    const s = this.s();
    const toggle = (act: string, on: boolean) => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="1">On</button><button class="chip ${on ? '' : 'on'}" data-act="${act}" data-v="0">Off</button>`;
    // devices
    const pads = this.pads();
    const dev = [`<div class="dev ${this.input.device === 'keys' ? 'on' : ''}"><b>⌨ Keyboard</b><span class="dim">always on</span></div>`];
    for (const p of pads) {
      const c = classify(p);
      const name = c.kind === 'wheel' ? `🛞 ${esc(c.model.name)}` : `🎮 ${FAMILY_NAME[c.family]} controller`;
      const live = (this.input.device === 'pad' || this.input.device === 'wheel') && this.input.activeIndex === p.index;
      dev.push(`<div class="dev ${live ? 'on' : ''}"><b>${name}</b><span class="dim">${esc(p.id.slice(0, 64))}</span></div>`);
    }
    if (matchMedia('(pointer: coarse)').matches) dev.push(`<div class="dev ${this.input.device === 'touch' ? 'on' : ''}"><b>📱 Touch screen</b><span class="dim">${s.touchSteering === 'tilt' ? 'tilt steering' : 'on-screen steering pad'}</span></div>`);
    const devices = `${dev.join('')}${pads.length ? '' : '<p class="dim small-note">No controller or wheel seen yet: plug it in and press any button on it (browsers only show a gamepad after a button press).</p>'}
      <p class="dim small-note">The device you last touched drives. Any mix works.</p>`;

    // Full remappable Keyboard & Controller actions (console-cert accessibility requirement)
    const ACTIONS: { id: BindAction; label: string; pad?: boolean }[] = [
      { id: 'throttle', label: 'Throttle', pad: true },
      { id: 'brake', label: 'Brake / Reverse', pad: true },
      { id: 'steerLeft', label: 'Steer Left' },
      { id: 'steerRight', label: 'Steer Right' },
      { id: 'shiftUp', label: 'Shift Up', pad: true },
      { id: 'shiftDown', label: 'Shift Down', pad: true },
      { id: 'handbrake', label: 'Handbrake', pad: true },
      { id: 'clutch', label: 'Clutch', pad: true },
      { id: 'reset', label: 'Recover / Repair', pad: true },
      { id: 'camera', label: 'Camera', pad: true },
      { id: 'lights', label: 'Lights', pad: true },
      { id: 'flash', label: 'Flash Wager (1v1)', pad: true },
      { id: 'stake', label: 'Switch Wager Stakes', pad: true },
      { id: 'board', label: 'Zone Leaderboards', pad: true },
      { id: 'photo', label: 'Photo Mode (4K)', pad: true },
      { id: 'replay', label: 'Cinematic Replay', pad: true },
      { id: 'carMeet', label: 'Car Meet Hub', pad: true },
      { id: 'stepOut', label: 'Step Out / Walk', pad: true },
      { id: 'interact', label: 'Race Node Matchmaking', pad: true },
      { id: 'hud', label: 'Hide HUD', pad: true },
      { id: 'map', label: 'Minimap' },
      { id: 'garage', label: 'Menu' },
      { id: 'pause', label: 'Pause', pad: true },
    ];
    const fmtKey = (code: string) => code.replace(/^Key/, '').replace(/^Digit/, '');
    const listen = this.input.listeningBind;
    const keys = ACTIONS.map((a) => {
      const wait = listen?.kind === 'key' && listen.action === a.id;
      return `<div class="bind"><button class="chip ${wait ? 'on' : ''}" data-act="c-rebind-key" data-v="${a.id}">${wait ? 'Press key…' : esc(fmtKey(this.input.keyBinds[a.id]))}</button><span>${a.label}</span></div>`;
    }).join('');

    // controller layout (every button remappable)
    const fam = this.layout ?? (this.input.device === 'pad' ? this.input.family : (pads.map((p) => classify(p)).find((c) => c.kind === 'pad') as { family: PadFamily } | undefined)?.family ?? 'xbox');
    const L = PAD_LABELS[fam];
    const padBtnName = (idx: number) => idx < 0 ? 'Unbound' : (Object.entries(L)[idx]?.[1] ?? `Btn ${idx}`);
    const famChips = (Object.keys(FAMILY_NAME) as PadFamily[]).map((f) => `<button class="chip ${f === fam ? 'on' : ''}" data-act="c-layout" data-v="${f}">${FAMILY_NAME[f]}</button>`).join('');
    const binds = ACTIONS.filter((a) => a.pad).map((a) => {
      const wait = listen?.kind === 'pad' && listen.action === a.id;
      const bIdx = this.input.padBinds[a.id];
      return `<div class="bind"><button class="chip ${wait ? 'on' : ''}" data-act="c-rebind-pad" data-v="${a.id}">${wait ? 'Press button…' : esc(padBtnName(bIdx))}</button><span>${a.label}</span></div>`;
    }).join('');
    const pad = `<div class="chips">${famChips}</div><p class="dim small-note">Click any button below to remap every controller action individually.</p><div class="binds">${binds}</div>
      <div class="opts"><span class="dim">VIBRATION</span>${toggle('c-vib', s.padVibration)}<button class="chip" data-act="c-vibtest">Test</button></div>
      <p class="dim small-note">Menus: D-pad / stick to move, ${L.a} to select, ${L.b} to go back. Vibration: front tyres scrubbing (light motor), rear sliding or spinning and crashes (heavy motor), ABS pulses.</p>`;

    return `<div class="lobby-screen"><div class="card lobby-card controls-card">
      <div class="lobby-head"><button data-act="c-back" class="back-btn">← Back</button><div><div class="kicker">INPUT</div><h2>Controls</h2></div></div>
      ${this.note ? `<div class="pnote">${esc(this.note)}</div>` : ''}
      <h3>Devices</h3>${devices}
      <h3>Steering wheel</h3>${this.wheelHtml()}
      <h3>Controller <small class="dim">(Xbox, PlayStation, Switch Pro, any standard pad)</small></h3>${pad}
      <h3>Keyboard</h3><div class="binds">${keys}</div>
      <h3>Phone &amp; tablet</h3>
      <div class="opts"><span class="dim">STEERING</span><button class="chip ${s.touchSteering === 'touch' ? 'on' : ''}" data-act="c-tilt" data-v="0">Touch pad</button><button class="chip ${s.touchSteering === 'tilt' ? 'on' : ''}" data-act="c-tilt" data-v="1">Tilt</button>
        ${s.touchSteering === 'tilt' ? '<button class="chip" data-act="c-recentre">Set straight</button>' : ''}</div>
      <div class="opts"><span class="dim">VIBRATION</span>${toggle('c-haptics', s.haptics)}</div>
      <p class="dim small-note">Tilt: hold the phone the way you want "straight", then tap Set straight (also the ⟲ button while driving); 35° of tilt is full lock. Vibration on crashes and slides works on Android; iPhones have no web vibration.</p>
      <div class="lobby-foot"><button data-act="c-reset" class="small">Reset all controls</button><button data-act="c-back" class="primary">Done</button></div>
    </div></div>`;
  }

  private wheelHtml(): string {
    const s = this.s(), w = this.wheelPad();
    const ffb = this.ffbHtml();
    if (this.cal) {
      const st = this.cal.current;
      return `<div class="calib">
        <div class="kicker">CALIBRATING · STEP ${this.cal.step + 1} / ${this.cal.steps.length}</div>
        <div class="cal-prompt">${esc(st?.prompt ?? '')}</div>
        <div class="cal-live" id="c-live">${esc(this.cal.live)}</div>
        <p class="dim small-note">Each step moves on by itself once it sees the input (released afterwards); or use the buttons.</p>
        <div class="opts"><button class="primary" data-act="c-next">Next</button>${st?.optional ? '<button data-act="c-skip">Skip</button>' : ''}<button data-act="c-cancel">Cancel</button></div>
      </div>`;
    }
    if (!w) {
      return `<p class="dim small-note">No wheel seen. Plug it in and press a button on it. Logitech, Thrustmaster, Fanatec, Moza, Simucube, Simagic, Asetek, Cammus, PXN, OpenFFBoard and other HID wheels all work for steering and pedals.</p>${ffb}`;
    }
    const c = classify(w);
    const key = deviceKey(w), cal = s.calibration[key], rot = this.input.rotation(w);
    const wheels = this.pads().filter((p) => classify(p).kind === 'wheel');
    const pick = wheels.length > 1 ? `<div class="chips">${wheels.map((p) => `<button class="chip ${p === w ? 'on' : ''}" data-act="c-wheel" data-v="${p.index}">${esc((classify(p) as { model: { name: string } }).model.name)}</button>`).join('')}</div>` : '';
    return `${pick}<div class="dev on"><b>🛞 ${esc(c.kind === 'wheel' ? c.model.name : w.id)}</b><span class="dim">${cal ? 'calibrated' : 'not calibrated: steering guessed on axis 0, pedals off until you calibrate'}</span></div>
      <div class="meters" id="c-meters"><div><span>Steer</span><div class="bar mid"><i></i></div></div><div><span>Throttle</span><div class="bar"><i></i></div></div><div><span>Brake</span><div class="bar"><i></i></div></div><div><span>Clutch</span><div class="bar"><i></i></div></div></div>
      <div class="opts"><button class="primary" data-act="c-cal">${cal ? 'Recalibrate' : 'Calibrate wheel &amp; pedals'}</button></div>
      <div class="opts"><span class="dim">WHEEL ROTATION</span>${ROTATIONS.map((r) => `<button class="chip ${rot === r ? 'on' : ''}" data-act="c-rot" data-v="${r}">${r}°</button>`).join('')}<span class="dim small-note">= the range set on the wheel / its driver</span></div>
      <div class="opts"><span class="dim">CAR LOCK TO LOCK</span>${LOCKS.map((r) => `<button class="chip ${s.wheelLockToLock === r ? 'on' : ''}" data-act="c-lock" data-v="${r}">${r}°</button>`).join('')}<span class="dim small-note">wheel turn for full steering lock (road car ≈ 720°)</span></div>
      <div class="opts"><span class="dim">H-SHIFTER</span><button class="chip ${s.hShifter ? 'on' : ''}" data-act="c-hshift" data-v="1">On</button><button class="chip ${s.hShifter ? '' : 'on'}" data-act="c-hshift" data-v="0">Off</button>
        <span class="dim small-note">${s.hShifter ? (cal && Object.keys(cal.hShifter).length ? `${Object.keys(cal.hShifter).length} gates mapped` : 'recalibrate to map the gates') : 'paddles / sequential'}</span></div>
      ${ffb}`;
  }

  private ffbHtml(): string {
    const s = this.s(), f = this.ffb;
    const slider = (id: string, label: string, v: number) => `<label class="field slider"><span class="dim">${label}</span><input id="${id}" type="range" min="0" max="100" step="5" value="${Math.round(v * 100)}" /><b id="${id}-v">${Math.round(v * 100)}%</b></label>`;
    const profChip = (id: 'direct_drive' | 'belt' | 'gear', label: string) =>
      `<button class="chip ${s.ffbProfile === id ? 'on' : ''}" data-act="c-ffbprof" data-v="${id}">${label}</button>`;
    const tuning = `<div class="opts"><span class="dim">WHEEL PROFILE</span>${profChip('direct_drive', 'Direct Drive (Moza/Simucube)')}${profChip('belt', 'Belt-Driven (Thrustmaster/CSL)')}${profChip('gear', 'Gear-Driven (Logitech G29)')}</div>
      ${slider('c-ffbs', 'STRENGTH', s.ffbStrength)}
      ${slider('c-ffbm', 'SAFETY CAP', s.ffbMax)}
      ${slider('c-ffbd', 'DAMPER', s.ffbDamper)}
      ${slider('c-ffbf', 'FRICTION', s.ffbFriction)}
      ${slider('c-ffbr', 'ROAD EFFECTS', s.ffbRoadEffects)}`;
    if (!ForceFeedback.available) return `<h4>Force feedback (FFB Profiles)</h4>${tuning}<p class="dim small-note">${esc(f.status)}.</p>`;
    return `<h4>Force feedback (FFB Profiles)</h4>
      <div class="opts"><span class="${f.driver ? '' : 'dim'}">${esc(f.status)}</span>${f.driver ? '' : '<button class="primary" data-act="c-ffb">Connect wheel for force feedback</button>'}</div>
      ${tuning}
      ${f.driver ? `<div class="opts"><button data-act="c-ffbtest">Test: push left</button><span class="dim">DIRECTION</span><button class="chip ${s.ffbInvert ? '' : 'on'}" data-act="c-ffbinv" data-v="0">Normal</button><button class="chip ${s.ffbInvert ? 'on' : ''}" data-act="c-ffbinv" data-v="1">Inverted</button></div>` : ''}
      <p class="dim small-note">Direct Drive uses lower damper &amp; higher dynamic range; Belt/Gear presets boost road effects &amp; friction so Logitech and Moza bases each feel authentic.</p>`;
  }

  /** Clicks on data-act="c-…" buttons. Returns true when handled. */
  click(act: string, v: string): boolean {
    const s = this.s();
    switch (act) {
      case 'c-layout': this.layout = v as PadFamily; break;
      case 'c-vib': s.padVibration = v === '1'; break;
      case 'c-vibtest': {
        const p = this.pads().find((x) => (x as RumblePad).vibrationActuator) as RumblePad | undefined;
        if (p) void p.vibrationActuator!.playEffect('dual-rumble', { startDelay: 0, duration: 400, weakMagnitude: 0.6, strongMagnitude: 0.8 }).catch(() => {});
        else this.note = 'No controller with vibration found (press a button on it first).';
        break;
      }
      case 'c-tilt':
        if (v === '1') {
          void this.input.enableTilt().then((ok) => {
            if (ok) { s.touchSteering = 'tilt'; this.note = ''; } else this.note = 'Motion sensors are blocked or missing: tilt steering is not available.';
            this.save(); this.rerender();
          });
          return true;
        }
        s.touchSteering = 'touch'; this.input.disableTilt(); break;
      case 'c-recentre': this.input.recentreTilt(); this.note = 'Tilt centre set.'; break;
      case 'c-haptics': s.haptics = v === '1'; if (s.haptics) navigator.vibrate?.(30); break;
      case 'c-wheel': this.wheelIndex = Number(v); break;
      case 'c-cal': {
        const w = this.wheelPad();
        if (!w) return true;
        this.cal = Calibration.forPad(w, s.hShifter, this.gears());
        this.input.suspended = true;
        this.note = '';
        break;
      }
      case 'c-next': if (this.cal && !this.cal.next()) this.note = 'Nothing detected yet for this step.'; else this.note = ''; this.finishIfDone(); break;
      case 'c-skip': this.cal?.skip(); this.finishIfDone(); break;
      case 'c-cancel': this.cal = null; this.input.suspended = false; this.note = 'Calibration cancelled.'; break;
      case 'c-rot': { const w = this.wheelPad(); if (w) { s.wheelRotation[deviceKey(w)] = Number(v); this.applyRange(); } break; }
      case 'c-lock': s.wheelLockToLock = Number(v); break;
      case 'c-hshift': s.hShifter = v === '1'; break;
      case 'c-ffb': void this.ffb.connect(true); return true;
      case 'c-ffbtest': this.ffb.testPulse(); return true;
      case 'c-ffbinv': s.ffbInvert = v === '1'; break;
      case 'c-ffbprof': {
        s.ffbProfile = v as 'direct_drive' | 'belt' | 'gear';
        if (v === 'direct_drive') { s.ffbStrength = 0.55; s.ffbMax = 0.75; s.ffbDamper = 0.18; s.ffbFriction = 0.12; s.ffbRoadEffects = 0.45; }
        else if (v === 'belt') { s.ffbStrength = 0.75; s.ffbMax = 0.9; s.ffbDamper = 0.35; s.ffbFriction = 0.25; s.ffbRoadEffects = 0.65; }
        else { s.ffbStrength = 0.9; s.ffbMax = 1.0; s.ffbDamper = 0.45; s.ffbFriction = 0.35; s.ffbRoadEffects = 0.85; }
        this.note = `✓ Applied ${v.replace('_', ' ')} FFB curve.`;
        break;
      }
      case 'c-rebind-key':
        this.input.listeningBind = { kind: 'key', action: v as BindAction, onDone: () => { this.note = `✓ Remapped ${v}.`; this.rerender(); } };
        this.note = `Press any key for "${v}" (Esc cancels)…`;
        break;
      case 'c-rebind-pad':
        this.input.listeningBind = { kind: 'pad', action: v as BindAction, onDone: () => { this.note = `✓ Remapped controller button for ${v}.`; this.rerender(); } };
        this.note = `Press any controller button for "${v}"…`;
        break;
      case 'c-reset': {
        Object.assign(s, defaultSettings());
        this.input.resetBinds();
        this.input.listeningBind = null;
        this.input.disableTilt();
        this.note = 'Controls & remappings reset to defaults.';
        break;
      }
      default: return false;
    }
    this.save();
    this.rerender();
    return true;
  }

  private finishIfDone() {
    if (!this.cal?.done) return;
    this.s().calibration[this.cal.key] = this.cal.result;
    this.save();
    this.note = '✓ Wheel calibrated.';
    this.cal = null;
    this.input.suspended = false;
  }

  /** Slider moved. */
  slide(t: HTMLInputElement) {
    const s = this.s(), v = Number(t.value) / 100;
    if (t.id === 'c-ffbs') s.ffbStrength = v;
    else if (t.id === 'c-ffbm') s.ffbMax = v;
    else if (t.id === 'c-ffbd') s.ffbDamper = v;
    else if (t.id === 'c-ffbf') s.ffbFriction = v;
    else if (t.id === 'c-ffbr') s.ffbRoadEffects = v;
    else return;
    const out = document.getElementById(`${t.id}-v`);
    if (out) out.textContent = `${t.value}%`;
    this.save();
  }

  /** Leaving the screen: stop a calibration or rebind in progress. */
  leave() { if (this.cal) { this.cal = null; this.input.suspended = false; } this.input.listeningBind = null; this.note = ''; }

  /** Every frame while the screen is up. */
  tick() {
    this.input.pollPadRebind();
    if (this.cal) {
      const before = this.cal.step;
      this.cal.sample();
      if (this.cal.step !== before) { this.note = ''; this.finishIfDone(); this.rerender(); return; }
      const el = document.getElementById('c-live');
      if (el && el.textContent !== this.cal.live) el.textContent = this.cal.live;
      return;
    }
    const m = document.getElementById('c-meters'), w = this.wheelPad();
    if (!m || !w) return;
    const cal = this.input.cal(w), bars = m.querySelectorAll<HTMLElement>('.bar i');
    const span = cal.steer.full - cal.steer.rest;
    const steer = Math.abs(span) < 1e-3 ? 0 : ((w.axes[cal.steer.index] ?? cal.steer.rest) - cal.steer.rest) / span;   // +1 full left
    const st = Math.max(-1, Math.min(1, steer));
    bars[0].style.left = `${50 - Math.max(0, st) * 50}%`;
    bars[0].style.width = `${Math.abs(st) * 50}%`;
    [cal.throttle, cal.brake, cal.clutch].forEach((a, i) => { bars[i + 1].style.width = `${Math.round(axisValue(w, a) * 100)}%`; });
  }
}
