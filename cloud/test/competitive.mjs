// Apache-2.0 — Comprehensive deterministic tests for OpenGrid's Competitive Online Moat:
// Real PBKDF2-SHA256 Email/Password Auth, Ad-Free Subscription Entitlements, Glicko-2 DR & SOF,
// Fault-Aware Safety Rating (0x Victim Shield), License Fast-Track Promotion/Demotion, Bad-Sport Quarantine,
// Balanced SOF Split Seeding, Seasonal Championship Drop-Week Points, and Restorative Protest Refunds.
// Runs directly in Node 24+ (native TS stripping) in <1s -> runs on every GitHub CI build!
import assert from 'node:assert/strict';
import { emailError, hashPassword, hmacSha256Hex, normalizeEmail, passwordError, timingSafeEqualHex, verifyPassword } from '../src/auth.ts';
import {
  OFFICIAL_SERIES, TRIAL_DURATION_MS, applyDropWeeks, calcChampionshipPoints,
  computeRestorativeVerdict, computeSof, driverGradeOf, evaluateSafetyAndLicense,
  isSubscriptionActive, nextEventForSeries, seedBalancedSplits, updateDriverRatings,
} from '../src/ratings.ts';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  [PASS] ${name}`);
}

// 1. Real PBKDF2-HMAC-SHA256 Email + Password Authentication
await test('PBKDF2-SHA256 password hashing & constant-time verification', async () => {
  assert.equal(normalizeEmail('  Driver@OpenGrid.GG '), 'driver@opengrid.gg');
  assert.equal(emailError('driver@opengrid.gg'), null);
  assert.notEqual(emailError('not-an-email'), null);
  assert.notEqual(passwordError('short'), null);
  assert.equal(passwordError('ApexRacing2026!'), null);

  const { hash, salt } = await hashPassword('ApexRacing2026!');
  assert.equal(hash.length, 64);
  assert.equal(salt.length, 32);
  assert.equal(await verifyPassword('ApexRacing2026!', hash, salt), true);
  assert.equal(await verifyPassword('WrongPassword99!', hash, salt), false);
});

await test('HMAC-SHA256 billing webhook signature verification', async () => {
  const payload = JSON.stringify({ accountId: 'acct_123', tier: 'pro', expiresAt: Date.now() + 30 * 86400e3 });
  const sig = await hmacSha256Hex('whsec_test_key', payload);
  const sig2 = await hmacSha256Hex('whsec_test_key', payload);
  const bad = await hmacSha256Hex('wrong_secret', payload);
  assert.equal(timingSafeEqualHex(sig, sig2), true);
  assert.equal(timingSafeEqualHex(sig, bad), false);
});

// 2. Ad-Free Subscription & 7-Day Trial Entitlements
await test('Ad-free subscription trial, pro, and expiry gating', () => {
  const now = 1_795_000_000_000;
  assert.equal(isSubscriptionActive('trial', now + TRIAL_DURATION_MS, now), true);
  assert.equal(isSubscriptionActive('trial', now - 1000, now), false);
  assert.equal(isSubscriptionActive('pro', now + 86400e3, now), true);
  assert.equal(isSubscriptionActive('pro', now - 1000, now), false);
  assert.equal(isSubscriptionActive('none', 0, now), false);
});

// 3. Glicko-2 Driver Rating & Strength of Field (SOF)
await test('Glicko-2 DR rewards beating stronger field & converges RD cleanly', () => {
  const field = [
    { id: 'underdog', dr: 1400, rd: 160, finished: true, dnf: false },
    { id: 'alien', dr: 2400, rd: 60, finished: true, dnf: false },
    { id: 'mid1', dr: 1650, rd: 90, finished: true, dnf: false },
    { id: 'mid2', dr: 1600, rd: 90, finished: true, dnf: false },
    { id: 'mid3', dr: 1550, rd: 90, finished: true, dnf: false },
    { id: 'back', dr: 1300, rd: 140, finished: true, dnf: false },
  ];
  const { sof, updates } = updateDriverRatings(field);
  assert.ok(sof > 1550 && sof < 2100, `SOF ${sof} out of range`);
  assert.ok(updates.get('underdog').drDelta > 25, 'Underdog winning strong field must gain large DR');
  assert.ok(updates.get('back').drDelta < -5, 'Last place must lose DR');
  assert.ok(updates.get('underdog').rdAfter < 160, 'RD shrinks after official race');
  assert.equal(driverGradeOf(2800), 'S');
  assert.equal(driverGradeOf(1500), 'C');
});

// 4. Fault-Aware Safety Rating (0x Victim Shield!), License Ladder & Bad-Sport Quarantine
await test('Fault-Aware SR protects innocent victims (0x) while punishing at-fault rammers (4x)', () => {
  const victim = evaluateSafetyAndLicense({
    sr: 3.10, license: 'D', mprRaces: 2, rollingCpi: 28, badSport: false, cleanStreak: 12,
    cornersCompleted: 36, offTrack1x: 0, lossControl2x: 0, atFaultContact4x: 0, victimShield0x: 2,
    isOfficialMprEligible: true,
  });
  assert.equal(victim.incidentPoints, 0);
  assert.ok(victim.srAfter > victim.srBefore, 'Blameless victim with 0x shield must GAIN SR, never lose it!');

  const rammer = evaluateSafetyAndLicense({
    sr: 1.45, license: 'R', mprRaces: 0, rollingCpi: 10, badSport: false, cleanStreak: 0,
    cornersCompleted: 20, offTrack1x: 2, lossControl2x: 1, atFaultContact4x: 3, victimShield0x: 0,
    isOfficialMprEligible: true,
  });
  assert.equal(rammer.incidentPoints, 16);
  assert.ok(rammer.srAfter < 1.25, 'Heavy rammer drops below 1.25 SR');
  assert.equal(rammer.badSportAfter, true, 'Heavy rammer enters Bad-Sport Quarantine');

  // Lifting quarantine requires >= 15 consecutive clean corners & SR >= 1.50
  const reformed = evaluateSafetyAndLicense({
    sr: 1.40, license: 'R', mprRaces: 1, rollingCpi: 18, badSport: true, cleanStreak: 0,
    cornersCompleted: 24, offTrack1x: 0, lossControl2x: 0, atFaultContact4x: 0, victimShield0x: 0,
    isOfficialMprEligible: true,
  });
  assert.equal(reformed.badSportAfter, false, '24 consecutive clean corners lifts Bad-Sport Quarantine');
});

await test('Fast-Track License Promotion (R -> D) and Demotion (C -> D)', () => {
  const promo = evaluateSafetyAndLicense({
    sr: 3.92, license: 'R', mprRaces: 3, rollingCpi: 35, badSport: false, cleanStreak: 20,
    cornersCompleted: 36, offTrack1x: 0, lossControl2x: 0, atFaultContact4x: 0, victimShield0x: 0,
    isOfficialMprEligible: true,
  });
  assert.equal(promo.promoted, true);
  assert.equal(promo.licenseAfter, 'D');
  assert.equal(promo.srAfter, 3.4);

  const demo = evaluateSafetyAndLicense({
    sr: 1.05, license: 'C', mprRaces: 2, rollingCpi: 10, badSport: false, cleanStreak: 0,
    cornersCompleted: 20, offTrack1x: 2, lossControl2x: 1, atFaultContact4x: 2, victimShield0x: 0,
    isOfficialMprEligible: true,
  });
  assert.equal(demo.demoted, true);
  assert.equal(demo.licenseAfter, 'D');
});

// 5. Balanced SOF Split Seeding & Strict Rammer Isolation
await test('Balanced SOF Splits isolate Bad-Sport rammers & keep top split highest SOF', () => {
  const regs = [];
  for (let i = 0; i < 22; i++) regs.push({ account: `clean_${i}`, dr: 1200 + i * 80, sr: 3.2, badSport: false });
  for (let i = 0; i < 3; i++) regs.push({ account: `rammer_${i}`, dr: 2600 + i * 50, sr: 0.9, badSport: true });

  const ev = nextEventForSeries(OFFICIAL_SERIES[1]);
  const splits = seedBalancedSplits(ev.eventKey, regs, 16);
  assert.equal(splits.length, 3, '22 clean (max 16) -> 2 balanced splits of 11 + 1 isolated bad-sport split');
  assert.equal(splits[0].splitNo, 1);
  assert.equal(splits[0].accounts.length, 11);
  assert.equal(splits[1].splitNo, 2);
  assert.equal(splits[1].accounts.length, 11);
  assert.ok(splits[0].sof > splits[1].sof + 500, `Split 1 SOF (${splits[0].sof}) must clearly exceed Split 2 (${splits[1].sof})`);
  assert.equal(splits[2].splitNo, -1);
  assert.equal(splits[2].badSportSplit, true);
  assert.equal(splits[2].accounts.length, 3);
  assert.ok(!splits[0].accounts.some((a) => a.startsWith('rammer_')), 'High-DR rammers NEVER enter clean Split 1!');
});

// 6. SOF Championship Points & Drop Weeks + Restorative Protests
await test('SOF championship points scale with SOF and keep best 8 of 12 rounds', () => {
  const s1Win = calcChampionshipPoints(1, 16, 3000, 1.25);
  const s2Win = calcChampionshipPoints(1, 16, 1500, 1.25);
  const s1Last = calcChampionshipPoints(16, 16, 3000, 1.25);
  assert.ok(s1Win > s2Win * 1.8 && s1Win > s1Last * 4);
  const { total, kept } = applyDropWeeks([100, 90, 80, 120, 110, 40, 20, 130, 95, 85, 10, 105], 8);
  assert.equal(kept.length, 8);
  assert.equal(total, 130 + 120 + 110 + 105 + 100 + 95 + 90 + 85);
});

await test('Restorative Protest refunds 100% of lost victim DR & SR and quarantines intentional wrecker', () => {
  const v = computeRestorativeVerdict(1820, 1772.5, 3.60, 3.12, 'intentional_wreck');
  assert.equal(v.drRefund, 47.5);
  assert.equal(v.srRefund, 0.48);
  assert.equal(v.offenderQuarantine, true);
  assert.equal(v.offenderStrike, true);
  assert.equal(v.offenderSrPenalty, 0.75);
});

console.log(`\nALL ${passed} OpenGrid Competitive Online Moat tests PASSED`);
