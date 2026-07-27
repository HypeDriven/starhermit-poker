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
// Invite helpers (transport orchestration, no DOM — unit-tested against a
// fake controller)

// Invite a friend to `roomId`. One call: the platform notifies the invitee
// itself (a `game_invite` push the StarHermit dashboard shows as a toast, plus
// their /me/game-invites inbox), so there is nothing to send alongside it — a
// second invite through the games API would only notify them twice.
// `notified` mirrors the response field: false = the friend is not connected
// right now, null = the platform did not say. Never throws.
export async function inviteFriend(controller, roomId, toUserId) {
  try {
    const invite = await controller.sendInvite(roomId, toUserId);
    return {
      seated: true,
      notified: invite && invite.notified !== undefined ? invite.notified : null,
      error: null,
    };
  } catch (e) {
    // 409 = already invited or already seated: the seat stands and the first
    // invite did the notifying.
    if (e && e.status === 409) return { seated: true, notified: null, error: null };
    return { seated: false, notified: null, error: e };
  }
}

// ---------------------------------------------------------------------------
// Main menu

export class MenuScreen {
  // ctx: { root, net, gameInfo, onEnterLobby(room), onEnterTable(room) }
  constructor(ctx) {
    this.ctx = ctx;
    this.busy = false;
    this.inviteTimer = null;
    this.invites = [];
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
    const boardBtn = el('button', {
      type: 'button', text: 'Leaderboard',
      onclick: () => this.ctx.onShowLeaderboard && this.ctx.onShowLeaderboard(),
    });
    const replaysBtn = el('button', {
      type: 'button', text: 'Replays',
      onclick: () => this.ctx.onShowReplays && this.ctx.onShowReplays(),
    });

    this.inviteSection = el('div', { class: 'invite-inbox', hidden: '' });

    this.menu = el('div', { class: 'screen main-menu cinematic' },
      el('h1', { text: (gameInfo && gameInfo.name) || GAME.name }),
      el('p', {
        class: 'muted bold',
        text: me.userId
          ? `Elo ${me.elo} · ${me.wins}W / ${me.losses}L / ${me.draws}D`
          : 'No-limit Texas Hold\'em · play money only',
      }),
      el('div', { class: 'menu-actions' }, quickBtn, privateBtn, boardBtn, replaysBtn),
      this.inviteSection,
      el('p', { class: 'muted small bold skip-hint', text: 'Click anywhere to skip the intro' }),
      el('p', {
        class: 'muted small bold',
        text: 'Quick Play joins a public table; Private Table stays in the lobby ' +
          'until you start it. Empty seats are filled by AI — the host can tap ' +
          'an empty seat in the lobby to start right away.',
      }),
      this.errorLine,
    );
    // Cinematic 3D casino behind the menu. Loaded dynamically so the node
    // test-suite (and any WebGL-less browser) never has to resolve 'three'.
    this.destroyed = false;
    this.scene3d = null;
    const stage = el('div', { class: 'menu3d-stage' });
    root.append(stage);
    import('./menu3d.js').then(({ MenuScene3D }) => {
      if (this.destroyed) return;
      this.scene3d = new MenuScene3D(stage);
      if (this.scene3d.failed) this.scene3d = null;
    }).catch((err) => {
      // No WebGL or CDN — the CSS background carries the menu.
      console.warn('menu3d: 3D menu unavailable', err);
    });

    root.append(this.menu);

    // The skip hint only makes sense while the camera is still flying.
    const hint = this.menu.querySelector('.skip-hint');
    this.dropHint = () => { if (hint) hint.hidden = true; };
    addEventListener('pointerdown', this.dropHint, { once: true });
    this.hintTimer = setTimeout(this.dropHint, 20000);

    // Room-invite inbox: polled (launch tokens cannot use the chat push socket).
    this.pollInvites();
    this.inviteTimer = setInterval(() => this.pollInvites(), GAME.invitePollMs);
  }

  async pollInvites() {
    try {
      this.invites = await new RoomController(this.ctx.net).myInvites() || [];
    } catch { /* keep the previous list */ }
    this.renderInvites();
  }

  renderInvites() {
    if (!this.inviteSection) return;
    this.inviteSection.textContent = '';
    if (!this.invites.length) {
      this.inviteSection.hidden = true;
      return;
    }
    this.inviteSection.hidden = false;
    this.inviteSection.append(el('h2', { text: 'Table invites' }));
    for (const inv of this.invites) {
      const row = el('div', { class: 'invite-row' },
        el('span', { text: `${inv.fromUsername || 'A friend'} invites you to a table` }),
        el('button', {
          class: 'primary', type: 'button', text: 'Accept',
          onclick: () => this.answerInvite(inv, true),
        }),
        el('button', {
          type: 'button', text: 'Decline',
          onclick: () => this.answerInvite(inv, false),
        }),
      );
      this.inviteSection.append(row);
    }
  }

  async answerInvite(inv, accept) {
    const controller = new RoomController(this.ctx.net);
    try {
      if (accept) {
        const room = await controller.acceptInvite(inv.id);
        this.ctx.onEnterLobby(room);
        return;
      }
      await controller.declineInvite(inv.id);
      this.invites = this.invites.filter((i) => i.id !== inv.id);
      this.renderInvites();
    } catch (e) {
      // 409: room full/started/closed or we are in another room — drop the invite.
      this.errorLine.textContent = e.message || String(e);
      this.errorLine.hidden = false;
      this.pollInvites();
    }
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
    this.destroyed = true;
    removeEventListener('pointerdown', this.dropHint);
    clearTimeout(this.hintTimer);
    if (this.scene3d) {
      this.scene3d.destroy();
      this.scene3d = null;
    }
    if (this.inviteTimer) {
      clearInterval(this.inviteTimer);
      this.inviteTimer = null;
    }
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
    this.starting = false;
    this.presence = new Map(); // userId -> online
    this.pendingInvites = new Set(); // userIds with an outstanding room invite
    this.destroyed = false;

    this.controller = new RoomController(ctx.net, {
      onRoster: (r) => this.onRoster(r),
      onPresence: (p) => this.onPresence(p),
      onReady: () => this.render(),
      onResult: () => {},
      onSocketDown: () => this.render(),
    });
    this._profileListener = () => this.render();
    ctx.net.profiles.addListener(this._profileListener);
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
      this.buildInviteSection(),
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
    this.loadFriends();
  }

  // --- invites (friends-only while the room is Lobby/Open) ---

  buildInviteSection() {
    this.friendList = el('div', { class: 'friend-list' },
      el('p', { class: 'muted small', text: 'Loading friends…' }));
    this.inviteSection = el('div', { class: 'invite-section' },
      el('h2', { text: 'Invite players' }),
      el('button', {
        type: 'button', text: 'Copy share link',
        onclick: () => this.copyShareLink(),
      }),
      this.friendList,
    );
    return this.inviteSection;
  }

  async loadFriends() {
    try {
      // The only friends endpoint a game-scoped launch token may call.
      const friends = await this.ctx.net.client.get('/api/v1/me/friends') || [];
      this.renderFriends(friends);
    } catch {
      if (this.friendList) {
        this.friendList.textContent = '';
        this.friendList.append(el('p', {
          class: 'muted small', text: 'Could not load the friend list.',
        }));
      }
    }
  }

  renderFriends(friends) {
    if (!this.friendList) return;
    this.friendList.textContent = '';
    if (!friends.length) {
      this.friendList.append(el('p', {
        class: 'muted small',
        text: 'No friends yet — use the share link to invite someone.',
      }));
      return;
    }
    for (const f of friends) {
      const pending = this.pendingInvites.has(f.userId);
      const btn = el('button', {
        type: 'button', text: pending ? 'Invited ✓' : 'Invite',
        onclick: () => this.invite(f),
      });
      btn.disabled = pending;
      // Friends list carries no nickname; resolve through the profile cache.
      this.ctx.net.profiles.profile(f.userId);
      const name = this.ctx.net.profiles.displayName(f.userId, f.username);
      this.friendList.append(el('div', { class: 'friend-row' },
        el('span', { class: `dot${f.online ? ' on' : ''}` }),
        el('span', { class: 'friend-name', text: name }),
        f.currentGame ? el('span', { class: 'muted small', text: `playing ${f.currentGame}` }) : '',
        btn,
      ));
    }
  }

  async invite(friend) {
    const name = this.ctx.net.profiles.displayName(friend.userId, friend.username);
    const res = await inviteFriend(this.controller, this.room.id, friend.userId);
    if (res.error) {
      this.showError(res.error);
      return;
    }
    this.pendingInvites.add(friend.userId);
    this.shareNote(res.notified === false
      ? `${name} was invited, but is not connected right now — StarHermit will ` +
        'show them the invite when they are.'
      : `${name} was invited — StarHermit is notifying them now.`);
    this.loadFriends();
  }

  async copyShareLink() {
    const link = this.controller.shareInviteLink();
    try {
      await navigator.clipboard.writeText(link);
      this.shareNote('Share link copied — the dashboard handles sign-in and friending.');
    } catch {
      this.shareNote(link);
    }
  }

  shareNote(text) {
    if (!this.inviteSection) return;
    let note = this.inviteSection.querySelector('.share-note');
    if (!note) {
      note = el('p', { class: 'muted small share-note' });
      this.inviteSection.append(note);
    }
    note.textContent = text;
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
    if (this.starting) return; // seat taps bypass startBtn.disabled
    this.starting = true;
    this.startBtn.disabled = true;
    try {
      const room = await this.controller.startRoom(this.room.id);
      this.room = room;
      this.render();
      if (room.status === 'Playing' && room.gameSessionId) this.ctx.onEnterTable(room);
    } catch (e) {
      this.showError(e);
      this.starting = false;
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

    // Invites only make sense (and are only accepted by the platform) while
    // the room is in Lobby/Open.
    if (this.inviteSection) {
      this.inviteSection.hidden = room.status !== 'Lobby' && room.status !== 'Open';
    }

    // Host controls: start only when legal; open only from Lobby.
    this.startBtn.hidden = !host;
    this.startBtn.disabled = !canStart(room, net.userId);
    this.startBtn.title = 'Fill empty seats with AI and deal the first hand';
    this.openBtn.hidden = !host || room.status !== 'Lobby';
  }

  renderSeat(seat, participant, room) {
    if (!participant) {
      // Hosts add AI on demand: tapping an empty seat starts the table
      // immediately. The platform backfills EVERY empty seat at start —
      // there is no add-one-AI endpoint — so one tap deals the first hand.
      if (isHost(room, this.ctx.net.userId) &&
          (room.status === 'Lobby' || room.status === 'Open')) {
        return el('button', {
          class: 'seat empty add-ai', type: 'button',
          title: 'Fill empty seats with AI and deal the first hand',
          onclick: () => this.start(),
        },
          el('span', { class: 'seat-name', text: `Seat ${seat + 1}` }),
          el('span', { class: 'add-ai-cta', text: '+ Add AI' }),
          el('span', { class: 'muted small', text: 'starts the table now' }));
      }
      return el('div', {
        class: 'seat empty',
        title: 'The host can fill empty seats with AI anytime',
      },
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
    const displayName = participant.isAi || !participant.userId
      ? (participant.username || 'AI')
      : (this.ctx.net.profiles.profile(participant.userId),
        this.ctx.net.profiles.displayName(participant.userId, participant.username));
    return el('div', { class: `seat${isSelf ? ' self' : ''}${online ? '' : ' offline'}` },
      el('span', { class: 'seat-name', text: displayName }),
      el('span', { class: 'seat-badges' },
        participant.isHost ? el('span', { class: 'badge host', text: 'HOST' }) : '',
        participant.isAi ? el('span', { class: 'badge ai', text: 'AI' }) : '',
        ready ? el('span', { class: 'badge ready', text: 'READY' }) : '',
        online ? '' : el('span', { class: 'badge offline', text: 'OFFLINE' }),
      ));
  }

  destroy() {
    this.destroyed = true;
    this.ctx.net.profiles.removeListener(this._profileListener);
    this.controller.destroy();
  }
}
