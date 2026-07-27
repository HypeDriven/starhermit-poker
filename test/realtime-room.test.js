import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatMap, canStart, isHost, ReadyTracker, RoomController } from '../src/realtime-room.js';

const p = (id, userId, slot, extra = {}) => ({
  id, userId, username: `u${slot}`, isAi: !userId, isHost: false,
  team: 0, slot, joinedAt: '2026-07-24T00:00:00Z', leftAt: null, ...extra,
});

test('seatMap places participants by slot and leaves gaps empty', () => {
  const seats = seatMap([p('a', 'u1', 0), p('b', 'u2', 3)]);
  assert.equal(seats.length, 6);
  assert.equal(seats[0].participant.id, 'a');
  assert.equal(seats[3].participant.id, 'b');
  assert.equal(seats[1].participant, null);
  assert.equal(seats[5].participant, null);
});

test('seatMap ignores participants outside team 0 / seat bounds', () => {
  const seats = seatMap([p('x', 'u9', 9), p('y', 'u8', 1, { team: 1 })]);
  assert.equal(seats.every((s) => s.participant === null), true);
});

test('canStart requires only the host and a non-terminal status', () => {
  const room = {
    status: 'Lobby', hostUserId: 'u1',
    participants: [p('a', 'u1', 0, { isHost: true })],
  };
  assert.equal(canStart(room, 'u1'), true); // solo host: AI backfills the rest
  assert.equal(canStart(room, 'u2'), false); // not the host
  room.status = 'Playing';
  assert.equal(canStart(room, 'u1'), false);
  room.status = 'Closed';
  assert.equal(canStart(room, 'u1'), false);
  room.status = 'Open';
  assert.equal(canStart(room, 'u1'), true);
  // A host left alone after the other player left can still start.
  room.participants.push(p('b', 'u2', 1, { leftAt: '2026-07-24T01:00:00Z' }));
  assert.equal(canStart(room, 'u1'), true);
});

test('isHost compares against hostUserId', () => {
  assert.equal(isHost({ hostUserId: 'u1' }, 'u1'), true);
  assert.equal(isHost({ hostUserId: 'u1' }, 'u2'), false);
  assert.equal(isHost(null, 'u1'), false);
});

test('ReadyTracker tracks, applies, and prunes by participant id', () => {
  const t = new ReadyTracker();
  t.applyFrame('pa', true);
  t.applyFrame('pb', false);
  assert.equal(t.isReady('pa'), true);
  assert.equal(t.isReady('pb'), false);
  t.applyFrame('pa', false);
  assert.equal(t.isReady('pa'), false);
  t.applyFrame(null, true); // ignored: no participant id
  t.prune([{ id: 'pb' }]);
  assert.equal(t.isReady('pa'), false); // pruned
  assert.equal(t.isReady('pb'), false);
});

function fakeNet() {
  const posts = [];
  return {
    posts,
    scope: 'poker',
    tokenManager: { token: 'tok' },
    client: {
      post: async (path, body) => { posts.push({ path, body }); return { id: 'r1' }; },
      get: async () => { const e = new Error('nope'); e.status = 404; throw e; },
    },
  };
}

test('createRoom sends the documented FFA config and poker metadata', async () => {
  const net = fakeNet();
  const controller = new RoomController(net);
  await controller.createRoom('public');
  const { path, body } = net.posts[0];
  assert.equal(path, '/api/v1/realtime/rooms');
  assert.equal(body.gameSlug, 'poker');
  assert.equal(body.teamCount, 1);
  assert.equal(body.seatsPerTeam, 6);
  assert.equal(typeof body.backfillAfterSeconds, 'number');
  assert.equal(body.aiPlayers, 0); // defaults to no pre-seated AI
  assert.deepEqual(body.metadata, {
    variant: 'nlhe',
    startingStack: 10000,
    smallBlind: 50,
    bigBlind: 100,
    turnDurationSeconds: 30,
    visibility: 'public',
  });
});

test('createRoom forwards the requested AI opponent count', async () => {
  const net = fakeNet();
  const controller = new RoomController(net);
  await controller.createRoom('private', 3);
  assert.equal(net.posts[0].body.aiPlayers, 3);
});

test('setSeats posts the seat assignment to the seats endpoint', async () => {
  const net = fakeNet();
  const controller = new RoomController(net);
  await controller.setSeats('r1', [{ participantId: 'p9', team: 0, slot: 4 }]);
  assert.equal(net.posts[0].path, '/api/v1/realtime/rooms/r1/seats');
  assert.deepEqual(net.posts[0].body, { seats: [{ participantId: 'p9', team: 0, slot: 4 }] });
});

test('quickJoin requests exactly one seat', async () => {
  const net = fakeNet();
  const controller = new RoomController(net);
  await controller.quickJoin();
  assert.deepEqual(net.posts[0].body, { gameSlug: 'poker', seats: 1 });
});

test('myRoom maps 404 to null', async () => {
  const net = fakeNet();
  const controller = new RoomController(net);
  assert.equal(await controller.myRoom(), null);
});

test('roster push frames update the room and reach the handler', () => {
  const net = fakeNet();
  let got = null;
  const controller = new RoomController(net, { onRoster: (r) => { got = r; } });
  controller.room = { id: 'r1', status: 'Lobby' };
  controller._onFrame(JSON.stringify({
    type: 'roster', roomId: 'r1', status: 'Playing',
    gameSessionId: 'gs1', participants: [],
  }), false);
  assert.equal(got.status, 'Playing');
  assert.equal(got.gameSessionId, 'gs1');
  assert.equal(got.id, 'r1');
});

test('ready control frames feed the tracker via handler', () => {
  const net = fakeNet();
  let ready = null;
  const controller = new RoomController(net, {
    onReady: (participantId, r) => { ready = { participantId, r }; },
  });
  controller._onFrame(JSON.stringify({ type: 'ready', from: 'pa', ready: true }), false);
  assert.deepEqual(ready, { participantId: 'pa', r: true });
  assert.equal(controller.readyTracker.isReady('pa'), true);
});

test('binary frames and malformed JSON are ignored', () => {
  const net = fakeNet();
  let calls = 0;
  const controller = new RoomController(net, { onRoster: () => { calls++; } });
  controller._onFrame(new ArrayBuffer(8), true);
  controller._onFrame('not json', false);
  assert.equal(calls, 0);
});
