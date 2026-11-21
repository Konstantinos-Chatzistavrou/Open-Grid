// Physical Web Audio synthesizer for Open Grid:
// - Cross-plane V8 engine with custom Fourier blowdown PeriodicWave, dual-bank exhaust comb filter,
//   acoustic header/muffler formant resonators, intake induction roar, straight-cut GT gearbox whine,
//   upshift ignition-cut bark, and lift-off overrun exhaust crackles/pops.
// - Dedicated physical collision & destruction synthesizers:
//   * breakPoleSound(): hollow steel tube modal ringing + bolt shear snap + secondary asphalt clang & electric sparks
//   * breakGlassShopSound(): tempered plate-glass flex thump + wide-band shatter + 45+ crystalline shard chimes
//   * breakWallSound(): heavy structural masonry/concrete demolition + falling brick rubble + glass shatter
import { OUT } from './physics/core';
import { stockEngineOfCar, type EngineVoiceId } from './brands';

/** Acoustic synthesis parameters derived from real engine firing orders, crank planes & exhaust manifolds. */
interface EngineVoiceSpec {
  /** Combustion firings per crankshaft revolution (3.0 = 6-cyl, 4.0 = 8-cyl / 4-rotor, 5.0 = V10, 6.0 = V12). */
  firingsPerRev: number;
  /** Sub-harmonic oscillator ratio relative to firing freq (0.25 = cross-plane V8 lope, 0.5 = odd-fire V10 / flat-6). */
  subRatio: number;
  /** Secondary exhaust bank / unequal-runner ratio (0.75 = V8, 1.5 = V10/Flat-6 rasp, 2.0 = V12/Flat-8/Rotary scream). */
  bankRatio: number;
  /** Upper intake/header harmonic shriek ratio (2.0 = V12 soprano, 2.5 = V10 wail, 3.0 = Flat-6/Rotary buzz). */
  harmRatio: number;
  /** Oscillator mix weights */
  mainGain: number;
  subGain: number;
  bankGain: number;
  harmGain: number;
  /** Dual exhaust bank X-pipe / header waveguide comb delays (seconds) */
  combL: number;
  combR: number;
  /** 3 acoustic exhaust/intake formant resonators [freqHz, Q, gainDb] */
  f1: [number, number, number];
  f2: [number, number, number];
  f3: [number, number, number];
  /** Idle lope rate (Hz) & depth (rotary peripheral-port brap & cross-plane V8 cam lope vs smooth V12/I6) */
  lopeHz: number;
  lopeDepth: number;
  /** WaveShaper harmonic saturation drive */
  drive: number;
  /** Forced induction synthesizer mode */
  boost: 'none' | 'turbo' | 'supercharger';
  /** Garage rev target RPM */
  revRpm: number;
  /** PeriodicWave preset key */
  waveKey: 'crossplane' | 'flatplane' | 'v12' | 'v10' | 'v6' | 'flat6' | 'flat8' | 'i6' | 'rotary';
}

const ENGINE_VOICES: Record<EngineVoiceId, EngineVoiceSpec> = {
  v8_crossplane: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.75, harmRatio: 1.5,
    mainGain: 0.76, subGain: 0.74, bankGain: 0.38, harmGain: 0.14,
    combL: 0.0024, combR: 0.0043,
    f1: [112, 2.2, 8.0], f2: [330, 1.8, 5.5], f3: [1220, 2.4, 4.2],
    lopeHz: 17.5, lopeDepth: 0.032, drive: 4.4, boost: 'none', revRpm: 7200, waveKey: 'crossplane',
  },
  v8_twin_turbo: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.75, harmRatio: 1.5,
    mainGain: 0.74, subGain: 0.68, bankGain: 0.36, harmGain: 0.16,
    combL: 0.0028, combR: 0.0046,
    f1: [104, 2.4, 8.5], f2: [295, 1.9, 5.8], f3: [1180, 2.3, 3.8],
    lopeHz: 18.0, lopeDepth: 0.026, drive: 4.2, boost: 'turbo', revRpm: 7800, waveKey: 'crossplane',
  },
  v8_supercharged: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.75, harmRatio: 1.5,
    mainGain: 0.78, subGain: 0.76, bankGain: 0.40, harmGain: 0.14,
    combL: 0.0026, combR: 0.0048,
    f1: [98, 2.5, 9.0], f2: [310, 1.7, 6.0], f3: [1350, 2.2, 4.5],
    lopeHz: 15.5, lopeDepth: 0.038, drive: 4.8, boost: 'supercharger', revRpm: 7200, waveKey: 'crossplane',
  },
  v8_flatplane: {
    firingsPerRev: 4.0, subRatio: 0.5, bankRatio: 1.003, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.30, bankGain: 0.42, harmGain: 0.36,
    combL: 0.0018, combR: 0.0019,
    f1: [165, 2.0, 5.5], f2: [520, 2.1, 5.5], f3: [1780, 2.8, 6.8],
    lopeHz: 24.0, lopeDepth: 0.014, drive: 4.6, boost: 'none', revRpm: 9000, waveKey: 'flatplane',
  },
  v12_na: {
    firingsPerRev: 6.0, subRatio: 0.5, bankRatio: 1.002, harmRatio: 2.0,
    mainGain: 0.84, subGain: 0.24, bankGain: 0.44, harmGain: 0.46,
    combL: 0.0015, combR: 0.00155,
    f1: [195, 2.0, 4.8], f2: [640, 2.3, 6.2], f3: [2150, 3.0, 7.6],
    lopeHz: 28.0, lopeDepth: 0.008, drive: 3.8, boost: 'none', revRpm: 9300, waveKey: 'v12',
  },
  v10_screamer: {
    firingsPerRev: 5.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.36, bankGain: 0.50, harmGain: 0.42,
    combL: 0.0019, combR: 0.0027,
    f1: [170, 2.2, 5.4], f2: [560, 2.4, 6.8], f3: [1980, 3.1, 7.8],
    lopeHz: 22.0, lopeDepth: 0.014, drive: 4.5, boost: 'none', revRpm: 9000, waveKey: 'v10',
  },
  v6_tt: {
    firingsPerRev: 3.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 2.0,
    mainGain: 0.78, subGain: 0.46, bankGain: 0.44, harmGain: 0.24,
    combL: 0.0023, combR: 0.0036,
    f1: [135, 2.3, 6.8], f2: [430, 2.1, 6.0], f3: [1520, 2.6, 5.4],
    lopeHz: 19.0, lopeDepth: 0.020, drive: 4.3, boost: 'turbo', revRpm: 8000, waveKey: 'v6',
  },
  flat6_na: {
    firingsPerRev: 3.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 3.0,
    mainGain: 0.76, subGain: 0.38, bankGain: 0.52, harmGain: 0.38,
    combL: 0.0017, combR: 0.0031,
    f1: [155, 2.1, 5.6], f2: [490, 2.4, 6.5], f3: [1880, 3.2, 7.8],
    lopeHz: 21.0, lopeDepth: 0.018, drive: 4.7, boost: 'none', revRpm: 9000, waveKey: 'flat6',
  },
  flat8_na: {
    firingsPerRev: 4.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.32, bankGain: 0.46, harmGain: 0.42,
    combL: 0.0016, combR: 0.0025,
    f1: [175, 2.2, 5.2], f2: [580, 2.3, 6.4], f3: [2040, 3.0, 7.5],
    lopeHz: 24.5, lopeDepth: 0.012, drive: 4.5, boost: 'none', revRpm: 9400, waveKey: 'flat8',
  },
  i6_forged: {
    firingsPerRev: 3.0, subRatio: 0.5, bankRatio: 2.0, harmRatio: 3.0,
    mainGain: 0.82, subGain: 0.28, bankGain: 0.44, harmGain: 0.30,
    combL: 0.0020, combR: 0.00205,
    f1: [148, 2.2, 6.2], f2: [460, 2.2, 6.0], f3: [1680, 2.8, 6.2],
    lopeHz: 25.0, lopeDepth: 0.010, drive: 3.9, boost: 'turbo', revRpm: 8200, waveKey: 'i6',
  },
  rotary_4: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 2.0, harmRatio: 3.0,
    mainGain: 0.80, subGain: 0.40, bankGain: 0.54, harmGain: 0.50,
    combL: 0.0013, combR: 0.00135,
    f1: [185, 2.4, 5.2], f2: [720, 2.8, 7.2], f3: [2480, 3.4, 8.6],
    lopeHz: 11.5, lopeDepth: 0.068, drive: 5.2, boost: 'none', revRpm: 10200, waveKey: 'rotary',
  },
};

/** Dual-zone physical combustion stem mapping (`/assets/audio/<id>.ogg` + reference RPM). */
interface EngineStemZoneSpec {
  low: readonly [id: string, refRpm: number];
  high: readonly [id: string, refRpm: number];
}

const ENGINE_STEM_ZONES: Record<EngineVoiceId, EngineStemZoneSpec> = {
  flat6_na:        { low: ['eng_flat6_low', 1800],    high: ['eng_flat6_4000', 4000] },
  v12_na:          { low: ['eng_v12_low', 2000],      high: ['eng_v12_5000', 5000] },
  v10_screamer:    { low: ['eng_v10_low', 2000],      high: ['eng_v10_5500', 5500] },
  rotary_4:        { low: ['eng_rotary4_low', 1600],  high: ['eng_rotary4_6000', 6000] },
  i6_forged:       { low: ['eng_tt_i6_low', 1800],    high: ['eng_tt_i6_4000', 4000] },
  v6_tt:           { low: ['eng_tt_i6_low', 1800],    high: ['eng_tt_i6_4000', 4000] },
  v8_crossplane:   { low: ['eng_v8_cross_low', 1500], high: ['eng_v8_cross_4200', 4200] },
  v8_twin_turbo:   { low: ['eng_v8_cross_low', 1500], high: ['eng_v8_cross_4200', 4200] },
  v8_flatplane:    { low: ['eng_v8_flat_low', 2000],  high: ['eng_v8_flat_5500', 5500] },
  flat8_na:        { low: ['eng_v8_flat_low', 2000],  high: ['eng_v8_flat_5500', 5500] },
  v8_supercharged: { low: ['eng_v8_cross_low', 1500], high: ['eng_sc_v8_whine', 4000] },
};

const FX_LOOP_STEMS = [
  'gear_whine_straightcut',
  'tyre_scrub_dry',
  'tyre_spray_wet',
  'kerb_rumble_strip',
] as const;

const FX_ONESHOT_STEMS = [
  'turbo_flutter_bov',
  'exhaust_backfire_pop',
] as const;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private out: GainNode | null = null;
  private waves: Partial<Record<EngineVoiceSpec['waveKey'], PeriodicWave>> = {};
  private eng: {
    o1: OscillatorNode;
    oMain: OscillatorNode;
    oSub: OscillatorNode;
    oBank: OscillatorNode;
    oHarm: OscillatorNode;
    gMain: GainNode;
    gSub: GainNode;
    gBank: GainNode;
    gHarm: GainNode;
    oBoost: OscillatorNode;
    boostFilter: BiquadFilterNode;
    boostGain: GainNode;
    oGear: OscillatorNode;
    gearGain: GainNode;
    combDelayL: DelayNode;
    combDelayR: DelayNode;
    formant1: BiquadFilterNode;
    formant2: BiquadFilterNode;
    formant3: BiquadFilterNode;
    intakeFilter: BiquadFilterNode;
    intakeGain: GainNode;
    exhaustFilter: BiquadFilterNode;
    exhaustGain: GainNode;
    lp: BiquadFilterNode;
    shaper: WaveShaperNode;
    g: GainNode;
  } | null = null;
  private tyre: { f: BiquadFilterNode; f2: BiquadFilterNode; g: GainNode } | null = null;
  private roadRoll: { f: BiquadFilterNode; g: GainNode } | null = null;
  /** Simcenter Tire 2606 dual Doppler-split toroidal air-cavity (~225 Hz) resonant bandpass filters. */
  private cavity: { fLo: BiquadFilterNode; fHi: BiquadFilterNode; g: GainNode } | null = null;
  private lastBovAt = 0;
  /** audio-clock time of the last update of the slow layers (wind, road roll, reverb send: 80-140 ms smoothing) */
  private slowAt = -1;
  private wind: { f: BiquadFilterNode; g: GainNode } | null = null;
  private reverbSend: GainNode | null = null;
  /** Dynamic adaptive music state (reacts to speed, police pursuit heat & finish line swell). */
  musicEnabled = true;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicStep = 0;
  private musicIntensity = 0;
  private musicChase = false;
  /** Environmental reverb amount 0 (open avenue) .. 1 (narrow canyon / tunnel). */
  envReverb = 0;
  /** Surface wetness 0 (dry asphalt) .. 1 (rain puddles) & off-road gravel flag. */
  roadWetness = 0.3;
  onGravel = false;
  /** two-tone police siren, created on first use; gain follows the pursuit's proximity */
  private srn: { o: OscillatorNode; lfo: OscillatorNode; lg: GainNode; g: GainNode } | null = null;
  private lastGear = 1;
  private lastRpm = 800;
  private nextCrackleAt = 0;
  private voiceId: EngineVoiceId = 'v8_crossplane';
  private extraTurbo = false;
  private boostSpool = 0;
  private revUntil = 0;
  // Real interactive Garage engine state (Ignition = toggle ON/OFF, Rev = momentary press-and-hold!)
  private garageRunning = false;
  private garageRevHeld = false;
  private garagePulseUntil = 0;
  private garageCrankUntil = 0;
  private garageFlareUntil = 0;
  private garageRpm = 0;
  private garageThr = 0;
  private garageLimCutUntil = 0;
  private garageFlame = 0;
  private garageWasHighRpm = false;
  private _muted = false;
  /** Low-power mobile/potato audio mode: skips heavy stereo FFT ConvolverNode reverb to save phone ARM CPU. */
  lowPower = false;

  // Multi-zone physical combustion & FX audio stems (`/assets/audio/<id>.ogg`) with graceful synth fallback
  private stemBuffers = new Map<string, AudioBuffer>();
  private stemAttempted = new Set<string>();
  private stemLowSrc: AudioBufferSourceNode | null = null;
  private stemLowId: string | null = null;
  private stemHighSrc: AudioBufferSourceNode | null = null;
  private stemHighId: string | null = null;
  private stemLowGain: GainNode | null = null;
  private stemHighGain: GainNode | null = null;
  private stemToneFilter: BiquadFilterNode | null = null;
  private stemShaper: WaveShaperNode | null = null;
  private stemEngMaster: GainNode | null = null;
  private stemGearSrc: AudioBufferSourceNode | null = null;
  private stemGearGain: GainNode | null = null;
  private stemDryTyreSrc: AudioBufferSourceNode | null = null;
  private stemDryTyreGain: GainNode | null = null;
  private stemWetSpraySrc: AudioBufferSourceNode | null = null;
  private stemWetSprayGain: GainNode | null = null;
  private stemKerbSrc: AudioBufferSourceNode | null = null;
  private stemKerbGain: GainNode | null = null;

  get muted(): boolean { return this._muted; }
  set muted(v: boolean) {
    this._muted = v;
    if (v) this.silenceAll();
  }

  /** Immediately ramp every continuous driving & engine sound layer to 0 (called when returning to menu or pausing). */
  silenceAll() {
    this.garageRunning = false;
    this.garageRevHeld = false;
    this.garagePulseUntil = 0;
    this.garageCrankUntil = 0;
    this.garageFlareUntil = 0;
    this.garageRpm = 0;
    this.garageThr = 0;
    this.garageFlame = 0;
    this.boostSpool = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const zero = (g?: GainNode | null) => {
      if (!g) return;
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.02);
    };
    zero(this.eng?.g);
    zero(this.eng?.boostGain);
    zero(this.eng?.gearGain);
    zero(this.tyre?.g);
    zero(this.roadRoll?.g);
    zero(this.cavity?.g);
    zero(this.wind?.g);
    zero(this.reverbSend);
    zero(this.srn?.g);
    zero(this.stemLowGain);
    zero(this.stemHighGain);
    zero(this.stemEngMaster);
    zero(this.stemGearGain);
    zero(this.stemDryTyreGain);
    zero(this.stemWetSprayGain);
    zero(this.stemKerbGain);
  }

  /** Silence only road/tyre/wind/siren/gearbox layers (used before starting the Garage stationary ignition). */
  private silenceDrivingLayers() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const zero = (g?: GainNode | null) => {
      if (!g) return;
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.02);
    };
    zero(this.eng?.gearGain);
    zero(this.tyre?.g);
    zero(this.roadRoll?.g);
    zero(this.cavity?.g);
    zero(this.wind?.g);
    zero(this.srn?.g);
    zero(this.stemGearGain);
    zero(this.stemDryTyreGain);
    zero(this.stemWetSprayGain);
    zero(this.stemKerbGain);
  }

  /** Apply authentic engine acoustic architecture (factory stock engine OR installed engine swap + turbo kit). */
  setCarProfile(carId: string, swapVoice?: EngineVoiceId | null, hasAftermarketTurbo = false) {
    this.voiceId = swapVoice ?? stockEngineOfCar(carId).voice;
    this.extraTurbo = hasAftermarketTurbo;
    this.applyVoice();
  }

  private applyVoice() {
    const e = this.eng;
    const ctx = this.ctx;
    if (!e || !ctx) return;
    const v = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const t = ctx.currentTime;
    const w = this.waves[v.waveKey];
    if (w) {
      e.oMain.setPeriodicWave(w);
      e.oBank.setPeriodicWave(w);
    }
    e.gMain.gain.setTargetAtTime(v.mainGain, t, 0.04);
    e.gSub.gain.setTargetAtTime(v.subGain, t, 0.04);
    e.gBank.gain.setTargetAtTime(v.bankGain, t, 0.04);
    e.gHarm.gain.setTargetAtTime(v.harmGain, t, 0.04);
    e.combDelayL.delayTime.setTargetAtTime(v.combL, t, 0.04);
    e.combDelayR.delayTime.setTargetAtTime(v.combR, t, 0.04);
    e.formant1.frequency.setTargetAtTime(v.f1[0], t, 0.04); e.formant1.Q.value = v.f1[1]; e.formant1.gain.value = v.f1[2];
    e.formant2.frequency.setTargetAtTime(v.f2[0], t, 0.04); e.formant2.Q.value = v.f2[1]; e.formant2.gain.value = v.f2[2];
    e.formant3.frequency.setTargetAtTime(v.f3[0], t, 0.04); e.formant3.Q.value = v.f3[1]; e.formant3.gain.value = v.f3[2];
    e.shaper.curve = distortion(v.drive);
    if (this.stemShaper) this.stemShaper.curve = distortion(1.0 + v.drive * 0.12);
    this.preloadVoiceStems(this.voiceId);
    this.preloadFxStems();
    this.syncEngineStemSources();
  }

  get garageEngineOn(): boolean { return this.garageRunning; }
  get garageFlameLevel(): number { return this.garageFlame; }
  get revvingInGarage(): boolean { return this.garageRevHeld || performance.now() < this.garagePulseUntil || performance.now() < this.revUntil; }

  /** Toggle Garage Ignition ON/OFF using the car's REAL multi-harmonic engine synthesizer. Returns new ON/OFF state. */
  toggleGarageIgnition(): boolean {
    this.unlock();
    const ctx = this.ctx;
    if (this.garageRunning) {
      // Shut engine off cleanly with ignition-cut relay click
      this.garageRunning = false;
      this.garageRevHeld = false;
      this.garagePulseUntil = 0;
      this.garageCrankUntil = 0;
      this.garageFlareUntil = 0;
      this.garageFlame = 0;
      if (ctx && this.out) this.tone(ctx.currentTime, 0.04, 180, 90, 'triangle', 0.08);
      return false;
    }
    this.startGarageEngine();
    return true;
  }

  private startGarageEngine() {
    this.unlock();
    this._muted = false;
    this.silenceDrivingLayers();
    this.applyVoice();
    const ctx = this.ctx;
    const now = performance.now();
    this.garageRunning = true;
    this.garageCrankUntil = now + 380;
    this.garageFlareUntil = now + 980;
    this.garageRpm = 320;
    this.garageThr = 0;
    this.garageWasHighRpm = false;
    if (ctx && this.out && !this.muted) {
      const t = ctx.currentTime;
      // Crisp starter-motor solenoid + 4 compression cranks before the real engine catches
      for (let i = 0; i < 4; i++) {
        this.tone(t + i * 0.095, 0.072, 118, 152, 'sawtooth', 0.11);
        this.burst(t + i * 0.095, 0.045, 'bandpass', 620, 2.2, 0.06);
      }
      // Cold-start exhaust catch bark at 0.38s
      const v = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
      this.burst(t + 0.37, 0.18, 'bandpass', v.f2[0], 1.5, 0.24);
    }
  }

  /** Momentary press-and-hold Garage Rev control (true on press, false on release — NEVER toggled). */
  setGarageRev(held: boolean): boolean {
    if (held) {
      this.unlock();
      this.applyVoice();
      if (!this.garageRunning) this.startGarageEngine();
      this.garageRevHeld = true;
    } else {
      const wasHeld = this.garageRevHeld;
      this.garageRevHeld = false;
      if (wasHeld && this.garageRpm > 3000) {
        this.garageWasHighRpm = true;
        this.triggerGarageLiftOffEffects();
      }
    }
    return this.garageRunning;
  }

  /** Brief automatic rev blip when installing a new Engine Swap so you immediately hear its real voice. */
  pulseGarageRev(ms = 680) {
    this.unlock();
    this._muted = false;
    this.silenceDrivingLayers();
    this.applyVoice();
    if (!this.garageRunning) {
      this.garageRunning = true;
      this.garageCrankUntil = 0;
      this.garageFlareUntil = 0;
      this.garageRpm = 1050;
    }
    const now = performance.now();
    this.garagePulseUntil = Math.max(this.garagePulseUntil, now + ms);
    this.revUntil = Math.max(this.revUntil, now + ms + 450);
  }

  /** Silence and reset the Garage engine cleanly when exiting Garage into menus or driving. */
  stopGarageEngine() {
    this.garageRunning = false;
    this.garageRevHeld = false;
    this.garagePulseUntil = 0;
    this.garageCrankUntil = 0;
    this.garageFlareUntil = 0;
    this.garageRpm = 0;
    this.garageThr = 0;
    this.garageFlame = 0;
    const e = this.eng, ctx = this.ctx;
    if (e && ctx) {
      const t = ctx.currentTime;
      e.g.gain.setTargetAtTime(0, t, 0.05);
      e.boostGain.gain.setTargetAtTime(0, t, 0.05);
      e.gearGain.gain.setTargetAtTime(0, t, 0.05);
      if (this.stemEngMaster) this.stemEngMaster.gain.setTargetAtTime(0, t, 0.05);
      if (this.stemLowGain) this.stemLowGain.gain.setTargetAtTime(0, t, 0.05);
      if (this.stemHighGain) this.stemHighGain.gain.setTargetAtTime(0, t, 0.05);
    }
  }

  /** Turbo BOV flutter + overrun exhaust pops when releasing the Rev pedal from high RPM in Garage. */
  private triggerGarageLiftOffEffects() {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running' || this.muted) return;
    const t = ctx.currentTime;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const intensity = Math.min(1, Math.max(0.25, (this.garageRpm - 2800) / Math.max(3000, vSpec.revRpm - 2800)));
    const boostMode = vSpec.boost !== 'none' ? vSpec.boost : (this.extraTurbo ? 'turbo' : 'none');
    if (boostMode === 'turbo' && this.boostSpool > 0.2 && t > this.lastBovAt + 0.28) {
      this.lastBovAt = t;
      this.triggerTurboBov(t, intensity);
    }
    this.exhaustPop(t + 0.03, intensity);
    this.garageFlame = Math.max(this.garageFlame, 0.75 + 0.45 * intensity);
  }

  /**
   * Per-frame real engine synthesizer update while in the Garage showroom.
   * Drives the EXACT same dual-zone physical combustion stems + multi-harmonic PeriodicWave synth as driving!
   */
  updateGarage(dt: number) {
    const e = this.eng, ctx = this.ctx;
    if (!e || !ctx || ctx.state !== 'running') {
      this.garageFlame = Math.max(0, this.garageFlame - dt * 5);
      return;
    }
    const now = performance.now();
    const t = ctx.currentTime;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const idleRpm = this.voiceId === 'rotary_4' ? 1150 : vSpec.firingsPerRev >= 5 ? 980 : 860;
    const redline = vSpec.revRpm;

    // Decay exhaust flame smoothly between pops/limiter cuts
    this.garageFlame = Math.max(0, this.garageFlame - dt * 4.2);

    // Silence road/tyre/wind/gear noise (both synth & stem layers) in the static garage
    if (this.tyre) this.tyre.g.gain.setTargetAtTime(0, t, 0.05);
    if (this.wind) this.wind.g.gain.setTargetAtTime(0, t, 0.05);
    if (this.roadRoll) this.roadRoll.g.gain.setTargetAtTime(0, t, 0.05);
    if (this.cavity) this.cavity.g.gain.setTargetAtTime(0, t, 0.05);
    e.gearGain.gain.setTargetAtTime(0, t, 0.05);
    if (this.stemGearGain) this.stemGearGain.gain.setTargetAtTime(0, t, 0.05);
    if (this.stemDryTyreGain) this.stemDryTyreGain.gain.setTargetAtTime(0, t, 0.05);
    if (this.stemWetSprayGain) this.stemWetSprayGain.gain.setTargetAtTime(0, t, 0.05);
    if (this.stemKerbGain) this.stemKerbGain.gain.setTargetAtTime(0, t, 0.05);

    if (!this.garageRunning) {
      // Smooth engine spin-down when ignition is switched OFF
      this.garageRpm = Math.max(0, this.garageRpm - dt * 2800);
      this.garageThr = Math.max(0, this.garageThr - dt * 8);
      if (this.garageRpm < 180) {
        e.g.gain.setTargetAtTime(0, t, 0.05);
        e.boostGain.gain.setTargetAtTime(0, t, 0.05);
        if (this.stemEngMaster) this.stemEngMaster.gain.setTargetAtTime(0, t, 0.05);
        return;
      }
    } else if (now < this.garageCrankUntil) {
      // Cranking starter before ignition catches
      this.garageRpm = 320 + Math.sin(now * 0.06) * 45;
      this.garageThr = 0.08;
      e.g.gain.setTargetAtTime(0, t, 0.03);
      e.boostGain.gain.setTargetAtTime(0, t, 0.03);
      if (this.stemEngMaster) this.stemEngMaster.gain.setTargetAtTime(0, t, 0.03);
      return;
    } else {
      const pulsing = now < this.garagePulseUntil;
      const revPressed = this.garageRevHeld || pulsing;
      const flaring = now < this.garageFlareUntil && !revPressed;

      if (flaring && this.garageRpm < 1600) {
        // Cold-start initial bark flare
        this.garageRpm = 2450;
        this.garageThr = 0.42;
        this.garageFlame = Math.max(this.garageFlame, 0.55);
      }

      const targetThr = revPressed ? 1.0 : flaring ? 0.16 : 0.0;
      this.garageThr += (targetThr - this.garageThr) * Math.min(1, dt * (revPressed ? 18 : 10));

      // Realistic unloaded flywheel RPM response (exotics & rotaries spin up faster than heavy V8s)
      const accelRate = this.voiceId === 'rotary_4' || vSpec.firingsPerRev >= 5 ? 9200 : 7600;
      const decelRate = 4300;
      const inLimCut = now < this.garageLimCutUntil;

      if (revPressed && !inLimCut) {
        this.garageRpm += accelRate * dt;
        if (this.garageRpm >= redline) {
          this.garageRpm = redline - 240;
          this.garageLimCutUntil = now + 72; // authentic crisp fuel/ignition rev-limiter bounce!
          if (!this.muted) this.shiftBark(t, 0.85);
          this.garageFlame = Math.max(this.garageFlame, 1.15);
          this.garageWasHighRpm = true;
        }
      } else {
        const floorRpm = flaring ? idleRpm + 650 : idleRpm;
        const dropRate = inLimCut ? 5200 : decelRate;
        if (this.garageRpm > floorRpm) {
          this.garageRpm = Math.max(floorRpm, this.garageRpm - dropRate * dt);
        } else {
          this.garageRpm += (floorRpm - this.garageRpm) * Math.min(1, dt * 8);
        }
      }

      // Overrun crackle pops & exhaust flames while decelerating from high RPM after letting go of Rev
      if (!revPressed && this.garageWasHighRpm) {
        if (this.garageRpm > 2800 && !this.muted && t > this.nextCrackleAt) {
          const inten = Math.min(1, (this.garageRpm - 2500) / Math.max(3000, redline - 2500));
          this.exhaustPop(t, inten);
          this.garageFlame = Math.max(this.garageFlame, 0.55 + 0.55 * inten);
          this.nextCrackleAt = t + 0.055 + Math.random() * 0.11;
        } else if (this.garageRpm <= 2200) {
          this.garageWasHighRpm = false;
        }
      }
      // Subtle lift-off pop right as a swap pulse ends
      if (pulsing && now + dt * 1000 >= this.garagePulseUntil && this.garageRpm > 3200) {
        this.garageWasHighRpm = true;
        this.triggerGarageLiftOffEffects();
      }
    }

    // Drive the REAL multi-harmonic engine synthesizer + dual-zone combustion stems with `garageRpm` & `garageThr`
    const rpm = Math.max(450, this.garageRpm);
    const thr = this.garageThr;
    const f = Math.max(20, (rpm / 60) * vSpec.firingsPerRev);
    const tc = 0.018;
    const lopeAmt = rpm < 1800 ? vSpec.lopeDepth : vSpec.lopeDepth * 0.35;
    const lope = 1 + lopeAmt * Math.sin(t * vSpec.lopeHz);

    e.oMain.frequency.setTargetAtTime(f * lope, t, tc);
    e.oSub.frequency.setTargetAtTime(f * vSpec.subRatio * lope, t, tc);
    e.oBank.frequency.setTargetAtTime(f * vSpec.bankRatio * (2 - lope), t, tc);
    e.oHarm.frequency.setTargetAtTime(f * vSpec.harmRatio, t, tc);

    const rpmNorm = Math.min(1, (rpm - 650) / Math.max(5500, redline - 650));
    const load = 0.16 + 0.84 * thr;
    e.exhaustFilter.frequency.setTargetAtTime(160 + f * 1.9, t, tc);
    e.exhaustGain.gain.setTargetAtTime(0.18 + 0.42 * load + 0.22 * rpmNorm, t, tc);

    e.intakeFilter.frequency.setTargetAtTime(280 + f * 2.8, t, tc);
    e.intakeGain.gain.setTargetAtTime(thr * thr * (0.28 + 0.36 * rpmNorm), t, tc);

    const spinFade = this.garageRunning ? 1 : Math.min(1, rpm / Math.max(1, idleRpm));
    const master = this.muted ? 0 : (0.15 + 0.25 * load + 0.11 * rpmNorm) * spinFade;
    const stemsActive = this.updateEngineStems(rpm, thr, rpmNorm, master, lope, tc);

    // Real supercharger whine OR turbo spool while revving in Garage
    const boostMode = vSpec.boost !== 'none' ? vSpec.boost : (this.extraTurbo ? 'turbo' : 'none');
    if (boostMode === 'supercharger' && !this.muted && this.garageRunning) {
      const scFreq = 920 + rpm * 0.31;
      const scDuck = stemsActive && this.voiceId === 'v8_supercharged' ? 0.35 : 1.0;
      e.oBoost.frequency.setTargetAtTime(scFreq, t, 0.02);
      e.boostFilter.frequency.setTargetAtTime(scFreq, t, 0.03);
      e.boostGain.gain.setTargetAtTime((0.025 + 0.105 * thr) * (0.35 + 0.65 * rpmNorm) * scDuck, t, 0.03);
    } else if (boostMode === 'turbo' && !this.muted && this.garageRunning) {
      const targetSpool = Math.max(0, (rpmNorm - 0.15) * 1.25) * thr;
      this.boostSpool += (targetSpool - this.boostSpool) * 0.16;
      const tFreq = 2200 + this.boostSpool * 4400;
      e.oBoost.frequency.setTargetAtTime(tFreq, t, 0.035);
      e.boostFilter.frequency.setTargetAtTime(tFreq, t, 0.035);
      e.boostGain.gain.setTargetAtTime(this.boostSpool * 0.052, t, 0.035);
    } else {
      this.boostSpool *= 0.85;
      e.boostGain.gain.setTargetAtTime(0, t, 0.05);
    }

    const topBright = vSpec.firingsPerRev >= 5 || this.voiceId === 'rotary_4' || this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' ? 2600 : 1800;
    const cutoff = 320 + f * (2.2 + 5.8 * load) + rpmNorm * topBright * thr;
    e.lp.frequency.setTargetAtTime(cutoff, t, tc);

    e.g.gain.setTargetAtTime(stemsActive ? master * 0.15 : master, t, 0.035);
    // Warm enclosed showroom reverb so the garage echoes like a real concrete bay
    if (this.reverbSend) {
      this.reverbSend.gain.setTargetAtTime(this.muted ? 0 : 0.36, t, 0.08);
    }
  }

  /**
   * Police siren while a pursuit is live: a wailing tone (LFO on pitch) at a level set by proximity. Silent and free
   * when there is no chase (the nodes are created once, on the first call after the audio context unlocks).
   */
  siren(level: number) {
    if (!this.ctx || !this.out) return;
    const t = this.ctx.currentTime;
    if (level <= 0.01 || this.muted) {
      if (this.srn) this.srn.g.gain.setTargetAtTime(0, t, 0.12);
      return;
    }
    if (!this.srn) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 760;
      const lfo = this.ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.55;          // one wail every ~1.8 s
      const lg = this.ctx.createGain();
      lg.gain.value = 230;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      lfo.connect(lg).connect(o.frequency);
      o.connect(g).connect(this.out);
      o.start(); lfo.start();
      this.srn = { o, lfo, lg, g };
    }
    this.srn.g.gain.setTargetAtTime(0.025 + level * 0.11, t, 0.15);
  }

  unlock() {
    if (!this.ctx) this.prepare();
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  prepare() {
    if (this.ctx) return;
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    let ctx: AudioContext;
    try { ctx = new AudioCtor({ latencyHint: 'interactive' }); } catch { ctx = new AudioCtor(); }
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    this.out.connect(comp).connect(ctx.destination);

    // 3-second pink-ish + white noise buffer for combustion, wind, tyre scrub, and debris
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029;
      b1 = 0.985 * b1 + w * 0.032;
      b2 = 0.950 * b2 + w * 0.048;
      d[i] = Math.max(-1, Math.min(1, (w * 0.55 + (b0 + b1 + b2) * 0.45)));
    }
    this.buildEngine();
    this.tyre = this.buildTyreSynth();
    this.wind = this.loopNoise('lowpass', 420, 0.7);
  }

  private loopNoise(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.out!);
    src.start();
    return { f, g };
  }

  private buildTyreSynth() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 980;
    f.Q.value = 5.5;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'peaking';
    f2.frequency.value = 1850;
    f2.Q.value = 4.0;
    f2.gain.value = 8;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(f2).connect(g).connect(this.out!);
    src.start();
    return { f, f2, g };
  }

  private buildEngine() {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = 0;

    // Custom Fourier PeriodicWaves for each real engine architecture's exhaust blowdown harmonics
    const nHarm = 28;
    const mkWave = (fn: (k: number) => [number, number]) => {
      const re = new Float32Array(nHarm);
      const im = new Float32Array(nHarm);
      for (let k = 1; k < nHarm; k++) {
        const [r, i] = fn(k);
        re[k] = r; im[k] = i;
      }
      return ctx.createPeriodicWave(re, im, { disableNormalization: false });
    };
    this.waves.crossplane = mkWave((k) => {
      const env = Math.exp(-k * 0.12) * (1 + 0.35 * Math.sin(k * 1.1));
      return [env * Math.cos(k * 0.42) * 0.6, env * Math.sin(k * 0.42 + 0.3)];
    });
    this.waves.flatplane = mkWave((k) => {
      const env = Math.exp(-k * 0.085) * (k % 2 === 0 ? 1.15 : 0.72);
      return [env * 0.45, env * 0.9];
    });
    this.waves.v12 = mkWave((k) => {
      // Silky 12-cyl harmonic stack: strong 1, 2, 3, 4, 6th orders -> soaring soprano shriek
      const boost = (k === 1 || k === 2 || k === 3 || k === 4 || k === 6) ? 1.35 : 0.55;
      const env = Math.exp(-k * 0.075) * boost;
      return [env * 0.3, env * 0.95];
    });
    this.waves.v10 = mkWave((k) => {
      // Piercing 72° odd-fire V10: strong odd + 5th harmonic prominence -> iconic F1/LFA howl
      const boost = (k % 2 === 1 ? 1.25 : 0.78) * (k === 5 || k === 3 ? 1.3 : 1.0);
      const env = Math.exp(-k * 0.082) * boost;
      return [env * 0.42, env * 0.92];
    });
    this.waves.v6 = mkWave((k) => {
      const boost = (k % 3 === 0 ? 1.3 : 0.85);
      const env = Math.exp(-k * 0.105) * boost;
      return [env * 0.52, env * 0.84];
    });
    this.waves.flat6 = mkWave((k) => {
      // Horizontally-opposed boxer rasp: crisp metallic 3rd, 5th, 6th, 9th overtones
      const boost = (k % 3 === 0 || k === 5 || k === 7) ? 1.35 : 0.65;
      const env = Math.exp(-k * 0.078) * boost;
      return [env * 0.55 * (k % 2 ? 1 : -1), env * 0.88];
    });
    this.waves.flat8 = mkWave((k) => {
      const boost = (k % 2 === 0 || k === 3 || k === 5) ? 1.28 : 0.6;
      const env = Math.exp(-k * 0.076) * boost;
      return [env * 0.46, env * 0.92];
    });
    this.waves.i6 = mkWave((k) => {
      // Straight-six pure harmonic symmetry: ultra-smooth singing 1st, 2nd, 3rd, 6th
      const boost = (k === 1 || k === 2 || k === 3 || k === 6) ? 1.4 : 0.5;
      const env = Math.exp(-k * 0.095) * boost;
      return [env * 0.25, env * 0.96];
    });
    this.waves.rotary = mkWave((k) => {
      // 4-rotor 26B peripheral-port saw/buzz siren: rich upper harmonics all the way to k=24
      const env = Math.exp(-k * 0.055) * (1 + 0.25 * (k % 2 === 0 ? 1 : -0.4));
      return [env * 0.55, env * 0.95];
    });

    // Sub-harmonic uneven bank cadence wave (deep V8 burble / boxer rumble / rotary idle brap)
    const subReal = new Float32Array(nHarm);
    const subImag = new Float32Array(nHarm);
    const weights = [0, 0.9, 1.0, 0.75, 0.6, 0.85, 0.45, 0.35, 0.5, 0.25, 0.2, 0.15];
    for (let k = 1; k < weights.length; k++) {
      subImag[k] = weights[k];
      subReal[k] = weights[k] * 0.35 * (k % 2 === 1 ? 1 : -1);
    }
    const subWave = ctx.createPeriodicWave(subReal, subImag, { disableNormalization: false });

    const preMix = ctx.createGain();
    preMix.gain.value = 0.42;

    const mkOsc = (wave: PeriodicWave, level: number) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      const og = ctx.createGain();
      og.gain.value = level;
      o.connect(og).connect(preMix);
      o.start();
      return { o, og };
    };

    const mMain = mkOsc(this.waves.crossplane, 0.76);
    const mSub = mkOsc(subWave, 0.74);
    const mBank = mkOsc(this.waves.crossplane, 0.38);
    const oHarm = ctx.createOscillator();
    oHarm.type = 'triangle';
    const gHarm = ctx.createGain();
    gHarm.gain.value = 0.14;
    oHarm.connect(gHarm).connect(preMix);
    oHarm.start();

    const oMain = mMain.o, gMain = mMain.og;
    const oSub = mSub.o, gSub = mSub.og;
    const oBank = mBank.o, gBank = mBank.og;

    // Dedicated forced-induction synthesizer: helical Supercharger whine OR high-freq Turbocharger spool whistle
    const oBoost = ctx.createOscillator();
    oBoost.type = 'sine';
    const boostFilter = ctx.createBiquadFilter();
    boostFilter.type = 'bandpass';
    boostFilter.frequency.value = 2400;
    boostFilter.Q.value = 3.5;
    const boostGain = ctx.createGain();
    boostGain.gain.value = 0;
    oBoost.connect(boostFilter).connect(boostGain).connect(g);
    oBoost.start();

    // Dual-exhaust pipe waveguide comb filter (left & right exhaust banks meeting at X-pipe)
    const combDelayL = ctx.createDelay(0.02);
    combDelayL.delayTime.value = 0.0024;
    const combDelayR = ctx.createDelay(0.02);
    combDelayR.delayTime.value = 0.0041;
    const combMix = ctx.createGain();
    combMix.gain.value = 0.75;
    preMix.connect(combDelayL).connect(combMix);
    preMix.connect(combDelayR).connect(combMix);
    preMix.connect(combMix);

    // Exhaust pulse turbulent gas flow noise
    const exNoise = ctx.createBufferSource();
    exNoise.buffer = this.noise;
    exNoise.loop = true;
    const exhaustFilter = ctx.createBiquadFilter();
    exhaustFilter.type = 'bandpass';
    exhaustFilter.Q.value = 1.6;
    const exhaustGain = ctx.createGain();
    exhaustGain.gain.value = 0;
    exNoise.connect(exhaustFilter).connect(exhaustGain).connect(combMix);
    exNoise.start();

    // Intake manifold induction roar (opens sharply above 50% throttle)
    const inNoise = ctx.createBufferSource();
    inNoise.buffer = this.noise;
    inNoise.loop = true;
    const intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.Q.value = 2.4;
    const intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    inNoise.connect(intakeFilter).connect(intakeGain).connect(combMix);
    inNoise.start();

    // Acoustic exhaust & engine-bay formant filters (gives chesty real-car resonance instead of raw synth buzz)
    const formant1 = ctx.createBiquadFilter();
    formant1.type = 'peaking';
    formant1.frequency.value = 118;  // Deep exhaust muffler resonance
    formant1.Q.value = 2.2;
    formant1.gain.value = 7.5;

    const formant2 = ctx.createBiquadFilter();
    formant2.type = 'peaking';
    formant2.frequency.value = 340;  // V8 mid-range chest growl
    formant2.Q.value = 1.8;
    formant2.gain.value = 5.0;

    const formant3 = ctx.createBiquadFilter();
    formant3.type = 'peaking';
    formant3.frequency.value = 1280; // High-RPM header metallic rasp
    formant3.Q.value = 2.5;
    formant3.gain.value = 4.5;

    const shaper = ctx.createWaveShaper();
    shaper.curve = distortion(4.2);
    shaper.oversample = '2x';

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.4;

    // Straight-cut GT sequential transmission whine (audible inside/behind race cars as speed climbs)
    const oGear = ctx.createOscillator();
    oGear.type = 'triangle';
    const gearFilter = ctx.createBiquadFilter();
    gearFilter.type = 'bandpass';
    gearFilter.frequency.value = 1400;
    gearFilter.Q.value = 4.5;
    const gearGain = ctx.createGain();
    gearGain.gain.value = 0;
    oGear.connect(gearFilter).connect(gearGain).connect(g);
    oGear.start();

    // Environmental wall/tunnel acoustic reverb convolver (skipped on low-power phones to save ARM FFT CPU)
    if (!this.lowPower) {
      const irLen = Math.floor(ctx.sampleRate * 0.9);
      const irBuf = ctx.createBuffer(2, irLen, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = irBuf.getChannelData(ch);
        for (let i = 0; i < irLen; i++) {
          const dec = Math.pow(1 - i / irLen, 2.6);
          data[i] = (Math.random() * 2 - 1) * dec * (i < 900 ? 0.85 : 0.45);
        }
      }
      const conv = ctx.createConvolver();
      conv.buffer = irBuf;
      const revSend = ctx.createGain();
      revSend.gain.value = 0;
      revSend.connect(conv).connect(this.out!);
      this.reverbSend = revSend;
    }

    // Surface-specific rolling tire noise (wet asphalt spray hiss vs dry hum vs gravel crunch)
    const rSrc = ctx.createBufferSource();
    rSrc.buffer = this.noise;
    rSrc.loop = true;
    const rFilt = ctx.createBiquadFilter();
    rFilt.type = 'bandpass';
    rFilt.frequency.value = 520;
    rFilt.Q.value = 0.9;
    const rGain = ctx.createGain();
    rGain.gain.value = 0;
    rSrc.connect(rFilt).connect(rGain).connect(this.out!);
    rSrc.start();
    this.roadRoll = { f: rFilt, g: rGain };

    // Simcenter Tire 2606 Toroidal Air-Cavity (~225 Hz Doppler-split doublet) resonant hollow boom on curbs/bumps
    const cSrc = ctx.createBufferSource();
    cSrc.buffer = this.noise;
    cSrc.loop = true;
    const cLo = ctx.createBiquadFilter();
    cLo.type = 'bandpass'; cLo.frequency.value = 216; cLo.Q.value = 14;
    const cHi = ctx.createBiquadFilter();
    cHi.type = 'bandpass'; cHi.frequency.value = 234; cHi.Q.value = 14;
    const cGain = ctx.createGain();
    cGain.gain.value = 0;
    cSrc.connect(cLo).connect(cGain);
    cSrc.connect(cHi).connect(cGain);
    cGain.connect(this.out!);
    cSrc.start();
    this.cavity = { fLo: cLo, fHi: cHi, g: cGain };

    combMix
      .connect(shaper)
      .connect(formant1)
      .connect(formant2)
      .connect(formant3)
      .connect(lp)
      .connect(g)
      .connect(this.out!);
    if (this.reverbSend) g.connect(this.reverbSend);

    this.startAdaptiveMusic();

    this.eng = {
      o1: oMain, oMain, oSub, oBank, oHarm, gMain, gSub, gBank, gHarm,
      oBoost, boostFilter, boostGain,
      oGear, gearGain,
      combDelayL, combDelayR,
      formant1, formant2, formant3,
      intakeFilter, intakeGain, exhaustFilter, exhaustGain,
      lp, shaper, g,
    };
    this.buildStemGraph();
    this.applyVoice();
  }

  private buildStemGraph() {
    const ctx = this.ctx;
    if (!ctx || !this.out) return;

    // Dual-zone engine combustion stem bus:
    // (lowSrc -> stemLowGain) + (highSrc -> stemHighGain) -> stemToneFilter -> stemShaper -> stemEngMaster -> out (+ reverbSend)
    const stemLowGain = ctx.createGain();
    stemLowGain.gain.value = 0;
    const stemHighGain = ctx.createGain();
    stemHighGain.gain.value = 0;

    const stemToneFilter = ctx.createBiquadFilter();
    stemToneFilter.type = 'lowpass';
    stemToneFilter.frequency.value = 1800;
    stemToneFilter.Q.value = 0.85;

    const stemShaper = ctx.createWaveShaper();
    stemShaper.curve = distortion(1.45);
    stemShaper.oversample = '2x';

    const stemEngMaster = ctx.createGain();
    stemEngMaster.gain.value = 0;

    stemLowGain.connect(stemToneFilter);
    stemHighGain.connect(stemToneFilter);
    stemToneFilter.connect(stemShaper).connect(stemEngMaster).connect(this.out);
    if (this.reverbSend) stemEngMaster.connect(this.reverbSend);

    this.stemLowGain = stemLowGain;
    this.stemHighGain = stemHighGain;
    this.stemToneFilter = stemToneFilter;
    this.stemShaper = stemShaper;
    this.stemEngMaster = stemEngMaster;

    // Looping FX stem gain buses (zeroed until driving update modulates them)
    const mkFxBus = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out!);
      return g;
    };
    this.stemGearGain = mkFxBus();
    this.stemDryTyreGain = mkFxBus();
    this.stemWetSprayGain = mkFxBus();
    this.stemKerbGain = mkFxBus();
  }

  private preloadVoiceStems(voice: EngineVoiceId) {
    const zones = ENGINE_STEM_ZONES[voice] ?? ENGINE_STEM_ZONES.v8_crossplane;
    void this.loadStem(zones.low[0]);
    void this.loadStem(zones.high[0]);
  }

  private preloadFxStems() {
    for (const id of FX_LOOP_STEMS) void this.loadStem(id);
    for (const id of FX_ONESHOT_STEMS) void this.loadStem(id);
  }

  /** Non-blocking fetch + decode for `/assets/audio/<id>.ogg` with one-time caching and silent fallback. */
  private async loadStem(id: string): Promise<void> {
    if (this.stemBuffers.has(id) || this.stemAttempted.has(id)) return;
    const ctx = this.ctx;
    if (!ctx || typeof fetch !== 'function') return;
    this.stemAttempted.add(id);
    try {
      const res = await fetch(`/assets/audio/${id}.ogg`);
      if (!res.ok) return;
      const ab = await res.arrayBuffer();
      if (!this.ctx) return;
      const buf = await this.ctx.decodeAudioData(ab);
      this.stemBuffers.set(id, buf);
      this.onStemDecoded(id, buf);
    } catch {
      // Silently fall back to procedural synth in offline / headless / missing-asset environments
    }
  }

  private onStemDecoded(id: string, buf: AudioBuffer) {
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    if (id === zones.low[0] || id === zones.high[0]) {
      this.syncEngineStemSources();
    }
    if (id === 'gear_whine_straightcut') this.attachFxLoop('gear', buf);
    else if (id === 'tyre_scrub_dry') this.attachFxLoop('dryTyre', buf);
    else if (id === 'tyre_spray_wet') this.attachFxLoop('wetSpray', buf);
    else if (id === 'kerb_rumble_strip') this.attachFxLoop('kerb', buf);
  }

  private attachFxLoop(kind: 'gear' | 'dryTyre' | 'wetSpray' | 'kerb', buf: AudioBuffer) {
    const ctx = this.ctx;
    if (!ctx) return;
    const startLoop = (dest: GainNode | null) => {
      if (!dest) return null;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(dest);
      src.start();
      return src;
    };
    if (kind === 'gear' && !this.stemGearSrc) this.stemGearSrc = startLoop(this.stemGearGain);
    else if (kind === 'dryTyre' && !this.stemDryTyreSrc) this.stemDryTyreSrc = startLoop(this.stemDryTyreGain);
    else if (kind === 'wetSpray' && !this.stemWetSpraySrc) this.stemWetSpraySrc = startLoop(this.stemWetSprayGain);
    else if (kind === 'kerb' && !this.stemKerbSrc) this.stemKerbSrc = startLoop(this.stemKerbGain);
  }

  private syncEngineStemSources() {
    const ctx = this.ctx;
    if (!ctx || !this.stemLowGain || !this.stemHighGain) return;
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    const [lowId, lowRef] = zones.low;
    const [highId, highRef] = zones.high;
    const curRpm = Math.max(650, this.garageRunning ? this.garageRpm : this.lastRpm);

    if (this.stemLowId !== lowId || (!this.stemLowSrc && this.stemBuffers.has(lowId))) {
      if (this.stemLowSrc) {
        try { this.stemLowSrc.stop(); this.stemLowSrc.disconnect(); } catch {}
        this.stemLowSrc = null;
        this.stemLowId = null;
      }
      const buf = this.stemBuffers.get(lowId);
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = clamp(curRpm / lowRef, 0.42, 2.35);
        src.connect(this.stemLowGain);
        src.start();
        this.stemLowSrc = src;
        this.stemLowId = lowId;
      }
    }

    if (this.stemHighId !== highId || (!this.stemHighSrc && this.stemBuffers.has(highId))) {
      if (this.stemHighSrc) {
        try { this.stemHighSrc.stop(); this.stemHighSrc.disconnect(); } catch {}
        this.stemHighSrc = null;
        this.stemHighId = null;
      }
      const buf = this.stemBuffers.get(highId);
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = clamp(curRpm / highRef, 0.42, 2.35);
        src.connect(this.stemHighGain);
        src.start();
        this.stemHighSrc = src;
        this.stemHighId = highId;
      }
    }
  }

  private hasBothEngineStems(): boolean {
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    return this.stemLowSrc !== null && this.stemLowId === zones.low[0]
      && this.stemHighSrc !== null && this.stemHighId === zones.high[0];
  }

  /**
   * Drive dual-zone realistic combustion engine stems for both driving (`update`) and Garage (`updateGarage`).
   * Returns true when BOTH zones for the active voice are active so the caller can duck the raw oscillator synth to 15%.
   */
  private updateEngineStems(rpm: number, thr: number, rpmNorm: number, master: number, lope: number, tc: number): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.stemEngMaster || !this.stemLowGain || !this.stemHighGain || !this.stemToneFilter) {
      return false;
    }
    const t = ctx.currentTime;
    if (!this.hasBothEngineStems() || !this.stemLowSrc || !this.stemHighSrc) {
      this.stemEngMaster.gain.setTargetAtTime(0, t, 0.04);
      return false;
    }
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const lowRef = zones.low[1];
    const highRef = zones.high[1];

    // Smooth playbackRate tracking with subtle organic idle lope micro-variation
    const idleMicro = 1 + (lope - 1) * 0.35;
    const lowRate = clamp((rpm / lowRef) * idleMicro, 0.42, 2.35);
    const highRate = clamp((rpm / highRef) * (1 + (lope - 1) * 0.15), 0.42, 2.35);
    this.stemLowSrc.playbackRate.setTargetAtTime(lowRate, t, tc);
    this.stemHighSrc.playbackRate.setTargetAtTime(highRate, t, tc);

    // Equal-power cos/sin crossfade: 100% lowZone below ~2,100 RPM -> 100% highZone above ~4,600 RPM,
    // biased earlier under heavy throttle so WOT pulls roar aggressively
    const effRpm = rpm + thr * 450;
    const xfade = clamp((effRpm - 2100) / (4600 - 2100), 0, 1);
    const angle = xfade * Math.PI * 0.5;
    this.stemLowGain.gain.setTargetAtTime(Math.cos(angle), t, tc);
    this.stemHighGain.gain.setTargetAtTime(Math.sin(angle), t, tc);

    // Load-responsive exhaust tone filter opens smoothly with throttle & RPM
    const exoticBright =
      vSpec.firingsPerRev >= 5 || this.voiceId === 'rotary_4' || this.voiceId === 'flat6_na'
      || this.voiceId === 'flat8_na' || this.voiceId === 'v8_supercharged'
        ? 3200
        : 1800;
    const toneCutoff = 850 + thr * 3400 + rpmNorm * (2800 + exoticBright * (0.45 + 0.55 * thr));
    this.stemToneFilter.frequency.setTargetAtTime(Math.min(14000, toneCutoff), t, tc);

    this.stemEngMaster.gain.setTargetAtTime(Math.min(0.85, master * 1.18), t, 0.035);
    return true;
  }

  private playStemOneShot(id: string, at: number, gain: number, playbackRate: number, toReverb = false): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.out || this._muted) return false;
    const buf = this.stemBuffers.get(id);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = playbackRate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, gain), at);
    src.connect(g).connect(this.out);
    if (toReverb && this.reverbSend) g.connect(this.reverbSend);
    src.start(at);
    return true;
  }

  private triggerTurboBov(t: number, intensity = 1) {
    if (this._muted) return;
    const rate = 0.92 + Math.random() * 0.16;
    if (this.playStemOneShot('turbo_flutter_bov', t, 0.36 * intensity, rate, true)) {
      return;
    }
    for (let k = 0; k < 4; k++) {
      this.burst(t + k * 0.048, 0.042, 'bandpass', 3600 - k * 340, 5.2, 0.13 * intensity * (1 - k * 0.18));
    }
  }

  /** Every frame with the core's output. */
  update(out: Float64Array, speed: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.eng) return;
    const t = ctx.currentTime, tc = 0.024;
    const rpm = Math.max(650, out[OUT.rpm]);
    const thr = out[OUT.throttle];
    const gear = Math.round(out[OUT.gear]);
    const stalled = out[OUT.stalled] > 0.5;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const f = (rpm / 60) * vSpec.firingsPerRev;

    // Architecture-specific idle lope (chunky rotary peripheral-port brap & V8 cam lope vs smooth V12 / I6)
    const idleFactor = Math.max(0, 1 - (rpm - 650) / 1050);
    const lope = 1 + Math.sin(t * vSpec.lopeHz) * vSpec.lopeDepth * idleFactor + (Math.random() - 0.5) * 0.007;
    const e = this.eng;
    e.oMain.frequency.setTargetAtTime(f * lope, t, tc);
    e.oSub.frequency.setTargetAtTime(f * vSpec.subRatio * lope, t, tc);
    e.oBank.frequency.setTargetAtTime(f * vSpec.bankRatio * (2 - lope), t, tc);
    e.oHarm.frequency.setTargetAtTime(f * vSpec.harmRatio, t, tc);

    // Exhaust gas flow & intake induction roar
    const rpmNorm = Math.min(1, (rpm - 650) / Math.max(5500, vSpec.revRpm - 650));
    const load = 0.18 + 0.82 * thr;
    e.exhaustFilter.frequency.setTargetAtTime(160 + f * 1.9, t, tc);
    e.exhaustGain.gain.setTargetAtTime(0.18 + 0.42 * load + 0.22 * rpmNorm, t, tc);

    e.intakeFilter.frequency.setTargetAtTime(280 + f * 2.8, t, tc);
    e.intakeGain.gain.setTargetAtTime(thr * thr * (0.28 + 0.36 * rpmNorm), t, tc);

    const absSpeed = Math.abs(speed);
    const kmh = absSpeed * 3.6;
    // At 250 km/h aerodynamic wind noise swells and gently ducks the engine mix (like real high-speed cabins)
    const highSpdWind = Math.max(0, Math.min(1, (kmh - 140) / 130));
    const windDuck = 1 - highSpdWind * 0.34;
    const master = this.muted || stalled ? 0 : (0.16 + 0.24 * load + 0.10 * rpmNorm) * windDuck;
    const stemsActive = this.updateEngineStems(rpm, thr, rpmNorm, master, lope, tc);

    // Forced-induction synthesizer: linear RPM supercharger whine OR lag-spooled turbo compressor whistle
    const boostMode = vSpec.boost !== 'none' ? vSpec.boost : (this.extraTurbo ? 'turbo' : 'none');
    if (boostMode === 'supercharger' && !this.muted && !stalled) {
      const scFreq = 920 + rpm * 0.31;
      const scDuck = stemsActive && this.voiceId === 'v8_supercharged' ? 0.35 : 1.0;
      e.oBoost.frequency.setTargetAtTime(scFreq, t, 0.02);
      e.boostFilter.frequency.setTargetAtTime(scFreq, t, 0.03);
      e.boostGain.gain.setTargetAtTime((0.025 + 0.105 * thr) * (0.35 + 0.65 * rpmNorm) * scDuck, t, 0.03);
    } else if (boostMode === 'turbo' && !this.muted && !stalled) {
      const targetSpool = Math.max(0, (rpmNorm - 0.18) * 1.25) * thr;
      this.boostSpool += (targetSpool - this.boostSpool) * 0.12;
      const tFreq = 2200 + this.boostSpool * 4400;
      e.oBoost.frequency.setTargetAtTime(tFreq, t, 0.04);
      e.boostFilter.frequency.setTargetAtTime(tFreq, t, 0.04);
      e.boostGain.gain.setTargetAtTime(this.boostSpool * 0.048, t, 0.04);
    } else {
      this.boostSpool *= 0.85;
      e.boostGain.gain.setTargetAtTime(0, t, 0.05);
    }

    // Dynamic low-pass opens with throttle and RPM; higher-revving exotic engines open brighter at the top end
    const topBright = vSpec.firingsPerRev >= 5 || this.voiceId === 'rotary_4' || this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' ? 2600 : 1800;
    const cutoff = 320 + f * (2.2 + 5.8 * load) + rpmNorm * topBright * thr;
    e.lp.frequency.setTargetAtTime(cutoff, t, tc);

    e.g.gain.setTargetAtTime(stemsActive ? master * 0.15 : master, t, 0.04);
    // The engine voice above follows every frame (24-40 ms smoothing: fewer updates would step the revs). The slow layers
    // (80-140 ms smoothing) glide the same at ~30 Hz: half the automation events posted to the audio thread for them.
    const slow = t - this.slowAt >= 0.03 || t < this.slowAt;
    if (slow) this.slowAt = t;
    if (this.reverbSend && slow) {
      // Narrow tunnels/walled canyons amplify and echo the exhaust note
      this.reverbSend.gain.setTargetAtTime(this.muted ? 0 : this.envReverb * 0.62, t, 0.08);
    }

    // Distinct rolling tire surface audio: realistic wet spray stem + fallback hiss / gravel crunch / dry asphalt
    if (slow) {
      const wetAmt = this.onGravel ? 0 : Math.max(0, (this.roadWetness - 0.15) / 0.85);
      const spdFrac = Math.min(1, kmh / 170);
      if (this.stemWetSpraySrc && this.stemWetSprayGain) {
        this.stemWetSpraySrc.playbackRate.setTargetAtTime(clamp(0.68 + spdFrac * 0.78, 0.6, 1.75), t, 0.08);
        this.stemWetSprayGain.gain.setTargetAtTime(this.muted ? 0 : wetAmt * Math.pow(spdFrac, 1.25) * 0.34, t, 0.08);
      }
      if (this.roadRoll) {
        const rollFrac = Math.min(1, kmh / 180);
        const targetFreq = this.onGravel ? 240 + kmh * 2.2 : this.roadWetness > 0.55 ? 1650 + kmh * 9.5 : 460 + kmh * 3.2;
        const wetDuck = this.stemWetSpraySrc && !this.onGravel && this.roadWetness > 0.35 ? 1 - 0.75 * wetAmt : 1;
        const targetGain = this.muted ? 0 : rollFrac * (this.onGravel ? 0.14 : this.roadWetness > 0.55 ? 0.11 : 0.055) * wetDuck;
        this.roadRoll.f.frequency.setTargetAtTime(targetFreq, t, 0.08);
        this.roadRoll.g.gain.setTargetAtTime(targetGain, t, 0.08);
      }
    }

    // Simcenter Tire 2606 Doppler-split toroidal air-cavity resonance + kerb rumble strip stem over curbs/bumps
    let peakCav = 0;
    for (let i = 0; i < 4; i++) peakCav = Math.max(peakCav, out[OUT.cavityGain(i)] || 0);
    if (this.stemKerbSrc && this.stemKerbGain) {
      const kerbExcite = Math.min(1, peakCav * 1.4) * Math.min(1, absSpeed / 4.0);
      this.stemKerbSrc.playbackRate.setTargetAtTime(clamp(0.55 + (absSpeed / 42) * 1.35, 0.5, 2.2), t, 0.03);
      this.stemKerbGain.gain.setTargetAtTime(this.muted ? 0 : kerbExcite * 0.38, t, 0.025);
    }
    if (this.cavity) {
      const fLo = Math.max(120, Math.min(340, out[OUT.cavityLowHz] || 220));
      const fHi = Math.max(130, Math.min(380, out[OUT.cavityHighHz] || 228));
      this.cavity.fLo.frequency.setTargetAtTime(fLo, t, 0.03);
      this.cavity.fHi.frequency.setTargetAtTime(fHi, t, 0.03);
      this.cavity.g.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.24, peakCav * 0.22) * (this.stemKerbSrc ? 0.3 : 1), t, 0.025);
    }

    // Turbo Blow-Off Valve (BOV) compressor surge flutter triggered by C++ drivetrain state or turbo lift-off
    const bovTriggered = (out[OUT.bovVenting] || 0) > 0.5
      || (boostMode === 'turbo' && this.boostSpool > 0.32 && thr < 0.08);
    if (!this.muted && !stalled && bovTriggered && t > this.lastBovAt + 0.32) {
      this.lastBovAt = t;
      this.triggerTurboBov(t, Math.max(0.65, this.boostSpool));
      this.boostSpool *= 0.35;
    }

    // Straight-cut GT transmission gear whine stem + subtle synth fallback proportional to wheel speed + engine load
    const gearFreq = Math.max(240, absSpeed * 28 + rpm * 0.12);
    e.oGear.frequency.setTargetAtTime(gearFreq, t, 0.03);
    const whineLevel = this.muted || stalled ? 0 : Math.min(0.038, (absSpeed / 65) * 0.026 * (0.4 + 0.6 * thr));
    if (this.stemGearSrc && this.stemGearGain) {
      const gearRate = clamp(0.45 + (absSpeed / 58) * 1.45 + (rpm / 9000) * 0.25, 0.42, 2.35);
      this.stemGearSrc.playbackRate.setTargetAtTime(gearRate, t, 0.03);
      const stemWhine = this.muted || stalled ? 0 : Math.min(0.16, (absSpeed / 65) * 0.12 * (0.35 + 0.65 * thr)) * Math.min(1, absSpeed / 6);
      this.stemGearGain.gain.setTargetAtTime(stemWhine, t, 0.04);
    }
    e.gearGain.gain.setTargetAtTime(this.stemGearSrc ? whineLevel * 0.15 : whineLevel, t, 0.04);

    // Gearshift ignition-cut bark when shifting up or down under load
    if (gear !== this.lastGear && !this.muted && !stalled) {
      if (gear > this.lastGear && this.lastRpm > 3200) {
        this.shiftBark(t, Math.min(1, (this.lastRpm - 2500) / 4800));
      }
      this.lastGear = gear;
    }
    this.lastRpm = rpm;

    // Lift-off overrun exhaust pops & crackles when decelerating from high RPM
    if (!this.muted && !stalled && thr < 0.08 && rpm > 2900 && t > this.nextCrackleAt) {
      this.exhaustPop(t, Math.min(1, (rpm - 2600) / 4500));
      this.nextCrackleAt = t + 0.045 + Math.random() * 0.14;
    }

    // Tyres: realistic dry rubber scrub stem + dual-formant tread squeal weighted by normal load
    let squeal = 0, slip = 0;
    for (let i = 0; i < 4; i++) {
      const o = OUT.wheel(i);
      if (out[o + 5] < 0.5) continue;
      const sa = Math.abs(out[o + 8]) * 57.3, sr = Math.abs(out[o + 7]);
      const s = Math.max((sa - 5.5) / 8, (sr - 0.11) / 0.25);
      const w = Math.min(1.3, out[o + 6] / 4000);
      if (s * w > squeal) { squeal = s * w; slip = s; }
    }
    squeal = Math.max(0, Math.min(1, squeal)) * Math.min(1, absSpeed / 3.5);
    if (this.stemDryTyreSrc && this.stemDryTyreGain) {
      const dryFactor = this.onGravel ? 0.15 : Math.max(0.25, 1 - this.roadWetness * 0.75);
      this.stemDryTyreSrc.playbackRate.setTargetAtTime(clamp(0.72 + Math.min(1.4, slip) * 0.42 + Math.min(0.3, absSpeed / 120), 0.65, 1.85), t, 0.04);
      this.stemDryTyreGain.gain.setTargetAtTime(this.muted ? 0 : squeal * dryFactor * 0.42, t, 0.04);
    }
    this.tyre!.g.gain.setTargetAtTime(this.muted ? 0 : squeal * 0.28 * (this.stemDryTyreSrc ? 0.2 : 1), t, 0.04);
    this.tyre!.f.frequency.setTargetAtTime(780 + 380 * Math.min(1.6, slip), t, 0.04);
    this.tyre!.f2.frequency.setTargetAtTime(1520 + 620 * Math.min(1.6, slip), t, 0.04);

    if (slow) {
      const v = Math.min(1, absSpeed / 70);
      this.wind!.g.gain.setTargetAtTime(this.muted ? 0 : Math.pow(v, 1.8) * 0.42, t, 0.14);
      this.wind!.f.frequency.setTargetAtTime(260 + 1080 * v, t, 0.14);
    }
  }

  /** Update dynamic adaptive music intensity from speed, police heat & chase state. */
  setMusicContext(speedKmh: number, copsActive: boolean, heatLevel: number) {
    this.musicChase = copsActive;
    const spd = Math.min(1, speedKmh / 240);
    this.musicIntensity = copsActive ? Math.min(1, 0.72 + heatLevel * 0.06) : Math.max(0.15, spd);
  }

  /** Triumphal chord swell when crossing the race finish line! */
  triggerFinishSwell() {
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.musicEnabled) return;
    const t = ctx.currentTime;
    for (const hz of [220, 277.18, 329.63, 440, 659.25]) {
      this.tone(t, 1.45, hz, hz * 1.005, 'triangle', 0.055);
    }
  }

  private startAdaptiveMusic() {
    if (this.musicTimer) return;
    const cruiseScale = [55, 55, 65.41, 73.42, 82.41, 73.42, 65.41, 49];   // A minor synthwave bass
    const chaseScale = [61.74, 65.41, 61.74, 73.42, 82.41, 77.78, 65.41, 55]; // High-tension Phrygian pursuit
    this.musicTimer = setInterval(() => {
      const ctx = this.ctx;
      if (!ctx || !this.out || ctx.state !== 'running' || this.muted || !this.musicEnabled) return;
      const t = ctx.currentTime;
      const step = this.musicStep++;
      const scale = this.musicChase ? chaseScale : cruiseScale;
      const note = scale[step % scale.length];
      const inten = this.musicIntensity;
      // Sub-bass pulse
      this.tone(t, 0.16, note, note * 0.99, this.musicChase ? 'sawtooth' : 'triangle', 0.028 + inten * 0.025);
      // High-speed / chase arpeggio synth layer unlocks above 110 km/h or during cop pursuit
      if (inten > 0.45 && step % (this.musicChase ? 1 : 2) === 0) {
        const arp = note * (step % 4 === 0 ? 4 : step % 2 === 0 ? 3 : 2);
        this.tone(t, 0.09, arp, arp, 'square', (inten - 0.35) * 0.022);
      }
      // Crisp hi-hat tick in chase / high-speed mode
      if ((this.musicChase || inten > 0.6) && step % 2 === 1) {
        this.burst(t, 0.025, 'highpass', 7500, 1.2, 0.018 * inten);
      }
    }, 185);
  }

  /** Brief ignition-cut exhaust thump on high-RPM upshifts. */
  private shiftBark(t: number, intensity: number) {
    if (this._muted) return;
    const rate = 0.86 + Math.random() * 0.32;
    if (this.playStemOneShot('exhaust_backfire_pop', t, 0.42 * intensity, rate, true)) {
      this.tone(t, 0.045, 115, 48, 'sawtooth', 0.11 * intensity);
      return;
    }
    this.burst(t, 0.075, 'bandpass', 190 + Math.random() * 70, 1.4, 0.38 * intensity);
    this.tone(t, 0.065, 115, 48, 'sawtooth', 0.22 * intensity);
  }

  /** Exhaust header pop / burble on high-RPM throttle lift-off. */
  private exhaustPop(t: number, intensity: number) {
    if (this._muted) return;
    const rate = 0.86 + Math.random() * 0.32;
    const popGain = (0.28 + Math.random() * 0.24) * intensity;
    if (this.playStemOneShot('exhaust_backfire_pop', t, popGain, rate, true)) {
      this.tone(t, 0.028, 125 + Math.random() * 40, 44, 'triangle', 0.08 * intensity);
      return;
    }
    const g = (0.14 + Math.random() * 0.18) * intensity;
    this.burst(t, 0.038 + Math.random() * 0.03, 'bandpass', 240 + Math.random() * 260, 1.8, g);
    this.tone(t, 0.04, 130 + Math.random() * 50, 42, 'triangle', g * 0.65);
  }

  /**
   * Breakable sound router & physical crash synthesizer:
   * - kind === 'pole' -> hollow steel streetlamp / signal pole shear + modal ringing + asphalt bounce
   * - kind === 'shop' -> tempered plate-glass storefront explosion + 45+ crystalline falling shards
   * - kind === 'wall' -> ground-floor masonry/concrete building wall breach + falling rubble + glass shatter
   */
  impact(kj: number, glass: boolean, kind?: 'pole' | 'shop' | 'wall') {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running' || this.muted) return;
    const s = Math.min(1, Math.max(0.18, Math.sqrt(kj / 55)));
    const t = ctx.currentTime;

    if (kind === 'pole') {
      this.playPoleBreak(t, s);
      return;
    }
    if (kind === 'shop') {
      this.playStorefrontShatter(t, s);
      return;
    }
    if (kind === 'wall') {
      this.playWallBreach(t, s);
      return;
    }

    // Standard car-to-wall / car-to-car chassis impact
    this.tone(t, 0.32, 92, 26, 'sine', 0.75 * s);
    this.burst(t, 0.28 * s + 0.12, 'lowpass', 210, 0.9, 0.72 * s);
    // Sheet-metal crumple & suspension clang modes
    const modes = [310, 485, 760, 1180, 1840];
    for (let i = 0; i < modes.length; i++) {
      const d = i * 0.012 + Math.random() * 0.04;
      const f = modes[i] * (0.92 + Math.random() * 0.16);
      this.tone(t + d, 0.12 + Math.random() * 0.14, f, f * 0.86, 'triangle', 0.16 * s);
      this.burst(t + d, 0.06 + Math.random() * 0.08, 'bandpass', f * 1.4, 5.5, 0.24 * s);
    }
    if (glass) {
      this.playGlassShards(t + 0.015, s * 0.85, 22);
    }
  }

  /** Hollow cast-iron/steel pole sheared off its base + inharmonic tubular ringing + secondary road impact. */
  private playPoleBreak(t: number, s: number) {
    // 1. Cast-iron flange bolt snap & bumper thump
    this.tone(t, 0.24, 118, 34, 'sine', 0.72 * s);
    this.burst(t, 0.09, 'bandpass', 1450, 3.2, 0.58 * s);
    this.burst(t, 0.18, 'lowpass', 260, 1.1, 0.62 * s);

    // 2. Hollow steel cylinder modal ringing (inharmonic bending modes of a 6-9m tapered steel shaft)
    const tubeModes = [192, 338, 584, 945, 1490, 2260];
    for (let i = 0; i < tubeModes.length; i++) {
      const f0 = tubeModes[i] * (0.95 + Math.random() * 0.1);
      const decay = (0.48 - i * 0.055) * (0.8 + 0.3 * s);
      this.tone(t + 0.005 * i, Math.max(0.12, decay), f0, f0 * 0.985, i % 2 === 0 ? 'sine' : 'triangle', (0.22 / (1 + i * 0.35)) * s);
    }

    // 3. Secondary metallic clang & scrape when the tumbling pole hits the wet asphalt (~0.36s later)
    const tBounce = t + 0.34 + Math.random() * 0.12;
    this.tone(tBounce, 0.28, 225, 218, 'triangle', 0.24 * s);
    this.tone(tBounce, 0.22, 640, 620, 'sine', 0.18 * s);
    this.burst(tBounce, 0.16, 'bandpass', 1850, 4.0, 0.25 * s);
  }

  /** Plate-glass storefront window flexing inward, detonating, and raining 40+ crystalline shards onto the sidewalk. */
  private playStorefrontShatter(t: number, s: number) {
    // 1. Large tempered glass pane membrane flex & frame punch
    this.tone(t, 0.19, 138, 42, 'sine', 0.68 * s);
    this.burst(t, 0.14, 'bandpass', 620, 1.8, 0.52 * s);
    // 2. High-energy plate-glass fracture crack
    this.burst(t + 0.006, 0.11, 'highpass', 2800, 1.5, 0.65 * s);
    this.burst(t + 0.015, 0.22, 'bandpass', 5200, 2.2, 0.48 * s);
    // 3. Cascading crystalline glass shards bouncing on concrete sidewalk
    this.playGlassShards(t + 0.01, s, 44);
  }

  /** Full ground-floor building wall demolition: seismic masonry/brick collapse + steel mullion shear + glass shatter. */
  private playWallBreach(t: number, s: number) {
    // 1. Deep structural masonry & concrete wall punch
    this.tone(t, 0.48, 68, 20, 'sine', 0.92 * s);
    this.tone(t, 0.32, 125, 38, 'triangle', 0.65 * s);
    this.burst(t, 0.42, 'lowpass', 195, 0.85, 0.88 * s);
    this.burst(t + 0.02, 0.35, 'bandpass', 420, 1.4, 0.65 * s);

    // 2. Tumbling brick & concrete chunks slamming onto the floor over 0.06..0.75s (all 16 voices: fewer read as thinner)
    for (let i = 0; i < 16; i++) {
      const dt = 0.05 + Math.random() * 0.68;
      const f = 140 + Math.random() * 380;
      const g = (0.18 + Math.random() * 0.22) * s * (1 - dt * 0.7);
      this.burst(t + dt, 0.055 + Math.random() * 0.07, 'bandpass', f, 2.6, g);
      this.tone(t + dt, 0.05, f * 0.75, f * 0.45, 'sine', g * 0.7);
    }

    // 3. Storefront plate glass & steel frame shattering simultaneously
    this.playStorefrontShatter(t + 0.01, s * 0.95);
  }

  /** Crystalline high-Q modal pings for individual tempered glass shards hitting pavement. */
  private playGlassShards(t0: number, s: number, count: number) {
    for (let i = 0; i < count; i++) {
      // Exponential distribution in time: dense burst immediately, trailing tinkles up to 0.95s
      const u = Math.random();
      const dt = u * u * 0.88 + Math.random() * 0.04;
      const freq = 3100 + Math.random() * 7800;
      const dur = 0.022 + Math.random() * 0.055;
      const amp = (0.045 + Math.random() * 0.065) * s * (1 - u * 0.55);
      this.tone(t0 + dt, dur, freq, freq * 0.97, 'sine', amp);
      if (i % 2 === 0) {
        this.burst(t0 + dt, dur * 0.7, 'bandpass', freq * 1.15, 14, amp * 0.85);
      }
    }
  }

  private tone(at: number, len: number, fStart: number, fEnd: number, type: OscillatorType, gain: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(16, fStart), at);
    o.frequency.exponentialRampToValueAtTime(Math.max(16, fEnd), at + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(this.out!);
    o.start(at);
    o.stop(at + len + 0.02);
  }

  private burst(at: number, len: number, type: BiquadFilterType, freq: number, q: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    src.connect(f).connect(g).connect(this.out!);
    src.start(at, Math.random() * 2.0, len + 0.05);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function distortion(k: number): Float32Array<ArrayBuffer> {
  const n = 1024, c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
}
