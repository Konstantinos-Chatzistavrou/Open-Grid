// What does the background traffic cost? (docs/minimum_spec.md.) A/B inside ONE page so the scene, camera and machine state are the same: car counts 0, 64, 256, 0, 64, 256, each measured over 240 frames after a 4 s settle.
//   cd web && npx vite --port 5173 --host 127.0.0.1 &
//   HEADLESS=1 node tools/cdp.mjs start "http://127.0.0.1:5173/?menu=0&touch=0&quality=low&scale=1&cap=0&ai=5&city=london&traffic=1" 1280x863      (1280x863 gives a 1280x720 picture)
//   CPU_THROTTLE=4 HEADLESS=1 node tools/cdp.mjs file tools/probes/traffic_cost.js                                                                (main thread 4x slower: makes small costs visible)
// Read it as: `update_ms` is the CPU time of the traffic simulation plus writing the instances (the reliable number, divide by the throttle for real time); the frame means are only meaningful if the two
// 0-car runs agree with each other, because the gap between them is the noise floor: an effect smaller than that gap is not measured.
(async () => {
  const t = window.__game.cityTraffic;
  if (!t) return 'no traffic: start a free run in a city (?menu=0) first';
  t.setCount = () => {};                                   // the game re-applies its tier every second; this run decides the count itself
  const player = () => ({ x: t.prev.x, y: -t.prev.z, vx: 0, vy: 0 });
  const out = [];
  for (const n of [0, 64, 256, 0, 64, 256]) {
    t.sim.setCount(n);
    if (n > 0) { t.sim.reset(player()); for (let i = 0; i < 80; i++) t.sim.update(0.1, player()); }   // a settled street, not a fresh spawn
    else t.sim.update(0.1, player());
    await new Promise((r) => setTimeout(r, 4000));
    const d = [], upd = []; let last = performance.now();
    await new Promise((res) => { const f = (now) => { d.push(now - last); last = now; upd.push(t.lastUpdateMs); if (d.length < 240) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    d.shift();
    const s = [...d].sort((a, b) => a - b), q = (p) => +s[Math.floor(p * (s.length - 1))].toFixed(1);
    out.push({ cars: t.sim.agents.length, drawn: t.drawn, mean_ms: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1), median_ms: q(0.5), p95_ms: q(0.95), update_ms: +(upd.reduce((a, b) => a + b, 0) / upd.length).toFixed(3) });
  }
  return JSON.stringify(out);
})()
