import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const { game } = loadScript('server.js');
const j = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------
// Scripted-table driver: two humans, deterministic randoms. NOTE: the engine
// chains straight into the next hand when one ends, so post-hand assertions
// use prevHand (the finished hand) and account for hand-2 blinds on stacks.
// ---------------------------------------------------------------------------

function newTable({ stacks = null, random = 0.42, now = 1_000_000, seatCount = 2 } = {}) {
  const names = ['alice', 'bob', 'carol'];
  const roster = Array.from({ length: seatCount }, (_, i) => ({
    userId: `u-${String.fromCharCode(97 + i)}`, name: names[i], team: 0, slot: i, ai: false,
  }));
  const ctx = makeCtx({
    now, random,
    room: { roomId: 'r', metadata: { startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 }, roster },
    presence: Object.fromEntries(roster.map((r) => [r.userId, { online: true, left: false }])),
    players: roster.map((r) => ({ id: r.userId, name: r.name })),
  });
  const state = game.createSession(ctx).sessionState;
  if (stacks) state.seats.forEach((s, i) => { s.stack = stacks[i]; });
  return { state, ctx };
}

function act(state, baseCtx, userId, data) {
  baseCtx.now += 1000;
  return game.onPlayerMessage({
    ...baseCtx,
    sessionState: state,
    message: { from: userId, data },
  });
}

const actingUser = (state) => state.seats[state.actingSeat].userId;
const totalChips = (state) => state.seats.reduce((t, s) => t + s.stack + s.handCommit, 0);

// Check/call until THE CURRENT hand ends (chains into the next hand stop us).
function checkCallDown(state, ctx, maxSteps = 50) {
  const handNo = state.handNumber;
  let steps = 0;
  while (state.hand.live && state.handNumber === handNo && steps < maxSteps) {
    const res = act(state, ctx, actingUser(state), { type: 'call' });
    if (!res.ok) {
      const res2 = act(state, ctx, actingUser(state), { type: 'check' });
      assert.equal(res2.ok, true, res2.error);
    }
    steps++;
  }
  assert.notEqual(state.handNumber === handNo && state.hand.live, true, 'hand did not finish');
  return state;
}

// ---------------------------------------------------------------------------

test('heads-up preflop: SB (dealer) acts first; BB closes with a check', () => {
  const { state, ctx } = newTable();
  const dealer = state.dealerSeat;
  assert.equal(state.actingSeat, dealer);
  let res = act(state, ctx, actingUser(state), { type: 'call' });
  assert.equal(res.ok, true);
  assert.equal(state.seats[dealer].roundCommit, 100);
  assert.equal(state.hand.street, 'preflop');
  res = act(state, ctx, actingUser(state), { type: 'check' });
  assert.equal(res.ok, true);
  assert.equal(state.hand.street, 'flop');
  assert.equal(state.hand.board.length, 3);
  assert.equal(state.actingSeat, 1 - dealer); // non-dealer first postflop
});

test('a short big blind never lowers the price below the posted small blind', () => {
  const { state, ctx } = newTable();
  const nextBigBlind = state.dealerSeat; // button rotates; old button becomes BB heads-up
  for (const seat of state.seats) {
    seat.handCommit = 0;
    seat.roundCommit = 0;
    seat.folded = false;
    seat.allIn = false;
    seat.eliminated = false;
  }
  state.seats[nextBigBlind].stack = 30;
  state.seats[1 - nextBigBlind].stack = 1000;
  state.hand.live = false;
  state.actingSeat = -1;
  game.onTick({ ...ctx, sessionState: state });

  assert.equal(state.hand.bigBlindSeat, nextBigBlind);
  assert.equal(state.seats[nextBigBlind].roundCommit, 30);
  assert.equal(state.seats[state.hand.smallBlindSeat].roundCommit, 50);
  assert.equal(state.hand.currentBet, 50);
  assert.equal(state.hand.minRaiseTotal, 150);
});

test('checks around advance streets to showdown; chips conserved; hand chains', () => {
  const { state, ctx } = newTable();
  checkCallDown(state, ctx);
  assert.equal(state.prevHand.handNumber, 1);
  assert.ok(state.prevHand.winners.length >= 1);
  assert.equal(state.prevHand.board.length, 5);
  assert.equal(totalChips(state), 20000);
  // Chained hand 2: button moved, blinds posted.
  assert.equal(state.handNumber, 2);
  assert.equal(state.hand.live, true);
  assert.equal(state.dealerSeat, 1 - state.prevHand.dealer);
  assert.equal(state.hand.board.length, 0);
});

test('bet, call, raise totals; minimum raise enforced (total convention)', () => {
  const { state, ctx } = newTable();
  act(state, ctx, actingUser(state), { type: 'call' });
  act(state, ctx, actingUser(state), { type: 'check' });
  assert.equal(state.hand.street, 'flop');

  let res = act(state, ctx, actingUser(state), { type: 'bet', amount: 300 });
  assert.equal(res.ok, true);
  assert.equal(state.hand.currentBet, 300);

  const raiser = actingUser(state);
  res = act(state, ctx, raiser, { type: 'raise', amount: 500 });
  assert.equal(res.ok, false);
  assert.match(res.error, /minimum raise/i);

  res = act(state, ctx, raiser, { type: 'raise', amount: 600 });
  assert.equal(res.ok, true);
  assert.equal(state.hand.currentBet, 600);
  assert.equal(state.hand.lastFullRaise, 300);

  res = act(state, ctx, actingUser(state), { type: 'call' });
  assert.equal(res.ok, true);
  assert.equal(state.hand.street, 'turn');
  assert.equal(totalChips(state), 20000);
});

test('negative, decimal, and over-stack amounts are rejected', () => {
  const { state, ctx } = newTable();
  act(state, ctx, actingUser(state), { type: 'call' });
  act(state, ctx, actingUser(state), { type: 'check' });
  const actor = actingUser(state);
  for (const amount of [-5, 12.5, Number.MAX_SAFE_INTEGER]) {
    const res = act(state, ctx, actor, { type: 'bet', amount });
    assert.equal(res.ok, false, `amount ${amount} accepted`);
  }
  const over = act(state, ctx, actor, { type: 'bet', amount: 10001 });
  assert.equal(over.ok, false);
});

test('out-of-turn, post-fold, and foreign actions are rejected', () => {
  const { state, ctx } = newTable();
  const actor = actingUser(state);
  const other = actor === 'u-a' ? 'u-b' : 'u-a';
  assert.equal(act(state, ctx, other, { type: 'fold' }).ok, false);
  assert.equal(act(state, ctx, actor, { type: 'fold' }).ok, true);
  // Hand 1 is over; the actor is no longer necessarily the same seat — the
  // same command from the same user may now be out of turn. Either way it
  // must not corrupt state.
  assert.equal(totalChips(state), 20000);
  assert.equal(act(state, ctx, 'u-stranger', { type: 'sync' }).ok, false);
});

test('fold-to-win awards the pot and records no showdown reveal', () => {
  const { state, ctx } = newTable();
  const winnerSeat = 1 - state.actingSeat;
  const res = act(state, ctx, actingUser(state), { type: 'fold' });
  assert.equal(res.ok, true);
  assert.equal(state.prevHand.handNumber, 1);
  assert.equal(state.prevHand.winners.length, 1);
  assert.equal(state.prevHand.winners[0].seat, winnerSeat);
  assert.equal(state.prevHand.winners[0].amount, 150); // both blinds
  assert.deepEqual(j(state.prevHand.revealed), {});
  assert.equal(totalChips(state), 20000);
});

test('short all-in does not reopen the action and closes the round', () => {
  const { state, ctx } = newTable();
  const sb = state.hand.smallBlindSeat;
  const bb = state.hand.bigBlindSeat;
  state.seats[bb].stack = 150; // posted 100, 150 behind
  const sbUser = state.seats[sb].userId;
  let res = act(state, ctx, sbUser, { type: 'raise', amount: 300 });
  assert.equal(res.ok, true);
  const bbUser = state.seats[bb].userId;
  res = act(state, ctx, bbUser, { type: 'all-in' });
  assert.equal(res.ok, true);
  assert.equal(state.seats[bb].allIn, true);
  // 250 total < 300 bet: a short all-in call. SB already matched, so the
  // round closes and the flop arrives.
  assert.equal(state.hand.street, 'flop');
  checkCallDown(state, ctx);
  assert.equal(totalChips(state), 10250); // 20000 less bb's overridden stack
});

test('a short all-in does not allow a player to bypass closed action by shoving', () => {
  const { state, ctx } = newTable({ seatCount: 3 });
  while (state.hand.street === 'preflop') {
    const seat = state.seats[state.actingSeat];
    const toCall = state.hand.currentBet - seat.roundCommit;
    const res = act(state, ctx, seat.userId, { type: toCall ? 'call' : 'check' });
    assert.equal(res.ok, true);
  }

  const first = state.actingSeat;
  let res = act(state, ctx, actingUser(state), { type: 'bet', amount: 200 });
  assert.equal(res.ok, true);
  res = act(state, ctx, actingUser(state), { type: 'call' });
  assert.equal(res.ok, true);
  state.seats[state.actingSeat].stack = 250;
  res = act(state, ctx, actingUser(state), { type: 'all-in' });
  assert.equal(res.ok, true);
  assert.equal(state.hand.currentBet, 250);
  assert.equal(state.actingSeat, first);
  assert.equal(state.seats[first].lastActionSeq >= 0, true);
  assert.equal(res.sessionState.hand.lastFullRaise, 200);

  const legal = res.broadcast.find((b) => Array.isArray(b.to) && b.to[0] === state.seats[first].userId)
    .data.you.legalActions;
  assert.equal(legal.canRaise, false);
  assert.equal(legal.canAllIn, false);
  res = act(state, ctx, state.seats[first].userId, { type: 'all-in' });
  assert.equal(res.ok, false);
  assert.match(res.error, /action is closed/i);
  assert.equal(act(state, ctx, state.seats[first].userId, { type: 'call' }).ok, true);
});

test('short opening all-in does not reduce the minimum raise', () => {
  const { state, ctx } = newTable();
  act(state, ctx, actingUser(state), { type: 'call' });
  act(state, ctx, actingUser(state), { type: 'check' });
  const opener = state.actingSeat;
  state.seats[opener].stack = 60;

  let res = act(state, ctx, actingUser(state), { type: 'all-in' });
  assert.equal(res.ok, true);
  assert.equal(state.hand.currentBet, 60);
  assert.equal(state.hand.lastFullRaise, 100);

  res = act(state, ctx, actingUser(state), { type: 'raise', amount: 120 });
  assert.equal(res.ok, false);
  assert.match(res.error, /minimum raise/i);
  res = act(state, ctx, actingUser(state), { type: 'raise', amount: 160 });
  assert.equal(res.ok, true);
});

test('full all-in: uncalled portion returns when the other player folds', () => {
  const { state, ctx } = newTable();
  const sb = state.hand.smallBlindSeat;
  const bb = state.hand.bigBlindSeat;
  let res = act(state, ctx, state.seats[sb].userId, { type: 'all-in' });
  assert.equal(res.ok, true);
  res = act(state, ctx, state.seats[bb].userId, { type: 'fold' });
  assert.equal(res.ok, true);
  // SB scooped 10100: their own 10000 back (uncalled bet returned) + BB's 100.
  assert.equal(state.prevHand.winners[0].seat, sb);
  assert.equal(state.prevHand.winners[0].amount, 10100);
  assert.equal(totalChips(state), 20000);
});

test('elimination: loser at zero chips; match completes; commands rejected after', () => {
  const { state, ctx } = newTable({ stacks: [10000, 200] });
  const sb = state.hand.smallBlindSeat;
  const bb = state.hand.bigBlindSeat;
  const sbUser = state.seats[sb].userId;
  const bbUser = state.seats[bb].userId;
  let res = act(state, ctx, sbUser, { type: 'all-in' });
  assert.equal(res.ok, true);
  res = act(state, ctx, bbUser, { type: 'call' });
  assert.equal(res.ok, true);
  // Both all-in: the board runs out automatically and the hand completes.
  assert.equal(state.prevHand.handNumber, 1);
  assert.equal(totalChips(state), 10350); // overrides added 50 to sb, removed 9700 from bb
  if (state.seats[bb].stack === 0 && state.prevHand.winners.length === 1) {
    // Decisive: bb busted. No new hand can start; the match is over.
    assert.equal(state.matchResult !== null, true);
    assert.equal(state.matchResult.winnerSeat, sb);
    assert.equal(state.hand.live, false);
    const after = act(state, ctx, sbUser, { type: 'fold' });
    assert.equal(after.ok, false);
  } else {
    // Split pot: bb survives; the match continues.
    assert.equal(state.matchResult, null);
  }
});
