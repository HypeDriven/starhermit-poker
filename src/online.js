// Online tables: StarHermit realtime rooms for the lobby, and the session the
// platform binds to a started room for the match, refereed by server.js.
//
// The host creates a room (one team; six seats, or exactly 1 + N when the
// player chose N AI opponents, since start backfills every empty seat) with
// the poker config in its metadata, seating the AI opponents at once
// (`aiPlayers`); Quick Play joins an open room of this game or, when there is
// none, creates a public one and opens it for matchmaking (an open room starts
// as soon as every seat is taken, AI seats included). Private tables stay in
// the lobby: the host invites friends (room invites, which StarHermit shows
// the friend), moves AI seats to empty seats, and starts the table. When the
// room is playing, every client opens the bound session's game socket, sends
// { type: 'sync' } on every (re)connection and its actions as commands; the
// script answers each player with its own addressed projection. Results,
// ratings and leaderboard scores are the script's (server.js returns them):
// no client ever posts a result. A room that starts without a bound session
// is not played (there is no client-refereed fallback).
//
// `platform` is the adapter native/platform.ts provides (and the node tests
// fake): { userId, createRoom, openRoom, startRoom, leaveRoom, getRoom,
// quickJoin, myRoom, seat, invite, invites, acceptInvite, declineInvite,
// connectRoom(roomId, handlers), connectGame(sessionId, handlers) }. Room
// objects are the engine's (status lobby | open | playing | closed).

import { TableModel } from './table-model.js';

export const MAX_SEATS = 6;
export const BACKFILL_AFTER_SECONDS = 45;
/** The platform disconnects a client that sends commands faster than the session's tick (1 Hz). */
export const CMD_MIN_INTERVAL_MS = 1000;

/** The poker config stored in the room's metadata (server.js readConfig). */
export function roomMetadata(visibility) {
  return {
    variant: 'nlhe', startingStack: 10000, smallBlind: 50, bigBlind: 100, turnDurationSeconds: 30,
    visibility, // 'public' | 'private'
  };
}

/** The room's seat count (the full table when the room's shape is unknown). */
export function seatCountOf(room) {
  const n = room && room.seatsPerTeam;
  return Number.isInteger(n) && n > 0 ? n : MAX_SEATS;
}

/** Participants by seat (one team, so seat = slot): `seatCount` entries { seat, participant | null }. */
export function seatMap(participants, seatCount = MAX_SEATS) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({ seat: i, participant: null }));
  for (const p of participants || []) {
    if (p && (p.team ?? 0) === 0 && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < seatCount) {
      seats[p.slot] = { seat: p.slot, participant: p };
    }
  }
  return seats;
}

export function isHost(room, userId) {
  return !!room && !!userId && room.hostUserId === userId;
}

/** The host may start whenever the room is still in the lobby — even alone (empty seats become AI). */
export function canStart(room, userId) {
  if (!room || room.status === 'playing' || room.status === 'closed') return false;
  return isHost(room, userId);
}

/** Ready signals from the room's control frames, by participant id (the platform keeps no ready field). */
export class ReadyTracker {
  constructor() { this.byParticipant = new Map(); }
  applyFrame(fromParticipantId, ready) { if (fromParticipantId) this.byParticipant.set(fromParticipantId, !!ready); }
  isReady(participantId) { return this.byParticipant.get(participantId) === true; }
  prune(participants) {
    const ids = new Set((participants || []).map((p) => p.id));
    for (const id of [...this.byParticipant.keys()]) if (!ids.has(id)) this.byParticipant.delete(id);
  }
}

const errKind = (e) => (e && (e.kind || e.code)) || '';
const conflict = (e) => {
  const k = errKind(e);
  return k === 'conflict' || k === 'active-room-elsewhere' || (e && e.status === 409);
};

/** The room config for a new table: N AI opponents seat a table of exactly 1 + N. */
export function newRoom(visibility, aiPlayers = 0) {
  return {
    teamCount: 1,
    seatsPerTeam: aiPlayers > 0 ? 1 + aiPlayers : MAX_SEATS,
    backfillAfterSeconds: BACKFILL_AFTER_SECONDS,
    aiPlayers,
    metadata: roomMetadata(visibility),
  };
}

// One active room per player: when creating or joining conflicts, rejoin the
// room the player already holds instead of failing.
async function recoverConflict(platform, e) {
  if (conflict(e)) {
    const room = await platform.myRoom().catch(() => null);
    if (room && room.status !== 'closed') return room;
  }
  throw e;
}

/** Quick Play: join an open table, else create a public one with `aiPlayers` AI and open it. */
export async function quickPlay(platform, aiPlayers = 0) {
  try {
    const joined = await platform.quickJoin();
    if (joined) return joined;
    const room = await platform.createRoom(newRoom('public', aiPlayers));
    return await platform.openRoom(room.id);
  } catch (e) {
    return recoverConflict(platform, e);
  }
}

/** Private Table: a lobby room the host fills with invites and starts by hand. */
export async function createPrivateTable(platform, aiPlayers = 0) {
  try {
    return await platform.createRoom(newRoom('private', aiPlayers));
  } catch (e) {
    return recoverConflict(platform, e);
  }
}

/**
 * Invites a friend to `roomId`: one room invite, which StarHermit shows the
 * friend (a games-API invite as well would notify them twice). A conflict means
 * already invited or seated: the seat stands. Never throws.
 */
export async function inviteFriend(platform, roomId, toUserId) {
  try {
    await platform.invite(roomId, toUserId);
    return { seated: true, error: null };
  } catch (e) {
    if (conflict(e)) return { seated: true, error: null };
    return { seated: false, error: e };
  }
}

// ---------------------------------------------------------------------------
// The lobby: the room's roster, presence and ready signals, and the host's controls.

export class LobbyClient {
  /** hooks: onChange(), onPlaying(room) when the bound session is there, onClosed(code). */
  constructor(platform, room, hooks = {}) {
    this.platform = platform;
    this.hooks = hooks;
    this.room = room;
    this.ready = new ReadyTracker();
    this.presence = new Map();
    this.selfReady = false;
    this.selectedAi = null;     // an AI participant picked up to move
    this.pendingInvites = new Set();
    this.connected = false;
    this.unavailable = false;
    this.starting = false;
    this._socket = null;
    this._handedOff = false;
  }

  get userId() { return this.platform.userId; }
  get host() { return isHost(this.room, this.userId); }
  get seatCount() { return seatCountOf(this.room); }
  get participants() { return (this.room && this.room.participants) || []; }
  get visibility() {
    const m = this.room && this.room.metadata;
    return m && typeof m === 'object' && m.visibility === 'private' ? 'private' : 'public';
  }

  _emit(name, ...args) { const fn = this.hooks[name]; if (fn) fn(...args); }

  connect() {
    if (this._socket) return;
    this._socket = this.platform.connectRoom(this.room.id, {
      onOpen: () => { this.connected = true; this._emit('onChange'); },
      onDown: () => { this.connected = false; this._emit('onChange'); },
      onRoster: (room) => this._onRoster(room),
      onPresence: (userId, online) => { this.presence.set(userId, online); this._emit('onChange'); },
      onReady: (from, ready) => { this.ready.applyFrame(from, ready); this._emit('onChange'); },
      onStopped: (reason) => {
        this.connected = false;
        if (reason !== 'closed') { this.unavailable = true; this._emit('onClosed', reason); }
        this._emit('onChange');
      },
    });
    void this.refresh();
  }

  async refresh() {
    try {
      const room = await this.platform.getRoom(this.room.id);
      if (room) this._onRoster(room);
      else { this.unavailable = true; this._emit('onChange'); }
    } catch { /* the socket's roster keeps it current */ }
  }

  _onRoster(room) {
    this.room = { ...this.room, ...room };
    this.ready.prune(this.participants);
    if (this.selectedAi && !this.participants.some((p) => p.id === this.selectedAi && p.isAi)) this.selectedAi = null;
    if (this.room.status === 'playing' && this.room.gameSessionId && !this._handedOff) {
      this._handedOff = true;
      this._emit('onPlaying', this.room);
    } else if (this.room.status === 'closed') {
      this.unavailable = true;
    }
    this._emit('onChange');
  }

  /** Whether this seat's player is ready (the local player by its own press). */
  isReady(participant) {
    if (!participant) return false;
    if (participant.userId && participant.userId === this.userId) return this.selfReady;
    return this.ready.isReady(participant.id);
  }

  isOnline(participant) {
    if (!participant || participant.isAi || !participant.userId) return true;
    return this.presence.get(participant.userId) !== false;
  }

  sendReady() {
    if (this.selfReady || !this._socket) return false;
    this.selfReady = this._socket.sendReady();
    this._emit('onChange');
    return this.selfReady;
  }

  get canStart() { return canStart(this.room, this.userId) && !this.unavailable && !this.starting; }
  /** Seat moves need a free seat to drop into. */
  get canArrange() {
    const st = this.room && this.room.status;
    return this.host && (st === 'lobby' || st === 'open') && this.participants.length < this.seatCount;
  }

  async start() {
    if (!this.canStart) return { ok: false };
    this.starting = true;
    this._emit('onChange');
    try {
      const room = await this.platform.startRoom(this.room.id);
      this.starting = false;
      if (room) this._onRoster(room);
      return { ok: true };
    } catch (e) {
      this.starting = false;
      this._emit('onChange');
      return { ok: false, error: e };
    }
  }

  async open() {
    try { const room = await this.platform.openRoom(this.room.id); if (room) this._onRoster(room); return { ok: true }; }
    catch (e) { return { ok: false, error: e }; }
  }

  /** Host: pick up an AI seat (again: put it back). */
  pickAi(participantId) {
    this.selectedAi = this.selectedAi === participantId ? null : participantId;
    this._emit('onChange');
  }

  /** Host: move the picked-up AI participant to an empty seat. */
  async placeAi(seat) {
    const participantId = this.selectedAi;
    this.selectedAi = null;
    if (!participantId) return { ok: false };
    try {
      const room = await this.platform.seat(this.room.id, [{ participantId, team: 0, slot: seat }]);
      if (room) this._onRoster(room);
      return { ok: true };
    } catch (e) {
      this._emit('onChange');
      return { ok: false, error: e };
    }
  }

  async invite(userId) {
    const res = await inviteFriend(this.platform, this.room.id, userId);
    if (res.seated) this.pendingInvites.add(userId);
    this._emit('onChange');
    return res;
  }

  async leave() {
    this.close();
    try { await this.platform.leaveRoom(this.room.id); } catch { /* already gone */ }
  }

  close() {
    if (this._socket) { try { this._socket.close(); } catch { /* gone */ } }
    this._socket = null;
  }
}

// ---------------------------------------------------------------------------
// The table: the bound session's game socket and the table model.

export class TableClient {
  /**
   * now(): ms on the platform's clock (server.js's deadlines are epoch ms).
   * hooks: onChange(), onError(message) for rejections, onOver(result).
   */
  constructor(platform, room, opts = {}) {
    this.platform = platform;
    this.room = room;
    this.sessionId = room.gameSessionId;
    this.now = opts.now || (() => 0);
    this.hooks = opts.hooks || {};
    this.model = new TableModel({ now: this.now });
    this.stateVersion = -1;
    this.connected = false;
    this.unavailable = false;
    this.queue = [];
    this.lastSentAt = 0;
    this._game = null;
    this._room = null;
  }

  _emit(name, ...args) { const fn = this.hooks[name]; if (fn) fn(...args); }

  connect() {
    if (this._game) return;
    this._game = this.platform.connectGame(this.sessionId, {
      onOpen: () => {
        this.connected = true;
        this.lastSentAt = 0;
        // Every (re)connection resyncs before anything else.
        this.queue.unshift({ cmd: { type: 'sync' }, versioned: false });
        this.update();
        this._emit('onChange');
      },
      onDown: () => { this.connected = false; this._emit('onChange'); },
      onMessage: (data) => this._onGame(data),
      onError: (message) => this._emit('onError', String(message || 'Unknown error')),
      onStopped: (reason) => {
        this.connected = false;
        if (reason !== 'closed') this.unavailable = true;
        this._emit('onChange');
      },
    });
    // The room's socket stays open for the roster and presence (the platform
    // closes a playing room whose host has no socket for a minute).
    if (this.room.id) {
      this._room = this.platform.connectRoom(this.room.id, {
        onRoster: (room) => { this.room = { ...this.room, ...room }; this._emit('onChange'); },
      });
    }
  }

  /** Queues a game command (fold, check, call, bet/raise with a new round total, all-in). */
  send(cmd) {
    this.queue.push({ cmd, versioned: true });
    this.update();
  }

  /** Called every frame: drains the queue at the session's pace. */
  update() {
    if (!this._game || !this.connected || !this.queue.length) return;
    if (this.lastSentAt && this.now() - this.lastSentAt < CMD_MIN_INTERVAL_MS) return;
    const { cmd, versioned } = this.queue[0];
    const data = versioned && this.stateVersion >= 0 ? { ...cmd, stateVersion: this.stateVersion } : cmd;
    if (!this._game.send(data)) return; // paced or down: try again next frame
    this.queue.shift();
    this.lastSentAt = this.now();
  }

  _onGame(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.stateVersion === 'number') {
      if (data.stateVersion < this.stateVersion) return;
      this.stateVersion = data.stateVersion;
    }
    this.model.receive(data);
    if (data.type === 'match-complete') this._emit('onOver', data.result || null);
    this._emit('onChange');
  }

  /** Both players' sides of the connection are gone: the last view stays on screen. */
  get stopped() { return this.unavailable && !(this.model.pub && this.model.pub.matchResult); }

  async leave() {
    this.close();
    if (this.room.id) { try { await this.platform.leaveRoom(this.room.id); } catch { /* gone */ } }
  }

  close() {
    for (const s of [this._game, this._room]) if (s) { try { s.close(); } catch { /* gone */ } }
    this._game = null;
    this._room = null;
  }
}
