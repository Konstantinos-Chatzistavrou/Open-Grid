// Onboarding Driving Academy, GT7-Style Weekly Event Calendar, Spec Class & Racing Penalty System (OpenGrid).

export interface AcademyLesson {
  id: string;
  num: number;
  title: string;
  goal: string;
  xpReward: number;
  laps: number;
  cops: boolean;
  specClass: boolean;
}

export const ACADEMY_LESSONS: AcademyLesson[] = [
  { id: 'ac_brake', num: 1, title: 'Braking Points & ABS', goal: 'Brake smoothly along the racing line from 160 km/h without locking wheels.', xpReward: 800, laps: 1, cops: false, specClass: true },
  { id: 'ac_tires', num: 2, title: 'Tire Temp Window (80–105°C)', goal: 'Build cornering load on lap 1 to warm your Pacejka tires into peak grip.', xpReward: 950, laps: 2, cops: false, specClass: true },
  { id: 'ac_slide', num: 3, title: 'Catching a Rear Slide', goal: 'Modulate throttle & counter-steer through a tight Manhattan hairpin.', xpReward: 1100, laps: 1, cops: false, specClass: true },
  { id: 'ac_cops',  num: 4, title: 'Tactical Cop Escape', goal: 'Anticipate a rear-quarter PIT attempt and thread a 2-cruiser roadblock.', xpReward: 1500, laps: 2, cops: true,  specClass: false },
];

export interface CalendarEvent {
  dayIdx: number; // 0 = Sun .. 6 = Sat
  day: string;
  title: string;
  kind: string;
  laps: number;
  cops: boolean;
  specClass: boolean;
  bonusXp: number;
}

export const WEEKLY_CALENDAR: CalendarEvent[] = [
  { dayIdx: 1, day: 'MON', title: 'Drift Masters Night',       kind: 'Free Roam Drift Zones',      laps: 0, cops: false, specClass: false, bonusXp: 1200 },
  { dayIdx: 2, day: 'TUE', title: 'Cop Chase Endurance',       kind: '5-Lap Tactical Pursuit',     laps: 5, cops: true,  specClass: false, bonusXp: 2400 },
  { dayIdx: 3, day: 'WED', title: 'Spec Class Cup (Equal Car)', kind: '3-Lap Stock Spec · Esports', laps: 3, cops: false, specClass: true,  bonusXp: 1800 },
  { dayIdx: 4, day: 'THU', title: 'Traffic-Light Drag Wagers', kind: 'Free Roam [F] 400m Drags',   laps: 0, cops: false, specClass: false, bonusXp: 1400 },
  { dayIdx: 5, day: 'FRI', title: 'Wet Asphalt Sprint',        kind: '3-Lap Rain Physics Run',     laps: 3, cops: true,  specClass: false, bonusXp: 1900 },
  { dayIdx: 6, day: 'SAT', title: 'Midtown Midnight GP',       kind: '5-Lap High-Stakes Race',     laps: 5, cops: true,  specClass: false, bonusXp: 2800 },
  { dayIdx: 0, day: 'SUN', title: '5-Floor Car Meet & Hotlap', kind: '16P Social Meet + Zones',    laps: 0, cops: false, specClass: false, bonusXp: 1100 },
];

export function todayCalendarEvent(d = new Date()): CalendarEvent {
  const dow = d.getUTCDay();
  return WEEKLY_CALENDAR.find((e) => e.dayIdx === dow) ?? WEEKLY_CALENDAR[0];
}

const AC_KEY = 'nr.academy.v1';

export function loadCompletedLessons(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(AC_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function markLessonDone(id: string): string[] {
  const list = loadCompletedLessons();
  if (!list.includes(id)) {
    list.push(id);
    try { localStorage.setItem(AC_KEY, JSON.stringify(list)); } catch { /* blocked */ }
  }
  return list;
}

/**
 * Competitive Esports Penalty Tracker (GT7 / iRacing style):
 * Adds +5.0 s race time penalties for heavy car-to-car ramming or severe corner-cutting.
 */
export class PenaltyTracker {
  seconds = 0;
  incidents: { at: number; reason: string; sec: number }[] = [];
  private lastAt = 0;

  reset() {
    this.seconds = 0;
    this.incidents.length = 0;
    this.lastAt = 0;
  }

  addPenalty(reason: string, sec = 5.0, now = performance.now()): boolean {
    if (now - this.lastAt < 4500) return false; // debounce multi-contact frames
    this.lastAt = now;
    this.seconds += sec;
    this.incidents.push({ at: now, reason, sec });
    return true;
  }

  hudText(): string {
    return this.seconds > 0 ? `⚠ PENALTY +${this.seconds.toFixed(1)}s` : '';
  }
}
