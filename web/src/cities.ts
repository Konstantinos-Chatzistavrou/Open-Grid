// The real-scale cities (1:1, built from open map data by tools/nyc: docs/cities.md). One is streamed per session; the
// Game Modes screen picks it and the choice is kept on this device (changing city reloads the game: every tile, collider
// and material set belongs to one city).
//   base   tiles folder (index.json, map.json, {ix}_{iy}.*)
//   route  the race loop through the city's landmarks (tools/nyc/build_index.py)
//   grid   street-grid angle from east in degrees (sidewalk slabs and pavers line up with the kerbs)
//   map    attribution for the map data (shown in the credits line; full list in CREDITS.md)

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
}

const OSM = 'OpenStreetMap contributors (ODbL)';

export const CITIES: CityInfo[] = [
  { id: 'nyc', name: 'New York', district: 'Manhattan', country: 'US', base: '/assets/nyc/tiles/', route: '/data/tracks/nyc_route.json', grid: 29,
    drive: 'right', map: `${OSM} & NYC Open Data`, blurb: 'All of Manhattan, river to river: Times Square, the avenues, Wall Street, Harlem.',
    mandatoryCops: true, patrolNote: 'High-patrol Midtown district · Tactical cops always active in Races' },
  { id: 'london', name: 'London', district: 'Westminster & the City', country: 'GB', base: '/assets/cities/london/tiles/', route: '/data/tracks/london_route.json', grid: 0,
    drive: 'left', map: OSM, blurb: 'Trafalgar Square to the Tower: Piccadilly, the Strand, the Thames bridges.',
    mandatoryCops: true, patrolNote: 'Central Westminster patrol zone · Tactical cops always active in Races' },
  { id: 'paris', name: 'Paris', district: 'Champs-Élysées to Notre-Dame', country: 'FR', base: '/assets/cities/paris/tiles/', route: '/data/tracks/paris_route.json', grid: 0,
    drive: 'right', map: OSM, blurb: "Arc de Triomphe, Concorde, the Louvre and the Seine's quays.",
    mandatoryCops: false, patrolNote: 'Optional Cop Mode in Race Events' },
  { id: 'tokyo', name: 'Tokyo', district: 'Shibuya to Shinjuku', country: 'JP', base: '/assets/cities/tokyo/tiles/', route: '/data/tracks/tokyo_route.json', grid: 0,
    drive: 'left', map: OSM, blurb: 'The Scramble, Omotesando, Harajuku and the Shinjuku towers.',
    mandatoryCops: false, patrolNote: 'Optional Cop Mode in Race Events' },
  { id: 'losangeles', name: 'Los Angeles', district: 'Downtown', country: 'US', base: '/assets/cities/losangeles/tiles/', route: '/data/tracks/losangeles_route.json', grid: 38,
    drive: 'right', map: OSM, blurb: 'Bunker Hill, Broadway and the Financial District grid.',
    mandatoryCops: false, patrolNote: 'Optional Cop Mode in Race Events' },
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
