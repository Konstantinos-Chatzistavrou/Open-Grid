import { OUT, type AssistToggles, type CarInfo, type Damage, type LapInfo } from './physics/core';

const $ = (id: string) => document.getElementById(id)!;
const NS = 'http://www.w3.org/2000/svg';
const LABELS = ['FL', 'FR', 'RL', 'RR'];

// Dial geometry: 270 degree sweep, 0 km/h at the lower left, 320 km/h at the lower right.
const MAX_KMH = 320, A0 = -225, SWEEP = 270, CX = 120, CY = 120;
const ang = (f: number) => ((A0 + SWEEP * f) * Math.PI) / 180;
const at = (f: number, r: number) => [CX + Math.cos(ang(f)) * r, CY + Math.sin(ang(f)) * r] as const;
function arc(f0: number, f1: number, r: number) {
  const [x0, y0] = at(f0, r), [x1, y1] = at(f1, r);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${SWEEP * (f1 - f0) > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

// Warning lamps: flame (engine fire) and the ISO brake symbol, (!) in a circle with side arcs.
const ICON_FIRE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-6 1-9.5z"/></svg>';
const ICON_BRAKE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><path d="M4.5 6.5a9 9 0 0 0 0 11M19.5 6.5a9 9 0 0 1 0 11M12 8.5v4.5M12 15.6v.1"/></svg>';

export function formatLap(t: number) {
  if (!(t > 0)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** ring capacity for the drawn-frame times of the last second (enough for a 500 Hz display) */
const FRAME_RING = 512;

export class Hud {
  /** drawn-frame timestamps of the last second: O(1) ring (head = oldest), no shift() and no arrays per frame */
  private frames = new Float64Array(FRAME_RING);
  private fHead = 0;
  private fCount = 0;
  private gaps = new Float64Array(FRAME_RING);
  private last = 0;
  private needle = 0;            // smoothed needle position, km/h
  private rev = 0;
  private lapsSeen = 0;
  private toastTimer = 0;
  private warnHtml = '';
  private assistHtml = '';
  private damageBad = false;
  extra = '';
  /** Race mode: lap count shown as 'n / total' (0 = free run, counted forever). */
  lapTotal = 0;
  /** R repairs (false in a full-realism race: a wreck is out) */
  canRecover = true;
  /** full realism: 'ROLLED OVER · OUT IN 3 s' etc. ('' none) */
  outWarn = '';
  /** the simulation is held while the street under the car is still loading (slow phones, slow networks) */
  holdWarn = '';
  fps = 60;
  /** the frame cap in fps (0 = uncapped), so a 33 ms interval reads as the cap working, not as a slow frame */
  cap = 0;
  /** draw calls and texture VRAM of the frame, set by main once a second */
  stats: { calls: number; textureMB: number; noMips: number } | null = null;
  /** the largest frame interval of the last second: logged, not shown (one hitch is not the frame time) */
  lastMax = 0;
  private el = { needle: $('needle'), rev: $('revfill') };
  private needleKey = '';
  private revKey = -1;

  constructor() {
    const ticks = $('ticks');
    for (let v = 0; v <= MAX_KMH; v += 10) {
      const f = v / MAX_KMH, major = v % 40 === 0;
      const [x0, y0] = at(f, major ? 88 : 93), [x1, y1] = at(f, 100);
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', `${x0}`); l.setAttribute('y1', `${y0}`); l.setAttribute('x2', `${x1}`); l.setAttribute('y2', `${y1}`);
      l.setAttribute('class', major ? 'tick major' : 'tick');
      ticks.appendChild(l);
      if (major) {
        const [tx, ty] = at(f, 76);
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', `${tx}`); t.setAttribute('y', `${ty}`); t.setAttribute('class', 'lbl');
        t.textContent = String(v);
        ticks.appendChild(t);
      }
    }
    $('revtrack').setAttribute('d', arc(0, 1, 110));
  }

  show() { ($('hud') as HTMLElement).hidden = false; document.getElementById('loading')?.remove(); this.resetFps(); }
  hide() { ($('hud') as HTMLElement).hidden = true; }
  get visible() { return !($('hud') as HTMLElement).hidden; }
  toggle() { const h = $('hud') as HTMLElement; h.hidden = !h.hidden; }
  resetFps() { this.fHead = 0; this.fCount = 0; }

  /** Every frame: the dial animates at frame rate; text updates at 10 Hz. */
  /** A frame was actually drawn (the fps readout counts these, not display refreshes: the 30 fps cap skips some). */
  rendered(now: number) {
    if (!this.visible) return;
    if (this.fCount === FRAME_RING) { this.fHead = (this.fHead + 1) % FRAME_RING; this.fCount--; }
    this.frames[(this.fHead + this.fCount) % FRAME_RING] = now;
    this.fCount++;
  }
  private frameAt(i: number) { return this.frames[(this.fHead + i) % FRAME_RING]; }

  update(now: number, dt: number, out: Float64Array, info: CarInfo, assists: AssistToggles, dmg: Damage | null, lap: LapInfo | null) {
    while (this.fCount && this.frames[this.fHead] < now - 1000) { this.fHead = (this.fHead + 1) % FRAME_RING; this.fCount--; }

    // dial: the needle eases toward the true speed (critically damped feel, no ticking)
    const kmh = Math.abs(out[OUT.speed]) * 3.6;
    this.needle += (kmh - this.needle) * (1 - Math.exp(-dt * 14));
    this.rev += (Math.min(1, out[OUT.rpm] / info.redline) - this.rev) * (1 - Math.exp(-dt * 20));
    // DOM writes only when the drawn value changes (0.1 px needle, 0.1 % rev ring): an SVG
    // attribute write invalidates style + paint even when the value is the same, every frame.
    const f = Math.min(1, this.needle / MAX_KMH);
    const [nx, ny] = at(f, 86);
    const nk = `${nx.toFixed(1)} ${ny.toFixed(1)}`;
    if (nk !== this.needleKey) {
      this.needleKey = nk;
      this.el.needle.setAttribute('x2', nx.toFixed(1));
      this.el.needle.setAttribute('y2', ny.toFixed(1));
    }
    const rk = this.rev > 0.002 ? Math.round(this.rev * 1000) : 0;
    if (rk !== this.revKey) {
      this.revKey = rk;
      this.el.rev.setAttribute('d', rk ? arc(0, rk / 1000, 110) : '');
      this.el.rev.classList.toggle('red', this.rev > 0.92);
    }

    if (lap) this.updateLapToast(lap, dt);   // the lap-finished card reacts every frame; its texts below at 10 Hz

    if (now - this.last < 100) return;   // DOM text at 10 Hz
    this.last = now;
    if (lap) this.updateLaps(lap);
    const n = this.fCount;
    const span = n > 1 ? this.frameAt(n - 1) - this.frameAt(0) : 0;
    const fps = (this.fps = span >= 850 ? n : span > 10 ? Math.round(((n - 1) * 1000) / span) : 30);
    // Frame intervals over the last second: the median is the pace the player sees, p95 is the jitter. The old readout
    // showed the maximum only ("worst 128 ms"), so one shader compile or texture upload made a healthy 30 fps game
    // look like it ran at 128 ms; the maximum is logged (lastMax) instead of displayed.
    const ng = Math.max(0, n - 1);
    for (let i = 1; i < n; i++) this.gaps[i - 1] = this.frameAt(i) - this.frameAt(i - 1);
    const gaps = this.gaps.subarray(0, ng).sort();   // typed-array sort: numeric, in place
    const med = ng ? gaps[ng >> 1] : 0;
    const p95 = ng ? gaps[Math.min(ng - 1, Math.floor(ng * 0.95))] : 0;
    this.lastMax = ng ? gaps[ng - 1] : 0;
    const cap = this.cap ? ` (cap ${this.cap})` : '';
    const st = this.stats ? ` · ${this.stats.calls} calls · ${this.stats.textureMB} MB tex${this.stats.noMips ? ` · ${this.stats.noMips} NO MIPS` : ''}` : '';
    this.text('perf', `${fps} fps${cap} · ${med.toFixed(0)} ms · p95 ${p95.toFixed(0)}${st}\n${this.extra}`);
    this.text('speed', Math.round(kmh).toString());
    const g = out[OUT.gear];
    this.text('gear', g === 0 ? 'R' : g === 1 ? 'N' : String(g - 1));
    const on = (n: string, v: boolean, act = false) => (v ? `<b>${act ? '● ' : ''}${n}</b>` : n);
    const assistHtml = [
      on('ABS', assists.abs, out[OUT.abs] > 0), on('TC', assists.tc, out[OUT.tc] > 0.01),
      on('ESC', assists.esc, out[OUT.esc] !== 0), on('AUTO', assists.autoGearbox),
    ].join(' · ');
    if (assistHtml !== this.assistHtml) $('assists').innerHTML = this.assistHtml = assistHtml;
    this.updateWarnings(dmg, out);
    this.updateSimTelemetry(out);
    if (!dmg || dmg.totalKj < 1) { this.text('damage', ''); return; }
    const pct = (x: number) => Math.round(Math.min(1, x) * 100);
    if (dmg.totaled !== this.damageBad) { this.damageBad = dmg.totaled; $('damage').classList.toggle('bad', dmg.totaled); }
    this.text('damage', dmg.totaled
      ? (this.canRecover ? 'WRECKED · limping · R repairs' : 'WRECKED')
      : `DAMAGE  body ${pct(Math.max(...dmg.zone))}%  engine ${pct(dmg.engine)}%  wheels ${pct(Math.max(...dmg.wheel))}%`);
  }

  /** Fire and brake lamps (DOM rebuilt only when the text changes). */
  private updateWarnings(dmg: Damage | null, out?: Float64Array) {
    const chips: string[] = [];
    // hot brakes (thermal fade, core brake model): the hottest disc and what the pads have left
    if (out) {
      let t = 0, mu = 1, maxFlat = 0, maxBlister = 0;
      for (let i = 0; i < 4; i++) {
        t = Math.max(t, out[OUT.brakeTemp(i)]);
        mu = Math.min(mu, out[OUT.padMu(i)]);
        maxFlat = Math.max(maxFlat, out[OUT.flatSpot(i)] || 0);
        maxBlister = Math.max(maxBlister, out[OUT.blistering(i)] || 0);
      }
      if (t > 720 && !(dmg && (dmg.brakesFailed || dmg.brakes < 0.97))) chips.push(`<div class="chip ${mu < 0.75 ? 'red' : ''}">${ICON_BRAKE}BRAKES ${mu < 0.95 ? 'FADING' : 'HOT'} ${Math.round(t / 10) * 10}°C</div>`);
      if ((out[OUT.brakeVaporSponge] || 0) > 0.06) chips.push(`<div class="chip red">${ICON_BRAKE}BRAKE FLUID BOILING</div>`);
      if (maxFlat > 0.35) chips.push(`<div class="chip">FLAT-SPOT ${maxFlat.toFixed(1)}mm</div>`);
      if (maxBlister > 0.35) chips.push(`<div class="chip red">TIRES BLISTERING</div>`);
      if ((out[OUT.splitterStalled] || 0) > 0.5) chips.push(`<div class="chip">SPLITTER STALL</div>`);
    }
    if (this.outWarn) chips.push(`<div class="chip">${this.outWarn}</div>`);
    if (this.holdWarn) chips.push(`<div class="chip">${this.holdWarn}</div>`);
    if (dmg) {
      if (dmg.fire > 0) chips.push(`<div class="chip red">${ICON_FIRE}ENGINE FIRE</div>`);
      else if (dmg.smoulder > 0) chips.push(`<div class="chip">${ICON_FIRE}ENGINE OVERHEATING</div>`);
      if (dmg.wheel.some((w) => w >= 0.95)) chips.push(`<div class="chip red">WHEEL LOST</div>`);
      if (dmg.brakesFailed) chips.push(`<div class="chip red">${ICON_BRAKE}NO BRAKES</div>`);
      else if (dmg.brakes < 0.97) chips.push(`<div class="chip">${ICON_BRAKE}BRAKES FADING ${Math.round(dmg.brakes * 100)}%</div>`);
    }
    const html = chips.join('');
    if (html !== this.warnHtml) $('warn').innerHTML = this.warnHtml = html;
  }

  /** Simcenter Tire 2606 3-Zone (Inner/Middle/Outer) thermal widget + live Active Aero & Turbo Boost pills.
   *  The DOM is built once; every 10 Hz update only writes a rib colour or a label that changed (it used to rebuild the
   *  whole widget's innerHTML whenever one rounded temperature moved). */
  private st: {
    host: HTMLElement; pills: HTMLDivElement; grid: HTMLDivElement; ribs: HTMLElement[]; lbls: HTMLElement[];
    drs: HTMLSpanElement; air: HTMLSpanElement; boost: HTMLSpanElement; ribBg: string[]; lblTxt: string[]; pillKey: string; boostTxt: string;
  } | null = null;

  private buildSimTelemetry(host: HTMLElement) {
    host.textContent = '';
    const div = (cls: string) => { const d = document.createElement('div'); d.className = cls; return d; };
    const pill = (cls: string, txt: string) => { const p = document.createElement('span'); p.className = `st-pill ${cls}`; p.textContent = txt; return p; };
    const pills = div('st-pills'), grid = div('st-grid');
    const ribs: HTMLElement[] = [], lbls: HTMLElement[] = [];
    for (let i = 0; i < 4; i++) {
      const tire = div('st-tire'), rib = div('st-ribs');
      for (let k = 0; k < 3; k++) { const r = document.createElement('i'); rib.appendChild(r); ribs.push(r); }
      const lbl = document.createElement('span'); lbl.className = 'st-lbl';
      tire.append(rib, lbl);
      grid.appendChild(tire);
      lbls.push(lbl);
    }
    host.appendChild(grid);   // the pills row is inserted above the grid only while a pill is lit (as before)
    return (this.st = { host, pills, grid, ribs, lbls, drs: pill('drs', 'DRS OPEN'), air: pill('air', 'AIRBRAKE'), boost: pill('boost', ''),
      ribBg: new Array<string>(12).fill(''), lblTxt: new Array<string>(4).fill(''), pillKey: '', boostTxt: '' });
  }

  private updateSimTelemetry(out: Float64Array) {
    const host = document.getElementById('sim-telemetry');
    if (!host) return;
    const st = this.st && this.st.host === host && this.st.grid.parentNode === host ? this.st : this.buildSimTelemetry(host);
    const ribColor = (c: number) =>
      c < 62 ? '#38bdf8' : c < 76 ? '#4ade80' : c <= 108 ? '#22c55e' : c <= 130 ? '#f59e0b' : '#ef4444';
    for (let i = 0; i < 4; i++) {
      const ti = out[OUT.tireInner(i)] || out[OUT.treadSurface(i)] || 80;
      const tm = out[OUT.tireMiddle(i)] || out[OUT.treadSurface(i)] || 80;
      const to = out[OUT.tireOuter(i)] || out[OUT.treadSurface(i)] || 80;
      const surf = Math.round((ti + tm + to) / 3);
      // Left wheels (0,2): Outer|Mid|Inner left-to-right; Right wheels (1,3): Inner|Mid|Outer left-to-right
      const left = i % 2 === 0;
      for (let k = 0; k < 3; k++) {
        const c = ribColor(k === 1 ? tm : (k === 0) === left ? to : ti), j = i * 3 + k;
        if (st.ribBg[j] !== c) { st.ribBg[j] = c; st.ribs[j].style.background = c; }
      }
      const txt = `${LABELS[i]} ${surf}°`;
      if (st.lblTxt[i] !== txt) { st.lblTxt[i] = txt; st.lbls[i].textContent = txt; }
    }
    const drs = (out[OUT.drsActive] || 0) > 0.5, air = (out[OUT.airbrakeActive] || 0) > 0.5;
    const boost = out[OUT.boostBar] || 0, boosting = boost > 0.05;
    if (boosting) { const bt = `${boost.toFixed(2)} BAR`; if (bt !== st.boostTxt) { st.boostTxt = bt; st.boost.textContent = bt; } }
    const key = `${+drs}${+air}${+boosting}`;
    if (key !== st.pillKey) {
      st.pillKey = key;
      st.pills.textContent = '';
      if (drs) st.pills.appendChild(st.drs);
      if (air) st.pills.appendChild(st.air);
      if (boosting) st.pills.appendChild(st.boost);
      if (drs || air || boosting) { if (st.pills.parentNode !== host) host.insertBefore(st.pills, st.grid); }
      else st.pills.remove();
    }
  }

  /** Lap texts (10 Hz, from update). */
  private updateLaps(lap: LapInfo) {
    this.text('lapno', this.lapTotal ? `${Math.min(lap.laps + 1, this.lapTotal)} / ${this.lapTotal}` : String(lap.laps + 1));
    const cur = formatLap(lap.current);
    this.text('lapcur', cur === '—' ? '0:00.000' : cur);
    this.text('laplast', formatLap(lap.last));
    this.text('lapbest', formatLap(lap.best));
  }

  /** Every frame: a lap just finished -> fade the lap card in, then out. */
  private updateLapToast(lap: LapInfo, dt: number) {
    if (lap.laps > this.lapsSeen) {          // a lap just finished: fade a card in, then out
      this.lapsSeen = lap.laps;
      const best = lap.last > 0 && Math.abs(lap.last - lap.best) < 1e-6;
      const t = $('toast');
      t.innerHTML = `LAP ${lap.laps}${best ? ' · <span class="best">BEST</span>' : ''}<b>${formatLap(lap.last)}</b>`;
      t.classList.add('show');
      this.toastTimer = 3;
    }
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) $('toast').classList.remove('show');
  }

  /** textContent only when it changed (a same-value write still replaces the text node). */
  private texts = new Map<string, string>();
  private text(id: string, v: string) {
    if (this.texts.get(id) !== v) { this.texts.set(id, v); $(id).textContent = v; }
  }

  /** A short card in the lap-toast slot ("#Bot2 WRECKED"); `small` is the line above the big one. */
  toast(small: string, big: string) {
    const t = $('toast');
    t.textContent = small;
    const b = document.createElement('b'); b.textContent = big; t.appendChild(b);
    t.classList.add('show');
    this.toastTimer = 2.5;
  }
  resetLaps() { this.lapsSeen = 0; this.toastTimer = 0; $('toast').classList.remove('show'); this.board(null); }

  private boardHtml = '';
  /**
   * Race position and the running order (null hides both: free roam). rows: names in order, with the
   * gap to the car in front ('' for the leader), `you` marks the player.
   */
  board(rows: { name: string; gap: string; you: boolean }[] | null) {
    const pos = $('lappos-row') as HTMLElement, el = $('board') as HTMLElement;
    pos.hidden = el.hidden = !rows;
    if (!rows) { this.boardHtml = ''; return; }
    const me = rows.findIndex((r) => r.you) + 1;
    this.text('lappos', `${me} / ${rows.length}`);
    const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = rows.map((r, i) => `<div class="b ${r.you ? 'you' : ''}"><i>${i + 1}</i><span>${esc(r.name)}</span><em>${r.gap}</em></div>`).join('');
    if (html !== this.boardHtml) el.innerHTML = this.boardHtml = html;
  }
}
