// Gradient stops -> 256-entry palette (vec4f per entry, for a storage buffer).
// stops: [[pos 0..1, [r, g, b] 0..1], ...] sorted by pos; the gradient wraps.

export function buildPalette(stops) {
  const out = new Float32Array(256 * 4);
  const s = [...stops].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = s.findIndex((st) => st[0] > t);
    let lo, hi, span, f;
    if (j === -1) {           // past the last stop: wrap to the first
      lo = s[s.length - 1]; hi = s[0];
      span = 1 - lo[0] + hi[0];
      f = span > 0 ? (t - lo[0]) / span : 0;
    } else if (j === 0) {     // before the first stop: wrap from the last
      lo = s[s.length - 1]; hi = s[0];
      span = 1 - lo[0] + hi[0];
      f = span > 0 ? (t + 1 - lo[0]) / span : 0;
    } else {
      lo = s[j - 1]; hi = s[j];
      span = hi[0] - lo[0];
      f = span > 0 ? (t - lo[0]) / span : 0;
    }
    for (let k = 0; k < 3; k++) out[i * 4 + k] = lo[1][k] + (hi[1][k] - lo[1][k]) * f;
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** "#rrggbb" -> [r, g, b] in 0..1 */
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
