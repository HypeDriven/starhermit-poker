// Shared profile cache.
// Contract: https://wiki.starhermit.com/docs/api/profile.html
//
// Launch tokens may call exactly two profile endpoints:
//   GET /api/v1/users/{id}/profile  -> { id, username, nickname }
//   GET /api/v1/users/{id}/avatar   -> PNG bytes (404 when unset)
// Display convention: the profile nickname, else "Player " + id.slice(0,8)
// (never the username). Before a profile arrives (or when it fails) the
// roster's name stands in. Results (including failures and avatars) are
// cached for the session — no documented freshness/ETag mechanism exists.
// Avatars come through the StarHermit SDK (Bearer + the SDK's API base).
// AI seats never go through here: their display name comes from the roster.

export class ProfileCache {
  // client: ApiClient (JSON calls); sdk: StarHermit SDK instance (avatars).
  // onUpdate(userId) fires when data arrives so screens can re-render.
  constructor(client, { sdk = globalThis.StarHermit || null } = {}) {
    this.client = client;
    this.sdk = sdk;
    this.listeners = new Set();
    this.profiles = new Map(); // userId -> Promise<profile|null>
    this.resolved = new Map(); // userId -> profile|null (arrived)
    this.avatars = new Map();  // userId -> Promise<objectURL|null>
  }

  addListener(fn) { this.listeners.add(fn); }
  removeListener(fn) { this.listeners.delete(fn); }
  onUpdate(userId) { for (const fn of this.listeners) fn(userId); }

  profile(userId) {
    if (!this.profiles.has(userId)) {
      this.profiles.set(userId, this.client
        .get(`/api/v1/users/${userId}/profile`)
        .catch(() => null)
        .then((p) => {
          this.resolved.set(userId, p);
          this.onUpdate(userId);
          return p;
        }));
    }
    return this.profiles.get(userId);
  }

  // Synchronous display name: resolved profile if it has arrived, otherwise
  // the roster/username fallback. Call profile(userId) first (fire-and-forget)
  // and re-render on onUpdate.
  displayName(userId, fallbackUsername) {
    const p = this.resolved.get(userId);
    if (p && p.nickname) return p.nickname;
    if (p) return `Player ${String(userId).slice(0, 8)}`;
    if (fallbackUsername) return fallbackUsername;
    return `Player ${String(userId).slice(0, 8)}`;
  }

  avatarUrl(userId) {
    if (!this.avatars.has(userId)) {
      this.avatars.set(userId, (async () => {
        try {
          const url = this.sdk ? await this.sdk.avatarUrl(userId) : null;
          if (url) this.onUpdate(userId);
          return url;
        } catch {
          return null;
        }
      })());
    }
    return this.avatars.get(userId);
  }

  destroy() {
    for (const p of this.avatars.values()) {
      p.then((url) => { if (url) URL.revokeObjectURL(url); }).catch(() => {});
    }
    this.profiles.clear();
    this.resolved.clear();
    this.avatars.clear();
  }
}

// One app-wide cache; screens resolve names through here.
let shared = null;
export function sharedProfiles(client, opts) {
  if (!shared && client) shared = new ProfileCache(client, opts);
  return shared;
}
