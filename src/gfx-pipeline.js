// Shared three.js render pipeline for the menu casino and the poker table:
// owns the WebGLRenderer (recreated only when canvas MSAA must change), the
// pixel ratio (preset cap × render scale × adaptive scale), the shadow map,
// and the post chain (RenderPass → [sanitize] → GTAO → UnrealBloom → grade →
// OutputPass → SMAA/FXAA). Settings apply live via apply(resolved).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { SHADOW_MAP, pixelRatio } from './gfx.js';
import { graphics } from './gfx-settings.js';

// Colour grade + vignette (display-space colours in, display-space out):
// gentle S-curve contrast, a touch more saturation, warm highlights / cool
// shadows. Blacks are lifted a hair so dark UI-adjacent areas never crush.
export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.05, 1.0, 0.94), smoothstep(0.15, 0.85, l));
      s = s * 0.975 + 0.012;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

export class GfxPipeline {
  /**
   * opts: container, scene, camera,
   *   configure(renderer)  — tone mapping etc. on each (re)created renderer,
   *   onRenderer(renderer) — after (re)creation (env maps, canvas listeners),
   *   prePasses()          — extra passes right after the RenderPass,
   *   subset               — categories this view honours (null = all),
   *   bloom                — { strength, radius, threshold },
   *   alpha                — transparent canvas when rendering directly.
   */
  constructor(opts) {
    this.o = opts;
    this.container = opts.container;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.size = [0, 0];
    this.pixelRatio = 1;
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null;
    this.composer = null;
    this.postFailed = false;
    this.q = null;
    this.renderer = null;
    this._unsub = graphics.subscribe((q) => this.apply(q));
    graphics.attach(this);
    this.apply(graphics.resolved);
  }

  honours(cat) {
    return !this.o.subset || this.o.subset.includes(cat);
  }

  _createRenderer(msaa) {
    const old = this.renderer;
    const r = new THREE.WebGLRenderer({
      antialias: msaa, alpha: !!this.o.alpha, powerPreference: 'high-performance',
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    if (this.o.configure) this.o.configure(r);
    if (old) {
      old.domElement.replaceWith(r.domElement);
      this._disposeComposer();
      old.dispose();
    } else {
      this.container.appendChild(r.domElement);
    }
    this.renderer = r;
    this.msaa = msaa;
    this.size = [0, 0];
    this.postKey = null;
    if (this.o.onRenderer) this.o.onRenderer(r);
  }

  /** Apply resolved settings live. */
  apply(q) {
    const eff = { ...q };
    if (!this.honours('shadows')) eff.shadows = 'off';
    if (!this.honours('ao')) eff.ao = 'off';
    if (!this.honours('grade')) eff.grade = 'off';
    if (!this.honours('bloom')) eff.bloom = 'off';
    eff.post = eff.ao !== 'off' || eff.bloom === 'on' || eff.grade === 'on'
      || eff.antialias === 'fxaa' || eff.antialias === 'smaa';
    this.q = eff;
    // Canvas MSAA is a context attribute: only used when rendering directly.
    const msaa = eff.antialias === 'msaa';
    if (!this.renderer || (msaa !== this.msaa && !eff.post)) this._createRenderer(msaa);
    const r = this.renderer;
    const size = SHADOW_MAP[eff.shadows];
    const wasShadows = r.shadowMap.enabled;
    r.shadowMap.enabled = size > 0;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    if (this.o.shadowLights) {
      for (const light of this.o.shadowLights()) {
        light.castShadow = size > 0;
        if (size > 0 && light.shadow.mapSize.x !== size) {
          light.shadow.mapSize.set(size, size);
          light.shadow.map?.dispose();
          light.shadow.map = null;
        }
      }
    }
    if (wasShadows !== r.shadowMap.enabled) {
      // Materials pick up shadow-map changes on recompile.
      this.scene.traverse((o) => {
        const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of mats) m.needsUpdate = true;
      });
    }
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild on the next frame
    this.postFailed = false;
    if (this.o.onApply) this.o.onApply(q);
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this._disposeComposer();
    if (!g.post || this.postFailed) return;
    try {
      const pw = Math.max(1, Math.round(w * this.pixelRatio));
      const ph = Math.max(1, Math.round(h * this.pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      for (const pass of this.o.prePasses ? this.o.prePasses() : []) composer.addPass(pass);
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        // Decals and glows (transparent, no depth write) must not occlude:
        // hide them from GTAO's depth/normal pass as it already does for points.
        // A texture scene.background is drawn as a plane, which the override
        // material would place in the world as a depth-writing quad — so the
        // background is lifted out of that pass too.
        const hide = ao.overrideVisibility.bind(ao);
        const restore = ao.restoreVisibility.bind(ao);
        let bg = null;
        ao.overrideVisibility = () => {
          hide();
          bg = this.scene.background;
          this.scene.background = null;
          this.scene.traverse((o) => {
            const m = o.material;
            if (o.userData.noAO || (m && !Array.isArray(m) && m.transparent && !m.depthWrite)) o.visible = false;
          });
        };
        ao.restoreVisibility = () => {
          restore();
          this.scene.background = bg;
        };
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        const b = this.o.bloom || { strength: 0.5, radius: 0.45, threshold: 0.9 };
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), b.strength, b.radius, b.threshold));
      }
      composer.addPass(new OutputPass());
      // The grade works on display-referred colour, after tone mapping.
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if the chain
      // cannot be built (the Graphics panel says so).
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(dt) {
    if (!this.q.adaptive) return false;
    const f = this._frames;
    f.push(dt);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  /** Current drawing-buffer size in device pixels. */
  pixels() {
    return [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
  }

  render(dtMs = 16) {
    const r = this.renderer;
    if (!r) return;
    const rescale = this._adapt(dtMs);
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    // The canvas sits inside the CSS-zoomed #app (ui-scale.js): render at layout size x zoom.
    const ratio = pixelRatio(this.q, window.devicePixelRatio || 1, this.adaptiveScale) * ((window.UIScale && UIScale.value) || 1);
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      r.setPixelRatio(ratio);
      r.setSize(w, h, false);
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try {
        this.composer.render(dtMs / 1000);
        return;
      } catch {
        // Latch the fallback: a chain that fails intermittently would flicker.
        this.postFailed = true;
        this._disposeComposer();
      }
    }
    r.render(this.scene, this.camera);
  }

  _disposeComposer() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) pass.dispose?.();
    this.composer.dispose();
    this.composer = null;
  }

  dispose() {
    this._unsub();
    graphics.detach(this);
    this._disposeComposer();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
  }
}
