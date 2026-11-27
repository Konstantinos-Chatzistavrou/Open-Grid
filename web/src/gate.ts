// The welcome gate: the first screen a new player sees, before the title. They either play as a guest (nothing to type, progress
// stays on this device, upgradable to a full account any time from the Profile) or sign in / sign up (email + password, or
// Google / GitHub / Discord where the online service has them). The choice is remembered per browser, so a returning player
// goes straight to the title; signing out brings the gate back. All account work itself lives in menu.ts + cloud.ts, this
// file only decides WHETHER the gate shows and remembers the answer, so it has no DOM and is tested on its own
// (tools/test_gate.mjs).

const KEY = 'nr.gate.v1';

export type GateChoice = 'guest' | 'account';

/** What this browser chose last time, or null when it never passed the gate (or storage is blocked). */
export function gateChoice(): GateChoice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'guest' || v === 'account' ? v : null;
  } catch { return null; }
}

export function markGate(choice: GateChoice): void {
  try { localStorage.setItem(KEY, choice); } catch { /* storage blocked: the gate shows again next time, nothing breaks */ }
}

/** Sign out: the next start asks again. */
export function clearGate(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export interface GateInput {
  /** ?gate=0 in the URL (test tools, deep links) */
  skipParam: boolean;
  /** what gateChoice() returned */
  chosen: GateChoice | null;
  /** an online account already exists on this device, or a valid username was picked here before the gate existed */
  returning: boolean;
  /** this page load is the return from a Google / GitHub / Discord redirect: the player just signed in */
  oauthReturn: boolean;
}

/** true when the welcome screen must come before the title. */
export function needsGate(i: GateInput): boolean {
  return !(i.skipParam || i.chosen !== null || i.returning || i.oauthReturn);
}
