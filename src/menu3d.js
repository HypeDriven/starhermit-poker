// Cinematic sci-fi casino behind the main menu.
//
// The hall itself (assets/casino.glb) is modelled in Blender: a domed neon
// casino with a poker-table centrepiece. This module loads it, adds the
// shader-driven magic Blender cannot export — nebula sky, volumetric light
// beam, holographic ring, dust particles, and a cloud of playing cards
// drifting in zero gravity around the table — then flies the camera from
// the entrance, past the decorations, and down into a slow orbit of the
// table. Any click or key skips the flight.
//
// Everything degrades gracefully: no WebGL, no GLB, or reduced-motion just
// leaves the CSS background in place.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  SHELL, makeDriftState, stepDrift, mulberry32, easeInOutCubic, clamp01,
} from './menu3d-physics.js';

const FLY_SECONDS = 17;
const CARD_COUNT = 28;
const REDUCED = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Shaders

const NEBULA_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NEBULA_FRAG = /* glsl */`
  varying vec3 vDir;
  uniform float uTime;
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.55; }
    return v;
  }
  void main() {
    vec3 d = normalize(vDir);
    float n = fbm(d * 3.0 + vec3(uTime * 0.010, 0.0, uTime * 0.006));
    float n2 = fbm(d * 7.0 - vec3(0.0, uTime * 0.008, 0.0));
    vec3 col = mix(vec3(0.004, 0.006, 0.020), vec3(0.050, 0.020, 0.120),
                   smoothstep(0.35, 0.8, n));
    col += vec3(0.00, 0.10, 0.16) * smoothstep(0.55, 0.90, n2) * 0.8;
    col += vec3(0.14, 0.03, 0.12) * smoothstep(0.60, 0.95, fbm(d * 5.0 + 10.0)) * 0.9;
    vec3 cell = floor(d * 200.0);
    float s = hash(cell);
    if (s > 0.9975) {
      float tw = 0.6 + 0.4 * sin(uTime * 2.0 + s * 90.0);
      col += vec3(tw) * smoothstep(0.9975, 1.0, s) * 1.6;
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

const CARD_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewW;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewW = cameraPosition - wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CARD_FRAG = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewW;
  varying vec3 vWorld;
  uniform sampler2D uMap;
  uniform vec3 uTint;
  uniform float uTime;
  uniform float uSeed;
  void main() {
    vec3 col;
    float alpha;
    if (gl_FrontFacing) {
      vec4 tex = texture2D(uMap, vUv);
      col = tex.rgb;
      alpha = tex.a;
    } else {
      // Procedural card back: dark glass with a glowing lattice.
      vec2 g = abs(fract(vUv * vec2(5.0, 7.0)) - 0.5);
      float line = smoothstep(0.44, 0.5, max(g.x, g.y));
      col = vec3(0.015, 0.04, 0.09) + uTint * line * 0.55;
      alpha = 1.0;
    }
    float fres = pow(1.0 - abs(dot(normalize(vViewW), normalize(vNormalW))), 2.0);
    float scan = sin(vWorld.y * 36.0 - uTime * 2.5 + uSeed * 17.0) * 0.5 + 0.5;
    float flick = 0.92 + 0.08 * sin(uTime * 13.0 + uSeed * 40.0);
    col = col * flick + uTint * (fres * 1.5 + scan * 0.05);
    gl_FragColor = vec4(col, alpha);
  }
`;

const BEAM_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BEAM_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  void main() {
    float fade = pow(vUv.y, 1.6);
    float streak = 0.85 + 0.15 * sin(vUv.x * 40.0 + uTime * 0.7);
    float pulse = 0.9 + 0.1 * sin(uTime * 0.9);
    gl_FragColor = vec4(uColor, fade * streak * pulse * 0.16);
  }
`;

const HOLO_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  void main() {
    float band = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
    float scan = 0.5 + 0.5 * sin(vUv.y * 70.0 - uTime * 5.0);
    float ticks = step(0.72, fract(vUv.x * 36.0 + uTime * 0.06));
    float a = band * (0.06 + scan * 0.10 + ticks * 0.10);
    gl_FragColor = vec4(uColor, a);
  }
`;

const DUST_VERT = /* glsl */`
  attribute float aSeed;
  varying float vSeed;
  uniform float uTime;
  void main() {
    vSeed = aSeed;
    vec3 p = position;
    p.y += sin(uTime * 0.20 + aSeed * 20.0) * 0.8;
    p.x += sin(uTime * 0.13 + aSeed * 31.0) * 0.6;
    p.z += cos(uTime * 0.17 + aSeed * 27.0) * 0.6;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = (60.0 * (0.4 + 0.6 * fract(aSeed * 7.0))) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const DUST_FRAG = /* glsl */`
  varying float vSeed;
  uniform float uTime;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    float tw = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.6 + vSeed) + vSeed * 40.0));
    vec3 col = mix(vec3(0.5, 0.8, 1.0), vec3(1.0, 0.6, 0.9), fract(vSeed * 3.0));
    gl_FragColor = vec4(col, a * tw * 0.55);
  }
`;

// ---------------------------------------------------------------------------
// Card faces (canvas textures; holo-styled to match the shader)

const RANKS = 'AKQJT98765432';
const SUITS = ['♠', '♥', '♦', '♣'];
const RED = new Set(['♥', '♦']);

function cardTexture(rank, suit) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 180;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 180);
  g.beginPath();
  g.roundRect(4, 4, 120, 172, 12);
  g.fillStyle = 'rgba(8, 14, 28, 0.92)';
  g.fill();
  g.strokeStyle = 'rgba(110, 220, 255, 0.85)';
  g.lineWidth = 3;
  g.stroke();
  const color = RED.has(suit) ? '#ff6b81' : '#bfeaff';
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 12;
  g.font = '700 34px Georgia, serif';
  g.textAlign = 'left';
  g.fillText(rank, 16, 44);
  g.font = '400 30px Georgia, serif';
  g.fillText(suit, 16, 78);
  g.font = '400 54px Georgia, serif';
  g.textAlign = 'center';
  g.fillText(suit, 64, 142);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------

export class MenuScene3D {
  constructor(container) {
    this.container = container;
    this.failed = false;
    this.destroyed = false;
    this.disposables = [];
    this.cardStates = [];
    this.cards = [];
    this.chips = [];
    this.crystals = [];
    this.neonMats = [];
    this.uniforms = [];
    this.pointer = { x: 0, y: 0 };
    this.flyT = REDUCED ? 1 : 0;
    this.idleAngle = Math.PI * 0.15;

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      this.failed = true;
      return;
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
    this.camera.position.set(0, 5.5, 30);

    this.buildLighting();
    this.buildSky();
    this.buildBeam();
    this.buildHoloBands();
    this.buildDust();
    this.buildCards();
    this.buildFlightPath();
    this.loadCasino();

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.4, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.onResize = () => this.resize();
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(container);
    this.resize();

    this.onPointer = (e) => {
      this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
      this.pointer.y = (e.clientY / innerHeight) * 2 - 1;
    };
    this.onSkip = () => { this.flyT = 1; };
    addEventListener('pointermove', this.onPointer, { passive: true });
    if (!REDUCED) {
      addEventListener('pointerdown', this.onSkip);
      addEventListener('keydown', this.onSkip);
    }

    this.clock = new THREE.Clock();
    this.loop = () => {
      if (this.destroyed) return;
      this.raf = requestAnimationFrame(this.loop);
      this.tick(Math.min(this.clock.getDelta(), 0.05));
    };
    this.loop();
  }

  track(...objs) {
    this.disposables.push(...objs);
    return objs[0];
  }

  uniformBag(u) {
    this.uniforms.push(u);
    return u;
  }

  // --- scene pieces ---------------------------------------------------------

  buildLighting() {
    this.scene.add(new THREE.AmbientLight(0x334466, 2.2));
    const hemi = new THREE.HemisphereLight(0x445588, 0x1a0f22, 1.2);
    this.scene.add(hemi);
    const key = new THREE.PointLight(0x66ccff, 900, 60, 2);
    key.position.set(0, 11, 0);
    const warm = new THREE.PointLight(0xff8844, 500, 45, 2);
    warm.position.set(14, 8, -10);
    const cool = new THREE.PointLight(0x8844ff, 500, 45, 2);
    cool.position.set(-14, 8, 10);
    const felt = new THREE.PointLight(0x33ffaa, 110, 18, 2);
    felt.position.set(0, 5, 0);
    this.scene.add(key, warm, cool, felt);
  }

  buildSky() {
    const geo = this.track(new THREE.SphereGeometry(180, 48, 32));
    this.skyU = this.uniformBag({ uTime: { value: 0 } });
    const mat = this.track(new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERT,
      fragmentShader: NEBULA_FRAG,
      uniforms: this.skyU,
      side: THREE.BackSide,
      depthWrite: false,
    }));
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  // Light shaft from the dome oculus down onto the table.
  buildBeam() {
    const geo = this.track(new THREE.ConeGeometry(3.6, 22, 48, 1, true));
    this.beamU = this.uniformBag({
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x9fd8ff) },
    });
    const mat = this.track(new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: this.beamU,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    }));
    const beam = new THREE.Mesh(geo, mat);
    beam.position.set(0, 14.5, 0);
    this.scene.add(beam);
  }

  // Holographic rings rotating above the felt.
  buildHoloBands() {
    this.holoU = [];
    const mk = (radius, y, h, color, speed) => {
      const geo = this.track(new THREE.CylinderGeometry(radius, radius, h, 64, 1, true));
      const u = this.uniformBag({
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(color) },
      });
      const mat = this.track(new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: HOLO_FRAG,
        uniforms: u,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = y;
      mesh.userData.speed = speed;
      this.scene.add(mesh);
      return mesh;
    };
    this.bands = [
      mk(3.1, 4.6, 0.9, 0x33ddff, 0.12),
      mk(2.6, 5.6, 0.55, 0xff44aa, -0.18),
    ];
  }

  buildDust() {
    const n = 700;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    const rand = mulberry32(42);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const r = 4 + rand() * 20;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rand() * 16;
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed[i] = rand();
    }
    const geo = this.track(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.dustU = this.uniformBag({ uTime: { value: 0 } });
    const mat = this.track(new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: this.dustU,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.scene.add(new THREE.Points(geo, mat));
  }

  // The zero-g card cloud over the table.
  buildCards() {
    const rand = mulberry32(1337);
    const geo = this.track(new THREE.PlaneGeometry(0.72, 1.0));
    for (let i = 0; i < CARD_COUNT; i++) {
      const rank = RANKS[Math.floor(rand() * RANKS.length)];
      const suit = SUITS[Math.floor(rand() * SUITS.length)];
      const tex = this.track(cardTexture(rank, suit));
      const u = this.uniformBag({
        uMap: { value: tex },
        uTint: { value: new THREE.Color(i % 3 === 0 ? 0xff66bb : 0x55ddff) },
        uTime: { value: 0 },
        uSeed: { value: rand() },
      });
      const mat = this.track(new THREE.ShaderMaterial({
        vertexShader: CARD_VERT,
        fragmentShader: CARD_FRAG,
        uniforms: u,
        transparent: true,
        side: THREE.DoubleSide,
      }));
      const mesh = new THREE.Mesh(geo, mat);
      const state = makeDriftState(rand);
      mesh.position.set(...state.pos);
      mesh.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      mesh.userData.uniforms = u;
      this.scene.add(mesh);
      this.cards.push(mesh);
      this.cardStates.push(state);
    }
  }

  // Entrance → sweep past the decorations → descend to the table → orbit.
  buildFlightPath() {
    this.flyPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 4.8, 21.5),   // just inside the entrance arch
      new THREE.Vector3(0, 4.9, 16.5),   // gliding down the grand aisle
      new THREE.Vector3(-7.5, 6.2, 12.5), // sweep left, obelisks in view
      new THREE.Vector3(-12.5, 7.6, 0.0), // balcony height, dome + chips
      new THREE.Vector3(-8.0, 6.0, -10.5),
      new THREE.Vector3(2.0, 4.6, -11.5),
      new THREE.Vector3(8.5, 3.6, -5.0), // start the descent
      new THREE.Vector3(7.0, 3.1, 3.5),  // arrive over the felt
    ], false, 'centripetal');
    this.flyTargets = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 6.5, 0),      // chandelier ahead, not the far wall
      new THREE.Vector3(0, 6.5, 0),
      new THREE.Vector3(0, 7.5, 0),      // chandelier
      new THREE.Vector3(0, 9.0, 0),      // up through the dome
      new THREE.Vector3(0, 6.0, 0),
      new THREE.Vector3(0, 3.5, 0),
      new THREE.Vector3(0, 2.6, 0),
      new THREE.Vector3(0, 2.4, 0),
    ], false, 'centripetal');
    this.idleCenter = new THREE.Vector3(0, 2.55, 0);
    this.idleRadius = 7.2;
    this.idleHeight = 3.4;
    // Blend out of the exact arrival pose so there is no pop at t = 1.
    this.arrivePos = this.flyPath.getPoint(1);
    this.arriveTarget = this.flyTargets.getPoint(1);
  }

  loadCasino() {
    // Resolve against this module, not the page URL: the app may be served
    // from a path without a trailing slash, where a bare relative URL would
    // escape the game directory.
    const url = new URL('../assets/casino.glb', import.meta.url);
    new GLTFLoader().load(url.href, (gltf) => {
      if (this.destroyed) return;
      const root = gltf.scene;
      const toRemove = [];
      root.traverse((o) => {
        if (o.isLight) { toRemove.push(o); return; } // own lighting instead
        if (!o.isMesh) return;
        const name = o.name || '';
        const m = o.material;
        // Blender exports emission strengths of 8–14, which nukes the bloom
        // pass; pull them into a cinematic range and only pulse true neons.
        if (m && m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.01) {
          m.emissiveIntensity *= 0.3;
          this.neonMats.push({
            mat: m, base: m.emissiveIntensity, phase: Math.random() * Math.PI * 2,
          });
        }
        if (name.startsWith('FloatChip_')) {
          this.chips.push({ obj: o, baseY: o.position.y, phase: Math.random() * 7 });
        }
        if (name.startsWith('SuitCrystal_')) {
          this.crystals.push({ obj: o, baseY: o.position.y, phase: Math.random() * 7 });
        }
        if (name === 'ChandelierStar') this.star = o;
      });
      toRemove.forEach((o) => o.parent && o.parent.remove(o));
      this.scene.add(root);
    }, undefined, (err) => {
      // No GLB (e.g. opened from file://): keep sky/cards — still a menu.
      console.warn('menu3d: casino.glb failed to load', err);
    });
  }

  // --- per-frame ------------------------------------------------------------

  tick(dt) {
    const t = this.clock.elapsedTime;
    for (const u of this.uniforms) {
      if (u.uTime) u.uTime.value = t;
    }

    // Zero-g card drift + tumble.
    for (let i = 0; i < this.cards.length; i++) {
      const s = stepDrift(this.cardStates[i], dt, t);
      const mesh = this.cards[i];
      mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
      mesh.rotateOnAxis(new THREE.Vector3(...s.axis), s.spin * dt);
    }

    // Casino set dressing.
    for (const c of this.chips) {
      c.obj.position.y = c.baseY + Math.sin(t * 0.5 + c.phase) * 0.45;
      c.obj.rotation.y += dt * 0.25;
      c.obj.rotation.x += dt * 0.06;
    }
    for (const c of this.crystals) {
      c.obj.position.y = c.baseY + Math.sin(t * 0.7 + c.phase) * 0.25;
      c.obj.rotation.y += dt * 0.5;
    }
    if (this.star) {
      const p = 0.55 + Math.sin(t * 1.6) * 0.05;
      this.star.scale.set(p, p, p);
      this.star.rotation.y += dt * 0.4;
    }
    for (const b of this.bands || []) b.rotation.y += dt * b.userData.speed;
    for (const n of this.neonMats) {
      n.mat.emissiveIntensity = n.base * (0.82 + 0.18 * Math.sin(t * 1.3 + n.phase));
    }

    this.updateCamera(dt);
    try {
      this.composer.render();
    } catch (err) {
      // Some GPUs can't handle the bloom chain's float buffers — degrade to
      // a plain render; if even that fails, give the stage back to CSS.
      if (!this.plainRender) {
        this.plainRender = true;
        console.warn('menu3d: bloom pipeline failed, falling back', err);
      }
      try {
        this.renderer.render(this.scene, this.camera);
      } catch (e) {
        console.warn('menu3d: renderer failed', e);
        this.destroy();
      }
    }
  }

  updateCamera(dt) {
    if (this.flyT < 1) {
      this.flyT = clamp01(this.flyT + dt / FLY_SECONDS);
      const k = easeInOutCubic(this.flyT);
      this.camera.position.copy(this.flyPath.getPoint(k));
      this.camera.lookAt(this.flyTargets.getPoint(k));
      // Seed the idle orbit with the arrival bearing to avoid a jump.
      const p = this.camera.position;
      this.idleAngle = Math.atan2(p.z, p.x);
      return;
    }
    this.idleAngle += dt * 0.07;
    const px = Math.cos(this.idleAngle) * this.idleRadius + this.pointer.x * 0.5;
    const pz = Math.sin(this.idleAngle) * this.idleRadius;
    const py = this.idleHeight - this.pointer.y * 0.35
      + Math.sin(this.clock.elapsedTime * 0.3) * 0.18;
    // Ease from the stored arrival pose into the orbit on the first frames.
    const target = new THREE.Vector3(px, py, pz);
    this.camera.position.lerp(target, Math.min(1, dt * 2.5));
    this.camera.lookAt(this.idleCenter);
  }

  resize() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    removeEventListener('pointermove', this.onPointer);
    removeEventListener('pointerdown', this.onSkip);
    removeEventListener('keydown', this.onSkip);
    for (const d of this.disposables) d.dispose && d.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const key of Object.keys(m)) {
            if (m[key] && m[key].isTexture) m[key].dispose();
          }
          m.dispose();
        }
      }
    });
    if (this.bloom) this.bloom.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.container.classList.add('menu3d-stage--off');
  }
}
