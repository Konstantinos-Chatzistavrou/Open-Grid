// On-screen controls for phones and tablets (multi-touch, pointer events).
//   left, bottom:  always-visible horizontal pill steering slider (direct tap-to-steer + drag,
//                  precision non-linear curve, spring return to centre)
//   right, bottom: minimal glass Brake and Gas icon pedals + circular Handbrake pill above Gas
//                  (BRAKE held at a standstill = reverse: core's pedal reverse, same as keyboard S)
//   top right:     menu, reset, straight (tilt), camera, gearbox auto/manual, fullscreen; shift up/down in manual
export interface TouchState {
  active: boolean;
  steer: number; throttle: number; brake: number; handbrake: number;
  shiftUp: boolean; shiftDown: boolean;
}

export interface TouchActions { reset(): void; camera(): void; toggleGearbox(): boolean; unlockAudio(): void; garage?(): void; recentre?(): void; tilt?(): boolean }

export class TouchControls {
  readonly state: TouchState = { active: false, steer: 0, throttle: 0, brake: 0, handbrake: 0, shiftUp: false, shiftDown: false };
  private root = document.createElement('div');

  constructor(private actions: TouchActions) {
    this.root.id = 'touch';
    this.root.innerHTML = `
      <div class="steer" data-c="steer" aria-label="Steering slider">
        <div class="steer-rail"><div class="steer-center"></div></div>
        <div class="steer-fill"></div>
        <div class="knob"></div>
      </div>
      <div class="pedals">
        <button class="pad hb" data-c="handbrake" title="Handbrake" aria-label="Handbrake">HB</button>
        <button class="pad brake" data-c="brake" title="Brake / Hold to reverse" aria-label="Brake">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11.5" cy="12" r="7.5"/>
            <circle cx="11.5" cy="12" r="2.6"/>
            <path d="M16.8 5.2a9 9 0 0 1 3.7 7.3 9 9 0 0 1-1.3 4.6" stroke-width="2.8"/>
          </svg>
        </button>
        <button class="pad gas" data-c="gas" title="Gas" aria-label="Gas">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 19V5"/>
            <path d="M6 11l6-6 6 6"/>
          </svg>
        </button>
      </div>
      <div class="shift" hidden>
        <button class="small" data-c="up" title="Shift up" aria-label="Shift up">▲</button>
        <button class="small" data-c="down" title="Shift down" aria-label="Shift down">▼</button>
      </div>
      <div class="top">
        <button class="small" data-c="garage" title="Back to the menu">← MENU</button>
        <button class="small" data-c="reset" title="Reset">⟲</button>
        <button class="small tilt-only" data-c="recentre" title="Hold the phone straight and tap">STRAIGHT</button>
        <button class="small" data-c="camera" title="Camera">CAM</button>
        <button class="small" data-c="gearbox" title="Gearbox">AUTO</button>
        <button class="small" data-c="fullscreen" title="Fullscreen">⛶</button>
      </div>`;
    document.body.appendChild(this.root);
    const on = (c: string, f: (e: PointerEvent, el: HTMLElement) => void) => {
      const el = this.root.querySelector<HTMLElement>(`[data-c="${c}"]`)!;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        this.state.active = true;
        this.actions.unlockAudio();
        f(e, el);
      });
      return el;
    };
    const hold = (c: string, set: (v: number) => void) => {
      const el = on(c, (_e, el) => { set(1); el.classList.add('down'); });
      const up = () => { set(0); el.classList.remove('down'); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    };
    hold('gas', (v) => (this.state.throttle = v));
    hold('brake', (v) => (this.state.brake = v));
    hold('handbrake', (v) => (this.state.handbrake = v));
    on('up', () => (this.state.shiftUp = true));
    on('down', () => (this.state.shiftDown = true));
    on('garage', () => this.actions.garage?.());
    on('reset', () => this.actions.reset());
    on('camera', () => this.actions.camera());
    on('recentre', () => this.actions.recentre?.());
    this.setTilt(!!this.actions.tilt?.());
    const gb = on('gearbox', (_e, el) => {
      const auto = this.actions.toggleGearbox();
      el.textContent = auto ? 'AUTO' : 'MAN';
      (this.root.querySelector('.shift') as HTMLElement).hidden = auto;
    });
    gb.textContent = 'AUTO';
    on('fullscreen', () => {
      const d = document.documentElement;
      if (document.fullscreenElement) void document.exitFullscreen();
      else d.requestFullscreen?.({ navigationUI: 'hide' }).then(() => {
        (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
      }).catch(() => {});
    });

    // Always-visible horizontal pill steering slider: direct tap-to-steer + smooth drag.
    const pad = this.root.querySelector<HTMLElement>('.steer')!;
    const knob = pad.querySelector<HTMLElement>('.knob')!;
    const fill = pad.querySelector<HTMLElement>('.steer-fill')!;
    let id = -1, centerX = 0, halfTrackPx = 1, lastU = 0;

    const applySteer = (clientX: number, force = false) => {
      const u = Math.max(-1, Math.min(1, (clientX - centerX) / halfTrackPx));
      const shaped = Math.sign(u) * (0.40 * Math.abs(u) + 0.60 * u * u);
      this.state.steer = -shaped;   // core: +1 = left
      if (force || Math.abs(u - lastU) >= 0.002 || Math.abs(u) === 1 || u === 0) {
        lastU = u;
        const dx = u * halfTrackPx;
        knob.style.transform = `translate3d(calc(-50% + ${dx.toFixed(1)}px), -50%, 0)`;
        fill.style.transform = `translate3d(0, -50%, 0) scaleX(${u.toFixed(4)})`;
      }
    };

    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id !== -1) return;
      id = e.pointerId;
      pad.setPointerCapture(id);
      this.state.active = true;
      this.actions.unlockAudio();
      const rect = pad.getBoundingClientRect();
      const inset = knob.offsetWidth ? knob.offsetWidth / 2 + 2 : 28;
      centerX = rect.left + rect.width / 2;
      halfTrackPx = Math.max(1, rect.width / 2 - inset);
      pad.classList.add('active');
      applySteer(e.clientX, true);
    });
    pad.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      applySteer(e.clientX);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      lastU = 0;
      this.state.steer = 0;
      pad.classList.remove('active');
      knob.style.transform = 'translate3d(-50%, -50%, 0)';
      fill.style.transform = 'translate3d(0, -50%, 0) scaleX(0)';
    };
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    pad.addEventListener('lostpointercapture', release);

    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Tilt steering: the steering pad goes away and a "straight" (recentre) button appears. */
  private tiltOn: boolean | null = null;
  setTilt(on: boolean) {
    if (on === this.tiltOn) return;
    this.tiltOn = on;
    this.root.classList.toggle('tilt', on);
  }

  /** Edge events are consumed once per physics tick. */
  takeShifts(): { up: boolean; down: boolean } {
    const r = { up: this.state.shiftUp, down: this.state.shiftDown };
    this.state.shiftUp = this.state.shiftDown = false;
    return r;
  }
}

/** Touch-first device (phone/tablet) or a touch actually used: show the on-screen controls. */
export function wantsTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches;
}
