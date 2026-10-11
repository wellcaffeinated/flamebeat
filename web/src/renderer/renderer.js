// WebGPU fractal flame renderer: persistent chaos-game chains + decaying
// fixed-point histogram + flam3-style tone map.

import {
  MAX_XFORMS, XFORM_FLOATS, PARAMS_BYTES, VARIATIONS,
  computeWGSL, decayWGSL, toneWGSL,
} from './shaders.js';
import { buildPalette } from './palette.js';

const MAX_ITERS_PER_DISPATCH = 256;

export class WebGPUUnavailable extends Error {}

export async function createRenderer(canvas, opts = {}) {
  if (!navigator.gpu) {
    throw new WebGPUUnavailable(
      window.isSecureContext
        ? 'This browser does not expose WebGPU (navigator.gpu is missing).'
        : 'WebGPU needs a secure context: open the page via http://localhost or https.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new WebGPUUnavailable('WebGPU is present but no GPU adapter is available.');
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
    },
  });
  return new FlameRenderer(canvas, adapter, device, opts);
}

export class FlameRenderer {
  constructor(canvas, adapter, device, opts) {
    this.canvas = canvas;
    this.adapter = adapter;
    this.device = device;
    this.chains = opts.chains ?? 65536;
    this.itersPerThread = opts.itersPerThread ?? 16;
    this.resScale = opts.resScale ?? 1;
    this.frameNo = 0;
    this.lost = false;
    device.lost.then((info) => { this.lost = true; console.error('GPU device lost', info); });

    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const U = GPUBufferUsage;
    this.paramBuf = device.createBuffer({ size: PARAMS_BYTES, usage: U.UNIFORM | U.COPY_DST });
    this.paramData = new ArrayBuffer(PARAMS_BYTES);
    this.xformBuf = device.createBuffer({ size: (MAX_XFORMS + 1) * XFORM_FLOATS * 4, usage: U.STORAGE | U.COPY_DST });
    this.xformData = new Float32Array((MAX_XFORMS + 1) * XFORM_FLOATS);
    this.paletteBuf = device.createBuffer({ size: 256 * 16, usage: U.STORAGE | U.COPY_DST });
    this.allocChains(this.chains);

    const mk = (code) => device.createShaderModule({ code });
    this.computePipe = device.createComputePipeline({
      layout: 'auto', compute: { module: mk(computeWGSL), entryPoint: 'main' },
    });
    this.decayPipe = device.createComputePipeline({
      layout: 'auto', compute: { module: mk(decayWGSL), entryPoint: 'main' },
    });
    const toneMod = mk(toneWGSL);
    this.tonePipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: toneMod, entryPoint: 'vs' },
      fragment: { module: toneMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.paletteKey = null;
    this.resize();
  }

  allocChains(n) {
    const U = GPUBufferUsage;
    this.chains = n;
    this.pointBuf?.destroy();
    this.rngBuf?.destroy();
    this.pointBuf = this.device.createBuffer({ size: n * 16, usage: U.STORAGE | U.COPY_DST });
    this.rngBuf = this.device.createBuffer({ size: n * 4, usage: U.STORAGE | U.COPY_DST });
    const pts = new Float32Array(n * 4);
    const seeds = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      pts[i * 4] = Math.random() * 2 - 1;
      pts[i * 4 + 1] = Math.random() * 2 - 1;
      pts[i * 4 + 2] = Math.random();
      seeds[i] = (Math.random() * 0xffffffff) >>> 0 | 1;
    }
    this.device.queue.writeBuffer(this.pointBuf, 0, pts);
    this.device.queue.writeBuffer(this.rngBuf, 0, seeds);
    this.bindGroups = null;
  }

  setChains(n) { if (n !== this.chains) this.allocChains(n); }

  /** Render at exactly w x h (video), ignoring the canvas' on-screen size; null = follow the canvas again. */
  setFixedSize(w, h) { this.fixedSize = w && h ? [w, h] : null; this.resize(); }

  /** Match the histogram to the canvas' CSS size * devicePixelRatio * resScale (or the fixed size). */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const [w, h] = this.fixedSize ?? [
      Math.max(16, Math.round(this.canvas.clientWidth * dpr * this.resScale)),
      Math.max(16, Math.round(this.canvas.clientHeight * dpr * this.resScale))];
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;
    this.histBuf?.destroy();
    this.histBuf = this.device.createBuffer({
      size: w * h * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.bindGroups = null;
  }

  makeBindGroups() {
    const d = this.device;
    const e = (b, buffer) => ({ binding: b, resource: { buffer } });
    this.bindGroups = {
      compute: d.createBindGroup({
        layout: this.computePipe.getBindGroupLayout(0),
        entries: [e(0, this.paramBuf), e(1, this.xformBuf), e(2, this.paletteBuf),
          e(3, this.pointBuf), e(4, this.rngBuf), e(5, this.histBuf)],
      }),
      decay: d.createBindGroup({
        layout: this.decayPipe.getBindGroupLayout(0),
        entries: [e(0, this.paramBuf), e(1, this.histBuf)],
      }),
      tone: d.createBindGroup({
        layout: this.tonePipe.getBindGroupLayout(0),
        entries: [e(0, this.paramBuf), e(1, this.histBuf)],
      }),
    };
  }

  setPalette(stops) {
    const key = JSON.stringify(stops);
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    this.device.queue.writeBuffer(this.paletteBuf, 0, buildPalette(stops));
  }

  clear() {
    if (this.histBuf) this.device.queue.writeBuffer(this.histBuf, 0, new Uint8Array(this.width * this.height * 16));
  }

  writeXforms(flame) {
    const xd = this.xformData;
    xd.fill(0);
    const xs = flame.xforms.slice(0, MAX_XFORMS);
    const total = xs.reduce((s, x) => s + Math.max(0, x.weight), 0) || 1;
    let cum = 0;
    const put = (slot, x, cumW) => {
      const o = slot * XFORM_FLOATS;
      const [a, b, c, d, e, f] = x.affine;
      xd.set([a, b, c, d, e, f, x.color ?? 0, x.colorSpeed ?? 0.5], o);
      VARIATIONS.forEach((v, k) => { xd[o + 8 + k] = x.vars?.[v] ?? 0; });
      xd[o + 18] = cumW;
      xd[o + 19] = x.opacity ?? 1;
    };
    xs.forEach((x, i) => {
      cum += Math.max(0, x.weight) / total;
      put(i, x, i === xs.length - 1 ? 1.0001 : cum);
    });
    if (flame.final) put(MAX_XFORMS, flame.final, 0);
    this.device.queue.writeBuffer(this.xformBuf, 0, xd);
    return xs.length;
  }

  writeParams(flame, opts) {
    const u = new Uint32Array(this.paramData);
    const f = new Float32Array(this.paramData);
    const n = this.writeXforms(flame);
    u.set([this.width, this.height, n, flame.final ? 1 : 0], 0);
    u.set([opts.itersPerThread, (this.frameNo * 7919 + 1) >>> 0, this.chains, 0], 4);
    const cam = flame.camera;
    f.set([cam.x, cam.y, cam.zoom, cam.angle ?? 0], 8);
    // k2: scale density so that the "average" lit pixel lands around 1.
    // Steady-state hits held in the histogram ~ hits per frame / (1 - decay).
    const decay = opts.decay;
    const held = this.chains * (opts.held ?? opts.itersPerThread) / Math.max(1 - Math.min(decay, 0.999), 1e-3);
    const k2 = (flame.exposure ?? 1) * (this.width * this.height) / Math.max(held, 1) * 4;
    f.set([flame.brightness, flame.gamma, flame.vibrancy, k2], 12);
    const bg = flame.background ?? [0, 0, 0];
    f.set([bg[0], bg[1], bg[2], opts.paletteOffset ?? 0], 16);
    f.set([decay, flame.juliaAtan === 'xy' ? 1 : 0, opts.hue ?? 0, 0], 20);
    this.device.queue.writeBuffer(this.paramBuf, 0, this.paramData);
  }

  /**
   * Tone-map the current histogram into an offscreen texture and read it back
   * as RGBA8 (for headless verification, where canvas readback is blank).
   */
  async snapshot() {
    const d = this.device;
    const w = this.width, h = this.height;
    if (!this.snapPipe) {
      const mod = d.createShaderModule({ code: toneWGSL });
      this.snapPipe = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
    }
    const tex = d.createTexture({ size: [w, h], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bpr = Math.ceil(w * 4 / 256) * 256;
    const buf = d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bg = d.createBindGroup({ layout: this.snapPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.paramBuf } }, { binding: 1, resource: { buffer: this.histBuf } }] });
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.snapPipe); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap(); buf.destroy(); tex.destroy();
    return { width: w, height: h, data: out };
  }

  /**
   * Tone-map the current histogram and read it back for video encoding.
   * Resources are kept between calls; returns { width, height, data, stride }
   * where rows are `stride` bytes apart (padded to 256). `data` is only valid
   * until `release()` is called.
   */
  async readFrame() {
    const d = this.device;
    const w = this.width, h = this.height;
    const bpr = Math.ceil(w * 4 / 256) * 256;
    if (!this.snapPipe) {
      const mod = d.createShaderModule({ code: toneWGSL });
      this.snapPipe = d.createRenderPipeline({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
    }
    const R = this.readRes;
    if (!R || R.w !== w || R.h !== h || R.hist !== this.histBuf) {
      R?.tex.destroy(); R?.buf.destroy();
      this.readRes = {
        w, h, hist: this.histBuf,
        tex: d.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }),
        buf: d.createBuffer({ size: bpr * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        bg: d.createBindGroup({ layout: this.snapPipe.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: this.paramBuf } }, { binding: 1, resource: { buffer: this.histBuf } }] }),
      };
    }
    const { tex, buf, bg } = this.readRes;
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(this.snapPipe); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    return { width: w, height: h, stride: bpr, data: new Uint8Array(buf.getMappedRange()), release: () => buf.unmap() };
  }

  /** Debug: read the histogram back and summarise it (slow; for tests only). */
  async histStats() {
    const size = this.width * this.height * 16;
    const rb = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.histBuf, 0, rb, 0, size);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const a = new Uint32Array(rb.getMappedRange());
    let lit = 0, max = 0, sum = 0;
    const pixels = a.length / 4;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i]) { lit++; sum += a[i]; if (a[i] > max) max = a[i]; }
    }
    rb.unmap(); rb.destroy();
    return { pixels, lit, maxDens: max, meanLitDens: lit ? sum / lit : 0 };
  }

  /**
   * Render one frame.
   * opts: { itersPerThread, decay, paletteOffset, hue }
   */
  render(flame, opts = {}) {
    if (this.lost) return;
    this.resize();
    if (!this.bindGroups) this.makeBindGroups();
    this.setPalette(flame.palette);
    const total = Math.max(1, Math.round(opts.itersPerThread ?? this.itersPerThread));
    // heavy frames (video quality) run as several dispatches of <= MAX_ITERS_PER_DISPATCH,
    // so no single GPU job runs long enough to trip a driver watchdog
    const passes = Math.ceil(total / MAX_ITERS_PER_DISPATCH);
    const o = {
      itersPerThread: Math.ceil(total / passes),
      held: total,
      decay: opts.decay ?? 0.9,
      paletteOffset: opts.paletteOffset ?? 0,
      hue: opts.hue ?? 0,
    };
    this.writeParams(flame, o);

    const enc = this.device.createCommandEncoder();
    {
      const pass = enc.beginComputePass();
      const cells = this.width * this.height * 4;
      const groups = Math.ceil(cells / 256);
      pass.setPipeline(this.decayPipe);
      pass.setBindGroup(0, this.bindGroups.decay);
      pass.dispatchWorkgroups(Math.min(groups, 65535), Math.ceil(groups / 65535));
      pass.end();
      for (let k = 0; k < passes; k++) {
        const cp = enc.beginComputePass();
        cp.setPipeline(this.computePipe);
        cp.setBindGroup(0, this.bindGroups.compute);
        cp.dispatchWorkgroups(Math.ceil(this.chains / 64));
        cp.end();
      }
    }
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.ctx.getCurrentTexture().createView(),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.tonePipe);
      pass.setBindGroup(0, this.bindGroups.tone);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([enc.finish()]);
    this.frameNo++;
    return this.chains * o.itersPerThread * passes;   // iterations this frame
  }
}
