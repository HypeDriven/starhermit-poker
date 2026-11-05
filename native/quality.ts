// The look per graphics level. Shadows, AO, bloom, the grade and anti-aliasing
// come from the engine's levelSettings() for the frame's level; the art columns
// here (the browser build's src/gfx.js TABLE / BUDGETS) stay keyed by its
// quality tier, with the star, mote and menu-dust counts scaled within the tier
// by the level's particle budget (at most 2×). The runtime owns the rest of
// what the old Settings → Graphics panel did: Auto and the level choice, render scale and
// the pixel-ratio cap, adaptive resolution, the frame-rate limit and readout.
// The old panel's per-effect overrides are not offered (the runtime's Options
// choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0: off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null: off). */
  bloom: number | null;
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

type Art = Pick<Look, "reflections" | "detailed" | "particles" | "animated">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { reflections: true, detailed: true, particles: "low", animated: true },
  high: { reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", card: 128, felt: 512, curve: 48, chip: 20, stars: 120, motes: 80, dust: 300 },
  balanced: { material: "standard", card: 256, felt: 1024, curve: 64, chip: 28, stars: 180, motes: 140, dust: 450 },
  high: { material: "physical", card: 256, felt: 1024, curve: 96, chip: 40, stars: 240, motes: 220, dust: 700 },
  ultra: { material: "physical", card: 512, felt: 2048, curve: 128, chip: 48, stars: 360, motes: 360, dust: 1000 },
};
export const STAR_MAX = 720;
export const MOTE_MAX = 720;
export const DUST_MAX = 2000;
/** Each tier's first level: its budgets are authored for this level's particle budget. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  // Effect counts grow with the level's particle budget above the tier's first level, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.stars = Math.min(STAR_MAX, Math.round(b.stars * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  b.dust = Math.min(DUST_MAX, Math.round(b.dust * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
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
