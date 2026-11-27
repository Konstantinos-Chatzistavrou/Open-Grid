// Apache-2.0 - the zone leaderboards' entries and the pace targets they start with. Pure (no three.js, no DOM) so it can be tested in Node.
//
// A zone's board lists YOUR best scores on this device, your party's, and five PACE TARGETS: fixed times derived from the zone's star thresholds so that a
// first visit has something to beat. They are not other players and are never shown as players. (Before 2026-11-27 they were five invented player names
// under a "Global Leaderboard" title: a board that looks global but is not misleads people.)

export interface LeaderboardEntry {
  name: string;
  score: number;
  car: string;
  stars: number;
  you?: boolean;
  party?: boolean;
  /** a fixed target set by the game, not a player */
  pace?: boolean;
}

/** Five pace targets for a zone whose 1, 2 and 3 star thresholds are `stars`. Names are unique (a board merges entries by name). */
export function paceTargets(stars: [number, number, number]): LeaderboardEntry[] {
  const [s1, s2, s3] = stars;
  return [
    { name: 'Elite target', score: Math.round(s3 * 1.12), car: 'strix_gt7', stars: 3, pace: true },
    { name: 'Gold target', score: Math.round(s3 * 1.03), car: 'basilisk_v12', stars: 3, pace: true },
    { name: 'Silver target', score: Math.round((s2 + s3) * 0.52), car: 'harrier_gt', stars: 2, pace: true },
    { name: 'Bronze+ target', score: Math.round(s2 * 0.96), car: 'kestrel_gt', stars: 2, pace: true },
    { name: 'Bronze target', score: Math.round(s1 * 1.08), car: 'vela_gt', stars: 1, pace: true },
  ];
}
