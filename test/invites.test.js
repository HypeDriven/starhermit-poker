import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomController } from '../src/realtime-room.js';

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
