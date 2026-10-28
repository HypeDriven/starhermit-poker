// The offline table (src/offline.js) drives server.js exactly as the platform
// does, on an injected clock and random source: a whole match against the five
// AI seats ends with a result, the table model keeps a capped feed of the
// action log, the reveal window opens after each hand, the sound cues follow
// the state, and the only cards the player is ever sent are their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './harness.js';
import { OfflineTable, USER_ID, TICK_MS } from '../src/offline.js';
import { FEED_CAP, REVEAL_WINDOW_MS } from '../src/table-model.js';
import { setLocale } from '../src/i18n.js';

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTable(seed = 7) {
  const { game } = loadScript('server.js');
  let now = 1_800_000_000_000;
  const table = new OfflineTable({ game, now: () => now, random: seeded(seed) });
  return { table, advance: (ms) => { now += ms; }, now: () => now };
}

test('a whole offline match ends with a result (the player shoves every turn)', () => {
  setLocale('en-US');
  const { table, advance } = makeTable(11);
  table.start();
  const m = table.model;
  assert.ok(m.pub, 'the first state arrived');
  assert.equal(m.pub.seats.length, 6);
  let guard = 0;
  const cues = new Set();
  while (!table.over && guard++ < 20000) {
    const la = m.legal;
    if (la) {
      assert.ok(table.send(la.canAllIn === false ? { type: la.callAmount > 0 ? 'call' : 'check' } : { type: 'all-in' }), String(table.error));
    } else {
      advance(TICK_MS);
      table.update();
    }
    for (const s of m.take().sounds) cues.add(s);
    // Opponents' live hole cards never reach this client.
    const you = m.you;
    for (const s of m.pub.seats) if (s.userId !== USER_ID) assert.equal(s.holeCards, undefined);
    if (you && you.holeCards) assert.equal(you.holeCards.length, 2);
  }
  assert.ok(table.over, 'the match finished');
  assert.ok(m.matchOver, 'match-complete arrived');
  assert.ok(m.feed.length <= FEED_CAP);
  for (const c of ['deal', 'chips', 'turn', 'win']) assert.ok(cues.has(c), `cue ${c}`);
});

test('the reveal window opens after a hand and closes after its time', () => {
  const { table, advance } = makeTable(3);
  table.start();
  const m = table.model;
  let guard = 0;
  while (!m.revealUntil && guard++ < 5000) {
    if (m.legal) table.send({ type: m.legal.callAmount > 0 ? 'call' : 'check' });
    else { advance(TICK_MS); table.update(); }
  }
  assert.ok(m.revealUntil > 0, 'a hand completed');
  advance(REVEAL_WINDOW_MS + 1);
  assert.equal(m.reveal(), null);
});

test('a rejected command keeps the error for the screen', () => {
  const { table } = makeTable(5);
  table.start();
  const m = table.model;
  if (!m.legal) {
    assert.equal(table.send({ type: 'check' }), false);
    assert.ok(table.error);
  } else {
    assert.equal(table.send({ type: 'raise', amount: 1 }), false);
    assert.match(String(table.error), /Minimum|Cannot|raise/i);
  }
});

test('the same seed and clock deal the same match (play scripts replay exactly)', () => {
  const run = () => {
    const { table, advance } = makeTable(42);
    table.start();
    const log = [];
    for (let i = 0; i < 200 && !table.over; i++) {
      if (table.model.legal) table.send({ type: 'fold' });
      else { advance(TICK_MS); table.update(); }
      log.push(JSON.stringify(table.model.pub.board) + table.model.pub.handNumber);
    }
    return log.join('|');
  };
  assert.equal(run(), run());
});
