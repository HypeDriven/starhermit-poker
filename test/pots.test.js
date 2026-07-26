import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const { game, pokerRules } = loadScript('server.js');
const { buildPots, splitPot } = pokerRules;
const j = (x) => JSON.parse(JSON.stringify(x));

const seat = (handCommit, folded = false) => ({ handCommit, folded });

// ---------------------------------------------------------------------------
// Pure pot math
// ---------------------------------------------------------------------------

test('single pot when everyone matches', () => {
  const pots = buildPots([seat(500), seat(500), seat(500)]);
  assert.deepEqual(j(pots), [{ amount: 1500, eligible: [0, 1, 2] }]);
});

test('one side pot from a short all-in', () => {
  const pots = buildPots([seat(200), seat(1000), seat(1000)]);
  assert.deepEqual(j(pots), [
    { amount: 600, eligible: [0, 1, 2] },   // main: 200 x 3
    { amount: 1600, eligible: [1, 2] },     // side: 800 x 2
  ]);
});

test('multiple side pots from staggered all-ins', () => {
  const pots = buildPots([seat(100), seat(400), seat(900), seat(900)]);
  assert.deepEqual(j(pots), [
    { amount: 400, eligible: [0, 1, 2, 3] },
    { amount: 900, eligible: [1, 2, 3] },   // 300 x 3
    { amount: 1000, eligible: [2, 3] },     // 500 x 2
  ]);
});

test('folded contributors stay in the pot but are ineligible', () => {
  const pots = buildPots([seat(500, true), seat(500), seat(200)]);
  assert.deepEqual(j(pots), [
    { amount: 600, eligible: [1, 2] },
    { amount: 600, eligible: [1] },         // folded seat's excess contested by seat 1 alone
  ]);
});

test('uncalled top level returns through payout (single eligible)', () => {
  const pots = buildPots([seat(100, true), seat(10000)]);
  assert.deepEqual(j(pots), [
    { amount: 200, eligible: [1] },
    { amount: 9900, eligible: [1] },
  ]);
});

test('splitPot divides evenly and allocates odd chips clockwise from button', () => {
  // 100 split 3 ways: 33/33/34, extra chip to the winner closest left of seat 0.
  assert.deepEqual(j(splitPot(100, [1, 2, 3], 0, 6)), { 1: 34, 2: 33, 3: 33 });
  // With dealer seat 2, seat 3 is closest clockwise.
  assert.deepEqual(j(splitPot(100, [1, 3, 5], 2, 6)), { 3: 34, 5: 33, 1: 33 });
  assert.deepEqual(j(splitPot(101, [0, 3], 0, 6)), { 0: 51, 3: 50 });
});

test('pot payouts equal collected chips (invariant over random commits)', () => {
  const rng = pokerRules.mulberry32(777);
  for (let trial = 0; trial < 200; trial++) {
    const seats = Array.from({ length: 6 }, () =>
      seat(Math.floor(rng() * 5000), rng() < 0.3));
    const pots = buildPots(seats);
    const collected = seats.reduce((t, s) => t + s.handCommit, 0);
    const inPots = pots.reduce((t, p) => t + p.amount, 0);
    assert.equal(inPots, collected);
    // Only eligible (non-folded contributor) seats appear in each pot, and
    // every pot with multiple contributors at a level has all of them.
    for (const p of pots) {
      for (const i of p.eligible) assert.equal(seats[i].folded, false);
    }
  }
});

// ---------------------------------------------------------------------------
// Engine-driven showdown with a crafted deck (fully deterministic)
// ---------------------------------------------------------------------------

const C = (str) => '23456789TJQKA'.indexOf(str[0]) + 13 * 'cdhs'.indexOf(str[1]);

function threeHandedCtx(overrides = {}) {
  const roster = [
    { userId: 'u-a', name: 'alice', team: 0, slot: 0, ai: false },
    { userId: 'u-b', name: 'bob', team: 0, slot: 1, ai: false },
    { userId: 'u-c', name: 'carol', team: 0, slot: 2, ai: false },
  ];
  return makeCtx({
    now: 1_000_000, random: 0.42,
    room: { roomId: 'r', metadata: { startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 }, roster },
    presence: {
      'u-a': { online: true, left: false },
      'u-b': { online: true, left: false },
      'u-c': { online: true, left: false },
    },
    players: roster.map((r) => ({ id: r.userId, name: r.name })),
    ...overrides,
  });
}

function act(state, ctx, data) {
  ctx.now += 1000;
  const res = game.onPlayerMessage({
    ...ctx, sessionState: state,
    message: { from: state.seats[state.actingSeat].userId, data },
  });
  assert.equal(res.ok, true, res.error);
  return res;
}

test('three-way staggered all-in: main and side pots to different winners', () => {
  const ctx = threeHandedCtx();
  const state = game.createSession(ctx).sessionState;

  // Stacks: A short (300), B mid (2500), C deep (10000). Blinds are already
  // posted, so totals include them.
  state.seats[0].stack = 300;
  state.seats[1].stack = 2500;
  const tA = state.seats[0].stack + state.seats[0].handCommit;
  const tB = state.seats[1].stack + state.seats[1].handCommit;
  const tC = state.seats[2].stack + state.seats[2].handCommit;

  // Craft hands: A wins the main pot (royal), C wins the side pot (quads),
  // B loses everything. Board runs out from the END of hand.deck.
  state.hand.holes[0] = [C('As'), C('Ks')];
  state.hand.holes[1] = [C('2d'), C('3d')];
  state.hand.holes[2] = [C('9h'), C('9c')];
  // deck.pop() order: burn, f1, f2, f3, burn, turn, burn, river.
  state.hand.deck = [
    C('5c'),                                   // river
    C('8d'),                                   // burn
    C('9d'),                                   // turn (C makes quads... 9h9c+9d+9s?)
    C('8c'),                                   // burn
    C('Js'), C('Qs'), C('Ts'),                 // flop (A royal draw, C set+quad draw)
    C('8h'),                                   // burn
  ];

  // Everyone jams preflop in turn order.
  while (state.hand.live && state.handNumber === 1) {
    act(state, ctx, { type: 'all-in' });
  }

  // A (short stack): wins the main pot 3*tA with the royal flush.
  // C (deep): wins the side pot 2*(tB-tA) with quads, uncalled tC-tB returns.
  const winners = state.prevHand.winners;
  const bySeat = Object.fromEntries(winners.map((w) => [w.seat, w.amount]));
  assert.equal(bySeat[0], 3 * tA);
  assert.equal(bySeat[2], 2 * (tB - tA) + (tC - tB));
  assert.equal(bySeat[1], undefined);
  const total = state.seats.reduce((t, s) => t + s.stack + s.handCommit, 0);
  assert.equal(total, tA + tB + tC);
});

test('showdown reveals contesting hands; folded non-shown hands stay hidden', () => {
  const ctx = threeHandedCtx();
  const state = game.createSession(ctx).sessionState;

  // A folds preflop (no show-cards), B and C see a showdown.
  state.hand.holes[1] = [C('Ah'), C('Ad')];
  state.hand.holes[2] = [C('2c'), C('3c')];
  state.hand.deck = [C('5h'), C('8d'), C('6s'), C('8c'), C('9h'), C('7d'), C('4h'), C('8s')];

  // A folds at their first opportunity; B and C call/check to showdown.
  let guard = 0;
  while (state.hand.live && state.handNumber === 1 && guard++ < 30) {
    const i = state.actingSeat;
    const s = state.seats[i];
    const toCall = state.hand.currentBet - s.roundCommit;
    if (i === 0) act(state, ctx, { type: 'fold' });
    else if (toCall > 0) act(state, ctx, { type: 'call' });
    else act(state, ctx, { type: 'check' });
  }

  const revealed = state.prevHand.revealed;
  assert.equal(Object.keys(revealed).length, 2);
  assert.equal(revealed[0], undefined, 'folder without show-cards was revealed');
  assert.deepEqual(j(revealed[1]), j(state.hands[0].reveal[1]));
  assert.deepEqual(j(revealed[1]), j([C('Ah'), C('Ad')]));
});

test('hand-complete event carries winners, pot sizes, and reveal', () => {
  const ctx = threeHandedCtx();
  const state = game.createSession(ctx).sessionState;
  // Everyone calls/checks to showdown.
  let guard = 0;
  const events = [];
  while (state.hand.live && state.handNumber === 1 && guard++ < 40) {
    ctx.now += 1000;
    const res = game.onPlayerMessage({
      ...ctx, sessionState: state,
      message: { from: state.seats[state.actingSeat].userId, data: { type: 'call' } },
    });
    const ok = res.ok ? res : game.onPlayerMessage({
      ...ctx, sessionState: state,
      message: { from: state.seats[state.actingSeat].userId, data: { type: 'check' } },
    });
    for (const b of ok.broadcast || []) {
      if (b.to === 'all') events.push(b.data);
    }
  }
  const hc = events.find((e) => e.type === 'hand-complete');
  assert.ok(hc, 'no hand-complete event');
  assert.equal(hc.handNumber, 1);
  assert.ok(Array.isArray(hc.winners) && hc.winners.length >= 1);
  const potSum = hc.pots.reduce((t, p) => t + p, 0);
  const winSum = hc.winners.reduce((t, w) => t + w.amount, 0);
  assert.equal(potSum, winSum); // paid exactly what was collected
  assert.ok(Object.keys(hc.revealedCards).length >= 2);
});

test('conservation invariant across a full random match', () => {
  const rng = pokerRules.mulberry32(20260724);
  const ctx = threeHandedCtx();
  const state = game.createSession(ctx).sessionState;
  const TOTAL = 30000;
  let guard = 0;
  while (!state.matchResult && guard++ < 8000) {
    const i = state.actingSeat;
    if (i < 0) break;
    const s = state.seats[i];
    const toCall = state.hand.currentBet - s.roundCommit;
    const roll = rng();
    let cmd;
    if (roll < 0.05 && toCall > 0) cmd = { type: 'fold' };
    else if (roll < 0.25) cmd = { type: 'all-in' };
    else if (roll < 0.35 && state.hand.currentBet === 0) cmd = { type: 'bet', amount: Math.min(2000, s.roundCommit + s.stack) };
    else if (toCall > 0) cmd = { type: 'call' };
    else cmd = { type: 'check' };
    const res = act(state, ctx, cmd);
    // Invariants after EVERY action:
    assert.equal(state.seats.reduce((t, x) => t + x.stack + x.handCommit, 0), TOTAL,
      `chip leak after ${JSON.stringify(cmd)}`);
    assert.ok(state.seats.every((x) => x.stack >= 0 && x.handCommit >= 0 && x.roundCommit >= 0),
      'negative chips');
    assert.ok(state.seats.every((x) => x.roundCommit <= x.handCommit),
      'round commit exceeds hand commit');
    // No duplicate cards anywhere.
    const cards = [...state.hand.deck, ...state.hand.board, ...state.hand.burn,
      ...state.hand.holes.filter(Boolean).flat()];
    assert.equal(new Set(cards).size, cards.length, 'duplicate card');
  }
  assert.ok(state.matchResult, 'match never completed');
  assert.equal(state.matchResult.finalStacks.reduce((t, x) => t + x, 0), TOTAL);
});
