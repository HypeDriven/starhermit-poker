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

import { ReconnectingSocket, wsUrl } from './net.js';

export class GameSocket {
  // net: shared net context. sessionId: the room-bound game session.
  // Handlers:
  //   onState(msg)      — { stateVersion, you, publicState }
  //   onEvent(msg)      — action / hand-started / hand-complete / match-complete
  //   onError(message)  — platform or script error frames
  //   onPresence(p)     — { userId, online }
  //   onDown()          — socket lost (reconnect follows automatically)
  constructor(net, sessionId, handlers = {}) {
    this.net = net;
    this.sessionId = sessionId;
    this.handlers = handlers;
    this.stateVersion = -1;
    this.destroyed = false;

    this.socket = new ReconnectingSocket({
      urlFactory: () => wsUrl('/ws/v1/games', {
        sessionId: this.sessionId,
        access_token: this.net.tokenManager.token,
      }),
      onOpen: () => this.sendCommand({ type: 'sync' }, { versioned: false }),
      onMessage: (data, isBinary) => this._onFrame(data, isBinary),
      onDown: () => this.handlers.onDown && this.handlers.onDown(),
    });
  }

  connect() {
    this.socket.connect();
  }

  // Send a game command. By default the current stateVersion rides along so
  // the script can reject actions based on stale views.
  sendCommand(cmd, { versioned = true } = {}) {
    const data = versioned && this.stateVersion >= 0
      ? { ...cmd, stateVersion: this.stateVersion }
      : cmd;
    return this.socket.sendJson({ type: 'cmd', data });
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
    this.socket.destroy();
  }
}
