// Shared profile cache.
// Contract: https://wiki.starhermit.com/docs/api/profile.html
//
// Launch tokens may call exactly two profile endpoints:
//   GET /api/v1/users/{id}/profile  -> { id, username, nickname }
//   GET /api/v1/users/{id}/avatar   -> PNG bytes (404 when unset)
// Display convention: nickname wins; then username; then
// "Player " + id.slice(0,8). Results (including failures and avatars) are
// cached for the session — no documented freshness/ETag mechanism exists.
// AI seats never go through here: their display name comes from the roster.

export class ProfileCache {
  // client: ApiClient (JSON calls); getToken: () => current launch token
  // (for the raw avatar fetch). onUpdate(userId) fires when data arrives so
  // screens can re-render.
  constructor(client, { getToken } = {}) {
    this.client = client;
    this.getToken = getToken || (() => null);
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
    if (p && p.username) return p.username;
    if (fallbackUsername) return fallbackUsername;
    return `Player ${String(userId).slice(0, 8)}`;
  }

  avatarUrl(userId) {
    if (!this.avatars.has(userId)) {
      this.avatars.set(userId, (async () => {
        try {
          const headers = {};
          const token = this.getToken();
          if (token) headers.Authorization = `Bearer ${token}`;
          const base = this.client.baseUrl || '';
          const res = await fetch(`${base}/api/v1/users/${userId}/avatar`, { headers });
          if (!res.ok) return null;
          const url = URL.createObjectURL(await res.blob());
          this.onUpdate(userId);
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
