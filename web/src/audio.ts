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
import { pubUrl } from './assetBase';

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
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.5, harmRatio: 2.0,
    mainGain: 0.78, subGain: 0.82, bankGain: 0.52, harmGain: 0.08,
    combL: 0.0026, combR: 0.0029,
    f1: [86, 1.8, 9.5], f2: [250, 1.5, 6.2], f3: [1120, 1.8, 1.8],
    sf1: [88, 1.4, 5.8], sf2: [290, 1.4, 3.8], sf3: [1350, 1.7, 0.8],
    lopeHz: 16.5, lopeDepth: 0.024, drive: 3.2, boost: 'none', revRpm: 7200, waveKey: 'crossplane',
  },
  v8_twin_turbo: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.5, harmRatio: 2.0,
    mainGain: 0.76, subGain: 0.78, bankGain: 0.48, harmGain: 0.10,
    combL: 0.0027, combR: 0.0030,
    f1: [84, 1.9, 9.5], f2: [245, 1.6, 6.2], f3: [1150, 1.8, 1.6],
    sf1: [90, 1.4, 5.8], sf2: [305, 1.4, 3.6], sf3: [1380, 1.7, 0.8],
    lopeHz: 17.0, lopeDepth: 0.020, drive: 3.1, boost: 'turbo', revRpm: 7800, waveKey: 'crossplane',
  },
  v8_supercharged: {
    firingsPerRev: 4.0, subRatio: 0.25, bankRatio: 0.5, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.86, bankGain: 0.54, harmGain: 0.08,
    combL: 0.0028, combR: 0.0031,
    f1: [82, 1.9, 10.0], f2: [240, 1.5, 6.4], f3: [1180, 1.8, 1.8],
    sf1: [86, 1.4, 6.2], sf2: [295, 1.4, 4.0], sf3: [1420, 1.7, 1.0],
    lopeHz: 15.0, lopeDepth: 0.028, drive: 3.4, boost: 'supercharger', revRpm: 7200, waveKey: 'crossplane',
  },
  v8_flatplane: {
    firingsPerRev: 4.0, subRatio: 0.5, bankRatio: 1.0, harmRatio: 2.0,
    mainGain: 0.80, subGain: 0.44, bankGain: 0.42, harmGain: 0.20,
    combL: 0.0018, combR: 0.0019,
    f1: [118, 1.7, 7.2], f2: [380, 1.7, 5.5], f3: [1520, 2.0, 2.6],
    sf1: [115, 1.4, 4.6], sf2: [410, 1.5, 3.6], sf3: [1720, 1.8, 1.4],
    lopeHz: 22.0, lopeDepth: 0.012, drive: 3.3, boost: 'none', revRpm: 9000, waveKey: 'flatplane',
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

export type CameraPerspective = 'chase' | 'hood' | 'cockpit' | 'bumper' | 'garage';
export type ExhaustStage = 'stock' | 'sport' | 'race';
export type AudioEngineMode = 'real_samples' | 'engine_sim';

/** Pre-allocated static camera perspective acoustic mixing profiles (zero per-frame allocations). */
interface CameraAcousticProfile {
  f1GainOff: number;
  f2GainOff: number;
  f3GainOff: number;
  cabinSubDb: number;
  toneCapHz: number;
  toneScale: number;
  centerGain: number;
  haasWidth: number;
  boostMul: number;
  intakeMul: number;
  gearMul: number;
  tyreMul: number;
  kerbMul: number;
  windMul: number;
  windCutoffMul: number;
  brakeMul: number;
  thumpMul: number;
  popMul: number;
  burbleMul: number;
  popLpHz: number;
  burbleLpHz: number;
  tunnelMul: number;
  tunnelFloor: number;
}

const CAMERA_PROFILES: Record<CameraPerspective, CameraAcousticProfile> = {
  chase: {
    f1GainOff: 1.4, f2GainOff: 0.6, f3GainOff: -1.6, cabinSubDb: 1.2,
    toneCapHz: 6800, toneScale: 0.88, centerGain: 0.76, haasWidth: 0.32,
    boostMul: 0.88, intakeMul: 0.78, gearMul: 0.68, tyreMul: 1.0, kerbMul: 1.0,
    windMul: 0.72, windCutoffMul: 0.78, brakeMul: 0.95, thumpMul: 1.0,
    popMul: 0.52, burbleMul: 0.78, popLpHz: 1450, burbleLpHz: 620,
    tunnelMul: 0.95, tunnelFloor: 0,
  },
  bumper: {
    f1GainOff: 1.2, f2GainOff: 0.8, f3GainOff: -0.8, cabinSubDb: 0.8,
    toneCapHz: 7400, toneScale: 0.94, centerGain: 0.74, haasWidth: 0.36,
    boostMul: 0.88, intakeMul: 0.92, gearMul: 0.62, tyreMul: 1.22, kerbMul: 1.26,
    windMul: 0.82, windCutoffMul: 0.85, brakeMul: 1.12, thumpMul: 1.10,
    popMul: 0.58, burbleMul: 0.84, popLpHz: 1650, burbleLpHz: 680,
    tunnelMul: 1.00, tunnelFloor: 0,
  },
  hood: {
    f1GainOff: 0.8, f2GainOff: 0.9, f3GainOff: -0.8, cabinSubDb: 1.2,
    toneCapHz: 6600, toneScale: 0.90, centerGain: 0.82, haasWidth: 0.22,
    boostMul: 1.18, intakeMul: 1.55, gearMul: 0.82, tyreMul: 0.92, kerbMul: 0.92,
    windMul: 0.74, windCutoffMul: 0.80, brakeMul: 1.00, thumpMul: 1.05,
    popMul: 0.44, burbleMul: 0.68, popLpHz: 1350, burbleLpHz: 600,
    tunnelMul: 0.88, tunnelFloor: 0,
  },
  cockpit: {
    f1GainOff: 1.6, f2GainOff: 0.6, f3GainOff: -2.6, cabinSubDb: 3.4,
    toneCapHz: 3200, toneScale: 0.58, centerGain: 0.85, haasWidth: 0.16,
    boostMul: 1.02, intakeMul: 1.35, gearMul: 1.05, tyreMul: 0.74, kerbMul: 0.86,
    windMul: 0.42, windCutoffMul: 0.52, brakeMul: 0.60, thumpMul: 1.16,
    popMul: 0.36, burbleMul: 0.54, popLpHz: 1050, burbleLpHz: 460,
    tunnelMul: 0.62, tunnelFloor: 0,
  },
  garage: {
    f1GainOff: 1.8, f2GainOff: 0.8, f3GainOff: -1.0, cabinSubDb: 1.8,
    toneCapHz: 7200, toneScale: 0.90, centerGain: 0.76, haasWidth: 0.30,
    boostMul: 0.96, intakeMul: 0.95, gearMul: 0, tyreMul: 0, kerbMul: 0,
    windMul: 0, windCutoffMul: 1.0, brakeMul: 0, thumpMul: 1.0,
    popMul: 0.56, burbleMul: 0.85, popLpHz: 1500, burbleLpHz: 650,
    tunnelMul: 0.95, tunnelFloor: 0.38,
  },
};

/** Pre-allocated static exhaust upgrade stage profiles (stock OEM -> sport cat-back -> race straight-pipe). */
interface ExhaustStageProfile {
  f1GainOff: number;
  f2GainOff: number;
  f3GainOff: number;
  toneCapHz: number;
  toneScale: number;
  shaperKey: string;
  shaperDrive: number;
  popGainMul: number;
  popChance: number;
  popCountMin: number;
  popCountSpan: number;
  popRateMin: number;
  popRateSpan: number;
  popLpHz: number;
  burbleGainMul: number;
  burbleCountMin: number;
  burbleCountSpan: number;
  shiftBarkMul: number;
  flameMul: number;
}

const EXHAUST_PROFILES: Record<ExhaustStage, ExhaustStageProfile> = {
  stock: {
    f1GainOff: 0.8, f2GainOff: -0.2, f3GainOff: -2.2,
    toneCapHz: 4200, toneScale: 0.76, shaperKey: 's:1.02', shaperDrive: 1.02,
    popGainMul: 0.0, popChance: 0.0, popCountMin: 0, popCountSpan: 1,
    popRateMin: 0.72, popRateSpan: 0.12, popLpHz: 1100,
    burbleGainMul: 0.34, burbleCountMin: 1, burbleCountSpan: 1,
    shiftBarkMul: 0.32, flameMul: 0.0,
  },
  sport: {
    f1GainOff: 0.6, f2GainOff: 0.4, f3GainOff: -0.6,
    toneCapHz: 5800, toneScale: 0.94, shaperKey: 's:1.05', shaperDrive: 1.05,
    popGainMul: 0.44, popChance: 0.45, popCountMin: 1, popCountSpan: 1,
    popRateMin: 0.74, popRateSpan: 0.16, popLpHz: 1400,
    burbleGainMul: 0.68, burbleCountMin: 1, burbleCountSpan: 2,
    shiftBarkMul: 0.56, flameMul: 0.55,
  },
  race: {
    f1GainOff: 0.4, f2GainOff: 0.9, f3GainOff: 0.6,
    toneCapHz: 7200, toneScale: 1.08, shaperKey: 's:1.14', shaperDrive: 1.14,
    popGainMul: 0.66, popChance: 0.75, popCountMin: 1, popCountSpan: 2,
    popRateMin: 0.80, popRateSpan: 0.18, popLpHz: 1750,
    burbleGainMul: 0.88, burbleCountMin: 2, burbleCountSpan: 2,
    shiftBarkMul: 0.74, flameMul: 0.85,
  },
};

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
  /** Multi-mode Whelen/Federal Signal 100W police siren + Rumbler sub-layer + Doppler/Pan + dual-tone airhorn. */
  private srn: {
    oMain: OscillatorNode;
    oDet: OscillatorNode;
    oRumbler: OscillatorNode;
    lfo: OscillatorNode;
    lg: GainNode;
    lgSub: GainNode;
    distLp: BiquadFilterNode;
    rumbleGain: GainNode;
    panner: StereoPannerNode | null;
    g: GainNode;
    airhornGain: GainNode;
    revSend: GainNode | null;
    mode: 'wail' | 'yelp' | 'phaser';
    modeSwitchAt: number;
    lastAirhornAt: number;
  } | null = null;
  private lastGear = 1;
  private lastRpm = 800;
  private nextCrackleAt = 0;
  private lastShiftBarkAt = 0;
  // Slow, authentic anti-lag / lift-off overrun burst state (replaces harsh rapid crackle spam)
  private wasOnThrottle = false;
  private wasMidThrottle = false;
  private antiLagRemaining = 0;
  private antiLagUntil = 0;
  private antiLagPopIdx = 0;
  private burbleRemaining = 0;
  private burbleUntil = 0;
  private nextBurbleAt = 0;
  private drivingFlame = 0;
  private garageAntiLagRemaining = 0;
  private garageBurbleRemaining = 0;
  private voiceId: EngineVoiceId = 'v8_crossplane';
  private extraTurbo = false;
  private boostSpool = 0;
  private revUntil = 0;
  // Forza Horizon 6 camera perspective & exhaust upgrade stage state
  private cameraPerspective: CameraPerspective = 'chase';
  private exhaustStage: ExhaustStage = 'sport';
  private appliedExhaustShaperKey: string | null = null;
  private lastSuspThumpAt = -1;
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
  /** Low-power mobile/potato audio mode: skips heavy stereo FFT ConvolverNode reverb & WASM AudioWorklet to save phone ARM CPU. */
  lowPower = false;
  /** Real-time environment spatial audio inputs (populated from main.ts 3D raycasts & weather). */
  wallProximityL = 0;
  wallProximityR = 0;
  overpassReflection = 0;
  roadWaterMm = 0;

  // Dedicated C++17 WebAssembly AudioWorklet (rs::VehicleAudioEngine: vendored engine-sim + 12 voices +
  // 8-ch Householder tunnel FDN + 4-wheel tyre/road/brake/ABS/drivetrain/aero/impact + 2 ms lookahead limiter).
  private workletNode: AudioWorkletNode | null = null;
  private workletGain: GainNode | null = null;
  private wasmAudioReady = false;
  private wasmAudioLoading = false;
  wasmAudioError = '';
  private wasmTelBuf = new Float32Array(128);
  private lastWasmVoice = -1;
  private lastWasmStage = -1;
  private lastWasmTurbo = false;
  private carId = 'vela_gt';
  private customVoiceTag = '';
  private _audioEngineMode: AudioEngineMode = (() => {
    try { return localStorage.getItem('og.audioMode') === 'engine_sim' ? 'engine_sim' : 'real_samples'; } catch { return 'real_samples'; }
  })();

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
  private stemCabinSub: BiquadFilterNode | null = null;
  private stemToneFilter: BiquadFilterNode | null = null;
  private stemShaper: WaveShaperNode | null = null;
  private stemCenter: GainNode | null = null;
  private stemHaasGainL: GainNode | null = null;
  private stemHaasGainR: GainNode | null = null;
  private stemEngMaster: GainNode | null = null;
  // Persistent induction intake roar layer (active in hood/cockpit even when 4-zone stems mute raw synth)
  private stemIntakeFilter: BiquadFilterNode | null = null;
  private stemIntakeGain: GainNode | null = null;
  // Zero-stutter 4-tap stereo tunnel / canyon slapback reflection network (works even in lowPower mode!)
  private tunnelSend: GainNode | null = null;
  private tunnelFb: GainNode | null = null;
  // Persistent zero-allocation carbon-ceramic brake hiss & metallic squeal nodes
  private brakeOsc: OscillatorNode | null = null;
  private brakeHissFilter: BiquadFilterNode | null = null;
  private brakeHissGain: GainNode | null = null;
  private brakeSquealFilter: BiquadFilterNode | null = null;
  private brakeSquealGain: GainNode | null = null;
  private brakeGain: GainNode | null = null;
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
    this.burbleRemaining = 0;
    this.garageAntiLagRemaining = 0;
    this.garageBurbleRemaining = 0;
    this.wasOnThrottle = false;
    this.wasMidThrottle = false;
    this.boostSpool = 0;
    this.lastSuspThumpAt = -1;
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
    zero(this.tunnelSend);
    zero(this.tunnelFb);
    zero(this.brakeGain);
    zero(this.brakeHissGain);
    zero(this.brakeSquealGain);
    zero(this.stemIntakeGain);
    zero(this.srn?.g);
    zero(this.srn?.rumbleGain);
    zero(this.srn?.airhornGain);
    for (let i = 0; i < 4; i++) zero(this.stemZoneGains[i]);
    zero(this.stemDecelGain);
    zero(this.stemEngMaster);
    zero(this.stemTurboGain);
    zero(this.stemGearGain);
    zero(this.stemDryTyreGain);
    zero(this.stemWetSprayGain);
    zero(this.stemKerbGain);
    zero(this.workletGain);
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'active', active: false });
    }
  }

  /** Active A/B audio synthesis mode: 'real_samples' (CC-BY 3.0 real car recordings) vs 'engine_sim' (WASM thermodynamic + 192-tap muffler IR). */
  get audioEngineMode(): AudioEngineMode {
    return this._audioEngineMode;
  }

  /** Switch live between Real Recorded Cars (CC-BY 3.0) and Engine-Sim + Exhaust IR (WASM) with zero audio overlap. */
  setAudioEngineMode(mode: AudioEngineMode): void {
    if (mode === this._audioEngineMode) return;
    this._audioEngineMode = mode;
    try { localStorage.setItem('og.audioMode', mode); } catch { /* storage blocked */ }
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (mode === 'real_samples') {
      if (this.workletGain) this.workletGain.gain.setTargetAtTime(0, t, 0.015);
      if (this.workletNode) this.workletNode.port.postMessage({ type: 'active', active: false });
      this.preloadVoiceStems(this.voiceId);
      this.preloadFxStems();
      this.syncEngineStemSources();
    } else {
      this.muteFallbackVehicleBuses(t);
      if (!this.wasmAudioReady && !this.wasmAudioLoading && !this.lowPower) {
        void this.initWasmWorklet();
      } else {
        this.syncWasmVoice();
      }
      this.preloadVoiceStems(this.voiceId);
      this.syncEngineStemSources();
    }
  }

  /** True when the C++17 physical WASM AudioWorklet owns vehicle synthesis (only in 'engine_sim' mode & non-lowPower). */
  get wasmPhysicalAudioActive(): boolean {
    return this._audioEngineMode === 'engine_sim' && this.wasmAudioReady && !this.lowPower && this.workletNode !== null;
  }

  private resolveWasmVoiceId(): number {
    const tag = this.customVoiceTag || this.voiceId;
    if (tag === 'i4_turbo') return 10;
    if (tag === 'i5_turbo') return 11;
    // Detect stock 4-cyl/5-cyl rally & hot-hatch chassis when no engine swap is active
    if (!this.customVoiceTag) {
      const id = this.carId.toLowerCase();
      if (id.includes('quattro') || id.includes('rs3') || id.includes('ttrs') || id.includes('i5')) return 11;
      if (id.includes('200t') || id.includes('integrale') || id.includes('evo') || id.includes('civic') || id.includes('golf') || id.includes('i4')) return 10;
    }
    switch (this.voiceId) {
      case 'v8_crossplane':   return 0;
      case 'v8_flatplane':
      case 'flat8_na':        return 1;
      case 'v8_supercharged': return 2;
      case 'v8_twin_turbo':   return 3;
      case 'v12_na':          return 4;
      case 'v10_screamer':    return 5;
      case 'flat6_na':        return 6;
      case 'i6_forged':       return 7;
      case 'v6_tt':           return 8;
      case 'rotary_4':        return 9;
      default:                return 0;
    }
  }

  private resolveWasmExhaustStage(): number {
    return this.exhaustStage === 'stock' ? 0 : this.exhaustStage === 'race' ? 2 : 1;
  }

  private resolveWasmPerspective(): number {
    switch (this.cameraPerspective) {
      case 'garage':  return 0;
      case 'chase':   return 1;
      case 'hood':
      case 'bumper':  return 2;
      case 'cockpit': return 3;
      default:        return 1;
    }
  }

  private resolveWasmTurboEnabled(): boolean {
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    return this.extraTurbo || vSpec.boost === 'turbo' || this.resolveWasmVoiceId() === 10 || this.resolveWasmVoiceId() === 11;
  }

  private syncWasmVoice() {
    if (!this.wasmAudioReady || !this.workletNode) return;
    const voiceId = this.resolveWasmVoiceId();
    const exhaustStage = this.resolveWasmExhaustStage();
    const turboEnabled = this.resolveWasmTurboEnabled();
    if (voiceId === this.lastWasmVoice && exhaustStage === this.lastWasmStage && turboEnabled === this.lastWasmTurbo) {
      return;
    }
    this.lastWasmVoice = voiceId;
    this.lastWasmStage = exhaustStage;
    this.lastWasmTurbo = turboEnabled;
    this.workletNode.port.postMessage({ type: 'voice', voiceId, exhaustStage, turboEnabled });
  }

  private postWasmTrigger(kind: 'pop' | 'flutter' | 'crank' | 'burble' | 'impact', value: number) {
    if (!this.wasmPhysicalAudioActive || !this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'trigger', kind, value });
  }

  private muteFallbackVehicleBuses(t: number) {
    const zero = (g?: GainNode | null) => {
      if (g) g.gain.setTargetAtTime(0, t, 0.02);
    };
    zero(this.eng?.g);
    zero(this.eng?.boostGain);
    zero(this.eng?.gearGain);
    zero(this.stemEngMaster);
    zero(this.stemIntakeGain);
    zero(this.stemTurboGain);
    zero(this.stemGearGain);
    zero(this.stemDryTyreGain);
    zero(this.stemWetSprayGain);
    zero(this.stemKerbGain);
    zero(this.tyre?.g);
    zero(this.roadRoll?.g);
    zero(this.cavity?.g);
    zero(this.wind?.g);
    zero(this.brakeGain);
    zero(this.brakeHissGain);
    zero(this.brakeSquealGain);
    zero(this.reverbSend);
    zero(this.tunnelSend);
    zero(this.tunnelFb);
  }

  private async initWasmWorklet() {
    const ctx = this.ctx;
    if (!ctx || !this.out || this.lowPower || this.wasmAudioLoading || this.wasmAudioReady) return;
    if (typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet) return;
    this.wasmAudioLoading = true;
    try {
      const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
      const [resp] = await Promise.all([
        fetch(`${base}audio/rs_audio.wasm`),
        ctx.audioWorklet.addModule(`${base}audio/opengrid-audio-worklet.js`),
      ]);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching rs_audio.wasm`);
      const wasmBinary = await resp.arrayBuffer();
      const node = new AudioWorkletNode(ctx, 'opengrid-vehicle-audio', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const gain = ctx.createGain();
      gain.gain.value = 0;
      node.connect(gain).connect(this.out);
      const voiceId = this.resolveWasmVoiceId();
      const exhaustStage = this.resolveWasmExhaustStage();
      const turboEnabled = this.resolveWasmTurboEnabled();
      node.port.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === 'ready') {
          this.wasmAudioReady = true;
          this.lastWasmVoice = voiceId;
          this.lastWasmStage = exhaustStage;
          this.lastWasmTurbo = turboEnabled;
          this.syncWasmVoice();
        } else if (msg.type === 'error') {
          this.wasmAudioReady = false;
          this.wasmAudioError = String(msg.error || 'worklet error');
        }
      };
      this.workletNode = node;
      this.workletGain = gain;
      node.port.postMessage(
        {
          type: 'init',
          wasmBinary,
          voiceId,
          exhaustStage,
          turboEnabled,
          simFreq: 4000,
          fluidSubsteps: 3,
        },
        [wasmBinary],
      );
    } catch (err) {
      // Graceful automatic fallback: existing WebAudio stems + harmonic synth stay active.
      this.wasmAudioReady = false;
      this.wasmAudioError = String(err);
    } finally {
      this.wasmAudioLoading = false;
    }
  }

  /** Silence only road/tyre/wind/siren/gearbox/brake/tunnel layers (used before starting the Garage stationary ignition). */
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
    zero(this.srn?.rumbleGain);
    zero(this.srn?.airhornGain);
    zero(this.brakeGain);
    zero(this.brakeHissGain);
    zero(this.brakeSquealGain);
    zero(this.tunnelSend);
    zero(this.stemGearGain);
    zero(this.stemDryTyreGain);
    zero(this.stemWetSprayGain);
    zero(this.stemKerbGain);
  }

  /** Smoothly adapt real engine stems, stereo Haas width, cabin sub-bass, intake/boost & gearbox mix to camera perspective. */
  setCameraPerspective(mode: 'chase' | 'hood' | 'cockpit' | 'bumper' | 'garage'): void {
    if (this.cameraPerspective === mode) return;
    this.cameraPerspective = mode;
    this.applyAcousticProfile(0.06);
  }

  /** Switch exhaust upgrade tuning stage (stock OEM muffler -> sport cat-back -> titanium straight-pipe race). */
  setExhaustStage(stage: 'stock' | 'sport' | 'race'): void {
    if (this.exhaustStage === stage) return;
    this.exhaustStage = stage;
    this.applyAcousticProfile(0.05);
    this.syncWasmVoice();
  }

  /** Apply combined camera perspective + exhaust stage EQ, cabin resonance, Haas width & cached WaveShaper curve. */
  private applyAcousticProfile(tc = 0.05) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const stage = EXHAUST_PROFILES[this.exhaustStage];
    if (this.stemF1) {
      this.stemF1.gain.setTargetAtTime(2.4 + cam.f1GainOff + stage.f1GainOff, t, tc);
    }
    if (this.stemF2) {
      this.stemF2.gain.setTargetAtTime(0.8 + cam.f2GainOff + stage.f2GainOff, t, tc);
    }
    if (this.stemF3) {
      this.stemF3.gain.setTargetAtTime(-1.2 + cam.f3GainOff + stage.f3GainOff, t, tc);
    }
    if (this.stemCabinSub) {
      this.stemCabinSub.gain.setTargetAtTime(cam.cabinSubDb, t, tc);
    }
    if (this.stemCenter) {
      this.stemCenter.gain.setTargetAtTime(cam.centerGain, t, tc);
    }
    if (this.stemHaasGainL) {
      this.stemHaasGainL.gain.setTargetAtTime(cam.haasWidth, t, tc);
    }
    if (this.stemHaasGainR) {
      this.stemHaasGainR.gain.setTargetAtTime(cam.haasWidth, t, tc);
    }
    if (this.stemShaper && this.appliedExhaustShaperKey !== stage.shaperKey) {
      let sCurve = this.shaperCache.get(stage.shaperKey);
      if (!sCurve) {
        sCurve = warmExhaustCurve(stage.shaperDrive);
        this.shaperCache.set(stage.shaperKey, sCurve);
      }
      this.stemShaper.curve = sCurve;
      this.appliedExhaustShaperKey = stage.shaperKey;
    }
  }

  /** Apply authentic engine acoustic architecture (factory stock engine OR installed engine swap + turbo kit). */
  setCarProfile(carId: string, swapVoice?: EngineVoiceId | null, hasAftermarketTurbo = false) {
    this.carId = carId;
    this.customVoiceTag = swapVoice ? String(swapVoice) : '';
    this.voiceId = swapVoice ?? stockEngineOfCar(carId).voice;
    this.extraTurbo = hasAftermarketTurbo;
    this.applyVoice();
    this.syncWasmVoice();
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
    }
    if (this.stemF2) {
      this.stemF2.frequency.setTargetAtTime(v.sf2[0], t, 0.04);
      this.stemF2.Q.value = 1.25;
    }
    if (this.stemF3) {
      this.stemF3.frequency.setTargetAtTime(v.sf3[0], t, 0.04);
      this.stemF3.Q.value = 1.1;
    }
    this.applyAcousticProfile(0.04);
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
      if (this.wasmPhysicalAudioActive) {
        this.postWasmTrigger('crank', 0.40);
      } else {
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
    this.burbleRemaining = 0;
    this.garageAntiLagRemaining = 0;
    this.garageBurbleRemaining = 0;
    this.wasOnThrottle = false;
    this.wasMidThrottle = false;
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
      if (this.stemIntakeGain) this.stemIntakeGain.gain.setTargetAtTime(0, t, 0.02);
      for (let i = 0; i < 4; i++) {
        const zg = this.stemZoneGains[i];
        if (zg) zg.gain.setTargetAtTime(0, t, 0.02);
      }
      if (this.stemDecelGain) this.stemDecelGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.reverbSend) this.reverbSend.gain.setTargetAtTime(0, t, 0.03);
      if (this.tunnelSend) this.tunnelSend.gain.setTargetAtTime(0, t, 0.03);
      if (this.workletGain) this.workletGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.workletNode) this.workletNode.port.postMessage({ type: 'active', active: false });
    }
  }

  /** Turbo BOV flutter + overrun exhaust pops when releasing the Rev pedal from high RPM in Garage. */
  private triggerGarageLiftOffEffects() {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running' || this.muted) return;
    const t = ctx.currentTime;
    const vSpec = ENGINE_VOICES[this.voiceId] ?? ENGINE_VOICES.v8_crossplane;
    const stage = EXHAUST_PROFILES[this.exhaustStage];
    const intensity = Math.min(1, Math.max(0.45, (this.garageRpm - 2600) / Math.max(3000, vSpec.revRpm - 2600)));
    const boostMode = vSpec.boost !== 'none' ? vSpec.boost : (this.extraTurbo ? 'turbo' : 'none');
    if (boostMode === 'turbo' && this.boostSpool > 0.2 && t > this.lastBovAt + 0.26) {
      this.lastBovAt = t;
      this.triggerTurboBov(t, Math.max(0.75, intensity));
      this.boostSpool *= 0.28;
    }
    if (this.exhaustStage === 'race' && intensity > 0.72) {
      this.exhaustPop(t + 0.04, intensity * 0.65);
      this.garageFlame = Math.max(this.garageFlame, (0.55 + 0.30 * intensity) * stage.flameMul);
    } else if (this.exhaustStage !== 'stock') {
      this.exhaustBurble(t + 0.04, intensity * 0.75);
    }
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
    const stage = EXHAUST_PROFILES[this.exhaustStage];
    const idleRpm = this.voiceId === 'rotary_4' ? 1150 : vSpec.firingsPerRev >= 5 ? 980 : 860;
    const redline = vSpec.revRpm;

    // Decay exhaust flame smoothly between pops/limiter cuts
    this.garageFlame = Math.max(0, this.garageFlame - safeDt * 4.2);

    // Silence road/tyre/wind/gear/brake noise (both synth & stem layers) in the static garage
    if (this.tyre) this.tyre.g.gain.setTargetAtTime(0, t, 0.03);
    if (this.wind) this.wind.g.gain.setTargetAtTime(0, t, 0.03);
    if (this.roadRoll) this.roadRoll.g.gain.setTargetAtTime(0, t, 0.03);
    if (this.cavity) this.cavity.g.gain.setTargetAtTime(0, t, 0.03);
    if (this.brakeGain) this.brakeGain.gain.setTargetAtTime(0, t, 0.03);
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
        if (this.stemIntakeGain) this.stemIntakeGain.gain.setTargetAtTime(0, t, 0.03);
        if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.03);
        if (this.workletGain) this.workletGain.gain.setTargetAtTime(0, t, 0.03);
        if (this.workletNode) this.workletNode.port.postMessage({ type: 'active', active: false });
        return;
      }
    } else if (now < this.garageCrankUntil) {
      // Cranking starter before ignition catches
      this.garageRpm = 320 + Math.sin(now * 0.06) * 45;
      this.garageThr = 0.08;
      this.boostSpool = 0;
      if (this.wasmPhysicalAudioActive && this.workletNode && this.workletGain) {
        const b = this.wasmTelBuf;
        b.fill(0);
        b[0] = this.garageRpm;
        b[1] = redline;
        b[2] = 0.08;
        b[4] = 0.25;
        b[6] = this.resolveWasmTurboEnabled() ? 1 : 0;
        b[10] = 1; // starter_crank
        b[15] = 1; b[16] = 1;
        b[20] = this.resolveWasmExhaustStage();
        b[21] = 0; // ExteriorRear in garage
        b[22] = 0.34;
        b[23] = 0.22;
        this.workletNode.port.postMessage({ type: 'telemetry', data: b.slice(), active: !this.muted });
        this.workletGain.gain.setTargetAtTime(this.muted ? 0 : 1.0, t, 0.015);
        this.muteFallbackVehicleBuses(t);
        return;
      }
      e.g.gain.setTargetAtTime(0, t, 0.02);
      e.boostGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.stemEngMaster) this.stemEngMaster.gain.setTargetAtTime(0, t, 0.02);
      if (this.stemIntakeGain) this.stemIntakeGain.gain.setTargetAtTime(0, t, 0.02);
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
          this.garageLimCutUntil = now + 78; // authentic crisp fuel/ignition rev-limiter bounce (no gunshot spam!)
          if (!this.muted && !this.wasmPhysicalAudioActive && this.exhaustStage === 'race') {
            this.exhaustBurble(t, 0.55);
          }
          this.garageFlame = Math.max(this.garageFlame, 0.72 * stage.flameMul);
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

      // Overrun burbles (and rare high-RPM Race pop) when letting off Rev in Garage (skipped if WASM owns overrun)
      if (!this.wasmPhysicalAudioActive) {
        if (revPressed && this.garageRpm > redline * 0.65) {
          this.garageWasHighRpm = true;
          this.garageAntiLagRemaining = this.exhaustStage === 'race' ? 1 : 0;
          this.garageBurbleRemaining = this.exhaustStage === 'stock' ? 0 : 1 + Math.floor(Math.random() * 2);
        }
        if (!revPressed && this.garageWasHighRpm) {
          if (this.garageRpm > redline * 0.55 && this.garageAntiLagRemaining > 0 && !this.muted && t > this.nextCrackleAt) {
            const inten = Math.min(0.8, (this.garageRpm - 2800) / Math.max(2800, redline - 2800));
            this.exhaustPop(t, inten);
            this.garageFlame = Math.max(this.garageFlame, (0.55 + 0.25 * inten) * stage.flameMul);
            this.garageAntiLagRemaining--;
            this.nextCrackleAt = t + 0.34 + Math.random() * 0.22;
          } else if (this.garageAntiLagRemaining <= 0 && this.garageBurbleRemaining > 0 && this.garageRpm > 1900 && !this.muted && t > this.nextCrackleAt) {
            const bInten = clamp((this.garageRpm - 1600) / 3000, 0.30, 0.75);
            this.exhaustBurble(t, bInten);
            this.garageBurbleRemaining--;
            this.nextCrackleAt = t + 0.24 + Math.random() * 0.20;
          } else if (this.garageRpm <= 1900 || (this.garageAntiLagRemaining <= 0 && this.garageBurbleRemaining <= 0)) {
            this.garageWasHighRpm = false;
          }
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
    e.oBank.frequency.setTargetAtTime(f * vSpec.bankRatio * lope, t, tc);
    e.oHarm.frequency.setTargetAtTime(f * vSpec.harmRatio * lope, t, tc);

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

    // Real turbo spool stem + whistle OR supercharger whine (routed directly to out + reverb + slapback!)
    this.updateForcedInduction(vSpec, rpm, rpmNorm, thr, 0, safeDt, t, !this.muted && this.garageRunning);

    const topBright = vSpec.firingsPerRev >= 5 || this.voiceId === 'rotary_4' || this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' ? 2600 : 1800;
    const cutoff = Math.min(stage.toneCapHz, (320 + f * (2.2 + 5.8 * load) + rpmNorm * topBright * thr) * stage.toneScale);
    e.lp.frequency.setTargetAtTime(cutoff, t, tc);

    // Mute raw oscillator synth completely once all 4 real recorded engine stems are active (ZERO RC-car synth buzz!)
    e.g.gain.setTargetAtTime(stemsActive ? 0 : master, t, 0.03);
    // Warm enclosed showroom reverb & concrete early slapback reflections (works even in lowPower mode!)
    if (this.reverbSend) {
      this.reverbSend.gain.setTargetAtTime(this.muted ? 0 : 0.38, t, 0.08);
    }
    if (this.tunnelSend) {
      this.tunnelSend.gain.setTargetAtTime(this.muted ? 0 : 0.40, t, 0.08);
    }
    if (this.tunnelFb) {
      this.tunnelFb.gain.setTargetAtTime(this.muted ? 0 : 0.26, t, 0.08);
    }

    if (this.wasmPhysicalAudioActive && this.workletNode && this.workletGain) {
      this.syncWasmVoice();
      const b = this.wasmTelBuf;
      b.fill(0);
      b[0] = rpm;
      b[1] = redline;
      b[2] = thr;
      b[4] = load;
      b[5] = this.boostSpool * 1.45;
      b[6] = this.resolveWasmTurboEnabled() ? 1 : 0;
      b[8] = now < this.garageLimCutUntil ? 1 : 0;
      b[15] = 1; b[16] = 1;
      b[20] = this.resolveWasmExhaustStage();
      b[21] = 0; // ExteriorRear in showroom garage
      b[22] = 0.34;
      b[23] = 0.22;
      b[24] = 0.45;
      b[25] = 0.45;
      b[29] = this.exhaustStage === 'race' && this.resolveWasmTurboEnabled() ? 1 : 0;
      this.workletNode.port.postMessage({ type: 'telemetry', data: b.slice(), active: !this.muted });
      this.workletGain.gain.setTargetAtTime(this.muted ? 0 : spinFade, t, 0.02);
      this.muteFallbackVehicleBuses(t);
    } else if (this.workletGain) {
      this.workletGain.gain.setTargetAtTime(0, t, 0.02);
    }
  }

  /**
   * Realistic multi-mode Whelen CenCom / Federal Signal 100W police interceptor siren:
   * - Detuned dual-oscillator horn-speaker resonator stack (megaphone formant bandpass + presence peak + distance LP + soft saturation)
   * - Low-frequency Rumbler sub-layer (0.5x pitch) that kicks in at close range (> 0.55)
   * - Organic WAIL / YELP / PHASER mode cycling based on proximity & pursuit aggression
   * - 3D Doppler pitch shift, stereo panning, urban canyon reverb send, and dual-tone brass police airhorn bursts
   */
  siren(
    level: number,
    opts?: { doppler?: number; pan?: number; aggressive?: boolean; hornPulse?: number },
  ) {
    if (!this.ctx || !this.out) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const lvl = clamp(level, 0, 1);

    if (lvl <= 0.01 || this.muted) {
      if (this.srn) {
        this.srn.g.gain.setTargetAtTime(0, t, 0.10);
        this.srn.rumbleGain.gain.setTargetAtTime(0, t, 0.08);
        if (this.muted) {
          this.srn.airhornGain.gain.cancelScheduledValues(t);
          this.srn.airhornGain.gain.setTargetAtTime(0, t, 0.02);
        }
      }
      return;
    }

    if (!this.srn) {
      // Primary horn driver stack: sawtooth + 1.004x detuned square through soft PA saturation & megaphone formants
      const oMain = ctx.createOscillator();
      oMain.type = 'sawtooth';
      oMain.frequency.value = 1055;

      const oDet = ctx.createOscillator();
      oDet.type = 'square';
      oDet.frequency.value = 1055;
      oDet.detune.value = 7; // ~1.00405x subtle compression-driver chorus/detune

      const gMain = ctx.createGain();
      gMain.gain.value = 0.66;
      const gDet = ctx.createGain();
      gDet.gain.value = 0.24;

      const shaper = ctx.createWaveShaper();
      let hornCurve = this.shaperCache.get('siren_pa');
      if (!hornCurve) {
        hornCurve = warmExhaustCurve(2.2);
        this.shaperCache.set('siren_pa', hornCurve);
      }
      shaper.curve = hornCurve;
      shaper.oversample = '2x';

      // Dual resonant megaphone formant filter + distance-dependent atmospheric lowpass
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1350;
      bp.Q.value = 1.4;

      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 2500;
      peak.Q.value = 1.5;
      peak.gain.value = 5.5;

      const distLp = ctx.createBiquadFilter();
      distLp.type = 'lowpass';
      distLp.frequency.value = 2200;
      distLp.Q.value = 0.85;

      // Low-frequency Federal Signal Rumbler sub-layer (0.5x pitch, felt when cruiser is close)
      const oRumbler = ctx.createOscillator();
      oRumbler.type = 'sawtooth';
      oRumbler.frequency.value = 527.5;

      const rumbleLp = ctx.createBiquadFilter();
      rumbleLp.type = 'lowpass';
      rumbleLp.frequency.value = 380;
      rumbleLp.Q.value = 1.1;

      const rumbleGain = ctx.createGain();
      rumbleGain.gain.value = 0;

      // Shared LFO driving primary horn oscillators + half-depth Rumbler oscillator
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.21;

      const lg = ctx.createGain();
      lg.gain.value = 425;

      const lgSub = ctx.createGain();
      lgSub.gain.value = 212.5;

      lfo.connect(lg);
      lg.connect(oMain.frequency);
      lg.connect(oDet.frequency);
      lfo.connect(lgSub).connect(oRumbler.frequency);

      // Master siren gain -> StereoPanner -> out (+ urban reverb / tunnel send)
      const g = ctx.createGain();
      g.gain.value = 0;

      const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      if (panner) panner.pan.value = 0;

      oMain.connect(gMain).connect(shaper);
      oDet.connect(gDet).connect(shaper);
      shaper.connect(bp).connect(peak).connect(distLp).connect(g);
      oRumbler.connect(rumbleLp).connect(rumbleGain).connect(g);

      const airhornGain = ctx.createGain();
      airhornGain.gain.value = 1;

      if (panner) {
        g.connect(panner);
        airhornGain.connect(panner);
        panner.connect(this.out);
      } else {
        g.connect(this.out);
        airhornGain.connect(this.out);
      }

      // Urban street-canyon / tunnel echo send for realistic Manhattan bounce
      let revSend: GainNode | null = null;
      if (this.reverbSend || this.tunnelSend) {
        revSend = ctx.createGain();
        revSend.gain.value = 0.36;
        g.connect(revSend);
        airhornGain.connect(revSend);
        if (this.reverbSend) revSend.connect(this.reverbSend);
        if (this.tunnelSend) revSend.connect(this.tunnelSend);
      }

      oMain.start();
      oDet.start();
      oRumbler.start();
      lfo.start();

      this.srn = {
        oMain,
        oDet,
        oRumbler,
        lfo,
        lg,
        lgSub,
        distLp,
        rumbleGain,
        panner,
        g,
        airhornGain,
        revSend,
        mode: 'wail',
        modeSwitchAt: t + 3.5,
        lastAirhornAt: -10,
      };
    }

    const s = this.srn;
    const doppler = clamp(opts?.doppler ?? 1.0, 0.85, 1.18);
    const pan = clamp(opts?.pan ?? 0, -0.85, 0.85);
    const aggressive = Boolean(opts?.aggressive);

    // Organic Whelen CenCom mode selection based on proximity & tactical aggression
    let desiredMode: 'wail' | 'yelp' | 'phaser';
    if (aggressive || lvl >= 0.78) {
      if (s.mode !== 'phaser' && s.mode !== 'yelp') {
        s.mode = 'phaser';
        s.modeSwitchAt = t + 3.5;
      } else if (t >= s.modeSwitchAt) {
        s.mode = s.mode === 'phaser' ? 'yelp' : 'phaser';
        s.modeSwitchAt = t + 3.4 + Math.random() * 0.6;
      }
      desiredMode = s.mode;
    } else if (lvl >= 0.48) {
      desiredMode = 'yelp';
      s.mode = 'yelp';
      s.modeSwitchAt = t + 3.5;
    } else {
      desiredMode = 'wail';
      s.mode = 'wail';
      s.modeSwitchAt = t + 3.5;
    }

    // Mode pitch sweep ranges (authentic US 100W electronic police siren specs):
    // WAIL:   0.21 Hz, 630–1480 Hz (center 1055, depth 425)
    // YELP:   2.70 Hz, 660–1560 Hz (center 1110, depth 450)
    // PHASER: 8.20 Hz, 720–1450 Hz (center 1085, depth 365)
    let lfoHz = 0.21;
    let centerHz = 1055;
    let depthHz = 425;
    if (desiredMode === 'yelp') {
      lfoHz = 2.7;
      centerHz = 1110;
      depthHz = 450;
    } else if (desiredMode === 'phaser') {
      lfoHz = 8.2;
      centerHz = 1085;
      depthHz = 365;
    }

    const dCenter = centerHz * doppler;
    const dDepth = depthHz * doppler;
    s.lfo.frequency.setTargetAtTime(lfoHz, t, 0.04);
    s.oMain.frequency.setTargetAtTime(dCenter, t, 0.045);
    s.oDet.frequency.setTargetAtTime(dCenter, t, 0.045);
    s.oRumbler.frequency.setTargetAtTime(dCenter * 0.5, t, 0.045);
    s.lg.gain.setTargetAtTime(dDepth, t, 0.045);
    s.lgSub.gain.setTargetAtTime(dDepth * 0.5, t, 0.045);

    // Distance-dependent atmospheric air absorption: muffled 950 Hz far away -> crisp 4600 Hz right next to you
    const lpHz = 950 + Math.pow(lvl, 1.15) * (4600 - 950);
    s.distLp.frequency.setTargetAtTime(lpHz, t, 0.06);

    // Rumbler low-frequency sub-layer kicks in above 0.55 proximity
    const rumbleAmt = lvl > 0.55 ? clamp((lvl - 0.55) / 0.45, 0, 1) * 0.45 : 0;
    s.rumbleGain.gain.setTargetAtTime(rumbleAmt, t, 0.08);

    // Stereo panning + urban reverb wet ratio (more wet echo when further away)
    if (s.panner) s.panner.pan.setTargetAtTime(pan, t, 0.045);
    if (s.revSend) {
      const revAmt = clamp(0.22 + (1 - lvl) * 0.34 + this.envReverb * 0.28, 0.18, 0.72);
      s.revSend.gain.setTargetAtTime(revAmt, t, 0.08);
    }

    // Master siren gain (balanced so it cuts cleanly through engine + city mix without piercing)
    const targetGain = 0.032 + Math.pow(lvl, 1.1) * 0.145;
    s.g.gain.setTargetAtTime(targetGain, t, 0.08);
    s.airhornGain.gain.setTargetAtTime(1, t, 0.02);

    // Dual-tone brass police airhorn double-tap burst (2.8 s cooldown)
    if (opts?.hornPulse && opts.hornPulse > 0.5 && t - s.lastAirhornAt >= 2.8) {
      s.lastAirhornAt = t;
      this.firePoliceAirhorn(s.airhornGain, doppler, lvl);
    }
  }

  /** Brief authentic double-tap dual-tone brass police airhorn (385 Hz + 478 Hz sawtooth + 750 Hz bandpass). */
  private firePoliceAirhorn(dest: GainNode, doppler: number, level: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t0 = ctx.currentTime;
    const peakAmp = 0.065 + clamp(level, 0.2, 1) * 0.135;

    // Double-tap bursts: 0.22 s first blast, 0.07 s gap, 0.32 s second blast
    const bursts: [number, number][] = [
      [0.0, 0.22],
      [0.29, 0.32],
    ];

    let shaperCurve = this.shaperCache.get('siren_pa');
    if (!shaperCurve) {
      shaperCurve = warmExhaustCurve(2.2);
      this.shaperCache.set('siren_pa', shaperCurve);
    }

    for (const [offset, dur] of bursts) {
      const start = t0 + offset;
      const end = start + dur;

      const o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.setValueAtTime(385 * doppler, start);
      o1.frequency.exponentialRampToValueAtTime(378 * doppler, end);

      const o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.setValueAtTime(478 * doppler, start);
      o2.frequency.exponentialRampToValueAtTime(470 * doppler, end);

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 750;
      bp.Q.value = 1.15;

      const shaper = ctx.createWaveShaper();
      shaper.curve = shaperCurve;

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.linearRampToValueAtTime(peakAmp, start + 0.012);
      env.gain.setValueAtTime(peakAmp * 0.92, Math.max(start + 0.02, end - 0.035));
      env.gain.exponentialRampToValueAtTime(0.0001, end);

      o1.connect(bp);
      o2.connect(bp);
      bp.connect(shaper).connect(env).connect(dest);

      o1.start(start);
      o2.start(start);
      o1.stop(end + 0.02);
      o2.stop(end + 0.02);
    }
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
    if (!this.lowPower && this._audioEngineMode === 'engine_sim') {
      void this.initWasmWorklet();
    }
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

    // 4-zone engine combustion stem bus with stationary exhaust/muffler formants + cabin sub-bass + stereo Haas width:
    // sum(zone[0..3] + decel) -> stemF1 -> stemF2 -> stemF3 -> stemCabinSub -> stemToneFilter -> stemShaper -> Haas Stereo Merger -> stemEngMaster -> out (+ reverbSend + tunnelSend)
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

    // Dedicated 95 Hz interior cabin chassis sub-bass resonator (smoothly boosted +2.5 dB in cockpit perspective)
    const stemCabinSub = ctx.createBiquadFilter();
    stemCabinSub.type = 'peaking';
    stemCabinSub.frequency.value = 95;
    stemCabinSub.Q.value = 1.15;
    stemCabinSub.gain.value = 0;

    const stemToneFilter = ctx.createBiquadFilter();
    stemToneFilter.type = 'lowpass';
    stemToneFilter.frequency.value = 1800;
    stemToneFilter.Q.value = 0.78;

    const stemShaper = ctx.createWaveShaper();
    const initStage = EXHAUST_PROFILES[this.exhaustStage];
    let warmC = this.shaperCache.get(initStage.shaperKey);
    if (!warmC) { warmC = warmExhaustCurve(initStage.shaperDrive); this.shaperCache.set(initStage.shaperKey, warmC); }
    stemShaper.curve = warmC;
    stemShaper.oversample = 'none';
    this.appliedExhaustShaperKey = initStage.shaperKey;

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

    // Zero-stutter 4-tap stereo tunnel & canyon slapback reflection network (runs cleanly even in lowPower mode!)
    // Taps at 11 ms (L), 23 ms (R), 39 ms (L), 57 ms (R) + single 2.8 kHz LP damping filter + feedback strictly <= 0.42
    const tunnelSend = ctx.createGain();
    tunnelSend.gain.value = 0;
    const tunnelIn = ctx.createGain();
    tunnelIn.gain.value = 1.0;
    tunnelSend.connect(tunnelIn);

    const tap1 = ctx.createDelay(0.08); tap1.delayTime.value = 0.011;
    const tap2 = ctx.createDelay(0.08); tap2.delayTime.value = 0.023;
    const tap3 = ctx.createDelay(0.08); tap3.delayTime.value = 0.039;
    const tap4 = ctx.createDelay(0.08); tap4.delayTime.value = 0.057;
    const tap1G = ctx.createGain(); tap1G.gain.value = 0.46;
    const tap2G = ctx.createGain(); tap2G.gain.value = 0.38;
    const tap3G = ctx.createGain(); tap3G.gain.value = 0.32;
    const tap4G = ctx.createGain(); tap4G.gain.value = 0.28;

    const tunnelMerger = ctx.createChannelMerger(2);
    const tunnelOut = ctx.createGain();
    tunnelOut.gain.value = 0.56;

    tunnelIn.connect(tap1); tap1.connect(tap1G).connect(tunnelMerger, 0, 0);
    tunnelIn.connect(tap2); tap2.connect(tap2G).connect(tunnelMerger, 0, 1);
    tunnelIn.connect(tap3); tap3.connect(tap3G).connect(tunnelMerger, 0, 0);
    tunnelIn.connect(tap4); tap4.connect(tap4G).connect(tunnelMerger, 0, 1);
    tunnelMerger.connect(tunnelOut).connect(this.out);

    const tunnelDamp = ctx.createBiquadFilter();
    tunnelDamp.type = 'lowpass';
    tunnelDamp.frequency.value = 2800;
    tunnelDamp.Q.value = 0.707;
    const tunnelFb = ctx.createGain();
    tunnelFb.gain.value = 0.28; // Strictly clamped <= 0.42 everywhere so loop gain < 1 at all frequencies
    tap4.connect(tunnelDamp).connect(tunnelFb).connect(tunnelIn);

    this.tunnelSend = tunnelSend;
    this.tunnelFb = tunnelFb;

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

    stemF1.connect(stemF2).connect(stemF3).connect(stemCabinSub).connect(stemToneFilter).connect(stemShaper);
    stemMerger.connect(stemEngMaster).connect(this.out);
    if (this.reverbSend) stemEngMaster.connect(this.reverbSend);
    stemEngMaster.connect(tunnelSend);
    if (this.eng) {
      this.eng.g.connect(tunnelSend);
      this.eng.boostGain.connect(tunnelSend);
    }

    this.stemF1 = stemF1;
    this.stemF2 = stemF2;
    this.stemF3 = stemF3;
    this.stemCabinSub = stemCabinSub;
    this.stemToneFilter = stemToneFilter;
    this.stemShaper = stemShaper;
    this.stemCenter = stemCenter;
    this.stemHaasGainL = stemHaasGainL;
    this.stemHaasGainR = stemHaasGainR;
    this.stemEngMaster = stemEngMaster;

    // Persistent engine-bay induction intake roar layer (adds hood & cockpit intake prominence when stems are active)
    if (this.noise) {
      const inSrc = ctx.createBufferSource();
      inSrc.buffer = this.noise;
      inSrc.loop = true;
      const inFilt = ctx.createBiquadFilter();
      inFilt.type = 'bandpass';
      inFilt.frequency.value = 650;
      inFilt.Q.value = 1.9;
      const inGain = ctx.createGain();
      inGain.gain.value = 0;
      inSrc.connect(inFilt).connect(inGain).connect(this.out);
      inGain.connect(tunnelSend);
      inSrc.start();
      this.stemIntakeFilter = inFilt;
      this.stemIntakeGain = inGain;
    }

    // Persistent low-CPU carbon-ceramic brake hiss & metallic squeal nodes (zero per-frame allocations!)
    if (this.noise) {
      const bNoise = ctx.createBufferSource();
      bNoise.buffer = this.noise;
      bNoise.loop = true;

      const bHissFilter = ctx.createBiquadFilter();
      bHissFilter.type = 'bandpass';
      bHissFilter.frequency.value = 1800;
      bHissFilter.Q.value = 1.6;
      const bHissGain = ctx.createGain();
      bHissGain.gain.value = 0;

      const bOsc = ctx.createOscillator();
      bOsc.type = 'sine';
      bOsc.frequency.value = 2950;
      const bOscMix = ctx.createGain();
      bOscMix.gain.value = 0.16;
      const bNoiseMix = ctx.createGain();
      bNoiseMix.gain.value = 0.88;

      const bSquealFilter = ctx.createBiquadFilter();
      bSquealFilter.type = 'bandpass';
      bSquealFilter.frequency.value = 2950;
      bSquealFilter.Q.value = 22;
      const bSquealGain = ctx.createGain();
      bSquealGain.gain.value = 0;

      const bMaster = ctx.createGain();
      bMaster.gain.value = 0;

      bNoise.connect(bHissFilter).connect(bHissGain).connect(bMaster);
      bNoise.connect(bNoiseMix).connect(bSquealFilter);
      bOsc.connect(bOscMix).connect(bSquealFilter);
      bSquealFilter.connect(bSquealGain).connect(bMaster);
      bMaster.connect(this.out);

      bNoise.start();
      bOsc.start();

      this.brakeOsc = bOsc;
      this.brakeHissFilter = bHissFilter;
      this.brakeHissGain = bHissGain;
      this.brakeSquealFilter = bSquealFilter;
      this.brakeSquealGain = bSquealGain;
      this.brakeGain = bMaster;
    }

    // Dedicated independent forced-induction & FX stem gain buses (zeroed until update modulates them)
    const mkFxBus = (toReverb = false) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out!);
      if (toReverb) {
        if (this.reverbSend) g.connect(this.reverbSend);
        g.connect(tunnelSend);
      }
      return g;
    };
    this.stemTurboGain = mkFxBus(true);
    this.stemGearGain = mkFxBus(false);
    this.stemDryTyreGain = mkFxBus(false);
    this.stemWetSprayGain = mkFxBus(false);
    this.stemKerbGain = mkFxBus(false);
  }

  private stemPackDir(): 'audio_real' | 'audio' {
    return this._audioEngineMode === 'real_samples' ? 'audio_real' : 'audio';
  }

  private stemKey(id: string, dir: 'audio_real' | 'audio' = this.stemPackDir()): string {
    return `${dir}:${id}`;
  }

  private preloadVoiceStems(voice: EngineVoiceId) {
    const zones = ENGINE_STEM_ZONES[voice] ?? ENGINE_STEM_ZONES.v8_crossplane;
    const decel = ENGINE_DECEL_STEM[voice] ?? ENGINE_DECEL_STEM.v8_crossplane;
    // Queue decel only for engine_sim pack (real_samples shapes closed-throttle decel cleanly on the 4 real zones without synthetic blend)
    if (this._audioEngineMode === 'engine_sim') {
      this.enqueueStem(decel.id, true);
    }
    for (let i = zones.length - 1; i >= 0; i--) this.enqueueStem(zones[i].id, true);
  }

  private preloadFxStems() {
    for (const id of FX_LOOP_STEMS) this.enqueueStem(id, false);
    for (const id of FX_ONESHOT_STEMS) this.enqueueStem(id, false);
  }

  private enqueueStem(id: string, highPriority: boolean) {
    const key = this.stemKey(id);
    if (this.stemBuffers.has(key) || this.stemAttempted.has(key)) return;
    if (this.stemQueue.includes(key)) {
      if (highPriority) {
        this.stemQueue = [key, ...this.stemQueue.filter((x) => x !== key)];
      }
      return;
    }
    if (highPriority) this.stemQueue.unshift(key);
    else this.stemQueue.push(key);
    if (!this.stemDecoding) void this.drainStemQueue();
  }

  /** Serialized 1-at-a-time fetch + decode with 20 ms frame yields so decoding NEVER freezes gameplay or Ignition/Rev! */
  private async drainStemQueue(): Promise<void> {
    if (this.stemDecoding) return;
    this.stemDecoding = true;
    try {
      while (this.stemQueue.length > 0 && this.ctx) {
        const key = this.stemQueue.shift()!;
        await this.loadStem(key);
        // Yield at least 1 render frame (~20 ms) before starting the next OGG decode so WebGPU stays butter-smooth
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    } finally {
      this.stemDecoding = false;
    }
  }

  /** Non-blocking fetch + decode for `/assets/<pack>/<id>.ogg` with one-time caching and silent fallback. */
  private async loadStem(key: string): Promise<void> {
    if (this.stemBuffers.has(key) || this.stemAttempted.has(key)) return;
    const ctx = this.ctx;
    if (!ctx || typeof fetch !== 'function') return;
    this.stemAttempted.add(key);
    const sep = key.indexOf(':');
    const dir = sep > 0 ? key.slice(0, sep) : this.stemPackDir();
    const id = sep > 0 ? key.slice(sep + 1) : key;
    try {
      const res = await fetch(pubUrl(`/assets/${dir}/${id}.ogg`));
      if (!res.ok) return;
      const ab = await res.arrayBuffer();
      if (!this.ctx) return;
      const buf = await this.ctx.decodeAudioData(ab);
      this.stemBuffers.set(key, buf);
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
      const zk = this.stemKey(z.id);
      const zg = this.stemZoneGains[i];
      if (!zg) continue;
      if (this.stemZoneIds[i] !== zk || (!this.stemZoneSrcs[i] && this.stemBuffers.has(zk))) {
        const old = this.stemZoneSrcs[i];
        if (old) {
          try { old.stop(); old.disconnect(); } catch {}
          this.stemZoneSrcs[i] = null;
          this.stemZoneIds[i] = null;
        }
        const buf = this.stemBuffers.get(zk);
        if (buf) {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.playbackRate.value = clamp(curRpm / z.refRpm, 0.68, 1.42);
          src.connect(zg);
          src.start();
          this.stemZoneSrcs[i] = src;
          this.stemZoneIds[i] = zk;
        }
      }
    }

    const decel = ENGINE_DECEL_STEM[this.voiceId] ?? ENGINE_DECEL_STEM.v8_crossplane;
    const dk = this.stemKey(decel.id);
    if (this.stemDecelGain && (this.stemDecelId !== dk || (!this.stemDecelSrc && this.stemBuffers.has(dk)))) {
      if (this.stemDecelSrc) {
        try { this.stemDecelSrc.stop(); this.stemDecelSrc.disconnect(); } catch {}
        this.stemDecelSrc = null;
        this.stemDecelId = null;
      }
      const dBuf = this.stemBuffers.get(dk);
      if (dBuf) {
        const src = ctx.createBufferSource();
        src.buffer = dBuf;
        src.loop = true;
        src.playbackRate.value = clamp(curRpm / decel.refRpm, 0.42, 1.65);
        src.connect(this.stemDecelGain);
        src.start();
        this.stemDecelSrc = src;
        this.stemDecelId = dk;
      }
    }
  }

  private hasAllEngineStems(): boolean {
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    for (let i = 0; i < 4; i++) {
      if (this.stemZoneSrcs[i] === null || this.stemZoneIds[i] !== this.stemKey(zones[i].id)) return false;
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
      if (this.stemIntakeGain) this.stemIntakeGain.gain.setTargetAtTime(0, t, 0.03);
      return false;
    }
    const zones = ENGINE_STEM_ZONES[this.voiceId] ?? ENGINE_STEM_ZONES.v8_crossplane;
    const decelZone = ENGINE_DECEL_STEM[this.voiceId] ?? ENGINE_DECEL_STEM.v8_crossplane;
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const stage = EXHAUST_PROFILES[this.exhaustStage];

    // Strictly bounded playbackRate [0.68, 1.42] per zone (gentle idle lope ONLY on z0 below 1250 RPM at closed throttle)
    for (let i = 0; i < 4; i++) {
      const src = this.stemZoneSrcs[i]!;
      const lopeScale = i === 0 ? stemLope : 1;
      const rate = clamp((rpm / zones[i].refRpm) * lopeScale, 0.68, 1.42);
      src.playbackRate.setTargetAtTime(rate, t, tc);
    }

    // Forza-grade ON-LOAD <-> OFF-LOAD DECEL dynamic crossfade (closed-throttle vacuum engine braking)
    const hasDecel = this.stemDecelSrc !== null && this.stemDecelId === this.stemKey(decelZone.id) && this.stemDecelGain !== null;
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

    // Load-responsive warm exhaust filter modulated by Camera Perspective (cockpit ~2800-4200 Hz cap) & Exhaust Stage
    const thrClamped = clamp(thr, 0, 1);
    const baseOpen = (1450 + rpmNorm * 1450) * stage.toneScale * cam.toneScale;
    const wotOpen = Math.pow(thrClamped, 0.85) * (6600 + rpmNorm * 4300) * stage.toneScale * cam.toneScale;
    const decelClose = isDecel ? -280 : 0;
    const camCap = this.cameraPerspective === 'cockpit'
      ? 2800 + thrClamped * 900 + rpmNorm * 500
      : cam.toneCapHz;
    const maxCap = Math.min(camCap, stage.toneCapHz);
    const toneCutoff = clamp(baseOpen + wotOpen + decelClose, 1050, maxCap);
    this.stemToneFilter.frequency.setTargetAtTime(toneCutoff, t, tc);

    if (this.stemF2) {
      const decelBoost = isDecel ? 0.9 : 0;
      this.stemF2.gain.setTargetAtTime(0.8 + cam.f2GainOff + stage.f2GainOff + decelBoost, t, 0.05);
    }

    // Engine-bay induction intake roar layer (gives authentic hood/cockpit intake prominence alongside real stems)
    if (this.stemIntakeFilter && this.stemIntakeGain) {
      const inFreq = clamp(320 + rpm * 0.19 + thrClamped * 420, 320, 2600);
      const inGain = master > 0.001
        ? clamp(Math.pow(thrClamped, 1.45) * (0.020 + 0.055 * rpmNorm) * cam.intakeMul, 0, 0.14)
        : 0;
      this.stemIntakeFilter.frequency.setTargetAtTime(inFreq, t, tc);
      this.stemIntakeGain.gain.setTargetAtTime(inGain, t, tc);
    }

    this.stemEngMaster.gain.setTargetAtTime(Math.min(0.98, master * 1.48), t, 0.03);
    return true;
  }

  /**
   * Independent forced-induction mix (Real Nissan GT-R Turbo spool loop OR Helical Supercharger whine).
   * Routed directly to `this.out` + `this.reverbSend` + `this.tunnelSend` so engine synth ducking NEVER silences boost!
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
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const boostMode = vSpec.boost !== 'none' ? vSpec.boost : (this.extraTurbo ? 'turbo' : 'none');

    if (boostMode === 'supercharger' && active) {
      this.boostSpool = 0;
      if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.03);
      const scFreq = 880 + rpm * 0.28;
      e.oBoost.frequency.setTargetAtTime(scFreq, t, 0.02);
      e.boostFilter.frequency.setTargetAtTime(scFreq, t, 0.025);
      e.boostFilter.Q.setTargetAtTime(2.4, t, 0.04);
      const scGain = (0.02 + 0.12 * smoothThr) * (0.28 + 0.72 * rpmNorm) * cam.boostMul;
      e.boostGain.gain.setTargetAtTime(clamp(scGain, 0, 0.19), t, 0.025);
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
        const tGain = clamp(Math.pow(spoolLevel, 1.1) * 0.22 * (0.35 + 0.65 * smoothThr) * cam.boostMul, 0, 0.34);
        this.stemTurboGain.gain.setTargetAtTime(tGain, t, 0.035);
      }
      // Mute harsh raw sine oscillator whenever real turbo_spool_loop stem is loaded!
      const tFreq = 1900 + this.boostSpool * 2600;
      e.oBoost.frequency.setTargetAtTime(tFreq, t, 0.03);
      e.boostFilter.frequency.setTargetAtTime(tFreq, t, 0.03);
      e.boostFilter.Q.setTargetAtTime(3.2, t, 0.04);
      e.boostGain.gain.setTargetAtTime(this.stemTurboSrc ? 0 : spoolLevel * 0.08 * cam.boostMul, t, 0.03);
    } else {
      this.boostSpool *= Math.exp(-dt / 0.18);
      e.boostGain.gain.setTargetAtTime(0, t, 0.035);
      if (this.stemTurboGain) this.stemTurboGain.gain.setTargetAtTime(0, t, 0.035);
    }

    return boostMode;
  }

  private playStemOneShot(
    id: string,
    at: number,
    gain: number,
    playbackRate: number,
    toReverb = false,
    lowpassHz = 0,
  ): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.out || this._muted) return false;
    const buf = this.stemBuffers.get(this.stemKey(id))
      ?? this.stemBuffers.get(`audio_real:${id}`)
      ?? this.stemBuffers.get(`audio:${id}`);
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = playbackRate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, gain), at);
    if (lowpassHz > 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lowpassHz;
      lp.Q.value = 0.75;
      src.connect(lp).connect(g);
    } else {
      src.connect(g);
    }
    g.connect(this.out);
    if (toReverb) {
      if (this.reverbSend) g.connect(this.reverbSend);
      if (this.tunnelSend) g.connect(this.tunnelSend);
    }
    src.start(at);
    return true;
  }

  private triggerTurboBov(t: number, intensity = 1) {
    if (this._muted) return;
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const bovScale = 0.72 + 0.28 * cam.boostMul;
    const inten = clamp(intensity, 0.5, 1.2) * bovScale;
    if (this.wasmPhysicalAudioActive) {
      this.postWasmTrigger('flutter', inten);
      return;
    }
    const rate = 0.94 + Math.random() * 0.12;
    if (this.playStemOneShot('turbo_flutter_bov', t, 0.74 * inten, rate, true, cam.popLpHz > 0 ? 3400 : 0)) {
      return;
    }
    for (let k = 0; k < 4; k++) {
      this.burst(t + k * 0.048, 0.045, 'bandpass', 3200 - k * 300, 4.4, 0.18 * inten * (1 - k * 0.17), true);
    }
  }

  /** Clean motorsport downshift rev-match blip (subtle warm exhaust burble, never a gunshot). */
  private downshiftBlipSound(t: number, intensity: number) {
    if (this._muted || this.wasmPhysicalAudioActive) return;
    const inten = clamp(intensity, 0.30, 0.75);
    this.exhaustBurble(t + 0.03, inten * 0.75);
  }

  /**
   * Persistent zero-allocation carbon-ceramic brake acoustics:
   * - Subtle high-speed drilled-rotor hiss/whir under braking
   * - Faint authentic metallic squeal chirp (2600-3400 Hz high-Q) ONLY under firm braking at medium-low speeds (4..26 m/s) when rotors are warm (> 120°C)
   */
  updateBrakes(brakePressure: number, speedMps: number, rotorTempC: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.brakeGain || !this.brakeHissFilter || !this.brakeHissGain || !this.brakeSquealFilter || !this.brakeSquealGain || !this.brakeOsc) {
      return;
    }
    const t = ctx.currentTime;
    if (this.wasmPhysicalAudioActive) {
      this.brakeGain.gain.setTargetAtTime(0, t, 0.02);
      this.brakeHissGain.gain.setTargetAtTime(0, t, 0.02);
      this.brakeSquealGain.gain.setTargetAtTime(0, t, 0.02);
      return;
    }
    const bp = clamp(brakePressure, 0, 1);
    const spd = Math.abs(speedMps);
    const cam = CAMERA_PROFILES[this.cameraPerspective];

    if (this.muted || cam.brakeMul <= 0 || bp < 0.04 || spd < 0.8) {
      this.brakeGain.gain.setTargetAtTime(0, t, 0.025);
      this.brakeHissGain.gain.setTargetAtTime(0, t, 0.025);
      this.brakeSquealGain.gain.setTargetAtTime(0, t, 0.025);
      return;
    }

    // Subtle carbon-ceramic drilled-rotor hiss/whir at higher road speeds
    const hissEnv = clamp((spd - 4) / 48, 0, 1) * Math.pow(bp, 0.85);
    const hissFreq = clamp(1200 + spd * 34 + bp * 450, 1200, 4200);
    const hissAmp = hissEnv * 0.065 * cam.brakeMul;
    this.brakeHissFilter.frequency.setTargetAtTime(hissFreq, t, 0.03);
    this.brakeHissGain.gain.setTargetAtTime(hissAmp, t, 0.03);

    // Authentic carbon-ceramic squeal chirp: strictly gated to firm braking, 4..26 m/s, warm rotors > 120°C
    let squealAmp = 0;
    if (bp > 0.32 && spd > 4 && spd < 26 && rotorTempC > 120) {
      const spdBell = clamp((spd - 4) / 4, 0, 1) * clamp((26 - spd) / 7, 0, 1);
      const tempFactor = clamp((rotorTempC - 120) / 220, 0, 1);
      const pressFactor = clamp((bp - 0.32) / 0.53, 0, 1);
      const shimmer = 0.72 + 0.28 * Math.sin(t * 23.0 + spd * 1.7);
      const squealHz = clamp(2680 + (1 - spd / 26) * 440 + bp * 190 + Math.sin(t * 9.5) * 45, 2600, 3400);
      this.brakeSquealFilter.frequency.setTargetAtTime(squealHz, t, 0.025);
      this.brakeOsc.frequency.setTargetAtTime(squealHz, t, 0.025);
      squealAmp = spdBell * tempFactor * pressFactor * shimmer * 0.042 * cam.brakeMul;
    }
    this.brakeSquealGain.gain.setTargetAtTime(squealAmp, t, 0.025);
    this.brakeGain.gain.setTargetAtTime(hissAmp + squealAmp > 0.0004 ? 1.0 : 0, t, 0.02);
  }

  /**
   * Deep chassis compression thump on heavy landings, curb strikes, and suspension bottom-out
   * (58 -> 24 Hz damped sine + short 160 Hz lowpass rubber thud, rate-limited to prevent spam).
   */
  suspensionThump(intensity: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.out || ctx.state !== 'running' || this.muted) return;
    const inten = clamp(intensity, 0, 1);
    if (inten < 0.06) return;
    const t = ctx.currentTime;
    if (this.lastSuspThumpAt >= 0 && t < this.lastSuspThumpAt + 0.095) return;
    this.lastSuspThumpAt = t;

    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const scale = cam.thumpMul;
    // Deep damped chassis sine (58 -> 24 Hz)
    this.tone(t, 0.14 + 0.12 * inten, 58, 24, 'sine', clamp((0.20 + 0.44 * inten) * scale, 0.05, 0.72));
    // Short 160 Hz lowpass bump-stop rubber thud
    this.burst(t, 0.055 + 0.055 * inten, 'lowpass', 160, 0.9, clamp((0.16 + 0.36 * inten) * scale, 0.04, 0.58));
    // Subtle shock-tower knuckle knock on hard suspension bottom-outs
    if (inten > 0.65) {
      this.tone(t + 0.006, 0.075, 118, 46, 'triangle', 0.14 * (inten - 0.5) * scale);
    }
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
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const stage = EXHAUST_PROFILES[this.exhaustStage];
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

    // Crisp redline rev-limiter bounce: clean rhythmic ignition cut ONLY (ZERO gunshot spam at top speed!)
    let limDip = 1.0;
    if (!stalled && rawRpm >= redline * 0.980 && rawThr > 0.65) {
      if (nowMs >= this.revLimiterNextToggle) {
        this.revLimiterCutUntil = nowMs + 34;
        this.revLimiterNextToggle = nowMs + 84;
      }
      if (nowMs < this.revLimiterCutUntil) limDip = 0.64;
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
    e.oBank.frequency.setTargetAtTime(f * vSpec.bankRatio * lope, t, tc);
    e.oHarm.frequency.setTargetAtTime(f * vSpec.harmRatio * lope, t, tc);

    // Exhaust gas flow & intake induction roar (fallback synth)
    const rpmNorm = clamp((rpm - 650) / Math.max(5500, redline - 650), 0, 1);
    e.exhaustFilter.frequency.setTargetAtTime(160 + f * 1.9, t, tc);
    e.exhaustGain.gain.setTargetAtTime(0.18 + 0.42 * load + 0.22 * rpmNorm, t, tc);

    e.intakeFilter.frequency.setTargetAtTime(280 + f * 2.8, t, tc);
    e.intakeGain.gain.setTargetAtTime(thr * thr * (0.28 + 0.36 * rpmNorm) * cam.intakeMul, t, tc);

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

    // Dynamic low-pass for fallback synth (respects camera perspective & exhaust stage)
    const topBright = vSpec.firingsPerRev >= 5 || this.voiceId === 'rotary_4' || this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' ? 2600 : 1800;
    const camCap = this.cameraPerspective === 'cockpit'
      ? 2800 + clamp(thr, 0, 1) * 900 + rpmNorm * 500
      : cam.toneCapHz;
    const cutoff = Math.min(
      Math.min(camCap, stage.toneCapHz),
      (320 + f * (2.2 + 5.8 * load) + rpmNorm * topBright * thr) * stage.toneScale * cam.toneScale,
    );
    e.lp.frequency.setTargetAtTime(cutoff, t, tc);

    // Decay driving exhaust flame smoothly between anti-lag pops & upshift bangs
    this.drivingFlame = Math.max(0, this.drivingFlame - dt * 5.2);

    // Mute raw oscillator synth completely once all 4 real recorded engine stems are active (ZERO RC-car synth buzz!)
    e.g.gain.setTargetAtTime(stemsActive ? 0 : master, t, 0.03);

    // Slow layers (80-140 ms smoothing) glide smoothly at ~30 Hz
    const slow = t - this.slowAt >= 0.03 || t < this.slowAt;
    if (slow) this.slowAt = t;
    if (slow) {
      // Narrow tunnels/walled canyons/bridges echo exhaust + turbo + BOV via both Convolver (if enabled) and zero-stutter 4-tap stereo slapback
      const tunnelEnv = clamp(Math.max(this.envReverb, cam.tunnelFloor), 0, 1);
      if (this.reverbSend) {
        this.reverbSend.gain.setTargetAtTime(this.muted ? 0 : tunnelEnv * 0.64 * cam.tunnelMul, t, 0.08);
      }
      if (this.tunnelSend) {
        this.tunnelSend.gain.setTargetAtTime(this.muted ? 0 : tunnelEnv * 0.62 * cam.tunnelMul, t, 0.08);
      }
      if (this.tunnelFb) {
        // Strictly clamp feedback gain <= 0.42 so it can NEVER self-oscillate or clip!
        this.tunnelFb.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.42, 0.16 + tunnelEnv * 0.26), t, 0.08);
      }
    }

    // Distinct rolling tire surface audio: wet spray stem (up to 0.44) + fallback hiss / gravel crunch / dry asphalt
    if (slow) {
      const wetAmt = this.onGravel ? 0 : Math.max(0, (this.roadWetness - 0.15) / 0.85);
      const spdFrac = Math.min(1, kmh / 170);
      if (this.stemWetSpraySrc && this.stemWetSprayGain) {
        this.stemWetSpraySrc.playbackRate.setTargetAtTime(clamp(0.68 + spdFrac * 0.78, 0.6, 1.75), t, 0.08);
        this.stemWetSprayGain.gain.setTargetAtTime(this.muted ? 0 : wetAmt * Math.pow(spdFrac, 1.15) * 0.44 * cam.tyreMul, t, 0.08);
      }
      if (this.roadRoll) {
        const rollFrac = Math.min(1, kmh / 180);
        const targetFreq = this.onGravel ? 240 + kmh * 2.2 : this.roadWetness > 0.55 ? 1650 + kmh * 9.5 : 460 + kmh * 3.2;
        const wetDuck = this.stemWetSpraySrc && !this.onGravel && this.roadWetness > 0.35 ? 1 - 0.78 * wetAmt : 1;
        const targetGain = this.muted ? 0 : rollFrac * (this.onGravel ? 0.15 : this.roadWetness > 0.55 ? 0.11 : 0.055) * wetDuck * cam.tyreMul;
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
      this.stemKerbGain.gain.setTargetAtTime(this.muted ? 0 : kerbExcite * 0.52 * cam.kerbMul, t, 0.025);
    }
    if (this.cavity) {
      const fLo = Math.max(120, Math.min(340, out[OUT.cavityLowHz] || 220));
      const fHi = Math.max(130, Math.min(380, out[OUT.cavityHighHz] || 228));
      this.cavity.fLo.frequency.setTargetAtTime(fLo, t, 0.03);
      this.cavity.fHi.frequency.setTargetAtTime(fHi, t, 0.03);
      this.cavity.g.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.24, peakCav * 0.22) * (this.stemKerbSrc ? 0.25 : 1) * cam.kerbMul, t, 0.025);
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

    // Real BMW M3 GTR straight-cut gearbox whine — subtle & authentic above 55 km/h (+45% in cockpit!)
    const isRaceBox = this.voiceId === 'flat6_na' || this.voiceId === 'flat8_na' || this.voiceId === 'v8_flatplane' || this.voiceId === 'v10_screamer' || this.voiceId === 'v12_na';
    const gearPresence = clamp((kmh - 55) / 85, 0, 1);
    const gearMaxGain = isRaceBox ? 0.11 : 0.045;
    const gearFreq = Math.max(240, absSpeed * 22 + rpm * 0.09);
    e.oGear.frequency.setTargetAtTime(gearFreq, t, 0.03);
    const stemWhine = this.muted || stalled
      ? 0
      : gearPresence * Math.pow(clamp(kmh / 220, 0, 1), 0.9) * gearMaxGain * (0.25 + 0.75 * thr) * cam.gearMul;
    if (this.stemGearSrc && this.stemGearGain) {
      const gearRate = clamp(0.55 + (absSpeed / 78) * 0.95 + (rpm / 10000) * 0.18, 0.52, 1.62);
      this.stemGearSrc.playbackRate.setTargetAtTime(gearRate, t, 0.035);
      this.stemGearGain.gain.setTargetAtTime(stemWhine, t, 0.04);
    }
    // Mute synthetic triangle gear oscillator when real BMW M3 GTR stem is loaded!
    e.gearGain.gain.setTargetAtTime(this.stemGearSrc ? 0 : stemWhine * 0.35, t, 0.04);

    this.lastRpm = rawRpm;

    // Multi-tier off-throttle exhaust acoustics (ONLY in WebAudio fallback mode — when WASM physical audio is active,
    // C++ engine_audio.cpp handles overrun cleanly so we NEVER double-trigger gunshots on throttle lift!)
    if (!this.wasmPhysicalAudioActive) {
      if (thr > 0.62 && rpm > redline * 0.70) {
        this.wasOnThrottle = true;
        this.wasMidThrottle = false;
        this.antiLagRemaining = 0;
        this.burbleRemaining = 0;
      } else if (thr > 0.25 && rpm >= 2400 && rpm <= 4800) {
        this.wasMidThrottle = true;
        this.burbleRemaining = 0;
      } else if (this.wasOnThrottle && !tcActive && rawThr < 0.10 && rpm > redline * 0.62) {
        this.wasOnThrottle = false;
        this.wasMidThrottle = false;
        if (stage.popCountMin > 0 && Math.random() <= stage.popChance) {
          this.antiLagRemaining = stage.popCountMin + Math.floor(Math.random() * stage.popCountSpan);
          this.antiLagUntil = t + 1.4;
          this.nextCrackleAt = t + 0.18 + Math.random() * 0.14;
        } else if (this.exhaustStage !== 'stock') {
          this.burbleRemaining = stage.burbleCountMin + Math.floor(Math.random() * stage.burbleCountSpan);
          this.burbleUntil = t + 1.8;
          this.nextBurbleAt = t + 0.16 + Math.random() * 0.14;
        }
      } else if (this.wasMidThrottle && !tcActive && rawThr < 0.10 && rpm >= 2400 && rpm <= 4800 && this.antiLagRemaining === 0 && this.exhaustStage !== 'stock') {
        this.wasMidThrottle = false;
        this.burbleRemaining = stage.burbleCountMin + Math.floor(Math.random() * stage.burbleCountSpan);
        this.burbleUntil = t + 1.9;
        this.nextBurbleAt = t + 0.18 + Math.random() * 0.14;
      } else if (rawThr > 0.18 || rpm < 1800) {
        this.antiLagRemaining = 0;
        this.burbleRemaining = 0;
        if (rpm < 2200) {
          this.wasOnThrottle = false;
          this.wasMidThrottle = false;
        }
      }

      if (!this.muted && !stalled && this.antiLagRemaining > 0 && t < this.antiLagUntil && t >= this.nextCrackleAt) {
        const inten = clamp((rpm - 2600) / Math.max(2800, redline - 2600), 0.40, 0.85);
        this.exhaustPop(t, inten);
        this.antiLagRemaining--;
        if (this.antiLagRemaining === 0 && this.exhaustStage !== 'stock' && rpm > 2100) {
          this.burbleRemaining = 1 + (this.exhaustStage === 'race' ? 1 : 0);
          this.burbleUntil = t + 1.6;
          this.nextBurbleAt = t + 0.28 + Math.random() * 0.16;
        } else {
          this.nextCrackleAt = t + 0.34 + Math.random() * 0.26;
        }
      } else if (!this.muted && !stalled && this.antiLagRemaining === 0 && this.burbleRemaining > 0 && t < this.burbleUntil && t >= this.nextBurbleAt && rpm > 1900) {
        const bInten = clamp((rpm - 1800) / 2900, 0.30, 0.78);
        this.exhaustBurble(t, bInten);
        this.burbleRemaining--;
        this.nextBurbleAt = t + 0.24 + Math.random() * 0.22;
      }
    } else {
      this.wasOnThrottle = false;
      this.wasMidThrottle = false;
      this.antiLagRemaining = 0;
      this.burbleRemaining = 0;
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
    // LMU pre-squeal brush contact-patch micro-slip scrub cue: wakes subtly as front adhesion drops below 0.84 (~100 ms before squeal!)
    const frontAdh = (out.length > OUT.frontAdhesionRatio && out[OUT.frontAdhesionRatio] > 0) ? out[OUT.frontAdhesionRatio] : 1;
    const preScrub = clamp((0.84 - frontAdh) / 0.34, 0, 1) * clamp((absSpeed - 4) / 14, 0, 1);
    const dryMix = Math.max(squeal, preScrub * 0.32);
    if (this.stemDryTyreSrc && this.stemDryTyreGain) {
      const dryFactor = this.onGravel ? 0.15 : Math.max(0.25, 1 - this.roadWetness * 0.75);
      const scrubRate = squeal > 0.05
        ? clamp(0.72 + Math.min(1.4, slip) * 0.42 + Math.min(0.3, absSpeed / 120), 0.65, 1.85)
        : clamp(0.62 + preScrub * 0.24 + Math.min(0.2, absSpeed / 140), 0.58, 1.05);
      this.stemDryTyreSrc.playbackRate.setTargetAtTime(scrubRate, t, 0.04);
      this.stemDryTyreGain.gain.setTargetAtTime(this.muted ? 0 : dryMix * dryFactor * 0.55 * cam.tyreMul, t, 0.04);
    }
    this.tyre!.g.gain.setTargetAtTime(this.muted ? 0 : dryMix * 0.28 * (this.stemDryTyreSrc ? 0.18 : 1) * cam.tyreMul, t, 0.04);
    this.tyre!.f.frequency.setTargetAtTime(780 + 380 * Math.min(1.6, slip), t, 0.04);
    this.tyre!.f2.frequency.setTargetAtTime(1520 + 620 * Math.min(1.6, slip), t, 0.04);

    if (slow) {
      const v = Math.min(1, absSpeed / 85);
      this.wind!.g.gain.setTargetAtTime(this.muted ? 0 : Math.pow(v, 1.8) * 0.22 * cam.windMul, t, 0.14);
      this.wind!.f.frequency.setTargetAtTime((220 + 540 * v) * cam.windCutoffMul, t, 0.14);
    }

    if (this.wasmPhysicalAudioActive && this.workletNode && this.workletGain) {
      this.syncWasmVoice();
      const b = this.wasmTelBuf;
      b.fill(0);
      const tunnelEnv = clamp(Math.max(this.envReverb, cam.tunnelFloor), 0, 1);
      b[0] = rpm;
      b[1] = redline;
      b[2] = thr;
      b[3] = clamp(out[OUT.brake] || 0, 0, 1);
      b[4] = load;
      b[5] = Math.max(out[OUT.boostBar] || 0, this.boostSpool * 1.4);
      b[6] = this.resolveWasmTurboEnabled() ? 1 : 0;
      b[7] = (out[OUT.bovVenting] || 0) > 0.5 ? 1 : 0;
      b[8] = (out[OUT.shiftCut] || 0) > 0.5 ? 1 : 0;
      b[11] = (out[OUT.gearGrind] || 0) > 0.5 ? 1 : 0;
      const physWhineHz = out[OUT.gearWhineHz] || 0;
      const isDogBox = Math.round(out[OUT.transmissionType] || 0) === 1;
      b[12] = physWhineHz > 40 ? physWhineHz : gearFreq;
      b[13] = gearPresence * (isDogBox ? 0.58 : isRaceBox ? 0.18 : 0.0);
      b[14] = out[OUT.drivelineClunk] || 0;
      b[15] = out[OUT.tcSlipRatio] > 0 ? out[OUT.tcSlipRatio] : 1;
      b[16] = out[OUT.tcTorqueRatio] >= 1 ? out[OUT.tcTorqueRatio] : 1;
      b[17] = absSpeed;
      b[18] = out[OUT.sideslip] || 0;
      b[19] = (out[OUT.splitterStalled] || 0) > 0.5 ? 1 : 0;
      b[20] = this.resolveWasmExhaustStage();
      b[21] = this.resolveWasmPerspective();
      b[22] = clamp(0.12 + tunnelEnv * 0.45, 0, 1);
      b[23] = tunnelEnv;
      b[24] = this.wallProximityL;
      b[25] = this.wallProximityR;
      b[26] = this.overpassReflection;
      b[27] = Math.max(this.roadWaterMm, this.roadWetness > 0.15 ? this.roadWetness * 1.8 : 0);
      b[28] = clamp(out[OUT.streetMarbles] || 0, 0, 1);
      b[29] = this.exhaustStage === 'race' && this.resolveWasmTurboEnabled() ? 1 : 0;
      b[30] = out[OUT.treadPitchHz] > 50 ? out[OUT.treadPitchHz] : 520;
      const absFlag = (out[OUT.abs] || 0) > 0.5 ? 10 : 0;
      const cavLo = out[OUT.cavityLowHz] > 80 ? out[OUT.cavityLowHz] : 220;
      const cavHi = out[OUT.cavityHighHz] > 80 ? out[OUT.cavityHighHz] : 228;
      for (let w = 0; w < 4; w++) {
        const o = OUT.wheel(w);
        const dst = 32 + 20 * w;
        const surf = Math.round(out[o + 11] || 0);
        const cavG = out[OUT.cavityGain(w)] || 0;
        b[dst + 0] = out[o + 5] || 0;
        b[dst + 1] = out[o + 6] || 0;
        b[dst + 2] = out[o + 7] || 0;
        b[dst + 3] = out[o + 8] || 0;
        b[dst + 4] = out[o + 10] || 0;
        b[dst + 5] = 0.33;
        b[dst + 6] = out[OUT.treadSurface(w)] || 70;
        b[dst + 7] = out[OUT.brakeTemp(w)] || 45;
        b[dst + 8] = out[OUT.pressure(w)] || 220;
        b[dst + 9] = out[OUT.flatSpot(w)] || 0;
        b[dst + 12] = b[28];
        b[dst + 13] = Math.min(1, b[27] * 0.25 * Math.max(0, (absSpeed - 18) / 36));
        b[dst + 14] = surf === 1 ? 0.85 : 0;
        b[dst + 15] = Math.min(1, cavG * 1.4);
        b[dst + 16] = cavLo;
        b[dst + 17] = cavHi;
        b[dst + 18] = cavG;
        b[dst + 19] = absFlag + (this.onGravel ? 2 : (surf % 10));
      }
      const active = !this.muted && !stalled;
      this.workletNode.port.postMessage({ type: 'telemetry', data: b.slice(), active });
      this.workletGain.gain.setTargetAtTime(active ? 1.0 : 0, t, 0.015);
      this.muteFallbackVehicleBuses(t);
    } else if (this.workletGain) {
      this.workletGain.gain.setTargetAtTime(0, t, 0.02);
      if (this.workletNode) this.workletNode.port.postMessage({ type: 'active', active: false });
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

  /** Crisp subtle upshift exhaust bark (zero duplicate triggers when WASM physical engine handles shiftCut!). */
  private shiftBark(t: number, intensity: number) {
    if (this._muted) return;
    const inten = clamp(intensity, 0, 1);
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const stage = EXHAUST_PROFILES[this.exhaustStage];
    this.drivingFlame = Math.max(this.drivingFlame, (0.65 + 0.25 * inten) * stage.flameMul);
    if (this.wasmPhysicalAudioActive) {
      // C++ VehicleAudioEngine already fires shift bark on shift_cut_active edge -> no duplicate bang!
      return;
    }
    const id = ANTILAG_POP_IDS[this.antiLagPopIdx++ % ANTILAG_POP_IDS.length];
    const rate = (this.exhaustStage === 'race' ? 0.88 : 0.80) + Math.random() * 0.14;
    const bangGain = clamp((0.36 + 0.18 * inten) * stage.shiftBarkMul * cam.popMul, 0.08, 0.65);
    const lpHz = cam.popLpHz > 0 && stage.popLpHz > 0
      ? Math.min(cam.popLpHz, stage.popLpHz)
      : (cam.popLpHz || stage.popLpHz || 1500);
    if (this.playStemOneShot(id, t, bangGain, rate, true, lpHz) || this.playStemOneShot('exhaust_backfire_pop', t, bangGain, rate, true, lpHz)) {
      return;
    }
    this.burst(t, 0.065, 'bandpass', 165 + Math.random() * 45, 1.4, 0.24 * (0.5 + 0.5 * inten) * stage.shiftBarkMul * cam.popMul, true);
  }

  /** Muffled tailpipe overrun pop + synced tailpipe flame flash (band-limited <= 1.75 kHz, never a gunshot). */
  private exhaustPop(t: number, intensity: number) {
    if (this._muted) return;
    const stage = EXHAUST_PROFILES[this.exhaustStage];
    if (stage.popGainMul <= 0.01) return;
    const inten = clamp(intensity, 0.35, 0.90);
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    this.drivingFlame = Math.max(this.drivingFlame, (0.55 + 0.25 * inten) * stage.flameMul);
    if (this.wasmPhysicalAudioActive) {
      this.postWasmTrigger('pop', inten * 0.65);
      return;
    }
    const id = ANTILAG_POP_IDS[this.antiLagPopIdx++ % ANTILAG_POP_IDS.length];
    const rate = stage.popRateMin + Math.random() * stage.popRateSpan;
    const popGain = clamp((0.34 + Math.random() * 0.14) * (0.72 + 0.28 * inten) * stage.popGainMul * cam.popMul, 0.06, 0.62);
    const lpHz = cam.popLpHz > 0 && stage.popLpHz > 0
      ? Math.min(cam.popLpHz, stage.popLpHz)
      : (cam.popLpHz || stage.popLpHz || 1450);
    if (this.playStemOneShot(id, t, popGain, rate, true, lpHz) || this.playStemOneShot('exhaust_backfire_pop', t, popGain, rate, true, lpHz)) {
      return;
    }
    const g = (0.12 + Math.random() * 0.09) * inten * stage.popGainMul * cam.popMul;
    this.burst(t, 0.055 + Math.random() * 0.025, 'bandpass', 175 + Math.random() * 90, 1.5, g, true);
  }

  /**
   * Soft warm low-mid overrun exhaust burble / gurgle on mid-RPM lift-off or trailing after anti-lag bangs:
   * 130-260 Hz muffled bandpass puff + softly pitched-down stem pop at low gain (0.18-0.30).
   */
  private exhaustBurble(t: number, intensity: number) {
    if (this._muted) return;
    const inten = clamp(intensity, 0.25, 1.0);
    const cam = CAMERA_PROFILES[this.cameraPerspective];
    const stage = EXHAUST_PROFILES[this.exhaustStage];
    const mul = stage.burbleGainMul * cam.burbleMul;
    if (mul <= 0.04) return;
    if (this.wasmPhysicalAudioActive) {
      this.postWasmTrigger('burble', clamp(inten * mul, 0.2, 1.0));
      if (this.exhaustStage === 'race') {
        this.drivingFlame = Math.max(this.drivingFlame, 0.22 * inten);
      }
      return;
    }

    // Warm muffled low-mid gurgle (130-260 Hz bandpass)
    const freq = 130 + Math.random() * 130;
    const dur = 0.065 + Math.random() * 0.050;
    const puffGain = clamp((0.085 + Math.random() * 0.055) * inten * mul, 0.02, 0.28);
    this.burst(t, dur, 'bandpass', freq, 2.0 + Math.random() * 0.6, puffGain, true);

    // Softly pitched-down real exhaust stem pop at low gain (0.18-0.30 base) through warm lowpass
    const id = ANTILAG_POP_IDS[this.antiLagPopIdx++ % ANTILAG_POP_IDS.length];
    const rate = 0.62 + Math.random() * 0.16;
    const stemGain = clamp((0.18 + Math.random() * 0.12) * inten * mul, 0.04, 0.40);
    this.playStemOneShot(id, t + 0.008, stemGain, rate, true, cam.burbleLpHz);

    if (this.exhaustStage === 'race') {
      this.drivingFlame = Math.max(this.drivingFlame, 0.22 * inten);
    }
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
    if (this.wasmPhysicalAudioActive) {
      this.postWasmTrigger('impact', Math.max(1, kj));
      if (glass) this.playGlassShards(t + 0.015, s * 0.85, 22);
      return;
    }
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

  private burst(
    at: number,
    len: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    gain: number,
    toReverb = false,
  ) {
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
    if (toReverb) {
      if (this.reverbSend) g.connect(this.reverbSend);
      if (this.tunnelSend) g.connect(this.tunnelSend);
    }
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
