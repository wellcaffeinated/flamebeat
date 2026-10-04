// Headless check of keyboard controls + debug overlay screenshot.
// usage: node keys.mjs <out.png> [baseUrl]
import { chromium } from 'playwright-core';
import os from 'node:os'; import path from 'node:path';
const out = process.argv[2] ?? 'keys.png';
const base = process.argv[3] ?? 'http://localhost:8000/web/';
const exe = process.env.CHROME ?? path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '?chains=4096&iters=4&t=64.4');
await page.waitForFunction(() => window.__flamebeat?.timeline, null, { timeout: 30000 });
const st = () => page.evaluate(() => ({ ...window.__flamebeat, mods: undefined, iters: document.getElementById('hud').textContent }));
await page.waitForTimeout(600);
console.log('start  :', (await st()).preset);
for (const k of ['p', 'p', 'p']) { await page.keyboard.press(k); await page.waitForTimeout(400); console.log(`press ${k}:`, (await st()).preset); }
await page.keyboard.press(']'); await page.waitForTimeout(800);
console.log('after ]:', (await st()).iters);
await page.keyboard.press('d');
await page.waitForTimeout(600);
console.log('debug visible:', await page.evaluate(() => !document.getElementById('debug').hidden));
await page.screenshot({ path: out, clip: { x: 600, y: 0, width: 360, height: 540 } });
await page.keyboard.press('h'); await page.waitForTimeout(200);
console.log('bar hidden after H:', await page.evaluate(() => document.getElementById('bar').classList.contains('hidden')));
console.log(errors.length ? errors : 'no page errors');
await browser.close();
