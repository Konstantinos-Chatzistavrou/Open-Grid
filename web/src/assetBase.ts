// Resolves bundled public paths relative to Vite's BASE_URL ('/' on Vercel/dev, './' on itch.io
// subpath embeds) and optionally routes heavy streaming city tiles to a CORS-enabled CDN origin
// (VITE_CITY_CDN, e.g. 'https://open-grid.racing') so the itch.io HTML5 ZIP stays under itch.io's
// 500 MB / 1,000-file extracted limits while keeping all 18 real-scale cities playable.

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const rawBase = env?.BASE_URL || '/';
const BASE = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
const CITY_CDN = (env?.VITE_CITY_CDN ?? '').replace(/\/+$/, '');

/** Resolve a bundled public path (accepts '/assets/...' or 'assets/...'). */
export function pubUrl(path: string): string {
  if (!path || /^(https?:|data:|blob:)/i.test(path)) return path;
  const rel = path.replace(/^\/+/, '');
  if (CITY_CDN && (rel.startsWith('assets/cities/') || rel.startsWith('assets/nyc/'))) {
    return `${CITY_CDN}/${rel}`;
  }
  return `${BASE}${rel}`;
}
