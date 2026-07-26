import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const { game, pokerRules } = loadScript('server.js');
const j = (x) => JSON.parse(JSON.stringify(x));

// Table: one human + one AI seat.
function humanVsAiCtx(overrides = {}) {
  const roster = [
    { userId: 'u-a', name: 'alice', team: 0, slot: 0, ai: false },
    { userId: null, name: 'Rafa Vento', team: 0, slot: 1, ai: true },
  ];
  return makeCtx({
    now: 1_000_000, random: 0.42,
    room: { roomId: 'r', metadata: { startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 }, roster },
    presence: { 'u-a': { online: true, left: false } },
    players: [{ id: 'u-a', name: 'alice' }],
    ...overrides,
  });
}

const totalChips = (state) => state.seats.reduce((t, s) => t + s.stack + s.handCommit, 0);

test('AI seats get a documented profile at table start', () => {
  const res = game.createSession(humanVsAiCtx());
  const ai = res.sessionState.seats[1];
  assert.ok(['conservative', 'balanced', 'aggressive'].includes(ai.aiProfile));
});

test('AI acts without any client input when it is its turn', () => {
  // Force the AI to be the first preflop actor (dealer heads-up = SB acts first).
  let ctx, state;
  for (const r of [0.01, 0.2, 0.4, 0.6, 0.8, 0.99]) {
    ctx = humanVsAiCtx({ random: r });
    state = game.createSession(ctx).sessionState;
    if (state.dealerSeat === 1) break;
  }
  // createSession already runs the AI loop: the AI (seat 1) has acted and the
  // turn is back with the human, or the hand advanced.
  assert.equal(state.seats[1].lastActionSeq >= 0, true, 'AI never acted');
  assert.equal(state.actingSeat === 0 || !state.hand.live, true);
  assert.equal(totalChips(state), 20000);
});

test('AI loop is bounded and driven by ticks; a full match completes', () => {
  const ctx = humanVsAiCtx();
  const state = game.createSession(ctx).sessionState;
  let guard = 0;
  while (!state.matchResult && guard++ < 3000) {
    if (state.hand.live && state.actingSeat === 0) {
      // Aggressive human: jams preflop, otherwise calls/checks down.
      const s = state.seats[0];
      const toCall = state.hand.currentBet - s.roundCommit;
      const data = state.hand.street === 'preflop' && s.stack > 0 && !s.allIn
        ? { type: 'all-in' }
        : toCall > 0 ? { type: 'call' } : { type: 'check' };
      ctx.now += 1000;
      const res = game.onPlayerMessage({
        ...ctx, sessionState: state,
        message: { from: 'u-a', data },
      });
      assert.equal(res.ok, true, res.error);
    } else {
      ctx.now += 1000;
      game.onTick({ ...ctx, sessionState: state });
    }
    // Invariants throughout.
    assert.equal(totalChips(state), 20000, 'chip leak with AI in play');
    assert.ok(state.seats.every((s) => s.stack >= 0));
  }
  assert.ok(state.matchResult, 'match vs AI never completed');
});

test('AI summary never invents a user id for the acting AI seat', () => {
  let ctx, state;
  for (const r of [0.01, 0.2, 0.4, 0.6, 0.8, 0.99]) {
    ctx = humanVsAiCtx({ random: r });
    state = game.createSession(ctx).sessionState;
    if (state.dealerSeat === 1) break;
  }
  // Run one AI action via tick and inspect summary while AI acts... AI acts
  // immediately in createSession; construct a state where AI is mid-turn by
  // checking summary after a fresh hand where AI is first: either way,
  // turnPlayerId must never be null-userId AI seat.
  const res = game.onTick({ ...ctx, sessionState: state });
  const summary = res.sessionState.summary;
  if (state.actingSeat >= 0 && state.seats[state.actingSeat].ai) {
    assert.equal(summary.turnPlayerId, null);
  } else {
    assert.equal(summary.turnPlayerId, 'u-a');
  }
});

test('human departure converts the seat to AI which keeps playing on ticks', () => {
  const roster = [
    { userId: 'u-a', name: 'alice', team: 0, slot: 0, ai: false },
    { userId: 'u-b', name: 'bob', team: 0, slot: 1, ai: false },
  ];
  const ctx = makeCtx({
    now: 1_000_000, random: 0.42,
    room: { roomId: 'r', metadata: { startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 }, roster },
    presence: { 'u-a': { online: true, left: false }, 'u-b': { online: true, left: false } },
    players: [{ id: 'u-a', name: 'alice' }, { id: 'u-b', name: 'bob' }],
  });
  const state = game.createSession(ctx).sessionState;

  // Bob leaves mid-hand: platform marks left + converts the seat.
  ctx.presence = {
    'u-a': { online: true, left: false },
    'u-b': { online: false, left: true },
  };
  ctx.room.roster[1] = { userId: null, name: 'AI Bob', team: 0, slot: 1, ai: true };
  ctx.now += 1000;
  game.onTick({ ...ctx, sessionState: state });
  const bob = state.seats[1];
  assert.equal(bob.ai, true);
  assert.equal(bob.left, true);
  assert.ok(bob.aiProfile, 'converted seat has no AI profile');

  // Bob's commands are rejected; the seat plays on via ticks.
  ctx.now += 1000;
  const denied = game.onPlayerMessage({
    ...ctx, sessionState: state,
    message: { from: 'u-b', data: { type: 'fold' } },
  });
  assert.equal(denied.ok, false);

  // Play the match out with alice calling/checking.
  const rng = pokerRules.mulberry32(7);
  let guard = 0;
  while (!state.matchResult && guard++ < 3000) {
    if (state.hand.live && state.actingSeat === 0) {
      const toCall = state.hand.currentBet - state.seats[0].roundCommit;
      ctx.now += 1000;
      game.onPlayerMessage({
        ...ctx, sessionState: state,
        message: { from: 'u-a', data: toCall > 0 ? { type: 'call' } : { type: 'check' } },
      });
    } else {
      ctx.now += 1000;
      game.onTick({ ...ctx, sessionState: state });
    }
  }
  assert.ok(state.matchResult, 'match stalled after human->AI conversion');
  assert.equal(totalChips(state), 20000);
});

test('AI never receives state broadcasts (AI seats are not session players)', () => {
  const res = game.createSession(humanVsAiCtx());
  for (const b of res.broadcast) {
    if (b.to !== 'all') assert.deepEqual(j(b.to), ['u-a']);
  }
});
