import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const { game } = loadScript('server.js');
const j = (x) => JSON.parse(JSON.stringify(x));

function twoHumanCtx(overrides = {}) {
  const roster = [
    { userId: 'u-a', name: 'alice', team: 0, slot: 0, ai: false },
    { userId: 'u-b', name: 'bob', team: 0, slot: 1, ai: false },
  ];
  return makeCtx({
    now: 1_000_000, random: 0.42,
    room: { roomId: 'r', metadata: { startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 }, roster },
    presence: { 'u-a': { online: true, left: false }, 'u-b': { online: true, left: false } },
    players: [{ id: 'u-a', name: 'alice' }, { id: 'u-b', name: 'bob' }],
    ...overrides,
  });
}

// Play an all-in-every-hand match to completion, tracking playerStates and
// capturing the response that ends the session.
function playMatch() {
  const ctx = twoHumanCtx();
  let res = game.createSession(ctx);
  let state = res.sessionState;
  let playerStates = res.playerStates;
  let finalRes = null;
  let guard = 0;
  while (!finalRes && guard++ < 500) {
    if (state.hand.live && state.actingSeat >= 0) {
      const user = state.seats[state.actingSeat].userId;
      const toCall = state.hand.currentBet - state.seats[state.actingSeat].roundCommit;
      ctx.now += 1000;
      ctx.random = 0.42;
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
    if (res.result) finalRes = res;
  }
  return { ctx, state, playerStates, finalRes };
}

test('match completion returns result + eloUpdates and ends the session', () => {
  const { finalRes } = playMatch();
  assert.ok(finalRes, 'match never completed');
  const result = finalRes.result;
  assert.equal(result.version, 1);
  assert.equal(result.endReason, 'last-player-with-chips');
  assert.equal(result.placements.length, 2);
  assert.equal(result.placements[0].place, 1);
  // Equal starting elos: winner +16, loser -16.
  const winner = result.placements[0].userId;
  const loser = result.placements[1].userId;
  assert.equal(result.eloBefore[winner], 1200);
  assert.equal(result.eloAfter[winner], 1216);
  assert.equal(result.eloAfter[loser], 1184);
  assert.deepEqual(j(finalRes.eloUpdates), j(result.eloAfter));
  assert.ok(result.durationMs > 0);
  // Archived session JSON contains compact replay reveals only, never the raw
  // final deck or folded/mucked hole cards.
  assert.deepEqual(j(finalRes.sessionState.hand.deck), []);
  assert.deepEqual(j(finalRes.sessionState.hand.burn), []);
  assert.ok(finalRes.sessionState.hand.holes.every((cards) => cards === null));
});

test('player documents track wins, losses, streaks, and recent games', () => {
  const { finalRes, playerStates } = playMatch();
  const result = finalRes.result;
  const winnerDoc = playerStates[result.placements[0].userId];
  const loserDoc = playerStates[result.placements[1].userId];
  assert.equal(winnerDoc.wins, 1);
  assert.equal(winnerDoc.matchesPlayed, 1);
  assert.equal(winnerDoc.currentStreak, 1);
  assert.equal(winnerDoc.bestStreak, 1);
  assert.equal(loserDoc.losses, 1);
  assert.equal(loserDoc.currentStreak, 0);
  assert.ok(winnerDoc.handsPlayed >= 1);
  assert.equal(winnerDoc.recentGames.length, 1);
  assert.equal(winnerDoc.recentGames[0].place, 1);
  assert.ok(winnerDoc.elo === 1216);
});

test('elo math: favorite gains less, underdog gains more', () => {
  // Second match with skewed ratings carried in via playerStates.
  const ctx = twoHumanCtx({
    playerStates: {
      'u-a': { elo: 1600, wins: 0, losses: 0, draws: 0 },
      'u-b': { elo: 1000, wins: 0, losses: 0, draws: 0 },
    },
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
  const a = res.result.placements.find((p) => p.userId === 'u-a');
  const b = res.result.placements.find((p) => p.userId === 'u-b');
  if (a.place === 1) {
    // Favorite won: small gain, underdog loses little.
    assert.ok(a.eloAfter - 1600 < 16 && a.eloAfter > 1600, `favorite gain ${a.eloAfter - 1600}`);
    assert.ok(1000 - b.eloAfter < 16 && b.eloAfter < 1000);
  } else {
    // Underdog won: big swing.
    assert.ok(b.eloAfter - 1000 > 16, `underdog gain ${b.eloAfter - 1000}`);
    assert.ok(1600 - a.eloAfter > 16);
  }
});
