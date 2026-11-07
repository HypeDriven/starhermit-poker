// Sound, as the browser build's src/sounds.js synthesized it with WebAudio
// (`sfx=synthesized` in starhermit.txt: there are no authored clips): a paper
// swish when a hand is dealt, a snap and a soft thud when a community card
// lands, a few bright chip clicks when the pot grows, a three-note chime when
// a hand is won, and a soft blip when the action moves to you. The browser
// build ran an oscillator / bandpass-filtered noise graph per cue, and so does
// this: each cue is rendered once at start on an OfflineAudioContext into a clip
// played on the "effects" bus. The old master gain (0.12) is baked in; the
// runtime's Options own the volumes, the mute and the voice limit (they replaced
// the table's Sound on/off button).
import { createClip, OfflineAudioContext, play as playClip, type AudioClip, type GainNode } from "starhermit:audio";

const RATE = 44100;
const MASTER = 0.12;
export type Cue = "deal" | "place" | "chips" | "win" | "turn";

/** setValueAtTime(0.0001) → exponentialRamp(peak, attack) → exponentialRamp(0.0001, dur), then silence. */
function envelope(off: OfflineAudioContext, at: number, attack: number, dur: number, peak: number): GainNode {
  const g = off.createGain();
  g.gain.setValueAtTime(0.0001 * MASTER, at);
  g.gain.exponentialRampToValueAtTime(peak * MASTER, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001 * MASTER, at + dur);
  g.gain.setValueAtTime(0, at + dur);
  g.connect(off.destination);
  return g;
}
interface Noise { at?: number; dur?: number; from?: number; to?: number; gain?: number; q?: number }
/** sounds.js _noise: band-passed noise whose centre sweeps from → to. */
function addNoise(off: OfflineAudioContext, { at = 0, dur = 0.09, from = 2600, to = 900, gain = 0.5, q = 1.2 }: Noise, seed: number): void {
  const noise = off.createNoise({ seed, seconds: dur + 0.05 });
  const bp = off.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = q;
  bp.frequency.setValueAtTime(from, at);
  bp.frequency.exponentialRampToValueAtTime(to, at + dur);
  noise.connect(bp).connect(envelope(off, at, 0.012, dur, gain));
  noise.start(at);
}
interface Tone { at?: number; dur?: number; from?: number; to?: number | null; gain?: number; type?: "sine" | "square" }
/** sounds.js _tone: one oscillator with a pitch glide and a decay envelope. */
function addTone(off: OfflineAudioContext, { at = 0, dur = 0.12, from = 440, to = null, gain = 0.25, type = "sine" }: Tone): void {
  const osc = off.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
  osc.connect(envelope(off, at, 0.01, dur, gain));
  osc.start(at);
  osc.stop(at + dur + 0.05);
}
const RENDER: Record<Cue, { seconds: number; draw: (off: OfflineAudioContext) => void }> = {
  // A hole card being dealt: a quick paper swish.
  deal: { seconds: 0.15, draw: (o) => addNoise(o, { dur: 0.08, from: 2800, to: 1100, gain: 0.4 }, 11) },
  // A community card landing on the felt: a snap and a soft thud.
  place: { seconds: 0.16, draw: (o) => { addNoise(o, { dur: 0.06, from: 3400, to: 1600, gain: 0.35, q: 2 }, 23); addTone(o, { dur: 0.09, from: 170, to: 120, gain: 0.18 }); } },
  // Chips pushed into the pot: a few bright clicks (0.171: the old 0.14 on a naive square, by measured rms).
  chips: { seconds: 0.17, draw: (o) => { for (let i = 0; i < 3; i++) addTone(o, { at: i * 0.035, dur: 0.025, from: 2400 + i * 500, gain: 0.171, type: "square" }); } },
  // A hand won: a short three-note chime (E5, G5, C6).
  win: { seconds: 0.48, draw: (o) => { addTone(o, { at: 0, dur: 0.14, from: 659, gain: 0.2 }); addTone(o, { at: 0.09, dur: 0.14, from: 784, gain: 0.2 }); addTone(o, { at: 0.18, dur: 0.24, from: 1047, gain: 0.22 }); } },
  // Your turn: a single soft blip.
  turn: { seconds: 0.17, draw: (o) => addTone(o, { dur: 0.11, from: 880, to: 990, gain: 0.16 }) },
};
const clips = new Map<Cue, AudioClip>();

/** Renders every cue, one context a cue. */
export function load(): void {
  for (const cue of Object.keys(RENDER) as Cue[]) {
    const r = RENDER[cue];
    const off = new OfflineAudioContext(1, Math.ceil(r.seconds * RATE), RATE);
    r.draw(off);
    void off.startRendering().then((rendered) => { clips.set(cue, createClip(rendered)); })
      .catch((e: unknown) => console.warn(`audio: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** Plays a cue (silent until its clip is rendered: the first press unlocks web audio). */
export function play(cue: Cue): void {
  const clip = clips.get(cue);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* the mixer is full this frame: skip it */ }
}
