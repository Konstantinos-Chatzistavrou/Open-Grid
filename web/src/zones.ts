// City-Wide Speed Traps & Drift Zones + Global/Party Leaderboards (Free Roam Exploration, OpenGrid).
// Deterministically scatters Speed Traps (fast straightaways) and Drift Zones (narrow twisty streets)
// across every real-scale city (NYC, London, Paris, Tokyo, LA), renders glowing 3D street gates,
// tracks live drift combos & trap speeds, awards XP + 1-3 Stars, and maintains persistent Global/Party Leaderboards.
import * as THREE from 'three/webgpu';
import type { ZoneScoreNetMsg } from './party';
import { ZONE_STAR_XP } from './progression';

export type ZoneKind = 'speed' | 'drift';

export interface ZoneDef {
  id: string;
  cityId: string;
  name: string;
  kind: ZoneKind;
  /** World entry position (three.js x, y, z) */
  start: THREE.Vector3;
  /** World exit position (same as start for Speed Traps; 180-240 m down-street for Drift Zones) */
  end: THREE.Vector3;
  /** Entry gate heading yaw (rad) */
  startYaw: number;
  endYaw: number;
  /** 1-star, 2-star, 3-star thresholds (km/h for speed traps; points for drift zones) */
  stars: [number, number, number];
}

export interface LeaderboardEntry {
  name: string;
  score: number;
  car: string;
  stars: number;
  you?: boolean;
  party?: boolean;
}

export interface ZoneHooks {
  onScore(z: ZoneDef, score: number, stars: number, isPB: boolean, xp: number): void;
  sendNet(msg: ZoneScoreNetMsg): void;
}

const STORAGE_KEY = 'nr.zones.v1';

const SPEED_NAMES: Record<string, string[]> = {
  nyc: ['7th Ave Laser Trap', 'Midtown Straight', 'Broadway Sprint', 'Park Ave Blitz'],
  london: ['The Strand Radar', 'Piccadilly Dash', 'Embankment Trap', 'Whitehall Sprint'],
  paris: ['Champs-Élysées Trap', 'Quai de Seine Run', 'Concorde Laser', 'Rivoli Blitz'],
  tokyo: ['Shinjuku Express', 'Omotesando Laser', 'Meiji Dori Sprint', 'Aoyama Trap'],
  losangeles: ['Broadway Straight', 'Figueroa Sprint', 'Grand Ave Radar', 'Wilshire Blitz'],
};

const DRIFT_NAMES: Record<string, string[]> = {
  nyc: ['SoHo Alley Slide', 'Hell\'s Kitchen Switch', 'Tribeca Hairpin', 'Lower East Drift'],
  london: ['Soho Narrow Bend', 'Trafalgar Sweep', 'Fleet St Chicane', 'Aldwych Slide'],
  paris: ['Le Marais Twist', 'Louvre Quai Drift', 'Place Vendôme Arc', 'Latin Quarter Slide'],
  tokyo: ['Shibuya Scramble Drift', 'Harajuku Touge', 'Kabukicho Alley', 'Yoyogi Sweep'],
  losangeles: ['Bunker Hill Switch', 'Arts District Drift', 'Olvera Corner', 'Spring St Sweep'],
};

/** Seeded realistic global leaderboard rivals so every zone has competitive targets immediately. */
function seededBoard(z: ZoneDef): LeaderboardEntry[] {
  const [s1, s2, s3] = z.stars;
  const mult = z.kind === 'speed' ? 1 : 1;
  return [
    { name: 'Kurogane_JP', score: Math.round(s3 * 1.12 * mult), car: 'strix_gt7', stars: 3 },
    { name: 'Valkyrie99', score: Math.round(s3 * 1.03 * mult), car: 'basilisk_v12', stars: 3 },
    { name: 'MidnightApex', score: Math.round((s2 + s3) * 0.52 * mult), car: 'harrier_gt', stars: 2 },
    { name: 'StreetGhost', score: Math.round(s2 * 0.96 * mult), car: 'kestrel_gt', stars: 2 },
    { name: 'Redline_NYC', score: Math.round(s1 * 1.08 * mult), car: 'vela_gt', stars: 1 },
  ];
}

export function starsFor(z: ZoneDef, score: number): number {
  if (score >= z.stars[2]) return 3;
  if (score >= z.stars[1]) return 2;
  if (score >= z.stars[0]) return 1;
  return 0;
}

/** Deterministically scatter 4 Speed Traps (straights) + 4 Drift Zones (corners) from any city's route samples. */
export function buildCityZones(
  cityId: string,
  samples: { x: number; y: number; z: number }[],
): ZoneDef[] {
  const n = samples.length;
  if (n < 16) return [];
  // Convert core Z-up (x, y, z) -> three.js (x, z, -y)
  const pts = samples.map((p) => new THREE.Vector3(p.x, p.z, -p.y));
  const headingAt = (i: number) => {
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    return Math.atan2(b.x - a.x, b.z - a.z);
  };
  const curvAt = (i: number) => {
    const h0 = headingAt((i - 2 + n) % n);
    const h1 = headingAt((i + 2) % n);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    return Math.abs(dh);
  };

  // Partition route into 8 evenly spaced sectors; alternate Speed Traps (lowest curvature in sector)
  // and Drift Zones (highest curvature in sector) so every part of the city has exploration activities.
  const zones: ZoneDef[] = [];
  const sNames = SPEED_NAMES[cityId] ?? SPEED_NAMES.nyc;
  const dNames = DRIFT_NAMES[cityId] ?? DRIFT_NAMES.nyc;
  const sectors = 8;
  const secLen = Math.max(2, Math.floor(n / sectors));
  let sCount = 0;
  let dCount = 0;

  for (let sec = 0; sec < sectors; sec++) {
    const startIdx = (sec * secLen + 3) % n;
    const isSpeed = sec % 2 === 0;
    let bestIdx = startIdx;
    let bestMetric = isSpeed ? Infinity : -1;

    for (let k = 0; k < Math.max(1, secLen - 2); k++) {
      const idx = (startIdx + k) % n;
      const c = curvAt(idx);
      if (isSpeed ? c < bestMetric : c > bestMetric) {
        bestMetric = c;
        bestIdx = idx;
      }
    }

    if (isSpeed) {
      const p = pts[bestIdx].clone();
      const yaw = headingAt(bestIdx);
      zones.push({
        id: `${cityId}_speed_${sCount}`,
        cityId,
        name: sNames[sCount % sNames.length],
        kind: 'speed',
        start: p,
        end: p.clone(),
        startYaw: yaw,
        endYaw: yaw,
        stars: [145, 200, 250],
      });
      sCount++;
    } else {
      const pStart = pts[bestIdx].clone();
      // Walk ~180 m forward along samples for Drift Zone exit gate
      let dist = 0;
      let endIdx = bestIdx;
      for (let step = 0; step < Math.min(n - 2, 45); step++) {
        const next = (endIdx + 1) % n;
        dist += pts[endIdx].distanceTo(pts[next]);
        endIdx = next;
        if (dist >= 180) break;
      }
      const pEnd = pts[endIdx].clone();
      zones.push({
        id: `${cityId}_drift_${dCount}`,
        cityId,
        name: dNames[dCount % dNames.length],
        kind: 'drift',
        start: pStart,
        end: pEnd,
        startYaw: headingAt(bestIdx),
        endYaw: headingAt(endIdx),
        stars: [1500, 3500, 6500],
      });
      dCount++;
    }
  }
  return zones;
}

export class CityZones {
  readonly zones: ZoneDef[];
  readonly root = new THREE.Group();
  private boards = new Map<string, LeaderboardEntry[]>();
  private personalBest = new Map<string, number>();
  private cooldowns = new Map<string, number>();

  /** Currently active Drift Zone attempt, or null. */
  activeDrift: {
    zone: ZoneDef;
    score: number;
    combo: number;
    timer: number;
    holdSlip: number;
  } | null = null;

  /** Toggleable Global Leaderboard overlay state (`KeyB`). */
  boardVisible = false;
  /** Most recently triggered zone (shown first in leaderboard overlay). */
  lastZoneId = '';

  constructor(
    scene: THREE.Scene,
    cityId: string,
    samples: { x: number; y: number; z: number }[],
    private hooks: ZoneHooks,
  ) {
    this.zones = buildCityZones(cityId, samples);
    this.root.name = 'free_roam_zones';
    this.loadSaved();
    this.buildGates();
    scene.add(this.root);
  }

  /** Remove all zone gates from the scene and free GPU resources (for seamless city switching). */
  dispose() {
    this.activeDrift = null;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) mat?.dispose();
    });
    this.root.removeFromParent();
  }

  private loadSaved() {
    let saved: Record<string, LeaderboardEntry[]> = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, LeaderboardEntry[]>;
    } catch { /* storage blocked */ }

    for (const z of this.zones) {
      const merged = [...seededBoard(z), ...(saved[z.id] ?? [])];
      const byName = new Map<string, LeaderboardEntry>();
      for (const e of merged) {
        const prev = byName.get(e.name);
        if (!prev || e.score > prev.score) byName.set(e.name, e);
      }
      const sorted = [...byName.values()].sort((a, b) => b.score - a.score).slice(0, 10);
      this.boards.set(z.id, sorted);
      const mine = sorted.find((e) => e.you);
      if (mine) this.personalBest.set(z.id, mine.score);
    }
  }

  private saveLocal() {
    try {
      const out: Record<string, LeaderboardEntry[]> = {};
      for (const [id, list] of this.boards) {
        const keep = list.filter((e) => e.you || e.party);
        if (keep.length) out[id] = keep;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch { /* storage blocked */ }
  }

  private buildGates() {
    const postGeo = new THREE.BoxGeometry(0.24, 6.2, 0.24);
    const beamGeo = new THREE.BoxGeometry(11.6, 0.3, 0.24);
    const speedMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    const speedBeam = new THREE.MeshBasicMaterial({ color: 0x60f8ff });
    const driftMat = new THREE.MeshBasicMaterial({ color: 0xff9f1c });
    const driftBeam = new THREE.MeshBasicMaterial({ color: 0xff2d88 });

    const placeGate = (pos: THREE.Vector3, yaw: number, isSpeed: boolean, label: string) => {
      const g = new THREE.Group();
      g.name = label;
      const pMat = isSpeed ? speedMat : driftMat;
      const bMat = isSpeed ? speedBeam : driftBeam;
      const l = new THREE.Mesh(postGeo, pMat); l.position.set(-5.8, 3.1, 0);
      const r = new THREE.Mesh(postGeo, pMat); r.position.set(5.8, 3.1, 0);
      const top = new THREE.Mesh(beamGeo, bMat); top.position.set(0, 6.15, 0);
      g.add(l, r, top);
      g.position.copy(pos);
      g.rotation.y = yaw;
      this.root.add(g);
    };

    for (const z of this.zones) {
      placeGate(z.start, z.startYaw, z.kind === 'speed', `zone_start_${z.id}`);
      if (z.kind === 'drift') {
        placeGate(z.end, z.endYaw, false, `zone_end_${z.id}`);
      }
    }
  }

  setVisible(on: boolean) {
    this.root.visible = on;
    if (!on) {
      this.activeDrift = null;
      this.boardVisible = false;
    }
  }

  /** Receive a Speed Trap / Drift Zone score from another player in the 16-player Free Roam lobby. */
  receiveNetScore(msg: ZoneScoreNetMsg) {
    const z = this.zones.find((x) => x.id === msg.zoneId);
    if (!z) return;
    this.recordEntry(z, { name: msg.name, score: Math.round(msg.score), car: msg.car, stars: msg.stars, party: true });
  }

  private recordEntry(z: ZoneDef, entry: LeaderboardEntry): boolean {
    const list = this.boards.get(z.id) ?? seededBoard(z);
    const prev = list.find((e) => e.name === entry.name);
    const improved = !prev || entry.score > prev.score;
    if (improved) {
      const next = [...list.filter((e) => e.name !== entry.name), entry]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      this.boards.set(z.id, next);
      if (entry.you) this.personalBest.set(z.id, entry.score);
      this.saveLocal();
    }
    return improved;
  }

  /** Per-frame update in Free Roam: checks Speed Trap triggers and live Drift Zone scoring. */
  update(
    dt: number,
    enabled: boolean,
    playerPos: THREE.Vector3,
    kmh: number,
    sideslipRad: number,
    playerName: string,
    carId: string,
    now = performance.now(),
  ) {
    if (!enabled) {
      this.activeDrift = null;
      return;
    }

    // Distance-cull far checkpoint/zone gate meshes (saves draw calls when gates are > 260 m away across the city)
    for (const ch of this.root.children) {
      const dx = ch.position.x - playerPos.x;
      const dz = ch.position.z - playerPos.z;
      ch.visible = dx * dx + dz * dz < 260 * 260;
    }

    // 1. Update active Drift Zone scoring
    if (this.activeDrift) {
      const d = this.activeDrift;
      d.timer += dt;
      const slip = Math.abs(sideslipRad);
      if (kmh > 28 && slip > 0.13) {
        d.holdSlip += dt;
        d.combo = Math.min(4.0, 1.0 + Math.floor(d.holdSlip / 1.4) * 0.5);
        d.score += (kmh / 3.6) * Math.min(1.1, slip) * d.combo * dt * 52;
      } else if (kmh < 10) {
        d.holdSlip = 0;
        d.combo = 1.0;
      }

      const distExit = Math.hypot(playerPos.x - d.zone.end.x, playerPos.z - d.zone.end.z);
      if (distExit < 14 && d.timer > 1.2) {
        const finalScore = Math.round(d.score);
        const z = d.zone;
        this.activeDrift = null;
        this.cooldowns.set(z.id, now + 10_000);
        this.completeZone(z, finalScore, playerName, carId);
        return;
      }
      // Cancel if driver left the corridor or timed out
      if (d.timer > 32 || Math.hypot(playerPos.x - d.zone.start.x, playerPos.z - d.zone.start.z) > 420) {
        this.activeDrift = null;
      }
    }

    // 2. Check gate triggers
    for (const z of this.zones) {
      const cd = this.cooldowns.get(z.id) ?? 0;
      if (now < cd) continue;
      const dist = Math.hypot(playerPos.x - z.start.x, playerPos.z - z.start.z);
      if (dist > 12.5) continue;

      if (z.kind === 'speed' && kmh >= 50) {
        this.cooldowns.set(z.id, now + 12_000);
        this.completeZone(z, Math.round(kmh), playerName, carId);
      } else if (z.kind === 'drift' && !this.activeDrift && kmh >= 25) {
        this.activeDrift = { zone: z, score: 0, combo: 1.0, timer: 0, holdSlip: 0 };
        this.lastZoneId = z.id;
      }
    }
  }

  private completeZone(z: ZoneDef, score: number, playerName: string, carId: string) {
    this.lastZoneId = z.id;
    const stars = starsFor(z, score);
    const prevPB = this.personalBest.get(z.id) ?? 0;
    const isPB = score > prevPB;
    this.recordEntry(z, { name: playerName, score, car: carId, stars, you: true });
    const xp = isPB ? ZONE_STAR_XP[stars] : Math.round(ZONE_STAR_XP[stars] * 0.25);
    this.hooks.onScore(z, score, stars, isPB, xp);
    if (isPB) {
      this.hooks.sendNet({ zoneId: z.id, zoneName: z.name, kind: z.kind, score, stars, car: carId, name: playerName });
    }
  }

  /** Minimap blips for all Speed Traps (cyan) and Drift Zones (amber). */
  minimapBlips(): { x: number; z: number; color: string }[] {
    const out: { x: number; z: number; color: string }[] = [];
    for (const z of this.zones) {
      out.push({ x: z.start.x, z: z.start.z, color: z.kind === 'speed' ? '#00e5ff' : '#ff9f1c' });
    }
    return out;
  }

  /** Live Drift Zone HUD pill HTML (empty when not inside a drift zone). */
  driftHudHtml(): string {
    if (!this.activeDrift) return '';
    const d = this.activeDrift;
    const pts = Math.round(d.score).toLocaleString();
    const stars = '★'.repeat(starsFor(d.zone, d.score)) + '☆'.repeat(3 - starsFor(d.zone, d.score));
    return `<div class="drift-pill"><b>🔥 ${d.zone.name}</b> · <span>${pts} PTS</span> · ${d.combo.toFixed(1)}× · ${stars}</div>`;
  }

  /** Compact Global/Party Leaderboard overlay HTML (toggled via [B] in Free Roam). */
  leaderboardHtml(): string {
    if (!this.boardVisible) return '';
    const ordered = [...this.zones].sort((a, b) => (a.id === this.lastZoneId ? -1 : b.id === this.lastZoneId ? 1 : 0));
    const cards = ordered.slice(0, 6).map((z) => {
      const unit = z.kind === 'speed' ? 'km/h' : 'pts';
      const rows = (this.boards.get(z.id) ?? []).slice(0, 5).map((e, idx) =>
        `<div class="zb-row ${e.you ? 'you' : e.party ? 'party' : ''}"><span>#${idx + 1}</span><b>${e.name}</b><span>${e.score.toLocaleString()} ${unit}</span></div>`,
      ).join('');
      return `<div class="zb-card"><div class="zb-head"><span class="zb-tag ${z.kind}">${z.kind === 'speed' ? '⚡ SPEED TRAP' : '🔥 DRIFT ZONE'}</span><b>${z.name}</b></div>${rows}</div>`;
    }).join('');
    return `<div class="zone-board"><div class="zb-top"><b>GLOBAL &amp; PARTY LEADERBOARDS</b><span>Press [B] to close · Explore narrow streets to set records</span></div><div class="zb-grid">${cards}</div></div>`;
  }

  /** Snapshot for diagnostics/tests. */
  summary() {
    return {
      totalZones: this.zones.length,
      speedTraps: this.zones.filter((z) => z.kind === 'speed').length,
      driftZones: this.zones.filter((z) => z.kind === 'drift').length,
      personalBests: Object.fromEntries(this.personalBest),
      activeDrift: this.activeDrift ? { zone: this.activeDrift.zone.name, score: Math.round(this.activeDrift.score) } : null,
    };
  }
}
