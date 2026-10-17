// Replay screens: recent-match list and the replay viewer.
// Data: GET /api/v1/games/{slug}/replays/mine?limit= and
//       GET /api/v1/games/{slug}/replays/{sessionId} (participants only).
// pokerRules is loaded globally from server.js (see index.html) and injected
// into the shared ReplayEngine.

import { ReplayEngine, REPLAY_SPEEDS } from './replay-engine.js';
import { el, t, num } from './i18n.js';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];
const RED = new Set([1, 2]);
function cardEl(card) {
  const suit = (card / 13) | 0;
  return el('span', {
    class: `pcard${RED.has(suit) ? ' red' : ''}`,
    text: `${RANKS[card % 13]}${SUIT_GLYPHS[suit]}`,
  });
}

export class ReplayListScreen {
  // ctx: { root, net, onBack(), onOpenReplay(sessionId) }
  constructor(ctx) {
    this.ctx = ctx;
  }

  async show() {
    const { root, net } = this.ctx;
    root.textContent = '';
    this.status = el('p', { class: 'muted', i18n: 'Loading…' });
    this.list = el('div', { class: 'replay-list' });
    root.append(el('div', { class: 'screen' },
      el('h1', { i18n: 'Replays' }), this.status, this.list,
      el('button', { type: 'button', i18n: 'Back', onclick: () => this.ctx.onBack() })));
    try {
      this.items = await net.client.get(
        `/api/v1/games/${net.scope}/replays/mine?limit=20`) || [];
      this.renderList();
    } catch (e) {
      this.status.removeAttribute('data-i18n');
      this.status.textContent = t('Could not load replays: {error}', { error: e.message || e });
    }
  }

  renderList() {
    const { net } = this.ctx;
    const items = this.items || [];
    this.status.removeAttribute('data-i18n');
    this.status.textContent = items.length ? '' : t('No finished matches yet.');
    this.list.textContent = '';
    for (const r of items) {
      const names = (r.players || []).map((p) => {
        net.profiles.profile(p.userId);
        return net.profiles.displayName(p.userId, p.username);
      }).join(t(' vs '));
      const result = r.result
        ? t('{name} won · {n} hands', { name: r.result.winnerName || t('Winner'), n: r.result.hands ?? '?' })
        : t('finished');
      this.list.append(el('button', {
        type: 'button', class: 'replay-row',
        onclick: () => this.ctx.onOpenReplay(r.sessionId),
      },
        el('span', { text: names }),
        el('span', { class: 'muted small', text: `${result} · ${String(r.finishedAt || '').slice(0, 10)}` }),
      ));
    }
  }

  relocalize() { if (this.items) this.renderList(); }

  destroy() {}
}

export class ReplayScreen {
  // ctx: { root, net, sessionId, onBack() }
  constructor(ctx) {
    this.ctx = ctx;
    this.handIdx = 0;
    this.stepIdx = 0;
    this.playing = false;
    this.speed = 1;
    this.timer = null;
  }

  async show() {
    const { root, net, sessionId } = this.ctx;
    root.textContent = '';
    this.status = el('p', { class: 'muted', i18n: 'Loading replay…' });
    this.stage = el('div', { class: 'replay-stage' });
    root.append(el('div', { class: 'screen' }, el('h1', { i18n: 'Replay' }), this.status, this.stage));
    try {
      const data = await net.client.get(
        `/api/v1/games/${net.scope}/replays/${sessionId}`);
      const rules = globalThis.pokerRules;
      if (!data || !data.state || !rules) throw new Error(t('Replay unavailable'));
      this.engine = new ReplayEngine(data.state, rules);
      this.result = data.result || (data.state && data.state.matchResult);
      this.buildViewer();
    } catch (e) {
      this.status.removeAttribute('data-i18n');
      this.status.textContent = t('Could not load the replay: {error}', { error: e.message || e });
    }
  }

  relocalize() {
    if (!this.engine) return;
    this.renderStatus();
    this.handLabel.textContent = t('Hand {n}/{total}', { n: this.handIdx + 1, total: this.engine.handCount() });
    this.playBtn.textContent = this.playing ? t('⏸ Pause') : t('▶ Play');
    this.renderStep();
  }

  renderStatus() {
    this.status.removeAttribute('data-i18n');
    this.status.textContent = this.result
      ? t('{name} won · {n} hands', { name: this.result.winnerName || t('Winner'), n: this.engine.handCount() }) : '';
  }

  buildViewer() {
    this.renderStatus();
    this.boardEl = el('div', { class: 'replay-board' });
    this.potEl = el('div', { class: 'pot-display' });
    this.seatsEl = el('div', { class: 'replay-seats' });
    this.stepLabel = el('div', { class: 'replay-step muted' });
    this.handLabel = el('span', { class: 'muted' });

    const nav = el('div', { class: 'replay-nav' },
      el('button', { type: 'button', i18n: '⏮ First', onclick: () => this.goHand(0) }),
      el('button', { type: 'button', i18n: '‹ Hand', onclick: () => this.goHand(this.handIdx - 1) }),
      this.handLabel,
      el('button', { type: 'button', i18n: 'Hand ›', onclick: () => this.goHand(this.handIdx + 1) }),
      el('button', { type: 'button', i18n: 'Last ⏭', onclick: () => this.goHand(this.engine.handCount() - 1) }),
    );
    const steps = el('div', { class: 'replay-nav' },
      el('button', { type: 'button', text: '‹', i18nAria: 'Previous step', onclick: () => this.goStep(this.stepIdx - 1) }),
      this.playBtn = el('button', { type: 'button', text: t('▶ Play'), onclick: () => this.togglePlay() }),
      el('button', { type: 'button', text: '›', i18nAria: 'Next step', onclick: () => this.goStep(this.stepIdx + 1) }),
      this.speedSelect = el('select', { i18nAria: 'Replay speed' },
        ...REPLAY_SPEEDS.map((s) => el('option', { value: String(s), text: `${s}×` }))),
    );
    this.speedSelect.value = '1';
    this.speedSelect.addEventListener('change', () => {
      this.speed = Number(this.speedSelect.value);
      if (this.playing) this.startTimer();
    });

    this.stage.append(
      this.potEl, this.boardEl, this.seatsEl, this.stepLabel, nav, steps,
      el('button', { type: 'button', i18n: 'Back', onclick: () => this.ctx.onBack() }));
    this.goHand(0);
  }

  goHand(idx) {
    this.handIdx = Math.max(0, Math.min(idx, this.engine.handCount() - 1));
    this.steps = this.engine.stepsForHand(this.handIdx);
    this.stepIdx = 0;
    this.handLabel.textContent = t('Hand {n}/{total}', { n: this.handIdx + 1, total: this.engine.handCount() });
    this.renderStep();
  }

  goStep(idx) {
    this.stepIdx = Math.max(0, Math.min(idx, this.steps.length - 1));
    this.renderStep();
    if (this.playing && this.stepIdx >= this.steps.length - 1) {
      if (this.handIdx < this.engine.handCount() - 1) {
        this.goHand(this.handIdx + 1);
      } else {
        this.togglePlay();
      }
    }
  }

  togglePlay() {
    this.playing = !this.playing;
    this.playBtn.textContent = this.playing ? t('⏸ Pause') : t('▶ Play');
    this.startTimer();
  }

  startTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.playing) {
      this.timer = setInterval(() => this.goStep(this.stepIdx + 1), 900 / this.speed);
    }
  }

  renderStep() {
    const step = this.steps[this.stepIdx];
    this.potEl.textContent = t('Pot {n}', { n: num(step.pot) });
    this.stepLabel.textContent = typeof step.label === 'function' ? step.label() : step.label;
    this.boardEl.textContent = '';
    for (const c of step.board) this.boardEl.append(cardEl(c));
    const equity = this.engine.equityForStep(this.handIdx, step);
    this.seatsEl.textContent = '';
    this.engine.seatMeta.forEach((meta, i) => {
      // Every dealt hand is visible in the replay (archived post-match);
      // old replays fall back to the recorded showdown reveal.
      const cards = step.holes ? step.holes[i] : (step.reveal && step.reveal[i]);
      const folded = step.folded && step.folded[i];
      const pct = equity && equity[i] != null ? Math.round(equity[i] * 100) : null;
      this.seatsEl.append(el('div', {
        class: 'replay-seat' + (i === step.activeSeat ? ' acting' : ''),
      },
        el('span', { class: 'seat-title', text: meta.name }),
        el('span', { class: 'seat-stack', text: num(step.stacks[i]) }),
        step.commits[i] > 0 ? el('span', { class: 'seat-bet', text: t('in for {n}', { n: num(step.commits[i]) }) }) : '',
        cards ? el('span', { class: `replay-cards${folded ? ' dim' : ''}` }, ...cards.map(cardEl)) : '',
        pct !== null ? el('span', { class: 'seat-equity', text: t('{pct}% to win', { pct }) }) : '',
      ));
    });
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
