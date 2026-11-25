// The look of the in-car navigation: colour themes (day / night, after the map styling of a modern phone navigation app),
// the turn-arrow glyphs, the round buttons and the speed-limit sign. Everything is drawn into one 2D canvas
// (640 x 400 logical px) so the same picture serves the HUD device and the cabin screen texture.
// Own drawing code and colours; no third-party logos or icon fonts.

export interface NavTheme {
  night: boolean;
  land: string;
  landFar: string;
  /** road tiers: 0 local, 1 collector, 2 arterial, 3 highway */
  road: [string, string, string, string];
  casing: [string, string, string, string];
  roof: string;
  roofEdge: string;
  wallLit: string;
  wallDark: string;
  label: string;
  labelHalo: string;
  route: string;
  routeCasing: string;
  puck: string;
  haze: string;
  card: string;
  cardText: string;
  cardSub: string;
  cardLine: string;
  maneuver: string;
  maneuverDark: string;
  eta: string;
  button: string;
  buttonIcon: string;
  poi: string;
  water: string;
  waterEdge: string;
  green: string;
  greenEdge: string;
  laneDash: string;
  bldgShadow: string;
  bldgFlat: string;
  shieldBg: string;
  shieldBorder: string;
  shieldText: string;
  puckDisc: string;
  roadPill: string;
  roadPillBorder: string;
  trafficOrange: string;
  trafficRed: string;
  trafficOrangeCasing: string;
  trafficRedCasing: string;
}

export const NIGHT: NavTheme = {
  night: true,
  land: '#18212b',
  landFar: '#121922',
  road: ['#2f3b4a', '#3b4a5e', '#4d6078', '#b09155'],
  casing: ['#0d131a', '#0d131a', '#0b1017', '#4c3e20'],
  roof: '#2d3b4e',
  roofEdge: '#ffffff1c',
  wallLit: '#243140',
  wallDark: '#1b2532',
  label: '#c6d0dd',
  labelHalo: '#141c26',
  route: '#4b93ff',
  routeCasing: '#153a7a',
  puck: '#4285f4',
  haze: '#121922',
  card: '#1f2328',
  cardText: '#f1f3f4',
  cardSub: '#aab0b8',
  cardLine: '#ffffff1f',
  maneuver: '#0b7b44',
  maneuverDark: '#075c32',
  eta: '#5bd486',
  button: '#282d35',
  buttonIcon: '#e8eaed',
  poi: '#6ea8fe',
  water: '#123452',
  waterEdge: '#204d73',
  green: '#18382d',
  greenEdge: '#224a3c',
  laneDash: '#ffffff24',
  bldgShadow: 'rgba(6, 10, 16, 0.42)',
  bldgFlat: '#24303e',
  shieldBg: '#184734',
  shieldBorder: '#7ad8a4',
  shieldText: '#eefbf3',
  puckDisc: '#ffffff',
  roadPill: '#20262ee8',
  roadPillBorder: '#ffffff26',
  trafficOrange: '#f9ab00',
  trafficRed: '#ea4335',
  trafficOrangeCasing: '#7a4d00',
  trafficRedCasing: '#6d1b14',
};

export const DAY: NavTheme = {
  night: false,
  land: '#f1f3f4',
  landFar: '#e4e7ea',
  road: ['#ffffff', '#ffffff', '#ffffff', '#ffda75'],
  casing: ['#dadce0', '#cfd3d8', '#bdc1c6', '#e0a21e'],
  roof: '#f6f7f8',
  roofEdge: '#00000018',
  wallLit: '#e2e5e9',
  wallDark: '#cfd4da',
  label: '#3c4043',
  labelHalo: '#ffffff',
  route: '#4285f4',
  routeCasing: '#1a56c2',
  puck: '#4285f4',
  haze: '#e4e7ea',
  card: '#ffffff',
  cardText: '#202124',
  cardSub: '#5f6368',
  cardLine: '#0000001a',
  maneuver: '#0b8043',
  maneuverDark: '#096a38',
  eta: '#188038',
  button: '#ffffff',
  buttonIcon: '#3c4043',
  poi: '#4285f4',
  water: '#aadaff',
  waterEdge: '#89c4f4',
  green: '#ceead6',
  greenEdge: '#a8dab5',
  laneDash: '#b0b8c288',
  bldgShadow: 'rgba(32, 42, 54, 0.16)',
  bldgFlat: '#e6e8ec',
  shieldBg: '#137333',
  shieldBorder: '#ffffff',
  shieldText: '#ffffff',
  puckDisc: '#ffffff',
  roadPill: '#ffffffeb',
  roadPillBorder: '#dadce0',
  trafficOrange: '#f29900',
  trafficRed: '#d93025',
  trafficOrangeCasing: '#b06a00',
  trafficRedCasing: '#8c1c13',
};

export type ManeuverKind = 'straight' | 'slight' | 'turn' | 'sharp' | 'uturn' | 'arrive';

export function classifyTurn(angRad: number): ManeuverKind {
  const a = Math.abs(angRad);
  if (a < 0.28) return 'straight';
  if (a < 1.2) return 'slight';
  if (a < 2.1) return 'turn';
  if (a < 2.7) return 'sharp';
  return 'uturn';
}

const R = 0.2;   // corner radius of the arrow stem, in glyph units

/** A turn arrow centred on (0, 0), `s` px tall, pointing up out of the bottom: white, round joins, a solid head. dir -1 = left, 1 = right. */
export function drawManeuver(c: CanvasRenderingContext2D, kind: ManeuverKind, dir: -1 | 1, s: number, color = '#ffffff') {
  c.save();
  c.scale(dir * s, s);
  c.strokeStyle = color; c.fillStyle = color;
  c.lineWidth = 0.15; c.lineCap = 'butt'; c.lineJoin = 'round';
  let pts: number[][];
  let head: number;   // heading of the arrow head, radians (0 = +x, -pi/2 = up)
  switch (kind) {
    case 'straight': pts = [[0, 0.46], [0, -0.22]]; head = -Math.PI / 2; break;
    case 'slight': pts = [[-0.14, 0.46], [-0.14, 0.06], [0.2, -0.24]]; head = -Math.PI / 4; break;
    case 'turn': pts = [[-0.18, 0.46], [-0.18, -0.08], [0.2, -0.08]]; head = 0; break;
    case 'sharp': pts = [[-0.2, -0.38], [-0.2, -0.02], [0.14, 0.3]]; head = Math.PI / 4; break;
    case 'uturn': pts = [[-0.22, 0.46], [-0.22, -0.2], [0.22, -0.2], [0.22, 0.18]]; head = Math.PI / 2; break;
    default: pts = []; head = 0;
  }
  if (kind === 'arrive') {
    // chequered flag, as the finish marker of a route
    c.lineWidth = 0.08;
    c.beginPath(); c.moveTo(-0.22, 0.46); c.lineTo(-0.22, -0.44); c.stroke();
    const n = 4, cw = 0.15, x0 = -0.22, y0 = -0.44;
    for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) {
      c.fillStyle = (i + j) % 2 ? color : 'rgba(255,255,255,0.28)';
      c.fillRect(x0 + i * cw, y0 + j * cw, cw, cw);
    }
    c.restore();
    return;
  }
  // body with rounded corners, stopping short of the head
  const hl = 0.24;   // head length
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const dx = last[0] - prev[0], dy = last[1] - prev[1], dl = Math.hypot(dx, dy) || 1;
  const end = [last[0] - (dx / dl) * (hl * 0.55), last[1] - (dy / dl) * (hl * 0.55)];
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) c.arcTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], R);
  c.lineTo(end[0], end[1]);
  c.stroke();
  // head
  c.save();
  c.translate(last[0], last[1]); c.rotate(Math.atan2(dy, dx) || head);
  c.beginPath(); c.moveTo(hl, 0); c.lineTo(-hl * 0.35, hl * 0.78); c.lineTo(-hl * 0.35, -hl * 0.78); c.closePath(); c.fill();
  c.restore();
  c.restore();
}

export function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** A floating card with a soft shadow. */
export function card(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, night: boolean) {
  c.save();
  c.shadowColor = night ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.28)';
  c.shadowBlur = 12; c.shadowOffsetY = 3;
  c.fillStyle = fill;
  roundRect(c, x, y, w, h, r);
  c.fill();
  c.restore();
}

/** A round map button with a white / dark disc and one of a few icons. */
export function roundButton(c: CanvasRenderingContext2D, x: number, y: number, r: number, t: NavTheme, icon: 'speaker' | 'search' | 'report' | 'close' | 'overview') {
  c.save();
  c.shadowColor = t.night ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)';
  c.shadowBlur = 8; c.shadowOffsetY = 2;
  c.fillStyle = t.button;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.restore();
  c.save();
  c.translate(x, y);
  c.strokeStyle = t.buttonIcon; c.fillStyle = t.buttonIcon; c.lineWidth = r * 0.12; c.lineCap = 'round'; c.lineJoin = 'round';
  const u = r / 20;
  if (icon === 'speaker') {
    c.beginPath(); c.moveTo(-9 * u, -4 * u); c.lineTo(-4 * u, -4 * u); c.lineTo(2 * u, -9 * u); c.lineTo(2 * u, 9 * u); c.lineTo(-4 * u, 4 * u); c.lineTo(-9 * u, 4 * u); c.closePath(); c.fill();
    c.beginPath(); c.arc(3 * u, 0, 6 * u, -0.9, 0.9); c.stroke();
    c.beginPath(); c.arc(3 * u, 0, 10.5 * u, -0.9, 0.9); c.stroke();
  } else if (icon === 'search') {
    c.beginPath(); c.arc(-2 * u, -2 * u, 7 * u, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(3 * u, 3 * u); c.lineTo(9 * u, 9 * u); c.stroke();
  } else if (icon === 'report') {
    roundRect(c, -9 * u, -9 * u, 18 * u, 14 * u, 3 * u); c.stroke();
    c.beginPath(); c.moveTo(-3 * u, 5 * u); c.lineTo(-3 * u, 10 * u); c.lineTo(3 * u, 5 * u); c.stroke();
    c.beginPath(); c.moveTo(0, -5 * u); c.lineTo(0, 0); c.stroke();
    c.beginPath(); c.arc(0, 2.6 * u, 0.9 * u, 0, Math.PI * 2); c.fill();
  } else if (icon === 'close') {
    c.beginPath(); c.moveTo(-7 * u, -7 * u); c.lineTo(7 * u, 7 * u); c.moveTo(7 * u, -7 * u); c.lineTo(-7 * u, 7 * u); c.stroke();
  } else {
    // route overview: a zig-zag between two dots
    c.beginPath(); c.moveTo(-8 * u, 7 * u); c.lineTo(-2 * u, 7 * u); c.lineTo(-2 * u, -2 * u); c.lineTo(6 * u, -2 * u); c.lineTo(6 * u, -8 * u); c.stroke();
    c.beginPath(); c.arc(-8 * u, 7 * u, 2.2 * u, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(6 * u, -8 * u, 2.2 * u, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

/** The compass button: a disc with a needle that points to north. `north` is the screen angle of north (0 = up). */
export function compassButton(c: CanvasRenderingContext2D, x: number, y: number, r: number, t: NavTheme, north: number) {
  c.save();
  c.shadowColor = t.night ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)';
  c.shadowBlur = 8; c.shadowOffsetY = 2;
  c.fillStyle = t.button;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.restore();
  c.save();
  c.translate(x, y); c.rotate(north);
  const u = r / 20;
  c.fillStyle = '#ea4335';
  c.beginPath(); c.moveTo(0, -12 * u); c.lineTo(5 * u, 1 * u); c.lineTo(-5 * u, 1 * u); c.closePath(); c.fill();
  c.fillStyle = t.night ? '#9aa0a6' : '#80868b';
  c.beginPath(); c.moveTo(0, 12 * u); c.lineTo(5 * u, 1 * u); c.lineTo(-5 * u, 1 * u); c.closePath(); c.fill();
  c.restore();
}

/** Speed-limit sign (round, red ring) and the current-speed bubble, which turns red over the limit. */
export function speedBubbles(c: CanvasRenderingContext2D, x: number, y: number, speedKmh: number, limit: number, t: NavTheme, font: string) {
  const over = limit > 0 && speedKmh > limit + 2;
  // limit sign above
  if (limit > 0) {
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 8; c.shadowOffsetY = 2;
    c.fillStyle = '#ffffff';
    c.beginPath(); c.arc(x, y - 64, 25, 0, Math.PI * 2); c.fill();
    c.restore();
    c.strokeStyle = '#d93025'; c.lineWidth = 5.5;
    c.beginPath(); c.arc(x, y - 64, 21.5, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#202124'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `700 ${limit >= 100 ? 19 : 23}px ${font}`;
    c.fillText(String(limit), x, y - 63.5);
  }
  // speed bubble
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 8; c.shadowOffsetY = 2;
  c.fillStyle = over ? '#d93025' : t.card;
  c.beginPath(); c.arc(x, y, 28, 0, Math.PI * 2); c.fill();
  c.restore();
  c.fillStyle = over ? '#ffffff' : t.cardText; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `700 ${speedKmh >= 100 ? 24 : 28}px ${font}`;
  c.fillText(String(Math.round(speedKmh)), x, y - 3);
  c.fillStyle = over ? '#ffd9d5' : t.cardSub;
  c.font = `500 9.5px ${font}`;
  c.fillText('km/h', x, y + 15);
}

/** 3-lane guidance pill under the emerald maneuver card when approaching a turn (Google Maps lane assistant). */
export function drawLaneGuidance(c: CanvasRenderingContext2D, x: number, y: number, w: number, kind: ManeuverKind, dir: -1 | 1, t: NavTheme) {
  const h = 34;
  c.save();
  c.fillStyle = t.maneuverDark;
  roundRect(c, x, y - 6, w, h + 6, 12);
  c.fill();
  c.fillStyle = t.maneuver;
  c.fillRect(x, y - 6, w, 9);
  const cx = x + w * 0.5;
  const cy = y + h * 0.5 + 1;
  const activeLane = kind === 'straight' ? 1 : (dir < 0 ? 0 : 2);
  for (let lane = 0; lane < 3; lane++) {
    const lx = cx + (lane - 1) * 34;
    const isAct = lane === activeLane;
    const lk: ManeuverKind = isAct ? kind : 'straight';
    const ld: -1 | 1 = isAct ? dir : 1;
    c.save();
    c.translate(lx, cy);
    drawManeuver(c, lk, ld, 21, isAct ? '#ffffff' : 'rgba(255,255,255,0.34)');
    c.restore();
    if (lane < 2) {
      c.strokeStyle = 'rgba(255,255,255,0.22)';
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(lx + 17, y + 6);
      c.lineTo(lx + 17, y + h - 4);
      c.stroke();
      c.setLineDash([]);
    }
  }
  c.restore();
}

/** Crisp highway route shield pill (e.g. "I-495", "FDR", "A1", "M25") like Google Maps navigation. */
export function drawHighwayShield(c: CanvasRenderingContext2D, x: number, y: number, text: string, t: NavTheme, font: string) {
  c.save();
  c.font = `700 10px ${font}`;
  const tw = c.measureText(text).width;
  const pw = Math.max(26, tw + 11);
  const ph = 16;
  roundRect(c, x - pw / 2, y - ph / 2, pw, ph, 4);
  c.fillStyle = t.shieldBg;
  c.fill();
  c.strokeStyle = t.shieldBorder;
  c.lineWidth = 1.25;
  c.stroke();
  c.fillStyle = t.shieldText;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y + 0.5);
  c.restore();
}
