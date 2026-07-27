# StarHermit Poker

Multiplayer no-limit Texas Hold'em for the [StarHermit](https://wiki.starhermit.com/)
platform: 2–6 seats, play-money chips, server-authoritative rules, AI backfill,
private tables, quick-join matchmaking, chat, optional voice, profiles,
leaderboards, and hand replays.

Chips have no monetary value. They cannot be purchased, redeemed, withdrawn,
transferred between accounts, or traded; they are a score inside a single
table's match and nothing else.

## Architecture

- **Client** — no-build static site (`index.html` + ES modules, three.js via
  CDN import map). Served same-origin at the game's StarHermit subdomain with
  `/api` and `/ws` proxied; no CORS, no API-base configuration in production.
- **Server authority** — `server.js`, a single JavaScript file executed per
  invocation in the platform's sandboxed Jint engine. It owns the deck,
  dealing, betting, side pots, hand evaluation, showdown, turn timers, AI
  players, statistics, Elo, and match results. The browser is never
  authoritative for cards, randomness, legal actions, stacks, pots, winners,
  ratings, or results.
- **Lobby** — StarHermit realtime rooms (`teamCount: 1`, `seatsPerTeam: 6`,
  poker config in room metadata). Quick Play = `POST /rooms/quick-join`
  (404 → create + open). Private tables = lobby-state rooms with friends-only
  invites + the dashboard share link. Empty seats at start are backfilled
  with AI automatically; departed humans convert to AI seats in place.
- **Invites** — `POST /rooms/{id}/invites` (friends-only, `Lobby`/`Open` only)
  reserves the seat *and* notifies the friend: the platform emits the
  `game_invite` push StarHermit shows as a dashboard toast ("*friend* invites
  you to their table in *game*") and lists in `GET /api/v1/me/game-invites`. The
  response's `notified` says whether that reached a live connection, which the
  lobby surfaces to the host (`inviteFriend` in `src/lobby.js`). Accepting from
  the dashboard seats the player, so they land in this table's lobby on launch —
  no `#session_id=` deep link involved. Do not send a games-API invite
  (`/games/poker/invites`) alongside the room invite: same notification, so the
  friend would be told twice.
- **Gameplay** — once the room reports `gameSessionId`, clients play over
  `ws/v1/games` with `cmd`/`game` frames; the realtime socket stays open for
  roster and presence.

## Repository layout

| Path | What it is |
|---|---|
| `starhermit.txt` | Platform manifest (name/slug/launch/owner/server) |
| `server.js` | The entire server-authoritative game (Jint script) + shared `pokerRules` |
| `index.html` | Entry point (import map; loads `server.js` for replay rules) |
| `src/` | Client modules (net, rooms, game socket, table, chat, voice, …) |
| `test/` | `node:test` suites; `server.js` is loaded via `vm` exactly as the sandbox sees it |
| `docs/integration-plan.md` | Verified API contract notes and checkpoint plan |

## Local development

1. Run the StarHermit backend locally (`http://localhost:5000`, or `5050` in
   some setups).
2. Serve this repo: `python3 -m http.server 8080` (any static server works).
3. Open `http://localhost:8080/index.html` — with no `#game_token` in the URL
   the local-dev auth panel appears. Paste a full platform JWT, keep the API
   base at `http://localhost:5000`, and mint a launch token. The token is
   cached in `sessionStorage` for the tab (documented dev pattern);
   production tokens never touch storage.
4. Two browsers (or an incognito window) can share a table: Quick Play joins
   the same open room; Private Table + friend invite works between two
   accounts that are friends.

Tests and checks:

```bash
npm test          # node --test test/*.test.js (140 tests, zero dependencies)
node --check server.js && for f in src/*.js; do node --check "$f"; done
```

The test harness (`test/harness.js`) drives the script with deterministic
`ctx.now`/`ctx.random` adapters; production randomness comes only from the
host-provided `ctx.random`.

## Deployment

1. Push the repo (manifest at the root: `starhermit.txt`).
2. Link your GitHub identity on StarHermit, then register the game:
   `POST /api/v1/me/github-games` with `{ "repoUrl": "https://github.com/HypeDriven/starhermit-poker" }`.
3. Enable hosting: `PUT /api/v1/me/github-games/{id}/hosting` `{ "enabled": true }`.
4. Pin a commit: `PUT /api/v1/me/github-games/{id}/deployment` `{ "commit": "<sha>" }`;
   poll `GET .../deployment` until live. The game is served at its hosted URL
   and launched by the platform with `#game_token=<jwt>`.
5. **Turn timers**: the platform's timer service drives `onTick` (per-game
   default 300 s, platform sweep 60 s, minimum 15 s). Timeout enforcement also
   happens lazily on every invocation, but for prompt 30-second turn clocks,
   ask the operator to schedule the fastest available sweep for `poker`.

## Protocol (client ↔ `server.js`)

Commands (inside `{"type":"cmd","data":…}`): `sync`, `fold`, `check`, `call`,
`bet`, `raise`, `all-in` (with `stateVersion` for stale rejection), plus
`sit-out-next-hand` and `show-cards` preferences.

**Raise convention**: `bet`/`raise` `amount` is the player's *new total
contribution for the current betting round* — everywhere: server validation,
client slider/presets, action history, replays.

Broadcasts: `state` (per-player addressed projection — the only live message
that carries hole cards, and only the recipient's), `action`, `hand-started`,
`hand-complete`, `match-complete`. Raw session state is never broadcast. Deck,
burn cards, and every other player's hole-card values are structurally absent
from all live payloads, including showdown and previous-hand summaries. The
server computes winners and keeps reveal evidence for archived post-match
replays; it never places opponent card values in the active table's memory.

The full protocol contract is documented at the top of `server.js`.

## Security review

- Identity comes only from the platform-authenticated `ctx.message.from`;
  payloads carrying user ids/seeds/results/elo are ignored (tested).
- Every command is validated server-side: turn order, integer chip bounds,
  stack limits, min-raise/reopening rules, match-over/eliminated/AI-converted
  rejection, stale `stateVersion`, duplicate commands.
- Prototype-pollution keys are never merged into state; untrusted input is
  read field-by-field (tested).
- State documents are complete replacements, JSON-serializable, with capped
  logs/history (tested for bounds).
- Client rendering is `textContent`-only (no HTML injection via chat or
  nicknames); tokens are read from the URL hash once, stripped with
  `history.replaceState`, kept in memory, and refreshed 15 min before expiry.
- WebSockets: one logical socket per channel with 1 s→30 s exponential
  backoff; the platform supersedes stale connections; gameplay re-syncs on
  every open.

## Known limitations

- **Achievements are not unlocked.** StarHermit achievements are
  client-reported against catalog titles and scripted games have no
  script-side unlock hook (verified in the wiki); a client-claimed unlock
  would be exploitable. `src/achievements.js` holds the catalog and a pure
  derivation from script-authoritative evidence for future use.
- **Turn-timeout granularity** equals the platform tick interval (see
  Deployment §5); with default sweeps a 30 s deadline may fire late.
- **Voice fallback**: the server-relayed Opus binary path is not implemented;
  voice requires WebRTC-capable browsers (all modern browsers).
- **Ready state is transient** (realtime control frames only — the platform
  exposes no ready field), so late joiners see others as unready until a new
  signal.
- **Playing-room host sweep**: the platform closes a Playing room when its
  host has had no active WebSocket for 60 s. The client keeps the realtime
  socket open during play; host migration happens on explicit leave.
