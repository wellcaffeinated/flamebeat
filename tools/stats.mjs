import { chromium } from 'playwright-core';
import os from 'node:os'; import path from 'node:path';
const exe = path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(process.argv[2]);
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => window.__renderer.histStats())));
await browser.close();
