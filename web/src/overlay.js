// Debug overlay (toggle with D): live bars for every mapped signal, the raw
// timeline streams, chroma, and flashes for drum events / beats.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const COLORS = { kick: '#ff4d4d', snare: '#4da6ff', hat: '#5cd65c', beat: '#ccc', downbeat: '#fff' };

export class DebugOverlay {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.visible = false;
    this.chroma = new Float32Array(12);
  }

  toggle() { this.visible = !this.visible; this.c.hidden = !this.visible; }

  draw(t, tl, mapper) {
    if (!this.visible) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 330, H = 470;
    if (this.c.width !== W * dpr) { this.c.width = W * dpr; this.c.height = H * dpr; this.c.style.width = `${W}px`; this.c.style.height = `${H}px`; }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(0, 0, W, H);
    g.font = '11px ui-monospace, monospace';
    g.textBaseline = 'middle';
    let y = 12;
    const row = (label, v, color = '#8fd', text) => {
      g.fillStyle = '#aaa'; g.fillText(label, 6, y);
      g.fillStyle = '#222'; g.fillRect(130, y - 5, 150, 10);
      g.fillStyle = color; g.fillRect(130, y - 5, 150 * Math.min(1, Math.max(0, v)), 10);
      g.fillStyle = '#ccc'; g.fillText(text ?? v.toFixed(2), 286, y);
      y += 14;
    };
    g.fillStyle = '#fff';
    g.fillText(`t ${t.toFixed(2)}s  lookahead ${(mapper.opts.lookahead * 1000).toFixed(0)}ms`, 6, y); y += 16;
    if (!tl) { g.fillText('no timeline loaded', 6, y); return; }

    for (const s of ['volume', 'energy.intensity', 'energy.flux', 'energy.sub', 'energy.bass', 'energy.mid', 'energy.high']) {
      row(s, tl.sample(s, t));
    }
    y += 4;
    // drum flashes
    for (const k of ['kick', 'snare', 'hat']) {
      const v = tl.impulse(k, t, { release: 0.1, lookahead: mapper.opts.lookahead });
      row(k, v, COLORS[k]);
    }
    const beat = tl.eventsIn('beats', t - 0.12, t)[0];
    const pos = beat?.bar_pos != null ? ` ${beat.bar_pos + 1}/${tl.meter.pulses}` : '';
    row(beat?.downbeat ? `beat${pos} (downbeat)` : `beat${pos}`, beat ? 1 - (t - beat.t) / 0.12 : 0, beat?.downbeat ? COLORS.downbeat : COLORS.beat);
    const f0 = tl.sampleNearest('pitch.bass.f0', t);
    const conf = tl.sample('pitch.bass.conf', t);
    row('bass conf', conf, '#fc6', f0 > 0 ? `${f0.toFixed(0)}Hz` : '—');
    y += 4;
    g.fillStyle = '#fff'; g.fillText('mapped (after envelope)', 6, y); y += 14;
    for (const m of mapper.mappings) {
      const e = mapper.env.get(m.id);
      const v = Array.isArray(e) ? ((Math.atan2(e[1], e[0]) / (2 * Math.PI)) + 1) % 1 : (e ?? 0);
      row(m.id, v, '#d8f');
    }
    y += 6;
    // chroma
    const c = tl.sampleChroma(t, this.chroma);
    const bw = (W - 12) / 12;
    for (let k = 0; k < 12; k++) {
      const h = 40 * c[k];
      g.fillStyle = `hsl(${k * 30},80%,60%)`;
      g.fillRect(6 + k * bw, y + 40 - h, bw - 2, h);
      g.fillStyle = '#aaa'; g.fillText(NAMES[k], 6 + k * bw, y + 50);
    }
  }
}
