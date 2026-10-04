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
