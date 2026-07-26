import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, deriveUnlocks } from '../src/achievements.js';

test('catalog keys are unique with required fields', () => {
  const keys = ACHIEVEMENTS.map((a) => a.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.name && a.description && Number.isInteger(a.points));
  }
});

test('derivation maps authoritative evidence to unlocks', () => {
  const u = deriveUnlocks({
    handsPlayed: 40, matchesWon: 1, bestStreak: 3, eliminations: 5,
    winningHands: [
      { category: 6, allIn: false, pot: 3000 },
      { category: 8, allIn: true, pot: 12000 },
    ],
  });
  for (const key of ['first-hand', 'first-win', 'streak-three', 'defeat-five',
    'win-full-house', 'win-straight-flush', 'win-all-in', 'win-10k-pot']) {
    assert.ok(u.has(key), key);
  }
  assert.ok(!u.has('win-quads'));
});

test('no evidence, no unlocks', () => {
  assert.equal(deriveUnlocks({}).size, 0);
  assert.equal(deriveUnlocks(null).size, 0);
});
