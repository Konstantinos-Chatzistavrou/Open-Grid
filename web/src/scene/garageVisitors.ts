// Apache-2.0 — 3D Friend Avatars standing/walking inside the Live Co-Op Garage.
// Lightweight standing driver figures (helmet + visor + racing suit + boots + floating name & reaction badge)
// so the host and visitors see each other physically hanging out around the car being modified.
import * as THREE from 'three/webgpu';
import { skinOf } from './driver';

interface VisitorEntry {
  root: THREE.Group;
  body: THREE.Group;
  tagSprite: THREE.Sprite;
  tagCanvas: HTMLCanvasElement;
  tagTex: THREE.CanvasTexture;
  targetPos: THREE.Vector3;
  targetYaw: number;
  name: string;
  skin: string;
  reaction: string;
  reactionUntil: number;
  slot: number;
}

// Natural default standing positions around the garage turntable (clear of the car & showroom camera).
const DEFAULT_SLOTS: [number, number, number][] = [
  [-3.2,  2.3,  2.35],
  [ 3.3,  2.1, -2.30],
  [-3.1, -2.3,  0.85],
  [ 3.2, -2.2, -0.85],
  [ 0.0,  3.8,  3.14],
  [-4.2,  0.2,  1.57],
  [ 4.2,  0.2, -1.57],
];

function drawBadge(canvas: HTMLCanvasElement, name: string, reaction: string) {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const label = reaction ? `${name}  ·  ${reaction}` : name;
  ctx.font = '700 24px system-ui, -apple-system, sans-serif';
  const tw = Math.min(canvas.width - 36, ctx.measureText(label).width);
  const bw = tw + 30;
  const bx = (canvas.width - bw) / 2;
  const by = 14;
  const bh = 40;
  ctx.fillStyle = reaction ? 'rgba(255, 107, 45, 0.92)' : 'rgba(13, 16, 23, 0.82)';
  ctx.strokeStyle = reaction ? 'rgba(255, 224, 178, 0.9)' : 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, by + bh / 2 + 1, canvas.width - 40);
}

function buildStandingDriver(skinId?: string): THREE.Group {
  const s = skinOf(skinId);
  const g = new THREE.Group();
  const suitMat = new THREE.MeshStandardMaterial({ color: s.suit, roughness: 0.82, metalness: 0.05 });
  const accentMat = new THREE.MeshStandardMaterial({ color: s.accent, roughness: 0.55, metalness: 0.15 });
  const gloveMat = new THREE.MeshStandardMaterial({ color: s.gloves, roughness: 0.72, metalness: 0.05 });
  const helmetMat = new THREE.MeshPhysicalMaterial({ color: s.helmet, roughness: 0.22, metalness: 0.12, clearcoat: 1, clearcoatRoughness: 0.06 });
  const visorMat = new THREE.MeshPhysicalMaterial({ color: s.visor, roughness: 0.05, metalness: 0.88, clearcoat: 1 });
  const bootMat = new THREE.MeshStandardMaterial({ color: 0x16181f, roughness: 0.75, metalness: 0.1 });

  // Legs
  for (const sx of [-0.11, 0.11]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.68, 4, 8), suitMat);
    leg.position.set(sx, 0.44, 0);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.11, 0.24), bootMat);
    boot.position.set(sx, 0.055, 0.04);
    g.add(leg, boot);
  }
  // Torso + chest stripe
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.46, 4, 10), suitMat);
  torso.position.set(0, 1.12, 0);
  torso.scale.set(1.12, 1, 0.74);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.48, 0.28), accentMat);
  stripe.position.set(0, 1.13, 0.01);
  // Arms
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.46, 4, 8), suitMat);
    arm.position.set(sx * 0.25, 1.07, 0.02);
    arm.rotation.z = sx * 0.14;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.052, 8, 6), gloveMat);
    hand.position.set(sx * 0.29, 0.80, 0.04);
    g.add(arm, hand);
  }
  // Helmet + visor facing +Z
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), helmetMat);
  helm.position.set(0, 1.62, 0);
  helm.scale.set(0.95, 1.02, 1.08);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.149, 14, 8, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.22), visorMat);
  visor.position.set(0, 1.62, 0);
  visor.scale.set(0.96, 1.02, 1.09);
  visor.rotation.y = Math.PI / 2;

  g.add(torso, stripe, helm, visor);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export class GarageVisitors {
  readonly group = new THREE.Group();
  private entries = new Map<string, VisitorEntry>();
  private nextSlot = 0;

  constructor() {
    this.group.name = 'garage_visitors';
  }

  attachTo(parent: THREE.Object3D) {
    if (this.group.parent !== parent) parent.add(this.group);
  }

  /** Ensure a visiting friend is visible in the garage (with default slot if they haven't walked yet). */
  ensure(id: string, name: string, skin = 'classic') {
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.name !== name) {
        existing.name = name;
        drawBadge(existing.tagCanvas, existing.name, existing.reaction);
        existing.tagTex.needsUpdate = true;
      }
      return;
    }
    const slot = this.nextSlot++ % DEFAULT_SLOTS.length;
    const [dx, dz, dyaw] = DEFAULT_SLOTS[slot];
    const root = new THREE.Group();
    root.position.set(dx, 0, dz);
    root.rotation.y = dyaw;

    const body = buildStandingDriver(skin);
    root.add(body);

    const tagCanvas = document.createElement('canvas');
    tagCanvas.width = 512;
    tagCanvas.height = 68;
    drawBadge(tagCanvas, name, '');
    const tagTex = new THREE.CanvasTexture(tagCanvas);
    tagTex.colorSpace = THREE.SRGBColorSpace;
    const tagMat = new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthTest: false });
    const tagSprite = new THREE.Sprite(tagMat);
    tagSprite.position.set(0, 2.02, 0);
    tagSprite.scale.set(1.75, 0.24, 1);
    root.add(tagSprite);

    this.group.add(root);
    this.entries.set(id, {
      root, body, tagSprite, tagCanvas, tagTex,
      targetPos: new THREE.Vector3(dx, 0, dz),
      targetYaw: dyaw,
      name, skin, reaction: '', reactionUntil: 0, slot,
    });
  }

  /** Update a friend's live walking position inside the garage. */
  setWalk(id: string, x: number, z: number, yaw: number, name: string, skin?: string) {
    this.ensure(id, name, skin);
    const e = this.entries.get(id);
    if (!e) return;
    e.targetPos.set(Math.max(-7.5, Math.min(7.5, x)), 0, Math.max(-7.5, Math.min(7.5, z)));
    // Walk camera faces (sin(yaw), cos(yaw)), so standing driver (+Z forward) aligns directly with yaw
    e.targetYaw = yaw;
  }

  /** Show a floating reaction bubble ("🔥 Fire!", "🔊 Rev It!") above a friend's head for 4 s. */
  react(id: string, text: string, nowMs: number) {
    const e = this.entries.get(id);
    if (!e) return;
    e.reaction = text.slice(0, 24);
    e.reactionUntil = nowMs + 4200;
    drawBadge(e.tagCanvas, e.name, e.reaction);
    e.tagTex.needsUpdate = true;
  }

  remove(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.group.remove(e.root);
    e.tagTex.dispose();
    (e.tagSprite.material as THREE.SpriteMaterial).dispose();
    this.entries.delete(id);
  }

  clear() {
    for (const id of [...this.entries.keys()]) this.remove(id);
    this.nextSlot = 0;
  }

  /** Smoothly interpolate visitor avatars and expire reaction bubbles. */
  update(dt: number, nowMs: number) {
    const k = 1 - Math.exp(-Math.min(0.1, dt) * 10);
    for (const e of this.entries.values()) {
      e.root.position.lerp(e.targetPos, k);
      let dYaw = e.targetYaw - e.root.rotation.y;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      e.root.rotation.y += dYaw * k;
      // Subtle breathing / idle sway so friends feel alive
      e.body.position.y = Math.sin(nowMs * 0.0025 + e.slot * 1.7) * 0.012;
      if (e.reaction && nowMs > e.reactionUntil) {
        e.reaction = '';
        drawBadge(e.tagCanvas, e.name, '');
        e.tagTex.needsUpdate = true;
      }
    }
  }
}
