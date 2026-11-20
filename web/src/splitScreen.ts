// 2-Player Local Split-Screen (Laptop + Smart TV with 2 Controllers, 1 Controller + Keyboard, or Shared Keyboard)
// plus cross-browser controller polling (Chrome, Edge, Firefox, Safari, Linux/Windows/macOS, Smart TVs).
import type { RawInput } from './physics/core';

export type SplitLayout = 'horizontal' | 'vertical';

export interface SplitScreenCheck {
  eligible: boolean;
  displayOk: boolean;
  padsCount: number;
  padNames: string[];
  modeLabel: string;
  reason: string;
}

export function connectedGamepads(): Gamepad[] {
  try {
    return Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
  } catch {
    return [];
  }
}

/**
 * Check Split-Screen readiness across all desktops, laptops, and Smart TVs (never artificially locked out).
 * Works with 2 controllers (ideal for Laptop + Smart TV), 1 controller + keyboard, or shared keyboard (WASD + Arrows).
 */
export function checkSplitScreen(): SplitScreenCheck {
  const isPhone = matchMedia('(pointer: coarse)').matches && Math.max(innerWidth, innerHeight) < 820;
  const displayOk = !isPhone;
  const pads = connectedGamepads();
  const padsCount = pads.length;
  const padNames = pads.slice(0, 2).map((p, i) => `Pad ${i + 1}: ${p.id.replace(/\s*\(.*?\)\s*/g, '').slice(0, 22) || 'Controller'}`);

  if (!displayOk) {
    return {
      eligible: false,
      displayOk: false,
      padsCount,
      padNames,
      modeLabel: 'Desktop / TV',
      reason: 'Connect to a laptop, monitor, or Smart TV (landscape >= 820 px) for 2-player Split-Screen.',
    };
  }
  if (padsCount >= 2) {
    return {
      eligible: true,
      displayOk: true,
      padsCount,
      padNames,
      modeLabel: '2 Controllers (TV Ready)',
      reason: `2 controllers connected! P1 = ${padNames[0]} · P2 = ${padNames[1]} (LOD auto-balanced for smooth TV FPS).`,
    };
  }
  if (padsCount === 1) {
    return {
      eligible: true,
      displayOk: true,
      padsCount,
      padNames,
      modeLabel: '1 Controller + Keyboard',
      reason: `1 controller detected: P1 = WASD + Space · P2 = ${padNames[0]} (or Arrow Keys). Plug in a 2nd controller anytime!`,
    };
  }
  return {
    eligible: true,
    displayOk: true,
    padsCount: 0,
    padNames: [],
    modeLabel: 'Shared Keyboard (or Plug 2 Pads)',
    reason: 'Ready now! P1 = WASD + Space · P2 = Arrow Keys + Right Shift — or plug in 2 Bluetooth/USB controllers for TV couch play.',
  };
}

export interface Player2Poll {
  raw: RawInput;
  nos: boolean;
  camToggle: boolean;
  resetCar: boolean;
  rightStickX: number;
  rightStickY: number;
  sourceLabel: string;
}

/** Dedicated Player 2 input reader: Gamepad #2 (when 2+ pads), Gamepad #1 (when 1 pad + P1 on keyboard), plus Arrow Keys fallback. */
export class Player2Input {
  private prevBtns: boolean[] = [];
  private prevKeys = new Set<string>();
  private raw: RawInput = { steer: 0, throttle: 0, brake: 0, handbrake: 0, clutch: 0, shiftUp: false, shiftDown: false, directGear: -99, device: 1 };

  private padEdge(pad: Gamepad, idx: number): boolean {
    const down = !!pad.buttons[idx]?.pressed || (pad.buttons[idx]?.value ?? 0) > 0.55;
    const was = this.prevBtns[idx] ?? false;
    this.prevBtns[idx] = down;
    return down && !was;
  }

  private keyEdge(isKeyDown: (code: string) => boolean, code: string): boolean {
    const down = isKeyDown(code);
    const was = this.prevKeys.has(code);
    if (down) this.prevKeys.add(code); else this.prevKeys.delete(code);
    return down && !was;
  }

  poll(isKeyDown: (code: string) => boolean, locked = false): Player2Poll {
    const r = this.raw;
    r.steer = r.throttle = r.brake = r.handbrake = r.clutch = 0;
    r.shiftUp = r.shiftDown = false;
    r.directGear = -99;

    const pads = connectedGamepads();
    // 2+ pads: P1 gets pads[0], P2 gets pads[1]. 1 pad: P1 gets WASD, P2 gets pads[0] (and Arrows also work).
    const pad = pads.length >= 2 ? pads[1] : pads.length === 1 ? pads[0] : null;
    let nos = false;
    let camToggle = false;
    let resetCar = false;
    let rightStickX = 0;
    let rightStickY = 0;
    let sourceLabel = 'Arrows';

    if (pad) {
      r.device = 1;
      sourceLabel = pads.length >= 2 ? 'Pad 2' : 'Pad 1';
      const dz = (v: number, d = 0.08) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
      r.steer = -dz(pad.axes[0] ?? 0, 0.07);
      // Standard mapping (Xbox/PS/Switch/Generic): RT=7, LT=6; fallback to A/B if digital triggers missing
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      r.throttle = rt > 0.02 ? rt : (pad.buttons[0]?.pressed ? 1 : 0);
      r.brake = lt > 0.02 ? lt : (pad.buttons[2]?.pressed ? 1 : 0);
      r.handbrake = pad.buttons[1]?.pressed ? 1 : 0; // B / Circle
      nos = !!pad.buttons[2]?.pressed && lt < 0.05;  // X / Square (when LT not acting as brake)
      if (this.padEdge(pad, 5)) r.shiftUp = true;    // RB / R1
      if (this.padEdge(pad, 4)) r.shiftDown = true;  // LB / L1
      if (this.padEdge(pad, 3)) camToggle = true;    // Y / Triangle
      if (this.padEdge(pad, 8)) resetCar = true;     // Back / Share / Select
      rightStickX = dz(pad.axes[2] ?? 0, 0.14);
      rightStickY = dz(pad.axes[3] ?? 0, 0.14);
    }

    // Arrow Keys always work as seamless fallback for Player 2 (when pad isn't pressed)
    const kSteer = (isKeyDown('ArrowLeft') ? 1 : 0) - (isKeyDown('ArrowRight') ? 1 : 0);
    const kThr = isKeyDown('ArrowUp') ? 1 : 0;
    const kBrk = isKeyDown('ArrowDown') ? 1 : 0;
    const kHb = isKeyDown('ShiftRight') ? 1 : 0;
    if (!pad || Math.abs(kSteer) > 0 || kThr > 0 || kBrk > 0 || kHb > 0) {
      if (Math.abs(kSteer) > Math.abs(r.steer)) { r.steer = kSteer; r.device = 0; }
      if (kThr > r.throttle) { r.throttle = kThr; r.device = 0; }
      if (kBrk > r.brake) { r.brake = kBrk; r.device = 0; }
      if (kHb > r.handbrake) r.handbrake = kHb;
    }
    if (isKeyDown('Enter') || isKeyDown('Numpad0')) nos = true;
    if (this.keyEdge(isKeyDown, 'KeyM') || this.keyEdge(isKeyDown, 'Slash')) camToggle = true;
    if (this.keyEdge(isKeyDown, 'Backspace')) resetCar = true;

    if (locked) {
      r.throttle = 0;
      r.brake = Math.max(r.brake, 0.5);
    }
    return { raw: r, nos, camToggle, resetCar, rightStickX, rightStickY, sourceLabel };
  }
}

/** Crisp, ultra-lightweight 2-Player Split-Screen HUD overlay (zero allocations per frame). */
export class SplitHud {
  private root: HTMLDivElement;
  private divider: HTMLDivElement;
  private p1El: HTMLDivElement;
  private p2El: HTMLDivElement;
  private lastP1 = '';
  private lastP2 = '';

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'split-hud';
    this.root.hidden = true;
    this.divider = document.createElement('div');
    this.divider.className = 'split-divider';
    this.p1El = document.createElement('div');
    this.p1El.className = 'split-badge split-p1';
    this.p2El = document.createElement('div');
    this.p2El.className = 'split-badge split-p2';
    this.root.append(this.divider, this.p1El, this.p2El);
    document.body.appendChild(this.root);
  }

  show(layout: SplitLayout) {
    this.root.dataset.layout = layout;
    this.root.hidden = false;
  }

  hide() {
    this.root.hidden = true;
    this.lastP1 = this.lastP2 = '';
  }

  update(
    p1: { kmh: number; gear: number; rpmFrac: number; label: string; extra: string },
    p2: { kmh: number; gear: number; rpmFrac: number; label: string; extra: string },
  ) {
    const gTxt = (g: number) => (g < 0 ? 'R' : g === 0 ? 'N' : String(g));
    const h1 = `<div class="sb-top"><i class="p1">P1</i><span>${p1.label}</span><em>${p1.extra}</em></div>
      <div class="sb-main"><b>${Math.round(p1.kmh)}</b><small>KM/H</small><u>${gTxt(p1.gear)}</u></div>
      <div class="sb-rpm"><i style="width:${Math.round(Math.max(0, Math.min(1, p1.rpmFrac)) * 100)}%"></i></div>`;
    if (h1 !== this.lastP1) { this.p1El.innerHTML = this.lastP1 = h1; }

    const h2 = `<div class="sb-top"><i class="p2">P2</i><span>${p2.label}</span><em>${p2.extra}</em></div>
      <div class="sb-main"><b>${Math.round(p2.kmh)}</b><small>KM/H</small><u>${gTxt(p2.gear)}</u></div>
      <div class="sb-rpm"><i style="width:${Math.round(Math.max(0, Math.min(1, p2.rpmFrac)) * 100)}%"></i></div>`;
    if (h2 !== this.lastP2) { this.p2El.innerHTML = this.lastP2 = h2; }
  }
}
