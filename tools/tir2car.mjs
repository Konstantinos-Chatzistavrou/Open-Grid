#!/usr/bin/env node
// Magic Formula tyre property file (.tir, PAC2002 / MF 5.2 / 6.1 / 6.2) -> the "tire_front" / "tire_rear" block of a
// data/cars/*.json car (schema car/1, read by core/src/config.cpp parse_tire).
//
//   node tools/tir2car.mjs data/tires/audi_245_40R18_pac2002.tir                 # print the converted block
//   node tools/tir2car.mjs <file.tir> --apply data/cars/vela_gt.json [--ky-front 1 --ky-rear 1.16]
//       replaces the fitted curve SHAPE of both axles' tyres (stiffness, curvature, load and camber sensitivity,
//       aligning torque, vertical stiffness) and keeps each tyre's own size, radius, inertia, relaxation lengths,
//       rolling resistance, combined-slip block (if the file has none) and PEAK FRICTION (mu): peak grip is the
//       per-car calibration against published tests; scaling it is what the MF scaling factors (LMUX/LMUY) are for.
//       Slip stiffness is scaled with it (LKX/LKY = LMUX/LMUY) so the peak stays at the fitted slip.
//
// Conventions. Tyre files use ISO-W axes for a LEFT tyre: Fy = K (alpha + SHy) + SVy with K < 0 (PKY1 negative),
// camber positive = top tilted to the right. Our core uses +alpha -> +Fy (K > 0) and camber positive = top tilted
// LEFT, so alpha_ours = -alpha_iso, gamma_ours = -gamma_iso, and every coefficient that is odd in alpha or gamma
// changes sign (worked out term by term below). Left-tyre-only offsets (ply steer, conicity: PHX1/2, PVX1/2, PHY1/2,
// PVY1/2, QHZ1/2, QDZ6/7) are zeroed: a real car has mirrored tyres left and right, so they cancel; with one parameter
// set for all four wheels they would pull the car to one side. For the same reason every other term that is not
// invariant under the full mirror (alpha, gamma) -> (-alpha, -gamma) is zeroed (PEY3, QBZ4, QDZ3): with one fit on all
// four wheels a left turn must behave like a right turn. Scaling factors LFZO, LMUX/Y, LKX/Y, LCX/Y, LEX/Y are
// applied before conversion.
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
if (!file) { console.error('usage: tir2car.mjs <file.tir> [--apply car.json] [--ky-front k] [--ky-rear k]'); process.exit(1); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const P = {};
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*([^$!]*)/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^'|'$/g, '');
  P[m[1]] = /^[-+0-9.eE]+$/.test(v) ? Number(v) : v;
}
const g = (k, d = 0) => (typeof P[k] === 'number' ? P[k] : d);
const L = (k) => g(k, 1);   // scaling factor (1 if absent)

const fz0 = g('FNOMIN', 4000) * L('LFZO');
const mux = g('PDX1') * L('LMUX'), muy = g('PDY1') * L('LMUY');
const r4 = (x) => +x.toPrecision(5);

/** The converted tyre block (peak mu as fitted; --apply keeps the car's own). */
function convert() {
  return {
    source: `${file.split('/').pop()} (${P.PROPERTY_FILE_FORMAT ?? 'FITTYP ' + P.FITTYP}): fitted Magic Formula + Simcenter 2606 / MF 6.2 carcass, converted by tools/tir2car.mjs`,
    fz0_n: r4(fz0),
    vertical_stiffness_n_per_m: r4(g('VERTICAL_STIFFNESS', 220000)),
    vertical_damping_ns_per_m: r4(g('VERTICAL_DAMPING', 2000)),
    breff: r4(g('BREFF', 8.4)),
    dreff: r4(g('DREFF', 0.27)),
    freff: r4(g('FREFF', 0.07)),
    pfz1: r4(g('PFZ1', 0.72)),
    mbelt_kg: r4(g('MBELT', 5.4)),
    section_width_m: r4(g('WIDTH', 0.245)),
    aspect_ratio: r4(g('ASPECT_RATIO', 0.40)),
    longitudinal: {
      C: r4(g('PCX1') * L('LCX')),
      mu: r4(mux),
      load_sensitivity: r4(g('PDX2') / g('PDX1')),          // ours: mu (1 + pdx2 dfz)
      camber_sensitivity: r4(g('PDX3')),                    // even in gamma
      E: r4(g('PEX1') * L('LEX')), pEx2: r4(g('PEX2')), pEx3: r4(g('PEX3')), pEx4: r4(g('PEX4')),   // kappa: same sign
      slip_stiffness_per_load: r4(g('PKX1') * L('LKX')), pKx2: r4(g('PKX2')), pKx3: r4(g('PKX3')),
      pTx1: r4(g('PTX1', 2.3657)), pTx2: r4(g('PTX2', 1.4112)), pTx3: r4(g('PTX3', 0.56626)),
      pPx1: r4(g('PPX1', -0.3485)), pPx2: r4(g('PPX2', 0.37824)), pPx3: r4(g('PPX3', -0.09603)), pPx4: r4(g('PPX4', 0.06518)),
    },
    lateral: {
      C: r4(g('PCY1') * L('LCY')),
      mu: r4(muy),
      load_sensitivity: r4(g('PDY2') / g('PDY1')),
      camber_sensitivity: r4(g('PDY3')),                    // (1 - pDy3 gamma^2): even
      E: r4(g('PEY1') * L('LEY')), pEy2: r4(g('PEY2')),
      pEy3: 0,                                              // curvature by sgn(alpha) alone: a left-tyre asymmetry (zeroed, see below)
      pEy4: r4(g('PEY4')),                                  // gamma * sgn(alpha): even -> keeps
      cornering_stiffness_per_fz0: r4(Math.abs(g('PKY1')) * L('LKY')),
      cornering_stiffness_peak_load: r4(g('PKY2')),
      camber_stiffness_factor: r4(g('PKY3')),               // |gamma|: even
      pHy1: 0, pHy2: 0,                                     // left-tyre ply steer: cancels on a car
      pHy3: r4(g('PHY3')),                                  // K (alpha + pHy3 gamma): both flip -> keeps
      pVy1: 0, pVy2: 0,                                     // conicity: cancels on a car
      pVy3: r4(-g('PVY3')), pVy4: r4(-g('PVY4')),            // Fz pVy3 gamma: gamma flips, Fy doesn't -> flips
      pTy1: r4(g('PTY1', 2.1439)), pTy2: r4(g('PTY2', 1.9829)),
      pPy1: r4(g('PPY1', -0.6255)), pPy2: r4(g('PPY2', -0.06523)), pPy3: r4(g('PPY3', -0.16666)), pPy4: r4(g('PPY4', 0.2811)),
    },
    aligning: {
      qBz1: r4(g('QBZ1')), qBz2: r4(g('QBZ2')), qBz3: r4(g('QBZ3')),
      qBz4: 0,                                              // trail stiffness by gamma alone: not mirror-symmetric (zeroed)
      qBz5: r4(g('QBZ5')),                                  // |gamma|
      qCz1: r4(g('QCZ1')),
      qDz1: r4(g('QDZ1')), qDz2: r4(g('QDZ2')),
      qDz3: 0, qDz4: r4(g('QDZ4')),                         // peak trail by gamma alone: not mirror-symmetric (zeroed) / gamma^2 even
      qEz1: r4(g('QEZ1')), qEz2: r4(g('QEZ2')), qEz3: r4(g('QEZ3')),
      qEz4: 0,                                              // atan(Bt Ct alpha) without gamma: breaks L/R symmetry at gamma=0 (zeroed)
      qEz5: r4(g('QEZ5')),                                  // gamma * atan(Bt Ct alpha): both gamma and alpha flip -> EVEN, keep sign
      qHz1: 0, qHz2: 0,                                     // left-tyre offsets
      qHz3: r4(g('QHZ3')), qHz4: r4(g('QHZ4')),              // shift of alpha by gamma: both flip -> keeps
      qBz9: r4(g('QBZ9')), qBz10: r4(g('QBZ10')),
      qDz6: 0, qDz7: 0,                                     // residual torque at zero slip (conicity)
      qDz8: r4(-g('QDZ8')), qDz9: r4(-g('QDZ9')),            // gamma: odd
      sSz1: 0, sSz2: r4(g('SSZ2')), sSz3: r4(-g('SSZ3')), sSz4: r4(-g('SSZ4')),
      qTz1: r4(g('QTZ1', 0.2)),
    },
    ...(typeof P.PDYP1 === 'number' ? { turn_slip: { pDyp1: g('PDYP1'), pDyp2: g('PDYP2'), pDyp3: g('PDYP3'), pDyp4: g('PDYP4'), pKyp1: g('PKYP1', 1) } } : {}),
    ...(typeof P.NOMPRES === 'number' ? { pressure_nominal_kpa: r4(P.NOMPRES / 1000) } : {}),
    ...(typeof P.LMUV === 'number' && P.LMUV > 0 ? { friction_speed_decay: P.LMUV } : {}),
  };
}

const tyre = convert();
const apply = opt('--apply');
if (!apply) { console.log(JSON.stringify(tyre, null, 2)); process.exit(0); }

const car = JSON.parse(fs.readFileSync(apply, 'utf8'));
for (const [axle, ky, widthOpt, arOpt] of [
  ['tire_front', Number(opt('--ky-front', 1)), Number(opt('--width-front', tyre.section_width_m)), Number(opt('--ar-front', tyre.aspect_ratio))],
  ['tire_rear',  Number(opt('--ky-rear', 1)),  Number(opt('--width-rear',  tyre.section_width_m)), Number(opt('--ar-rear',  tyre.aspect_ratio))],
]) {
  const t = car[axle];
  if (!t) continue;
  const keep = { mux: t.longitudinal.mu, muy: t.lateral.mu };
  t.source = tyre.source + (ky !== 1 ? `, cornering stiffness x${ky} for the section width` : '');
  t.fz0_n = tyre.fz0_n;
  t.vertical_stiffness_n_per_m = tyre.vertical_stiffness_n_per_m;
  t.vertical_damping_ns_per_m = tyre.vertical_damping_ns_per_m;
  t.breff = tyre.breff;
  t.dreff = tyre.dreff;
  t.freff = tyre.freff;
  t.pfz1 = tyre.pfz1;
  t.section_width_m = r4(widthOpt);
  t.aspect_ratio = r4(arOpt);
  // Scale steel belt mass physically by section width and loaded radius relative to the 245/40 R18 lab tire:
  const widthScale = widthOpt / tyre.section_width_m;
  const radScale = (t.radius_m || 0.327) / 0.327;
  t.mbelt_kg = r4(tyre.mbelt_kg * (0.35 + 0.65 * widthScale) * (0.4 + 0.6 * radScale));
  // Grip and stiffness scale together (LMU and LK by the same factor): the fitted curve keeps its shape in slip, so the
  // peak stays at the fitted slip ratio / slip angle. Raising mu alone would move the peak out (a softer, slower tyre).
  const sx = keep.mux / tyre.longitudinal.mu, sy = keep.muy / tyre.lateral.mu;
  t.longitudinal = { ...tyre.longitudinal, mu: keep.mux, slip_stiffness_per_load: r4(tyre.longitudinal.slip_stiffness_per_load * sx) };
  t.lateral = { ...tyre.lateral, mu: keep.muy, cornering_stiffness_per_fz0: r4(tyre.lateral.cornering_stiffness_per_fz0 * sy * ky) };
  t.aligning = tyre.aligning;
  if (tyre.turn_slip) t.turn_slip = tyre.turn_slip;
}
fs.writeFileSync(apply, JSON.stringify(car, null, 2) + '\n');
console.log(`applied ${file} to ${apply} (peak mu kept: front ${car.tire_front.longitudinal.mu}/${car.tire_front.lateral.mu}, rear ${car.tire_rear?.longitudinal.mu}/${car.tire_rear?.lateral.mu})`);
