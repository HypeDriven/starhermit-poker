// Online tables (src/online.js) against a fake platform whose room-bound
// session runs server.js as the platform does: Quick Play creates and opens a
// table when none is open, a conflict rejoins the player's room, the lobby
// hands over to the table when the room plays, the host moves AI seats and
// invites friends, and the table resyncs on every connection, paces its
// commands to the session's tick, drops stale states, and only ever receives
// its own hole cards. No client call can post a result: the fake has none, and
// the match result comes back from server.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './harness.js';
import {
  LobbyClient, TableClient, quickPlay, createPrivateTable, inviteFriend, seatMap, canStart, newRoom, CMD_MIN_INTERVAL_MS,
} from '../src/online.js';

const ME = 'u-me';

class FakePlatform {
  constructor() {
    this.userId = ME;
    this.rooms = new Map();
    this.calls = [];
    this.n = 0;
    this.roomSockets = [];
    this.gameSockets = [];
    this.session = null;
    this.game = loadScript('server.js').game;
    this.now = 1_800_000_000_000;
  }
  _room(r) { return JSON.parse(JSON.stringify(r)); }
  async createRoom(cfg) {
    this.calls.push(['create', cfg]);
    const id = `room-${++this.n}`;
    const participants = [{ id: `p-${ME}`, userId: ME, username: 'me', displayName: 'Me', isAi: false, isHost: true, team: 0, slot: 0 }];
    for (let i = 0; i < cfg.aiPlayers; i++) participants.push({ id: `p-ai${i}`, userId: null, username: `Bot${i}`, displayName: `Bot${i}`, isAi: true, isHost: false, team: 0, slot: i + 1 });
    const room = { id, status: 'lobby', hostUserId: ME, seatsPerTeam: cfg.seatsPerTeam, teamCount: 1, participants, metadata: cfg.metadata, gameSessionId: null, revision: 1 };
    this.rooms.set(id, room);
    return this._room(room);
  }
  async openRoom(id) { this.calls.push(['open', id]); const r = this.rooms.get(id); r.status = 'open'; return this._room(r); }
  async quickJoin() { this.calls.push(['quickJoin']); return null; }
  async myRoom() { return [...this.rooms.values()].find((r) => r.status !== 'closed') || null; }
  async getRoom(id) { return this.rooms.has(id) ? this._room(this.rooms.get(id)) : null; }
  async seat(id, seats) {
    const r = this.rooms.get(id);
    for (const s of seats) r.participants.find((p) => p.id === s.participantId).slot = s.slot;
    return this._room(r);
  }
  async invite(id, user) { this.calls.push(['invite', id, user]); if (user === 'dupe') { const e = new Error('conflict'); e.kind = 'conflict'; throw e; } }
  async leaveRoom(id) { this.calls.push(['leave', id]); }
  async startRoom(id) {
    const r = this.rooms.get(id);
    // Empty seats become AI at start; the platform binds a session of server.js.
    const roster = r.participants.map((p) => ({ userId: p.userId, name: p.displayName, team: 0, slot: p.slot, ai: p.isAi }));
    for (let s = 0; s < r.seatsPerTeam; s++) if (!roster.some((x) => x.slot === s)) roster.push({ userId: null, name: `Backfill${s}`, team: 0, slot: s, ai: true });
    roster.sort((a, b) => a.slot - b.slot);
    r.status = 'playing';
    r.gameSessionId = 'sess-1';
    this.ctxRoom = { roomId: id, metadata: r.metadata, roster };
    const res = this.game.createSession(this._ctx({}));
    this.session = { state: res.sessionState, players: res.playerStates };
    this.pending = res.broadcast || [];
    for (const s of this.roomSockets) s.h.onRoster && s.h.onRoster(this._room(r));
    return this._room(r);
  }
  _ctx(extra) {
    return { now: this.now, random: 0.37, sessionId: 'sess-1', players: [{ id: ME, name: 'me' }], room: this.ctxRoom,
      presence: { [ME]: { online: true, left: false } }, sessionState: this.session ? this.session.state : null,
      playerStates: this.session ? this.session.players : {}, ...extra };
  }
  _deliver(broadcast, h) {
    for (const e of broadcast || []) if (e.to === 'all' || (Array.isArray(e.to) && e.to.includes(ME))) h.onMessage(JSON.parse(JSON.stringify(e.data)));
  }
  connectRoom(id, h) {
    const s = { id, h, ready: 0 };
    this.roomSockets.push(s);
    return { sendReady: (ready = true) => { s.ready += ready ? 1 : -1; return true; }, close: () => { s.closed = true; } };
  }
  connectGame(sessionId, h) {
    const sock = { sessionId, h, sent: [] };
    this.gameSockets.push(sock);
    sock.open = () => h.onOpen();
    return {
      send: (data) => {
        sock.sent.push(data);
        const res = this.game.onPlayerMessage(this._ctx({ message: { from: ME, data } }));
        if (res.sessionState) this.session.state = res.sessionState;
        if (res.playerStates) this.session.players = res.playerStates;
        if (res.ok === false) h.onError(res.error);
        this._deliver(res.broadcast, h);
        if (res.result) this.result = res.result;
        return true;
      },
      close: () => { sock.closed = true; },
    };
  }
}

test('room helpers: the seat map, who may start, the table shape for N AI opponents', () => {
  const seats = seatMap([{ team: 0, slot: 2, id: 'a' }, { team: 0, slot: 9, id: 'x' }], 3);
  assert.deepEqual(seats.map((s) => s.participant && s.participant.id), [null, null, 'a']);
  assert.equal(canStart({ status: 'lobby', hostUserId: ME }, ME), true);
  assert.equal(canStart({ status: 'playing', hostUserId: ME }, ME), false);
  assert.equal(canStart({ status: 'lobby', hostUserId: 'other' }, ME), false);
  assert.equal(newRoom('private', 0).seatsPerTeam, 6);
  assert.equal(newRoom('private', 2).seatsPerTeam, 3);
  assert.equal(newRoom('public', 2).metadata.visibility, 'public');
});

test('Quick Play creates and opens a public table when none is open; a conflict rejoins the held room', async () => {
  const p = new FakePlatform();
  const room = await quickPlay(p, 2);
  assert.equal(room.status, 'open');
  assert.deepEqual(p.calls.map((c) => c[0]), ['quickJoin', 'create', 'open']);
  assert.equal(p.calls[1][1].aiPlayers, 2);
  p.createRoom = async () => { const e = new Error('busy'); e.kind = 'active-room-elsewhere'; throw e; };
  const again = await createPrivateTable(p, 0);
  assert.equal(again.id, room.id);
});

test('invites: one room invite; a duplicate keeps the seat', async () => {
  const p = new FakePlatform();
  assert.deepEqual(await inviteFriend(p, 'r', 'f1'), { seated: true, error: null });
  assert.deepEqual(await inviteFriend(p, 'r', 'dupe'), { seated: true, error: null });
  assert.equal(p.calls.filter((c) => c[0] === 'invite').length, 2);
});

test('the lobby: ready, AI seat moves, start hands over to the server-refereed table', async () => {
  const p = new FakePlatform();
  const room = await createPrivateTable(p, 1);
  let playing = null;
  const lobby = new LobbyClient(p, room, { onPlaying: (r) => { playing = r; } });
  lobby.connect();
  assert.equal(lobby.visibility, 'private');
  assert.equal(lobby.host, true);
  assert.equal(lobby.sendReady(), true);
  assert.equal(lobby.isReady(lobby.participants[0]), true);
  assert.equal(lobby.sendReady(false), true); // Unready
  assert.equal(lobby.isReady(lobby.participants[0]), false);
  assert.equal(lobby.sendReady(true), true);
  // The AI seat moves to an empty seat (the table of 1 + 1 has none: a 6-seat table does).
  const big = await createPrivateTable(p, 0);
  const lobby2 = new LobbyClient(p, { ...big, participants: [...big.participants, { id: 'p-bot', userId: null, isAi: true, team: 0, slot: 1 }] }, {});
  p.rooms.get(big.id).participants.push({ id: 'p-bot', userId: null, isAi: true, team: 0, slot: 1, displayName: 'Bot' });
  assert.equal(lobby2.canArrange, true);
  lobby2.pickAi('p-bot');
  await lobby2.placeAi(4);
  assert.equal(lobby2.participants.find((x) => x.id === 'p-bot').slot, 4);
  // Start: the room plays with a bound session.
  const r = await lobby.start();
  assert.equal(r.ok, true);
  assert.ok(playing && playing.gameSessionId === 'sess-1');
});

test('the table: sync on open, paced commands, its own cards only, the result from server.js', async () => {
  const p = new FakePlatform();
  const room = await createPrivateTable(p, 2);
  const lobby = new LobbyClient(p, room, {});
  lobby.connect();
  await lobby.start();
  let clock = 0;
  let over = null;
  const errors = [];
  const t = new TableClient(p, await p.getRoom(room.id), { now: () => clock, hooks: { onOver: (r) => { over = r; }, onError: (m) => errors.push(m) } });
  t.connect();
  p.gameSockets[0].open();
  assert.deepEqual(p.gameSockets[0].sent[0], { type: 'sync' });
  assert.ok(t.model.pub, 'the projection arrived');
  // Two commands in one frame: the second waits for the session's pace.
  let guard = 0;
  while (!t.model.pub.matchResult && guard++ < 4000) {
    const la = t.model.legal;
    if (la) {
      t.send({ type: 'all-in' });
      t.send({ type: 'check' });
      const before = p.gameSockets[0].sent.length;
      t.update();
      assert.equal(p.gameSockets[0].sent.length, before, 'no second command inside the interval');
      clock += CMD_MIN_INTERVAL_MS;
      t.update();
      clock += CMD_MIN_INTERVAL_MS;
      t.update();
      t.queue.length = 0;
    } else {
      // The platform's 1 Hz sweep.
      p.now += 1000;
      const res = p.game.onTick(p._ctx({}));
      if (res.sessionState) p.session.state = res.sessionState;
      if (res.playerStates) p.session.players = res.playerStates;
      p._deliver(res.broadcast, p.gameSockets[0].h);
      if (res.result) p.result = res.result;
    }
    for (const s of t.model.pub.seats) assert.equal(s.holeCards, undefined);
    clock += CMD_MIN_INTERVAL_MS;
  }
  assert.ok(t.model.pub.matchResult, 'the match ended');
  assert.ok(over, 'match-complete reached the client');
  assert.ok(p.result, 'server.js returned the result (the client posted none)');
  // A stale projection is dropped.
  const v = t.stateVersion;
  t._onGame({ type: 'state', stateVersion: v - 5, publicState: { ...t.model.pub, handNumber: -1 }, you: null });
  assert.notEqual(t.model.pub.handNumber, -1);
  void errors;
});
