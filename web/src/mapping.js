// Signals -> flame parameters.
//
// MAPPINGS is the declarative table of routes. Each row is
//   { src: <SOURCES key>, target: <TARGETS key>, amount: 1, ...overrides }
// and resolve() expands it into the full form the Mapper runs:
//   src      { stream: 'energy.intensity' }      continuous timeline stream
//            { impulse: 'kick', attack, release } decaying impulse from events
//            { derived: 'chromaPos' | 'chromaPeak' | 'bassPitch' }
//   gain     multiply the source              (default 1)
//   curve    shape applied after gain+clamp: a CURVES name ('quad', 'exp', ...)
//            or a number (power; default 1, >1 = more contrast)
//   attack / release   one-pole envelope time constants in seconds (media time)
//   out      [min, max]  the 0..1 value is mapped linearly onto this range
//            (row, then source, then target default)
//   amount   scales the route's deviation from the target's neutral value
//            (0 = off, 1 = as designed, negative = inverted)
//   target   name of a modulation slot, consumed by applyMods() below
// Overrides on a row (curve, attack, release, out, impulse) beat the target's
// and source's defaults. Several routes may share a target: their deviations add.
//
// Envelopes run on *media* time (t - tPrev), so pause freezes the visuals,
// playbackRate changes scale them correctly, and seeks reset them.

import { clone, rotateAffine, clampContractive } from './flame.js';

/**
 * Response curves, 0..1 -> 0..1. Anything steeper than linear keeps quiet
 * parts low and saves the range for peaks, so changes near the top stand out.
 */
const EXP_K = 5;
export const CURVES = {
  sqrt: { label: 'square root', fn: Math.sqrt },
  linear: { label: 'linear', fn: (x) => x },
  quad: { label: 'quadratic', fn: (x) => x * x },
  cubic: { label: 'cubic', fn: (x) => x * x * x },
  exp: { label: 'exponential', fn: (x) => Math.expm1(EXP_K * x) / Math.expm1(EXP_K) },
};

/** Apply a route's curve (CURVES name, power, or undefined = linear) to a 0..1 value. */
export function shape(x, curve) {
  if (typeof curve === 'number') return Math.pow(x, curve);
  return CURVES[curve]?.fn(x) ?? x;
}

/** Signals a route can read. `env` is the default envelope for that kind of signal. */
export const SOURCES = {
  volume: { label: 'volume', src: { stream: 'volume' }, env: { curve: 1.6, attack: 0.03, release: 0.25 } },
  intensity: { label: 'intensity', src: { stream: 'energy.intensity' }, env: { attack: 0.3, release: 1.0 } },
  flux: { label: 'spectral flux', src: { stream: 'energy.flux' }, env: { attack: 0.02, release: 0.2 } },
  sub: { label: 'sub energy', src: { stream: 'energy.sub' }, env: { attack: 0.03, release: 0.25 } },
  bass: { label: 'bass energy', src: { stream: 'energy.bass' }, env: { attack: 0.03, release: 0.25 } },
  mid: { label: 'mid energy', src: { stream: 'energy.mid' }, env: { attack: 0.03, release: 0.25 } },
  high: { label: 'high energy', src: { stream: 'energy.high' }, env: { attack: 0.03, release: 0.25 } },
  kick: { label: 'kick hit', src: { impulse: 'kick' }, impulse: { attack: 0.008, release: 0.15 } },
  snare: { label: 'snare hit', src: { impulse: 'snare' }, impulse: { attack: 0.005, release: 0.2 } },
  hat: { label: 'hat hit', src: { impulse: 'hat' }, impulse: { attack: 0.004, release: 0.07 } },
  beat: { label: 'beat', src: { impulse: 'beats' }, impulse: { attack: 0.005, release: 0.15 } },
  onset: { label: 'onset', src: { impulse: 'onsets' }, impulse: { attack: 0.005, release: 0.1 } },
  note: { label: 'note', src: { impulse: 'notes' }, impulse: { attack: 0.005, release: 0.15 } },
  chroma: { label: 'chroma (average)', src: { derived: 'chromaPos' }, env: { attack: 0.6, release: 0.6 }, circular: true, out: [0, 0.35] },
  // strongest pitch class only: each note is its own palette position, over the whole gradient
  chromaPeak: { label: 'chroma peak', src: { derived: 'chromaPeak' }, env: { attack: 0.08, release: 0.08 }, circular: true },
  bassPitch: { label: 'bass pitch', src: { derived: 'bassPitch' }, env: { attack: 0.08, release: 0.08 } },
};

/** Modulation slots. `neutral` is the value with no routes; `out` the range at amount 1. */
export const TARGETS = {
  brightness: { label: 'brightness', neutral: 1, out: [0.45, 1.25] },
  spin: { label: 'spin speed', neutral: 0, out: [0.03, 0.55], env: { curve: 1.5, attack: 0.5, release: 1.5 } },
  iters: { label: 'iterations', neutral: 1, out: [0.55, 1.0] },
  zoomPulse: { label: 'zoom pulse', neutral: 0, out: [0, 0.09] },
  weightBump: { label: 'transform weight', neutral: 0, out: [0, 1.6] },
  paletteKick: { label: 'palette shift', neutral: 0, out: [0, 0.12] },
  palettePos: { label: 'palette position', neutral: 0, out: [0, 1] },
  juliaJitter: { label: 'julia blend', neutral: 0, out: [0, 0.3] },
  xformRotate: { label: 'transform rotate', neutral: 0, out: [-0.5, 0.5] },
};

// Beats show as light and colour, not motion: no zoom pulse, no transform
// weight bump, and the iteration budget stays fixed (zoomPulse, weightBump and
// iters remain available as targets in the route editor).
export const MAPPINGS = [
  { src: 'volume', target: 'brightness', amount: 1 },
  { src: 'kick', target: 'brightness', amount: 1, curve: 'quad', out: [1, 3.2], impulse: { attack: 0.008, release: 0.2 } },
  { src: 'beat', target: 'paletteKick', amount: 1, out: [0, 0.06], impulse: { attack: 0.01, release: 0.25 } },
  { src: 'snare', target: 'paletteKick', amount: 1 },
  { src: 'intensity', target: 'spin', amount: 1 },
  { src: 'hat', target: 'juliaJitter', amount: 1 },
  { src: 'chromaPeak', target: 'palettePos', amount: 1 },
  { src: 'bassPitch', target: 'xformRotate', amount: 1 },
];

/** Expand a route row into the full form the Mapper runs (see top of file). */
export function resolve(row, i = 0) {
  const S = SOURCES[row.src], T = TARGETS[row.target];
  if (!S || !T) throw new Error(`unknown route ${row.src} -> ${row.target}`);
  // slow targets (spin) keep their own smoothing on continuous sources;
  // impulses are already shaped, so they skip the envelope
  const env = S.src.impulse ? {} : { ...S.env, ...(S.circular ? {} : T.env) };
  return {
    id: `${S.label}→${T.label}#${i}`,
    src: S.src.impulse ? { ...S.src, ...S.impulse, ...row.impulse } : S.src,
    curve: row.curve ?? env.curve,
    attack: row.attack ?? env.attack,
    release: row.release ?? env.release,
    out: row.out ?? S.out ?? T.out,
    target: row.target,
    neutral: T.neutral,
    amount: row.amount ?? 1,
    circular: !!S.circular,
  };
}

export const MAP_DEFAULTS = {
  lookahead: 0.03,        // s: impulses lead the audio a little (output latency + perception)
  bassConf: 0.5,          // pYIN voiced-probability gate
  chromaSwitch: 0.85,     // chroma peak moves to a new pitch class only once the held one drops below this x the strongest
  chromaFloor: 0.2,       // ...and only if the strongest is at least this (quieter frames hold the last note)
  bassLoHz: 40, bassOctaves: 2,   // bassPitch 0..1 spans this range (log)
  maxGain: 0.98,          // affine contraction clamp
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const TAU = Math.PI * 2;

export class Mapper {
  constructor(timeline, routes = MAPPINGS, opts = {}) {
    this.tl = timeline;
    this.opts = { ...MAP_DEFAULTS, ...opts };
    this.chroma = new Float32Array(12);
    this.setRoutes(routes);
    this.reset();
  }

  /** Replace the route table (live; envelopes of unchanged routes carry over by id). */
  setRoutes(routes) {
    this.routes = routes;
    this.mappings = routes.map(resolve);
  }

  reset() {
    this.env = new Map();        // mapping id -> envelope value (or [cos, sin] for circular)
    this.tPrev = null;
    this.bassHold = 0.5;
    this.chromaHold = -1;
    this.spinPhase = this.spinPhase ?? 0;
    this.signals = {};           // last raw source values, for the debug overlay
    this.mods = {};
  }

  source(src, t) {
    const tl = this.tl;
    if (src.stream) return tl.sample(src.stream, t);
    if (src.impulse) {
      return tl.impulse(src.impulse, t, { attack: src.attack, release: src.release, lookahead: this.opts.lookahead });
    }
    if (src.derived === 'chromaPos') {
      // weighted circular mean of the 12 pitch classes -> 0..1 around the circle
      const c = tl.sampleChroma(t, this.chroma);
      let x = 0, y = 0;
      for (let k = 0; k < 12; k++) {
        const w = c[k] * c[k];
        x += w * Math.cos((k / 12) * TAU);
        y += w * Math.sin((k / 12) * TAU);
      }
      return ((Math.atan2(y, x) / TAU) + 1) % 1;
    }
    if (src.derived === 'chromaPeak') {
      // the strongest pitch class (k / 12), with hysteresis so near-ties don't flicker
      const c = tl.sampleChroma(t, this.chroma);
      let best = 0;
      for (let k = 1; k < 12; k++) if (c[k] > c[best]) best = k;
      const held = this.chromaHold;
      if (held < 0) this.chromaHold = best;
      else if (c[best] >= this.opts.chromaFloor && c[held] < this.opts.chromaSwitch * c[best]) this.chromaHold = best;
      return this.chromaHold / 12;
    }
    if (src.derived === 'bassPitch') {
      // confidence-gated, holds the last confident value
      const f0 = tl.sampleNearest('pitch.bass.f0', t);
      const conf = tl.sample('pitch.bass.conf', t);
      if (f0 > 0 && conf >= this.opts.bassConf) {
        this.bassHold = clamp01(Math.log2(f0 / this.opts.bassLoHz) / this.opts.bassOctaves);
      }
      return this.bassHold;
    }
    return 0;
  }

  /** Held bass value at t: the last confident f0 within 20 s before t (seek-safe). */
  lastConfidentBass(t) {
    const tl = this.tl;
    for (let i = Math.floor(t * tl.rate); i >= 0 && i > (t - 20) * tl.rate; i--) {
      const ti = i / tl.rate;
      const f0 = tl.sampleNearest('pitch.bass.f0', ti);
      if (f0 > 0 && tl.sample('pitch.bass.conf', ti) >= this.opts.bassConf) {
        return clamp01(Math.log2(f0 / this.opts.bassLoHz) / this.opts.bassOctaves);
      }
    }
    return 0.5;
  }

  /** Advance to media time t. Returns the modulation slots { target: value }. */
  update(t) {
    let dt = this.tPrev == null ? 0 : t - this.tPrev;
    const seeked = this.tPrev == null || dt < -0.05 || dt > 0.5;
    if (seeked) { dt = 0; this.bassHold = this.lastConfidentBass(t); this.chromaHold = -1; }
    dt = Math.max(0, Math.min(dt, 0.1));
    this.tPrev = t;

    const mods = {};
    for (const [k, T] of Object.entries(TARGETS)) mods[k] = T.neutral;
    for (const m of this.mappings) {
      let s = this.source(m.src, t);
      this.signals[m.id] = s;
      if (!m.circular) s = shape(clamp01(s * (m.gain ?? 1)), m.curve);

      // envelope
      let e = this.env.get(m.id);
      if (m.circular) {
        const tx = Math.cos(s * TAU), ty = Math.sin(s * TAU);
        if (e == null || seeked) e = [tx, ty];
        else {
          const k = 1 - Math.exp(-dt / Math.max(m.release ?? 0, 1e-3));
          e = [e[0] + (tx - e[0]) * k, e[1] + (ty - e[1]) * k];
        }
        this.env.set(m.id, e);
        s = ((Math.atan2(e[1], e[0]) / TAU) + 1) % 1;
      } else {
        if (e == null || seeked || !(m.attack || m.release)) e = s;
        else {
          const tau = s > e ? (m.attack ?? 0) : (m.release ?? 0);
          e = tau > 0 ? e + (s - e) * (1 - Math.exp(-dt / tau)) : s;
        }
        this.env.set(m.id, e);
        s = e;
      }
      const [lo, hi] = m.out ?? [0, 1];
      mods[m.target] += m.amount * (lo + (hi - lo) * s - m.neutral);
    }
    this.spinPhase += (mods.spin ?? 0) * dt;
    mods.spinPhase = this.spinPhase;
    this.mods = mods;
    return mods;
  }
}

/**
 * Apply modulation slots to a copy of the base preset.
 * Returns { flame, itersScale, paletteOffset }.
 * A preset may name which xforms receive which modulation via `mod`:
 *   mod: { spin: 0, kick: 1, bass: 1, hat: 2 }  (indices; defaults shown)
 */
export function applyMods(base, mods, opts = MAP_DEFAULTS) {
  const f = clone(base);
  const xs = f.xforms;
  const n = xs.length;
  const idx = { spin: 0, kick: Math.min(1, n - 1), bass: Math.min(1, n - 1), hat: n - 1, ...(base.mod ?? {}) };

  // routes can be amplified or inverted from the UI, so clamp every slot to a safe range
  if (mods.brightness != null) f.brightness *= Math.max(0, mods.brightness);

  if (mods.spinPhase) xs[idx.spin].affine = rotateAffine(xs[idx.spin].affine, mods.spinPhase);
  if (mods.xformRotate) xs[idx.bass].affine = rotateAffine(xs[idx.bass].affine, mods.xformRotate);
  if (mods.weightBump) xs[idx.kick].weight *= Math.max(0.05, 1 + mods.weightBump);
  if (mods.zoomPulse) f.camera = { ...f.camera, zoom: f.camera.zoom * Math.max(0.2, 1 + mods.zoomPulse) };

  if (mods.juliaJitter > 0) {
    const x = xs[idx.hat];
    const j = Math.min(0.9, mods.juliaJitter);
    const v = { ...x.vars };
    for (const k of Object.keys(v)) v[k] *= 1 - j;
    v.julia = (v.julia ?? 0) + j;
    x.vars = v;
  }

  // keep the shape from blowing up
  for (const x of xs) x.affine = clampContractive(x.affine, opts.maxGain ?? 0.98);

  const paletteOffset = (mods.paletteKick ?? 0) + (mods.palettePos ?? 0);
  return { flame: f, itersScale: Math.min(4, Math.max(0.05, mods.iters ?? 1)), paletteOffset };
}
