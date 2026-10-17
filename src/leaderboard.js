// Leaderboard screen: global + friends views of the game's script-owned elo
// board. Contract: https://wiki.starhermit.com/docs/api/leaderboards.html
// Reads only — scores are written exclusively by the script's eloUpdates.

import { GAME } from './config.js';
import { el, t } from './i18n.js';

export class LeaderboardScreen {
  // ctx: { root, net, gameInfo, onBack() }
  constructor(ctx) {
    this.ctx = ctx;
    this.friendsOnly = false;
    this.page = 1;
    this.pageSize = 10;
    this._profileListener = () => this.renderRows();
  }

  leaderboardId() {
    return this.ctx.gameInfo && this.ctx.gameInfo.leaderboardId;
  }

  show() {
    const { root, net, gameInfo } = this.ctx;
    net.profiles.addListener(this._profileListener);
    root.textContent = '';
    const me = (gameInfo && gameInfo.me) || {};

    this.toggleBtn = el('button', {
      type: 'button', i18n: 'Friends: off',
      onclick: () => {
        this.friendsOnly = !this.friendsOnly;
        this.toggleBtn.dataset.i18n = this.friendsOnly ? 'Friends: on' : 'Friends: off';
        this.toggleBtn.textContent = t(this.toggleBtn.dataset.i18n);
        this.page = 1;
        this.load();
      },
    });
    this.rows = el('div', { class: 'lb-rows' });
    this.status = el('p', { class: 'muted' });
    this.prevBtn = el('button', { type: 'button', i18n: '‹ Prev', onclick: () => this.turn(-1) });
    this.nextBtn = el('button', { type: 'button', i18n: 'Next ›', onclick: () => this.turn(1) });

    root.append(el('div', { class: 'screen leaderboard' },
      el('h1', { i18n: 'Leaderboard' }),
      el('p', {
        class: 'muted',
        ...(me.userId ? { i18n: ['You: elo {elo} · {w}W / {l}L / {d}D · {n} active',
          { elo: me.elo, w: me.wins, l: me.losses, d: me.draws, n: me.activeSessionCount }] } : {}),
      }),
      el('div', { class: 'lb-controls' }, this.toggleBtn),
      this.status, this.rows,
      el('div', { class: 'lb-controls' }, this.prevBtn, this.nextBtn),
      el('button', { type: 'button', i18n: 'Back', onclick: () => this.ctx.onBack() }),
    ));

    if (!this.leaderboardId()) {
      this.setStatus(() => t('No leaderboard is provisioned for this game yet.'));
      return;
    }
    this.load();
  }

  turn(delta) {
    this.page = Math.max(1, this.page + delta);
    this.load();
  }

  async load() {
    this.setStatus(() => t('Loading…'));
    this.prevBtn.disabled = this.page <= 1;
    try {
      const data = await this.ctx.net.client.get(
        `/api/v1/leaderboards/${this.leaderboardId()}/entries` +
        `?page=${this.page}&pageSize=${this.pageSize}` +
        (this.friendsOnly ? '&friendsOnly=true' : ''));
      this.entries = (data && data.items) || [];
      this.total = (data && data.total) || 0;
      this.nextBtn.disabled = this.page * this.pageSize >= this.total;
      const total = this.total;
      this.setStatus(this.entries.length
        ? () => t('{n} players', { n: total })
        : () => t('No entries yet — play a match.'));
      for (const e of this.entries) this.ctx.net.profiles.profile(e.userId);
      this.renderRows();
    } catch (e) {
      const error = e.message || e;
      this.setStatus(() => t('Could not load the leaderboard: {error}', { error }));
    }
  }

  // fn: returns the status line in the current language (re-run on a change).
  setStatus(fn) {
    this._status = fn;
    this.status.textContent = fn();
  }

  relocalize() {
    if (this._status && this.status) this.status.textContent = this._status();
  }

  renderRows() {
    if (!this.rows || !this.entries) return;
    this.rows.textContent = '';
    for (const e of this.entries) {
      const name = this.ctx.net.profiles.displayName(e.userId, e.username);
      this.rows.append(el('div', {
        class: 'lb-row' + (e.userId === this.ctx.net.userId ? ' self' : ''),
      },
        el('span', { class: 'lb-rank', text: `#${e.rank}` }),
        el('span', { class: 'lb-name', text: name }),
        el('span', { class: 'lb-score', text: String(e.score) }),
      ));
    }
  }

  destroy() {
    this.ctx.net.profiles.removeListener(this._profileListener);
  }
}
