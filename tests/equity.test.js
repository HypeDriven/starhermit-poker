import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './harness.js';

const { pokerRules } = loadScript('server.js');

// Card int helpers: rank 0=2 .. 12=A, suit 0=clubs 1=diamonds 2=hearts 3=spades.
const c = (rank, suit) => suit * 13 + rank;
const A = 12, K = 11, Q = 10;

// Independent brute-force reference: enumerate every completion of the board
// and tally each seat's win fraction (ties split).
function bruteForceEquity(holesBySeat, board) {
  const known = new Set(board);
  for (const h of holesBySeat) if (h) for (const card of h) known.add(card);
  const remaining = [];
  for (let card = 0; card < 52; card++) if (!known.has(card)) remaining.push(card);
  const active = holesBySeat.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
  const wins = new Map(active.map((i) => [i, 0]));
  let trials = 0;
  const need = 5 - board.length;
  const combo = [];
  const visit = (start) => {
    if (combo.length === need) {
      const full = board.concat(combo);
      let best = null, leaders = [];
      for (const i of active) {
        const ev = pokerRules.evaluateHoldem(holesBySeat[i], full);
        if (!best || pokerRules.compareScores(ev.score, best) > 0) {
          best = ev.score; leaders = [i];
        } else if (pokerRules.compareScores(ev.score, best) === 0) leaders.push(i);
      }
      for (const i of leaders) wins.set(i, wins.get(i) + 1 / leaders.length);
      trials += 1;
      return;
    }
    for (let k = start; k < remaining.length; k++) {
      combo.push(remaining[k]);
      visit(k + 1);
      combo.pop();
    }
  };
  visit(0);
  return active.map((i) => wins.get(i) / trials);
}

test('equity: no active seats yields all null; one active seat wins by default', () => {
  assert.deepEqual(pokerRules.equity([null, null], []), [null, null]);
  assert.deepEqual(pokerRules.equity([[c(A, 0), c(A, 1)], null, null], []), [1, null, null]);
});

test('equity: exact on the turn/river and matches brute force', () => {
  const holes = [[c(A, 2), c(A, 1)], [c(0, 0), c(1, 0)]]; // A♥A♦ vs 2♣3♣
  const turn = [c(3, 0), c(4, 1), c(6, 3), c(7, 2)];      // 5♣6♦8♠9♥
  for (const board of [turn, turn.concat([c(Q, 3)])]) {
    const eq = pokerRules.equity(holes, board);
    const ref = bruteForceEquity(holes, board);
    assert.ok(Math.abs(eq[0] - ref[0]) < 1e-9, `seat 0: ${eq[0]} vs ${ref[0]}`);
    assert.ok(Math.abs(eq[1] - ref[1]) < 1e-9, `seat 1: ${eq[1]} vs ${ref[1]}`);
  }
});

test('equity: complete board is decided exactly', () => {
  // Board: A♠ K♠ Q♠ J♠ T♠ — a royal flush on board; everyone ties.
  const board = [c(A, 3), c(K, 3), c(Q, 3), c(9, 3), c(8, 3)];
  const eq = pokerRules.equity([[c(0, 0), c(0, 1)], [c(1, 2), c(2, 1)]], board);
  assert.ok(Math.abs(eq[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(eq[1] - 0.5) < 1e-9);
});

test('equity: Monte Carlo streets are deterministic and sum to 1', () => {
  const holes = [[c(A, 0), c(A, 1)], [c(K, 0), c(K, 1)], [c(Q, 0), c(Q, 1)]];
  for (const board of [[], [c(0, 0), c(5, 1), c(7, 2)]]) {
    const first = pokerRules.equity(holes, board);
    const second = pokerRules.equity(holes, board);
    assert.deepEqual(first, second);
    const sum = first.reduce((t, v) => t + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `equity sums to ${sum}`);
  }
});

test('equity: pocket aces dominate pocket kings preflop', () => {
  const eq = pokerRules.equity([[c(A, 0), c(A, 1)], [c(K, 0), c(K, 1)]], []);
  assert.ok(eq[0] > 0.7 && eq[0] < 0.95, `AA equity ${eq[0]}`);
  assert.ok(eq[1] < 0.3, `KK equity ${eq[1]}`);
});

test('equity: probabilities split among only the live seats', () => {
  const holes = [[c(A, 0), c(A, 1)], null, [c(0, 0), c(0, 1)]];
  const eq = pokerRules.equity(holes, [c(3, 0), c(4, 1), c(6, 3), c(7, 2)]);
  assert.equal(eq[1], null);
  assert.ok(Math.abs(eq[0] + eq[2] - 1) < 1e-9);
});
