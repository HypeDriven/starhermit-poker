// StarHermit Poker — single configuration module.
// All game defaults live here so they can be changed in one place.
// The slug itself is NOT hard-coded at runtime: the client reads it from the
// launch token's `game_scope` claim (see src/net.js). DEFAULT_SLUG is only a
// fallback for the local-development auth panel.

export const GAME = Object.freeze({
  name: 'StarHermit Poker',
  defaultSlug: 'poker',
  variant: 'nlhe', // no-limit Texas Hold'em

  minPlayers: 2,
  maxSeats: 6,
  teamCount: 1, // free-for-all; seatsPerTeam = maxSeats

  startingStack: 10000,
  smallBlind: 50,
  bigBlind: 100,
  turnDurationSeconds: 30,

  // Realtime-room creation defaults (metadata blob stored on the room).
  roomBackfillAfterSeconds: 45,

  // Launch-token refresh cadence (token lifetime is 60 min; the documented
  // reference pattern refreshes every 45 min).
  tokenRefreshMs: 45 * 60 * 1000,

  // WebSocket reconnect: exponential backoff 1 s -> 30 s.
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,

  // Chat: REST polling only (ws/v1/chat is blocked for launch tokens).
  chatPollMs: 5000,
  chatPageSize: 50,

  // Invite inbox polling while in a lobby.
  invitePollMs: 5000,

  // AI behavior profiles assigned at table start.
  aiProfiles: ['conservative', 'balanced', 'aggressive'],
});

// Room metadata stored verbatim in config.metadata on room creation.
export function buildRoomMetadata(visibility) {
  return {
    variant: GAME.variant,
    startingStack: GAME.startingStack,
    smallBlind: GAME.smallBlind,
    bigBlind: GAME.bigBlind,
    turnDurationSeconds: GAME.turnDurationSeconds,
    visibility, // 'public' | 'private'
  };
}
