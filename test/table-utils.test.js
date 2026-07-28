import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seatVisual, seatUnit, presetTotal, visibleCardsForSeat, describeLogEntry,
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

test('visibleCardsForSeat exposes only the addressed player cards', () => {
  const you = { seat: 0, holeCards: [12, 25] };
  assert.deepEqual(visibleCardsForSeat({ seat: 2, inHand: true }, you), [-1, -1]);
  assert.deepEqual(visibleCardsForSeat({ seat: 0, inHand: true }, you), [12, 25]);
  assert.equal(visibleCardsForSeat({ seat: 2, inHand: false }, you), null);
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

test('describeLogEntry renders feed lines as plain sentences', () => {
  const seats = [{ name: 'alice' }, { name: 'bob' }];
  assert.equal(describeLogEntry([3, 1, 0, 'fold', 0], seats), 'Alice folded.');
  assert.equal(describeLogEntry([4, 1, 1, 'timeout-fold', 0], seats), 'Bob ran out of time and folded.');
  assert.equal(describeLogEntry([5, 1, 0, 'check', 0], seats), 'Alice checked.');
  assert.equal(describeLogEntry([6, 1, 1, 'call', 200], seats), 'Bob called 200.');
  assert.equal(describeLogEntry([7, 1, 0, 'bet', 3000], seats), 'Alice bet 3,000.');
  assert.equal(describeLogEntry([8, 1, 1, 'raise', 400], seats), 'Bob raised 400.');
  assert.equal(describeLogEntry([9, 1, 0, 'blind', 100], seats), 'Alice posted a blind of 100.');
  assert.equal(describeLogEntry([10, 1, -1, 'street-flop', 0], seats), 'The flop was dealt.');
  // Unknown seats/actions degrade gracefully.
  assert.equal(describeLogEntry([11, 1, 5, 'fold', 0], seats), 'Seat 6 folded.');
  assert.equal(describeLogEntry([12, 1, 1, 'mystery', 50], seats), 'Bob mystery 50.');
});
