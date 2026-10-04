// StarHermit integration over the shared SDK with a stubbed fetch: launch
// token capture, nickname, settings KV mirror and the invite link — and no
// request at all without a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureLaunchCredentials, createNetContext } from '../src/net.js';
import { ProfileCache } from '../src/profiles.js';

// The SDK is a classic browser script: evaluate it the way a <script> would.
const holder = {};
new Function('self', 'module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(holder, undefined);
const SDK = holder.StarHermit;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `h.${b64u({ sub: 'user-0011aabb', game_scope: 'pk-slug', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

function install(href) {
  const calls = [];
  const kv = { soundEnabled: false, graphics: { preset: 'low' } };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    const r = (status, body) => new Response(body, { status });
    const j = (o) => r(200, JSON.stringify(o));
    if (url === '/api/v1/users/user-0011aabb/profile') return j({ username: 'hidden', nickname: 'River Rat' });
    if (url.endsWith('/settings') && init.method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return j({}); }
    if (url.endsWith('/settings')) return j({ settings: kv });
    return r(404, '');
  };
  const u = new URL(href);
  const loc = { hash: u.hash, search: u.search, pathname: u.pathname, origin: u.origin, hostname: u.hostname, href };
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.StarHermit = SDK.create({ window: { location: loc, history: { replaceState() {} } }, fetch, setTimeout: () => 0, clearTimeout: () => {} });
  return { calls, kv, store };
}

test('hosted: launch token, nickname, settings KV, invite link', async () => {
  const h = install(`https://pk-slug.starhermit.com/#game_token=${TOKEN}&session_id=s-42`);
  const creds = captureLaunchCredentials();
  assert.deepEqual(creds, { token: TOKEN, sessionId: 's-42' });
  const net = createNetContext({ token: creds.token });
  assert.equal(net.scope, 'pk-slug');
  assert.equal(net.userId, 'user-0011aabb');

  const profiles = new ProfileCache({ get: (p) => globalThis.StarHermit.api(p) });
  await profiles.profile(net.userId);
  assert.equal(profiles.displayName(net.userId), 'River Rat');

  const { loadPlatformPrefs, pushPref, SOUND_ENABLED_KEY } = await import('../src/platform-prefs.js');
  const remote = await loadPlatformPrefs(net.sdk);
  assert.equal(remote.soundEnabled, false);
  assert.equal(h.store.get(SOUND_ENABLED_KEY), '0', 'platform value wins locally');
  await pushPref('soundEnabled', true);
  const patches = h.calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.init.body).settings);
  assert.deepEqual(patches.at(-1), { soundEnabled: true });
  assert.equal(h.kv.soundEnabled, true);
  assert.ok(h.calls.every((c) => c.init.headers.Authorization === `Bearer ${TOKEN}`));
  assert.match(net.sdk.inviteLink(), /\/game-invite\/user-0011aabb\/pk-slug$/);
});

test('standalone: no token means no request and no sign-in off-platform', async () => {
  const h = install('http://localhost:8080/index.html');
  assert.deepEqual(captureLaunchCredentials(), { token: null, sessionId: null });
  assert.equal(globalThis.StarHermit.canSignIn(), false);
  assert.equal(globalThis.StarHermit.inviteLink(), null);
  assert.equal(h.calls.length, 0);
});

test('sign-in is offered on <id>.starhermit.com without a token', () => {
  const h = install('https://pk-slug.starhermit.com/');
  captureLaunchCredentials();
  assert.equal(globalThis.StarHermit.canSignIn(), true);
  assert.equal(h.calls.length, 0);
});
