// Sound, as the browser build's src/sounds.js synthesized it with WebAudio
// (`sfx=synthesized` in starhermit.txt: there are no authored clips): a paper
// swish when a hand is dealt, a snap and a soft thud when a community card
// lands, a few bright chip clicks when the pot grows, a three-note chime when
// a hand is won, and a soft blip when the action moves to you. The browser
// build ran an oscillator / bandpass-filtered noise graph per cue; a live
// synthesis graph is not ported (it makes clip loads fail on the engine's web
// runtime), so each cue is rendered once here, sample by sample with the same
// oscillators, filter sweeps and exponential envelopes (an RBJ band-pass for
// BiquadFilterNode), into a clip (createClip, one cue a frame once the mixer
// runs) and played on the "effects" bus. The old master gain (0.12) is baked
// in; the runtime's Options own the volumes, the mute and the voice limit
// (they replaced the table's Sound on/off button).
import { context, createClip, play as playClip, type AudioClip } from "starhermit:audio";

const RATE = 44100;
const MASTER = 0.12;
export type Cue = "deal" | "place" | "chips" | "win" | "turn";

/** A deterministic noise source (the old buffers used Math.random). */
function noiseSource(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}
/** setValueAtTime(0.0001) → exponentialRamp(peak, attack) → exponentialRamp(0.0001, dur). */
function envelope(t: number, attack: number, dur: number, peak: number): number {
  if (t < 0 || t > dur) return 0;
  if (t < attack) return 0.0001 * Math.pow(peak / 0.0001, t / attack);
  return peak * Math.pow(0.0001 / peak, (t - attack) / (dur - attack));
}
interface Noise { at?: number; dur?: number; from?: number; to?: number; gain?: number; q?: number }
/** sounds.js _noise: band-passed noise whose centre sweeps from → to. */
function addNoise(out: Float32Array, { at = 0, dur = 0.09, from = 2600, to = 900, gain = 0.5, q = 1.2 }: Noise, seed: number): void {
  const rnd = noiseSource(seed);
  const start = Math.round(at * RATE);
  const n = Math.round((dur + 0.05) * RATE);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / RATE;
    const f = t < dur ? from * Math.pow(to / from, t / dur) : to;
    const w = (2 * Math.PI * f) / RATE;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
    const x = rnd();
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[start + i] = out[start + i]! + y * envelope(t, 0.012, dur, gain) * MASTER;
  }
}
interface Tone { at?: number; dur?: number; from?: number; to?: number | null; gain?: number; type?: "sine" | "square" }
/** sounds.js _tone: one oscillator with a pitch glide and a decay envelope. */
function addTone(out: Float32Array, { at = 0, dur = 0.12, from = 440, to = null, gain = 0.25, type = "sine" }: Tone): void {
  const start = Math.round(at * RATE);
  const n = Math.round((dur + 0.05) * RATE);
  let phase = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / RATE;
    const f = to && t < dur ? from * Math.pow(to / from, t / dur) : (to ?? from);
    phase += f / RATE;
    const p = phase % 1;
    const s = type === "square" ? (p < 0.5 ? 1 : -1) : Math.sin(2 * Math.PI * p);
    out[start + i] = out[start + i]! + s * envelope(t, 0.01, dur, gain) * MASTER;
  }
}
const RENDER: Record<Cue, { seconds: number; draw: (out: Float32Array) => void }> = {
  // A hole card being dealt: a quick paper swish.
  deal: { seconds: 0.15, draw: (o) => addNoise(o, { dur: 0.08, from: 2800, to: 1100, gain: 0.4 }, 11) },
  // A community card landing on the felt: a snap and a soft thud.
  place: { seconds: 0.16, draw: (o) => { addNoise(o, { dur: 0.06, from: 3400, to: 1600, gain: 0.35, q: 2 }, 23); addTone(o, { dur: 0.09, from: 170, to: 120, gain: 0.18 }); } },
  // Chips pushed into the pot: a few bright clicks.
  chips: { seconds: 0.17, draw: (o) => { for (let i = 0; i < 3; i++) addTone(o, { at: i * 0.035, dur: 0.025, from: 2400 + i * 500, gain: 0.14, type: "square" }); } },
  // A hand won: a short three-note chime (E5, G5, C6).
  win: { seconds: 0.48, draw: (o) => { addTone(o, { at: 0, dur: 0.14, from: 659, gain: 0.2 }); addTone(o, { at: 0.09, dur: 0.14, from: 784, gain: 0.2 }); addTone(o, { at: 0.18, dur: 0.24, from: 1047, gain: 0.22 }); } },
  // Your turn: a single soft blip.
  turn: { seconds: 0.17, draw: (o) => addTone(o, { dur: 0.11, from: 880, to: 990, gain: 0.16 }) },
};
const ORDER: Cue[] = ["turn", "chips", "deal", "place", "win"];
const clips = new Map<Cue, AudioClip>();
let failed = false;

/** Plays a cue (silent until its clip is rendered: the first press unlocks web audio). */
export function play(cue: Cue): void {
  const clip = clips.get(cue);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { clips.delete(cue); }
}

/** Each frame: renders the next missing clip once the mixer runs (one a frame). */
export function update(): void {
  if (failed || context.state !== "running") return;
  const next = ORDER.find((c) => !clips.has(c));
  if (!next) return;
  const r = RENDER[next];
  const pcm = new Float32Array(Math.ceil(r.seconds * RATE));
  r.draw(pcm);
  try { clips.set(next, createClip([pcm], RATE)); }
  catch (e) { failed = true; console.warn(`audio: ${e instanceof Error ? e.message : String(e)}`); }
}
