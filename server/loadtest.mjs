// Load test for the room server: connects N bots that drive around and send poses at 20 Hz like the real client,
// then reports what the server sent and used. Use it to size a server before you rent one.
//
//   MAX_PER_IP=1000 MAX_PLAYERS=200 npm run rooms            (the server under test, in another terminal)
//   npm run loadtest -- --url ws://127.0.0.1:9100 --bots 64 --seconds 20 --spread 300
//
//   --bots N       players (default 64)           --seconds S   how long to drive (default 20)
//   --spread M     the bots start scattered within M metres of one point (default 300): small = everyone sees
//                  everyone (worst case), large = most players are out of view of each other (a normal busy city)
//   --city NAME    room to join (default nyc)     --password P  if the server has one
// Run it on a different machine than the server if you can: the bots use CPU too (the server's own CPU is read from /health).
import { WebSocket } from 'ws';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const URL_ = args.url || 'ws://127.0.0.1:9100';
const BOTS = Number(args.bots) || 64;
const SECONDS = Number(args.seconds) || 20;
const SPREAD = Number(args.spread) || 300;
const CITY = args.city || 'nyc';
const HEALTH = URL_.replace(/^ws/, 'http') + '/health';
const HZ = 20;

const health = async () => (await fetch(HEALTH)).json();
const h0 = await health().catch(() => { console.error(`cannot reach ${HEALTH}: is the server running?`); process.exit(1); });

let inBytes = 0, inMsgs = 0, poseMsgs = 0, joined = 0, refused = 0;
const bots = [];
for (let i = 0; i < BOTS; i++) {
  const ws = new WebSocket(URL_);
  const r = Math.sqrt(Math.random()) * SPREAD, a = Math.random() * Math.PI * 2;
  const bot = { ws, cx: Math.cos(a) * r, cz: Math.sin(a) * r, phase: Math.random() * Math.PI * 2, loop: 40 + Math.random() * 60, speed: 15 + Math.random() * 25 };
  ws.on('message', (d) => {
    inBytes += d.length; inMsgs++;
    const m = JSON.parse(d.toString());
    if (m.t === 'welcome') ws.send(JSON.stringify({ t: 'hello', name: `Bot${String(i).padStart(3, '0')}`, car: 'tornado_gt', paint: (i * 4099) & 0xffffff, city: CITY, pw: args.password }));
    else if (m.t === 'lobby' && !bot.joined) { bot.joined = true; joined++; }
    else if (m.t === 'bye') refused++;
    else if (m.t === 'pose') poseMsgs++;
  });
  ws.on('error', () => {});
  bots.push(bot);
  if (i % 16 === 15) await new Promise((r2) => setTimeout(r2, 50));     // stagger the connects a little
}
await new Promise((r) => setTimeout(r, 1500));
console.log(`${joined}/${BOTS} bots in ${CITY} (${refused} refused). Driving for ${SECONDS} s, spread ${SPREAD} m ...`);

const h1 = await health();
const t0 = Date.now();
let sentBytes = 0;
const timer = setInterval(() => {
  const t = (Date.now() - t0) / 1000;
  for (const b of bots) {
    if (!b.joined || b.ws.readyState !== 1) continue;
    const ang = b.phase + (t * b.speed) / b.loop;
    const x = b.cx + Math.cos(ang) * b.loop, z = b.cz + Math.sin(ang) * b.loop;
    const msg = JSON.stringify({ t: 'pose', c: 16711680, p: { x: +x.toFixed(3), y: 0.4, z: +z.toFixed(3), qx: 0, qy: +Math.sin(ang / 2).toFixed(4), qz: 0, qw: +Math.cos(ang / 2).toFixed(4), vx: +(-Math.sin(ang) * b.speed).toFixed(2), vy: 0, vz: +(Math.cos(ang) * b.speed).toFixed(2) } });
    sentBytes += msg.length;
    b.ws.send(msg);
  }
}, 1000 / HZ);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);
const secs = (Date.now() - t0) / 1000;
const h2 = await health();
for (const b of bots) b.ws.close();

const out = (h2.bytesOut - h1.bytesOut) / secs;           // what the server sent (includes the welcome/lobby traffic, tiny)
const cpu = ((h2.cpuMs - h1.cpuMs) / (secs * 1000)) * 100;
const players = Math.max(1, joined);
const fmt = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(2)} MB/s` : `${(b / 1e3).toFixed(1)} KB/s`);
console.log(`
players:                    ${joined}
server sends:               ${fmt(out)}  =  ${((out * 8) / 1e6).toFixed(1)} Mbit/s   (${fmt(out / players)} per player)
server receives:            ${fmt((h2.bytesIn - h1.bytesIn) / secs)}   (${fmt(sentBytes / secs / players)} per player, every pose is checked and relayed)
poses each player received: ${(poseMsgs / players / secs).toFixed(0)} per second  (${(poseMsgs / players / secs / HZ).toFixed(1)} other cars at full rate)
server CPU (one core = 100%): ${cpu.toFixed(0)}%
poses dropped by rate limit: ${h2.posesDropped - h1.posesDropped}
if this load ran 24/7:      about ${((out * 86400 * 30) / 1e12).toFixed(1)} TB of traffic a month
`);
process.exit(0);
