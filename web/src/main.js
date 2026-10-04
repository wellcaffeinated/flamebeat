// flamebeat entry point: WebGPU flame + <audio> + timeline-driven mapping.
//
// URL params:
//   track=Funkorama          load ../assets/audio/<track>.mp3 + timelines/<track>.json
//   audio=<url> timeline=<url>   explicit sources
//   preset=0 chains=65536 iters=16 decay=0.9 res=1 lookahead=0.03
//   t=<seconds>              start position
//   follow=0                 disable camera follow
//   clock=manual             (testing) time is set via window.__setTime(t), not audio

import { createRenderer, WebGPUUnavailable } from './renderer/renderer.js';
import { presets } from './presets.js';
import { clone, autoFrame } from './flame.js';
import { Timeline, AudioClock } from './timeline.js';
import { Mapper, applyMods, MAP_DEFAULTS } from './mapping.js';
import { DebugOverlay } from './overlay.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);

const $ = (id) => document.getElementById(id);
const canvas = $('gpu');
const msg = $('msg');
const hud = $('hud');
const audio = $('audio');
const statusEl = $('status');
const bar = $('bar');
const overlay = new DebugOverlay($('debug'));

const state = {
  presetIndex: num('preset', 0) % presets.length,
  itersPerThread: num('iters', 16),
  decay: num('decay', 0.9),
  frames: 0, itersWindow: 0, tWindow: performance.now(), fps: 0, ips: 0,
  timeline: null,
  mapper: null,
  manualT: q.get('clock') === 'manual' ? num('t', 0) : null,
};
const mapOpts = { ...MAP_DEFAULTS, lookahead: num('lookahead', MAP_DEFAULTS.lookahead) };

function fail(text) {
  msg.hidden = false;
  msg.textContent = text;
  window.__flamebeat = { error: text };
}
const setStatus = (s) => { statusEl.textContent = s; };

// ---------------------------------------------------------------- renderer
let renderer;
try {
  renderer = await createRenderer(canvas, {
    chains: num('chains', 65536),
    itersPerThread: state.itersPerThread,
    resScale: num('res', 1),
  });
} catch (e) {
  fail(e instanceof WebGPUUnavailable ? e.message : `WebGPU init failed: ${e.message ?? e}`);
  throw e;
}

function loadPreset(i) {
  const f = clone(presets[i]);
  if (f.camera === 'auto' || f.camera == null) f.camera = autoFrame(f, canvas.clientWidth / canvas.clientHeight);
  return f;
}
let base = loadPreset(state.presetIndex);

// camera follow: the mapping reshapes the attractor (spin, bass rotation), so
// re-frame the *modulated* flame on the CPU every REFRAME_MS and ease the
// camera toward it. Kick zoom pulses are applied on top of this.
const REFRAME_MS = 500, CAM_TAU = 1.5;
const follow = { target: null, last: 0, wall: performance.now() };
function followCamera(modFlame) {
  const nowMs = performance.now();
  const dt = Math.min(0.1, (nowMs - follow.wall) / 1000);
  follow.wall = nowMs;
  if (q.get('follow') === '0') return;
  if (nowMs - follow.last > REFRAME_MS) {
    follow.last = nowMs;
    follow.target = autoFrame({ ...modFlame, camera: base.camera }, canvas.clientWidth / canvas.clientHeight, 0.75, 0.02, 0.98, 6000);
  }
  if (!follow.target) return;
  const k = 1 - Math.exp(-dt / CAM_TAU);
  const c = base.camera, tg = follow.target;
  // ease zoom in log space so zooming in/out feels symmetric
  base.camera = {
    ...c,
    x: c.x + (tg.x - c.x) * k,
    y: c.y + (tg.y - c.y) * k,
    zoom: Math.exp(Math.log(c.zoom) + (Math.log(tg.zoom) - Math.log(c.zoom)) * k),
  };
}

// ---------------------------------------------------------------- audio + timeline
const clock = new AudioClock(audio);
const now = () => (state.manualT != null ? state.manualT : clock.now());

async function loadTimelineFrom(urlOrFile) {
  try {
    const json = typeof urlOrFile === 'string'
      ? await fetch(urlOrFile).then((r) => { if (!r.ok) throw new Error(`${r.status} ${urlOrFile}`); return r.json(); })
      : JSON.parse(await urlOrFile.text());
    state.timeline = new Timeline(json);
    state.mapper = new Mapper(state.timeline, undefined, mapOpts);
    setStatus(`${json.track?.file ?? 'timeline'} · ${state.timeline.tempo.toFixed(1)} BPM · `
      + `${state.timeline.events.drums?.length ?? 0} drum hits`);
    return true;
  } catch (e) {
    state.timeline = null; state.mapper = null;
    setStatus(`no timeline (${e.message}); run: just analyze <audio>`);
    console.warn('timeline load failed', e);
    return false;
  }
}

const stem = (name) => name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

function loadTrack(audioUrl, timelineUrl) {
  audio.src = audioUrl;
  audio.addEventListener('error', () => setStatus(`could not load audio ${audioUrl} (run: just fetch)`), { once: true });
  if (q.has('t')) audio.addEventListener('loadedmetadata', () => { audio.currentTime = num('t', 0); }, { once: true });
  return loadTimelineFrom(timelineUrl);
}

$('file').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  const aud = files.find((f) => f.type.startsWith('audio/') || /\.(mp3|ogg|wav|flac|m4a|opus)$/i.test(f.name));
  const js = files.find((f) => /\.json$/i.test(f.name));
  if (aud) { audio.src = URL.createObjectURL(aud); }
  if (js) await loadTimelineFrom(js);
  else if (aud) await loadTimelineFrom(`timelines/${encodeURIComponent(stem(aud.name))}.json`);
});

const track = q.get('track') ?? 'Funkorama';
loadTrack(q.get('audio') ?? `../assets/audio/${encodeURIComponent(track)}.mp3`,
  q.get('timeline') ?? `timelines/${encodeURIComponent(track)}.json`);

// seeks / rate changes: the mapper detects jumps in media time and resets
// its envelopes; timeline queries are stateless, so nothing else to do.
audio.addEventListener('seeked', () => state.mapper?.update(now()));

// ---------------------------------------------------------------- frame loop
let lastMods = {};
function draw() {
  const t = now();
  let flame = base, itersScale = 1, paletteOffset = 0;
  if (state.mapper) {
    lastMods = state.mapper.update(t);
    ({ flame, itersScale, paletteOffset } = applyMods(base, lastMods, mapOpts));
    followCamera({ ...flame, camera: base.camera });
  }
  const its = renderer.render(flame, {
    itersPerThread: state.itersPerThread * itersScale,
    decay: state.decay,
    paletteOffset,
  });
  overlay.draw(t, state.timeline, state.mapper ?? { opts: mapOpts, mappings: [], env: new Map() });
  return { its, t };
}

function frame(nowMs) {
  const { its, t } = draw();
  state.frames++;
  state.itersWindow += its;
  const dt = nowMs - state.tWindow;
  if (dt > 500) {
    state.fps = (state.frames * 1000) / dt;
    state.ips = (state.itersWindow * 1000) / dt;
    state.frames = 0; state.itersWindow = 0; state.tWindow = nowMs;
    hud.textContent = `${state.fps.toFixed(1)} fps · ${(state.ips / 1e6).toFixed(1)} M iter/s · `
      + `${renderer.width}×${renderer.height} · ${renderer.chains} chains × ${state.itersPerThread} · `
      + `${base.name}`;
  }
  window.__flamebeat = {
    frames: renderer.frameNo, fps: state.fps, ips: state.ips, t, audioT: audio.currentTime,
    adapter: renderer.adapter.info?.vendor, timeline: !!state.timeline,
    preset: base.name, mods: lastMods,
  };
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      if (audio.paused) audio.play().catch((err) => setStatus(`play failed: ${err.message}`));
      else audio.pause();
      break;
    case 'ArrowLeft': e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - (e.shiftKey ? 30 : 5)); break;
    case 'ArrowRight': e.preventDefault(); audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + (e.shiftKey ? 30 : 5)); break;
    case 'p': case 'P':
      state.presetIndex = (state.presetIndex + 1) % presets.length;
      base = loadPreset(state.presetIndex);
      renderer.clear();
      break;
    case 'd': case 'D': overlay.toggle(); break;
    case 'h': case 'H': bar.classList.toggle('hidden'); hud.hidden = !hud.hidden; break;
    case '[': state.itersPerThread = Math.max(1, Math.round(state.itersPerThread / 1.5)); break;
    case ']': state.itersPerThread = Math.min(512, Math.round(state.itersPerThread * 1.5) || 1); break;
    default: return;
  }
});
// keep the media element from swallowing keys after it was clicked
audio.addEventListener('keydown', (e) => { if ([' ', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault(); });

// ---------------------------------------------------------------- test hooks
// headless verification: tone-map to an offscreen texture and read it back
window.__grab = async () => {
  const { width, height, data } = await renderer.snapshot();
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return c.toDataURL('image/png');
};
window.__setTime = (t) => { state.manualT = t; };
window.__overlay = (on = true) => { if (overlay.visible !== on) overlay.toggle(); };
window.__renderer = renderer;
