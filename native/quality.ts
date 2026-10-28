// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the star, mote and menu-dust counts scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// StarHermit hardware level. The runtime owns the rest of what the old
// Settings → Graphics panel did: Auto and the level choice, render scale and
// the pixel-ratio cap, adaptive resolution, the frame-rate limit and readout.
// The old panel's per-effect overrides are not offered (the runtime's Options
// choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Table, card and chip shading: Lambert (Low), Standard (Balanced), Physical — clear-coated rail, cards, chips (High/Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Card-face texture width (px; authored 256 × 356). */
  card: 128 | 256 | 512;
  /** Printed felt texture width (px; Detailed table). */
  felt: 512 | 1024 | 2048;
  /** Table ellipse curve segments (felt, rail, base, trims, floor). */
  curve: number;
  /** Chip radial segments. */
  chip: number;
  stars: number;
  motes: number;
  dust: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map size (0: off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** Image-based reflections from a RoomEnvironment. */
  reflections: boolean;
  /** Table detail: woven baize, padded leather rail, rounded lacquered cards, clay chips, the spill-light pool. */
  detailed: boolean;
  particles: "low" | "high";
  /** Shimmering key light, pulsing seat ring, drifting motes and nebula (Static freezes them). */
  animated: boolean;
  budget: Budget;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "low", animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", card: 128, felt: 512, curve: 48, chip: 20, stars: 120, motes: 80, dust: 300, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", card: 256, felt: 1024, curve: 64, chip: 28, stars: 180, motes: 140, dust: 450, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", card: 256, felt: 1024, curve: 96, chip: 40, stars: 240, motes: 220, dust: 700, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", card: 512, felt: 2048, curve: 128, chip: 48, stars: 360, motes: 360, dust: 1000, bloomRes: 1, aoRes: 1 },
};
export const STAR_MAX = 720;
export const MOTE_MAX = 720;
export const DUST_MAX = 2000;
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: effect counts grow with the level above the tier's first, at most 2×.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.stars = Math.min(STAR_MAX, Math.round(b.stars * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return { preset, ...TABLE[preset], budget: b };
}

/** gfx.js particleCounts: the Particles tier's share of the preset's budget. */
export function particleCounts(look: Look): { stars: number; motes: number; dust: number } {
  const high = look.particles === "high";
  return {
    stars: high ? look.budget.stars : Math.round(look.budget.stars / 2),
    motes: high ? look.budget.motes : 0,
    dust: high ? look.budget.dust : Math.round(look.budget.dust * 0.37),
  };
}
