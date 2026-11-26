// Apache-2.0 — Zero-cost iRacing-style Race Spotter & Crew Chief (OpenGrid).
// Runs 100% client-side with Web Speech API + HUD radio banners ($0 server cost):
//   - Real-time proximity awareness: "Car left", "Car right", "Three wide — hold your line", "Clear!"
//   - Race control & flag radio calls: Final Lap, Yellow Flag, Blue Flag, Meatball Flag, 0x Victim Shield.

export interface SpotterCar {
  x: number;
  z: number;
  vx?: number;
  vz?: number;
}

export interface SpotterCallout {
  headline: string;
  detail: string;
  speech: string;
}

const STORAGE_KEY = 'og.spotter.v1';

export class RaceSpotter {
  enabled = true;
  voiceEnabled = true;

  private leftActive = false;
  private rightActive = false;
  private threeWideActive = false;
  private lastCallAt = 0;
  private lastClearAt = 0;
  private lastSpecialAt = new Map<string, number>();

  constructor() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === '0') this.enabled = false;
    } catch { /* blocked */ }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch { /* blocked */ }
    if (!on) this.reset();
  }

  reset() {
    this.leftActive = false;
    this.rightActive = false;
    this.threeWideActive = false;
    this.lastCallAt = 0;
    this.lastClearAt = 0;
    this.lastSpecialAt.clear();
  }

  /**
   * Update proximity radar against all nearby rival cars in three.js XZ world coordinates.
   * `fwdX/fwdZ` is the player's unit forward vector in XZ; right vector is `(-fwdZ, fwdX)`.
   */
  update(
    nowMs: number,
    playerX: number,
    playerZ: number,
    fwdX: number,
    fwdZ: number,
    speedMs: number,
    rivals: SpotterCar[],
  ): SpotterCallout | null {
    if (!this.enabled || speedMs < 8.5 || !rivals.length) return null;

    // Right-hand perpendicular in three.js XZ plane (assuming forward = (fwdX, fwdZ)):
    // In three.js (Y up), forward x up = (fwdX, 0, fwdZ) x (0, 1, 0) = (-fwdZ, 0, fwdX) = right vector.
    const rightX = -fwdZ;
    const rightZ = fwdX;

    let carLeft = false;
    let carRight = false;

    for (const r of rivals) {
      const dx = r.x - playerX;
      const dz = r.z - playerZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > 64 || d2 < 0.25) continue;   // ignore > 8 m away or self

      const lon = dx * fwdX + dz * fwdZ;    // +ahead, -behind
      const lat = dx * rightX + dz * rightZ; // +right, -left

      // Overlap box: roughly one car length ahead/behind, adjacent lane laterally
      if (lon >= -4.8 && lon <= 4.8) {
        if (lat <= -1.25 && lat >= -4.8) carLeft = true;
        if (lat >= 1.25 && lat <= 4.8) carRight = true;
      }
    }

    const threeWide = carLeft && carRight;
    let callout: SpotterCallout | null = null;

    if (threeWide && !this.threeWideActive && nowMs - this.lastCallAt > 1800) {
      callout = { headline: '📻 SPOTTER', detail: 'THREE WIDE — HOLD YOUR LINE!', speech: 'Three wide, hold your line.' };
    } else if (carLeft && !this.leftActive && !threeWide && nowMs - this.lastCallAt > 1800) {
      callout = { headline: '📻 SPOTTER', detail: 'CAR LEFT — HOLD HIGH', speech: 'Car left.' };
    } else if (carRight && !this.rightActive && !threeWide && nowMs - this.lastCallAt > 1800) {
      callout = { headline: '📻 SPOTTER', detail: 'CAR RIGHT — HOLD LOW', speech: 'Car right.' };
    } else if (!carLeft && !carRight && (this.leftActive || this.rightActive || this.threeWideActive) && nowMs - this.lastClearAt > 2400) {
      callout = { headline: '📻 SPOTTER', detail: 'ALL CLEAR', speech: 'Clear.' };
      this.lastClearAt = nowMs;
    }

    this.leftActive = carLeft;
    this.rightActive = carRight;
    this.threeWideActive = threeWide;

    if (callout) {
      this.lastCallAt = nowMs;
      this.speak(callout.speech);
    }
    return callout;
  }

  /** Announce a race-control event (flag, final lap, damage, victim shield) with cooldown protection. */
  announce(key: string, detail: string, speech: string, nowMs: number, cooldownMs = 8000): SpotterCallout | null {
    if (!this.enabled) return null;
    const prev = this.lastSpecialAt.get(key) ?? 0;
    if (nowMs - prev < cooldownMs) return null;
    this.lastSpecialAt.set(key, nowMs);
    this.speak(speech);
    return { headline: '📻 RACE CONTROL', detail, speech };
  }

  private speak(text: string) {
    if (!this.voiceEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      if (synth.speaking) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.18;
      u.pitch = 0.95;
      u.volume = 0.72;
      synth.speak(u);
    } catch { /* browser blocked speech */ }
  }
}
