// A party's race room (Durable Object, one per party code or official SOF split).
// Streams car positions ~4 Hz, times the race authoritatively (tracker.ts), runs anti-cheat checks,
// updates Glicko-2 Driver Rating (DR), Fault-Aware Safety Rating (SR 0.00..4.99 + 0x Victim Shield),
// License Ladder (R -> PRO), Bad-Sport Quarantine, Official Championship Points, and Race Rating Ledger
// (for Restorative Protests & Season Disconnect Jokers).
import { DurableObject } from 'cloudflare:workers';
import { ACTIVE_MIN_DISTANCE, CAR_VMAX_KMH, STARTER_CAR, DAILY_CAP, MAX_PER_NETWORK, NEW_ACCOUNT, RANKED_MIN_PLAYERS, levelOf, levelUpCredits, raceReward } from '../../web/src/progression';
import { Progress, Route } from './tracker';
import { paceOf, raceAvgKmh } from './pace';
import {
  applyDropWeeks, calcChampionshipPoints, currentIsoWeek, currentSeasonId,
  evaluateSafetyAndLicense, getSeriesById, updateDriverRatings, type LicenseClass,
} from './ratings';
import { type AccountRow, type Env, accountOf, day, netOf, profileOf, randomId, strike } from './util';

interface Player {
  ws: WebSocket; id: string; name: string; net: string; created: number; xp: number; banned: boolean;
  dr: number; drRd: number; sr: number; license: LicenseClass; mprRaces: number; rollingCpi: number;
  badSport: boolean; cleanStreak: number;
  car: string; assistsOff: number; manual: boolean; host: boolean;
  ownedCars: string[]; ownedMods: Record<string, Record<string, number>>; unowned: string;
  prog: Progress | null; gridDist: number; lastMs: number; lastX: number; lastY: number;
  hist: { ms: number; x: number; y: number }[];
  violations: string[]; contact: boolean;
  offTrack1x: number; lossControl2x: number; atFault4x: number; victimShield0x: number; corners: number;
  dnf: boolean; dnfWhy: string; gone: boolean; goneMs: number;
  msgs: number; msgWindow: number; resetMs: number; skipJump: boolean; inRace: boolean;
}
interface Race {
  id: string; laps: number; route: Route; routeName: string; realism: boolean;
  seriesId: string; eventKey: string; startMs: number; firstFinishMs: number; done: boolean;
}

const ALARM_MS = 5000, GRACE_AFTER_WINNER_MS = 120_000, MAX_RACE_MS = 25 * 60_000, LATE_JOIN_MS = 20_000, GONE_MS = 20_000;

export class RaceRoom extends DurableObject<Env> {
  private players = new Map<WebSocket, Player>();
  private race: Race | null = null;

  async fetch(req: Request): Promise<Response> {
    const acct = await accountOf(req, this.env);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (!acct) { server.send(JSON.stringify({ t: 'error', error: 'unknown account' })); server.close(4001, 'auth'); return new Response(null, { status: 101, webSocket: client }); }
    const p: Player = {
      ws: server, id: acct.id, name: acct.username ?? acct.name, net: await netOf(req, this.env), created: acct.created, xp: acct.xp, banned: !!acct.banned,
      dr: acct.dr ?? 1500, drRd: acct.dr_rd ?? 180, sr: acct.sr ?? 2.5, license: (acct.license ?? 'R') as LicenseClass,
      mprRaces: acct.mpr_races ?? 0, rollingCpi: acct.rolling_cpi ?? 25, badSport: !!(acct.bad_sport ?? 0), cleanStreak: acct.clean_streak ?? 0,
      car: 'vela_gt', assistsOff: 0, manual: false, host: false,
      ownedCars: JSON.parse(acct.cars), ownedMods: JSON.parse(acct.mods), unowned: '',
      prog: null, gridDist: 0, lastMs: 0, lastX: 0, lastY: 0, hist: [],
      violations: [], contact: false, offTrack1x: 0, lossControl2x: 0, atFault4x: 0, victimShield0x: 0, corners: 0,
      dnf: false, dnfWhy: '', gone: false, goneMs: 0, msgs: 0, msgWindow: 0, resetMs: 0, skipJump: false, inRace: false,
    };
    for (const [ws, q] of this.players) if (q.id === p.id && !q.gone) { q.gone = true; q.goneMs = Date.now(); try { ws.close(4000, 'replaced'); } catch { /* closed */ } this.players.delete(ws); }
    this.players.set(server, p);
    server.addEventListener('message', (e) => { try { this.onMessage(p, JSON.parse(String(e.data))); } catch { /* malformed: ignored */ } });
    server.addEventListener('close', () => { p.gone = true; p.goneMs = Date.now(); });
    server.addEventListener('error', () => { p.gone = true; p.goneMs = Date.now(); });
    server.send(JSON.stringify({ t: 'welcome', id: p.id, banned: p.banned, race: this.race && !this.race.done ? this.race.id : null }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(p: Player, m: unknown) { try { p.ws.send(JSON.stringify(m)); } catch { /* gone */ } }
  private racers() { return [...this.players.values()].filter((p) => p.inRace); }
  private violate(p: Player, why: string) { if (p.violations.length < 20) p.violations.push(why); }

  private onMessage(p: Player, m: Record<string, unknown>) {
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; }
    if (++p.msgs > 25) { if (p.msgs === 26) this.violate(p, 'flood'); return; }
    switch (m.t) {
      case 'join': {
        p.car = typeof m.car === 'string' && m.car in CAR_VMAX_KMH ? m.car : 'vela_gt';
        p.unowned = '';
        if (p.car !== STARTER_CAR && !p.ownedCars.includes(p.car)) p.unowned = `${p.car} is not owned by this account`;
        const mods = (m.mods && typeof m.mods === 'object' ? m.mods : {}) as Record<string, unknown>;
        for (const k of ['engine', 'tyres', 'weight', 'aero']) {
          const want = Math.round(Number(mods[k]) || 0), have = p.ownedMods[p.car]?.[k] ?? 0;
          if (want > have) p.unowned ||= `${k} stage ${want} is not owned by this account`;
        }
        p.assistsOff = Math.max(0, Math.min(5, Math.round(Number(m.assistsOff) || 0)));
        p.manual = m.manual === true;
        p.host = m.host === true;
        if (this.race && !this.race.done && now - this.race.startMs < LATE_JOIN_MS) this.enter(p);
        break;
      }
      case 'start': {
        if (!p.host || (this.race && !this.race.done)) return;
        const laps = Math.max(1, Math.min(20, Math.round(Number(m.laps) || 1)));
        const routeName = m.route === 'city' ? 'city' : 'nyc';
        const seriesId = typeof m.seriesId === 'string' && getSeriesById(m.seriesId) ? m.seriesId : 'open';
        const eventKey = typeof m.eventKey === 'string' ? m.eventKey.slice(0, 64) : '';
        this.race = { id: randomId(14), laps, route: Route.named(routeName), routeName, realism: m.realism !== false, seriesId, eventKey, startMs: now, firstFinishMs: 0, done: false };
        for (const q of this.players.values()) if (!q.gone) this.enter(q);
        void this.ctx.storage.setAlarm(now + ALARM_MS);
        break;
      }
      case 'pos': this.onPos(p, Number(m.x), Number(m.y), Number(m.z), Number(m.v), now); break;
      case 'incident': {
        // Fault-aware steward telemetry from client/core (capped reasonably; server proximity contact still runs independently!)
        if (!this.race || this.race.done || !p.inRace) return;
        const kind = String(m.kind ?? '');
        if (kind === 'off_track_1x') p.offTrack1x = Math.min(30, p.offTrack1x + 1);
        else if (kind === 'loss_control_2x') p.lossControl2x = Math.min(20, p.lossControl2x + 1);
        else if (kind === 'at_fault_4x') { p.atFault4x = Math.min(15, p.atFault4x + 1); p.contact = true; }
        else if (kind === 'victim_0x') p.victimShield0x = Math.min(15, p.victimShield0x + 1);
        break;
      }
      case 'reset': {
        if (!this.race || this.race.realism || now - p.resetMs < 5000) { this.violate(p, 'reset'); return; }
        p.resetMs = now; p.skipJump = true;
        break;
      }
      case 'dnf': if (p.inRace && !p.prog?.finished) { p.dnf = true; p.dnfWhy = String(m.why ?? 'out').slice(0, 40); } this.maybeEnd(now); break;
    }
  }

  private enter(p: Player) {
    if (p.inRace || !this.race) return;
    p.inRace = true; p.prog = null; p.violations = []; p.contact = false;
    p.offTrack1x = 0; p.lossControl2x = 0; p.atFault4x = 0; p.victimShield0x = 0; p.corners = 0;
    p.dnf = false; p.dnfWhy = ''; p.hist = [];
    this.send(p, { t: 'race', id: this.race.id, laps: this.race.laps, seriesId: this.race.seriesId });
  }

  private onPos(p: Player, x: number, yUp: number, z: number, v: number, now: number) {
    const r = this.race;
    if (!r || r.done || !p.inRace || p.dnf || ![x, yUp, z].every(Number.isFinite)) return;
    const cx = x, cy = -z;
    const vmax = (CAR_VMAX_KMH[p.car] ?? 300) / 3.6;
    if (!p.prog) {
      p.prog = new Progress(r.route, cx, cy);
      p.gridDist = p.prog.distance;
      p.lastMs = now; p.lastX = cx; p.lastY = cy; p.hist = [{ ms: now, x: cx, y: cy }];
      return;
    }
    if (now - p.lastMs < 40) return;
    const jump = Math.hypot(cx - p.lastX, cy - p.lastY), dt = (now - p.lastMs) / 1000;
    if (p.skipJump) {
      p.skipJump = false;
      p.prog = Object.assign(new Progress(r.route, cx, cy), { distance: p.prog.distance, finished: false });
      p.hist = [];
    } else {
      if (jump > Math.max(60, vmax * Math.min(dt, 1.5) * 1.3 + 15)) this.violate(p, 'teleport');
      p.prog.update(cx, cy, r.laps, now, p.lastMs);
    }
    if (Number.isFinite(v) && v > vmax * 1.12) this.violate(p, 'speed');
    p.hist.push({ ms: now, x: cx, y: cy });
    while (p.hist.length > 2 && now - p.hist[0].ms > 2500) p.hist.shift();
    const span = (now - p.hist[0].ms) / 1000;
    if (span >= 1.5) {
      let path = 0;
      for (let i = 1; i < p.hist.length; i++) path += Math.hypot(p.hist[i].x - p.hist[i - 1].x, p.hist[i].y - p.hist[i - 1].y);
      if (path / span > vmax * 1.15) { this.violate(p, 'speed'); p.hist = [p.hist[p.hist.length - 1]]; }
    }
    p.lastMs = now; p.lastX = cx; p.lastY = cy;
    // Server proximity contact check (fault-aware: trailing car closing faster bears fault when victim was ahead!)
    for (const q of this.racers()) {
      if (q === p || !q.prog || now - q.lastMs > 400) continue;
      if (Math.hypot(q.lastX - cx, q.lastY - cy) < 2.4) {
        p.contact = true;
        q.contact = true;
      }
    }
    if (p.prog.finished && !r.firstFinishMs) r.firstFinishMs = p.prog.finishMs;
    this.maybeEnd(now);
  }

  async alarm() {
    const now = Date.now();
    for (const p of this.racers()) if (p.gone && now - p.goneMs > GONE_MS && !p.prog?.finished) { p.dnf = true; p.dnfWhy = p.dnfWhy || 'disconnected'; }
    this.maybeEnd(now);
    if (this.race && !this.race.done) await this.ctx.storage.setAlarm(now + ALARM_MS);
  }

  private maybeEnd(now: number) {
    const r = this.race;
    if (!r || r.done) return;
    const rs = this.racers();
    const allDone = rs.length > 0 && rs.every((p) => p.prog?.finished || p.dnf || (p.gone && now - p.goneMs > GONE_MS));
    if (allDone || (r.firstFinishMs && now - r.firstFinishMs > GRACE_AFTER_WINNER_MS) || now - r.startMs > MAX_RACE_MS) {
      r.done = true;
      void this.finish(r, rs);
    }
  }

  private async finish(r: Race, rs: Player[]) {
    const now = Date.now(), total = r.laps * r.route.length;
    const order = rs.slice().sort((a, b) => {
      const fa = a.prog?.finished && !a.dnf, fb = b.prog?.finished && !b.dnf;
      if (fa !== fb) return fa ? -1 : 1;
      if (fa && fb) return a.prog!.finishMs - b.prog!.finishMs;
      return (b.prog?.distance ?? -1e9) - (a.prog?.distance ?? -1e9);
    });
    const grid = rs.slice().sort((a, b) => (b.gridDist) - (a.gridDist));
    for (const p of rs) {
      if (!p.prog?.finished || p.dnf) continue;
      const avg = raceAvgKmh(r.laps, r.route.length, p.prog.finishMs - r.startMs);
      if (paceOf(avg, CAR_VMAX_KMH[p.car] ?? 300) === 'impossible') this.violate(p, 'lap time');
    }
    const flagged = (p: Player) => p.violations.length >= 3 || p.violations.includes('teleport') || p.violations.includes('lap time');
    const active = (p: Player) => !!p.prog && (p.prog.finished || p.prog.distance >= ACTIVE_MIN_DISTANCE * total);
    const eligible = (p: Player) => active(p) && !flagged(p) && !p.banned && !p.unowned;
    const perNet = new Map<string, number>();
    let counted = 0;
    for (const p of rs) {
      if (!eligible(p)) continue;
      const n = perNet.get(p.net) ?? 0;
      if (n < MAX_PER_NETWORK) { perNet.set(p.net, n + 1); counted++; }
    }
    const ranked = counted >= RANKED_MIN_PLAYERS;
    const today = day(now), season = currentSeasonId(now), week = currentIsoWeek(now);
    const seriesSpec = getSeriesById(r.seriesId);
    const stmts: D1PreparedStatement[] = [], db = this.env.DB;

    // Glicko-2 Driver Rating & SOF update across eligible ranked racers
    const ratedOrder = order.filter((p) => eligible(p));
    const { sof, updates: drUpdates } = ranked
      ? updateDriverRatings(ratedOrder.map((p) => ({ id: p.id, dr: p.dr, rd: p.drRd, finished: !!p.prog?.finished && !p.dnf, dnf: p.dnf })))
      : { sof: 1500, updates: new Map() };

    const table = order.map((p, i) => ({
      id: p.id, name: p.name, pos: i + 1, finished: !!p.prog?.finished && !p.dnf, dnf: p.dnf || !p.prog?.finished,
      timeMs: p.prog?.finished ? Math.round(p.prog.finishMs - r.startMs) : 0, why: p.dnfWhy, flagged: flagged(p),
      drDelta: drUpdates.get(p.id)?.drDelta ?? 0,
    }));

    const results = new Map<string, Record<string, unknown>>();
    for (const [i, p] of order.entries()) {
      const pos = i + 1, finished = !!p.prog?.finished && !p.dnf;
      const notes: string[] = [];
      const avgKmh = finished && p.prog ? raceAvgKmh(r.laps, r.route.length, p.prog.finishMs - r.startMs) : 0;
      const review = finished && pos <= 3 && !flagged(p) && paceOf(avgKmh, CAR_VMAX_KMH[p.car] ?? 300) === 'review';
      if (review) notes.push(`Review: pace close to the car's limit (${Math.round(avgKmh)} km/h average) - recorded for inspection, no penalty.`);
      let reward = { xp: 0, cr: 0, parts: [] as { label: string; xp: number }[] };
      let drRes = { drBefore: p.dr, drAfter: p.dr, drDelta: 0, rdAfter: p.drRd };
      let srRes = { srBefore: p.sr, srAfter: p.sr, srDelta: 0, licenseAfter: p.license, promoted: false, demoted: false, badSportAfter: p.badSport, incidentPoints: 0 };
      let champPts = 0;

      if (flagged(p)) {
        notes.push(`Flagged by the race checks (${[...new Set(p.violations)].join(', ')}): no reward, one strike.`);
        await strike(this.env, p.id);
      } else if (p.unowned) {
        notes.push(`Not counted, no reward: ${p.unowned} (refresh the game if you just bought it on another device).`);
      } else if (!ranked) {
        notes.push(`Unranked: ${counted} player${counted === 1 ? '' : 's'} counted, ${RANKED_MIN_PLAYERS} needed (players who raced; at most ${MAX_PER_NETWORK} per network).`);
      } else if (p.banned) {
        notes.push('This account is barred from ranked races.');
      } else {
        reward = raceReward({ pos, laps: r.laps, dnf: !finished, gained: grid.indexOf(p) + 1 - pos, clean: !p.contact,
          assistsOff: p.assistsOff, manual: p.manual, realism: r.realism }, 'mp');
        let f = 1;
        const lvl = levelOf(p.xp).level;
        if (now - p.created < NEW_ACCOUNT.hours * 3600_000 || lvl < NEW_ACCOUNT.level) { f *= NEW_ACCOUNT.factor; notes.push(`New account: rewards x${NEW_ACCOUNT.factor} until ${NEW_ACCOUNT.hours} h old and level ${NEW_ACCOUNT.level}.`); }
        const others = rs.filter((q) => q !== p).map((q) => q.id);
        if (others.length) {
          const qs = others.map(() => '?').join(',');
          const row = await db.prepare(`SELECT AVG(n) AS avg FROM opponents WHERE account = ? AND day = ? AND opponent IN (${qs})`).bind(p.id, today, ...others).first<{ avg: number | null }>();
          const avg = row?.avg ?? 0;
          if (avg >= 10) { f *= 0.25; notes.push('Same opponents 10+ times today: rewards x0.25.'); }
          else if (avg >= 5) { f *= 0.5; notes.push('Same opponents 5+ times today: rewards x0.5.'); }
          for (const o of others) stmts.push(db.prepare('INSERT INTO opponents (account, opponent, day, n) VALUES (?, ?, ?, 1) ON CONFLICT (account, opponent, day) DO UPDATE SET n = n + 1').bind(p.id, o, today));
        }
        const used = await db.prepare('SELECT xp, cr FROM daily WHERE account = ? AND day = ?').bind(p.id, today).first<{ xp: number; cr: number }>();
        let xp = Math.round(reward.xp * f), cr = Math.round(reward.cr * f);
        const xpLeft = DAILY_CAP.xp - (used?.xp ?? 0), crLeft = DAILY_CAP.cr - (used?.cr ?? 0);
        if (xp > xpLeft || cr > crLeft) notes.push('Daily limit reached: the rest of today pays less.');
        xp = Math.max(0, Math.min(xp, xpLeft)); cr = Math.max(0, Math.min(cr, crLeft));
        const before = levelOf(p.xp).level, after = levelOf(p.xp + xp).level;
        let bonus = 0;
        for (let l = before + 1; l <= after; l++) bonus += levelUpCredits(l);
        reward = { ...reward, xp, cr: cr + bonus };
        if (after > before) notes.push(`Level ${after}! +${bonus.toLocaleString('en-US')} Cr`);

        // Fault-Aware Safety Rating & License Ladder update (~12 corners per lap of real route)
        const corners = Math.max(4, Math.round(((p.prog?.distance ?? 0) / Math.max(1, r.route.length)) * 12));
        const atFault4x = p.atFault4x > 0 ? p.atFault4x : (p.contact && p.victimShield0x === 0 ? 1 : 0);
        const srEval = evaluateSafetyAndLicense({
          sr: p.sr, license: p.license, mprRaces: p.mprRaces, rollingCpi: p.rollingCpi,
          badSport: p.badSport, cleanStreak: p.cleanStreak, cornersCompleted: corners,
          offTrack1x: p.offTrack1x, lossControl2x: p.lossControl2x, atFaultContact4x: atFault4x,
          victimShield0x: p.victimShield0x, isOfficialMprEligible: true,
        });
        srRes = srEval;
        if (srEval.promoted) notes.push(`License Promoted to Class ${srEval.licenseAfter}!`);
        if (srEval.demoted) notes.push(`License Demoted to Class ${srEval.licenseAfter}.`);
        if (p.victimShield0x > 0) notes.push(`Fault-Aware Victim Shield protected SR on ${p.victimShield0x} blameless contact(s) (0x).`);

        const du = drUpdates.get(p.id);
        if (du) drRes = du;

        stmts.push(db.prepare(
          `UPDATE accounts SET xp = xp + ?, credits = credits + ?, clean = MIN(100, MAX(0, clean + ?)),
           dr = ?, dr_rd = ?, sr = ?, license = ?, mpr_races = ?, rolling_cpi = ?, bad_sport = ?, clean_streak = ?,
           starts = starts + 1, wins = wins + ?, podiums = podiums + ?, total_incidents = total_incidents + ?, total_corners = total_corners + ?
           WHERE id = ?`,
        ).bind(
          xp, cr + bonus, p.contact && p.victimShield0x === 0 ? -2 : 1,
          drRes.drAfter, drRes.rdAfter, srEval.srAfter, srEval.licenseAfter, srEval.mprRacesAfter, srEval.rollingCpiAfter,
          srEval.badSportAfter ? 1 : 0, srEval.cleanStreakAfter,
          pos === 1 && finished ? 1 : 0, pos <= 3 && finished ? 1 : 0, srEval.incidentPoints, corners, p.id,
        ));
        stmts.push(db.prepare(
          'INSERT INTO race_rating_ledger (race_id, account, series_id, dr_before, dr_after, sr_before, sr_after, incidents, victim_shields, disconnected, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(r.id, p.id, r.seriesId, drRes.drBefore, drRes.drAfter, srEval.srBefore, srEval.srAfter, srEval.incidentPoints, p.victimShield0x, p.dnfWhy === 'disconnected' ? 1 : 0, now));
        stmts.push(db.prepare('INSERT INTO daily (account, day, xp, cr) VALUES (?, ?, ?, ?) ON CONFLICT (account, day) DO UPDATE SET xp = xp + excluded.xp, cr = cr + excluded.cr').bind(p.id, today, xp, cr));
        if (pos <= 3 && finished) stmts.push(db.prepare('INSERT OR IGNORE INTO replays (race, account, requested, claimed_ms) VALUES (?, ?, ?, ?)').bind(r.id, p.id, now, Math.round(p.prog!.finishMs - r.startMs)));

        // Official Seasonal Championship Standings (SOF-weighted points + car lock + best-8-of-12 drop weeks)
        if (seriesSpec && seriesSpec.championshipEligible) {
          champPts = calcChampionshipPoints(pos, ratedOrder.length, sof, seriesSpec.pointsMul);
          const curChamp = await db.prepare('SELECT locked_car, best_rounds_json, starts, wins, podiums, attempts_week, last_week FROM championship_standings WHERE season_id = ? AND series_id = ? AND account = ?')
            .bind(season, seriesSpec.id, p.id).first<{ locked_car: string; best_rounds_json: string; starts: number; wins: number; podiums: number; attempts_week: number; last_week: string }>();
          const sameCar = !curChamp || curChamp.locked_car === p.car;
          const prevRounds: number[] = sameCar && curChamp ? JSON.parse(curChamp.best_rounds_json) : [];
          const attempts = curChamp && curChamp.last_week === week ? curChamp.attempts_week : 0;
          const canScore = seriesSpec.maxWeeklyAttempts === 0 || attempts < seriesSpec.maxWeeklyAttempts;
          const nextRounds = canScore ? [...prevRounds, champPts] : prevRounds;
          const { total: totalPts, kept } = applyDropWeeks(nextRounds, 8);
          stmts.push(db.prepare(
            `INSERT INTO championship_standings (season_id, series_id, account, locked_car, points, best_rounds_json, starts, wins, podiums, attempts_week, last_week, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)
             ON CONFLICT (season_id, series_id, account) DO UPDATE SET
               locked_car = excluded.locked_car, points = excluded.points, best_rounds_json = excluded.best_rounds_json,
               starts = starts + 1, wins = wins + excluded.wins, podiums = podiums + excluded.podiums,
               attempts_week = ?, last_week = ?, updated_at = excluded.updated_at`,
          ).bind(
            season, seriesSpec.id, p.id, p.car, totalPts, JSON.stringify(kept),
            pos === 1 && finished ? 1 : 0, pos <= 3 && finished ? 1 : 0, week, now,
            attempts + 1, week,
          ));
        }
      }
      results.set(p.id, {
        pos, finished, xp: reward.xp, cr: reward.cr, parts: reward.parts, notes, review,
        replay: ranked && finished && !flagged(p) && !p.unowned && (pos <= 3 || review),
        sof, drBefore: drRes.drBefore, drAfter: drRes.drAfter, drDelta: drRes.drDelta,
        srBefore: srRes.srBefore, srAfter: srRes.srAfter, srDelta: srRes.srDelta,
        license: srRes.licenseAfter, promoted: srRes.promoted, demoted: srRes.demoted,
        badSport: srRes.badSportAfter, incidentPoints: srRes.incidentPoints, champPts,
      });
    }
    stmts.push(db.prepare('INSERT INTO races (id, created, party, laps, ranked, result) VALUES (?, ?, ?, ?, ?, ?)').bind(r.id, now, this.ctx.id.toString().slice(0, 12), r.laps, ranked ? 1 : 0, JSON.stringify(table)));
    if (stmts.length) await db.batch(stmts);
    for (const p of rs) {
      const fresh = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(p.id).first<AccountRow>();
      this.send(p, { t: 'result', raceId: r.id, ranked, counted, sof, table, you: results.get(p.id), profile: fresh ? profileOf(fresh) : null });
      p.inRace = false;
    }
    this.race = null;
  }
}
