// Palette editor (the "look" tab of the route editor): a gradient strip drawn
// exactly as the renderer builds it, with one marker per colour stop.
//   click a marker   pick its colour (browser colour picker)
//   drag a marker    move the stop
//   double-click the strip   add a stop there (in the colour already at that spot)
// main.js supplies `host`:
//   host.palette()          -> { stops, custom, flame }   stops: [[pos, [r,g,b]]]
//   host.setPalette(stops)  stops, or null = go back to the fractal's own palette
//   host.presets()          -> [{ name, palette }]

import { buildPalette, hex } from './renderer/palette.js';

const toHex = (rgb) => '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const STRIP_W = 512;
const DRAG_PX = 3;   // pointer travel before a press on a marker counts as a drag

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export class PaletteEditor {
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.selected = -1;
  }

  /** Edits always start from a copy of the current stops, so the first edit makes the palette custom. */
  stops() { return structuredClone(this.host.palette().stops).sort((a, b) => a[0] - b[0]); }

  set(stops, selectedStop) {
    stops.sort((a, b) => a[0] - b[0]);
    this.selected = selectedStop ? stops.indexOf(selectedStop) : -1;
    this.host.setPalette(stops);
    this.render();
  }

  render() {
    const { stops, custom, flame } = this.host.palette();
    const r = this.root;
    r.replaceChildren();

    const strip = el('canvas', { className: 'palette-strip', width: 256, height: 1, title: 'double-click to add a colour stop' });
    const lut = buildPalette(stops);
    const img = new ImageData(256, 1);
    for (let i = 0; i < 256 * 4; i++) img.data[i] = (i % 4 === 3) ? 255 : Math.round(lut[i] * 255);
    strip.getContext('2d').putImageData(img, 0, 0);
    strip.addEventListener('dblclick', (e) => {
      const pos = Math.min(1, Math.max(0, e.offsetX / strip.clientWidth));
      const i = Math.min(255, Math.round(pos * 255));
      const stop = [pos, [lut[i * 4], lut[i * 4 + 1], lut[i * 4 + 2]]];
      const next = this.stops();
      next.push(stop);
      this.set(next, stop);
    });

    const markers = el('div', { className: 'palette-markers' });
    stops.forEach(([pos, rgb], i) => markers.append(this.marker(pos, rgb, i, markers)));

    const from = el('select', { title: 'start from another fractal’s palette' },
      el('option', { value: '', textContent: 'copy palette from…' }),
      ...this.host.presets().map((p, i) => el('option', { value: i, textContent: p.name })));
    from.addEventListener('change', () => {
      const p = this.host.presets()[from.value];
      if (p) this.set(structuredClone(p.palette));
    });
    const button = (text, title, onclick, disabled = false) =>
      Object.assign(el('button', { type: 'button', textContent: text, title, disabled }), { onclick });
    const sel = this.selected >= 0 && this.selected < stops.length ? this.selected : -1;

    r.append(
      el('div', { className: 'look-head' },
        el('b', { textContent: 'palette' }),
        el('span', { className: 'hint', textContent: custom ? 'custom (kept when you switch fractal with P)' : `${flame}’s own` })),
      el('div', { className: 'palette-edit', style: `width: ${STRIP_W}px` }, strip, markers),
      el('div', { className: 'palette-tools' },
        from,
        button('reverse', 'flip the gradient end to end', () => this.set(this.stops().map(([p, c]) => [1 - p, c]))),
        button('remove stop', sel < 0 ? 'select a stop first (click its marker)' : 'remove the selected stop', () => {
          const next = this.stops();
          next.splice(sel, 1);
          this.set(next);
        }, sel < 0 || stops.length <= 2),
        button('use fractal’s own', 'drop the custom palette', () => { this.selected = -1; this.host.setPalette(null); this.render(); }, !custom)),
      el('div', { className: 'hint', style: `max-width: ${STRIP_W}px`, textContent: 'click a marker to change its colour · drag to move it · double-click the strip to add a stop · the gradient wraps from the right end back to the left' }));
  }

  marker(pos, rgb, i, track) {
    const color = el('input', { type: 'color', value: toHex(rgb), tabIndex: -1 });
    const m = el('span', { className: 'palette-marker' + (i === this.selected ? ' selected' : ''), title: `stop ${i + 1} at ${pos.toFixed(2)}` }, color);
    m.setAttribute('role', 'button');
    m.style.left = `${pos * 100}%`;
    m.style.background = toHex(rgb);
    m.setAttribute('aria-label', `colour stop ${i + 1}`);
    // live while the picker is open: update the palette, re-render the strip when it closes
    color.addEventListener('input', () => {
      const next = this.stops();
      next[i][1] = hex(color.value);
      m.style.background = color.value;
      this.selected = i;
      this.host.setPalette(next);
    });
    color.addEventListener('change', () => this.render());

    m.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      let dragging = false, next = null;
      m.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!dragging && Math.abs(ev.clientX - x0) < DRAG_PX) return;
        dragging = true;
        const box = track.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width));
        next ??= this.stops();
        next[i][0] = p;
        m.style.left = `${p * 100}%`;
        this.host.setPalette([...next].sort((a, b) => a[0] - b[0]));
      };
      const up = () => {
        m.removeEventListener('pointermove', move);
        m.removeEventListener('pointerup', up);
        if (dragging) { this.set(next, next[i]); return; }
        // a plain click: select it and open the colour picker
        this.selected = i;
        this.render();
        const input = this.root.querySelectorAll('.palette-marker input')[i];
        try { input.showPicker(); } catch { input?.click(); }
      };
      m.addEventListener('pointermove', move);
      m.addEventListener('pointerup', up);
    });
    return m;
  }
}
