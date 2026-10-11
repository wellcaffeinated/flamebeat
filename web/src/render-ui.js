// Render panel (render video button): format, frame rate, quality, time range,
// then an offline render to MP4 with a progress bar. main.js supplies `host`:
//   host.info()                    -> { duration, track, mapping, flame, fade, zoom }
//   host.render(settings, extra)   -> Promise<{ codecs, frames, blob }>; see video.js

import { FORMATS } from './video.js';

const QUALITY = { 1: 'standard (as live)', 2: 'high (2× iterations)', 4: 'very high (4× iterations)' };
const BITRATES = { 12: '12 Mbps', 20: '20 Mbps', 30: '30 Mbps' };
const STORE = 'flamebeat.render.v1';

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}
function select(table, value) {
  return el('select', {}, ...Object.entries(table).map(([k, v]) =>
    el('option', { value: k, textContent: typeof v === 'string' ? v : v.label, selected: String(k) === String(value) })));
}
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const slug = (s) => String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');

export class RenderPanel {
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.busy = null;   // AbortController while rendering
    this.settings = { format: 'landscape', fps: 60, quality: 1, bitrate: 20 };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(STORE)) ?? {}); } catch { /* defaults */ }
  }

  get visible() { return !this.root.hidden; }
  toggle() { this.root.hidden = !this.root.hidden; if (!this.root.hidden && !this.busy) this.render(); }

  render() {
    const info = this.host.info();
    const s = this.settings;
    const format = select(FORMATS, s.format);
    const fps = select({ 60: '60 fps', 30: '30 fps' }, s.fps);
    const quality = select(QUALITY, s.quality);
    const bitrate = select(BITRATES, s.bitrate);
    const start = el('input', { type: 'number', min: 0, step: 0.1, value: 0 });
    const end = el('input', { type: 'number', min: 0, step: 0.1, value: info.duration.toFixed(1) });
    const status = el('div', { className: 'render-status' });
    const bar = el('progress', { max: 1, value: 0, hidden: true });
    const go = el('button', { type: 'button', className: 'go', textContent: 'render video' });
    const cancel = el('button', { type: 'button', textContent: 'cancel', hidden: true });
    const row = (label, ...kids) => el('label', { className: 'row' }, el('span', { textContent: label }), ...kids);

    go.onclick = async () => {
      const settings = {
        format: format.value, fps: Number(fps.value), quality: Number(quality.value), bitrate: Number(bitrate.value),
        t0: Math.max(0, Number(start.value) || 0), t1: Math.min(info.duration, Number(end.value) || info.duration),
      };
      if (!(settings.t1 > settings.t0)) { status.textContent = 'the end must be after the start'; return; }
      this.settings = { format: settings.format, fps: settings.fps, quality: settings.quality, bitrate: settings.bitrate };
      try { localStorage.setItem(STORE, JSON.stringify(this.settings)); } catch { /* ignore */ }
      const F = FORMATS[settings.format];
      const name = `${slug(info.track)}-${slug(info.mapping || info.flame)}-${F.width}x${F.height}-${settings.fps}fps.mp4`;
      // the save dialog has to open straight from the click, before anything else is awaited
      let fileHandle = null;
      if (window.showSaveFilePicker) {
        try {
          fileHandle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
        } catch (e) { if (e.name === 'AbortError') return; throw e; }
      }
      this.busy = new AbortController();
      go.hidden = true; cancel.hidden = false; bar.hidden = false; bar.value = 0;
      for (const c of [format, fps, quality, bitrate, start, end]) c.disabled = true;
      status.textContent = 'preparing (decoding audio, building trails)…';
      try {
        const res = await this.host.render(settings, {
          fileHandle, signal: this.busy.signal,
          onProgress: (p) => {
            bar.value = p.frame / p.frames;
            status.textContent = `frame ${p.frame} / ${p.frames} · ${p.fps.toFixed(1)} frames/s · about ${fmtTime(p.eta)} left`;
          },
        });
        const a = res.codecs.audio;
        let msg = `done: ${res.frames} frames, ${res.codecs.video.mux === 'avc' ? 'H.264' : res.codecs.video.mux.toUpperCase()}`
          + (a ? ` + ${a.mux === 'aac' ? 'AAC' : 'Opus'} audio` : ', no audio');
        if (a && a.mux !== 'aac') msg += '. This browser has no AAC encoder; Instagram may reject Opus audio (Chrome on macOS/Windows has AAC).';
        if (res.blob) {
          const url = URL.createObjectURL(res.blob);
          status.replaceChildren(msg + ' ', el('a', { href: url, download: name, textContent: `download ${name}` }));
        } else status.textContent = `${msg}. Saved.`;
        bar.value = 1;
      } catch (e) {
        status.textContent = e.name === 'AbortError' ? 'cancelled (the partial file was discarded)' : `render failed: ${e.message}`;
        console.error(e);
      } finally {
        this.busy = null;
        go.hidden = false; cancel.hidden = true;
        for (const c of [format, fps, quality, bitrate, start, end]) c.disabled = false;
      }
    };
    cancel.onclick = () => this.busy?.abort();

    this.root.replaceChildren(
      el('div', { className: 'render-head' }, el('b', { textContent: 'render video' }),
        el('button', { type: 'button', className: 'close', textContent: '×', title: 'close', onclick: () => { if (!this.busy) this.root.hidden = true; } })),
      el('div', { className: 'render-what' },
        `${info.track} · fractal “${info.flame}” · ${info.mapping ? `mapping “${info.mapping}”` : 'current routes'} · fade ${info.fade} s${info.zoom !== 1 ? ` · zoom ${info.zoom}×` : ''}`),
      row('format', format), row('frame rate', fps), row('quality', quality), row('bitrate', bitrate),
      row('from (s)', start, el('span', { className: 'hint', textContent: 'to' }), end,
        el('span', { className: 'hint', textContent: `of ${fmtTime(info.duration)}` })),
      el('div', { className: 'render-go' }, go, cancel), bar, status,
      el('p', { className: 'hint', textContent: 'Renders frame by frame (not in real time) with the routes, fade, zoom, palette and fractal shown in the editor, so slow GPUs just take longer. Keep this tab in front while it runs.' }));
  }
}
