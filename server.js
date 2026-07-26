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

  // --- hand evaluator ------------------------------------------------------
  // Evaluate the best 5-card hand from 5-7 card ints. Returns
  // { score: [category, t1..t5], category, description } where score arrays
  // compare lexicographically (higher wins). Categories:
  //   8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight,
  //   3 trips, 2 two pair, 1 one pair, 0 high card.
  // Deterministic: no randomness, no host dependencies.

  const CATEGORY_NAMES = [
    'High Card', 'One Pair', 'Two Pair', 'Three of a Kind',
    'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
  ];

  // Highest straight top-rank in a rank-presence set, or -1. The wheel
  // (A-2-3-4-5) counts as five-high (top rank index 3).
  function straightTop(present) {
    for (let hi = 12; hi >= 4; hi--) {
      if (present[hi] && present[hi - 1] && present[hi - 2] && present[hi - 3] && present[hi - 4]) {
        return hi;
      }
    }
    if (present[12] && present[0] && present[1] && present[2] && present[3]) return 3;
    return -1;
  }

  const RANK_WORDS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
    'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
  const RANK_PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens',
    'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

  rules.evaluate = function (cards) {
    const rankCount = new Array(13).fill(0);
    const suitRanks = [[], [], [], []];
    for (const c of cards) {
      rankCount[c % 13] += 1;
      suitRanks[(c / 13) | 0].push(c % 13);
    }
    const desc = (a, b) => b - a;

    // Flush?
    let flushRanks = null;
    for (let s = 0; s < 4; s++) {
      if (suitRanks[s].length >= 5) {
        flushRanks = suitRanks[s].sort(desc);
        break;
      }
    }

    // Straight flush?
    if (flushRanks) {
      const present = new Array(13).fill(false);
      for (const r of flushRanks) present[r] = true;
      const top = straightTop(present);
      if (top >= 0) {
        return {
          score: [8, top, 0, 0, 0, 0], category: 8,
          description: `${CATEGORY_NAMES[8]}, ${RANK_WORDS[top]} high`,
        };
      }
    }

    // Groups: ranks sorted by (count desc, rank desc).
    const groups = [];
    for (let r = 0; r < 13; r++) {
      if (rankCount[r] > 0) groups.push({ rank: r, count: rankCount[r] });
    }
    groups.sort((a, b) => (b.count - a.count) || (b.rank - a.rank));

    const singles = groups.filter((g) => g.count === 1).map((g) => g.rank).sort(desc);
    const pad5 = (arr) => {
      const out = arr.slice(0, 5);
      while (out.length < 5) out.push(0);
      return out;
    };
    const make = (category, tieRanks, description) => ({
      score: [category, ...pad5(tieRanks)], category, description,
    });

    // Four of a kind.
    if (groups[0].count === 4) {
      return make(7, [groups[0].rank, singles[0] ?? 0],
        `${CATEGORY_NAMES[7]}, ${RANK_PLURAL[groups[0].rank]}`);
    }
    // Full house (a second trips group plays as the pair).
    const trips = groups.filter((g) => g.count === 3);
    const pairs = groups.filter((g) => g.count === 2);
    if (trips.length >= 1 && (pairs.length >= 1 || trips.length >= 2)) {
      const pairRank = pairs.length >= 1 ? pairs[0].rank : trips[1].rank;
      return make(6, [trips[0].rank, pairRank],
        `${CATEGORY_NAMES[6]}, ${RANK_PLURAL[trips[0].rank]} over ${RANK_PLURAL[pairRank]}`);
    }
    // Flush.
    if (flushRanks) {
      return make(5, flushRanks, `${CATEGORY_NAMES[5]}, ${RANK_WORDS[flushRanks[0]]} high`);
    }
    // Straight.
    const present = new Array(13).fill(false);
    for (const g of groups) present[g.rank] = true;
    const top = straightTop(present);
    if (top >= 0) {
      return make(4, [top], `${CATEGORY_NAMES[4]}, ${RANK_WORDS[top]} high`);
    }
    // Three of a kind.
    if (trips.length === 1) {
      return make(3, [trips[0].rank, ...singles],
        `${CATEGORY_NAMES[3]}, ${RANK_PLURAL[trips[0].rank]}`);
    }
    // Two pair.
    if (pairs.length >= 2) {
      const p = pairs.map((x) => x.rank).sort(desc);
      return make(2, [p[0], p[1], singles[0] ?? 0],
        `${CATEGORY_NAMES[2]}, ${RANK_PLURAL[p[0]]} and ${RANK_PLURAL[p[1]]}`);
    }
    // One pair.
    if (pairs.length === 1) {
      return make(1, [pairs[0].rank, ...singles],
        `${CATEGORY_NAMES[1]}, ${RANK_PLURAL[pairs[0].rank]}`);
    }
    return make(0, singles, `${CATEGORY_NAMES[0]}, ${RANK_WORDS[singles[0]]}`);
  };

  // -1 / 0 / 1 lexicographic score comparison.
  rules.compareScores = function (a, b) {
    for (let i = 0; i < 6; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  };

  // Best evaluation for a player: 2 hole cards + board (3-5 cards).
  rules.evaluateHoldem = function (holeCards, board) {
    return rules.evaluate(holeCards.concat(board));
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
    legalActions: state.hand.live && state.actingSeat === seatIndex &&
      !s.folded && !s.allIn
      ? legalActions(state, seatIndex)
      : null,
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
  // Blinds are forced bets, not voluntary actions: lastActionSeq stays -1 so
  // the big blind keeps their preflop option and round completion requires a
  // real action from every contesting seat.
  state.actionSeq += 1;
  logAction(state, sbSeat, 'blind', sbPosted);
  state.actionSeq += 1;
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
// Betting engine
//
// RAISE CONVENTION (enforced everywhere): bet/raise `amount` is the player's
// NEW TOTAL contribution for the current betting round (their roundCommit
// after the action), never the amount added. The client slider, presets,
// action log, and replays all use the same convention.
// ---------------------------------------------------------------------------

// Seats still contesting the pot (dealt in and not folded).
function contestingSeats(state) {
  const out = [];
  state.seats.forEach((s, i) => {
    if (state.hand.holes[i] && !s.folded) out.push(i);
  });
  return out;
}

// Seats that can still make a voluntary action this round.
function actionableSeats(state) {
  return contestingSeats(state).filter((i) => !state.seats[i].allIn);
}

// Whether this seat is allowed to raise (reopening rule): a player who has
// already acted may only re-raise if a FULL raise happened after their last
// action. Short all-ins do not reopen the action.
function raiseReopened(state, seatIndex) {
  const s = state.seats[seatIndex];
  return s.lastActionSeq < 0 || state.hand.lastFullRaiseSeq > s.lastActionSeq;
}

// Legal-action guidance for the acting seat (also drives the client UI).
function legalActions(state, seatIndex) {
  const hand = state.hand;
  const s = state.seats[seatIndex];
  const toCall = hand.currentBet - s.roundCommit;
  const maxTotal = s.roundCommit + s.stack;
  const canBet = hand.currentBet === 0 && s.stack > 0;
  const canRaise = hand.currentBet > 0 && maxTotal > hand.currentBet &&
    raiseReopened(state, seatIndex);
  return {
    canFold: true,
    canCheck: toCall === 0,
    callAmount: Math.max(0, Math.min(toCall, s.stack)),
    canBet,
    canRaise,
    minimumAmount: canBet
      ? Math.min(state.config.bigBlind, maxTotal)
      : (canRaise ? Math.min(hand.currentBet + hand.lastFullRaise, maxTotal) : maxTotal),
    maximumAmount: maxTotal,
  };
}

// Apply a voluntary action for the acting seat. Returns an error string, or
// null on success (state mutated, action logged, sequence advanced).
function applyPlayerAction(state, seatIndex, type, amount) {
  const rules = globalThis.pokerRules;
  const hand = state.hand;
  const s = state.seats[seatIndex];
  const toCall = hand.currentBet - s.roundCommit;
  const maxTotal = s.roundCommit + s.stack;

  let action = type;
  let newTotal = null;

  if (type === 'fold') {
    s.folded = true;
  } else if (type === 'check') {
    if (toCall > 0) return { error: 'Cannot check — there is a bet to call' };
  } else if (type === 'call') {
    if (toCall <= 0) return { error: 'Nothing to call' };
    newTotal = s.roundCommit + Math.min(toCall, s.stack);
  } else if (type === 'bet') {
    if (hand.currentBet !== 0) return { error: 'Cannot bet — there is already a bet this round' };
    if (!rules.isValidChips(amount)) return { error: 'Bet amount must be a non-negative integer' };
    if (amount > maxTotal) return { error: 'Bet exceeds your stack' };
    if (amount < state.config.bigBlind && amount !== maxTotal) {
      return { error: `Minimum bet is ${state.config.bigBlind}` };
    }
    if (amount <= 0) return { error: 'Bet must be positive' };
    newTotal = amount;
  } else if (type === 'raise') {
    if (hand.currentBet === 0) return { error: 'Cannot raise — use bet' };
    if (!rules.isValidChips(amount)) return { error: 'Raise amount must be a non-negative integer' };
    if (amount > maxTotal) return { error: 'Raise exceeds your stack' };
    if (amount <= hand.currentBet) return { error: 'Raise must exceed the current bet' };
    const minTotal = hand.currentBet + hand.lastFullRaise;
    if (amount < minTotal && amount !== maxTotal) {
      return { error: `Minimum raise total is ${Math.min(minTotal, maxTotal)}` };
    }
    if (!raiseReopened(state, seatIndex) && amount > hand.currentBet) {
      return { error: 'Action is closed — a full raise has not occurred since your last action' };
    }
    newTotal = amount;
  } else if (type === 'all-in') {
    newTotal = maxTotal;
    if (hand.currentBet === 0) action = 'bet';
    else if (newTotal > hand.currentBet) action = 'raise';
    else action = 'call';
  } else {
    return 'Unknown action: ' + type;
  }

  // Commit chips and update raise tracking.
  state.actionSeq += 1;
  s.lastActionSeq = state.actionSeq;
  if (newTotal !== null) {
    const posted = postChips(state, seatIndex, newTotal - s.roundCommit);
    if (newTotal > hand.currentBet) {
      const raiseSize = newTotal - hand.currentBet;
      const isFullRaise = hand.currentBet === 0
        ? newTotal >= state.config.bigBlind || s.allIn
        : raiseSize >= hand.lastFullRaise;
      if (isFullRaise) {
        hand.lastFullRaise = hand.currentBet === 0 ? newTotal : raiseSize;
        hand.lastFullRaiseSeq = state.actionSeq;
      }
      hand.currentBet = newTotal;
    }
    hand.minRaiseTotal = hand.currentBet + hand.lastFullRaise;
    logAction(state, seatIndex, action === type ? type : action, posted);
    return { action, amount: posted, error: null };
  }
  logAction(state, seatIndex, type, 0);
  return { action: type, amount: 0, error: null };
}

// ---------------------------------------------------------------------------
// Hand progression
// ---------------------------------------------------------------------------

function setActor(state, ctx, seatIndex) {
  state.actingSeat = seatIndex;
  state.turnDeadlineMs = seatIndex >= 0
    ? ctx.now + state.config.turnDurationSeconds * 1000
    : 0;
}

function resetRound(state) {
  const hand = state.hand;
  for (const s of state.seats) {
    s.roundCommit = 0;
    s.lastActionSeq = -1;
  }
  hand.currentBet = 0;
  hand.lastFullRaise = state.config.bigBlind;
  hand.lastFullRaiseSeq = -1;
  hand.minRaiseTotal = state.config.bigBlind;
}

function dealStreet(state) {
  const hand = state.hand;
  if (hand.street === 'preflop') {
    hand.burn.push(hand.deck.pop());
    for (let i = 0; i < 3; i++) hand.board.push(hand.deck.pop());
    hand.street = 'flop';
  } else if (hand.street === 'flop' || hand.street === 'turn') {
    hand.burn.push(hand.deck.pop());
    hand.board.push(hand.deck.pop());
    hand.street = hand.street === 'flop' ? 'turn' : 'river';
  }
}

// Is the current betting round complete? Every contesting seat that can still
// act must have acted since the street began and matched the current bet.
function bettingRoundComplete(state) {
  const hand = state.hand;
  for (const i of contestingSeats(state)) {
    const s = state.seats[i];
    if (s.allIn) continue;
    if (s.lastActionSeq < 0) return false; // has not acted this street
    if (s.roundCommit !== hand.currentBet) return false;
  }
  return true;
}

// Advance after a voluntary action: end the hand early, close the round, deal
// the next street, or move the action to the next seat.
function advanceHand(state, ctx, ev) {
  const contesting = contestingSeats(state);
  if (contesting.length === 1) {
    finishHandFold(state, ctx, ev, contesting[0]);
    return;
  }

  if (!bettingRoundComplete(state)) {
    const next = nextSeat(state, state.actingSeat,
      (i) => state.hand.holes[i] && !state.seats[i].folded && !state.seats[i].allIn);
    setActor(state, ctx, next);
    return;
  }

  // Street complete. Move to the next street or showdown; streets where no
  // one can act (everyone all-in) run out automatically.
  for (;;) {
    if (state.hand.street === 'river') {
      finishHandShowdown(state, ctx, ev);
      return;
    }
    dealStreet(state);
    resetRound(state);
    const first = nextSeat(state, state.dealerSeat,
      (i) => state.hand.holes[i] && !state.seats[i].folded && !state.seats[i].allIn);
    if (first >= 0) {
      setActor(state, ctx, first);
      return;
    }
    // No one can act: keep running out the board.
  }
}

// ---------------------------------------------------------------------------
// Hand completion
// ---------------------------------------------------------------------------

// Build main + side pots from per-seat hand commits. Folded players' chips
// stay in the pots they contributed to; a level with a single eligible
// contributor is an uncalled bet and returns to them through normal payout.
function buildPots(state) {
  const levels = [...new Set(
    state.seats.map((s) => s.handCommit).filter((c) => c > 0))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const contributors = [];
    state.seats.forEach((s, i) => {
      if (s.handCommit >= level) contributors.push(i);
    });
    const amount = (level - prev) * contributors.length;
    const eligible = contributors.filter((i) => !state.seats[i].folded);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  return pots;
}

// Award `pot` to `winners` (seat indexes). Odd chips go one apiece to the
// winners closest clockwise from the button (deterministic).
function splitPot(state, pot, winners) {
  const share = Math.floor(pot / winners.length);
  let odd = pot - share * winners.length;
  const ordered = winners.slice().sort((a, b) => {
    const da = (a - state.dealerSeat + state.seats.length) % state.seats.length;
    const db = (b - state.dealerSeat + state.seats.length) % state.seats.length;
    return da - db;
  });
  const payouts = {};
  for (const w of ordered) {
    payouts[w] = share + (odd > 0 ? 1 : 0);
    if (odd > 0) odd -= 1;
  }
  return payouts;
}

// Shared epilogue: payouts applied, hand closed, summary/replay recorded,
// match end checked. `ev` accumulates broadcast payloads for this invocation.
function finishHand(state, ctx, ev, { winnerSeats, description, revealed, potsWon }) {
  // Payouts.
  for (const [seat, amount] of Object.entries(potsWon)) {
    state.seats[seat].stack += amount;
  }
  const totalPot = state.seats.reduce((t, s) => t + s.handCommit, 0);
  for (const s of state.seats) { s.handCommit = 0; s.roundCommit = 0; }

  const hand = state.hand;
  hand.live = false;
  hand.reveal = revealed;
  state.actionSeq += 1;
  state.actingSeat = -1;
  state.turnDeadlineMs = 0;

  const winners = winnerSeats.map((seat) => ({
    seat,
    amount: potsWon[seat] || 0,
    name: state.seats[seat].name,
  }));

  state.prevHand = {
    handNumber: state.handNumber,
    dealer: state.dealerSeat,
    winners,
    description,
    pot: totalPot,
    board: hand.board.slice(),
    revealed,
  };
  // Compact replay record.
  globalThis.pokerRules.cappedPush(state.hands, {
    n: state.handNumber,
    dealer: state.dealerSeat,
    sb: hand.smallBlindSeat,
    bb: hand.bigBlindSeat,
    board: hand.board.slice(),
    actions: state.log.filter((l) => l[1] === state.handNumber)
      .map((l) => [l[2], l[3], l[4]]),
    reveal: revealed,
    winners,
    pot: totalPot,
  }, LIMITS.handHistory);

  ev.push({
    type: 'hand-complete',
    stateVersion: state.actionSeq,
    handNumber: state.handNumber,
    winners,
    pots: buildPots(state).map((p) => p.amount),
    revealedCards: revealed,
    description,
  });

  // Eliminations are applied at the next startHand; the match ends when at
  // most one seat still has chips.
  const withChips = state.seats.filter((s) => s.stack > 0 || s.handCommit > 0);
  if (withChips.length <= 1 && !state.matchResult) {
    finishMatch(state, ctx, ev, withChips.length === 1
      ? state.seats.indexOf(withChips[0]) : -1);
  }
}

function finishHandFold(state, ctx, ev, winnerSeat) {
  const pot = state.seats.reduce((t, s) => t + s.handCommit, 0);
  finishHand(state, ctx, ev, {
    winnerSeats: [winnerSeat],
    description: `${state.seats[winnerSeat].name} wins ${pot} (everyone else folded)`,
    revealed: voluntaryReveals(state),
    potsWon: { [winnerSeat]: pot },
  });
}

// Folded players who opted to show their cards.
function voluntaryReveals(state) {
  const out = {};
  state.seats.forEach((s, i) => {
    if (s.folded && s.showCards && state.hand.holes[i]) out[i] = state.hand.holes[i].slice();
  });
  return out;
}

function finishHandShowdown(state, ctx, ev) {
  const rules = globalThis.pokerRules;
  const contesting = contestingSeats(state);

  // Evaluate every contesting hand.
  const scores = {};
  for (const i of contesting) {
    scores[i] = rules.evaluateHoldem(state.hand.holes[i], state.hand.board);
  }

  // Showdown reveals every contesting hand plus voluntary folded shows.
  const revealed = voluntaryReveals(state);
  for (const i of contesting) revealed[i] = state.hand.holes[i].slice();

  // Distribute each pot among its eligible winners.
  const potsWon = {};
  const potDescriptions = [];
  for (const pot of buildPots(state)) {
    const eligible = pot.eligible.filter((i) => contesting.includes(i));
    if (eligible.length === 0) continue;
    let best = null;
    let winners = [];
    for (const i of eligible) {
      if (!best || rules.compareScores(scores[i].score, best) > 0) {
        best = scores[i].score;
        winners = [i];
      } else if (rules.compareScores(scores[i].score, best) === 0) {
        winners.push(i);
      }
    }
    const payouts = splitPot(state, pot.amount, winners);
    for (const [seat, amount] of Object.entries(payouts)) {
      potsWon[seat] = (potsWon[seat] || 0) + amount;
    }
    potDescriptions.push(
      `${winners.map((w) => state.seats[w].name).join(', ')} — ${scores[winners[0]].description}`);
  }

  finishHand(state, ctx, ev, {
    winnerSeats: Object.keys(potsWon).map(Number),
    description: potDescriptions.join(' · '),
    revealed,
    potsWon,
  });
}

// Basic match completion (ratings land in checkpoint 17).
function finishMatch(state, ctx, ev, winnerSeat) {
  state.matchResult = {
    version: 1,
    winnerSeat,
    winnerUserId: winnerSeat >= 0 ? state.seats[winnerSeat].userId : null,
    winnerName: winnerSeat >= 0 ? state.seats[winnerSeat].name : null,
    hands: state.handNumber,
    endReason: 'last-player-with-chips',
    finalStacks: state.seats.map((s) => s.stack),
  };
  ev.push({
    type: 'match-complete',
    stateVersion: state.actionSeq,
    result: state.matchResult,
  });
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

    // Gameplay actions: only the acting human seat, only during a live hand.
    const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', 'all-in'];
    if (ACTIONS.includes(data.type)) {
      if (!state.hand.live) return fail('No hand is running');
      if (state.actingSeat !== seatIndex) return fail('It is not your turn');
      if (seat.folded) return fail('You have folded');
      if (seat.allIn) return fail('You are all-in');
      if (seat.eliminated) return fail('You are eliminated');
      if ((data.type === 'bet' || data.type === 'raise') &&
          !globalThis.pokerRules.isValidChips(data.amount)) {
        return fail('amount must be a non-negative safe integer');
      }

      const ev = [];
      const applied = applyPlayerAction(state, seatIndex, data.type, data.amount);
      if (applied.error) return fail(applied.error);
      ev.push({
        type: 'action',
        stateVersion: state.actionSeq,
        handNumber: state.handNumber,
        seat: seatIndex,
        action: applied.action,
        amount: applied.amount,
        pot: state.seats.reduce((t, s) => t + s.handCommit, 0),
      });
      advanceHand(state, ctx, ev);

      // Chain straight into the next hand when this one ended (keeps the game
      // moving without waiting for a tick).
      if (!state.hand.live && !state.matchResult) {
        if (startHand(state, ctx)) ev.push(handStartedBroadcast(state).data);
      }

      state.summary = summaryFor(state);
      const broadcast = stateBroadcasts(state);
      for (const e of ev) broadcast.unshift({ to: 'all', data: e });
      return { ok: true, sessionState: state, broadcast };
    }

    return fail('Unknown command: ' + data.type);
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
