// In-game text chat.
// Contract: https://wiki.starhermit.com/docs/api/chat.html
//
// Launch tokens cannot open ws/v1/chat, so this is REST polling only:
//   GET  /api/v1/chat/conversations/{id}/messages?page=1&pageSize=50  (5 s)
//   POST /api/v1/chat/conversations/{id}/messages  { content }
// Rate limit: 10 messages/minute/user (429). No incremental-fetch parameter
// exists, so we dedupe by message id client-side. Display uses textContent
// only — no HTML injection is possible.

import { GAME } from './config.js';

// ChatCore: transport + dedupe, no DOM (unit-testable).
export class ChatCore {
  // client: ApiClient; conversationId; onMessages(messages) fires with the
  // full known list (oldest first) whenever it grows; onError(message).
  constructor(client, conversationId, { onMessages, onError } = {}) {
    this.client = client;
    this.conversationId = conversationId;
    this.onMessages = onMessages || (() => {});
    this.onError = onError || (() => {});
    this.messages = [];
    this.seen = new Set();
    this.sending = false;
  }

  async poll() {
    try {
      const page = await this.client.get(
        `/api/v1/chat/conversations/${this.conversationId}/messages?page=1&pageSize=${GAME.chatPageSize}`);
      const items = (page && page.items) || [];
      let grew = false;
      for (const m of items) {
        if (!m || !m.id || this.seen.has(m.id)) continue;
        this.seen.add(m.id);
        this.messages.push(m);
        grew = true;
      }
      if (grew) {
        this.messages.sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
        this.onMessages(this.messages);
      }
    } catch (e) {
      this.onError(e.message || String(e));
    }
  }

  async send(content) {
    const text = String(content || '').trim();
    if (!text || this.sending) return false;
    if (text.length > 2000) {
      this.onError('Message is too long');
      return false;
    }
    this.sending = true;
    try {
      await this.client.post(
        `/api/v1/chat/conversations/${this.conversationId}/messages`, { content: text });
      await this.poll(); // pick up our own message immediately
      return true;
    } catch (e) {
      this.onError(e && e.status === 429
        ? 'Slow down — chat is limited to 10 messages per minute'
        : (e.message || String(e)));
      return false;
    } finally {
      this.sending = false;
    }
  }
}

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

// ChatPanel: DOM binding for ChatCore.
export class ChatPanel {
  // resolveName(senderId, senderUsername) -> display name (profile cache
  // plugs in here at checkpoint 16; defaults to the username).
  constructor(net, conversationId, { resolveName } = {}) {
    this.net = net;
    this.resolveName = resolveName || ((id, username) => username || `Player ${String(id).slice(0, 8)}`);
    this.core = new ChatCore(net.client, conversationId, {
      onMessages: (msgs) => this.renderMessages(msgs),
      onError: (m) => this.showError(m),
    });
    this.timer = null;
  }

  mount(container) {
    this.list = el('div', { class: 'chat-list' });
    this.errorEl = el('div', { class: 'chat-error error small', hidden: '' });
    this.input = el('input', { type: 'text', maxlength: '2000', placeholder: 'Message…' });
    this.sendBtn = el('button', { type: 'button', text: 'Send' });
    const send = () => this.send();
    this.sendBtn.addEventListener('click', send);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    this.panel = el('div', { class: 'chat-panel' },
      el('div', { class: 'chat-title muted small', text: 'Table chat' }),
      this.list, this.errorEl,
      el('div', { class: 'chat-input-row' }, this.input, this.sendBtn));
    container.append(this.panel);

    this.core.poll();
    this.timer = setInterval(() => this.core.poll(), GAME.chatPollMs);
    return this;
  }

  renderMessages(messages) {
    if (!this.list) return;
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60;
    this.list.textContent = '';
    const me = this.net.userId;
    for (const m of messages.slice(-100)) {
      if (m.isDeleted) continue;
      const mine = m.senderId === me;
      this.list.append(el('div', { class: `chat-msg${mine ? ' mine' : ''}` },
        el('span', { class: 'chat-who', text: this.resolveName(m.senderId, m.senderUsername) }),
        el('span', { class: 'chat-text', text: m.content || '' })));
    }
    if (nearBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  async send() {
    const text = this.input.value;
    this.sendBtn.disabled = true;
    const ok = await this.core.send(text);
    if (ok) this.input.value = '';
    this.sendBtn.disabled = false;
    this.input.focus();
  }

  showError(message) {
    if (!this.errorEl) return;
    this.errorEl.textContent = message;
    this.errorEl.hidden = false;
    setTimeout(() => { if (this.errorEl) this.errorEl.hidden = true; }, 5000);
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.panel) this.panel.remove();
  }
}
