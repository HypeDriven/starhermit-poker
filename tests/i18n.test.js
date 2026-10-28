// Every player-facing key used in the engine client (native/*.ts: T('…'), N('…'))
// and the shared modules (src/*.js: t('…'), plus the
// symbolic keys built at runtime: streets, room states, badges, hand names,
// rule rejections) exists in all nine locales with the same {placeholders}.
// DUMP=1 lists the keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, EN } from '../src/strings.js';
import { t, setLocale, handDescription, serverMessage } from '../src/i18n.js';
import { describeLogEntry } from '../src/table-utils.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const lit = /(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.source;
const unq = (m) => (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"');

// Rejections the rules engine (server.js) can send to a player.
export const SERVER_MESSAGES = [
  'No active session state', 'Malformed command', 'Stale state version', 'The match is over',
  'You are not seated at this table', 'This seat is played by the AI', 'enabled must be a boolean',
  'No hand is running', 'It is not your turn', 'You have folded', 'You are all-in', 'You are eliminated',
  'amount must be a non-negative safe integer',
  'Action is closed — a full raise has not occurred since your last action',
  'Bet amount must be a non-negative integer', 'Bet exceeds your stack', 'Bet must be positive',
  'Cannot bet — there is already a bet this round', 'Cannot check — there is a bet to call',
  'Cannot raise — use bet', 'Nothing to call', 'Raise amount must be a non-negative integer',
  'Raise exceeds your stack', 'Raise must exceed the current bet',
  'Minimum bet is {n}', 'Minimum raise total is {n}', 'Unknown command: {name}',
];

export function usedKeys() {
  const keys = new Set();
  const srcFiles = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'))
    .filter((f) => !['strings.js', 'platform-i18n.js'].includes(f)).map((f) => 'src/' + f);
  const nativeFiles = readdirSync(new URL('../native/', import.meta.url)).filter((f) => f.endsWith('.ts')).map((f) => 'native/' + f);
  for (const f of [...srcFiles, ...nativeFiles]) {
    const src = read(f);
    const re = [
      new RegExp(`(?<![\\w.])(?:t|tr|T|N)\\(\\s*${lit}`, 'g'),
      new RegExp(`(?<![\\w.])(?:t|T)\\(\\s*[^,()]*?\\?\\s*${lit}\\s*:\\s*${lit}`, 'g'),
    ];
    for (const r of re) {
      for (const m of src.matchAll(r)) {
        if (m.length > 3) { keys.add((m[1] ?? m[2]).replace(/\\'/g, "'")); keys.add((m[3] ?? m[4]).replace(/\\'/g, "'")); }
        else keys.add(unq(m));
      }
    }
  }
  for (const k of ['Unready', 'Ready', 'Friends: on', 'Friends: off']) keys.add(k);
  for (const k of SERVER_MESSAGES) keys.add(k);
  for (const k of Object.keys(EN)) keys.add(k);
  // dynamic prefixes are covered by EN (street.*, room.*, …); drop the bare prefixes and template keys
  for (const k of [...keys]) if (k === '' || /^[\w-]+\.$/.test(k) || k.includes('${')) keys.delete(k);
  return keys;
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key exists in every translated locale with matching placeholders', () => {
  const keys = usedKeys();
  if (process.env.DUMP) console.log([...keys].sort().map((k) => JSON.stringify(k)).join('\n'));
  assert.ok(keys.size > 150, 'key scan found ' + keys.size);
  const missing = [];
  for (const loc of LOCALES) {
    if (loc.startsWith('en-')) continue;
    for (const k of keys) {
      const v = STRINGS[loc][k];
      if (typeof v !== 'string' || !v) missing.push(loc + ': ' + k);
      else if (ph(v) !== ph(EN[k] ?? k)) missing.push(loc + ' placeholders: ' + k);
    }
  }
  assert.deepEqual(missing, []);
});

test('nine locales; en-GB overrides only real keys; symbolic keys have en-US text', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const keys = usedKeys();
  for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
  for (const s of ['preflop', 'flop', 'turn', 'river', 'showdown']) {
    assert.ok(EN['street.' + s], 'street.' + s);
    assert.ok(EN['street-dealt.' + s], 'street-dealt.' + s);
  }
  for (const s of ['Lobby', 'Open', 'Playing', 'Closed']) assert.ok(EN['room.' + s], 'room.' + s);
  for (let i = 0; i < 13; i++) assert.ok(EN['rank.' + i] && EN['ranks.' + i], 'rank ' + i);
});

test('hand descriptions, rule rejections and feed lines follow the language', () => {
  setLocale('en-US');
  assert.equal(handDescription('Two Pair, Kings and Tens'), 'Two Pair, Kings and Tens');
  assert.equal(handDescription('Full House, Nines over Fours'), 'Full House, Nines over Fours');
  assert.equal(handDescription('Flush, Ace high'), 'Flush, Ace high');
  assert.equal(serverMessage('Minimum bet is 100'), 'Minimum bet is 100');
  setLocale('de-DE');
  assert.equal(handDescription('Two Pair, Kings and Tens'), STRINGS['de-DE']['{hand}, {a} and {b}']
    .replace('{hand}', STRINGS['de-DE']['hand.two-pair']).replace('{a}', STRINGS['de-DE']['ranks.11']).replace('{b}', STRINGS['de-DE']['ranks.8']));
  assert.equal(serverMessage('It is not your turn'), STRINGS['de-DE']['It is not your turn']);
  assert.match(serverMessage('Minimum raise total is 200'), /200/);
  assert.equal(describeLogEntry([1, 1, 0, 'fold', 0], [{ name: 'ada' }]), t('{name} folded.', { name: 'Ada' }));
  assert.notEqual(describeLogEntry([1, 1, 0, 'fold', 0], [{ name: 'ada' }]), 'Ada folded.');
  setLocale('en-US');
});
