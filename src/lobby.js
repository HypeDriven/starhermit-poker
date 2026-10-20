// Lobby screens: main menu (quick play / private table) and the table lobby
// (seats, ready, host start). Built on StarHermit realtime rooms — there is no
// custom lobby backend.

import { currentPlatformStrings } from './platform-i18n.js';
import { GAME } from './config.js';
import { ApiError } from './net.js';
import { RoomController, seatMap, seatCountOf, canStart, isHost } from './realtime-room.js';
import { settingsButton, closeSettings } from './graphics-panel.js';
import { el, t as tr } from './i18n.js';

const HAND_RANKINGS = ['Royal flush — A K Q J 10, one suit', 'Straight flush — five in sequence, one suit',
  'Four of a kind', 'Full house — three of a kind plus a pair', 'Flush — five of one suit',
  'Straight — five in sequence', 'Three of a kind', 'Two pair', 'One pair', 'High card'];

// "How to play" card (hidden until toggled).
function helpPanel() {
  return el('div', { class: 'help-panel', hidden: '' },
    el('h2', { i18n: "Texas Hold'em in a minute" }),
    el('p', { i18n: 'Everyone gets two private cards. Five shared cards arrive in three deals (flop, turn, river). Make the best five-card hand from any of the seven; the best hand — or the last player who has not folded — wins the pot.' }),
    el('p', { i18n: 'Each betting round you can Fold (give up the hand), Check/Call (match the current bet), Bet/Raise (put in more) or go All-in.' }),
    el('h3', { i18n: 'Hand rankings, best to worst' }),
    el('ol', {}, ...HAND_RANKINGS.map((k) => el('li', { i18n: k }))));
}

// ---------------------------------------------------------------------------
// Room acquisition helpers (used by the menu)

// Quick Play: join the oldest open room with a free seat; when none exists
// (404), create a public room with `aiPlayers` AI opponents seated and open
// it for matchmaking. The open response is returned because an open room
// starts immediately once every seat is taken — AI seats included.
export async function quickPlay(net, aiPlayers = 0) {
  const controller = new RoomController(net);
  try {
    return await controller.quickJoin();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) {
      return recoverConflict(e, net);
    }
    const room = await controller.createRoom('public', aiPlayers);
    return controller.openRoom(room.id);
  }
}

// Private Table: a lobby-state room the host fills with friend invites
// (checkpoint 5) and starts manually. `aiPlayers` AI opponents are seated at
// creation and can be rearranged in the lobby.
export async function createPrivateTable(net, aiPlayers = 0) {
  const controller = new RoomController(net);
  try {
    return await controller.createRoom('private', aiPlayers);
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
    this.aiCount = 0;
  }

  show() {
    const { root } = this.ctx;
    root.textContent = '';
    this.destroyed = false;
    this.hintDropped = false;
    // Cinematic 3D casino behind the menu. Loaded dynamically so the node
    // test-suite (and any WebGL-less browser) never has to resolve 'three'.
    this.scene3d = null;
    const stage = el('div', { class: 'menu3d-stage' });
    root.append(stage);
    import('./menu3d.js').then(({ MenuScene3D }) => {
      if (this.destroyed) return;
      this.scene3d = new MenuScene3D(stage);
      if (this.scene3d.failed) this.scene3d = null;
    }).catch(() => {
      // No WebGL or CDN — the CSS background carries the menu.
    });

    this.menu = this.buildMenu();
    root.append(this.menu);

    // The skip hint only makes sense while the camera is still flying. It
    // fades out without collapsing: removing it would shift the centred menu
    // between pointerdown and pointerup, and that first click would miss.
    this.dropHint = () => {
      this.hintDropped = true;
      const hint = this.menu && this.menu.querySelector('.skip-hint');
      if (hint) hint.style.visibility = 'hidden';
    };
    addEventListener('pointerdown', this.dropHint, { once: true });
    this.hintTimer = setTimeout(this.dropHint, 20000);

    // Room-invite inbox: polled (launch tokens cannot use the chat push socket).
    this.pollInvites();
    this.inviteTimer = setInterval(() => this.pollInvites(), GAME.invitePollMs);
  }

  // Language change: rebuild the menu card in place (3D scene, invites and
  // the open help panel stay).
  relocalize() {
    if (this.destroyed || !this.menu) return;
    const helpOpen = this.helpPanel && !this.helpPanel.hidden;
    const old = this.menu;
    this.menu = this.buildMenu();
    old.replaceWith(this.menu);
    if (helpOpen) this.toggleHelp();
    if (this.hintDropped) { const h = this.menu.querySelector('.skip-hint'); if (h) h.style.visibility = 'hidden'; }
    this.renderInvites();
  }

  buildMenu() {
    const { gameInfo } = this.ctx;
    const me = (gameInfo && gameInfo.me) || {};

    this.errorLine = el('p', { class: 'error', hidden: '' });

    const quickBtn = el('button', {
      class: 'primary big', type: 'button', i18n: 'Quick Play',
      onclick: () => this.go('quick'),
    });
    const privateBtn = el('button', {
      class: 'big', type: 'button', i18n: 'Private Table',
      onclick: () => this.go('private'),
    });
    const boardBtn = el('button', {
      type: 'button', i18n: 'Leaderboard',
      onclick: () => this.ctx.onShowLeaderboard && this.ctx.onShowLeaderboard(),
    });
    const replaysBtn = el('button', {
      type: 'button', i18n: 'Replays',
      onclick: () => this.ctx.onShowReplays && this.ctx.onShowReplays(),
    });
    const helpBtn = el('button', {
      type: 'button', i18n: 'How to play', onclick: () => this.toggleHelp(),
      'aria-expanded': 'false',
    });
    this.helpPanel = helpPanel();

    this.inviteSection = el('div', { class: 'invite-inbox', hidden: '' });

    // StarHermit account: profile nickname (+ avatar) and the invite link.
    const net = this.ctx.net;
    const t = currentPlatformStrings();
    const chip = this.playerChip;
    this.notice = el('p', { class: 'muted small bold', role: 'status', hidden: '' });
    this.playerChip = el('p', { class: 'player-chip bold' });
    if (chip && chip.childNodes.length) this.playerChip.append(...chip.childNodes); // keep name + avatar
    else if (net && net.userId && net.profiles) {
      const nameEl = el('span', { text: net.profiles.displayName(net.userId) });
      this.playerChip.append(nameEl);
      net.profiles.profile(net.userId).then(() => {
        nameEl.textContent = net.profiles.displayName(net.userId);
      });
      net.profiles.avatarUrl(net.userId).then((url) => {
        if (!url || this.destroyed) return;
        this.playerChip.prepend(el('img', {
          class: 'player-avatar', src: url, alt: '', width: '28', height: '28',
          style: 'border-radius:50%;vertical-align:middle;margin-right:0.4em',
        }));
      });
    } else this.playerChip.hidden = true;
    const inviteLink = net && net.sdk ? net.sdk.inviteLink() : null;
    const inviteBtn = inviteLink ? el('button', {
      type: 'button', text: t.invite, 'data-action': 'invite-friend',
      onclick: async () => {
        this.notice.hidden = false;
        try {
          await navigator.clipboard.writeText(inviteLink);
          this.notice.textContent = t.inviteCopied;
        } catch {
          this.notice.textContent = t.inviteFailed.replace('{link}', inviteLink);
        }
      },
    }) : null;

    // AI opponents are seated the moment a room is created (platform
    // `aiPlayers`); they only apply when we create the table — quick-joining
    // someone else's room takes its roster as-is.
    this.aiCountLabel = el('span', { class: 'ai-count', text: String(this.aiCount) });
    const stepAi = (d) => {
      this.aiCount = Math.min(GAME.maxSeats - 1, Math.max(0, this.aiCount + d));
      this.aiCountLabel.textContent = String(this.aiCount);
    };
    const aiStepper = el('div', { class: 'ai-stepper' },
      el('span', { class: 'muted small bold', i18n: 'AI opponents' }),
      el('button', {
        type: 'button', text: '−', i18nAria: 'Fewer AI opponents',
        onclick: () => stepAi(-1),
      }),
      this.aiCountLabel,
      el('button', {
        type: 'button', text: '+', i18nAria: 'More AI opponents',
        onclick: () => stepAi(1),
      }));

    const menu = el('div', { class: 'screen main-menu cinematic' },
      el('h1', { text: (gameInfo && gameInfo.name) || GAME.name }),
      this.playerChip,
      el('p', {
        class: 'muted bold',
        text: me.userId
          ? tr('Elo {elo} · {w}W / {l}L / {d}D', { elo: me.elo, w: me.wins, l: me.losses, d: me.draws })
          : tr('No-limit Texas Hold\'em · play money only'),
      }),
      el('div', { class: 'menu-actions' }, quickBtn, privateBtn, boardBtn, replaysBtn, helpBtn, ...(inviteBtn ? [inviteBtn] : []), settingsButton()),
      this.notice,
      this.helpPanel,
      aiStepper,
      this.inviteSection,
      el('p', { class: 'muted small bold skip-hint', i18n: 'Click anywhere to skip the intro' }),
      el('p', {
        class: 'muted small bold',
        i18n: 'Choosing N AI opponents deals you in against exactly N of them. With 0 the table seats 6: invites and matchmaking fill it, and seats still empty at start become AI. In the lobby the host can tap an AI seat, then an empty seat, to move it.',
      }),
      this.errorLine,
    );
    this._helpBtn = helpBtn;
    return menu;
  }

  async pollInvites() {
    try {
      this.invites = await new RoomController(this.ctx.net).myInvites() || [];
    } catch { /* keep the previous list */ }
    this.renderInvites();
  }

  renderInvites() {
    if (!this.inviteSection) return;
    // The inbox is polled every few seconds: rebuild it only when the invites
    // changed, so a press on Accept/Decline never loses its click to a rebuild
    // between press and release. A rebuilt menu (language change) gets a new section.
    const key = JSON.stringify(this.invites.map((i) => [i.id, i.fromUsername]));
    if (this._invitesShownIn === this.inviteSection && this._invitesKey === key) return;
    this._invitesShownIn = this.inviteSection;
    this._invitesKey = key;
    this.inviteSection.textContent = '';
    if (!this.invites.length) {
      this.inviteSection.hidden = true;
      return;
    }
    this.inviteSection.hidden = false;
    this.inviteSection.append(el('h2', { i18n: 'Table invites' }));
    for (const inv of this.invites) {
      const row = el('div', { class: 'invite-row' },
        el('span', { text: tr('{name} invites you to a table', { name: inv.fromUsername || tr('A friend') }) }),
        el('button', {
          class: 'primary', type: 'button', i18n: 'Accept',
          onclick: () => this.answerInvite(inv, true),
        }),
        el('button', {
          type: 'button', i18n: 'Decline',
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
        ? await quickPlay(this.ctx.net, this.aiCount)
        : await createPrivateTable(this.ctx.net, this.aiCount);
      if (room.status === 'Playing') this.ctx.onEnterTable(room);
      else this.ctx.onEnterLobby(room);
    } catch (e) {
      this.errorLine.textContent = tr('Could not get a table: {error}', { error: e.message || e });
      this.errorLine.hidden = false;
    } finally {
      this.busy = false;
    }
  }

  toggleHelp() {
    const open = this.helpPanel.hidden;
    this.helpPanel.hidden = !open;
    if (this._helpBtn) this._helpBtn.setAttribute('aria-expanded', String(open));
  }

  destroy() {
    this.busy = false;
    this.destroyed = true;
    closeSettings();
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
    this.selectedAi = null; // participant id of an AI seat picked up for moving
    this.presence = new Map(); // userId -> online
    this.pendingInvites = new Set(); // userIds with an outstanding room invite
    this.destroyed = false;

    this.controller = new RoomController(ctx.net, {
      onRoster: (r) => this.onRoster(r),
      onPresence: (p) => this.onPresence(p),
      onReady: () => this.render(),
      onResult: () => {},
      onSocketDown: () => this.render(),
      onUnavailable: () => this.onUnavailable(),
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
      type: 'button', i18n: 'Ready',
      onclick: () => this.toggleReady(),
    });
    this.startBtn = el('button', {
      class: 'primary', type: 'button', i18n: 'Start table',
      i18nTitle: 'Fill empty seats with AI and deal the first hand',
      onclick: () => this.start(),
    });
    this.openBtn = el('button', {
      type: 'button', i18n: 'Open to matchmaking',
      onclick: () => this.open(),
    });
    const leaveBtn = el('button', {
      type: 'button', i18n: 'Leave table',
      onclick: () => this.leave(),
    });
    this.stopNote = el('div', { class: 'online-stop', role: 'alert', hidden: '' });

    this.screen = el('div', { class: 'screen lobby' },
      el('h1', { i18n: visibility === 'private' ? 'Private table' : 'Public table' }),
      this.stopNote,
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
      el('p', { class: 'muted small', i18n: 'Loading friends…' }));
    this.inviteSection = el('div', { class: 'invite-section' },
      el('h2', { i18n: 'Invite players' }),
      el('button', {
        type: 'button', i18n: 'Copy share link',
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
      this.friends = friends;
      this.renderFriends(friends);
    } catch {
      if (this.friendList) {
        this.friendList.textContent = '';
        this.friendList.append(el('p', {
          class: 'muted small', i18n: 'Could not load the friend list.',
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
        i18n: 'No friends yet — use the share link to invite someone.',
      }));
      return;
    }
    for (const f of friends) {
      const pending = this.pendingInvites.has(f.userId);
      const btn = el('button', {
        type: 'button', i18n: pending ? 'Invited ✓' : 'Invite',
        onclick: () => this.invite(f),
      });
      btn.disabled = pending;
      // Friends list carries no nickname; resolve through the profile cache.
      this.ctx.net.profiles.profile(f.userId);
      const name = this.ctx.net.profiles.displayName(f.userId, f.username);
      this.friendList.append(el('div', { class: 'friend-row' },
        el('span', { class: `dot${f.online ? ' on' : ''}` }),
        el('span', { class: 'friend-name', text: name }),
        f.currentGame ? el('span', { class: 'muted small', text: tr('playing {game}', { game: f.currentGame }) }) : '',
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
    this.shareNote(() => tr(res.notified === false
      ? '{name} was invited, but is not connected right now — StarHermit will show them the invite when they are.'
      : '{name} was invited — StarHermit is notifying them now.', { name }));
    this.loadFriends();
  }

  async copyShareLink() {
    const link = this.controller.shareInviteLink();
    try {
      await navigator.clipboard.writeText(link);
      this.shareNote(() => tr('Share link copied — the dashboard handles sign-in and friending.'));
    } catch {
      this.shareNote(link);
    }
  }

  // text: a string, or a function re-run on a language change.
  shareNote(text) {
    if (!this.inviteSection) return;
    this._shareNote = text;
    if (typeof text === 'function') text = text();
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
    // Drop the move selection if that AI participant is gone or taken over.
    if (this.selectedAi && !(room.participants || [])
      .some((p) => p.id === this.selectedAi && p.isAi && !p.leftAt)) {
      this.selectedAi = null;
    }
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
    if (this.starting) return; // ignore double-clicks while the request is out
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

  // Host seat arrangement: move the selected AI participant to an empty seat.
  async moveSelectedAi(seat) {
    const participantId = this.selectedAi;
    this.selectedAi = null;
    try {
      this.room = await this.controller.setSeats(this.room.id, [
        { participantId, team: 0, slot: seat },
      ]);
    } catch (e) {
      this.showError(e);
    }
    this.render();
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

  // The room is gone (closed, or no longer ours): the reconnect loop stopped.
  onUnavailable() {
    if (this.destroyed) return;
    this.unavailable = true;
    this.render();
  }

  // Language change: static labels re-apply through data-i18n; the rest here.
  relocalize() {
    if (this.destroyed) return;
    this.render();
    if (this.friends) this.renderFriends(this.friends);
    if (this._shareNote) this.shareNote(this._shareNote);
  }

  // --- rendering ---

  render() {
    if (this.destroyed || !this.seatGrid) return;
    const { net } = this.ctx;
    const room = this.room;
    const participants = (room.participants || []).filter((p) => !p.leftAt);
    const seatCount = seatCountOf(room);
    const seats = seatMap(participants, seatCount);
    const host = isHost(room, net.userId);
    // Seat moves need a free slot to drop into; a full room has none.
    this.canMoveAi = participants.length < seatCount;

    const parts = [];
    // A room snapshot can arrive before its status is known: never print "undefined".
    if (room.status) parts.push(tr('Status: {status}', { status: tr('room.' + room.status) }));
    parts.push(tr('{n}/{total} seats', { n: participants.length, total: seatCount }));
    if (room.status === 'Open') {
      parts.push(tr('open for matchmaking (AI backfill ~{s}s after opening)',
        { s: room.config?.backfillAfterSeconds ?? GAME.roomBackfillAfterSeconds }));
    }
    if (!this.controller.connected && !this.unavailable) parts.push(tr('reconnecting…'));
    this.statusLine.textContent = parts.join(' · ');
    this.stopNote.hidden = !this.unavailable;
    this.stopNote.textContent = this.unavailable ? tr('This table is no longer available — leave it to return to the menu.') : '';

    this.seatGrid.textContent = '';
    for (const { seat, participant } of seats) {
      this.seatGrid.append(this.renderSeat(seat, participant, room));
    }

    // Ready toggle label.
    this.readyBtn.dataset.i18n = this.selfReady ? 'Unready' : 'Ready';
    this.readyBtn.textContent = tr(this.readyBtn.dataset.i18n);

    // Invites only make sense (and are only accepted by the platform) while
    // the room is in Lobby/Open.
    if (this.inviteSection) {
      this.inviteSection.hidden = room.status !== 'Lobby' && room.status !== 'Open';
    }

    // Host controls: start only when legal; open only from Lobby.
    this.startBtn.hidden = !host;
    this.startBtn.disabled = !canStart(room, net.userId) || !!this.unavailable;
    this.openBtn.hidden = !host || room.status !== 'Lobby';
  }

  renderSeat(seat, participant, room) {
    // The host arranges AI players while the room is in Lobby/Open: tap an AI
    // seat to pick it up, then tap an empty seat to place it there. Empty
    // seats that remain at start are still backfilled with AI by the platform.
    const canArrange = this.canMoveAi && isHost(room, this.ctx.net.userId) &&
      (room.status === 'Lobby' || room.status === 'Open');
    if (!participant) {
      if (canArrange && this.selectedAi) {
        return el('button', {
          class: 'seat empty drop-target', type: 'button',
          i18nTitle: 'Place the selected AI here',
          onclick: () => this.moveSelectedAi(seat),
        },
          el('span', { class: 'seat-name', text: tr('Seat {n}', { n: seat + 1 }) }),
          el('span', { class: 'muted small', i18n: 'Tap to place AI' }));
      }
      return el('div', {
        class: 'seat empty',
        i18nTitle: 'Empty seats become AI when the table starts',
      },
        el('span', { class: 'seat-name', text: tr('Seat {n}', { n: seat + 1 }) }),
        el('span', { class: 'muted small', i18n: 'Empty — AI at start' }));
    }
    const isSelf = participant.userId === this.ctx.net.userId;
    const online = participant.isAi
      ? true
      : this.presence.get(participant.userId) !== false; // assume online until told otherwise
    const ready = isSelf
      ? this.selfReady
      : this.controller.readyTracker.isReady(participant.id);
    const displayName = participant.isAi || !participant.userId
      ? (participant.username || tr('AI'))
      : (this.ctx.net.profiles.profile(participant.userId),
        this.ctx.net.profiles.displayName(participant.userId, participant.username));
    if (participant.isAi && canArrange) {
      const selected = this.selectedAi === participant.id;
      return el('button', {
        class: `seat ai-movable${selected ? ' selected' : ''}`, type: 'button',
        i18nTitle: selected
          ? 'Tap again to put it back'
          : 'Select this AI, then tap an empty seat to move it',
        onclick: () => {
          this.selectedAi = selected ? null : participant.id;
          this.render();
        },
      },
        el('span', { class: 'seat-name', text: displayName }),
        el('span', { class: 'seat-badges' },
          el('span', { class: 'badge ai', i18n: 'badge.ai' }),
          selected ? el('span', { class: 'badge move', i18n: 'badge.move' }) : ''));
    }
    return el('div', { class: `seat${isSelf ? ' self' : ''}${online ? '' : ' offline'}` },
      el('span', { class: 'seat-name', text: displayName }),
      el('span', { class: 'seat-badges' },
        participant.isHost ? el('span', { class: 'badge host', i18n: 'badge.host' }) : '',
        participant.isAi ? el('span', { class: 'badge ai', i18n: 'badge.ai' }) : '',
        ready ? el('span', { class: 'badge ready', i18n: 'badge.ready' }) : '',
        online ? '' : el('span', { class: 'badge offline', i18n: 'badge.offline' }),
      ));
  }

  destroy() {
    this.destroyed = true;
    this.ctx.net.profiles.removeListener(this._profileListener);
    this.controller.destroy();
  }
}
