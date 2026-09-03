import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const { game } = loadScript('server.js');

function newTable() {
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

const tick = (state, ctx) => game.onTick({ ...ctx, sessionState: state });
const actingUser = (state) => state.seats[state.actingSeat].userId;
const totalChips = (state) => state.seats.reduce((t, s) => t + s.stack + s.handCommit, 0);

test('no timeout fires before the deadline', () => {
  const { state, ctx } = newTable();
  const actor = state.actingSeat;
  ctx.now = state.turnDeadlineMs - 1;
  const res = tick(state, ctx);
  assert.equal(res.broadcast, undefined);
  assert.equal(state.actingSeat, actor);
});

test('timeout auto-checks when checking is legal', () => {
  const { state, ctx } = newTable();
  // SB calls, leaving BB with a free option (toCall = 0).
  game.onPlayerMessage({
    ...ctx, sessionState: state,
    message: { from: actingUser(state), data: { type: 'call' } },
  });
  assert.equal(state.hand.currentBet - state.seats[state.actingSeat].roundCommit, 0);
  const actorBefore = state.actingSeat;
  ctx.now = state.turnDeadlineMs + 1;
  const res = tick(state, ctx);
  assert.ok(res.broadcast, 'timeout produced no broadcast');
  const timeoutEvt = res.broadcast.find((b) => b.data.type === 'action');
  assert.equal(timeoutEvt.data.action, 'timeout-check');
  assert.equal(timeoutEvt.data.seat, actorBefore);
  // BB's free check closed the round: flop is dealt.
  assert.equal(state.hand.street, 'flop');
  assert.equal(totalChips(state), 20000);
});

test('timeout auto-folds when facing a bet', () => {
  const { state, ctx } = newTable();
  ctx.now = state.turnDeadlineMs + 1;
  const folder = state.actingSeat;
  const res = tick(state, ctx);
  const evt = res.broadcast.find((b) => b.data.type === 'action');
  assert.equal(evt.data.action, 'timeout-fold');
  assert.equal(evt.data.seat, folder);
  // Fold-to-win ended the hand: the OTHER seat won, and hand 2 chained.
  assert.equal(state.prevHand.handNumber, 1);
  assert.equal(state.prevHand.winners[0].seat, 1 - folder);
  assert.equal(state.handNumber, 2);
  assert.equal(totalChips(state), 20000);
});

test('duplicate ticks do not double-apply a timeout', () => {
  const { state, ctx } = newTable();
  ctx.now = state.turnDeadlineMs + 1;
  tick(state, ctx);
  const seqAfter = state.actionSeq;
  const handAfter = state.handNumber;
  // Same tick again (same clock instant): nothing new happens.
  const res2 = tick(state, ctx);
  assert.equal(res2.broadcast, undefined);
  assert.equal(state.actionSeq, seqAfter);
  assert.equal(state.handNumber, handAfter);
});

test('a delayed command from a timed-out player is rejected', () => {
  const { state, ctx } = newTable();
  const victim = actingUser(state);
  // Advance past the deadline; the NEXT invocation resolves the timeout.
  ctx.now = state.turnDeadlineMs + 1;
  const res = game.onPlayerMessage({
    ...ctx, sessionState: state,
    message: { from: victim, data: { type: 'call' } },
  });
  assert.equal(res.ok, false); // their seat already auto-folded / turn moved
  assert.match(res.error, /turn|folded|over|no hand/i);
});

test('timeout processing precedes stale-version rejection for other players', () => {
  const { state, ctx } = newTable();
  ctx.now = state.turnDeadlineMs + 1;
  // The other player sends sync: the timeout is lazily applied and the sync
  // still succeeds against the advanced state.
  const other = actingUser(state) === 'u-a' ? 'u-b' : 'u-a';
  const res = game.onPlayerMessage({
    ...ctx, sessionState: state,
    message: { from: other, data: { type: 'sync' } },
  });
  assert.equal(res.ok, true);
  const events = res.broadcast.filter((b) => b.to === 'all').map((b) => b.data.type);
  assert.ok(events.includes('action'), 'timeout action not merged into sync broadcast');
});

test('deadline is refreshed for each new actor', () => {
  const { state, ctx } = newTable();
  const d1 = state.turnDeadlineMs;
  game.onPlayerMessage({
    ...ctx, sessionState: state,
    message: { from: actingUser(state), data: { type: 'call' } },
  });
  assert.ok(state.turnDeadlineMs > d1 - 30000); // new deadline set from ctx.now
  assert.equal(state.turnDeadlineMs, ctx.now + 30000);
});
