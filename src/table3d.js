// Cinematic three.js poker table. The renderer receives only the server's
// addressed projection; visibleCardsForSeat adds a client-side privacy guard
// so an opponent's live cards can only ever be rendered as backs.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { seatVisual, seatUnit, visibleCardsForSeat } from './table-utils.js';
import { GfxPipeline } from './gfx-pipeline.js';
import { reducedMotion } from './gfx-settings.js';

export { seatVisual, seatUnit };

const TABLE_RX = 4.35;
const TABLE_RZ = 2.72;
const SEAT_RX = 3.62;
const SEAT_RZ = 2.34;
// World-space point the dealt/flopped cards fly in from (front of the felt).
const DECK_POS = new THREE.Vector3(1.7, 0.62, -1.05);
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set([1, 2]);

function ellipseShape(rx, ry) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0);
  return shape;
}

function ellipseRing(outerX, outerY, innerX, innerY) {
  const shape = ellipseShape(outerX, outerY);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, innerX, innerY, 0, Math.PI * 2, true, 0);
  shape.holes.push(hole);
  return shape;
}

function horizontalExtrusion(shape, depth, bevelSize = 0.04) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize,
    bevelThickness: bevelSize,
    curveSegments: 96,
  });
  geometry.center();
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function roundedRect(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.closePath();
}

function cardCanvas(card) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 356;
  const g = canvas.getContext('2d');

  roundedRect(g, 3, 3, 250, 350, 18);
  if (card === -1) {
    const bg = g.createLinearGradient(0, 0, 256, 356);
    bg.addColorStop(0, '#101a4d');
    bg.addColorStop(0.5, '#263d91');
    bg.addColorStop(1, '#090f31');
    g.fillStyle = bg;
    g.fill();
    g.save();
    roundedRect(g, 17, 17, 222, 322, 13);
    g.clip();
    g.strokeStyle = 'rgba(111, 189, 255, .48)';
    g.lineWidth = 3;
    for (let i = -360; i < 400; i += 22) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 356, 356); g.stroke();
      g.beginPath(); g.moveTo(i + 356, 0); g.lineTo(i, 356); g.stroke();
    }
    g.restore();
    g.strokeStyle = '#8bd5ff';
    g.lineWidth = 5;
    roundedRect(g, 13, 13, 230, 330, 14);
    g.stroke();
    g.fillStyle = 'rgba(4, 10, 35, .78)';
    g.beginPath(); g.arc(128, 178, 48, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d7b760'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#f4d675';
    g.font = '700 46px Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('S', 128, 178);
  } else {
    g.fillStyle = '#fffdf7';
    g.fill();
    g.strokeStyle = '#d6d0c4';
    g.lineWidth = 3;
    g.stroke();
    const rank = RANKS[card % 13];
    const suitIndex = (card / 13) | 0;
    const suit = SUITS[suitIndex];
    const color = RED_SUITS.has(suitIndex) ? '#c72535' : '#121826';
    g.fillStyle = color;
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '800 70px Georgia, serif';
    g.fillText(rank, 20, 12);
    g.font = '58px Georgia, serif';
    g.fillText(suit, 23, 82);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '116px Georgia, serif';
    g.globalAlpha = 0.92;
    g.fillText(suit, 128, 205);
    g.globalAlpha = 1;
    g.save();
    g.translate(256, 356); g.rotate(Math.PI);
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '800 70px Georgia, serif'; g.fillText(rank, 20, 12);
    g.font = '58px Georgia, serif'; g.fillText(suit, 23, 82);
    g.restore();
  }
  return canvas;
}

function labelTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 192;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '600 66px Georgia, serif';
  g.letterSpacing = '14px';
  g.fillStyle = 'rgba(223, 199, 121, .3)';
  g.fillText(text, 384, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// --- procedural textures (detail / backdrop) --------------------------------

function canvasTexture(canvas, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// Screen backdrop matching the stage's CSS gradient (blue glow up top).
function backdropTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 288;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 100, 0, 256, 100, 330);
  grad.addColorStop(0, '#182942');
  grad.addColorStop(0.56, '#090d16');
  grad.addColorStop(1, '#05070c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 288);
  return canvasTexture(c);
}

function radialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return canvasTexture(c);
}

// Tileable value noise (grey, linear) for bump maps.
function noiseTexture(size, blur, lo, hi) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  let r = 12345;
  for (let i = 0; i < size * size; i++) {
    r = (r * 16807) % 2147483647;
    const v = lo + (r / 2147483647) * (hi - lo);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (blur > 1) {
    g.filter = `blur(${blur - 1}px)`;
    g.drawImage(c, 0, 0);
    g.filter = 'none';
  }
  return canvasTexture(c, { srgb: false, repeat: true });
}

function feltTexture() {
  const W = 1024, H = 592;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.56);
  grad.addColorStop(0, '#0c6a4e');
  grad.addColorStop(0.7, '#08573f');
  grad.addColorStop(1, '#053a2b');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Fibres: short random strokes, light and dark.
  let r = 99;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI;
    g.strokeStyle = rnd() > 0.5 ? 'rgba(170,255,210,.05)' : 'rgba(0,20,10,.08)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4);
    g.stroke();
  }
  // Printed betting line and a faint card-box outline for the board.
  g.strokeStyle = 'rgba(232, 200, 120, .34)';
  g.lineWidth = 3;
  g.setLineDash([]);
  g.beginPath();
  g.ellipse(W / 2, H / 2, W * 0.36, H * 0.33, 0, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(232, 200, 120, .16)';
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(W / 2 - 280, H / 2 - 62, 560, 124, 16);
  g.stroke();
  return canvasTexture(c, { repeat: false });
}

// Casino chip: face with edge inserts, inlay ring and a star; side stripes.
function chipFaceTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  const light = color === 0xf0e6d0 || color === 0x21252e ? '#c7a24c' : '#f5ecd6';
  g.fillStyle = hex;
  g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.fill();
  g.fillStyle = light;
  for (let i = 0; i < 8; i++) {
    g.save();
    g.translate(64, 64);
    g.rotate((i / 8) * Math.PI * 2);
    g.fillRect(-7, -64, 14, 15);
    g.restore();
  }
  g.strokeStyle = light;
  g.lineWidth = 3;
  g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(0,0,0,.18)';
  g.beginPath(); g.arc(64, 64, 37, 0, Math.PI * 2); g.fill();
  g.fillStyle = light;
  g.font = '700 34px Georgia, serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('★', 64, 66);
  return canvasTexture(c);
}

function chipSideTexture(color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.fillRect(0, 0, 256, 8);
  g.fillStyle = color === 0xf0e6d0 || color === 0x21252e ? '#c7a24c' : '#f5ecd6';
  for (let i = 0; i < 8; i++) g.fillRect(i * 32 + 9, 0, 14, 8);
  return canvasTexture(c);
}

function roundedCardGeometry() {
  const w = 0.59, h = 0.82, r = 0.055;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  shape.lineTo(w / 2, h / 2 - r);
  shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.026, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 6,
  });
  geo.center();
  geo.rotateX(Math.PI / 2);
  return geo;
}

const MOTE_VERT = /* glsl */`
  attribute float aSeed;
  uniform float uTime;
  varying float vSeed;
  void main() {
    vSeed = aSeed;
    vec3 p = position;
    p.y += sin(uTime * 0.23 + aSeed * 30.0) * 0.35;
    p.x += sin(uTime * 0.11 + aSeed * 17.0) * 0.25;
    p.z += cos(uTime * 0.13 + aSeed * 23.0) * 0.25;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(14.0 * (0.5 + aSeed) / max(-mv.z, 0.5), 1.0, 24.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const MOTE_FRAG = /* glsl */`
  uniform float uTime;
  varying float vSeed;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    float tw = 0.5 + 0.5 * sin(uTime * (0.7 + vSeed) + vSeed * 50.0);
    gl_FragColor = vec4(vec3(1.0, 0.86, 0.62), a * tw * 0.35);
  }
`;

export class TableRenderer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x070b15, 0.055);
    // The backdrop lives in the scene (not a CSS/clear colour) so the post
    // chain grades it together with the table.
    this.scene.background = backdropTexture();
    this.camera = new THREE.PerspectiveCamera(39, 1, 0.1, 80);
    this.camera.position.set(0, 6.65, 7.15);
    this.camera.lookAt(0, 0.05, 0.35);
    this.clock = new THREE.Clock();
    this.cardTextures = new Map();
    this.shared = new Map();   // detailed card/chip materials + geometries, reused across redraws
    this.dynamicGroups = [];
    this.tweens = [];  // in-flight card fly-in animations
    // Diff state for animation triggers (hand number / board growth).
    this._anim = { handNumber: 0, boardLen: 0 };
    this.reduced = reducedMotion();

    this.buildLights();
    this.buildRoom();
    this.buildTable();
    this.buildDynamicGroups();

    this.pipeline = new GfxPipeline({
      container,
      scene: this.scene,
      camera: this.camera,
      shadowLights: () => [this.key],
      bloom: { strength: 0.6, radius: 0.5, threshold: 1.5 },
      configure: (r) => {
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.05;
      },
      onRenderer: () => { this._disposeEnv(); },
      onApply: (q) => this.applyGraphics(q),
    });
    this.renderer = this.pipeline.renderer;
    this._applyEnv();

    this._onResize = () => this.resize();
    this.resizeObserver = new ResizeObserver(this._onResize);
    this.resizeObserver.observe(container);
    this.resize();

    this._disposed = false;
    let last = performance.now();
    const loop = () => {
      if (this._disposed) return;
      const now = performance.now();
      const dt = Math.min(250, now - last);
      last = now;
      const t = this.clock.getElapsedTime();
      this._stepTweens(t);
      this._ambient(t);
      this.renderer = this.pipeline.renderer;
      this.pipeline.render(dt);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  // --- graphics settings ----------------------------------------------------

  applyGraphics(q) {
    this.q = q;
    this.detailed = q.detail === 'detailed';
    this.animated = q.background === 'animated' && !this.reduced;
    if (this.felt) {
      this.felt.material = this.detailed ? this.feltDetailed : this.feltPlain;
      this.rail.material = this.detailed ? this.railDetailed : this.railPlain;
      this.floorPool.visible = this.detailed;
    }
    if (this.motes) this.motes.visible = q.particles === 'high';
    if (this.stars) this.stars.geometry.setDrawRange(0, q.particles === 'high' ? 240 : 120);
    // HDR colour so only the acting-seat ring blooms (clamped when bloom is off).
    if (this.actingRing) {
      this.actingRing.material.color.set(0xffd66d).multiplyScalar(q.bloom === 'on' ? 4 : 1);
    }
    this._applyEnv();
    if (this._last) this.update(this._last.pub, this._last.you, { redraw: true });
  }

  _applyEnv() {
    if (!this.pipeline || !this.pipeline.renderer) return;
    if (this.q.reflections === 'on') {
      if (!this.envTex) {
        const pmrem = new THREE.PMREMGenerator(this.pipeline.renderer);
        const room = new RoomEnvironment();
        this.envTex = pmrem.fromScene(room, 0.04).texture;
        room.dispose();
        pmrem.dispose();
      }
      this.scene.environment = this.envTex;
      this.scene.environmentIntensity = 0.42;
    } else {
      this.scene.environment = null;
    }
  }

  _disposeEnv() {
    if (this.envTex) this.envTex.dispose();
    this.envTex = null;
    this.scene.environment = null;
    if (this.q) this._applyEnv();
  }

  // Gentle ambient motion: light shimmer, drifting motes, twinkling stars and
  // the acting-seat pulse. Frozen under prefers-reduced-motion / Static.
  _ambient(t) {
    const a = this.animated;
    if (this.actingRing) {
      const glow = a ? 0.58 + Math.sin(t * 4.2) * 0.25 : 0.75;
      this.actingRing.material.opacity = glow;
      if (a) this.actingRing.rotation.z = t * 0.18;
    }
    if (a) {
      this.key.intensity = 42 * (1 + Math.sin(t * 1.7) * 0.015 + Math.sin(t * 5.3) * 0.006);
      if (this.motes) this.motes.material.uniforms.uTime.value = t;
      if (this.stars) this.stars.material.opacity = 0.42 + Math.sin(t * 0.8) * 0.08;
    }
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xb9d9ff, 0x160c08, 1.35));
    const key = new THREE.SpotLight(0xfff0d3, 42, 25, Math.PI / 4.2, 0.7, 1.2);
    key.position.set(-3.5, 8, 4.5);
    key.target.position.set(0, 0, 0);
    // Shadow frustum fitted to the table: the light sits ~10 units from the
    // felt and the table spans ±4.4, so a tight near/far keeps depth precision.
    key.shadow.camera.near = 5;
    key.shadow.camera.far = 16;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.015;
    key.shadow.focus = 0.9;
    this.key = key;
    this.scene.add(key, key.target);
    const rim = new THREE.PointLight(0x3d7dff, 22, 14, 2);
    rim.position.set(4.5, 2.5, -4);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xff9e53, 12, 10, 2);
    warm.position.set(-5, 1.5, 1);
    this.scene.add(warm);
  }

  buildRoom() {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(12, 96),
      new THREE.MeshStandardMaterial({ color: 0x080b12, roughness: 0.88, metalness: 0.12 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.64;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Warm pool of spill light on the carpet around the pedestal.
    this.floorPool = new THREE.Mesh(
      new THREE.PlaneGeometry(13, 10),
      new THREE.MeshBasicMaterial({
        map: radialTexture('rgba(255,196,120,.16)', 'rgba(255,196,120,0)'),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
    this.floorPool.rotation.x = -Math.PI / 2;
    this.floorPool.position.y = -0.636;
    this.scene.add(this.floorPool);

    const points = [];
    // Interleaved so the first half of the draw range is an even subset.
    for (let i = 0; i < 240; i++) {
      const angle = i * 2.39996;
      const radius = 7 + (i % 29) * 0.22;
      points.push(Math.cos(angle) * radius, 2 + (i % 17) * 0.34, Math.sin(angle) * radius - 3);
    }
    const stars = new THREE.BufferGeometry();
    stars.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.stars = new THREE.Points(stars, new THREE.PointsMaterial({
      color: 0x729bd3, size: 0.035, transparent: true, opacity: 0.45,
    }));
    this.scene.add(this.stars);

    // Dust motes drifting through the key light's cone (Particles: High).
    const n = 220;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    let r = 7;
    const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const ang = rand() * Math.PI * 2;
      const rad = Math.sqrt(rand()) * 3.6;
      pos[i * 3] = Math.cos(ang) * rad * 1.2;
      pos[i * 3 + 1] = 0.7 + rand() * 4.2;
      pos[i * 3 + 2] = Math.sin(ang) * rad * 0.8;
      seed[i] = rand();
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    mg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.motes = new THREE.Points(mg, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.motes.visible = false;
    this.scene.add(this.motes);
  }

  buildTable() {
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.05, 0.78, 64),
      new THREE.MeshStandardMaterial({ color: 0x11141b, roughness: 0.22, metalness: 0.74 }));
    pedestal.position.y = -0.38;
    pedestal.castShadow = true;
    this.scene.add(pedestal);

    const base = new THREE.Mesh(
      horizontalExtrusion(ellipseShape(TABLE_RX, TABLE_RZ), 0.34, 0.08),
      new THREE.MeshPhysicalMaterial({ color: 0x171217, roughness: 0.22, metalness: 0.5, clearcoat: 0.65 }));
    base.position.y = -0.05;
    base.castShadow = base.receiveShadow = true;
    this.scene.add(base);

    this.railPlain = new THREE.MeshPhysicalMaterial({ color: 0x381a16, roughness: 0.28, metalness: 0.12, clearcoat: 0.85, clearcoatRoughness: 0.18 });
    // Detailed: padded leather — grain bump, soft sheen, lacquer clearcoat.
    const grain = noiseTexture(256, 3, 90, 165);
    grain.repeat.set(2.5, 2.5);
    this.railDetailed = new THREE.MeshPhysicalMaterial({
      color: 0x3f1c17, roughness: 0.46, metalness: 0.05, bumpMap: grain, bumpScale: 1.2,
      clearcoat: 0.55, clearcoatRoughness: 0.3, sheen: 0.4, sheenColor: new THREE.Color(0x8a4a3a), sheenRoughness: 0.6,
    });
    this.rail = new THREE.Mesh(
      horizontalExtrusion(ellipseRing(TABLE_RX, TABLE_RZ, 3.82, 2.19), 0.25, 0.07), this.railPlain);
    this.rail.position.y = 0.22;
    this.rail.castShadow = true;
    this.rail.receiveShadow = true;
    this.scene.add(this.rail);

    this.feltPlain = new THREE.MeshStandardMaterial({ color: 0x07543e, roughness: 0.92, metalness: 0.02 });
    // Detailed: woven baize — fibre noise, a soft centre lift and a printed
    // gold betting line. Shape UVs span the ellipse in world units.
    const feltTex = feltTexture();
    feltTex.repeat.set(1 / 7.72, 1 / 4.46);
    feltTex.offset.set(0.5, 0.5);
    const feltBump = noiseTexture(512, 1, 110, 150);
    feltBump.repeat.set(1.6, 1.6);
    this.feltDetailed = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: feltTex, roughness: 0.95, metalness: 0, bumpMap: feltBump, bumpScale: 0.6,
      envMapIntensity: 0.25,
    });
    this.felt = new THREE.Mesh(horizontalExtrusion(ellipseShape(3.84, 2.21), 0.09, 0.015), this.feltPlain);
    this.felt.position.y = 0.22;
    this.felt.receiveShadow = true;
    this.scene.add(this.felt);

    for (const [outer, inner, color, y] of [
      [[3.88, 2.25], [3.81, 2.18], 0xc69b42, 0.305],
      [[3.48, 1.88], [3.465, 1.865], 0x93a87b, 0.314],
    ]) {
      const trim = new THREE.Mesh(
        horizontalExtrusion(ellipseRing(...outer, ...inner), 0.018, 0.005),
        new THREE.MeshStandardMaterial({ color, metalness: 0.72, roughness: 0.28 }));
      trim.position.y = y;
      this.scene.add(trim);
    }

    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(2.7, 0.67),
      new THREE.MeshBasicMaterial({
        map: labelTexture('STARHERMIT'), transparent: true, depthWrite: false,
        // Printed on the felt (not floating above it) so ambient occlusion
        // reads it as part of the cloth; the offset keeps it from z-fighting.
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
    logo.rotation.x = -Math.PI / 2;
    logo.position.set(0, 0.281, -0.72);
    this.scene.add(logo);
  }

  buildDynamicGroups() {
    this.boardGroup = new THREE.Group();
    this.boardGroup.position.y = 0.37;
    this.scene.add(this.boardGroup);
    this.potGroup = new THREE.Group();
    this.potGroup.position.y = 0.36;
    this.scene.add(this.potGroup);

    this.seatGroups = [];
    for (let visual = 0; visual < 6; visual++) {
      const group = new THREE.Group();
      const { x, y } = seatUnit(visual);
      group.position.set(x * SEAT_RX, 0.37, y * SEAT_RZ);
      this.scene.add(group);
      this.seatGroups.push(group);
    }

    this.actingRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.48, 0.025, 10, 64),
      new THREE.MeshBasicMaterial({ color: 0xffd66d, transparent: true, opacity: 0 }));
    this.actingRing.rotation.x = Math.PI / 2;
    this.actingRing.userData.noAO = true;
    this.actingRing.visible = false;
    this.scene.add(this.actingRing);
  }

  textureForCard(card) {
    if (this.cardTextures.has(card)) return this.cardTextures.get(card);
    const texture = new THREE.CanvasTexture(cardCanvas(card));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.pipeline.renderer.capabilities.getMaxAnisotropy());
    this.cardTextures.set(card, texture);
    return texture;
  }

  // Detailed-mode resources shared by every card/chip (never disposed per redraw).
  sharedRes(key, make) {
    if (!this.shared.has(key)) {
      const res = make();
      res.userData.shared = true;
      this.shared.set(key, res);
    }
    return this.shared.get(key);
  }

  makeCard(card) {
    const group = new THREE.Group();
    if (this.detailed) {
      // Rounded, lacquered card stock; the printed face stays unlit so ranks
      // and suits keep full contrast (and sit just under the bloom threshold).
      const body = new THREE.Mesh(
        this.sharedRes('cardGeo', roundedCardGeometry),
        this.sharedRes('cardMat', () => new THREE.MeshPhysicalMaterial({
          color: 0xefe9dd, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.3,
        })));
      body.castShadow = body.receiveShadow = true;
      const face = new THREE.Mesh(
        this.sharedRes('faceGeo', () => new THREE.PlaneGeometry(0.585, 0.815)),
        new THREE.MeshBasicMaterial({
          map: this.textureForCard(card), alphaTest: 0.5, toneMapped: false, color: 0xe8e8e8,
        }));
      face.rotation.x = -Math.PI / 2;
      face.position.y = 0.0175;
      group.add(body, face);
      return group;
    }
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(0.59, 0.035, 0.82, 2, 1, 2),
      new THREE.MeshStandardMaterial({ color: 0xe7e1d5, roughness: 0.48 }));
    edge.castShadow = edge.receiveShadow = true;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.565, 0.795),
      new THREE.MeshBasicMaterial({ map: this.textureForCard(card) }));
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.019;
    group.add(edge, face);
    return group;
  }

  // --- card fly-in animation --------------------------------------------------
  // Cards are rebuilt on every state redraw, so animations are tweens over a
  // freshly created mesh's transform. A tween dies automatically when its
  // mesh is removed by the next redraw.

  // Animate `mesh` from world position `from` (converted into its parent
  // group's local space by the caller) to its already-assigned slot,
  // spinning and arcing slightly on the way.
  flyIn(mesh, from, { delay = 0, spin = Math.PI * 2, arc = 0.35, dur = 0.5 } = {}) {
    this.tweens.push({
      mesh,
      fromPos: from.clone(),
      toPos: mesh.position.clone(),
      fromRotY: mesh.rotation.y + spin,
      toRotY: mesh.rotation.y,
      fromRotX: 0,
      toRotX: mesh.rotation.x,
      arc,
      start: this.clock.getElapsedTime() + delay,
      dur,
    });
    mesh.position.copy(from);
  }

  _stepTweens(t) {
    if (!this.tweens.length) return;
    this.tweens = this.tweens.filter((tw) => {
      if (!tw.mesh.parent) return false; // cleared by a redraw
      const k = (t - tw.start) / tw.dur;
      if (k < 0) return true; // waiting for its stagger slot
      if (k >= 1) {
        tw.mesh.position.copy(tw.toPos);
        tw.mesh.rotation.y = tw.toRotY;
        tw.mesh.rotation.x = tw.toRotX;
        return false;
      }
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      tw.mesh.position.lerpVectors(tw.fromPos, tw.toPos, e);
      tw.mesh.position.y += Math.sin(Math.PI * e) * tw.arc;
      tw.mesh.rotation.y = tw.fromRotY + (tw.toRotY - tw.fromRotY) * e;
      tw.mesh.rotation.x = tw.fromRotX + (tw.toRotX - tw.fromRotX) * e;
      return true;
    });
  }

  makeChipStack(amount, compact = false) {
    const group = new THREE.Group();
    const count = Math.min(compact ? 10 : 14, Math.max(1, Math.ceil(Math.log2(Math.max(2, amount / 25)))));
    const colors = [0xf0e6d0, 0xc72e45, 0x2458b8, 0x159061, 0x21252e];
    const radius = compact ? 0.115 : 0.14;
    for (let i = 0; i < count; i++) {
      const color = colors[(Math.floor(amount / 100) + i) % colors.length];
      if (this.detailed) {
        // Clay chips: striped edge, inlaid face, clearcoat; slightly uneven stack.
        const geo = this.sharedRes(`chipGeo${radius}`, () => new THREE.CylinderGeometry(radius, radius, 0.042, 40));
        const side = this.sharedRes(`chipSide${color}`, () => new THREE.MeshPhysicalMaterial({
          map: chipSideTexture(color), roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3,
        }));
        const top = this.sharedRes(`chipTop${color}`, () => new THREE.MeshPhysicalMaterial({
          map: chipFaceTexture(color), roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.25,
        }));
        const chip = new THREE.Mesh(geo, [side, top, top]);
        chip.position.set(Math.sin(i * 2.7 + amount) * 0.006, 0.022 + i * 0.043, Math.cos(i * 1.9 + amount) * 0.006);
        chip.rotation.y = i * 0.9;
        chip.castShadow = chip.receiveShadow = true;
        group.add(chip);
        continue;
      }
      const chip = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 0.042, 32),
        new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.12 }));
      chip.position.y = 0.022 + i * 0.045;
      chip.castShadow = true;
      group.add(chip);
      if (i % 2 === 0) {
        const stripe = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 0.82, 0.009, 5, 24),
          new THREE.MeshBasicMaterial({ color: 0xf5e7bf }));
        stripe.rotation.x = Math.PI / 2;
        stripe.position.y = 0.045 + i * 0.045;
        group.add(stripe);
      }
    }
    return group;
  }

  clearGroup(group) {
    // Dynamic objects own their geometry/materials, except shared detailed
    // resources. Textures are cached and disposed once with the renderer.
    for (const child of [...group.children]) {
      child.traverse((obj) => {
        if (obj.geometry && !obj.geometry.userData.shared) obj.geometry.dispose();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) if (!mat.userData.shared) mat.dispose();
        }
      });
      group.remove(child);
    }
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    // The pipeline sizes the drawing buffer on the next frame.
    this.camera.aspect = w / h;
    this.camera.position.y = w / h < 1 ? 7.4 : 6.65;
    this.camera.position.z = w / h < 1 ? 8.5 : 7.15;
    this.camera.lookAt(0, 0.05, 0.3);
    this.camera.updateProjectionMatrix();
  }

  // Full redraw from a projected public state + the viewer's private view.
  update(publicState, you, { redraw = false } = {}) {
    this._last = { pub: publicState, you };
    if (redraw && !publicState) return;
    // Animation triggers: a new hand deals the hole cards; community cards
    // fly in as the board grows (an all-in runout grows it by 3-5 at once,
    // which reads as a rapid deal-out).
    const handChanged = publicState.handNumber !== this._anim.handNumber;
    this.clearGroup(this.boardGroup);
    const board = publicState.board || [];
    const boardAdded = handChanged ? 0 : Math.max(0, board.length - this._anim.boardLen);
    board.forEach((card, i) => {
      const mesh = this.makeCard(card);
      // Community cards are the table's focus: render them larger than the
      // hole cards and space them to match.
      mesh.scale.setScalar(1.28);
      mesh.position.set((i - 2) * 0.8, 0, -0.08);
      mesh.rotation.y = (i - 2) * -0.018;
      if (i >= board.length - boardAdded) {
        this.boardGroup.updateWorldMatrix(true, false);
        this.flyIn(mesh, this.boardGroup.worldToLocal(DECK_POS.clone()), {
          delay: (i - (board.length - boardAdded)) * 0.14,
          arc: 0.25,
        });
      }
      this.boardGroup.add(mesh);
    });

    this.clearGroup(this.potGroup);
    if (publicState.pot > 0) {
      const stack = this.makeChipStack(publicState.pot);
      stack.position.set(0, 0, 0.72);
      this.potGroup.add(stack);
    }

    const youSeat = you && Number.isInteger(you.seat) ? you.seat : 0;
    // Rooms can seat fewer than 6 (e.g. host + N AI): re-lay the seat ring so
    // a heads-up table puts the opponent across from you.
    const seatCount = (publicState.seats || []).length || 6;
    for (let visual = 0; visual < this.seatGroups.length; visual++) {
      const group = this.seatGroups[visual];
      const { x, y } = seatUnit(visual, seatCount);
      group.position.set(x * SEAT_RX, 0.37, y * SEAT_RZ);
      group.visible = visual < seatCount;
    }
    for (const group of this.seatGroups) this.clearGroup(group);
    for (const seat of publicState.seats || []) {
      const visual = seatVisual(seat.seat, Math.max(0, youSeat), seatCount);
      const group = this.seatGroups[visual];
      if (!group) continue;
      const cards = visibleCardsForSeat(seat, you);
      if (cards) {
        cards.forEach((card, index) => {
          const mesh = this.makeCard(card);
          mesh.position.set((index - 0.5) * 0.39, index * 0.012, 0);
          mesh.rotation.y = (index - 0.5) * -0.17;
          mesh.scale.setScalar(visual === 0 ? 1.5 : 0.84);
          if (visual === 0) {
            // Your own cards float off the near rail: raised, nudged toward
            // the camera and tilted face-toward-camera (positive X rotation
            // swings the up-facing card face toward +Z, where the camera is).
            mesh.position.y += 0.78;
            mesh.position.z += 0.55;
            mesh.rotation.x = 0.6;
          } else {
            // Opponent seats sit on the rail band: slide their cards inward
            // onto the felt and lift them so the brown rail lip doesn't
            // cover the outer edge.
            const len = Math.hypot(group.position.x, group.position.z) || 1;
            mesh.position.x -= (group.position.x / len) * 0.38;
            mesh.position.z -= (group.position.z / len) * 0.38;
            mesh.position.y += 0.1;
          }
          if (handChanged) {
            // Dealt from the deck, staggered seat by seat.
            group.updateWorldMatrix(true, false);
            this.flyIn(mesh, group.worldToLocal(DECK_POS.clone()), {
              delay: (visual * 2 + index) * 0.1,
            });
          }
          group.add(mesh);
        });
      }
      if (seat.roundCommit > 0) {
        const bet = this.makeChipStack(seat.roundCommit, true);
        // Move from the seat toward the centre of the felt.
        bet.position.set(-group.position.x * 0.22, 0, -group.position.z * 0.22);
        group.add(bet);
      }
    }

    const actor = (publicState.seats || []).find((seat) => seat.seat === publicState.actingSeat);
    if (actor) {
      const visual = seatVisual(actor.seat, Math.max(0, youSeat), seatCount);
      const target = this.seatGroups[visual];
      this.actingRing.visible = true;
      this.actingRing.position.set(target.position.x, 0.385, target.position.z);
      this.actingRing.scale.setScalar(visual === 0 ? 1.05 : 0.9);
    } else {
      this.actingRing.visible = false;
    }

    this._anim = { handNumber: publicState.handNumber, boardLen: board.length };
  }

  dispose() {
    this._disposed = true;
    this.tweens = [];
    if (this._raf) cancelAnimationFrame(this._raf);
    this.resizeObserver.disconnect();
    const seen = new Set();
    const disposeMat = (mat) => {
      if (seen.has(mat)) return;
      seen.add(mat);
      for (const key of ['map', 'bumpMap']) {
        if (mat[key] && !this.cardTextures.has(mat[key]) && ![...this.cardTextures.values()].includes(mat[key])) mat[key].dispose();
      }
      mat.dispose();
    };
    for (const m of [this.feltPlain, this.feltDetailed, this.railPlain, this.railDetailed]) disposeMat(m);
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(disposeMat);
    });
    for (const res of this.shared.values()) (res.isMaterial ? disposeMat(res) : res.dispose());
    this.shared.clear();
    for (const texture of this.cardTextures.values()) texture.dispose();
    this.cardTextures.clear();
    if (this.scene.background && this.scene.background.isTexture) this.scene.background.dispose();
    if (this.envTex) this.envTex.dispose();
    this.pipeline.dispose();
  }
}
