// 5-Floor Car Meet Hub + Walkable Driver Avatar Emotes + Open Hood/Trunk + Custom Radio/Playlist (OpenGrid).
// Lets players chill in Free Roam / Car Meets: pop their hood (revealing an illuminated twin-turbo engine bay),
// open their trunk (subwoofer showcase), step out in their customized Helmet/Suit/Gloves/Shoes, walk around,
// trigger RP emotes (Sit on Hood, Lean on Door, Wave, Inspect Engine, Celebrate), and play Synthwave radio
// or paste a custom Spotify / YouTube Music playlist URL!
import * as THREE from 'three/webgpu';
import { t } from './i18n';

export type MeetEmote = 'idle' | 'sit_hood' | 'lean_door' | 'wave' | 'inspect' | 'celebrate';

export interface AvatarGear {
  helmet: string;
  accent: string;
  visor: string;
  suit: string;
  gloves: string;
  shoes: string;
}

export const DEFAULT_AVATAR_GEAR: AvatarGear = {
  helmet: '#f4f4f6',
  accent: '#ff2d6a',
  visor: '#141824',
  suit: '#1d2230',
  gloves: '#ff2d6a',
  shoes: '#f4f4f6',
};

const FLOORS = [
  'Floor 1 · Street Imports',
  'Floor 2 · Euro Exotics',
  'Floor 3 · JDM Touge',
  'Floor 4 · Drift Pit',
  'Floor 5 · Rooftop Penthouse',
];

const STATIONS = [
  { id: 'off', name: 'Radio Off', bpm: 0, baseHz: 0 },
  { id: 'synthwave', name: 'Nightshift FM · Synthwave', bpm: 108, baseHz: 110 },
  { id: 'phonk', name: 'Underground 808 · Drift Phonk', bpm: 128, baseHz: 82.4 },
  { id: 'lofi', name: '3AM Rain · Midnight Lo-Fi', bpm: 84, baseHz: 130.8 },
];

export interface CarMeetHooks {
  onToast(title: string, detail: string): void;
  onSyncCamera?(pos: THREE.Vector3, target: THREE.Vector3): void;
}

export class CarMeetHub {
  panelOpen = false;
  walking = false;
  hoodOpen = false;
  trunkOpen = false;
  hazardsOn = false;
  floorIdx = 4; // Floor 5 Rooftop Penthouse default
  emote: MeetEmote = 'idle';
  stationId = 'off';
  playlistUrl = '';

  private el: HTMLElement;
  private hoodAngle = 0;
  private trunkAngle = 0;
  private showcaseGroup = new THREE.Group();
  private hoodPivot = new THREE.Group();
  private trunkPivot = new THREE.Group();
  private engineGlow: THREE.MeshBasicMaterial | null = null;
  private attachedRoot: THREE.Object3D | null = null;

  // Walkable 3D driver avatar (wears Helmet, Suit, Gloves, Shoes)
  readonly avatar = new THREE.Group();
  private avParts: {
    torso: THREE.Mesh;
    head: THREE.Group;
    armL: THREE.Group;
    armR: THREE.Group;
    legL: THREE.Group;
    legR: THREE.Group;
    mats: { helmet: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial; visor: THREE.MeshStandardMaterial; suit: THREE.MeshStandardMaterial; gloves: THREE.MeshStandardMaterial; shoes: THREE.MeshStandardMaterial };
  };
  private avYaw = 0;
  private avTime = 0;
  private gear: AvatarGear = { ...DEFAULT_AVATAR_GEAR };

  // Lightweight procedural WebAudio Car Meet radio (zero external MP3 needed!)
  private audioCtx: AudioContext | null = null;
  private radioTimer: ReturnType<typeof setInterval> | null = null;
  private radioStep = 0;

  constructor(private scene: THREE.Scene, private hooks: CarMeetHooks) {
    this.el = document.getElementById('carmeet-ui')!;
    this.buildShowcaseMeshes();
    this.avParts = this.buildWalkableAvatar();
    this.avatar.visible = false;
    this.scene.add(this.avatar);
    this.bindDom();
  }

  private buildShowcaseMeshes() {
    this.showcaseGroup.name = 'carmeet_showcase';
    // Illuminated twin-turbo engine bay tucked under the front hood area
    const bay = new THREE.Group();
    bay.position.set(0, 0.72, 1.32);
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(0.76, 0.28, 0.82),
      new THREE.MeshStandardMaterial({ color: 0x1b1f2a, metalness: 0.85, roughness: 0.3 }),
    );
    const intakeL = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.72, 10).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xc0160f, metalness: 0.7, roughness: 0.25 }),
    );
    intakeL.position.set(-0.22, 0.16, 0);
    const intakeR = intakeL.clone();
    intakeR.position.x = 0.22;
    this.engineGlow = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.03, 0.04), this.engineGlow);
    led.position.set(0, 0.26, 0.36);
    bay.add(block, intakeL, intakeR, led);

    // Hinged carbon hood display panel
    this.hoodPivot.position.set(0, 0.94, 0.78);
    const hoodPanel = new THREE.Mesh(
      new THREE.BoxGeometry(1.48, 0.05, 1.15),
      new THREE.MeshStandardMaterial({ color: 0x12151d, metalness: 0.75, roughness: 0.22 }),
    );
    hoodPanel.position.set(0, 0, 0.56);
    this.hoodPivot.add(hoodPanel);

    // Hinged trunk lid + rear subwoofer neon showcase
    const trunkBay = new THREE.Group();
    trunkBay.position.set(0, 0.74, -1.55);
    const subBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.32, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x141720, roughness: 0.6 }),
    );
    const subRingL = new THREE.Mesh(
      new THREE.TorusGeometry(0.11, 0.02, 8, 18),
      new THREE.MeshBasicMaterial({ color: 0xff2d6a }),
    );
    subRingL.position.set(-0.24, 0, -0.22);
    const subRingR = subRingL.clone();
    subRingR.position.x = 0.24;
    trunkBay.add(subBox, subRingL, subRingR);

    this.trunkPivot.position.set(0, 0.98, -1.18);
    const trunkLid = new THREE.Mesh(
      new THREE.BoxGeometry(1.36, 0.05, 0.85),
      new THREE.MeshStandardMaterial({ color: 0x12151d, metalness: 0.75, roughness: 0.22 }),
    );
    trunkLid.position.set(0, 0, -0.42);
    this.trunkPivot.add(trunkLid);

    this.showcaseGroup.add(bay, this.hoodPivot, trunkBay, this.trunkPivot);
    this.showcaseGroup.visible = false;
  }

  private buildWalkableAvatar() {
    this.avatar.name = 'carmeet_walkable_avatar';
    const mats = {
      helmet: new THREE.MeshStandardMaterial({ color: this.gear.helmet, roughness: 0.25, metalness: 0.2 }),
      accent: new THREE.MeshStandardMaterial({ color: this.gear.accent, roughness: 0.3, metalness: 0.2 }),
      visor: new THREE.MeshStandardMaterial({ color: this.gear.visor, roughness: 0.08, metalness: 0.9 }),
      suit: new THREE.MeshStandardMaterial({ color: this.gear.suit, roughness: 0.82 }),
      gloves: new THREE.MeshStandardMaterial({ color: this.gear.gloves, roughness: 0.65 }),
      shoes: new THREE.MeshStandardMaterial({ color: this.gear.shoes, roughness: 0.55 }),
    };

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.44, 4, 12), mats.suit);
    torso.position.set(0, 1.12, 0);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.46, 0.37), mats.accent);
    torso.add(stripe);

    const head = new THREE.Group();
    head.position.set(0, 1.58, 0);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), mats.helmet);
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.29), mats.accent);
    crown.position.y = 0.08;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.12), mats.visor);
    visor.position.set(0, 0.01, 0.1);
    head.add(shell, crown, visor);

    const mkArm = (side: number) => {
      const g = new THREE.Group();
      g.position.set(side * 0.24, 1.34, 0);
      const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.42, 4, 8), mats.suit);
      limb.position.y = -0.22;
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), mats.gloves);
      glove.position.y = -0.46;
      g.add(limb, glove);
      return g;
    };
    const mkLeg = (side: number) => {
      const g = new THREE.Group();
      g.position.set(side * 0.11, 0.82, 0);
      const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.58, 4, 8), mats.suit);
      limb.position.y = -0.34;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.26), mats.shoes);
      shoe.position.set(0, -0.74, 0.05);
      g.add(limb, shoe);
      return g;
    };

    const armL = mkArm(1), armR = mkArm(-1), legL = mkLeg(1), legR = mkLeg(-1);
    this.avatar.add(torso, head, armL, armR, legL, legR);
    return { torso, head, armL, armR, legL, legR, mats };
  }

  /** Apply customized Helmet, Suit, Gloves, and Shoes colours to the walkable Car Meet avatar. */
  setAvatarGear(g: Partial<AvatarGear>) {
    Object.assign(this.gear, g);
    this.avParts.mats.helmet.color.set(this.gear.helmet);
    this.avParts.mats.accent.color.set(this.gear.accent);
    this.avParts.mats.visor.color.set(this.gear.visor);
    this.avParts.mats.suit.color.set(this.gear.suit);
    this.avParts.mats.gloves.color.set(this.gear.gloves);
    this.avParts.mats.shoes.color.set(this.gear.shoes);
  }

  attachToCar(carRoot: THREE.Object3D) {
    if (this.attachedRoot === carRoot) return;
    this.attachedRoot = carRoot;
    carRoot.add(this.showcaseGroup);
  }

  togglePanel(force?: boolean) {
    this.panelOpen = force ?? !this.panelOpen;
    this.el.hidden = !this.panelOpen;
    if (this.panelOpen) this.renderUi();
  }

  toggleStepOut(carPos: THREE.Vector3, carQuat: THREE.Quaternion, kmh: number) {
    if (!this.walking && kmh > 12) {
      this.hooks.onToast('SLOW DOWN TO STEP OUT', 'Stop the car (< 12 km/h) to walk around the Car Meet');
      return;
    }
    this.walking = !this.walking;
    this.emote = 'idle';
    if (this.walking) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat).setY(0).normalize();
      this.avatar.position.copy(carPos).addScaledVector(right, 1.85);
      this.avatar.position.y = Math.max(0, carPos.y - 0.45);
      this.avYaw = Math.atan2(-right.x, -right.z);
      this.avatar.rotation.y = this.avYaw;
      this.avatar.visible = true;
      this.hooks.onToast('🚶 STEPPED OUT OF CAR', 'WASD to walk · Open Car Meet [U] for Emotes, Hood & Trunk');
    } else {
      this.avatar.visible = false;
      this.hooks.onToast('🚗 BACK IN DRIVER SEAT', 'Ready to roll');
    }
    if (this.panelOpen) this.renderUi();
  }

  setEmote(em: MeetEmote, carPos: THREE.Vector3, carQuat: THREE.Quaternion) {
    if (!this.walking) this.toggleStepOut(carPos, carQuat, 0);
    this.emote = em;
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat).setY(0).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat).setY(0).normalize();
    if (em === 'sit_hood') {
      // Hop onto the front hood edge facing forward!
      this.avatar.position.copy(carPos).addScaledVector(fwd, 1.65);
      this.avatar.position.y = Math.max(0, carPos.y + 0.18);
      this.avYaw = Math.atan2(fwd.x, fwd.z);
    } else if (em === 'lean_door') {
      this.avatar.position.copy(carPos).addScaledVector(right, 1.35);
      this.avatar.position.y = Math.max(0, carPos.y - 0.45);
      this.avYaw = Math.atan2(right.x, right.z);
    } else if (em === 'inspect') {
      this.hoodOpen = true;
      this.avatar.position.copy(carPos).addScaledVector(fwd, 2.75);
      this.avatar.position.y = Math.max(0, carPos.y - 0.45);
      this.avYaw = Math.atan2(-fwd.x, -fwd.z);
    }
    this.avatar.rotation.y = this.avYaw;
    if (this.panelOpen) this.renderUi();
  }

  /** Update hood/trunk animations, walkable avatar movement, emotes, and optional third-person walk cam. */
  update(dt: number, inFreeRoam: boolean, carPos: THREE.Vector3, isKeyDown: (code: string) => boolean) {
    if (!inFreeRoam) {
      if (this.panelOpen) this.togglePanel(false);
      if (this.walking) { this.walking = false; this.avatar.visible = false; }
      this.hoodOpen = false;
      this.trunkOpen = false;
      this.showcaseGroup.visible = false;
      return;
    }

    // Smooth hood & trunk hinges
    const targetHood = this.hoodOpen ? -0.78 : 0;
    const targetTrunk = this.trunkOpen ? 0.85 : 0;
    this.hoodAngle += (targetHood - this.hoodAngle) * Math.min(1, dt * 7);
    this.trunkAngle += (targetTrunk - this.trunkAngle) * Math.min(1, dt * 7);
    this.hoodPivot.rotation.x = this.hoodAngle;
    this.trunkPivot.rotation.x = this.trunkAngle;
    this.showcaseGroup.visible = Math.abs(this.hoodAngle) > 0.02 || Math.abs(this.trunkAngle) > 0.02;

    if (!this.walking) return;
    this.avTime += dt;

    // Walkable avatar controls (WASD)
    const moveF = (isKeyDown('KeyW') || isKeyDown('ArrowUp') ? 1 : 0) - (isKeyDown('KeyS') || isKeyDown('ArrowDown') ? 1 : 0);
    const turn = (isKeyDown('KeyA') || isKeyDown('ArrowLeft') ? 1 : 0) - (isKeyDown('KeyD') || isKeyDown('ArrowRight') ? 1 : 0);
    let moving = false;
    if (Math.abs(moveF) > 0.1 || Math.abs(turn) > 0.1) {
      if (this.emote === 'sit_hood' || this.emote === 'lean_door') {
        this.emote = 'idle';
        this.avatar.position.y = Math.max(0, carPos.y - 0.45);
      }
      this.avYaw += turn * dt * 2.4;
      this.avatar.rotation.y = this.avYaw;
      this.avatar.position.x += Math.sin(this.avYaw) * moveF * dt * 3.1;
      this.avatar.position.z += Math.cos(this.avYaw) * moveF * dt * 3.1;
      // Keep within 28 m of car in Car Meet area
      const dx = this.avatar.position.x - carPos.x, dz = this.avatar.position.z - carPos.z;
      const d = Math.hypot(dx, dz);
      if (d > 28) { this.avatar.position.x = carPos.x + (dx / d) * 28; this.avatar.position.z = carPos.z + (dz / d) * 28; }
      moving = Math.abs(moveF) > 0.1;
    }

    // Pose limbs for walking or active RP emote
    const p = this.avParts;
    p.armL.rotation.set(0, 0, 0); p.armR.rotation.set(0, 0, 0);
    p.legL.rotation.set(0, 0, 0); p.legR.rotation.set(0, 0, 0);
    p.torso.rotation.set(0, 0, 0);
    if (moving) {
      const s = Math.sin(this.avTime * 8) * 0.55;
      p.legL.rotation.x = s; p.legR.rotation.x = -s;
      p.armL.rotation.x = -s * 0.7; p.armR.rotation.x = s * 0.7;
    } else if (this.emote === 'sit_hood') {
      p.legL.rotation.x = -1.35; p.legR.rotation.x = -1.35;
      p.armL.rotation.x = 0.35; p.armR.rotation.x = 0.35;
      p.torso.rotation.x = -0.15;
    } else if (this.emote === 'lean_door') {
      p.torso.rotation.z = 0.14;
      p.armL.rotation.z = -0.35; p.armR.rotation.z = 0.35;
    } else if (this.emote === 'wave') {
      p.armR.rotation.z = -2.4 + Math.sin(this.avTime * 7) * 0.35;
    } else if (this.emote === 'inspect') {
      p.torso.rotation.x = 0.32;
      p.armL.rotation.x = -0.6; p.armR.rotation.x = -0.6;
    } else if (this.emote === 'celebrate') {
      const hop = Math.abs(Math.sin(this.avTime * 6)) * 0.25;
      p.armL.rotation.z = 2.6 + hop; p.armR.rotation.z = -2.6 - hop;
    }

    // Smooth third-person orbit camera around the walking avatar + car (3/4 hero angle during static emotes)
    const camPos = (this.emote === 'sit_hood' || this.emote === 'inspect')
      ? new THREE.Vector3(
        this.avatar.position.x + Math.sin(this.avYaw) * 3.8 + Math.cos(this.avYaw) * 2.2,
        this.avatar.position.y + 1.55,
        this.avatar.position.z + Math.cos(this.avYaw) * 3.8 - Math.sin(this.avYaw) * 2.2,
      )
      : new THREE.Vector3(
        this.avatar.position.x - Math.sin(this.avYaw) * 3.8,
        this.avatar.position.y + 2.2,
        this.avatar.position.z - Math.cos(this.avYaw) * 3.8,
      );
    const lookTarget = this.avatar.position.clone().lerp(carPos, 0.4).add(new THREE.Vector3(0, 0.9, 0));
    this.hooks.onSyncCamera?.(camPos, lookTarget);
  }

  /** Built-in procedural WebAudio synthwave/phonk radio for Car Meets. */
  setStation(id: string) {
    this.stationId = id;
    if (this.radioTimer) { clearInterval(this.radioTimer); this.radioTimer = null; }
    const st = STATIONS.find((x) => x.id === id);
    if (!st || st.bpm <= 0) { if (this.panelOpen) this.renderUi(); return; }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AC();
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
      const notes = [1, 1, 1.2, 1.33, 1.5, 1.33, 1.2, 0.9];
      const stepMs = (60_000 / st.bpm) / 2;
      this.radioStep = 0;
      this.radioTimer = setInterval(() => {
        if (!this.audioCtx || this.stationId === 'off') return;
        const now = this.audioCtx.currentTime;
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = st.id === 'phonk' ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(st.baseHz * notes[this.radioStep % notes.length], now);
        gain.gain.setValueAtTime(0.055, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (stepMs / 1000) * 0.85);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + (stepMs / 1000) * 0.9);
        this.radioStep++;
      }, stepMs);
    } catch { /* audio blocked */ }
    if (this.panelOpen) this.renderUi();
  }

  /** Convert a Spotify or YouTube Music playlist URL into a safe embed iframe URL. */
  private embedUrl(): string {
    const raw = this.playlistUrl.trim();
    if (!raw) return '';
    const sp = /open\.spotify\.com\/(playlist|album|track)\/([A-Za-z0-9]+)/.exec(raw);
    if (sp) return `https://open.spotify.com/embed/${sp[1]}/${sp[2]}?theme=0`;
    const ytList = /[?&]list=([A-Za-z0-9_-]+)/.exec(raw);
    if (ytList) return `https://www.youtube.com/embed/videoseries?list=${ytList[1]}`;
    const ytVid = /(?:youtu\.be\/|[?&]v=)([A-Za-z0-9_-]{11})/.exec(raw);
    if (ytVid) return `https://www.youtube.com/embed/${ytVid[1]}`;
    return '';
  }

  private lastCarPos = new THREE.Vector3();
  private lastCarQuat = new THREE.Quaternion();
  private lastKmh = 0;
  syncCarPose(pos: THREE.Vector3, quat: THREE.Quaternion, kmh: number) {
    this.lastCarPos.copy(pos);
    this.lastCarQuat.copy(quat);
    this.lastKmh = kmh;
  }

  private bindDom() {
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cm]');
      if (!b) return;
      const act = b.dataset.cm!;
      const v = b.dataset.v ?? '';
      if (act === 'close') this.togglePanel(false);
      else if (act === 'floor') { this.floorIdx = Number(v); this.hooks.onToast('🏢 CAR MEET GARAGE', FLOORS[this.floorIdx]); this.renderUi(); }
      else if (act === 'hood') { this.hoodOpen = !this.hoodOpen; this.renderUi(); }
      else if (act === 'trunk') { this.trunkOpen = !this.trunkOpen; this.renderUi(); }
      else if (act === 'walk') { this.toggleStepOut(this.lastCarPos, this.lastCarQuat, this.lastKmh); }
      else if (act === 'emote') { this.setEmote(v as MeetEmote, this.lastCarPos, this.lastCarQuat); }
      else if (act === 'radio') { this.setStation(v); }
      else if (act === 'playlist-load') {
        const inp = this.el.querySelector<HTMLInputElement>('#cm-playlist');
        this.playlistUrl = inp?.value.trim() ?? '';
        this.renderUi();
      }
    });
  }

  private renderUi() {
    const emb = this.embedUrl();
    const emBtn = (id: MeetEmote, lbl: string) =>
      `<button class="chip ${this.walking && this.emote === id ? 'on' : ''}" data-cm="emote" data-v="${id}">${lbl}</button>`;
    this.el.innerHTML = `<div class="cm-panel">
      <div class="cm-head">
        <b>🚗 ${t('carmeet.title')}</b>
        <button class="small" data-cm="close">Close [U]</button>
      </div>
      <div class="cm-sec">
        <span class="dim">GARAGE FLOOR</span>
        <div class="chips">${FLOORS.map((f, i) => `<button class="chip ${this.floorIdx === i ? 'on' : ''}" data-cm="floor" data-v="${i}">F${i + 1}</button>`).join('')}</div>
        <div class="dim small-note">${FLOORS[this.floorIdx]}</div>
      </div>
      <div class="cm-sec">
        <span class="dim">SHOWCASE</span>
        <div class="chips">
          <button class="chip ${this.hoodOpen ? 'on' : ''}" data-cm="hood">${this.hoodOpen ? '▼ Close' : '▲ Open'} ${t('carmeet.hood')}</button>
          <button class="chip ${this.trunkOpen ? 'on' : ''}" data-cm="trunk">${this.trunkOpen ? '▼ Close' : '▲ Pop'} ${t('carmeet.trunk')}</button>
          <button class="chip ${this.walking ? 'on' : ''}" data-cm="walk">🚶 ${this.walking ? 'Get In Car' : t('carmeet.stepout')}</button>
        </div>
      </div>
      <div class="cm-sec">
        <span class="dim">AVATAR EMOTES</span>
        <div class="chips">
          ${emBtn('sit_hood', 'Sit on Hood')}${emBtn('lean_door', 'Lean on Door')}${emBtn('wave', 'Wave')}${emBtn('inspect', 'Inspect Engine')}${emBtn('celebrate', 'Celebrate')}
        </div>
      </div>
      <div class="cm-sec">
        <span class="dim">🎵 ${t('carmeet.radio')}</span>
        <div class="chips">${STATIONS.map((s) => `<button class="chip ${this.stationId === s.id ? 'on' : ''}" data-cm="radio" data-v="${s.id}">${s.name}</button>`).join('')}</div>
        <div class="cm-playrow">
          <input id="cm-playlist" type="text" value="${this.playlistUrl.replace(/"/g, '&quot;')}" placeholder="Paste Spotify or YouTube Music playlist URL…" />
          <button class="small primary" data-cm="playlist-load">Stream</button>
        </div>
        ${emb ? `<iframe class="cm-embed" src="${emb}" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>` : ''}
      </div>
    </div>`;
  }
}
