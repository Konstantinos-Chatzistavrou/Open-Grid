// Open Grid room server (optional, self-hosted): a big Free Roam lobby for people who have a server to run it on.
// The game's normal parties are peer to peer (web/src/party.ts): the leader's browser relays everyone's cars, which
// is fine for ~16 friends and nothing more. This is the same relay as a small standalone program with no browser
// in the middle, so the only limit is your server and its bandwidth. Think of Minecraft's server.jar next to
// "Open to LAN". Nobody has to run one; the free game never needs it.
//
//   npm install && npm run rooms          (PORT env, default 9100)
//   players join with   https://open-grid.racing/?server=wss://your-host   (or your own copy of the web build)
//
// What it does
//   - speaks the party protocol of party.ts over WebSocket (JSON), so the client changes are small
//   - one room per city (the city a player sends in "hello"): players only see players in the same city
//   - only sends each car to players near it (AOI_RADIUS_M), and far cars at a lower rate (FAR_EVERY)
//   - free roam only: cars are ghosts on the client (no collisions), garage sharing is not relayed
//   - abuse limits: message size, per-connection rate limits, connections per address, heartbeat, optional password
// What it does not do: accounts, ranked results, anti-cheat. Everything a client sends is checked for shape and
// range only, so treat it as a casual server. IP addresses are used in memory for the connection limit and are never
// logged or stored.
//
// Settings (environment variables, all optional):
//   PORT 9100 · SERVER_NAME · SERVER_PASSWORD (empty = open) · MAX_PLAYERS per city room (64) · MAX_TOTAL (0 = no limit)
//   MAX_PER_IP (4) · AOI_RADIUS_M (400) · NEAR_RADIUS_M (120) · FAR_EVERY (3) · RADIO_RANGE_M (5000)
//   ALLOWED_ORIGINS (comma separated web origins; empty = any) · PROXIED=1 (behind a reverse proxy: trust X-Forwarded-For)
// Health and server-list data: GET /health (counters) and GET /status (name, players, cities); both allow any origin.
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 9100),
    name: String(env.SERVER_NAME || 'Open Grid Server').slice(0, 48),
    password: String(env.SERVER_PASSWORD || ''),
    maxPerRoom: Math.min(500, Math.max(2, Math.floor(num(env.MAX_PLAYERS, 64)))),
    maxTotal: Math.floor(num(env.MAX_TOTAL, 0)),
    maxPerIp: Math.floor(num(env.MAX_PER_IP, 4)),
    aoi: num(env.AOI_RADIUS_M, 400),
    near: num(env.NEAR_RADIUS_M, 120),
    farEvery: Math.max(1, Math.floor(num(env.FAR_EVERY, 3))),
    radioRange: num(env.RADIO_RANGE_M, 5000),
    origins: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    proxied: !!env.PROXIED,
  };
}

const PROTOCOL = 1;
const USERNAME_MAX = 16;                 // web/src/username.ts
const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 15_000, DEAD_MS = 45_000;
const LOBBY_DEBOUNCE_MS = 500;           // a burst of joins sends one member list, not one each
const SLOW_BYTES = 1 << 20, DEAD_BYTES = 8 << 20;   // a client this far behind misses poses; far beyond that is dropped
const WORLD_M = 50_000;
const HYSTERESIS = 1.15;                 // a car leaves your view at 1.15x the distance it entered at (no flicker)

const fin = (o, keys) => keys.every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>#\s]/g, '').trim().slice(0, USERNAME_MAX) : '');
const cleanCity = (s) => (typeof s === 'string' && /^[a-z]{1,16}$/.test(s) ? s : 'default');

function cleanPose(p) {
  if (!p || typeof p !== 'object' || !fin(p, ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'])) return null;
  if (Math.abs(p.x) > WORLD_M || Math.abs(p.y) > WORLD_M || Math.abs(p.z) > WORLD_M) return null;
  const ql = Math.hypot(p.qx, p.qy, p.qz, p.qw);
  if (ql < 0.5 || ql > 1.5) return null;
  const out = { x: p.x, y: p.y, z: p.z, qx: p.qx, qy: p.qy, qz: p.qz, qw: p.qw };
  if (fin(p, ['vx', 'vy', 'vz']) && Math.hypot(p.vx, p.vy, p.vz) < 150) { out.vx = p.vx; out.vy = p.vy; out.vz = p.vz; }
  return out;
}

function bucket(rate, burst) { return { tokens: burst, last: Date.now(), rate, burst }; }
function take(b, now) {
  b.tokens = Math.min(b.burst, b.tokens + ((now - b.last) * b.rate) / 1000);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const samePassword = (given, wanted) => crypto.timingSafeEqual(sha(given ?? ''), sha(wanted));

export function createRoomServer(cfg = loadConfig()) {
  const rooms = new Map();               // city -> Map(id -> client)
  const perIp = new Map();               // address -> open connections
  const stats = { bytesOut: 0, msgsOut: 0, bytesIn: 0, msgsIn: 0, posesDropped: 0, joins: 0, rejected: 0, started: Date.now() };
  const aoi2 = cfg.aoi * cfg.aoi, aoiOut2 = aoi2 * HYSTERESIS * HYSTERESIS, near2 = cfg.near * cfg.near;
  let total = 0;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });

  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (req.url === '/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, players: total, uptime: Math.round(process.uptime()), cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000), ...stats }));
    } else if (req.url === '/status') {
      const cities = {};
      for (const [city, room] of rooms) cities[city] = room.size;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: cfg.name, protocol: PROTOCOL, players: total, maxPerCity: cfg.maxPerRoom, passwordRequired: !!cfg.password, cities }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${cfg.name} (Open Grid room server). Join with ?server=wss://<this host> on a web build of the game.`);
    }
  });

  const addrOf = (req) => (cfg.proxied ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';

  server.on('upgrade', (req, socket, head) => {
    const reject = (code, why) => { stats.rejected++; socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const origin = req.headers.origin;
    if (cfg.origins.length && !cfg.origins.includes(origin)) return reject(403, 'Forbidden');
    const ip = addrOf(req);
    if ((perIp.get(ip) ?? 0) >= cfg.maxPerIp) return reject(429, 'Too Many Requests');
    if (cfg.maxTotal && total >= cfg.maxTotal) return reject(503, 'Server Full');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  });

  // ---- sending ----------------------------------------------------------------------------------
  function sendRaw(c, str, len = Buffer.byteLength(str)) {
    const ws = c.ws;
    if (ws.readyState !== 1) return false;
    if (ws.bufferedAmount > DEAD_BYTES) { ws.terminate(); return false; }
    if (ws.bufferedAmount > SLOW_BYTES) return false;      // a slow client skips this one; the next pose replaces it
    ws.send(str);
    stats.bytesOut += len; stats.msgsOut++;
    return true;
  }
  const sendJSON = (c, obj) => sendRaw(c, JSON.stringify(obj));

  const memberOf = (c) => ({ id: c.id, name: c.name, car: c.car, paint: c.paint, host: false, ready: true, skin: c.skin, look: c.look, city: c.city });
  function lobbyMsg(room) {
    return { t: 'lobby', members: [...room.values()].filter((c) => c.joined).map(memberOf), mode: 'free', laps: 3, realism: true, copMode: false, phase: 'driving', cap: cfg.maxPerRoom };
  }
  const roomTimers = new Map();
  function scheduleLobby(city) {
    if (roomTimers.has(city)) return;
    roomTimers.set(city, setTimeout(() => {
      roomTimers.delete(city);
      const room = rooms.get(city);
      if (!room) return;
      const str = JSON.stringify(lobbyMsg(room));
      const len = Buffer.byteLength(str);
      for (const c of room.values()) if (c.joined) sendRaw(c, str, len);
    }, LOBBY_DEBOUNCE_MS));
  }

  // ---- joining and leaving ----------------------------------------------------------------------
  function onConnection(ws, ip) {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    total++;
    const c = {
      id: crypto.randomBytes(6).toString('base64url'), ws, ip, joined: false, city: 'default',
      name: '', car: '', paint: 0, skin: undefined, look: undefined,
      pos: null, seq: 0, viewers: new Set(),
      poseBucket: bucket(30, 40), msgBucket: bucket(20, 30), strikes: 0, alive: true, lastSeen: Date.now(),
    };
    const helloTimer = setTimeout(() => { if (!c.joined) ws.close(1008, 'hello timeout'); }, HELLO_TIMEOUT_MS);
    ws.on('pong', () => { c.alive = true; c.lastSeen = Date.now(); });
    ws.on('message', (data, isBinary) => {
      stats.bytesIn += data.length; stats.msgsIn++;
      c.alive = true; c.lastSeen = Date.now();
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      onMessage(c, m);
    });
    const done = () => { clearTimeout(helloTimer); leave(c); };
    ws.on('close', done);
    ws.on('error', done);
    sendJSON(c, { t: 'welcome', id: c.id, name: cfg.name, cap: cfg.maxPerRoom, protocol: PROTOCOL });
  }

  let gone = new WeakSet();
  function leave(c) {
    if (gone.has(c)) return;
    gone.add(c);
    total--;
    const n = (perIp.get(c.ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(c.ip); else perIp.set(c.ip, n);
    if (!c.joined) return;
    const room = rooms.get(c.city);
    if (!room) return;
    room.delete(c.id);
    const bye = JSON.stringify({ t: 'gone', id: c.id });
    for (const id of c.viewers) { const o = room.get(id); if (o) sendRaw(o, bye); }
    c.viewers.clear();
    for (const o of room.values()) o.viewers.delete(c.id);
    if (room.size === 0) { rooms.delete(c.city); clearTimeout(roomTimers.get(c.city)); roomTimers.delete(c.city); }
    else scheduleLobby(c.city);
  }

  function refuse(c, reason) {
    stats.rejected++;
    sendJSON(c, { t: 'bye', reason });
    setTimeout(() => c.ws.close(1000, 'refused'), 300);
  }

  function hello(c, m) {
    if (cfg.password && !samePassword(m.pw, cfg.password)) return refuse(c, 'Wrong server password.');
    const name = cleanName(m.name) || 'Driver';
    const city = c.joined ? c.city : cleanCity(m.city);
    let room = rooms.get(city);
    if (!room) { room = new Map(); }
    if (!c.joined && room.size >= cfg.maxPerRoom) return refuse(c, `That server is full (${cfg.maxPerRoom} players in this city).`);
    for (const o of room.values()) if (o !== c && o.name.toLowerCase() === name.toLowerCase()) return refuse(c, `${name} is already on this server.`);
    c.name = name;
    c.car = typeof m.car === 'string' ? m.car.slice(0, 32) : '';
    c.paint = Number.isInteger(m.paint) && m.paint >= 0 && m.paint <= 0xffffff ? m.paint : 0;
    c.skin = typeof m.skin === 'string' ? m.skin.slice(0, 32) : undefined;
    c.look = m.look && typeof m.look === 'object' && JSON.stringify(m.look).length <= 1500 ? m.look : undefined;
    if (!c.joined) {
      c.joined = true; c.city = city;
      rooms.set(city, room);
      room.set(c.id, c);
      stats.joins++;
      sendJSON(c, lobbyMsg(room));
      sendJSON(c, { t: 'start', mode: 'free', laps: 3, realism: true, copMode: false });   // load straight into Free Roam
    }
    scheduleLobby(city);
  }

  // ---- relaying ---------------------------------------------------------------------------------
  const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

  function relayPose(c, p, paint) {
    c.pos = p; c.seq++;
    const room = rooms.get(c.city);
    if (!room) return;
    const msg = JSON.stringify({ t: 'pose', id: c.id, p, c: paint });
    const len = Buffer.byteLength(msg);
    const bye = JSON.stringify({ t: 'gone', id: c.id });
    const far = c.seq % cfg.farEvery === 0;
    for (const o of room.values()) {
      if (o === c || !o.joined || !o.pos) continue;
      const dist2 = d2(p, o.pos);
      const sees = c.viewers.has(o.id);
      if (dist2 <= (sees ? aoiOut2 : aoi2)) {
        if (!sees || dist2 <= near2 || far) { sendRaw(o, msg, len); c.viewers.add(o.id); }
      } else if (sees) {
        sendRaw(o, bye); c.viewers.delete(o.id);
      }
    }
  }

  /** To the players who currently see this car (events that belong to what is happening around it). */
  function toViewers(c, obj) {
    const room = rooms.get(c.city);
    if (!room) return;
    const str = JSON.stringify(obj);
    const len = Buffer.byteLength(str);
    for (const id of c.viewers) { const o = room.get(id); if (o) sendRaw(o, str, len); }
  }
  /** To everyone in the city within `range` metres of this car (it has to have sent a pose first). */
  function toNear(c, obj, range) {
    const room = rooms.get(c.city);
    if (!room || !c.pos) return;
    const str = JSON.stringify(obj);
    const len = Buffer.byteLength(str);
    const r2 = range * range;
    for (const o of room.values()) if (o !== c && o.joined && o.pos && d2(c.pos, o.pos) <= r2) sendRaw(o, str, len);
  }
  function toAll(c, obj) {
    const room = rooms.get(c.city);
    if (!room) return;
    const str = JSON.stringify(obj);
    const len = Buffer.byteLength(str);
    for (const o of room.values()) if (o !== c && o.joined) sendRaw(o, str, len);
  }

  function onMessage(c, m) {
    const now = Date.now();
    if (m.t === 'pose') {
      if (!c.joined) return;
      if (!take(c.poseBucket, now)) { stats.posesDropped++; if (++c.strikes > 600) c.ws.close(1008, 'too fast'); return; }
      const p = cleanPose(m.p);
      if (p) relayPose(c, p, Number.isInteger(m.c) && m.c >= 0 && m.c <= 0xffffff ? m.c : undefined);
      return;
    }
    if (!take(c.msgBucket, now)) { if (++c.strikes > 600) c.ws.close(1008, 'too fast'); return; }
    if (m.t === 'hello') return hello(c, m);
    if (!c.joined) return;
    switch (m.t) {
      case 'loaded': sendJSON(c, { t: 'go' }); break;
      case 'gone':
        toViewers(c, { t: 'gone', id: c.id });
        c.viewers.clear(); c.pos = null;
        break;
      case 'flash': toViewers(c, { t: 'flash', id: c.id }); break;
      case 'pole':
        if (fin(m, ['x', 'y', 'vx', 'vz'])) toNear(c, { t: 'pole', id: c.id, x: m.x, y: m.y, vx: m.vx, vz: m.vz }, cfg.aoi * 2);
        break;
      case 'breach':
        if (m.b && fin(m.b, ['cx', 'cy', 'face', 'u', 'seed'])) toNear(c, { t: 'breach', id: c.id, b: { cx: m.b.cx, cy: m.b.cy, face: m.b.face, u: m.b.u, seed: m.b.seed } }, cfg.aoi * 2);
        break;
      case 'wager':
        if (m.w && typeof m.w === 'object' && typeof m.w.wagerId === 'string' && JSON.stringify(m.w).length <= 1000) toViewers(c, { t: 'wager', id: c.id, w: m.w });
        break;
      case 'zone':
        if (m.z && typeof m.z === 'object' && typeof m.z.zoneId === 'string' && Number.isFinite(m.z.score) && JSON.stringify(m.z).length <= 1000) toAll(c, { t: 'zone', id: c.id, z: m.z });
        break;
      case 'radio': {
        const r = m.r;
        if (!r || typeof r.text !== 'string' || !fin(r, ['x', 'z'])) break;
        const text = r.text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
        if (!text) break;
        toNear(c, { t: 'radio', id: c.id, r: { from: cleanName(r.from) || c.name, text, x: r.x, z: r.z, mode: 'free', ts: Date.now() } }, cfg.radioRange);
        break;
      }
      default: break;     // prog (races), gstate / gevent / gwalk (co-op garage): not relayed by this server
    }
  }

  // ---- housekeeping -----------------------------------------------------------------------------
  const beat = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) ws.ping();
    for (const room of rooms.values()) for (const c of room.values()) if (now - c.lastSeen > DEAD_MS) c.ws.terminate();
  }, PING_MS);
  beat.unref();

  return {
    server, wss, stats, config: cfg,
    players: () => total,
    listen: () => new Promise((resolve) => server.listen(cfg.port, () => resolve(server.address().port))),
    close: async () => {
      clearInterval(beat);
      for (const t of roomTimers.values()) clearTimeout(t);
      for (const room of rooms.values()) for (const c of room.values()) { try { sendJSON(c, { t: 'bye', reason: 'The server is shutting down.' }); c.ws.close(1001); } catch { /* gone */ } }
      await new Promise((r) => setTimeout(r, 100));
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => server.close(r));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rs = createRoomServer(loadConfig());
  const port = await rs.listen();
  console.log(`room server "${rs.config.name}" listening on :${port} (${rs.config.maxPerRoom} players per city, view ${rs.config.aoi} m${rs.config.password ? ', password protected' : ''})`);
  const stop = async () => { await rs.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
