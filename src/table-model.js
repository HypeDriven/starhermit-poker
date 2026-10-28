// The table as the client sees it, shared by the offline table (offline.js)
// and the online table (online.js): the last addressed `state` projection
// from server.js, the activity feed (action lines rebuilt from the public
// action log, deduplicated by sequence number, plus the hand lifecycle lines),
// the showdown reveal window, and the sound cues a state change implies. Pure:
// the clock is injected (ms), every line is a function so it renders in the
// current language, and nothing here decides poker — server.js does.

import { t, num, streetName, handDescription } from './i18n.js';
import { describeLogEntry } from './table-utils.js';

/** How long showdown cards stay revealed on the seat panels after a hand (ms). */
export const REVEAL_WINDOW_MS = 8000;
/** The feed shows only the latest few lines. */
export const FEED_CAP = 3;

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * "Alice won 1,200 with Two Pair, Kings and Tens." from the hand-complete
 * payload, in the game language at call time. nameOf(winner) overrides a
 * winner's display name (the offline table shows its player as "You").
 */
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

/** Status line: "Hand #3 · flop" (+ reconnecting / connection closed / match over). */
export function tableStatus(pub, { reconnecting = false, stopped = '' } = {}) {
  return t('Hand #{n}', { n: pub?.handNumber ?? '–' }) + ' · ' + streetName(pub?.street) +
    (stopped ? ' · ' + stopped : reconnecting ? ' · ' + t('reconnecting…') : '') +
    (pub?.matchResult ? ' · ' + t('match over') : '');
}

/** The check/call and bet/raise labels for the current legal actions. */
export function actionLabels(la, pub) {
  if (!la) return { checkCall: t('Check / Call'), betRaise: t('Bet / Raise') };
  return {
    checkCall: la.callAmount > 0 ? t('Call {n}', { n: num(la.callAmount) }) : t('Check'),
    betRaise: pub && pub.currentBet === 0 ? t('Bet') : t('Raise to'),
  };
}

export class TableModel {
  /**
   * now(): the clock in ms (server.js's turnDeadlineMs is on the same clock
   * offline; online it is the platform's epoch, read through serverNow).
   * nameOf(winner) optional winner-name override (offline: "You").
   */
  constructor({ now, nameOf = null } = {}) {
    this.now = now || (() => 0);
    this.nameOf = nameOf;
    this.gameState = null;   // last 'state' message { you, publicState, stateVersion }
    this.feed = [];          // { text: () => string, cls } newest last, at most FEED_CAP
    this.seenLogSeq = -1;
    this.revealUntil = 0;
    this.sounds = [];        // cues since the last take(): deal | place | chips | turn | win
    this.announcements = []; // lines for screen readers since the last take
    this.version = 0;        // bumps on every change (renderers redraw)
    this._snd = { handNumber: 0, boardLen: 0, pot: 0, myTurn: false };
    this.matchOver = null;   // the match-complete result once it arrived
  }

  get pub() { return this.gameState ? this.gameState.publicState : null; }
  get you() { return this.gameState ? this.gameState.you : null; }
  get legal() { const y = this.you; return y && y.legalActions ? y.legalActions : null; }

  /** One server.js broadcast's data addressed to this player. */
  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'state') {
      if (!msg.publicState) return;
      this.gameState = msg;
      this._syncFeed(msg.publicState);
      this._stateSounds(msg);
    } else if (msg.type === 'hand-started') {
      this._push(() => t('Hand #{n} began.', { n: msg.handNumber }));
    } else if (msg.type === 'hand-complete') {
      const youSeat = this.you ? this.you.seat : -1;
      const nameOf = this.nameOf ? (w) => this.nameOf(w, youSeat) : null;
      this._push(() => describeHandComplete(msg, nameOf), 'win');
      this.sounds.push('win');
      this.revealUntil = this.now() + REVEAL_WINDOW_MS;
    } else if (msg.type === 'match-complete') {
      const r = msg.result || null;
      this.matchOver = r;
      const name = r ? (this.nameOf ? this.nameOf({ userId: r.winnerUserId, name: r.winnerName, seat: r.winnerSeat }, this.you ? this.you.seat : -1) : null) || r.winnerName : null;
      this._push(() => describeMatchOver(name), 'win');
    } else return;
    this.version++;
  }

  /** The showdown cards still shown on the seat panels (null when the window closed). */
  reveal() {
    const pub = this.pub;
    if (!pub || !pub.prevHand || this.revealUntil <= this.now()) return null;
    return pub.prevHand.reveal || null;
  }

  /** Seconds left on the acting seat's clock (null when no clock runs). */
  secondsLeft() {
    const pub = this.pub;
    if (!pub || !pub.turnDeadlineMs || pub.actingSeat < 0) return null;
    return Math.ceil(Math.max(0, pub.turnDeadlineMs - this.now()) / 1000);
  }

  /** Sound cues and announcements since the last call. */
  take() {
    const out = { sounds: this.sounds, announcements: this.announcements };
    this.sounds = [];
    this.announcements = [];
    return out;
  }

  _syncFeed(pub) {
    if (!Array.isArray(pub.recentLog)) return;
    for (const entry of pub.recentLog) {
      if (!Array.isArray(entry) || entry[0] <= this.seenLogSeq) continue;
      this.seenLogSeq = entry[0];
      const seats = pub.seats;
      this._push(() => describeLogEntry(entry, seats));
    }
  }

  _push(text, cls = '') {
    this.feed.push({ text, cls });
    while (this.feed.length > FEED_CAP) this.feed.shift();
    this.announcements.push(text);
  }

  // A deal swish on a new hand, a card snap when the board grows, chip clicks
  // when the pot grows, and a soft blip when the action moves to you.
  _stateSounds(msg) {
    const pub = msg.publicState;
    const prev = this._snd;
    const boardLen = (pub.board || []).length;
    const myTurn = !!(msg.you && msg.you.legalActions);
    if (pub.handNumber !== prev.handNumber) this.sounds.push('deal');
    else if (boardLen > prev.boardLen) this.sounds.push('place');
    if (pub.pot > prev.pot) this.sounds.push('chips');
    if (myTurn && !prev.myTurn) this.sounds.push('turn');
    this._snd = { handNumber: pub.handNumber, boardLen, pot: pub.pot, myTurn };
  }
}
