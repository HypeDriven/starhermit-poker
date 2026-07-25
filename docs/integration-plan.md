# StarHermit Poker — Integration Plan

Source of truth: https://wiki.starhermit.com/ (pages live under `/docs/api/*.html` and `/docs/tutorials/*`).
Verified 2026-07-24 against the live wiki (initial pass + full re-verification the same day after an API doc update). The chess reference (`HypeDriven/starhermit-chess`) is the canonical pattern: no-build static site + one server-side JS rules file.

Re-verification deltas (2026-07-24, second pass):
- Tick service wording changed — see limitation #2 below.
- `manifest owner`: `2712e04e-461b-4d23-81ae-e40b429128a8`.
- Confirmed additions that do not change the design: share-invite-link section on the games page (`https://dashboard.starhermit.com/game-invite/<userId>/<gameSlug>`), `game_invite` push over the invitee's chat socket (launch tokens can't use it — keep polling `GET /rooms/invites` and `GET /api/v1/me/game-invites`), `replays/mine` list DTO includes `moveCount` and `limit` clamps to 1–50, invite DTO/status enums, room invite DTO `{id, roomId, gameSlug, fromUserId, fromUsername, toUserId, status, createdAt}` with statuses `pending|accepted|declined|expired`, party-pinning seat rule, idempotent `/start`, `backfillAfterSeconds` default 30, host-routed result score clamp 0–50, realtime text control frames ≤4 KB with server-side `from` re-tagging, voice `VoiceRoomDto` participants shape, profile avatar constraints (PNG square ≤512 px ≤1 MB), leaderboard definition DTO, GitHub-game claim/transfer/browse endpoints.
- Achievements re-verified: still client-reported unlocks only, no script hook; limitation #1 stands unchanged.

## 1. Architecture summary

**Client**: no-build static site served from the repo at `<slug>.starhermit.com`, same-origin `/api` and `/ws` (no CORS, no API-base config). ES modules loaded directly by the browser; three.js via CDN import map renders the 3D poker table; DOM/CSS overlays for lobby, chat, controls. Responsive down to 320 CSS px.

**Server authority**: `server.js` at repo root (declared via `server=server.js` in `starhermit.txt`), executed per-invocation in a fresh sandboxed Jint engine. Exposes `globalThis.game = { createSession, onPlayerMessage, onTick }` and `globalThis.pokerRules` (pure functions, no host dependencies, loaded by both the script sandbox and the Node test harness via `vm`). No `Date`, no `Math.random`, no imports — clock from `ctx.now`, randomness stretched from the single `ctx.random` float via an internal seeded PRNG.

**Lobby**: StarHermit realtime rooms (`/api/v1/realtime/rooms`, `ws/v1/realtime`). `teamCount: 1`, `seatsPerTeam: 6`, poker config in `config.metadata`. Quick Play = `POST /rooms/quick-join` (`{gameSlug, seats: 1}`), `404` → create + `POST /rooms/{id}/open`. Private Table = create room (stays `Lobby`), friend invites via `POST /rooms/{id}/invites`, share link `https://dashboard.starhermit.com/game-invite/<userId>/<slug>`. Host starts via `POST /rooms/{id}/start`; backfill worker auto-starts open rooms at deadline. Empty seats at start become AI seats automatically.

**Gameplay**: when the room enters `Playing`, the platform creates a room-bound scripted session; the roster push and room DTO carry `gameSessionId`. Clients connect `ws/v1/games?sessionId=<id>` and immediately send `{"type":"cmd","data":{"type":"sync"}}` on every open. Realtime WS stays open for roster/presence. All poker rules, cards, pots, timers, AI, stats, Elo live in `server.js`.

**Privacy**: script builds a public projection + one private projection per human; delivered only via addressed `broadcast` entries (`{to:[userId], data}`). Raw session state is never broadcast. Automated tests scan outgoing payloads for hidden-card/deck leakage.

**Reconnect**: on startup `GET /rooms/mine`; if non-`Closed`, restore lobby/table, reconnect realtime WS, and if `gameSessionId` exists connect gameplay WS + sync. Newest socket supersedes the old (platform closes the stale one with `PolicyViolation`).

**Chat**: REST polling only (`ws/v1/chat` is blocked for launch tokens). `GET /api/v1/chat/conversations/{chatConversationId}/messages?page=1&pageSize=50` every 5 s with client-side dedupe; `POST` `{content}` to send; 10 msg/min cap. `chatConversationId` from `GET /api/v1/games/{slug}/sessions/{sessionId}`.

**Voice**: opt-in, default off. `GET /api/v1/voice/rooms?conversationId=` → create if none → `POST /rooms/{id}/join` (required before WS) → `ws/v1/voice?roomId=`. WebRTC P2P via `rtc` signaling frames; relayed Opus binary fallback. Disabled when no other human is at the table. Full media/peer cleanup on disable/leave.

**Profiles**: session-scoped cache; `GET /api/v1/users/{id}/profile` (nickname), `GET /api/v1/users/{id}/avatar` (PNG bytes); fallback `"Player " + id.slice(0,8)`; AI seat nicknames come from the room roster.

**Stats/Elo**: script-owned `playerStates` documents (`elo`, `wins`, `losses`, `draws` + poker stats, capped recent-match list). Multiplayer Elo by final placement, written only via `eloUpdates`. Leaderboard reads: `GET /api/v1/leaderboards/{leaderboardId}/entries?friendsOnly=&page=&pageSize=` (`leaderboardId` from `GET /api/v1/games/{slug}`).

**Replays**: platform archives the final `sessionState`; the script embeds a compact, size-capped hand/action log in state. Viewer fetches `GET /api/v1/games/{slug}/replays/mine` + `/replays/{sessionId}` and reconstructs hands using the shared `pokerRules` module. Reveal policy: only cards shown at showdown (or voluntarily shown) are visible in replays.

## 2. Existing repository state

The repository is **empty** (git repo, no commits on disk, no files). There is no existing framework, build system, component structure, formatting, or test convention to preserve. Conventions chosen (mirroring the chess reference):

- No-build static site, plain ES modules, three.js from CDN import map.
- `node:test` + `vm` for tests (zero dependencies); `server.js` stays a plain script so it loads identically in Jint and in Node's `vm`.
- No formatter/linter configured → code style: 2-space indent, single quotes kept consistent per file; `node --check` for syntax validation.

## 3. Files to add

| File | Purpose |
|---|---|
| `starhermit.txt` | Manifest: name/slug/launch/owner/server |
| `server.js` | Authoritative Jint game script + `globalThis.pokerRules` |
| `index.html` | Entry point, import map (three.js), screen containers |
| `css/style.css` | All styling, responsive to 320 px |
| `src/config.js` | Single game-configuration module (blinds, stacks, timers, profiles) |
| `src/net.js` | Token capture/refresh, JWT decode, REST client, WS URL builder, reconnect backoff |
| `src/realtime-room.js` | Room REST + realtime WS controller (lobby, roster, presence) |
| `src/game-socket.js` | Gameplay WS controller (sync, cmd, state versions, resync) |
| `src/profiles.js` | Profile/avatar cache |
| `src/chat.js` | Chat polling + send UI logic |
| `src/voice.js` | Voice room + WebRTC/relay controller |
| `src/lobby.js` | Main menu, quick play, private table, invites |
| `src/table.js` | Table screen orchestration, action controls |
| `src/table3d.js` | three.js table/seat/card rendering |
| `src/leaderboard.js` | Global + friends leaderboard |
| `src/replays.js` | Replay list + viewer (uses shared rules) |
| `src/app.js` | Screen router, lifecycle cleanup, boot/reconnect flow |
| `test/*.test.js`, `test/harness.js` | node:test suites + seeded ctx adapters |
| `README.md` | Local dev, deployment, API notes, protocol, security review, limitations |

## 4. Documented StarHermit constraints affecting design

1. **Achievements are client-reported** (`POST /api/v1/me/achievements/unlock`, requires catalog entitlement) and the wiki explicitly says scripted GitHub games typically don't use them; there is no script-side unlock hook. Server-authoritative unlocks are **not possible** in this architecture. We ship a centralized achievement config and document this limitation; unlock claims are derived from script-emitted evidence in broadcasts/replays, never from raw local state.
2. **Tick service** (re-verified 2026-07-24): the current game-scripts page documents only a timer service — **per-game default every 300 s; platform sweep default 60 s, minimum 15 s**. The earlier `GameDefinition.TickRateHz`/30 Hz/1–1000 Hz wording no longer appears there (the realtime page still references `TickRateHz`, a dangling cross-reference — the "Room-bound sessions" section it points to is also missing from the current game-scripts page, though `ctx.room`/`ctx.presence` remain the documented contract). `ctx.inputs[]` batching is no longer documented either (unused by poker). Consequence: **turn-timeout enforcement granularity equals the tick interval**; with default sweeps a 30 s deadline fires 15–60 s late. Mitigation: the script enforces expired deadlines at the top of every invocation (`onPlayerMessage` and `onTick`), so any activity resolves timeouts; **deployment should request the fastest available sweep (15 s) or an operator-configured faster tick for `poker`.**
3. **`ctx.random` is one float per invocation** — stretched via an internal PRNG seeded from it (plus monotonic counters) for shuffles and AI variation. No `Math.random`.
4. **Playing-room host sweep**: a `Playing` room is closed if its host has had no active WS for > 60 s. Host migration happens on explicit leave; clients must keep the realtime socket alive. Documented platform behavior, not game logic.
5. **No public-room browse endpoint** — discovery is `quick-join` only; Quick Play falls back to create+open on `404`.
6. **Room invites are friends-only**; the dashboard share link is the documented route for non-friends.
7. **Replay = final sessionState snapshot only**; hand history must live inside session state, compacted and size-capped (per-player state byte budget is documented but unquantified).
8. **Chat has no incremental-fetch parameter** — poll and dedupe by message id; 10 msg/min/user.
9. **Ready state exists only as a realtime WS control frame** (`{"type":"ready"}`) — no REST field; lobby ready indicators are transient/host-observed.
10. **One active room per user** (`409` otherwise) — reconnect path is `GET /rooms/mine`.
11. **`teamCount` max 2**; FFA is exactly `teamCount: 1`. `seatsPerTeam` 1–11 → 6 seats fits.
12. **ws/v1/games frames ≤ 16 KB text**; projections must stay compact.
13. **`summary` contract is fixed** (`turnPlayerId`, `deadline`, `status`, `moveCount`); for AI-only acting seats `turnPlayerId` is `null` (AI seats have no user id and are not session players).

## 5. Raise convention

`bet`/`raise` `amount` = **the player's new total contribution for the current betting round** (not amount-added). Enforced identically in server validation, client controls, tests, action history, and replay rendering.

## 6. Checkpoint order

1. ✅ Inspect repository + write this plan.
2. ✅ Manifest + networking layer (`starhermit.txt`, `index.html` shell, `src/config.js`, `src/net.js`) + test harness skeleton.
3. ✅ Auth/launch-token handling + boot flow (local-dev auth panel fallback).
4. ✅ Realtime room creation + lobby UI.
5. Friend invites + quick join (quick join landed early in checkpoint 4; invites remain).
6. Minimal room-bound `server.js` (session create, sync, projections, summary).
7. Gameplay WS + synchronization client.
8. Deck/dealing + private-state projections (+ leak tests).
9. Betting engine.
10. Side pots + showdown (evaluator).
11. Turn timers.
12. AI seats (conservative/balanced/aggressive).
13. Full table UI (three.js + DOM controls).
14. Chat. 15. Voice. 16. Profiles. 17. Stats + leaderboard. 18. Replays.
19. Achievements (config + documented limitation only).
20. Full test + security pass.
21. Deployment docs (README).

After each checkpoint: `node --check` on all JS, run `node --test`, report files changed / commands run / failures, and a manual verification procedure against `http://localhost:5000`.
