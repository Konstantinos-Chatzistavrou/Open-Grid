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
}

export const NIGHT: NavTheme = {
  night: true,
  land: '#1a232e',
  landFar: '#141b24',
  road: ['#3d4959', '#485669', '#5a6a82', '#a08c5a'],
  casing: ['#11171f', '#11171f', '#10161e', '#4f4328'],
  roof: '#324053',
  roofEdge: '#ffffff12',
  wallLit: '#28343f',
  wallDark: '#202a36',
  label: '#aeb8c6',
  labelHalo: '#1d2733',
  route: '#4d94ff',
  routeCasing: '#173a78',
  puck: '#4d94ff',
  haze: '#141b24',
  card: '#1f2328',
  cardText: '#f1f3f4',
  cardSub: '#aab0b8',
  cardLine: '#ffffff1f',
  maneuver: '#0b7a45',
  maneuverDark: '#085f35',
  eta: '#5bd486',
  button: '#2a2f36',
  buttonIcon: '#e8eaed',
  poi: '#7ea1ff',
};

export const DAY: NavTheme = {
  night: false,
  land: '#eceae4',
  landFar: '#e2e0da',
  road: ['#ffffff', '#ffffff', '#ffffff', '#fdd479'],
  casing: ['#cfd2d6', '#c6cacf', '#b9bec4', '#e0a93a'],
  roof: '#f6f4f0',
  roofEdge: '#00000014',
  wallLit: '#e0ddd6',
  wallDark: '#cfccc4',
  label: '#4d535a',
  labelHalo: '#ffffff',
  route: '#4285f4',
  routeCasing: '#1a56c2',
  puck: '#4285f4',
  haze: '#e2e0da',
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
