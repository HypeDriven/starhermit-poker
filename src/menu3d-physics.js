// Zero-gravity drift physics for the menu's floating cards.
//
// Pure math, no three.js — the node test-suite imports this file directly.
// Cards drift freely (no gravity) inside a soft torus shell above the poker
// table: a weak spring pulls them back toward the shell whenever they stray,
// so they never escape into the walls or sink into the felt.

export const SHELL = {
  center: [0, 4.1, 0], // ring centre (above the table)
  radius: 3.6,         // ring radius in the XZ plane
  tube: 1.9,           // allowed thickness around the ring
  spring: 0.55,        // radial spring strength (1/s^2 per unit error)
  damping: 0.35,       // velocity damping (1/s)
  maxSpeed: 0.85,
};

// Deterministic RNG so tests are stable.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One card's drift state: position, velocity, tumble axis and spin rate.
export function makeDriftState(rand = Math.random, shell = SHELL) {
  const ang = rand() * Math.PI * 2;
  const r = shell.radius + (rand() - 0.5) * shell.tube;
  const axis = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
  const len = Math.hypot(...axis) || 1;
  return {
    pos: [
      shell.center[0] + Math.cos(ang) * r,
      shell.center[1] + (rand() - 0.5) * shell.tube,
      shell.center[2] + Math.sin(ang) * r,
    ],
    vel: [(rand() - 0.5) * 0.5, (rand() - 0.5) * 0.3, (rand() - 0.5) * 0.5],
    axis: [axis[0] / len, axis[1] / len, axis[2] / len],
    spin: 0.25 + rand() * 0.9,      // rad/s tumble
    orbit: 0.05 + rand() * 0.12,    // rad/s slow swirl around the table
    phase: rand() * Math.PI * 2,
  };
}

// Advance one card by dt seconds. Mutates and returns the state.
export function stepDrift(s, dt, t = 0, shell = SHELL) {
  const [cx, cy, cz] = shell.center;
  const dx = s.pos[0] - cx;
  const dz = s.pos[2] - cz;
  const dy = s.pos[1] - cy;

  // Nearest point on the shell's ring circle (in the XZ plane).
  const ringDist = Math.hypot(dx, dz) || 1e-6;
  const radialErr = ringDist - shell.radius;
  const nx = dx / ringDist;
  const nz = dz / ringDist;

  // Spring toward the ring tube, plus a gentle vertical centring.
  let ax = -nx * radialErr * shell.spring;
  let az = -nz * radialErr * shell.spring;
  let ay = -dy * shell.spring * 0.8;

  // Slow swirl around the table (tangent to the ring) keeps the cloud alive.
  ax += -nz * s.orbit;
  az += nx * s.orbit;
  // Barely-there breathing so the drift never looks mechanical.
  ay += Math.sin(t * 0.4 + s.phase) * 0.02;

  s.vel[0] += ax * dt;
  s.vel[1] += ay * dt;
  s.vel[2] += az * dt;

  const damp = Math.max(0, 1 - shell.damping * dt);
  s.vel[0] *= damp; s.vel[1] *= damp; s.vel[2] *= damp;

  const speed = Math.hypot(...s.vel);
  if (speed > shell.maxSpeed) {
    const k = shell.maxSpeed / speed;
    s.vel[0] *= k; s.vel[1] *= k; s.vel[2] *= k;
  }

  s.pos[0] += s.vel[0] * dt;
  s.pos[1] += s.vel[1] * dt;
  s.pos[2] += s.vel[2] * dt;
  return s;
}

export function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
