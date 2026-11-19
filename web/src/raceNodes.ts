// GTA Online-Style Instanced Map Race Nodes & Matchmaking Lobby Flow (OpenGrid).
// Scatters glowing 3D Race Event Nodes across the Free Roam city map. Driving into a Race Node
// and pressing [Enter] opens a Matchmaking Lobby transition screen, spins up an instanced Race Event
// (pulling you cleanly out of Free Roam), and allows seamlessly returning to Free Roam when finished.
import * as THREE from 'three/webgpu';
import { t } from './i18n';

export interface RaceNodeDef {
  id: string;
  name: string;
  laps: number;
  copMode: boolean;
  pos: THREE.Vector3;
  yaw: number;
  playersText: string;
}

export interface MatchmakingHooks {
  onLaunchRace(node: RaceNodeDef): void;
}

const NODE_SPECS = [
  { name: 'Midtown Midnight Sprint', laps: 3, copMode: true, playersText: '8–12 Players · Tactical Cops' },
  { name: 'Underground Pursuit Circuit', laps: 5, copMode: true, playersText: '8–12 Players · High-Stakes Heat' },
  { name: 'Clean Apex Time Attack', laps: 3, copMode: false, playersText: '8–12 Players · Pure Sim Physics' },
  { name: '5-Floor Car Meet Hub', laps: 0, copMode: false, playersText: '16 Players · Car Meet & Emotes' },
];

export class RaceNodes {
  readonly nodes: RaceNodeDef[] = [];
  readonly root = new THREE.Group();
  nearby: RaceNodeDef | null = null;
  matchmaking = false;
  /** True when the current race was launched from a Free Roam Race Node (enables "Return to Free Roam"). */
  launchedFromFreeRoam = false;

  private rings: THREE.Mesh[] = [];
  private mmEl: HTMLElement;
  private mmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    scene: THREE.Scene,
    cityId: string,
    samples: { x: number; y: number; z: number }[],
    mandatoryCops: boolean,
    private hooks: MatchmakingHooks,
  ) {
    this.root.name = 'freeroam_race_nodes';
    this.mmEl = document.getElementById('matchmaking-ui')!;
    const n = samples.length;
    if (n >= 16) {
      // Place 4 nodes evenly around the city (node 0 close enough to the start line to explore quickly!)
      const offsets = [Math.min(n - 1, 8), Math.floor(n * 0.28), Math.floor(n * 0.56), Math.floor(n * 0.82)];
      for (let i = 0; i < NODE_SPECS.length; i++) {
        const idx = offsets[i] % n;
        const p = samples[idx];
        const q = samples[(idx + 1) % n];
        const pos = new THREE.Vector3(p.x, p.z, -p.y);
        const yaw = Math.atan2(q.x - p.x, -q.y - (-p.y));
        const spec = NODE_SPECS[i];
        const node: RaceNodeDef = {
          id: `${cityId}_node_${i}`,
          name: spec.name,
          laps: spec.laps,
          copMode: spec.laps > 0 ? (mandatoryCops || spec.copMode) : false,
          pos,
          yaw,
          playersText: spec.playersText,
        };
        this.nodes.push(node);
        this.addVisual(node);
      }
    }
    scene.add(this.root);
    this.mmEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-mm-cancel]')) this.cancelMatchmaking();
    });
  }

  private addVisual(node: RaceNodeDef) {
    const g = new THREE.Group();
    const isMeet = node.laps === 0;
    const col = isMeet ? 0x00f5a0 : 0xc77dff;
    // Glowing holographic floor ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.4, 4.1, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.position.y = 0.14;
    // Vertical light beacon column
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.45, 9.5, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }),
    );
    pillar.position.y = 4.75;
    g.add(ring, pillar);
    g.position.copy(node.pos);
    g.rotation.y = node.yaw;
    this.root.add(g);
    this.rings.push(ring);
  }

  setVisible(on: boolean) {
    this.root.visible = on;
    if (!on) this.nearby = null;
  }

  update(dt: number, enabled: boolean, playerPos: THREE.Vector3) {
    if (!enabled) { this.nearby = null; return; }
    for (const r of this.rings) r.rotation.z += dt * 0.9;
    let best: RaceNodeDef | null = null;
    let bd = 16;
    for (const n of this.nodes) {
      const d = Math.hypot(playerPos.x - n.pos.x, playerPos.z - n.pos.z);
      if (d < bd) { bd = d; best = n; }
    }
    this.nearby = best;
  }

  /** Trigger the GTA Online-style Matchmaking Lobby transition from a Race Node. */
  startMatchmaking(node: RaceNodeDef) {
    if (this.matchmaking) return;
    this.matchmaking = true;
    this.launchedFromFreeRoam = true;
    const steps = [
      'Pulling out of 16-player Free Roam lobby…',
      t('matchmaking.searching'),
      `Allocating dedicated instance (${node.playersText})…`,
      'Syncing grid positions & physics clock…',
    ];
    let step = 0;
    const render = () => {
      this.mmEl.innerHTML = `<div class="mm-card">
        <div class="kicker">🌐 ${t('matchmaking.title')}</div>
        <h2>${node.name}</h2>
        <p class="dim">${node.laps} Laps · ${node.copMode ? '🚨 Tactical Cops ON' : 'Clean Track Rules'} · ${node.playersText}</p>
        <div class="mm-status"><span class="spin inline"></span> ${steps[Math.min(step, steps.length - 1)]}</div>
        <div class="mm-bar"><i style="width:${Math.min(100, (step + 1) * 25)}%"></i></div>
        <button class="small" data-mm-cancel="1">Cancel &amp; Stay in Free Roam</button>
      </div>`;
    };
    this.mmEl.hidden = false;
    render();
    const advance = () => {
      if (!this.matchmaking) return;
      step++;
      if (step >= steps.length) {
        this.matchmaking = false;
        this.mmEl.hidden = true;
        this.hooks.onLaunchRace(node);
        return;
      }
      render();
      this.mmTimer = setTimeout(advance, 420);
    };
    this.mmTimer = setTimeout(advance, 420);
  }

  cancelMatchmaking() {
    if (this.mmTimer) clearTimeout(this.mmTimer);
    this.mmTimer = null;
    this.matchmaking = false;
    this.mmEl.hidden = true;
  }

  promptHtml(): string {
    if (!this.nearby || this.matchmaking) return '';
    const n = this.nearby;
    if (n.laps === 0) {
      return `<div class="wager-pill live"><b>🚗 ${n.name}</b> · <span>[Enter] ENTER 5-FLOOR CAR MEET</span></div>`;
    }
    return `<div class="wager-pill offer"><b>🏁 ${n.name}</b> · ${n.laps} Laps · ${n.copMode ? '🚨 Cops ON' : 'Clean'} · <span>[Enter] MATCHMAKING LOBBY</span></div>`;
  }

  minimapBlips(raceNodeColor: string): { x: number; z: number; color: string }[] {
    return this.nodes.map((n) => ({
      x: n.pos.x,
      z: n.pos.z,
      color: n.laps === 0 ? '#00f5a0' : raceNodeColor,
    }));
  }
}
