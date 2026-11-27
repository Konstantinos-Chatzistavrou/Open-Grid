// Welcome gate tests (src/gate.ts): WHEN the guest / log in / sign up screen shows, and that the choice is remembered.
// No browser: localStorage is a stub, and a blocked / throwing storage must never break the game.
// Usage: node tools/test_gate.mjs   (exit code 1 on failure)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-'));
fs.writeFileSync(path.join(tmp, 'gate.mjs'), stripTypeScriptTypes(fs.readFileSync(path.join(here, '../src/gate.ts'), 'utf8'), { mode: 'transform' }));

let store = new Map();
let blocked = false;
globalThis.localStorage = {
  getItem: (k) => { if (blocked) throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (blocked) throw new Error('SecurityError'); store.set(k, String(v)); },
  removeItem: (k) => { if (blocked) throw new Error('SecurityError'); store.delete(k); },
};
const G = await import(pathToFileURL(path.join(tmp, 'gate.mjs')).href);
fs.rmSync(tmp, { recursive: true, force: true });

let fails = 0, checks = 0;
function ok(name, cond) { checks++; if (!cond) { fails++; console.log(`FAIL  ${name}`); } }

const fresh = { skipParam: false, chosen: null, returning: false, oauthReturn: false };

// a brand-new visitor sees the gate; each reason to skip it works on its own
ok('new visitor: gate shows', G.needsGate(fresh) === true);
ok('?gate=0 skips it', G.needsGate({ ...fresh, skipParam: true }) === false);
ok('a remembered guest choice skips it', G.needsGate({ ...fresh, chosen: 'guest' }) === false);
ok('a remembered account choice skips it', G.needsGate({ ...fresh, chosen: 'account' }) === false);
ok('an existing account / username here skips it (players from before the gate)', G.needsGate({ ...fresh, returning: true }) === false);
ok('coming back from a Google / GitHub / Discord sign-in skips it', G.needsGate({ ...fresh, oauthReturn: true }) === false);

// persistence round trip
ok('nothing chosen yet', G.gateChoice() === null);
G.markGate('guest');
ok('guest remembered', G.gateChoice() === 'guest');
G.markGate('account');
ok('account replaces guest (upgrade)', G.gateChoice() === 'account');
G.clearGate();
ok('sign out clears it: the gate comes back', G.gateChoice() === null && G.needsGate({ ...fresh, chosen: G.gateChoice() }) === true);

// garbage in storage is treated as "never chose"
store.set('nr.gate.v1', 'admin');
ok('unknown stored value ignored', G.gateChoice() === null);
store.set('nr.gate.v1', '');
ok('empty stored value ignored', G.gateChoice() === null);

// blocked storage (private mode, cookies off): no exceptions, the gate simply shows again next start
blocked = true;
let threw = false;
try { G.markGate('guest'); G.clearGate(); ok('blocked storage reads as null', G.gateChoice() === null); } catch { threw = true; }
ok('blocked storage never throws', !threw);

console.log(`gate: ${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
