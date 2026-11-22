// Apache-2.0. open-grid-physics driving a Rapier rigid body, drawn with three.js. Serve the package folder
// (npx serve .  or  python3 -m http.server) and open /examples/three-rapier/.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadPhysics } from 'open-grid-physics';

const DT = 1 / 240;            // the core wants small steps; Rapier runs at the same rate
const base = new URL('../../', import.meta.url);
const [physics, spec, routeJson] = await Promise.all([
  loadPhysics(),
  fetch(new URL('cars/example_coupe.json', base)).then((r) => r.text()),
  fetch(new URL('routes/example_circuit.json', base)).then((r) => r.json()),
  RAPIER.init(),
]);
const car = physics.createCar(spec);
const info = car.info;

// ---- Rapier world: a flat ground and the car body (origin = centre of gravity) -----------------------------------
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });   // gravity is yours: the core never adds it
world.timestep = DT;
world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0).setFriction(0.8));

const start = routeStart(routeJson);
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
  .setTranslation(start.x, info.cgHeight + 0.05, start.z)
  .setRotation(yawQuat(start.yaw))
  .setCanSleep(false)
  .setAdditionalMassProperties(info.mass, { x: 0, y: 0, z: 0 },
    { x: info.inertia[0], y: info.inertia[1], z: info.inertia[2] }, { x: 0, y: 0, z: 0, w: 1 }));
// crash shell only (density 0: mass and inertia come from the spec above); it sits above the wheels' reach
const shell = world.createCollider(RAPIER.ColliderDesc.cuboid(0.9, 0.3, 2.2).setTranslation(0, 0.05, 0.1).setDensity(0)
  .setFriction(0.3), body);

// ---- three.js scene ---------------------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cb8d0);
scene.fog = new THREE.Fog(0x9cb8d0, 200, 900);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 3000);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x445533, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(100, 200, 50);
scene.add(sun);
const grass = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x4f7a3a }));
grass.rotation.x = -Math.PI / 2;
scene.add(grass);
scene.add(roadMesh(routeJson));

const carGroup = new THREE.Group();
const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 4.4), new THREE.MeshLambertMaterial({ color: 0xd8442f }));
chassis.position.set(0, 0.05, 0.1);
carGroup.add(chassis);
scene.add(carGroup);
const wheelMeshes = [0, 1, 2, 3].map(() => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(info.wheelRadius, info.wheelRadius, 0.24, 20).rotateZ(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x1c1c1c }));
  scene.add(m);
  return m;
});

// ---- input ------------------------------------------------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'KeyR') reset(); });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
function readInput() {
  const k = (a, b) => keys.has(a) || keys.has(b);
  return {
    steer: (k('ArrowLeft', 'KeyA') ? 1 : 0) - (k('ArrowRight', 'KeyD') ? 1 : 0),   // + = left
    throttle: k('ArrowUp', 'KeyW') ? 1 : 0,
    brake: k('ArrowDown', 'KeyS') ? 1 : 0,
    handbrake: keys.has('Space') ? 1 : 0,
    device: 0,   // keyboard: the core ramps and speed-limits the steering like a game would
  };
}
function reset() {
  body.setTranslation({ x: start.x, y: info.cgHeight + 0.05, z: start.z }, true);
  body.setRotation(yawQuat(start.yaw), true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  car.resetMotion(0, 1);
  car.repair();
}

// ---- the physics step: Rapier state -> rays -> Rapier raycasts -> core -> force + torque -> Rapier ---------------
const state = new Float64Array(13);
const contacts = new Float64Array(32);
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
let out = null;
function physicsStep(input) {
  const p = body.translation(), q = body.rotation(), v = body.linvel(), w = body.angvel();
  state.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z]);
  const r = car.rays(state);
  for (let i = 0; i < 4; i++) {
    const o = 8 * i;
    const fx = r[6 * i], fy = r[6 * i + 1], fz = r[6 * i + 2];
    const dx = r[6 * i + 3] - fx, dy = r[6 * i + 4] - fy, dz = r[6 * i + 5] - fz;
    const len = Math.hypot(dx, dy, dz);
    ray.origin = { x: fx, y: fy, z: fz };
    ray.dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = world.castRayAndGetNormal(ray, len, true, undefined, undefined, shell, body);
    if (hit) {
      const t = hit.timeOfImpact ?? hit.toi;
      contacts.set([1, fx + ray.dir.x * t, fy + ray.dir.y * t, fz + ray.dir.z * t,
        hit.normal.x, hit.normal.y, hit.normal.z, info.surfaces.asphalt], o);
    } else contacts[o] = 0;
  }
  out = car.step(contacts, input, DT);
  body.resetForces(true);
  body.resetTorques(true);
  body.addForce({ x: out.force[0], y: out.force[1], z: out.force[2] }, true);
  body.addTorque({ x: out.torque[0], y: out.torque[1], z: out.torque[2] }, true);
  world.step();
}

// ---- loop: fixed 240 Hz physics, render at display rate ----------------------------------------------------------
let acc = 0, last = performance.now();
const camPos = new THREE.Vector3(start.x, 4, start.z - 10);
const hud = document.getElementById('hud');
function frame(now) {
  acc = Math.min(acc + (now - last) / 1000, 0.1);
  last = now;
  const input = readInput();
  while (acc >= DT) { physicsStep(input); acc -= DT; }

  const p = body.translation(), q = body.rotation();
  carGroup.position.set(p.x, p.y, p.z);
  carGroup.quaternion.set(q.x, q.y, q.z, q.w);
  out.wheels.forEach((wh, i) => {
    wheelMeshes[i].position.set(wh.centre[0], wh.centre[1], wh.centre[2]);
    wheelMeshes[i].quaternion.copy(carGroup.quaternion)
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(wh.spin, wh.steer, 0, 'YXZ')));
  });
  const behind = new THREE.Vector3(0, 2.2, -7).applyQuaternion(carGroup.quaternion).add(carGroup.position);
  camPos.lerp(behind, 0.08);
  camera.position.copy(camPos);
  camera.lookAt(carGroup.position.x, carGroup.position.y + 0.8, carGroup.position.z);
  renderer.render(scene, camera);
  const gear = out.gear === 0 ? 'R' : out.gear === 1 ? 'N' : String(out.gear - 1);
  hud.innerHTML = `<b>${Math.round(Math.abs(out.speed) * 3.6)}</b> km/h &nbsp; gear ${gear} &nbsp; ${Math.round(out.rpm)} rpm` +
    `${out.abs ? ' &nbsp; ABS' : ''}${out.tc ? ' &nbsp; TC' : ''}`;
  requestAnimationFrame(frame);
}
physicsStep(readInput());
requestAnimationFrame(frame);
window.__ogp = { body, car, get out() { return out; }, keys };   // handy in the console

// ---- helpers ----------------------------------------------------------------------------------------------------
// route/1 is in the core frame (Z up); three (x, y, z) = core (x, z, -y)
function routeStart(r) {
  const s = r.samples[0];
  return { x: s.x, z: -s.y, yaw: Math.atan2(Math.cos(s.heading), -Math.sin(s.heading)) };
}
function yawQuat(yaw) { return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }; }
function roadMesh(r) {
  const pos = [], idx = [];
  r.samples.forEach((s, i) => {
    const lx = -Math.sin(s.heading), lz = -Math.cos(s.heading);   // left of the heading, three axes
    pos.push(s.x + lx * s.width_left, 0.01, -s.y + lz * s.width_left, s.x - lx * s.width_right, 0.01, -s.y - lz * s.width_right);
    const n = r.samples.length, a = 2 * i, b = 2 * ((i + 1) % n);
    if (r.closed || i < n - 1) idx.push(a, b, a + 1, a + 1, b, b + 1);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x3a3d42, side: THREE.DoubleSide }));
}
