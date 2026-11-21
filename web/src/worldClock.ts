// World Time, Real-Life Seasons, 1-in-5 Dynamic Rain & Realistic Traffic Density Curve (OpenGrid).
// - 1:4 Time Scale: 30 real minutes = 2 in-game hours (4x real-time progression).
// - Real-Life Seasons: synced to the real-world month (Dec-Feb Winter snow/ice grip, Jun-Aug hot summer tarmac).
// - Weather: random 1-in-5 (20%) chance of rain per race/session using shader-driven road wetness (no volumetric cost).
// - Traffic Density Curve:
//     22:00 - 01:00: Medium/Dense (100% cruising cars — high-speed weaving)
//     01:00 - 03:00: Sparse (45% — open avenues for drags)
//     04:00 - 05:30: Almost zero (10% — pure hotlap mode)
import * as THREE from 'three/webgpu';

export type SeasonKind = 'winter' | 'spring' | 'summer' | 'autumn';
export type WeatherKind = 'dry' | 'rain';

export interface SeasonInfo {
  id: SeasonKind;
  label: string;
  icon: string;
  gripMul: number;
  skyTint: number;
  ambientNote: string;
}

const SEASONS: Record<SeasonKind, SeasonInfo> = {
  winter: { id: 'winter', label: 'Winter', icon: '❄️', gripMul: 0.80, skyTint: 0x060914, ambientNote: 'Cold tarmac & ice patches' },
  spring: { id: 'spring', label: 'Spring', icon: '🌸', gripMul: 0.97, skyTint: 0x05070f, ambientNote: 'Cool evening air' },
  summer: { id: 'summer', label: 'Summer', icon: '☀️', gripMul: 1.05, skyTint: 0x07060d, ambientNote: 'Warm high-grip asphalt' },
  autumn: { id: 'autumn', label: 'Autumn', icon: '🍂', gripMul: 0.94, skyTint: 0x07060b, ambientNote: 'Damp leaves & crisp air' },
};

export function currentRealSeason(date = new Date()): SeasonInfo {
  const m = date.getMonth(); // 0 = Jan .. 11 = Dec
  if (m === 11 || m === 0 || m === 1) return SEASONS.winter;
  if (m >= 2 && m <= 4) return SEASONS.spring;
  if (m >= 5 && m <= 7) return SEASONS.summer;
  return SEASONS.autumn;
}

/** 1:4 time scale -> 1 real second = 4 in-game seconds (30 real min = 2 game hours). */
const TIME_SCALE = 4;

export class WorldClock {
  /** In-game seconds since midnight (0..86400). Starts at 22:30 (Night Shift). */
  gameSeconds = 22.5 * 3600;
  readonly season: SeasonInfo = currentRealSeason();
  weather: WeatherKind = 'dry';
  /** Shader wetness factor 0.15 (dry night sheen) .. 1.0 (rain puddles). */
  wetness = 0.28;
  private targetWetness = 0.28;
  private skyCol = new THREE.Color(0x05060c);
  /** twilight tint (reused: was a new THREE.Color every frame of dawn / dusk) */
  private twCol = new THREE.Color();

  constructor() {
    this.rollWeather(false);
  }

  /** Roll the 1-in-5 (20%) chance of rain for a new race or session. */
  rollWeather(isRace = true): WeatherKind {
    // 1-in-5 chance of rain per race (or slightly higher in Winter/Spring)
    const chance = isRace ? 0.20 : 0.25;
    this.weather = Math.random() < chance ? 'rain' : 'dry';
    this.targetWetness = this.weather === 'rain' ? 1.0 : (this.season.id === 'winter' ? 0.42 : 0.22);
    this.wetness = this.targetWetness;
    return this.weather;
  }

  /** Set weather explicitly ('dry' | 'rain') for testing or screenshots. */
  setWeather(w: WeatherKind) {
    this.weather = w;
    this.targetWetness = w === 'rain' ? 1.0 : 0.18;
    this.wetness = this.targetWetness;
  }

  /** Set in-game hour directly (0..24) for testing or Car Meet atmosphere. */
  setHour(h: number) {
    this.gameSeconds = (((h % 24) + 24) % 24) * 3600;
  }

  get hour(): number { return (this.gameSeconds / 3600) % 24; }

  /** Formatted 24h clock string (e.g. "22:34"). */
  get clockText(): string {
    const totalMin = Math.floor(this.gameSeconds / 60) % (24 * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  /**
   * Realistic Night Shift traffic density multiplier (0..1):
   *   22:00 - 01:00 -> 1.0 (Medium/Dense: weaving through traffic)
   *   01:00 - 03:00 -> 0.45 (Sparse: wide-open drag avenues)
   *   04:00 - 05:30 -> 0.10 (Near-zero: pure hotlap testing)
   */
  get trafficDensity(): number {
    const h = this.hour;
    if (h >= 22 || h < 1) return 1.0;
    if (h >= 1 && h < 3) return 0.45;
    if (h >= 3 && h < 4) return 0.25;
    if (h >= 4 && h <= 5.5) return 0.10;
    if (h > 5.5 && h < 9) return 0.65;
    return 0.85;
  }

  /** Combined seasonal + weather tire grip multiplier applied to physics / wear. */
  get gripMultiplier(): number {
    const rainMul = this.weather === 'rain' ? 0.86 : 1.0;
    return +(this.season.gripMul * rainMul).toFixed(3);
  }

  /** Advance 1:4 game clock and subtly update scene sky/fog & moon lighting. */
  update(dt: number, scene: THREE.Scene, moon: THREE.DirectionalLight) {
    this.gameSeconds = (this.gameSeconds + dt * TIME_SCALE) % 86400;
    this.wetness += (this.targetWetness - this.wetness) * Math.min(1, dt * 0.6);

    // Subtle twilight/dawn/midnight sky mood shift (keeps night racing identity crisp!)
    const h = this.hour;
    const dawnGlow = h >= 5 && h <= 7.5 ? Math.sin(((h - 5) / 2.5) * Math.PI) : 0;
    const duskGlow = h >= 19.5 && h <= 21.5 ? Math.sin(((h - 19.5) / 2.0) * Math.PI) : 0;
    const twilight = Math.max(dawnGlow, duskGlow);

    this.skyCol.setHex(this.season.skyTint);
    if (twilight > 0.01) {
      this.skyCol.lerp(this.twCol.setHex(dawnGlow > duskGlow ? 0x1a1d34 : 0x1e1128), twilight * 0.65);
    }
    if (scene.background instanceof THREE.Color) scene.background.copy(this.skyCol);
    if (scene.fog instanceof THREE.FogExp2) scene.fog.color.copy(this.skyCol);
    moon.intensity = 0.04 + twilight * 0.14 + (this.weather === 'rain' ? -0.01 : 0);
  }

  hudText(): string {
    const wIcon = this.weather === 'rain' ? '🌧 RAIN' : 'CLEAR';
    const dTag = this.trafficDensity >= 0.8 ? 'DENSE' : this.trafficDensity >= 0.35 ? 'SPARSE' : 'EMPTY';
    return `${this.clockText} · ${this.season.icon} ${this.season.label.toUpperCase()} · ${wIcon} · TRAFFIC ${dTag}`;
  }
}
