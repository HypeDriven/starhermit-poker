// The cinematic sci-fi casino behind the main menu, as the browser build's
// src/menu3d.js drew it with three.js r166: the hall modelled in Blender
// (assets/casino.glb: a domed neon casino with a poker-table centrepiece; its
// own lights dropped, its 8–14 emission strengths pulled into a cinematic
// range with the true neons pulsing), plus what Blender cannot export — the
// nebula sky, the volumetric light beam from the oculus, two holographic rings
// over the felt, the dust and a cloud of holographic cards drifting in zero
// gravity around the table (src/menu3d-physics.js) — while the camera flies in
// from the entrance, past the decorations, down into a slow orbit of the table
// (with a little pointer parallax on mouse devices). Any press or key skips the
// flight. The GLSL ShaderMaterials are WGSL here (three's vUv.y is 1 − uv.y);
// the point-sprite dust is camera-facing instanced quads sized in pixels as
// gl_PointSize sized them. Lights as written (r166 physical units). The old
// NaN-scrubbing pass before the bloom guarded drivers' GLSL; the WGSL here
// squares by hand and guards its divides instead.
import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BackSide, CatmullRomCurve3, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  GLTFLoader, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, PerspectiveCamera, PlaneGeometry, PointLight,
  SRGBColorSpace, ShaderMaterial, SphereGeometry, TextureLoader, Vector3, Vector4, renderer, scene,
  type Material, type Object3D,
} from "starhermit:scene";
import { clamp01, easeInOutCubic, makeDriftState, mulberry32, stepDrift } from "../src/menu3d-physics.js";
import { DUST_MAX, particleCounts, type Look } from "./quality.ts";
import { GRADE } from "./table3d.ts";

const FLY_SECONDS = 17;
const CARD_COUNT = 28;
const PI = Math.PI;

export const root = new Group();
root.visible = false;
scene.add(root);
const camera = new PerspectiveCamera(55, 1, 0.5, 240);
camera.position.set(0, 5.5, 30);

// -- lighting -----------------------------------------------------------------------------------
{
  root.add(new AmbientLight(0x334466, 2.2));
  root.add(new HemisphereLight(0x445588, 0x1a0f22, 1.2));
  const key = new PointLight(0x66ccff, 900, 60, 2);
  key.position.set(0, 11, 0);
  const warm = new PointLight(0xff8844, 500, 45, 2);
  warm.position.set(14, 8, -10);
  const cool = new PointLight(0x8844ff, 500, 45, 2);
  cool.position.set(-14, 8, 10);
  const felt = new PointLight(0x33ffaa, 110, 18, 2);
  felt.position.set(0, 5, 0);
  root.add(key, warm, cool, felt);
}

// -- the nebula sky -------------------------------------------------------------------------------
const NEBULA = /* wgsl */ `
fn hash3(q: vec3f) -> f32 {
  var p = fract(q * 0.3183099 + vec3f(0.1, 0.1, 0.1));
  p = p * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
fn noise3(x: vec3f) -> f32 {
  let i = floor(x);
  var f = fract(x);
  f = f * f * (vec3f(3.0, 3.0, 3.0) - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3f(1.0, 0.0, 0.0)), f.x),
        mix(hash3(i + vec3f(0.0, 1.0, 0.0)), hash3(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash3(i + vec3f(0.0, 0.0, 1.0)), hash3(i + vec3f(1.0, 0.0, 1.0)), f.x),
        mix(hash3(i + vec3f(0.0, 1.0, 1.0)), hash3(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
fn fbm(q: vec3f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var p = q;
  for (var i = 0; i < 5; i++) { v = v + a * noise3(p); p = p * 2.03; a = a * 0.55; }
  return v;
}
fn fragment(f: Fragment) -> vec4f {
  let t = uniforms.uTime;
  let d = normalize(f.world);
  let n = fbm(d * 3.0 + vec3f(t * 0.010, 0.0, t * 0.006));
  let n2 = fbm(d * 7.0 - vec3f(0.0, t * 0.008, 0.0));
  var col = mix(vec3f(0.004, 0.006, 0.020), vec3f(0.050, 0.020, 0.120), smoothstep(0.35, 0.8, n));
  col = col + vec3f(0.00, 0.10, 0.16) * smoothstep(0.55, 0.90, n2) * 0.8;
  col = col + vec3f(0.14, 0.03, 0.12) * smoothstep(0.60, 0.95, fbm(d * 5.0 + vec3f(10.0, 10.0, 10.0))) * 0.9;
  let s = hash3(floor(d * 200.0));
  let tw = 0.6 + 0.4 * sin(t * 2.0 + s * 90.0);
  col = col + vec3f(tw, tw, tw) * smoothstep(0.9975, 1.0, s) * 1.6 * step(0.9975, s);
  return vec4f(col, 1.0);
}`;
const skyMat = new ShaderMaterial({ uniforms: { uTime: { value: 0 } }, fragmentShader: NEBULA, side: BackSide, depthWrite: false });
const sky = new Mesh(new SphereGeometry(180, 48, 32), skyMat);
sky.noAO = true;
sky.frustumCulled = false;
root.add(sky);

// -- the light shaft from the dome's oculus ---------------------------------------------------------
const BEAM = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let v = 1.0 - f.uv.y;
  let fade = pow(max(v, 0.0), 1.6);
  let streak = 0.85 + 0.15 * sin(f.uv.x * 40.0 + uniforms.uTime * 0.7);
  let pulse = 0.9 + 0.1 * sin(uniforms.uTime * 0.9);
  return vec4f(uniforms.uColor, fade * streak * pulse * 0.16);
}`;
const beamMat = new ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColor: { value: new Color(0x9fd8ff) } }, fragmentShader: BEAM,
  transparent: true, blending: AdditiveBlending, side: DoubleSide, depthWrite: false,
});
const beam = new Mesh(new ConeGeometry(3.6, 22, 48, 1, true), beamMat);
beam.position.set(0, 14.5, 0);
beam.noAO = true;
root.add(beam);

// -- holographic rings over the felt -------------------------------------------------------------------
const HOLO = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let v = 1.0 - f.uv.y;
  let band = smoothstep(0.0, 0.12, v) * (1.0 - smoothstep(0.88, 1.0, v));
  let scan = 0.5 + 0.5 * sin(v * 70.0 - uniforms.uTime * 5.0);
  let ticks = step(0.72, fract(f.uv.x * 36.0 + uniforms.uTime * 0.06));
  let a = band * (0.06 + scan * 0.10 + ticks * 0.10);
  return vec4f(uniforms.uColor, a);
}`;
const bands: { mesh: Mesh; mat: ShaderMaterial; speed: number }[] = [];
for (const [radius, y, h, color, speed] of [[3.1, 4.6, 0.9, 0x33ddff, 0.12], [2.6, 5.6, 0.55, 0xff44aa, -0.18]] as const) {
  const mat = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new Color(color) } }, fragmentShader: HOLO,
    transparent: true, blending: AdditiveBlending, side: DoubleSide, depthWrite: false,
  });
  const mesh = new Mesh(new CylinderGeometry(radius, radius, h, 64, 1, true), mat);
  mesh.position.y = y;
  mesh.noAO = true;
  root.add(mesh);
  bands.push({ mesh, mat, speed });
}

// -- dust ---------------------------------------------------------------------------------------------
const DUST_VERT = /* wgsl */ `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  let seed = v.instance.x;
  let t = uniforms.uTime;
  var c = (model_matrix() * vec4f(0.0, 0.0, 0.0, 1.0)).xyz;
  c.y = c.y + sin(t * 0.20 + seed * 20.0) * 0.8;
  c.x = c.x + sin(t * 0.13 + seed * 31.0) * 0.6;
  c.z = c.z + cos(t * 0.17 + seed * 27.0) * 0.6;
  let clip = view_projection() * vec4f(c, 1.0);
  // A guarded divide and a capped sprite: the camera flies through the cloud.
  let px = clamp((60.0 * (0.4 + 0.6 * fract(seed * 7.0))) / max(clip.w, 0.5), 1.0, 96.0);
  let vp = viewport_size();
  o.clip = vec4f(clip.x + v.position.x * px * 2.0 / vp.x * clip.w, clip.y + v.position.y * px * 2.0 / vp.y * clip.w, clip.z, clip.w);
  o.v0 = vec4f(v.position.x + 0.5, v.position.y + 0.5, seed, 0.0);
  return o;
}`;
const DUST_FRAG = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let seed = f.v0.z;
  let d = length(f.v0.xy - vec2f(0.5, 0.5));
  let a = 1.0 - smoothstep(0.0, 0.5, d);
  let tw = 0.35 + 0.65 * (0.5 + 0.5 * sin(uniforms.uTime * (0.6 + seed) + seed * 40.0));
  let col = mix(vec3f(0.5, 0.8, 1.0), vec3f(1.0, 0.6, 0.9), fract(seed * 3.0));
  return vec4f(col, a * tw * 0.55);
}`;
const dustMat = new ShaderMaterial({
  uniforms: { uTime: { value: 0 } }, vertexShader: DUST_VERT, fragmentShader: DUST_FRAG,
  transparent: true, blending: AdditiveBlending, depthWrite: false,
});
const dust = new InstancedMesh(new PlaneGeometry(1, 1), dustMat, DUST_MAX);
dust.customSlots = 1;
dust.frustumCulled = false;
dust.noAO = true;
{
  const rand = mulberry32(42) as () => number;
  const m = new Matrix4();
  for (let i = 0; i < DUST_MAX; i++) {
    const a = rand() * PI * 2;
    const r = 4 + rand() * 20;
    const x = Math.cos(a) * r, y = rand() * 16, z = Math.sin(a) * r;
    m.makeTranslation(x, y, z);
    dust.setMatrixAt(i, m);
    dust.setCustomAt(i, new Vector4(rand(), 0, 0, 0));
  }
}
root.add(dust);

// -- the zero-g card cloud ------------------------------------------------------------------------------
const CARD = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  // Sampled before any branching (uniform control flow).
  let tex = textureSample(uMap, uMap_sampler, uniforms.uRegion.xy + f.uv * uniforms.uRegion.zw);
  let g = abs(fract(f.uv * vec2f(5.0, 7.0)) - vec2f(0.5, 0.5));
  let line = smoothstep(0.44, 0.5, max(g.x, g.y));
  let back = vec3f(0.015, 0.04, 0.09) + uniforms.uTint * line * 0.55;
  let face = select(0.0, 1.0, f.front);
  var col = mix(back, tex.rgb, face);
  let alpha = mix(1.0, tex.a, face);
  let ndv = dot(normalize(camera_position() - f.world), normalize(f.normal));
  let k = max(0.0, 1.0 - abs(ndv));
  let fres = k * k;
  let scan = sin(f.world.y * 36.0 - uniforms.uTime * 2.5 + uniforms.uSeed * 17.0) * 0.5 + 0.5;
  let flick = 0.92 + 0.08 * sin(uniforms.uTime * 13.0 + uniforms.uSeed * 40.0);
  col = col * flick + uniforms.uTint * (fres * 1.5 + scan * 0.05);
  return vec4f(col, alpha);
}`;
const HOLO_RANKS = "AKQJT98765432";
const HOLO_SUITS = ["♠", "♥", "♦", "♣"];
const cardTex = new TextureLoader().load("assets/textures/holo-cards.webp", undefined, undefined, (e: unknown) => console.warn(`holo-cards: ${e instanceof Error ? e.message : String(e)}`));
cardTex.colorSpace = SRGBColorSpace;
const cards: { mesh: Mesh; mat: ShaderMaterial; state: ReturnType<typeof makeDriftState> }[] = [];
{
  const rand = mulberry32(1337) as () => number;
  const geo = new PlaneGeometry(0.72, 1.0);
  for (let i = 0; i < CARD_COUNT; i++) {
    const r = Math.floor(rand() * HOLO_RANKS.length);
    const s = Math.floor(rand() * HOLO_SUITS.length);
    const mat = new ShaderMaterial({
      uniforms: {
        uMap: { value: cardTex },
        uRegion: { value: new Vector4(r / 13, s / 4, 1 / 13, 1 / 4) },
        uTint: { value: new Color(i % 3 === 0 ? 0xff66bb : 0x55ddff) },
        uTime: { value: 0 },
        uSeed: { value: rand() },
      },
      fragmentShader: CARD, transparent: true, depthWrite: false, side: DoubleSide,
    });
    const mesh = new Mesh(geo, mat);
    const state = makeDriftState(rand);
    mesh.position.set(state.pos[0], state.pos[1], state.pos[2]);
    mesh.rotation.set(rand() * PI, rand() * PI, rand() * PI);
    mesh.noAO = true;
    root.add(mesh);
    cards.push({ mesh, mat, state });
  }
}

// -- the casino --------------------------------------------------------------------------------------------
interface Bob { obj: Object3D; baseY: number; phase: number }
const chips: Bob[] = [];
const crystals: Bob[] = [];
let star: Object3D | null = null;
const neons: { mat: Material & { emissiveIntensity: number }; base: number; phase: number }[] = [];
let casinoLoaded = false;
/** Loads the hall once (on the first menu): a missing model leaves the sky and cards — still a menu. */
function loadCasino(): void {
  if (casinoLoaded) return;
  casinoLoaded = true;
  let phaseSeed = 0;
  const phase = (): number => ((phaseSeed = (phaseSeed * 16807 + 12345) % 2147483647) / 2147483647) * PI * 2;
  new GLTFLoader().load("assets/casino.glb", (gltf) => {
    const hall = gltf.scene;
    const remove: Object3D[] = [];
    const tuned = new Set<Material>();
    hall.traverse((o) => {
      const node = o as Object3D & { isLight?: boolean; isMesh?: boolean; material?: Material | Material[] };
      if (node.isLight) { remove.push(o); return; }
      if (!node.isMesh || !node.material || Array.isArray(node.material)) return;
      const name = o.name || "";
      // Base surfaces that carry nearly coplanar glow rings: pushed back in depth (on a clone: the material is shared).
      if (/^(FloorMain|Dais|Balcony|TableFelt|TableRail)$/.test(name)) {
        const m = node.material.clone();
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 2;
        node.material = m;
      }
      const m = node.material as Material & { emissive?: Color; emissiveIntensity?: number };
      // Blender exports emission strengths of 8–14: pulled into a cinematic range once per material; true neons pulse.
      if (m.emissive && !tuned.has(m) && m.emissive.r + m.emissive.g + m.emissive.b > 0.01) {
        tuned.add(m);
        m.emissiveIntensity = (m.emissiveIntensity ?? 1) * 0.3;
        neons.push({ mat: m as Material & { emissiveIntensity: number }, base: m.emissiveIntensity, phase: phase() });
      }
      if (name.startsWith("FloatChip_")) chips.push({ obj: o, baseY: o.position.y, phase: phase() * 7 / (PI * 2) });
      if (name.startsWith("SuitCrystal_")) crystals.push({ obj: o, baseY: o.position.y, phase: phase() * 7 / (PI * 2) });
      if (name === "ChandelierStar") star = o;
    });
    for (const o of remove) o.parent?.remove(o);
    root.add(hall);
  }, undefined, (e) => console.warn(`casino.glb: ${e.message}`));
}

// -- the flight and the orbit ------------------------------------------------------------------------------
const flyPath = new CatmullRomCurve3([
  new Vector3(0, 4.8, 21.5), new Vector3(0, 4.9, 16.5), new Vector3(-7.5, 6.2, 12.5), new Vector3(-12.5, 7.6, 0.0),
  new Vector3(-8.0, 6.0, -10.5), new Vector3(2.0, 4.6, -11.5), new Vector3(8.5, 3.6, -5.0), new Vector3(7.0, 3.1, 3.5),
], false, "centripetal");
const flyTargets = new CatmullRomCurve3([
  new Vector3(0, 6.5, 0), new Vector3(0, 6.5, 0), new Vector3(0, 7.5, 0), new Vector3(0, 9.0, 0),
  new Vector3(0, 6.0, 0), new Vector3(0, 3.5, 0), new Vector3(0, 2.6, 0), new Vector3(0, 2.4, 0),
], false, "centripetal");
const idleCenter = new Vector3(0, 2.55, 0);
const IDLE_RADIUS = 7.2, IDLE_HEIGHT = 3.4;
let flyT = 0;
let idleAngle = PI * 0.15;
let time = 0;
let reducedMotion = false;
let animatedBg = true;
let parallax = true;
const pointer = { x: 0, y: 0 };

/** Any press or key skips the flight (menu3d.js onSkip). */
export function skip(): void { flyT = 1; }
/** Whether the camera is still flying in (the menu's skip hint shows meanwhile). */
export function flying(): boolean { return flyT < 1; }
/** The pointer for the parallax, −1…1 across the window (mouse devices only). */
export function setPointer(x: number, y: number, mouse: boolean): void {
  parallax = mouse;
  pointer.x = mouse ? x : 0;
  pointer.y = mouse ? y : 0;
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (on) flyT = 1;
}

let look: Look | null = null;
export function applyLook(next: Look): void {
  look = next;
  animatedBg = next.animated && !reducedMotion;
  dust.count = particleCounts(next).dust;
  const high = next.particles === "high";
  cards.forEach((c, i) => { c.mesh.visible = high || i % 2 === 0; });
  if (active) applyRenderer();
}
function applyRenderer(): void {
  const l = look!;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.ao = null;
  renderer.shadowMap.enabled = false;
  renderer.bloom = l.bloom ? { strength: 0.45, radius: 0.4, threshold: 0.85, resolution: l.budget.bloomRes } : null;
  renderer.grade = l.grade ? GRADE : null;
  renderer.antialias = l.antialias;
}

let active = false;
let size = "";
/** Shows the casino behind the menu (the table hides); a new menu replays the flight. */
export function setActive(on: boolean): void {
  if (on && !active) {
    flyT = reducedMotion ? 1 : 0;
    idleAngle = PI * 0.15;
    size = "";
  }
  active = on;
  root.visible = on;
  if (!on) return;
  loadCasino();
  renderer.camera = camera;
  scene.fog = null;
  scene.background = new Color(0x05070d);
  scene.environment = null;
  if (look) applyRenderer();
}
export function isActive(): boolean { return active; }

/** Each frame: the drift, the set dressing, the neons and the camera. */
export function frameUpdate(dtIn: number, winW: number, winH: number): void {
  if (!active) return;
  const dt = Math.min(dtIn, 0.05);
  time += dt;
  const t = time;
  const k = `${winW}x${winH}`;
  if (k !== size && winW > 0 && winH > 0) {
    size = k;
    camera.aspect = winW / winH;
    camera.updateProjectionMatrix();
  }
  // Static (or reduced motion) freezes the nebula, the beam and the rings; the cards and set dressing keep drifting.
  const bg = animatedBg ? t : 0;
  skyMat.uniforms.uTime!.value = bg;
  beamMat.uniforms.uTime!.value = bg;
  for (const b of bands) {
    b.mat.uniforms.uTime!.value = bg;
    if (animatedBg) b.mesh.rotation.y += dt * b.speed;
  }
  dustMat.uniforms.uTime!.value = t;
  const axis = new Vector3();
  for (const c of cards) {
    const s = stepDrift(c.state, dt, t);
    c.mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
    c.mesh.rotateOnAxis(axis.set(s.axis[0], s.axis[1], s.axis[2]), s.spin * dt);
    c.mat.uniforms.uTime!.value = t;
  }
  for (const c of chips) {
    c.obj.position.y = c.baseY + Math.sin(t * 0.5 + c.phase) * 0.45;
    c.obj.rotation.y += dt * 0.25;
    c.obj.rotation.x += dt * 0.06;
  }
  for (const c of crystals) {
    c.obj.position.y = c.baseY + Math.sin(t * 0.7 + c.phase) * 0.25;
    c.obj.rotation.y += dt * 0.5;
  }
  if (star) {
    const p = 0.55 + Math.sin(t * 1.6) * 0.05;
    (star as Object3D).scale.set(p, p, p);
    (star as Object3D).rotation.y += dt * 0.4;
  }
  for (const n of neons) n.mat.emissiveIntensity = n.base * (0.82 + 0.18 * Math.sin(t * 1.3 + n.phase));
  // The camera: the flight, then a slow orbit of the table.
  if (flyT < 1) {
    flyT = clamp01(flyT + dt / FLY_SECONDS);
    const e = easeInOutCubic(flyT);
    camera.position.copy(flyPath.getPoint(e));
    camera.lookAt(flyTargets.getPoint(e));
    idleAngle = Math.atan2(camera.position.z, camera.position.x);
    return;
  }
  idleAngle += dt * 0.07;
  const px = Math.cos(idleAngle) * IDLE_RADIUS + (parallax ? pointer.x * 0.5 : 0);
  const pz = Math.sin(idleAngle) * IDLE_RADIUS;
  const py = IDLE_HEIGHT - (parallax ? pointer.y * 0.35 : 0) + Math.sin(t * 0.3) * 0.18;
  camera.position.lerp(new Vector3(px, py, pz), Math.min(1, dt * 2.5));
  camera.lookAt(idleCenter);
}
