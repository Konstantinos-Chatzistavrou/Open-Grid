// Room server tests: starts server/rooms.js in-process on a spare port and drives it with real WebSocket clients.
// Run: npm test   (or node test_rooms.mjs)
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createRoomServer, loadConfig } from './rooms.js';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(url, opts = {}) {
    this.msgs = [];
    this.closed = false;
    this.ws = new WebSocket(url, opts);
    this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); this.msgs.push(m); this.id ??= m.t === 'welcome' ? m.id : undefined; });
    this.ws.on('close', () => { this.closed = true; });
    this.ws.on('error', () => { this.closed = true; });
  }
  static async open(url, hello, opts) {
    const c = new Client(url, opts);
    await c.until((m) => m.t === 'welcome');
    if (hello) c.send({ t: 'hello', car: 'tornado_gt', paint: 0xff1111, city: 'nyc', ...hello });
    return c;
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  of(t) { return this.msgs.filter((m) => m.t === t); }
  async until(pred, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = this.msgs.find(pred); if (m) return m; await wait(10); }
    throw new Error(`timed out waiting; saw ${JSON.stringify(this.msgs.map((m) => m.t))}`);
  }
  close() { this.ws.close(); }
}
const pose = (x, z = 0) => ({ t: 'pose', c: 255, p: { x, y: 0, z, qx: 0, qy: 0, qz: 0, qw: 1, vx: 10, vy: 0, vz: 0 } });

const rs = createRoomServer({ ...loadConfig({}), port: 0, maxPerRoom: 3, maxPerIp: 50, aoi: 400, near: 100, farEvery: 3 });
const port = await rs.listen();
const url = `ws://127.0.0.1:${port}`;

await check('welcome carries an id, then hello gets the lobby and a start', async () => {
  const a = await Client.open(url, { name: 'Alice' });
  const lobby = await a.until((m) => m.t === 'lobby');
  assert.equal(lobby.mode, 'free'); assert.equal(lobby.phase, 'driving'); assert.equal(lobby.cap, 3);
  assert.deepEqual(lobby.members.map((m) => m.name), ['Alice']);
  await a.until((m) => m.t === 'start');
  a.send({ t: 'loaded' });
  await a.until((m) => m.t === 'go');
  a.close(); await wait(100);
});

await check('a player nearby gets the pose with the sender id, the sender does not get it back', async () => {
  const a = await Client.open(url, { name: 'Anna' }), b = await Client.open(url, { name: 'Ben' });
  await a.until((m) => m.t === 'lobby'); await b.until((m) => m.t === 'lobby');
  b.send(pose(10));                       // b needs a position to be seen from
  a.send(pose(0));
  const got = await b.until((m) => m.t === 'pose' && m.id === a.id);
  assert.equal(got.p.x, 0); assert.equal(got.c, 255);
  await wait(100);
  assert.equal(a.of('pose').filter((m) => m.id === a.id).length, 0);
  a.close(); b.close(); await wait(100);
});

await check('players beyond the view radius get nothing; leaving the radius removes the car', async () => {
  const a = await Client.open(url, { name: 'Near' }), b = await Client.open(url, { name: 'Far' });
  await a.until((m) => m.t === 'lobby'); await b.until((m) => m.t === 'lobby');
  b.send(pose(0));
  a.send(pose(100)); await b.until((m) => m.t === 'pose' && m.id === a.id);
  a.send(pose(5000)); await b.until((m) => m.t === 'gone' && m.id === a.id);
  const before = b.of('pose').length;
  a.send(pose(5010)); a.send(pose(5020)); await wait(150);
  assert.equal(b.of('pose').length, before, 'no poses from out of range');
  a.close(); b.close(); await wait(100);
});

await check('far cars (inside the view radius, beyond NEAR) arrive every third pose; near cars every pose', async () => {
  const a = await Client.open(url, { name: 'Sender' }), b = await Client.open(url, { name: 'Viewer' });
  await a.until((m) => m.t === 'lobby'); await b.until((m) => m.t === 'lobby');
  b.send(pose(0));
  for (let i = 0; i < 12; i++) { a.send(pose(300)); await wait(5); }
  await wait(150);
  const n = b.of('pose').filter((m) => m.id === a.id).length;
  assert.ok(n >= 3 && n <= 6, `far poses received: ${n} of 12`);
  a.close(); b.close(); await wait(100);
});

await check('different cities are separate rooms', async () => {
  const a = await Client.open(url, { name: 'Nyc', city: 'nyc' }), b = await Client.open(url, { name: 'Tokyo', city: 'tokyo' });
  await a.until((m) => m.t === 'lobby'); await b.until((m) => m.t === 'lobby');
  a.send(pose(0)); b.send(pose(0)); await wait(150);
  assert.equal(b.of('pose').length, 0); assert.equal(a.of('pose').length, 0);
  assert.deepEqual(b.of('lobby')[0].members.map((m) => m.name), ['Tokyo']);
  a.close(); b.close(); await wait(100);
});

await check('a duplicate name is refused, and a full city is refused', async () => {
  const a = await Client.open(url, { name: 'Same' });
  await a.until((m) => m.t === 'lobby');
  const dup = await Client.open(url, { name: 'same' });
  assert.match((await dup.until((m) => m.t === 'bye')).reason, /already/);
  const b = await Client.open(url, { name: 'Two' }), c = await Client.open(url, { name: 'Three' });
  await b.until((m) => m.t === 'lobby'); await c.until((m) => m.t === 'lobby');
  const full = await Client.open(url, { name: 'Four' });
  assert.match((await full.until((m) => m.t === 'bye')).reason, /full/);
  for (const x of [a, b, c, dup, full]) x.close();
  await wait(150);
});

await check('bad poses are dropped (NaN, out of range, not a quaternion)', async () => {
  const a = await Client.open(url, { name: 'Bad' }), b = await Client.open(url, { name: 'Good' });
  await a.until((m) => m.t === 'lobby'); await b.until((m) => m.t === 'lobby');
  b.send(pose(0));
  a.send({ t: 'pose', p: { x: 'a', y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 } });
  a.send({ t: 'pose', p: { x: 1e9, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 } });
  a.send({ t: 'pose', p: { x: 1, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 0 } });
  await wait(150);
  assert.equal(b.of('pose').length, 0);
  a.close(); b.close(); await wait(100);
});

await check('pose rate limit: a flood is cut to the burst allowance', async () => {
  const a = await Client.open(url, { name: 'Flood' }), b = await Client.open(url, { name: 'Calm' });
  await a.until((m) => m.t === 'lobby'); await b.until((m) => m.t === 'lobby');
  b.send(pose(0));
  for (let i = 0; i < 300; i++) a.send(pose(1));
  await wait(300);
  const n = b.of('pose').length;
  assert.ok(n > 0 && n < 120, `relayed ${n} of 300`);
  assert.ok(rs.stats.posesDropped > 100, `dropped ${rs.stats.posesDropped}`);
  a.close(); b.close(); await wait(100);
});

await check('/health and /status answer', async () => {
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.ok, true); assert.equal(typeof h.bytesOut, 'number');
  const s = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  assert.equal(s.protocol, 1); assert.equal(s.passwordRequired, false);
});

await check('oversized messages close the connection', async () => {
  const a = await Client.open(url, { name: 'Huge' });
  await a.until((m) => m.t === 'lobby');
  a.ws.send('x'.repeat(20000));
  await wait(200);
  assert.equal(a.closed, true);
});

await rs.close();

// password and origin checks need their own server settings
const locked = createRoomServer({ ...loadConfig({}), port: 0, password: 'hunter2', origins: ['https://open-grid.racing'], maxPerIp: 2 });
const lport = await locked.listen();
const lurl = `ws://127.0.0.1:${lport}`;
await check('wrong password is refused, right password joins', async () => {
  const bad = await Client.open(lurl, { name: 'Nope', pw: 'wrong' }, { origin: 'https://open-grid.racing' });
  assert.match((await bad.until((m) => m.t === 'bye')).reason, /password/);
  const ok = await Client.open(lurl, { name: 'Yes', pw: 'hunter2' }, { origin: 'https://open-grid.racing' });
  await ok.until((m) => m.t === 'lobby');
  assert.equal((await (await fetch(`http://127.0.0.1:${lport}/status`)).json()).passwordRequired, true);
  bad.close(); ok.close(); await wait(100);
});
await check('a web origin that is not allowed cannot connect; neither can a third connection from one address', async () => {
  const evil = new Client(lurl, { origin: 'https://evil.example' });
  await wait(300);
  assert.equal(evil.closed, true); assert.equal(evil.msgs.length, 0);
  const o = { origin: 'https://open-grid.racing' };
  const a = await Client.open(lurl, null, o), b = await Client.open(lurl, null, o);
  const third = new Client(lurl, o);
  await wait(300);
  assert.equal(third.closed, true); assert.equal(third.msgs.length, 0);
  a.close(); b.close(); await wait(100);
});
await locked.close();

console.log(failures ? `\n${failures} room server test(s) FAILED` : '\nall room server tests passed');
process.exit(failures ? 1 : 0);
