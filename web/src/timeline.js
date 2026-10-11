// Timeline (schema v1, see PLAN.md): sample continuous streams at time t with
// linear interpolation, and query events in a time window.
//
// Everything here is stateless in t, so pause / seek / playback-rate changes
// need no special handling: the caller just asks for a different t.

export class Timeline {
  constructor(json) {
    if (json.version !== 1) console.warn(`timeline version ${json.version}, expected 1`);
    this.json = json;
    this.rate = json.rate;
    this.duration = json.track?.duration ?? 0;
    this.tempo = json.track?.tempo ?? 0;
    this.streams = new Map();
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (Array.isArray(v) && typeof v[0] === 'number') this.streams.set(key, Float32Array.from(v));
        else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      }
    };
    const c = { ...json.continuous };
    const chroma = c.chroma;
    delete c.chroma;
    walk(c, '');
    // chroma: (n, 12) -> flat Float32Array
    this.chroma = null;
    if (Array.isArray(chroma) && chroma.length) {
      this.chroma = new Float32Array(chroma.length * 12);
      chroma.forEach((row, i) => this.chroma.set(row, i * 12));
      this.chromaLen = chroma.length;
    }
    // events: sorted by t
    this.events = {};
    for (const [k, list] of Object.entries(json.events ?? {})) {
      this.events[k] = [...list].sort((a, b) => a.t - b.t);
    }
    this.drumsByType = {};
    for (const d of this.events.drums ?? []) (this.drumsByType[d.type] ??= []).push(d);
    // bar structure (track.meter, beats[].bar_pos / group_start; older timelines: 4/4, no groups)
    this.meter = json.track?.meter ?? { pulses: 4, unit: 4, groups: [1, 1, 1, 1] };
    const beats = this.events.beats ?? [];
    this.events.downbeats = beats.filter((b) => b.downbeat);
    this.events.groupbeats = beats.filter((b) => b.group_start ?? true);
  }

  has(name) { return this.streams.has(name); }

  /** Linear interpolation of a continuous stream ("volume", "energy.intensity", ...). */
  sample(name, t) {
    const a = this.streams.get(name);
    if (!a) return 0;
    const x = t * this.rate;
    if (x <= 0) return a[0];
    const i = Math.floor(x);
    if (i >= a.length - 1) return a[a.length - 1];
    const f = x - i;
    return a[i] + (a[i + 1] - a[i]) * f;
  }

  /**
   * Name of `name` averaged over a window of `seconds` centred on each frame
   * (two box passes of seconds/2 ~ a triangle window, so no lag: the timeline
   * is known in advance), rescaled to 0..1 between its 1st and 99th
   * percentiles because averaging flattens the peaks. Computed once, cached as
   * a derived stream; sample it with sample().
   */
  smoothed(name, seconds) {
    const key = `${name}~${seconds}s`;
    if (this.streams.has(key)) return key;
    const src = this.streams.get(name);
    if (!src) return name;
    const half = Math.max(1, Math.round((seconds / 2) * this.rate / 2));   // box radius in frames
    const box = (a) => {
      const pre = new Float64Array(a.length + 1);
      for (let i = 0; i < a.length; i++) pre[i + 1] = pre[i] + a[i];
      const out = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) {
        const lo = Math.max(0, i - half), hi = Math.min(a.length, i + half + 1);
        out[i] = (pre[hi] - pre[lo]) / (hi - lo);
      }
      return out;
    };
    const s = box(box(src));
    const sorted = Float32Array.from(s).sort();
    const p1 = sorted[Math.floor(0.01 * (sorted.length - 1))], p99 = sorted[Math.floor(0.99 * (sorted.length - 1))];
    const span = p99 - p1 > 1e-6 ? p99 - p1 : 1;
    for (let i = 0; i < s.length; i++) s[i] = Math.min(1, Math.max(0, (s[i] - p1) / span));
    this.streams.set(key, s);
    return key;
  }

  /** Nearest-frame sample (for streams that must not be interpolated, e.g. f0). */
  sampleNearest(name, t) {
    const a = this.streams.get(name);
    if (!a) return 0;
    const i = Math.min(a.length - 1, Math.max(0, Math.round(t * this.rate)));
    return a[i];
  }

  /** Interpolated 12-bin chroma at t (writes into `out`). */
  sampleChroma(t, out = new Float32Array(12)) {
    if (!this.chroma) return out.fill(0);
    const x = Math.max(0, t * this.rate);
    const i = Math.min(this.chromaLen - 1, Math.floor(x));
    const j = Math.min(this.chromaLen - 1, i + 1);
    const f = Math.min(1, x - i);
    for (let k = 0; k < 12; k++) out[k] = this.chroma[i * 12 + k] * (1 - f) + this.chroma[j * 12 + k] * f;
    return out;
  }

  /** Events of `kind` ("beats", "onsets", "notes", or a drum type "kick") with t0 < e.t <= t1. */
  eventsIn(kind, t0, t1) {
    const list = this.drumsByType[kind] ?? this.events[kind] ?? [];
    let lo = lowerBound(list, t0);
    while (lo < list.length && list[lo].t <= t0) lo++;
    const out = [];
    for (let i = lo; i < list.length && list[i].t <= t1; i++) out.push(list[i]);
    return out;
  }

  /**
   * Decaying impulse envelope from events of `kind`, evaluated at t.
   * Each event contributes strength * attackRamp * exp(-dt / release),
   * dt = t + lookahead - e.t, so visuals can lead the audio by `lookahead`.
   * Contributions are combined with max (not sum) so dense hits don't pile up.
   */
  impulse(kind, t, { attack = 0.005, release = 0.15, lookahead = 0 } = {}) {
    const list = this.drumsByType[kind] ?? this.events[kind] ?? [];
    const tt = t + lookahead;
    const hi = lowerBound(list, tt + 1e-9);
    let v = 0;
    for (let i = hi - 1; i >= 0; i--) {
      const dt = tt - list[i].t;
      if (dt > release * 6) break;
      const s = list[i].strength ?? 1;
      const att = attack > 0 ? Math.min(1, dt / attack) : 1;
      v = Math.max(v, s * att * Math.exp(-dt / release));
    }
    return v;
  }
}

function lowerBound(list, t) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].t < t) lo = m + 1; else hi = m;
  }
  return lo;
}

/**
 * Smooth playback clock. `audio.currentTime` updates in coarse steps in some
 * browsers; while playing we extrapolate from the last change with
 * performance.now() and playbackRate. Paused -> currentTime exactly.
 */
export class AudioClock {
  constructor(audio) {
    this.audio = audio;
    this.lastCT = -1;
    this.lastPerf = 0;
  }

  now() {
    const a = this.audio;
    const ct = a.currentTime;
    const perf = performance.now();
    if (a.paused || a.seeking || a.readyState < 2) {
      this.lastCT = ct; this.lastPerf = perf;
      return ct;
    }
    if (ct !== this.lastCT) { this.lastCT = ct; this.lastPerf = perf; }
    const ext = ((perf - this.lastPerf) / 1000) * a.playbackRate;
    return ct + Math.min(ext, 0.25);   // never extrapolate far past the last report
  }
}
