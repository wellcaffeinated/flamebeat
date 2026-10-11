// Route editor (toggle with M): one row per signal -> parameter route, with a
// source select, a target select, a response curve, smoothing and an amount slider. Edits apply live via
// mapper.setRoutes() and are remembered in localStorage. Saved routes are full
// copies (ranges, curves), so when the defaults in mapping.js change the panel
// offers to switch to them instead of silently keeping the old ones.

import { SOURCES, TARGETS, MAPPINGS, CURVES, resolve } from './mapping.js';

/** Smoothing windows offered for continuous sources (seconds; '' = off). */
// keys are '2s' etc. so the object keeps this order (integer-like keys would sort first)
const SMOOTH_S = [0.1, 0.25, 0.5, 0.75, 1, 2];
const smoothOpts = (extra) => Object.fromEntries([['', 'raw'],
  ...[...new Set([...SMOOTH_S, ...(extra ? [extra] : [])])].sort((a, b) => a - b).map((v) => [`${v}s`, `avg ${v} s`])]
  .map(([k, label]) => [k, { label }]));

// v2: new default routes (beats -> brightness/palette, no zoom or iteration changes)
const STORE = 'flamebeat.routes.v2';
const STORE_DEFAULTS = 'flamebeat.routes.v2.defaults';   // MAPPINGS the saved rows were based on
const DEFAULTS = JSON.stringify(MAPPINGS);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/** True when routes were saved against different defaults than the current MAPPINGS. */
export function routesStale() {
  return store.get(STORE) != null && store.get(STORE_DEFAULTS) !== DEFAULTS;
}

export function loadRoutes() {
  try {
    const rows = JSON.parse(localStorage.getItem(STORE));
    if (Array.isArray(rows) && rows.every((r) => SOURCES[r.src] && TARGETS[r.target])) return rows;
  } catch { /* storage blocked or corrupt: fall back to defaults */ }
  return structuredClone(MAPPINGS);
}

function saveRoutes(rows) {
  // the first save records which defaults these routes started from
  if (store.get(STORE) == null) store.set(STORE_DEFAULTS, DEFAULTS);
  store.set(STORE, JSON.stringify(rows));
}

function acceptDefaults() { store.set(STORE_DEFAULTS, DEFAULTS); }

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function select(table, value, onChange) {
  const s = el('select');
  for (const [k, v] of Object.entries(table)) s.append(el('option', { value: k, textContent: v.label, selected: k === value }));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

export class RoutesPanel {
  /** `onChange(rows)` is called after every edit. */
  constructor(root, rows, onChange) {
    this.root = root;
    this.rows = rows;
    this.onChange = onChange;
    this.meters = [];
    this.render();
  }

  get visible() { return !this.root.hidden; }
  toggle() { this.root.hidden = !this.root.hidden; }

  changed(rebuild = false) {
    saveRoutes(this.rows);
    this.onChange(this.rows);
    if (rebuild) this.render();
  }

  render() {
    const r = this.root;
    r.replaceChildren();
    this.meters = [];
    r.append(el('div', { className: 'routes-head' },
      el('b', { textContent: 'routes' }),
      el('span', { className: 'hint', textContent: 'source → parameter · amount (double-click = 1)' })));
    document.getElementById('routes-btn')?.classList.toggle('stale', routesStale());
    if (routesStale()) {
      r.append(el('div', { className: 'routes-stale' },
        el('span', { textContent: 'The default routes changed since these were saved.' }),
        Object.assign(el('button', { textContent: 'use new defaults' }),
          { onclick: () => { this.rows = structuredClone(MAPPINGS); acceptDefaults(); this.changed(true); } }),
        Object.assign(el('button', { textContent: 'keep mine' }),
          { onclick: () => { acceptDefaults(); this.render(); } })));
    }

    this.rows.forEach((row, i) => {
      // changing source/target drops per-row envelope overrides so the new
      // pairing gets that source's and target's own defaults (a chosen curve is kept)
      const fresh = (patch) => {
        const keep = typeof row.curve === 'string' ? { curve: row.curve } : {};
        if (row.smooth) keep.smooth = row.smooth;
        this.rows[i] = { src: row.src, target: row.target, amount: row.amount ?? 1, ...keep, ...patch };
        this.changed(true);
      };
      const val = el('output', { textContent: (row.amount ?? 1).toFixed(2) });
      const slider = el('input', { type: 'range', min: -2, max: 2, step: 0.05, value: row.amount ?? 1, title: 'amount' });
      slider.addEventListener('input', () => {
        row.amount = Number(slider.value);
        val.textContent = row.amount.toFixed(2);
        this.changed();
      });
      slider.addEventListener('dblclick', () => { slider.value = 1; slider.dispatchEvent(new Event('input')); });
      // curve: '' = the pairing's default (named in the label); circular sources have none
      const def = resolve({ src: row.src, target: row.target });
      const defLabel = typeof def.curve === 'number' ? `default (^${def.curve})` : `default (${CURVES[def.curve]?.label ?? 'linear'})`;
      const curve = select({ '': { label: defLabel }, ...CURVES }, row.curve ?? '', (v) => {
        if (v) row.curve = v; else delete row.curve;
        this.changed();
      });
      curve.className = 'curve';
      curve.title = 'response curve';
      if (def.circular) { curve.disabled = true; curve.title = 'circular source: no curve'; }
      // smoothing: only continuous (stream) sources can be averaged
      // a saved window that is no longer offered stays listed, so the select shows what runs
      const smooth = select(smoothOpts(row.smooth), row.smooth ? `${row.smooth}s` : '', (v) => {
        if (v) row.smooth = parseFloat(v); else delete row.smooth;
        this.changed();
      });
      smooth.className = 'smooth';
      smooth.title = 'average the source over a window centred on now';
      if (!SOURCES[row.src].src.stream) { smooth.disabled = true; smooth.title = 'events and pitch sources are not averaged'; }
      const meter = el('span', { className: 'meter' }, el('i'));
      this.meters.push(meter.firstChild);
      r.append(el('div', { className: 'route' },
        select(SOURCES, row.src, (v) => fresh({ src: v })),
        el('span', { className: 'arrow', textContent: '→' }),
        select(TARGETS, row.target, (v) => fresh({ target: v })),
        curve, smooth, slider, val, meter,
        Object.assign(el('button', { textContent: '×', title: 'remove route' }),
          { onclick: () => { this.rows.splice(i, 1); this.changed(true); } })));
    });

    r.append(el('div', { className: 'routes-foot' },
      Object.assign(el('button', { textContent: '+ add route' }),
        { onclick: () => { this.rows.push({ src: 'kick', target: 'zoomPulse', amount: 1 }); this.changed(true); } }),
      Object.assign(el('button', { textContent: 'reset to defaults' }),
        { onclick: () => { this.rows = structuredClone(MAPPINGS); acceptDefaults(); this.changed(true); } })));
  }

  /** Live envelope meters, fed from the mapper each frame. */
  draw(mapper) {
    if (!this.visible || !mapper) return;
    mapper.mappings.forEach((m, i) => {
      const e = mapper.env.get(m.id);
      const v = Array.isArray(e) ? ((Math.atan2(e[1], e[0]) / (2 * Math.PI)) + 1) % 1 : (e ?? 0);
      if (this.meters[i]) this.meters[i].style.width = `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
    });
  }
}
