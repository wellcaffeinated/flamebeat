// Signals -> flame parameters.
//
// MAPPINGS is the declarative table. Each row reads one source signal (0..1),
// shapes it, and drives one target:
//   src      { stream: 'energy.intensity' }      continuous timeline stream
//            { impulse: 'kick', attack, release } decaying impulse from events
//            { derived: 'chromaPos' | 'bassPitch' }
//   gain     multiply the source              (default 1)
//   curve    power applied after gain+clamp   (default 1, >1 = more contrast)
//   attack / release   one-pole envelope time constants in seconds (media time)
//   out      [min, max]  the 0..1 value is mapped linearly onto this range
//   target   name of a modulation slot, consumed by applyMods() below
//
// Envelopes run on *media* time (t - tPrev), so pause freezes the visuals,
// playbackRate changes scale them correctly, and seeks reset them.

import { clone, rotateAffine, clampContractive } from './flame.js';

export const MAPPINGS = [
  { id: 'volume→brightness', src: { stream: 'volume' }, curve: 1.6, attack: 0.03, release: 0.25, out: [0.45, 1.25], target: 'brightness' },
  { id: 'intensity→spin', src: { stream: 'energy.intensity' }, curve: 1.5, attack: 0.5, release: 1.5, out: [0.03, 0.55], target: 'spin' },
  { id: 'intensity→iterations', src: { stream: 'energy.intensity' }, attack: 0.3, release: 1.0, out: [0.55, 1.0], target: 'iters' },
  { id: 'kick→zoom', src: { impulse: 'kick', attack: 0.008, release: 0.12 }, out: [0, 0.09], target: 'zoomPulse' },
  { id: 'kick→weight', src: { impulse: 'kick', attack: 0.008, release: 0.18 }, out: [0, 1.6], target: 'weightBump' },
  { id: 'snare→palette', src: { impulse: 'snare', attack: 0.005, release: 0.2 }, out: [0, 0.12], target: 'paletteKick' },
  { id: 'hat→julia', src: { impulse: 'hat', attack: 0.004, release: 0.07 }, out: [0, 0.3], target: 'juliaJitter' },
  { id: 'chroma→palette', src: { derived: 'chromaPos' }, attack: 0.6, release: 0.6, out: [0, 1], target: 'palettePos', circular: true },
  { id: 'bassf0→rotate', src: { derived: 'bassPitch' }, attack: 0.08, release: 0.08, out: [-0.5, 0.5], target: 'xformRotate' },
];

export const MAP_DEFAULTS = {
  lookahead: 0.03,        // s: impulses lead the audio a little (output latency + perception)
  paletteRange: 0.35,     // how far chroma moves the palette (fraction of the gradient)
  bassConf: 0.5,          // pYIN voiced-probability gate
  bassLoHz: 40, bassOctaves: 2,   // bassPitch 0..1 spans this range (log)
  maxGain: 0.98,          // affine contraction clamp
};

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const TAU = Math.PI * 2;

export class Mapper {
  constructor(timeline, mappings = MAPPINGS, opts = {}) {
    this.tl = timeline;
    this.mappings = mappings;
    this.opts = { ...MAP_DEFAULTS, ...opts };
    this.chroma = new Float32Array(12);
    this.reset();
  }

  reset() {
    this.env = new Map();        // mapping id -> envelope value (or [cos, sin] for circular)
    this.tPrev = null;
    this.bassHold = 0.5;
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
    if (seeked) { dt = 0; this.bassHold = this.lastConfidentBass(t); }
    dt = Math.max(0, Math.min(dt, 0.1));
    this.tPrev = t;

    const mods = {};
    for (const m of this.mappings) {
      let s = this.source(m.src, t);
      this.signals[m.id] = s;
      if (!m.circular) s = Math.pow(clamp01(s * (m.gain ?? 1)), m.curve ?? 1);

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
      mods[m.target] = (mods[m.target] ?? 0) + lo + (hi - lo) * s;
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

  if (mods.brightness != null) f.brightness *= mods.brightness;

  if (mods.spinPhase) xs[idx.spin].affine = rotateAffine(xs[idx.spin].affine, mods.spinPhase);
  if (mods.xformRotate) xs[idx.bass].affine = rotateAffine(xs[idx.bass].affine, mods.xformRotate);
  if (mods.weightBump) xs[idx.kick].weight *= 1 + mods.weightBump;
  if (mods.zoomPulse) f.camera = { ...f.camera, zoom: f.camera.zoom * (1 + mods.zoomPulse) };

  if (mods.juliaJitter) {
    const x = xs[idx.hat];
    const j = Math.min(0.9, mods.juliaJitter);
    const v = { ...x.vars };
    for (const k of Object.keys(v)) v[k] *= 1 - j;
    v.julia = (v.julia ?? 0) + j;
    x.vars = v;
  }

  // keep the shape from blowing up
  for (const x of xs) x.affine = clampContractive(x.affine, opts.maxGain ?? 0.98);

  const paletteOffset = (mods.paletteKick ?? 0) + (mods.palettePos ?? 0) * (opts.paletteRange ?? 0.35);
  return { flame: f, itersScale: mods.iters ?? 1, paletteOffset };
}
