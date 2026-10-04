import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wsUrl,
  backoffDelay,
} from '../src/net.js';
import { loadScript } from './harness.js';

// Launch-token parsing and claim decoding live in the StarHermit SDK
// (tests/platform.test.js covers the adapter on top of it).

test('wsUrl follows the page protocol', () => {
  const http = { protocol: 'http:', host: 'localhost:5000' };
  const https = { protocol: 'https:', host: 'poker.starhermit.com' };
  assert.equal(
    wsUrl('/ws/v1/games', { sessionId: 's1', access_token: 't+k/e=' }, http),
    'ws://localhost:5000/ws/v1/games?sessionId=s1&access_token=t%2Bk%2Fe%3D'
  );
  assert.equal(
    wsUrl('/ws/v1/realtime', { roomId: 'r1' }, https),
    'wss://poker.starhermit.com/ws/v1/realtime?roomId=r1'
  );
});

test('backoffDelay is exponential from 1s capped at 30s', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(2), 4000);
  assert.equal(backoffDelay(3), 8000);
  assert.equal(backoffDelay(4), 16000);
  assert.equal(backoffDelay(5), 30000);
  assert.equal(backoffDelay(10), 30000);
  assert.equal(backoffDelay(-3), 1000);
});

test('server.js loads as a plain script and exposes the contract globals', () => {
  const g = loadScript('server.js');
  assert.equal(typeof g.game.createSession, 'function');
  assert.equal(typeof g.game.onPlayerMessage, 'function');
  assert.equal(typeof g.game.onTick, 'function');
  assert.equal(typeof g.pokerRules, 'object');
});

test('server.js stub createSession returns a summary window', () => {
  const g = loadScript('server.js');
  const res = g.game.createSession({ now: 0, random: 0.5, players: [] });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.sessionState.summary), [
    'turnPlayerId', 'deadline', 'status', 'moveCount',
  ]);
});
