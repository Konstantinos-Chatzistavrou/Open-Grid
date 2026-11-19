// Console-cert Accessibility Settings:
//   - Colorblind Modes (Off, Protanopia, Deuteranopia, Tritanopia): remaps Driving Line & Minimap icons
//     (Player, Rivals, Police, Roadblocks, Speed Traps, Drift Zones, Race Nodes) to high-contrast palettes.
//   - UI Scaling (85%, 100%, 115%, 130%): scales HUD speedometer, minimap, and telemetry widgets via `--hud-scale`.

export type ColorblindMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export type UiScale = 0.85 | 1 | 1.15 | 1.3;

export interface AccessibilitySettings {
  colorblind: ColorblindMode;
  uiScale: UiScale;
}

export interface ColorPalette {
  /** Driving line RGB 0..1 */
  lineGo: [number, number, number];
  lineCaution: [number, number, number];
  lineBrake: [number, number, number];
  /** Minimap hex colours */
  rival: string;
  traffic: string;
  peer: string;
  cop: string;
  roadblock: string;
  speedTrap: string;
  driftZone: string;
  raceNode: string;
  dragFinish: string;
}

export const PALETTES: Record<ColorblindMode, ColorPalette> = {
  off: {
    lineGo: [0.25, 0.6, 1.0],
    lineCaution: [1.0, 0.78, 0.1],
    lineBrake: [1.0, 0.12, 0.08],
    rival: '#ff4d6d',
    traffic: '#d0d8e8',
    peer: '#4dd2ff',
    cop: '#2a9dff',
    roadblock: '#ff9f1c',
    speedTrap: '#00e5ff',
    driftZone: '#ff9f1c',
    raceNode: '#c77dff',
    dragFinish: '#ff2d6a',
  },
  // Okabe-Ito colorblind-safe high-contrast palettes
  protanopia: {
    lineGo: [0.0, 0.45, 0.7],
    lineCaution: [0.95, 0.9, 0.25],
    lineBrake: [0.9, 0.6, 0.0],
    rival: '#e69f00',
    traffic: '#d9dee8',
    peer: '#56b4e9',
    cop: '#0072b2',
    roadblock: '#f0e442',
    speedTrap: '#56b4e9',
    driftZone: '#f0e442',
    raceNode: '#ffffff',
    dragFinish: '#e69f00',
  },
  deuteranopia: {
    lineGo: [0.0, 0.45, 0.7],
    lineCaution: [0.95, 0.9, 0.25],
    lineBrake: [0.84, 0.37, 0.0],
    rival: '#d55e00',
    traffic: '#d9dee8',
    peer: '#56b4e9',
    cop: '#0072b2',
    roadblock: '#f0e442',
    speedTrap: '#56b4e9',
    driftZone: '#f0e442',
    raceNode: '#cc79a7',
    dragFinish: '#d55e00',
  },
  tritanopia: {
    lineGo: [0.0, 0.62, 0.45],
    lineCaution: [0.95, 0.6, 0.7],
    lineBrake: [0.9, 0.15, 0.25],
    rival: '#ff2d55',
    traffic: '#e5e7eb',
    peer: '#00c49a',
    cop: '#ffffff',
    roadblock: '#ff6b6b',
    speedTrap: '#00c49a',
    driftZone: '#ff99c8',
    raceNode: '#ff2d55',
    dragFinish: '#ffffff',
  },
};

const A11Y_KEY = 'nr.a11y.v1';

export function loadAccessibility(): AccessibilitySettings {
  const def: AccessibilitySettings = { colorblind: 'off', uiScale: 1 };
  try {
    const raw = JSON.parse(localStorage.getItem(A11Y_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      if (raw.colorblind in PALETTES) def.colorblind = raw.colorblind;
      if ([0.85, 1, 1.15, 1.3].includes(Number(raw.uiScale))) def.uiScale = Number(raw.uiScale) as UiScale;
    }
  } catch { /* blocked */ }
  return def;
}

export function saveAccessibility(s: AccessibilitySettings) {
  try { localStorage.setItem(A11Y_KEY, JSON.stringify(s)); } catch { /* blocked */ }
}

export function applyAccessibility(s: AccessibilitySettings) {
  document.documentElement.style.setProperty('--hud-scale', String(s.uiScale));
  document.documentElement.dataset.cb = s.colorblind;
}

export function paletteOf(s: AccessibilitySettings): ColorPalette {
  return PALETTES[s.colorblind] ?? PALETTES.off;
}
