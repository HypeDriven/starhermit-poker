// Table screen (basic). Checkpoint 7 scope: keep the realtime socket alive for
// roster/presence, connect the gameplay socket on gameSessionId, sync, and
// render a minimal textual view proving end-to-end state flow. The full 3D
// table replaces this render layer in checkpoint 13; the socket/session glue
// stays.

import { RoomController } from './realtime-room.js';
import { GameSocket } from './game-socket.js';

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

export class TableScreen {
  // ctx: { root, net, onExitToMenu() }; room: the Playing realtime room.
  constructor(ctx, room) {
    this.ctx = ctx;
    this.room = room;
    this.gameState = null; // last 'state' message { you, publicState }
    this.lastEvent = null;
    this.destroyed = false;

    this.roomCtl = new RoomController(ctx.net, {
      onRoster: (r) => {
        this.room = r;
        // Session created after we mounted (bridge is best-effort): attach.
        if (r.gameSessionId && !this.game) this.attachGame(r.gameSessionId);
        if (r.status === 'Closed' && !this.destroyed) this.ctx.onExitToMenu();
        this.render();
      },
    });

    if (room.gameSessionId) this.attachGame(room.gameSessionId);
  }

  attachGame(sessionId) {
    this.game = new GameSocket(this.ctx.net, sessionId, {
      onState: (msg) => {
        this.gameState = msg;
        this.render();
      },
      onEvent: (msg) => {
        this.lastEvent = msg;
        if (msg.type === 'match-complete') this.render();
      },
      onError: (message) => this.showError(message),
      onDown: () => this.render(),
    });
    this.game.connect();
  }

  show() {
    const { root } = this.ctx;
    root.textContent = '';
    this.statusLine = el('p', { class: 'muted' });
    this.tableInfo = el('div', { class: 'table-debug' });
    this.errorLine = el('p', { class: 'error', hidden: '' });
    const leaveBtn = el('button', {
      type: 'button', text: 'Leave table',
      onclick: () => this.leave(),
    });
    this.screen = el('div', { class: 'screen' },
      el('h1', { text: 'Poker table' }),
      this.statusLine, this.tableInfo, this.errorLine, leaveBtn);
    root.append(this.screen);
    this.render();
    if (this.room.id) this.roomCtl.connect(this.room.id);
  }

  async leave() {
    if (this.room.id) {
      try { await this.roomCtl.leaveRoom(this.room.id); } catch { /* already gone */ }
    }
    if (!this.destroyed) this.ctx.onExitToMenu();
  }

  showError(message) {
    if (!this.errorLine) return;
    this.errorLine.textContent = message;
    this.errorLine.hidden = false;
  }

  render() {
    if (this.destroyed || !this.statusLine) return;
    const gs = this.gameState;
    this.statusLine.textContent =
      `Room ${this.room.status} · session ${this.room.gameSessionId || 'pending'}` +
      (this.game && this.game.socket.connected ? '' : ' · reconnecting…');

    this.tableInfo.textContent = '';
    if (!gs) {
      this.tableInfo.append(el('p', { class: 'muted', text: 'Waiting for game state…' }));
      return;
    }
    const pub = gs.publicState;
    this.tableInfo.append(
      el('p', { text: `Hand #${pub.handNumber} · ${pub.street} · pot ${pub.pot}` }),
      el('p', {
        class: 'muted small',
        text: `You are seat ${gs.you.seat >= 0 ? gs.you.seat + 1 : '?'} · state v${gs.stateVersion}` +
          (this.lastEvent ? ` · last event: ${this.lastEvent.type}` : ''),
      }),
    );
    const list = el('div', { class: 'seat-grid' });
    for (const s of pub.seats) {
      list.append(el('div', { class: 'seat' + (s.userId === this.ctx.net.userId ? ' self' : '') },
        el('span', { class: 'seat-name', text: s.name }),
        el('span', { class: 'muted small', text: `${s.stack} chips${s.ai ? ' · AI' : ''}` })));
    }
    this.tableInfo.append(list);
  }

  destroy() {
    this.destroyed = true;
    if (this.game) this.game.destroy();
    this.roomCtl.destroy();
  }
}
