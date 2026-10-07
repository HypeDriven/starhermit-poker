// Socket reconnects renew the launch token first (an expired token is refused
// before the upgrade and looks like a plain 1006 drop, so the same URL can
// never recover). Real SDK, stubbed fetch / WebSocket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.location = { protocol: 'https:', host: 'poker.test' };

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.instances.push(this); }
  send(d) { this.sent.push(d); }
  close() { this.onclose && this.onclose(); }
  open() { this.onopen && this.onopen(); }
  drop() { this.onclose && this.onclose({ code: 1006 }); }
}
globalThis.WebSocket = FakeWS;

const { createNetContext, ReconnectingSocket } = await import('../src/net.js');
const { GameSocket } = await import('../src/game-socket.js');
const { RoomController } = await import('../src/realtime-room.js');
const { signedOutMenu, PLATFORM_LOCALES } = await import('../src/platform-i18n.js');

const holder = {};
new Function('self', 'module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(holder, undefined);
const SDK = holder.StarHermit;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const tok = (v) => `h.${b64u({ sub: 'user-0011aabb', game_scope: 'pk-slug', exp: Math.floor(Date.now() / 1000) + 3600, v })}.s`;
const OLD = tok(1);
const NEW = tok(2);

// renewal: 'ok' → new token, 'flaky' → 503, 'refused' → 401
function setup(renewal) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push(`${init.method || 'GET'} ${url}`);
    if (url.endsWith('/launch-token')) {
      if (renewal === 'ok') return new Response(JSON.stringify({ token: NEW }), { status: 200 });
      return new Response('', { status: renewal === 'refused' ? 401 : 503 });
    }
    return new Response('', { status: 404 });
  };
  const loc = { hash: `#game_token=${OLD}`, search: '', pathname: '/', origin: 'https://poker.test', hostname: 'poker.test', href: `https://poker.test/#game_token=${OLD}` };
  const win = { location: { ...loc, assign: (u) => { win.assigned = u; } }, history: { replaceState() {} } };
  const sdk = SDK.create({ window: win, fetch, setTimeout: () => 0, clearTimeout: () => {} });
  sdk.init();
  globalThis.StarHermit = sdk;
  const net = createNetContext({ token: sdk.token, sdk });
  FakeWS.instances = [];
  return { calls, sdk, net, win };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1)); };
const renewals = (calls) => calls.filter((c) => c === 'POST /api/v1/games/pk-slug/launch-token').length;

test('game socket: reconnect renews first and reopens with the new token', async () => {
  const { calls, net } = setup('ok');
  const gs = new GameSocket(net, 'session-1', {}, { minIntervalMs: 0 });
  gs.socket.backoff = () => 0;
  gs.connect();
  const first = FakeWS.instances[0];
  assert.ok(first.url.includes(`access_token=${OLD}`));
  assert.equal(renewals(calls), 0, 'first connect needs no renewal');
  first.open(); first.drop();
  await settle();
  assert.equal(renewals(calls), 1);
  assert.equal(FakeWS.instances.length, 2);
  assert.ok(FakeWS.instances[1].url.includes(NEW), 'reopened with the renewed token');
  assert.match(FakeWS.instances[1].url, /\/ws\/v1\/games\?sessionId=session-1&/);
  gs.destroy();
});

test('realtime room: reconnect renews first and reopens with the new token', async () => {
  const { calls, net } = setup('ok');
  const ctl = new RoomController(net);
  ctl.connect('room-9');
  ctl.socket.backoff = () => 0;
  FakeWS.instances[0].open(); FakeWS.instances[0].drop();
  await settle();
  assert.equal(renewals(calls), 1);
  assert.equal(FakeWS.instances.length, 2);
  assert.match(FakeWS.instances[1].url, /\/ws\/v1\/realtime\?roomId=room-9&access_token=/);
  assert.ok(FakeWS.instances[1].url.includes(NEW));
  ctl.destroy();
});

test("'retry' backs off without reopening the old URL, then recovers", async () => {
  const outcomes = ['retry', 'retry', 'renewed'];
  let token = 'a';
  const delays = [];
  const sock = new ReconnectingSocket({
    urlFactory: () => `wss://poker.test/ws?access_token=${token}`,
    renew: async () => { const r = outcomes.shift(); if (r === 'renewed') token = 'b'; return r; },
    backoff: (n) => { delays.push(n); return 0; },
    wsImpl: FakeWS,
  });
  FakeWS.instances = [];
  sock.connect();
  FakeWS.instances[0].drop();
  await settle();
  assert.equal(FakeWS.instances.length, 2, 'exactly one reopen, after the successful renewal');
  assert.equal(FakeWS.instances[1].url, 'wss://poker.test/ws?access_token=b');
  assert.deepEqual(delays, [0, 1, 2], 'existing exponential backoff keeps climbing across retries');
  sock.destroy();
});

test("'relaunch' stops the socket for good and surfaces the relaunch prompt", async () => {
  const { calls, net, sdk, win } = setup('refused');
  const auth = [];
  sdk.on('auth', (a) => auth.push(a));
  let lost = 0;
  const gs = new GameSocket(net, 'session-1', { onAuthLost: () => { lost++; } }, { minIntervalMs: 0 });
  gs.socket.backoff = () => 0;
  gs.connect();
  FakeWS.instances[0].open(); FakeWS.instances[0].drop();
  await settle();
  assert.equal(renewals(calls), 1);
  assert.equal(lost, 1);
  assert.equal(FakeWS.instances.length, 1, 'the old URL is never reopened');
  await settle();
  assert.equal(FakeWS.instances.length, 1, 'no further attempts');
  assert.deepEqual(auth, [{ signedIn: false, reason: 'expired' }]);
  // app.js turns that auth event into the local menu with the relaunch button
  const menu = signedOutMenu(auth[0], sdk, 'en-US');
  assert.match(menu.notice, /expired/);
  assert.equal(typeof menu.onRelaunch, 'function');
  assert.equal(menu.onRelaunch(), true);
  assert.ok(win.assigned, 'navigated to the StarHermit launcher');
  // a plain sign-out keeps the old notice, no relaunch button
  assert.equal(signedOutMenu({ signedIn: false, reason: 'signed-out' }, sdk, 'en-US').onRelaunch, undefined);
  gs.destroy();
});

test('session-expired strings exist in all nine locales', () => {
  assert.equal(PLATFORM_LOCALES.length, 9);
  for (const l of PLATFORM_LOCALES) {
    const m = signedOutMenu({ reason: 'expired' }, { relaunch: () => true }, l);
    assert.ok(m.notice && m.onRelaunch, l);
  }
  assert.notEqual(signedOutMenu({ reason: 'expired' }, { relaunch: () => true }, 'de-DE').notice,
    signedOutMenu({ reason: 'expired' }, { relaunch: () => true }, 'en-US').notice);
});
