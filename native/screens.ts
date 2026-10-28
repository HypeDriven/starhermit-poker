// The browser build's DOM screens (src/offline.js, lobby.js, table.js,
// leaderboard.js, replays.js and css/style.css) as starhermit:ui, built every
// frame: the menu over the casino (title, the account line, the actions, How
// to play, the AI-opponent stepper, the room-invite inbox, the skip hint, the
// notes), the table lobby (status, the seat grid with the host's AI moves,
// Ready / Start / Open / Leave, friend invites and the share link), the table
// (the status bar with Leave and Settings, the seat panels and the pot over
// the 3D stage, the action bar, the feed, voice and chat), the leaderboard and
// the replay list and viewer. The old media queries are layouts picked by the
// window's logical size: wide (≥ 760 px: the action bar's buttons beside the
// bet controls), phone (a stacked action bar; 2 × 2 buttons at ≤ 420 px) and
// short landscape (≤ 500 px tall: the action bar beside the stage). Settings
// opens the runtime's Options (graphics, sound, language, controls), which
// replaced the old Settings panel.
import { frame, openMenu } from "starhermit:engine";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { seatUnit, seatVisual, seatName } from "../src/table-utils.js";
import { actionLabels, seatBadges, tableStatus } from "../src/table-model.js";
import { REPLAY_SPEEDS } from "../src/replay-engine.js";
import { serverMessage } from "../src/i18n.js";
import { N, Num, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as menu3d from "./menu3d.ts";
import {
  act, actBetRaise, actCheckCall, answerInvite, app, canAggro, copyInvite, copyShareLink, fresh, goHand, goMenu, goOnline,
  goStep, hasOtherHumans, later, leaveTable, legal, lobbyInvite, lobbyLeave, lobbyOpen, lobbyStart, myId, openReplay, preset, pub,
  rematch, sendChat, setSpeed, showLeaderboard, showReplays, signIn, stage, startOffline, stepAi, stepEquity, tableModel,
  toggleBoardFriends, toggleHelp, toggleMute, togglePlay, toggleVoice, turnBoard, you,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; sx: number; sy: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  return { lw: Math.max(1, (f.width - sa.left - sa.right) / sc), lh: Math.max(1, (f.height - sa.top - sa.bottom) / sc), sc, sx: sa.left, sy: sa.top };
}
const lastSize = new Map<string, { w: number; h: number }>();
function remember(key: string, r: ui.Rect, sc: number): void { lastSize.set(key, { w: r.width / sc, h: r.height / sc }); }
function sizeOf(key: string, w = 0, h = 0): { w: number; h: number } { return lastSize.get(key) ?? { w, h }; }
function textWidth(text: string, style: string | ui.Style | (string | ui.Style)[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: style as ui.Style }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; selected?: boolean; aria?: string }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): ui.Rect | null {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  const s: ui.Style = width != null ? { width } : {};
  if (width != null && buttonWidth(b.text, style) > width) {
    const inner = Math.max(20, width - 26);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  }
  // A glyph button keeps its spoken name (aria) and shows the glyph in the button's own text style.
  if (b.aria && !opts.content) opts.content = () => ui.label(b.text);
  if (ui.style(style, s).id(b.id).button(b.aria ?? b.text, opts) && fresh()) later(b.act);
  return null;
}
/** Buttons at their own widths in rows that wrap at `width`. */
function flow(label: string, list: Btn[], width: number, gap = 10, justify: "start" | "center" | "end" = "start"): ui.Rect {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  return ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button(b, bw(b) >= width ? width : null);
    }, { spacing: gap, width, justify }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "body", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
/** A note on its dark backing (.main-menu.cinematic p.muted): centred, wrapping inside its padding. */
function note(text: string, width: number, cls: string, id: string): void {
  const inner = Math.min(width - 26, textWidth(text, cls) + 2);
  ui.column(id, () => {
    if (textWidth(text, cls) <= width - 26) ui.style({ text: { align: "center" } }).label(text);
    else ui.style({ text: { align: "center" } }).paragraph(text, inner);
  }, { style: cls, align: "center" });
}
function heading(cls: string, text: string, width: number): void {
  if (textWidth(text, cls, "heading") <= width) ui.style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
function badge(id: string, cls: string, text: string): void {
  ui.column(id, () => ui.style("badge-text").label(text), { style: cls, align: "center" });
}
/** A full-window box: a placed role-"none" widget, so it covers what was built before it and takes no pointer. */
function backdrop(cls: string, clipOut?: { x: number; y: number; width: number; height: number }): void {
  const f = frame(), sc = ui.preferences().scale;
  ui.place("backdrop", { anchor: "top-start", x: -f.safeArea.left / sc, y: -f.safeArea.top / sc }, () => {
    ui.widget("", {
      role: "none", size: { width: f.width / sc, height: f.height / sc }, draw: () => {
        if (!clipOut) { draw.box(0, 0, f.width, f.height, cls); return; }
        // The page around the stage (the 3D table shows through the stage's rectangle).
        const s = clipOut;
        const bands = [
          { x: 0, y: 0, width: f.width, height: s.y },
          { x: 0, y: s.y + s.height, width: f.width, height: f.height - s.y - s.height },
          { x: 0, y: s.y, width: s.x, height: s.height },
          { x: s.x + s.width, y: s.y, width: f.width - s.x - s.width, height: s.height },
        ];
        for (const b of bands) if (b.width > 0 && b.height > 0) draw.box(0, 0, f.width, f.height, cls, { clip: b });
      },
    });
  });
}
/** A panel centred in the window, scrolling inside when taller than it. */
function page(key: string, L: Layout, build: (w: number) => void, width: number, cls: string | null = "screen-panel"): void {
  const pad = cls ? (L.lw < 420 ? 14 : 20) : 0;
  const outer = Math.min(width, L.lw - (cls ? 24 : 32));
  const avail = Math.max(80, L.lh - 24);
  const h = sizeOf(key).h;
  const scroll = h > avail;
  const inner = outer - 2 * pad - (cls ? 2 : 0) - (scroll ? 14 : 0);
  const opening = frame().frame - app.openedFrame <= 6;
  ui.place(`page-${key}`, "center", () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner), { ...(cls ? { style: cls } : {}), width: outer - (scroll ? 14 : 0), spacing: 12, padding: pad, align: "center" });
      remember(key, r, L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  switch (app.screen) {
    case "menu": page("menu", L, (w) => menuScreen(w, L), 1000, null); break;
    case "lobby": backdrop("page-bg"); page("lobby", L, (w) => lobbyScreen(w, L), 992); break;
    case "table": tableScreen(L); break;
    case "leaderboard": backdrop("page-bg"); page("board", L, (w) => boardScreen(w), 640); break;
    case "replays": backdrop("page-bg"); page("replays", L, (w) => replaysScreen(w), 640); break;
    case "replay": backdrop("page-bg"); page("replay", L, (w) => replayScreen(w), 640); break;
  }
  const f = frame();
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the menu
const HAND_RANKINGS = [N("Royal flush — A K Q J 10, one suit"), N("Straight flush — five in sequence, one suit"),
  N("Four of a kind"), N("Full house — three of a kind plus a pair"), N("Flush — five of one suit"),
  N("Straight — five in sequence"), N("Three of a kind"), N("Two pair"), N("One pair"), N("High card")];
function helpPanel(w: number): void {
  const inner = w - 36;
  ui.column("help", () => {
    heading("h2", T("Texas Hold'em in a minute"), inner);
    para(T("Everyone gets two private cards. Five shared cards arrive in three deals (flop, turn, river). Make the best five-card hand from any of the seven; the best hand — or the last player who has not folded — wins the pot."), inner, "help-text");
    para(T("Each betting round you can Fold (give up the hand), Check/Call (match the current bet), Bet/Raise (put in more) or go All-in."), inner, "help-text");
    heading("h3", T("Hand rankings, best to worst"), inner);
    HAND_RANKINGS.forEach((k, i) => para(`${i + 1}. ${T(k)}`, inner, "help-text", `rank-${i}`));
  }, { style: "help-panel", width: w, spacing: 6 });
}
function menuScreen(full: number, L: Layout): void {
  const signed = platform.signedIn();
  const titleText = "StarHermit Poker";
  // The gold title on one line (a wrapped title loses its gradient): the big face when it fits, else scaled to fit.
  const big = textWidth(titleText, "title", "heading");
  const small = textWidth(titleText, "title-small", "heading");
  ui.column("menu-head", () => {
    if (big <= full) ui.style("title").heading(titleText);
    else ui.style("title-small", { text: { size: Math.max(18, Math.floor(38 * Math.min(1, (full - 4) / small))), letterSpacing: small > full ? 2 : 4.5 } }).heading(titleText);
  }, { width: full, align: "center" });
  const w = Math.min(full, 672);
  if (signed) {
    const me = platform.standing();
    ui.row("player-chip", () => {
      const av = platform.avatarImage();
      if (av) ui.widget("", { role: "none", size: { width: 28, height: 28 }, draw: (r) => draw.image(av, r.x, r.y, r.width, r.height) });
      ui.style("player-chip").label(platform.nameOf(platform.userId(), null));
    }, { spacing: 8, align: "center" });
    note(me && me.elo !== undefined
      ? T("Elo {elo} · {w}W / {l}L / {d}D", { elo: me.elo, w: me.wins ?? 0, l: me.losses ?? 0, d: me.draws ?? 0 })
      : T("No-limit Texas Hold'em · play money only"), w, "menu-note-bold", "menu-line");
  } else {
    note(T("No-limit Texas Hold'em. Play an offline table against five AI opponents — no sign-in needed."), w, "menu-note", "menu-line");
  }
  if (app.notice) note(app.notice(), w, "menu-note-bold", "menu-notice");
  const btns: Btn[] = signed ? [
    { id: "btn-quick", text: T("Quick Play"), style: "btn-cine-primary big", act: () => goOnline("quick"), disabled: app.busy },
    { id: "btn-private", text: T("Private Table"), style: "btn-cine big", act: () => goOnline("private"), disabled: app.busy },
    { id: "btn-board", text: T("Leaderboard"), style: "btn-cine", act: showLeaderboard },
    { id: "btn-replays", text: T("Replays"), style: "btn-cine", act: showReplays },
    { id: "btn-help", text: T("How to play"), style: "btn-cine", act: toggleHelp, selected: app.helpOpen },
    ...(platform.inviteLink() ? [{ id: "btn-invite", text: S("invite"), style: "btn-cine", act: copyInvite }] : []),
    { id: "btn-settings", text: T("Settings"), style: "btn-cine", act: () => openMenu() },
  ] : [
    { id: "btn-play", text: T("Play"), style: "btn-cine-primary big", act: startOffline },
    { id: "btn-signin", text: S("signIn"), style: "btn-cine", act: signIn },
    { id: "btn-help", text: T("How to play"), style: "btn-cine", act: toggleHelp, selected: app.helpOpen },
    { id: "btn-settings", text: T("Settings"), style: "btn-cine", act: () => openMenu() },
  ];
  flow("menu-actions", btns, w, 12, "center");
  if (app.status) note(app.status(), w, "menu-note-small", "menu-status");
  if (app.helpOpen) helpPanel(Math.min(w, 640));
  if (signed) {
    ui.row("ai-stepper", () => {
      ui.style("menu-note-small").label(T("AI opponents"));
      if (ui.style("btn-cine").id("ai-less").button(T("Fewer AI opponents"), { content: () => ui.label("−") }) && fresh()) later(() => stepAi(-1));
      ui.style("ai-count").label(String(app.aiCount));
      if (ui.style("btn-cine").id("ai-more").button(T("More AI opponents"), { content: () => ui.label("+") }) && fresh()) later(() => stepAi(1));
    }, { spacing: 10, align: "center" });
    if (app.invites.length) {
      const iw = Math.min(w, 560);
      ui.column("invites", () => {
        heading("h2", T("Table invites"), iw - 34);
        for (const inv of app.invites) {
          ui.row(`inv-${inv.id}`, () => {
            ui.style("body", { text: { overflow: "ellipsis" } }).label(T("{name} invites you to a table", { name: inv.fromUsername || T("A friend") }));
            ui.spacer();
            button({ id: `inv-acc-${inv.id}`, text: T("Accept"), style: "btn-primary btn-small", act: () => answerInvite(inv, true), disabled: app.busy });
            button({ id: `inv-dec-${inv.id}`, text: T("Decline"), style: "btn btn-small", act: () => answerInvite(inv, false), disabled: app.busy });
          }, { style: "invite-row", spacing: 8, width: iw - 34, align: "center" });
        }
      }, { style: "invite-inbox", width: iw, spacing: 4 });
    }
    if (menu3d.flying()) note(T("Click anywhere to skip the intro"), w, "menu-note-small", "skip-hint");
    note(T("Choosing N AI opponents deals you in against exactly N of them. With 0 the table seats 6: invites and matchmaking fill it, and seats still empty at start become AI. In the lobby the host can tap an AI seat, then an empty seat, to move it."), w, "menu-note-small", "menu-ai-note");
  } else {
    note(T("Sign in with StarHermit to play online tables, with friends or against AI, on the leaderboard."), w, "menu-note-small", "menu-online-note");
  }
  if (app.error) para(app.error(), w, "error", "menu-error");
  void L;
}

// ------------------------------------------------------------------ the lobby
function lobbyScreen(w: number, L: Layout): void {
  const l = app.lobby;
  if (!l) return;
  const room = l.room;
  heading("h1", T(l.visibility === "private" ? "Private table" : "Public table"), w);
  if (l.unavailable) {
    ui.column("lobby-stop", () => para(T("This table is no longer available — leave it to return to the menu."), w - 26, "body"), { style: "online-stop", width: w });
  }
  const parts: string[] = [];
  if (room.status) parts.push(T("Status: {status}", { status: T("room." + room.status.charAt(0).toUpperCase() + room.status.slice(1)) }));
  const participants = l.participants;
  parts.push(T("{n}/{total} seats", { n: participants.length, total: l.seatCount }));
  if (room.status === "open") parts.push(T("open for matchmaking (AI backfill ~{s}s after opening)", { s: room.backfillAfterSeconds ?? 45 }));
  if (!l.connected && !l.unavailable) parts.push(T("reconnecting…"));
  para(parts.join(" · "), w, "muted", "lobby-status");
  // The seat grid (three across, two on narrow screens).
  const cols = L.lw < 480 ? 2 : 3;
  const cw = (w - (cols - 1) * 10) / cols;
  const seats: { seat: number; participant: (typeof participants)[number] | null }[] = Array.from({ length: l.seatCount }, (_, i) => ({ seat: i, participant: null }));
  for (const p of participants) if (Number.isInteger(p.slot) && p.slot >= 0 && p.slot < l.seatCount) seats[p.slot] = { seat: p.slot, participant: p };
  const arrange = l.canArrange;
  ui.grid("seat-grid", () => {
    for (const { seat, participant: p } of seats) {
      if (!p) {
        if (arrange && l.selectedAi) {
          if (ui.style("seat-drop", { width: cw }).id(`seat-${seat}`).button(T("Seat {n}", { n: seat + 1 }), {
            content: () => { ui.style("seat-name").label(T("Seat {n}", { n: seat + 1 })); ui.style("small").label(T("Tap to place AI")); },
            tooltip: T("Place the selected AI here"),
          }) && fresh()) later(() => void l.placeAi(seat));
        } else {
          ui.column(`seat-${seat}`, () => {
            ui.style("seat-name").label(T("Seat {n}", { n: seat + 1 }));
            ui.style("small").label(T("Empty — AI at start"));
          }, { style: ["seat", "seat-empty"], width: cw, spacing: 5, tooltip: T("Empty seats become AI when the table starts") });
        }
        continue;
      }
      const self = !!p.userId && p.userId === platform.userId();
      const name = p.isAi || !p.userId ? (p.displayName || T("AI")) : platform.nameOf(p.userId, p.displayName || p.username);
      if (p.isAi && arrange) {
        const picked = l.selectedAi === p.id;
        if (ui.style(picked ? "seat-picked" : "seat-move", { width: cw }).id(`seat-${seat}`).button(name, {
          content: () => {
            ui.style("seat-name", { text: { overflow: "ellipsis" } }).label(name);
            ui.row(`seat-${seat}-b`, () => { badge(`seat-${seat}-ai`, "badge-ai", T("badge.ai")); if (picked) badge(`seat-${seat}-mv`, "badge-move", T("badge.move")); }, { spacing: 5 });
          },
          tooltip: picked ? T("Tap again to put it back") : T("Select this AI, then tap an empty seat to move it"),
        }) && fresh()) later(() => l.pickAi(p.id));
        continue;
      }
      const online = l.isOnline(p);
      const ready = l.isReady(p);
      ui.column(`seat-${seat}`, () => {
        ui.style("seat-name", { text: { overflow: "ellipsis" } }).label(name);
        ui.row(`seat-${seat}-b`, () => {
          if (p.isHost) badge(`seat-${seat}-h`, "badge-host", T("badge.host"));
          if (p.isAi) badge(`seat-${seat}-a`, "badge-ai", T("badge.ai"));
          if (ready) badge(`seat-${seat}-r`, "badge-ready", T("badge.ready"));
          if (!online) badge(`seat-${seat}-o`, "badge-offline", T("badge.offline"));
        }, { spacing: 5 });
      }, { style: ["seat", ...(self ? ["seat-self"] : []), ...(online ? [] : ["seat-offline"])], width: cw, spacing: 5 });
    }
  }, { columns: cols, gap: 10, width: w });
  // Ready, the host's Start and Open, Leave.
  const host = l.host;
  const acts: Btn[] = [
    { id: "btn-ready", text: l.selfReady ? T("badge.ready") + " ✓" : T("Ready"), act: () => l.sendReady(), disabled: l.selfReady },
    ...(host ? [{ id: "btn-start", text: T("Start table"), style: "btn-primary", act: lobbyStart, disabled: !l.canStart }] : []),
    ...(host && room.status === "lobby" ? [{ id: "btn-open", text: T("Open to matchmaking"), act: lobbyOpen }] : []),
    { id: "btn-lobby-leave", text: T("Leave table"), act: lobbyLeave },
  ];
  flow("lobby-actions", acts, w, 10);
  if (app.lobbyError) para(app.lobbyError(), w, "error", "lobby-error");
  // Invites (friends only, while the room is in the lobby or open).
  if (room.status === "lobby" || room.status === "open") {
    ui.column("invite-section", () => {
      heading("h2", T("Invite players"), w);
      if (platform.shareLink()) button({ id: "btn-share", text: T("Copy share link"), act: copyShareLink });
      const friends = app.friends;
      if (friends === undefined) para(T("Loading friends…"), w, "small");
      else if (friends === null) para(T("Could not load the friend list."), w, "small");
      else if (!friends.length) para(T("No friends yet — use the share link to invite someone."), w, "small");
      else for (const f of friends) {
        const invited = l.pendingInvites.has(f.userId);
        const name = platform.nameOf(f.userId, f.username);
        ui.row(`friend-${f.userId}`, () => {
          ui.widget("", { role: "none", size: { width: 9, height: 9 }, draw: (r) => draw.circle(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, f.online ? "#4caf7d" : "#555555") });
          ui.style("body", { text: { overflow: "ellipsis" } }).label(name);
          if (f.currentGame) ui.style("small").label(T("playing {game}", { game: f.currentGame }));
          ui.spacer();
          button({ id: `invite-${f.userId}`, text: invited ? T("Invited ✓") : T("Invite"), style: "btn btn-small", act: () => lobbyInvite(f), disabled: invited });
        }, { style: "friend-row", spacing: 10, width: w, align: "center" });
      }
      if (app.shareNote) para(app.shareNote(), w, "small", "share-note");
    }, { style: "section-top", width: w, spacing: 8 });
  }
}

// ------------------------------------------------------------------ the table
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["♣", "♦", "♥", "♠"];
export function cardName(c: number): string { return `${RANKS[c % 13]}${SUITS[(c / 13) | 0]}`; }
/** A small paper card (.pcard): its rank and suit in the suit's colour. */
function pcard(id: string, c: number, big = false): void {
  const red = ((c / 13) | 0) === 1 || ((c / 13) | 0) === 2;
  const detailed = frame().quality !== "low";
  ui.column(id, () => ui.style(big ? (red ? "pcard-big-red" : "pcard-big-black") : (red ? "pcard-red" : "pcard-black")).label(cardName(c)),
    { style: detailed ? "pcard-detailed" : "pcard", align: "center" });
}
type Mode = "wide" | "phone" | "short";
function tableMode(L: Layout): Mode {
  if (L.lh <= 500 && L.lw > L.lh) return "short";
  return L.lw >= 760 ? "wide" : "phone";
}
function tableScreen(L: Layout): void {
  const f = frame();
  const mode = tableMode(L);
  const pad = mode === "wide" ? 10 : 6;
  const gap = mode === "short" ? 6 : 8;
  // The status bar, then the bottom block (or the side column in short landscape); the stage takes the rest.
  const top = sizeOf("tbar", 0, 34).h;
  const sideW = mode === "short" ? Math.min(330, Math.max(250, L.lw * 0.4)) : 0;
  const bottom = mode === "short" ? 0 : sizeOf("tbottom", 0, mode === "wide" ? 150 : 290).h;
  const sx = pad, sy = pad + top + gap;
  const sw = L.lw - 2 * pad - (sideW ? sideW + gap : 0);
  const sh = Math.max(120, L.lh - sy - pad - (bottom ? bottom + gap : 0));
  stage.x = L.sx + sx * L.sc; stage.y = L.sy + sy * L.sc; stage.width = sw * L.sc; stage.height = sh * L.sc;
  backdrop("page-bg", stage);
  // The stage's frame (its border and the faint top light / bottom shade over the 3D view).
  ui.place("stage-frame", { anchor: "top-start", x: sx, y: sy }, () => {
    ui.widget("", { role: "none", size: { width: sw, height: sh }, draw: (r) => { draw.box(r.x, r.y, r.width, r.height, "stage-shade"); draw.box(r.x, r.y, r.width, r.height, "stage-frame"); } });
  });
  seatPanels(L, mode, sx, sy, sw, sh);
  centerInfo(L, mode, sx, sy, sw, sh);
  // The status bar: Leave (start), the hand and street (centre), Settings (end).
  ui.place("tbar", { anchor: "top-start", x: pad, y: pad }, () => {
    const r = ui.row("tbar-row", () => {
      button({ id: "btn-leave", text: T("Leave table"), style: "pill", act: () => (app.offline ? goMenu() : leaveTable()) });
      ui.spacer();
      const m = tableModel();
      const stopped = app.online?.stopped ? T("connection closed") : "";
      const leaveW = buttonWidth(T("Leave table"), "pill");
      const setW = buttonWidth(mode === "phone" && L.lw < 560 ? "⚙" : `⚙ ${T("Settings")}`, "pill");
      ui.style("table-status", { width: Math.max(40, L.lw - 2 * pad - leaveW - setW - 40), text: { overflow: "ellipsis" } })
        .label(tableStatus(m?.pub, { reconnecting: !!app.online && !app.online.connected && !app.online.unavailable, stopped }));
      ui.spacer();
      const compact = mode === "phone" && L.lw < 560;
      button({ id: "btn-table-settings", text: compact ? "⚙" : `⚙ ${T("Settings")}`, ...(compact ? { aria: T("Settings") } : {}), style: "pill", act: () => openMenu() });
    }, { width: L.lw - 2 * pad, align: "center", spacing: 8 });
    remember("tbar", r, L.sc);
  });
  if (mode === "short") {
    ui.place("tside", { anchor: "top-start", x: pad + sw + gap, y: sy }, () => {
      ui.column("tside-col", () => {
        actionBar(sideW, "short");
        voiceRow(sideW);
        feed(sideW, 2);
      }, { width: sideW, spacing: 6 });
    });
  } else {
    const bw = L.lw - 2 * pad;
    ui.place("tbottom", { anchor: "top-start", x: pad, y: sy + sh + gap }, () => {
      const r = ui.column("tbottom-col", () => {
        actionBar(bw, mode);
        if (mode === "wide") {
          ui.row("tbelow", () => {
            ui.column("feed-col", () => feed(bw - 330 - 12, 3), { width: bw - 330 - 12 });
            voiceRow(330);
          }, { width: bw, spacing: 12 });
        } else {
          voiceRow(bw);
          feed(bw, 3);
        }
      }, { width: bw, spacing: gap });
      remember("tbottom", r, L.sc);
    });
  }
  chatDialog(L);
  void f;
}

/** The seat panels over the stage, each where its seat sits on the table's ellipse (kept inside the stage). */
function seatPanels(L: Layout, mode: Mode, sx: number, sy: number, sw: number, sh: number): void {
  const m = tableModel();
  const p = pub();
  if (!m || !p) return;
  const y0 = you();
  const youSeat = y0 && y0.seat >= 0 ? y0.seat : 0;
  const n = p.seats.length || 6;
  const reveal = m.reveal() as Record<number, number[]> | null;
  const secs = m.secondsLeft();
  const small = mode !== "wide";
  const me = myId();
  for (const s of p.seats) {
    const v = seatVisual(s.seat, youSeat, n);
    const { x, y } = seatUnit(v, n);
    const key = `seatp-${s.seat}`;
    const size = sizeOf(key, small ? 70 : 90, small ? 56 : 66);
    const halfW = size.w / 2 + 2, halfH = size.h / 2 + 2;
    const cx = Math.max(sx + halfW, Math.min(sx + sw - halfW, sx + (0.5 + x * 0.44) * sw));
    const cy = Math.max(sy + halfH, Math.min(sy + sh - halfH, sy + (0.5 + y * 0.44) * sh));
    const acting = s.seat === p.actingSeat;
    const self = !!me && s.userId === me;
    const dim = s.folded || s.eliminated;
    const name = s.ai || !s.userId ? seatName(s) : (app.offline ? seatName(s) : platform.nameOf(s.userId, s.name));
    const badges = seatBadges(s, p, { offline: !app.offline }) as string[];
    const fs = (base: number): ui.Style => (small ? { text: { size: base * 0.85 } } : {});
    ui.place(key, { anchor: "top-start", x: cx - size.w / 2, y: cy - size.h / 2 }, () => {
      const r = ui.column(`${key}-col`, () => {
        ui.style("seat-title", fs(12.2), { text: { overflow: "ellipsis" } }).label(name);
        ui.row(`${key}-stack`, () => { ui.style("seat-diamond").label("◆"); ui.style("seat-stack", fs(12.2)).label(Num(s.stack)); }, { spacing: 3, align: "center" });
        if (s.roundCommit > 0) ui.style("seat-bet", fs(11)).label(T("bet {n}", { n: Num(s.roundCommit) }));
        if (badges.length) ui.style("seat-flags", fs(10)).label(badges.join(" "));
        // The local player's own hole cards (only ever their own), and the showdown's revealed cards for a while.
        if (self && y0 && Array.isArray(y0.holeCards)) ui.row(`${key}-cards`, () => y0.holeCards!.forEach((c, i) => pcard(`${key}-c${i}`, c)), { spacing: 3 });
        const shown = reveal && reveal[s.seat];
        if (shown) ui.row(`${key}-reveal`, () => shown.forEach((c, i) => pcard(`${key}-r${i}`, c)), { spacing: 3 });
      }, {
        style: [self ? "seat-panel-self" : "seat-panel", ...(acting ? ["seat-panel-acting"] : []), ...(dim ? ["seat-dim"] : [])],
        align: "center", spacing: 0, ...(small ? { padding: { top: 4, bottom: 4, start: 6, end: 6 } } : {}),
      });
      remember(key, r, L.sc);
    });
    if (acting && secs !== null) {
      ui.place(`${key}-timer`, { anchor: "top-start", x: cx + size.w / 2 - 26, y: cy - size.h / 2 - 8 }, () => {
        ui.column(`${key}-timer-col`, () => ui.style("seat-timer-text").label(`${secs}s`), { style: "seat-timer", align: "center" });
      });
    }
  }
}

/** The pot above the community cards (never on their faces), the match's result, and a stopped table's notice. */
function centerInfo(L: Layout, mode: Mode, sx: number, sy: number, sw: number, sh: number): void {
  const p = pub();
  const stopped = !!app.online?.stopped;
  const cw = Math.min(sw - 20, 420);
  const k = "center";
  const sz = sizeOf(k, 120, 30);
  const frac = mode === "phone" ? 0.31 : 0.27;
  const cy = mode === "short" ? Math.max(sy + sh * 0.24, sy + 86) : sy + sh * frac;
  ui.place(k, { anchor: "top-start", x: sx + (sw - sz.w) / 2, y: cy - Math.min(sz.h, 34) / 2 }, () => {
    const r = ui.column(`${k}-col`, () => {
      if (stopped) ui.column("stop-note", () => para(T("This table is no longer available — leave it to return to the menu."), cw - 26, "body"), { style: "online-stop", width: cw });
      if (!p) return;
      ui.column("pot", () => ui.style("pot-text").label(T("Pot {n}", { n: Num(p.pot) })), { style: "pot", align: "center" });
      if (p.matchResult) {
        const r0 = p.matchResult;
        const winner = app.offline && r0.winnerUserId === "local-player" ? T("You") : (r0.winnerName || "–");
        ui.style("match-result").label(T("Winner: {name}", { name: winner }));
        if (app.lbLine) ui.style("match-lb").label(app.lbLine());
        if (app.offline) button({ id: "btn-rematch", text: T("New match"), style: "btn-primary", act: rematch });
      }
    }, { align: "center", spacing: 6 });
    remember(k, r, L.sc);
  });
}

/** The action bar: Fold, Check / Call, Bet / Raise, All-in, the bet slider with its amount, and the presets. */
function actionBar(w: number, mode: Mode): void {
  const la = legal();
  const p = pub();
  const myTurn = !!la;
  const labels = actionLabels(la, p) as { checkCall: string; betRaise: string };
  const pad = mode === "short" ? 7 : 11;
  const inner = w - 2 * pad - 2;
  const buttons = (bw: number, perRow: number): void => {
    const list: Btn[] = [
      { id: "act-fold", text: T("Fold"), style: "act-fold", act: () => act("fold"), disabled: !myTurn || !la!.canFold },
      { id: "act-check", text: labels.checkCall, style: "act", act: actCheckCall, disabled: !myTurn || !(la!.canCheck || la!.callAmount > 0) },
      { id: "act-bet", text: labels.betRaise, style: "act-primary", act: actBetRaise, disabled: !myTurn || !canAggro() },
      { id: "act-allin", text: T("All-in"), style: "act", act: () => act("all-in"), disabled: !myTurn || la!.canAllIn === false || la!.maximumAmount <= 0 },
    ];
    const g = 8;
    const cw = (bw - (perRow - 1) * g) / perRow;
    ui.column("act-buttons", () => {
      for (let r = 0; r < list.length / perRow; r++) {
        ui.row(`act-r${r}`, () => { for (const b of list.slice(r * perRow, r * perRow + perRow)) button(b, cw); }, { spacing: g, width: bw });
      }
    }, { spacing: g, width: bw });
  };
  const betControls = (bw: number): void => {
    const amountW = 76;
    ui.row("bet-row", () => {
      const sw = bw - amountW - 10;
      if (myTurn && la) {
        const v = ui.id("bet-slider").slider(T("Bet or raise total"), app.bet, { min: la.minimumAmount, max: Math.max(la.minimumAmount + 1, la.maximumAmount), step: 1, width: sw });
        if (v !== app.bet && fresh()) later(() => { app.bet = Math.max(la.minimumAmount, Math.min(la.maximumAmount, Math.round(v))); });
      } else {
        ui.widget("", { role: "none", size: { width: sw, height: 20 }, draw: (r) => draw.roundRect(r.x, r.y + r.height / 2 - 3, r.width, 6, 3, "#3a3a3a80") });
      }
      ui.style("bet-amount", { width: amountW }).label(myTurn ? Num(app.bet) : "");
    }, { spacing: 10, width: bw, align: "center" });
    const presets: [string, () => void][] = [
      ["preset.min", () => preset("min")], ["preset.half", () => preset(0.5)], ["preset.three-quarters", () => preset(0.75)],
      ["preset.pot", () => preset(1)], ["preset.all-in", () => preset("all")],
    ];
    const pw = (bw - 4 * 5) / 5;
    ui.row("bet-presets", () => {
      for (const [key, fn] of presets) button({ id: `p-${key}`, text: T(key), style: "preset", act: fn, disabled: !myTurn }, pw);
    }, { spacing: 5, width: bw });
  };
  ui.column("action-bar", () => {
    if (mode === "wide") {
      const left = Math.round(inner * 0.45);
      ui.row("action-cols", () => {
        buttons(left, 4);
        ui.column("bet-controls", () => betControls(inner - left - 12), { width: inner - left - 12, spacing: 6 });
      }, { width: inner, spacing: 12, align: "center" });
    } else {
      const perRow = mode === "short" || w <= 420 ? 2 : 4;
      buttons(inner, perRow);
      betControls(inner);
    }
  }, { style: "action-bar", width: w, spacing: mode === "short" ? 6 : 8, padding: pad });
  if (app.tableError) para(serverMessage(app.tableError.text) as string, w, "error", "table-error");
}

/** The latest feed lines (newest first), cut to one line each. */
function feed(w: number, lines: number): void {
  const m = tableModel();
  if (!m) return;
  const items = (m.feed as { text: () => string; cls: string }[]).slice().reverse().slice(0, lines);
  ui.column("feed", () => {
    items.forEach((it, i) => {
      const win = it.cls === "win";
      ui.column(`feed-${i}`, () => ui.style(win ? "feed-win-text" : "feed-text", { text: { overflow: "ellipsis" } }).label(it.text()), { style: win ? "feed-win" : "feed-item", width: w });
    });
  }, { width: w, spacing: 4 });
}

/** Voice (default off; a microphone opt-in, once another human sits at the table), mute and the table chat (online tables). */
function voiceRow(w: number): void {
  if (!app.online) return;
  const v = app.voice;
  const enabled = !!v?.enabled;
  const others = hasOtherHumans();
  const list: Btn[] = [
    { id: "btn-voice", text: enabled ? T("Voice: on") : T("Voice: off"), style: "btn btn-small", act: toggleVoice, disabled: !enabled && (!others || !app.chat?.conversationId || !!v?.busy) },
    ...(enabled ? [{ id: "btn-mute", text: app.voiceMuted ? T("Unmute") : T("Mute"), style: "btn btn-small", act: toggleMute }] : []),
    { id: "btn-chat", text: app.chat && app.chat.lines.length ? `${T("Table chat")} (${app.chat.lines.length})` : T("Table chat"), style: "btn btn-small", act: () => { app.chatOpen = true; app.focusNext = "chat-field"; }, disabled: !app.chat?.ready },
  ];
  ui.column("voice-col", () => {
    flow("voice-row", list, w, 8, "end");
    if (enabled && v?.status) {
      const peers = v.status.participants;
      if (peers.length) ui.row("voice-peers", () => {
        for (const peer of peers) {
          ui.column(`peer-${peer.userId}`, () => ui.style("small-fg").label(`${peer.muted ? "🔇" : "🎙"} ${platform.nameOf(peer.userId, peer.username)}`),
            { style: peer.speaking ? "voice-peer-speaking" : "voice-peer" });
        }
      }, { spacing: 6 });
    }
    if (v?.error) para(T(v.error), w, "error", "voice-error");
    else if (!enabled && !others) para(T("Voice is available when another human is at the table"), w, "small", "voice-hint");
  }, { width: w, spacing: 6, align: "end" });
}

/** The table chat (the session's conversation): the latest messages, a field and Send. */
function chatDialog(L: Layout): void {
  if (!app.online || !app.chat) return;
  const c = app.chat;
  const w = Math.min(520, L.lw - 40);
  const open = ui.style("dialog").dialog(T("Table chat"), "", app.chatOpen, () => {
    ui.column("chat-body", () => {
      heading("h2", T("Table chat"), w);
      const listH = Math.min(260, Math.max(120, L.lh - 260));
      ui.scrollArea("chat-list", { width: w, height: listH }, () => {
        ui.column("chat-lines", () => {
          for (const line of c.lines) {
            ui.row(`chat-${line.id}`, () => {
              const who = platform.nameOf(line.who, null);
              ui.style(line.mine ? "chat-who-mine" : "chat-who").label(who);
              const tw = w - 30 - textWidth(who, "chat-who");
              if (textWidth(line.text, "chat-text") <= tw) ui.style("chat-text").label(line.text);
              else ui.style("chat-text").paragraph(line.text, Math.max(60, tw));
            }, { spacing: 6 });
          }
        }, { width: w - 16, spacing: 4 });
      }, { scrollTo: { top: Infinity } });
      if (c.error) para(T(c.error), w, "error", "chat-error");
      ui.row("chat-input", () => {
        app.chatDraft = ui.id("chat-field").textField(T("Chat message"), app.chatDraft, { maxChars: 2000, width: w - 100, placeholder: T("Message…") });
        if (ui.submitted("chat-field") || ui.submitted(T("Chat message"))) later(sendChat);
        button({ id: "btn-chat-send", text: T("Send"), style: "btn-primary btn-small", act: sendChat });
      }, { spacing: 8, width: w, align: "center" });
      button({ id: "btn-chat-close", text: T("Close"), act: () => { app.chatOpen = false; } });
    }, { width: w, spacing: 8 });
  });
  if (!open && app.chatOpen) app.chatOpen = false;
}

// ------------------------------------------------------------------ leaderboard and replays
function boardScreen(w: number): void {
  heading("h1", T("Leaderboard"), w);
  const me = platform.standing();
  if (me && me.elo !== undefined) para(T("You: elo {elo} · {w}W / {l}L / {d}D · {n} active", { elo: me.elo, w: me.wins ?? 0, l: me.losses ?? 0, d: me.draws ?? 0, n: 0 }), w, "muted", "board-me");
  button({ id: "btn-friends", text: app.boardFriends ? T("Friends: on") : T("Friends: off"), act: toggleBoardFriends, selected: app.boardFriends });
  if (app.boardStatus) para(app.boardStatus(), w, "muted", "board-status");
  const b = app.board;
  if (b) {
    ui.column("board-rows", () => {
      for (const r of b.rows) {
        ui.row(`row-${r.rank}`, () => {
          ui.style("lb-rank", { width: 52 }).label(`#${r.rank}`);
          ui.style("body", { text: { overflow: "ellipsis" }, width: w - 52 - 90 - 30 }).label(r.name);
          ui.spacer();
          ui.style("lb-score").label(Num(r.score));
        }, { style: r.you ? "lb-row-self" : "lb-row", width: w, spacing: 10 });
      }
    }, { width: w });
  }
  flow("board-pages", [
    { id: "btn-prev", text: T("‹ Prev"), act: () => turnBoard(-1), disabled: app.boardPage <= 1 },
    { id: "btn-next", text: T("Next ›"), act: () => turnBoard(1), disabled: !b || app.boardPage * 10 >= b.total },
  ], w, 10);
  button({ id: "btn-board-back", text: T("Back"), act: () => goMenu() });
}
function replaysScreen(w: number): void {
  heading("h1", T("Replays"), w);
  if (app.replayStatus) para(app.replayStatus(), w, "muted", "replays-status");
  for (const r of app.replayItems ?? []) {
    const names = r.players.map((p) => platform.nameOf(p.userId, p.username)).join(T(" vs "));
    const res = r.result as { winnerName?: string; hands?: number } | null;
    const result = res ? T("{name} won · {n} hands", { name: res.winnerName || T("Winner"), n: res.hands ?? "?" }) : T("finished");
    const date = r.finishedAt ? new Date(r.finishedAt).toISOString().slice(0, 10) : "";
    if (ui.style("replay-row", { width: w }).id(`replay-${r.sessionId}`).button(`${names} — ${result}`, {
      content: () => { ui.style("body", { text: { overflow: "ellipsis" } }).label(names); ui.style("small").label(`${result} · ${date}`); },
    }) && fresh()) later(() => openReplay(r.sessionId));
  }
  button({ id: "btn-replays-back", text: T("Back"), act: () => goMenu() });
}
function replayScreen(w: number): void {
  heading("h1", T("Replay"), w);
  const v = app.replay;
  if (!v) return;
  if (v.status) para(v.status(), w, "muted", "replay-status");
  const e = v.engine;
  if (!e) { button({ id: "btn-replay-back", text: T("Back"), act: showReplays }); return; }
  if (v.result) para(T("{name} won · {n} hands", { name: v.result.winnerName || T("Winner"), n: e.handCount() }), w, "muted", "replay-result");
  const step = v.steps[v.stepIdx];
  if (step) {
    ui.column("replay-pot", () => ui.style("pot-text").label(T("Pot {n}", { n: Num(step.pot) })), { style: "pot", align: "center" });
    ui.row("replay-board", () => (step.board as number[]).forEach((c, i) => pcard(`rb-${i}`, c, true)), { spacing: 5 });
    const eq = stepEquity();
    const cols = w < 420 ? 2 : 3;
    const cw = (w - (cols - 1) * 6) / cols;
    ui.grid("replay-seats", () => {
      e.seatMeta.forEach((meta: { name: string }, i: number) => {
        const cards = step.holes ? step.holes[i] : (step.reveal && step.reveal[i]);
        const folded = step.folded && step.folded[i];
        const pct = eq && eq[i] != null ? Math.round((eq[i] as number) * 100) : null;
        ui.column(`rs-${i}`, () => {
          ui.style("seat-title", { text: { overflow: "ellipsis", align: "start" } }).label(meta.name);
          ui.style("seat-stack", { text: { align: "start" } }).label(Num(step.stacks[i]));
          if (step.commits[i] > 0) ui.style("seat-bet", { text: { align: "start" } }).label(T("in for {n}", { n: Num(step.commits[i]) }));
          if (cards) ui.row(`rs-${i}-c`, () => (cards as number[]).forEach((c, k) => pcard(`rs-${i}-c${k}`, c)), { spacing: 3, style: folded ? "dim" : undefined } as ui.Layout);
          if (pct !== null) ui.style("equity").label(T("{pct}% to win", { pct }));
        }, { style: i === step.activeSeat ? "replay-seat-acting" : "replay-seat", width: cw, spacing: 2 });
      });
    }, { columns: cols, gap: 6, width: w });
    para(typeof step.label === "function" ? step.label() : String(step.label), w, "muted", "replay-step");
  }
  flow("replay-hands", [
    { id: "btn-first", text: T("⏮ First"), act: () => goHand(0) },
    { id: "btn-hand-prev", text: T("‹ Hand"), act: () => goHand(v.handIdx - 1) },
    { id: "btn-hand-next", text: T("Hand ›"), act: () => goHand(v.handIdx + 1) },
    { id: "btn-last", text: T("Last ⏭"), act: () => goHand(e.handCount() - 1) },
  ], w, 8);
  para(T("Hand {n}/{total}", { n: v.handIdx + 1, total: e.handCount() }), w, "muted", "replay-hand");
  ui.row("replay-steps", () => {
    button({ id: "btn-step-prev", text: "‹", aria: T("Previous step"), act: () => goStep(v.stepIdx - 1) });
    button({ id: "btn-play", text: v.playing ? T("⏸ Pause") : T("▶ Play"), act: togglePlay });
    button({ id: "btn-step-next", text: "›", aria: T("Next step"), act: () => goStep(v.stepIdx + 1) });
    const speeds = REPLAY_SPEEDS as number[];
    const idx = Math.max(0, speeds.indexOf(v.speed));
    const pick = ui.id("replay-speed").select(T("Replay speed"), idx, speeds.map((s) => `${s}×`));
    if (pick !== idx && fresh()) later(() => setSpeed(speeds[pick]!));
  }, { spacing: 8, align: "center" });
  button({ id: "btn-replay-back", text: T("Back"), act: showReplays });
}
