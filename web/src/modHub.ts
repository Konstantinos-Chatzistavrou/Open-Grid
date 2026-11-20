// In-Game Mod Hub Browser (OpenGrid — Content Discovery & Validated Community Packs).
// Eliminates sketchy external .zip downloads: players browse, verify poly-count/LOD/anti-cheat badges,
// and subscribe/unsubscribe in 1 click (mirrors Steam Workshop / community repo metadata).

export interface ModEntry {
  id: string;
  title: string;
  kind: 'car' | 'livery' | 'track' | 'parts';
  author: string;
  version: string;
  polyCount: number;
  hasLods: boolean;
  validated: boolean;
  workshopId: string;
  blurb: string;
  downloads: string;
}

export const MOD_CATALOG: ModEntry[] = [
  {
    id: 'mod_s15_spec', title: 'S15 Spec-R Street Coupe', kind: 'car', author: 'TougeLab_JP', version: '1.4.2',
    polyCount: 68_400, hasLods: true, validated: true, workshopId: 'WS-401829',
    blurb: 'Debranded 90s FR turbo coupe with 14 aero bumpers, forged I6 swap & Pacejka drift compound.', downloads: '42.8k',
  },
  {
    id: 'mod_e46_gtr', title: 'Euro M-Spec Widebody Kit', kind: 'parts', author: 'ApexAtelier', version: '2.1.0',
    polyCount: 24_200, hasLods: true, validated: true, workshopId: 'WS-402190',
    blurb: 'OEM+ wide fenders, swan-neck carbon GT wing, dual titanium exhausts & vented hood pack.', downloads: '31.5k',
  },
  {
    id: 'mod_hakone_pass', title: 'Hakone Midnight Mountain Pass', kind: 'track', author: 'KanagawaSim', version: '1.1.0',
    polyCount: 94_000, hasLods: true, validated: true, workshopId: 'WS-403512',
    blurb: 'Real-width 8.4 km Japanese touge switchbacks with 3 Drift Zones & fog-bank lighting.', downloads: '56.1k',
  },
  {
    id: 'mod_gt3_liveries', title: 'Apex Midnight Pro Livery Pack (24x)', kind: 'livery', author: 'OpenGrid Community', version: '3.0.1',
    polyCount: 0, hasLods: true, validated: true, workshopId: 'WS-404011',
    blurb: 'Moderation-cleared racing stripes, metallic fades, and Japanese street club decals.', downloads: '63.9k',
  },
  {
    id: 'mod_mx5_spec', title: 'Roadster Cup Spec Class Car', kind: 'car', author: 'SimClub_EU', version: '1.0.8',
    polyCount: 52_100, hasLods: true, validated: true, workshopId: 'WS-405334',
    blurb: 'Lightweight 1,050 kg momentum racer tuned for identical Spec Class esports leagues.', downloads: '29.4k',
  },
];

const MODS_KEY = 'nr.modhub.v1';

export interface ModHubStore {
  subscribed: string[];
}

export function loadModHub(): ModHubStore {
  try {
    const raw = JSON.parse(localStorage.getItem(MODS_KEY) ?? 'null');
    if (raw && Array.isArray(raw.subscribed)) return { subscribed: raw.subscribed };
  } catch { /* blocked */ }
  return { subscribed: [] };
}

export function saveModHub(s: ModHubStore) {
  try { localStorage.setItem(MODS_KEY, JSON.stringify(s)); } catch { /* blocked */ }
}

export function toggleModSub(s: ModHubStore, id: string): boolean {
  const idx = s.subscribed.indexOf(id);
  if (idx >= 0) { s.subscribed.splice(idx, 1); saveModHub(s); return false; }
  s.subscribed.push(id);
  saveModHub(s);
  return true;
}
