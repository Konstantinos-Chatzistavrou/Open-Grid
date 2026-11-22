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
  /** 3 acoustic exhaust/intake formant resonators [freqHz, Q, gainDb] for fallback synth */
  f1: [number, number, number];
  f2: [number, number, number];
  f3: [number, number, number];
  /** 3 stationary fixed-frequency exhaust/muffler/header pipe formants [freqHz, Q, gainDb] for 4-zone stems */
  sf1: [number, number, number];
  sf2: [number, number, number];
  sf3: [number, number, number];
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
    sf1: [115, 1.6, 4.2], sf2: [420, 1.5, 3.0], sf3: [1620, 2.0, 2.4],
    lopeHz: 17.5, lopeDepth: 0.032, drive: 4.4, boost: 'none', revRpm: 7200, waveKey: 'crossplane',
  },
  v8_twin_turbo: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.75, harmRatio: 1.5,
    mainGain: 0.74, subGain: 0.68, bankGain: 0.36, harmGain: 0.16,
    combL: 0.0028, combR: 0.0046,
    f1: [104, 2.4, 8.5], f2: [295, 1.9, 5.8], f3: [1180, 2.3, 3.8],
    sf1: [118, 1.7, 4.4], sf2: [435, 1.6, 2.8], sf3: [1680, 2.0, 2.2],
    lopeHz: 18.0, lopeDepth: 0.026, drive: 4.2, boost: 'turbo', revRpm: 7800, waveKey: 'crossplane',
  },
  v8_supercharged: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.75, harmRatio: 1.5,
    mainGain: 0.78, subGain: 0.76, bankGain: 0.40, harmGain: 0.14,
    combL: 0.0026, combR: 0.0048,
    f1: [98, 2.5, 9.0], f2: [310, 1.7, 6.0], f3: [1350, 2.2, 4.5],
    sf1: [115, 1.6, 4.6], sf2: [440, 1.5, 3.2], sf3: [1850, 1.9, 3.0],
    lopeHz: 15.5, lopeDepth: 0.038, drive: 4.8, boost: 'supercharger', revRpm: 7200, waveKey: 'crossplane',
  },
  v8_flatplane: {
    firingsPerRev: 4.0, subRatio: 0.5, bankRatio: 1.003, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.30, bankGain: 0.42, harmGain: 0.36,
    combL: 0.0018, combR: 0.0019,
    f1: [165, 2.0, 5.5], f2: [520, 2.1, 5.5], f3: [1780, 2.8, 6.8],
    sf1: [158, 1.6, 3.2], sf2: [560, 1.7, 3.4], sf3: [2150, 2.1, 3.6],
    lopeHz: 24.0, lopeDepth: 0.014, drive: 4.6, boost: 'none', revRpm: 9000, waveKey: 'flatplane',
  },
  v12_na: {
    firingsPerRev: 6.0, subRatio: 0.5, bankRatio: 1.002, harmRatio: 2.0,
    mainGain: 0.84, subGain: 0.24, bankGain: 0.44, harmGain: 0.46,
    combL: 0.0015, combR: 0.00155,
    f1: [195, 2.0, 4.8], f2: [640, 2.3, 6.2], f3: [2150, 3.0, 7.6],
    sf1: [182, 1.5, 2.8], sf2: [640, 1.8, 3.8], sf3: [2480, 2.2, 4.2],
    lopeHz: 28.0, lopeDepth: 0.008, drive: 3.8, boost: 'none', revRpm: 9300, waveKey: 'v12',
  },
  v10_screamer: {
    firingsPerRev: 5.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.36, bankGain: 0.50, harmGain: 0.42,
    combL: 0.0019, combR: 0.0027,
    f1: [170, 2.2, 5.4], f2: [560, 2.4, 6.8], f3: [1980, 3.1, 7.8],
    sf1: [170, 1.6, 3.0], sf2: [600, 1.8, 4.0], sf3: [2360, 2.2, 4.2],
    lopeHz: 22.0, lopeDepth: 0.014, drive: 4.5, boost: 'none', revRpm: 9000, waveKey: 'v10',
  },
  v6_tt: {
    firingsPerRev: 3.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 2.0,
    mainGain: 0.78, subGain: 0.46, bankGain: 0.44, harmGain: 0.24,
    combL: 0.0023, combR: 0.0036,
    f1: [135, 2.3, 6.8], f2: [430, 2.1, 6.0], f3: [1520, 2.6, 5.4],
    sf1: [132, 1.7, 3.8], sf2: [470, 1.6, 3.2], sf3: [1780, 2.0, 2.8],
    lopeHz: 19.0, lopeDepth: 0.020, drive: 4.3, boost: 'turbo', revRpm: 8000, waveKey: 'v6',
  },
  flat6_na: {
    firingsPerRev: 3.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 3.0,
    mainGain: 0.76, subGain: 0.38, bankGain: 0.52, harmGain: 0.38,
    combL: 0.0017, combR: 0.0031,
    f1: [155, 2.1, 5.6], f2: [490, 2.4, 6.5], f3: [1880, 3.2, 7.8],
    sf1: [152, 1.6, 3.4], sf2: [540, 1.8, 3.8], sf3: [2200, 2.2, 4.0],
    lopeHz: 21.0, lopeDepth: 0.018, drive: 4.7, boost: 'none', revRpm: 9000, waveKey: 'flat6',
  },
  flat8_na: {
    firingsPerRev: 4.0, subRatio: 0.5, bankRatio: 1.5, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.32, bankGain: 0.46, harmGain: 0.42,
    combL: 0.0016, combR: 0.0025,
    f1: [175, 2.2, 5.2], f2: [580, 2.3, 6.4], f3: [2040, 3.0, 7.5],
    sf1: [165, 1.6, 3.2], sf2: [580, 1.7, 3.6], sf3: [2280, 2.1, 3.8],
    lopeHz: 24.5, lopeDepth: 0.012, drive: 4.5, boost: 'none', revRpm: 9400, waveKey: 'flat8',
  },
  i6_forged: {
    firingsPerRev: 3.0, subRatio: 0.5, bankRatio: 2.0, harmRatio: 3.0,
    mainGain: 0.82, subGain: 0.28, bankGain: 0.44, harmGain: 0.30,
    combL: 0.0020, combR: 0.00205,
    f1: [148, 2.2, 6.2], f2: [460, 2.2, 6.0], f3: [1680, 2.8, 6.2],
    sf1: [142, 1.6, 3.6], sf2: [495, 1.7, 3.4], sf3: [1920, 2.0, 3.2],
    lopeHz: 25.0, lopeDepth: 0.010, drive: 3.9, boost: 'turbo', revRpm: 8200, waveKey: 'i6',
  },
  rotary_4: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 2.0, harmRatio: 3.0,
    mainGain: 0.80, subGain: 0.40, bankGain: 0.54, harmGain: 0.50,
    combL: 0.0013, combR: 0.00135,
    f1: [185, 2.4, 5.2], f2: [720, 2.8, 7.2], f3: [2480, 3.4, 8.6],
    sf1: [188, 1.7, 3.0], sf2: [680, 1.9, 4.2], sf3: [2580, 2.3, 4.5],
    lopeHz: 11.5, lopeDepth: 0.068, drive: 5.2, boost: 'turbo', revRpm: 10200, waveKey: 'rotary',
  },
};

/** 4-zone physical combustion stem mapping (`/assets/audio/<id>.ogg` + reference RPM). */
interface EngineStemZone { id: string; refRpm: number }

// 4 zones per voice: [z0 Idle, z1 Low-Mid, z2 Mid-High, z3 Redline Scream]
const ENGINE_STEM_ZONES: Record<EngineVoiceId, readonly [EngineStemZone, EngineStemZone, EngineStemZone, EngineStemZone]> = {
  flat6_na:        [{ id: 'eng_flat6_1000', refRpm: 1000 },   { id: 'eng_flat6_low', refRpm: 2400 },   { id: 'eng_flat6_4000', refRpm: 4800 },   { id: 'eng_flat6_7800', refRpm: 7800 }],
  v12_na:          [{ id: 'eng_v12_1000', refRpm: 1000 },     { id: 'eng_v12_low', refRpm: 2500 },     { id: 'eng_v12_5000', refRpm: 5000 },     { id: 'eng_v12_8000', refRpm: 8000 }],
  v10_screamer:    [{ id: 'eng_v10_1000', refRpm: 1000 },     { id: 'eng_v10_low', refRpm: 2400 },     { id: 'eng_v10_5500', refRpm: 5200 },     { id: 'eng_v10_7800', refRpm: 7800 }],
  rotary_4:        [{ id: 'eng_rotary4_1100', refRpm: 1100 }, { id: 'eng_rotary4_low', refRpm: 2600 }, { id: 'eng_rotary4_6000', refRpm: 5500 }, { id: 'eng_rotary4_8500', refRpm: 8500 }],
  i6_forged:       [{ id: 'eng_tt_i6_1000', refRpm: 1000 },   { id: 'eng_tt_i6_low', refRpm: 2400 },   { id: 'eng_tt_i6_4000', refRpm: 4500 },   { id: 'eng_tt_i6_7000', refRpm: 7000 }],
  v6_tt:           [{ id: 'eng_v6_tt_1000', refRpm: 1000 },   { id: 'eng_v6_tt_low', refRpm: 2400 },   { id: 'eng_v6_tt_4500', refRpm: 4500 },   { id: 'eng_v6_tt_7200', refRpm: 7200 }],
  v8_crossplane:   [{ id: 'eng_v8_cross_900', refRpm: 900 },  { id: 'eng_v8_cross_low', refRpm: 2100 },{ id: 'eng_v8_cross_4200', refRpm: 4200 },{ id: 'eng_v8_cross_6800', refRpm: 6800 }],
  v8_twin_turbo:   [{ id: 'eng_v8_cross_900', refRpm: 900 },  { id: 'eng_v8_cross_low', refRpm: 2100 },{ id: 'eng_v8_cross_4200', refRpm: 4200 },{ id: 'eng_v8_cross_6800', refRpm: 6800 }],
  v8_flatplane:    [{ id: 'eng_v8_flat_1100', refRpm: 1100 }, { id: 'eng_v8_flat_low', refRpm: 2600 }, { id: 'eng_v8_flat_5500', refRpm: 5200 }, { id: 'eng_v8_flat_8000', refRpm: 8000 }],
  flat8_na:        [{ id: 'eng_v8_flat_1100', refRpm: 1100 }, { id: 'eng_v8_flat_low', refRpm: 2600 }, { id: 'eng_v8_flat_5500', refRpm: 5200 }, { id: 'eng_v8_flat_8000', refRpm: 8000 }],
  v8_supercharged: [{ id: 'eng_v8_cross_900', refRpm: 900 },  { id: 'eng_v8_cross_low', refRpm: 2100 },{ id: 'eng_sc_v8_whine', refRpm: 4200 },  { id: 'eng_sc_v8_6800', refRpm: 6800 }],
};

/** Dedicated off-throttle engine-braking decel stems rendered at closed throttle (Forza Horizon ON-LOAD <-> OFF-LOAD crossfade). */
const ENGINE_DECEL_STEM: Record<EngineVoiceId, EngineStemZone> = {
  flat6_na:        { id: 'eng_flat6_decel',    refRpm: 4800 },
  v12_na:          { id: 'eng_v12_decel',      refRpm: 5200 },
  v10_screamer:    { id: 'eng_v10_decel',      refRpm: 5200 },
  rotary_4:        { id: 'eng_rotary4_decel',  refRpm: 5400 },
  i6_forged:       { id: 'eng_tt_i6_decel',    refRpm: 4600 },
  v6_tt:           { id: 'eng_v6_tt_decel',    refRpm: 4600 },
  v8_crossplane:   { id: 'eng_v8_cross_decel', refRpm: 4200 },
  v8_twin_turbo:   { id: 'eng_v8_cross_decel', refRpm: 4200 },
  v8_flatplane:    { id: 'eng_v8_flat_decel',  refRpm: 5200 },
  flat8_na:        { id: 'eng_v8_flat_decel',  refRpm: 5200 },
  v8_supercharged: { id: 'eng_v8_cross_decel', refRpm: 4200 },
};

const FX_LOOP_STEMS = [
  'turbo_spool_loop',
  'gear_whine_straightcut',
  'tyre_scrub_dry',
  'tyre_spray_wet',
  'kerb_rumble_strip',
] as const;

const FX_ONESHOT_STEMS = [
  'turbo_flutter_bov',
  'exhaust_backfire_pop',
  'exhaust_antilag_pop2',
  'exhaust_antilag_pop3',
] as const;

const ANTILAG_POP_IDS = [
  'exhaust_backfire_pop',
  'exhaust_antilag_pop2',
  'exhaust_antilag_pop3',
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
  private lastShiftBarkAt = 0;
  // Slow, authentic anti-lag / lift-off overrun burst state (replaces harsh rapid crackle spam)
  private wasOnThrottle = false;
  private antiLagRemaining = 0;
  private antiLagUntil = 0;
  private antiLagPopIdx = 0;
  private drivingFlame = 0;
  private garageAntiLagRemaining = 0;
  private voiceId: EngineVoiceId = 'v8_crossplane';
  private extraTurbo = false;
  private boostSpool = 0;
  private revUntil = 0;
  // Zero-hiccup acoustic envelope followers (smooth out clutch engagement & 15-30 Hz TC throttle pulses)
  private smoothRpm = 850;
  private smoothThr = 0;
  private smoothLoad = 0.2;
  private lastUpdateMs = 0;
  private hasValidSmooth = false;
  private revLimiterCutUntil = 0;
  private revLimiterNextToggle = 0;
  private downshiftBlipUntil = 0;
  private downshiftBlipRpm = 0;
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

  // 4-zone physical combustion & FX audio stems (`/assets/audio/<id>.ogg`) with graceful synth fallback
  private stemBuffers = new Map<string, AudioBuffer>();
  private stemAttempted = new Set<string>();
  private stemQueue: string[] = [];
  private stemDecoding = false;
  private appliedVoiceId: EngineVoiceId | null = null;
  private shaperCache = new Map<string, Float32Array<ArrayBuffer>>();
  private stemZoneSrcs: (AudioBufferSourceNode | null)[] = [null, null, null, null];
  private stemZoneIds: (string | null)[] = [null, null, null, null];
  private stemZoneGains: (GainNode | null)[] = [null, null, null, null];
  private stemDecelSrc: AudioBufferSourceNode | null = null;
  private stemDecelId: string | null = null;
  private stemDecelGain: GainNode | null = null;
  private stemF1: BiquadFilterNode | null = null;
  private stemF2: BiquadFilterNode | null = null;
  private stemF3: BiquadFilterNode | null = null;
  private stemToneFilter: BiquadFilterNode | null = null;
  private stemShaper: WaveShaperNode | null = null;
  private stemEngMaster: GainNode | null = null;
  private stemTurboSrc: AudioBufferSourceNode | null = null;
  private stemTurboGain: GainNode | null = null;
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
    this.drivingFlame = 0;
    this.antiLagRemaining = 0;
    this.garageAntiLagRemaining = 0;
    this.wasOnThrottle = false;
    this.boostSpool = 0;
    this.smoothRpm = 850;
    this.smoothThr = 0;
    this.smoothLoad = 0.2;
    this.lastUpdateMs = 0;
    this.hasValidSmooth = false;
    this.revLimiterCutUntil = 0;
    this.revLimiterNextToggle = 0;
    this.downshiftBlipUntil = 0;
    this.downshiftBlipRpm = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const zero = (g?: GainNode | null) => {
      if (!g) return;
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.005);
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
    for (let i = 0; i < 4; i++) zero(this.stemZoneGains[i]);
    zero(this.stemDecelGain);
    zero(this.stemEngMaster);
    zero(this.stemTurboGain);
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
      g.gain.setTargetAtTime(0, t, 0.006);
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
    // Fast O(1) no-op if this voice is already active (prevents WaveShaper/PeriodicWave audio-thread hitches on Rev/Ignition clicks!)
    if (this.appliedVoiceId === this.voiceId) {
      this.syncEngineStemSources();
      return;
    }
    this.appliedVoiceId = this.voiceId;
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
    const dKey = `d:${v.drive}`;
    let dCurve = this.shaperCache.get(dKey);
    if (!dCurve) { dCurve = distortion(v.drive); this.shaperCache.set(dKey, dCurve); }
    e.shaper.curve = dCurve;
    // Helical roots supercharger whine uses richer triangle harmonics; turbo compressor whistle stays pure sine
    e.oBoost.type = v.boost === 'supercharger' ? 'triangle' : 'sine';
    // Gentle warm mastering EQ for real recorded engine stems (natural chest punch, zero nasal RC-car buzz)
    if (this.stemF1) {
      this.stemF1.frequency.setTargetAtTime(Math.min(135, v.sf1[0]), t, 0.04);
      this.stemF1.Q.value = 1.05;
      this.stemF1.gain.setTargetAtTime(2.4, t, 0.04);
    }
    if (this.stemF2) {
      this.stemF2.frequency.setTargetAtTime(v.sf2[0], t, 0.04);
      this.stemF2.Q.value = 1.25;
      this.stemF2.gain.setTargetAtTime(0.8, t, 0.04);
    }
    if (this.stemF3) {
      this.stemF3.frequency.setTargetAtTime(v.sf3[0], t, 0.04);
      this.stemF3.Q.value = 1.1;
      this.stemF3.gain.setTargetAtTime(-1.2, t, 0.04);
    }
    if (this.stemShaper && !this.stemShaper.curve) {
      let sCurve = this.shaperCache.get('s:1.06');
      if (!sCurve) { sCurve = warmExhaustCurve(1.06); this.shaperCache.set('s:1.06', sCurve); }
      this.stemShaper.curve = sCurve;
    }
    this.preloadVoiceStems(this.voiceId);
    this.preloadFxStems();
    this.syncEngineStemSources();
  }

  get garageEngineOn(): boolean { return this.garageRunning; }
  get garageFlameLevel(): number { return this.garageFlame; }
  get drivingFlameLevel(): number { return this.drivingFlame; }
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
      if (wasHeld && this.garageRpm > 2800) {
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
    this.drivingFlame = 0;
    this.antiLagRemaining = 0;
    this.garageAntiLagRemaining = 0;
    this.wasOnThrottle = false;
    this.boostSpool = 0;
    this.hasValidSmooth = false;
    this.lastUpdateMs = 0;
    const e = this.eng, ctx = this.ctx;
    if (e && ctx) {
      const t = ctx.currentTime;
      e.g.gain.setTargetAtTime(0, t, 0.02);
      e.boostGain.gain.setTargetAtTime(0, t, 0.02);
      e.gearGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.stemEngMaster) this.stemEngMaster.gain.setTargetAtTime(0, t, 0.02);
      for (let i = 0; i < 4; i++) {
        const zg = this.stemZoneGains[i];
        if (zg) zg.gain.setTargetAtTime(0, t, 0.02);
      }
      if (this.stemDecelGain) this.stemDecelGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.reverbSend) this.reverbSend.gain.setTargetAtTime(0, t, 0.03);
    }
  }

  /** Turbo BOV flutter + overrun exhaust pops when releasing the Rev pedal from high RPM in Garage. */
  private triggerGarageLiftOffEffects() {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running' || this.muted) return;
    const t = ctx.currentTime;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const intensity = Math.min(1, Math.max(0.45, (this.garageRpm - 2600) / Math.max(3000, vSpec.revRpm - 2600)));
    const boostMode = vSpec.boost !== 'none' ? vSpec.boost : (this.extraTurbo ? 'turbo' : 'none');
    if (boostMode === 'turbo' && this.boostSpool > 0.2 && t > this.lastBovAt + 0.26) {
      this.lastBovAt = t;
      this.triggerTurboBov(t, Math.max(0.75, intensity));
      this.boostSpool *= 0.28;
    }
    this.exhaustPop(t + 0.03, intensity);
    this.garageFlame = Math.max(this.garageFlame, 0.75 + 0.45 * intensity);
  }

  /**
   * Per-frame real engine synthesizer update while in the Garage showroom.
   * Drives the EXACT same 4-zone physical combustion stems + turbo/supercharger + multi-harmonic PeriodicWave synth as driving!
   */
  updateGarage(dt: number) {
    const e = this.eng, ctx = this.ctx;
    if (!e || !ctx || ctx.state !== 'running') {
      this.garageFlame = Math.max(0, this.garageFlame - dt * 5);
      return;
    }
    const now = performance.now();
    const t = ctx.currentTime;
    const safeDt = clamp(dt, 0.004, 0.05);
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const idleRpm = this.voiceId === 'rotary_4' ? 1150 : vSpec.firingsPerRev >= 5 ? 980 : 860;
    const redline = vSpec.revRpm;

    // Decay exhaust flame smoothly between pops/limiter cuts
    this.garageFlame = Math.max(0, this.garageFlame - safeDt * 4.2);

    // Silence road/tyre/wind/gear noise (both synth & stem layers) in the static garage
    if (this.tyre) this.tyre.g.gain.setTargetAtTime(0, t, 0.03);
    if (this.wind) this.wind.g.gain.setTargetAtTime(0, t, 0.03);
    if (this.roadRoll) this.roadRoll.g.gain.setTargetAtTime(0, t, 0.03);
    if (this.cavity) this.cavity.g.gain.setTargetAtTime(0, t, 0.03);
    e.gearGain.gain.setTargetAtTime(0, t, 0.03);
    if (this.stemGearGain) this.stemGearGain.gain.setTargetAtTime(0, t, 0.03);
    if (this.stemDryTyreGain) this.stemDryTyreGain.gain.setTargetAtTime(0, t, 0.03);
    if (this.stemWetSprayGain) this.stemWetSprayGain.gain.setTargetAtTime(0, t, 0.03);
    if (this.stemKerbGain) this.stemKerbGain.gain.setTargetAtTime(0, t, 0.03);

    if (!this.garageRunning) {
      // Smooth engine spin-down when ignition is switched OFF
      this.garageRpm = Math.max(0, this.garageRpm - safeDt * 2800);
      this.garageThr = Math.max(0, this.garageThr - safeDt * 8);
      if (this.garageRpm < 180) {
        this.boostSpool = 0;
        e.g.gain.setTargetAtTime(0, t, 0.03);
        e.boostGain.gain.setTargetAtTime(0, t, 0.03);
        if (this.stemEngMaster) this.stemEngMaster.gain.setTargetAtTime(0, t, 0.03);
        if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.03);
        return;
      }
    } else if (now < this.garageCrankUntil) {
      // Cranking starter before ignition catches
      this.garageRpm = 320 + Math.sin(now * 0.06) * 45;
      this.garageThr = 0.08;
      this.boostSpool = 0;
      e.g.gain.setTargetAtTime(0, t, 0.02);
      e.boostGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.stemEngMaster) this.stemEngMaster.gain.setTargetAtTime(0, t, 0.02);
      if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.02);
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
      this.garageThr += (targetThr - this.garageThr) * Math.min(1, safeDt * (revPressed ? 18 : 10));

      // Realistic unloaded flywheel RPM response (exotics & rotaries spin up faster than heavy V8s)
      const accelRate = this.voiceId === 'rotary_4' || vSpec.firingsPerRev >= 5 ? 9200 : 7600;
      const decelRate = 4300;
      const inLimCut = now < this.garageLimCutUntil;

      if (revPressed && !inLimCut) {
        this.garageRpm += accelRate * safeDt;
        if (this.garageRpm >= redline) {
          this.garageRpm = redline - 240;
          this.garageLimCutUntil = now + 72; // authentic crisp fuel/ignition rev-limiter bounce!
          if (!this.muted) this.shiftBark(t, 0.9);
          this.garageFlame = Math.max(this.garageFlame, 1.15);
          this.garageWasHighRpm = true;
        }
      } else {
        const floorRpm = flaring ? idleRpm + 650 : idleRpm;
        const dropRate = inLimCut ? 5200 : decelRate;
        if (this.garageRpm > floorRpm) {
          this.garageRpm = Math.max(floorRpm, this.garageRpm - dropRate * safeDt);
        } else {
          this.garageRpm += (floorRpm - this.garageRpm) * Math.min(1, safeDt * 8);
        }
      }

      // Slow rhythmic anti-lag exhaust pops & flames when letting off Rev from high RPM in Garage
      if (revPressed && this.garageRpm > 3400) {
        this.garageWasHighRpm = true;
        this.garageAntiLagRemaining = 2 + Math.floor(Math.random() * 2);
      }
      if (!revPressed && this.garageWasHighRpm) {
        if (this.garageRpm > 2500 && this.garageAntiLagRemaining > 0 && !this.muted && t > this.nextCrackleAt) {
          const inten = Math.min(1, (this.garageRpm - 2300) / Math.max(2800, redline - 2300));
          this.exhaustPop(t, inten);
          this.garageFlame = Math.max(this.garageFlame, 0.80 + 0.35 * inten);
          this.garageAntiLagRemaining--;
          this.nextCrackleAt = t + 0.24 + Math.random() * 0.22;
        } else if (this.garageRpm <= 2200 || this.garageAntiLagRemaining <= 0) {
          this.garageWasHighRpm = false;
        }
      }
      // Lift-off BOV + pop right as a swap pulse ends
      if (pulsing && now + safeDt * 1000 >= this.garagePulseUntil && this.garageRpm > 3000) {
        this.garageWasHighRpm = true;
        this.triggerGarageLiftOffEffects();
      }
    }

    // Drive the REAL 4-zone combustion stems + multi-harmonic engine synthesizer with `garageRpm` & `garageThr`
    const rpm = Math.max(450, this.garageRpm);
    const thr = this.garageThr;
    const f = Math.max(20, (rpm / 60) * vSpec.firingsPerRev);
    const tc = 0.018;
    // Gentle idle lope ONLY below 1250 RPM at closed throttle (zero jitter on pulls!)
    const idleLopeFactor = thr <= 0.1 && rpm < 1250
      ? clamp((1250 - rpm) / 450, 0, 1) * clamp((0.1 - thr) / 0.1, 0, 1)
      : 0;
    const lope = 1 + Math.sin(t * vSpec.lopeHz) * vSpec.lopeDepth * idleLopeFactor;
    const stemLope = 1 + Math.sin(t * vSpec.lopeHz) * (vSpec.lopeDepth * 0.45) * idleLopeFactor;

    e.oMain.frequency.setTargetAtTime(f * lope, t, tc);
    e.oSub.frequency.setTargetAtTime(f * vSpec.subRatio * lope, t, tc);
    e.oBank.frequency.setTargetAtTime(f * vSpec.bankRatio * (2 - lope), t, tc);
    e.oHarm.frequency.setTargetAtTime(f * vSpec.harmRatio, t, tc);

    const rpmNorm = clamp((rpm - 650) / Math.max(5500, redline - 650), 0, 1);
    const load = 0.16 + 0.84 * thr;
    const isDecel = thr < 0.1 && rpm > 2600;
    e.exhaustFilter.frequency.setTargetAtTime(160 + f * 1.9, t, tc);
    e.exhaustGain.gain.setTargetAtTime(0.18 + 0.42 * load + 0.22 * rpmNorm, t, tc);

    e.intakeFilter.frequency.setTargetAtTime(280 + f * 2.8, t, tc);
    e.intakeGain.gain.setTargetAtTime(thr * thr * (0.28 + 0.36 * rpmNorm), t, tc);

    const spinFade = this.garageRunning ? 1 : Math.min(1, rpm / Math.max(1, idleRpm));
    const limDip = now < this.garageLimCutUntil ? 0.58 : 1.0;
    const master = this.muted ? 0 : (0.16 + 0.26 * load + 0.12 * rpmNorm) * spinFade * limDip;
    const stemsActive = this.updateEngineStems(rpm, thr, rpmNorm, master, stemLope, tc, isDecel);

    // Real turbo spool stem + whistle OR supercharger whine (routed directly to out + reverb!)
    this.updateForcedInduction(vSpec, rpm, rpmNorm, thr, 0, safeDt, t, !this.muted && this.garageRunning);

    const topBright = vSpec.firingsPerRev >= 5 || this.voiceId === 'rotary_4' || this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' ? 2600 : 1800;
    const cutoff = 320 + f * (2.2 + 5.8 * load) + rpmNorm * topBright * thr;
    e.lp.frequency.setTargetAtTime(cutoff, t, tc);

    // Mute raw oscillator synth completely once all 4 real recorded engine stems are active (ZERO RC-car synth buzz!)
    e.g.gain.setTargetAtTime(stemsActive ? 0 : master, t, 0.03);
    // Warm enclosed showroom reverb so the garage echoes like a real concrete bay
    if (this.reverbSend) {
      this.reverbSend.gain.setTargetAtTime(this.muted ? 0 : 0.38, t, 0.08);
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
    // Routed DIRECTLY to `this.out` (+ `reverbSend` below) so ducking `g` NEVER silences boost whine!
    const oBoost = ctx.createOscillator();
    oBoost.type = 'sine';
    const boostFilter = ctx.createBiquadFilter();
    boostFilter.type = 'bandpass';
    boostFilter.frequency.value = 2400;
    boostFilter.Q.value = 2.8;
    const boostGain = ctx.createGain();
    boostGain.gain.value = 0;
    oBoost.connect(boostFilter).connect(boostGain).connect(this.out!);
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
    shaper.oversample = 'none';

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.4;

    // Straight-cut GT sequential transmission whine — routed DIRECTLY to `this.out` (+ `reverbSend` below)
    const oGear = ctx.createOscillator();
    oGear.type = 'triangle';
    const gearFilter = ctx.createBiquadFilter();
    gearFilter.type = 'bandpass';
    gearFilter.frequency.value = 1400;
    gearFilter.Q.value = 4.2;
    const gearGain = ctx.createGain();
    gearGain.gain.value = 0;
    oGear.connect(gearFilter).connect(gearGain).connect(this.out!);
    oGear.start();

    // Lightweight 0.28s environmental wall/garage slapback reverb (3x lighter FFT than 0.9s; skipped in lowPower)
    if (!this.lowPower) {
      const irLen = Math.floor(ctx.sampleRate * 0.28);
      const irBuf = ctx.createBuffer(2, irLen, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = irBuf.getChannelData(ch);
        for (let i = 0; i < irLen; i++) {
          const dec = Math.pow(1 - i / irLen, 2.4);
          data[i] = (Math.random() * 2 - 1) * dec * (i < 600 ? 0.78 : 0.36);
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
    if (this.reverbSend) {
      g.connect(this.reverbSend);
      boostGain.connect(this.reverbSend);
      gearGain.connect(this.reverbSend);
    }

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

    // 4-zone engine combustion stem bus with stationary exhaust/muffler formants + 3.5 ms stereo Haas width:
    // sum(zone[0..3]) -> stemF1 -> stemF2 -> stemF3 -> stemToneFilter -> stemShaper -> Haas Stereo Merger -> stemEngMaster -> out (+ reverbSend)
    const stemF1 = ctx.createBiquadFilter();
    stemF1.type = 'peaking';
    stemF1.frequency.value = 130;
    stemF1.Q.value = 1.6;
    stemF1.gain.value = 3.8;

    const stemF2 = ctx.createBiquadFilter();
    stemF2.type = 'peaking';
    stemF2.frequency.value = 480;
    stemF2.Q.value = 1.6;
    stemF2.gain.value = 3.2;

    const stemF3 = ctx.createBiquadFilter();
    stemF3.type = 'peaking';
    stemF3.frequency.value = 1900;
    stemF3.Q.value = 2.0;
    stemF3.gain.value = 3.0;

    const stemToneFilter = ctx.createBiquadFilter();
    stemToneFilter.type = 'lowpass';
    stemToneFilter.frequency.value = 1800;
    stemToneFilter.Q.value = 0.78;

    const stemShaper = ctx.createWaveShaper();
    let warmC = this.shaperCache.get('s:1.06');
    if (!warmC) { warmC = warmExhaustCurve(1.06); this.shaperCache.set('s:1.06', warmC); }
    stemShaper.curve = warmC;
    stemShaper.oversample = 'none';

    // Centered sub/body + 3.5 ms L/R Haas stereo exhaust width above 180 Hz (huge 3D engine without mono bass cancellation)
    const stemMerger = ctx.createChannelMerger(2);
    const stemCenter = ctx.createGain();
    stemCenter.gain.value = 0.72;
    stemShaper.connect(stemCenter);
    stemCenter.connect(stemMerger, 0, 0);
    stemCenter.connect(stemMerger, 0, 1);

    const stemHaasHp = ctx.createBiquadFilter();
    stemHaasHp.type = 'highpass';
    stemHaasHp.frequency.value = 180;
    stemHaasHp.Q.value = 0.7;
    const stemHaasDelayL = ctx.createDelay(0.02);
    stemHaasDelayL.delayTime.value = 0.0016;
    const stemHaasDelayR = ctx.createDelay(0.02);
    stemHaasDelayR.delayTime.value = 0.0051; // 3.5 ms inter-aural Haas exhaust spread
    const stemHaasGainL = ctx.createGain();
    stemHaasGainL.gain.value = 0.36;
    const stemHaasGainR = ctx.createGain();
    stemHaasGainR.gain.value = 0.36;
    stemShaper.connect(stemHaasHp);
    stemHaasHp.connect(stemHaasDelayL).connect(stemHaasGainL).connect(stemMerger, 0, 0);
    stemHaasHp.connect(stemHaasDelayR).connect(stemHaasGainR).connect(stemMerger, 0, 1);

    const stemEngMaster = ctx.createGain();
    stemEngMaster.gain.value = 0;

    for (let i = 0; i < 4; i++) {
      const zg = ctx.createGain();
      zg.gain.value = 0;
      zg.connect(stemF1);
      this.stemZoneGains[i] = zg;
    }
    const stemDecelGain = ctx.createGain();
    stemDecelGain.gain.value = 0;
    stemDecelGain.connect(stemF1);
    this.stemDecelGain = stemDecelGain;

    stemF1.connect(stemF2).connect(stemF3).connect(stemToneFilter).connect(stemShaper);
    stemMerger.connect(stemEngMaster).connect(this.out);
    if (this.reverbSend) stemEngMaster.connect(this.reverbSend);

    this.stemF1 = stemF1;
    this.stemF2 = stemF2;
    this.stemF3 = stemF3;
    this.stemToneFilter = stemToneFilter;
    this.stemShaper = stemShaper;
    this.stemEngMaster = stemEngMaster;

    // Dedicated independent forced-induction & FX stem gain buses (zeroed until update modulates them)
    const mkFxBus = (toReverb = false) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out!);
      if (toReverb && this.reverbSend) g.connect(this.reverbSend);
      return g;
    };
    this.stemTurboGain = mkFxBus(true);
    this.stemGearGain = mkFxBus(false);
    this.stemDryTyreGain = mkFxBus(false);
    this.stemWetSprayGain = mkFxBus(false);
    this.stemKerbGain = mkFxBus(false);
  }

  private preloadVoiceStems(voice: EngineVoiceId) {
    const zones = ENGINE_STEM_ZONES[voice] ?? ENGINE_STEM_ZONES.v8_crossplane;
    const decel = ENGINE_DECEL_STEM[voice] ?? ENGINE_DECEL_STEM.v8_crossplane;
    // Queue decel right behind the 4 primary zones so active ON-LOAD stems unlock first, then OFF-LOAD decel immediately after
    this.enqueueStem(decel.id, true);
    for (let i = zones.length - 1; i >= 0; i--) this.enqueueStem(zones[i].id, true);
  }

  private preloadFxStems() {
    for (const id of FX_LOOP_STEMS) this.enqueueStem(id, false);
    for (const id of FX_ONESHOT_STEMS) this.enqueueStem(id, false);
  }

  private enqueueStem(id: string, highPriority: boolean) {
    if (this.stemBuffers.has(id) || this.stemAttempted.has(id)) return;
    if (this.stemQueue.includes(id)) {
      if (highPriority) {
        this.stemQueue = [id, ...this.stemQueue.filter((x) => x !== id)];
      }
      return;
    }
    if (highPriority) this.stemQueue.unshift(id);
    else this.stemQueue.push(id);
    if (!this.stemDecoding) void this.drainStemQueue();
  }

  /** Serialized 1-at-a-time fetch + decode with 20 ms frame yields so decoding NEVER freezes gameplay or Ignition/Rev! */
  private async drainStemQueue(): Promise<void> {
    if (this.stemDecoding) return;
    this.stemDecoding = true;
    try {
      while (this.stemQueue.length > 0 && this.ctx) {
        const id = this.stemQueue.shift()!;
        await this.loadStem(id);
        // Yield at least 1 render frame (~20 ms) before starting the next OGG decode so WebGPU stays butter-smooth
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    } finally {
      this.stemDecoding = false;
    }
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
    const decel = ENGINE_DECEL_STEM[this.voiceId] ?? ENGINE_DECEL_STEM.v8_crossplane;
    if (zones.some((z) => z.id === id) || decel.id === id) {
      this.syncEngineStemSources();
    }
    if (id === 'turbo_spool_loop') this.attachFxLoop('turbo', buf);
    else if (id === 'gear_whine_straightcut') this.attachFxLoop('gear', buf);
    else if (id === 'tyre_scrub_dry') this.attachFxLoop('dryTyre', buf);
    else if (id === 'tyre_spray_wet') this.attachFxLoop('wetSpray', buf);
    else if (id === 'kerb_rumble_strip') this.attachFxLoop('kerb', buf);
  }

  private attachFxLoop(kind: 'turbo' | 'gear' | 'dryTyre' | 'wetSpray' | 'kerb', buf: AudioBuffer) {
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
    if (kind === 'turbo' && !this.stemTurboSrc) this.stemTurboSrc = startLoop(this.stemTurboGain);
    else if (kind === 'gear' && !this.stemGearSrc) this.stemGearSrc = startLoop(this.stemGearGain);
    else if (kind === 'dryTyre' && !this.stemDryTyreSrc) this.stemDryTyreSrc = startLoop(this.stemDryTyreGain);
    else if (kind === 'wetSpray' && !this.stemWetSpraySrc) this.stemWetSpraySrc = startLoop(this.stemWetSprayGain);
    else if (kind === 'kerb' && !this.stemKerbSrc) this.stemKerbSrc = startLoop(this.stemKerbGain);
  }

  private syncEngineStemSources() {
    const ctx = this.ctx;
    if (!ctx) return;
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    const curRpm = Math.max(650, this.garageRunning ? this.garageRpm : this.smoothRpm);

    for (let i = 0; i < 4; i++) {
      const z = zones[i];
      const zg = this.stemZoneGains[i];
      if (!zg) continue;
      if (this.stemZoneIds[i] !== z.id || (!this.stemZoneSrcs[i] && this.stemBuffers.has(z.id))) {
        const old = this.stemZoneSrcs[i];
        if (old) {
          try { old.stop(); old.disconnect(); } catch {}
          this.stemZoneSrcs[i] = null;
          this.stemZoneIds[i] = null;
        }
        const buf = this.stemBuffers.get(z.id);
        if (buf) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.playbackRate.value = clamp(curRpm / z.refRpm, 0.68, 1.42);
          src.connect(zg);
          src.start();
          this.stemZoneSrcs[i] = src;
          this.stemZoneIds[i] = z.id;
        }
      }
    }

    const decel = ENGINE_DECEL_STEM[this.voiceId] ?? ENGINE_DECEL_STEM.v8_crossplane;
    if (this.stemDecelGain && (this.stemDecelId !== decel.id || (!this.stemDecelSrc && this.stemBuffers.has(decel.id)))) {
      if (this.stemDecelSrc) {
        try { this.stemDecelSrc.stop(); this.stemDecelSrc.disconnect(); } catch {}
        this.stemDecelSrc = null;
        this.stemDecelId = null;
      }
      const dBuf = this.stemBuffers.get(decel.id);
      if (dBuf) {
        const src = ctx.createBufferSource();
        src.buffer = dBuf;
        src.loop = true;
        src.playbackRate.value = clamp(curRpm / decel.refRpm, 0.42, 1.65);
        src.connect(this.stemDecelGain);
        src.start();
        this.stemDecelSrc = src;
        this.stemDecelId = decel.id;
      }
    }
  }

  private hasAllEngineStems(): boolean {
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    for (let i = 0; i < 4; i++) {
      if (this.stemZoneSrcs[i] === null || this.stemZoneIds[i] !== zones[i].id) return false;
    }
    return true;
  }

  /**
   * Drive 4-zone realistic combustion engine stems for both driving (`update`) and Garage (`updateGarage`).
   * Keeps `playbackRate` strictly inside `[0.68, 1.42]` with piecewise equal-power cos/sin crossfades across
   * adjacent zones (`z0 <-> z1 <-> z2 <-> z3`), stationary exhaust formants, and distinct load vs decel character.
   * Returns true when all 4 zones for the active voice are active so the caller ducks the raw synth to 0.06.
   */
  private updateEngineStems(
    rpm: number,
    thr: number,
    rpmNorm: number,
    master: number,
    stemLope: number,
    tc: number,
    isDecel: boolean,
  ): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.stemEngMaster || !this.stemToneFilter) return false;
    const t = ctx.currentTime;
    if (!this.hasAllEngineStems()) {
      this.stemEngMaster.gain.setTargetAtTime(0, t, 0.03);
      return false;
    }
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    const decelZone = ENGINE_DECEL_STEM[this.voiceId] ?? ENGINE_DECEL_STEM.v8_crossplane;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;

    // Strictly bounded playbackRate [0.68, 1.42] per zone (gentle idle lope ONLY on z0 below 1250 RPM at closed throttle)
    for (let i = 0; i < 4; i++) {
      const src = this.stemZoneSrcs[i]!;
      const lopeScale = i === 0 ? stemLope : 1;
      const rate = clamp((rpm / zones[i].refRpm) * lopeScale, 0.68, 1.42);
      src.playbackRate.setTargetAtTime(rate, t, tc);
    }

    // Forza-grade ON-LOAD <-> OFF-LOAD DECEL dynamic crossfade (closed-throttle vacuum engine braking)
    const hasDecel = this.stemDecelSrc !== null && this.stemDecelId === decelZone.id && this.stemDecelGain !== null;
    let decelBlend = 0;
    if (hasDecel) {
      const decelRate = clamp(rpm / decelZone.refRpm, 0.42, 1.65);
      this.stemDecelSrc!.playbackRate.setTargetAtTime(decelRate, t, tc);
      const decelRpmEnv = clamp((rpm - 1750) / 1400, 0, 1);
      const decelThrEnv = clamp((0.22 - thr) / 0.22, 0, 1);
      decelBlend = decelRpmEnv * decelThrEnv * (isDecel ? 0.82 : 0.48);
    }
    const onLoadScale = Math.cos(decelBlend * Math.PI * 0.5);
    const offLoadScale = Math.sin(decelBlend * Math.PI * 0.5);

    // Piecewise equal-power cos/sin crossfade across adjacent zones (at most 2 zones active at any RPM)
    const r0 = zones[0].refRpm;
    const r1 = zones[1].refRpm;
    const r2 = zones[2].refRpm;
    const r3 = zones[3].refRpm;
    const m01 = Math.sqrt(r0 * r1), hw01 = Math.min(m01 * 0.14, (r1 - r0) * 0.28);
    const m12 = Math.sqrt(r1 * r2), hw12 = Math.min(m12 * 0.16, (r2 - r1) * 0.28);
    const m23 = Math.sqrt(r2 * r3), hw23 = Math.min(m23 * 0.16, (r3 - r2) * 0.28);

    const effRpm = rpm + 220 * thr;
    let w0 = 0, w1 = 0, w2 = 0, w3 = 0;
    if (effRpm <= m01 - hw01) {
      w0 = 1;
    } else if (effRpm < m01 + hw01) {
      const u = (effRpm - (m01 - hw01)) / (2 * hw01);
      w0 = Math.cos(u * Math.PI * 0.5);
      w1 = Math.sin(u * Math.PI * 0.5);
    } else if (effRpm <= m12 - hw12) {
      w1 = 1;
    } else if (effRpm < m12 + hw12) {
      const u = (effRpm - (m12 - hw12)) / (2 * hw12);
      w1 = Math.cos(u * Math.PI * 0.5);
      w2 = Math.sin(u * Math.PI * 0.5);
    } else if (effRpm <= m23 - hw23) {
      w2 = 1;
    } else if (effRpm < m23 + hw23) {
      const u = (effRpm - (m23 - hw23)) / (2 * hw23);
      w2 = Math.cos(u * Math.PI * 0.5);
      w3 = Math.sin(u * Math.PI * 0.5);
    } else {
      w3 = 1;
    }
    this.stemZoneGains[0]!.gain.setTargetAtTime(w0 * onLoadScale, t, tc);
    this.stemZoneGains[1]!.gain.setTargetAtTime(w1 * onLoadScale, t, tc);
    this.stemZoneGains[2]!.gain.setTargetAtTime(w2 * onLoadScale, t, tc);
    this.stemZoneGains[3]!.gain.setTargetAtTime(w3 * onLoadScale, t, tc);
    if (this.stemDecelGain) {
      this.stemDecelGain.gain.setTargetAtTime(offLoadScale * 1.15, t, tc);
    }

    // Load-responsive warm exhaust filter (1450 Hz closed-throttle cruise -> 13800 Hz WOT redline)
    const baseOpen = 1450 + rpmNorm * 1450;
    const wotOpen = Math.pow(clamp(thr, 0, 1), 0.85) * (6600 + rpmNorm * 4300);
    const decelClose = isDecel ? -280 : 0;
    const toneCutoff = clamp(baseOpen + wotOpen + decelClose, 1200, 13800);
    this.stemToneFilter.frequency.setTargetAtTime(toneCutoff, t, tc);

    if (this.stemF2) {
      const decelBoost = isDecel ? 0.9 : 0;
      this.stemF2.gain.setTargetAtTime(0.8 + decelBoost, t, 0.05);
    }

    this.stemEngMaster.gain.setTargetAtTime(Math.min(0.98, master * 1.48), t, 0.03);
    return true;
  }

  /**
   * Independent forced-induction mix (Real Nissan GT-R Turbo spool loop OR Helical Supercharger whine).
   * Routed directly to `this.out` + `this.reverbSend` so engine synth ducking NEVER silences boost!
   */
  private updateForcedInduction(
    vSpec: EngineVoiceSpec,
    rpm: number,
    rpmNorm: number,
    smoothThr: number,
    coreBoostBar: number,
    dt: number,
    t: number,
    active: boolean,
  ): 'none' | 'turbo' | 'supercharger' {
    const e = this.eng!;
    const boostMode = vSpec.boost !== 'none' ? vSpec.boost : (this.extraTurbo ? 'turbo' : 'none');

    if (boostMode === 'supercharger' && active) {
      this.boostSpool = 0;
      if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.03);
      const scFreq = 880 + rpm * 0.28;
      e.oBoost.frequency.setTargetAtTime(scFreq, t, 0.02);
      e.boostFilter.frequency.setTargetAtTime(scFreq, t, 0.025);
      e.boostFilter.Q.setTargetAtTime(2.4, t, 0.04);
      const scGain = (0.02 + 0.12 * smoothThr) * (0.28 + 0.72 * rpmNorm);
      e.boostGain.gain.setTargetAtTime(clamp(scGain, 0, 0.14), t, 0.025);
    } else if (boostMode === 'turbo' && active) {
      const fromCore = Math.max(0, coreBoostBar / 1.5);
      const fromSynth = Math.max(0, (rpmNorm - 0.14) * 1.25) * smoothThr;
      const targetSpool = clamp(Math.max(fromCore, fromSynth), 0, 1.05);
      const spoolTc = targetSpool >= this.boostSpool ? 0.11 : 0.24;
      this.boostSpool += (targetSpool - this.boostSpool) * (1 - Math.exp(-dt / spoolTc));

      const spoolLevel = clamp(this.boostSpool, 0, 1);
      if (this.stemTurboSrc && this.stemTurboGain) {
        // Warm realistic Garrett/BorgWarner turbine pitch [0.58, 1.36] (zero piercing RC-car shriek!)
        const rate = clamp(0.58 + this.boostSpool * 0.62 + rpmNorm * 0.16, 0.55, 1.36);
        this.stemTurboSrc.playbackRate.setTargetAtTime(rate, t, 0.035);
        this.stemTurboGain.gain.setTargetAtTime(Math.pow(spoolLevel, 1.1) * 0.22 * (0.35 + 0.65 * smoothThr), t, 0.035);
      }
      // Mute harsh raw sine oscillator whenever real turbo_spool_loop stem is loaded!
      const tFreq = 1900 + this.boostSpool * 2600;
      e.oBoost.frequency.setTargetAtTime(tFreq, t, 0.03);
      e.boostFilter.frequency.setTargetAtTime(tFreq, t, 0.03);
      e.boostFilter.Q.setTargetAtTime(3.2, t, 0.04);
      e.boostGain.gain.setTargetAtTime(this.stemTurboSrc ? 0 : spoolLevel * 0.08, t, 0.03);
    } else {
      this.boostSpool *= Math.exp(-dt / 0.18);
      e.boostGain.gain.setTargetAtTime(0, t, 0.035);
      if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.035);
    }

    return boostMode;
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
    const inten = clamp(intensity, 0.5, 1.2);
    const rate = 0.94 + Math.random() * 0.12;
    if (this.playStemOneShot('turbo_flutter_bov', t, 0.74 * inten, rate, true)) {
      return;
    }
    for (let k = 0; k < 4; k++) {
      this.burst(t + k * 0.048, 0.045, 'bandpass', 3200 - k * 300, 4.4, 0.18 * inten * (1 - k * 0.17));
    }
  }

  /** Clean motorsport downshift rev-match blip (subtle single real exhaust pop, no metallic click). */
  private downshiftBlipSound(t: number, intensity: number) {
    if (this._muted) return;
    const inten = clamp(intensity, 0.35, 0.9);
    this.exhaustPop(t + 0.03, inten * 0.75);
  }

  /** Every frame with the core's output. */
  update(out: Float64Array, speed: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.eng) return;
    const nowMs = performance.now();
    const dt = this.lastUpdateMs > 0 ? clamp((nowMs - this.lastUpdateMs) / 1000, 0.004, 0.05) : 0.016;
    this.lastUpdateMs = nowMs;

    const t = ctx.currentTime, tc = 0.020;
    const rawRpm = Math.max(650, out[OUT.rpm]);
    const rawThr = clamp(out[OUT.throttle], 0, 1);
    const gear = Math.round(out[OUT.gear]);
    const stalled = out[OUT.stalled] > 0.5;
    const tcActive = (out[OUT.tc] || 0) > 0.5;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const redline = vSpec.revRpm;

    if (!this.hasValidSmooth) {
      this.smoothRpm = rawRpm;
      this.smoothThr = rawThr;
      this.smoothLoad = 0.16 + 0.84 * rawThr;
      this.lastGear = gear;
      this.lastRpm = rawRpm;
      this.hasValidSmooth = true;
    }

    // Gearshift transitions: upshift ignition-cut bang + BOV flutter, downshift rev-match blip!
    let upshiftUnderBoost = false;
    if (gear !== this.lastGear) {
      if (!this.muted && !stalled) {
        if (gear > this.lastGear) {
          if (this.lastRpm > 3000 && t > this.lastShiftBarkAt + 0.16) {
            this.lastShiftBarkAt = t;
            this.shiftBark(t, clamp((this.lastRpm - 2200) / 4800, 0.45, 1.0));
          }
          upshiftUnderBoost = this.boostSpool > 0.25;
        } else if (gear < this.lastGear && gear >= 1 && rawRpm > 2400) {
          this.downshiftBlipUntil = nowMs + 135;
          this.downshiftBlipRpm = Math.min(redline, rawRpm + 950);
          this.downshiftBlipSound(t, clamp((rawRpm - 2200) / 4500, 0.4, 1.0));
        }
      }
      this.lastGear = gear;
    }
    if ((out[OUT.shiftCut] || 0) > 0.5 && !this.muted && !stalled && t > this.lastShiftBarkAt + 0.16) {
      this.lastShiftBarkAt = t;
      this.shiftBark(t, clamp((rawRpm - 2200) / 4800, 0.5, 1.0));
    }

    // Crisp redline rev-limiter bounce (strictly at true redline under heavy throttle — NEVER interferes with launch!)
    let limDip = 1.0;
    if (!stalled && rawRpm >= redline * 0.975 && rawThr > 0.65) {
      if (nowMs >= this.revLimiterNextToggle) {
        this.revLimiterCutUntil = nowMs + 36;
        this.revLimiterNextToggle = nowMs + 78;
        if (!this.muted && Math.random() < 0.55) {
          this.exhaustPop(t, 0.85);
        }
      }
      if (nowMs < this.revLimiterCutUntil) limDip = 0.58;
    } else {
      this.revLimiterCutUntil = 0;
    }

    // Zero-hiccup asymmetric acoustic envelope followers:
    // - smoothRpm removes clutch-bite / substep jaggedness (fast 18 ms attack, 32 ms release)
    // - smoothThr absorbs 15-30 Hz traction-control wheelspin throttle pulses (25 ms attack, 95 ms release)
    const targetRpm = nowMs < this.downshiftBlipUntil ? Math.max(rawRpm, this.downshiftBlipRpm) : rawRpm;
    const rpmTc = targetRpm >= this.smoothRpm ? 0.018 : 0.032;
    this.smoothRpm += (targetRpm - this.smoothRpm) * (1 - Math.exp(-dt / rpmTc));

    const thrTc = rawThr >= this.smoothThr ? 0.025 : 0.095;
    this.smoothThr += (rawThr - this.smoothThr) * (1 - Math.exp(-dt / thrTc));

    const targetLoad = 0.16 + 0.84 * this.smoothThr;
    const loadTc = targetLoad >= this.smoothLoad ? 0.028 : 0.085;
    this.smoothLoad += (targetLoad - this.smoothLoad) * (1 - Math.exp(-dt / loadTc));

    const rpm = Math.max(650, this.smoothRpm);
    const thr = this.smoothThr;
    const load = this.smoothLoad;
    const f = (rpm / 60) * vSpec.firingsPerRev;

    // Gentle organic idle lope ONLY below 1250 RPM at closed throttle (ZERO random jitter or pull wobble!)
    const idleLopeFactor = thr <= 0.1 && rpm < 1250
      ? clamp((1250 - rpm) / 450, 0, 1) * clamp((0.1 - thr) / 0.1, 0, 1)
      : 0;
    const lope = 1 + Math.sin(t * vSpec.lopeHz) * vSpec.lopeDepth * idleLopeFactor;
    const stemLope = 1 + Math.sin(t * vSpec.lopeHz) * (vSpec.lopeDepth * 0.45) * idleLopeFactor;

    const e = this.eng;
    e.oMain.frequency.setTargetAtTime(f * lope, t, tc);
    e.oSub.frequency.setTargetAtTime(f * vSpec.subRatio * lope, t, tc);
    e.oBank.frequency.setTargetAtTime(f * vSpec.bankRatio * (2 - lope), t, tc);
    e.oHarm.frequency.setTargetAtTime(f * vSpec.harmRatio, t, tc);

    // Exhaust gas flow & intake induction roar (fallback synth)
    const rpmNorm = clamp((rpm - 650) / Math.max(5500, redline - 650), 0, 1);
    e.exhaustFilter.frequency.setTargetAtTime(160 + f * 1.9, t, tc);
    e.exhaustGain.gain.setTargetAtTime(0.18 + 0.42 * load + 0.22 * rpmNorm, t, tc);

    e.intakeFilter.frequency.setTargetAtTime(280 + f * 2.8, t, tc);
    e.intakeGain.gain.setTargetAtTime(thr * thr * (0.28 + 0.36 * rpmNorm), t, tc);

    const absSpeed = Math.abs(speed);
    const kmh = absSpeed * 3.6;
    // At 250 km/h aerodynamic wind noise swells and gently ducks the engine mix (like real high-speed cabins)
    const highSpdWind = Math.max(0, Math.min(1, (kmh - 140) / 130));
    const windDuck = 1 - highSpdWind * 0.30;
    const master = this.muted || stalled ? 0 : (0.17 + 0.25 * load + 0.11 * rpmNorm) * windDuck * limDip;
    const isDecel = !tcActive && rawThr < 0.1 && thr < 0.45 && rpm > 2600;
    const stemsActive = this.updateEngineStems(rpm, thr, rpmNorm, master, stemLope, tc, isDecel);

    // Independent forced-induction mix: Turbo spool loop + whistle OR Supercharger whine directly on `this.out`
    const boostMode = this.updateForcedInduction(
      vSpec, rpm, rpmNorm, thr, out[OUT.boostBar] || 0, dt, t, !this.muted && !stalled,
    );

    // Dynamic low-pass for fallback synth
    const topBright = vSpec.firingsPerRev >= 5 || this.voiceId === 'rotary_4' || this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' ? 2600 : 1800;
    const cutoff = 320 + f * (2.2 + 5.8 * load) + rpmNorm * topBright * thr;
    e.lp.frequency.setTargetAtTime(cutoff, t, tc);

    // Decay driving exhaust flame smoothly between anti-lag pops & upshift bangs
    this.drivingFlame = Math.max(0, this.drivingFlame - dt * 5.2);

    // Mute raw oscillator synth completely once all 4 real recorded engine stems are active (ZERO RC-car synth buzz!)
    e.g.gain.setTargetAtTime(stemsActive ? 0 : master, t, 0.03);

    // Slow layers (80-140 ms smoothing) glide smoothly at ~30 Hz
    const slow = t - this.slowAt >= 0.03 || t < this.slowAt;
    if (slow) this.slowAt = t;
    if (this.reverbSend && slow) {
      // Narrow tunnels/walled canyons amplify and echo the exhaust + turbo + BOV
      this.reverbSend.gain.setTargetAtTime(this.muted ? 0 : this.envReverb * 0.64, t, 0.08);
    }

    // Distinct rolling tire surface audio: wet spray stem (up to 0.44) + fallback hiss / gravel crunch / dry asphalt
    if (slow) {
      const wetAmt = this.onGravel ? 0 : Math.max(0, (this.roadWetness - 0.15) / 0.85);
      const spdFrac = Math.min(1, kmh / 170);
      if (this.stemWetSpraySrc && this.stemWetSprayGain) {
        this.stemWetSpraySrc.playbackRate.setTargetAtTime(clamp(0.68 + spdFrac * 0.78, 0.6, 1.75), t, 0.08);
        this.stemWetSprayGain.gain.setTargetAtTime(this.muted ? 0 : wetAmt * Math.pow(spdFrac, 1.15) * 0.44, t, 0.08);
      }
      if (this.roadRoll) {
        const rollFrac = Math.min(1, kmh / 180);
        const targetFreq = this.onGravel ? 240 + kmh * 2.2 : this.roadWetness > 0.55 ? 1650 + kmh * 9.5 : 460 + kmh * 3.2;
        const wetDuck = this.stemWetSpraySrc && !this.onGravel && this.roadWetness > 0.35 ? 1 - 0.78 * wetAmt : 1;
        const targetGain = this.muted ? 0 : rollFrac * (this.onGravel ? 0.15 : this.roadWetness > 0.55 ? 0.11 : 0.055) * wetDuck;
        this.roadRoll.f.frequency.setTargetAtTime(targetFreq, t, 0.08);
        this.roadRoll.g.gain.setTargetAtTime(targetGain, t, 0.08);
      }
    }

    // Simcenter Tire 2606 Doppler-split toroidal air-cavity resonance + punchy kerb rumble strip stem (up to 0.52)
    let peakCav = 0;
    for (let i = 0; i < 4; i++) peakCav = Math.max(peakCav, out[OUT.cavityGain(i)] || 0);
    if (this.stemKerbSrc && this.stemKerbGain) {
      const kerbExcite = Math.min(1, peakCav * 1.55) * Math.min(1, absSpeed / 3.5);
      this.stemKerbSrc.playbackRate.setTargetAtTime(clamp(0.55 + (absSpeed / 42) * 1.35, 0.5, 2.2), t, 0.03);
      this.stemKerbGain.gain.setTargetAtTime(this.muted ? 0 : kerbExcite * 0.52, t, 0.025);
    }
    if (this.cavity) {
      const fLo = Math.max(120, Math.min(340, out[OUT.cavityLowHz] || 220));
      const fHi = Math.max(130, Math.min(380, out[OUT.cavityHighHz] || 228));
      this.cavity.fLo.frequency.setTargetAtTime(fLo, t, 0.03);
      this.cavity.fHi.frequency.setTargetAtTime(fHi, t, 0.03);
      this.cavity.g.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.24, peakCav * 0.22) * (this.stemKerbSrc ? 0.25 : 1), t, 0.025);
    }

    // Turbo Blow-Off Valve (BOV) compressor surge flutter (`stu-tu-tu-tu`) on upshifts under boost, lift-off, or C++ bovVenting
    const liftOffBov = boostMode === 'turbo' && this.boostSpool > 0.25 && !tcActive && rawThr < 0.12 && thr < 0.45;
    const coreBov = (out[OUT.bovVenting] || 0) > 0.5 && !tcActive;
    const bovTriggered = (boostMode === 'turbo' && upshiftUnderBoost) || liftOffBov || coreBov;
    if (!this.muted && !stalled && bovTriggered && t > this.lastBovAt + 0.26) {
      this.lastBovAt = t;
      this.triggerTurboBov(t, Math.max(0.7, this.boostSpool));
      this.boostSpool *= 0.28;
    }

    // Real BMW M3 GTR straight-cut gearbox whine — subtle & authentic above 55 km/h (ZERO RC-car spur gear whine at low speed!)
    const isRaceBox = this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' || this.voiceId === 'v8_flatplane' || this.voiceId === 'v10_screamer' || this.voiceId === 'v12_na';
    const gearPresence = clamp((kmh - 55) / 85, 0, 1);
    const gearMaxGain = isRaceBox ? 0.11 : 0.045;
    const gearFreq = Math.max(240, absSpeed * 22 + rpm * 0.09);
    e.oGear.frequency.setTargetAtTime(gearFreq, t, 0.03);
    const stemWhine = this.muted || stalled
      ? 0
      : gearPresence * Math.pow(clamp(kmh / 220, 0, 1), 0.9) * gearMaxGain * (0.25 + 0.75 * thr);
    if (this.stemGearSrc && this.stemGearGain) {
      const gearRate = clamp(0.55 + (absSpeed / 78) * 0.95 + (rpm / 10000) * 0.18, 0.52, 1.62);
      this.stemGearSrc.playbackRate.setTargetAtTime(gearRate, t, 0.035);
      this.stemGearGain.gain.setTargetAtTime(stemWhine, t, 0.04);
    }
    // Mute synthetic triangle gear oscillator when real BMW M3 GTR stem is loaded!
    e.gearGain.gain.setTargetAtTime(this.stemGearSrc ? 0 : stemWhine * 0.35, t, 0.04);

    this.lastRpm = rawRpm;

    // Authentic slow rhythmic anti-lag / lift-off overrun pops + synchronized exhaust flames!
    // Arms ONLY when lifting off from high throttle & RPM; fires 2-4 slow spaced deep bangs (0.26-0.52 s apart), NEVER continuous rattle!
    if (thr > 0.42 && rpm > 3200) {
      this.wasOnThrottle = true;
      this.antiLagRemaining = 0;
    } else if (this.wasOnThrottle && !tcActive && rawThr < 0.10 && rpm > 2900) {
      this.wasOnThrottle = false;
      this.antiLagRemaining = 2 + Math.floor(Math.random() * 3); // 2 to 4 slow rhythmic pops
      this.antiLagUntil = t + 2.1;
      this.nextCrackleAt = t + 0.16 + Math.random() * 0.14;
    } else if (rawThr > 0.18 || rpm < 2300) {
      this.antiLagRemaining = 0;
      if (rpm < 2300) this.wasOnThrottle = false;
    }

    if (!this.muted && !stalled && this.antiLagRemaining > 0 && t < this.antiLagUntil && t >= this.nextCrackleAt) {
      const inten = clamp((rpm - 2300) / Math.max(2800, redline - 2300), 0.55, 1.0);
      this.exhaustPop(t, inten);
      this.antiLagRemaining--;
      // Slow natural anti-lag rhythm: 0.26 - 0.52 s between bangs (occasionally a crisp 0.15 s double-pop)
      const isDouble = this.antiLagRemaining > 0 && Math.random() < 0.28;
      this.nextCrackleAt = t + (isDouble ? 0.14 + Math.random() * 0.06 : 0.28 + Math.random() * 0.24);
    }

    // Tyres: dry rubber scrub stem (up to 0.55) + dual-formant tread squeal weighted by normal load
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
      this.stemDryTyreGain.gain.setTargetAtTime(this.muted ? 0 : squeal * dryFactor * 0.55, t, 0.04);
    }
    this.tyre!.g.gain.setTargetAtTime(this.muted ? 0 : squeal * 0.28 * (this.stemDryTyreSrc ? 0.18 : 1), t, 0.04);
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

  /** Crisp real ignition-cut exhaust bang on high-RPM upshifts + synced flame flash. */
  private shiftBark(t: number, intensity: number) {
    if (this._muted) return;
    const inten = clamp(intensity, 0, 1);
    this.drivingFlame = Math.max(this.drivingFlame, 0.92 + 0.26 * inten);
    const id = ANTILAG_POP_IDS[this.antiLagPopIdx++ % ANTILAG_POP_IDS.length];
    const rate = 0.92 + Math.random() * 0.18;
    const bangGain = 0.62 + 0.26 * inten;
    if (this.playStemOneShot(id, t, bangGain, rate, true) || this.playStemOneShot('exhaust_backfire_pop', t, bangGain, rate, true)) {
      return;
    }
    this.burst(t, 0.075, 'bandpass', 180 + Math.random() * 60, 1.4, 0.42 * (0.5 + 0.5 * inten));
  }

  /** Deep slow real anti-lag / overrun exhaust gunshot pop + synced tailpipe flame flash. */
  private exhaustPop(t: number, intensity: number) {
    if (this._muted) return;
    const inten = clamp(intensity, 0.45, 1.0);
    this.drivingFlame = Math.max(this.drivingFlame, 0.82 + 0.34 * inten);
    const id = ANTILAG_POP_IDS[this.antiLagPopIdx++ % ANTILAG_POP_IDS.length];
    const rate = 0.84 + Math.random() * 0.26;
    const popGain = (0.56 + Math.random() * 0.24) * (0.75 + 0.25 * inten);
    if (this.playStemOneShot(id, t, popGain, rate, true) || this.playStemOneShot('exhaust_backfire_pop', t, popGain, rate, true)) {
      return;
    }
    const g = (0.18 + Math.random() * 0.16) * inten;
    this.burst(t, 0.045 + Math.random() * 0.025, 'bandpass', 210 + Math.random() * 140, 1.6, g);
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

/** Warm asymmetric exhaust-pipe saturation curve (adds subtle 2nd-harmonic analog body with zero DC offset). */
function warmExhaustCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024, c = new Float32Array(new ArrayBuffer(n * 4));
  const norm = Math.tanh(drive * 1.14) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * (x + 0.14 * x * x)) / norm;
  }
  return c;
}
