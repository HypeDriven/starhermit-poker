// Replay screens: recent-match list and the replay viewer.
// Data: GET /api/v1/games/{slug}/replays/mine?limit= and
//       GET /api/v1/games/{slug}/replays/{sessionId} (participants only).
// pokerRules is loaded globally from server.js (see index.html) and injected
// into the shared ReplayEngine.

import { ReplayEngine, REPLAY_SPEEDS } from './replay-engine.js';

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

const RANKS = '23456789TJQKA';
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
    const status = el('p', { class: 'muted', text: 'Loading…' });
    const list = el('div', { class: 'replay-list' });
    root.append(el('div', { class: 'screen' },
      el('h1', { text: 'Replays' }), status, list,
      el('button', { type: 'button', text: 'Back', onclick: () => this.ctx.onBack() })));
    try {
      const items = await net.client.get(
        `/api/v1/games/${net.scope}/replays/mine?limit=20`) || [];
      status.textContent = items.length ? '' : 'No finished matches yet.';
      for (const r of items) {
        const names = (r.players || []).map((p) => {
          net.profiles.profile(p.userId);
          return net.profiles.displayName(p.userId, p.username);
        }).join(' vs ');
        const result = r.result
          ? `${r.result.winnerName || 'Winner'} won · ${r.result.hands ?? '?'} hands`
          : 'finished';
        list.append(el('button', {
          type: 'button', class: 'replay-row',
          onclick: () => this.ctx.onOpenReplay(r.sessionId),
        },
          el('span', { text: names }),
          el('span', { class: 'muted small', text: `${result} · ${String(r.finishedAt || '').slice(0, 10)}` }),
        ));
      }
    } catch (e) {
      status.textContent = `Could not load replays: ${e.message || e}`;
    }
  }

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
    this.status = el('p', { class: 'muted', text: 'Loading replay…' });
    this.stage = el('div', { class: 'replay-stage' });
    root.append(el('div', { class: 'screen' }, el('h1', { text: 'Replay' }), this.status, this.stage));
    try {
      const data = await net.client.get(
        `/api/v1/games/${net.scope}/replays/${sessionId}`);
      const rules = globalThis.pokerRules;
      if (!data || !data.state || !rules) throw new Error('Replay unavailable');
      this.engine = new ReplayEngine(data.state, rules);
      this.result = data.result || (data.state && data.state.matchResult);
      this.buildViewer();
    } catch (e) {
      this.status.textContent = `Could not load the replay: ${e.message || e}`;
    }
  }

  buildViewer() {
    this.status.textContent = this.result
      ? `${this.result.winnerName || 'Winner'} won · ${this.engine.handCount()} hands` : '';
    this.boardEl = el('div', { class: 'replay-board' });
    this.potEl = el('div', { class: 'pot-display' });
    this.seatsEl = el('div', { class: 'replay-seats' });
    this.stepLabel = el('div', { class: 'replay-step muted' });
    this.handLabel = el('span', { class: 'muted' });

    const nav = el('div', { class: 'replay-nav' },
      el('button', { type: 'button', text: '⏮ First', onclick: () => this.goHand(0) }),
      el('button', { type: 'button', text: '‹ Hand', onclick: () => this.goHand(this.handIdx - 1) }),
      this.handLabel,
      el('button', { type: 'button', text: 'Hand ›', onclick: () => this.goHand(this.handIdx + 1) }),
      el('button', { type: 'button', text: 'Last ⏭', onclick: () => this.goHand(this.engine.handCount() - 1) }),
    );
    const steps = el('div', { class: 'replay-nav' },
      el('button', { type: 'button', text: '‹', onclick: () => this.goStep(this.stepIdx - 1) }),
      this.playBtn = el('button', { type: 'button', text: '▶ Play', onclick: () => this.togglePlay() }),
      el('button', { type: 'button', text: '›', onclick: () => this.goStep(this.stepIdx + 1) }),
      this.speedSelect = el('select', {},
        ...REPLAY_SPEEDS.map((s) => el('option', { value: String(s), text: `${s}×` }))),
    );
    this.speedSelect.value = '1';
    this.speedSelect.addEventListener('change', () => {
      this.speed = Number(this.speedSelect.value);
      if (this.playing) this.startTimer();
    });

    this.stage.append(
      this.potEl, this.boardEl, this.seatsEl, this.stepLabel, nav, steps,
      el('button', { type: 'button', text: 'Back', onclick: () => this.ctx.onBack() }));
    this.goHand(0);
  }

  goHand(idx) {
    this.handIdx = Math.max(0, Math.min(idx, this.engine.handCount() - 1));
    this.steps = this.engine.stepsForHand(this.handIdx);
    this.stepIdx = 0;
    this.handLabel.textContent = `Hand ${this.handIdx + 1}/${this.engine.handCount()}`;
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
    this.playBtn.textContent = this.playing ? '⏸ Pause' : '▶ Play';
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
    this.potEl.textContent = `Pot ${step.pot.toLocaleString()}`;
    this.stepLabel.textContent = step.label;
    this.boardEl.textContent = '';
    for (const c of step.board) this.boardEl.append(cardEl(c));
    this.seatsEl.textContent = '';
    this.engine.seatMeta.forEach((meta, i) => {
      const cards = step.reveal && step.reveal[i];
      this.seatsEl.append(el('div', {
        class: 'replay-seat' + (i === step.activeSeat ? ' acting' : ''),
      },
        el('span', { class: 'seat-title', text: meta.name }),
        el('span', { class: 'seat-stack', text: step.stacks[i].toLocaleString() }),
        step.commits[i] > 0 ? el('span', { class: 'seat-bet', text: `in for ${step.commits[i]}` }) : '',
        cards ? el('span', { class: 'replay-cards' }, ...cards.map(cardEl)) : '',
      ));
    });
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
