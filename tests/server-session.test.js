import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const g = loadScript('server.js');
const { game, pokerRules } = g;

// vm-sandbox objects carry a different realm's prototypes; round-trip through
// JSON before deep comparisons.
const j = (x) => JSON.parse(JSON.stringify(x));

// Room-bound ctx: two humans + one AI seat, poker metadata.
function roomCtx(overrides = {}) {
  return makeCtx({
    random: 0.42,
    room: {
      roomId: 'room-1',
      metadata: { variant: 'nlhe', startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 },
      roster: [
        { userId: 'u-alice', name: 'alice', team: 0, slot: 0, ai: false },
        { userId: 'u-bob', name: 'bob', team: 0, slot: 1, ai: false },
        { userId: null, name: 'Rafa Vento', team: 0, slot: 2, ai: true },
      ],
    },
    presence: { 'u-alice': { online: true, left: false }, 'u-bob': { online: true, left: false } },
    players: [
      { id: 'u-alice', name: 'alice' },
      { id: 'u-bob', name: 'bob' },
    ],
    ...overrides,
  });
}

test('createSession builds seats from the room roster in slot order', () => {
  const res = game.createSession(roomCtx());
  assert.equal(res.ok, true);
  const s = res.sessionState;
  assert.equal(s.seats.length, 3);
  assert.equal(s.seats[0].userId, 'u-alice');
  assert.equal(s.seats[1].userId, 'u-bob');
  assert.equal(s.seats[2].userId, null);
  assert.equal(s.seats[2].ai, true);
  assert.equal(s.seats[2].name, 'Rafa Vento');
  // Blinds are posted at deal time; chips are conserved.
  const total = s.seats.reduce((t, seat) => t + seat.stack + seat.handCommit, 0);
  assert.equal(total, 30000);
  assert.ok(s.seats.every((seat) => seat.stack < 10000 || seat.handCommit === 0));
});

test('createSession emits the platform summary window', () => {
  const res = game.createSession(roomCtx());
  const summary = res.sessionState.summary;
  assert.deepEqual(Object.keys(summary), ['turnPlayerId', 'deadline', 'status', 'moveCount']);
  assert.equal(summary.status, 'active');
  assert.equal(summary.moveCount, 2); // two blind posts logged
});

test('createSession initializes per-player documents for humans only', () => {
  const res = game.createSession(roomCtx());
  assert.deepEqual(j(res.playerStates['u-alice']), { elo: 1200, wins: 0, losses: 0, draws: 0 });
  assert.deepEqual(j(res.playerStates['u-bob']), { elo: 1200, wins: 0, losses: 0, draws: 0 });
  assert.equal('undefined' in res.playerStates || res.playerStates[undefined], undefined);
  assert.equal(Object.keys(res.playerStates).length, 2);
});

test('createSession preserves existing player documents', () => {
  const ctx = roomCtx({
    playerStates: { 'u-alice': { elo: 1450, wins: 9, losses: 1, draws: 0 } },
  });
  const res = game.createSession(ctx);
  assert.equal(res.playerStates['u-alice'].elo, 1450);
});

test('sync returns a per-player addressed state message', () => {
  const created = game.createSession(roomCtx());
  const ctx = roomCtx({
    sessionState: created.sessionState,
    message: { from: 'u-bob', data: { type: 'sync' } },
  });
  const res = game.onPlayerMessage(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.broadcast.length, 1);
  assert.deepEqual(j(res.broadcast[0].to), ['u-bob']);
  assert.equal(res.broadcast[0].data.you.seat, 1);
  assert.equal(res.broadcast[0].data.publicState.seats.length, 3);
});

test('sync rejects unseated senders and malformed commands', () => {
  const created = game.createSession(roomCtx());
  const bad1 = game.onPlayerMessage(roomCtx({
    sessionState: created.sessionState,
    message: { from: 'u-stranger', data: { type: 'sync' } },
  }));
  assert.equal(bad1.ok, false);
  const bad2 = game.onPlayerMessage(roomCtx({
    sessionState: created.sessionState,
    message: { from: 'u-alice', data: { nope: 1 } },
  }));
  assert.equal(bad2.ok, false);
});

test('stale stateVersion is rejected', () => {
  const created = game.createSession(roomCtx());
  const res = game.onPlayerMessage(roomCtx({
    sessionState: created.sessionState,
    message: { from: 'u-alice', data: { type: 'sync', stateVersion: 99 } },
  }));
  assert.equal(res.ok, false);
  assert.match(res.error, /stale/i);
});

test('no state broadcast ever targets "all" or contains deck/holes', () => {
  const created = game.createSession(roomCtx());
  for (const b of created.broadcast) {
    if (b.data.type === 'state') assert.notEqual(b.to, 'all');
    assert.equal('deck' in b.data, false);
    assert.equal('holes' in b.data, false);
    if (b.data.publicState) assert.equal('hand' in b.data.publicState, false);
  }
});

test('presence conversion: a leaver becomes an AI seat and keeps their stack', () => {
  const created = game.createSession(roomCtx());
  const before = created.sessionState.seats[1].stack;
  created.sessionState.seats[1].stack = 4321;
  const expectedTotal = 30000 - before + 4321;
  const ctx = roomCtx({
    sessionState: created.sessionState,
    presence: {
      'u-alice': { online: true, left: false },
      'u-bob': { online: false, left: true },
    },
    message: { from: 'u-alice', data: { type: 'sync' } },
  });
  game.onPlayerMessage(ctx);
  const bob = ctx.sessionState.seats[1];
  assert.equal(bob.ai, true);
  assert.equal(bob.left, true);
  // The converted seat is AI-driven: it may have acted legally already, but
  // its chips are conserved (never destroyed or created).
  const total = ctx.sessionState.seats.reduce((t, s) => t + s.stack + s.handCommit, 0);
  assert.equal(total, expectedTotal);
  assert.ok(bob.stack + bob.handCommit <= 4321 + 100);
});

test('epochMsToIso formats without Date', () => {
  assert.equal(pokerRules.epochMsToIso(0), '1970-01-01T00:00:00Z');
  assert.equal(pokerRules.epochMsToIso(1721473200000), '2024-07-20T11:00:00Z');
  assert.equal(pokerRules.epochMsToIso(951782400000), '2000-02-29T00:00:00Z'); // leap day
});

test('shuffle is deterministic for a seeded rng and preserves 52 unique cards', () => {
  const deck1 = pokerRules.shuffle(pokerRules.freshDeck(), pokerRules.mulberry32(1234));
  const deck2 = pokerRules.shuffle(pokerRules.freshDeck(), pokerRules.mulberry32(1234));
  assert.deepEqual(deck1, deck2);
  assert.equal(new Set(deck1).size, 52);
});

test('summary deadline is an ISO string derived from turnDeadlineMs', () => {
  const created = game.createSession(roomCtx());
  created.sessionState.turnDeadlineMs = 1721473200000;
  const res = game.onTick(roomCtx({ sessionState: created.sessionState }));
  assert.equal(res.sessionState.summary.deadline, '2024-07-20T11:00:00Z');
});

// --- showdown reveal + archived hole cards ---------------------------------

function headsUpCtx(overrides = {}) {
  return makeCtx({
    now: 1_000_000, random: 0.42,
    room: {
      roomId: 'room-hu',
      metadata: { variant: 'nlhe', startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 },
      roster: [
        { userId: 'u-alice', name: 'alice', team: 0, slot: 0, ai: false },
        { userId: 'u-bob', name: 'bob', team: 0, slot: 1, ai: false },
      ],
    },
    presence: { 'u-alice': { online: true, left: false }, 'u-bob': { online: true, left: false } },
    players: [{ id: 'u-alice', name: 'alice' }, { id: 'u-bob', name: 'bob' }],
    ...overrides,
  });
}

const actingUser = (state) => state.seats[state.actingSeat].userId;
const sendCmd = (state, from, data) => game.onPlayerMessage(headsUpCtx({
  now: 1_000_000 + state.actionSeq * 1000, sessionState: state,
  message: { from, data },
}));
const lastPublicState = (res) =>
  res.broadcast.filter((b) => b.data.type === 'state').pop().data.publicState;

test('showdown projects the contesting hands in prevHand.reveal', () => {
  let state = game.createSession(headsUpCtx()).sessionState;
  const dealt = state.hand.holes.map((h) => h && h.slice());
  let res = sendCmd(state, actingUser(state), { type: 'all-in' });
  state = res.sessionState;
  res = sendCmd(state, actingUser(state), { type: 'all-in' });
  state = res.sessionState;

  // The all-in runout completed hand #1 at a showdown.
  const record = state.hands.find((h) => h.n === 1);
  assert.ok(record, 'hand record archived');
  assert.ok(Object.keys(record.reveal).length >= 2, 'showdown reveals both hands');

  const pub = lastPublicState(res);
  assert.deepEqual(j(pub.prevHand.reveal), j(record.reveal));
  // Exactly the dealt cards — nothing invented, nothing extra.
  for (const [seat, cards] of Object.entries(pub.prevHand.reveal)) {
    assert.deepEqual(j(cards), j(dealt[Number(seat)]));
  }
});

test('fold wins project no reveal; both hands stay archived for replay', () => {
  let state = game.createSession(headsUpCtx()).sessionState;
  const dealt = state.hand.holes.map((h) => h && h.slice());
  const res = sendCmd(state, actingUser(state), { type: 'fold' });
  state = res.sessionState;

  const pub = lastPublicState(res);
  assert.ok(pub.prevHand, 'prevHand projected');
  assert.deepEqual(j(pub.prevHand.reveal || {}), {}, 'mucked cards are not revealed live');

  const record = state.hands.find((h) => h.n === 1);
  assert.deepEqual(j(record.holes), j(dealt), 'replay archives every dealt hand');
});
