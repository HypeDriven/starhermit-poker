import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoundFX } from '../src/sounds.js';

// Minimal AudioContext stub recording node creation and scheduling calls.
function fakeContext() {
  const log = { oscillators: 0, buffers: 0, gains: 0, filters: 0, started: 0 };
  const param = () => ({
    value: 0,
    setValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
  });
  const node = () => ({ connect: () => {}, start: () => { log.started += 1; }, stop: () => {} });
  const ctx = {
    currentTime: 1,
    sampleRate: 8000,
    state: 'running',
    destination: {},
    resume: () => {},
    createGain: () => { log.gains += 1; return { ...node(), gain: param() }; },
    createOscillator: () => { log.oscillators += 1; return { ...node(), type: '', frequency: param() }; },
    createBiquadFilter: () => { log.filters += 1; return { ...node(), type: '', frequency: param(), Q: param() }; },
    createBufferSource: () => ({ ...node(), buffer: null }),
    createBuffer: (ch, frames) => {
      log.buffers += 1;
      return { getChannelData: () => new Float32Array(frames) };
    },
  };
  return { ctx, log };
}

test('effects schedule nodes through the context', () => {
  const { ctx, log } = fakeContext();
  const fx = new SoundFX({ contextFactory: () => ctx });
  fx.deal();
  assert.ok(log.buffers >= 1 && log.filters >= 1, 'deal uses filtered noise');
  fx.place();
  fx.chips();
  fx.win();
  fx.turn();
  assert.ok(log.oscillators >= 7, `expected tones, got ${log.oscillators}`);
  assert.ok(log.started >= 8, 'sources are started');
});

test('the context is created lazily and resumed when suspended', () => {
  let created = 0;
  let resumed = 0;
  const { ctx } = fakeContext();
  ctx.state = 'suspended';
  ctx.resume = () => { resumed += 1; };
  const fx = new SoundFX({ contextFactory: () => { created += 1; return ctx; } });
  assert.equal(created, 0);
  fx.turn();
  assert.equal(created, 1);
  assert.ok(resumed >= 1);
  fx.turn(); // reuses the same context
  assert.equal(created, 1);
});

test('disabled sound effects create no context and no nodes', () => {
  let created = 0;
  const fx = new SoundFX({ contextFactory: () => { created += 1; return fakeContext().ctx; } });
  fx.setEnabled(false);
  fx.deal(); fx.place(); fx.chips(); fx.win(); fx.turn(); fx.unlock();
  assert.equal(created, 0);
  fx.setEnabled(true);
  fx.turn();
  assert.equal(created, 1);
});

test('a missing AudioContext disables effects gracefully', () => {
  const fx = new SoundFX({ contextFactory: () => null });
  fx.deal(); fx.win(); fx.unlock();
  assert.equal(fx.enabled, false);
});
