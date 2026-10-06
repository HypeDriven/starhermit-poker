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
the GPU's unmasked renderer string, software renderers get Low, discrete GPUs
and Apple M-series get High, others Balanced, touch devices capped at
Balanced — plus Low, Balanced, High, Ultra); Render scale 50–200%; one
override per effect (Shadows off/low/medium/high, Ambient occlusion
off/on/high, Bloom, Colour grade, Anti-aliasing off/FXAA/SMAA/MSAA,
Reflections, Table detail plain/detailed, Particles low/high, Background
static/animated), each defaulting to "From preset (…)"; Adaptive resolution
(on by default); Show frame rate (off by default; a readout at the bottom
left that never takes pointer input); and a summary line "GPU · cost ·
W×H px". Choosing a preset clears the overrides. Changes apply immediately
and persist in `localStorage` (`poker.graphics`); `<body>` carries
`data-gfx-preset`, `data-gfx-detail` and `data-gfx-background`. The panel is
keyboard (focus trap, Escape closes), mouse and touch operable, scrolls inside
itself on short screens, and is localized for en-US, en-GB, es-419, es-ES,
de-DE, fr-FR, fr-CA, pt-BR and it-IT (from the browser language).

## Large screens

Above 1600×1000 the shared `ui-scale.js` sets `--ui-scale` (`min(w/1600, h/1000)`, capped at 2.5): `#app`, the body-level settings backdrop and the FPS meter are CSS-zoomed by it, vw/vh lengths inside them are divided by it, and the 3D menu/table canvases multiply their pixel ratio by it so they stay sharp. At 1600×1000 and below the layout is unchanged.

## File map (graphics)

| Path | What it is |
|---|---|
| `src/gfx.js` | Pure quality model: presets, categories, `detectPreset`, `resolve`, `presetTier`, `choosePreset`, `describe`, `pixelRatio` |
| `src/gfx-settings.js` | Settings store: GPU probe, `localStorage`, change listeners, `<body>` attributes, FPS readout |
| `src/gfx-pipeline.js` | Shared three.js renderer/post-processing/adaptive-resolution pipeline and the grade shader |
| `src/graphics-panel.js` | Settings button and the Settings → Graphics panel |
| `src/gfx-i18n.js` | Graphics panel strings for the nine supported locales |
| `tests/gfx.test.js` | Unit tests for the quality model and panel strings |

## StarHermit integration

- `index.html` loads the shared SDK `starhermit-sdk.js` (an unchanged copy of
  `tools/starhermit-sdk.js`) and calls `StarHermit.init()` before the app
  modules. The SDK reads `#game_token=` (plus `session_id`) or a sign-in
  return's `#access_token=`, strips it, and renews the token; `src/net.js`
  builds the net context on it (`tokenManager.token` reads the SDK's current
  token, the slug is the `game_scope` claim). A dev token minted in the auth
  panel is handed to the SDK too, with the dev API base.
- When renewal is refused the SDK signs out and the game returns to the local
  menu with a notice; offline play keeps working.
- Local menu (no token): on `<id>.starhermit.com` it shows **Sign in with
  StarHermit**, which redirects through the platform sign-in. Without a token
  no StarHermit request is made.
- Platform menu: the player chip shows the profile nickname (fallback
  `Player <id prefix>`, never the username) and avatar; **Invite a friend**
  copies `StarHermit.inviteLink()` and confirms in a status line. Seat names
  use the same nickname rule.
- Settings KV: the graphics settings (`graphics`) and the sound toggle
  (`soundEnabled`) are mirrored with `PATCH /settings` on change; on sign-in
  the platform values win (`src/platform-prefs.js`).
- Already platform-native (unchanged): realtime-room lobby with quick play,
  private tables, friends picker and room invites, the `ws/v1/games` gameplay
  socket, REST-polled session chat, voice, the Elo leaderboard, and replays.
- Not used: cloud save (all progress — Elo, stats — is script-owned player
  state), keyboard controls (play is pointer/touch only), achievements
  (`server.js` declares none), matchmaking queues (rooms handle seating).
- Account strings are localized in the nine locales (`src/platform-i18n.js`).

## Browser interference

`browser-guard.js` (loaded from `index.html`) suppresses browser UI that gets in the way of play: the right-click context menu, the iOS long-press callout, copy / cut / paste, and page text selection. Text fields (inputs, textareas, selects, contenteditable) keep normal selection, context menu and clipboard behaviour.
