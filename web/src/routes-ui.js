// Route editor (toggle with M): one row per signal -> parameter route, with a
// source select, a target select, a response curve and an amount slider; ▸ opens
// a detail line with the output range and smoothing. Edits apply live via
// mapper.setRoutes() and are remembered in localStorage. Saved routes are full
// copies (ranges, curves), so when the defaults in mapping.js change the panel
// offers to switch to them instead of silently keeping the old ones.
// A second tab, "look", hosts the palette editor (palette-ui.js).

import { SOURCES, TARGETS, MAPPINGS, CURVES, resolve } from './mapping.js';
import { makeMapping, library, download, readFile } from './mappings.js';

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

const COLUMNS_HELP = [
  ['source → parameter', 'What drives the change (a signal from the analysed song) and what it changes in the fractal. Several routes can drive the same parameter: their effects add up.'],
  ['curve', 'Reshapes the source before it is used. Square root lifts quiet parts; quadratic, cubic and exponential keep quiet parts low and save the range for peaks, so big moments stand out more.'],
  ['▸', 'Opens the route’s details: its output range and smoothing. Lit when the range differs from the default for this source and parameter.'],
  ['range', 'The parameter values the route produces for the quietest (left) and strongest (right) source, at amount 1. Drag the ends of the bar or type the numbers; a left value above the right one inverts the route. The dot is the live value, the tick the parameter’s neutral (no-route) value.'],
  ['smooth', 'Averages a level source over a window centred on now, for a steadier signal that follows phrases instead of single hits. Events (hits, beats) and pitch sources are not averaged.'],
  ['amount', 'How strongly the route acts: 0 = off, 1 = as designed, 2 = double, negative = the opposite direction. Double-click to reset to 1.'],
  ['bar', 'The live value of the route after smoothing, 0 to 1.'],
];

/** A small (?) button: hover shows `text`; click pins it under the row (`show`). */
function helpButton(text, show) {
  const b = el('button', { type: 'button', className: 'help', textContent: '?', title: text });
  b.setAttribute('aria-label', 'help');
  b.addEventListener('click', () => show(text));
  return b;
}

/** Step for editing a range of this size: about 1/100 of it, rounded to a power of ten. */
const stepFor = (span) => 10 ** Math.floor(Math.log10(Math.max(1e-6, Math.abs(span)) / 100));
const decimals = (step) => Math.max(0, -Math.floor(Math.log10(step)));
const sameRange = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

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
    this.lives = [];
    this.tab = 'routes';
    this.open = new WeakSet();   // rows whose detail line is open
    this.render();
  }

  /** The look tab's editor (a PaletteEditor), set by main.js. */
  look = null;

  /**
   * Mapping presets. main.js sets `hooks = { current(): { flame, fade, zoom, palette }, apply(mapping) }`:
   * current() supplies the non-route parts to save, apply() switches flame/fade/zoom/palette
   * and then calls setRows().
   */
  hooks = null;
  mappingName = '';
  mappingMsg = '';

  /** Replace all routes (from a mapping). persist = false keeps the editor's saved routes untouched. */
  setRows(rows, { persist = true, name } = {}) {
    this.rows = structuredClone(rows);
    if (name != null) this.mappingName = name;
    if (persist) saveRoutes(this.rows);
    this.onChange(this.rows);
    this.render();
  }

  currentMapping(name = this.mappingName) {
    return makeMapping({ name, ...(this.hooks?.current() ?? {}), routes: this.rows });
  }

  applyMapping({ mapping, warnings }, verb = 'loaded') {
    this.mappingMsg = [`${verb} “${mapping.name}”`, ...warnings].join(' · ');
    if (this.hooks) this.hooks.apply(mapping);
    else this.setRows(mapping.routes, { name: mapping.name });
  }

  mappingBar() {
    const msg = el('span', { className: 'mapping-msg', textContent: this.mappingMsg });
    const say = (t) => { this.mappingMsg = t; msg.textContent = t; };
    const names = library.names();
    const load = el('select', { title: 'load a saved mapping' },
      el('option', { value: '', textContent: names.length ? 'load…' : 'no saved mappings' }),
      ...names.map((n) => el('option', { value: n, textContent: n, selected: n === this.mappingName })));
    load.addEventListener('change', () => {
      const got = load.value && library.get(load.value);
      if (got) this.applyMapping(got);
    });
    const name = el('input', { type: 'text', value: this.mappingName, placeholder: 'mapping name', title: 'name to save as' });
    const button = (text, title, onclick) => Object.assign(el('button', { type: 'button', textContent: text, title }), { onclick });
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', async () => {
      try {
        const got = await readFile(file.files[0]);
        library.save(got.mapping);
        this.applyMapping(got, 'imported');
      } catch (e) { say(`import failed: ${e.message}`); }
    });
    return el('div', { className: 'mapping-bar' },
      el('span', { className: 'hint', textContent: 'mapping' }), load, name,
      button('save', 'save routes, fade, zoom, palette and fractal under this name (in this browser)', () => {
        const n = name.value.trim();
        if (!n) { say('give the mapping a name first'); name.focus(); return; }
        if (n !== this.mappingName && library.names().includes(n) && !confirm(`Replace the saved mapping “${n}”?`)) return;
        this.mappingName = n;
        say(library.save(this.currentMapping(n)) ? `saved “${n}”` : 'could not save (browser storage blocked?)');
        this.render();
      }),
      button('delete', 'delete the selected saved mapping', () => {
        const n = load.value || this.mappingName;
        if (!n || !library.names().includes(n)) { say('pick a saved mapping to delete'); return; }
        if (!confirm(`Delete the saved mapping “${n}”?`)) return;
        library.remove(n);
        if (n === this.mappingName) this.mappingName = '';
        say(`deleted “${n}”`);
        this.render();
      }),
      button('export', 'download as a .json file (use it with ?mapping=… or for rendering)', () => {
        download(this.currentMapping(name.value.trim() || this.mappingName || 'mapping'));
      }),
      button('import', 'load a mapping .json file (also adds it to the saved list)', () => file.click()),
      file, msg);
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
    this.lives = [];
    const tabs = el('span', { className: 'tabs' }, ...['routes', 'look'].map((t) =>
      Object.assign(el('button', { type: 'button', textContent: t, className: t === this.tab ? 'on' : '' }),
        { onclick: () => { this.tab = t; this.render(); } })));
    if (this.tab === 'look' && this.look) {
      r.append(el('div', { className: 'routes-head' }, tabs), this.mappingBar(), this.look.root);
      this.look.render();
      return;
    }
    const legend = el('dl', { className: 'routes-legend', hidden: true },
      ...COLUMNS_HELP.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
    const legendBtn = el('button', { type: 'button', className: 'help', textContent: '?', title: 'what the columns mean' });
    legendBtn.addEventListener('click', () => { legend.hidden = !legend.hidden; });
    r.append(el('div', { className: 'routes-head' },
      tabs,
      el('span', { className: 'hint', textContent: 'source → parameter · curve · amount · ▸ range' }),
      legendBtn), legend, this.mappingBar());
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
      const details = this.details(row, def, smooth);
      const fold = el('button', { type: 'button', className: 'fold', textContent: this.open.has(row) ? '▾' : '▸', title: 'output range and smoothing' });
      const custom = () => fold.classList.toggle('custom', !!row.out && !sameRange(row.out, def.out));
      custom();
      details.addEventListener('range', custom);
      fold.addEventListener('click', () => {
        if (this.open.has(row)) this.open.delete(row); else this.open.add(row);
        details.hidden = !this.open.has(row);
        fold.textContent = details.hidden ? '▸' : '▾';
      });
      // help: hover a (?) for a tooltip, click to pin the text under the row (click again to hide)
      const helpLine = el('div', { className: 'route-help', hidden: true });
      const show = (text) => {
        helpLine.hidden = !helpLine.hidden && helpLine.textContent === text;
        helpLine.textContent = text;
      };
      r.append(el('div', { className: 'route' },
        select(SOURCES, row.src, (v) => fresh({ src: v })),
        helpButton(`${SOURCES[row.src].label}: ${SOURCES[row.src].help}`, show),
        el('span', { className: 'arrow', textContent: '→' }),
        select(TARGETS, row.target, (v) => fresh({ target: v })),
        helpButton(`${TARGETS[row.target].label}: ${TARGETS[row.target].help}`, show),
        curve, slider, val, meter, fold,
        Object.assign(el('button', { textContent: '×', title: 'remove route' }),
          { onclick: () => { this.rows.splice(i, 1); this.changed(true); } })), helpLine, details);
    });

    r.append(el('div', { className: 'routes-foot' },
      Object.assign(el('button', { textContent: '+ add route' }),
        { onclick: () => { this.rows.push({ src: 'kick', target: 'zoomPulse', amount: 1 }); this.changed(true); } }),
      Object.assign(el('button', { textContent: 'reset to defaults' }),
        { onclick: () => { this.rows = structuredClone(MAPPINGS); acceptDefaults(); this.changed(true); } })));
  }

  /**
   * A route's detail line: its output range as a bar with two draggable ends
   * plus number fields, and the smoothing select. The bar spans the default
   * range and neutral with some room either side, and widens when a typed
   * value falls outside it. Dispatches a 'range' event on every range change.
   */
  details(row, def, smooth) {
    const T = TARGETS[row.target];
    const range = () => row.out ?? def.out;
    const [dlo, dhi] = def.out;
    const pad = Math.abs(dhi - dlo) * 0.25 || 0.1;
    let lo0, hi0;
    const fit = () => {
      const [a, b] = range();
      if (lo0 != null && Math.min(a, b) >= lo0 && Math.max(a, b) <= hi0) return;
      lo0 = Math.min(dlo, dhi, T.neutral, a, b) - pad;
      hi0 = Math.max(dlo, dhi, T.neutral, a, b) + pad;
      neutral.style.left = x(T.neutral);
    };
    const step = stepFor(dhi - dlo), dp = decimals(step);
    const x = (v) => `${((v - lo0) / (hi0 - lo0)) * 100}%`;

    const seg = el('i', { className: 'seg' });
    const ends = [el('b', { className: 'end' }), el('b', { className: 'end' })];
    const dot = el('u', { className: 'live' });
    const neutral = el('s', { className: 'neutral', title: `neutral ${T.neutral}` });
    const bar = el('span', { className: 'range-bar', title: 'drag either end' }, seg, neutral, ...ends, dot);
    const num = (k) => el('input', { type: 'number', step, value: range()[k].toFixed(dp), title: k ? 'value for the strongest source' : 'value for the quietest source' });
    const nums = [num(0), num(1)];
    const reset = el('button', { type: 'button', textContent: 'default', title: `default range for this pairing: ${dlo} … ${dhi}` });
    const line = el('div', { className: 'route-details', hidden: !this.open.has(row) },
      el('span', { className: 'hint', textContent: 'range' }), nums[0], bar, nums[1],
      el('span', { className: 'hint', textContent: T.label }), reset,
      el('span', { className: 'hint sep', textContent: 'smooth' }), smooth);

    const show = () => {
      fit();
      const [a, b] = range();
      seg.style.left = x(Math.min(a, b));
      seg.style.width = `${(Math.abs(b - a) / (hi0 - lo0)) * 100}%`;
      ends[0].style.left = x(a);
      ends[1].style.left = x(b);
      reset.disabled = sameRange(range(), def.out);
    };
    const set = (k, v, fromInput = false) => {
      const out = [...range()];
      out[k] = fromInput ? v : Number((Math.round(v / step) * step).toFixed(dp));   // typed values are kept as typed
      if (sameRange(out, def.out)) delete row.out; else row.out = out;
      if (!fromInput) nums[k].value = out[k].toFixed(dp);
      show();
      line.dispatchEvent(new Event('range'));
      this.changed();
    };
    nums.forEach((n, k) => n.addEventListener('input', () => { if (n.value !== '' && Number.isFinite(Number(n.value))) set(k, Number(n.value), true); }));
    reset.addEventListener('click', () => {
      delete row.out;
      nums.forEach((n, k) => { n.value = def.out[k].toFixed(dp); });
      show();
      line.dispatchEvent(new Event('range'));
      this.changed();
    });
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const box = bar.getBoundingClientRect();
      const at = (ev) => lo0 + Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)) * (hi0 - lo0);
      // grab whichever end is nearer the pointer (on a tie, the one on the pointer's side)
      const v = at(e), [a, b] = range();
      const da = Math.abs(v - a), db = Math.abs(v - b);
      const k = Math.abs(da - db) > 1e-9 ? (da < db ? 0 : 1) : (v > a) === (b >= a) ? 1 : 0;
      bar.setPointerCapture(e.pointerId);
      set(k, v);
      const move = (ev) => set(k, at(ev));
      const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    show();
    this.lives.push({ dot, range, x, line });
    return line;
  }

  /** Live envelope meters (and the live value on open range bars), fed from the mapper each frame. */
  draw(mapper) {
    if (!this.visible || !mapper || this.tab !== 'routes') return;
    mapper.mappings.forEach((m, i) => {
      const e = mapper.env.get(m.id);
      const v = Array.isArray(e) ? ((Math.atan2(e[1], e[0]) / (2 * Math.PI)) + 1) % 1 : (e ?? 0);
      const u = Math.min(1, Math.max(0, v));
      if (this.meters[i]) this.meters[i].style.width = `${Math.round(u * 100)}%`;
      const live = this.lives[i];
      if (live && !live.line.hidden) {
        const [a, b] = live.range();
        live.dot.style.left = live.x(a + (b - a) * u);
      }
    });
  }
}
