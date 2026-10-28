// The rules engine on the client: server.js (the platform's authoritative
// script) evaluated as a classic script, as the browser build loaded it with
// a <script> tag, so its globals are this module's exports — `game` (the
// script's entry points, which the offline table drives with a local host
// adapter) and `pokerRules` (the pure rules the replay viewer rebuilds hands
// with). Nothing here is a second copy of the rules.
import { loadClassic } from "starhermit:script";

loadClassic("server.js");

export interface LegalActions {
  canFold: boolean; canCheck: boolean; canBet: boolean; canRaise: boolean; canAllIn?: boolean;
  callAmount: number; minimumAmount: number; maximumAmount: number;
}
export interface PublicSeat {
  seat: number; userId: string | null; name: string; ai: boolean; stack: number; roundCommit: number;
  inHand: boolean; folded: boolean; allIn: boolean; eliminated: boolean; sittingOut?: boolean; disconnected?: boolean; left?: boolean;
}
export interface MatchResult { winnerSeat: number; winnerUserId: string | null; winnerName: string; hands?: number }
export interface PublicState {
  handNumber: number; street: string | null; board: number[]; pot: number; currentBet: number;
  dealerSeat: number; smallBlindSeat: number; bigBlindSeat: number; actingSeat: number; turnDeadlineMs: number | null;
  seats: PublicSeat[]; recentLog: unknown[]; prevHand: { reveal?: Record<number, number[]> } | null; matchResult: MatchResult | null;
}
export interface You { seat: number; holeCards: number[] | null; legalActions: LegalActions | null }
interface Rules {
  equity(holes: (number[] | null)[], board: number[], iterations?: number): (number | null)[];
}
type Invoke = (ctx: Record<string, unknown>) => { ok?: boolean; error?: string; sessionState?: unknown; playerStates?: unknown; broadcast?: unknown[] };
export interface Game { createSession: Invoke; onPlayerMessage: Invoke; onTick: Invoke }

const g = globalThis as unknown as { game: Game; pokerRules: Rules };
export const game = g.game;
export const pokerRules = g.pokerRules;
