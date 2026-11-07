// Localization: the nine StarHermit locales in assets/strings.json (en-US text
// or a symbolic key as the key; `acct.*` the game's own account lines), through
// the engine's `strings`, which follows the player's language (Options ›
// Language, else the account's or the device's) and owns the sign-in, invite and
// leaderboard lines (`starhermit.*`). Every string is drawn through T() each
// frame, so a change shows on the next frame, and the feed lines are functions
// rendered in the current language. Card names (A♣, 10♥ …) are the same everywhere.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { bindStrings, num, t } from "../src/i18n.js";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
bindStrings({
  // Rule rejections and other text from outside the tables pass through, as the old lookup did.
  t: (key: unknown, vars?: Vars) => {
    if (typeof key === "string" && strings.has(key)) return strings.t(key, vars);
    if (typeof key !== "string" || !vars) return key;
    return key.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  },
  locale: () => strings.locale,
});
/** A game string by its en-US key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return t(key, vars ?? undefined) as string; }
/** Marks an en-US key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** Chip counts with the locale's grouping. */
export function Num(n: number): string { return num(n) as string; }
