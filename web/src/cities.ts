// The real-scale cities (1:1, built from open map data by tools/nyc: docs/cities.md). One is streamed per session; the
// Game Modes screen picks it and the choice is kept on this device (changing city reloads the game: every tile, collider
// and material set belongs to one city).
//   base   tiles folder (index.json, map.json, {ix}_{iy}.*)
//   route  the race loop through the city's landmarks (tools/nyc/build_index.py)
//   grid   street-grid angle from east in degrees (sidewalk slabs and pavers line up with the kerbs)
//   map    attribution for the map data (shown in the credits line; full list in CREDITS.md)

export interface CityLandmark {
  name: string;
  x: number;
  y: number;
}

export interface CityInfo {
  id: string;
  name: string;
  district: string;
  country: string;
  base: string;
  route: string;
  grid: number;
  drive: 'left' | 'right';
  map: string;
  /** a line for the city card */
  blurb: string;
  /** High-patrol downtown districts always have tactical police active in Race Events (never in Free Roam). */
  mandatoryCops: boolean;
  /** Short patrol-density note shown on Race Event setup. */
  patrolNote: string;
  /** Verified 1:1 real-life landmarks (game frame x east, y north) shown on the GPS map. */
  landmarks: CityLandmark[];
}

const OSM = 'OpenStreetMap contributors (ODbL)';

export const CITIES: CityInfo[] = [
  { id: 'nyc', name: 'New York', district: 'Manhattan', country: 'US', base: '/assets/nyc/tiles/', route: '/data/tracks/nyc_route.json', grid: 29,
    drive: 'right', map: `${OSM} & NYC Open Data`, blurb: 'All of Manhattan, river to river: Times Square, the avenues, Wall Street, Harlem.',
    mandatoryCops: true, patrolNote: 'High-patrol Midtown district · Tactical cops always active in Races',
    landmarks: [
      { name: 'Times Square', x: 0, y: 0 },
      { name: 'Empire State Bldg', x: -17, y: -1069 },
      { name: 'Central Park South', x: 919, y: 1091 },
      { name: 'Rockefeller Center', x: 573, y: 78 },
      { name: 'Grand Central', x: 700, y: -590 },
      { name: 'Madison Sq Garden', x: -666, y: -835 },
      { name: 'Hudson Yards', x: -1400, y: -468 },
      { name: 'Flatiron Bldg', x: -354, y: -1881 },
      { name: 'Washington Sq Park', x: -995, y: -3028 },
      { name: 'SoHo / Canal St', x: -1282, y: -4130 },
      { name: 'Wall Street', x: -2175, y: -5688 },
      { name: 'One WTC', x: -2353, y: -5043 },
      { name: 'Battery Park', x: -2656, y: -6089 },
      { name: 'Brooklyn Bridge', x: -1501, y: -5265 },
      { name: 'Columbus Circle', x: 304, y: 1124 },
      { name: 'The Met Museum', x: 1880, y: 2382 },
      { name: 'Harlem / 125th St', x: 3145, y: 5744 },
      { name: 'George Washington Br', x: 3668, y: 10297 },
    ] },
  { id: 'london', name: 'London', district: 'Westminster & the City', country: 'GB', base: '/assets/cities/london/tiles/', route: '/data/tracks/london_route.json', grid: 0,
    drive: 'left', map: OSM, blurb: 'Trafalgar Square to the Tower: Piccadilly, the Strand, the Thames bridges.',
    mandatoryCops: true, patrolNote: 'Central Westminster patrol zone · Tactical cops always active in Races',
    landmarks: [
      { name: 'Trafalgar Square', x: 0, y: 0 },
      { name: 'Piccadilly Circus', x: -423, y: 234 },
      { name: 'Big Ben / Westminster', x: 243, y: -813 },
      { name: 'Buckingham Palace', x: -956, y: -735 },
      { name: 'Hyde Park Corner', x: -1704, y: -590 },
      { name: 'Oxford Circus', x: -949, y: 802 },
      { name: 'Covent Garden', x: 284, y: 412 },
      { name: 'London Eye', x: 589, y: -523 },
      { name: "St Paul's Cathedral", x: 2058, y: 646 },
      { name: 'Bank / Royal Exchange', x: 2737, y: 601 },
      { name: 'Tower of London', x: 3617, y: 11 },
      { name: 'Tower Bridge', x: 3651, y: -278 },
      { name: 'The Shard', x: 2882, y: -390 },
      { name: 'Waterloo Station', x: 1032, y: -545 },
    ] },
  { id: 'paris', name: 'Paris', district: 'Champs-Élysées to Notre-Dame', country: 'FR', base: '/assets/cities/paris/tiles/', route: '/data/tracks/paris_route.json', grid: 0,
    drive: 'right', map: OSM, blurb: "Arc de Triomphe, Concorde, the Louvre and the Seine's quays.",
    mandatoryCops: false, patrolNote: 'Optional Cop Mode in Race Events',
    landmarks: [
      { name: 'Place de la Concorde', x: 0, y: 0 },
      { name: 'Arc de Triomphe', x: -1919, y: 913 },
      { name: 'Champs-Élysées', x: -1003, y: 468 },
      { name: 'Eiffel Tower', x: -1955, y: -802 },
      { name: 'Les Invalides', x: -630, y: -1002 },
      { name: 'Louvre Museum', x: 1201, y: -557 },
      { name: 'Notre-Dame', x: 2102, y: -1403 },
      { name: 'Opéra Garnier', x: 762, y: 712 },
      { name: 'Place Vendôme', x: 600, y: 212 },
      { name: 'Trocadéro', x: -2504, y: -301 },
      { name: 'Grand Palais', x: -637, y: 67 },
      { name: 'Châtelet', x: 1889, y: -802 },
    ] },
  { id: 'tokyo', name: 'Tokyo', district: 'Shibuya to Shinjuku', country: 'JP', base: '/assets/cities/tokyo/tiles/', route: '/data/tracks/tokyo_route.json', grid: 0,
    drive: 'left', map: OSM, blurb: 'The Scramble, Omotesando, Harajuku and the Shinjuku towers.',
    mandatoryCops: false, patrolNote: 'Optional Cop Mode in Race Events',
    landmarks: [
      { name: 'Shibuya Scramble', x: 0, y: 0 },
      { name: 'Dogenzaka', x: -344, y: -122 },
      { name: 'Harajuku Station', x: 199, y: 1191 },
      { name: 'Omotesando', x: 1067, y: 635 },
      { name: 'Meiji Shrine', x: -109, y: 1881 },
      { name: 'Yoyogi Park', x: -507, y: 1358 },
      { name: 'Shinjuku Station', x: 9, y: 3351 },
      { name: 'Tokyo Metro Gov', x: -796, y: 3351 },
      { name: 'Kabukicho', x: 262, y: 3818 },
      { name: 'Shinjuku Gyoen', x: 868, y: 2861 },
      { name: 'Aoyama', x: 1547, y: 1481 },
    ] },
  { id: 'losangeles', name: 'Los Angeles', district: 'Downtown', country: 'US', base: '/assets/cities/losangeles/tiles/', route: '/data/tracks/losangeles_route.json', grid: 38,
    drive: 'right', map: OSM, blurb: 'Bunker Hill, Broadway and the Financial District grid.',
    mandatoryCops: false, patrolNote: 'Optional Cop Mode in Race Events',
    landmarks: [
      { name: 'Financial District', x: 0, y: 0 },
      { name: 'US Bank Tower', x: 55, y: 223 },
      { name: 'Pershing Square', x: 314, y: -78 },
      { name: 'Walt Disney Hall', x: 480, y: 701 },
      { name: 'Grand Central Market', x: 563, y: 200 },
      { name: 'Crypto.com Arena', x: -1134, y: -668 },
      { name: 'LA Live', x: -1015, y: -412 },
      { name: 'Union Station', x: 1706, y: 802 },
      { name: 'City Hall', x: 1134, y: 523 },
      { name: 'Little Tokyo', x: 1402, y: 111 },
      { name: 'Arts District', x: 1835, y: -924 },
      { name: 'Fashion District', x: 138, y: -1024 },
    ] },
];

const KEY = 'nr.city';

export function cityById(id: string | null | undefined): CityInfo | undefined {
  return CITIES.find((c) => c.id === id);
}

/** The city for this session: ?city= wins (tests), then the saved choice, then New York. */
export function currentCity(params: URLSearchParams): CityInfo {
  const q = cityById(params.get('city'));
  if (q) return q;
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  return cityById(saved) ?? CITIES[0];
}

export function saveCity(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* storage blocked */ }
}

/**
 * Load any additional 1:1 cities registered by `tools/pipeline/ingest_city.py` into `data/cities/extra.json`.
 * Enables adding unlimited 1:1 cities with ZERO manual TypeScript edits.
 */
export async function loadExtraCities(): Promise<void> {
  try {
    const r = await fetch('/data/cities/extra.json');
    if (!r.ok) return;
    const d = (await r.json()) as { cities?: CityInfo[] };
    for (const c of d.cities ?? []) {
      if (!c?.id || CITIES.some((x) => x.id === c.id)) continue;
      CITIES.push(c);
    }
  } catch { /* optional manifest not yet created */ }
}
