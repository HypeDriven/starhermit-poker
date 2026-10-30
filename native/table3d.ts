// The poker table on starhermit:scene, as the browser build's src/table3d.js
// drew it with three.js r166: the backdrop gradient and fog, the hemisphere
// fill, the warm key spotlight (its shadow fitted to the table) with blue rim
// and warm side lights, the floor, pedestal and lacquered base, the rail
// (padded leather on Detailed), the felt (printed woven baize on Detailed),
// the gold trims, the STARHERMIT print, the cards (rounded lacquered stock
// with unlit printed faces on Detailed) flying in from the deck, the chip
// stacks (striped clay chips on Detailed), the pulsing acting-seat ring, the
// stars, the dust motes in the key light and the spill-light pool — seen
// through the stage rectangle the HUD leaves (setViewOffset, the old canvas
// sitting between the page's chrome). The renderer receives only the server's
// addressed projection; visibleCardsForSeat keeps an opponent's live cards
// backs whatever arrives.
//
// From three.js r166 (physical lights): punctual and hemisphere intensities as
// written (engine minor 23+ follows r155+ light units); environments, emissive and backgrounds as
// written. The post chain (GTAO, UnrealBloom on linear HDR light, OutputPass
// with ACES 1.05, the grade, SMAA / FXAA / MSAA) is the runtime's renderer.ao /
// bloom / grade / antialias. The procedural canvases are baked images
// (tools/bake-textures.mjs): every card shows its face through its own UVs into
// one atlas, every chip colour through its own UVs into the chip sheets. The
// motes' GLSL point sprites are camera-facing instanced quads sized in pixels
// by a WGSL vertex hook, as gl_PointSize sized them.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferGeometry, CircleGeometry, CylinderGeometry, ExtrudeGeometry,
  Float32BufferAttribute, FogExp2, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Path, PerspectiveCamera, PlaneGeometry, PMREMGenerator,
  PointLight, Points, PointsMaterial, RepeatWrapping, RoomEnvironment, SRGBColorSpace, ShaderMaterial, Shape, SpotLight,
  TextureLoader, TorusGeometry, Vector3, Vector4, renderer, scene,
  type Material, type Object3D, type Texture,
} from "starhermit:scene";
import type { PublicState, You } from "./classic.ts";
import { seatUnit, seatVisual, visibleCardsForSeat } from "../src/table-utils.js";
import { MOTE_MAX, STAR_MAX, particleCounts, type Look } from "./quality.ts";

const TABLE_RX = 4.35;
const TABLE_RZ = 2.72;
const SEAT_RX = 3.62;
const SEAT_RZ = 2.34;
/** World-space point the dealt and flopped cards fly in from (front of the felt). */
const DECK_POS = new Vector3(1.7, 0.62, -1.05);
const PI = Math.PI;

// -- the table's own group in the one scene (the menu's casino is another) -------------------------
export const root = new Group();
root.visible = false;
scene.add(root);
const camera = new PerspectiveCamera(39, 1, 0.1, 80);
camera.position.set(0, 6.65, 7.15);
camera.lookAt(0, 0.05, 0.35);

const loader = new TextureLoader();
const textures = new Map<string, Texture>();
function image(path: string, srgb = true): Texture {
  let t = textures.get(path);
  if (!t) {
    t = loader.load(`assets/textures/${path}`, undefined, undefined, (e: unknown) => console.warn(`${path}: ${e instanceof Error ? e.message : String(e)}`));
    if (srgb) t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    textures.set(path, t);
  }
  return t;
}
const backdrop = image("backdrop.webp");

// -- lights -------------------------------------------------------------------------------------
const hemi = new HemisphereLight(0xb9d9ff, 0x160c08, 1.35);
const KEY = 42;
const key = new SpotLight(0xfff0d3, KEY, 25, PI / 4.2, 0.7, 1.2);
key.position.set(-3.5, 8, 4.5);
key.target.position.set(0, 0, 0);
// The shadow fitted to the table: the light sits ~10 units from the felt.
key.shadow.camera.near = 5;
key.shadow.camera.far = 16;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.015;
key.shadow.focus = 0.9;
const rim = new PointLight(0x3d7dff, 22, 14, 2);
rim.position.set(4.5, 2.5, -4);
const warm = new PointLight(0xff9e53, 12, 10, 2);
warm.position.set(-5, 1.5, 1);
root.add(hemi, key, key.target, rim, warm);

// -- the room: floor pool, stars, motes ------------------------------------------------------------
const floorPool = new Mesh(new PlaneGeometry(13, 10), new MeshBasicMaterial({
  map: image("pool.png"), transparent: true, depthWrite: false, blending: AdditiveBlending,
}));
floorPool.rotation.x = -PI / 2;
floorPool.position.y = -0.636;
floorPool.noAO = true;
root.add(floorPool);

const starGeo = new BufferGeometry();
{
  const pts: number[] = [];
  // Golden-angle spiral: every prefix of the draw range (the preset's star budget) is an even subset.
  for (let i = 0; i < STAR_MAX; i++) {
    const angle = i * 2.39996;
    const radius = 7 + (i % 29) * 0.22;
    pts.push(Math.cos(angle) * radius, 2 + (i % 17) * 0.34, Math.sin(angle) * radius - 3);
  }
  starGeo.setAttribute("position", new Float32BufferAttribute(pts, 3));
}
const starMat = new PointsMaterial({ color: 0x729bd3, size: 0.035, transparent: true, opacity: 0.45 });
const stars = new Points(starGeo, starMat);
root.add(stars);

// Dust motes drifting through the key light's cone: table3d.js MOTE_VERT / MOTE_FRAG as an instanced quad.
const MOTE_VERT = /* wgsl */ `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  let seed = v.instance.x;
  let t = uniforms.uTime;
  var c = (model_matrix() * vec4f(0.0, 0.0, 0.0, 1.0)).xyz;
  c.y = c.y + sin(t * 0.23 + seed * 30.0) * 0.35;
  c.x = c.x + sin(t * 0.11 + seed * 17.0) * 0.25;
  c.z = c.z + cos(t * 0.13 + seed * 23.0) * 0.25;
  let clip = view_projection() * vec4f(c, 1.0);
  let px = clamp(14.0 * (0.5 + seed) / max(clip.w, 0.5), 1.0, 24.0);
  let vp = viewport_size();
  o.clip = vec4f(clip.x + v.position.x * px * 2.0 / vp.x * clip.w, clip.y + v.position.y * px * 2.0 / vp.y * clip.w, clip.z, clip.w);
  o.v0 = vec4f(v.position.x + 0.5, v.position.y + 0.5, seed, 0.0);
  return o;
}`;
const MOTE_FRAG = /* wgsl */ `
fn fragment(f: Fragment) -> vec4f {
  let d = length(f.v0.xy - vec2f(0.5, 0.5));
  let a = 1.0 - smoothstep(0.0, 0.5, d);
  let seed = f.v0.z;
  let tw = 0.5 + 0.5 * sin(uniforms.uTime * (0.7 + seed) + seed * 50.0);
  return vec4f(1.0, 0.86, 0.62, a * tw * 0.35);
}`;
const moteMat = new ShaderMaterial({
  uniforms: { uTime: { value: 0 } }, vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
  transparent: true, depthWrite: false, blending: AdditiveBlending,
});
const motes = new InstancedMesh(new PlaneGeometry(1, 1), moteMat, MOTE_MAX);
motes.customSlots = 1;
motes.frustumCulled = false;
motes.noAO = true;
{
  let r = 7;
  const rand = (): number => ((r = (r * 16807) % 2147483647) / 2147483647);
  const m = new Matrix4();
  for (let i = 0; i < MOTE_MAX; i++) {
    const ang = rand() * PI * 2;
    const rad = Math.sqrt(rand()) * 3.6;
    m.makeTranslation(Math.cos(ang) * rad * 1.2, 0.7 + rand() * 4.2, Math.sin(ang) * rad * 0.8);
    motes.setMatrixAt(i, m);
    motes.setCustomAt(i, new Vector4(rand(), 0, 0, 0));
  }
}
motes.visible = false;
root.add(motes);

// The STARHERMIT print on the felt (its own pieces; surfaces are rebuilt per budget).
const logo = new Mesh(new PlaneGeometry(2.7, 0.67), new MeshBasicMaterial({
  map: image("label.png"), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
}));
logo.rotation.x = -PI / 2;
logo.position.set(0, 0.281, -0.72);
root.add(logo);

// -- dynamic groups ----------------------------------------------------------------------------------
const boardGroup = new Group();
boardGroup.position.y = 0.37;
const potGroup = new Group();
potGroup.position.y = 0.36;
const seatGroups: Group[] = [];
for (let v = 0; v < 6; v++) {
  const g = new Group();
  const { x, y } = seatUnit(v);
  g.position.set(x * SEAT_RX, 0.37, y * SEAT_RZ);
  seatGroups.push(g);
}
root.add(boardGroup, potGroup, ...seatGroups);
const ringMat = new MeshBasicMaterial({ color: 0xffd66d, transparent: true, opacity: 0 });
const actingRing = new Mesh(new TorusGeometry(0.48, 0.025, 10, 64), ringMat);
actingRing.rotation.x = PI / 2;
actingRing.noAO = true;
actingRing.visible = false;
root.add(actingRing);

// -- geometry helpers ------------------------------------------------------------------------------
function ellipseShape(rx: number, ry: number): Shape {
  const shape = new Shape();
  shape.absellipse(0, 0, rx, ry, 0, PI * 2, false, 0);
  return shape;
}
function ellipseRing(ox: number, oy: number, ix: number, iy: number): Shape {
  const shape = ellipseShape(ox, oy);
  const hole = new Path();
  hole.absellipse(0, 0, ix, iy, 0, PI * 2, true, 0);
  shape.holes.push(hole);
  return shape;
}
function horizontalExtrusion(shape: Shape, depth: number, bevelSize = 0.04, curveSegments = 96): BufferGeometry {
  const g = new ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelSegments: curveSegments >= 96 ? 3 : 2, bevelSize, bevelThickness: bevelSize, curveSegments,
  });
  g.center();
  g.rotateX(PI / 2);
  return g;
}
function roundedCardGeometry(): BufferGeometry {
  const w = 0.59, h = 0.82, r = 0.055;
  const s = new Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const g = new ExtrudeGeometry(s, { depth: 0.026, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 6 });
  g.center();
  g.rotateX(PI / 2);
  return g;
}

// -- the look ----------------------------------------------------------------------------------------
let look: Look | null = null;
let detailed = false;
let animated = false;
let reducedMotion = false;
let envTex: Texture | null = null;
/** Shared per-look resources (materials, geometries), dropped on a budget change. */
const shared = new Map<string, Material | BufferGeometry>();
function res<T extends Material | BufferGeometry>(k: string, make: () => T): T {
  let r = shared.get(k) as T | undefined;
  if (!r) { r = make(); shared.set(k, r); }
  return r;
}
interface LitParams {
  color?: number; map?: Texture | null; roughness?: number; metalness?: number; bumpMap?: Texture | null; bumpScale?: number;
  clearcoat?: number; clearcoatRoughness?: number;
}
/** The preset's shading: Physical on High/Ultra, Standard (no clearcoat) on Balanced, Lambert (colour and maps kept) on Low. */
function lit(p: LitParams): Material {
  const tier = look!.budget.material;
  if (tier === "physical") return new MeshPhysicalMaterial(p);
  const { clearcoat: _c, clearcoatRoughness: _cr, ...std } = p;
  if (tier === "standard") return new MeshStandardMaterial(std);
  const { roughness: _r, metalness: _m, ...lam } = std;
  return new MeshLambertMaterial(lam);
}

let surfaces: Mesh[] = [];
let feltPlain: Material | null = null, feltDetailed: Material | null = null;
let railPlain: Material | null = null, railDetailed: Material | null = null;
let felt: Mesh | null = null, rail: Mesh | null = null;
let budgetKey = "";
/** Floor, pedestal, base, rail, felt and trims for the budget (shading, curve segments, felt texture size). */
function buildSurfaces(): void {
  const b = look!.budget;
  for (const m of surfaces) { root.remove(m); m.geometry.dispose(); }
  surfaces = [];
  const add = (m: Mesh): Mesh => { surfaces.push(m); root.add(m); return m; };
  const seg = b.curve;
  const floor = add(new Mesh(new CircleGeometry(12, seg), lit({ color: 0x080b12, roughness: 0.88, metalness: 0.12 })));
  floor.rotation.x = -PI / 2;
  floor.position.y = -0.64;
  floor.receiveShadow = true;
  const pedestal = add(new Mesh(new CylinderGeometry(1.5, 2.05, 0.78, Math.round(seg * 2 / 3)), lit({ color: 0x11141b, roughness: 0.22, metalness: 0.74 })));
  pedestal.position.y = -0.38;
  pedestal.castShadow = true;
  const base = add(new Mesh(horizontalExtrusion(ellipseShape(TABLE_RX, TABLE_RZ), 0.34, 0.08, seg),
    lit({ color: 0x171217, roughness: 0.22, metalness: 0.5, clearcoat: 0.65 })));
  base.position.y = -0.05;
  base.castShadow = base.receiveShadow = true;

  railPlain = lit({ color: 0x381a16, roughness: 0.28, metalness: 0.12, clearcoat: 0.85, clearcoatRoughness: 0.18 });
  // Detailed: padded leather — grain bump and lacquer clearcoat (sheen is not drawn by the engine).
  const grain = image("grain.png", false);
  grain.wrapS = grain.wrapT = RepeatWrapping;
  grain.repeat.set(2.5, 2.5);
  railDetailed = lit({ color: 0x3f1c17, roughness: 0.46, metalness: 0.05, bumpMap: grain, bumpScale: 1.2, clearcoat: 0.55, clearcoatRoughness: 0.3 });
  rail = add(new Mesh(horizontalExtrusion(ellipseRing(TABLE_RX, TABLE_RZ, 3.82, 2.19), 0.25, 0.07, seg), detailed ? railDetailed : railPlain));
  rail.position.y = 0.22;
  rail.castShadow = rail.receiveShadow = true;

  feltPlain = lit({ color: 0x07543e, roughness: 0.92, metalness: 0.02 });
  // Detailed: woven baize — fibres, a soft centre lift and a printed gold betting line; shape UVs span the ellipse in world units.
  const feltTex = image(`felt-${b.felt}.webp`);
  feltTex.repeat.set(1 / 7.72, 1 / 4.46);
  feltTex.offset.set(0.5, 0.5);
  const bump = image(`felt-bump-${b.felt / 2}.webp`, false);
  bump.wrapS = bump.wrapT = RepeatWrapping;
  bump.repeat.set(1.6, 1.6);
  feltDetailed = lit({ color: 0xffffff, map: feltTex, roughness: 0.95, metalness: 0, bumpMap: bump, bumpScale: 0.6 });
  felt = add(new Mesh(horizontalExtrusion(ellipseShape(3.84, 2.21), 0.09, 0.015, seg), detailed ? feltDetailed : feltPlain));
  felt.position.y = 0.22;
  felt.receiveShadow = true;

  for (const [o, i, color, y] of [
    [[3.88, 2.25], [3.81, 2.18], 0xc69b42, 0.305],
    [[3.48, 1.88], [3.465, 1.865], 0x93a87b, 0.314],
  ] as [[number, number], [number, number], number, number][]) {
    const trim = add(new Mesh(horizontalExtrusion(ellipseRing(o[0], o[1], i[0], i[1]), 0.018, 0.005, seg), lit({ color, metalness: 0.72, roughness: 0.28 })));
    trim.position.y = y;
  }
}

function applyEnv(): void {
  if (look!.reflections) {
    if (!envTex) {
      try { const pageRoom = new RoomEnvironment(renderer); pageRoom.position.y = 0; /* the page's three r166 (pre-r183) builds the room at the origin */ envTex = new PMREMGenerator(renderer).fromScene(pageRoom, 0.04).texture; }
      catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }
  if (active) {
    scene.environment = look!.reflections ? envTex : null;
    scene.environmentIntensity = 0.42;
  }
}

/** The renderer's post effects for the table (gfx-pipeline.js: GTAO, bloom, ACES 1.05, the grade, AA). */
function applyRenderer(): void {
  const l = look!;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.ao = l.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.35, distanceExponent: 1.4, thickness: 1, scale: 1, samples: l.ao === "high" ? 16 : 8,
    resolution: l.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: l.ao === "high" ? 6 : 4, rings: 2, samples: l.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // UnrealBloomPass(0.6, 0.5, 1.5) on the linear HDR light before OutputPass, as the runtime blooms.
  // three r166 page: the engine's r160 bloom model at the page's strength (engine.minor 30).
  renderer.bloom = l.bloom ? { model: "r160", strength: 0.6, radius: 0.5, threshold: 1.5, resolution: l.budget.bloomRes } : null;
  renderer.grade = l.grade ? GRADE : null;
  renderer.antialias = l.antialias;
  renderer.shadowMap.enabled = l.shadows > 0;
  key.castShadow = l.shadows > 0;
  if (l.shadows > 0) key.shadow.mapSize = l.shadows;
}
/** gfx-pipeline.js GradeShader (after OutputPass, display colours): 0.22 smoothstep S-curve, saturation 1.1, cool shadows / warm highlights, the s * 0.975 + 0.012 lift, vignette 0.28. */
export const GRADE = {
  space: "display" as const, contrastCurve: "s" as const, contrast: 0.22, levels: [0.975, 0.012] as [number, number], saturation: 1.1, split: [0.15, 0.85] as [number, number],
  shadows: [0.95, 0.98, 1.06] as [number, number, number], highlights: [1.05, 1.0, 0.94] as [number, number, number],
  vignette: { amount: 0.28, inner: 0.38, outer: 0.9, scale: [1.1, 1] as [number, number] },
};

export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  detailed = next.detailed;
  animated = next.animated && !reducedMotion;
  const b = next.budget;
  const k = [b.material, b.curve, b.felt, b.card, b.chip, next.detailed].join("|");
  if (k !== budgetKey) {
    budgetKey = k;
    for (const g of [boardGroup, potGroup, ...seatGroups]) clearGroup(g);
    tweens = [];
    for (const r of shared.values()) r.dispose();
    shared.clear();
    dropCardImages(b.card);
    buildSurfaces();
  }
  if (felt && rail) {
    felt.material = detailed ? feltDetailed! : feltPlain!;
    rail.material = detailed ? railDetailed! : railPlain!;
  }
  floorPool.visible = detailed;
  const counts = particleCounts(next);
  motes.visible = counts.motes > 0;
  motes.count = counts.motes;
  starGeo.setDrawRange(0, counts.stars);
  // An HDR colour so only the acting-seat ring blooms (clamped when bloom is off).
  ringMat.color.set(0xffd66d).multiplyScalar(next.bloom ? 4 : 1);
  if (active) { applyRenderer(); applyEnv(); }
  if (last) update(last.pub, last.you, true);
}
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
  if (look) animated = look.animated && !on;
}

// -- cards and chips ---------------------------------------------------------------------------------
/** Card `c`'s printed face (−1: the back) at the preset's card size, loaded the first time the card shows. */
function cardTexture(c: number): Texture {
  return image(`cards/${look!.budget.card}/${c < 0 ? "back" : c}.webp`);
}
/** Drops the card images of another card size (a budget change). */
function dropCardImages(keep: number): void {
  for (const [k, t] of textures) {
    if (k.startsWith("cards/") && !k.startsWith(`cards/${keep}/`)) { t.dispose(); textures.delete(k); }
  }
}
function makeCard(c: number): Group {
  const group = new Group();
  if (detailed) {
    // Rounded, lacquered card stock; the printed face stays unlit so ranks and suits keep full contrast.
    const body = new Mesh(res("cardGeo", roundedCardGeometry), res("cardMat", () => lit({ color: 0xefe9dd, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3 })));
    body.castShadow = body.receiveShadow = true;
    const face = new Mesh(res("faceGeo", () => new PlaneGeometry(0.585, 0.815)),
      res(`faceMat${c}`, () => new MeshBasicMaterial({ map: cardTexture(c), alphaTest: 0.5, toneMapped: false, color: 0xe8e8e8 })));
    face.rotation.x = -PI / 2;
    face.position.y = 0.0175;
    group.add(body, face);
    return group;
  }
  const edge = new Mesh(res("edgeGeo", () => new BoxGeometry(0.59, 0.035, 0.82, 2, 1, 2)), res("edgeMat", () => lit({ color: 0xe7e1d5, roughness: 0.48 })));
  edge.castShadow = edge.receiveShadow = true;
  const face = new Mesh(res("plainFaceGeo", () => new PlaneGeometry(0.565, 0.795)), res(`plainFaceMat${c}`, () => new MeshBasicMaterial({ map: cardTexture(c) })));
  face.rotation.x = -PI / 2;
  face.position.y = 0.019;
  group.add(edge, face);
  return group;
}

const CHIP_COLORS = [0xf0e6d0, 0xc72e45, 0x2458b8, 0x159061, 0x21252e];
/** A chip cylinder for colour `i`: its edge through row i of the stripe sheet, its faces through cell i of the face sheet. */
function chipGeometry(radius: number, i: number): BufferGeometry {
  const g = new CylinderGeometry(radius, radius, 0.042, look!.budget.chip);
  const uv = g.getAttribute("uv")!;
  const idx = g.index!;
  const groupOf = new Int8Array(uv.count).fill(-1);
  for (const gr of g.groups) for (let k = gr.start; k < gr.start + gr.count; k++) groupOf[idx.getX(k)] = gr.materialIndex;
  for (let v = 0; v < uv.count; v++) {
    const u = uv.getX(v), w = uv.getY(v);
    if (groupOf[v] === 0) uv.setXY(v, u, 1 - (i * 8 + 0.5 + (1 - w) * 7) / 40);
    else uv.setXY(v, (i + u) / 5, w);
  }
  uv.needsUpdate = true;
  return g;
}
function makeChipStack(amount: number, compact = false): Group {
  const group = new Group();
  const count = Math.min(compact ? 10 : 14, Math.max(1, Math.ceil(Math.log2(Math.max(2, amount / 25)))));
  const radius = compact ? 0.115 : 0.14;
  for (let i = 0; i < count; i++) {
    const ci = (Math.floor(amount / 100) + i) % CHIP_COLORS.length;
    const color = CHIP_COLORS[ci]!;
    if (detailed) {
      // Clay chips: striped edge, inlaid face, clearcoat; slightly uneven stack.
      const side = res("chipSide", () => lit({ map: image("chip-sides.png"), roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3 }));
      const top = res("chipTop", () => lit({ map: image(`chips-${look!.budget.card / 2}.png`), roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.25 }));
      const chip = new Mesh(res(`chipGeo${radius}:${ci}`, () => chipGeometry(radius, ci)), [side, top, top]);
      chip.position.set(Math.sin(i * 2.7 + amount) * 0.006, 0.022 + i * 0.043, Math.cos(i * 1.9 + amount) * 0.006);
      chip.rotation.y = i * 0.9;
      chip.castShadow = chip.receiveShadow = true;
      group.add(chip);
      continue;
    }
    const chip = new Mesh(res(`plainChipGeo${radius}`, () => new CylinderGeometry(radius, radius, 0.042, look!.budget.chip)),
      res(`plainChip${color}`, () => lit({ color, roughness: 0.3, metalness: 0.12 })));
    chip.position.y = 0.022 + i * 0.045;
    chip.castShadow = true;
    group.add(chip);
    if (i % 2 === 0) {
      const stripe = new Mesh(res(`stripeGeo${radius}`, () => new TorusGeometry(radius * 0.82, 0.009, 5, 24)), res("stripeMat", () => new MeshBasicMaterial({ color: 0xf5e7bf })));
      stripe.rotation.x = PI / 2;
      stripe.position.y = 0.045 + i * 0.045;
      group.add(stripe);
    }
  }
  return group;
}
function clearGroup(g: Group): void {
  for (const child of [...g.children]) g.remove(child);
}

// -- card fly-in animation -------------------------------------------------------------------------
interface Tween { mesh: Object3D; from: Vector3; to: Vector3; fromRotY: number; toRotY: number; toRotX: number; arc: number; start: number; dur: number }
let tweens: Tween[] = [];
let time = 0;
function flyIn(mesh: Object3D, from: Vector3, { delay = 0, spin = PI * 2, arc = 0.35, dur = 0.5 } = {}): void {
  if (reducedMotion) return;
  tweens.push({ mesh, from: from.clone(), to: mesh.position.clone(), fromRotY: mesh.rotation.y + spin, toRotY: mesh.rotation.y, toRotX: mesh.rotation.x, arc, start: time + delay, dur });
  mesh.position.copy(from);
}
function stepTweens(): void {
  if (!tweens.length) return;
  tweens = tweens.filter((tw) => {
    if (!tw.mesh.parent) return false;
    const k = (time - tw.start) / tw.dur;
    if (k < 0) return true;
    if (k >= 1) { tw.mesh.position.copy(tw.to); tw.mesh.rotation.y = tw.toRotY; tw.mesh.rotation.x = tw.toRotX; return false; }
    const e = 1 - Math.pow(1 - k, 3);
    tw.mesh.position.copy(tw.from).lerp(tw.to, e);
    tw.mesh.position.y += Math.sin(PI * e) * tw.arc;
    tw.mesh.rotation.y = tw.fromRotY + (tw.toRotY - tw.fromRotY) * e;
    tw.mesh.rotation.x = tw.toRotX * e;
    return true;
  });
}

// -- the state ---------------------------------------------------------------------------------------
let last: { pub: PublicState; you: You | null } | null = null;
let anim = { handNumber: 0, boardLen: 0 };
/** Full redraw from the public projection and the viewer's own view (table3d.js update). */
export function update(pub: PublicState, you: You | null, redraw = false): void {
  last = { pub, you };
  if (!look) return;
  const handChanged = !redraw && pub.handNumber !== anim.handNumber;
  clearGroup(boardGroup);
  const board = pub.board || [];
  const boardAdded = handChanged || redraw ? 0 : Math.max(0, board.length - anim.boardLen);
  board.forEach((c, i) => {
    const mesh = makeCard(c);
    // Community cards are the table's focus: larger than the hole cards.
    mesh.scale.setScalar(1.28);
    mesh.position.set((i - 2) * 0.8, 0, -0.08);
    mesh.rotation.y = (i - 2) * -0.018;
    if (i >= board.length - boardAdded) {
      boardGroup.updateWorldMatrix(true, false);
      flyIn(mesh, boardGroup.worldToLocal(DECK_POS.clone()), { delay: (i - (board.length - boardAdded)) * 0.14, arc: 0.25 });
    }
    boardGroup.add(mesh);
  });
  clearGroup(potGroup);
  if (pub.pot > 0) {
    const stack = makeChipStack(pub.pot);
    stack.position.set(0, 0, 0.72);
    potGroup.add(stack);
  }
  const youSeat = you && Number.isInteger(you.seat) ? Math.max(0, you.seat) : 0;
  // Rooms can seat fewer than 6: re-lay the seat ring so a heads-up table puts the opponent across.
  const seatCount = (pub.seats || []).length || 6;
  for (let v = 0; v < seatGroups.length; v++) {
    const g = seatGroups[v]!;
    const { x, y } = seatUnit(v, seatCount);
    g.position.set(x * SEAT_RX, 0.37, y * SEAT_RZ);
    g.visible = v < seatCount;
    clearGroup(g);
  }
  for (const seat of pub.seats || []) {
    const v = seatVisual(seat.seat, youSeat, seatCount);
    const g = seatGroups[v];
    if (!g) continue;
    const cards = visibleCardsForSeat(seat, you) as number[] | null;
    if (cards) {
      cards.forEach((c, index) => {
        const mesh = makeCard(c);
        mesh.position.set((index - 0.5) * 0.39, index * 0.012, 0);
        mesh.rotation.y = (index - 0.5) * -0.17;
        mesh.scale.setScalar(v === 0 ? 1.5 : 0.84);
        if (v === 0) {
          // Your own cards float off the near rail, tilted toward the camera.
          mesh.position.y += 0.78;
          mesh.position.z += 0.55;
          mesh.rotation.x = 0.6;
        } else {
          // Opponents' cards slide inward onto the felt, lifted over the rail lip.
          const len = Math.hypot(g.position.x, g.position.z) || 1;
          mesh.position.x -= (g.position.x / len) * 0.38;
          mesh.position.z -= (g.position.z / len) * 0.38;
          mesh.position.y += 0.1;
        }
        if (handChanged) {
          g.updateWorldMatrix(true, false);
          flyIn(mesh, g.worldToLocal(DECK_POS.clone()), { delay: (v * 2 + index) * 0.1 });
        }
        g.add(mesh);
      });
    }
    if (seat.roundCommit > 0) {
      const bet = makeChipStack(seat.roundCommit, true);
      bet.position.set(-g.position.x * 0.22, 0, -g.position.z * 0.22);
      g.add(bet);
    }
  }
  const actor = (pub.seats || []).find((s) => s.seat === pub.actingSeat);
  if (actor) {
    const v = seatVisual(actor.seat, youSeat, seatCount);
    const target = seatGroups[v]!;
    actingRing.visible = true;
    actingRing.position.set(target.position.x, 0.385, target.position.z);
    actingRing.scale.setScalar(v === 0 ? 1.05 : 0.9);
  } else actingRing.visible = false;
  if (!redraw) anim = { handNumber: pub.handNumber, boardLen: board.length };
}
/** A new table: forget the last hand so its first deal animates. */
export function reset(): void {
  last = null;
  anim = { handNumber: 0, boardLen: 0 };
  tweens = [];
  for (const g of [boardGroup, potGroup, ...seatGroups]) clearGroup(g);
  actingRing.visible = false;
}

// -- showing it --------------------------------------------------------------------------------------
let active = false;
/** Shows the table (the menu's casino hides) with its fog, backdrop, environment and post effects. */
export function setActive(on: boolean): void {
  active = on;
  root.visible = on;
  if (!on) return;
  renderer.camera = camera;
  scene.fog = new FogExp2(0x070b15, 0.055);
  scene.background = backdrop;
  if (look) { applyRenderer(); applyEnv(); }
}
export function isActive(): boolean { return active; }

let frameKey = "";
/**
 * Each frame: frames the camera into the stage rectangle (window px) as the old
 * canvas sat between the page's chrome, and runs the fly-ins and the ambient motion.
 */
export function frameUpdate(dt: number, winW: number, winH: number, stage: { x: number; y: number; width: number; height: number }): void {
  if (!active) return;
  time += dt;
  const fk = `${winW}x${winH}:${Math.round(stage.x)},${Math.round(stage.y)},${Math.round(stage.width)},${Math.round(stage.height)}`;
  if (fk !== frameKey && stage.width > 0 && stage.height > 0 && winW > 0 && winH > 0) {
    frameKey = fk;
    const portrait = stage.width / stage.height < 1;
    camera.position.set(0, portrait ? 7.4 : 6.65, portrait ? 8.5 : 7.15);
    camera.lookAt(0, 0.05, 0.3);
    camera.setViewOffset(stage.width, stage.height, -stage.x, -stage.y, winW, winH);
    camera.updateProjectionMatrix();
  }
  stepTweens();
  // Gentle ambient motion: light shimmer, drifting motes, twinkling stars and the acting-seat pulse (frozen when Static).
  const t = time;
  ringMat.opacity = animated ? 0.58 + Math.sin(t * 4.2) * 0.25 : 0.75;
  if (animated) {
    actingRing.rotation.z = t * 0.18;
    key.intensity = KEY * (1 + Math.sin(t * 1.7) * 0.015 + Math.sin(t * 5.3) * 0.006);
    moteMat.uniforms.uTime!.value = t;
    starMat.opacity = 0.42 + Math.sin(t * 0.8) * 0.08;
  }
}
