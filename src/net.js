// StarHermit Poker — networking layer.
// Contract source: https://wiki.starhermit.com/docs/api/auth.html,
// https://wiki.starhermit.com/docs/api/games.html,
// https://wiki.starhermit.com/docs/api/realtime.html
//
// Rules enforced here:
// - The launch token, its renewal, sign-in and claim decoding belong to the
//   shared StarHermit SDK (starhermit-sdk.js, window.StarHermit), which reads
//   `#game_token=` / `#access_token=` once and strips it. Decoded claims are
//   UI values only — the platform validates the token on every call.
// - All REST paths are same-origin relative; the game slug always comes from
//   the `game_scope` claim, never from a hard-coded constant.
// - WebSocket scheme follows the page protocol (ws: for http:, wss: for https:).
// - Reconnects use exponential backoff from 1 s to a 30 s ceiling, and every
//   reconnect renews the launch token first (StarHermit.renewForReconnect).
// - Every timer and socket is cancellable via destroy().

import { GAME } from './config.js';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in Node)

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
// Launch credentials (the SDK read and stripped the fragment at page load)

/** The StarHermit SDK instance (window.StarHermit; tests inject their own). */
export function starhermit() {
  return (typeof globalThis !== 'undefined' && globalThis.StarHermit) || null;
}

// Returns { token, sessionId } from the SDK. Safe to call repeatedly.
export function captureLaunchCredentials() {
  const sh = starhermit();
  if (!sh) return { token: null, sessionId: null };
  if (!sh.signedIn) sh.init();
  return { token: sh.token || null, sessionId: sh.launchSessionId || null };
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
  // baseUrl: '' for same-origin production; an explicit origin like
  // 'http://localhost:5000' for local development. fetchImpl is injectable
  // for tests.
  constructor({ getToken, baseUrl = '', fetchImpl = null }) {
    this.getToken = getToken;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl || ((...args) => fetch(...args));
  }

  async request(method, path, body) {
    if (!path.startsWith('/')) throw new Error('ApiClient: paths must be absolute-from-root');
    const headers = {};
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    const res = await this.fetch(this.baseUrl + path, {
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
  // onDown (socket lost, will retry), onAuthLost (renewal refused; stopped for good).
  // renew: () => Promise<'renewed'|'retry'|'relaunch'> runs before every
  // REconnect (never the first connect): a dropped socket may be an expired
  // launch token — refused before the upgrade, seen only as 1006 — and the
  // same URL can never recover. 'renewed' reopens with a fresh urlFactory()
  // URL, 'retry' backs off without reopening, 'relaunch' stops.
  constructor({ urlFactory, onOpen, onMessage, onDown, onAuthLost, renew = null, backoff = backoffDelay, wsImpl = null }) {
    this.urlFactory = urlFactory;
    this.onOpen = onOpen || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onDown = onDown || (() => {});
    this.onAuthLost = onAuthLost || (() => {});
    this.renew = renew;
    this._gen = 0; // bumps on connect()/destroy(): a pending renewal for an older attempt is dropped
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
    this._gen++;
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
    this._timer = setTimeout(() => this._reconnect(), delay);
  }

  // Renew the launch token first, then open a URL built from the current one.
  async _reconnect() {
    this._timer = null;
    if (this._destroyed) return;
    if (!this.renew) { this.connect(); return; }
    const gen = this._gen;
    let r;
    try { r = await this.renew(); } catch { r = 'retry'; }
    if (this._destroyed || gen !== this._gen) return; // destroyed or superseded meanwhile
    if (r === 'renewed') this.connect();
    else if (r === 'retry') this._scheduleReconnect(); // keep backing off; never reopen the old URL
    else {
      this._destroyed = true; // token dead: only a fresh launch can mint a new one
      this.onAuthLost();
    }
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
    this._gen++;
    this._cancelTimer();
    this._closeSocket();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap helper: build the shared net context on the SDK's token (a launch
// token, or a locally minted dev token handed over by the auth panel).
// `tokenManager.token` always reads the SDK's current (renewed) token.

export function createNetContext({ token, apiBase = '', api = null, sdk = starhermit() }) {
  if (apiBase) sdk.base = String(apiBase).replace(/\/+$/, '');
  if (token && sdk.token !== token) sdk.setToken(token);
  const scope = (sdk.claims && sdk.slug) || ''; // the game_scope claim; never guessed
  const userId = sdk.userId ? String(sdk.userId) : null;
  const client = api || new ApiClient({ getToken: () => sdk.token, baseUrl: apiBase });
  return {
    client,
    scope,
    userId,
    sdk,
    tokenManager: {
      get token() { return sdk.token; },
      // Before every socket REconnect: 'renewed' | 'retry' | 'relaunch' (the
      // SDK then signed out and emitted auth {signedIn:false, reason:'expired'}).
      renewForReconnect() {
        return typeof sdk.renewForReconnect === 'function' ? sdk.renewForReconnect() : Promise.resolve('relaunch');
      },
      destroy() { /* renewal lives in the SDK for the whole page */ },
    },
  };
}
