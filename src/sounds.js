// Procedural UI sound effects — no audio assets, everything is synthesized
// with WebAudio oscillators and filtered noise. Kept subtle (low master gain)
// and behind an on/off toggle. The AudioContext is created lazily and resumed
// from a user gesture (unlock) to satisfy browser autoplay policies.
//
// The context factory is injectable so the sequencing logic is unit-testable
// in Node with a stub context.

export class SoundFX {
  constructor({ contextFactory = null, masterGain = 0.12 } = {}) {
    this._factory = contextFactory || (() => {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      return AC ? new AC() : null;
    });
    this._masterGain = masterGain;
    this.ctx = null;
    this.master = null;
    this.enabled = true;
  }

  setEnabled(on) {
    this.enabled = !!on;
  }

  // Create/resume the context. Must be called from a user gesture at least
  // once before sounds become audible in browsers.
  unlock() {
    const ctx = this._ensure();
    if (ctx && typeof ctx.resume === 'function' && ctx.state === 'suspended') {
      ctx.resume();
    }
  }

  _ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      this.ctx = this._factory();
      if (!this.ctx) { this.enabled = false; return null; }
      this.master = this.ctx.createGain();
      this.master.gain.value = this._masterGain;
      this.master.connect(this.ctx.destination);
    }
    if (typeof this.ctx.resume === 'function' && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  // --- building blocks ------------------------------------------------------

  _noiseBuffer(ctx, seconds = 0.2) {
    const frames = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  // Filtered noise swish (card slide/snap).
  _noise({ at = 0, dur = 0.09, from = 2600, to = 900, gain = 0.5, q = 1.2 }) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer(ctx, dur + 0.02);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  // Single tone with a pitch glide and decay envelope.
  _tone({ at = 0, dur = 0.12, from = 440, to = null, gain = 0.25, type = 'sine' }) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // --- effects ---------------------------------------------------------------

  // A hole card being dealt: quick paper swish.
  deal() {
    this._noise({ dur: 0.08, from: 2800, to: 1100, gain: 0.4 });
  }

  // A community card landing on the felt: snap + soft thud.
  place() {
    this._noise({ dur: 0.06, from: 3400, to: 1600, gain: 0.35, q: 2 });
    this._tone({ dur: 0.09, from: 170, to: 120, gain: 0.18 });
  }

  // Chips pushed into the pot: a few bright clicks.
  chips() {
    for (let i = 0; i < 3; i++) {
      this._tone({ at: i * 0.035, dur: 0.025, from: 2400 + i * 500, gain: 0.14, type: 'square' });
    }
  }

  // Hand won: short three-note chime.
  win() {
    this._tone({ at: 0, dur: 0.14, from: 659, gain: 0.2 });      // E5
    this._tone({ at: 0.09, dur: 0.14, from: 784, gain: 0.2 });   // G5
    this._tone({ at: 0.18, dur: 0.24, from: 1047, gain: 0.22 }); // C6
  }

  // Your turn: a single soft blip.
  turn() {
    this._tone({ dur: 0.11, from: 880, to: 990, gain: 0.16 });
  }
}
