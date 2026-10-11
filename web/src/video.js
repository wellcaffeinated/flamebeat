// Offline video render. The song is stepped at exactly 1/fps per frame (not in
// real time), each frame is rendered by the WebGPU flame, read back, encoded
// with WebCodecs and muxed to MP4 together with the song's audio:
//   video: H.264 (VP9 if the browser has no H.264 encoder)
//   audio: AAC   (Opus if the browser has no AAC encoder, e.g. Chromium on Linux)
// Output streams to a file picked with showSaveFilePicker() when available
// (large renders never sit in memory), else it is collected and returned.

import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from '../vendor/mp4-muxer/mp4-muxer.mjs';

export const FORMATS = {
  landscape: { label: 'landscape 16:9 · 1920×1080', width: 1920, height: 1080 },
  portrait: { label: 'portrait 9:16 · 1080×1920 (Reels, Stories, TikTok)', width: 1080, height: 1920 },
  feed: { label: 'portrait 4:5 · 1080×1350 (Instagram feed)', width: 1080, height: 1350 },
  square: { label: 'square 1:1 · 1080×1080', width: 1080, height: 1080 },
};

const AUDIO_RATE = 48000;
const VIDEO_CODECS = [
  ['avc', 'avc1.64002A'],     // H.264 High 4.2: up to 1080p60 in either orientation
  ['avc', 'avc1.640033'],     // High 5.1
  ['vp9', 'vp09.00.41.08'],
];
const AUDIO_CODECS = [['aac', 'mp4a.40.2'], ['opus', 'opus']];

/** First supported video + audio encoder configs for these settings. */
export async function pickCodecs({ width, height, fps, bitrate, audioBitrate = 192000 }) {
  if (typeof VideoEncoder === 'undefined') throw new Error('this browser has no WebCodecs VideoEncoder');
  let video = null, audio = null;
  for (const [mux, codec] of VIDEO_CODECS) {
    const config = { codec, width, height, framerate: fps, bitrate, latencyMode: 'quality', ...(mux === 'avc' ? { avc: { format: 'avc' } } : {}) };
    if ((await VideoEncoder.isConfigSupported(config)).supported) { video = { mux, config }; break; }
  }
  if (!video) throw new Error(`no video encoder for ${width}×${height}@${fps}`);
  if (typeof AudioEncoder !== 'undefined') {
    for (const [mux, codec] of AUDIO_CODECS) {
      const config = { codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: audioBitrate };
      if ((await AudioEncoder.isConfigSupported(config)).supported) { audio = { mux, config }; break; }
    }
  }
  return { video, audio };
}

/** Decode the song to 48 kHz stereo Float32 channels. */
async function decodeAudio(url) {
  const data = await (await fetch(url)).arrayBuffer();
  const ab = await new OfflineAudioContext(2, AUDIO_RATE, AUDIO_RATE).decodeAudioData(data);
  const l = ab.getChannelData(0);
  return [l, ab.numberOfChannels > 1 ? ab.getChannelData(1) : l];
}

/**
 * opts:
 *   renderer              FlameRenderer
 *   frameAt(t)            -> { flame, itersScale, paletteOffset, hue, fadeScale } for media time t
 *   iters, fade           iterations per chain per frame and fade time (s) at quality 1
 *   width, height, fps, t0, t1 (s), quality (iteration multiplier), bitrate
 *   preroll               seconds rendered before t0 (not encoded) so trails are built up
 *   audioUrl              song to mux in (null = silent video)
 *   fileHandle            FileSystemFileHandle to stream into (else a Blob is returned)
 *   onProgress({ frame, frames, fps, eta, codecs }), signal (AbortSignal)
 */
export async function renderVideo(opts) {
  const { renderer, frameAt, width, height, fps, t0, t1, signal } = opts;
  const quality = opts.quality ?? 1;
  const frames = Math.max(1, Math.round((t1 - t0) * fps));
  const pre = Math.max(0, Math.round((opts.preroll ?? 0) * fps));
  const codecs = await pickCodecs({ width, height, fps, bitrate: opts.bitrate });
  const channels = codecs.audio && opts.audioUrl ? await decodeAudio(opts.audioUrl) : null;
  const s0 = Math.round(t0 * AUDIO_RATE);
  const s1 = channels ? Math.min(channels[0].length, Math.round(t1 * AUDIO_RATE)) : s0;

  let writable = null;
  const target = opts.fileHandle
    ? new FileSystemWritableFileStreamTarget(writable = await opts.fileHandle.createWritable())
    : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: codecs.video.mux, width, height, frameRate: fps },
    ...(channels ? { audio: { codec: codecs.audio.mux, numberOfChannels: 2, sampleRate: AUDIO_RATE } } : {}),
    // streaming: reserve room for the index up front so the file still starts with it ("fast start")
    fastStart: writable ? { expectedVideoChunks: frames + 4, expectedAudioChunks: Math.ceil((s1 - s0) / 960) + 64 } : 'in-memory',
  });

  let failure = null;
  const fail = (e) => { failure ??= e; };
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
  venc.configure(codecs.video.config);
  const aenc = channels ? new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail }) : null;
  aenc?.configure(codecs.audio.config);

  // audio is fed in step with the video so the muxer can interleave the two
  let sPos = s0;
  const feedAudio = (untilT) => {
    if (!aenc) return;
    const end = Math.min(s1, Math.round(untilT * AUDIO_RATE));
    while (sPos < end) {
      const n = Math.min(4800, end - sPos);
      const data = new Float32Array(n * 2);
      data.set(channels[0].subarray(sPos, sPos + n), 0);
      data.set(channels[1].subarray(sPos, sPos + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2,
        timestamp: Math.round((sPos - s0) * 1e6 / AUDIO_RATE), data });
      aenc.encode(ad);
      ad.close();
      sPos += n;
    }
  };

  const decayFor = (fadeScale) => {
    const fade = (opts.fade ?? 0.15) * (fadeScale ?? 1);
    return fade <= 0 ? 0 : Math.exp(-1 / fps / fade);
  };
  const drawAt = (t) => {
    const f = frameAt(t);
    renderer.render(f.flame, {
      itersPerThread: opts.iters * (f.itersScale ?? 1) * quality,
      decay: decayFor(f.fadeScale), paletteOffset: f.paletteOffset, hue: f.hue,
    });
  };

  const started = performance.now();
  try {
    renderer.setFixedSize(width, height);
    renderer.clear();
    for (let i = -pre; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('render cancelled', 'AbortError');
      if (failure) throw failure;
      const t = t0 + i / fps;
      drawAt(t);
      if (i < 0) {                       // pre-roll: build up trails, don't encode
        if (i % 8 === 0) await renderer.device.queue.onSubmittedWorkDone();
        continue;
      }
      const fr = await renderer.readFrame();
      const vf = new VideoFrame(fr.data, { format: 'RGBA', codedWidth: fr.width, codedHeight: fr.height,
        timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps), layout: [{ offset: 0, stride: fr.stride }] });
      fr.release();
      venc.encode(vf, { keyFrame: i % (2 * fps) === 0 });
      vf.close();
      feedAudio(t0 + (i + 1) / fps);
      while (venc.encodeQueueSize > 6) await new Promise((r) => venc.addEventListener('dequeue', r, { once: true }));
      const el = (performance.now() - started) / 1000;
      opts.onProgress?.({ frame: i + 1, frames, fps: (i + 1) / el, eta: el / (i + 1) * (frames - i - 1), codecs });
    }
    await venc.flush();
    feedAudio(t1);
    await aenc?.flush();
    if (failure) throw failure;
    muxer.finalize();
    if (writable) { await writable.close(); return { codecs, frames, blob: null }; }
    return { codecs, frames, blob: new Blob([target.buffer], { type: 'video/mp4' }) };
  } catch (e) {
    try { await writable?.abort(); } catch { /* ignore */ }
    throw e;
  } finally {
    if (venc.state !== 'closed') venc.close();
    if (aenc && aenc.state !== 'closed') aenc.close();
    renderer.setFixedSize(null);
    renderer.clear();
  }
}
