import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';
import { ReplayEngine } from '../src/replay-engine.js';

const { game, pokerRules } = loadScript('server.js');
const j = (x) => JSON.parse(JSON.stringify(x));

// Play a full two-human match and return the archived state.
function playMatch() {
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
  let res = game.createSession(ctx);
  let state = res.sessionState;
  let playerStates = res.playerStates;
  let guard = 0;
  while (!res.result && guard++ < 500) {
    if (state.hand.live && state.actingSeat >= 0) {
      const user = state.seats[state.actingSeat].userId;
      const toCall = state.hand.currentBet - state.seats[state.actingSeat].roundCommit;
      ctx.now += 1000;
      res = game.onPlayerMessage({
        ...ctx, sessionState: state, playerStates,
        message: { from: user, data: toCall > 0 ? { type: 'all-in' } : { type: 'check' } },
      });
    } else {
      ctx.now += 1000;
      res = game.onTick({ ...ctx, sessionState: state, playerStates });
    }
    state = res.sessionState || state;
    playerStates = res.playerStates || playerStates;
  }
  return { state: j(state), result: j(res.result) };
}

test('replay covers every hand with street markers and a terminal step', () => {
  const { state } = playMatch();
  const engine = new ReplayEngine(state, pokerRules);
  assert.ok(engine.handCount() >= 1);
  for (let h = 0; h < engine.handCount(); h++) {
    const steps = engine.stepsForHand(h);
    assert.ok(steps.length >= 2, `hand ${h} has too few steps`);
    // Final step is the payout snapshot.
    const last = steps[steps.length - 1];
    assert.ok(last.winners && last.winners.length >= 1);
    // Every hand ended with chips conserved across the payout.
    assert.equal(last.stacks.reduce((t, s) => t + s, 0), 20000);
  }
});

test('stack reconstruction matches the engine truth after every hand', () => {
  const { state } = playMatch();
  const engine = new ReplayEngine(state, pokerRules);
  // Replay hand-by-hand: stacks at the start of hand N plus/minus that hand's
  // commits and winnings must equal stacks at the start of hand N+1.
  for (let h = 0; h < engine.handCount() - 1; h++) {
    const steps = engine.stepsForHand(h);
    const finalStacks = steps[steps.length - 1].stacks;
    assert.deepEqual(finalStacks, engine.stacksAtHandStart(h + 1),
      `stack drift after hand ${h}`);
  }
});

test('reveal policy: replays show only recorded reveals (showdown/shown)', () => {
  const { state } = playMatch();
  const engine = new ReplayEngine(state, pokerRules);
  for (let h = 0; h < engine.handCount(); h++) {
    const reveal = state.hands[h].reveal || {};
    for (let seat = 0; seat < 2; seat++) {
      const visible = engine.visibleCards(h, seat);
      if (reveal[seat]) assert.deepEqual(visible, reveal[seat]);
      else assert.equal(visible, null, `seat ${seat} hand ${h} leaked in replay`);
    }
  }
});

test('showdown replays reconstruct the winning description', () => {
  const { state } = playMatch();
  const engine = new ReplayEngine(state, pokerRules);
  // Find a showdown hand (all-in every hand => every hand is a showdown or fold).
  for (let h = 0; h < engine.handCount(); h++) {
    const hand = state.hands[h];
    if (Object.keys(hand.reveal || {}).length === 2) {
      const v = pokerRules.evaluateHoldem(hand.reveal[hand.winners[0].seat], hand.board);
      assert.ok(v.description.length > 3);
      return;
    }
  }
  throw new Error('no showdown hand found to verify');
});
