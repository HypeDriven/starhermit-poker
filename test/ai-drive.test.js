import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const g = loadScript('server.js');
const { game } = g;

// Heads-up room: one human (slot 0) + one AI seat (slot 1) — the layout a
// solo player gets when they create a table with one AI opponent.
function headsUpCtx(overrides = {}) {
  return makeCtx({
    random: 0.42,
    room: {
      roomId: 'room-hu',
      metadata: { variant: 'nlhe', startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 },
      roster: [
        { userId: 'u-hu', name: 'hero', team: 0, slot: 0, ai: false },
        { userId: null, name: 'Rafa Vento', team: 0, slot: 1, ai: true },
      ],
    },
    presence: { 'u-hu': { online: true, left: false } },
    players: [{ id: 'u-hu', name: 'hero' }],
    ...overrides,
  });
}

test('createSession never leaves the turn on an idle AI seat', () => {
  const created = game.createSession(headsUpCtx());
  const s = created.sessionState;
  assert.ok(!s.hand.live || s.actingSeat !== 1 || s.seats[1].allIn);
});

test('a human action drives the AI response within the same invocation', () => {
  const created = game.createSession(headsUpCtx());
  const state = created.sessionState;
  assert.equal(state.actingSeat, 0, 'setup: the human opens heads-up');
  const res = game.onPlayerMessage(headsUpCtx({
    sessionState: state,
    message: { from: 'u-hu', data: { type: 'call', stateVersion: state.actionSeq } },
  }));
  assert.equal(res.ok, true);
  const s = res.sessionState;
  const actions = res.broadcast.map((b) => b.data).filter((d) => d && d.type === 'action');
  // The AI acted before the invocation returned — no waiting for a tick with
  // the turn abandoned on an AI seat (the original "stuck table" report).
  assert.ok(!s.hand.live || actions.some((e) => e.seat === 1),
    'expected an AI action event in the same invocation');
  assert.ok(!s.hand.live || s.actingSeat !== 1 || s.seats[1].allIn);
});

test('a rejected command still persists the sweep that preceded it', () => {
  const created = game.createSession(headsUpCtx());
  const state = created.sessionState;
  assert.equal(state.actingSeat, 0, 'setup: the human is to act');
  const seqBefore = state.actionSeq;
  const handBefore = state.handNumber;
  // The deadline has passed: the sweep resolves it, then the stale version
  // fails validation. Without sessionState on the error response the platform
  // would keep the pre-sweep document and the timeout would never stick.
  const res = game.onPlayerMessage(headsUpCtx({
    now: state.turnDeadlineMs + 1,
    sessionState: state,
    message: { from: 'u-hu', data: { type: 'check', stateVersion: -1 } },
  }));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Stale state version');
  assert.ok(res.sessionState, 'sweep progress must be returned, not rolled back');
  assert.ok(
    res.sessionState.actionSeq > seqBefore || res.sessionState.handNumber > handBefore,
    'the timeout sweep must be persisted',
  );
  assert.ok(Array.isArray(res.broadcast) && res.broadcast.length > 0);
});

test('onTick chains the next hand and drives its AI opener in one sweep', () => {
  const created = game.createSession(headsUpCtx());
  const state = created.sessionState;
  assert.equal(state.actingSeat, 0, 'setup: the human is to act');
  const handBefore = state.handNumber;
  // Human times out (small blind facing the big blind -> auto-fold), the
  // hand ends, and the chained hand must not stall on an AI opener.
  const res = game.onTick(headsUpCtx({
    now: state.turnDeadlineMs + 1,
    sessionState: state,
  }));
  assert.equal(res.ok, true);
  const s = res.sessionState;
  assert.ok(s.handNumber > handBefore, 'timeout ends the hand and chains the next');
  assert.ok(!s.hand.live || s.actingSeat !== 1 || s.seats[1].allIn,
    'a chained hand with an AI opener must not wait for the next tick');
});
