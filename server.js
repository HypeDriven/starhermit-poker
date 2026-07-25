// StarHermit Poker — server-authoritative game script (StarHermit Jint sandbox).
// Contract: https://wiki.starhermit.com/docs/api/game-scripts.html
//
// This is a checkpoint-2 stub. The full engine lands in checkpoints 6-12.
// The full command/broadcast protocol will be documented here before the
// engine is implemented, per the integration plan.
//
// Sandbox rules honored from day one: no imports, no Date, no Math.random,
// no network/filesystem. Clock from ctx.now, randomness from ctx.random.

globalThis.pokerRules = {
  // Pure, host-independent poker functions (deck, evaluator, pot math).
  // Shared by the server script, the browser replay viewer, and Node tests.
  version: 1,
};

globalThis.game = {
  createSession(ctx) {
    // Minimal placeholder: establishes the state envelope + platform summary.
    return {
      ok: true,
      sessionState: {
        schemaVersion: 1,
        status: 'active',
        summary: { turnPlayerId: null, deadline: null, status: 'active', moveCount: 0 },
      },
    };
  },
  onPlayerMessage(ctx) {
    return { ok: false, error: 'Table is not running yet' };
  },
  onTick(ctx) {
    return { ok: true };
  },
};
