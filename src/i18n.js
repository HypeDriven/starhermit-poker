// StarHermit Poker — the game language: string lookup, number grouping and the
// rules engine's English (hand descriptions, rejections) in the player's
// language. Pure (no DOM, no host): the engine client (native/i18n.ts) sets the
// locale from the runtime's interface language, and the node tests drive it
// directly. Strings are keyed by their en-US text (strings.js); EN holds the
// symbolic keys.

import { STRINGS, EN } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

let locale = 'en-US';
let table = STRINGS['en-US'];
const listeners = new Set();

/** Translate an en-US string (or symbolic key); {name} placeholders filled from vars. */
export function t(key, vars) {
  let s = table[key] ?? STRINGS['en-US'][key] ?? EN[key] ?? key;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function getLocale() { return locale; }

// Digit grouping per locale, as the browsers' toLocaleString wrote it (es-ES and
// it-IT leave four-digit numbers ungrouped; fr-FR groups with a narrow no-break
// space, fr-CA with a no-break space).
const GROUP = {
  'en-US': [',', 1], 'en-GB': [',', 1], 'es-419': [',', 1], 'es-ES': ['.', 2], 'de-DE': ['.', 1],
  'fr-FR': [' ', 1], 'fr-CA': [' ', 1], 'pt-BR': ['.', 1], 'it-IT': ['.', 2],
};
/** Locale-aware integer grouping (chip counts are whole numbers). */
export function num(n) {
  const v = Math.round(Number(n) || 0);
  const neg = v < 0;
  const digits = String(Math.abs(v));
  const [sep, minGroups] = GROUP[locale] || GROUP['en-US'];
  if (digits.length <= 3 || (minGroups === 2 && digits.length < 5)) return (neg ? '-' : '') + digits;
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
    out += digits[i];
  }
  return (neg ? '-' : '') + out;
}

/** fn(locale) after every language change; returns an unsubscribe function. */
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setLocale(next) {
  const resolved = LOCALES.includes(next) ? next : 'en-US';
  const changed = resolved !== locale;
  locale = resolved;
  table = STRINGS[locale] || STRINGS['en-US'];
  if (changed) for (const fn of [...listeners]) { try { fn(locale); } catch (e) { console.error(e); } }
  return locale;
}

/** Betting street (preflop / flop / turn / river / showdown) for status lines. */
export function streetName(street) {
  return street ? t('street.' + street) : t('waiting');
}

const CATEGORY = {
  'High Card': 'hand.high-card', 'One Pair': 'hand.one-pair', 'Two Pair': 'hand.two-pair',
  'Three of a Kind': 'hand.trips', 'Straight': 'hand.straight', 'Flush': 'hand.flush',
  'Full House': 'hand.full-house', 'Four of a Kind': 'hand.quads', 'Straight Flush': 'hand.straight-flush',
};
const RANK_WORDS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const rankOne = (w) => { const i = RANK_WORDS.indexOf(w); return i >= 0 ? t('rank.' + i) : w; };
const rankMany = (w) => { const i = RANK_PLURAL.indexOf(w); return i >= 0 ? t('ranks.' + i) : w; };

/**
 * The rules engine (server.js) describes hands in English ("Two Pair, Kings and
 * Tens", "Flush, Ace high", "Full House, Nines over Fours"); render one in the
 * game language. Unknown text passes through unchanged.
 */
export function handDescription(desc) {
  const m = /^(High Card|One Pair|Two Pair|Three of a Kind|Straight Flush|Straight|Flush|Full House|Four of a Kind), (.+)$/.exec(String(desc || ''));
  if (!m) return desc;
  const cat = m[1], rest = m[2];
  let r;
  if ((r = /^(\w+) high$/.exec(rest))) return t('{hand}, {rank} high', { hand: t(CATEGORY[cat]), rank: rankOne(r[1]) });
  if ((r = /^(\w+) over (\w+)$/.exec(rest))) return t('{hand}, {a} over {b}', { hand: t(CATEGORY[cat]), a: rankMany(r[1]), b: rankMany(r[2]) });
  if ((r = /^(\w+) and (\w+)$/.exec(rest))) return t('{hand}, {a} and {b}', { hand: t(CATEGORY[cat]), a: rankMany(r[1]), b: rankMany(r[2]) });
  if (cat === 'High Card') return t('{hand}, {rank}', { hand: t(CATEGORY[cat]), rank: rankOne(rest) });
  return t('{hand}, {rank}', { hand: t(CATEGORY[cat]), rank: rankMany(rest) });
}

/** Rejections from the rules engine / platform, in the game language. */
export function serverMessage(msg) {
  const s = String(msg || '');
  let m;
  if ((m = /^Minimum bet is (\d+)$/.exec(s))) return t('Minimum bet is {n}', { n: num(m[1]) });
  if ((m = /^Minimum raise total is (\d+)$/.exec(s))) return t('Minimum raise total is {n}', { n: num(m[1]) });
  if ((m = /^Unknown (action|command): ?(.*)$/.exec(s))) return t('Unknown command: {name}', { name: m[2] });
  return t(s);
}
