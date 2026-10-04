// Headless screenshot of the flamebeat page (WebGPU via SwiftShader).
// usage: node shoot.mjs <url> <out.png> [waitMs] [--size=WxH] [--eval=js-after-load]
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const [url, out, waitArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--'))
  .map((a) => a.slice(2).split(/=(.*)/s)));
const [w, h] = (flags.size ?? '960x540').split('x').map(Number);
const exe = process.env.CHROME ?? path.join(os.homedir(),
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');

const browser = await chromium.launch({
  executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader',
    '--use-webgpu-adapter=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
if (flags.eval) await page.evaluate(flags.eval);
await page.waitForTimeout(Number(waitArg ?? 3000));
const st = await page.evaluate(() => window.__flamebeat ?? null);
console.log('state:', JSON.stringify(st));
await page.screenshot({ path: out });
console.log('wrote', out);
await browser.close();
