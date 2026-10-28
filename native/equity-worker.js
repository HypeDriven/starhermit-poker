// Win chances for the replay viewer off the game's thread (starhermit:script
// worker, a module): server.js's pure pokerRules.equity, unchanged.
// Message in: { key, holes, board }. Message out: { key, eq }.
import "../server.js";

globalThis.onmessage = (e) => {
  const d = e.data;
  let eq = null;
  try { eq = globalThis.pokerRules.equity(d.holes, d.board); } catch { eq = d.holes.map(() => null); }
  postMessage({ key: d.key, eq });
};
