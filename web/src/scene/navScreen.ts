// In-car navigation screen: a physical display mounted on the dashboard, using the live GPS canvas as its
// texture. It is part of the car model (moves with the body), self-lit like a real screen, and only powered
// while driving - in the garage the glass is dark.
import * as THREE from 'three/webgpu';

export interface NavScreen {
  group: THREE.Group;
  setVisible(on: boolean): void;
  /** mark the canvas texture dirty after the minimap redraws */
  touch(): void;
}

export function createNavScreen(canvas: HTMLCanvasElement): NavScreen {
  const group = new THREE.Group();
  group.name = 'nav_screen';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.15),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(1.25, 1.25, 1.25) }),
  );
  screen.name = 'nav_screen_glass';
  screen.position.z = 0.0075;

  // bezel + back shell, so it reads as a device and not a floating decal
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.45, metalness: 0.2 });
  const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.285, 0.172, 0.014), bodyMat);
  bezel.name = 'nav_screen_bezel';
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.245, 0.14, 0.05), bodyMat);
  back.position.z = -0.032;
  // a short stand so it sits on the dash instead of hovering
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.05), bodyMat);
  stand.position.set(0, -0.1, -0.015);
  stand.rotation.x = 0.25;

  group.add(bezel, screen, back, stand);
  // tilt the face up toward the driver, face -z (the cabin side)
  group.rotation.set(-0.35, Math.PI, 0);
  group.position.set(-0.02, 0.94, 0.5);
  group.scale.setScalar(1.15);
  group.visible = false;

  return {
    group,
    setVisible(on: boolean) { group.visible = on; },
    touch() { tex.needsUpdate = true; },
  };
}
