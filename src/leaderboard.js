// Leaderboard screen: global + friends views of the game's script-owned elo
// board. Contract: https://wiki.starhermit.com/docs/api/leaderboards.html
// Reads only — scores are written exclusively by the script's eloUpdates.

import { GAME } from './config.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

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
      type: 'button', text: 'Friends: off',
      onclick: () => {
        this.friendsOnly = !this.friendsOnly;
        this.toggleBtn.textContent = `Friends: ${this.friendsOnly ? 'on' : 'off'}`;
        this.page = 1;
        this.load();
      },
    });
    this.rows = el('div', { class: 'lb-rows' });
    this.status = el('p', { class: 'muted' });
    this.prevBtn = el('button', { type: 'button', text: '‹ Prev', onclick: () => this.turn(-1) });
    this.nextBtn = el('button', { type: 'button', text: 'Next ›', onclick: () => this.turn(1) });

    root.append(el('div', { class: 'screen leaderboard' },
      el('h1', { text: 'Leaderboard' }),
      el('p', {
        class: 'muted',
        text: me.userId
          ? `You: elo ${me.elo} · ${me.wins}W / ${me.losses}L / ${me.draws}D · ${me.activeSessionCount} active`
          : '',
      }),
      el('div', { class: 'lb-controls' }, this.toggleBtn),
      this.status, this.rows,
      el('div', { class: 'lb-controls' }, this.prevBtn, this.nextBtn),
      el('button', { type: 'button', text: 'Back', onclick: () => this.ctx.onBack() }),
    ));

    if (!this.leaderboardId()) {
      this.status.textContent = 'No leaderboard is provisioned for this game yet.';
      return;
    }
    this.load();
  }

  turn(delta) {
    this.page = Math.max(1, this.page + delta);
    this.load();
  }

  async load() {
    this.status.textContent = 'Loading…';
    this.prevBtn.disabled = this.page <= 1;
    try {
      const data = await this.ctx.net.client.get(
        `/api/v1/leaderboards/${this.leaderboardId()}/entries` +
        `?page=${this.page}&pageSize=${this.pageSize}` +
        (this.friendsOnly ? '&friendsOnly=true' : ''));
      this.entries = (data && data.items) || [];
      this.total = (data && data.total) || 0;
      this.nextBtn.disabled = this.page * this.pageSize >= this.total;
      this.status.textContent = this.entries.length
        ? `${this.total} players`
        : 'No entries yet — play a match.';
      for (const e of this.entries) this.ctx.net.profiles.profile(e.userId);
      this.renderRows();
    } catch (e) {
      this.status.textContent = `Could not load the leaderboard: ${e.message || e}`;
    }
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
