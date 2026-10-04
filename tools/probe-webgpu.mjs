// Probe: can headless Chromium give us a WebGPU adapter in this environment?
import { chromium } from 'playwright-core';
import os from 'node:os';
import path from 'node:path';

const exe = process.env.CHROME ?? path.join(os.homedir(),
  '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const variants = {
  vulkan_swiftshader: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'],
  swiftshader_only: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  vulkan_angle_vulkan: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=vulkan', '--disable-vulkan-surface'],
};
for (const [name, args] of Object.entries(variants)) {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args });
  const page = await browser.newPage();
  await page.goto(process.env.URL ?? 'http://localhost:8765/web/');
  const r = await page.evaluate(async () => {
    if (!navigator.gpu) return 'no navigator.gpu';
    try {
      const ad = await navigator.gpu.requestAdapter();
      if (!ad) return 'requestAdapter() -> null';
      const info = ad.info ?? {};
      const dev = await ad.requestDevice();
      return `adapter ok: ${info.vendor}/${info.architecture}/${info.device}/${info.description}; device ${!!dev}; maxStorageBufferBindingSize=${ad.limits.maxStorageBufferBindingSize}`;
    } catch (e) { return 'error: ' + e; }
  });
  console.log(name.padEnd(22), r);
  await browser.close();
}
