# StarHermit Poker — running spec

Multiplayer no-limit Texas Hold'em (2–6 seats, play-money chips) as a StarHermit engine script game, pinned to
engine 1.23.0 with `engine.minor=20` (strict three.js r185 parity). One package plays natively in the StarHermit
client and in browsers through the engine's web runtime (the loader `index.html` that `npm run package` writes).
`server.js` is the authoritative rules referee; this client only shows projections and sends commands.

## Files

| Path | What it is |
|---|---|
| `starhermit.txt` | Manifest: `server=server.js`, engine pin, capabilities (`platform,storage,clipboard,voice`), controls and gamepad defaults |
| `server.js` | The whole server-authoritative game (deck, betting, side pots, showdown, timers, AI seats, stats, Elo, match result, leaderboard scores) + the shared `pokerRules`. Unchanged by the port |
| `native/main.ts` | Entry: app state, screen flow, table commands, keys and pads, lifecycle, the fixed-step clock |
| `native/screens.ts` | Every screen in `starhermit:ui` |
| `native/table3d.ts` | The 3D table (`starhermit:scene`) |
| `native/menu3d.ts` | The cinematic casino behind the menu (`assets/casino.glb` + WGSL sky, beam, holo rings, dust, card cloud) |
| `native/platform.ts` | `starhermit:platform`: rooms/game-socket adapter, profiles, invites, friends, leaderboards, replays, chat, voice |
| `native/audio.ts` | The old WebAudio cues rendered into clips |
| `native/quality.ts` | The old Low/Balanced/High/Ultra presets and budgets per runtime quality tier |
| `native/classic.ts`, `native/equity.ts`, `native/equity-worker.js` | `server.js` loaded as a classic script; replay win chances on a worker |
| `native/i18n.ts`, `native/style.ts` | Strings in the runtime's interface language; the converted stylesheet |
| `src/offline.js` | The offline table: `server.js` driven locally on an injected clock and random source |
| `src/online.js` | Rooms lobby (`LobbyClient`), the server-refereed table client (`TableClient`), Quick Play / private tables / invites |
| `src/table-model.js` | The table as the client sees it: last projection, feed, reveal window, sound cues |
| `src/i18n.js`, `src/strings.js`, `src/platform-i18n.js` | Strings in nine locales (en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT) |
| `src/table-utils.js`, `src/replay-engine.js`, `src/menu3d-physics.js`, `src/achievements.js` | Pure helpers shared with the node tests |
| `assets/textures/` | Baked canvas textures (`tools/bake-textures.mjs`) |
| `assets/ui-style.json` | `tools/ui-style.css` converted by `starhermit css` (`npm run css`) |

## Screens

- **Menu** over the casino (the camera flies in from the entrance, then orbits the table; any press or key skips
  the flight; mouse devices get a little parallax). Signed out: the tagline, **Play** (the offline table), **Sign
  in with StarHermit** (the runtime's sign-in), **How to play**, **Settings** (the runtime's Options) and a note
  that online tables need a sign-in. Signed in: the player's avatar and name, Elo and record, **Quick Play**,
  **Private Table**, **Leaderboard**, **Replays**, **How to play**, **Invite a friend** (copies the invite link),
  **Settings**, the AI-opponent stepper (0–5), the room-invite inbox (polled every 5 s; Accept / Decline), the
  skip hint (hidden, keeping its room, once the flight ends) and the note on AI seats. A room the player still
  holds a seat in reopens its lobby or table at start; a launch for an invite's session opens that table.
- **Lobby** (realtime room): Private/Public table, the room status and seats, the seat grid (host, AI, ready,
  offline badges; the host taps an AI seat, then an empty seat, to move it), **Ready**, the host's **Start table**
  and **Open to matchmaking**, **Leave table**, and while the room is in the lobby or open: **Copy share link** and
  the friend list with **Invite** (room invites; StarHermit notifies the friend).
- **Table**: a status bar (Leave table · hand and street · Settings), the stage (the 3D table framed between the
  bars), seat panels at each seat's place on the ellipse (name, stack, bet, dealer/blind/AI/all-in/fold/out
  badges, the turn clock on the acting seat, the player's own hole cards, the showdown's revealed cards for 8 s),
  the pot above the community cards, the match's winner (offline: **New match**; online: the leaderboard rank
  line), the action bar (Fold, Check/Call N, Bet/Raise to, All-in, the bet slider with its amount, the Min / ½ Pot
  / ¾ Pot / Pot / All-in presets — the new-round-total convention), the latest three feed lines, and online:
  Voice on/off, Mute, the voice peers, and **Table chat** (a dialog with the session conversation's messages, a
  field and Send). Layouts: wide (≥ 760 logical px: buttons beside the bet controls), phone (stacked; 2 × 2
  buttons at ≤ 420 px) and short landscape (≤ 500 px tall: the action bar beside the stage).
- **Leaderboard** (the game's board, friends toggle, pages of 10), **Replays** (the player's finished matches)
  and the **replay viewer** (hand and step navigation, play/pause at 0.5–4×, every dealt hand shown, per-seat
  win chances computed on a worker).

## Controls

Keys (rebindable in the runtime's Options): F fold, C check/call, B bet/raise, A all-in, ↑/= and ↓/− change the
bet by a big blind, 1–5 the presets, T opens the table chat. Gamepad: West check/call, North bet/raise, Left
trigger fold, Right trigger all-in, shoulders change the bet, Select the chat; the D-pad/stick and South move and
press the UI's focus, East goes back. Every button takes the pointer, touch, or Tab and Enter.

## Play and the referee

- **Offline** (signed out): six seats (You + Ada, Ben, Cleo, Dex, Eva), 10,000 chips, blinds 50/100, 30 s turns.
  `server.js` runs in the client exactly as on the platform; its clock is the runtime's fixed steps and its
  random source is seeded from the step the match starts on, so a hidden window never runs the clock and play
  scripts replay exactly. A 1 Hz sweep enforces deadlines and lets AI seats act. Offline play is never recorded.
- **Online** (signed in): Quick Play joins an open table of this game, else creates a public one (N AI opponents
  seat a table of exactly 1 + N) and opens it for matchmaking; Private Table creates a lobby room. When the room
  plays, the platform binds a session of `server.js`: every client opens its game socket, sends `sync` on every
  (re)connection, and sends commands at most once a second (the session's 1 Hz tick). The script answers each
  player with its own projection (only their own hole cards). **Results, Elo and leaderboard scores are
  server-authoritative**: `server.js` returns the result, `eloUpdates` and `scores` (`match-wins` to the winner,
  `hands-won` to every seated player); no client posts anything. Hosted play without a server script is not
  recorded (this game always has one).
- Chat polls the session's conversation (the runtime's `ChatChannel`); voice joins its voice room (opt-in,
  needs another human at the table; microphone through the runtime's prompt).

## Look

The old three.js r166 scenes, ported: lights ÷ π (r155+ physical units), ACES 1.05 (table) / 1.0 (menu), the
runtime's GTAO, bloom (table threshold 1.5, menu 0.85, before tone mapping as the old composer bloomed linear
HDR), display-space grade (contrast 0.11, saturation 1.1, split tint, vignette 0.28) and antialiasing per tier;
RoomEnvironment reflections at environment intensity 0.42. Per tier (runtime quality → old preset): Low (Lambert,
128 px cards, no shadows/bloom/grade, plain table, static background), Balanced (Standard, 256 px cards, 1024
shadow map, bloom, grade, FXAA, detailed table), High (Physical, 2048 shadows, GTAO, SMAA, particles high),
Ultra (512 px cards, 2048 felt, 4096 shadows, GTAO high, MSAA). Star, mote and dust counts grow with the level
within a tier (≤ 2×). The runtime owns render scale, adaptive resolution and the frame-rate limit.

Card faces, felt, bumps, chips, the STARHERMIT print and the menu's holographic cards are baked once in Chrome
from the old canvas painters (`npm run textures`); one image per card, loaded when the card first shows. The
casino's Blender lights (KHR_lights_punctual, which the engine's loader refuses as a required extension) were
stripped from the file (`tools/strip-glb-lights.mjs`); the old code dropped them at load anyway.

## Sound

`sfx=synthesized`: the deal swish, card snap, chip clicks, win chime and turn blip are rendered sample by sample
from the old oscillator / band-passed-noise recipes into clips once the mixer runs, and play on the effects bus.
Volumes, mute and the voice limit are the runtime's Options (they replaced the table's Sound button).

## Platform and settings

The runtime's Options replace the old Settings panel (graphics, sound, frame rate, language, controls,
accessibility, report a problem). The browser build's account settings (`graphics`, `soundEnabled`,
`ui.language`) are legacy keys, removed once. There was no cloud save (Elo and stats are script-owned player
state), so nothing migrates. A session that ends (signed out, expired, terms) returns online screens to the menu
with a notice; offline play keeps working.

## Checks

- `npm run test:unit` — node tests: the rules/script suites (`tests/*.test.js` with `tests/harness.js`), the
  offline match, the online lobby and table against a fake platform running `server.js`, i18n coverage of every
  key used in `native/*.ts` and `src/*.js` in all nine locales.
- `npm run test:native` — the web index is up to date, `tsc`, `starhermit check` with no warnings, and the play
  scripts in `tests/native/` (desktop with How to play, a whole offline match and New match; a phone at DPR 3 by
  touch to the result; short landscape by keys).
- `npm run test:online` — `tests/online/*.play` on the runtime's local platform (`--dev --local-platform`): a
  private table with two AI opponents to the result, and two players meeting at a Quick Play table (desktop host,
  phone guest), both refereed by `server.js`.
- `npm run test:browser` — the web package in Chrome on the GPU at desktop, phone (DPR 3) and landscape (DPR 3):
  menu, Play, call/check and a ½-pot bet, shoving to the result, New match; fails on console errors.

## Known limitations

- **Ready can't be withdrawn**: the runtime's room socket sends only a ready signal (`sendReady()`), so the
  lobby's old Ready/Unready toggle is a one-way Ready.
- **Achievements are not unlocked** (scripted games have no script-side unlock hook; `src/achievements.js` keeps
  the catalog).
- The table's DOM-era rounded stage corners are square (the page around the 3D view is painted in bands).
- Sheen on the leather rail is not drawn (the engine's physical material draws clearcoat only).
- Turn-timeout granularity equals the script's 1 Hz tick.
