import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './harness.js';

const { pokerRules } = loadScript('server.js');
const { evaluate, compareScores, evaluateHoldem } = pokerRules;

// Card helper: rank '2'..'A', suit 'c','d','h','s' -> int.
function C(str) {
  const ranks = '23456789TJQKA';
  const suits = 'cdhs';
  return ranks.indexOf(str[0]) + 13 * suits.indexOf(str[1]);
}
const hand = (str) => str.split(' ').map(C);

test('every category is ranked correctly', () => {
  const cases = [
    ['As Ks Qs Js Ts 9h 2d', 8], // royal = straight flush
    ['9c 8c 7c 6c 5c Ah 2d', 8], // straight flush
    ['9h 9d 9s 9c Kh 2d 3c', 7], // quads
    ['9h 9d 9s Kc Kh 2d 3c', 6], // full house
    ['Ah Kh 9h 5h 2h 3d 4d', 5], // flush
    ['9c 8d 7h 6s 5d Ah 2c', 4], // straight
    ['9h 9d 9s Kc Qh 2d 3c', 3], // trips
    ['9h 9d Ks Kc Qh 2d 3c', 2], // two pair
    ['9h 9d Ks Qc Jh 2d 3c', 1], // one pair
    ['Ah Kd Qs 9c 5h 3d 2c', 0], // high card
  ];
  for (const [cards, cat] of cases) {
    assert.equal(evaluate(hand(cards)).category, cat, cards);
  }
});

test('wheel straight A-2-3-4-5 is five-high', () => {
  const wheel = evaluate(hand('Ah 2d 3c 4s 5h 9d Kc'));
  assert.equal(wheel.category, 4);
  assert.equal(wheel.score[1], 3); // five high
  // Loses to a six-high straight.
  const six = evaluate(hand('2h 3d 4c 5s 6h 9d Kc'));
  assert.ok(compareScores(wheel.score, six.score) < 0);
  // Ace plays low only: A-2-3-4-6 is not a straight.
  assert.notEqual(evaluate(hand('Ah 2d 3c 4s 6h 9d Kc')).category, 4);
});

test('kickers decide ties', () => {
  const a = evaluate(hand('Ah Ad Ks 9c 5h 3d 2c')); // pair of aces, K kicker
  const b = evaluate(hand('Ah Ad Qs 9c 5h 3d 2c')); // pair of aces, Q kicker
  assert.ok(compareScores(a.score, b.score) > 0);
});

test('identical hands tie exactly', () => {
  const a = evaluate(hand('Ah Kh Qd Jc 9s 3d 2c'));
  const b = evaluate(hand('As Ks Qh Jd 9c 3h 2s'));
  assert.equal(compareScores(a.score, b.score), 0);
});

test('board-only hand (playing the board)', () => {
  // Board is a royal flush; any hole cards tie.
  const v = evaluateHoldem(hand('2d 3c'), hand('As Ks Qs Js Ts'));
  assert.equal(v.category, 8);
});

test('best five of seven is selected (wheel straight flush beats flush)', () => {
  // A-2-3-4-5 of hearts from seven cards: the straight flush outranks the
  // plain flush and the wheel straight.
  const v = evaluate(hand('Ah 2h 3h 4h 5h 6d 7d'));
  assert.equal(v.category, 8);
  assert.equal(v.score[1], 3); // five-high
});

test('straight flush beats quads beats full house', () => {
  const sf = evaluate(hand('5h 6h 7h 8h 9h Ad Kd'));
  const q = evaluate(hand('9s 9d 9c 9h Ad Kd Qd'));
  const fh = evaluate(hand('As Ac Ad Ks Kh Qd Jd'));
  assert.ok(compareScores(sf.score, q.score) > 0);
  assert.ok(compareScores(q.score, fh.score) > 0);
});

test('two-pair ordering and fifth kicker', () => {
  const a = evaluate(hand('Ah As Kd Kc 2h 3d 4c')); // A-A-K-K
  const b = evaluate(hand('Ah As Qd Qc Kh 3d 4c')); // A-A-Q-Q K kicker
  assert.ok(compareScores(a.score, b.score) > 0);
  const c = evaluate(hand('Kh Ks Qd Qc Ah 3d 4c')); // K-K-Q-Q A kicker
  assert.ok(compareScores(b.score, c.score) > 0); // higher second pair wins
});

test('full house: higher trips win; trips+kicker ordering', () => {
  const a = evaluate(hand('Kh Kd Ks 2c 2h 5d 6c'));
  const b = evaluate(hand('Qh Qd Qs Ac Ah 5d 6c'));
  assert.ok(compareScores(a.score, b.score) > 0);
});

test('descriptions are human-readable', () => {
  assert.match(evaluate(hand('As Ks Qs Js Ts 9h 2d')).description, /Straight Flush/);
  assert.match(evaluate(hand('9h 9d 9s Kc Kh 2d 3c')).description, /Full House, Nines over Kings/);
  assert.match(evaluate(hand('Ah 2d 3c 4s 5h 9d Kc')).description, /Straight, Five high/);
});
