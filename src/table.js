// Table screen: realtime-room socket (roster/presence) + gameplay socket +
// three.js table + DOM seat overlays, action bar, and event feed.
// All poker decisions come from the server; this screen only renders
// projections and sends commands.

import { RoomController } from './realtime-room.js';
import { GameSocket } from './game-socket.js';
import { TableRenderer } from './table3d.js';
import { seatVisual, seatUnit, presetTotal, describeLogEntry, keepSeatInStage, seatName } from './table-utils.js';
import { ChatPanel } from './chat.js';
import { VoiceController } from './voice.js';
import { SoundFX } from './sounds.js';
import { settingsButton, closeSettings } from './graphics-panel.js';
import { pushPref, SOUND_ENABLED_KEY } from './platform-prefs.js';
import { currentPlatformStrings } from './platform-i18n.js';
import { el, t, num, streetName, handDescription, serverMessage } from './i18n.js';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set([1, 2]);
export function cardEl(card) {
  const suit = (card / 13) | 0;
  return el('span', {
    class: `pcard${RED_SUITS.has(suit) ? ' red' : ''}`,
    text: `${RANKS[card % 13]}${SUIT_GLYPHS[suit]}`,
  });
}

// How long showdown cards stay revealed on the seat overlays after a hand.
const REVEAL_WINDOW_MS = 8000;
// The feed shows only the latest few lines — no scrolling, fits the screen.
const FEED_CAP = 3;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);


function readSoundEnabled() {
  try { return localStorage.getItem(SOUND_ENABLED_KEY) !== '0'; } catch { return true; }
}

function writeSoundEnabled(on) {
  try { localStorage.setItem(SOUND_ENABLED_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  pushPref('soundEnabled', on); // StarHermit settings KV when signed in
}

// "Alice won 1,200 with Two Pair, Kings and Tens." — built from the
// hand-complete payload rather than the server's compact description, in the
// game language at call time.
// nameOf(winner) overrides a winner's display name (the offline table shows
// its player as "You" in the game language).
export function describeHandComplete(msg, nameOf = null) {
  if (!Array.isArray(msg.winners) || msg.winners.length === 0) {
    return msg.description || t('The hand ended.');
  }
  const names = msg.winners.map((w) => cap((nameOf && nameOf(w))
    || w.name || t('Seat {n}', { n: w.seat + 1 }))).join(t(' and '));
  const total = num(msg.winners.reduce((s, w) => s + (w.amount || 0), 0));
  const desc = msg.description || '';
  const handDesc = desc.includes(' — ') ? desc.slice(desc.lastIndexOf(' — ') + 3) : '';
  if (handDesc) return t('{names} won {total} with {hand}.', { names, total, hand: handDescription(handDesc) });
  if (/everyone else folded/.test(desc)) return t('{names} won {total} — everyone else folded.', { names, total });
  return t('{names} won {total}.', { names, total });
}

/** "The match is over — Ada won." in the game language. */
export function describeMatchOver(winner) {
  return winner ? t('The match is over — {name} won.', { name: cap(winner) }) : t('The match is over.');
}

/** Seat badges (dealer, blinds, AI, state) in the game language. */
export function seatBadges(s, pub, { offline = true } = {}) {
  const b = [];
  if (s.seat === pub.dealerSeat) b.push(t('badge.dealer'));
  if (s.seat === pub.smallBlindSeat) b.push(t('badge.sb'));
  if (s.seat === pub.bigBlindSeat) b.push(t('badge.bb'));
  if (s.ai) b.push(t('badge.ai'));
  if (s.allIn) b.push(t('badge.all-in'));
  if (s.folded) b.push(t('badge.fold'));
  if (s.sittingOut || s.eliminated) b.push(t('badge.out'));
  if (offline && s.disconnected) b.push(t('badge.offline'));
  return b;
}

/** Status line: "Hand #3 · flop" (+ reconnecting / match over). */
export function tableStatus(pub, { reconnecting = false, stopped = '' } = {}) {
  return t('Hand #{n}', { n: pub?.handNumber ?? '–' }) + ' · ' + streetName(pub?.street) +
    (stopped ? ' · ' + stopped : reconnecting ? ' · ' + t('reconnecting…') : '') +
    (pub?.matchResult ? ' · ' + t('match over') : '');
}

/** Action-bar labels for the current legal actions (shared with the offline table). */
export function labelActionBar(view, la, pub) {
  if (!la) {
    view.checkCallBtn.textContent = t('Check / Call');
    view.betRaiseBtn.textContent = t('Bet / Raise');
    return;
  }
  view.checkCallBtn.textContent = la.callAmount > 0 ? t('Call {n}', { n: num(la.callAmount) }) : t('Check');
  view.betRaiseBtn.textContent = pub.currentBet === 0 ? t('Bet') : t('Raise to');
}

export class TableScreen {
  // ctx: { root, net, onExitToMenu() }; room: the Playing realtime room.
  constructor(ctx, room) {
    this.ctx = ctx;
    this.room = room;
    this.gameState = null;      // last 'state' message { you, publicState }
    this.feedItems = [];        // recent activity lines (newest last)
    this.seenLogSeq = -1;       // highest action-log seq already in the feed
    this.revealUntil = 0;       // epoch ms until showdown cards stay visible
    this.destroyed = false;
    this.sounds = new SoundFX();
    this.sounds.setEnabled(readSoundEnabled());
    // Diff state for sound triggers (mirrors the renderer's animation diffs).
    this._soundState = { handNumber: 0, boardLen: 0, pot: 0, myTurn: false };

    this.roomCtl = new RoomController(ctx.net, {
      onRoster: (r) => {
        this.room = r;
        if (r.gameSessionId && !this.game) this.attachGame(r.gameSessionId);
        if (r.status === 'Closed' && !this.destroyed) this.ctx.onExitToMenu();
        this.render();
      },
      // The room vanished while we were away: the game socket decides what
      // the player sees (it may still be finishing the match).
      onUnavailable: () => this.render(),
    });
    if (room.gameSessionId) this.attachGame(room.gameSessionId);

    this._profileListener = () => this.render();
    ctx.net.profiles.addListener(this._profileListener);
  }

  // Nickname-aware display name (roster username as fallback, AI names from
  // the roster unchanged).
  seatDisplayName(s) {
    if (s.ai || !s.userId) return s.name;
    this.ctx.net.profiles.profile(s.userId); // fire-and-forget; listener re-renders
    return this.ctx.net.profiles.displayName(s.userId, s.name);
  }

  attachGame(sessionId) {
    this.game = new GameSocket(this.ctx.net, sessionId, {
      onState: (msg) => {
        this.gameState = msg;
        this.syncFeedFromLog(msg.publicState);
        this.playStateSounds(msg);
        this.render();
      },
      onEvent: (msg) => this.onGameEvent(msg),
      onError: (message) => this.showError(message),
      onDown: () => this.render(),
      onUnavailable: () => this.onUnavailable(),
    });
    this.game.connect();
    this.attachChat(sessionId);
  }

  // The session detail carries the chat conversation for this table (chat
  // and voice both anchor to it).
  async attachChat(sessionId) {
    try {
      const session = await this.ctx.net.client.get(
        `/api/v1/games/${this.ctx.net.scope}/sessions/${sessionId}`);
      if (this.destroyed || !session || !session.chatConversationId) return;
      if (this.chat) this.chat.destroy();
      this.chat = new ChatPanel(this.ctx.net, session.chatConversationId, {
        resolveName: (userId, username) => {
          this.ctx.net.profiles.profile(userId);
          return this.ctx.net.profiles.displayName(userId, username);
        },
      });
      if (this.chatContainer) this.chat.mount(this.chatContainer);
      this.attachVoice(session.chatConversationId);
    } catch { /* chat/voice are optional; gameplay continues without them */ }
  }

  attachVoice(conversationId) {
    if (this.voice) this.voice.destroy();
    this.voice = new VoiceController(this.ctx.net, conversationId, {
      onParticipants: () => this.renderVoicePanel(),
      onState: () => this.renderVoicePanel(),
      onError: (m) => this.showError(m),
    });
    this.renderVoicePanel();
  }

  hasOtherHumans() {
    const seats = this.gameState?.publicState?.seats || [];
    return seats.some((s) => s.userId && s.userId !== this.ctx.net.userId && !s.left);
  }

  renderVoicePanel() {
    if (!this.voicePanel || !this.voice) return;
    const enabled = this.voice.enabled;
    this.voiceBtn.textContent = enabled ? t('Voice: on') : t('Voice: off');
    this.muteBtn.hidden = !enabled;
    this.voiceBtn.disabled = !enabled && !this.hasOtherHumans();
    this.voiceBtn.title = this.hasOtherHumans()
      ? t('Join table voice chat (microphone)')
      : t('Voice is available when another human is at the table');
    this.voiceList.textContent = '';
    if (enabled) {
      for (const p of this.voice.participants) {
        const [userId, state] = p;
        this.voiceList.append(el('span', {
          class: `voice-peer${state.speaking ? ' speaking' : ''}`,
          text: `${state.muted ? '🔇' : '🎙'} ${this.nameFor(userId)}`,
        }));
      }
    }
  }

  nameFor(userId) {
    const seats = this.gameState?.publicState?.seats || [];
    const s = seats.find((x) => x.userId === userId);
    this.ctx.net.profiles.profile(userId);
    return this.ctx.net.profiles.displayName(userId, s ? s.name : undefined);
  }

  // Fold/street/action lines are rebuilt from publicState.recentLog (see
  // syncFeedFromLog) so they survive reconnects; this handler adds only the
  // hand lifecycle lines the log does not carry.
  onGameEvent(msg) {
    if (msg.type === 'hand-started') {
      this.pushEvent(() => t('Hand #{n} began.', { n: msg.handNumber }));
    } else if (msg.type === 'hand-complete') {
      this.pushEvent(() => describeHandComplete(msg), 'win');
      this.sounds.win();
      // Show the revealed showdown cards on the seat overlays for a while.
      this.revealUntil = Date.now() + REVEAL_WINDOW_MS;
    } else if (msg.type === 'match-complete') {
      const winner = msg.result && msg.result.winnerName;
      this.pushEvent(() => describeMatchOver(winner), 'win');
      this.showMatchRank(msg.result);
      this.render();
    }
  }

  // server.js posts the winner's tables-won total to match-wins and every
  // seated player's hands won to hands-won; show the signed-in player's rank on
  // the board that this result moved (match-wins for a win, hands-won otherwise).
  async showMatchRank(result) {
    const sh = globalThis.StarHermit;
    if (!sh || !sh.signedIn || !result || this._lbShown) return;
    this._lbShown = true;
    const board = result.winnerUserId === this.ctx.net.userId ? 'match-wins' : 'hands-won';
    this.lbText = () => currentPlatformStrings().lbPosting;
    this.render();
    let mine = null;
    for (let i = 0; i < 8 && !mine && !this.destroyed; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500));
      const r = await sh.leaderboard(board, { pageSize: 100 }).catch(() => null);
      mine = r && (r.items || []).find((e) => e.userId === this.ctx.net.userId);
    }
    if (this.destroyed) return;
    this.lbText = mine ? () => currentPlatformStrings().lbRank.replace('{rank}', mine.rank) : () => currentPlatformStrings().lbPosted;
    this.render();
  }

  // Sound effects driven by state diffs: a deal swish on a new hand, a card
  // snap when the board grows, chip clicks when the pot grows, and a soft
  // blip when the action moves to you.
  playStateSounds(msg) {
    const pub = msg.publicState;
    if (!pub) return;
    const prev = this._soundState;
    const boardLen = (pub.board || []).length;
    const myTurn = !!(msg.you && msg.you.legalActions);
    if (pub.handNumber !== prev.handNumber) this.sounds.deal();
    else if (boardLen > prev.boardLen) this.sounds.place();
    if (pub.pot > prev.pot) this.sounds.chips();
    if (myTurn && !prev.myTurn) this.sounds.turn();
    this._soundState = { handNumber: pub.handNumber, boardLen, pot: pub.pot, myTurn };
  }

  // Append action/street lines from the broadcast action log, skipping
  // entries already fed (dedup by monotonically increasing action seq).
  syncFeedFromLog(pub) {
    if (!pub || !Array.isArray(pub.recentLog)) return;
    for (const entry of pub.recentLog) {
      if (!Array.isArray(entry) || entry[0] <= this.seenLogSeq) continue;
      this.seenLogSeq = entry[0];
      const seats = pub.seats;
      this.pushEvent(() => describeLogEntry(entry, seats));
    }
  }

  // text: a function returning the line in the current language (re-run on a
  // language change) or a plain string.
  pushEvent(text, cls = '') {
    this.feedItems.push({ text, cls });
    while (this.feedItems.length > FEED_CAP) this.feedItems.shift();
    this.renderFeed();
  }

  renderFeed() {
    if (!this.feed) return;
    this.feed.textContent = '';
    for (const item of this.feedItems.slice().reverse()) {
      const text = typeof item.text === 'function' ? item.text() : item.text;
      this.feed.append(el('div', { class: `feed-item${item.cls ? ' ' + item.cls : ''}`, text }));
    }
  }

  // Language change: static labels re-apply through data-i18n; the rest here.
  relocalize() {
    if (this.destroyed) return;
    this.renderFeed();
    this.render();
    if (this.voiceMuted !== undefined && this.muteBtn) this.muteBtn.textContent = this.voiceMuted ? t('Unmute') : t('Mute');
    if (this.soundBtn) this.soundBtn.textContent = this.sounds.enabled ? t('Sound: on') : t('Sound: off');
    if (this.lastError && this.errorLine && !this.errorLine.hidden) this.errorLine.textContent = serverMessage(this.lastError);
  }

  // The game session is gone or finished while we were disconnected: the
  // reconnect loop stopped; say so and leave the last view on screen.
  onUnavailable() {
    if (this.destroyed) return;
    this.unavailable = true;
    this.render();
  }

  show() {
    const { root } = this.ctx;
    root.textContent = '';

    this.statusLine = el('div', { class: 'table-status muted small', 'aria-live': 'polite' });
    this.centerInfo = el('div', { class: 'table-center' });
    this.feed = el('div', { class: 'event-feed', 'aria-live': 'polite' });
    this.errorLine = el('p', { class: 'error', hidden: '', role: 'alert' });

    this.glContainer = el('div', { class: 'gl-stage' });
    this.seatOverlay = el('div', { class: 'seat-overlay' });

    const stage = el('div', { class: 'table-stage has-3d' },
      this.glContainer, this.seatOverlay, this.centerInfo);

    // Action bar.
    this.foldBtn = el('button', { type: 'button', i18n: 'Fold', onclick: () => this.act('fold') });
    this.checkCallBtn = el('button', { type: 'button', onclick: () => this.actCheckCall() });
    this.betRaiseBtn = el('button', { class: 'primary', type: 'button', onclick: () => this.actBetRaise() });
    this.allInBtn = el('button', { type: 'button', i18n: 'All-in', onclick: () => this.act('all-in') });
    this.amountInput = el('input', { type: 'range', class: 'bet-slider', i18nAria: 'Bet or raise total' });
    this.amountLabel = el('span', { class: 'bet-amount' });
    this.presets = el('div', { class: 'bet-presets' });
    for (const [label, fn] of [
      ['preset.min', () => this.preset('min')],
      ['preset.half', () => this.preset(0.5)],
      ['preset.three-quarters', () => this.preset(0.75)],
      ['preset.pot', () => this.preset(1)],
      ['preset.all-in', () => this.preset('all')],
    ]) {
      this.presets.append(el('button', { type: 'button', class: 'preset', i18n: label, onclick: fn }));
    }

    const actionBar = el('div', { class: 'action-bar' },
      el('div', { class: 'action-buttons' }, this.foldBtn, this.checkCallBtn, this.betRaiseBtn, this.allInBtn),
      el('div', { class: 'bet-controls' }, this.amountInput, this.amountLabel, this.presets));

    const leaveBtn = el('button', { type: 'button', i18n: 'Leave table', onclick: () => this.leave() });

    this.chatContainer = el('div', { class: 'chat-container' });

    // Voice controls (default OFF; explicit microphone opt-in).
    this.voiceBtn = el('button', {
      type: 'button', text: t('Voice: off'),
      onclick: () => {
        if (!this.voice) return;
        if (this.voice.enabled) this.voice.disable();
        else this.voice.enable();
      },
    });
    this.muteBtn = el('button', {
      type: 'button', text: t('Mute'), hidden: '',
      onclick: () => {
        if (!this.voice) return;
        this.voiceMuted = !this.voiceMuted;
        this.muteBtn.textContent = this.voiceMuted ? t('Unmute') : t('Mute');
        this.voice.setMuted(this.voiceMuted);
      },
    });
    this.voiceList = el('span', { class: 'voice-list' });
    // Sound effects (procedural, subtle; the context unlocks on first tap).
    this.soundBtn = el('button', {
      type: 'button', text: this.sounds.enabled ? t('Sound: on') : t('Sound: off'),
      onclick: () => {
        this.sounds.setEnabled(!this.sounds.enabled);
        writeSoundEnabled(this.sounds.enabled);
        this.soundBtn.textContent = this.sounds.enabled ? t('Sound: on') : t('Sound: off');
        if (this.sounds.enabled) this.sounds.unlock();
      },
    });
    this.voicePanel = el('div', { class: 'voice-panel' },
      this.voiceBtn, this.muteBtn, this.soundBtn, this.voiceList);
    this._unlockSound = () => this.sounds.unlock();
    root.addEventListener('pointerdown', this._unlockSound);

    this.screen = el('div', { class: 'table-screen' },
      el('div', { class: 'table-topbar' }, this.statusLine, settingsButton('compact')), stage, actionBar, this.voicePanel, this.chatContainer,
      this.feed, this.errorLine, leaveBtn);
    root.append(this.screen);

    try {
      this.renderer3d = new TableRenderer(this.glContainer);
    } catch (e) {
      // WebGL unavailable: the DOM overlay still renders the full game.
      this.glContainer.append(el('p', { class: 'muted', i18n: '3D unavailable — playing in text mode.' }));
      this.renderer3d = null;
    }

    this.timerInterval = setInterval(() => this.renderTimer(), 250);
    if (this.room.id) this.roomCtl.connect(this.room.id);
    this.render();
  }

  // --- actions ------------------------------------------------------------

  act(type, amount) {
    if (!this.game) return;
    const cmd = amount !== undefined ? { type, amount } : { type };
    this.game.sendCommand(cmd);
  }

  actCheckCall() {
    const la = this.gameState?.you?.legalActions;
    if (!la) return;
    this.act(la.callAmount > 0 ? 'call' : 'check');
  }

  currentAmount() {
    return Number(this.amountInput.value) || 0;
  }

  actBetRaise() {
    const pub = this.gameState?.publicState;
    const la = this.gameState?.you?.legalActions;
    if (!pub || !la) return;
    const amount = this.currentAmount();
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

  // --- rendering ----------------------------------------------------------

  renderAmount() {
    this.amountLabel.textContent = num(this.currentAmount());
  }

  render() {
    if (this.destroyed || !this.statusLine) return;
    const gs = this.gameState;
    const pub = gs?.publicState;
    const you = gs?.you;

    const stopped = this.unavailable && !pub?.matchResult;
    this.statusLine.textContent = tableStatus(pub, {
      reconnecting: !this.game?.socket.connected,
      stopped: stopped ? t('connection closed') : '',
    });

    // Center: pot + board status.
    this.centerInfo.textContent = '';
    if (stopped) {
      this.centerInfo.append(el('div', { class: 'online-stop', role: 'alert',
        text: t('This table is no longer available — leave it to return to the menu.') }));
    }
    if (pub) {
      this.centerInfo.append(
        el('div', { class: 'pot-display', text: t('Pot {n}', { n: num(pub.pot) }) }),
      );
      if (pub.matchResult) {
        this.centerInfo.append(el('div', {
          class: 'match-result',
          text: t('Winner: {name}', { name: pub.matchResult.winnerName || '–' }),
        }));
        if (this.lbText) {
          this.centerInfo.append(el('div', { class: 'match-lb', id: 'match-lb', text: this.lbText() }));
        }
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
            (s.userId === this.ctx.net.userId ? ' self' : '') +
            (s.folded || s.eliminated ? ' dim' : ''),
        });
        seatEl.style.left = `${50 + x * 44}%`;
        seatEl.style.top = `${50 + y * 44}%`;
        const badges = seatBadges(s, pub);
        seatEl.append(
          el('div', { class: 'seat-title', text: this.seatDisplayName(s) }),
          el('div', { class: 'seat-stack', text: num(s.stack) }),
          s.roundCommit > 0
            ? el('div', { class: 'seat-bet', text: t('bet {n}', { n: num(s.roundCommit) }) })
            : '',
          badges.length ? el('div', { class: 'seat-flags', text: badges.join(' ') }) : '',
          s.seat === pub.actingSeat ? el('div', { class: 'seat-timer' }) : '',
        );
        const shown = reveal && reveal[s.seat];
        if (shown) {
          seatEl.append(el('div', { class: 'seat-reveal' }, ...shown.map(cardEl)));
        }
        this.seatOverlay.append(seatEl);
        keepSeatInStage(seatEl, y);
      }
    }

    // 3D scene.
    if (this.renderer3d && pub) this.renderer3d.update(pub, you);

    this.renderActionBar();
    this.renderVoicePanel();
    this.renderTimer();
  }

  renderActionBar() {
    const la = this.gameState?.you?.legalActions;
    const pub = this.gameState?.publicState;
    const myTurn = !!la;
    for (const btn of [this.foldBtn, this.checkCallBtn, this.betRaiseBtn, this.allInBtn]) {
      btn.disabled = !myTurn;
    }
    this.amountInput.disabled = !myTurn;
    labelActionBar(this, la, pub);

    if (!myTurn) {
      this.amountLabel.textContent = '';
      return;
    }

    this.foldBtn.disabled = !la.canFold;
    this.checkCallBtn.disabled = !(la.canCheck || la.callAmount > 0);

    const canAggro = pub.currentBet === 0 ? la.canBet : la.canRaise;
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
    // turnDeadlineMs is an absolute epoch from the authoritative server.
    // Do not reset the clock from receipt time: delayed frames must show the
    // actual remaining time rather than granting a visual extra turn.
    const remaining = Math.max(0, pub.turnDeadlineMs - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const panels = this.seatOverlay?.querySelectorAll('.seat-panel.acting .seat-timer');
    if (panels) {
      for (const p of panels) p.textContent = `${seconds}s`;
    }
  }

  showError(message) {
    if (!this.errorLine) return;
    this.lastError = message;
    this.errorLine.textContent = serverMessage(message);
    this.errorLine.hidden = false;
    setTimeout(() => { if (this.errorLine) this.errorLine.hidden = true; }, 4000);
  }

  async leave() {
    if (this.room.id) {
      try { await this.roomCtl.leaveRoom(this.room.id); } catch { /* already gone */ }
    }
    if (!this.destroyed) this.ctx.onExitToMenu();
  }

  destroy() {
    this.destroyed = true;
    closeSettings();
    this.ctx.net.profiles.removeListener(this._profileListener);
    if (this._unlockSound) this.ctx.root.removeEventListener('pointerdown', this._unlockSound);
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.voice) this.voice.destroy();
    if (this.chat) this.chat.destroy();
    if (this.renderer3d) this.renderer3d.dispose();
    if (this.game) this.game.destroy();
    this.roomCtl.destroy();
  }
}
