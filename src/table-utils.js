// Pure table helpers shared by the engine client and the node tests.

import { t, num } from './i18n.js';

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
// as a plain sentence for the activity feed. `seats` is the public seat array
// (for names); the log stores chips POSTED (not raise totals), so raises read
// "raised N". seat === -1 marks a street transition.
export function describeLogEntry(entry, seats) {
  const [, , seat, action, amount] = entry;
  if (seat === -1) return t('street-dealt.' + action.replace('street-', ''));
  const raw = seats && seats[seat] ? seatName(seats[seat]) : t('Seat {n}', { n: seat + 1 });
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  const chips = num(amount);
  switch (action) {
    case 'fold': return t('{name} folded.', { name });
    case 'timeout-fold': return t('{name} ran out of time and folded.', { name });
    case 'check': return t('{name} checked.', { name });
    case 'timeout-check': return t('{name} ran out of time and checked.', { name });
    case 'call': return t('{name} called {chips}.', { name, chips });
    case 'bet': return t('{name} bet {chips}.', { name, chips });
    case 'raise': return t('{name} raised {chips}.', { name, chips });
    case 'all-in': return t('{name} went all-in.', { name });
    case 'blind': return t('{name} posted a blind of {chips}.', { name, chips });
    default: return `${name} ${action}${amount ? ` ${chips}` : ''}.`;
  }
}

// A seat's display name: the offline player's own seat is "You" in the
// game language; everyone else keeps their (nick)name.
export function seatName(seat) {
  return seat && seat.userId === 'local-player' ? t('You') : (seat && seat.name) || '';
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
