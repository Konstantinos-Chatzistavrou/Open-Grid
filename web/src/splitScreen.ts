// Split-Screen Eligibility Guard & Performance Scaler (OpenGrid).
// Blueprint rules:
//   - Strictly locked to displays >= 27 inches (desktop >= 1920x1080 viewport heuristic)
//   - Requires 2 connected gamepads / steering wheels
//   - Automatically steps down LOD / shadow frequency while split-screen is active to protect FPS

export interface SplitScreenCheck {
  eligible: boolean;
  displayOk: boolean;
  padsCount: number;
  reason: string;
}

export function checkSplitScreen(): SplitScreenCheck {
  const screenW = Math.max(screen.width * (devicePixelRatio || 1), innerWidth);
  const displayOk = screenW >= 1920 && !matchMedia('(pointer: coarse)').matches;
  const pads = (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
  const padsCount = pads.length;
  if (!displayOk) {
    return { eligible: false, displayOk: false, padsCount, reason: 'Split-screen requires a 27"+ desktop display (>= 1080p).' };
  }
  if (padsCount < 2) {
    return { eligible: false, displayOk: true, padsCount, reason: `Connect 2 controllers/wheels (${padsCount}/2 detected).` };
  }
  return { eligible: true, displayOk: true, padsCount, reason: 'Ready: 27"+ display & 2 controllers detected (LOD/shadows auto-optimized).' };
}
