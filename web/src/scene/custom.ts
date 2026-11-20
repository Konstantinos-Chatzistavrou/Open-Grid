// Visual customisation, part by part (the garage's Paint / Aero / Wheels / Lights / Glass & exhaust tabs).
// Rules that keep it smooth: everything a player can change is a UNIFORM (colour, roughness, a style index) or an
// object's visibility, never a material swap or a new shader, so changing a part never compiles a pipeline. The few
// new meshes (procedural wings, underglow) are built once per car, hidden until chosen.
//
// Liveries: the models have no paint UV layout, so stripes are drawn in the car's own space (model space, x = left,
// y = up, z = forward) from the world position and a per-car inverse matrix (updated every frame by syncLivery).
import * as THREE from 'three/webgpu';
import { float, materialColor, mix, smoothstep, texture, uniform, uv, vec4 } from 'three/tsl';
import { installDualLayerCarPaint, type CarPaintWgslUniforms } from '../fx/carPaintWgsl';
/** a colour uniform as an rgb node (the typings keep 'color' and 'vec3' apart; the shader does not) */
const rgb = (u: THREE.UniformNode<'color', THREE.Color>) => u as unknown as THREE.Node<'vec3'>;

import { AERO_NAMES, BODY_NAMES } from '../parts-names';
import { BodyFit, DIFFUSERS_FIT, FLARES_FIT, SKIRTS_FIT, SPLITTERS_FIT, exactBox, fittedDiffuser, fittedSkirt, fittedSplitter, reshaped, type FitWheel } from './parts/fit';
import { RIM_SPECS } from './parts/rims';
import { WING_SPECS } from './parts/wings';
import { AERO_FINISHES, HEAD_TINTS, RIM_FINISHES, WINGS, cleanCustom, defaultCustom, type AeroFinish, type Custom, type HeadTint, type RimFinish, type WingKind } from '../custom-data';
export { AERO_FINISHES, DIFFUSERS, FENDERS, FRONT_BUMPERS, GLOW_COLOURS, HEAD_TINTS, HOODS, LIVERIES, PART_COLOURS, REAR_BUMPERS, RIM_FINISHES, RIMS, SKIRTS, SPLITTERS, WINGS, cleanCustom, defaultCustom } from '../custom-data';
export type { AeroFinish, Custom, HeadTint, RimFinish, WingKind } from '../custom-data';

/**
 * Sculpted automotive widebody fender kit that truly molds into THIS car's body contour:
 * - Samples `fit.bodySideAt(y, z, side)` at every station & height so lower bumper/rocker feet NEVER float.
 * - Sweeps a smooth 7-point convex painted dome (single outward-facing winding + full continuous UVs so dual-layer
 *   metallic clearcoat, flakes, liveries & reflections match the body 100% seamlessly — ZERO normal cancellation!).
 * - Adds a crisp recessed dark carbon/matte inner wheel-arch return liner so looking into the wheel well looks factory-finished.
 * - Adds recessed dark-titanium Liberty-Walk / Rocket-Bunny rivet hardware when `p.bolts` is enabled.
 */
function sculptedWidebodyFlares(
  fit: BodyFit,
  paintMat: THREE.Material,
  linerMat: THREE.Material,
  p: { out: number; lip: number; bolts?: boolean },
): THREE.Object3D {
  const g = new THREE.Group();
  const boltGeo = p.bolts ? new THREE.CylinderGeometry(0.0055, 0.0055, 0.006, 8) : null;
  if (boltGeo) boltGeo.rotateZ(Math.PI / 2);

  for (const w of fit.wheels) {
    const s: 1 | -1 = w.x >= 0 ? 1 : -1;
    const R0 = w.r + 0.048;
    const N = 56;
    const a0 = -0.09 * Math.PI;
    const a1 = 1.09 * Math.PI;

    // 7-point smooth painted outer dome profile (from upper inner body seam -> sculpted convex shoulder -> crisp outer lip)
    // Each entry: [radialFrac (0=arch lip, 1=upper body seam), outFrac (0=body surface, 1=full flare outstand)]
    const domeProf: [number, number][] = [
      [1.00, -0.22], // tucked 22% inboard beneath stock panel (hides seam cleanly)
      [0.88,  0.14], // smooth tangent fillet rising out of the stock fender
      [0.68,  0.58], // convex upper shoulder sweep
      [0.44,  0.90], // full automotive haunch bulge
      [0.20,  1.00], // outer crown highlight line
      [0.05,  0.98], // crisp outer arch bevel
      [0.00,  0.86], // rolled lip edge turning inward toward the wheel well
    ];
    const P = domeProf.length;

    const pos: number[] = [];
    const uvArr: number[] = [];
    const idx: number[] = [];

    // Separate recessed dark inner wheel-well return liner (from rolled outer lip back into the wheel well)
    const lPos: number[] = [];
    const lUv: number[] = [];
    const lIdx: number[] = [];

    const clampZ = (z: number) => Math.min(fit.box.max.z - 0.02, Math.max(fit.box.min.z + 0.02, z));

    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const a = a0 + (a1 - a0) * u;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Smooth S-curve taper to 0 at both front & rear feet so the flare melts cleanly into the bumper & rocker
      const endT = THREE.MathUtils.smoothstep(Math.min(1, Math.min(u, 1 - u) / 0.19), 0, 1);
      // Slightly fuller over the top crown of the arch (like real GT3 / Liberty Walk overfenders)
      const crown = 0.72 + 0.28 * Math.sin(Math.PI * u);
      const outMax = p.out * crown * endT;
      const lipH = Math.max(0.055, p.lip * 1.38) * (0.45 + 0.55 * endT);
      const rArch = R0 + 0.016 * endT;

      // Painted outer dome ring
      for (let j = 0; j < P; j++) {
        const [rFrac, oFrac] = domeProf[j];
        const rad = rArch + lipH * rFrac;
        const y = Math.max(fit.ground + 0.06, w.y + sa * rad);
        const z = clampZ(w.z + ca * rad);
        const bodyX = fit.bodySideAt(y, z, s);
        const dx = oFrac < 0 ? Math.max(-0.026, oFrac * Math.max(0.04, p.out) - 0.012) : outMax * oFrac;
        const x = s * (bodyX + dx);
        pos.push(x, y, z);
        // Continuous automotive surface UVs (matches body flake scale)
        uvArr.push(u * 2.2, (j / (P - 1)) * 0.55);
      }

      // Recessed inner wheel-arch liner (3 points wrapping cleanly inboard behind the lip)
      const yLip = Math.max(fit.ground + 0.06, w.y + sa * rArch);
      const zLip = clampZ(w.z + ca * rArch);
      const bodyLip = fit.bodySideAt(yLip, zLip, s);
      const xOuterLip = s * (bodyLip + outMax * 0.86);
      const xInnerWell = s * (bodyLip - 0.045);
      const yInnerWell = Math.max(fit.ground + 0.05, w.y + sa * (rArch - 0.014));
      const zInnerWell = clampZ(w.z + ca * (rArch - 0.014));
      lPos.push(xOuterLip, yLip, zLip, xInnerWell, yInnerWell, zInnerWell);
      lUv.push(u * 2.0, 0, u * 2.0, 0.25);

      // Optional Liberty-Walk / Rocket-Bunny recessed dark-titanium rivets along the upper seam
      if (boltGeo && i >= 6 && i <= N - 6 && i % 5 === 0) {
        const radB = rArch + lipH * 0.78;
        const yB = Math.max(fit.ground + 0.08, w.y + sa * radB);
        const zB = clampZ(w.z + ca * radB);
        const bodyB = fit.bodySideAt(yB, zB, s);
        const xB = s * (bodyB + outMax * 0.38 + 0.002);
        const bolt = new THREE.Mesh(boltGeo, linerMat);
        bolt.position.set(xB, yB, zB);
        bolt.name = 'fender_bolt';
        bolt.castShadow = false;
        g.add(bolt);
      }
    }

    // Build single-sided outward-facing triangles (NEVER duplicate reversed triangles on shared vertices!)
    for (let i = 0; i < N; i++) {
      const aRow = i * P, bRow = (i + 1) * P;
      for (let j = 0; j < P - 1; j++) {
        if (s > 0) {
          idx.push(aRow + j, bRow + j, bRow + j + 1, aRow + j, bRow + j + 1, aRow + j + 1);
        } else {
          idx.push(aRow + j, bRow + j + 1, bRow + j, aRow + j, aRow + j + 1, bRow + j + 1);
        }
      }
      const la = i * 2, lb = (i + 1) * 2;
      if (s > 0) {
        lIdx.push(la, lb, lb + 1, la, lb + 1, la + 1);
      } else {
        lIdx.push(la, lb + 1, lb, la, la + 1, lb + 1);
      }
    }

    // Verify painted dome outward normal points along +side (+X on left, -X on right) at arch crown
    const midTri = Math.floor((N / 2) * (P - 1) * 2) * 3;
    if (midTri + 2 < idx.length) {
      const i0 = idx[midTri] * 3, i1 = idx[midTri + 1] * 3, i2 = idx[midTri + 2] * 3;
      const e1x = pos[i1] - pos[i0], e1y = pos[i1 + 1] - pos[i0 + 1], e1z = pos[i1 + 2] - pos[i0 + 2];
      const e2x = pos[i2] - pos[i0], e2y = pos[i2 + 1] - pos[i0 + 1], e2z = pos[i2 + 2] - pos[i0 + 2];
      const nx = e1y * e2z - e1z * e2y;
      if (nx * s < 0) {
        for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
      }
    }

    const domeGeo = new THREE.BufferGeometry();
    domeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    domeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
    domeGeo.setIndex(idx);
    domeGeo.computeVertexNormals();
    const domeMesh = new THREE.Mesh(domeGeo, paintMat);
    domeMesh.name = 'fender_flare';
    domeMesh.castShadow = false;
    domeMesh.receiveShadow = true;
    g.add(domeMesh);

    const linerGeo = new THREE.BufferGeometry();
    linerGeo.setAttribute('position', new THREE.Float32BufferAttribute(lPos, 3));
    linerGeo.setAttribute('uv', new THREE.Float32BufferAttribute(lUv, 2));
    linerGeo.setIndex(lIdx);
    linerGeo.computeVertexNormals();
    const linerMesh = new THREE.Mesh(linerGeo, linerMat);
    linerMesh.name = 'fender_liner';
    linerMesh.castShadow = false;
    linerMesh.receiveShadow = false;
    g.add(linerMesh);
  }
  return g;
}

// ---- shader nodes installed once on a car's paint / carbon material (setupCarMaterials) -------------------------------
export type LiveryUniforms = CarPaintWgslUniforms;
/** Paint: dual-layer PBR clear-coat WGSL shader + model-space livery mask + dynamic dirt/wear mask + underglow sill wash. */
export function installLivery(paint: THREE.MeshPhysicalMaterial): LiveryUniforms {
  return installDualLayerCarPaint(paint as unknown as THREE.MeshPhysicalNodeMaterial);
}
export interface AeroUniforms { flat: THREE.UniformNode<'float', number>; color: THREE.UniformNode<'color', THREE.Color>; rough: THREE.UniformNode<'float', number> }
/** Carbon parts: the weave, or a flat colour (gloss / matte black, body colour). */
export function installAero(carbon: THREE.MeshPhysicalMaterial): AeroUniforms {
  const u: AeroUniforms = { flat: uniform(0), color: uniform(new THREE.Color(0x0b0c0e)), rough: uniform(0.28) };
  const weave = carbon.map ? texture(carbon.map, uv()).rgb.mul(materialColor) : materialColor;
  carbon.colorNode = mix(weave, rgb(u.color), u.flat);
  carbon.roughnessNode = u.rough;
  return u;
}

// ---- per car: parts, colours, lights ----------------------------------------------------------------------------------
type Std = THREE.MeshStandardMaterial;
const RIM: Record<RimFinish, [number, number]> = { chrome: [1, 0.05], gloss: [0.55, 0.18], satin: [0.7, 0.38], matte: [0.35, 0.7] };
const HEAD: Record<HeadTint, number> = { white: 0xfff3e0, ice: 0xd8e8ff, yellow: 0xffd98a };
const ONE = new THREE.Vector3(1, 1, 1);

export class CarCustomizer {
  private rim: Std[] = [];
  private caliper: Std[] = [];
  private exhaust: Std[] = [];
  private lens: Std[] = [];
  private tail: Std[] = [];
  private tailBase = new Map<Std, THREE.Color>();
  private lensBase = new Map<Std, number>();
  private m4 = new THREE.Matrix4();
  private stockWing: THREE.Object3D[] = [];
  private wings: Partial<Record<WingKind, THREE.Object3D>> = {};
  /** splitter / diffuser / skirt designs, by id (one visible per kind) */
  private kits: Record<string, THREE.Object3D> = {};
  /** generated rim designs: four copies each, parented to the wheel nodes */
  private wheelRims: Record<string, THREE.Object3D[]> = {};
  private rimMat!: THREE.MeshPhysicalMaterial;
  /** the model's own rim meshes: hidden when a generated rim is fitted */
  private rimMeshes: THREE.Mesh[] = [];
  /** the model's own aero panels: replaced (hidden) when a generated splitter/skirt is fitted */
  private stockPanels: Record<string, THREE.Object3D[]> = { splitter: [], skirt: [] };
  /** generated bumpers / hoods / fender flares, by id */
  private bodyParts: Record<string, THREE.Object3D> = {};
  /** the model's own bumpers and hood, hidden when a generated one is fitted */
  private bodyStock: { front?: THREE.Object3D; rear?: THREE.Object3D; hood?: THREE.Object3D } = {};
  /** Gameplay-driven paint wear uniforms: wear (road grime), scuff (scrapes/damage), wakeSpray (drafting mist). */
  private wear = 0;
  private scuff = 0;
  private wakeSpray = 0;
  /** Update the WGSL dynamic dirt/wear mask uniforms (zero material mutations, zero shader recompiles). */
  setWear(t: number, scuff = this.scuff, wakeSpray = this.wakeSpray) {
    const w = Math.max(0, Math.min(1, t));
    const sc = Math.max(0, Math.min(1, scuff));
    const ws = Math.max(0, Math.min(1, wakeSpray));
    if (Math.abs(w - this.wear) < 0.002 && Math.abs(sc - this.scuff) < 0.002 && Math.abs(ws - this.wakeSpray) < 0.002) return;
    this.wear = w;
    this.scuff = sc;
    this.wakeSpray = ws;
    const lu = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (lu) {
      lu.wear.value = w;
      lu.scuff.value = sc;
      lu.wakeSpray.value = ws;
    }
  }
  getWear() { return { wear: this.wear, scuff: this.scuff, wakeSpray: this.wakeSpray }; }
  /** paint clone for imported parts: double-sided, so an inverted-winding export can never read as a black hole */
  private extraMat?: THREE.Material;
  /** fender flares, by id: four arch lips */
  private fenderParts: Record<string, THREE.Object3D> = {};
  private wheelNodes: THREE.Object3D[] = [];
  /** the body's outlines every generated part is fitted to (parts/fit.ts) */
  fit!: BodyFit;
  private glow: THREE.Mesh;
  /** the pool's real size: the warm-up trick scales optional parts to ~0 and restores 1, which is not the pool's size */
  private glowScale = new THREE.Vector3(1, 1, 1);
  private glowColor = uniform(new THREE.Color(0xff2d55));
  /** Underglow look (all uniforms, so it tunes without a rebuild). ?glow=strength:3.4,outer:0.95,inner:0.16,power:1.6 */
  private glowStrength = uniform(3.2);
  private glowInner = uniform(0.16);
  private glowOuter = uniform(0.9);
  private glowPower = uniform(1.6);
  private box = new THREE.Box3();
  private aeroMat: THREE.MeshPhysicalMaterial;
  current = defaultCustom();
  /** frames left in which the optional parts are drawn at ~zero size (their shaders compile now, behind the loading
   *  screen, not as a hitch the first time the player picks one) */
  private warm = 3;

  constructor(private model: THREE.Object3D, private paint: THREE.MeshPhysicalMaterial | null, private glass: THREE.MeshPhysicalMaterial | null,
              carbon: THREE.MeshPhysicalMaterial | null, private headlights: THREE.SpotLight[] = [], wheelNodes?: THREE.Object3D[]) {
    model.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert(), tmp = new THREE.Box3();
    // own copies of the shared (cached glTF) materials this car recolours, so another car with the same model keeps its own
    const own = new Map<THREE.Material, Std>();
    const mine = (m: THREE.Mesh, i: number, mat: THREE.Material, list: Std[]) => {
      let c = own.get(mat);
      if (!c) { c = (mat as Std).clone(); own.set(mat, c); list.push(c); }
      if (Array.isArray(m.material)) m.material[i] = c; else m.material = c;
      return c;
    };
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.geometry && !m.name.startsWith('wheel_contact')) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        tmp.copy(m.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
        if (!/^beam|shadow|blur/.test(m.name)) this.box.union(tmp);
      }
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mat, i) => {
        const n = mat.name ?? '';
        if (/^rim/i.test(n)) { mine(m, i, mat, this.rim); if (!this.rimMeshes.includes(m)) this.rimMeshes.push(m); }
        else if (n === 'caliper') mine(m, i, mat, this.caliper);
        else if (/exhaust_chrome/.test(n) || (/exhaust_tips/.test(m.name) && n === 'chrome')) mine(m, i, mat, this.exhaust);
        else if (/^light_head$|^headlight_lens$/.test(n) || /^drl_/.test(m.name)) { const c = mine(m, i, mat, this.lens); if (!this.lensBase.has(c)) this.lensBase.set(c, c.emissive ? Math.max(c.emissive.r, c.emissive.g, c.emissive.b) : 0); }
        else if (/^light_tail$|^taillight$|^tail_lens$/.test(n)) { const c = mine(m, i, mat, this.tail); if (!this.tailBase.has(c)) this.tailBase.set(c, c.color.clone()); }
      });
    });
    // Stock wing(s): every node that looks like the model's own spoiler, not just the first node called 'wing'.
    // A model can carry the blade and its stands as siblings (or a 'wing_assembly' under 'wing'), and missing one of
    // them is exactly what leaves a second spoiler on the car; collect them all, outermost first, de-duplicated.
    {
      const stockName = /^(wing|wing_assembly|spoiler|rear_wing|ducktail|gt_wing|tail_wing)([_ .-]|$)/i;
      const collect = (o: THREE.Object3D) => {
        if (!stockName.test(o.name)) return false;
        for (let q: THREE.Object3D | null = o; q && q !== model; q = q.parent) if (this.stockWing.includes(q)) return true;
        this.stockWing.push(o);
        return true;
      };
      model.traverse((o) => { collect(o); });
      // the old single-node fallback, kept for models whose assembly is named differently from its parts
      if (!this.stockWing.length) {
        const w = model.getObjectByName('wing') ?? model.getObjectByName('wing_assembly');
        if (w) this.stockWing.push(w);
      }
    }
    for (const o of [model.getObjectByName('splitter')]) if (o) this.stockPanels.splitter.push(o);
    for (const n of ['skirt_L', 'skirt_R']) { const o = model.getObjectByName(n); if (o) this.stockPanels.skirt.push(o); }
    // The body's own outlines (parts/fit.ts): every generated part is swept along them, so it sits on THIS car.
    // the wheel nodes come from the car (its visual config names them); the fallback is the Vela's naming
    this.wheelNodes = wheelNodes?.length ? wheelNodes : ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR']
      .map((n) => model.getObjectByName(n)).filter((w): w is THREE.Object3D => !!w);
    // a rim is also anything under a node called *rim* inside a wheel (models that do not name the material)
    for (const wn of this.wheelNodes) wn.traverse((o) => {
      const mm = o as THREE.Mesh;
      if (!mm.isMesh || this.rimMeshes.includes(mm)) return;
      for (let q: THREE.Object3D | null = mm; q && q !== wn; q = q.parent) if (/rim/i.test(q.name)) { this.rimMeshes.push(mm); break; }
    });
    const fitWheels: FitWheel[] = this.wheelNodes.map((wn) => {
      const wbx = exactBox(wn, inv, (mm) => /blur|shadow/.test(mm.name));
      const c = wbx.getCenter(new THREE.Vector3());
      return { x: c.x, y: c.y, z: c.z, r: wbx.isEmpty() ? 0.34 : (wbx.max.y - wbx.min.y) / 2, w: wbx.isEmpty() ? 0.25 : wbx.max.x - wbx.min.x } as FitWheel & { w: number };
    });
    const notBody = /^wheel|caliper|^beam|shadow|blur|interior|seat|dashboard|steering|driver|plate|disc|^hub/i;
    const fit = new BodyFit(model, fitWheels, (mesh) => {
      for (let o: THREE.Object3D | null = mesh; o && o !== model; o = o.parent) if (notBody.test(o.name) || this.stockWing.includes(o)) return true;
      return false;
    });
    this.fit = fit;
    // rear wings stand on the tail deck (the stock wing's own box hung them in the air above its stands)
    const wb = fit.wingBase();
    this.aeroMat = carbon ?? new THREE.MeshPhysicalMaterial({ color: 0x101215, roughness: 0.3, metalness: 0.2, clearcoat: 0.8, name: 'carbon' });
    // every wing design in parts/wings.ts: built once against this car's boxes, hidden until chosen
    for (const spec of WING_SPECS) {
      const g = spec.build({ box: this.box, wb, mat: this.aeroMat });
      g.name = 'wing_' + spec.id;
      g.visible = false;
      this.wings[spec.id] = g;
      model.add(g);
    }
    // aero kits: splitters / diffusers / skirts, each a thin section following the bumper / sill it belongs to
    for (const spec of AERO_NAMES) {
      const g = spec.kind === 'splitter' ? fittedSplitter(fit, this.aeroMat, SPLITTERS_FIT[spec.id] ?? { out: 0.05 })
        : spec.kind === 'diffuser' ? fittedDiffuser(fit, this.aeroMat, DIFFUSERS_FIT[spec.id] ?? { out: 0.05 })
        : fittedSkirt(fit, this.aeroMat, SKIRTS_FIT[spec.id] ?? { out: 0.04 });
      g.name = 'kit_' + spec.id;
      g.visible = false;
      this.kits[spec.id] = g;
      model.add(g);
    }
    // Body panels. A generated shell cannot follow a real nose, so every bumper / hood option is the car's OWN panel,
    // copied and reshaped (parts/fit.ts reshaped): it seats in the same opening by construction. The edge that meets
    // the fenders never moves; the change grows from there to the nose / tail.
    this.bodyStock = { front: model.getObjectByName('bumper_front') ?? undefined, rear: model.getObjectByName('bumper_rear') ?? undefined, hood: model.getObjectByName('hood') ?? undefined };
    const paintMat = this.paint ?? this.aeroMat;
    const boxOf = (o: THREE.Object3D) => {
      const bx = new THREE.Box3();
      o.updateWorldMatrix(true, true);
      o.traverse((mm) => {
        const mesh = mm as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        bx.union(tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld)));
      });
      return bx;
    };
    const sm = (a0: number, b0: number, x: number) => { const k = Math.min(1, Math.max(0, (x - a0) / (b0 - a0))); return k * k * (3 - 2 * k); };
    const G = fit.ground;
    /** bumper: wider by `wide` (share), its lower edge `lip` m further out and `drop` m lower; dir +1 front, -1 rear */
    const bumper = (stock: THREE.Object3D, dir: 1 | -1, wide: number, lip: number, drop: number, chin = 0) => {
      const bx = boxOf(stock), seam = dir > 0 ? bx.min.z : bx.max.z, len = Math.max(0.2, bx.max.z - bx.min.z);
      // each mesh keeps its own material: the grille, the mesh insert and the lamps of a bumper are not paint
      return reshaped(model, stock, null, (v) => {
        const k = sm(0.05, 0.6, ((v.z - seam) * dir) / len);          // 0 at the seam to the fenders, 1 at the nose
        const lowK = 1 - sm(0.02, 0.26, v.y - G - 0.1);               // 1 along the lower edge, 0 above the grille line
        v.x *= 1 + wide * k;
        v.z += dir * (lip * lowK * k + 0.004 * k);                    // 4 mm proud: never fights the panel it replaces
        v.y -= drop * lowK * k;
        if (chin) v.z += dir * chin * k * (1 - sm(0.0, 0.34, Math.abs(v.x))) * lowK;   // a pointed centre section
      });
    };
    const FRONTS: Record<string, [number, number, number, number]> = {
      'front-smooth': [0.004, 0.0, 0.0, 0], 'front-gt': [0.02, 0.025, 0.012, 0], 'front-intake': [0.012, 0.01, 0.02, 0.03],
      'front-split': [0.008, 0.045, 0.014, 0], 'front-canard': [0.026, 0.02, 0.008, 0], 'front-track': [0.036, 0.05, 0.022, 0.02],
      'front-shell-wide': [0.045, 0.02, 0.0, 0], 'front-shell-track': [0.03, 0.04, 0.03, 0],
    };
    const REARS: Record<string, [number, number, number, number]> = {
      'rear-smooth': [0.004, 0.0, 0.0, 0], 'rear-diffuser': [0.01, 0.02, 0.02, 0], 'rear-twin': [0.016, 0.015, 0.01, 0.02],
      'rear-aggressive': [0.03, 0.04, 0.02, 0], 'rear-gt': [0.022, 0.025, 0.012, 0], 'rear-track': [0.036, 0.045, 0.024, 0.02],
      'rear-shell-wide': [0.045, 0.02, 0.0, 0], 'rear-shell-deep': [0.02, 0.05, 0.03, 0],
    };
    const addBody = (id: string, g: THREE.Object3D) => { g.name = 'fit_' + id; g.visible = false; this.bodyParts[id] = g; model.add(g); };
    if (this.bodyStock.front) for (const [id, [wd, lp, dr, ch]] of Object.entries(FRONTS)) addBody(id, bumper(this.bodyStock.front, 1, wd, lp, dr, ch));
    if (this.bodyStock.rear) for (const [id, [wd, lp, dr, ch]] of Object.entries(REARS)) addBody(id, bumper(this.bodyStock.rear, -1, wd, lp, dr, ch));
    if (this.bodyStock.hood) {
      const hb = boxOf(this.bodyStock.hood), hw2 = Math.max(0.2, (hb.max.x - hb.min.x) / 2), hc = (hb.max.z + hb.min.z) / 2, hl = Math.max(0.3, (hb.max.z - hb.min.z) / 2);
      // a hood: raised by `h` over the middle `wshare` of its width, with a trough of `dip` down the centre; its rim stays flush
      const hood = (h: number, wshare: number, dip: number, mat: THREE.Material) => reshaped(model, this.bodyStock.hood!, mat, (v) => {
        const u = Math.abs(v.x) / hw2, t = Math.abs(v.z - hc) / hl;
        const edge = (1 - sm(0.72, 0.98, u)) * (1 - sm(0.7, 0.98, t));
        const dome = 1 - sm(wshare * 0.45, wshare, u);
        v.y += 0.003 + edge * (h * dome - dip * (1 - sm(0.04, 0.2, u)));
      });
      const HOODS_FIT: Record<string, [number, number, number, boolean]> = {
        'hood-smooth': [0.0, 1, 0, false], 'hood-vented': [0.024, 0.7, 0.03, false], 'hood-bulge': [0.03, 0.75, 0, false],
        'hood-power': [0.05, 0.42, 0, false], 'hood-carbon': [0.0, 1, 0, true], 'hood-track': [0.034, 0.6, 0.02, true],
      };
      for (const [id, [h, ws, dip, cf]] of Object.entries(HOODS_FIT)) addBody(id, hood(h, ws, dip, cf ? this.aeroMat : paintMat));
    }
    // fender flares: sculpted automotive widebody arches + recessed inner wheel-well liners + optional rivets
    const flareLinerMat = new THREE.MeshStandardMaterial({ color: 0x0e1014, roughness: 0.72, metalness: 0.15, side: THREE.DoubleSide, name: 'widebody_liner' });
    for (const spec of BODY_NAMES) {
      if (spec.kind !== 'fender') continue;
      const g = sculptedWidebodyFlares(fit, paintMat, flareLinerMat, FLARES_FIT[spec.id] ?? { out: 0.03, lip: 0.05 });
      g.name = 'fender_' + spec.id;
      g.visible = false;
      this.fenderParts[spec.id] = g;
      model.add(g);
    }
    // rims: a generated face per wheel, parented to the wheel node so it steers and spins with it
    this.rimMat = new THREE.MeshPhysicalMaterial({ name: 'rim_generated', color: 0x9aa0aa, metalness: 1, roughness: 0.2, clearcoat: 0.4 });
    // The size comes from the wheel itself: the model's own rim (its 'rim' material meshes), else 70 % of the tyre.
    const rimR: number[] = [], rimW: number[] = [], rimX: number[] = [];
    this.wheelNodes.forEach((wn, i) => {
      const rb = exactBox(wn, new THREE.Matrix4().copy(wn.matrixWorld).invert(), (mm) => !this.rimMeshes.includes(mm));
      const fw = fitWheels[i] as FitWheel & { w: number };
      const sc = new THREE.Vector3().setFromMatrixScale(wn.matrixWorld).y / (new THREE.Vector3().setFromMatrixScale(model.matrixWorld).y || 1) || 1;
      rimR.push(rb.isEmpty() ? (fw.r * 0.7) / sc : Math.min(fw.r * 0.8 / sc, (rb.max.y - rb.min.y) / 2));
      rimW.push(rb.isEmpty() ? (fw.w * 0.92) / sc : Math.min(fw.w / sc, rb.max.x - rb.min.x));
      rimX.push(rb.isEmpty() ? 0 : (rb.max.x + rb.min.x) / 2);
    });
    for (const spec of RIM_SPECS) {
      const list: THREE.Object3D[] = [];
      this.wheelNodes.forEach((w, i) => {
        const side = w.name.endsWith('L') ? 1 : -1;
        const rim = spec.build({ radius: rimR[i], width: rimW[i], mat: this.rimMat });
        rim.rotation.y = (side * Math.PI) / 2;   // the builder's axle is +z; a wheel's is x
        rim.position.x = rimX[i];
        rim.visible = false;
        w.add(rim);
        list.push(rim);
      });
      this.wheelRims[spec.id] = list;
    }
    // underglow: a soft additive pool on the ground under the car (no light: adding lights recompiles everything).
    // Underground reads as a bright core about a car wide with a fast falloff, so the plane is generous (the geometry
    // is built once) and the VISIBLE pool is shaped by the falloff uniforms: ?glow=outer:0.95 widens it, inner tightens
    // the core, strength and power set the punch. Tuning never touches geometry.
    for (const kv of (new URLSearchParams(location.search).get('glow') ?? '').split(',')) {
      const [k, v] = kv.split(':'); const n = Number(v);
      if (!Number.isFinite(n)) continue;
      if (k === 'strength') this.glowStrength.value = n;
      else if (k === 'inner') this.glowInner.value = n;
      else if (k === 'outer') this.glowOuter.value = n;
      else if (k === 'power') this.glowPower.value = n;
    }
    const gm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const d = uv().sub(0.5).mul(2);
    const fall = float(1).sub(smoothstep(this.glowInner, this.glowOuter, d.length())).pow(this.glowPower);
    gm.colorNode = vec4(rgb(this.glowColor).mul(fall.mul(this.glowStrength)), fall);
    const sx = this.box.max.x - this.box.min.x, sz = this.box.max.z - this.box.min.z;
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), gm);
    this.glow.scale.set(sx * 3.0, 1, sz * 2.2);   // the falloff uniforms decide how much of that is lit
    this.glowScale.copy(this.glow.scale);
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.set((this.box.max.x + this.box.min.x) / 2, this.box.min.y + 0.02, (this.box.max.z + this.box.min.z) / 2);
    this.glow.name = 'wheel_underglow';   // 'wheel_' prefix: never dented
    this.glow.renderOrder = 1;
    model.add(this.glow);
    for (const o of this.optional()) { o.visible = true; o.scale.setScalar(1e-4); }
    const lu = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (lu) { lu.bottom.value = this.box.min.y + 0.1; lu.top.value = this.box.max.y; }
  }

  /**
   * Swap in shells authored in Blender (GLBs that already sit at the car's own coordinates): they replace the
   * runtime-derived clones and are fitted by construction because they were cut from this car's bumper.
   */
  setShells(wide: THREE.Object3D, track: THREE.Object3D) {
    const pairs: [string, THREE.Object3D][] = [['front-shell-wide', wide], ['front-shell-track', track]];
    for (const [id, g] of pairs) {
      this.bodyParts[id]?.removeFromParent();
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // Blender exports can carry inverted/loose normals: recompute them and draw the imported part double-sided
        if (m.geometry) m.geometry.computeVertexNormals();
        if (!this.extraMat) { this.extraMat = (this.paint ?? this.aeroMat).clone(); this.extraMat.side = THREE.DoubleSide; }
        m.material = this.extraMat;
        m.castShadow = false;
        m.frustumCulled = false;
      });
      g.name = 'shell_' + id;
      g.visible = false;
      this.bodyParts[id] = g;
      this.model.add(g);
    }
    this.showOptional();
  }

  /** Swap in extra authored parts (hood / rear shells) keyed by their option id. */
  setExtraParts(map: Record<string, THREE.Object3D>) {
    for (const [id, g] of Object.entries(map)) {
      this.bodyParts[id]?.removeFromParent();
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // Blender exports can carry inverted/loose normals: recompute them and draw the imported part double-sided
        if (m.geometry) m.geometry.computeVertexNormals();
        if (!this.extraMat) { this.extraMat = (this.paint ?? this.aeroMat).clone(); this.extraMat.side = THREE.DoubleSide; }
        m.material = this.extraMat;
        m.castShadow = false;
        m.frustumCulled = false;
      });
      g.name = 'extra_' + id;
      g.visible = false;
      this.bodyParts[id] = g;
      this.model.add(g);
    }
    this.showOptional();
  }

  /** Is there a bumper / hood with this id for this car? (The garage lists only those.) */
  hasBody(id: string) { return id in this.bodyParts; }
  /** Choose a wing atomically: the generated wing and the stock one can never both be visible. */
  setWing(id: WingKind) {
    this.current = { ...this.current, wing: id };
    this.showOptional();
  }

  /** Apply a full set of choices (cheap: uniforms and visibility only). paintHex: the body colour (aero 'body'). */
  apply(c: Custom, paintHex?: string) {
    this.current = c;
    const lu = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (lu) { lu.style.value = c.livery; lu.color.value.set(c.liveryColor); }
    const au = this.aeroMat.userData.aero as AeroUniforms | undefined;
    if (au) {
      au.flat.value = c.aero === 'carbon' ? 0 : 1;
      au.color.value.set(c.aero === 'body' ? paintHex ?? '#888888' : '#0b0c0e');
      au.rough.value = c.aero === 'matte' ? 0.72 : c.aero === 'carbon' ? 0.28 : 0.14;
    }
    this.showOptional();
    const [met, rough] = RIM[c.rimFinish];
    for (const m of this.rim) { m.color.set(c.rimColor); m.metalness = met; m.roughness = rough; }
    if (this.rimMat) { this.rimMat.color.set(c.rimColor); this.rimMat.metalness = met; this.rimMat.roughness = rough; }
    for (const m of this.caliper) m.color.set(c.caliper);
    for (const m of this.exhaust) {
      if (c.exhaust === 'black') { m.color.set(0x111214); m.metalness = 0.5; m.roughness = 0.45; }
      else if (c.exhaust === 'titanium') { m.color.set(0x7a6aa0); m.metalness = 1; m.roughness = 0.22; }
      else { m.color.set(0xe8eaee); m.metalness = 1; m.roughness = 0.05; }
    }
    const hc = new THREE.Color(HEAD[c.headlights]);
    for (const s of this.headlights) s.color.copy(hc);
    for (const m of this.lens) if (m.emissive) m.emissive.copy(hc).multiplyScalar(this.lensBase.get(m) ?? 0);
    for (const m of this.tail) m.color.copy(this.tailBase.get(m) ?? m.color).multiplyScalar(c.smokedTails ? 0.25 : 1);
    if (this.glass) { this.glass.opacity = [0.5, 0.64, 0.86][c.tint]; this.glass.color.setHex([0x101418, 0x06080c, 0x020203][c.tint]); }
    // Underglow on the car itself: the paint's sills take the colour and the rims pick it up. Emissive on materials
    // that already have the input is a uniform write, so this costs nothing per frame and compiles nothing.
    const glow = c.underglow;
    if (glow) this.glowColor.value.set(glow);
    const lv = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (lv) { lv.glow.value.set(glow || 0x000000); lv.glowAmt.value = glow ? 1 : 0; }
    for (const m of this.rim) { m.emissive.set(glow || 0x000000); m.emissiveIntensity = glow ? 0.12 : 0; }
    this.showOptional();
  }

  private optional() { return [...(Object.values(this.wings) as THREE.Object3D[]), this.glow]; }
  private showOptional() {
    if (this.warm > 0) return;   // still warming: stay drawn, tiny
    const c = this.current;
    for (const [k, w] of Object.entries(this.wings)) if (w) w.visible = c.wing === k;
    // Stock wing: shown ONLY for 'stock' and only when no generated wing is actually drawn. Deriving it from the
    // rendered state (not from the id alone) makes a double spoiler impossible even if a caller applies a stale
    // Custom: 'none' and every generated id hide it, and a generated wing that is visible always wins.
    const anyWing = Object.values(this.wings).some((w) => !!w && w.visible);
    const stockVisible = c.wing === 'stock' && !anyWing;
    for (const w of this.stockWing) w.visible = stockVisible;
    for (const [k, w] of Object.entries(this.kits)) w.visible = c.splitter === k || c.diffuser === k || c.skirt === k;
    for (const [k, list] of Object.entries(this.wheelRims)) for (const r of list) r.visible = c.rims === k;
    for (const m of this.rimMeshes) m.visible = c.rims === 'stock';
    for (const [k, g] of Object.entries(this.bodyParts)) g.visible = k === c.frontB || k === c.rearB || k === c.hood;
    for (const [k, g] of Object.entries(this.fenderParts)) g.visible = k === c.fenders;
    // the stock panel makes way only for a replacement this car really has (an option without one keeps the stock panel)
    if (this.bodyStock.front) this.bodyStock.front.visible = !this.bodyParts[c.frontB];
    if (this.bodyStock.rear) this.bodyStock.rear.visible = !this.bodyParts[c.rearB];
    if (this.bodyStock.hood) this.bodyStock.hood.visible = !this.bodyParts[c.hood];
    this.glow.visible = !!c.underglow;
    this.onWidebodyTrack?.(this.getWidebodyTrackOffset());
  }

  /** Every frame, after the car root moved (root at pos / quat, in the scene): updates model-space inverse matrix for WGSL paint/flakes/dirt/livery. */
  sync(pos: THREE.Vector3, quat: THREE.Quaternion) {
    if (this.warm > 0 && --this.warm === 0) { for (const o of this.optional()) { if (o === this.glow) o.scale.copy(this.glowScale); else o.scale.setScalar(1); } this.showOptional(); }
    const lu = this.paint?.userData.livery as LiveryUniforms | undefined;
    if (!lu) return;
    this.model.updateMatrix();
    lu.inv.value.copy(this.m4.compose(pos, quat, ONE).multiply(this.model.matrix)).invert();
  }

  /** Outward wheel track spacer (m) matching the currently equipped widebody kit so wheels sit flush inside the arches. */
  getWidebodyTrackOffset(): number {
    const f = FLARES_FIT[this.current.fenders];
    return f ? Math.min(0.056, f.out * 0.72) : 0;
  }

  /** Optional callback notified whenever widebody track offset changes (wired by CarVisual). */
  onWidebodyTrack?: (offsetM: number) => void;

  /** Active Aero wing pitch angle (rad): smoothed toward -0.15 (DRS) or +0.36 (Airbrake). */
  private aeroPitch = 0;

  /** Animate active rear wing pitch cleanly around the wing's own rear deck pivot (never around car origin!). */
  setActiveAero(drs: boolean, airbrake: boolean, dt: number) {
    const target = airbrake ? 0.32 : drs ? -0.14 : 0;
    const next = this.aeroPitch + (target - this.aeroPitch) * Math.min(1, dt * 10);
    if (Math.abs(next - this.aeroPitch) < 1e-4 && Math.abs(target - next) < 1e-4) return;
    this.aeroPitch = next;
    const wb = this.fit?.wingBase();
    const py = wb ? wb.max.y + 0.16 : 0.96;
    const pz = wb ? (wb.min.z + wb.max.z) * 0.5 : -2.0;
    const applyPivot = (o: THREE.Object3D) => {
      o.rotation.x = this.aeroPitch;
      // Compensate origin pivot so the wing rotates smoothly in-place around (0, py, pz)
      const c = Math.cos(this.aeroPitch), s = Math.sin(this.aeroPitch);
      o.position.y = py - (py * c - pz * s);
      o.position.z = pz - (py * s + pz * c);
    };
    for (const w of Object.values(this.wings)) {
      if (w && w.visible) applyPivot(w);
    }
    for (const sw of this.stockWing) {
      if (sw.visible) applyPivot(sw);
    }
  }

  /** Model-space box of the body (for the driver seat estimate and the garage camera). */
  get bounds() { return this.box; }
}