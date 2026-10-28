// The StarHermit platform on the runtime's module (starhermit:platform):
// - the player (nickname-first display names through a profile cache, the
//   avatar), the invite link, the platform's clock (server.js's turn
//   deadlines are platform epoch milliseconds);
// - rooms and the bound session's game socket for src/online.js
//   (`adapter`): Quick Play, private tables with AI seats and friend invites,
//   the room's roster / presence / ready signals, the game socket's commands
//   and server.js's addressed broadcasts. No client posts a result: server.js
//   returns the match result, the Elo updates and the leaderboard scores;
// - the room-invite inbox, the friend list, the leaderboards (read only) and
//   the player's replays (the archived session state server.js kept);
// - the table's chat (the session's conversation, polled by the runtime) and
//   voice (the runtime's voice room for that conversation).
// The browser build's own account settings (graphics, soundEnabled) and the
// language helper's ui.language were replaced by the runtime's Options: the
// legacy keys are removed once. The game kept no cloud save before (Elo and
// stats are script-owned player state), so nothing migrates.
import type { JsonValue } from "starhermit:engine";
import {
  avatar as fetchAvatar, chat, connectGame, friends, gameInfo, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player,
  profile, replays, rooms, serverNow, serverTime, sessions, voice,
  type ChatChannel, type ChatMessage, type Friend, type GameSocket, type ReplayDetail, type ReplaySummary, type Room, type RoomInvite,
  type RoomSocket, type VoiceStatus,
} from "starhermit:platform";
import { settings as store } from "starhermit:storage";
import type { ImageBitmap } from "starhermit:canvas";
import { N } from "./i18n.ts";

// --- the player ---------------------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function userId(): string | null { return player()?.userId ?? null; }

const names = new Map<string, string>();
const asked = new Set<string>();
let namesVersion = 0;
/** A player's name to show: the profile's (nickname first), else the given fallback, else "Player <id>". */
export function nameOf(id: string | null | undefined, fallback?: string | null): string {
  if (!id) return fallback || "";
  const known = names.get(id);
  if (known) return known;
  const me = player();
  if (me && me.userId === id) return me.displayName;
  if (!asked.has(id) && signedIn()) {
    asked.add(id);
    profile(id).then((p) => { names.set(id, p.displayName); namesVersion++; }, () => undefined);
  }
  return fallback || `Player ${id.slice(0, 8)}`;
}
/** Bumps when a profile arrived (screens re-read names). */
export function nameVersion(): number { return namesVersion; }

let myAvatar: ImageBitmap | null = null;
let invite: string | null = null;
let info: { leaderboardId: string | null; elo?: number; wins?: number; losses?: number; draws?: number } | null = null;
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
function refreshPlayer(): void {
  invite = null; myAvatar = null; info = null; boards = null;
  for (const fn of playerListeners) fn();
  const me = player();
  if (!me) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  fetchAvatar(me.userId).then((b) => { myAvatar = b; }, () => { myAvatar = null; });
  gameInfo().then((g) => { info = { leaderboardId: g.leaderboardId, ...(g.me ?? {}) }; }, () => { info = null; });
}
onPlayerChange(() => refreshPlayer());
export function avatarImage(): ImageBitmap | null { return myAvatar; }
/** The invite link, fetched ahead so a press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
/** The player's standing (Elo and record) from the platform, once it answered. */
export function standing(): typeof info { return info; }
/** The share link a non-friend opens on the dashboard (sign-in, friending, launch). */
export function shareLink(): string | null { return inviteLink(); }

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

/** Reads the platform clock and removes the browser build's account settings (from onStart). */
export function initPlatform(): void {
  const legacy = (): void => {
    const keys = store.legacyKeys();
    if (!keys) return;
    for (const key of keys) { try { store.removeLegacy(key); } catch { /* not removable */ } }
  };
  store.onLegacy(legacy);
  legacy();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- rooms and the game socket (src/online.js's platform) ----------------------------------
const lower = (room: Room | null): Room | null => room;
interface RoomHandlers {
  onOpen?: () => void; onDown?: () => void; onRoster?: (room: Room) => void;
  onPresence?: (userId: string, online: boolean) => void; onReady?: (from: string, ready: boolean) => void;
  onStopped?: (reason: string) => void;
}
interface GameHandlers {
  onOpen?: () => void; onDown?: () => void; onMessage?: (data: unknown) => void;
  onError?: (message: string) => void; onStopped?: (reason: string) => void;
}
export const adapter = {
  get userId(): string | null { return userId(); },
  createRoom: (cfg: { teamCount: number; seatsPerTeam: number; backfillAfterSeconds: number; aiPlayers: number; metadata: JsonValue }): Promise<Room> =>
    rooms.create({ ...cfg, isVisible: true }),
  openRoom: (id: string): Promise<Room> => rooms.open(id),
  startRoom: (id: string): Promise<Room> => rooms.start(id),
  leaveRoom: (id: string): Promise<void> => rooms.leave(id),
  getRoom: (id: string): Promise<Room | null> => rooms.get(id).then(lower),
  quickJoin: (): Promise<Room | null> => rooms.quickJoin(),
  myRoom: (): Promise<Room | null> => rooms.mine(),
  seat: (id: string, seats: { participantId: string; team: number; slot: number }[]): Promise<Room> => rooms.seat(id, seats),
  invite: (id: string, user: string): Promise<void> => rooms.invite(id, user),
  connectRoom(roomId: string, h: RoomHandlers): { sendReady(): boolean; close(): void } {
    let socket: RoomSocket | null = null;
    try { socket = rooms.connect(roomId); } catch { queueMicrotask(() => h.onStopped?.("connect")); }
    if (socket) {
      socket.on("open", () => h.onOpen?.());
      socket.on("disconnected", () => h.onDown?.());
      socket.on("roster", (room) => h.onRoster?.(room));
      socket.on("presence", (u, online) => h.onPresence?.(u, online));
      socket.on("control", (from, kind, frame) => {
        if (kind !== "ready") return;
        const f = frame as { ready?: unknown } | null;
        h.onReady?.(from, !(f && typeof f === "object" && f.ready === false));
      });
      socket.on("stopped", (reason) => h.onStopped?.(reason));
    }
    return {
      sendReady(): boolean { try { return !!socket && socket.sendReady(); } catch { return false; } },
      close(): void { try { socket?.close(); } catch { /* gone */ } socket = null; },
    };
  },
  connectGame(sessionId: string, h: GameHandlers): { send(data: JsonValue): boolean; close(): void } {
    let socket: GameSocket | null = null;
    try { socket = connectGame(sessionId); } catch { queueMicrotask(() => h.onStopped?.("connect")); }
    if (socket) {
      socket.on("open", () => h.onOpen?.());
      socket.on("disconnected", () => h.onDown?.());
      socket.on("game", (data) => h.onMessage?.(data));
      socket.on("error", (message) => h.onError?.(message));
      socket.on("stopped", (reason) => h.onStopped?.(reason));
      socket.on("abandoned", (reason) => h.onStopped?.(`abandoned:${reason}`));
    }
    return {
      send(data: JsonValue): boolean { try { return !!socket && socket.state === "open" && socket.sendCommand(data); } catch { return false; } },
      close(): void { try { socket?.close(); } catch { /* gone */ } socket = null; },
    };
  },
};

/** The room the player holds a seat in (a reconnect restores its lobby or table), or null. */
export async function myRoom(): Promise<Room | null> {
  if (!signedIn()) return null;
  try { const r = await rooms.mine(); return r && r.status !== "closed" ? r : null; } catch { return null; }
}
/** What the platform launched the run for: an invite's session to open at once. */
export async function launchSession(sessionId: string): Promise<boolean> {
  try { const s = await sessions.get(sessionId); return !!s && s.status === "active"; } catch { return false; }
}

// --- the room-invite inbox and friends --------------------------------------------------------
export async function roomInvites(): Promise<RoomInvite[] | null> {
  if (!signedIn()) return [];
  try { return await rooms.invites(); } catch { return null; }
}
export const acceptInvite = (id: string): Promise<Room> => rooms.acceptInvite(id);
export const declineInvite = (id: string): Promise<void> => rooms.declineInvite(id);
export async function friendList(): Promise<Friend[] | null> {
  try { return await friends.list(); } catch { return null; }
}

// --- leaderboards and replays -------------------------------------------------------------------
let boards: { key: string; id: string }[] | null = null;
async function boardId(key: string): Promise<string | null> {
  if (!boards) boards = (await leaderboards.list()).map((b) => ({ key: b.key, id: b.id }));
  return boards.find((b) => b.key === key)?.id ?? null;
}
export interface BoardRow { rank: number; name: string; score: number; you: boolean }
export interface BoardPage { rows: BoardRow[]; total: number }
/** A page of the game's leaderboard (the platform's default board: tables won), friends only or everyone. */
export async function boardPage(page: number, pageSize: number, friendsOnly: boolean): Promise<BoardPage | "none"> {
  let id = info?.leaderboardId ?? null;
  if (!id) id = await boardId("match-wins");
  if (!id) return "none";
  const me = userId();
  const r = await leaderboards.entries(id, { page, pageSize, ...(friendsOnly ? { friendsOnly: true } : {}) });
  return {
    total: r.total,
    rows: r.items.map((e) => ({ rank: e.rank, name: names.get(e.userId) ?? e.displayName ?? e.username, score: e.score, you: !!me && e.userId === me })),
  };
}
/** The player's rank on a board (server.js posted to it), polled a few times while the platform files it. */
export async function rankOn(key: string): Promise<number | null> {
  const me = userId();
  if (!me) return null;
  try {
    const id = await boardId(key);
    if (!id) return null;
    const r = await leaderboards.entries(id, { pageSize: 100 });
    return r.items.find((e) => e.userId === me)?.rank ?? null;
  } catch { return null; }
}
export const replayList = (): Promise<ReplaySummary[]> => replays.list({ limit: 20 });
export const replayDetail = (id: string): Promise<ReplayDetail> => replays.get(id);

// --- chat --------------------------------------------------------------------------------------
export interface ChatLine { id: string; who: string; text: string; mine: boolean; at: number }
export class TableChat {
  lines: ChatLine[] = [];
  error: string | null = null;
  version = 0;
  conversationId: string | null = null;
  private channel: ChatChannel | null = null;
  private seen = new Set<string>();
  private closed = false;
  constructor(sessionId: string) {
    void sessions.get(sessionId).then(async (s) => {
      if (this.closed || !s?.chatConversationId) return;
      this.conversationId = s.chatConversationId;
      const page = await chat.messages(s.chatConversationId, { page: 1, pageSize: 50 }).catch(() => null);
      if (this.closed) return;
      if (page) for (const m of page.items.slice().reverse()) this.add(m);
      this.channel = chat.subscribe(s.chatConversationId);
      this.channel.on("message", (m) => this.add(m));
      this.channel.on("error", () => { this.error = N("Could not load the chat."); this.version++; });
    }, () => undefined);
  }
  private add(m: ChatMessage): void {
    if (this.seen.has(m.id) || m.isDeleted) return;
    this.seen.add(m.id);
    const me = userId();
    this.lines.push({ id: m.id, who: m.senderId, text: m.content, mine: !!me && m.senderId === me, at: m.sentAt });
    this.lines.sort((a, b) => a.at - b.at);
    while (this.lines.length > 100) this.lines.shift();
    this.error = null;
    this.version++;
  }
  /** Sends a line (1–2000 characters); false when it could not be queued. */
  send(text: string): boolean {
    const s = text.trim();
    if (!s || !this.channel) return false;
    if (s.length > 2000) { this.error = N("Message is too long"); this.version++; return false; }
    try { return this.channel.send(s); } catch { return false; }
  }
  get ready(): boolean { return !!this.channel; }
  close(): void { this.closed = true; try { this.channel?.close(); } catch { /* gone */ } this.channel = null; }
}

// --- voice -------------------------------------------------------------------------------------
export class TableVoice {
  status: VoiceStatus | null = null;
  error: string | null = null;
  busy = false;
  private unsub: (() => void) | null = null;
  get enabled(): boolean { return !!this.status && this.status.connection !== "off" && this.status.connection !== "failed"; }
  async enable(conversationId: string): Promise<void> {
    if (this.busy || this.enabled) return;
    this.busy = true;
    this.error = null;
    try {
      this.unsub ??= voice.onStatus((s) => { this.status = s; });
      voice.setMode("open-mic");
      this.status = await voice.join(conversationId);
    } catch (e) {
      const kind = (e as { kind?: string })?.kind;
      this.error = kind === "not-allowed" ? N("Microphone access denied") : N("Voice is unavailable right now.");
    } finally { this.busy = false; }
  }
  async disable(): Promise<void> {
    try { await voice.leave(); } catch { /* not joined */ }
    this.status = null;
  }
  setMuted(muted: boolean): void { try { voice.setMuted(muted); } catch { /* not joined */ } }
  close(): void { void this.disable(); this.unsub?.(); this.unsub = null; }
}
