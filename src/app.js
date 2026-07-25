// StarHermit Poker — application entry point and boot flow.
//
// Boot order:
//   1. Production launch: #game_token=<jwt> in the URL hash (captured and
//      stripped exactly once by net.js). No auth UI is ever shown.
//   2. Local development: reuse the launch token cached in sessionStorage by
//      the auth panel, or show the panel to mint one.
//   3. Probe GET /api/v1/games/{scope} — validates the token and loads game
//      info (leaderboard id, my stats) used by the menu screens.
//
// Screens are mounted into #screen-root; every screen owns its timers and
// sockets and must release them on teardown (see the lobby/table controllers
// in later checkpoints).

import { GAME } from './config.js';
import { captureLaunchCredentials, createNetContext } from './net.js';
import { showAuthPanel, clearDevToken } from './auth-panel.js';

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

// Placeholder main screen until checkpoint 4 lands the lobby. Shows that auth,
// token refresh, and the game-info probe all work end to end.
function enterMain(net, gameInfo, { production, deepLinkSessionId }) {
  leaveBootScreen();
  const root = screenRoot();
  root.textContent = '';

  const me = (gameInfo && gameInfo.me) || {};
  const screen = document.createElement('div');
  screen.className = 'screen main-menu';

  const h = document.createElement('h1');
  h.textContent = gameInfo && gameInfo.name ? gameInfo.name : GAME.name;

  const idLine = document.createElement('p');
  idLine.className = 'muted';
  idLine.textContent =
    `Signed in as ${net.userId ? 'Player ' + net.userId.slice(0, 8) : 'unknown'} · ` +
    `game "${net.scope}" · ${production ? 'platform launch' : 'local dev'}`;

  const stats = document.createElement('p');
  stats.textContent = me.userId
    ? `Elo ${me.elo} · ${me.wins}W / ${me.losses}L / ${me.draws}D · active sessions ${me.activeSessionCount}`
    : 'No stats yet.';

  screen.append(h, idLine, stats);

  if (deepLinkSessionId) {
    const link = document.createElement('p');
    link.textContent = `Deep-linked session: ${deepLinkSessionId}`;
    screen.append(link);
  }

  if (!production) {
    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = 'Sign out (dev)';
    out.addEventListener('click', () => {
      clearDevToken();
      net.tokenManager.destroy();
      location.reload();
    });
    screen.append(out);
  }

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Lobby arrives in checkpoint 4.';
  screen.append(note);

  root.append(screen);
}

async function bootWithToken(token, apiBase, { production, deepLinkSessionId }) {
  const net = createNetContext({ token, apiBase });
  window.addEventListener('pagehide', () => net.tokenManager.destroy());

  setBootStatus('Checking session…');
  try {
    const gameInfo = await net.client.get(`/api/v1/games/${net.scope}`);
    enterMain(net, gameInfo, { production, deepLinkSessionId });
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
