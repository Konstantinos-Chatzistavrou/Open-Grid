// WebRTC Illegal Street Radio Walkie-Talkie & 5 km Free Roam Proximity Voice Chat (OpenGrid).
// Routes remote peer WebRTC streams through a procedural Web Audio VHF/CB bandpass radio filter
// (320-3100 Hz) + squelch roger beeps for authentic underground street-racing radio comms,
// with configurable proximity range (Race-wide radio, 5 km Free Roam proximity, or 45 m Car Meet).

interface RemoteVoiceChain {
  el: HTMLAudioElement;
  src: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  distGain: number;
}

export class VoiceChat {
  enabled = false;
  muted = true;
  pttActive = false;
  mode: 'ptt' | 'open' = 'ptt';
  status = 'Radio Voice Off';

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private remoteChains = new Map<string, RemoteVoiceChain>();
  readonly mutedPeers = new Set<string>();
  readonly blockedPeers = new Set<string>();

  toggleMutePeer(peerId: string): boolean {
    if (this.mutedPeers.has(peerId)) this.mutedPeers.delete(peerId);
    else this.mutedPeers.add(peerId);
    this.syncPeerGain(peerId);
    return this.mutedPeers.has(peerId);
  }

  blockPeer(peerId: string) {
    this.blockedPeers.add(peerId);
    this.mutedPeers.add(peerId);
    this.syncPeerGain(peerId);
  }

  private syncPeerGain(peerId: string) {
    const c = this.remoteChains.get(peerId);
    if (!c) return;
    const silent = this.mutedPeers.has(peerId) || this.blockedPeers.has(peerId);
    c.el.muted = silent || !!c.gain; // muted on <audio> element when routed via Web Audio bandpass filter
    if (c.gain && this.audioCtx) {
      c.gain.gain.setTargetAtTime(silent ? 0 : c.distGain, this.audioCtx.currentTime, 0.04);
    } else {
      c.el.volume = silent ? 0 : c.distGain;
    }
  }

  async enable(): Promise<boolean> {
    if (this.enabled && this.stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.status = 'Microphone API unavailable in this browser';
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      this.enabled = true;
      this.setTransmitting(this.mode === 'open');
      this.status = this.mode === 'open' ? 'Street Radio Open Mic' : 'Street Radio Ready ([Z] PTT)';
      return true;
    } catch {
      this.status = 'Microphone permission denied';
      return false;
    }
  }

  disable() {
    this.enabled = false;
    this.muted = true;
    this.pttActive = false;
    if (this.stream) {
      for (const tr of this.stream.getTracks()) tr.stop();
      this.stream = null;
    }
    for (const c of this.remoteChains.values()) {
      try { c.src?.disconnect(); c.gain?.disconnect(); } catch { /* ignore */ }
      c.el.pause();
      c.el.srcObject = null;
    }
    this.remoteChains.clear();
    this.status = 'Radio Voice Off';
  }

  setMode(m: 'ptt' | 'open') {
    this.mode = m;
    if (this.enabled) {
      this.setTransmitting(m === 'open');
      this.status = m === 'open' ? 'Street Radio Open Mic' : 'Street Radio Ready ([Z] PTT)';
    }
  }

  /** Push-to-talk key down/up ([Z]). Plays classic illegal street walkie-talkie squelch beep. */
  setPushToTalk(down: boolean) {
    if (!this.enabled || this.mode !== 'ptt' || this.pttActive === down) return;
    this.pttActive = down;
    this.setTransmitting(down);
    this.playSquelch(down);
  }

  private setTransmitting(tx: boolean) {
    this.muted = !tx;
    if (this.stream) {
      for (const tr of this.stream.getAudioTracks()) tr.enabled = tx;
    }
  }

  private ensureCtx(): AudioContext | null {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      if (!this.audioCtx) this.audioCtx = new AC();
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume().catch(() => {});
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  /** Attach an incoming remote peer MediaStream routed through a VHF/CB radio bandpass filter (320-3100 Hz). */
  attachRemoteStream(peerId: string, stream: MediaStream) {
    this.detachRemoteStream(peerId);
    const el = document.createElement('audio');
    el.autoplay = true;
    el.srcObject = stream;

    let src: MediaStreamAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    const ctx = this.ensureCtx();
    if (ctx) {
      try {
        src = ctx.createMediaStreamSource(stream);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 320;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3100;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -22;
        comp.ratio.value = 6;
        gain = ctx.createGain();
        gain.gain.value = 1;
        src.connect(hp).connect(lp).connect(comp).connect(gain).connect(ctx.destination);
        el.muted = true; // Web Audio handles output so Chrome keeps stream active without double playback
      } catch {
        src = null;
        gain = null;
      }
    }

    this.remoteChains.set(peerId, { el, src, gain, distGain: 1 });
    this.syncPeerGain(peerId);
    void el.play().catch(() => {});
  }

  /** Remove a disconnected peer's audio element and radio filter nodes. */
  detachRemoteStream(peerId: string) {
    const c = this.remoteChains.get(peerId);
    if (!c) return;
    try { c.src?.disconnect(); c.gain?.disconnect(); } catch { /* ignore */ }
    c.el.pause();
    c.el.srcObject = null;
    this.remoteChains.delete(peerId);
  }

  /**
   * Proximity radio voice attenuation:
   *  - Race frequency (`maxRangeMeters = Infinity`): crystal-clear grid-wide radio (gain = 1)
   *  - Free Roam (`maxRangeMeters = 5000`): full volume <= 1000 m, fades smoothly to 0 at 5,000 m (5 km)
   *  - Car Meet (`maxRangeMeters = 45`): tight close-range attenuation
   */
  setPeerDistance(peerId: string, meters: number, maxRangeMeters = 5000) {
    const c = this.remoteChains.get(peerId);
    if (!c) return;
    if (!Number.isFinite(maxRangeMeters)) {
      c.distGain = 1;
    } else if (meters >= maxRangeMeters) {
      c.distGain = 0;
    } else {
      const fullRadius = maxRangeMeters * 0.2;
      c.distGain = meters <= fullRadius
        ? 1
        : Math.max(0, Math.min(1, 1 - (meters - fullRadius) / (maxRangeMeters - fullRadius)));
    }
    this.syncPeerGain(peerId);
  }

  get localStream(): MediaStream | null { return this.stream; }

  private playSquelch(on: boolean) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(on ? 1280 : 880, now);
      osc.frequency.exponentialRampToValueAtTime(on ? 1620 : 620, now + 0.055);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.065);
    } catch { /* ignore */ }
  }
}
