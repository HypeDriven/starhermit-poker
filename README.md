# StarHermit Poker

Multiplayer no-limit Texas Hold'em for the [StarHermit](https://wiki.starhermit.com/)
platform: 2–6 seats, play-money chips, server-authoritative rules, AI backfill,
private tables, quick-join matchmaking, chat, optional voice, profiles,
leaderboards, and hand replays.

Chips have no monetary value. They cannot be purchased, redeemed, withdrawn,
transferred between accounts, or traded; they are a score inside a single
table's match and nothing else.

## Architecture

- **Client** — a StarHermit engine script game (`native/*.ts` on the host API, engine 1.22.0, minor 20), played
  natively in the StarHermit client and in browsers through the engine's web runtime (`index.html` is the loader
  `npm run package` writes). See `spec.md`.
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
| `starhermit.txt` | Manifest (engine pin, controls, `server=server.js`) |
| `server.js` | The entire server-authoritative game (Jint script) + shared `pokerRules` |
| `native/` | The engine client (screens, 3D table and casino, platform, audio) |
| `src/` | Pure modules shared with the node tests (offline table, online clients, table model, strings) |
| `tests/` | `node:test` suites, `tests/native/*.play` and `tests/online/*.play` play scripts, `tests/native.mjs` |
| `tools/` | Packaging, CSS conversion, texture baking, browser and online checks |

## Local development

```bash
npm run package       # writes index.html + starhermit-files.json (after every change)
npm test              # node tests + native checks (tsc, starhermit check, play scripts)
npm run test:online   # online tables on the runtime's local platform, refereed by server.js
npm run test:browser  # the web package in Chrome on the GPU (desktop, phone, landscape)
```

`STARHERMIT` names the runtime (default `~/sh/runtime/1.22.0/.../starhermit`). Run the game with
`starhermit .` (signed out: the offline table), or `starhermit . --dev --local-platform --player NAME` to play
online tables against a local platform that runs `server.js`.

## Deployment

1. Push the repo (manifest at the root: `starhermit.txt`).
2. Link your GitHub identity on StarHermit, then register the game:
   `POST /api/v1/me/github-games` with `{ "repoUrl": "https://github.com/HypeDriven/starhermit-poker" }`.
3. Enable hosting: `PUT /api/v1/me/github-games/{id}/hosting` `{ "enabled": true }`.
4. Pin a commit: `PUT /api/v1/me/github-games/{id}/deployment` `{ "commit": "<sha>" }`;
   poll `GET .../deployment` until live. The game is served at its hosted URL
   and launched by the platform with `#game_token=<jwt>`.
5. **Turn timers**: `server.js` declares `game.tickRateHz: 1`, so the platform's
   timer service drives `onTick` with one-second sweeps and timeout enforcement
   (also applied lazily on every invocation) fires within ~1 s of a deadline —
   no operator sweep request needed.

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
- **Turn-timeout granularity** equals the declared tick interval — `tickRateHz: 1`
  means ≤ 1 s (see Deployment §5).
- **Voice fallback**: the server-relayed Opus binary path is not implemented;
  voice requires WebRTC-capable browsers (all modern browsers).
- **Ready state is transient** (realtime control frames only — the platform
  exposes no ready field), so late joiners see others as unready until a new
  signal.
- **Playing-room host sweep**: the platform closes a Playing room when its
  host has had no active WebSocket for 60 s. The client keeps the realtime
  socket open during play; host migration happens on explicit leave.
