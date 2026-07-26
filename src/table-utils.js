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

// Bet-sizing preset → NEW ROUND TOTAL (the table-wide raise convention).
// kind: 'min' | 'all' | fraction of the pot (after calling).
export function presetTotal(la, roundCommit, pot, kind) {
  if (kind === 'min') return la.minimumAmount;
  if (kind === 'all') return la.maximumAmount;
  const toCall = la.callAmount;
  const total = roundCommit + toCall + Math.ceil(kind * (pot + toCall));
  return Math.max(la.minimumAmount, Math.min(total, la.maximumAmount));
}
