// StarHermit Poker — networking layer.
// Contract source: https://wiki.starhermit.com/docs/api/auth.html,
// https://wiki.starhermit.com/docs/api/games.html,
// https://wiki.starhermit.com/docs/api/realtime.html
//
// Rules enforced here:
// - `#game_token=<jwt>` is read from the URL hash exactly once, then stripped
//   with history.replaceState. The token lives only in memory afterwards.
// - The JWT payload is decoded locally ONLY to read non-security UI values
//   (`sub`, `game_scope`). Decoded claims are never treated as proof of
//   authorization — the platform validates the token on every call.
// - All REST paths are same-origin relative; the game slug always comes from
//   the `game_scope` claim, never from a hard-coded constant.
// - WebSocket scheme follows the page protocol (ws: for http:, wss: for https:).
// - Reconnects use exponential backoff from 1 s to a 30 s ceiling.
// - Every timer and socket is cancellable via destroy().

import { GAME } from './config.js';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in Node)

// Parse the launch hash. Accepts with or without the leading '#'.
// Returns { token: string|null, sessionId: string|null }.
export function parseLaunchHash(hash) {
  const out = { token: null, sessionId: null };
  if (!hash) return out;
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of trimmed.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = decodeURIComponent(part.slice(eq + 1));
    if (key === 'game_token' && value) out.token = value;
    else if (key === 'session_id' && value) out.sessionId = value;
  }
  return out;
}

// Decode a JWT payload WITHOUT verifying the signature. UI convenience only.
// Returns the claims object, or null if the token is malformed.
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    let json;
    if (typeof atob === 'function') {
      json = decodeURIComponent(
        Array.from(atob(padded), (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
      );
    } else {
      json = Buffer.from(padded, 'base64').toString('utf8');
    }
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

// Build a ws:/wss: URL for a same-origin path. protocol/host are injectable
// for tests; in the browser pass nothing and location is used.
export function wsUrl(path, params, loc) {
  const l = loc || (typeof location !== 'undefined' ? location : null);
  if (!l) throw new Error('wsUrl: no location available');
  const scheme = l.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams(params).toString();
  return `${scheme}//${l.host}${path}${qs ? '?' + qs : ''}`;
}

// Exponential backoff: 1 s, 2 s, 4 s, ... capped at 30 s (attempt is 0-based).
export function backoffDelay(attempt, baseMs = GAME.reconnectBaseMs, maxMs = GAME.reconnectMaxMs) {
  const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return Math.min(baseMs * 2 ** n, maxMs);
}

// ---------------------------------------------------------------------------
// Launch-token capture (browser, once per page load)

let captured = null;

// Reads and strips the launch hash exactly once. Subsequent calls return the
// originally captured values. Safe to call before DOM ready.
export function captureLaunchCredentials() {
  if (captured) return captured;
  const { token, sessionId } = parseLaunchHash(
    typeof location !== 'undefined' ? location.hash : ''
  );
  if (token && typeof history !== 'undefined' && history.replaceState) {
    // Remove the JWT from the visible URL. session_id is not sensitive, but
    // keeping the URL clean avoids re-processing it on refresh.
    history.replaceState(null, '', location.pathname + location.search);
  }
  captured = { token, sessionId };
  return captured;
}

// ---------------------------------------------------------------------------
// Token manager: holds the launch token in memory and refreshes it before
// expiry using the documented self re-mint endpoint.

export class TokenManager {
  // onRefresh(token) is called every time the token rotates (sockets use the
  // current value at connect time, so no action is usually needed).
  constructor({ token, scope, api, refreshMs = GAME.tokenRefreshMs, onRefresh = null }) {
    this.token = token;
    this.scope = scope;
    this.api = api;
    this.refreshMs = refreshMs;
    this.onRefresh = onRefresh;
    this._timer = null;
    this._destroyed = false;
    if (token) this._schedule();
  }

  _schedule() {
    this._clear();
    this._timer = setTimeout(() => this.refresh(), this.refreshMs);
  }

  _clear() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async refresh() {
    if (this._destroyed || !this.token) return;
    try {
      // A scoped token may re-mint a token for its own game.
      const res = await this.api.post(`/api/v1/games/${this.scope}/launch-token`, null);
      if (res && typeof res.token === 'string') {
        this.token = res.token;
        if (this.onRefresh) this.onRefresh(res.token);
      }
    } catch {
      // Keep the current token; retry on the next cycle. If it has genuinely
      // expired, API calls will start failing with 401 and the UI will
      // surface the auth problem.
    }
    if (!this._destroyed) this._schedule();
  }

  destroy() {
    this._destroyed = true;
    this._clear();
  }
}

// ---------------------------------------------------------------------------
// REST client: same-origin relative paths, Bearer auth, JSON in/out.

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
  }
}

export class ApiClient {
  // getToken: () => current launch token (may change after refresh).
  constructor(getToken) {
    this.getToken = getToken;
  }

  async request(method, path, body) {
    if (!path.startsWith('/')) throw new Error('ApiClient: paths must be same-origin relative');
    const headers = {};
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      throw new ApiError(res.status, (data && data.error) || res.statusText);
    }
    return data;
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  del(path) { return this.request('DELETE', path); }
}

// ---------------------------------------------------------------------------
// ReconnectingSocket: one logical WebSocket with exponential backoff.
// Guarantees a single active socket instance: connect() supersedes any
// previous attempt, and destroy() cancels pending reconnects.

export class ReconnectingSocket {
  // urlFactory: () => string  (called on every connect, so refreshed tokens
  // and new session ids are picked up). Handlers: onOpen, onMessage(data, isBinary),
  // onDown (socket lost, will retry), onGiveUp optional.
  constructor({ urlFactory, onOpen, onMessage, onDown, backoff = backoffDelay, wsImpl = null }) {
    this.urlFactory = urlFactory;
    this.onOpen = onOpen || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onDown = onDown || (() => {});
    this.backoff = backoff;
    this.WS = wsImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.attempt = 0;
    this.socket = null;
    this._timer = null;
    this._destroyed = false;
    this.connected = false;
  }

  connect() {
    if (this._destroyed) return;
    this._cancelTimer();
    this._closeSocket();
    const ws = new this.WS(this.urlFactory());
    this.socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.attempt = 0;
      this.connected = true;
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      if (this.socket !== ws) return;
      this.onMessage(ev.data, typeof ev.data !== 'string');
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.connected = false;
      this.onDown();
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    const delay = this.backoff(this.attempt++);
    this._timer = setTimeout(() => this.connect(), delay);
  }

  send(textOrBinary) {
    if (this.socket && this.connected) {
      this.socket.send(textOrBinary);
      return true;
    }
    return false;
  }

  sendJson(obj) {
    return this.send(JSON.stringify(obj));
  }

  _cancelTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _closeSocket() {
    if (this.socket) {
      const ws = this.socket;
      this.socket = null;
      this.connected = false;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  destroy() {
    this._destroyed = true;
    this._cancelTimer();
    this._closeSocket();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap helper: build the shared net context from the captured launch
// credentials (or a locally supplied dev token — see checkpoint 3 auth panel).

export function createNetContext({ token, api = null }) {
  const claims = token ? decodeJwtPayload(token) : null;
  const scope = claims && typeof claims.game_scope === 'string'
    ? claims.game_scope
    : GAME.defaultSlug; // local-dev fallback only; production always has the claim
  const userId = claims && typeof claims.sub === 'string' ? claims.sub : null;
  const client = api || new ApiClient(() => net.tokenManager.token);
  const net = {
    client,
    scope,
    userId,
    tokenManager: null,
  };
  net.tokenManager = new TokenManager({ token, scope, api: client });
  return net;
}
