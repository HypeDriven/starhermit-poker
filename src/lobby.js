// Lobby screens: main menu (quick play / private table) and the table lobby
// (seats, ready, host start). Built on StarHermit realtime rooms — there is no
// custom lobby backend.

import { GAME } from './config.js';
import { ApiError } from './net.js';
import { RoomController, seatMap, canStart, isHost } from './realtime-room.js';

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
// Room acquisition helpers (used by the menu)

// Quick Play: join the oldest open room with a free seat; when none exists
// (404), create a public room and open it for matchmaking.
export async function quickPlay(net) {
  const controller = new RoomController(net);
  try {
    return await controller.quickJoin();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) {
      return recoverConflict(e, net);
    }
    const room = await controller.createRoom('public');
    await controller.openRoom(room.id);
    return room;
  }
}

// Private Table: a lobby-state room the host fills with friend invites
// (checkpoint 5) and starts manually.
export async function createPrivateTable(net) {
  const controller = new RoomController(net);
  try {
    return await controller.createRoom('private');
  } catch (e) {
    return recoverConflict(e, net);
  }
}

// One active room per user: if creation/join hits 409, rejoin the room we are
// already in instead of failing.
async function recoverConflict(e, net) {
  if (e instanceof ApiError && e.status === 409) {
    const controller = new RoomController(net);
    const room = await controller.myRoom();
    if (room) return room;
  }
  throw e;
}

// ---------------------------------------------------------------------------
// Main menu

export class MenuScreen {
  // ctx: { root, net, gameInfo, onEnterLobby(room), onEnterTable(room) }
  constructor(ctx) {
    this.ctx = ctx;
    this.busy = false;
  }

  show() {
    const { root, gameInfo } = this.ctx;
    root.textContent = '';
    const me = (gameInfo && gameInfo.me) || {};

    this.errorLine = el('p', { class: 'error', hidden: '' });

    const quickBtn = el('button', {
      class: 'primary big', type: 'button', text: 'Quick Play',
      onclick: () => this.go('quick'),
    });
    const privateBtn = el('button', {
      class: 'big', type: 'button', text: 'Private Table',
      onclick: () => this.go('private'),
    });

    this.menu = el('div', { class: 'screen main-menu' },
      el('h1', { text: (gameInfo && gameInfo.name) || GAME.name }),
      el('p', {
        class: 'muted',
        text: me.userId
          ? `Elo ${me.elo} · ${me.wins}W / ${me.losses}L / ${me.draws}D`
          : 'No-limit Texas Hold\'em · play money only',
      }),
      el('div', { class: 'menu-actions' }, quickBtn, privateBtn),
      el('p', {
        class: 'muted small',
        text: 'Quick Play joins a public table (empty seats are filled by AI). ' +
          'Private Table stays in the lobby until you start it.',
      }),
      this.errorLine,
    );
    root.append(this.menu);
  }

  async go(mode) {
    if (this.busy) return;
    this.busy = true;
    this.errorLine.hidden = true;
    try {
      const room = mode === 'quick'
        ? await quickPlay(this.ctx.net)
        : await createPrivateTable(this.ctx.net);
      if (room.status === 'Playing') this.ctx.onEnterTable(room);
      else this.ctx.onEnterLobby(room);
    } catch (e) {
      this.errorLine.textContent = `Could not get a table: ${e.message || e}`;
      this.errorLine.hidden = false;
    } finally {
      this.busy = false;
    }
  }

  destroy() {
    this.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Table lobby

export class LobbyScreen {
  // ctx: { root, net, onEnterTable(room), onExitToMenu() }
  constructor(ctx, room) {
    this.ctx = ctx;
    this.room = room;
    this.selfReady = false;
    this.presence = new Map(); // userId -> online
    this.destroyed = false;

    this.controller = new RoomController(ctx.net, {
      onRoster: (r) => this.onRoster(r),
      onPresence: (p) => this.onPresence(p),
      onReady: () => this.render(),
      onResult: () => {},
      onSocketDown: () => this.render(),
    });
  }

  async show() {
    const { root } = this.ctx;
    root.textContent = '';

    const visibility = (this.room.config && this.room.config.metadata
      && this.room.config.metadata.visibility) || 'public';

    this.statusLine = el('p', { class: 'muted' });
    this.seatGrid = el('div', { class: 'seat-grid' });
    this.errorLine = el('p', { class: 'error', hidden: '' });

    this.readyBtn = el('button', {
      type: 'button', text: 'Ready',
      onclick: () => this.toggleReady(),
    });
    this.startBtn = el('button', {
      class: 'primary', type: 'button', text: 'Start table',
      onclick: () => this.start(),
    });
    this.openBtn = el('button', {
      type: 'button', text: 'Open to matchmaking',
      onclick: () => this.open(),
    });
    const leaveBtn = el('button', {
      type: 'button', text: 'Leave table',
      onclick: () => this.leave(),
    });

    this.screen = el('div', { class: 'screen lobby' },
      el('h1', { text: visibility === 'private' ? 'Private table' : 'Public table' }),
      this.statusLine,
      this.seatGrid,
      el('div', { class: 'lobby-actions' },
        this.readyBtn, this.startBtn, this.openBtn, leaveBtn),
      this.errorLine,
    );
    root.append(this.screen);

    // Fresh state, then live updates.
    this.render();
    try {
      this.room = await this.controller.getRoom(this.room.id);
      this.render();
    } catch (e) {
      this.showError(e);
    }
    this.controller.connect(this.room.id);
  }

  // --- controller events ---

  onRoster(room) {
    this.room = room;
    this.render();
    if (room.status === 'Playing' && room.gameSessionId && !this.destroyed) {
      this.ctx.onEnterTable(room);
    }
  }

  onPresence(p) {
    this.presence.set(p.userId, p.online);
    this.render();
  }

  // --- actions ---

  toggleReady() {
    this.selfReady = !this.selfReady;
    this.controller.sendReady(this.selfReady);
    this.render();
  }

  async start() {
    this.startBtn.disabled = true;
    try {
      const room = await this.controller.startRoom(this.room.id);
      this.room = room;
      this.render();
      if (room.status === 'Playing' && room.gameSessionId) this.ctx.onEnterTable(room);
    } catch (e) {
      this.showError(e);
      this.startBtn.disabled = false;
    }
  }

  async open() {
    try {
      this.room = await this.controller.openRoom(this.room.id);
      this.render();
    } catch (e) {
      this.showError(e);
    }
  }

  async leave() {
    try {
      await this.controller.leaveRoom(this.room.id);
    } catch { /* room may already be gone; exit regardless */ }
    if (!this.destroyed) this.ctx.onExitToMenu();
  }

  showError(e) {
    this.errorLine.textContent = e.message || String(e);
    this.errorLine.hidden = false;
  }

  // --- rendering ---

  render() {
    if (this.destroyed || !this.seatGrid) return;
    const { net } = this.ctx;
    const room = this.room;
    const participants = (room.participants || []).filter((p) => !p.leftAt);
    const seats = seatMap(participants);
    const host = isHost(room, net.userId);

    this.statusLine.textContent =
      `Status: ${room.status} · ${participants.length}/${GAME.maxSeats} seats` +
      (room.status === 'Open'
        ? ` · open for matchmaking (AI backfill ~${room.config?.backfillAfterSeconds ?? GAME.roomBackfillAfterSeconds}s after opening)`
        : '') +
      (this.controller.connected ? '' : ' · reconnecting…');

    this.seatGrid.textContent = '';
    for (const { seat, participant } of seats) {
      this.seatGrid.append(this.renderSeat(seat, participant, room));
    }

    // Ready toggle label.
    this.readyBtn.textContent = this.selfReady ? 'Unready' : 'Ready';

    // Host controls: start only when legal; open only from Lobby.
    this.startBtn.hidden = !host;
    this.startBtn.disabled = !canStart(room, net.userId);
    this.startBtn.title = canStart(room, net.userId)
      ? 'Fill empty seats with AI and deal the first hand'
      : `Needs at least ${GAME.minPlayers} seated players`;
    this.openBtn.hidden = !host || room.status !== 'Lobby';
  }

  renderSeat(seat, participant, room) {
    if (!participant) {
      return el('div', { class: 'seat empty' },
        el('span', { class: 'seat-name', text: `Seat ${seat + 1}` }),
        el('span', { class: 'muted small', text: 'Empty — AI at start' }));
    }
    const isSelf = participant.userId === this.ctx.net.userId;
    const online = participant.isAi
      ? true
      : this.presence.get(participant.userId) !== false; // assume online until told otherwise
    const ready = isSelf
      ? this.selfReady
      : this.controller.readyTracker.isReady(participant.id);
    return el('div', { class: `seat${isSelf ? ' self' : ''}${online ? '' : ' offline'}` },
      el('span', { class: 'seat-name', text: participant.username || 'Player' }),
      el('span', { class: 'seat-badges' },
        participant.isHost ? el('span', { class: 'badge host', text: 'HOST' }) : '',
        participant.isAi ? el('span', { class: 'badge ai', text: 'AI' }) : '',
        ready ? el('span', { class: 'badge ready', text: 'READY' }) : '',
        online ? '' : el('span', { class: 'badge offline', text: 'OFFLINE' }),
      ));
  }

  destroy() {
    this.destroyed = true;
    this.controller.destroy();
  }
}
