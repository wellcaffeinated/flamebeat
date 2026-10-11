// Flame presets. See flame.js for the shape of a flame.
import { hex } from './renderer/palette.js';

const P = (cols) => cols.map((c, i) => [i / cols.length, hex(c)]);

/**
 * Convert a flame-fractal parameter file (github: flame-fractal, examples/*.json)
 * to a flamebeat flame. Differences handled here:
 * - camera.zoom there is fractal units across the short side; here the
 *   viewport height spans 2 / zoom units (the short side on landscape screens)
 * - palette stops are spread evenly over 0..1 inclusive and don't wrap
 * - background is 0..255, julia uses the paper's atan2(x, y)
 * Render-only fields (width, height, supersample, iterations) are dropped.
 * Tone mapping differs (flam3-style here), so brightness etc. may need retuning.
 */
export function fromFlameFractal(name, p) {
  const xf = (t) => ({
    weight: t.weight ?? 1, color: t.color ?? 0, colorSpeed: t.colorSpeed ?? 0.5,
    affine: [...(t.affine ?? [1, 0, 0, 0, 1, 0])], vars: { ...(t.variations ?? { linear: 1 }) },
  });
  const n = p.palette.length;
  return {
    name,
    xforms: p.transforms.map(xf),
    final: p.final ? xf(p.final) : null,
    camera: { x: p.camera?.x ?? 0, y: p.camera?.y ?? 0, zoom: 2 / (p.camera?.zoom ?? 1), angle: 0 },
    palette: p.palette.map((c, i) => [n > 1 ? i / (n - 1) : 0, hex(c)]),
    brightness: p.brightness, gamma: p.gamma, vibrancy: p.vibrancy, exposure: 1,
    background: (p.background ?? [0, 0, 0]).map((v) => v / 255),
    juliaAtan: 'xy',
  };
}

export const presets = [
  {
    name: 'spiral bloom',
    xforms: [
      { weight: 1.0, color: 0.0, colorSpeed: 0.5, affine: [0.80, -0.32, 0.0, 0.32, 0.80, 0.0], vars: { linear: 0.7, swirl: 0.3 } },
      { weight: 0.45, color: 0.55, colorSpeed: 0.5, affine: [0.42, 0.0, 0.62, 0.0, 0.42, 0.0], vars: { spherical: 1.0 } },
      { weight: 0.3, color: 1.0, colorSpeed: 0.6, affine: [-0.5, 0.2, -0.3, -0.2, -0.5, 0.4], vars: { julia: 1.0 } },
    ],
    final: null,
    camera: 'auto',
    palette: P(['#0b0630', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf', '#7ad3f0', '#1d4e89']),
    brightness: 3.5, gamma: 2.6, vibrancy: 1.0, exposure: 1, background: [0, 0, 0],
  },
  {
    name: 'sierpinski wings',
    xforms: [
      { weight: 1, color: 0.0, colorSpeed: 0.6, affine: [0.5, 0, -0.5, 0, 0.5, -0.4], vars: { linear: 0.8, sinusoidal: 0.2 } },
      { weight: 1, color: 0.5, colorSpeed: 0.6, affine: [0.5, 0, 0.5, 0, 0.5, -0.4], vars: { linear: 0.8, sinusoidal: 0.2 } },
      { weight: 1, color: 1.0, colorSpeed: 0.6, affine: [0.5, 0, 0.0, 0, 0.5, 0.5], vars: { linear: 0.8, swirl: 0.2 } },
    ],
    final: { color: 0, colorSpeed: 0, affine: [1, 0, 0, 0, 1, 0], vars: { heart: 0.6, linear: 0.4 } },
    camera: 'auto',
    palette: P(['#ff2e63', '#ff9a3c', '#ffd460', '#08d9d6', '#3a0ca3', '#f72585']),
    brightness: 4, gamma: 2.4, vibrancy: 0.9, exposure: 1, background: [0.01, 0.0, 0.02],
  },
  {
    name: 'julia disc',
    xforms: [
      { weight: 1.0, color: 0.1, colorSpeed: 0.4, affine: [0.6, 0.4, 0.2, -0.4, 0.6, 0.1], vars: { julia: 0.8, linear: 0.2 } },
      { weight: 0.7, color: 0.9, colorSpeed: 0.5, affine: [0.5, -0.1, -0.4, 0.1, 0.5, -0.2], vars: { disc: 0.6, polar: 0.2, linear: 0.2 } },
      { weight: 0.35, color: 0.5, colorSpeed: 0.7, affine: [0.3, 0.0, 0.0, 0.0, 0.3, 0.6], vars: { spiral: 0.5, horseshoe: 0.5 } },
    ],
    final: null,
    camera: 'auto',
    palette: P(['#001219', '#005f73', '#0a9396', '#94d2bd', '#e9d8a6', '#ee9b00', '#ca6702', '#9b2226']),
    brightness: 3.5, gamma: 2.5, vibrancy: 1.0, exposure: 1, background: [0, 0, 0],
  },
  // flame-fractal examples/julia-bloom-dense-teal-hires.json
  fromFlameFractal('julia bloom teal', {
    camera: { x: 0.1, y: 0, zoom: 3.4 },
    brightness: 4, gamma: 3.2, vibrancy: 0.85, background: [2, 6, 6],
    palette: ['#03181a', '#0d5c63', '#44a1a0', '#83a598', '#e3d9b0', '#ff9e7a'],
    transforms: [
      { weight: 0.4, color: 0, affine: [0.6, -0.3, 0.1, 0.3, 0.6, 0], variations: { julia: 1 } },
      { weight: 0.3, color: 0.6, affine: [0.45, 0.25, -0.4, -0.25, 0.45, 0.2], variations: { disc: 0.7, linear: 0.3 } },
      { weight: 0.3, color: 1, affine: [0.5, 0.1, 0.3, -0.1, 0.5, -0.3], variations: { heart: 0.5, spherical: 0.5 } },
    ],
    final: { color: 0.5, affine: [1, 0, 0, 0, 1, 0], variations: { linear: 0.7, swirl: 0.15 } },
  }),
];
