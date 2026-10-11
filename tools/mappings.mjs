// Headless check of mapping presets: save / load / export / delete in the route
// editor, and ?mapping=<url> (applies without overwriting the editor's routes).
// usage: node mappings.mjs [baseUrl]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os'; import path from 'node:path';
const base = process.argv[2] ?? 'http://localhost:8000/web/';
const exe = process.env.CHROME ?? path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const q = '?chains=4096&iters=4&clock=manual&t=64.4';
const ready = () => page.waitForFunction(() => window.__flamebeat?.timeline, null, { timeout: 30000 });
const routes = () => page.evaluate(() => window.__routes.rows);
const bar = page.locator('#routes .mapping-bar');
const amount0 = page.locator('#routes .route').nth(0).locator('input[type=range]');

await page.goto(base + q); await ready();
await page.evaluate(() => localStorage.clear());
await page.reload(); await ready();
await page.keyboard.press('m');

// save: routes + fade + fractal under a name
await amount0.fill('0.5');
await page.locator('#zoom').fill('0.5');   // slider position 0.5 -> 4^0.5 = 2x
await page.waitForFunction(() => window.__flamebeat.zoom === 2);
await bar.locator('input[type=text]').fill('test A');
await bar.locator('button', { hasText: 'save' }).click();
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('flamebeat.mappings.v1'))['test A']);
assert.equal(saved.format, 'flamebeat-mapping');
assert.equal(saved.routes[0].amount, 0.5);
assert.equal(saved.flame, (await page.evaluate(() => window.__flamebeat.preset)));
assert.equal(saved.fade, 0.15);
assert.equal(saved.zoom, 2);
console.log(`saved "test A": ${saved.routes.length} routes, flame "${saved.flame}", fade ${saved.fade}`);

// change, then load it back
await amount0.fill('2');
await page.locator('#zoom').dblclick();
assert.equal((await routes())[0].amount, 2);
await page.waitForFunction(() => window.__flamebeat.zoom === 1);
await bar.locator('select').selectOption('test A');
assert.equal((await routes())[0].amount, 0.5);
await page.waitForFunction(() => window.__flamebeat.zoom === 2); console.log('load restores the routes and zoom');

// export: a downloadable file in the same format
const [dl] = await Promise.all([page.waitForEvent('download'), bar.locator('button', { hasText: 'export' }).click()]);
const file = path.join(os.tmpdir(), dl.suggestedFilename());
await dl.saveAs(file);
const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(exported.name, 'test A'); assert.equal(exported.routes[0].amount, 0.5);
console.log('export:', dl.suggestedFilename());

// import the exported file under a new name
exported.name = 'test B';
fs.writeFileSync(file, JSON.stringify(exported));
await bar.locator('input[type=file]').setInputFiles(file);
await page.waitForFunction(() => window.__routes.mappingName === 'test B');
assert.deepEqual(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('flamebeat.mappings.v1'))).sort()), ['test A', 'test B']);
console.log('import adds "test B"');
fs.unlinkSync(file);

// delete
await bar.locator('select').selectOption('test A');
await bar.locator('button', { hasText: 'delete' }).click();
assert.deepEqual(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('flamebeat.mappings.v1')))), ['test B']);
console.log('delete ok');

// ?mapping=<url>: applies routes, fade and fractal, without touching the editor's saved routes
const before = await page.evaluate(() => localStorage.getItem('flamebeat.routes.v2'));
await page.goto(base + q + '&mapping=mappings/teal-defaults.json'); await ready();
await page.waitForFunction(() => window.__flamebeat.preset === 'julia bloom teal');
const file0 = JSON.parse(fs.readFileSync(new URL('../web/mappings/teal-defaults.json', import.meta.url)));
assert.deepEqual(await routes(), file0.routes);
assert.equal(await page.evaluate(() => localStorage.getItem('flamebeat.routes.v2')), before);
await page.waitForFunction(() => window.__flamebeat.zoom === 1);   // no zoom in the file: the fractal's own framing
console.log(`?mapping=: fractal "julia bloom teal", ${file0.routes.length} routes, editor routes untouched`);

console.log(errors.length ? errors : 'no page errors');
assert.equal(errors.length, 0);
await browser.close();
