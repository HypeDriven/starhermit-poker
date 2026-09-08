// Offline mode: when the game is opened without a platform launch token
// (a plain local load, e.g. `PORT=8803 node server.js`), the player can play
// a full match against AI seats entirely in the browser. The same
// server-authoritative script (server.js, `globalThis.game`) is driven by a
// local host adapter that supplies ctx.now / ctx.random / ctx.room and keeps
// the returned sessionState between invocations. No network, no sign-in.

import { GAME } from './config.js';
import { seatVisual, seatUnit, presetTotal, describeLogEntry } from './table-utils.js';
import { cardEl, describeHandComplete } from './table.js';

const USER_ID = 'local-player';
const AI_NAMES = ['Ada', 'Ben', 'Cleo', 'Dex', 'Eva'];
// How long showdown cards stay revealed on the seat overlays after a hand.
const REVEAL_WINDOW_MS = 8000;
// The feed shows only the latest few lines — no scrolling, fits the screen.
const FEED_CAP = 3;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

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

// ---------------------------------------------------------------------------
// Local menu: the cold-load landing when no platform launch happened.

export class LocalMenuScreen {
  // ctx: { root, onPlayOffline(), onShowSignIn() }
  constructor(ctx) {
    this.ctx = ctx;
  }

  show() {
    const { root } = this.ctx;
    root.textContent = '';
    root.append(el('div', { class: 'screen main-menu' },
      el('h1', { text: 'StarHermit Poker' }),
      el('p', {
        class: 'muted',
        text: 'No-limit Texas Hold\'em. Play an offline table against five AI ' +
          'opponents — no sign-in needed.',
      }),
      el('div', { class: 'menu-actions' },
        el('button', {
          class: 'primary big', type: 'button', text: 'Play',
          onclick: () => this.ctx.onPlayOffline(),
        }),
        el('button', {
          type: 'button', text: 'Multiplayer sign-in',
          onclick: () => this.ctx.onShowSignIn(),
        }),
      ),
      el('p', {
        class: 'muted small',
        text: 'Multiplayer is available when the game is launched from the ' +
          'StarHermit platform, or via a development launch token.',
      }),
    ));
  }

  destroy() { /* no timers or sockets */ }
}

// ---------------------------------------------------------------------------
// Offline table: drives globalThis.game (server.js) with a local host adapter.

export class LocalTableScreen {
  // ctx: { root, onExitToMenu(), onRematch() }
  constructor(ctx) {
    this.ctx = ctx;
    this.gameState = null;      // last 'state' broadcast { you, publicState }
    this.feedItems = [];
    this.seenLogSeq = -1;
    this.revealUntil = 0;
    this.destroyed = false;
    this.sessionState = null;   // document owned by the game script
    this.playerStates = {};
    this.room = {
      roomId: 'local-room',
      metadata: {
        startingStack: GAME.startingStack,
        smallBlind: GAME.smallBlind,
        bigBlind: GAME.bigBlind,
        turnDurationSeconds: GAME.turnDurationSeconds,
      },
      roster: [
        { userId: USER_ID, name: 'You', team: 0, slot: 0 },
        ...AI_NAMES.map((name, i) => ({ userId: null, name, team: 0, slot: i + 1, ai: true })),
      ],
    };
  }

  // One script invocation with a fresh host context. The script only ever
  // reads ctx.now / ctx.random / ctx.room / ctx.presence / ctx.message and the
  // carried sessionState / playerStates documents.
  invoke(fn, extra = {}) {
    const engine = globalThis.game;
    if (!engine) {
      this.showError('The game script (server.js) is not loaded.');
      return null;
    }
    const res = engine[fn]({
      now: Date.now(),
      random: Math.random(),
      sessionId: 'local-session',
      players: [],
      sessionState: this.sessionState,
      playerStates: this.playerStates,
      room: this.room,
      presence: { [USER_ID]: { online: true } },
      ...extra,
    });
    if (res && typeof res === 'object') {
      if (res.sessionState) this.sessionState = res.sessionState;
      if (res.playerStates) this.playerStates = res.playerStates;
      if (Array.isArray(res.broadcast)) this.dispatch(res.broadcast);
    }
    return res;
  }

  // Deliver broadcasts addressed to the local player (or to everyone).
  dispatch(broadcast) {
    for (const entry of broadcast) {
      const mine = entry.to === 'all' ||
        (Array.isArray(entry.to) && entry.to.includes(USER_ID));
      if (!mine) continue;
      const msg = entry.data;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'state') {
        this.gameState = msg;
        this.syncFeedFromLog(msg.publicState);
      } else if (msg.type === 'hand-started') {
        this.pushEvent(`Hand #${msg.handNumber} began.`);
      } else if (msg.type === 'hand-complete') {
        this.pushEvent(describeHandComplete(msg), 'win');
        this.revealUntil = Date.now() + REVEAL_WINDOW_MS;
      } else if (msg.type === 'match-complete') {
        const winner = msg.result && msg.result.winnerName;
        this.pushEvent(winner ? `The match is over — ${cap(winner)} won.` : 'The match is over.', 'win');
      }
    }
    this.render();
  }

  // --- script command channel ----------------------------------------------

  sendCommand(data) {
    const res = this.invoke('onPlayerMessage', { message: { from: USER_ID, data } });
    if (res && res.ok === false && res.error) this.showError(res.error);
  }

  act(type, amount) {
    const cmd = amount !== undefined ? { type, amount } : { type };
    this.sendCommand(cmd);
  }

  actCheckCall() {
    const la = this.gameState?.you?.legalActions;
    if (!la) return;
    this.act(la.callAmount > 0 ? 'call' : 'check');
  }

  actBetRaise() {
    const pub = this.gameState?.publicState;
    const la = this.gameState?.you?.legalActions;
    if (!pub || !la) return;
    const amount = Number(this.amountInput.value) || 0;
    this.act(pub.currentBet === 0 ? 'bet' : 'raise', amount);
  }

  preset(kind) {
    const pub = this.gameState?.publicState;
    const la = this.gameState?.you?.legalActions;
    if (!pub || !la) return;
    const me = pub.seats[this.gameState.you.seat];
    this.amountInput.value = presetTotal(la, me.roundCommit, pub.pot, kind);
    this.renderAmount();
  }

  // --- view ------------------------------------------------------------------

  show() {
    const { root } = this.ctx;
    root.textContent = '';

    this.statusLine = el('div', { class: 'table-status muted small', 'aria-live': 'polite' });
    this.centerInfo = el('div', { class: 'table-center' });
    this.feed = el('div', { class: 'event-feed', 'aria-live': 'polite' });
    this.errorLine = el('p', { class: 'error', hidden: '', role: 'alert' });
    this.seatOverlay = el('div', { class: 'seat-overlay' });

    const stage = el('div', { class: 'table-stage game-board' },
      this.seatOverlay, this.centerInfo);

    this.foldBtn = el('button', { type: 'button', text: 'Fold', onclick: () => this.act('fold') });
    this.checkCallBtn = el('button', { type: 'button', onclick: () => this.actCheckCall() });
    this.betRaiseBtn = el('button', { class: 'primary', type: 'button', onclick: () => this.actBetRaise() });
    this.allInBtn = el('button', { type: 'button', text: 'All-in', onclick: () => this.act('all-in') });
    this.amountInput = el('input', { type: 'range', class: 'bet-slider', 'aria-label': 'Bet or raise total' });
    this.amountLabel = el('span', { class: 'bet-amount' });
    this.presets = el('div', { class: 'bet-presets' });
    for (const [label, fn] of [
      ['Min', () => this.preset('min')],
      ['½ Pot', () => this.preset(0.5)],
      ['¾ Pot', () => this.preset(0.75)],
      ['Pot', () => this.preset(1)],
      ['All-in', () => this.preset('all')],
    ]) {
      this.presets.append(el('button', { type: 'button', class: 'preset', text: label, onclick: fn }));
    }

    const actionBar = el('div', { class: 'action-bar' },
      el('div', { class: 'action-buttons' }, this.foldBtn, this.checkCallBtn, this.betRaiseBtn, this.allInBtn),
      el('div', { class: 'bet-controls' }, this.amountInput, this.amountLabel, this.presets));

    const leaveBtn = el('button', {
      type: 'button', text: 'Leave table', onclick: () => this.ctx.onExitToMenu(),
    });

    this.screen = el('div', { class: 'table-screen' },
      this.statusLine, stage, actionBar, this.feed, this.errorLine, leaveBtn);
    root.append(this.screen);

    this.timerInterval = setInterval(() => this.renderTimer(), 250);
    // 1 Hz sweep, matching the script's declared tickRateHz: enforces turn
    // deadlines and lets AI seats act while the player watches.
    this.tickInterval = setInterval(() => {
      if (!this.destroyed && !this.gameState?.publicState?.matchResult) this.invoke('onTick');
    }, 1000);

    this.invoke('createSession');
    this.render();
  }

  render() {
    if (this.destroyed || !this.statusLine) return;
    const gs = this.gameState;
    const pub = gs?.publicState;
    const you = gs?.you;

    this.statusLine.textContent =
      `Hand #${pub?.handNumber ?? '–'} · ${pub?.street ?? 'waiting'}` +
      (pub?.matchResult ? ' · match over' : '');

    this.centerInfo.textContent = '';
    if (pub) {
      this.centerInfo.append(
        el('div', { class: 'pot-display', text: `Pot ${pub.pot.toLocaleString()}` }),
      );
      if (pub.board && pub.board.length) {
        this.centerInfo.append(el('div', { class: 'board-cards' },
          ...pub.board.map(cardEl)));
      }
      if (pub.matchResult) {
        this.centerInfo.append(el('div', {
          class: 'match-result',
          text: `Winner: ${pub.matchResult.winnerName || '–'}`,
        }), el('button', {
          class: 'primary', type: 'button', text: 'New match',
          onclick: () => this.ctx.onRematch(),
        }));
      }
    }

    // Seat overlays.
    this.seatOverlay.textContent = '';
    if (pub) {
      const youSeat = you && you.seat >= 0 ? you.seat : 0;
      const seatCount = pub.seats.length || 6;
      // Showdown cards stay face-up on the seat panels for a short window
      // after the hand (the next hand may already have started).
      const reveal = this.revealUntil > Date.now() && pub.prevHand
        ? pub.prevHand.reveal : null;
      for (const s of pub.seats) {
        const v = seatVisual(s.seat, youSeat, seatCount);
        const { x, y } = seatUnit(v, seatCount);
        const seatEl = el('div', {
          class: 'seat-panel' +
            (s.seat === pub.actingSeat ? ' acting' : '') +
            (s.userId === USER_ID ? ' self' : '') +
            (s.folded || s.eliminated ? ' dim' : ''),
        });
        seatEl.style.left = `${50 + x * 44}%`;
        seatEl.style.top = `${50 + y * 44}%`;
        const badges = [];
        if (s.seat === pub.dealerSeat) badges.push('D');
        if (s.seat === pub.smallBlindSeat) badges.push('SB');
        if (s.seat === pub.bigBlindSeat) badges.push('BB');
        if (s.ai) badges.push('AI');
        if (s.allIn) badges.push('ALL-IN');
        if (s.folded) badges.push('FOLD');
        if (s.sittingOut) badges.push('OUT');
        if (s.eliminated) badges.push('OUT');
        seatEl.append(
          el('div', { class: 'seat-title', text: s.name }),
          el('div', { class: 'seat-stack', text: s.stack.toLocaleString() }),
          s.roundCommit > 0
            ? el('div', { class: 'seat-bet', text: `bet ${s.roundCommit.toLocaleString()}` })
            : '',
          badges.length ? el('div', { class: 'seat-flags', text: badges.join(' ') }) : '',
          s.seat === pub.actingSeat ? el('div', { class: 'seat-timer' }) : '',
        );
        // The local player's own hole cards (only ever their own).
        if (s.userId === USER_ID && you && Array.isArray(you.holeCards)) {
          seatEl.append(el('div', { class: 'seat-cards' }, ...you.holeCards.map(cardEl)));
        }
        const shown = reveal && reveal[s.seat];
        if (shown) {
          seatEl.append(el('div', { class: 'seat-reveal' }, ...shown.map(cardEl)));
        }
        this.seatOverlay.append(seatEl);
      }
    }

    this.renderActionBar();
    this.renderTimer();
  }

  renderAmount() {
    this.amountLabel.textContent = (Number(this.amountInput.value) || 0).toLocaleString();
  }

  renderActionBar() {
    const la = this.gameState?.you?.legalActions;
    const pub = this.gameState?.publicState;
    const myTurn = !!la;
    for (const btn of [this.foldBtn, this.checkCallBtn, this.betRaiseBtn, this.allInBtn]) {
      btn.disabled = !myTurn;
    }
    this.amountInput.disabled = !myTurn;

    if (!myTurn) {
      this.checkCallBtn.textContent = 'Check / Call';
      this.betRaiseBtn.textContent = 'Bet / Raise';
      this.amountLabel.textContent = '';
      return;
    }

    this.foldBtn.disabled = !la.canFold;
    this.checkCallBtn.textContent = la.callAmount > 0
      ? `Call ${la.callAmount.toLocaleString()}`
      : 'Check';
    this.checkCallBtn.disabled = !(la.canCheck || la.callAmount > 0);

    const canAggro = pub.currentBet === 0 ? la.canBet : la.canRaise;
    this.betRaiseBtn.textContent = pub.currentBet === 0 ? 'Bet' : 'Raise to';
    this.betRaiseBtn.disabled = !canAggro;
    this.allInBtn.disabled = la.canAllIn === false || la.maximumAmount <= 0;

    this.amountInput.min = la.minimumAmount;
    this.amountInput.max = la.maximumAmount;
    if (!this.amountInput.value || Number(this.amountInput.value) < la.minimumAmount) {
      this.amountInput.value = la.minimumAmount;
    }
    this.amountInput.oninput = () => this.renderAmount();
    this.renderAmount();
  }

  renderTimer() {
    if (this.destroyed) return;
    // Expire the showdown reveal window even when no new state arrives.
    if (this.revealUntil && Date.now() >= this.revealUntil) {
      this.revealUntil = 0;
      this.render();
      return;
    }
    const pub = this.gameState?.publicState;
    if (!pub || !pub.turnDeadlineMs || pub.actingSeat < 0) return;
    // turnDeadlineMs comes from the script's ctx.now clock — Date.now() here.
    const remaining = Math.max(0, pub.turnDeadlineMs - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const panels = this.seatOverlay?.querySelectorAll('.seat-panel.acting .seat-timer');
    if (panels) {
      for (const p of panels) p.textContent = `${seconds}s`;
    }
  }

  // Fold/street/action lines are rebuilt from publicState.recentLog so they
  // survive screen redraws; dedup by monotonically increasing action seq.
  syncFeedFromLog(pub) {
    if (!pub || !Array.isArray(pub.recentLog)) return;
    for (const entry of pub.recentLog) {
      if (!Array.isArray(entry) || entry[0] <= this.seenLogSeq) continue;
      this.seenLogSeq = entry[0];
      this.pushEvent(describeLogEntry(entry, pub.seats));
    }
  }

  pushEvent(text, cls = '') {
    this.feedItems.push({ text, cls });
    while (this.feedItems.length > FEED_CAP) this.feedItems.shift();
    if (this.feed) {
      this.feed.textContent = '';
      for (const item of this.feedItems.slice().reverse()) {
        this.feed.append(el('div', { class: `feed-item${item.cls ? ' ' + item.cls : ''}`, text: item.text }));
      }
    }
  }

  showError(message) {
    if (!this.errorLine) return;
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
    setTimeout(() => { if (this.errorLine) this.errorLine.hidden = true; }, 4000);
  }

  destroy() {
    this.destroyed = true;
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.tickInterval) clearInterval(this.tickInterval);
  }
}
