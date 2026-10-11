// Mapping presets: a named, portable snapshot of how the music drives the flame.
//
//   { "format": "flamebeat-mapping", "version": 1, "name": "teal 9/8",
//     "flame": "julia bloom teal",   // preset name (optional: keep the current one)
//     "fade": 0.15,                  // trail fade time in seconds (optional)
//     "zoom": 1.5,                   // zoom multiplier on the fractal's camera (optional, default 1)
//     "palette": [[0, "#03181a"], [0.4, "#44a1a0"], ...],   // custom palette (optional:
//                                    // absent = the fractal's own); stops wrap from last to first
//     "routes": [ { "src": "kick", "target": "brightness", "amount": 1, ... } ] }
//
// The same file works in three places: the browser library (localStorage),
// exported .json files, and ?mapping=<url> (e.g. mappings/teal.json), which is
// how a render run picks the mapping it should use.

import { SOURCES, TARGETS } from './mapping.js';

export const FORMAT = 'flamebeat-mapping';
export const VERSION = 1;
const LIBRARY = 'flamebeat.mappings.v1';

const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/** Palette stops [[pos, [r,g,b]]] <-> the file's [[pos, "#rrggbb"]]. */
export const paletteToFile = (stops) => stops.map(([p, c]) => [Math.round(p * 1e4) / 1e4, toHex(c)]);
export function paletteFromFile(v) {
  if (!Array.isArray(v) || v.length < 2) return null;
  const ok = v.every((s) => Array.isArray(s) && Number.isFinite(s[0]) && s[0] >= 0 && s[0] <= 1
    && typeof s[1] === 'string' && /^#[0-9a-f]{6}$/i.test(s[1]));
  return ok ? v.map(([p, h]) => [p, fromHex(h)]).sort((a, b) => a[0] - b[0]) : null;
}

/** `palette` is flame-style stops ([[pos, [r,g,b]]]) or null for the fractal's own. */
export function makeMapping({ name, flame, fade, zoom, palette, routes }) {
  const m = { format: FORMAT, version: VERSION, name: String(name || 'untitled') };
  if (flame) m.flame = flame;
  if (Number.isFinite(fade)) m.fade = fade;
  if (Number.isFinite(zoom) && zoom > 0 && zoom !== 1) m.zoom = zoom;
  if (palette) m.palette = paletteToFile(palette);
  m.routes = structuredClone(routes ?? []);
  return m;
}

/**
 * Check a parsed mapping. Unknown sources/targets (e.g. from a newer version)
 * are dropped, with a warning, instead of rejecting the whole file.
 * Returns { mapping, warnings }; throws if it isn't a mapping at all.
 */
export function parseMapping(json) {
  if (!json || json.format !== FORMAT) throw new Error('not a flamebeat mapping file');
  if (json.version > VERSION) console.warn(`mapping version ${json.version} is newer than ${VERSION}`);
  if (!Array.isArray(json.routes)) throw new Error('mapping has no routes');
  const warnings = [];
  const routes = json.routes.filter((r, i) => {
    const ok = r && SOURCES[r.src] && TARGETS[r.target];
    if (!ok) warnings.push(`route ${i + 1} skipped: unknown ${SOURCES[r?.src] ? 'parameter' : 'source'} "${SOURCES[r?.src] ? r?.target : r?.src}"`);
    return ok;
  });
  const fade = Number(json.fade);
  const zoom = Number(json.zoom);
  const palette = json.palette == null ? null : paletteFromFile(json.palette);
  if (json.palette != null && !palette) warnings.push('palette ignored: expected [[position 0–1, "#rrggbb"], …] with at least 2 stops');
  return {
    mapping: makeMapping({ name: json.name, flame: json.flame, fade: Number.isFinite(fade) && fade >= 0 ? fade : undefined, zoom: zoom > 0 ? zoom : undefined, palette, routes }),
    warnings,
  };
}

// ---- browser library (localStorage) ---------------------------------------
function readLibrary() {
  try {
    const v = JSON.parse(localStorage.getItem(LIBRARY));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function writeLibrary(lib) {
  try { localStorage.setItem(LIBRARY, JSON.stringify(lib)); return true; } catch { return false; }
}

export const library = {
  names: () => Object.keys(readLibrary()).sort((a, b) => a.localeCompare(b)),
  get: (name) => { const m = readLibrary()[name]; return m ? parseMapping(m) : null; },
  save: (m) => { const lib = readLibrary(); lib[m.name] = m; return writeLibrary(lib); },
  remove: (name) => { const lib = readLibrary(); delete lib[name]; return writeLibrary(lib); },
};

// ---- files ----------------------------------------------------------------
export const fileName = (m) => `${m.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'mapping'}.flamebeat.json`;

export function download(m) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(m, null, 2) + '\n'], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName(m) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readFile(file) { return parseMapping(JSON.parse(await file.text())); }

export async function fetchMapping(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return parseMapping(await r.json());
}
