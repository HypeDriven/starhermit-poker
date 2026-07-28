// Replay engine: reconstructs deterministic per-step views from the compact
// hand records stored in the archived session state. Pure and DOM-free — the
// same logic drives the browser viewer and the Node tests. Uses the shared
// pokerRules (injected) so replay behavior cannot drift from server behavior.

export const REPLAY_SPEEDS = [0.5, 1, 2, 4];

export class ReplayEngine {
  // replay: the archived session state { config, seats, hands, matchResult }.
  // rules: pokerRules (card names, evaluation for showdown descriptions).
  constructor(replay, rules) {
    this.rules = rules;
    this.config = replay.config;
    this.seatMeta = (replay.seats || []).map((s) => ({
      name: s.name, ai: s.ai, userId: s.userId,
    }));
    this.hands = replay.hands || [];
    this.matchResult = replay.matchResult || null;
  }

  handCount() {
    return this.hands.length;
  }

  // Stacks at the start of hand `handIdx`: initial stacks minus everything
  // committed, plus everything won, across all previous hands.
  stacksAtHandStart(handIdx) {
    const stacks = this.seatMeta.map(() => this.config.startingStack);
    for (let h = 0; h < handIdx && h < this.hands.length; h++) {
      const hand = this.hands[h];
      for (const [seat, , amount] of hand.actions) {
        if (seat >= 0) stacks[seat] -= amount;
      }
      for (const w of hand.winners || []) stacks[w.seat] += w.amount;
    }
    return stacks;
  }

  // Ordered display steps for one hand. Each step is a complete snapshot:
  // { label, board, pot, commits[], stacks[], activeSeat, reveal, winners,
  //   holes, folded[] }.
  // `holes` carries every dealt hand (archived post-match, participant-only);
  // `folded` tracks which seats had folded by that step.
  stepsForHand(handIdx) {
    const hand = this.hands[handIdx];
    if (!hand) return [];
    const startStacks = this.stacksAtHandStart(handIdx);
    const commits = this.seatMeta.map(() => 0);
    const folded = this.seatMeta.map(() => false);
    const holes = hand.holes || null;
    const steps = [];
    const snap = (label, extra = {}) => {
      steps.push({
        label,
        board: extra.board || [],
        pot: commits.reduce((t, c) => t + c, 0),
        commits: commits.slice(),
        stacks: startStacks.map((s, i) => s - commits[i] + (extra.won && extra.won[i] || 0)),
        activeSeat: extra.activeSeat ?? -1,
        reveal: extra.reveal || null,
        winners: extra.winners || null,
        holes,
        folded: folded.slice(),
      });
    };

    snap(`Hand #${hand.n} — blinds`, { activeSeat: hand.dealer });
    let boardShown = 0;
    for (const [seat, action, amount] of hand.actions) {
      if (seat === -1) {
        // Street marker: reveal the next board cards.
        const target = action === 'street-flop' ? 3 : action === 'street-turn' ? 4 : 5;
        boardShown = Math.min(target, hand.board.length);
        snap(action.replace('street-', '').toUpperCase(), {
          board: hand.board.slice(0, boardShown),
        });
        continue;
      }
      if (action === 'fold' || action === 'timeout-fold') folded[seat] = true;
      commits[seat] += amount;
      const name = this.seatMeta[seat] ? this.seatMeta[seat].name : `Seat ${seat + 1}`;
      snap(`${name} ${action}${amount ? ' ' + amount : ''}`, {
        board: hand.board.slice(0, boardShown),
        activeSeat: seat,
      });
    }
    // Final: showdown / result with payouts applied.
    const won = this.seatMeta.map(() => 0);
    for (const w of hand.winners || []) won[w.seat] = w.amount;
    snap(hand.winners && hand.winners.length
      ? hand.winners.map((w) => `${this.seatMeta[w.seat]?.name ?? 'Seat ' + (w.seat + 1)} +${w.amount}`).join(' · ')
      : 'Hand complete', {
      board: hand.board.slice(),
      reveal: hand.reveal || null,
      winners: hand.winners || [],
      won,
    });
    return steps;
  }

  // Per-seat win probability at a step, computed from the archived hole
  // cards and the board shown at that step (folded seats get null). Lazy and
  // memoized: equity only changes when the board or the live-seat set does.
  // Returns null for old replays without archived holes.
  equityForStep(handIdx, step) {
    if (!step || !step.holes || !this.rules.equity) return null;
    const key = `${handIdx}|${step.board.length}|${step.folded.map((f) => (f ? 1 : 0)).join('')}`;
    if (!this._equityCache) this._equityCache = new Map();
    if (!this._equityCache.has(key)) {
      const holesBySeat = step.holes.map((h, i) => (h && !step.folded[i] ? h : null));
      this._equityCache.set(key, this.rules.equity(holesBySeat, step.board));
    }
    return this._equityCache.get(key);
  }

  // Cards a replay may display for a seat in a hand: the full archived hand
  // (post-match, participant-only), falling back to the recorded reveal
  // (showdown/voluntary show) for replays archived before holes were kept.
  visibleCards(handIdx, seat) {
    const hand = this.hands[handIdx];
    if (!hand) return null;
    if (hand.holes && hand.holes[seat]) return hand.holes[seat];
    return hand.reveal ? hand.reveal[seat] || null : null;
  }
}
