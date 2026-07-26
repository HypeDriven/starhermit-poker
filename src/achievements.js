// Achievement catalog for StarHermit Poker.
//
// PLATFORM LIMITATION (verified against the wiki, achievements.html):
// StarHermit achievements target catalog-distributed titles; unlocks are
// CLIENT-REPORTED (POST /api/v1/me/achievements/unlock) and require an
// entitlement to the title. Scripted GitHub games (like this one) have no
// script-side unlock hook — the game-script contract exposes only
// sessionState/playerStates/broadcast/eloUpdates/result. The wiki explicitly
// notes scripted games typically don't use achievements.
//
// Consequence: server-authoritative unlocks are IMPOSSIBLE in this
// architecture, and a client-reported unlock for poker would be exploitable
// (any client could claim "Win With a Straight Flush"). We therefore do NOT
// wire unlocking. This module is the centralized definition plus a pure
// derivation from script-authoritative evidence (match results and hand
// records emitted by server.js), ready for a future platform mechanism —
// and usable today as read-only "achievement progress" display.

export const ACHIEVEMENTS = Object.freeze([
  { key: 'first-hand', name: 'First Hand', description: 'Play your first hand of StarHermit Poker.', secret: false, points: 5 },
  { key: 'first-win', name: 'First Match Win', description: 'Win your first match.', secret: false, points: 10 },
  { key: 'win-full-house', name: 'Win With a Full House', description: 'Win a hand with a full house.', secret: false, points: 15 },
  { key: 'win-quads', name: 'Win With Four of a Kind', description: 'Win a hand with four of a kind.', secret: false, points: 20 },
  { key: 'win-straight-flush', name: 'Win With a Straight Flush', description: 'Win a hand with a straight flush.', secret: true, points: 50 },
  { key: 'win-all-in', name: 'Win an All-In', description: 'Win a hand where you were all-in.', secret: false, points: 15 },
  { key: 'win-10k-pot', name: 'Win a Pot of 10,000 Chips', description: 'Win a single pot of at least 10,000 chips.', secret: false, points: 20 },
  { key: 'defeat-five', name: 'Defeat Five Opponents', description: 'Eliminate five opponents across your matches.', secret: false, points: 25 },
  { key: 'streak-three', name: 'Three-Match Win Streak', description: 'Win three matches in a row.', secret: false, points: 30 },
]);

// Derive unlocked keys from script-authoritative evidence:
//   evidence: {
//     handsPlayed, matchesWon, bestStreak, eliminations,   // lifetime stats
//     winningHands: [{ category, allIn, pot }],            // from hand records
//   }
// Every input must originate from server broadcasts/results — never from
// client-side game state alone.
export function deriveUnlocks(evidence) {
  const e = evidence || {};
  const unlocked = new Set();
  if ((e.handsPlayed || 0) >= 1) unlocked.add('first-hand');
  if ((e.matchesWon || 0) >= 1) unlocked.add('first-win');
  if ((e.bestStreak || 0) >= 3) unlocked.add('streak-three');
  if ((e.eliminations || 0) >= 5) unlocked.add('defeat-five');
  for (const h of e.winningHands || []) {
    if (h.category >= 6) unlocked.add('win-full-house');
    if (h.category >= 7) unlocked.add('win-quads');
    if (h.category >= 8) unlocked.add('win-straight-flush');
    if (h.allIn) unlocked.add('win-all-in');
    if ((h.pot || 0) >= 10000) unlocked.add('win-10k-pot');
  }
  return unlocked;
}
