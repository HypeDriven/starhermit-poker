// Local-development auth panel.
// Documented pattern (wiki: Authentication — local development): when the game
// is not launched by the platform (no #game_token fragment), the user pastes a
// full platform JWT and the game mints its own launch token via
// POST {apiBase}/api/v1/games/{slug}/launch-token. The launch token is cached
// in sessionStorage (per-tab) and the API base in localStorage, under
// slug-specific keys. Production launches never see this panel.

import { GAME } from './config.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

// onReady({ token, apiBase }) is called once a launch token has been minted
// and cached. onError(message) renders into the panel's error line.
export function showAuthPanel(root, { onReady, error = null }) {
  root.textContent = '';

  const apiBaseInput = el('input', {
    id: 'dev-api-base', type: 'text', spellcheck: 'false',
    value: localStorage.getItem(GAME.dev.apiBaseKey) || GAME.dev.defaultApiBase,
  });
  const slugInput = el('input', {
    id: 'dev-slug', type: 'text', spellcheck: 'false', value: GAME.defaultSlug,
  });
  const jwtInput = el('textarea', {
    id: 'dev-jwt', rows: '4', spellcheck: 'false',
    placeholder: 'Paste a full StarHermit platform JWT (local dev only)',
  });
  const errorLine = el('p', { class: 'error', id: 'dev-error', text: error || '' });
  if (!error) errorLine.hidden = true;
  const submit = el('button', { class: 'primary', type: 'button', text: 'Mint launch token' });

  const form = el('div', { class: 'auth-panel' },
    el('h2', { text: 'Local development sign-in' }),
    el('p', {
      class: 'muted',
      text: 'No #game_token launch detected. In production the platform launcher ' +
        'hands the game a launch token; for local development, mint one yourself.',
    }),
    el('label', { for: 'dev-api-base', text: 'API base' }), apiBaseInput,
    el('label', { for: 'dev-slug', text: 'Game slug' }), slugInput,
    el('label', { for: 'dev-jwt', text: 'Platform JWT' }), jwtInput,
    submit, errorLine,
  );
  root.append(form);

  submit.addEventListener('click', async () => {
    const apiBase = apiBaseInput.value.trim().replace(/\/+$/, '');
    const slug = slugInput.value.trim();
    const userJwt = jwtInput.value.trim();
    errorLine.hidden = true;
    if (!apiBase || !slug || !userJwt) {
      errorLine.textContent = 'All three fields are required.';
      errorLine.hidden = false;
      return;
    }
    submit.disabled = true;
    try {
      const res = await fetch(`${apiBase}/api/v1/games/${encodeURIComponent(slug)}/launch-token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userJwt}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.token !== 'string') {
        throw new Error((data && data.error) || `HTTP ${res.status}`);
      }
      // Cache per the documented dev pattern; the token never hits logs.
      localStorage.setItem(GAME.dev.apiBaseKey, apiBase);
      sessionStorage.setItem(GAME.dev.gameTokenKey, data.token);
      onReady({ token: data.token, apiBase });
    } catch (e) {
      errorLine.textContent = `Could not mint a launch token: ${e.message || e}`;
      errorLine.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

// Drop the cached dev token (e.g. after it expired); the panel is shown next.
export function clearDevToken() {
  sessionStorage.removeItem(GAME.dev.gameTokenKey);
}
