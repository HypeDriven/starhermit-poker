// The offline table: a full match against five AI seats with no network and
// no sign-in. The same server-authoritative script (server.js,
// globalThis.game) runs in the client, driven by a local host adapter that
// supplies ctx.now / ctx.random / ctx.room and keeps the returned
// sessionState between invocations, exactly as the platform does for a
// hosted table. The clock and the random source are injected: the engine
// client passes its fixed-step clock and a seeded stream, so a played
// table replays exactly (play scripts) — the browser build used Date.now()
// and Math.random(). A 1 Hz sweep (onTick, server.js's declared tickRateHz)
// enforces turn deadlines and lets AI seats act while the player watches.
// Nothing is posted anywhere: offline play is never recorded.

import { TableModel } from './table-model.js';
import { t } from './i18n.js';

export const USER_ID = 'local-player';
export const AI_NAMES = ['Ada', 'Ben', 'Cleo', 'Dex', 'Eva'];
export const OFFLINE_CONFIG = Object.freeze({
  startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30,
});
export const TICK_MS = 1000;

export class OfflineTable {
  /**
   * game: server.js's globalThis.game; now(): ms; random(): [0, 1).
   */
  constructor({ game, now, random }) {
    this.game = game;
    this.now = now;
    this.random = random;
    this.sessionState = null;
    this.playerStates = {};
    this.lastTick = 0;
    this.error = null;           // the last rejection (English, from server.js)
    this.model = new TableModel({
      now,
      nameOf: (w, youSeat) => (w.userId === USER_ID || (w.userId === undefined && w.seat === youSeat) ? t('You') : null),
    });
    this.room = {
      roomId: 'local-room',
      metadata: { ...OFFLINE_CONFIG },
      roster: [
        { userId: USER_ID, name: 'You', team: 0, slot: 0 },
        ...AI_NAMES.map((name, i) => ({ userId: null, name, team: 0, slot: i + 1, ai: true })),
      ],
    };
  }

  /** Deals the first hand. */
  start() {
    this.lastTick = this.now();
    this.invoke('createSession');
  }

  // One script invocation with a fresh host context, as the platform makes it.
  invoke(fn, extra = {}) {
    const res = this.game[fn]({
      now: this.now(),
      random: this.random(),
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

  /** Broadcasts addressed to the local player (or to everyone), in order. */
  dispatch(broadcast) {
    for (const entry of broadcast) {
      const mine = entry.to === 'all' || (Array.isArray(entry.to) && entry.to.includes(USER_ID));
      if (mine) this.model.receive(entry.data);
    }
  }

  /** A command from the player: fold, check, call, bet/raise (new round total), all-in. */
  send(data) {
    const res = this.invoke('onPlayerMessage', { message: { from: USER_ID, data } });
    this.error = res && res.ok === false && res.error ? res.error : null;
    return !this.error;
  }

  get over() { return !!(this.model.pub && this.model.pub.matchResult); }

  /** Called every frame: the 1 Hz sweep on the injected clock. */
  update() {
    const now = this.now();
    if (now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    if (!this.over) this.invoke('onTick');
  }
}
