// Room-server check for src/party.ts (Party.joinServer): two pages in one Chrome (tools/party/harness.html, Vite dev
// server running) join server/rooms.js, which this script starts itself. Checks: join + auto start + GO, member
// list, pose relay near, a far car is taken away (gone), a taken name and a bad address are refused, leaving.
// Usage: node tools/party_server_test.mjs [http://127.0.0.1:5173]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRoomServer, loadConfig } from '../../server/rooms.js';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const port = Number(process.env.CDP_PORT ?? 9336);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-partyserver-'));
const chrome = spawn('google-chrome', [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--headless=new', '--no-sandbox', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rs = createRoomServer({ ...loadConfig({}), port: 0, maxPerIp: 50 });
const sport = await rs.listen();
const addr = `ws://127.0.0.1:${sport}`;

async function page() {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${base}/tools/party/harness.html`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const ev = async (expr) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const d = await new Promise((r) => pending.set(id, r));
    if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description ?? 'eval error');
    return d.result.result.value;
  };
  for (let i = 0; i < 60 && !(await ev('!!window.ready').catch(() => false)); i++) await sleep(250);
  return ev;
}
const waitFor = async (ev, expr, ms = 15000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) if (await ev(expr)) return true; throw new Error('timeout: ' + expr); };
const check = (name, cond) => { assert.ok(cond, name); console.log('  ok  ' + name); };

try {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(250); } }
  const A = await page(), B = await page(), C = await page();
  const me = (name) => `{ name: '${name}', car: 'vela_gt', paint: 0xff0000, city: 'nyc' }`;

  check('joined a room server', (await A(`P.joinServer('${addr}', ${me('Alice')}).then((p) => { window.p = p; hooks(p, 'A'); return p.isServer; })`)) === true);
  await waitFor(A, `log.some((l) => l[1] === 'start')`);
  await waitFor(A, `log.some((l) => l[1] === 'go')`);
  check('the server starts Free Roam for us (start, then go after we are loaded)', true);
  check('the party knows the server cap and has a self id from the server', (await A(`p.maxMembers`)) === 64 && (await A(`typeof p.selfId`)) === 'string' && (await A(`p.selfId.length > 4`)));

  await B(`P.joinServer('${addr}', ${me('Bob')}).then((p) => { window.p = p; hooks(p, 'B'); return 1; })`);
  await waitFor(A, `p.members.length === 2`);
  await waitFor(B, `p.members.length === 2`);
  check('both players see two members', JSON.stringify(await B('p.members.map((m) => m.name).sort()')) === '["Alice","Bob"]');
  check('nobody is a leader (the server is)', (await B('p.isHost')) === false && (await B('p.members.every((m) => !m.host)')));

  await B(`(p.sendPose({ x: 5, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, 7), 1)`);
  await sleep(100);
  await A(`(p.sendPose({ x: 12.5, y: 0, z: 1, qx: 0, qy: 0, qz: 0, qw: 1, vx: 3, vy: 0, vz: 0 }, 255), 1)`);
  await waitFor(B, `log.some((l) => l[1] === 'pose' && l[2] === 12.5 && l[3] === 255)`);
  check('a nearby car arrives with its position and paint', true);

  await A(`(p.sendPose({ x: 9000, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, 255), 1)`);
  await waitFor(B, `log.some((l) => l[1] === 'gone')`);
  check('a car that drives out of view is taken off the road (gone)', true);

  check('a taken name is refused', /already/i.test(await C(`P.joinServer('${addr}', ${me('alice')}).then(() => 'joined', (e) => e.message)`)));
  check('a bad address is refused', /address/i.test(await C(`P.joinServer('not a host!', ${me('Carl')}).then(() => 'joined', (e) => e.message)`)));
  check('a server that is not there is refused', /connect|answer|closed/i.test(await C(`P.joinServer('ws://127.0.0.1:1', ${me('Carl')}).then(() => 'joined', (e) => e.message)`)));

  await B(`(p.leave(), 1)`);
  await waitFor(A, `p.members.length === 1`);
  check('leaving updates the member list', true);

  console.log('\nall party-server checks passed');
} finally {
  chrome.kill();
  await rs.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(0);
