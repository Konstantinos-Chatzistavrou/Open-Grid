// Seamless transition loading screen for everything after boot: switching cities (no page reload, stays fullscreen!),
// starting a session, or swapping cars in the garage.
// Ultra-lightweight by construction (phone-friendly): every motion uses GPU-compositor-only CSS transforms/opacity
// (no JS animation loop, no canvas, no heavy blur filters) so it stays silky smooth even during shader/mesh uploads.
export const LOAD_TIPS = [
  'Every city is built 1:1 from real street networks: New York, London, Paris, Tokyo & Los Angeles.',
  'Use Testing Purposes in Play → Free Roam to unlock every car, Stage 3 upgrade, turbo & engine swap for free.',
  'High-speed impacts shatter storefront corners and glass — drive straight through buildings into modeled interiors.',
  '2,400 Hz rigid-ring tire belt physics + 3-zone tire temperatures reward smooth trail-braking and throttle control.',
  'Press [Tab] or click the minimap to open the full interactive city GPS with real-life landmarks & click waypoints.',
  'Flash headlights [F] near rivals in Free Roam for instant 1v1 Cash or Pink Slip street drags.',
  'Assists can be changed any time from the pause menu without altering underlying tire or aero physics.',
  'Press [P] for 4K Photo Mode, [T] for Instant Replay, or [C] to cycle Chase, Drift, Hood & Cinematic cameras.',
  'The driving line turns red where you need to brake from your live speed and grip level.',
  'Controllers, force-feedback wheels and touch phones all work — tune bindings in Settings → Controls.',
];

export class Loader {
  private el: HTMLDivElement;
  private msg: HTMLElement;
  private badge: HTMLElement;
  private pctEl: HTMLElement;
  private fillEl: HTMLElement;
  private barEl: HTMLElement;
  private tip: HTMLElement;
  private tipTimer = 0;
  private hideTimer = 0;
  private tipIdx = Math.floor(Math.random() * LOAD_TIPS.length);
  shown = false;
  /** while set, hide() requests are ignored (the game is still warming up behind the screen) */
  hold = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'loader';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="ld-bg" aria-hidden="true"><div class="ld-grid"></div><i class="ld-streak s1"></i><i class="ld-streak s2"></i></div>
      <div class="load-box">
        <div class="load-brand">OPEN<span>GRID</span></div>
        <div class="load-sub">The ultimate driving and racing experience</div>
        <div class="ld-tach" aria-hidden="true">
          <svg viewBox="0 0 120 120"><circle class="t-track" cx="60" cy="60" r="50"/><circle class="t-arc" cx="60" cy="60" r="50"/><circle class="t-arc2" cx="60" cy="60" r="40"/></svg>
          <b class="ld-pct">•••</b>
        </div>
        <div class="ld-badge" hidden></div>
        <div class="load-meta"><span class="load-msg"></span><span class="ld-tag">SEAMLESS TRANSITION</span></div>
        <div class="ld-bar"><i class="ld-fill"></i></div>
        <div class="ld-tip"></div>
      </div>`;
    document.body.appendChild(this.el);
    this.msg = this.el.querySelector('.load-msg')!;
    this.badge = this.el.querySelector('.ld-badge')!;
    this.pctEl = this.el.querySelector('.ld-pct')!;
    this.fillEl = this.el.querySelector('.ld-fill')!;
    this.barEl = this.el.querySelector('.ld-bar')!;
    this.tip = this.el.querySelector('.ld-tip')!;
  }

  /** Show (or retitle) the seamless loading overlay. Resolves after two paint frames so heavy work runs behind it. */
  show(text: string, badge = '', pct?: number): Promise<void> {
    clearTimeout(this.hideTimer);
    this.msg.textContent = text;
    if (badge) { this.badge.textContent = badge; this.badge.hidden = false; }
    else if (!this.shown) { this.badge.hidden = true; }
    this.progress(pct);
    if (!this.shown) {
      this.shown = true;
      this.el.hidden = false;
      this.el.classList.remove('out');
      void this.el.offsetWidth;
      this.el.classList.add('in');
      this.nextTip();
      clearInterval(this.tipTimer);
      this.tipTimer = window.setInterval(() => this.nextTip(), 4200);
    }
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  }

  /** Update message and optional determinate percentage (0..100). */
  text(t: string, pct?: number) {
    this.msg.textContent = t;
    if (pct !== undefined) this.progress(pct);
  }

  /** Switch bar between determinate progress (0..100) and smooth indeterminate shimmer (undefined). */
  progress(pct?: number) {
    if (pct === undefined) {
      this.barEl.classList.remove('det');
      this.fillEl.style.width = '';
      this.pctEl.textContent = 'LIVE';
    } else {
      const p = Math.max(0, Math.min(100, Math.round(pct)));
      this.barEl.classList.add('det');
      this.fillEl.style.width = `${p}%`;
      this.pctEl.textContent = `${p}%`;
    }
  }

  private nextTip() {
    this.tipIdx = (this.tipIdx + 1) % LOAD_TIPS.length;
    this.tip.textContent = 'Tip · ' + LOAD_TIPS[this.tipIdx];
  }

  /** Fade out smoothly (unless held). */
  hide() {
    if (!this.shown || this.hold) return;
    this.shown = false;
    clearInterval(this.tipTimer);
    this.el.classList.remove('in');
    this.el.classList.add('out');
    this.hideTimer = window.setTimeout(() => {
      this.el.hidden = true;
      this.badge.hidden = true;
      this.barEl.classList.remove('det');
    }, 340);
  }
}

/**
 * Resolves when the game renders steadily again: `count` consecutive frames under `ms`, or after `maxMs`.
 * Used behind the loading screen so it lifts onto a smooth picture.
 */
export function steadyFrames(count = 5, ms = 68, maxMs = 4500): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let prev = t0, ok = 0;
    const f = (t: number) => {
      ok = t - prev < ms ? ok + 1 : 0;
      prev = t;
      if (ok >= count || t - t0 > maxMs) resolve(); else requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
}
