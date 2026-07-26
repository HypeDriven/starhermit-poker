import { test } from 'node:test';
import assert from 'node:assert/strict';

// wsUrl() reads the page location; shim it for Node.
globalThis.location = { protocol: 'https:', host: 'poker.test' };

const { GameSocket } = await import('../src/game-socket.js');

// Fake WebSocket capturing sends and allowing scripted events.
class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { if (this.onclose) this.onclose(); }
  open() { if (this.onopen) this.onopen(); }
  message(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}

function makeSocket(handlers = {}) {
  const net = {
    tokenManager: { token: 'tok' },
  };
  const gs = new GameSocket(net, 'session-1', handlers);
  // Inject the fake WS implementation.
  gs.socket.WS = FakeWS;
  return gs;
}

test('sends the documented sync command on every open', () => {
  FakeWS.instances = [];
  const gs = makeSocket();
  gs.connect();
  const ws = FakeWS.instances[0];
  assert.match(ws.url, /^wss?:\/\//);
  assert.match(ws.url, /\/ws\/v1\/games\?/);
  assert.match(ws.url, /sessionId=session-1/);
  assert.match(ws.url, /access_token=tok/);
  ws.open();
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'cmd', data: { type: 'sync' } });
  gs.destroy();
});

test('routes state frames to onState and events to onEvent', () => {
  FakeWS.instances = [];
  const seen = { states: [], events: [] };
  const gs = makeSocket({
    onState: (m) => seen.states.push(m),
    onEvent: (m) => seen.events.push(m),
  });
  gs.connect();
  const ws = FakeWS.instances[0];
  ws.open();
  ws.message({ type: 'game', data: { type: 'state', stateVersion: 3, you: {}, publicState: {} } });
  ws.message({ type: 'game', data: { type: 'action', stateVersion: 4, action: 'call' } });
  assert.equal(seen.states.length, 1);
  assert.equal(seen.events.length, 1);
  assert.equal(gs.stateVersion, 4);
  gs.destroy();
});

test('drops stale state versions', () => {
  FakeWS.instances = [];
  const seen = [];
  const gs = makeSocket({ onState: (m) => seen.push(m) });
  gs.connect();
  const ws = FakeWS.instances[0];
  ws.open();
  ws.message({ type: 'game', data: { type: 'state', stateVersion: 5 } });
  ws.message({ type: 'game', data: { type: 'state', stateVersion: 4 } }); // stale
  ws.message({ type: 'game', data: { type: 'state', stateVersion: 5 } }); // same = ok
  assert.equal(seen.length, 2);
  gs.destroy();
});

test('commands carry the current stateVersion', () => {
  FakeWS.instances = [];
  const gs = makeSocket();
  gs.connect();
  const ws = FakeWS.instances[0];
  ws.open();
  ws.message({ type: 'game', data: { type: 'state', stateVersion: 7 } });
  gs.sendCommand({ type: 'call' });
  assert.deepEqual(JSON.parse(ws.sent[1]), {
    type: 'cmd', data: { type: 'call', stateVersion: 7 },
  });
  gs.destroy();
});

test('error and presence frames reach their handlers', () => {
  FakeWS.instances = [];
  const got = { errors: [], presence: [] };
  const gs = makeSocket({
    onError: (m) => got.errors.push(m),
    onPresence: (p) => got.presence.push(p),
  });
  gs.connect();
  const ws = FakeWS.instances[0];
  ws.open();
  ws.message({ type: 'error', error: 'Illegal move' });
  ws.message({ type: 'presence', userId: 'u1', online: false });
  assert.deepEqual(got.errors, ['Illegal move']);
  assert.deepEqual(got.presence, [{ userId: 'u1', online: false }]);
  gs.destroy();
});

test('reconnect re-syncs: a fresh sync is sent on the next open', async () => {
  FakeWS.instances = [];
  const gs = makeSocket();
  gs.socket.backoff = () => 1; // near-instant reconnect for the test
  gs.connect();
  FakeWS.instances[0].open();
  FakeWS.instances[0].close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWS.instances.length, 2);
  FakeWS.instances[1].open();
  assert.deepEqual(JSON.parse(FakeWS.instances[1].sent[0]),
    { type: 'cmd', data: { type: 'sync' } });
  gs.destroy();
});

test('destroy stops reconnects and closes the socket', async () => {
  FakeWS.instances = [];
  const gs = makeSocket();
  gs.socket.backoff = () => 1;
  gs.connect();
  FakeWS.instances[0].open();
  gs.destroy();
  FakeWS.instances[0].close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWS.instances.length, 1);
});
