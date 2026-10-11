// Signals -> flame parameters.
//
// MAPPINGS is the declarative table of routes. Each row is
//   { src: <SOURCES key>, target: <TARGETS key>, amount: 1, ...overrides }
// and resolve() expands it into the full form the Mapper runs:
//   src      { stream: 'energy.intensity' }      continuous timeline stream
//            { impulse: 'kick', attack, release } decaying impulse from events
//            { derived: 'chromaPos' | 'chromaPeak' | 'bassPitch' }
//   smooth   seconds: average a continuous source over a centred window of this
//            length (and rescale it to 0..1) for a steadier, section-level signal
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

import { clone, rotateAffine, scaleAffine, clampContractive } from './flame.js';

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
  volume: { label: 'volume', help: 'Loudness as you hear it (400 ms window), scaled 0–1 for this track. Heavily compressed songs sit near the top most of the time.', src: { stream: 'volume' }, env: { curve: 1.6, attack: 0.03, release: 0.25 } },
  intensity: { label: 'intensity', help: 'Overall energy: how much is changing, how many new sounds start, and how loud the bands are, smoothed over about 0.75 s. Follows song sections (intro, build, drop).', src: { stream: 'energy.intensity' }, env: { attack: 0.3, release: 1.0 } },
  flux: { label: 'spectral flux', help: 'How fast the sound’s spectrum is changing. Spikes whenever something new starts: hits, notes, chord changes.', src: { stream: 'energy.flux' }, env: { attack: 0.02, release: 0.2 } },
  sub: { label: 'sub energy', help: 'Energy below 60 Hz: sub-bass and the body of the kick drum.', src: { stream: 'energy.sub' }, env: { attack: 0.03, release: 0.25 } },
  bass: { label: 'bass energy', help: 'Energy from 60 to 250 Hz: bass lines and kick drums.', src: { stream: 'energy.bass' }, env: { attack: 0.03, release: 0.25 } },
  mid: { label: 'mid energy', help: 'Energy from 250 Hz to 2 kHz: vocals, synths, guitars, the body of the snare.', src: { stream: 'energy.mid' }, env: { attack: 0.03, release: 0.25 } },
  high: { label: 'high energy', help: 'Energy above 2 kHz: hi-hats, cymbals, brightness and air.', src: { stream: 'energy.high' }, env: { attack: 0.03, release: 0.25 } },
  kick: { label: 'kick hit', help: 'A pulse on each detected kick drum that fades out quickly. Its height is the hit’s strength.', src: { impulse: 'kick' }, impulse: { attack: 0.008, release: 0.15 } },
  snare: { label: 'snare hit', help: 'A pulse on each detected snare or clap that fades out quickly. Its height is the hit’s strength.', src: { impulse: 'snare' }, impulse: { attack: 0.005, release: 0.2 } },
  hat: { label: 'hat hit', help: 'A short pulse on each detected hi-hat.', src: { impulse: 'hat' }, impulse: { attack: 0.004, release: 0.07 } },
  beat: { label: 'beat (pulse)', help: 'A pulse on every beat of the meter’s pulse (each eighth note in 9/8).', src: { impulse: 'beats' }, impulse: { attack: 0.005, release: 0.15 } },
  // bar structure from the analysis meter (--meter 9/8: group beat = each dotted quarter, 3 per bar)
  groupBeat: { label: 'group beat', help: 'A pulse at the start of each beat group: each dotted quarter in 9/8 (3+3+3), every beat in 4/4.', src: { impulse: 'groupbeats' }, impulse: { attack: 0.005, release: 0.3 } },
  downbeat: { label: 'downbeat (bar)', help: 'A longer pulse on beat 1 of every bar.', src: { impulse: 'downbeats' }, impulse: { attack: 0.005, release: 0.6 } },
  onset: { label: 'onset', help: 'A pulse whenever any new sound starts (drum or note).', src: { impulse: 'onsets' }, impulse: { attack: 0.005, release: 0.1 } },
  note: { label: 'note', help: 'A pulse at the start of each transcribed note, with its height set by the note’s loudness.', src: { impulse: 'notes' }, impulse: { attack: 0.005, release: 0.15 } },
  chroma: { label: 'chroma (average)', help: 'Where the harmony sits on the 12-note circle (C, C#, … B), averaged over all sounding notes and smoothed over about 0.6 s. Moves slowly; chords can land between notes.', src: { derived: 'chromaPos' }, env: { attack: 0.6, release: 0.6 }, circular: true, out: [0, 0.35] },
  // strongest pitch class only: each note is its own palette position, over the whole gradient
  chromaPeak: { label: 'chroma peak', help: 'The single strongest note (C, C#, … B) as a position around a circle, switching quickly when the note changes. Each note gets its own value.', src: { derived: 'chromaPeak' }, env: { attack: 0.08, release: 0.08 }, circular: true },
  bassPitch: { label: 'bass pitch', help: 'Pitch of the bass line (low to high over about two octaves), holding the last confident note when the bass is unclear.', src: { derived: 'bassPitch' }, env: { attack: 0.08, release: 0.08 } },
};

/** Modulation slots. `neutral` is the value with no routes; `out` the range at amount 1. */
export const TARGETS = {
  brightness: { label: 'brightness', help: 'Overall brightness (exposure). Several routes to brightness add together.', neutral: 1, out: [0.45, 1.25] },
  // rotates xform 0's input: with a julia xform the shape morphs in place (period 2π), it does not rotate
  spin: { label: 'morph speed', help: 'Rotates the input of transform 1, in radians per second. With this fractal the shape morphs in place and repeats every full turn; it doesn’t spin the picture. Fast morphing plus a long fade blurs.', neutral: 0, out: [0.03, 3.0], env: { curve: 1.5, attack: 0.5, release: 1.5 } },
  iters: { label: 'iterations', help: 'How many points are drawn per frame: more gives smoother detail but is slower.', neutral: 1, out: [0.55, 1.0] },
  zoomPulse: { label: 'zoom pulse', help: 'Zooms the camera in briefly.', neutral: 0, out: [0, 0.09] },
  weightBump: { label: 'transform weight', help: 'How often transform 2 is chosen. Higher makes its part denser and brighter, and pulls the shape toward it.', neutral: 0, out: [0, 1.6] },
  paletteKick: { label: 'palette shift', help: 'Slides every point’s colour along the palette gradient (wrapping around at the end).', neutral: 0, out: [0, 0.12] },
  palettePos: { label: 'palette position', help: 'Same as palette shift: 0–1 moves the colours across the whole gradient once.', neutral: 0, out: [0, 1] },
  hue: { label: 'hue rotate', help: 'Turns all colours around the colour wheel (1 = full circle) while keeping their brightness, e.g. teal → magenta → lime.', neutral: 0, out: [0, 1] },
  juliaJitter: { label: 'julia blend', help: 'Mixes the julia variation into the last transform, splitting its part into mirrored, flame-like halves.', neutral: 0, out: [0, 0.3] },
  xformRotate: { label: 'transform rotate', help: 'Rotates transform 2 by a fixed angle (not a speed), bending the shape one way or the other.', neutral: 0, out: [-0.5, 0.5] },
  // geometry
  finalSwirl: { label: 'final swirl', help: 'Adds swirl to the final transform: twists the whole image around the centre, more strongly further out.', neutral: 0, out: [0, 0.6] },
  xformScale: { label: 'transform scale', help: 'Scales transform 1: its part of the shape swells or shrinks, like breathing.', neutral: 1, out: [0.8, 1.2] },
  xformOffset: { label: 'transform offset', help: 'Moves the last transform’s position along its own direction, so its part slides away from or into the rest.', neutral: 0, out: [-0.3, 0.3] },
  varMix: { label: 'variation mix', help: 'Swaps the mix inside each transform that uses two or more variations (e.g. 70% disc + 30% linear → 30% disc + 70% linear), changing each part’s character.', neutral: 0, out: [0, 1] },
  opacity: { label: 'transform opacity', help: 'How many of the last transform’s points are drawn. Lower fades that part out without changing the shape.', neutral: 1, out: [0.15, 1] },
  sinusoidal: { label: 'blend → sinusoidal', help: 'Mixes the sinusoidal variation into transform 2: folds its part into a wavy, square-bounded shape.', neutral: 0, out: [0, 0.5] },
  polar: { label: 'blend → polar', help: 'Mixes the polar variation into transform 2: unrolls its part as if converting circles into lines.', neutral: 0, out: [0, 0.5] },
  spiral: { label: 'blend → spiral', help: 'Mixes the spiral variation into transform 2: winds its part into spiral arms. Strong.', neutral: 0, out: [0, 0.5] },
  horseshoe: { label: 'blend → horseshoe', help: 'Mixes the horseshoe variation into transform 2: folds its part into arcs.', neutral: 0, out: [0, 0.5] },
  // colour + tone
  colorSpeed: { label: 'colour speed', help: 'How quickly each point takes on the colour of the transform it just passed through. Low: colours blend into soft gradients. High: each part keeps its own colour, giving hard colour regions.', neutral: 0, out: [0, 0.5] },
  gamma: { label: 'gamma', help: 'Contrast of the glow. Lower is flatter and milky; higher gives deep blacks with glowing filaments.', neutral: 1, out: [0.6, 1.6], env: { attack: 0.3, release: 0.8 } },
  vibrancy: { label: 'vibrancy', help: 'Colour intensity. Higher is vivid and saturated; lower is washed out and pastel.', neutral: 0, out: [-0.5, 0.15] },
  // log2 multiplier on the fade slider: -2 = a quarter as long, +2 = four times
  fade: { label: 'fade time', help: 'Changes how long trails last, relative to the fade slider: +1 doubles it, −1 halves it.', neutral: 0, out: [-2, 2], env: { attack: 0.5, release: 1.5 } },
};

/** Which xform each per-transform target acts on (a preset's `mod` overrides these). */
const XFORM_SLOTS = (n) => ({
  spin: 0, kick: Math.min(1, n - 1), bass: Math.min(1, n - 1), hat: n - 1,
  scale: 0, offset: n - 1, opacity: n - 1, blend: Math.min(1, n - 1),
});

// Beats show as light and colour, not motion: no zoom pulse, no transform
// weight bump, and the iteration budget stays fixed (zoomPulse, weightBump and
// iters remain available as targets in the route editor).
export const MAPPINGS = [
  { src: 'volume', target: 'brightness', amount: 1 },
  { src: 'intensity', target: 'brightness', amount: 1, curve: 'quad', out: [0.6, 1.8] },
  { src: 'kick', target: 'brightness', amount: 1, curve: 'quad', out: [1, 3.2], impulse: { attack: 0.008, release: 0.2 } },
  { src: 'beat', target: 'paletteKick', amount: 1, out: [0, 0.06], impulse: { attack: 0.01, release: 0.25 } },
  { src: 'snare', target: 'paletteKick', amount: 1 },
  { src: 'intensity', target: 'spin', amount: 1, curve: 'exp', out: [0.12, 10.9] },
  { src: 'hat', target: 'juliaJitter', amount: 1 },
  { src: 'chromaPeak', target: 'hue', amount: 1 },
  { src: 'bassPitch', target: 'xformRotate', amount: 1 },
  // to experiment with: off (amount 0) until a slider is moved
  { src: 'sub', target: 'finalSwirl', amount: 0 },
  { src: 'bass', target: 'xformScale', amount: 0 },
  { src: 'intensity', target: 'fade', amount: 0 },
  { src: 'snare', target: 'colorSpeed', amount: 0 },
];

/** Cross-fade an xform's variations toward `name` by j (0..0.9). */
function blendToward(x, name, j) {
  j = Math.min(0.9, j);
  const v = { ...x.vars };
  for (const k of Object.keys(v)) v[k] *= 1 - j;
  v[name] = (v[name] ?? 0) + j;
  x.vars = v;
}

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
    smooth: S.src.stream ? (row.smooth ?? 0) : 0,
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

  source(src, t, smooth = 0) {
    const tl = this.tl;
    if (src.stream) return tl.sample(smooth > 0 ? tl.smoothed(src.stream, smooth) : src.stream, t);
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
      let s = this.source(m.src, t, m.smooth);
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
 * Returns { flame, itersScale, paletteOffset, hue, fadeScale }.
 * A preset may name which xforms receive which modulation via `mod`
 * (indices; defaults in XFORM_SLOTS):
 *   mod: { spin: 0, kick: 1, bass: 1, hat: 2, scale: 0, offset: 2, opacity: 2, blend: 1 }
 * Every slot at its neutral value leaves the preset untouched.
 */
export function applyMods(base, mods, opts = MAP_DEFAULTS) {
  const f = clone(base);
  const xs = f.xforms;
  const n = xs.length;
  const idx = { ...XFORM_SLOTS(n), ...(base.mod ?? {}) };

  // routes can be amplified or inverted from the UI, so clamp every slot to a safe range
  if (mods.brightness != null) f.brightness *= Math.max(0, mods.brightness);

  if (mods.spinPhase) xs[idx.spin].affine = rotateAffine(xs[idx.spin].affine, mods.spinPhase);
  if (mods.xformRotate) xs[idx.bass].affine = rotateAffine(xs[idx.bass].affine, mods.xformRotate);
  if (mods.weightBump) xs[idx.kick].weight *= Math.max(0.05, 1 + mods.weightBump);
  if (mods.zoomPulse) f.camera = { ...f.camera, zoom: f.camera.zoom * Math.max(0.2, 1 + mods.zoomPulse) };

  if (mods.juliaJitter > 0) blendToward(xs[idx.hat], 'julia', mods.juliaJitter);
  for (const name of ['sinusoidal', 'polar', 'spiral', 'horseshoe']) {
    if (mods[name] > 0) blendToward(xs[idx.blend], name, mods[name]);
  }

  if (mods.xformScale != null && mods.xformScale !== 1) {
    xs[idx.scale].affine = scaleAffine(xs[idx.scale].affine, Math.min(2, Math.max(0.2, mods.xformScale)));
  }
  if (mods.xformOffset) {
    // push the xform's translation along its own direction (x axis if it has none)
    const a = [...xs[idx.offset].affine];
    const len = Math.hypot(a[2], a[5]);
    const [ux, uy] = len > 1e-6 ? [a[2] / len, a[5] / len] : [1, 0];
    const d = Math.min(1, Math.max(-1, mods.xformOffset));
    a[2] += ux * d; a[5] += uy * d;
    xs[idx.offset].affine = a;
  }
  if (mods.varMix > 0) {
    // swap weight between an xform's variations: largest <-> smallest at varMix 1
    const t = Math.min(1, mods.varMix);
    for (const x of xs) {
      const ents = Object.entries(x.vars ?? {});
      if (ents.length < 2) continue;
      const w = ents.map(([, v]) => v);
      const rev = [...w].reverse();
      x.vars = Object.fromEntries(ents.map(([k], i) => [k, w[i] + (rev[i] - w[i]) * t]));
    }
  }
  if (mods.opacity != null && mods.opacity !== 1) xs[idx.opacity].opacity = Math.min(1, Math.max(0.02, mods.opacity));
  if (mods.finalSwirl) {
    // presets without a final transform get an identity one (colorSpeed 0: colours unchanged)
    f.final ??= { color: 0, colorSpeed: 0, affine: [1, 0, 0, 0, 1, 0], vars: { linear: 1 } };
    f.final.vars = { ...f.final.vars, swirl: Math.max(-1, Math.min(1.5, (f.final.vars.swirl ?? 0) + mods.finalSwirl)) };
  }
  if (mods.colorSpeed) {
    for (const x of xs) x.colorSpeed = Math.min(1, Math.max(0.02, (x.colorSpeed ?? 0.5) + mods.colorSpeed));
  }
  if (mods.gamma != null && mods.gamma !== 1) f.gamma *= Math.min(3, Math.max(0.3, mods.gamma));
  if (mods.vibrancy) f.vibrancy = Math.min(1, Math.max(0, f.vibrancy + mods.vibrancy));

  // keep the shape from blowing up
  for (const x of xs) x.affine = clampContractive(x.affine, opts.maxGain ?? 0.98);

  const paletteOffset = (mods.paletteKick ?? 0) + (mods.palettePos ?? 0);
  const hue = (((mods.hue ?? 0) % 1) + 1) % 1;
  const fadeScale = Math.pow(2, Math.min(4, Math.max(-4, mods.fade ?? 0)));
  return { flame: f, itersScale: Math.min(4, Math.max(0.05, mods.iters ?? 1)), paletteOffset, hue, fadeScale };
}
