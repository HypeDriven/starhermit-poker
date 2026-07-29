import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, createNetContext } from '../src/net.js';

// Minimal Response stand-in matching what ApiClient consumes.
function fakeResponse({ status = 200, body = '' }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status-${status}`,
    text: async () => body,
  };
}

function recordingClient({ token = 'tok', baseUrl = '', responses = [] } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return queue.length ? queue.shift() : fakeResponse({ body: '{}' });
  };
  const client = new ApiClient({ getToken: () => token, baseUrl, fetchImpl });
  return { client, calls };
}

test('adds Authorization: Bearer to authenticated calls', async () => {
  const { client, calls } = recordingClient({ token: 'abc' });
  await client.get('/api/v1/games/83fd04b1-3cbe-4b09-a251-3733ad4b9d94');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer abc');
});

test('omits Authorization when there is no token', async () => {
  const { client, calls } = recordingClient({ token: null });
  await client.get('/api/v1/games/83fd04b1-3cbe-4b09-a251-3733ad4b9d94');
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test('joins baseUrl for local dev and keeps same-origin relative in production', async () => {
  const prod = recordingClient({ baseUrl: '' });
  await prod.client.get('/api/v1/games/83fd04b1-3cbe-4b09-a251-3733ad4b9d94');
  assert.equal(prod.calls[0].url, '/api/v1/games/83fd04b1-3cbe-4b09-a251-3733ad4b9d94');

  const dev = recordingClient({ baseUrl: 'http://localhost:5000/' });
  await dev.client.get('/api/v1/games/83fd04b1-3cbe-4b09-a251-3733ad4b9d94');
  assert.equal(dev.calls[0].url, 'http://localhost:5000/api/v1/games/83fd04b1-3cbe-4b09-a251-3733ad4b9d94');
});

test('rejects non-rooted paths', async () => {
  const { client } = recordingClient();
  await assert.rejects(() => client.get('http://evil.example/x'));
});

test('returns null on 204 and parses JSON bodies', async () => {
  const { client } = recordingClient({
    responses: [fakeResponse({ status: 204 }), fakeResponse({ body: '{"a":1}' })],
  });
  assert.equal(await client.get('/x'), null);
  assert.deepEqual(await client.get('/x'), { a: 1 });
});

test('surfaces backend {"error": "..."} message and status', async () => {
  const { client } = recordingClient({
    responses: [fakeResponse({ status: 403, body: '{"error":"not friends"}' })],
  });
  await assert.rejects(
    () => client.post('/api/v1/realtime/rooms/r1/invites', { toUserId: 'u' }),
    (e) => e instanceof ApiError && e.status === 403 && e.message === 'not friends'
  );
});

test('sends JSON bodies with content-type', async () => {
  const { client, calls } = recordingClient();
  await client.post('/x', { hello: 'world' });
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body, '{"hello":"world"}');
});

test('createNetContext reads scope and user id from the token claims', () => {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // game_scope carries the game's uid — the platform assigns it and nothing chooses it.
  const uid = '83fd04b1-3cbe-4b09-a251-3733ad4b9d94';
  const token = `${b64url({ alg: 'none' })}.${b64url({ sub: 'u-1', game_scope: uid })}.sig`;
  const net = createNetContext({ token, apiBase: 'http://localhost:5000' });
  // destroy() in a finally: the token manager holds a timer, so an assertion failing before it
  // ran used to leave the test runner hanging instead of reporting the failure.
  try {
    assert.equal(net.scope, uid);
    assert.equal(net.userId, 'u-1');
    assert.equal(net.client.baseUrl, 'http://localhost:5000');
  } finally {
    net.tokenManager.destroy();
  }
});

test('createNetContext has no slug to fall back to without claims', () => {
  // There is no default any more: a slug is the game's uid, so no value could be guessed here.
  // Local dev supplies it explicitly through the auth panel; production always has the claim.
  const net = createNetContext({ token: 'garbage' });
  try {
    assert.equal(net.scope, '');
    assert.equal(net.userId, null);
  } finally {
    net.tokenManager.destroy();
  }
});
