// In-car navigation head unit: a physical rectangular display on the dash that shows the live GPS canvas. It is part of the car
// model (moves with the body), self-lit like a real LCD, and only powered while driving - in the garage the glass is dark.
// Built to read as a real unit: a rounded piano-black housing with a bevelled edge and a thin metal trim, a recessed panel, a
// glass layer with a soft reflection of the windscreen that slides as the car turns, three hard keys and a standby LED, and a
// short arm that mounts it on the dash.
import * as THREE from 'three/webgpu';

export interface NavScreen {
  group: THREE.Group;
  setVisible(on: boolean): void;
  /** mark the canvas texture dirty after the GPS redraws */
  touch(): void;
}

const SW = 0.256, SH = 0.16;   // the lit panel, 16:10 like the GPS canvas
const PY = 0.0085;             // the panel sits this far above the housing's centre (room for the keys under it)

function outline<T extends THREE.Path>(p: T, w: number, h: number, r: number, cy = 0): T {
  const x = -w / 2, y = -h / 2 + cy;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y); p.quadraticCurveTo(x + w, y, x + w, y + r);
  p.lineTo(x + w, y + h - r); p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h); p.quadraticCurveTo(x, y + h, x, y + h - r);
  p.lineTo(x, y + r); p.quadraticCurveTo(x, y, x + r, y);
  return p;
}
/** a rounded rectangle, optionally with a rounded window cut out of it (the window sits `holeDy` above the shape's centre) */
function roundedRect(w: number, h: number, r: number, hole?: { w: number; h: number; r: number; dy?: number }) {
  const s = outline(new THREE.Shape(), w, h, r);
  if (hole) s.holes.push(outline(new THREE.Path(), hole.w, hole.h, hole.r, hole.dy ?? 0));
  return s;
}

/** A soft diagonal sheen, drawn once: the windscreen's reflection in the glass. */
function glareTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const g = c.getContext('2d')!;
  const l = g.createLinearGradient(0, 0, 256, 160);
  l.addColorStop(0, 'rgba(255,255,255,0.55)');
  l.addColorStop(0.34, 'rgba(255,255,255,0.16)');
  l.addColorStop(0.41, 'rgba(255,255,255,0.00)');
  l.addColorStop(0.55, 'rgba(255,255,255,0.00)');
  l.addColorStop(0.62, 'rgba(255,255,255,0.08)');
  l.addColorStop(1, 'rgba(255,255,255,0.00)');
  g.fillStyle = l; g.fillRect(0, 0, 256, 160);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createNavScreen(canvas: HTMLCanvasElement): NavScreen {
  const group = new THREE.Group();
  group.name = 'nav_screen';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(SW, SH),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(1.35, 1.35, 1.35) }),
  );
  screen.name = 'nav_screen_glass';
  screen.position.z = 0.0088;
  screen.position.y = PY;

  // housing: rounded slab with a bevelled front edge (piano-black plastic, clear-coated so it picks up the cabin reflections)
  const housingGeo = new THREE.ExtrudeGeometry(roundedRect(SW + 0.03, SH + 0.034, 0.016, { w: SW + 0.002, h: SH + 0.002, r: 0.004, dy: 0.0085 }), {
    depth: 0.010, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 3, curveSegments: 8,
  });
  const housingMat = new THREE.MeshPhysicalMaterial({ color: 0x0a0b0e, roughness: 0.38, metalness: 0.2, clearcoat: 0.85, clearcoatRoughness: 0.1 });
  const housing = new THREE.Mesh(housingGeo, housingMat);
  housing.name = 'nav_screen_bezel';
  housing.position.z = -0.004;

  // thin metal trim around the panel opening
  const trimGeo = new THREE.ExtrudeGeometry(roundedRect(SW + 0.007, SH + 0.007, 0.006, { w: SW - 0.002, h: SH - 0.002, r: 0.003 }), { depth: 0.0012, bevelEnabled: false, curveSegments: 6 });
  const trim = new THREE.Mesh(trimGeo, new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.28, metalness: 1 }));
  trim.position.z = 0.0103;
  trim.position.y = PY;

  // the glass: a reflection that is added over the picture (it does not darken it)
  const glare = new THREE.Mesh(
    new THREE.PlaneGeometry(SW, SH),
    new THREE.MeshBasicMaterial({ map: glareTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.42, toneMapped: false }),
  );
  glare.name = 'nav_screen_glare';
  glare.position.z = 0.0094;
  glare.position.y = PY;

  // three hard keys under the glass and a standby LED
  const keyMat = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.4, metalness: 0.5 });
  const keys: THREE.Mesh[] = [];
  for (let i = -1; i <= 1; i++) {
    const k = new THREE.Mesh(new THREE.CapsuleGeometry(0.0022, 0.012, 3, 6), keyMat);
    k.rotation.z = Math.PI / 2;
    k.position.set(i * 0.034, PY - SH / 2 - 0.0128, 0.0108);
    keys.push(k);
  }
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.0017, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 2.2, 0.7), toneMapped: false }));
  led.position.set(SW / 2 - 0.004, PY - SH / 2 - 0.0128, 0.0108);

  // rear shell and the arm that mounts it on the dash
  const rear = new THREE.Mesh(new THREE.BoxGeometry(SW * 0.86, SH * 0.82, 0.034), housingMat);
  rear.position.z = -0.026;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, 0.075, 12), new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.5, metalness: 0.4 }));
  arm.position.set(0, -SH / 2 - 0.03, -0.03);
  arm.rotation.x = 0.25;
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.008, 20), new THREE.MeshStandardMaterial({ color: 0x0d0e11, roughness: 0.6, metalness: 0.2 }));
  foot.position.set(0, -SH / 2 - 0.066, -0.034);

  group.add(housing, trim, screen, glare, ...keys, led, rear, arm, foot);
  // tilt the face up toward the driver, face -z (the cabin side); sits on the dash top
  group.rotation.set(-0.3, Math.PI, 0);
  group.position.set(-0.02, 0.99, 0.5);
  group.scale.setScalar(1.15);
  group.visible = false;

  return {
    group,
    setVisible(on: boolean) { group.visible = on; },
    touch() { tex.needsUpdate = true; },
  };
}
