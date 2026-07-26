import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileCache } from '../src/profiles.js';

function fakeClient(profileResponses = {}) {
  const calls = [];
  return {
    calls,
    baseUrl: '',
    get: async (path) => {
      calls.push(path);
      const id = path.match(/users\/(.+)\/profile/)[1];
      if (profileResponses[id] === 'error') throw new Error('HTTP 500');
      return profileResponses[id] || null;
    },
  };
}

test('displayName prefers nickname, then username, then Player fallback', async () => {
  const cache = new ProfileCache(fakeClient({
    'u-nick': { id: 'u-nick', username: 'alice123', nickname: 'Al' },
    'u-plain': { id: 'u-plain', username: 'bob456', nickname: null },
  }));
  await cache.profile('u-nick');
  await cache.profile('u-plain');
  assert.equal(cache.displayName('u-nick'), 'Al');
  assert.equal(cache.displayName('u-plain'), 'bob456');
  assert.equal(cache.displayName('u-1234567890ab'), 'Player u-123456');
});

test('profile fetch is deduped and failures are cached', async () => {
  const client = fakeClient({ 'u-x': { id: 'u-x', username: 'x', nickname: null } });
  const cache = new ProfileCache(client);
  await Promise.all([cache.profile('u-x'), cache.profile('u-x'), cache.profile('u-x')]);
  assert.equal(client.calls.length, 1);
  const errClient = fakeClient({ 'u-bad': 'error' });
  const cache2 = new ProfileCache(errClient);
  assert.equal(await cache2.profile('u-bad'), null);
  assert.equal(cache2.displayName('u-bad', 'roster-name'), 'roster-name');
});

test('listeners fire when a profile arrives', async () => {
  const cache = new ProfileCache(fakeClient({
    'u-a': { id: 'u-a', username: 'a', nickname: 'A!' },
  }));
  const seen = [];
  cache.addListener((id) => seen.push(id));
  await cache.profile('u-a');
  assert.deepEqual(seen, ['u-a']);
  cache.removeListener(seen[0] && cache.listeners.values().next().value);
});
