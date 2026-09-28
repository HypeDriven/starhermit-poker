// Graphics quality model (src/gfx.js) and the Graphics panel strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, resolve, presetTier, choosePreset, describe, pixelRatio,
} from '../src/gfx.js';
import { STRINGS, LOCALES, pickLocale, strings } from '../src/gfx-i18n.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2 Pro'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Mali-G78'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  assert.equal(detectPreset(null), 'balanced');
});

test('detectPreset caps touch/mobile devices at balanced', () => {
  assert.equal(detectPreset('Apple M1', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
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
