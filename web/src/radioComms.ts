// Apache-2.0 — Underground Street Radio Comms + Police Scanner (OpenGrid).
// Gives both Race Events and Free Roam an authentic illegal street-racing radio feel:
//   - Race Frequency (146.52 MHz · RACE FREQ): grid-wide street radio text + neural CB voice clips + walkie-talkie squelch SFX
//   - Free Roam Proximity Radio (146.52 MHz · 5.0 KM): strict 5,000 m distance filter with live signal bars & distance-scaled static
//   - Police Scanner Intercept (CH-04 · 460.12 MHz): Motorola APX/MDC-1200 chirp, studio neural VHF voice clips, & clean TX queue

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

interface RadioTxItem {
  channel: 'police' | 'street';
  clipId?: string;
  text: string;
  signal: number;
  allowTtsFallback: boolean;
}

const MAX_LINES = 6;
const MAX_QUEUED_TX = 2;

const QUICK_CALLS = [
  '🚨 Cops behind us!',
  '📸 Watch the speed cam',
  '🚧 Roadblock ahead',
  '🏁 Clean run · GG',
];

const KNOWN_CLIPS = new Set<string>([
  // Police Dispatch
  'cam_dispatch',
  'cam_respot',
  'roadblock_deploy',
  'escaped',
  // Police Interceptor
  'patrol_spotted',
  'unit_visual',
  'intercept_ahead',
  'pit_request',
  'pit_contact',
  'roadblock_cleared',
  'high_speed',
  'evading_gap',
  'evading_los',
  'reacquired',
  'busted',
  'pull_over_1',
  'pull_over_2',
  'boxing_in',
  'unit_disabled',
  // Underground Street Crew / GPS
  'street_cam_warn',
  'street_rb_punch',
  'street_rb_forming',
  'street_rb_reroute',
  'street_rb_cleared',
]);

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function signalBars(sig: number): string {
  if (sig >= 0.78) return '▂▄▆█';
  if (sig >= 0.52) return '▂▄▆░';
  if (sig >= 0.28) return '▂▄░░';
  return '▂░░░';
}

function resolveClipUrl(clipId: string): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL || '/';
  const norm = base.endsWith('/') ? base : `${base}/`;
  return `${norm}assets/audio/radio/${clipId}.ogg`;
}

/** Automatic keyword -> clipId fallback when callers pass natural radio text without an explicit clipId. */
function inferClipId(channel: 'police' | 'street', text: string): string | undefined {
  if (channel === 'police') {
    if (/unit disabled|heavy (crash|vehicle) damage|out of the pursuit/i.test(text)) return 'unit_disabled';
    if (/moving alongside|do not ram|keep it clean|box the suspect in/i.test(text)) return 'boxing_in';
    if (/pull your vehicle over|side of the road|stop immediately/i.test(text)) return 'pull_over_1';
    if (/slow down and pull over|pull over (right )?now|stop the vehicle/i.test(text)) return 'pull_over_2';
    if (/10-15|ten-fifteen|in custody|immobilized|boxed in and stopped/i.test(text)) return 'busted';
    if (/10-22|ten-twenty-two|cancel pursuit|return to patrol|stand down|terminated|slipped the net|evaded/i.test(text)) return 'escaped';
    if (/visual re-?acquired|re-?acquired|got 'em|back in (hot )?pursuit/i.test(text)) return 'reacquired';
    if (/lost visual|behind.*blocks|side streets|cooldown search/i.test(text)) return 'evading_los';
    if (/out of visual|opening a gap|search pattern/i.test(text)) return 'evading_gap';
    if (/contact!|pit engaged|keep 'em boxed/i.test(text)) return 'pit_contact';
    if (/\bpit\b|rear quarter/i.test(text)) return 'pit_request';
    if (/cleared.*roadblock|blew.*through.*roadblock|through the roadblock/i.test(text)) return 'roadblock_cleared';
    if (/roadblock/i.test(text)) return 'roadblock_deploy';
    if (/caught.*again|re-?engag|blew past camera/i.test(text)) return 'cam_respot';
    if (/speed cam|camera.*tripped|clocked at/i.test(text)) return 'cam_dispatch';
    if (/pulling away|pulling hard|topped out|high-?speed backup/i.test(text)) return 'high_speed';
    if (/rolling out ahead|cut 'em off|cut them off|intersection/i.test(text)) return 'intercept_ahead';
    if (/reckless|flying past|on 'em/i.test(text)) return 'patrol_spotted';
    if (/10-4|ten-four|has visual|moving to intercept|lights and sirens/i.test(text)) return 'unit_visual';
    return undefined;
  }

  // Underground street radio / GPS channel
  if (/speed cam|tripped.*cam|scanners/i.test(text)) return 'street_cam_warn';
  if (/punched through|bypass complete|past the roadblock|back on (the )?main/i.test(text)) return 'street_rb_cleared';
  if (/reroute active|reroute locked|bypass route locked|swing (left|right|wide)/i.test(text)) return 'street_rb_reroute';
  if (/punch through|top 3.*too close/i.test(text)) return 'street_rb_punch';
  if (/roadblock forming|roadblock ahead|rerouting/i.test(text)) return 'street_rb_forming';
  return undefined;
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

  // Real neural-voice radio clip cache & non-overlapping transmission queue
  private clipCache = new Map<string, AudioBuffer | null>();
  private clipLoading = new Map<string, Promise<AudioBuffer | null>>();
  private txQueue: RadioTxItem[] = [];
  private txBusy = false;
  private activeSource: AudioBufferSourceNode | null = null;
  private txSessionGen = 0;
  private nextTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** Street AI racer / GPS callout on the illegal race frequency (plays real neural CB voice clip when mapped). */
  aiStreetRadio(callsign: string, text: string, clipId?: string) {
    this.push({
      channel: 'street',
      callsign,
      text,
      signal: 0.88,
      ts: Date.now(),
    });
    const resolvedClip = (clipId && KNOWN_CLIPS.has(clipId)) ? clipId : inferClipId('street', text);
    if (resolvedClip && !this.voiceMuted) {
      this.enqueueTx({
        channel: 'street',
        clipId: resolvedClip,
        text,
        signal: 0.88,
        allowTtsFallback: false,
      });
    } else {
      this.playSquelch('rx', 0.85);
    }
  }

  /** Police Scanner Intercept (CH-04): queues Motorola repeater chirp + real neural VHF voice clip + trailing squelch. */
  policeIntercept(unit: string, text: string, speak = true, clipId?: string) {
    this.push({
      channel: 'police',
      callsign: unit,
      text,
      ts: Date.now(),
    });
    if (speak && !this.voiceMuted) {
      const resolvedClip = (clipId && KNOWN_CLIPS.has(clipId)) ? clipId : inferClipId('police', text);
      this.enqueueTx({
        channel: 'police',
        clipId: resolvedClip,
        text,
        signal: 0.92,
        allowTtsFallback: true,
      });
    } else {
      this.playSquelch('police', 0.9);
    }
  }

  systemNotice(text: string) {
    this.push({ channel: 'system', callsign: 'FREQ', text, ts: Date.now() });
  }

  clearSession() {
    this.entries = [];
    this.stopAllTransmissions();
    this.setPoliceScannerActive(false);
    this.closeInput();
    this.render();
  }

  tick(nowMs: number) {
    if (!this.root) return;
    const quiet = !this.open && !this.policeActive && nowMs - this.lastActivity > 9500;
    this.root.classList.toggle('idle', quiet);
  }

  private stopAllTransmissions() {
    this.txSessionGen++;
    this.txQueue.length = 0;
    this.txBusy = false;
    if (this.nextTimer !== null) {
      clearTimeout(this.nextTimer);
      this.nextTimer = null;
    }
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch { /* already stopped */ }
      this.activeSource = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
  }

  private enqueueTx(item: RadioTxItem) {
    // Drop stale queued transmissions if more than MAX_QUEUED_TX are backed up so radio stays snappy & live
    while (this.txQueue.length >= MAX_QUEUED_TX) {
      this.txQueue.shift();
    }
    this.txQueue.push(item);
    // Warm-start fetch immediately so clip is decoded by the time the repeater chirp finishes
    if (item.clipId) void this.loadClip(item.clipId);
    if (!this.txBusy) void this.pumpQueue();
  }

  private async pumpQueue() {
    if (this.txBusy) return;
    const item = this.txQueue.shift();
    if (!item) return;

    const gen = this.txSessionGen;
    this.txBusy = true;

    const finish = () => {
      if (gen !== this.txSessionGen) return;
      this.activeSource = null;
      this.playTrailingSquelch(item.channel, item.signal);
      this.nextTimer = setTimeout(() => {
        if (gen !== this.txSessionGen) return;
        this.nextTimer = null;
        this.txBusy = false;
        void this.pumpQueue();
      }, 150);
    };

    try {
      // Load real neural .ogg clip first (fast from in-memory cache after first play)
      const clipBuf = item.clipId ? await this.loadClip(item.clipId) : null;
      if (gen !== this.txSessionGen) return;

      // Opening Motorola MDC-1200 / PTT chirp bookend
      const chirpDelayMs = item.channel === 'police' ? 145 : 80;
      this.playSquelch(item.channel === 'police' ? 'police' : 'rx', item.signal);

      if (clipBuf) {
        const ctx = this.ensureAudio();
        if (ctx) {
          const startAt = ctx.currentTime + chirpDelayMs / 1000;
          const src = ctx.createBufferSource();
          src.buffer = clipBuf;

          const gain = ctx.createGain();
          gain.gain.value = item.channel === 'police' ? 0.90 : 0.84;

          src.connect(gain).connect(ctx.destination);
          this.activeSource = src;

          let done = false;
          const onDone = () => {
            if (done) return;
            done = true;
            finish();
          };
          src.onended = onDone;
          src.start(startAt);
          return;
        }
      }

      // Natural browser neural-voice fallback ONLY if .ogg unavailable or unmapped custom line
      if (item.allowTtsFallback) {
        setTimeout(() => {
          if (gen !== this.txSessionGen) return;
          this.speakNaturalFallback(item.text, finish);
        }, chirpDelayMs);
      } else {
        finish();
      }
    } catch {
      finish();
    }
  }

  private loadClip(clipId: string): Promise<AudioBuffer | null> {
    if (this.clipCache.has(clipId)) {
      return Promise.resolve(this.clipCache.get(clipId) ?? null);
    }
    const inflight = this.clipLoading.get(clipId);
    if (inflight) return inflight;

    const p = (async () => {
      try {
        const ctx = this.ensureAudio();
        if (!ctx) return null;
        const resp = await fetch(resolveClipUrl(clipId));
        if (!resp.ok) {
          this.clipCache.set(clipId, null);
          return null;
        }
        const arr = await resp.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arr);
        this.clipCache.set(clipId, decoded);
        return decoded;
      } catch {
        this.clipCache.set(clipId, null);
        return null;
      } finally {
        this.clipLoading.delete(clipId);
      }
    })();

    this.clipLoading.set(clipId, p);
    return p;
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

  /** Procedural Motorola MDC-1200 / VHF squelch, bandpass radio static, repeater chirp, and GATSO speed camera flash beep. */
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

      // Bandpass carrier squelch burst (louder when further away in 5 km Free Roam proximity)
      if (this.noiseBuf) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = kind === 'police' ? 1550 : 1750;
        bp.Q.value = 2.4;
        const ng = ctx.createGain();
        const staticAmp = kind === 'police' ? 0.048 : 0.024 + (1 - Math.max(0, Math.min(1, signalQuality))) * 0.065;
        const dur = kind === 'police' ? 0.14 : 0.085;
        ng.gain.setValueAtTime(staticAmp, now);
        ng.gain.exponentialRampToValueAtTime(0.001, now + dur);
        src.connect(bp).connect(ng).connect(ctx.destination);
        src.start(now);
        src.stop(now + dur + 0.01);
      }

      if (kind === 'police') {
        // Authentic Motorola MDC-1200 PTT pre-ID FSK warble (1200/1800 Hz rapid digital chirp) + VHF repeater beep
        const osc = ctx.createOscillator();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1480;
        bp.Q.value = 1.8;
        const g = ctx.createGain();
        osc.type = 'square';
        const fskSteps = [1200, 1800, 1200, 1800, 1800, 1200, 1800, 1200];
        for (let i = 0; i < fskSteps.length; i++) {
          osc.frequency.setValueAtTime(fskSteps[i], now + i * 0.011);
        }
        // Short clean VHF repeater talk-permit tone right after MDC burst
        osc.frequency.setValueAtTime(1520, now + 0.092);
        g.gain.setValueAtTime(0.036, now);
        g.gain.setValueAtTime(0.032, now + 0.09);
        g.gain.exponentialRampToValueAtTime(0.0008, now + 0.145);
        osc.connect(bp).connect(g).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.155);
      } else {
        // Walkie-talkie / CB PTT squelch tone
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(kind === 'tx' ? 1320 : 940, now);
        osc.frequency.exponentialRampToValueAtTime(kind === 'tx' ? 1680 : 720, now + 0.055);
        g.gain.setValueAtTime(0.042, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
        osc.connect(g).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.07);
      }
    } catch { /* ignore audio errors */ }
  }

  /** Crisp trailing Motorola PTT un-key click + short VHF squelch tail after a voice clip finishes. */
  private playTrailingSquelch(channel: 'police' | 'street', signalQuality: number) {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    try {
      if (this.noiseBuf) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = channel === 'police' ? 1900 : 1650;
        bp.Q.value = 2.6;
        const ng = ctx.createGain();
        const amp = channel === 'police' ? 0.052 : 0.03 + (1 - Math.max(0, Math.min(1, signalQuality))) * 0.04;
        ng.gain.setValueAtTime(amp, now);
        ng.gain.exponentialRampToValueAtTime(0.0008, now + 0.095);
        src.connect(bp).connect(ng).connect(ctx.destination);
        src.start(now);
        src.stop(now + 0.105);
      }
      // Subtle PTT release "kshh-tick" drop
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(channel === 'police' ? 980 : 840, now);
      osc.frequency.exponentialRampToValueAtTime(420, now + 0.032);
      g.gain.setValueAtTime(0.028, now);
      g.gain.exponentialRampToValueAtTime(0.0008, now + 0.038);
      osc.connect(g).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.045);
    } catch { /* ignore */ }
  }

  /** Natural-voice browser TTS fallback ONLY used if an .ogg clip fails to load or for custom unmapped lines. */
  private speakNaturalFallback(text: string, onDone: () => void) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      onDone();
      return;
    }
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      onDone();
    };
    try {
      const synth = window.speechSynthesis;
      if (synth.speaking) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const bestVoice = this.pickBestNaturalVoice(synth);
      if (bestVoice) u.voice = bestVoice;
      u.rate = 1.03;
      u.pitch = 1.0;
      u.volume = 0.80;
      const safetyTimer = setTimeout(done, 8500);
      u.onend = () => { clearTimeout(safetyTimer); done(); };
      u.onerror = () => { clearTimeout(safetyTimer); done(); };
      synth.speak(u);
    } catch {
      done();
    }
  }

  private pickBestNaturalVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    const voices = synth.getVoices?.() || [];
    if (!voices.length) return null;
    const patterns: RegExp[] = [
      /Microsoft .* Online \(Natural\).*English/i,
      /Google US English/i,
      /\b(Samantha|Alex|Daniel|Ava|Allison|Serena)\b/i,
    ];
    for (const re of patterns) {
      const hit = voices.find((v) => re.test(v.name));
      if (hit) return hit;
    }
    return voices.find((v) => /^en[-_]US/i.test(v.lang))
      ?? voices.find((v) => /^en/i.test(v.lang))
      ?? null;
  }
}
