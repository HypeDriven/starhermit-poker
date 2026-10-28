// StarHermit Poker on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. It is what the browser build's src/app.js and its
// screens did around server.js: the menu over the cinematic casino (signed
// out: the offline table against five AI seats; signed in: Quick Play, private
// tables with AI opponents, the room-invite inbox, the leaderboard, replays,
// the invite link), the table lobby (seats, presence, ready, AI seat moves,
// friend invites, start / open to matchmaking), the table (the 3D table, the
// seat panels, the pot, the action bar with the bet slider and presets, the
// activity feed, chat and voice for online tables), the leaderboard and the
// replay viewer. Poker itself is server.js's: online tables are refereed by
// it on the platform (src/online.js), the offline table runs it locally
// (src/offline.js); this client only shows projections and sends commands.
// Screens are drawn by screens.ts (starhermit:ui), the table by table3d.ts
// and the menu's casino by menu3d.ts (starhermit:scene).
//
// Time: the offline table's clock is the runtime's fixed steps (1/60 s each),
// so turn clocks, the 1 Hz sweep and the AI pace never move while the window
// is hidden, and play scripts replay exactly; its deck is seeded from the step
// the match starts on. Online tables read the platform's clock (server.js's
// deadlines are platform time).
import "./classic.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onStart, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onKey, onPointerButton, onPointerMove, onTouch, primaryPointer } from "starhermit:input";
import * as ui from "starhermit:ui";
import { renderer } from "starhermit:scene";
import { launchContext, onSessionEnded, requestSignIn, type Friend, type ReplaySummary, type RoomInvite, type Room } from "starhermit:platform";
import { game, pokerRules, type LegalActions, type PublicState, type You } from "./classic.ts";
import { OfflineTable } from "../src/offline.js";
import { LobbyClient, TableClient, createPrivateTable, quickPlay } from "../src/online.js";
import { ReplayEngine } from "../src/replay-engine.js";
import { presetTotal } from "../src/table-utils.js";
import type { TableModel } from "../src/table-model.js";
import * as audio from "./audio.ts";
import { S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as table3d from "./table3d.ts";
import * as menu3d from "./menu3d.ts";
import { drawScreens } from "./screens.ts";
import { initStyles } from "./style.ts";
import * as equity from "./equity.ts";

export type Screen = "menu" | "lobby" | "table" | "leaderboard" | "replays" | "replay";
type Text = () => string;

export interface ReplayView {
  engine: InstanceType<typeof ReplayEngine> | null;
  result: { winnerName?: string } | null;
  status: Text | null;
  handIdx: number;
  stepIdx: number;
  steps: ReturnType<InstanceType<typeof ReplayEngine>["stepsForHand"]>;
  playing: boolean;
  speed: number;
  nextAt: number;
}

export const app = {
  screen: "menu" as Screen,
  /** Frame the screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  /** A notice on the menu (signed out, session expired, terms). */
  notice: null as Text | null,
  helpOpen: false,
  aiCount: 0,
  busy: false,
  error: null as Text | null,
  status: null as Text | null,
  invites: [] as RoomInvite[],
  lobby: null as LobbyClient | null,
  friends: undefined as Friend[] | null | undefined,
  shareNote: null as Text | null,
  lobbyError: null as Text | null,
  offline: null as OfflineTable | null,
  online: null as TableClient | null,
  /** The bet slider's value (a new round total). */
  bet: 0,
  betFor: "",
  tableError: null as { text: string; until: number } | null,
  lbLine: null as Text | null,
  chat: null as platform.TableChat | null,
  chatOpen: false,
  chatDraft: "",
  voice: null as platform.TableVoice | null,
  voiceMuted: false,
  boardPage: 1,
  boardFriends: false,
  board: null as platform.BoardPage | null,
  boardStatus: null as Text | null,
  replayItems: null as ReplaySummary[] | null,
  replayStatus: null as Text | null,
  replay: null as ReplayView | null,
};
export const now = (): number => frame().time;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (!text || !text.trim()) return;
  try { ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" }); } catch { /* a burst past the reader's queue: dropped */ }
}
export function show(screen: Screen, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
  const casino = screen === "menu";
  const tableOn = screen === "table";
  if (!casino) menu3d.setActive(false);
  if (!tableOn) table3d.setActive(false);
  if (casino) menu3d.setActive(true);
  if (tableOn) table3d.setActive(true);
  if (!casino && !tableOn) setNoScene();
}
function setNoScene(): void {
  table3d.setActive(false);
  menu3d.setActive(false);
  renderer.camera = null;
}
export const fresh = (): boolean => frame().frame !== app.openedFrame;
const errText = (e: unknown): string => {
  const pe = e as { kind?: string; message?: string };
  return String(pe?.message || pe?.kind || e || "");
};

/** The table being shown: its model (offline or online). */
export function tableModel(): TableModel | null {
  if (app.offline) return app.offline.model as TableModel;
  if (app.online) return app.online.model as TableModel;
  return null;
}
export function pub(): PublicState | null { return (tableModel()?.pub as PublicState | null) ?? null; }
export function you(): You | null { return (tableModel()?.you as You | null) ?? null; }
export function legal(): LegalActions | null { return (tableModel()?.legal as LegalActions | null) ?? null; }
/** The local player's user id at this table ("local-player" offline). */
export function myId(): string | null { return app.offline ? "local-player" : platform.userId(); }

// ------------------------------------------------------------------ the menu
export function goMenu(notice: Text | null = null): void {
  closeTable();
  if (app.lobby) { app.lobby.close(); app.lobby = null; }
  app.notice = notice ?? app.notice;
  app.error = null;
  app.status = null;
  app.busy = false;
  show("menu", platform.signedIn() ? "btn-quick" : "btn-play");
  pollInvites(true);
}
let inviteAt = -1e9;
function pollInvites(force = false): void {
  if (!platform.signedIn() || app.screen !== "menu") return;
  if (!force && now() - inviteAt < 5) return;
  inviteAt = now();
  void platform.roomInvites().then((list) => { if (list) app.invites = list; });
}
export function toggleHelp(): void { app.helpOpen = !app.helpOpen; }
export function stepAi(d: number): void { app.aiCount = Math.min(5, Math.max(0, app.aiCount + d)); }
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); app.status = () => S("inviteCopied"); }
  catch { app.status = () => S("inviteFailed", { link }); }
}

/** Quick Play or a private table (with the chosen number of AI opponents). */
export function goOnline(mode: "quick" | "private"): void {
  if (app.busy) return;
  app.busy = true;
  app.error = null;
  const p = mode === "quick" ? quickPlay(platform.adapter, app.aiCount) : createPrivateTable(platform.adapter, app.aiCount);
  p.then((room: Room) => {
    app.busy = false;
    if (app.screen !== "menu") return;
    enterRoom(room);
  }, (e: unknown) => {
    app.busy = false;
    const error = errText(e);
    app.error = () => T("Could not get a table: {error}", { error });
  });
}
export function answerInvite(inv: RoomInvite, accept: boolean): void {
  if (app.busy) return;
  app.busy = true;
  (accept ? platform.acceptInvite(inv.id).then((room) => { app.busy = false; enterRoom(room); })
    : platform.declineInvite(inv.id).then(() => { app.busy = false; app.invites = app.invites.filter((i) => i.id !== inv.id); })
  ).catch((e: unknown) => {
    // The room is full, started or closed, or the player is in another room: drop the invite.
    app.busy = false;
    const error = errText(e);
    app.error = () => error;
    pollInvites(true);
  });
}
/** A room to show: its lobby, or the table once it is playing. */
export function enterRoom(room: Room): void {
  if (room.status === "playing" && room.gameSessionId) { enterOnlineTable(room); return; }
  if (room.status === "playing" || room.status === "closed") { app.error = () => T("This table is no longer available — leave it to return to the menu."); return; }
  const lobby: LobbyClient = new LobbyClient(platform.adapter, room, {
    onPlaying: (r: Room) => { if (app.lobby === lobby) { lobby.close(); app.lobby = null; enterOnlineTable(r); } },
  });
  app.lobby = lobby;
  app.friends = undefined;
  app.shareNote = null;
  app.lobbyError = null;
  lobby.connect();
  void platform.friendList().then((f) => { if (app.lobby === lobby) app.friends = f; });
  show("lobby", "btn-ready");
}

// ------------------------------------------------------------------ the lobby
export function lobbyLeave(): void {
  const l = app.lobby;
  app.lobby = null;
  if (l) void l.leave();
  goMenu();
}
export function lobbyStart(): void {
  const l = app.lobby;
  if (!l) return;
  void l.start().then((r: { ok: boolean; error?: unknown }) => { if (!r.ok && r.error) { const e = errText(r.error); app.lobbyError = () => e; } });
}
export function lobbyOpen(): void {
  const l = app.lobby;
  if (!l) return;
  void l.open().then((r: { ok: boolean; error?: unknown }) => { if (!r.ok && r.error) { const e = errText(r.error); app.lobbyError = () => e; } });
}
export function lobbyInvite(f: Friend): void {
  const l = app.lobby;
  if (!l) return;
  const name = platform.nameOf(f.userId, f.username);
  void l.invite(f.userId).then((r: { seated: boolean; error: unknown }) => {
    if (r.error) { const e = errText(r.error); app.lobbyError = () => e; return; }
    app.shareNote = () => T("{name} was invited — StarHermit is notifying them now.", { name });
  });
}
export function copyShareLink(): void {
  const link = platform.shareLink();
  if (!link) return;
  try { clipboard.writeText(link); app.shareNote = () => T("Share link copied — the dashboard handles sign-in and friending."); }
  catch { app.shareNote = () => link; }
}

// ------------------------------------------------------------------ tables
let clockMs = 1_800_000_000_000;
let steps = 0;
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Play (signed out): a fresh offline match against five AI seats. */
export function startOffline(): void {
  closeTable();
  const random = seededRandom(Math.imul(steps + 1, 0x9e3779b1) ^ 0x5eed);
  const t = new OfflineTable({ game, now: () => clockMs, random });
  app.offline = t;
  table3d.reset();
  resetTableUi();
  show("table");
  t.start();
}
function enterOnlineTable(room: Room): void {
  closeTable();
  const t: TableClient = new TableClient(platform.adapter, room, {
    now: platform.nowMs,
    hooks: {
      onError: (m: string) => { if (app.online === t) showTableError(m); },
      onOver: (result: { winnerUserId?: string | null } | null) => { if (app.online === t) showMatchRank(result); },
    },
  });
  app.online = t;
  table3d.reset();
  resetTableUi();
  t.connect();
  app.chat = new platform.TableChat(t.sessionId);
  app.voice = new platform.TableVoice();
  show("table");
}
function resetTableUi(): void {
  app.bet = 0;
  app.betFor = "";
  app.tableError = null;
  app.lbLine = null;
  app.chatOpen = false;
  app.chatDraft = "";
  app.voiceMuted = false;
  lastVersion = -1;
}
function closeTable(): void {
  if (app.online) { app.online.close(); app.online = null; }
  app.offline = null;
  if (app.chat) { app.chat.close(); app.chat = null; }
  if (app.voice) { app.voice.close(); app.voice = null; }
}
export function leaveTable(): void {
  const t = app.online;
  app.online = null;
  if (t) void t.leave();
  goMenu();
}
export function rematch(): void { startOffline(); }
function showTableError(message: string): void {
  app.tableError = { text: message, until: now() + 4 };
  announce(message, true);
}
/** server.js posted the winner's tables won to match-wins and everyone's hands won to hands-won: the rank on the board that moved. */
function showMatchRank(result: { winnerUserId?: string | null } | null): void {
  const me = platform.userId();
  if (!me || !result) return;
  const t = app.online;
  const key = result.winnerUserId === me ? "match-wins" : "hands-won";
  app.lbLine = () => S("lbPosting");
  let tries = 0;
  const poll = (): void => {
    void platform.rankOn(key).then((rank) => {
      if (app.online !== t) return;
      if (rank) { app.lbLine = () => S("lbRank", { rank }); return; }
      if (++tries < 8) setTimeout(poll, 1500);
      else app.lbLine = () => S("lbPosted");
    });
  };
  poll();
}

/** A table command: the offline table runs it at once, the online one queues it at the session's pace. */
function command(cmd: { type: string; amount?: number }): void {
  if (app.offline) {
    if (!app.offline.send(cmd)) showTableError(String(app.offline.error));
  } else if (app.online) app.online.send(cmd);
}
export function act(type: "fold" | "check" | "call" | "all-in"): void { if (legal()) command({ type }); }
export function actCheckCall(): void {
  const la = legal();
  if (!la) return;
  command({ type: la.callAmount > 0 ? "call" : "check" });
}
export function canAggro(): boolean {
  const la = legal(), p = pub();
  if (!la || !p) return false;
  return p.currentBet === 0 ? la.canBet : la.canRaise;
}
export function actBetRaise(): void {
  const la = legal(), p = pub();
  if (!la || !p || !canAggro()) return;
  command({ type: p.currentBet === 0 ? "bet" : "raise", amount: Math.round(app.bet) });
}
export function preset(kind: "min" | "all" | number): void {
  const la = legal(), p = pub(), y = you();
  if (!la || !p || !y) return;
  const me = p.seats[y.seat];
  app.bet = presetTotal(la, me ? me.roundCommit : 0, p.pot, kind);
}
export function nudgeBet(dir: number): void {
  const la = legal(), p = pub();
  if (!la || !p) return;
  const step = Math.max(1, (p as unknown as { config?: { bigBlind?: number } }).config?.bigBlind ?? 100);
  app.bet = Math.max(la.minimumAmount, Math.min(la.maximumAmount, Math.round(app.bet + dir * step)));
}
/** A new turn (or a changed range) puts the slider back in range, at the minimum when below it (table.js renderActionBar). */
function syncBet(): void {
  const la = legal();
  if (!la) return;
  const k = `${la.minimumAmount}:${la.maximumAmount}`;
  if (k !== app.betFor) {
    app.betFor = k;
    if (!app.bet || app.bet < la.minimumAmount) app.bet = la.minimumAmount;
  }
  app.bet = Math.max(la.minimumAmount, Math.min(la.maximumAmount, app.bet));
}

// ------------------------------------------------------------------ chat and voice
export function sendChat(): void {
  const c = app.chat;
  const text = app.chatDraft.trim();
  if (!c || !text) return;
  if (c.send(text)) app.chatDraft = "";
}
export function hasOtherHumans(): boolean {
  const p = pub();
  const me = platform.userId();
  return !!p && p.seats.some((s) => !!s.userId && s.userId !== me && !s.left);
}
export function toggleVoice(): void {
  const v = app.voice, c = app.chat;
  if (!v) return;
  if (v.enabled) void v.disable();
  else if (c?.conversationId && hasOtherHumans()) void v.enable(c.conversationId).then(() => v.setMuted(app.voiceMuted));
}
export function toggleMute(): void {
  app.voiceMuted = !app.voiceMuted;
  app.voice?.setMuted(app.voiceMuted);
}

// ------------------------------------------------------------------ leaderboard and replays
export function showLeaderboard(): void {
  app.boardPage = 1;
  app.board = null;
  show("leaderboard", "btn-board-back");
  loadBoard();
}
export function loadBoard(): void {
  app.boardStatus = () => T("Loading…");
  const page = app.boardPage, friends = app.boardFriends;
  platform.boardPage(page, 10, friends).then((r) => {
    if (app.screen !== "leaderboard" || page !== app.boardPage || friends !== app.boardFriends) return;
    if (r === "none") { app.board = null; app.boardStatus = () => T("No leaderboard is provisioned for this game yet."); return; }
    app.board = r;
    const total = r.total;
    app.boardStatus = r.rows.length ? () => T("{n} players", { n: total }) : () => T("No entries yet — play a match.");
  }, (e: unknown) => {
    const error = errText(e);
    app.boardStatus = () => T("Could not load the leaderboard: {error}", { error });
  });
}
export function turnBoard(d: number): void { app.boardPage = Math.max(1, app.boardPage + d); loadBoard(); }
export function toggleBoardFriends(): void { app.boardFriends = !app.boardFriends; app.boardPage = 1; loadBoard(); }

export function showReplays(): void {
  app.replayItems = null;
  app.replayStatus = () => T("Loading…");
  show("replays", "btn-replays-back");
  platform.replayList().then((items) => {
    app.replayItems = items;
    app.replayStatus = items.length ? null : () => T("No finished matches yet.");
  }, (e: unknown) => {
    const error = errText(e);
    app.replayStatus = () => T("Could not load replays: {error}", { error });
  });
}
export function openReplay(sessionId: string): void {
  const view: ReplayView = { engine: null, result: null, status: () => T("Loading replay…"), handIdx: 0, stepIdx: 0, steps: [], playing: false, speed: 1, nextAt: 0 };
  app.replay = view;
  show("replay", "btn-replay-back");
  platform.replayDetail(sessionId).then((d) => {
    if (app.replay !== view) return;
    const state = d.state as { matchResult?: { winnerName?: string } } | null;
    if (!state) throw new Error(T("Replay unavailable"));
    view.engine = new ReplayEngine(state, pokerRules);
    view.result = (d.result as { winnerName?: string } | null) || state.matchResult || null;
    view.status = null;
    goHand(0);
  }).catch((e: unknown) => {
    if (app.replay !== view) return;
    const error = errText(e);
    view.status = () => T("Could not load the replay: {error}", { error });
  });
}
export function goHand(i: number): void {
  const v = app.replay;
  if (!v || !v.engine) return;
  v.handIdx = Math.max(0, Math.min(i, v.engine.handCount() - 1));
  v.steps = v.engine.stepsForHand(v.handIdx);
  v.stepIdx = 0;
}
export function goStep(i: number): void {
  const v = app.replay;
  if (!v || !v.engine) return;
  v.stepIdx = Math.max(0, Math.min(i, v.steps.length - 1));
  if (v.playing && v.stepIdx >= v.steps.length - 1) {
    if (v.handIdx < v.engine.handCount() - 1) goHand(v.handIdx + 1);
    else v.playing = false;
  }
}
export function togglePlay(): void {
  const v = app.replay;
  if (!v) return;
  v.playing = !v.playing;
  v.nextAt = now() + 0.9 / v.speed;
}
export function setSpeed(s: number): void {
  const v = app.replay;
  if (!v) return;
  v.speed = s;
  v.nextAt = now() + 0.9 / s;
}
/** Per-seat win chances at the shown step (computed off the game's thread; null while it works). */
export function stepEquity(): (number | null)[] | null {
  const v = app.replay;
  if (!v || !v.engine) return null;
  const step = v.steps[v.stepIdx];
  if (!step || !step.holes) return null;
  const holes = step.holes.map((h: number[] | null, i: number) => (h && !step.folded[i] ? h : null));
  return equity.get(holes, step.board);
}

// ------------------------------------------------------------------ keys and pads
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  if (app.screen === "menu") menu3d.skip();
  if (app.screen !== "table") return;
  if (!fresh()) return;
  // Enter and Space on a focused widget are its own; the table's shortcuts are letters, digits, arrows and the pad.
  switch (a) {
    case "fold": act("fold"); break;
    case "check_call": actCheckCall(); break;
    case "bet_raise": actBetRaise(); break;
    case "all_in": act("all-in"); break;
    case "bet_more": nudgeBet(1); break;
    case "bet_less": nudgeBet(-1); break;
    case "preset_min": preset("min"); break;
    case "preset_half": preset(0.5); break;
    case "preset_three": preset(0.75); break;
    case "preset_pot": preset(1); break;
    case "preset_all": preset("all"); break;
    case "chat": if (app.online && app.chat) { app.chatOpen = true; app.focusNext = "chat-field"; app.openedFrame = frame().frame; } break;
    default: break;
  }
});
// Any press or key skips the casino flight (menu3d.js onSkip).
onKey((e) => { if (e.pressed && app.screen === "menu") menu3d.skip(); });
onPointerButton((e) => { if (e.pressed && app.screen === "menu") menu3d.skip(); });
onTouch((e) => { if (e.phase === "start" && app.screen === "menu") menu3d.skip(); });
onPointerMove((x, y) => {
  const f = frame();
  if (f.width > 0 && f.height > 0) menu3d.setPointer((x / f.width) * 2 - 1, (y / f.height) * 2 - 1, primaryPointer() === "fine");
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  const look = lookFor(f.quality, f.levelIndex);
  table3d.applyLook(look);
  menu3d.applyLook(look);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  const rm = preferences().reducedMotion;
  table3d.setReducedMotion(rm);
  menu3d.setReducedMotion(rm);
  applyLook();
  show("menu", platform.signedIn() ? "btn-quick" : "btn-play");
  void resume();
});
/** A room the player still holds a seat in drops them back into its lobby or table; an invite's session opens at once. */
async function resume(): Promise<void> {
  if (!platform.signedIn()) return;
  const room = await platform.myRoom();
  if (room && app.screen === "menu" && !app.busy) { enterRoom(room); return; }
  const launch = launchContext();
  if (launch?.sessionId && app.screen === "menu" && (await platform.launchSession(launch.sessionId))) {
    enterOnlineTable({ id: "", status: "playing", gameSessionId: launch.sessionId, participants: [] } as unknown as Room);
  }
}
platform.onPlayer(() => {
  if (!platform.signedIn() && (app.online || app.lobby || app.screen === "leaderboard" || app.screen === "replays" || app.screen === "replay")) {
    if (app.lobby) { app.lobby.close(); app.lobby = null; }
    goMenu();
  }
  if (platform.signedIn() && app.screen === "menu") { app.notice = null; void resume(); }
});
onPreferencesChange((p) => { table3d.setReducedMotion(p.reducedMotion); menu3d.setReducedMotion(p.reducedMotion); });
onSessionEnded((reason) => {
  app.notice = reason === "expired" ? () => S("expired") : reason === "terms-required" ? () => S("termsRequired") : () => S("signedOut");
  if (app.screen !== "table" || app.online) goMenu(app.notice);
});

onFixedUpdate(() => {
  steps++;
  clockMs += 1000 / 60;
  if (app.offline && app.screen === "table") app.offline.update();
});

let frameDt = 0;
let lastVersion = -1;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  audio.update();
  if (app.online) app.online.update();
  pollInvites();
  const m = tableModel();
  if (m) {
    const { sounds, announcements } = m.take();
    for (const s of sounds) audio.play(s as audio.Cue);
    // The newest line only (an AI-only stretch plays many hands a second).
    if (announcements.length) announce((announcements[announcements.length - 1] as Text)());
    if (m.version !== lastVersion && m.pub) {
      lastVersion = m.version;
      table3d.update(m.pub as PublicState, m.you as You | null);
    }
    syncBet();
  }
  if (app.tableError && app.tableError.until < now()) app.tableError = null;
  const r = app.replay;
  if (app.screen === "replay" && r && r.playing && now() >= r.nextAt) {
    r.nextAt = now() + 0.9 / r.speed;
    goStep(r.stepIdx + 1);
  }
});
/** The stage rectangle the HUD leaves (window px), set by screens.ts. */
export const stage = { x: 0, y: 0, width: 0, height: 0 };
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
onRender(() => {
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  const f = frame();
  table3d.frameUpdate(frameDt, f.width, f.height, stage);
  menu3d.frameUpdate(frameDt, f.width, f.height);
});
