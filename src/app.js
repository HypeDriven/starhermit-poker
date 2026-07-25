// StarHermit Poker — application entry point and boot flow.
//
// Boot order:
//   1. Production launch: #game_token=<jwt> in the URL hash (captured and
//      stripped exactly once by net.js). No auth UI is ever shown.
//   2. Local development: reuse the launch token cached in sessionStorage by
//      the auth panel, or show the panel to mint one.
//   3. Probe GET /api/v1/games/{scope} — validates the token and loads game
//      info (leaderboard id, my stats) used by the menu screens.
//   4. Reconnect: GET /api/v1/realtime/rooms/mine — a non-Closed room drops
//      the player straight back into its lobby (or the table when Playing).
//
// Screens are mounted into #screen-root; every screen owns its timers and
// sockets and must release them in destroy().

import { GAME } from './config.js';
import { captureLaunchCredentials, createNetContext } from './net.js';
import { showAuthPanel, clearDevToken } from './auth-panel.js';
import { RoomController } from './realtime-room.js';
import { MenuScreen, LobbyScreen } from './lobby.js';

const bootScreen = () => document.getElementById('screen-boot');
const screenRoot = () => document.getElementById('screen-root');

function setBootStatus(text) {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = text;
}

function leaveBootScreen() {
  const el = bootScreen();
  if (el) el.hidden = true;
}

function showFatal(message) {
  leaveBootScreen();
  const root = screenRoot();
  root.textContent = '';
  const box = document.createElement('div');
  box.className = 'auth-panel';
  const h = document.createElement('h2');
  h.textContent = 'Cannot start';
  const p = document.createElement('p');
  p.textContent = message;
  box.append(h, p);
  root.append(box);
}

// ---------------------------------------------------------------------------
// Screen management: exactly one active screen at a time.

let currentScreen = null;

function switchScreen(screen) {
  if (currentScreen && currentScreen.destroy) currentScreen.destroy();
  currentScreen = screen;
  if (screen && screen.show) screen.show();
}

// Placeholder table screen until the gameplay socket (checkpoint 7) and the
// full table UI (checkpoint 13) land. Keeps the realtime socket alive for
// roster/presence — a Playing room is closed by the platform if the host has
// no active socket for 60 s.
class TablePlaceholderScreen {
  constructor(ctx, room) {
    this.ctx = ctx;
    this.room = room;
    this.controller = new RoomController(ctx.net, {
      onRoster: (r) => {
        this.room = r;
        this.render();
      },
    });
  }

  show() {
    const { root } = this.ctx;
    root.textContent = '';
    this.info = document.createElement('p');
    const screen = document.createElement('div');
    screen.className = 'screen';
    const h = document.createElement('h1');
    h.textContent = 'Table started';
    this.info.className = 'muted';
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.textContent = 'Leave table';
    leave.addEventListener('click', async () => {
      try { await this.controller.leaveRoom(this.room.id); } catch { /* already gone */ }
      switchScreen(new MenuScreen(this.ctx));
    });
    screen.append(h, this.info, leave);
    root.append(screen);
    this.render();
    this.controller.connect(this.room.id);
  }

  render() {
    if (this.info) {
      this.info.textContent =
        `Room ${this.room.status} · gameSessionId ${this.room.gameSessionId || 'pending'} · ` +
        'gameplay arrives in checkpoint 7.';
    }
  }

  destroy() {
    this.controller.destroy();
  }
}

function makeScreenCtx(net, gameInfo) {
  return {
    root: screenRoot(),
    net,
    gameInfo,
    onEnterLobby: (room) => switchScreen(new LobbyScreen(makeScreenCtx(net, gameInfo), room)),
    onEnterTable: (room) => switchScreen(new TablePlaceholderScreen(makeScreenCtx(net, gameInfo), room)),
    onExitToMenu: () => switchScreen(new MenuScreen(makeScreenCtx(net, gameInfo))),
  };
}

async function enterApp(net, gameInfo, { production, deepLinkSessionId }) {
  leaveBootScreen();
  const ctx = makeScreenCtx(net, gameInfo);

  // Reconnect path: a non-Closed room restores the lobby or table. The
  // deep-link session id is honored once gameplay exists (checkpoint 7).
  try {
    const room = await new RoomController(net).myRoom();
    if (room && room.status !== 'Closed') {
      if (room.status === 'Playing') switchScreen(new TablePlaceholderScreen(ctx, room));
      else switchScreen(new LobbyScreen(ctx, room));
      return;
    }
  } catch { /* reconnect probe failed — fall through to the menu */ }

  switchScreen(new MenuScreen(ctx));
}

async function bootWithToken(token, apiBase, { production, deepLinkSessionId }) {
  const net = createNetContext({ token, apiBase });
  window.addEventListener('pagehide', () => {
    if (currentScreen && currentScreen.destroy) currentScreen.destroy();
    net.tokenManager.destroy();
  });

  setBootStatus('Checking session…');
  try {
    const gameInfo = await net.client.get(`/api/v1/games/${net.scope}`);
    await enterApp(net, gameInfo, { production, deepLinkSessionId });
  } catch (e) {
    net.tokenManager.destroy();
    if (production) {
      showFatal(
        'The platform rejected the launch token. Relaunch the game from StarHermit ' +
        `to get a fresh one. (${e.message || e})`
      );
    } else {
      // Dev token expired or rejected: drop it and show the panel again.
      clearDevToken();
      showAuthPanel(screenRoot(), {
        error: `Cached dev session was rejected (${e.message || e}). Mint a new token.`,
        onReady: ({ token: t, apiBase: base }) =>
          bootWithToken(t, base, { production: false, deepLinkSessionId: null }),
      });
      leaveBootScreen();
    }
  }
}

function boot() {
  const { token, sessionId } = captureLaunchCredentials();

  if (token) {
    bootWithToken(token, '', { production: true, deepLinkSessionId: sessionId });
    return;
  }

  // Local development: try the cached dev launch token first.
  const devToken = sessionStorage.getItem(GAME.dev.gameTokenKey);
  const apiBase = localStorage.getItem(GAME.dev.apiBaseKey) || GAME.dev.defaultApiBase;
  if (devToken) {
    bootWithToken(devToken, apiBase, { production: false, deepLinkSessionId: null });
    return;
  }

  leaveBootScreen();
  showAuthPanel(screenRoot(), {
    onReady: ({ token: t, apiBase: base }) =>
      bootWithToken(t, base, { production: false, deepLinkSessionId: null }),
  });
}

boot();
