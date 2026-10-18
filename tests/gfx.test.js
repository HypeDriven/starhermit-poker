// Graphics quality model (src/gfx.js) and the Graphics panel strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// src/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../src/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const {
  PRESETS, CATEGORIES, detectPreset, detectLevel, presetForLevel, budgetFor, particleCounts, resolve, presetTier,
  choosePreset, describe, pixelRatio, LEVELS, BUDGETS, STAR_MAX, MOTE_MAX, DUST_MAX,
} = await import('../src/gfx.js');
import { STRINGS, LOCALES, pickLocale, strings } from '../src/gfx-i18n.js';

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M1', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'card', 'felt', 'curve', 'chip', 'stars', 'motes', 'dust', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].card), [128, 256, 256, 512]);
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).stars > budgetFor('balanced', 4).stars, 'counts scale up within the preset');
  const top = budgetFor('ultra', 20);
  assert.ok(top.stars <= STAR_MAX && top.motes <= MOTE_MAX && top.dust <= DUST_MAX);
  const hi = resolve({ preset: 'high' }, 'low', 10);
  assert.deepEqual(particleCounts(hi), { stars: 240, motes: 220, dust: 700 });
  assert.deepEqual(particleCounts(resolve({ preset: 'high', particles: 'low' }, 'low', 10)), { stars: 120, motes: 0, dust: 259 });
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('graphics summary level label in every locale', () => {
  for (const loc of LOCALES) assert.match(strings(loc).level(7), /7$/, loc);
});

test('resolve: auto uses the detected preset; explicit preset wins', () => {
  const auto = resolve({}, 'low');
  assert.equal(auto.preset, 'low');
  assert.equal(auto.auto, true);
  assert.equal(auto.shadows, 'off');
  assert.equal(auto.post, false, 'Low renders without post-processing');
  const high = resolve({ preset: 'high' }, 'low');
  assert.equal(high.preset, 'high');
  assert.equal(high.auto, false);
  assert.equal(high.shadows, presetTier('high', 'shadows'));
  assert.equal(high.post, true);
  assert.equal(resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
});

test('resolve: per-category overrides apply, invalid tiers fall back to the preset', () => {
  const r = resolve({ preset: 'high', bloom: 'off', ao: 'off', grade: 'off', antialias: 'msaa', shadows: 'nope' }, 'low');
  assert.equal(r.bloom, 'off');
  assert.equal(r.shadows, presetTier('high', 'shadows'));
  assert.equal(r.post, false, 'nothing left that needs the composer');
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('resolve: render scale is clamped to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).userScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).userScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({}).adaptive, true);
  assert.equal(resolve({ adaptive: false }).adaptive, false);
  assert.equal(resolve({}).showFps, false);
});

test('pixel ratio is capped per preset so Low stays cheap', () => {
  assert.equal(pixelRatio(resolve({ preset: 'low' }), 3), 1);
  assert.equal(pixelRatio(resolve({ preset: 'balanced' }), 3), 1.5);
  assert.equal(pixelRatio(resolve({ preset: 'high' }), 3), 2);
  assert.equal(pixelRatio(resolve({ preset: 'high' }), 2, 0.6), 1.2);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const next = choosePreset({ preset: 'high', bloom: 'off', shadows: 'high', render_scale: 1.5, show_fps: true }, 'low');
  assert.deepEqual(next, { preset: 'low', render_scale: 1.5, show_fps: true });
  assert.equal(choosePreset({ bloom: 'on' }, 'auto').preset, 'auto');
});

test('describe summarises cost and pixel size', () => {
  const s = describe(resolve({ preset: 'high' }), [2560, 1440]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /ambient occlusion/);
  assert.match(s, /SMAA/);
  assert.match(s, /2560×1440 px/);
  assert.match(describe(resolve({ preset: 'low' })), /^no shadows/);
});

test('every locale translates every Graphics panel string', () => {
  const keys = Object.keys(STRINGS['en-US']).filter((k) => !/^tier_(fxaa|smaa|msaa)$/.test(k));
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(LOCALES.includes(loc), loc);
    for (const k of keys) assert.ok(STRINGS[loc][k] !== undefined || loc === 'en-GB', `${loc}.${k}`);
    const t = strings(loc);
    assert.equal(typeof t.auto('x'), 'string');
    assert.equal(typeof t.fromPreset('x'), 'string');
  }
  assert.equal(strings('en-GB').cat_grade, 'Colour grade');
});

test('pickLocale falls back by language and region', () => {
  assert.equal(pickLocale('es-MX'), 'es-419');
  assert.equal(pickLocale('es'), 'es-419');
  assert.equal(pickLocale('es-ES'), 'es-ES');
  assert.equal(pickLocale('fr-CA'), 'fr-CA');
  assert.equal(pickLocale('fr-BE'), 'fr-FR');
  assert.equal(pickLocale('en-AU'), 'en-GB');
  assert.equal(pickLocale('pt-PT'), 'pt-BR');
  assert.equal(pickLocale('ja-JP'), 'en-US');
});
