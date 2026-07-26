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
import { TableScreen } from './table.js';
import { LeaderboardScreen } from './leaderboard.js';
import { ReplayListScreen, ReplayScreen } from './replays.js';
import { sharedProfiles } from './profiles.js';

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

function makeScreenCtx(net, gameInfo) {
  return {
    root: screenRoot(),
    net,
    gameInfo,
    onEnterLobby: (room) => switchScreen(new LobbyScreen(makeScreenCtx(net, gameInfo), room)),
    onEnterTable: (room) => switchScreen(new TableScreen(makeScreenCtx(net, gameInfo), room)),
    onExitToMenu: () => switchScreen(new MenuScreen(makeScreenCtx(net, gameInfo))),
    onShowLeaderboard: () => switchScreen(new LeaderboardScreen({
      ...makeScreenCtx(net, gameInfo),
      onBack: () => switchScreen(new MenuScreen(makeScreenCtx(net, gameInfo))),
    })),
    onShowReplays: () => switchScreen(new ReplayListScreen({
      ...makeScreenCtx(net, gameInfo),
      onBack: () => switchScreen(new MenuScreen(makeScreenCtx(net, gameInfo))),
      onOpenReplay: (sessionId) => switchScreen(new ReplayScreen({
        ...makeScreenCtx(net, gameInfo),
        sessionId,
        onBack: () => switchScreen(new ReplayListScreen({
          ...makeScreenCtx(net, gameInfo),
          onBack: () => switchScreen(new MenuScreen(makeScreenCtx(net, gameInfo))),
          onOpenReplay: (id) => switchScreen(new ReplayScreen({
            ...makeScreenCtx(net, gameInfo),
            sessionId: id,
            onBack: () => switchScreen(new MenuScreen(makeScreenCtx(net, gameInfo))),
          })),
        })),
      })),
    })),
  };
}

async function enterApp(net, gameInfo, { production, deepLinkSessionId }) {
  leaveBootScreen();
  const ctx = makeScreenCtx(net, gameInfo);

  // Reconnect path: a non-Closed room restores the lobby or table.
  try {
    const room = await new RoomController(net).myRoom();
    if (room && room.status !== 'Closed') {
      if (room.status === 'Playing') switchScreen(new TableScreen(ctx, room));
      else switchScreen(new LobbyScreen(ctx, room));
      return;
    }
  } catch { /* reconnect probe failed — fall through to the menu */ }

  // Invite deep-link (#session_id=): join the session's table directly when it
  // is still active (its room, if any, was already handled above).
  //
  // A dashboard-accepted *room* invite never lands here — accepting one seats
  // the player, so the reconnect probe above finds the room. This path is for a
  // games-API invite, whose accept mints a standalone session; honour it as
  // sent rather than second-guessing it against any pending room invite.
  if (deepLinkSessionId) {
    try {
      const session = await net.client.get(
        `/api/v1/games/${net.scope}/sessions/${deepLinkSessionId}`);
      if (session && session.status === 'active') {
        switchScreen(new TableScreen(ctx, {
          id: null, status: 'Playing', gameSessionId: session.sessionId,
          participants: [],
        }));
        return;
      }
    } catch { /* not our session anymore — fall through */ }
  }

  switchScreen(new MenuScreen(ctx));
}

async function bootWithToken(token, apiBase, { production, deepLinkSessionId }) {
  const net = createNetContext({ token, apiBase });
  net.profiles = sharedProfiles(net.client, { getToken: () => net.tokenManager.token });
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
