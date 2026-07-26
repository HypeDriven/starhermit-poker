import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript, makeCtx } from './harness.js';

const { game } = loadScript('server.js');
const j = (x) => JSON.parse(JSON.stringify(x));

function roomCtx(roster, overrides = {}) {
  const humans = roster.filter((r) => r.userId);
  return makeCtx({
    random: 0.42,
    room: {
      roomId: 'room-1',
      metadata: { startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30 },
      roster,
    },
    presence: Object.fromEntries(humans.map((h) => [h.userId, { online: true, left: false }])),
    players: humans.map((h) => ({ id: h.userId, name: h.name })),
    ...overrides,
  });
}

const twoHumans = [
  { userId: 'u-a', name: 'alice', team: 0, slot: 0, ai: false },
  { userId: 'u-b', name: 'bob', team: 0, slot: 1, ai: false },
];
const sixMax = [
  { userId: 'u-a', name: 'a', team: 0, slot: 0, ai: false },
  { userId: 'u-b', name: 'b', team: 0, slot: 1, ai: false },
  { userId: 'u-c', name: 'c', team: 0, slot: 2, ai: false },
  { userId: null, name: 'AI-1', team: 0, slot: 3, ai: true },
  { userId: null, name: 'AI-2', team: 0, slot: 4, ai: true },
  { userId: null, name: 'AI-3', team: 0, slot: 5, ai: true },
];

test('createSession deals hand 1: two hole cards per eligible seat, deck intact', () => {
  const res = game.createSession(roomCtx(sixMax));
  const s = res.sessionState;
  assert.equal(s.hand.live, true);
  assert.equal(s.handNumber, 1);
  assert.equal(s.hand.street, 'preflop');
  for (let i = 0; i < 6; i++) {
    assert.equal(s.hand.holes[i].length, 2, `seat ${i} holds two cards`);
  }
  // Deck = 52 - 12 dealt.
  assert.equal(s.hand.deck.length, 40);
  // No card appears twice anywhere.
  const all = [...s.hand.deck, ...s.hand.holes.flat()];
  assert.equal(new Set(all).size, 52);
  // Chips conservation: blinds posted from stacks.
  const total = s.seats.reduce((t, x) => t + x.stack + x.handCommit, 0);
  assert.equal(total, 60000);
});

test('heads-up blinds: dealer is small blind and acts first preflop', () => {
  const res = game.createSession(roomCtx(twoHumans));
  const s = res.sessionState;
  const dealer = s.dealerSeat;
  assert.equal(s.hand.smallBlindSeat, dealer);
  assert.equal(s.hand.bigBlindSeat, 1 - dealer);
  assert.equal(s.actingSeat, dealer); // SB acts first preflop heads-up
  assert.equal(s.seats[dealer].roundCommit, 50);
  assert.equal(s.seats[1 - dealer].roundCommit, 100);
  assert.equal(s.hand.currentBet, 100);
});

test('six-max blinds and action order: SB/BB right of button, UTG first', () => {
  // All-human table (AI seats would act immediately in createSession).
  const allHuman = sixMax.map((r, i) => r.userId
    ? r : { userId: `u-ai${i}`, name: `h${i}`, team: 0, slot: i, ai: false });
  let res;
  for (const r of [0.01, 0.2, 0.4, 0.6, 0.8, 0.99]) {
    res = game.createSession(roomCtx(allHuman, { random: r }));
    if (res.sessionState.dealerSeat === 0) break;
  }
  const s = res.sessionState;
  assert.equal(s.dealerSeat, 0);
  assert.equal(s.hand.smallBlindSeat, 1);
  assert.equal(s.hand.bigBlindSeat, 2);
  assert.equal(s.actingSeat, 3); // left of the big blind
  assert.equal(s.seats[1].roundCommit, 50);
  assert.equal(s.seats[2].roundCommit, 100);
});

test('private projections carry only the recipient\'s hole cards — no leaks', () => {
  const res = game.createSession(roomCtx(sixMax));
  const s = res.sessionState;
  const broadcasts = res.broadcast.filter((b) => b.data.type === 'state');
  assert.equal(broadcasts.length, 3); // humans only

  for (const b of broadcasts) {
    assert.notEqual(b.to, 'all');
    assert.equal(b.to.length, 1);
    const recipientSeat = s.seats.findIndex((x) => x.userId === b.to[0]);
    const ownCards = s.hand.holes[recipientSeat];
    assert.deepEqual(j(b.data.you.holeCards), j(ownCards));

    // Structural leak check: the ONLY card-bearing fields in the payload are
    // you.holeCards (own), publicState.board (empty preflop), and
    // publicState.revealed (empty preflop). Everything else must contain no
    // card data — deck order and other holes cannot appear by construction.
    const pub = b.data.publicState;
    assert.deepEqual(j(pub.board), []);
    assert.deepEqual(j(pub.revealed), {});
    assert.equal('deck' in pub, false);
    assert.equal('holes' in pub, false);
    assert.equal('hand' in pub, false);
    assert.equal('holeCards' in pub, false);
    for (const seat of pub.seats) {
      assert.equal('holeCards' in seat, false);
      assert.equal('cards' in seat, false);
    }
    // The private channel carries card data ONLY in you.holeCards: it has no
    // other field where hidden cards could hide.
    assert.deepEqual(Object.keys(b.data.you).sort(),
      ['holeCards', 'legalActions', 'seat']);
    assert.deepEqual(j(b.data.you.holeCards).slice().sort((x, y) => x - y),
      j(ownCards).slice().sort((x, y) => x - y));
  }
});

test('hand-started broadcast goes to all with blind positions', () => {
  const res = game.createSession(roomCtx(twoHumans));
  const hs = res.broadcast.find((b) => b.data.type === 'hand-started');
  assert.equal(hs.to, 'all');
  assert.equal(hs.data.handNumber, 1);
  assert.equal(typeof hs.data.dealerSeat, 'number');
});

test('sit-out-next-hand excludes the seat from the next deal', () => {
  const created = game.createSession(roomCtx(twoHumans));
  const res = game.onPlayerMessage(roomCtx(twoHumans, {
    sessionState: created.sessionState,
    message: { from: 'u-a', data: { type: 'sit-out-next-hand', enabled: true } },
  }));
  assert.equal(res.ok, true);
  const seat = res.sessionState.seats.find((x) => x.userId === 'u-a');
  assert.equal(seat.sitOutNext, true);
});

test('sit-out-next-hand validates the enabled flag and the sender', () => {
  const created = game.createSession(roomCtx(twoHumans));
  const bad = game.onPlayerMessage(roomCtx(twoHumans, {
    sessionState: created.sessionState,
    message: { from: 'u-a', data: { type: 'sit-out-next-hand', enabled: 'yes' } },
  }));
  assert.equal(bad.ok, false);
  const stranger = game.onPlayerMessage(roomCtx(twoHumans, {
    sessionState: created.sessionState,
    message: { from: 'u-x', data: { type: 'sit-out-next-hand', enabled: true } },
  }));
  assert.equal(stranger.ok, false);
});
