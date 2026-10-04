// Headless end-to-end check (WebGPU via SwiftShader):
//  1. manual clock: snapshots of the flame at several track timestamps
//  2. real <audio> playback: render clock vs audio.currentTime, pause, seek, playbackRate
// usage: node verify.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outDir = process.argv[2] ?? 'out';
const base = process.argv[3] ?? 'http://localhost:8000/web/';
fs.mkdirSync(outDir, { recursive: true });
const exe = process.env.CHROME ?? path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const browser = await chromium.launch({
  executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader',
    '--use-webgpu-adapter=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const log = (...a) => console.log(...a);
const errors = [];
async function open(query) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + query);
  await page.waitForFunction(() => window.__flamebeat && (window.__flamebeat.error || window.__flamebeat.timeline), null, { timeout: 30000 });
  const st = await page.evaluate(() => window.__flamebeat);
  if (st.error) throw new Error(st.error);
  return page;
}
const grab = async (page, file) => {
  const url = await page.evaluate(() => window.__grab());
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
};

// 1. snapshots at timestamps (manual clock => deterministic media time)
const stamps = (process.env.STAMPS ?? '3,64.45,66.55,110,150').split(',').map(Number);
for (const preset of (process.env.PRESETS ?? '0').split(',')) {
  const page = await open(`?clock=manual&preset=${preset}&chains=16384&iters=8`);
  for (const t of stamps) {
    await page.evaluate((tt) => window.__setTime(tt), t);
    await page.waitForTimeout(2500);         // ~25 frames at SwiftShader speed: histogram reaches steady state
    const st = await page.evaluate(() => window.__flamebeat);
    const f = path.join(outDir, `p${preset}_t${t}.png`);
    await grab(page, f);
    const m = st.mods;
    log(`snapshot preset ${preset} t=${t}: bright ${m.brightness?.toFixed(2)} zoomPulse ${m.zoomPulse?.toFixed(3)} `
      + `kickW ${m.weightBump?.toFixed(2)} snarePal ${m.paletteKick?.toFixed(3)} hatJulia ${m.juliaJitter?.toFixed(2)} -> ${f}`);
  }
  await page.close();
}

// 2. real playback sync
if (!process.env.NO_PLAYBACK) {
  const page = await open('?chains=4096&iters=4');
  const sample = () => page.evaluate(() => {
    const a = document.getElementById('audio');
    const f = window.__flamebeat;
    return { ct: a.currentTime, t: f.t, frameCt: f.audioT, paused: a.paused, rate: a.playbackRate };
  });
  const drift = async (label, ms = 2000) => {
    const ds = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = await sample(); ds.push(s.t - s.frameCt); await page.waitForTimeout(100); }
    const s = await sample();
    log(`${label}: audio.currentTime=${s.ct.toFixed(3)} paused=${s.paused} rate=${s.rate} `
      + `render clock minus audio.currentTime (same frame): max |${Math.max(...ds.map(Math.abs)).toFixed(3)}| s over ${ds.length} samples`);
    return s;
  };
  await page.evaluate(() => document.getElementById('audio').play());
  const a = await drift('playing');
  if (a.paused || a.ct < 0.5) log('WARNING: audio did not advance in headless playback');
  await page.keyboard.press('Space');                   // pause via keyboard handler
  await page.waitForTimeout(400);                       // let a frame render after the pause
  const p1 = await sample(); await page.waitForTimeout(800); const p2 = await sample();
  log(`paused: t ${p1.t.toFixed(3)} -> ${p2.t.toFixed(3)} (should be equal), paused=${p2.paused}`);
  await page.evaluate(() => { document.getElementById('audio').currentTime = 64; });
  await page.waitForTimeout(500);
  const s1 = await sample();
  log(`seek to 64 while paused: render t=${s1.t.toFixed(3)} audio=${s1.ct.toFixed(3)}`);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  log(`ArrowRight: audio=${(await sample()).ct.toFixed(3)} (expected 69)`);
  await page.evaluate(() => { const a = document.getElementById('audio'); a.playbackRate = 1.5; return a.play(); });
  await page.waitForTimeout(300);
  const r0 = await sample(); const w0 = Date.now();
  await drift('playing at 1.5x');
  const r1 = await sample();
  log(`1.5x: media advanced ${(r1.ct - r0.ct).toFixed(2)} s in ${((Date.now() - w0) / 1000).toFixed(2)} s wall`);
  await page.close();
}
log(errors.length ? `page errors:\n  ${errors.join('\n  ')}` : 'no page errors');
await browser.close();
