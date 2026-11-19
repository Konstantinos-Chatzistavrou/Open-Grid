// Spontaneous Headlight-Flash 1v1 Street Drag Wagers (Free Roam Social Sandbox, OpenGrid).
// Pull up next to a friend (online peer) or cruising street rival, flash headlights [F / double-tap L],
// and trigger an instant 400 m Cash ($5,000) or Pink Slip drag race right from the lights.
import * as THREE from 'three/webgpu';
import type { WagerNetMsg } from './party';
import { WAGER_CASH_DEFAULT, WAGER_CASH_XP, WAGER_PINKSLIP_XP } from './progression';

export type WagerStake = 'cash' | 'pinkslip';

export interface NearbyCandidate {
  id: string;
  name: string;
  kind: 'peer' | 'ai';
  aiIdx: number;
  dist: number;
  pos: THREE.Vector3;
}

export interface ActiveWager {
  wagerId: string;
  opponentId: string;
  opponentName: string;
  opponentKind: 'peer' | 'ai';
  aiIdx: number;
  stake: WagerStake;
  amount: number;
  phase: 'countdown' | 'racing';
  countdown: number;
  elapsed: number;
  startX: number;
  startZ: number;
  dirX: number;
  dirZ: number;
  distM: number;
  myProg: number;
  oppProg: number;
  peerFinishSec: number | null;
}

export interface PendingOffer {
  fromId: string;
  fromName: string;
  msg: WagerNetMsg;
  expiresAt: number;
}

export interface WagerResult {
  won: boolean;
  stake: WagerStake;
  amount: number;
  opponentName: string;
  timeSec: number;
  xpReward: number;
  pinkSlipTransferred: boolean;
}

export interface WagerHooks {
  sendNet(msg: WagerNetMsg): void;
  onStartAiDrag(aiIdx: number, held: boolean): void;
  onReleaseAiDrag(): void;
  onEndAiDrag(): void;
  onComplete(res: WagerResult): void;
  onToast(title: string, detail: string): void;
}

const DRAG_DIST_M = 400; // classic quarter-mile street drag
const PROXIMITY_M = 20;
const MAX_CHALLENGE_KMH = 42;

export class SpontaneousWagers {
  stake: WagerStake = 'cash';
  amount = WAGER_CASH_DEFAULT;
  nearby: NearbyCandidate | null = null;
  active: ActiveWager | null = null;
  pendingOffer: PendingOffer | null = null;
  /** Outgoing offer waiting on a peer to flash back. */
  outgoingOffer: { toId: string; toName: string; wagerId: string; stake: WagerStake; expiresAt: number } | null = null;

  /** High-beam flash animation timer (seconds remaining). */
  flashTimer = 0;

  private finishArch: THREE.Group;
  private finishPos = new THREE.Vector3();

  constructor(private scene: THREE.Scene, private hooks: WagerHooks) {
    this.finishArch = this.buildFinishArch();
    this.finishArch.visible = false;
    this.scene.add(this.finishArch);
  }

  private buildFinishArch(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'drag_finish_arch';
    const postGeo = new THREE.BoxGeometry(0.28, 7.5, 0.28);
    const barGeo = new THREE.BoxGeometry(12.6, 0.45, 0.35);
    const matPost = new THREE.MeshBasicMaterial({ color: 0xff2d6a });
    const matBar = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
    const l = new THREE.Mesh(postGeo, matPost); l.position.set(-6.2, 3.75, 0);
    const r = new THREE.Mesh(postGeo, matPost); r.position.set(6.2, 3.75, 0);
    const top = new THREE.Mesh(barGeo, matBar); top.position.set(0, 7.4, 0);
    // Glowing finish line strip across the wet road
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(12.4, 0.9).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xff2d6a, transparent: true, opacity: 0.72, depthWrite: false }),
    );
    strip.position.y = 0.08;
    g.add(l, r, top, strip);
    return g;
  }

  toggleStake(): WagerStake {
    this.stake = this.stake === 'cash' ? 'pinkslip' : 'cash';
    this.hooks.onToast(
      this.stake === 'pinkslip' ? 'PINK SLIP STAKES ARMED' : `CASH WAGER · $${this.amount.toLocaleString()}`,
      this.stake === 'pinkslip' ? 'Winner takes the ride (starter car protected)' : 'Flash headlights [F] next to a driver to race 400 m',
    );
    return this.stake;
  }

  /** Finish gate world position for minimap marker, or null if no drag active. */
  get finishWorld(): THREE.Vector3 | null {
    return this.active ? this.finishPos : null;
  }

  /** Player flashed headlights [F / double-tap L] in Free Roam. */
  triggerFlash(
    playerPos: THREE.Vector3,
    playerFwd: THREE.Vector3,
    selfId: string,
    now = performance.now(),
  ): boolean {
    this.flashTimer = 0.55;
    if (this.active) return false;

    // 1. Accept pending incoming peer wager if present
    if (this.pendingOffer && now < this.pendingOffer.expiresAt) {
      const offer = this.pendingOffer;
      this.pendingOffer = null;
      this.hooks.sendNet({ ...offer.msg, kind: 'accept', to: offer.fromId });
      this.beginWager({
        wagerId: offer.msg.wagerId,
        opponentId: offer.fromId,
        opponentName: offer.fromName,
        opponentKind: 'peer',
        aiIdx: -1,
        stake: offer.msg.stake,
        amount: offer.msg.amount,
        startX: offer.msg.startX,
        startZ: offer.msg.startZ,
        dirX: offer.msg.dirX,
        dirZ: offer.msg.dirZ,
        distM: offer.msg.distM,
      });
      return true;
    }

    // 2. Challenge nearest side-by-side driver
    if (!this.nearby) {
      this.hooks.onToast('HEADLIGHTS FLASHED', 'Pull up next to a friend or rival (< 20 m) to trigger a 1v1 drag');
      return false;
    }

    const len = Math.hypot(playerFwd.x, playerFwd.z) || 1;
    const dirX = playerFwd.x / len;
    const dirZ = playerFwd.z / len;
    const wagerId = `w_${Math.floor(now)}_${Math.floor(Math.random() * 9999)}`;

    if (this.nearby.kind === 'peer') {
      const msg: WagerNetMsg = {
        kind: 'offer',
        wagerId,
        to: this.nearby.id,
        stake: this.stake,
        amount: this.amount,
        startX: playerPos.x,
        startZ: playerPos.z,
        dirX,
        dirZ,
        distM: DRAG_DIST_M,
      };
      this.hooks.sendNet(msg);
      this.outgoingOffer = { toId: this.nearby.id, toName: this.nearby.name, wagerId, stake: this.stake, expiresAt: now + 12_000 };
      this.hooks.onToast(
        `CHALLENGE SENT TO ${this.nearby.name}`,
        this.stake === 'pinkslip' ? 'PINK SLIP · 400 m · waiting for headlight flash' : `$${this.amount.toLocaleString()} CASH · 400 m · waiting for reply`,
      );
      return true;
    }

    // Solo / cruising AI rival accepts immediately after flashing back!
    const target = this.nearby;
    this.beginWager({
      wagerId,
      opponentId: target.id,
      opponentName: target.name,
      opponentKind: 'ai',
      aiIdx: target.aiIdx,
      stake: this.stake,
      amount: this.amount,
      startX: playerPos.x,
      startZ: playerPos.z,
      dirX,
      dirZ,
      distM: DRAG_DIST_M,
    });
    void selfId;
    return true;
  }

  /** Handle incoming WebRTC wager message from a party member. */
  onNetWager(fromId: string, fromName: string, w: WagerNetMsg, selfId: string, now = performance.now()) {
    if (w.to !== selfId && w.to !== '*') return;
    if (w.kind === 'offer' && !this.active) {
      this.pendingOffer = { fromId, fromName, msg: w, expiresAt: now + 12_000 };
      this.hooks.onToast(
        `⚡ ${fromName} FLASHED HIGH-BEAMS!`,
        `${w.stake === 'pinkslip' ? 'PINK SLIP' : '$' + w.amount.toLocaleString() + ' CASH'} · 400 m DRAG — PRESS [F] TO ACCEPT`,
      );
    } else if (w.kind === 'accept' && this.outgoingOffer && this.outgoingOffer.wagerId === w.wagerId) {
      this.outgoingOffer = null;
      this.beginWager({
        wagerId: w.wagerId,
        opponentId: fromId,
        opponentName: fromName,
        opponentKind: 'peer',
        aiIdx: -1,
        stake: w.stake,
        amount: w.amount,
        startX: w.startX,
        startZ: w.startZ,
        dirX: w.dirX,
        dirZ: w.dirZ,
        distM: w.distM,
      });
    } else if (w.kind === 'decline' && this.outgoingOffer && this.outgoingOffer.wagerId === w.wagerId) {
      this.outgoingOffer = null;
      this.hooks.onToast('WAGER DECLINED', `${fromName} passed on the run`);
    } else if (w.kind === 'finish' && this.active && this.active.wagerId === w.wagerId) {
      this.active.peerFinishSec = w.finishSec ?? this.active.elapsed;
      // Opponent crossed the 400 m line first
      this.finishWager(false, this.active.elapsed);
    }
  }

  private beginWager(spec: {
    wagerId: string;
    opponentId: string;
    opponentName: string;
    opponentKind: 'peer' | 'ai';
    aiIdx: number;
    stake: WagerStake;
    amount: number;
    startX: number;
    startZ: number;
    dirX: number;
    dirZ: number;
    distM: number;
  }) {
    this.active = {
      ...spec,
      phase: 'countdown',
      countdown: 3.0,
      elapsed: 0,
      myProg: 0,
      oppProg: 0,
      peerFinishSec: null,
    };
    this.finishPos.set(spec.startX + spec.dirX * spec.distM, 0, spec.startZ + spec.dirZ * spec.distM);
    this.finishArch.position.copy(this.finishPos);
    this.finishArch.rotation.y = Math.atan2(spec.dirX, spec.dirZ);
    this.finishArch.visible = true;
    if (spec.opponentKind === 'ai' && spec.aiIdx >= 0) {
      this.hooks.onStartAiDrag(spec.aiIdx, true);
    }
    this.hooks.onToast(
      `1v1 DRAG vs ${spec.opponentName}`,
      spec.stake === 'pinkslip' ? 'PINK SLIP ON THE LINE · 400 m' : `$${spec.amount.toLocaleString()} CASH WAGER · 400 m`,
    );
  }

  cancel() {
    if (this.active?.opponentKind === 'ai') this.hooks.onEndAiDrag();
    this.active = null;
    this.pendingOffer = null;
    this.outgoingOffer = null;
    this.finishArch.visible = false;
  }

  /**
   * Per-frame update in Free Roam: updates flash pulse, proximity candidate detection,
   * active 400 m drag countdown/progress, and finish check.
   */
  update(
    dt: number,
    inFreeRoam: boolean,
    playerPos: THREE.Vector3,
    playerKmh: number,
    candidates: NearbyCandidate[],
    now = performance.now(),
  ) {
    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);
    if (!inFreeRoam) {
      this.nearby = null;
      if (this.active) this.cancel();
      return;
    }

    if (this.pendingOffer && now > this.pendingOffer.expiresAt) this.pendingOffer = null;
    if (this.outgoingOffer && now > this.outgoingOffer.expiresAt) this.outgoingOffer = null;

    // 1. Proximity search when idle
    if (!this.active) {
      let best: NearbyCandidate | null = null;
      if (playerKmh <= MAX_CHALLENGE_KMH) {
        for (const c of candidates) {
          if (c.dist <= PROXIMITY_M && (!best || c.dist < best.dist)) best = c;
        }
      }
      this.nearby = best;
      return;
    }

    // 2. Active 1v1 Drag Race
    const a = this.active;
    this.nearby = null;

    // Project progress along drag vector
    a.myProg = (playerPos.x - a.startX) * a.dirX + (playerPos.z - a.startZ) * a.dirZ;
    const opp = candidates.find((c) => c.id === a.opponentId);
    if (opp) {
      a.oppProg = (opp.pos.x - a.startX) * a.dirX + (opp.pos.z - a.startZ) * a.dirZ;
    }

    if (a.phase === 'countdown') {
      a.countdown -= dt;
      if (a.countdown <= 0) {
        a.phase = 'racing';
        a.countdown = 0;
        if (a.opponentKind === 'ai') this.hooks.onReleaseAiDrag();
        this.hooks.onToast('LAUNCH!', `400 m to the finish arch vs ${a.opponentName}`);
      }
      return;
    }

    a.elapsed += dt;
    // Check finish beam
    if (a.myProg >= a.distM) {
      if (a.opponentKind === 'peer') {
        this.hooks.sendNet({
          kind: 'finish',
          wagerId: a.wagerId,
          to: a.opponentId,
          stake: a.stake,
          amount: a.amount,
          startX: a.startX,
          startZ: a.startZ,
          dirX: a.dirX,
          dirZ: a.dirZ,
          distM: a.distM,
          finishSec: a.elapsed,
        });
      }
      this.finishWager(true, a.elapsed);
      return;
    }
    if (a.opponentKind === 'ai' && a.oppProg >= a.distM) {
      this.finishWager(false, a.elapsed);
      return;
    }
    // Safety timeout if player turns around and abandons drag
    if (a.elapsed > 45) {
      this.hooks.onToast('DRAG ABANDONED', 'Timed out before crossing the 400 m finish');
      this.cancel();
    }
  }

  private finishWager(won: boolean, timeSec: number) {
    const a = this.active;
    if (!a) return;
    if (a.opponentKind === 'ai') this.hooks.onEndAiDrag();
    this.active = null;
    this.finishArch.visible = false;

    const xpReward = won ? (a.stake === 'pinkslip' ? WAGER_PINKSLIP_XP : WAGER_CASH_XP) : 0;
    this.hooks.onComplete({
      won,
      stake: a.stake,
      amount: a.amount,
      opponentName: a.opponentName,
      timeSec,
      xpReward,
      pinkSlipTransferred: a.stake === 'pinkslip',
    });
  }

  /** Compact status banner HTML for HUD (empty when nothing to display). */
  hudBanner(): string {
    const now = performance.now();
    if (this.active) {
      const a = this.active;
      const stakeTag = a.stake === 'pinkslip' ? 'PINK SLIP' : `$${a.amount.toLocaleString()}`;
      if (a.phase === 'countdown') {
        const n = Math.max(1, Math.ceil(a.countdown));
        return `<div class="wager-pill live"><b>⚡ 1v1 DRAG · ${stakeTag}</b> · vs ${a.opponentName} · <span>STAGING ${n}</span></div>`;
      }
      const left = Math.max(0, Math.round(a.distM - a.myProg));
      const gap = Math.round(a.myProg - a.oppProg);
      const gapStr = gap >= 0 ? `+${gap} m AHEAD` : `${gap} m BEHIND`;
      return `<div class="wager-pill live"><b>⚡ 400m DRAG · ${stakeTag}</b> · ${left} m left · <span>${gapStr}</span></div>`;
    }
    if (this.pendingOffer && now < this.pendingOffer.expiresAt) {
      const p = this.pendingOffer;
      const tag = p.msg.stake === 'pinkslip' ? 'PINK SLIP' : `$${p.msg.amount.toLocaleString()}`;
      return `<div class="wager-pill offer"><b>⚡ ${p.fromName} FLASHED YOU!</b> · ${tag} 400m Drag · <span>[F] ACCEPT</span></div>`;
    }
    if (this.outgoingOffer && now < this.outgoingOffer.expiresAt) {
      return `<div class="wager-pill"><b>⚡ CHALLENGE SENT</b> · Waiting for ${this.outgoingOffer.toName} to flash back…</div>`;
    }
    if (this.nearby) {
      const stakeLabel = this.stake === 'pinkslip' ? 'PINK SLIP' : `$${this.amount.toLocaleString()} CASH`;
      return `<div class="wager-pill"><b>⚡ ${this.nearby.name} (${Math.round(this.nearby.dist)} m)</b> · [F] Flash to Drag · <span>${stakeLabel}</span> [V] Switch</div>`;
    }
    return '';
  }

  /** Visual headlight intensity multiplier during a high-beam flash pulse. */
  get flashMultiplier(): number {
    if (this.flashTimer <= 0) return 1;
    // Two crisp high-beam flashes over 0.55 s
    const phase = this.flashTimer / 0.55;
    const pulse = (phase > 0.65 || (phase > 0.15 && phase < 0.45)) ? 2.4 : 0.35;
    return pulse;
  }
}
