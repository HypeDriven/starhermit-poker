// StarHermit Poker — application entry point.
// Checkpoint 2 scope: capture launch credentials, build the net context,
// report boot status. Screens (lobby/table/…) mount in later checkpoints.

import { captureLaunchCredentials, createNetContext } from './net.js';

function setBootStatus(text) {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = text;
}

function boot() {
  const { token, sessionId } = captureLaunchCredentials();

  if (!token) {
    // Local-development fallback (checkpoint 3 adds the auth panel that mints
    // a launch token from a user JWT). Production launches always carry the
    // #game_token fragment.
    setBootStatus('No launch token. Local development auth panel arrives in the next checkpoint.');
    return;
  }

  const net = createNetContext({ token });
  window.addEventListener('pagehide', () => net.tokenManager.destroy());

  setBootStatus(
    `Signed in as ${net.userId ? net.userId.slice(0, 8) : 'unknown'} · game "${net.scope}"` +
    (sessionId ? ` · deep-linked session ${sessionId.slice(0, 8)}` : '')
  );
}

boot();
