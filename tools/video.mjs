// Headless check of the offline video render: a short portrait clip through the
// render panel (blob fallback instead of the save dialog), checked with ffprobe,
// plus a cancel. Needs ffprobe/ffmpeg on PATH (mise).
// usage: node video.mjs <out dir> [baseUrl]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path';
const outDir = process.argv[2] ?? 'video-out';
const base = process.argv[3] ?? 'http://localhost:8000/web/';
fs.mkdirSync(outDir, { recursive: true });
const exe = process.env.CHROME ?? path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader',
    '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) console.log('[console]', m.text()); });

await page.goto(base + '?chains=4096&iters=8&preset=3');
await page.waitForFunction(() => window.__flamebeat?.timeline, null, { timeout: 30000 });
await page.evaluate(() => { window.showSaveFilePicker = undefined; });   // no dialog headless: use the Blob path
await page.keyboard.press('v');
const panel = page.locator('#render');
assert.equal(await panel.isVisible(), true);

const T0 = 64, T1 = 65.5, FPS = 30;
await panel.locator('select').nth(0).selectOption('portrait');
await panel.locator('select').nth(1).selectOption(String(FPS));
await panel.locator('input[type=number]').nth(0).fill(String(T0));
await panel.locator('input[type=number]').nth(1).fill(String(T1));
const started = Date.now();
await panel.locator('button.go').click();
await page.waitForFunction(() => /^done|failed/.test(document.querySelector('#render .render-status')?.textContent ?? ''), null, { timeout: 600000 });
const status = await panel.locator('.render-status').textContent();
console.log(`status (${((Date.now() - started) / 1000).toFixed(0)} s): ${status}`);
assert.match(status, /^done: 45 frames/);

// fetch the Blob behind the download link and check it with ffprobe
const b64 = await page.evaluate(async () => {
  const a = document.querySelector('#render .render-status a');
  const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
});
const mp4 = path.join(outDir, 'render-test.mp4');
fs.writeFileSync(mp4, Buffer.from(b64, 'base64'));
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4]));
const v = probe.streams.find((s) => s.codec_type === 'video');
const a = probe.streams.find((s) => s.codec_type === 'audio');
console.log(`ffprobe: video ${v.codec_name} ${v.width}x${v.height} ${v.r_frame_rate} ${v.nb_frames} frames; `
  + `audio ${a ? `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch` : 'none'}; duration ${probe.format.duration} s; `
  + `${(fs.statSync(mp4).size / 1e6).toFixed(2)} MB`);
assert.equal(v.width, 1080); assert.equal(v.height, 1920); assert.equal(v.r_frame_rate, `${FPS}/1`);
assert.equal(Number(v.nb_frames), 45);
assert.ok(a, 'audio stream'); assert.ok(Math.abs(Number(probe.format.duration) - (T1 - T0)) < 0.1, 'duration');
// a frame from the middle, for looking at; and it must not be black
const png = path.join(outDir, 'render-test-frame.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '0.75', '-i', mp4, '-frames:v', '1', png]);
const mean = Number(execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])[0]);
console.log(`frame ${png}: mean grey ${mean}`); assert.ok(mean > 3, 'frame is not black');

// cancel: starts, then aborts cleanly and the live view comes back
await panel.locator('input[type=number]').nth(1).fill('90');
await panel.locator('button.go').click();
await page.waitForFunction(() => /^frame/.test(document.querySelector('#render .render-status')?.textContent ?? ''), null, { timeout: 120000 });
await panel.locator('button', { hasText: 'cancel' }).click();
await page.waitForFunction(() => /cancelled/.test(document.querySelector('#render .render-status')?.textContent ?? ''), null, { timeout: 60000 });
const f0 = await page.evaluate(() => window.__flamebeat.frames);
await page.waitForTimeout(1500);
assert.ok(await page.evaluate(() => window.__flamebeat.frames) > f0, 'live rendering resumed');
console.log('cancel ok, live view resumed');

console.log(errors.length ? errors : 'no page errors');
assert.equal(errors.length, 0);
await browser.close();
