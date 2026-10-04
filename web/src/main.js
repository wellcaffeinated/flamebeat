// flamebeat entry point.
import { createRenderer, WebGPUUnavailable } from './renderer/renderer.js';
import { presets } from './presets.js';
import { clone, autoFrame } from './flame.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);

const canvas = document.getElementById('gpu');
const msg = document.getElementById('msg');
const hud = document.getElementById('hud');

const state = {
  presetIndex: num('preset', 0) % presets.length,
  itersPerThread: num('iters', 16),
  decay: num('decay', 0.9),
  frames: 0,
  itersWindow: 0,
  tWindow: performance.now(),
  fps: 0,
  ips: 0,
};

function fail(text) {
  msg.hidden = false;
  msg.textContent = text;
  window.__flamebeat = { error: text };
}

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
let flame = loadPreset(state.presetIndex);

function draw() {
  return renderer.render(flame, {
    itersPerThread: state.itersPerThread,
    decay: state.decay,
  });
}

// test hook (headless verification): tone-map to an offscreen texture and read it back
window.__grab = async () => {
  const { width, height, data } = await renderer.snapshot();
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return c.toDataURL('image/png');
};

function frame(now) {
  const its = draw();
  state.frames++;
  state.itersWindow += its;
  const dt = now - state.tWindow;
  if (dt > 500) {
    state.fps = (state.frames * 1000) / dt;
    state.ips = (state.itersWindow * 1000) / dt;
    state.frames = 0; state.itersWindow = 0; state.tWindow = now;
    hud.textContent = `${state.fps.toFixed(1)} fps · ${(state.ips / 1e6).toFixed(1)} M iter/s · `
      + `${renderer.width}×${renderer.height} · ${renderer.chains} chains × ${state.itersPerThread} · `
      + `${flame.name}`;
  }
  window.__flamebeat = { frames: renderer.frameNo, fps: state.fps, ips: state.ips, adapter: renderer.adapter.info?.vendor };
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__renderer = renderer;

window.addEventListener('keydown', (e) => {
  if (e.key === 'p' || e.key === 'P') {
    state.presetIndex = (state.presetIndex + 1) % presets.length;
    flame = loadPreset(state.presetIndex);
  }
});
