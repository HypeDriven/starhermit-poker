// The string tables for the node tests: binds src/i18n.js to assets/strings.json
// as the client binds it to the engine's `strings`.
import { readFileSync } from 'node:fs';
import { bindStrings } from '../src/i18n.js';

export const STRINGS = JSON.parse(readFileSync(new URL('../assets/strings.json', import.meta.url), 'utf8'));
let locale = 'en-US';
export function setLocale(next) { locale = next in STRINGS ? next : 'en-US'; return locale; }
bindStrings({
  t(key, vars) {
    const s = STRINGS[locale][key] ?? STRINGS['en-US'][key] ?? key;
    return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  },
  locale: () => locale,
});
