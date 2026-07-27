import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seatVisual, seatUnit, presetTotal, visibleCardsForSeat,
} from '../src/table-utils.js';

test('seatVisual puts the player at position 0 and rotates others', () => {
  assert.equal(seatVisual(2, 2), 0);       // own seat bottom center
  assert.equal(seatVisual(3, 2), 1);
  assert.equal(seatVisual(0, 2), 4);
  assert.equal(seatVisual(5, 0), 5);
});

test('seatUnit is on the unit circle and own seat is bottom center', () => {
  for (let v = 0; v < 6; v++) {
    const { x, y } = seatUnit(v);
    assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-9);
  }
  const own = seatUnit(0);
  assert.ok(Math.abs(own.x) < 1e-9 && own.y > 0.99, 'own seat not at bottom');
});

test('visibleCardsForSeat never exposes an opponent reveal during a live hand', () => {
  const opponent = { seat: 2, inHand: true };
  const you = { seat: 0, holeCards: [12, 25] };
  assert.deepEqual(visibleCardsForSeat(opponent, you, { 2: [50, 51] }), [-1, -1]);
  assert.deepEqual(visibleCardsForSeat({ seat: 0, inHand: true }, you, {}), [12, 25]);
});

test('visibleCardsForSeat allows only post-hand public reveals', () => {
  assert.deepEqual(
    visibleCardsForSeat({ seat: 2, inHand: false }, { seat: 0 }, { 2: [50, 51] }),
    [50, 51]);
  assert.equal(visibleCardsForSeat({ seat: 2, inHand: false }, { seat: 0 }, {}), null);
});

test('presetTotal honors the new-total convention and clamps', () => {
  const la = { minimumAmount: 200, maximumAmount: 5000, callAmount: 300 };
  assert.equal(presetTotal(la, 100, 1000, 'min'), 200);
  assert.equal(presetTotal(la, 100, 1000, 'all'), 5000);
  // 1/2 pot after calling: 100 + 300 + ceil(0.5 * 1300) = 1050.
  assert.equal(presetTotal(la, 100, 1000, 0.5), 1050);
  // Pot: 100 + 300 + 1300 = 1700.
  assert.equal(presetTotal(la, 100, 1000, 1), 1700);
  // Clamped to the maximum when the pot is huge.
  assert.equal(presetTotal(la, 100, 999999, 1), 5000);
});
