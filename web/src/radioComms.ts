// Apache-2.0 — Underground Street Radio Comms + Police Scanner (OpenGrid).
// Gives both Race Events and Free Roam an authentic illegal street-racing radio feel:
//   - Race Frequency (146.52 MHz · RACE FREQ): grid-wide street radio text + walkie-talkie squelch SFX
//   - Free Roam Proximity Radio (146.52 MHz · 5.0 KM): strict 5,000 m distance filter with live signal bars & distance-scaled static
//   - Police Scanner Intercept (CH-04 · 460.12 MHz): speed camera dispatch, pursuit callouts, & Web Speech filtered police radio

export const FREE_ROAM_RADIO_RANGE_M = 5000;

export interface RadioNetMsg {
  from: string;
  text: string;
  x: number;
  z: number;
  mode: 'race' | 'free';
  ts: number;
}

export interface RadioEntry {
  channel: 'street' | 'police' | 'system';
  callsign: string;
  text: string;
  distM?: number;
  signal?: number; // 0..1
  ts: number;
}

export interface RadioCommsHooks {
  onSend(text: string): void;
  getMode(): 'race' | 'free';
  getUsername(): string;
  isDriving(): boolean;
}

const MAX_LINES = 6;
const QUICK_CALLS = [
  '🚨 Cops behind us!',
  '📸 Watch the speed cam',
  '🚧 Roadblock ahead',
  '🏁 Clean run · GG',
];

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function signalBars(sig: number): string {
  if (sig >= 0.78) return '▂▄▆█';
  if (sig >= 0.52) return '▂▄▆░';
  if (sig >= 0.28) return '▂▄░░';
  return '▂░░░';
}

export class RadioComms {
  private root: HTMLElement | null = null;
  private feedEl: HTMLElement | null = null;
  private freqEl: HTMLElement | null = null;
  private scannerEl: HTMLElement | null = null;
  private drawerEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private flashEl: HTMLElement | null = null;

  private entries: RadioEntry[] = [];
  private audioCtx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private open = false;
  private policeActive = false;
  private lastActivity = 0;
  private mode: 'race' | 'free' = 'free';
  private voiceMuted = false;

  constructor(private hooks: RadioCommsHooks) {
    this.mount();
  }

  get isTyping() { return this.open; }

  private mount() {
    const el = document.getElementById('radio-comms');
    this.flashEl = document.getElementById('cam-flash');
    if (!el) return;
    this.root = el;
    el.innerHTML = `
      <div class="rc-head">
        <span class="rc-led" aria-hidden="true"></span>
        <span class="rc-freq" id="rc-freq">146.52 MHz · 5 KM</span>
        <span class="rc-scan" id="rc-scan" hidden>CH-04 SCANNER</span>
        <button type="button" class="rc-btn" id="rc-open-btn" title="Transmit on Street Radio (Y)">TX [Y]</button>
      </div>
      <div class="rc-feed" id="rc-feed" aria-live="polite"></div>
      <div class="rc-drawer" id="rc-drawer" hidden>
        <div class="rc-quicks">${QUICK_CALLS.map((q) => `<button type="button" class="rc-q" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <div class="rc-row">
          <input type="text" id="rc-input" maxlength="120" placeholder="Transmit on street radio… (Enter to send, Esc to close)" autocomplete="off" spellcheck="false" />
          <button type="button" class="rc-send" id="rc-send">TX</button>
        </div>
      </div>`;
    this.feedEl = el.querySelector('#rc-feed');
    this.freqEl = el.querySelector('#rc-freq');
    this.scannerEl = el.querySelector('#rc-scan');
    this.drawerEl = el.querySelector('#rc-drawer');
    this.inputEl = el.querySelector('#rc-input');

    el.querySelector('#rc-open-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleInput();
    });
    el.querySelector('#rc-send')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.submitInput();
    });
    el.querySelectorAll('.rc-q').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const q = (btn as HTMLElement).dataset.q;
        if (q) this.transmitLocal(q);
        this.closeInput();
      });
    });
    this.inputEl?.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submitInput();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeInput();
      }
    });
  }

  setMode(mode: 'race' | 'free') {
    if (this.mode === mode) return;
    this.mode = mode;
    if (this.freqEl) {
      this.freqEl.textContent = mode === 'race'
        ? '146.52 MHz · RACE'
        : '146.52 MHz · 5 KM';
    }
  }

  setPoliceScannerActive(on: boolean) {
    if (this.policeActive === on) return;
    this.policeActive = on;
    if (this.scannerEl) this.scannerEl.hidden = !on;
    this.root?.classList.toggle('police-hot', on);
  }

  setVisible(on: boolean) {
    if (!this.root) return;
    this.root.hidden = !on;
    if (!on) this.closeInput();
  }

  /** Trigger full-screen double-strobe white/amber speed camera flash + shutter chirp. */
  triggerCameraFlash() {
    this.playSquelch('flash', 1);
    if (!this.flashEl) return;
    this.flashEl.classList.remove('go');
    // Force reflow so rapid consecutive camera flashes replay the double-strobe animation cleanly
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('go');
  }

  openInput() {
    if (!this.hooks.isDriving() || !this.drawerEl || !this.inputEl) return;
    this.open = true;
    this.drawerEl.hidden = false;
    this.root?.classList.add('open');
    this.root?.classList.remove('idle');
    this.lastActivity = performance.now();
    this.inputEl.value = '';
    setTimeout(() => this.inputEl?.focus(), 0);
  }

  closeInput() {
    if (!this.open) return;
    this.open = false;
    if (this.drawerEl) this.drawerEl.hidden = true;
    this.root?.classList.remove('open');
    this.inputEl?.blur();
  }

  toggleInput() {
    if (this.open) this.closeInput();
    else this.openInput();
  }

  private submitInput() {
    if (!this.inputEl) return;
    const text = this.inputEl.value.trim().slice(0, 120);
    this.inputEl.value = '';
    this.closeInput();
    if (text) this.transmitLocal(text);
  }

  /** Send a player transmission on the current street radio channel. */
  transmitLocal(text: string) {
    const clean = text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
    if (!clean) return;
    this.playSquelch('tx', 1);
    this.push({
      channel: 'street',
      callsign: this.hooks.getUsername() || 'YOU',
      text: clean,
      distM: this.mode === 'free' ? 0 : undefined,
      signal: 1,
      ts: Date.now(),
    });
    this.hooks.onSend(clean);
  }

  /** Receive a network street radio message; enforces strict 5.0 km proximity radius in Free Roam. */
  receiveNet(msg: RadioNetMsg, myPos: { x: number; z: number }, isFreeRoam: boolean): boolean {
    const text = (msg.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
    if (!text) return false;
    let distM: number | undefined;
    let signal = 1;
    if (isFreeRoam) {
      distM = Math.hypot((msg.x || 0) - myPos.x, (msg.z || 0) - myPos.z);
      if (distM > FREE_ROAM_RADIO_RANGE_M) return false; // out of 5 km radio range
      signal = Math.max(0.15, Math.min(1, 1 - distM / (FREE_ROAM_RADIO_RANGE_M * 1.08)));
    }
    this.playSquelch('rx', signal);
    this.push({
      channel: 'street',
      callsign: (msg.from || 'RACER').slice(0, 18),
      text,
      distM,
      signal,
      ts: Date.now(),
    });
    return true;
  }

  /** Street AI racer ambient chatter on the illegal race frequency. */
  aiStreetRadio(callsign: string, text: string) {
    this.playSquelch('rx', 0.85);
    this.push({
      channel: 'street',
      callsign,
      text,
      signal: 0.85,
      ts: Date.now(),
    });
  }

  /** Police Scanner Intercept (CH-04): plays VHF police repeater tone + static + dispatch voice. */
  policeIntercept(unit: string, text: string, speak = true) {
    this.playSquelch('police', 0.9);
    this.push({
      channel: 'police',
      callsign: unit,
      text,
      ts: Date.now(),
    });
    if (speak && !this.voiceMuted) this.speakPolice(text);
  }

  systemNotice(text: string) {
    this.push({ channel: 'system', callsign: 'FREQ', text, ts: Date.now() });
  }

  clearSession() {
    this.entries = [];
    this.setPoliceScannerActive(false);
    this.closeInput();
    this.render();
  }

  tick(nowMs: number) {
    if (!this.root) return;
    const quiet = !this.open && !this.policeActive && nowMs - this.lastActivity > 9500;
    this.root.classList.toggle('idle', quiet);
  }

  private push(e: RadioEntry) {
    this.entries.push(e);
    if (this.entries.length > MAX_LINES) this.entries.shift();
    this.lastActivity = performance.now();
    this.root?.classList.remove('idle');
    this.render();
  }

  private render() {
    if (!this.feedEl) return;
    if (!this.entries.length) {
      this.feedEl.innerHTML = `<div class="rc-line sys"><span>FREQ</span><em>${this.mode === 'race' ? 'Race radio open — press [Y] to transmit, [Z] for PTT voice.' : 'Local 5 km street radio scanning — press [Y] to transmit, [Z] for PTT voice.'}</em></div>`;
      return;
    }
    this.feedEl.innerHTML = this.entries.map((e) => {
      const meta = e.channel === 'street' && e.distM !== undefined
        ? `<i class="rc-sig">${e.distM < 10 ? 'TX' : `${(e.distM / 1000).toFixed(1)}km`} ${signalBars(e.signal ?? 1)}</i>`
        : e.channel === 'police'
        ? `<i class="rc-sig pol">CH-04</i>`
        : '';
      return `<div class="rc-line ${e.channel}"><b>${esc(e.callsign)}</b><em>${esc(e.text)}</em>${meta}</div>`;
    }).join('');
    this.feedEl.scrollTop = this.feedEl.scrollHeight;
  }

  private ensureAudio(): AudioContext | null {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      if (!this.audioCtx) this.audioCtx = new AC();
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume().catch(() => {});
      if (!this.noiseBuf) {
        const len = Math.floor(this.audioCtx.sampleRate * 0.25);
        const buf = this.audioCtx.createBuffer(1, len, this.audioCtx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = buf;
      }
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  /** Procedural VHF/CB squelch, bandpass radio static, police repeater chirp, and GATSO speed camera flash beep. */
  playSquelch(kind: 'tx' | 'rx' | 'police' | 'flash', signalQuality = 1) {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    try {
      if (kind === 'flash') {
        // Double-strobe GATSO radar trigger beep + crisp shutter snap
        for (const offset of [0, 0.13]) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(1920, now + offset);
          osc.frequency.exponentialRampToValueAtTime(1380, now + offset + 0.06);
          g.gain.setValueAtTime(0.085, now + offset);
          g.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.075);
          osc.connect(g).connect(ctx.destination);
          osc.start(now + offset);
          osc.stop(now + offset + 0.08);
        }
        return;
      }

      // Bandpass static hiss (louder when further away in 5 km Free Roam proximity)
      if (this.noiseBuf) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = kind === 'police' ? 1450 : 1750;
        bp.Q.value = 2.4;
        const ng = ctx.createGain();
        const staticAmp = kind === 'police' ? 0.055 : 0.025 + (1 - Math.max(0, Math.min(1, signalQuality))) * 0.07;
        const dur = kind === 'police' ? 0.16 : 0.095;
        ng.gain.setValueAtTime(staticAmp, now);
        ng.gain.exponentialRampToValueAtTime(0.001, now + dur);
        src.connect(bp).connect(ng).connect(ctx.destination);
        src.start(now);
        src.stop(now + dur + 0.01);
      }

      // Repeater / Roger beep
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = kind === 'police' ? 'square' : 'sine';
      if (kind === 'police') {
        // Classic two-tone police dispatch repeater chirp
        osc.frequency.setValueAtTime(1120, now);
        osc.frequency.setValueAtTime(1480, now + 0.06);
        g.gain.setValueAtTime(0.04, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1300;
        bp.Q.value = 1.6;
        osc.connect(bp).connect(g).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.15);
      } else {
        // Walkie-talkie PTT squelch tone
        osc.frequency.setValueAtTime(kind === 'tx' ? 1320 : 940, now);
        osc.frequency.exponentialRampToValueAtTime(kind === 'tx' ? 1680 : 720, now + 0.055);
        g.gain.setValueAtTime(0.045, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        osc.connect(g).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.07);
      }
    } catch { /* ignore audio errors */ }
  }

  private speakPolice(text: string) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      if (synth.speaking) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.16;
      u.pitch = 0.88;
      u.volume = 0.78;
      u.onend = () => this.playSquelch('rx', 0.7); // trailing roger static burst
      synth.speak(u);
    } catch { /* speech unavailable */ }
  }
}
