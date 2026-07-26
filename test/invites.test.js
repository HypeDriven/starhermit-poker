import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomController } from '../src/realtime-room.js';
import { inviteFriend } from '../src/lobby.js';

function fakeNet() {
  const calls = [];
  return {
    calls,
    scope: 'poker',
    userId: 'u-self',
    tokenManager: { token: 'tok' },
    client: {
      post: async (path, body) => { calls.push({ method: 'POST', path, body }); return {}; },
      get: async (path) => { calls.push({ method: 'GET', path }); return []; },
    },
  };
}

// A stand-in RoomController recording the invite calls the lobby makes.
// `fail` maps a method name to the error it should throw.
function fakeController(fail = {}, data = {}) {
  const err = (name) => {
    const e = fail[name];
    if (!e) return;
    const thrown = new Error(e.message || `HTTP ${e.status}`);
    thrown.status = e.status;
    throw thrown;
  };
  return {
    calls: [],
    async sendInvite(roomId, toUserId) {
      this.calls.push(['sendInvite', roomId, toUserId]);
      err('sendInvite');
      return 'invite' in data ? data.invite : { id: 'inv-room', notified: true };
    },
  };
}

const httpError = (status) => ({ status });

test('sendInvite posts to the room invites endpoint', async () => {
  const net = fakeNet();
  await new RoomController(net).sendInvite('room-1', 'user-2');
  assert.deepEqual(net.calls[0], {
    method: 'POST',
    path: '/api/v1/realtime/rooms/room-1/invites',
    body: { toUserId: 'user-2' },
  });
});

test('myInvites reads the cross-game invite inbox', async () => {
  const net = fakeNet();
  await new RoomController(net).myInvites();
  assert.deepEqual(net.calls[0], { method: 'GET', path: '/api/v1/realtime/rooms/invites' });
});

test('acceptInvite and declineInvite hit the documented paths', async () => {
  const net = fakeNet();
  const c = new RoomController(net);
  await c.acceptInvite('inv-1');
  await c.declineInvite('inv-2');
  assert.equal(net.calls[0].path, '/api/v1/realtime/rooms/invites/inv-1/accept');
  assert.equal(net.calls[1].path, '/api/v1/realtime/rooms/invites/inv-2/decline');
});

test('shareInviteLink uses the dashboard game-invite format with sub + scope', async () => {
  const net = fakeNet();
  const link = new RoomController(net).shareInviteLink();
  assert.equal(link, 'https://dashboard.starhermit.com/game-invite/u-self/poker');
});

// --- inviting a friend --------------------------------------------------------
//
// One call per invite: the platform pushes the dashboard notification itself.
// A second games-API invite alongside it would notify the friend twice, so
// these tests pin that sendInvite is the only call made.

test('inviteFriend sends the room invite and nothing else', async () => {
  const c = fakeController();
  const res = await inviteFriend(c, 'room-1', 'user-2');
  assert.deepEqual(res, { seated: true, notified: true, error: null });
  assert.deepEqual(c.calls, [['sendInvite', 'room-1', 'user-2']]);
});

test('inviteFriend passes through an undelivered notification', async () => {
  const c = fakeController({}, { invite: { id: 'inv-room', notified: false } });
  const res = await inviteFriend(c, 'room-1', 'user-2');
  assert.equal(res.seated, true);
  assert.equal(res.notified, false); // friend is offline; invite still stands
  assert.equal(res.error, null);
});

test('inviteFriend reports unknown delivery when the platform omits it', async () => {
  const c = fakeController({}, { invite: { id: 'inv-room' } });
  assert.equal((await inviteFriend(c, 'room-1', 'user-2')).notified, null);
  const empty = fakeController({}, { invite: null });
  assert.equal((await inviteFriend(empty, 'room-1', 'user-2')).notified, null);
});

test('inviteFriend treats 409 as already invited', async () => {
  const c = fakeController({ sendInvite: httpError(409) });
  const res = await inviteFriend(c, 'room-1', 'user-2');
  assert.equal(res.seated, true);
  assert.equal(res.notified, null); // the first invite did the notifying
  assert.equal(res.error, null);
});

test('inviteFriend reports a failed invite instead of a false success', async () => {
  const c = fakeController({ sendInvite: httpError(403) }); // not friends
  const res = await inviteFriend(c, 'room-1', 'user-2');
  assert.equal(res.seated, false);
  assert.equal(res.error.status, 403);
});
