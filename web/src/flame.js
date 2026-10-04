// Flame parameter helpers. A flame is a plain object:
// {
//   name, xforms: [{ weight, color, colorSpeed, affine: [a,b,c,d,e,f], vars: {linear: 1, ...}, opacity }],
//   final: null | xform, camera: { x, y, zoom, angle }, palette: [[pos, [r,g,b]], ...],
//   brightness, gamma, vibrancy, exposure, background: [r,g,b]
// }
// Affine convention: x' = a x + b y + c,  y' = d x + e y + f.

export const clone = (f) => structuredClone(f);

/** Rotate the linear part of an affine about its own origin by `rad`. */
export function rotateAffine(aff, rad) {
  const [a, b, c, d, e, f] = aff;
  const cs = Math.cos(rad), sn = Math.sin(rad);
  // R * [[a b] [d e]]
  return [cs * a - sn * d, cs * b - sn * e, c, sn * a + cs * d, sn * b + cs * e, f];
}

/** Scale the linear part. */
export function scaleAffine(aff, s) {
  const [a, b, c, d, e, f] = aff;
  return [a * s, b * s, c, d * s, e * s, f];
}

/**
 * Keep an affine contractive: if the linear part's largest singular value
 * exceeds `maxGain`, scale it down to exactly that.
 */
export function clampContractive(aff, maxGain = 0.95) {
  const [a, b, , d, e] = aff;
  // largest singular value of [[a b] [d e]]
  const s1 = a * a + b * b + d * d + e * e;
  const det = a * e - b * d;
  const sv = Math.sqrt((s1 + Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))) / 2);
  return sv > maxGain ? scaleAffine(aff, maxGain / sv) : aff;
}

// ---- CPU reference of the variations (used for auto-framing only) --------
const PI = Math.PI;
function applyXformCPU(x, p) {
  const [a, b, c, d, e, f] = x.affine;
  const tx = a * p[0] + b * p[1] + c;
  const ty = d * p[0] + e * p[1] + f;
  const r2 = Math.max(tx * tx + ty * ty, 1e-12);
  const r = Math.sqrt(r2);
  const th = Math.atan2(tx, ty);
  const v = x.vars ?? {};
  let ox = 0, oy = 0;
  const add = (w, vx, vy) => { if (w) { ox += w * vx; oy += w * vy; } };
  add(v.linear, tx, ty);
  add(v.sinusoidal, Math.sin(tx), Math.sin(ty));
  add(v.spherical, tx / r2, ty / r2);
  if (v.swirl) add(v.swirl, tx * Math.sin(r2) - ty * Math.cos(r2), tx * Math.cos(r2) + ty * Math.sin(r2));
  if (v.horseshoe) add(v.horseshoe, (tx - ty) * (tx + ty) / r, 2 * tx * ty / r);
  if (v.polar) add(v.polar, th / PI, r - 1);
  if (v.heart) add(v.heart, r * Math.sin(th * r), -r * Math.cos(th * r));
  if (v.disc) add(v.disc, (th / PI) * Math.sin(PI * r), (th / PI) * Math.cos(PI * r));
  if (v.spiral) add(v.spiral, (Math.cos(th) + Math.sin(r)) / r, (Math.sin(th) - Math.cos(r)) / r);
  if (v.julia) {
    const ang = Math.atan2(ty, tx) / 2 + (Math.random() < 0.5 ? 0 : PI);
    const sr = Math.sqrt(r);
    add(v.julia, sr * Math.cos(ang), sr * Math.sin(ang));
  }
  return [ox, oy];
}

/** Sample the attractor on the CPU: returns an array of [x, y] (after final xform). */
export function sampleAttractor(flame, n = 20000) {
  const xs = flame.xforms;
  const tot = xs.reduce((s, x) => s + Math.max(0, x.weight), 0);
  let p = [Math.random() * 2 - 1, Math.random() * 2 - 1];
  const out = [];
  for (let i = 0; i < n + 50; i++) {
    let u = Math.random() * tot, j = 0;
    while (j < xs.length - 1 && (u -= Math.max(0, xs[j].weight)) > 0) j++;
    p = applyXformCPU(xs[j], p);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 1e6 || Math.abs(p[1]) > 1e6) {
      p = [Math.random() * 2 - 1, Math.random() * 2 - 1];
      continue;
    }
    if (i < 50) continue;
    out.push(flame.final ? applyXformCPU(flame.final, p) : p);
  }
  return out;
}

/**
 * Centre the camera on the attractor and zoom so its [lo, hi] percentile box
 * fills `fill` of the viewport height (aspect = width / height).
 */
export function autoFrame(flame, aspect = 16 / 9, fill = 0.75, lo = 0.02, hi = 0.98) {
  const pts = sampleAttractor(flame);
  const q = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
  const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
  const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
  const x0 = q(xs, lo), x1 = q(xs, hi), y0 = q(ys, lo), y1 = q(ys, hi);
  const halfH = Math.max((y1 - y0) / 2, (x1 - x0) / 2 / aspect, 1e-3);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom: fill / halfH, angle: flame.camera?.angle ?? 0 };
}
