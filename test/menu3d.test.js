// Menu 3D: zero-g drift physics and the casino GLB asset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  SHELL, makeDriftState, stepDrift, mulberry32, easeInOutCubic, clamp01,
} from '../src/menu3d-physics.js';

test('mulberry32 is deterministic', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
});

test('easeInOutCubic endpoints and midpoint', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
});

test('clamp01 bounds', () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.3), 0.3);
});

test('drift state starts inside the shell tube', () => {
  const rand = mulberry32(1);
  for (let i = 0; i < 50; i++) {
    const s = makeDriftState(rand);
    const dx = s.pos[0] - SHELL.center[0];
    const dz = s.pos[2] - SHELL.center[2];
    const radial = Math.hypot(dx, dz);
    assert.ok(Math.abs(radial - SHELL.radius) <= SHELL.tube / 2 + 1e-9);
    const len = Math.hypot(...s.axis);
    assert.ok(Math.abs(len - 1) < 1e-9, 'tumble axis is normalised');
  }
});

test('cards never escape: 10 minutes of drift stays bounded', () => {
  const rand = mulberry32(99);
  for (let i = 0; i < 10; i++) {
    const s = makeDriftState(rand);
    // Kick it hard outward first — the spring must reel it back.
    s.vel = [s.pos[0] * 2, 3, s.pos[2] * 2];
    let t = 0;
    for (let step = 0; step < 600 * 10; step++) {
      t += 1 / 60;
      stepDrift(s, 1 / 60, t);
    }
    const radial = Math.hypot(s.pos[0] - SHELL.center[0], s.pos[2] - SHELL.center[2]);
    const height = Math.abs(s.pos[1] - SHELL.center[1]);
    assert.ok(radial < SHELL.radius + SHELL.tube * 3, `radial ${radial}`);
    assert.ok(height < SHELL.tube * 3, `height ${height}`);
    assert.ok(Number.isFinite(s.pos[0]) && Number.isFinite(s.pos[1]));
  }
});

test('speed is capped', () => {
  const rand = mulberry32(5);
  const s = makeDriftState(rand);
  s.vel = [100, 100, 100];
  stepDrift(s, 1 / 60, 0);
  assert.ok(Math.hypot(...s.vel) <= SHELL.maxSpeed + 1e-9);
});

test('casino GLB exists and has a valid header', () => {
  assert.ok(existsSync('assets/casino.glb'), 'assets/casino.glb missing');
  const buf = readFileSync('assets/casino.glb');
  assert.equal(buf.toString('ascii', 0, 4), 'glTF');
  assert.equal(buf.readUInt32LE(4), 2, 'glTF version 2');
  assert.equal(buf.readUInt32LE(8), buf.length, 'declared length matches file');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  assert.ok(json.meshes.length > 100, 'hall geometry is present');
  const names = json.nodes.map((n) => n.name || '');
  for (const expected of ['TableFelt', 'Dome', 'ChandelierStar', 'FloorMain']) {
    assert.ok(names.includes(expected), `node ${expected} exported`);
  }
});
