// Graphics quality model: presets, per-category overrides, StarHermit hardware-level
// detection, per-preset asset/effect budgets and a cost summary. Pure (no three.js, no DOM) so the settings panel, the 3D
// renderers and the node tests all agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  detail: ['plain', 'detailed'],
  particles: ['low', 'high'],
  background: ['static', 'animated'],
};

// Each preset is a row of tiers plus a render scale (multiplies the device
// pixel ratio) and a pixel-ratio cap, so Low never costs more than the game
// did before the upgrade.
const TABLE = {
  low: { scale: 1, maxRatio: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', background: 'static' },
  balanced: { scale: 1, maxRatio: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'low', background: 'animated' },
  high: { scale: 1, maxRatio: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  ultra: { scale: 1.25, maxRatio: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; src/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Cards, chips, seats,
 * the action bar and the rules are identical on every preset — only visuals change.
 *   material  table, card and chip shading: lambert (Low) / standard (Balanced) / physical — clear-coated
 *             rail, cards and chips, leather sheen (High, Ultra)
 *   card      card-face texture width in px (authored at 256 × 356)
 *   felt      printed felt texture width in px (Table detail: Detailed; authored at 1024 × 592)
 *   curve     table ellipse curve segments (felt, rail, base and trims)
 *   chip      chip cylinder radial segments
 *   stars     backdrop star points (Particles low: half), scaled with the level
 *   motes     dust motes in the key light (Particles high), scaled with the level
 *   dust      menu casino dust motes (Particles low: 37 %), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', card: 128, felt: 512, curve: 48, chip: 20, stars: 120, motes: 80, dust: 300, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', card: 256, felt: 1024, curve: 64, chip: 28, stars: 180, motes: 140, dust: 450, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', card: 256, felt: 1024, curve: 96, chip: 40, stars: 240, motes: 220, dust: 700, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', card: 512, felt: 2048, curve: 128, chip: 48, stars: 360, motes: 360, dust: 1000, bloomRes: 1, aoRes: 1 },
};
export const STAR_MAX = 720;
export const MOTE_MAX = 720;
export const DUST_MAX = 2000;

/** A preset's concrete budget for a hardware level (effect counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.stars = Math.min(STAR_MAX, Math.round(b.stars * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return b;
}

/** Live particle counts for resolved settings (the Particles tier's share of the preset's budget). */
export function particleCounts(r) {
  const high = r.particles === 'high';
  return {
    stars: high ? r.budget.stars : Math.round(r.budget.stars / 2),
    motes: high ? r.budget.motes : 0,
    dust: high ? r.budget.dust : Math.round(r.budget.dust * 0.37),
  };
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, userScale, scale: row.scale * userScale, maxRatio: row.maxRatio };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas's own MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on'
    || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Saved settings after choosing a preset: overrides are cleared, scale/toggles kept. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const next = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  for (const k of ['render_scale', 'adaptive', 'show_fps']) if (k in s) next[k] = s[k];
  return next;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

const EN = {
  noShadows: 'no shadows',
  shadows: (n) => `${n}² shadows`,
  ao: 'ambient occlusion',
  aoHigh: 'full ambient occlusion',
  bloom: 'bloom',
  reflections: 'reflections',
  noAa: 'no anti-aliasing',
};

/** Cost summary, e.g. "2048² shadows · ambient occlusion · bloom · SMAA · 2560×1440 px". */
export function describe(r, pixels, words = EN) {
  const w = { ...EN, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows(SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.aoHigh : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.reflections === 'on' ? w.reflections : null,
    r.antialias === 'off' ? w.noAa : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Device pixel ratio for a resolved setting (capped per preset, then adaptive). */
export function pixelRatio(r, dpr, adaptiveScale = 1) {
  const base = Math.min(dpr || 1, r.maxRatio);
  return clamp(base * r.scale * adaptiveScale, 0.25, 4);
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
