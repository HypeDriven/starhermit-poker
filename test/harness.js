// Test harness: loads plain-script files (server.js) into a vm context exactly
// the way the Jint sandbox sees them, plus deterministic host adapters
// (seeded ctx.now / ctx.random) for lifecycle tests.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Load a plain (non-module) script and return its sandbox global object.
export function loadScript(relPath) {
  const code = readFileSync(join(root, relPath), 'utf8');
  const sandbox = Object.create(null);
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: relPath });
  return sandbox;
}

// Deterministic host adapters: the production script must only ever use
// ctx.now / ctx.random; tests drive them from fixed sequences.
export function makeCtx(overrides = {}) {
  const ctx = {
    now: 1_721_473_200_000,
    random: 0.5,
    sessionId: 'test-session',
    players: [],
    sessionState: null,
    playerStates: null,
    ...overrides,
  };
  return ctx;
}

// A ctx factory whose random values come from a repeatable sequence
// (wraps around). Use when a test needs several host calls.
export function makeSeededHost(randoms, startNow = 1_721_473_200_000) {
  let i = 0;
  let now = startNow;
  return {
    nextRandom() {
      const v = randoms[i % randoms.length];
      i += 1;
      return v;
    },
    now() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
  };
}
