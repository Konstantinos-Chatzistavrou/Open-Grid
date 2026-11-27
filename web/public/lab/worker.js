// Tyre Lab worker: the WebAssembly module (rs::mf62 + rs::tirfit, the code CI checks against MFeval) runs here so a fit never freezes the page.
import createTyreLab from './tyrelab.js';

let M;
const ready = createTyreLab().then((m) => { M = m; });

const str = (s) => M.stringToNewUTF8(s);
function withStrings(strs, fn) {
  const ptrs = strs.map(str);
  try { return fn(...ptrs); } finally { ptrs.forEach((p) => M._free(p)); }
}

const ops = {
  fit: (csv, tmpl, sets, angleSign, aligning, combined) =>
    JSON.parse(M.UTF8ToString(withStrings([csv, tmpl, sets], (a, b, c) => M._lab_fit(a, b, c, angleSign, aligning ? 1 : 0, combined ? 1 : 0)))),
  demo: (tir, noise) => M.UTF8ToString(withStrings([tir], (a) => M._lab_demo(a, noise))),
  rows: (csv, angleSign) => JSON.parse(M.UTF8ToString(withStrings([csv], (a) => M._lab_rows(a, angleSign)))),
  info: (tir) => JSON.parse(M.UTF8ToString(withStrings([tir], (a) => M._lab_tyre_info(a)))),
  curves: (tir, jobs) => withStrings([tir], (t) => jobs.map((j) => {
    const n = M._lab_curve(t, j.channel, j.fz, j.gamma, j.x0, j.x1, j.n);
    const at = M._lab_curve_ptr() / 8;
    return Array.from(M.HEAPF64.subarray(at, at + n));
  })),
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    await ready;
    self.postMessage({ id, ok: true, result: ops[op](...args) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
