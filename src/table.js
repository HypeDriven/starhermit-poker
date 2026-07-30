// Table screen: realtime-room socket (roster/presence) + gameplay socket +
// three.js table + DOM seat overlays, action bar, and event feed.
// All poker decisions come from the server; this screen only renders
// projections and sends commands.

import { RoomController } from './realtime-room.js';
import { GameSocket } from './game-socket.js';
import { TableRenderer } from './table3d.js';
import { seatVisual, seatUnit, presetTotal, describeLogEntry } from './table-utils.js';
import { ChatPanel } from './chat.js';
import { VoiceController } from './voice.js';
import { SoundFX } from './sounds.js';

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

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set([1, 2]);
function cardEl(card) {
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

// "Alice won 1,200 with Two Pair, Kings and Tens." — built from the
// hand-complete payload rather than the server's compact description.
function describeHandComplete(msg) {
  if (!Array.isArray(msg.winners) || msg.winners.length === 0) {
    return msg.description || 'The hand ended.';
  }
  const names = msg.winners.map((w) => cap(w.name || `Seat ${w.seat + 1}`)).join(' and ');
  const total = msg.winners.reduce((t, w) => t + (w.amount || 0), 0).toLocaleString();
  const desc = msg.description || '';
  const handDesc = desc.includes(' — ') ? desc.slice(desc.lastIndexOf(' — ') + 3) : '';
  if (handDesc) return `${names} won ${total} with ${handDesc}.`;
  if (/everyone else folded/.test(desc)) return `${names} won ${total} — everyone else folded.`;
  return `${names} won ${total}.`;
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
    // Diff state for sound triggers (mirrors the renderer's animation diffs).
    this._soundState = { handNumber: 0, boardLen: 0, pot: 0, myTurn: false };

    this.roomCtl = new RoomController(ctx.net, {
      onRoster: (r) => {
        this.room = r;
        if (r.gameSessionId && !this.game) this.attachGame(r.gameSessionId);
        if (r.status === 'Closed' && !this.destroyed) this.ctx.onExitToMenu();
        this.render();
      },
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
    this.voiceBtn.textContent = enabled ? 'Voice: on' : 'Voice: off';
    this.muteBtn.hidden = !enabled;
    this.voiceBtn.disabled = !enabled && !this.hasOtherHumans();
    this.voiceBtn.title = this.hasOtherHumans()
      ? 'Join table voice chat (microphone)'
      : 'Voice is available when another human is at the table';
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
      this.pushEvent(`Hand #${msg.handNumber} began.`);
    } else if (msg.type === 'hand-complete') {
      this.pushEvent(describeHandComplete(msg), 'win');
      this.sounds.win();
      // Show the revealed showdown cards on the seat overlays for a while.
      this.revealUntil = Date.now() + REVEAL_WINDOW_MS;
    } else if (msg.type === 'match-complete') {
      const winner = msg.result && msg.result.winnerName;
      this.pushEvent(winner ? `The match is over — ${cap(winner)} won.` : 'The match is over.', 'win');
      this.render();
    }
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

  show() {
    const { root } = this.ctx;
    root.textContent = '';

    this.statusLine = el('div', { class: 'table-status muted small' });
    this.centerInfo = el('div', { class: 'table-center' });
    this.feed = el('div', { class: 'event-feed' });
    this.errorLine = el('p', { class: 'error', hidden: '' });

    this.glContainer = el('div', { class: 'gl-stage' });
    this.seatOverlay = el('div', { class: 'seat-overlay' });

    const stage = el('div', { class: 'table-stage' },
      this.glContainer, this.seatOverlay, this.centerInfo);

    // Action bar.
    this.foldBtn = el('button', { type: 'button', text: 'Fold', onclick: () => this.act('fold') });
    this.checkCallBtn = el('button', { type: 'button', onclick: () => this.actCheckCall() });
    this.betRaiseBtn = el('button', { class: 'primary', type: 'button', onclick: () => this.actBetRaise() });
    this.allInBtn = el('button', { type: 'button', text: 'All-in', onclick: () => this.act('all-in') });
    this.amountInput = el('input', { type: 'range', class: 'bet-slider' });
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

    const leaveBtn = el('button', { type: 'button', text: 'Leave table', onclick: () => this.leave() });

    this.chatContainer = el('div', { class: 'chat-container' });

    // Voice controls (default OFF; explicit microphone opt-in).
    this.voiceBtn = el('button', {
      type: 'button', text: 'Voice: off',
      onclick: () => {
        if (!this.voice) return;
        if (this.voice.enabled) this.voice.disable();
        else this.voice.enable();
      },
    });
    this.muteBtn = el('button', {
      type: 'button', text: 'Mute', hidden: '',
      onclick: () => {
        if (!this.voice) return;
        this.voiceMuted = !this.voiceMuted;
        this.muteBtn.textContent = this.voiceMuted ? 'Unmute' : 'Mute';
        this.voice.setMuted(this.voiceMuted);
      },
    });
    this.voiceList = el('span', { class: 'voice-list' });
    // Sound effects (procedural, subtle; the context unlocks on first tap).
    this.soundBtn = el('button', {
      type: 'button', text: 'Sound: on',
      onclick: () => {
        this.sounds.setEnabled(!this.sounds.enabled);
        this.soundBtn.textContent = this.sounds.enabled ? 'Sound: on' : 'Sound: off';
        if (this.sounds.enabled) this.sounds.unlock();
      },
    });
    this.voicePanel = el('div', { class: 'voice-panel' },
      this.voiceBtn, this.muteBtn, this.soundBtn, this.voiceList);
    this._unlockSound = () => this.sounds.unlock();
    root.addEventListener('pointerdown', this._unlockSound);

    this.screen = el('div', { class: 'table-screen' },
      this.statusLine, stage, actionBar, this.voicePanel, this.chatContainer,
      this.feed, this.errorLine, leaveBtn);
    root.append(this.screen);

    try {
      this.renderer3d = new TableRenderer(this.glContainer);
    } catch (e) {
      // WebGL unavailable: the DOM overlay still renders the full game.
      this.glContainer.append(el('p', { class: 'muted', text: '3D unavailable — playing in text mode.' }));
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
    this.amountLabel.textContent = this.currentAmount().toLocaleString();
  }

  render() {
    if (this.destroyed || !this.statusLine) return;
    const gs = this.gameState;
    const pub = gs?.publicState;
    const you = gs?.you;

    this.statusLine.textContent =
      `Hand #${pub?.handNumber ?? '–'} · ${pub?.street ?? 'waiting'}` +
      (this.game?.socket.connected ? '' : ' · reconnecting…') +
      (pub?.matchResult ? ' · match over' : '');

    // Center: pot + board status.
    this.centerInfo.textContent = '';
    if (pub) {
      this.centerInfo.append(
        el('div', { class: 'pot-display', text: `Pot ${pub.pot.toLocaleString()}` }),
      );
      if (pub.matchResult) {
        this.centerInfo.append(el('div', {
          class: 'match-result',
          text: `Winner: ${pub.matchResult.winnerName || '–'}`,
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
            (s.userId === this.ctx.net.userId ? ' self' : '') +
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
        if (s.disconnected) badges.push('OFFLINE');
        seatEl.append(
          el('div', { class: 'seat-title', text: this.seatDisplayName(s) }),
          el('div', { class: 'seat-stack', text: s.stack.toLocaleString() }),
          s.roundCommit > 0
            ? el('div', { class: 'seat-bet', text: `bet ${s.roundCommit.toLocaleString()}` })
            : '',
          badges.length ? el('div', { class: 'seat-flags', text: badges.join(' ') }) : '',
          s.seat === pub.actingSeat ? el('div', { class: 'seat-timer' }) : '',
        );
        const shown = reveal && reveal[s.seat];
        if (shown) {
          seatEl.append(el('div', { class: 'seat-reveal' }, ...shown.map(cardEl)));
        }
        this.seatOverlay.append(seatEl);
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
    this.errorLine.textContent = message;
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
