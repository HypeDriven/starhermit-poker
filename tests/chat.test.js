import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatCore } from '../src/chat.js';

function fakeClient(pages = []) {
  const calls = [];
  const queue = [...pages];
  return {
    calls,
    get: async (path) => {
      calls.push({ method: 'GET', path });
      return queue.shift() || { items: [] };
    },
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body });
      return {};
    },
  };
}

const msg = (id, content, sentAt) => ({
  id, conversationId: 'c1', senderId: 'u-x', senderUsername: 'x',
  content, kind: 'text', sentAt, isDeleted: false,
});

test('poll dedupes by message id and appends in order', async () => {
  const core = new ChatCore(fakeClient([
    { items: [msg('m2', 'two', '2026-07-24T10:00:02Z'), msg('m1', 'one', '2026-07-24T10:00:01Z')] },
    { items: [msg('m2', 'two', '2026-07-24T10:00:02Z'), msg('m1', 'one', '2026-07-24T10:00:01Z'), msg('m3', 'three', '2026-07-24T10:00:03Z')] },
  ]));
  const snapshots = [];
  core.onMessages = (msgs) => snapshots.push(msgs.map((m) => m.id));
  await core.poll();
  await core.poll();
  assert.deepEqual(snapshots, [['m1', 'm2'], ['m1', 'm2', 'm3']]);
  assert.equal(core.messages.length, 3);
});

test('send posts content and refreshes; empty and oversized rejected', async () => {
  const client = fakeClient([{ items: [] }]);
  const core = new ChatCore(client, 'c1');
  assert.equal(await core.send(''), false);
  assert.equal(await core.send('   '), false);
  assert.equal(await core.send('x'.repeat(2001)), false);
  assert.equal(await core.send('hello'), true);
  const post = client.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, '/api/v1/chat/conversations/c1/messages');
  assert.deepEqual(post.body, { content: 'hello' });
});

test('send is serialized (no double-send while in flight)', async () => {
  let release;
  const client = {
    get: async () => ({ items: [] }),
    post: () => new Promise((r) => { release = r; }),
  };
  const core = new ChatCore(client);
  const first = core.send('one');
  assert.equal(await core.send('two'), false); // blocked while sending
  release({});
  assert.equal(await first, true);
});

test('429 maps to a friendly rate-limit error', async () => {
  const core = new ChatCore({
    get: async () => ({ items: [] }),
    post: async () => { const e = new Error('HTTP 429'); e.status = 429; throw e; },
  });
  let error = null;
  core.onError = (m) => { error = m; };
  assert.equal(await core.send('spam'), false);
  assert.match(error, /slow down/i);
});
