# StarHermit Poker — running spec

Architecture, protocol, security and deployment are described in `README.md`;
this file tracks the client-facing presentation.

## Graphics

The poker table is a three.js scene (`src/table3d.js`) under the DOM seat
panels, used by both the platform table and the offline table against AI (the
offline table falls back to the DOM-only board when WebGL or the three.js CDN
is unavailable). Lighting is ACES-filmic tone-mapped with sRGB output: a
hemisphere fill, a warm key spotlight whose PCF shadow frustum is fitted to the
table, and blue rim / warm side lights; the backdrop is a scene-space gradient
so the post chain grades it with the table. Optional effects: spotlight
shadows; image-based reflections from a `RoomEnvironment` PMREM; Detailed
table dressing (woven baize with fibre noise and a printed gold betting line,
bump-mapped padded leather rail with sheen and clearcoat, rounded lacquered
cards whose printed faces stay unlit for full contrast, striped clay chips
with inlaid faces and slightly uneven stacks, a warm spill-light pool on the
carpet, and card-stock styling on DOM cards); dust motes drifting in the key
light and twinkling stars (Particles); a gently shimmering key light, pulsing
acting-seat ring and animated backdrop (Background — static under
`prefers-reduced-motion`); GTAO contact shadows that ignore decals, glows and
the backdrop; bloom limited to HDR highlights (the acting-seat ring, strong
specular glints); a colour grade with vignette; and FXAA/SMAA/MSAA. The main
menu (platform and offline) shows the cinematic 3D casino (`src/menu3d.js`) and
honours render scale, anti-aliasing, bloom, grade, particles (dust and
floating-card count) and background (nebula/beam/holo-band animation).

Both scenes render through one pipeline (`src/gfx-pipeline.js`): pixel ratio
= min(device ratio, preset cap: Low 1, Balanced 1.5, High/Ultra 2) × preset
scale × render scale × adaptive scale; the post chain (RenderPass → GTAO →
UnrealBloom → OutputPass → grade → SMAA/FXAA) is built only when an effect
needs it and rebuilt when its settings or size change; canvas MSAA is used
when rendering directly. Adaptive resolution averages 90 frames and steps the
scale down by 0.1 (to 0.6) above 26 ms and back up by 0.05 below 14 ms. If
the post chain cannot be built or throws, the scene renders without it and the
Graphics panel says so.

A **Settings** button (main menu, and top-right of every table) opens a modal
Settings panel whose **Graphics** section offers: Quality (Auto — chosen from
the StarHermit hardware level below — plus Low, Balanced, High, Ultra); Render scale 50–200%; one
override per effect (Shadows off/low/medium/high, Ambient occlusion
off/on/high, Bloom, Colour grade, Anti-aliasing off/FXAA/SMAA/MSAA,
Reflections, Table detail plain/detailed, Particles low/high, Background
static/animated), each defaulting to "From preset (…)"; Adaptive resolution
(on by default); Show frame rate (off by default; a readout at the bottom
left that never takes pointer input); and a summary line "GPU · Level N ·
cost · W×H px" ("Level" localized). Choosing a preset clears the overrides. Changes apply immediately
and persist in `localStorage` (`poker.graphics`); `<body>` carries
`data-gfx-preset`, `data-gfx-detail` and `data-gfx-background`. The panel is
keyboard (focus trap, Escape closes), mouse and touch operable, scrolls inside
itself on short screens, and follows the game Language setting (all nine
locales); a language change relabels the open panel in place. The shared
Sound, Language and Report sections (`game-options.js`) mount inside the
Graphics section and stay mounted across a language change.

**Hardware-level detection.** `src/gpu-level.js` (shared StarHermit copy, `window.StarHermitGpu`, a classic
script loaded before `src/app.js`, never edited here) rates the WebGL unmasked renderer plus device facts
(`detectSystem()`: phone/tablet, cores, memory, screen) on the StarHermit hardware level 0–20 (0 = Galaxy S20 /
Intel UHD or weaker, every software renderer and no WebGL; 20 = RTX 5090; each level ≈ 1.23×; laptop parts two
levels below desktop; phones, tablets and ≤ 4 GB machines capped at 9). `src/gfx.js` maps it with
`presetForLevel(level, { low: 0, balanced: 4, high: 10, ultra: 17 })`, so Auto picks Ultra on strong GPUs;
adaptive resolution still steps down when slow. Headless SwiftShader is level 0 → Low. Phones and tablets pace
Auto FPS at half the display refresh rate ("Auto (half refresh rate)") and start at 16 simultaneous sounds
(shared `game-options.js`).

**Per-preset budgets** (`BUDGETS` / `budgetFor` / `particleCounts` in `src/gfx.js`). Each preset holds 60 FPS
on the weakest GPU Auto gives it — Low at level 0, Balanced 4, High 10, Ultra 17. Cards, chips, seats, the
action bar and the rules are identical on every preset; only visuals change. Star, mote and menu-dust counts
are tuned at the floor level and scale up within the preset on faster GPUs (`StarHermitGpu.scaleBudget`, ≤ 2×,
at most 720 / 720 / 2000; the point pools are allocated once at that size and drawn partially). A change of
shading, curve segments or texture sizes rebuilds the table surfaces and the card/chip resources live (plain
cards and chips now share their geometry and materials too).

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Table, card and chip shading | Lambert | Standard | Physical (clear-coated rail, cards, chips; leather sheen) | as High |
| Card-face texture (authored 256 × 356) | 128 px | 256 px | 256 px | 512 px |
| Chip-face texture | 64 px | 128 px | 128 px | 256 px |
| Printed felt texture (Detailed) / felt bump | 512 / 256 px | 1024 / 512 px | 1024 / 512 px | 2048 / 1024 px |
| Table ellipse curve segments (felt, rail, base, trims, floor) | 48 | 64 | 96 | 128 |
| Chip radial segments | 20 | 28 | 40 | 48 |
| Backdrop stars (Particles low: half) | 120 | 180 | 240 | 360 |
| Key-light dust motes (Particles high) | 80 | 140 | 220 | 360 |
| Menu casino dust (Particles low: 37 %) | 300 | 450 | 700 | 1000 |
| Bloom / GTAO resolution | ½ | ½ | ½ | full |

**Benchmark** (`node tools/gfx-bench.mjs poker`; hook `tests/gfx-bench.mjs` picks the preset in the menu's
Settings → Graphics, opens the offline 3D table against the AI with the primary Play button and keeps playing
hands through the visible action bar — check, call small bets, fold big ones, New match when one ends). Measured
2026-10-18 (GPU ms above the draws-skipped floor, projected to the preset's floor level; CPU p90 on the RTX 5090
run):

- Desktop 1920×1080: PASS low (typical 0.00 / slow 2.32 ms GPU, CPU 0.70 ms); PASS balanced (4.03 / 4.18, CPU
  0.90); PASS high (1.15 / 1.46, CPU 1.60); PASS ultra (2.60 / 2.94, CPU 1.50).
- Mobile 390×844 at DPR 3 (`--mobile --presets low,balanced`): PASS low (0.43 / 1.84, CPU 0.50); PASS balanced
  (0.00 / 0.65, CPU 0.80).

## Large screens

Above 1600×1000 the shared `ui-scale.js` sets `--ui-scale` (`min(w/1600, h/1000)`, capped at 2.5): `#app`, the body-level settings backdrop and the FPS meter are CSS-zoomed by it, vw/vh lengths inside them are divided by it, and the 3D menu/table canvases multiply their pixel ratio by it so they stay sharp. At 1600×1000 and below the layout is unchanged.

## File map (graphics)

| Path | What it is |
|---|---|
| `src/gpu-level.js` | Shared StarHermit hardware-level module (`window.StarHermitGpu`; copy of `tools/gpu-level.js`) |
| `src/gfx.js` | Pure quality model: presets, categories, `detectLevel`/`presetForLevel`/`detectPreset`, per-preset `BUDGETS`/`budgetFor`/`particleCounts`, `resolve`, `presetTier`, `choosePreset`, `describe`, `pixelRatio` |
| `src/gfx-settings.js` | Settings store: GPU probe and hardware level, `localStorage`, change listeners, `<body>` attributes, FPS readout |
| `src/gfx-pipeline.js` | Shared three.js renderer/post-processing/adaptive-resolution pipeline and the grade shader |
| `src/graphics-panel.js` | Settings button and the Settings → Graphics panel |
| `src/gfx-i18n.js` | Graphics panel strings for the nine supported locales (in the game language) |
| `tests/gfx.test.js` | Unit tests for the quality model and panel strings: hardware level → preset (SwiftShader/llvmpipe/no WebGL, AMD Radeon Graphics and Intel UHD → Low, Iris Xe → Balanced, GTX 1070 → High, RTX 4080/5090 → Ultra, phones such as Adreno 740 capped at Balanced), the budget table, the level label |
| `tests/gfx-bench.mjs` | Dev-only hook for `tools/gfx-bench.mjs` (the real-GPU 60 FPS benchmark) |

## StarHermit integration

- `index.html` loads the shared SDK `starhermit-sdk.js` (an unchanged copy of
  `tools/starhermit-sdk.js`) and calls `StarHermit.init()` before the app
  modules. The SDK reads `#game_token=` (plus `session_id`) or a sign-in
  return's `#access_token=`, strips it, and renews the token; `src/net.js`
  builds the net context on it (`tokenManager.token` reads the SDK's current
  token, the slug is the `game_scope` claim). A dev token minted in the auth
  panel is handed to the SDK too, with the dev API base.
- Every socket reconnect (gameplay `ws/v1/games` and the realtime-room
  socket) renews the launch token first via `StarHermit.renewForReconnect()`
  and reopens with a URL built from the current token; a transient renewal
  failure keeps backing off (1 s → 30 s) without reopening the old URL. After
  a successful renewal and before reopening, the socket checks over REST that
  its target still exists: the game session (`GET …/sessions/{id}`, gone on
  403/404/410 or a non-`active` status) or the room (`GET …/rooms/{id}`, gone
  on 403/404/410 or `Closed`); a network error there keeps retrying. A gone
  target ends the reconnect loop (`onUnavailable`): the table keeps its last
  view, the status line reads "connection closed" and a notice says the table
  is no longer available (leave it to return to the menu); the lobby shows the
  same notice and disables Start. The voice socket does not auto-reconnect
  (voice re-joins on the next enable).
- When a renewal answers `terms-required` (the player must accept updated
  StarHermit terms; the SDK emits `termsrequired`), every socket stops
  reconnecting (`onTermsRequired`) and the game returns to the local menu with
  "StarHermit needs you to accept its updated terms…" and **Back to
  StarHermit** (`StarHermit.relaunch()`); offline play keeps working.
- When renewal is refused the SDK signs out, sockets stop reconnecting and the
  game returns to the local menu with a notice; offline play keeps working.
  When the session expired the notice says so and a **Back to StarHermit**
  button relaunches through the StarHermit launcher (or sign-in for sign-in
  launches); if the browser refuses, the notice says to reopen the game from
  the library. These strings are localized in the nine supported locales.
- Local menu (no token): on `<id>.starhermit.com` it shows **Sign in with
  StarHermit**, which redirects through the platform sign-in. Without a token
  no StarHermit request is made.
- Platform menu: the player chip shows the profile nickname (fallback
  `Player <id prefix>`, never the username) and avatar; **Invite a friend**
  copies `StarHermit.inviteLink()` and confirms in a status line. Seat names
  use the same nickname rule. The room-invite inbox is polled every 5 s but
  rebuilt only when its invites change, so an Accept/Decline click is never
  lost to a rebuild between press and release.
- Settings KV: the graphics settings (`graphics`) and the sound toggle
  (`soundEnabled`) are mirrored with `PATCH /settings` on change; on sign-in
  the platform values win (`src/platform-prefs.js`). Platform-owned `ui.*`
  keys (`ui.language`) are never treated as game settings.
- Already platform-native (unchanged): realtime-room lobby with quick play,
  private tables, friends picker and room invites, the `ws/v1/games` gameplay
  socket, REST-polled session chat, voice, the Elo leaderboard, and replays.
- Leaderboards: `leaderboards.json` declares `match-wins` ("Tables won",
  integer, higher is better, 1–1,000,000) and `hands-won` ("Hands won", integer,
  higher is better, 0–10,000,000). When a match ends, `server.js` returns the
  winner's running `wins` count to `match-wins` and every still-seated player's
  career `handsWon` to `hands-won` (a seat its player left earns nothing), so a
  solo player ranks by finishing any private table against AI opponents. The
  table's result panel shows "Leaderboard rank: #N" from `match-wins` to the
  signed-in winner and from `hands-won` to everyone else; these strings are
  localized in `src/platform-i18n.js`. Offline play posts nothing.
- Not used: cloud save (all progress — Elo, stats — is script-owned player
  state), keyboard controls (play is pointer/touch only), achievements
  (`server.js` declares none), matchmaking queues (rooms handle seating).
- Account strings are localized in the nine locales (`src/platform-i18n.js`)
  and follow the game language.

## Language

Settings has one **Language** selector (shared `game-options.js` section,
driven by `sh-language.js`, loaded before the app modules): Automatic or one of
en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT. Resolution
order: the explicit choice for this game → for Automatic the StarHermit
account's preferred language (`GET /me/language`, signed in only) →
`navigator.languages` → en-US. The choice is stored per player in
localStorage and, signed in, in the platform setting `ui.language`
(`{ choice }`). Every player-facing string — menus, help, lobby, table (action
bar, seat badges, status line, feed, hand descriptions such as "Two Pair,
Kings and Tens", rule rejections from `server.js`), chat, voice, leaderboard,
replays, the dev sign-in panel, Graphics and account strings — comes from
`src/i18n.js` / `src/strings.js` (the rules engine itself stays English; its
messages are mapped on the client). Switching re-renders the visible screen in
place: the menu card is rebuilt over the running 3D scene, the table relabels
without being rebuilt, feed lines are re-rendered from their source events,
and no socket, room or hand is touched. Numbers use the locale's grouping.

## Report a problem and crash reports

Signed in, Settings shows **Report a problem** (from `game-options.js`: title
and optional details), filed through `StarHermit.reportBug` with a small
non-personal `context.json` (viewport, language, FPS cap, audio limit);
uncaught errors are filed as crash reports through `StarHermit.captureCrashes`
(capped by the SDK). Standalone play shows no report section and makes no
network calls.

Tests: `tests/i18n.test.js` checks that every key used in markup and code
exists in all nine locales with matching placeholders (plus hand-description,
rule-message and feed rendering); `tests/reconnect.test.js` covers the
terms-required and unavailable reconnect stops; `tests/e2e.mjs` runs the
Language step (account fr-CA Automatic → German from the menu's Settings →
`ui.language` → Report a problem, then German mid-hand at the offline table)
at desktop and mobile sizes.

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.


## Sound and frame-rate options

The options panel includes Sound controls for master, music, effects and UI volume, a mute that preserves volume levels, and an Auto or manual concurrent-sound limit (1–64). Changes apply immediately with perceptual volume curves. A shared allocator bounds Web Audio and media playback, including loops and scheduled sources. Graphics includes Auto display refresh or a custom maximum frame rate from 1–1000 FPS; rendering is paced independently of simulation and input. Preferences persist locally, with FPS stored per detected GPU, and reconcile with Starhermit settings when signed in. The controls support keyboard and touch input and follow the Language setting.
