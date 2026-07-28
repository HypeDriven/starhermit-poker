// Pure table-UI helpers (no three.js / DOM dependencies — unit-testable).

// Seat visual order: the player's own seat sits at the bottom center.
export function seatVisual(seatIndex, youSeat, seatCount = 6) {
  return (seatIndex - youSeat + seatCount) % seatCount;
}

export function seatUnit(visual, seatCount = 6) {
  // Unit-circle position shared by the 3D ellipse and the DOM overlays.
  const angle = Math.PI / 2 + (visual * (2 * Math.PI)) / seatCount;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

// Defense-in-depth for card privacy. The live protocol never contains another
// seat's cards; this helper therefore renders only the viewer's addressed hand
// or anonymous backs. Showdown evidence stays server-side for later replays.
export function visibleCardsForSeat(seat, you) {
  const own = you && you.seat === seat.seat && Array.isArray(you.holeCards) &&
    you.holeCards.length === 2;
  if (seat.inHand) return own ? you.holeCards.slice() : [-1, -1];
  return null;
}

// One raw action-log entry ([seq, handNumber, seat, action, amount]) rendered
// for the activity feed. `seats` is the public seat array (for names); the
// log stores chips POSTED (not raise totals), so raises read "raises N".
// seat === -1 marks a street transition.
export function describeLogEntry(entry, seats) {
  const [, , seat, action, amount] = entry;
  if (seat === -1) return `${action.replace('street-', '')} dealt`;
  const name = seats && seats[seat] ? seats[seat].name : `Seat ${seat + 1}`;
  switch (action) {
    case 'fold': case 'timeout-fold': return `${name} folds${action.startsWith('timeout') ? ' (time)' : ''}`;
    case 'check': case 'timeout-check': return `${name} checks${action.startsWith('timeout') ? ' (time)' : ''}`;
    case 'call': return `${name} calls ${amount}`;
    case 'bet': return `${name} bets ${amount}`;
    case 'raise': return `${name} raises ${amount}`;
    case 'all-in': return `${name} is all-in`;
    case 'blind': return `${name} posts ${amount}`;
    default: return `${name}: ${action} ${amount || ''}`;
  }
}

// Bet-sizing preset → NEW ROUND TOTAL (the table-wide raise convention).
// kind: 'min' | 'all' | fraction of the pot (after calling).
export function presetTotal(la, roundCommit, pot, kind) {
  if (kind === 'min') return la.minimumAmount;
  if (kind === 'all') return la.maximumAmount;
  const toCall = la.callAmount;
  const total = roundCommit + toCall + Math.ceil(kind * (pot + toCall));
  return Math.max(la.minimumAmount, Math.min(total, la.maximumAmount));
}
