// Realtime-room controller: StarHermit lobby transport.
// Contract: https://wiki.starhermit.com/docs/api/realtime.html
//
// Rooms model the poker table lobby: creation, roster, presence, ready
// signals, start (AI backfill), and the bound gameSessionId handoff. Gameplay
// itself moves to ws/v1/games once the room is Playing (checkpoint 7).

import { GAME, buildRoomMetadata } from './config.js';
import { ReconnectingSocket, wsUrl } from './net.js';

const ROOMS = '/api/v1/realtime/rooms';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)

// Map roster participants onto the table's fixed seats (teamCount is always 1,
// so seat index === slot). Returns an array of GAME.maxSeats entries:
// { seat, participant | null }.
export function seatMap(participants) {
  const seats = Array.from({ length: GAME.maxSeats }, (_, i) => ({ seat: i, participant: null }));
  for (const p of participants || []) {
    if (p && p.team === 0 && Number.isInteger(p.slot) && p.slot >= 0 && p.slot < GAME.maxSeats) {
      seats[p.slot] = { seat: p.slot, participant: p };
    }
  }
  return seats;
}

// The host may start once at least GAME.minPlayers seats are occupied
// (remaining seats are backfilled with AI at start).
export function canStart(room, userId) {
  if (!room || room.status === 'Playing' || room.status === 'Closed') return false;
  if (room.hostUserId !== userId) return false;
  const occupied = (room.participants || []).filter((p) => p && !p.leftAt).length;
  return occupied >= GAME.minPlayers;
}

export function isHost(room, userId) {
  return !!room && room.hostUserId === userId;
}

// Track ready signals from realtime control frames. Ready state is transient
// (control frames only — the API exposes no ready field), keyed by the
// participant id the platform stamps on each frame.
export class ReadyTracker {
  constructor() {
    this.byParticipant = new Map();
  }
  applyFrame(fromParticipantId, ready) {
    if (fromParticipantId) this.byParticipant.set(fromParticipantId, !!ready);
  }
  isReady(participantId) {
    return this.byParticipant.get(participantId) === true;
  }
  // Drop entries for participants no longer in the roster.
  prune(participants) {
    const ids = new Set((participants || []).map((p) => p.id));
    for (const id of [...this.byParticipant.keys()]) {
      if (!ids.has(id)) this.byParticipant.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Controller

export class RoomController {
  // net: the shared net context (client, scope, tokenManager).
  // Handlers: onRoster(room), onPresence({userId, online}), onReady(participantId, ready),
  // onResult(result), onSocketDown().
  constructor(net, handlers = {}) {
    this.net = net;
    this.handlers = handlers;
    this.room = null;
    this.socket = null;
    this.readyTracker = new ReadyTracker();
  }

  // --- REST ---

  async createRoom(visibility) {
    const body = {
      gameSlug: this.net.scope, // ignored for scoped launch tokens (game_scope wins)
      teamCount: GAME.teamCount,
      seatsPerTeam: GAME.maxSeats,
      backfillAfterSeconds: GAME.roomBackfillAfterSeconds,
      metadata: buildRoomMetadata(visibility),
    };
    const room = await this.net.client.post(ROOMS, body);
    this.room = room;
    return room;
  }

  async getRoom(roomId) {
    const room = await this.net.client.get(`${ROOMS}/${roomId}`);
    this.room = room;
    return room;
  }

  // The caller's current non-Closed room, or null (404).
  async myRoom() {
    try {
      const room = await this.net.client.get(`${ROOMS}/mine`);
      this.room = room;
      return room;
    } catch (e) {
      if (e && e.status === 404) return null;
      throw e;
    }
  }

  openRoom(roomId) {
    return this.net.client.post(`${ROOMS}/${roomId}/open`);
  }

  startRoom(roomId) {
    return this.net.client.post(`${ROOMS}/${roomId}/start`);
  }

  async leaveRoom(roomId) {
    try {
      return await this.net.client.post(`${ROOMS}/${roomId}/leave`);
    } finally {
      this.disconnect();
      this.room = null;
    }
  }

  quickJoin() {
    return this.net.client.post(`${ROOMS}/quick-join`, { gameSlug: this.net.scope, seats: 1 });
  }

  // --- Invites (friends-only, Lobby/Open rooms only) ---

  // The platform notifies the invitee itself: a `game_invite` push their
  // StarHermit dashboard shows as a toast, plus GET /me/game-invites. The
  // response's `notified` says whether that reached a live connection, so
  // nothing else needs sending to make an invite visible.
  sendInvite(roomId, toUserId) {
    return this.net.client.post(`${ROOMS}/${roomId}/invites`, { toUserId });
  }

  // The caller's pending room invites (launch tokens see only their own game's).
  myInvites() {
    return this.net.client.get(`${ROOMS}/invites`);
  }

  // Accept seats the caller and returns the room.
  acceptInvite(inviteId) {
    return this.net.client.post(`${ROOMS}/invites/${inviteId}/accept`);
  }

  declineInvite(inviteId) {
    return this.net.client.post(`${ROOMS}/invites/${inviteId}/decline`);
  }

  // Documented share-link flow for non-friends: the web dashboard handles
  // sign-in, friending, launch, and sends the play invite back to the sharer.
  shareInviteLink() {
    return `https://dashboard.starhermit.com/game-invite/${this.net.userId}/${this.net.scope}`;
  }

  // --- Realtime WebSocket (roster/presence only; gameplay uses ws/v1/games) ---

  connect(roomId) {
    this.disconnect();
    this.socket = new ReconnectingSocket({
      urlFactory: () => wsUrl('/ws/v1/realtime', {
        roomId,
        access_token: this.net.tokenManager.token,
      }),
      onMessage: (data, isBinary) => this._onFrame(data, isBinary),
      onDown: () => this.handlers.onSocketDown && this.handlers.onSocketDown(),
    });
    this.socket.connect();
  }

  _onFrame(data, isBinary) {
    if (isBinary || typeof data !== 'string') return; // binary = host-routed; unused by poker
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    switch (frame.type) {
      case 'roster': {
        // Roster pushes carry the full room view, gameSessionId included once
        // the bound scripted session exists.
        const room = { ...(this.room || {}), ...frame, id: frame.roomId };
        delete room.roomId;
        this.room = room;
        this.readyTracker.prune(frame.participants);
        this.handlers.onRoster && this.handlers.onRoster(room);
        break;
      }
      case 'presence':
        this.handlers.onPresence && this.handlers.onPresence({
          userId: frame.userId,
          online: !!frame.online,
        });
        break;
      case 'ready':
        this.readyTracker.applyFrame(frame.from, frame.ready);
        this.handlers.onReady && this.handlers.onReady(frame.from, !!frame.ready);
        break;
      case 'result':
        this.handlers.onResult && this.handlers.onResult(frame);
        break;
      default:
        break; // 'event'/'chat' from the host-routed world: unused by poker
    }
  }

  sendReady(ready) {
    return this.socket ? this.socket.sendJson({ type: 'ready', ready: !!ready }) : false;
  }

  get connected() {
    return !!(this.socket && this.socket.connected);
  }

  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  destroy() {
    this.disconnect();
    this.room = null;
  }
}
