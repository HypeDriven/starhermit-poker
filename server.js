// StarHermit Poker — server-authoritative game script (StarHermit Jint sandbox).
// Contract: https://wiki.starhermit.com/docs/api/game-scripts.html (+ Room-bound
// sessions on https://wiki.starhermit.com/docs/api/realtime.html).
//
// ============================================================================
// PROTOCOL
// ============================================================================
//
// Transport: ws/v1/games. Client frames {"type":"cmd","data":<command>} reach
// onPlayerMessage as ctx.message {from, data}; `from` is the authenticated
// user id attached by the platform and is the ONLY trusted identity. Nothing
// is delivered to clients except entries of the returned `broadcast` array,
// each addressed to explicit user ids or "all".
//
// COMMANDS (ctx.message.data):
//   { type:"sync" }                       -> full projected state for the sender
//   { type:"fold" }
//   { type:"check" }
//   { type:"call" }
//   { type:"bet",   amount:<int> }        \
//   { type:"raise", amount:<int> }         } RAISE CONVENTION: `amount` is the
//   { type:"all-in" }                     / player's NEW TOTAL contribution for
//                                          the current betting round (not the
//                                          amount added). Enforced here, in the
//                                          client's controls, tests, and replays.
//   { type:"sit-out-next-hand", enabled:<bool> }
//   { type:"show-cards", enabled:<bool> }  (voluntary reveal when eligible)
//   Every command may carry stateVersion:<int>; stale versions are rejected.
//   Commands must never contain a user id — identity comes from ctx.message.from.
//
// BROADCASTS (broadcast entries; data shapes):
//   { type:"state", stateVersion, you:{seat}, publicState, privateState }
//        Per-player addressed (to:[userId]) full projection. privateState is
//        null for spectators of hidden info; publicState never contains hole
//        cards of active unrevealed players, the deck, or burn cards.
//   { type:"action", stateVersion, handNumber, seat, action, amount, pot }
//        To "all". Compact transition notice for UI/replay flavor.
//   { type:"hand-started", stateVersion, handNumber, dealerSeat,
//        smallBlindSeat, bigBlindSeat }                     -> "all"
//   { type:"hand-complete", stateVersion, handNumber, winners, pots,
//        revealedCards, description }                       -> "all"
//   { type:"match-complete", stateVersion, result }          -> "all"
//   Errors return as the script's `error` field (platform sends the sender a
//   {"type":"error",error} frame).
//
// STATE (sessionState, complete replacement document each invocation):
//   Compact and serializable; platform reads only `summary`
//   { turnPlayerId, deadline, status, moveCount }. For AI-only acting seats
//   turnPlayerId is null (AI seats have no user id and are not session
//   players). Hole cards and the deck live in state but are NEVER broadcast.
//
// SANDBOX RULES: no imports, no Date, no Math.random, no network/FS. Clock is
// ctx.now (ms epoch); randomness is ctx.random (one float per invocation),
// stretched through a small internal PRNG (mulberry32). Fresh engine per
// invocation: everything lives in the returned documents.
// ============================================================================

'use strict';

// ---------------------------------------------------------------------------
// pokerRules: pure, host-independent functions shared by the script, the
// browser replay viewer, and Node tests. Nothing here may touch ctx.
// ---------------------------------------------------------------------------

globalThis.pokerRules = (function () {
  const rules = {};

  rules.SCHEMA_VERSION = 1;

  // --- cards ---------------------------------------------------------------
  // A card is an int 0..51: rank = card % 13 (0=2 .. 12=A), suit = card/13|0
  // (0=clubs, 1=diamonds, 2=hearts, 3=spades).

  rules.freshDeck = function () {
    const deck = new Array(52);
    for (let i = 0; i < 52; i++) deck[i] = i;
    return deck;
  };

  rules.cardRank = (c) => c % 13;
  rules.cardSuit = (c) => (c / 13) | 0;

  const RANK_CHARS = '23456789TJQKA';
  const SUIT_CHARS = 'cdhs';
  rules.cardToString = (c) => RANK_CHARS[rules.cardRank(c)] + SUIT_CHARS[rules.cardSuit(c)];

  // Fisher-Yates driven by a supplied rng() in [0,1) — never Math.random.
  rules.shuffle = function (deck, rng) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
    }
    return deck;
  };

  // --- deterministic PRNG --------------------------------------------------
  // mulberry32: tiny, fast, good enough for play-money shuffle variance.
  rules.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Derive a 32-bit seed from the host's single ctx.random float plus a
  // monotonic counter, so successive invocations get independent streams.
  rules.deriveSeed = function (randomFloat, counter) {
    let h = Math.floor((randomFloat % 1) * 4294967296) >>> 0;
    let c = (counter | 0) >>> 0;
    h = Math.imul(h ^ 0x9E3779B9, 0x85EBCA6B) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h ^ c, 0xC2B2AE35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h;
  };

  rules.chipString = (n) => String(n);

  // Epoch ms -> ISO-8601 UTC string without Date (banned in the sandbox).
  // Howard Hinnant's civil-from-days algorithm, plain arithmetic.
  rules.epochMsToIso = function (ms) {
    if (!Number.isFinite(ms)) return null;
    let days = Math.floor(ms / 86400000);
    let rem = ms - days * 86400000;
    const hh = Math.floor(rem / 3600000); rem -= hh * 3600000;
    const mm = Math.floor(rem / 60000); rem -= mm * 60000;
    const ss = Math.floor(rem / 1000);
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp + (mp < 10 ? 3 : -9);
    const year = m <= 2 ? y + 1 : y;
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${pad(year, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}Z`;
  };

  // --- chip validation -----------------------------------------------------
  rules.isValidChips = (n) => Number.isSafeInteger(n) && n >= 0;

  // --- bounded collections -------------------------------------------------
  // Append to a capped log (returns a new array; state documents are replaced
  // wholesale, so mutation is fine — this just enforces the cap).
  rules.cappedPush = function (arr, item, cap) {
    arr.push(item);
    while (arr.length > cap) arr.shift();
    return arr;
  };

  return rules;
})();

// ---------------------------------------------------------------------------
// Internal helpers (script-side; not part of pokerRules)
// ---------------------------------------------------------------------------

const LIMITS = {
  actionLog: 300,   // max entries retained in state.log
  handHistory: 60,  // max completed-hand records retained for replay
  recentGames: 30,  // per-player document recent-match cap
};

const DEFAULT_CONFIG = {
  variant: 'nlhe',
  startingStack: 10000,
  smallBlind: 50,
  bigBlind: 100,
  turnDurationSeconds: 30,
};

function fail(message) {
  return { ok: false, error: message };
}

// Seat object factory. Presence flags (disconnected/left) are refreshed from
// ctx.presence on every invocation; `ai` follows the room roster.
function makeSeat(rosterEntry, config) {
  return {
    userId: rosterEntry.userId || null, // null for AI seats
    name: rosterEntry.name || 'Player',
    ai: !!rosterEntry.ai,
    stack: config.startingStack,
    handCommit: 0,   // chips committed this hand (all streets)
    roundCommit: 0,  // chips committed this betting round
    folded: false,
    allIn: false,
    sittingOut: false,
    sitOutNext: false, // sit-out-next-hand preference
    eliminated: false,
    showCards: false,   // voluntary reveal choice
    lastActionSeq: -1,  // action sequence of this seat's latest action
  };
}

// Read table config from room metadata, falling back to defaults and clamping
// to safe values (metadata is operator/client-controlled input).
function readConfig(metadata) {
  const m = metadata || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (k === 'variant') continue;
    if (Number.isSafeInteger(m[k]) && m[k] > 0) cfg[k] = m[k];
  }
  if (cfg.smallBlind >= cfg.bigBlind) cfg.smallBlind = Math.max(1, cfg.bigBlind >> 1);
  if (cfg.startingStack < cfg.bigBlind * 2) cfg.startingStack = cfg.bigBlind * 20;
  cfg.variant = 'nlhe';
  return cfg;
}

// The platform-readable window. turnPlayerId is null whenever the acting seat
// is AI (AI seats have no platform user id). deadline is the ISO string the
// platform expects, computed without Date.
function summaryFor(state) {
  const acting = state.actingSeat >= 0 ? state.seats[state.actingSeat] : null;
  return {
    turnPlayerId: acting && !acting.ai && !state.matchResult ? acting.userId : null,
    deadline: state.turnDeadlineMs
      ? globalThis.pokerRules.epochMsToIso(state.turnDeadlineMs)
      : null,
    status: state.matchResult ? 'finished' : 'active',
    moveCount: state.actionSeq,
  };
}

// ---------------------------------------------------------------------------
// Projections — the ONLY channel through which clients learn state.
// ---------------------------------------------------------------------------

// Public per-seat view: everything except hidden cards.
function publicSeat(state, i) {
  const s = state.seats[i];
  return {
    seat: i,
    userId: s.userId, // null for AI seats — clients must not treat it as an id
    name: s.name,
    ai: s.ai,
    stack: s.stack,
    roundCommit: s.roundCommit,
    handCommit: s.handCommit,
    folded: s.folded,
    allIn: s.allIn,
    sittingOut: s.sittingOut,
    eliminated: s.eliminated,
    disconnected: !!s.disconnected,
    left: !!s.left,
    inHand: !s.folded && !s.eliminated && !s.sittingOut && state.hand.live &&
      state.hand.holes[i] !== null,
  };
}

// Public state: safe to send to every participant.
function publicProjection(state) {
  return {
    schemaVersion: state.schemaVersion,
    status: state.matchResult ? 'finished' : 'active',
    handNumber: state.handNumber,
    street: state.hand.street,
    dealerSeat: state.dealerSeat,
    smallBlindSeat: state.hand.smallBlindSeat,
    bigBlindSeat: state.hand.bigBlindSeat,
    actingSeat: state.actingSeat,
    currentBet: state.hand.currentBet,
    minRaiseTotal: state.hand.minRaiseTotal,
    pot: state.seats.reduce((t, s) => t + s.handCommit, 0),
    board: state.hand.board.slice(),
    seats: state.seats.map((_, i) => publicSeat(state, i)),
    turnDeadlineMs: state.turnDeadlineMs,
    turnSeconds: state.config.turnDurationSeconds,
    // Revealed cards only: showdown/voluntarily shown hands. Keyed by seat.
    revealed: revealedCards(state),
    prevHand: state.prevHand,
    matchResult: state.matchResult,
    config: {
      smallBlind: state.config.smallBlind,
      bigBlind: state.config.bigBlind,
      startingStack: state.config.startingStack,
    },
    recentLog: state.log.slice(-30),
  };
}

// Cards a given broadcast may reveal to everyone: showdown participants and
// seats that chose show-cards when eligible.
function revealedCards(state) {
  const out = {};
  if (!state.hand.live && state.hand.reveal) {
    for (const k of Object.keys(state.hand.reveal)) {
      out[k] = state.hand.reveal[k].slice();
    }
  }
  return out;
}

// Per-player projection: public view + the player's own hole cards + legal
// actions when it is their turn. This is the ONLY message containing private
// cards, and it is always addressed to exactly that user id.
function privateProjection(state, userId) {
  const seatIndex = state.seats.findIndex((s) => s.userId === userId);
  if (seatIndex < 0) return { seat: -1, holeCards: null, legalActions: null };
  const s = state.seats[seatIndex];
  return {
    seat: seatIndex,
    holeCards: state.hand.live && state.hand.holes[seatIndex]
      ? state.hand.holes[seatIndex].slice()
      : null,
    legalActions: null, // checkpoint 9 computes real legal actions
  };
}

// Build the broadcast array delivering each human their projected state.
// AI seats are not session players and receive nothing.
function stateBroadcasts(state) {
  const pub = publicProjection(state);
  const out = [];
  for (const s of state.seats) {
    if (!s.userId) continue; // AI seat
    out.push({
      to: [s.userId],
      data: {
        type: 'state',
        stateVersion: state.actionSeq,
        you: privateProjection(state, s.userId),
        publicState: pub,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session construction (room-bound): ctx.room.roster is the frozen match
// roster (humans AND AI seats, ordered by team then slot); ctx.room.metadata
// carries the table config. Non-room sessions (invite/matchmaking/AI practice)
// fall back to ctx.players.
// ---------------------------------------------------------------------------

function buildSeats(ctx, config) {
  const roster = (ctx.room && ctx.room.roster)
    ? ctx.room.roster
    : (ctx.players || []).map((p) => ({
      userId: p.id, name: p.name, team: 0, slot: 0, ai: !!p.ai,
    }));
  const ordered = roster.slice().sort((a, b) =>
    ((a.team || 0) - (b.team || 0)) || ((a.slot || 0) - (b.slot || 0)));
  return ordered.map((entry) => makeSeat(entry, config));
}

function newHandState() {
  return {
    live: false,
    street: 'preflop', // preflop | flop | turn | river | showdown
    deck: [],
    board: [],
    holes: [],       // per seat: [c1,c2] | null — NEVER broadcast
    burn: [],        // burn cards — NEVER broadcast
    currentBet: 0,
    minRaiseTotal: 0,
    lastFullRaise: 0,
    lastFullRaiseSeq: -1,
    smallBlindSeat: -1,
    bigBlindSeat: -1,
    reveal: null,    // seat -> cards, set at showdown or voluntary show
  };
}

function initialState(ctx) {
  const config = readConfig(ctx.room && ctx.room.metadata);
  const seats = buildSeats(ctx, config);
  return {
    schemaVersion: globalThis.pokerRules.SCHEMA_VERSION,
    config,
    roomId: ctx.room ? ctx.room.roomId : null,
    seats,
    dealerSeat: -1,
    actingSeat: -1,
    handNumber: 0,
    actionSeq: 0,
    turnDeadlineMs: 0,
    hand: newHandState(),
    log: [],
    hands: [],        // completed-hand records for replay (capped)
    prevHand: null,
    matchResult: null,
    summary: null,    // filled below
  };
}

// Refresh volatile presence/AI flags from the room context. A seat whose user
// left the room mid-match has been converted to an AI participant by the
// platform: mark it ai+left so it can no longer act as that user (and the AI
// takes over its decisions in checkpoint 12) while keeping its stack/hand.
function syncPresence(state, ctx) {
  const presence = ctx.presence || {};
  const rosterBySlot = {};
  if (ctx.room && ctx.room.roster) {
    for (const r of ctx.room.roster) rosterBySlot[(r.team || 0) + ':' + (r.slot || 0)] = r;
  }
  state.seats.forEach((s, i) => {
    if (!s.userId) return;
    const p = presence[s.userId];
    s.disconnected = p ? !p.online : false;
    if (p && p.left) {
      s.left = true;
      const r = rosterBySlot['0:' + i];
      s.ai = true; // platform converted the seat to an AI participant
      if (r && r.name) s.name = r.name;
    }
  });
}

// ---------------------------------------------------------------------------
// Hand lifecycle
// ---------------------------------------------------------------------------

// Seats eligible to be dealt into the next hand.
function eligibleSeats(state) {
  const out = [];
  state.seats.forEach((s, i) => {
    if (!s.eliminated && !s.sittingOut && s.stack > 0) out.push(i);
  });
  return out;
}

// Next seat index (circular) after `from` satisfying pred(i).
function nextSeat(state, from, pred) {
  const n = state.seats.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (pred(i)) return i;
  }
  return -1;
}

function postChips(state, seatIndex, amount) {
  const s = state.seats[seatIndex];
  const posted = Math.min(amount, s.stack);
  s.stack -= posted;
  s.handCommit += posted;
  s.roundCommit += posted;
  if (s.stack === 0) s.allIn = true;
  return posted;
}

function logAction(state, seat, action, amount) {
  globalThis.pokerRules.cappedPush(state.log,
    [state.actionSeq, state.handNumber, seat, action, amount || 0], LIMITS.actionLog);
}

// Start a new hand: advance the button, post blinds, shuffle and deal with
// randomness derived ONLY from ctx.random, set the first actor and deadline.
// Returns true when a hand was started.
function startHand(state, ctx) {
  const rules = globalThis.pokerRules;

  // Apply pending sit-out requests and fresh eliminations.
  for (const s of state.seats) {
    if (s.stack === 0) s.eliminated = true;
    s.sittingOut = !!s.sitOutNext;
    s.sitOutNext = false;
  }

  const eligible = eligibleSeats(state);
  if (eligible.length < 2) return false; // match completion is handled by the caller

  state.handNumber += 1;
  state.hand = newHandState();
  const hand = state.hand;
  hand.live = true;
  hand.street = 'preflop';

  // Button: first hand picks via the host rng, then rotates to the next
  // eligible seat.
  const rng = rules.mulberry32(rules.deriveSeed(ctx.random, state.handNumber));
  if (state.dealerSeat < 0) {
    state.dealerSeat = eligible[Math.floor(rng() * eligible.length)];
  } else {
    state.dealerSeat = nextSeat(state, state.dealerSeat,
      (i) => eligible.includes(i));
  }

  const headsUp = eligible.length === 2;
  const sbSeat = headsUp
    ? state.dealerSeat
    : nextSeat(state, state.dealerSeat, (i) => eligible.includes(i));
  const bbSeat = nextSeat(state, sbSeat, (i) => eligible.includes(i));
  hand.smallBlindSeat = sbSeat;
  hand.bigBlindSeat = bbSeat;

  // Shuffle and deal one card at a time starting at the small blind.
  hand.deck = rules.shuffle(rules.freshDeck(), rng);
  hand.holes = state.seats.map(() => null);
  for (let round = 0; round < 2; round++) {
    let seat = sbSeat;
    for (let k = 0; k < eligible.length; k++) {
      if (!hand.holes[seat]) hand.holes[seat] = [];
      hand.holes[seat].push(hand.deck.pop());
      seat = nextSeat(state, seat, (i) => eligible.includes(i));
    }
  }

  // Blinds.
  for (const s of state.seats) {
    s.folded = false;
    s.allIn = false;
    s.handCommit = 0;
    s.roundCommit = 0;
    s.showCards = false;
    s.lastActionSeq = -1;
  }
  const bbPosted = postChips(state, bbSeat, state.config.bigBlind);
  const sbPosted = postChips(state, sbSeat, state.config.smallBlind);
  state.actionSeq += 1;
  state.seats[sbSeat].lastActionSeq = state.actionSeq;
  logAction(state, sbSeat, 'blind', sbPosted);
  state.actionSeq += 1;
  state.seats[bbSeat].lastActionSeq = state.actionSeq;
  logAction(state, bbSeat, 'blind', bbPosted);

  hand.currentBet = bbPosted;
  hand.lastFullRaise = state.config.bigBlind;
  hand.lastFullRaiseSeq = state.actionSeq;
  hand.minRaiseTotal = bbPosted + hand.lastFullRaise;

  // First action preflop: heads-up the dealer (small blind); otherwise the
  // seat left of the big blind.
  const actor = headsUp
    ? state.dealerSeat
    : nextSeat(state, bbSeat, (i) => eligible.includes(i));
  state.actingSeat = actor;
  state.turnDeadlineMs = ctx.now + state.config.turnDurationSeconds * 1000;
  return true;
}

function handStartedBroadcast(state) {
  return {
    to: 'all',
    data: {
      type: 'hand-started',
      stateVersion: state.actionSeq,
      handNumber: state.handNumber,
      dealerSeat: state.dealerSeat,
      smallBlindSeat: state.hand.smallBlindSeat,
      bigBlindSeat: state.hand.bigBlindSeat,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

globalThis.game = {
  createSession(ctx) {
    const state = initialState(ctx);
    syncPresence(state, ctx);
    startHand(state, ctx);
    state.summary = summaryFor(state);

    // Initialize per-player documents (stats owned by the script).
    const playerStates = {};
    for (const s of state.seats) {
      if (!s.userId) continue;
      const existing = ctx.playerStates && ctx.playerStates[s.userId];
      playerStates[s.userId] = existing && typeof existing === 'object'
        ? existing
        : { elo: 1200, wins: 0, losses: 0, draws: 0 };
    }

    const broadcast = stateBroadcasts(state);
    if (state.hand.live) broadcast.unshift(handStartedBroadcast(state));

    return {
      ok: true,
      sessionState: state,
      playerStates,
      broadcast,
    };
  },

  onPlayerMessage(ctx) {
    const state = ctx.sessionState;
    if (!state || state.schemaVersion !== globalThis.pokerRules.SCHEMA_VERSION) {
      return fail('No active session state');
    }
    syncPresence(state, ctx);

    const msg = ctx.message || {};
    const data = msg.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return fail('Malformed command');
    }
    // Stale-command rejection (optional version supplied by the client).
    if (data.stateVersion !== undefined &&
        data.stateVersion !== state.actionSeq) {
      return fail('Stale state version');
    }
    if (state.matchResult) return fail('The match is over');

    if (data.type === 'sync') {
      const mine = privateProjection(state, msg.from);
      if (mine.seat < 0) return fail('You are not seated at this table');
      return {
        ok: true,
        sessionState: state,
        broadcast: [{
          to: [msg.from],
          data: {
            type: 'state',
            stateVersion: state.actionSeq,
            you: mine,
            publicState: publicProjection(state),
          },
        }],
      };
    }

    // Preference commands: allowed from any seated human, in or out of a hand.
    const seatIndex = state.seats.findIndex((s) => s.userId === msg.from);
    if (seatIndex < 0) return fail('You are not seated at this table');
    const seat = state.seats[seatIndex];
    if (seat.ai) return fail('This seat is played by the AI');

    if (data.type === 'sit-out-next-hand') {
      if (typeof data.enabled !== 'boolean') return fail('enabled must be a boolean');
      seat.sitOutNext = data.enabled;
      state.actionSeq += 1;
      state.summary = summaryFor(state);
      return { ok: true, sessionState: state, broadcast: stateBroadcasts(state) };
    }

    if (data.type === 'show-cards') {
      if (typeof data.enabled !== 'boolean') return fail('enabled must be a boolean');
      // Meaningful only while the player holds cards; the reveal is applied
      // when the hand completes (checkpoint 10).
      seat.showCards = data.enabled;
      state.actionSeq += 1;
      state.summary = summaryFor(state);
      return { ok: true, sessionState: state, broadcast: stateBroadcasts(state) };
    }

    return fail('Unknown or not-yet-legal command: ' + data.type);
  },

  onTick(ctx) {
    const state = ctx.sessionState;
    if (!state) return { ok: true };
    syncPresence(state, ctx);
    // Between hands (e.g. right after session creation failed to deal because
    // only one seat had chips): try to start the next hand.
    let broadcast;
    if (!state.hand.live && !state.matchResult) {
      const before = state.handNumber;
      if (startHand(state, ctx) && state.handNumber !== before) {
        broadcast = stateBroadcasts(state);
        broadcast.unshift(handStartedBroadcast(state));
      }
    }
    state.summary = summaryFor(state);
    return { ok: true, sessionState: state, broadcast };
  },
};
