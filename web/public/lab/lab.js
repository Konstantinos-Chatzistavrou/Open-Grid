// OpenGrid Tyre Lab: UI and plots. The numbers all come from the WebAssembly module in worker.js (rs::mf62 + rs::tirfit); this file only moves text around and draws.
import { CHRONO_NOTICE, withNotice } from './notice.js';
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => { const p = pending.get(e.data.id); pending.delete(e.data.id); if (p) (e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error))); };
const rpc = (op, ...args) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); worker.postMessage({ id, op, args }); });

const $ = (id) => document.getElementById(id);
const TEMPLATES = [
  { file: 'audi_245_40R18_pac2002.tir', label: 'Road tyre 245/40 R18 (Project Chrono)' },
  { file: 'pac2002_235_60R16.tir', label: 'Road tyre 235/60 R16' },
  { file: 'classic_185_80R14_pac2002.tir', label: 'Classic 185/80 R14' },
  { file: 'suv_pac2002.tir', label: 'SUV' },
  { file: 'hmmwv_pac2002.tir', label: 'Heavy truck (HMMWV, 35 kN)' },
  { file: 'citybus_pac2002.tir', label: 'City bus' },
];
const GEO = [['FNOMIN', 'Nominal load N'], ['UNLOADED_RADIUS', 'Radius m'], ['WIDTH', 'Width m'], ['ASPECT_RATIO', 'Aspect ratio'], ['RIM_RADIUS', 'Rim radius m'], ['NOMPRES', 'Nominal pressure Pa'], ['INFLPRES', 'Inflation pressure Pa']];
const LOAD_COLORS = ['#38BDF8', '#22C55E', '#F59E0B', '#CBD5E1', '#A78BFA', '#FB7185'];
const tireUrl = (f) => new URL(`../data/tires/${f}`, import.meta.url).href;

const state = { csv: '', rows: [], templateText: '', result: null, plots: [], loads: [] };

// ---- template + geometry
for (const t of TEMPLATES) { const o = document.createElement('option'); o.value = t.file; o.textContent = t.label; $('tmpl').append(o); }
for (const [k, label] of GEO) {
  const l = document.createElement('label');
  l.className = 'field';
  l.append(label);
  const i = document.createElement('input');
  i.type = 'number'; i.step = 'any'; i.id = `geo_${k}`;
  l.append(i);
  $('geo').append(l);
}
const geo = (k) => $(`geo_${k}`);

async function loadTemplate(file) {
  const r = await fetch(tireUrl(file));
  if (!r.ok) throw new Error(`could not load the template ${file} (${r.status})`);
  state.templateText = await r.text();
  const info = await rpc('info', state.templateText);
  if (info.ok) for (const [k] of GEO) geo(k).value = info[k];
}

function applySets(text, values) {   // the same replace-or-append the native tool does with --set
  let out = text;
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^(\\s*${k}\\s*=)[^$\\n]*`, 'mi');
    out = re.test(out) ? out.replace(re, `$1 ${v} `) : `${out}\n${k} = ${v}\n`;
  }
  return out;
}
const geometry = () => Object.fromEntries(GEO.map(([k]) => [k, Number(geo(k).value)]).filter(([, v]) => Number.isFinite(v) && v > 0));

// ---- data
const sign = () => ($('sae').checked ? -1 : 1);
async function setData(csv) {
  state.csv = csv;
  state.result = null;
  $('results').hidden = true;
  const rows = await rpc('rows', csv, sign());
  const sum = $('summary');
  if (rows.error) { state.rows = []; sum.className = 'summary err'; sum.textContent = `The table could not be read: ${rows.error}`; $('fit').disabled = true; return; }
  state.rows = rows;
  const loads = [];
  for (const r of rows) { if (!loads.some((l) => Math.abs(l - r[0]) <= 0.03 * l)) loads.push(r[0]); }
  loads.sort((a, b) => a - b);
  state.loads = loads;
  const count = (i) => rows.filter((r) => r[i] != null).length;
  const range = (i) => { const v = rows.map((r) => r[i]).filter((x) => x != null); return v.length ? [Math.min(...v), Math.max(...v)] : [0, 0]; };
  const fmt = (a, d = 3) => `${Number(a[0].toPrecision(d))} .. ${Number(a[1].toPrecision(d))}`;
  const cam = range(3);
  sum.className = 'summary';
  sum.innerHTML = `${rows.length} rows · ${loads.length} load${loads.length === 1 ? '' : 's'} (${Math.round(loads[0])} .. ${Math.round(loads[loads.length - 1])} N)<br>` +
    `Fx ${count(4)} · Fy ${count(5)} · Mz ${count(6)} rows<br>kappa ${fmt(range(1))} · alpha ${fmt(range(2))} rad · camber ${fmt(cam)} rad` +
    (loads.length < 3 ? '<br><b>Fewer than 3 loads: the load dependence will be poorly determined.</b>' : '');
  // the nominal load of the fit defaults to the median measured load
  const fz = rows.map((r) => r[0]).sort((a, b) => a - b);
  geo('FNOMIN').value = Math.round(fz[Math.floor(fz.length / 2)]);
  $('fit').disabled = false;
}

$('file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await setData(await f.text()); });
$('sae').addEventListener('change', () => { if (state.csv) setData(state.csv); });
$('demo').addEventListener('click', async () => {
  const truth = await (await fetch(tireUrl('audi_245_40R18_pac2002.tir'))).text();
  await setData(await rpc('demo', truth, 0.01));
  $('summary').insertAdjacentHTML('beforeend', '<br><b>Synthetic</b>: generated from the Chrono Audi tyre with 1 % noise. Not a measurement.');
  // a different tyre than the truth, with the truth's size, so the fit has real work to do
  if ($('tmpl').value === 'audi_245_40R18_pac2002.tir') { $('tmpl').value = 'hmmwv_pac2002.tir'; await loadTemplate('hmmwv_pac2002.tir'); }
  for (const [k, v] of Object.entries({ UNLOADED_RADIUS: 0.344, WIDTH: 0.245, ASPECT_RATIO: 0.4, RIM_RADIUS: 0.2286, NOMPRES: 220000, INFLPRES: 220000, FNOMIN: 4850 })) geo(k).value = v;
});
$('tmpl').addEventListener('change', () => loadTemplate($('tmpl').value));

// ---- fit
$('fit').addEventListener('click', async () => {
  $('fit').disabled = true;
  $('busy').textContent = 'Fitting… (a few seconds, in a worker: the page stays responsive)';
  const t0 = performance.now();
  try {
    const tmpl = applySets(state.templateText, geometry());
    const res = await rpc('fit', state.csv, tmpl, '', sign(), $('aligning').checked, $('combined').checked);
    if (!res.ok) throw new Error(res.error);
    state.result = res;
    state.template = tmpl;
    showReport(res);
    $('results').hidden = false;
    await drawPlots();
    $('busy').textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('busy').textContent = `Could not fit: ${err.message}`;
  } finally { $('fit').disabled = false; }
});

function showReport(res) {
  const { report } = res;
  $('notes').innerHTML = report.notes.map((n) => `<p>${escapeHtml(n)}</p>`).join('');
  const tb = $('stages').tBodies[0];
  tb.innerHTML = '';
  for (const s of report.stages) {
    const tr = tb.insertRow();
    const cell = (t, cls) => { const c = tr.insertCell(); c.innerHTML = t; if (cls) c.className = cls; return c; };
    cell(s.name); cell(s.channel);
    cell(String(s.rows), 'r');
    if (!s.ran) { cell('-', 'r'); cell('-', 'r'); cell('-', 'r'); cell(`<span class="pill warn">not fitted</span>${escapeHtml(s.note)}`, 'flags'); continue; }
    cell(String(s.fitted.length), 'r');
    cell(Number(s.rms.toPrecision(3)).toString(), 'r');
    cell(s.rms_percent_of_peak.toFixed(2), 'r');
    const flags = [];
    if (!s.converged) flags.push('<span class="pill warn">iteration limit</span>');
    if (s.at_bounds.length) flags.push(`<span class="pill warn">on a bound</span>${s.at_bounds.join(' ')}`);
    if (s.weakly_determined.length) flags.push(`<span class="pill">barely determined</span>${s.weakly_determined.join(' ')}`);
    cell(flags.join(' '), 'flags');
  }
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([withNotice(state.result.tir, CHRONO_NOTICE)], { type: 'text/plain' }));   // every built-in template is a Project Chrono tyre
  a.download = 'fitted_tyre.tir';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('copy').addEventListener('click', async () => { await navigator.clipboard?.writeText(JSON.stringify(state.result.report, null, 2)); $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy report (JSON)'; }, 1500); });

// ---- plots
function groupRows(kind) {   // kind 0: Fx over kappa (alpha ~ 0); 1 and 2: Fy / Mz over alpha (kappa ~ 0, lowest camber group)
  const rows = state.rows.filter((r) => (kind === 0 ? Math.abs(r[2]) <= 0.003 && r[4] != null : Math.abs(r[1]) <= 0.003 && r[kind === 1 ? 5 : 6] != null));
  if (!rows.length) return [];
  const gmin = Math.min(...rows.map((r) => Math.abs(r[3])));
  const flat = kind === 0 ? rows : rows.filter((r) => Math.abs(r[3]) <= gmin + 0.0087);
  const groups = [];
  for (const r of flat) {
    let g = groups.find((x) => Math.abs(x.fz - r[0]) <= 0.03 * x.fz);
    if (!g) groups.push(g = { fz: r[0], gamma: r[3], pts: [] });
    g.pts.push([kind === 0 ? r[1] : r[2], kind === 0 ? r[4] : (kind === 1 ? r[5] : r[6])]);
  }
  return groups.sort((a, b) => a.fz - b.fz).slice(0, LOAD_COLORS.length);
}

async function drawPlots() {
  const titles = [['slip ratio', 'N'], ['slip angle rad', 'N'], ['slip angle rad', 'N m']];
  state.plots = [];
  const legend = new Map();
  for (let ch = 0; ch < 3; ++ch) {
    const groups = groupRows(ch);
    if (!groups.length) { state.plots.push({ canvas: $(`p${ch}`), empty: true, xlabel: titles[ch][0], ylabel: titles[ch][1] }); continue; }
    const xs = groups.flatMap((g) => g.pts.map((p) => p[0]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const jobs = groups.map((g) => ({ channel: ch, fz: g.fz, gamma: g.gamma, x0, x1, n: 121 }));
    const fitted = await rpc('curves', state.result.tir, jobs), templ = await rpc('curves', state.template, jobs);
    state.plots.push({
      canvas: $(`p${ch}`), xlabel: titles[ch][0], ylabel: titles[ch][1],
      series: groups.map((g, i) => ({ color: LOAD_COLORS[i], pts: g.pts, fit: fitted[i].map((y, k) => [x0 + (x1 - x0) * k / 120, y]), tmpl: templ[i].map((y, k) => [x0 + (x1 - x0) * k / 120, y]) })),
    });
    groups.forEach((g, i) => legend.set(Math.round(g.fz), LOAD_COLORS[i]));
  }
  $('legend').innerHTML = [...legend.entries()].sort((a, b) => a[0] - b[0]).map(([fz, c]) => `<span><i style="background:${c}"></i>${fz} N</span>`).join('');
  redraw();
}
const redraw = () => state.plots.forEach(drawPlot);
window.addEventListener('resize', () => { if (state.plots.length) redraw(); });

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function drawPlot(pl) {
  const c = pl.canvas, dpr = window.devicePixelRatio || 1, cssW = c.clientWidth || 520, cssH = Math.round(cssW * 340 / 520);
  c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  g.font = '500 11px "JetBrains Mono", monospace';
  if (pl.empty) { g.fillStyle = '#8E96A4'; g.fillText('no rows for this channel', 16, 28); return; }
  const L = 62, R = 14, T = 12, B = 38;
  const all = pl.series.flatMap((s) => [...s.pts, ...s.fit, ...s.tmpl]);
  let xmin = Math.min(...all.map((p) => p[0])), xmax = Math.max(...all.map((p) => p[0]));
  let ymin = Math.min(...pl.series.flatMap((s) => [...s.pts, ...s.fit].map((p) => p[1])), 0), ymax = Math.max(...pl.series.flatMap((s) => [...s.pts, ...s.fit].map((p) => p[1])), 0);
  const pad = (ymax - ymin) * 0.06 || 1; ymin -= pad; ymax += pad;
  const X = (x) => L + (x - xmin) / (xmax - xmin) * (cssW - L - R), Y = (y) => T + (1 - (y - ymin) / (ymax - ymin)) * (cssH - T - B);
  g.lineWidth = 1; g.strokeStyle = '#FFFFFF14'; g.fillStyle = '#8E96A4';
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const v of niceTicks(ymin, ymax)) { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(cssW - R, Y(v)); g.stroke(); g.fillText(Number(v.toPrecision(3)).toString(), L - 8, Y(v)); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const v of niceTicks(xmin, xmax, 6)) { g.beginPath(); g.moveTo(X(v), T); g.lineTo(X(v), cssH - B); g.stroke(); g.fillText(Number(v.toPrecision(3)).toString(), X(v), cssH - B + 8); }
  g.strokeStyle = '#FFFFFF55'; g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(cssW - R, Y(0)); g.moveTo(X(0), T); g.lineTo(X(0), cssH - B); g.stroke();
  g.fillStyle = '#8E96A4'; g.textAlign = 'center'; g.fillText(pl.xlabel, (L + cssW - R) / 2, cssH - 14);
  g.save(); g.translate(14, (T + cssH - B) / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText(pl.ylabel, 0, 0); g.restore();
  const line = (pts, dash, w) => { g.setLineDash(dash); g.lineWidth = w; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])))); g.stroke(); g.setLineDash([]); };
  for (const s of pl.series) {
    g.strokeStyle = s.color + '70'; line(s.tmpl, [5, 4], 1.2);
    g.fillStyle = s.color + 'AA';
    const step = Math.max(1, Math.floor(s.pts.length / 70));
    for (let i = 0; i < s.pts.length; i += step) { g.beginPath(); g.arc(X(s.pts[i][0]), Y(s.pts[i][1]), 2.1, 0, 7); g.fill(); }
    g.strokeStyle = s.color; line(s.fit, [], 1.8);
  }
}

// ---- start: a template, and ?demo=1&autofit=1 makes a shareable link that shows the whole thing
(async () => {
  $('tmpl').value = 'hmmwv_pac2002.tir';
  await loadTemplate('hmmwv_pac2002.tir');
  const q = new URLSearchParams(location.search);
  if (q.has('demo')) {
    $('demo').click();
    if (q.has('autofit')) { const wait = async () => { while ($('fit').disabled) await new Promise((r) => setTimeout(r, 50)); $('fit').click(); }; await new Promise((r) => setTimeout(r, 300)); await wait(); }
  }
})();
