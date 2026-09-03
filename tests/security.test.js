import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const { game } = loadScript('server.js');
const j = (x) => JSON.parse(JSON.stringify(x));

function table() {
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
  return { state: game.createSession(ctx).sessionState, ctx };
}

const actingUser = (state) => state.seats[state.actingSeat].userId;
const send = (state, ctx, from, data) => game.onPlayerMessage({
  ...ctx, sessionState: state, message: { from, data },
});

test('identity cannot be forged: userId fields in payloads are ignored', () => {
  const { state, ctx } = table();
  const actor = actingUser(state);
  const other = actor === 'u-a' ? 'u-b' : 'u-a';
  // The non-acting player claims to be the acting player inside the payload.
  const res = send(state, ctx, other, { type: 'fold', userId: actor, from: actor, seat: state.actingSeat });
  assert.equal(res.ok, false);
  // State untouched: it is still the same actor's turn.
  assert.equal(actingUser(state), actor);
});

test('client-supplied seeds, results, and elo have no effect', () => {
  const { state, ctx } = table();
  const actor = actingUser(state);
  const res = send(state, ctx, actor, {
    type: 'call', seed: 12345, random: 0.0, result: { kind: 'i-win' },
    eloUpdates: { 'u-a': 9999 }, winner: 'u-a',
  });
  assert.equal(res.ok, true); // the CALL was legal; the extras are ignored
  assert.equal(state.matchResult, null);
  assert.equal(res.result, undefined);
  assert.equal(res.eloUpdates, undefined);
});

test('prototype pollution attempts are inert', () => {
  const { state, ctx } = table();
  const actor = actingUser(state);
  const res = send(state, ctx, actor, JSON.parse(
    '{"type":"call","__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}'));
  assert.equal(res.ok, true);
  assert.equal({}.admin, undefined);
  assert.equal({}.x, undefined);
  assert.equal(state.admin, undefined);
});

test('invalid serialized values are rejected, never applied', () => {
  const { state, ctx } = table();
  // Reach the flop so bets are legal.
  send(state, ctx, actingUser(state), { type: 'call' });
  send(state, ctx, actingUser(state), { type: 'check' });
  const actor = actingUser(state);
  for (const amount of [NaN, Infinity, -Infinity, '100', 'all', null, undefined, {}, [], true]) {
    const res = send(state, ctx, actor, { type: 'bet', amount });
    assert.equal(res.ok, false, `amount ${String(amount)} accepted`);
  }
  assert.equal(state.hand.currentBet, 0);
});

test('duplicate commands are not idempotent-replayable', () => {
  const { state, ctx } = table();
  const actor = actingUser(state);
  const first = send(state, ctx, actor, { type: 'call' });
  assert.equal(first.ok, true);
  // Replaying the same command: now out of turn.
  const second = send(state, ctx, actor, { type: 'call' });
  assert.equal(second.ok, false);
});

test('commands from AI-converted seats are rejected', () => {
  const { state, ctx } = table();
  const victim = actingUser(state);
  const victimSeat = state.actingSeat;
  // The acting player's seat is converted to AI by the platform.
  ctx.presence = Object.fromEntries(
    ['u-a', 'u-b'].map((u) => [u, { online: u !== victim, left: u === victim }]));
  ctx.room.roster[victimSeat] = {
    userId: null, name: 'AI', team: 0, slot: victimSeat, ai: true,
  };
  const res = send(state, ctx, victim, { type: 'fold' });
  assert.equal(res.ok, false);
  // And the AI took over the seat.
  assert.equal(state.seats[victimSeat].ai, true);
});

test('action log and hand history stay bounded', () => {
  const { state, ctx } = table();
  // Play many fast hands (all-in every time) and verify caps.
  for (let i = 0; i < 70 && !state.matchResult; i++) {
    if (state.hand.live && state.actingSeat >= 0) {
      const toCall = state.hand.currentBet - state.seats[state.actingSeat].roundCommit;
      send(state, ctx, actingUser(state), toCall > 0 ? { type: 'all-in' } : { type: 'check' });
    } else {
      ctx.now += 1000;
      game.onTick({ ...ctx, sessionState: state });
    }
  }
  assert.ok(state.log.length <= 300, `log grew to ${state.log.length}`);
  assert.ok(state.hands.length <= 60, `hands grew to ${state.hands.length}`);
});

test('broadcasts never carry raw session documents', () => {
  const { state, ctx } = table();
  const res = send(state, ctx, actingUser(state), { type: 'sync' });
  for (const b of res.broadcast) {
    for (const key of ['seats', 'hand', 'log', 'deck', 'holes', 'hands', 'config']) {
      assert.equal(key in b.data, false, `broadcast carries raw ${key}`);
    }
    assert.equal('deck' in b.data.publicState, false);
    assert.equal('holes' in b.data.publicState, false);
  }
});

test('state version monotonicity: seq never decreases across a match', () => {
  const { state, ctx } = table();
  let prev = state.actionSeq;
  for (let i = 0; i < 60 && !state.matchResult; i++) {
    if (state.hand.live && state.actingSeat >= 0) {
      const toCall = state.hand.currentBet - state.seats[state.actingSeat].roundCommit;
      send(state, ctx, actingUser(state), toCall > 0 ? { type: 'call' } : { type: 'check' });
    } else {
      ctx.now += 1000;
      game.onTick({ ...ctx, sessionState: state });
    }
    assert.ok(state.actionSeq >= prev, `seq went backwards: ${prev} -> ${state.actionSeq}`);
    prev = state.actionSeq;
  }
});

test('summary window stays accurate after every transition', () => {
  const { state, ctx } = table();
  const check = () => {
    const s = state.summary;
    assert.deepEqual(Object.keys(j(s)), ['turnPlayerId', 'deadline', 'status', 'moveCount']);
    assert.equal(s.moveCount, state.actionSeq);
    if (state.matchResult) assert.equal(s.status, 'finished');
    else assert.equal(s.status, 'active');
  };
  check();
  for (let i = 0; i < 20 && !state.matchResult; i++) {
    if (state.hand.live && state.actingSeat >= 0) {
      const toCall = state.hand.currentBet - state.seats[state.actingSeat].roundCommit;
      send(state, ctx, actingUser(state), toCall > 0 ? { type: 'call' } : { type: 'check' });
    } else {
      ctx.now += 1000;
      game.onTick({ ...ctx, sessionState: state });
    }
    check();
  }
});

test('session state stays JSON-serializable and compact', () => {
  const { state, ctx } = table();
  for (let i = 0; i < 30 && !state.matchResult; i++) {
    if (state.hand.live && state.actingSeat >= 0) {
      const toCall = state.hand.currentBet - state.seats[state.actingSeat].roundCommit;
      send(state, ctx, actingUser(state), toCall > 0 ? { type: 'all-in' } : { type: 'check' });
    } else {
      ctx.now += 1000;
      game.onTick({ ...ctx, sessionState: state });
    }
  }
  const serialized = JSON.stringify(state);
  assert.ok(serialized.length < 200_000, `state ballooned to ${serialized.length} bytes`);
  assert.equal(serialized.includes('undefined'), false);
});
