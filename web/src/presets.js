// Flame presets. See flame.js for the shape of a flame.
import { hex } from './renderer/palette.js';

const P = (cols) => cols.map((c, i) => [i / cols.length, hex(c)]);

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
];
