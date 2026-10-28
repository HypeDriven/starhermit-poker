// The replay viewer's per-seat win chances (server.js pokerRules.equity:
// exact enumeration with two or fewer board cards to come, else a fixed-seed
// 1,000-board Monte Carlo) on a worker (native/equity-worker.js), so a
// preflop step never stalls a frame in the native interpreter. Answers are
// memoized by the live hands and the board, as replay-engine.js memoized
// them; without a worker it computes on the game's thread.
import { worker, type Worker } from "starhermit:script";
import { pokerRules } from "./classic.ts";

type Eq = (number | null)[];
const cache = new Map<string, Eq | "pending">();
let w: Worker | null = null;
let failed = false;

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/equity-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as { key: string; eq: Eq };
      cache.set(r.key, r.eq);
    });
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`equity worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      for (const [k, v] of cache) if (v === "pending") cache.delete(k);
    });
  } catch (e) { console.warn(`equity worker: ${String(e)}`); failed = true; w = null; }
  return w;
}

/** The win chances for these live hands on this board (null while the worker computes). */
export function get(holes: (number[] | null)[], board: number[]): Eq | null {
  const key = `${JSON.stringify(holes)}|${board.join(",")}`;
  const hit = cache.get(key);
  if (hit === "pending") return null;
  if (hit) return hit;
  const wk = ensure();
  if (!wk) {
    const eq = pokerRules.equity(holes, board);
    cache.set(key, eq);
    return eq;
  }
  cache.set(key, "pending");
  try { wk.post({ key, holes, board }); }
  catch { cache.set(key, pokerRules.equity(holes, board)); }
  return null;
}
