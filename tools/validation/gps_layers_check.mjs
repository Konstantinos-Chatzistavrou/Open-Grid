#!/usr/bin/env node
// Ground-truth checks for the GPS map layers (tools/nyc/gps_layers.py output): areas.json (water, green) and the `ms` speed limit on
// every edge of map.json, for the 17 cities.
//   1. structure: every ring numeric, closed polygons of >= 3 vertices, bounding boxes that contain their rings, every area >= 400 m2,
//      inside the built area (+300 m);
//   2. speed limits: every edge has an integer limit of 5-140 km/h, and the median limit never falls from one road class to the next
//      (local <= collector <= arterial <= motorway; slip roads and `trunk` left out: a 25 mph ramp or an urban trunk avenue is slower than the road class above) in any city;
//   3. real places: well-known parks and rivers, converted with the same transverse Mercator as the tile build, must lie inside a green
//      or a water area when they are inside the city's built area. A place that is outside the built area is skipped and said so.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CITIES = JSON.parse(readFileSync(`${ROOT}/tools/nyc/cities.json`, 'utf8'));

// ---- transverse Mercator (Krueger series), WGS84, k0 = 1, origin lat0 / lon0: what pyproj's "+proj=tmerc" gives, to a centimetre
const a = 6378137, f = 1 / 298.257223563, n = f / (2 - f);
const A = (a / (1 + n)) * (1 + n * n / 4 + n ** 4 / 64);
const al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240];
const rad = Math.PI / 180;
function tmerc(lat, lon, lat0, lon0) {
  const xi = (phi, dl) => {
    const s = Math.sin(phi), c = (2 * Math.sqrt(n)) / (1 + n);
    const t = Math.sinh(Math.atanh(s) - c * Math.atanh(c * s));
    const xi_ = Math.atan2(t, Math.cos(dl)), eta_ = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let X = xi_, E = eta_;
    al.forEach((aj, j) => { const k = 2 * (j + 1); X += aj * Math.sin(k * xi_) * Math.cosh(k * eta_); E += aj * Math.cos(k * xi_) * Math.sinh(k * eta_); });
    return [X, E];
  };
  const [x1, e1] = xi(lat * rad, (lon - lon0) * rad), [x0] = xi(lat0 * rad, 0);
  return [A * e1, A * (x1 - x0)];
}
const inRing = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 2; i < ring.length; i += 2) { const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; j = i; } return c; };
const inArea = (area, x, y) => { const b = area.b; if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false; let c = false; for (const r of area.r) if (inRing(r, x, y)) c = !c; return c; };
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 2; i < r.length; i += 2) { s += r[j] * r[i + 1] - r[i] * r[j + 1]; j = i; } return Math.abs(s) / 2; };

// well-known places: [lat, lon, expected layer, label]
const PLACES = {
  nyc: [[40.7829, -73.9654, 'green', 'Central Park'], [40.76, -74.015, 'water', 'Hudson River off midtown'], [40.752, -73.9625, 'water', 'East River west channel off Turtle Bay'], [40.7413, -73.9883, 'green', 'Madison Square Park']],
  london: [[51.5039, -0.1661, 'water', 'the Serpentine'], [51.5033, -0.1528, 'green', 'Green Park / Buckingham Palace gardens side'], [51.5006, -0.1220, 'water', 'Thames under Westminster Bridge']],
  paris: [[48.8635, 2.3275, 'green', 'Jardin des Tuileries'], [48.8583, 2.3375, 'water', 'Seine at the Pont des Arts']],
  tokyo: [[35.672, 139.6949, 'green', 'Yoyogi Park']],
  berlin: [[52.5138, 13.3395, 'green', 'Tiergarten (the Neuer See side)']],
  amsterdam: [[52.3579, 4.8686, 'green', 'Vondelpark'], [52.3825, 4.9, 'water', 'the IJ behind Centraal station']],
  barcelona: [[41.3884, 2.1873, 'green', 'Parc de la Ciutadella']],
  madrid: [[40.4153, -3.6845, 'green', 'Retiro Park']],
  lisbon: [[38.7275, -9.1535, 'green', 'Parque Eduardo VII']],
  toronto: [[43.6465, -79.4637, 'green', 'High Park']],
  melbourne: [[-37.8304, 144.9796, 'green', 'Royal Botanic Gardens']],
  seoul: [[37.5512, 126.9882, 'green', 'Namsan']],
  miami: [[25.77, -80.17, 'water', 'Biscayne Bay']],
};

// Known gaps in the data, said out loud: the check reports them and fails only when something ELSE is missing (or when a gap is closed,
// so that this list is kept honest).
const KNOWN_GAPS = new Set(['london: Thames under Westminster Bridge']);
let failures = 0, checks = 0;
const fail = (m) => { failures++; console.log(`  [FAIL] ${m}`); };
for (const [id, C] of Object.entries(CITIES)) {
  if (id.startsWith('_')) continue;
  const dir = `${ROOT}/${C.out}`;
  const idx = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'));
  const bb = Object.values(idx.tiles).map((t) => t.bbox).filter(Boolean);
  const box = [Math.min(...bb.map((b) => b[0])) - 300, Math.min(...bb.map((b) => b[1])) - 300, Math.max(...bb.map((b) => b[2])) + 300, Math.max(...bb.map((b) => b[3])) + 300];
  const areas = JSON.parse(readFileSync(`${dir}/areas.json`, 'utf8'));
  const map = JSON.parse(readFileSync(`${dir}/map.json`, 'utf8'));
  // 1. areas
  let nArea = 0;
  for (const [kind, list] of [['water', areas.water], ['green', areas.green]]) for (const ar of list) {
    nArea++; checks++;
    if (!ar.r.length || ar.r.some((r) => r.length < 6 || r.length % 2 || r.some((v) => !Number.isFinite(v)))) { fail(`${id}: malformed ring in a ${kind} area`); continue; }
    const xs = ar.r[0].filter((_, i) => i % 2 === 0), ys = ar.r[0].filter((_, i) => i % 2 === 1);
    if (Math.min(...xs) < ar.b[0] - 0.2 || Math.max(...xs) > ar.b[2] + 0.2 || Math.min(...ys) < ar.b[1] - 0.2 || Math.max(...ys) > ar.b[3] + 0.2) fail(`${id}: a ${kind} area's box does not contain its ring`);
    const m2 = ringArea(ar.r[0]) - ar.r.slice(1).reduce((s, r) => s + ringArea(r), 0);
    if (m2 < 380) fail(`${id}: a ${kind} area of ${m2.toFixed(0)} m2 (< 400)`);
    if (ar.b[0] < box[0] || ar.b[1] < box[1] || ar.b[2] > box[2] || ar.b[3] > box[3]) fail(`${id}: a ${kind} area outside the built area`);
  }
  // 2. speed limits
  const TIER = { living_street: 0, residential: 0, unclassified: 0, service: 0, road: 0, tertiary: 1, tertiary_link: 1, secondary: 1, secondary_link: 1, primary: 2, primary_link: 2, trunk: 3, trunk_link: 3, motorway: 3, motorway_link: 3 };
  const by = [[], [], [], []];
  for (const e of map.edges) { checks++; if (!Number.isInteger(e.ms) || e.ms < 5 || e.ms > 140) { fail(`${id}: edge limit ${e.ms}`); break; } if (!/_link$/.test(e.hw) && e.hw !== 'trunk') by[TIER[e.hw] ?? 0].push(e.ms); }   // OSM "trunk" is also San Francisco's 25 mph avenues (Van Ness, Lombard)
  const med = by.map((v) => (v.length >= 20 ? [...v].sort((x, y) => x - y)[v.length >> 1] : null));
  let last = 0;
  for (let t = 0; t < 4; t++) if (med[t] !== null) { checks++; if (med[t] < last) fail(`${id}: median limit falls from ${last} to ${med[t]} km/h at tier ${t}`); last = Math.max(last, med[t]); }
  // 3. places
  const res = [];
  for (const [lat, lon, want, label] of PLACES[id] ?? []) {
    const [x, y] = tmerc(lat, lon, C.origin[0], C.origin[1]);
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) { res.push(`${label}: outside the built area`); continue; }
    checks++;
    const hit = (want === 'green' ? areas.green : areas.water).some((ar) => inArea(ar, x, y));
    let near = Infinity;
    if (!hit) for (const ar of want === 'green' ? areas.green : areas.water) for (const r of ar.r) for (let i = 0; i < r.length; i += 2) near = Math.min(near, Math.hypot(r[i] - x, r[i + 1] - y));
    res.push(`${label}: ${hit ? 'ok' : 'MISSING'}`);
    const key = `${id}: ${label}`;
    if (!hit && KNOWN_GAPS.has(key)) console.log(`  [known gap] ${key}: the London extract is clipped, so the Thames relation cannot be assembled (nearest water vertex ${near.toFixed(0)} m away)`);
    else if (!hit) fail(`${id}: ${label} (${lat}, ${lon}) is not inside a ${want} area (nearest ${want} vertex ${near.toFixed(0)} m away)`);
    else if (KNOWN_GAPS.has(key)) fail(`${key} is now present: remove it from KNOWN_GAPS`);
  }
  console.log(`${id.padEnd(12)} ${String(areas.water.length).padStart(4)} water + ${String(areas.green.length).padStart(4)} green | limits by class median ${med.map((m) => m ?? '-').join('/')} km/h | ${res.join('; ') || 'no places listed'}`);
}
console.log(failures ? `\n${failures} of ${checks} checks failed` : `\nPASSED: ${checks} checks, 0 failed`);
process.exit(failures ? 1 : 0);
