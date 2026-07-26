import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPolite, rosterDiff } from '../src/voice.js';

test('politeness is deterministic and antisymmetric', () => {
  assert.equal(isPolite('b-user', 'a-user'), true);
  assert.equal(isPolite('a-user', 'b-user'), false);
  assert.notEqual(isPolite('x', 'y'), isPolite('y', 'x'));
});

test('rosterDiff connects new peers and drops departed ones', () => {
  const peers = new Map([['u-old', {}], ['u-stay', {}]]);
  const participants = [{ userId: 'u-stay' }, { userId: 'u-new' }, { userId: 'me' }];
  const { connect, drop } = rosterDiff(peers, participants, 'me');
  assert.deepEqual(connect, ['u-new']);
  assert.deepEqual(drop, ['u-old']);
});

test('rosterDiff ignores self and null user ids', () => {
  const { connect } = rosterDiff(new Map(), [{ userId: 'me' }, { userId: null }], 'me');
  assert.deepEqual(connect, []);
});
