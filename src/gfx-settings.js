// Graphics settings store (browser side of gfx.js): GPU detection, the saved
// settings in localStorage, change notification, and the page-level bits
// every renderer shares — <body data-gfx-*> attributes and the FPS readout.
// No three.js import, so DOM-only screens can use it cheaply.

import { resolve, detectPreset, choosePreset } from './gfx.js';

export const STORAGE_KEY = 'poker.graphics';

function readSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function writeSaved(v) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch { /* private mode */ }
}

// The unmasked renderer string from a throwaway context (released at once).
function probeGpu() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return String(name || '');
  } catch { return ''; }
}

const isMobile = () => typeof matchMedia === 'function'
  && (matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || ''));

export const reducedMotion = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

class GraphicsSettings {
  constructor() {
    this.saved = readSaved();
    this.gpu = null;
    this.detected = null;
    this.listeners = new Set();
    this.view = null; // the renderer currently on screen (for panel info)
  }

  _detect() {
    if (this.detected) return;
    this.gpu = probeGpu();
    this.detected = detectPreset(this.gpu, { mobile: isMobile() });
  }

  get resolved() {
    this._detect();
    return resolve(this.saved, this.detected);
  }

  /** Merge a patch into the saved settings ('preset' value removes an override). */
  set(patch) {
    const next = { ...this.saved };
    for (const [k, v] of Object.entries(patch)) {
      if (v === 'preset' || v === undefined) delete next[k];
      else next[k] = v;
    }
    this._commit(next);
  }

  /** Choosing a preset clears every per-category override. */
  setPreset(preset) {
    this._commit(choosePreset(this.saved, preset));
  }

  _commit(next) {
    this.saved = next;
    writeSaved(next);
    this.applyPage();
    for (const fn of [...this.listeners]) fn(this.resolved);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Reflect the resolved settings on <body> (DOM styling + e2e hooks) and the FPS readout. */
  applyPage() {
    if (typeof document === 'undefined' || !document.body) return;
    const r = this.resolved;
    const b = document.body.dataset;
    b.gfxPreset = r.preset;
    b.gfxAuto = String(r.auto);
    b.gfxDetail = r.detail;
    b.gfxBackground = r.background;
    showFps(r.showFps);
  }

  /** Renderers register while on screen so the panel can show size/post status. */
  attach(view) { this.view = view; }
  detach(view) { if (this.view === view) this.view = null; }
}

export const graphics = new GraphicsSettings();

// ---------------------------------------------------------------- FPS readout

let meter = null;
let meterFrames = [];
let meterRaf = 0;

function showFps(on) {
  if (on && !meter) {
    meter = document.createElement('div');
    meter.id = 'fps-meter';
    meter.setAttribute('aria-hidden', 'true');
    meter.textContent = '– fps';
    document.body.append(meter);
    // Page-level frame timing: works on DOM-only screens too.
    let last = performance.now();
    const tick = (now) => {
      meterFrames.push(now - last);
      last = now;
      if (meterFrames.length >= 30) {
        const avg = meterFrames.reduce((a, b) => a + b, 0) / meterFrames.length;
        meterFrames = [];
        const v = graphics.view;
        const ratio = v && v.pixelRatio ? ` · ${Math.round(v.pixelRatio * 100) / 100}×` : '';
        meter.textContent = `${Math.round(1000 / avg)} fps${ratio}`;
      }
      meterRaf = requestAnimationFrame(tick);
    };
    meterRaf = requestAnimationFrame(tick);
  } else if (!on && meter) {
    cancelAnimationFrame(meterRaf);
    meter.remove();
    meter = null;
    meterFrames = [];
  }
}
