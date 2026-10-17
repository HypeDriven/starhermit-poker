// StarHermit Poker — game language. One source for every string module (this
// file; gfx-i18n.js and platform-i18n.js read getLocale()): sh-language.js
// resolves the Language setting — explicit game choice (ui.language) → for
// Automatic the StarHermit account's preferred language → navigator.languages
// → en-US. Strings are keyed by their en-US text (strings.js); EN holds the
// symbolic keys. A change re-applies static markup (data-i18n, data-i18n-aria,
// data-i18n-title, data-i18n-placeholder) and fires the listeners; app.js then
// asks the current screen to re-render its dynamic text. Sockets, rooms and the
// hand in progress are never touched.

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

/** Locale-aware number grouping. */
export function num(n) { return Number(n || 0).toLocaleString(locale); }

/** fn(locale) after every language change; returns an unsubscribe function. */
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const varsOf = (n) => { try { return n.dataset.i18nVars ? JSON.parse(n.dataset.i18nVars) : undefined; } catch { return undefined; } };

/** Re-apply static markup under root. */
export function applyStatic(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n, varsOf(n));
  for (const n of root.querySelectorAll('[data-i18n-aria]')) n.setAttribute('aria-label', t(n.dataset.i18nAria));
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.setAttribute('title', t(n.dataset.i18nTitle));
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.setAttribute('placeholder', t(n.dataset.i18nPlaceholder));
}

export function setLocale(next) {
  const resolved = LOCALES.includes(next) ? next : 'en-US';
  const changed = resolved !== locale;
  locale = resolved;
  table = STRINGS[locale] || STRINGS['en-US'];
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  if (document.readyState !== 'loading') applyStatic();
  if (changed) for (const fn of [...listeners]) { try { fn(locale); } catch (e) { console.error(e); } }
}

/**
 * DOM builder shared by the screens. Besides class/text/on*, it takes
 * i18n (key, or [key, vars]) for text, i18nAria / i18nTitle / i18nPlaceholder
 * for attributes — the node keeps the key so a language change re-applies it.
 * false / null attributes are skipped, true sets an empty attribute.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'i18n') {
      const [key, vars] = Array.isArray(v) ? v : [v];
      node.dataset.i18n = key;
      if (vars) node.dataset.i18nVars = JSON.stringify(vars);
      node.textContent = t(key, vars);
    } else if (k === 'i18nAria') { node.dataset.i18nAria = v; node.setAttribute('aria-label', t(v)); }
    else if (k === 'i18nTitle') { node.dataset.i18nTitle = v; node.setAttribute('title', t(v)); }
    else if (k === 'i18nPlaceholder') { node.dataset.i18nPlaceholder = v; node.setAttribute('placeholder', t(v)); }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
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

// sh-language.js (classic script loaded before the modules) owns resolution,
// storage and the Settings → Language selector; it calls apply() now and on changes.
export const language = (typeof window !== 'undefined' && window.StarHermitLanguage)
  ? window.StarHermitLanguage.create({ game: 'poker', supported: LOCALES, apply: setLocale })
  : null;
if (!language) setLocale('en-US');
if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyStatic(), { once: true });
}
