// WebRTC Walkie-Talkie & Car Meet Proximity Voice Chat (OpenGrid).
// Supports Push-to-Talk ([Z]) or Open Mic in Party Lobbies & Car Meets via getUserMedia + WebRTC/PeerJS audio calls,
// with crisp walkie-talkie radio squelch tone cues and zero third-party voice server costs.

export class VoiceChat {
  enabled = false;
  muted = true;
  pttActive = false;
  mode: 'ptt' | 'open' = 'ptt';
  status = 'Voice Off';

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private remoteAudios = new Map<string, HTMLAudioElement>();
  readonly mutedPeers = new Set<string>();
  readonly blockedPeers = new Set<string>();

  toggleMutePeer(peerId: string): boolean {
    if (this.mutedPeers.has(peerId)) this.mutedPeers.delete(peerId);
    else this.mutedPeers.add(peerId);
    const el = this.remoteAudios.get(peerId);
    if (el) el.muted = this.mutedPeers.has(peerId) || this.blockedPeers.has(peerId);
    return this.mutedPeers.has(peerId);
  }

  blockPeer(peerId: string) {
    this.blockedPeers.add(peerId);
    this.mutedPeers.add(peerId);
    const el = this.remoteAudios.get(peerId);
    if (el) { el.muted = true; el.volume = 0; }
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
      this.status = this.mode === 'open' ? 'Open Mic Live' : 'Walkie-Talkie Ready ([Z] PTT)';
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
    for (const a of this.remoteAudios.values()) { a.pause(); a.srcObject = null; }
    this.remoteAudios.clear();
    this.status = 'Voice Off';
  }

  setMode(m: 'ptt' | 'open') {
    this.mode = m;
    if (this.enabled) {
      this.setTransmitting(m === 'open');
      this.status = m === 'open' ? 'Open Mic Live' : 'Walkie-Talkie Ready ([Z] PTT)';
    }
  }

  /** Push-to-talk key down/up ([Z]). Plays classic walkie-talkie squelch beep. */
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

  /** Attach an incoming remote peer MediaStream (with optional Car Meet distance attenuation). */
  attachRemoteStream(peerId: string, stream: MediaStream) {
    let el = this.remoteAudios.get(peerId);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      this.remoteAudios.set(peerId, el);
    }
    el.srcObject = stream;
    void el.play().catch(() => {});
  }

  /** Proximity voice attenuation for 5-floor Car Meets (full volume <= 8 m, fades smoothly to 0 at 45 m). */
  setPeerDistance(peerId: string, meters: number) {
    const el = this.remoteAudios.get(peerId);
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, 1 - (meters - 8) / 37));
  }

  get localStream(): MediaStream | null { return this.stream; }

  private playSquelch(on: boolean) {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!this.audioCtx) this.audioCtx = new AC();
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(on ? 1280 : 880, now);
      osc.frequency.exponentialRampToValueAtTime(on ? 1620 : 620, now + 0.055);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.065);
    } catch { /* ignore */ }
  }
}
