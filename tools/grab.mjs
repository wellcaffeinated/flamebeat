// Headless capture of the WebGPU canvas via an offscreen tone-map + buffer readback (window.__grab)
// (page screenshots and canvas.toDataURL come out blank with SwiftShader here).
// usage: node grab.mjs <url> <out.png> [waitMs] [--size=WxH] [--eval=js]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => a.slice(2).split(/=(.*)/s)));
const [url, out, waitArg] = pos;
const [w, h] = (flags.size ?? '960x540').split('x').map(Number);
const exe = process.env.CHROME ?? path.join(os.homedir(),
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');

const browser = await chromium.launch({
  executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader',
    '--use-webgpu-adapter=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('console', (m) => { if (!m.text().includes('404')) console.log(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__flamebeat, null, { timeout: 30000 });
if (flags.eval) console.log('eval:', JSON.stringify(await page.evaluate(flags.eval)));
await page.waitForTimeout(Number(waitArg ?? 3000));
const res = await page.evaluate(async () => {
  const st = window.__flamebeat;
  if (st.error) return { st };
  const url = await window.__grab();    // offscreen tone-map + readback
  return { st, url, hud: document.getElementById('hud')?.textContent };
});
console.log('state:', JSON.stringify(res.st), '\nhud:', res.hud);
if (res.url) {
  fs.writeFileSync(out, Buffer.from(res.url.split(',')[1], 'base64'));
  console.log('wrote', out);
}
await browser.close();
