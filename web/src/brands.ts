// 100% original, non-copyrighted fictional automotive brands for OpenGrid, each with its own crest/emblem SVG badge,
// heritage, signature colors, and factory stock engine architecture.
export type EngineVoiceId =
  | 'v8_crossplane'
  | 'v8_flatplane'
  | 'v8_supercharged'
  | 'v8_twin_turbo'
  | 'v12_na'
  | 'v10_screamer'
  | 'v6_tt'
  | 'flat6_na'
  | 'flat8_na'
  | 'i6_forged'
  | 'rotary_4';

export interface BrandInfo {
  id: 'valenza' | 'falcorn' | 'kaze' | 'kronos' | 'aether';
  name: string;
  fullName: string;
  country: string;
  origin: string;
  founded: number;
  motto: string;
  primary: string;
  accent: string;
}

export const BRANDS: Record<BrandInfo['id'], BrandInfo> = {
  valenza: {
    id: 'valenza',
    name: 'VALENZA',
    fullName: 'Valenza Automobili',
    country: 'IT',
    origin: 'Modena, Italy',
    founded: 1968,
    motto: 'Passione e Velocità',
    primary: '#d41c24',
    accent: '#f0c24b',
  },
  falcorn: {
    id: 'falcorn',
    name: 'FALCORN',
    fullName: 'Falcorn Motorsport',
    country: 'DE',
    origin: 'Stuttgart, Germany',
    founded: 1974,
    motto: 'Precision Under Load',
    primary: '#1f6feb',
    accent: '#dbe4f0',
  },
  kaze: {
    id: 'kaze',
    name: 'KAZE',
    fullName: 'Kaze Works',
    country: 'JP',
    origin: 'Yokohama, Japan',
    founded: 1981,
    motto: 'Wind & Carbon',
    primary: '#e11d48',
    accent: '#fbbf24',
  },
  kronos: {
    id: 'kronos',
    name: 'KRONOS',
    fullName: 'Kronos Mobility',
    country: 'SE',
    origin: 'Gothenburg, Sweden',
    founded: 2012,
    motto: 'Beyond Tomorrow',
    primary: '#06b6d4',
    accent: '#e2e8f0',
  },
  aether: {
    id: 'aether',
    name: 'AETHER',
    fullName: 'Aether Hyperworks',
    country: 'GB',
    origin: 'Silverstone, UK',
    founded: 2004,
    motto: 'Aero Above All',
    primary: '#ff2d6a',
    accent: '#f8fafc',
  },
};

const CAR_BRAND: Record<string, BrandInfo['id']> = {
  vela_gt: 'valenza',
  basilisk_v12: 'valenza',
  kestrel_gt: 'falcorn',
  harrier_gt: 'falcorn',
  hayate: 'kaze',
  tornado_gt: 'kaze',
  tornado_gt3: 'kaze',
  k_concept: 'kronos',
  strix_gt7: 'aether',
};

const CAR_STOCK_ENGINE: Record<string, { voice: EngineVoiceId; label: string }> = {
  vela_gt:      { voice: 'v8_crossplane', label: '4.2L Cross-Plane V8' },
  kestrel_gt:   { voice: 'flat6_na',      label: '4.0L High-Rev Flat-6' },
  harrier_gt:   { voice: 'v8_twin_turbo', label: '4.4L Twin-Turbo V8' },
  k_concept:    { voice: 'v8_flatplane',  label: '4.5L Flat-Plane V8' },
  strix_gt7:    { voice: 'v12_na',        label: '6.5L NA Track V12' },
  hayate:       { voice: 'i6_forged',     label: '3.0L Inline-6 Turbo' },
  basilisk_v12: { voice: 'v12_na',        label: '6.5L 65° NA V12' },
  tornado_gt:   { voice: 'v6_tt',         label: '3.5L Twin-Turbo V6 Hybrid' },
  tornado_gt3:  { voice: 'v8_flatplane',  label: '4.5L Flat-Plane GT3 V8' },
};

export function brandOfCar(carId: string): BrandInfo {
  return BRANDS[CAR_BRAND[carId] ?? 'valenza'];
}

export function stockEngineOfCar(carId: string): { voice: EngineVoiceId; label: string } {
  return CAR_STOCK_ENGINE[carId] ?? CAR_STOCK_ENGINE.vela_gt;
}

/** Crisp original vector crest/emblem SVG badge for each custom non-copyrighted marque. */
export function brandBadgeSvg(carOrBrandId: string, size = 28): string {
  const b = (BRANDS as Record<string, BrandInfo>)[carOrBrandId] ?? brandOfCar(carOrBrandId);
  let inner = '';
  switch (b.id) {
    case 'valenza':
      // Italian crimson & gold shield with twin-wing sculptural V crest
      inner = `
        <path d="M24 3 L42 10 V24 C42 35 33 42 24 45 C15 42 6 35 6 24 V10 Z" fill="#160608" stroke="${b.accent}" stroke-width="2.6"/>
        <path d="M24 7 L38 12.5 V23.5 C38 32 31 38 24 40.5 C17 38 10 32 10 23.5 V12.5 Z" fill="${b.primary}" opacity=".9"/>
        <path d="M14.5 15 L24 34 L33.5 15 H28.5 L24 24.8 L19.5 15 Z" fill="${b.accent}"/>
        <path d="M18 11.5 H30" stroke="${b.accent}" stroke-width="1.8" stroke-linecap="round"/>`;
      break;
    case 'falcorn':
      // German motorsport split shield with swept falcon speed-bars & apex star
      inner = `
        <path d="M24 3 L41 9 L39 27 C38 35 31 41 24 45 C17 41 10 35 9 27 L7 9 Z" fill="#0b1324" stroke="${b.accent}" stroke-width="2.4"/>
        <path d="M10 12 L24 7 L38 12 L37 22 H11 Z" fill="${b.primary}"/>
        <path d="M12 25 H36 L34 29 H14 Z" fill="${b.accent}" opacity=".92"/>
        <path d="M15 32 H33 L30 35.5 H18 Z" fill="${b.primary}"/>
        <polygon points="24,10 26.2,15.5 32,15.8 27.4,19.2 29,24.5 24,21.2 19,24.5 20.6,19.2 16,15.8 21.8,15.5" fill="#fff"/>`;
      break;
    case 'kaze':
      // Japanese forged octagonal emblem with twin swept katana/wind blades
      inner = `
        <polygon points="16,4 32,4 44,16 44,32 32,44 16,44 4,32 4,16" fill="#14090d" stroke="${b.accent}" stroke-width="2.4"/>
        <circle cx="24" cy="24" r="14" fill="none" stroke="${b.primary}" stroke-width="2.2"/>
        <path d="M13 18 L34 14 L25 23 L36 30 L14 34 L23 25 Z" fill="${b.accent}"/>
        <circle cx="24" cy="24" r="3.2" fill="${b.primary}"/>`;
      break;
    case 'kronos':
      // Nordic obsidian & cyan hexagonal prism with split geometric K-bolt
      inner = `
        <polygon points="24,3 42,13.5 42,34.5 24,45 6,34.5 6,13.5" fill="#08131a" stroke="${b.primary}" stroke-width="2.5"/>
        <polygon points="24,8 37,15.5 37,32.5 24,40 11,32.5 11,15.5" fill="#0e2431"/>
        <path d="M17 14 V34 M19 24 L31 14 M22 23 L32 34" stroke="${b.accent}" stroke-width="3.2" stroke-linecap="square"/>
        <circle cx="32" cy="14" r="2.2" fill="${b.primary}"/>`;
      break;
    case 'aether':
      // British hypercar swept delta-wing aero crest
      inner = `
        <polygon points="24,3 44,24 24,45 4,24" fill="#120914" stroke="${b.accent}" stroke-width="2.2"/>
        <path d="M24 9 L37 31 L24 25 L11 31 Z" fill="${b.primary}"/>
        <path d="M24 14 L31 27 L24 23.5 L17 27 Z" fill="${b.accent}"/>`;
      break;
  }
  return `<svg class="brand-badge" viewBox="0 0 48 48" width="${size}" height="${size}" aria-label="${b.fullName}" title="${b.fullName} · ${b.origin}">${inner}</svg>`;
}
