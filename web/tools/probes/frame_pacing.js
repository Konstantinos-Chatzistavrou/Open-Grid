// Frame pacing probe for the free-roam budget (docs/minimum_spec.md). Run it inside the live game with the persistent headless browser:
//   HEADLESS=1 node tools/cdp.mjs start "http://127.0.0.1:5173/?menu=0&touch=0&user=drive_test&quality=low&scale=1&cap=0&ai=5" 1280x863   (1280x863 gives a 1280x720 picture)
//   HEADLESS=1 node tools/cdp.mjs file tools/probes/frame_pacing.js
// ?cap=0 removes the 30 fps lock so the real headroom shows; ?quality=low&scale=1 pins the preset and the resolution. Reads 300 frames after a 5 s settle.
// Numbers are for the machine it runs on (headless Chrome, its integrated GPU): the median says how much headroom there is, the p95 how often a frame would miss a 33.3 ms (30 fps) deadline.
(async () => {
  const g = window.__game;
  await new Promise((r) => setTimeout(r, 5000));
  const d = []; let last = performance.now();
  await new Promise((res) => { const f = (t) => { d.push(t - last); last = t; if (d.length < 300) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  d.shift(); d.sort((a, b) => a - b);
  const q = (p) => +d[Math.floor(p * (d.length - 1))].toFixed(1);
  const perf = (document.getElementById('perf') || document.querySelector('[id*=perf]'))?.textContent?.slice(0, 120) ?? null;
  return JSON.stringify({ w: innerWidth, h: innerHeight, ai: g.ai.cars.length, median_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), fps_median: +(1000 / q(0.5)).toFixed(1), perf });
})()
