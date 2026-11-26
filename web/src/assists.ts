// Driving assists, per player (localStorage). Every level sits ON TOP of the exact same rs_core vehicle physics:
// no fake grip or alternate physics model — the car and tyres are identical for everyone; assists act as a layered
// learning ladder (Forza Horizon / iRacing Arcade model) from Beginner -> Intermediate -> Expert.
//   ABS            Off / Weak / Default        brake-pressure modulation to a wheel-slip target
//   Traction       Off / 1..5                  engine torque cut above a driven-wheel slip target (5 = earliest)
//   Stability      Off / On                    yaw-rate control braking single wheels (the core's ESC)
//   Steering Aid   Off / Sim / Assisted        physics-up front-axle peak slip-angle ceiling on pad/keyboard (wheels stay 1:1!)
//   Countersteer   Off / Weak / Strong         steering added toward the slide when the rear steps out
//   Braking Aid    Off / Low / High            physics-up corner braking assist driven by DrivingLine target speed
//   Gearbox        Auto / Manual
//   Driving Line   Off / Braking zones / Full  dynamic corner-speed racing line on the road
import type { AssistToggles } from './physics/core';

export type AbsLevel = 'off' | 'weak' | 'default';
export type CounterLevel = 'off' | 'weak' | 'strong';
export type SteeringAssistLevel = 'off' | 'sim' | 'assisted';
export type BrakingAssistLevel = 'off' | 'low' | 'high';
/** 'perfect': the car clutches for you (a dual-clutch / automatic box always does, whatever this says). 'off': you work a real clutch
 * pedal (wheel + pedals). */
export type AutoClutchLevel = 'off' | 'perfect';
export type LineMode = 'off' | 'braking' | 'full';
export type Preset = 'beginner' | 'intermediate' | 'expert' | 'custom';
export interface AssistSettings {
  preset: Preset;
  abs: AbsLevel;
  tc: number;                 // 0 off, 1..5
  stability: boolean;
  steeringAssist: SteeringAssistLevel;
  countersteer: CounterLevel;
  brakingAssist: BrakingAssistLevel;
  gearbox: 'auto' | 'manual';
  autoClutch: AutoClutchLevel;
  line: LineMode;
}

export const PRESETS: Record<Exclude<Preset, 'custom'>, Omit<AssistSettings, 'preset'>> = {
  beginner: {
    abs: 'default', tc: 5, stability: true, steeringAssist: 'assisted', countersteer: 'strong',
    brakingAssist: 'low', gearbox: 'auto', autoClutch: 'perfect', line: 'full',
  },
  intermediate: {
    abs: 'default', tc: 3, stability: true, steeringAssist: 'sim', countersteer: 'weak',
    brakingAssist: 'off', gearbox: 'auto', autoClutch: 'perfect', line: 'braking',
  },
  expert: {
    abs: 'weak', tc: 0, stability: false, steeringAssist: 'off', countersteer: 'off',
    brakingAssist: 'off', gearbox: 'manual', autoClutch: 'perfect', line: 'off',
  },
};
export const PRESET_INFO: Record<Preset, string> = {
  beginner: 'Forza / iRacing Arcade on-ramp: slip-angle steering filter, strong countersteer, low corner braking aid, ABS/TC/ESC & full line. Peel aids off as you improve!',
  intermediate: 'Sim steering filter (keeps pad tyres in peak grip), medium TC, stability, light countersteer & braking zones. Great for learning trail braking.',
  expert: 'Raw sim control: weak ABS only, manual gearbox, zero steering/braking aids, no line (+25% Assist-Off Skill Bonus).',
  custom: 'Your own mix of physics-up driver aids.',
};

// slip targets: the fitted tyre peaks near 10 % longitudinal slip (data/tires)
const ABS_SLIP: Record<AbsLevel, number> = { off: 0, weak: 0.17, default: 0.10 };
const TC_SLIP = [0, 0.24, 0.18, 0.14, 0.10, 0.07];
const COUNTER_GAIN: Record<CounterLevel, number> = { off: 0, weak: 0.4, strong: 0.8 };
const STEER_ASSIST_CODE: Record<SteeringAssistLevel, 0 | 1 | 2> = { off: 0, sim: 1, assisted: 2 };
const BRAKE_ASSIST_CODE: Record<BrakingAssistLevel, 0 | 1 | 2> = { off: 0, low: 1, high: 2 };

/** Count of major aids turned off (0..7) -> drives skill bonus & Assist Graduation ladder. */
export function assistsOffCount(a: AssistSettings): number {
  return +(a.abs === 'off') + +(a.tc === 0) + +!a.stability
    + +(a.steeringAssist === 'off') + +(a.countersteer === 'off')
    + +(a.brakingAssist === 'off') + +(a.line === 'off');
}

/** Friendly graduation tip after a clean race when a player barely needed their current aids. */
export function assistGraduationTip(a: AssistSettings, brakeAssistSecs: number, steerFilterSecs: number): string {
  if (a.brakingAssist !== 'off' && brakeAssistSecs < 1.5) {
    return '🎓 Ready to graduate: Braking Assist barely intervened — turn Braking Assist OFF in Settings for faster corner entry & more XP!';
  }
  if (a.preset === 'beginner' && steerFilterSecs < 4.0) {
    return '🎓 Ready to graduate: You kept the car composed — try Intermediate (Sim Steering Filter) for sharper turn-in & +10% Skill Bonus!';
  }
  if (a.preset === 'intermediate' && a.tc > 0) {
    return '🎓 Next step on the ladder: Try lowering Traction Control or switching to Expert (Manual + Aids Off) for +25% Skill Bonus!';
  }
  return '';
}

const KEY = 'nr.assists.v1';
export function loadAssists(): AssistSettings {
  const d: AssistSettings = { preset: 'intermediate', ...PRESETS.intermediate };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (s && typeof s === 'object') {
      if (['beginner', 'intermediate', 'expert', 'custom'].includes(s.preset)) d.preset = s.preset;
      if (['off', 'weak', 'default'].includes(s.abs)) d.abs = s.abs;
      if (Number.isInteger(s.tc) && s.tc >= 0 && s.tc <= 5) d.tc = s.tc;
      if (typeof s.stability === 'boolean') d.stability = s.stability;
      if (['off', 'sim', 'assisted'].includes(s.steeringAssist)) d.steeringAssist = s.steeringAssist;
      if (['off', 'weak', 'strong'].includes(s.countersteer)) d.countersteer = s.countersteer;
      if (['off', 'low', 'high'].includes(s.brakingAssist)) d.brakingAssist = s.brakingAssist;
      if (s.gearbox === 'auto' || s.gearbox === 'manual') d.gearbox = s.gearbox;
      if (s.autoClutch === 'off') d.autoClutch = 'off';
      else if (['poor', 'normal', 'perfect'].includes(s.autoClutch)) d.autoClutch = 'perfect';
      if (['off', 'braking', 'full'].includes(s.line)) d.line = s.line;
    }
  } catch { /* storage blocked */ }
  return d;
}
export function saveAssists(a: AssistSettings) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* blocked */ } }

export function applyPreset(a: AssistSettings, p: Preset) {
  a.preset = p;
  if (p !== 'custom') Object.assign(a, PRESETS[p]);
}
/** A single setting changed: the preset becomes whichever one matches now (or custom). */
export function matchPreset(a: AssistSettings) {
  const same = (p: Omit<AssistSettings, 'preset'>) => (Object.keys(p) as (keyof typeof p)[]).every((k) => p[k] === a[k]);
  a.preset = (Object.keys(PRESETS) as Exclude<Preset, 'custom'>[]).find((p) => same(PRESETS[p])) ?? 'custom';
}

/** Write the levels into the toggles the physics reads every tick. */
export function toToggles(a: AssistSettings, t: AssistToggles) {
  t.abs = a.abs !== 'off';
  t.absSlip = ABS_SLIP[a.abs];
  t.tc = a.tc > 0;
  t.tcSlip = TC_SLIP[a.tc];
  t.esc = a.stability;
  t.steeringAssist = STEER_ASSIST_CODE[a.steeringAssist];
  t.brakingAssist = BRAKE_ASSIST_CODE[a.brakingAssist];
  t.countersteer = COUNTER_GAIN[a.countersteer];
  t.autoGearbox = a.gearbox === 'auto';
  t.autoClutch = a.autoClutch;
}
/** The quick keys while driving (1 ABS, 2 TC, 3 stability, 5 gearbox) change the saved settings too. */
export function fromToggles(a: AssistSettings, t: AssistToggles) {
  if (!t.abs) a.abs = 'off'; else if (a.abs === 'off') a.abs = 'default';
  if (!t.tc) a.tc = 0; else if (a.tc === 0) a.tc = 3;
  a.stability = t.esc;
  a.gearbox = t.autoGearbox ? 'auto' : 'manual';
  matchPreset(a);
}
