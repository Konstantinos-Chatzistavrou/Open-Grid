// Kit v1 scanned PBR materials (Phase C, docs/kit.md): 12 CC0 full-PBR sets generated from 4K EXR masters into
// block-compressed KTX2 textures (2K roads/ground, 1K walls/roofs/metals) at web/public/assets/kit/materials/.
//
// Wetness (darker albedo, lower roughness, puddle mask) comes from the shader, never separate wet textures.
// ?kitmat=0 turns kit materials off (reverts to the procedural materials before Phase C for before/after checks).
import type * as THREE from 'three/webgpu';
import { loadKTX2 } from '../scene/loaders';
import { pubUrl } from '../assetBase';

export type KitMaterialRole =
  | 'dry_asphalt'
  | 'worn_asphalt'
  | 'concrete_kerb'
  | 'painted_kerb'
  | 'paving_stones'
  | 'smooth_plaster'
  | 'rough_plaster'
  | 'stone_wall'
  | 'brick'
  | 'roof_tiles'
  | 'rusty_metal'
  | 'painted_metal';

export interface KitMaterialEntry {
  id: string;
  role: KitMaterialRole;
  category: 'road' | 'wall';
  name: string;
  tile_m: [number, number];
  web_size: number;
  disp_size: number;
  has_metal: boolean;
  files: { diff: string; nor: string; arm: string; disp: string };
  licence: string;
}

export interface KitMaterialSet {
  id: string;
  role: KitMaterialRole;
  tileM: [number, number];
  diff: THREE.Texture;
  nor: THREE.Texture;
  arm: THREE.Texture;
  disp: THREE.Texture;
  hasMetal: boolean;
}

export type KitMaterialMap = Partial<Record<KitMaterialRole, KitMaterialSet>>;

const BASE = pubUrl('/assets/kit/materials/');

let enabled = true;
let manifestP: Promise<KitMaterialEntry[]> | null = null;
const loadedByRole = new Map<KitMaterialRole, Promise<KitMaterialSet | null>>();
let activeMaterials: KitMaterialMap = {};

export function kitMaterialsOn(params: URLSearchParams): boolean {
  return params.get('kitmat') !== '0';
}

export function setKitMaterialsEnabled(on: boolean): void {
  enabled = on;
  if (!on) activeMaterials = {};
}

export function getActiveKitMaterials(): KitMaterialMap {
  return enabled ? activeMaterials : {};
}

async function loadManifest(): Promise<KitMaterialEntry[]> {
  if (!manifestP) {
    manifestP = fetch(BASE + 'manifest.json')
      .then((r) => (r.ok ? r.json() : { materials: [] }))
      .then((j) => (j.materials ?? []) as KitMaterialEntry[])
      .catch(() => []);
  }
  return manifestP;
}

async function loadEntry(e: KitMaterialEntry): Promise<KitMaterialSet | null> {
  try {
    const [diff, nor, arm, disp] = await Promise.all([
      loadKTX2(BASE + e.files.diff, true, 8),
      loadKTX2(BASE + e.files.nor, false, 8),
      loadKTX2(BASE + e.files.arm, false, 8),
      loadKTX2(BASE + e.files.disp, false, 4),
    ]);
    diff.name = `kit_${e.id}_diff`;
    nor.name = `kit_${e.id}_nor`;
    arm.name = `kit_${e.id}_arm`;
    disp.name = `kit_${e.id}_disp`;
    return { id: e.id, role: e.role, tileM: e.tile_m, diff, nor, arm, disp, hasMetal: e.has_metal };
  } catch (err) {
    console.warn('kit materials: not loaded', e.id, err);
    return null;
  }
}

/**
 * Load the requested kit PBR roles (defaults to all roles used by the city ground, facades and roofs) and publish them
 * for createGroundMaterials / createFacadeMaterial / createRoofMaterial. Safe to call multiple times (cached).
 */
export async function loadKitMaterials(roles?: KitMaterialRole[]): Promise<KitMaterialMap> {
  if (!enabled) {
    activeMaterials = {};
    return activeMaterials;
  }
  const list = await loadManifest();
  if (!list.length) return {};
  const want = roles ? new Set<KitMaterialRole>(roles) : null;
  const picks = list.filter((e) => !want || want.has(e.role));
  const sets = await Promise.all(picks.map((e) => {
    let p = loadedByRole.get(e.role);
    if (!p) {
      p = loadEntry(e);
      loadedByRole.set(e.role, p);
    }
    return p;
  }));
  const out: KitMaterialMap = {};
  for (const s of sets) if (s) out[s.role] = s;
  activeMaterials = { ...activeMaterials, ...out };
  return activeMaterials;
}
