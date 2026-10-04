// Player preferences mirrored to the StarHermit per-game settings KV.
// Contract: /api/v1/games/{slug}/settings (via the shared SDK).
//
// Keys: `graphics` (the saved graphics settings object) and `soundEnabled`.
// On sign-in the platform values win over this browser's; afterwards every
// change is PATCHed. Nothing is sent before the platform values were read,
// and nothing at all without a token (the SDK resolves locally then).

import { graphics } from './gfx-settings.js';

export const SOUND_ENABLED_KEY = 'poker.soundEnabled';

let sdk = null;
let loaded = false;
const sent = {};

/** Mirror one preference (no-op until loadPlatformPrefs ran signed in). */
export function pushPref(key, value) {
  if (!loaded || !sdk || !sdk.signedIn) return null;
  const json = JSON.stringify(value);
  if (sent[key] === json) return null;
  sent[key] = json;
  return sdk.patchSettings({ [key]: value });
}

/** Read the platform values, apply them locally, then keep them in sync. */
export async function loadPlatformPrefs(instance) {
  sdk = instance;
  if (!sdk || !sdk.signedIn) return {};
  const remote = (await sdk.getSettings()) || {};
  for (const [k, v] of Object.entries(remote)) sent[k] = JSON.stringify(v);
  if (remote.graphics && typeof remote.graphics === 'object'
      && JSON.stringify(remote.graphics) !== JSON.stringify(graphics.saved)) {
    graphics.replace(remote.graphics);
  }
  if (typeof remote.soundEnabled === 'boolean') {
    try { localStorage.setItem(SOUND_ENABLED_KEY, remote.soundEnabled ? '1' : '0'); } catch { /* storage unavailable */ }
  }
  if (!loaded) graphics.subscribe(() => pushPref('graphics', graphics.saved));
  loaded = true;
  pushPref('graphics', graphics.saved);
  let sound = true;
  try { sound = localStorage.getItem(SOUND_ENABLED_KEY) !== '0'; } catch { /* default on */ }
  pushPref('soundEnabled', sound);
  return remote;
}
