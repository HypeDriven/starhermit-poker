// Gameplay WebSocket controller (ws/v1/games).
// Contract: https://wiki.starhermit.com/docs/api/games.html
//
// - Connects after the realtime room reports a gameSessionId; the realtime
//   socket stays open for roster/presence (owned by the lobby/table screen).
// - On EVERY open, immediately sends {"type":"cmd","data":{"type":"sync"}}.
// - Frames: {"type":"game","data":...}, {"type":"error","error":...},
//   {"type":"presence","userId","online"}.
// - Stale game states are dropped via monotonically increasing stateVersion.
// - Commands never carry a user id; the platform attaches the sender.
// - Commands are PACED: the platform disconnects a client that sends faster
//   than the session tick rate (PolicyViolation), so bursts queue and drain
//   one frame per GAME.cmdMinIntervalMs (the script ticks at 1 Hz).

import { GAME } from './config.js';
import { ReconnectingSocket, wsUrl } from './net.js';

export class GameSocket {
  // net: shared net context. sessionId: the room-bound game session.
  // Handlers:
  //   onState(msg)      — { stateVersion, you, publicState }
  //   onEvent(msg)      — action / hand-started / hand-complete / match-complete
  //   onError(message)  — platform or script error frames
  //   onPresence(p)     — { userId, online }
  //   onDown()          — socket lost (reconnect follows automatically)
  // opts.minIntervalMs: command pacing (tests override with a small value).
  constructor(net, sessionId, handlers = {}, { minIntervalMs = GAME.cmdMinIntervalMs } = {}) {
    this.net = net;
    this.sessionId = sessionId;
    this.handlers = handlers;
    this.stateVersion = -1;
    this.destroyed = false;
    this.minIntervalMs = minIntervalMs;
    this.sendQueue = [];
    this.sendTimer = null;
    this.lastSentAt = 0;

    this.socket = new ReconnectingSocket({
      urlFactory: () => wsUrl('/ws/v1/games', {
        sessionId: this.sessionId,
        access_token: this.net.tokenManager.token,
      }),
      onOpen: () => {
        // A fresh connection starts with a full rate budget.
        this.lastSentAt = 0;
        this.sendCommand({ type: 'sync' }, { versioned: false });
      },
      onMessage: (data, isBinary) => this._onFrame(data, isBinary),
      onDown: () => this.handlers.onDown && this.handlers.onDown(),
    });
  }

  connect() {
    this.socket.connect();
  }

  // Queue a game command. By default the current stateVersion rides along so
  // the script can reject actions based on stale views — stamped at SEND time,
  // so a queued command always carries the freshest view.
  sendCommand(cmd, { versioned = true } = {}) {
    if (this.destroyed) return false;
    this.sendQueue.push({ cmd, versioned });
    this._pump();
    return true;
  }

  _pump() {
    if (this.destroyed || this.sendTimer || !this.sendQueue.length) return;
    const wait = this.lastSentAt
      ? Math.max(0, this.minIntervalMs - (Date.now() - this.lastSentAt))
      : 0;
    if (wait > 0) {
      this.sendTimer = setTimeout(() => {
        this.sendTimer = null;
        this._pump();
      }, wait);
      return;
    }
    const { cmd, versioned } = this.sendQueue.shift();
    const data = versioned && this.stateVersion >= 0
      ? { ...cmd, stateVersion: this.stateVersion }
      : cmd;
    if (!this.socket.sendJson({ type: 'cmd', data })) {
      this.sendQueue.unshift({ cmd, versioned }); // socket down; drains after reconnect
      return;
    }
    this.lastSentAt = Date.now();
    if (this.sendQueue.length) this._pump(); // schedules the pacing timer
  }

  _onFrame(raw, isBinary) {
    if (isBinary || typeof raw !== 'string') return;
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    switch (frame.type) {
      case 'game':
        this._onGameData(frame.data);
        break;
      case 'error':
        this.handlers.onError &&
          this.handlers.onError(typeof frame.error === 'string' ? frame.error : 'Unknown error');
        break;
      case 'presence':
        this.handlers.onPresence &&
          this.handlers.onPresence({ userId: frame.userId, online: !!frame.online });
        break;
      default:
        break;
    }
  }

  _onGameData(data) {
    if (!data || typeof data !== 'object') return;
    // Stale-state rejection: any versioned message older than the newest seen
    // is dropped (reconnects and racing transitions can deliver out of order).
    if (typeof data.stateVersion === 'number') {
      if (data.stateVersion < this.stateVersion) return;
      this.stateVersion = data.stateVersion;
    }
    if (data.type === 'state') {
      this.handlers.onState && this.handlers.onState(data);
    } else {
      this.handlers.onEvent && this.handlers.onEvent(data);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.sendTimer = null;
    }
    this.sendQueue = [];
    this.socket.destroy();
  }
}
