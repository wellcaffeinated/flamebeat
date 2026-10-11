// Headless check of the look tab (palette editor): edit / add / move / remove
// stops, custom palette kept across fractal changes (P) and reloads, saved in
// mappings, and dropped by "use fractal's own" or a mapping without one.
// usage: node look.mjs <out.png> [baseUrl]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path';
const out = process.argv[2] ?? 'look.png';
const base = process.argv[3] ?? 'http://localhost:8000/web/';
const exe = process.env.CHROME ?? path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const q = '?chains=4096&iters=4&clock=manual&t=64.4';
const ready = () => page.waitForFunction(() => window.__flamebeat?.timeline, null, { timeout: 30000 });
const palette = async () => { await page.waitForTimeout(120); return page.evaluate(() => window.__flamebeat.palette); };
const markers = page.locator('#routes .palette-marker');
const lookTab = () => page.locator('#routes .tabs button', { hasText: 'look' }).click();
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

await page.goto(base + q); await ready();
await page.evaluate(() => localStorage.clear());
await page.reload(); await ready();
await page.keyboard.press('m');
await lookTab();
const own = await palette();
assert.equal(await markers.count(), own.length);
assert.match(await page.locator('#routes .look-head').textContent(), /’s own/);
console.log(`look tab: ${own.length} stops (fractal's own)`);

// recolour stop 1: live in the renderer, and the palette becomes custom
// (the picker input is hidden behind the marker, so set it the way the picker would)
await markers.nth(0).locator('input').evaluate((i) => {
  i.value = '#ff0000';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new Event('change', { bubbles: true }));
});
let p = await palette();
assert.ok(near(p[0][1], [1, 0, 0]));
assert.match(await page.evaluate(() => window.__renderer.paletteKey), /^\[\[0,\[1,0,0\]/);
assert.match(await page.locator('#routes .look-head').textContent(), /custom/);
console.log('recolour: stop 1 red, renderer palette updated');

// double-click the strip: a new stop at that spot
const strip = await page.locator('#routes .palette-strip').boundingBox();
await page.mouse.dblclick(strip.x + strip.width * 0.93, strip.y + strip.height / 2);
assert.equal(await markers.count(), own.length + 1);
p = await palette();
assert.ok(p.some(([pos]) => Math.abs(pos - 0.93) < 0.01)); console.log('add stop at 0.93');

// drag stop 2 to the right
const before = p[1][0];
const m1 = await markers.nth(1).boundingBox();
await page.mouse.move(m1.x + m1.width / 2, m1.y + m1.height / 2);
await page.mouse.down(); await page.mouse.move(m1.x + m1.width / 2 + 30, m1.y + m1.height / 2, { steps: 5 }); await page.mouse.up();
p = await palette();
assert.ok(p.some(([pos]) => Math.abs(pos - (before + 30 / strip.width)) < 0.01)); console.log(`drag stop 2: ${before.toFixed(3)} -> +${(30 / strip.width).toFixed(3)}`);

// select the added stop (plain click) and remove it
const n = await markers.count();
const ai = p.findIndex(([pos]) => Math.abs(pos - 0.93) < 0.01);
await markers.nth(ai).click();
assert.equal(await markers.nth(ai).evaluate((m) => m.classList.contains('selected')), true);
await page.keyboard.press('Escape');
await page.locator('#routes button', { hasText: 'remove stop' }).click();
assert.equal(await markers.count(), n - 1); console.log('select + remove stop');

// reverse: the red stop moves from 0 to 1
await page.locator('#routes button', { hasText: 'reverse' }).click();
p = await palette();
assert.ok(near(p[p.length - 1][1], [1, 0, 0]) && p[p.length - 1][0] === 1); console.log('reverse ok');

// switching fractal keeps the custom palette
const custom = p;
const name0 = await page.evaluate(() => window.__flamebeat.preset);
await page.locator('#hud').click({ force: true });
await page.keyboard.press('p');
await page.waitForFunction((n0) => window.__flamebeat.preset !== n0, name0);
assert.deepEqual(await palette(), custom);
assert.match(await page.locator('#routes .look-head').textContent(), /custom/); console.log('P keeps the custom palette');

// saved in a mapping
const bar = page.locator('#routes .mapping-bar');
await bar.locator('input[type=text]').fill('pal');
await bar.locator('button', { hasText: 'save' }).click();
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('flamebeat.mappings.v1')).pal);
assert.equal(saved.palette.at(-1)[1], '#ff0000'); console.log('mapping saves the palette:', JSON.stringify(saved.palette));

await page.screenshot({ path: out });

// use fractal's own: back to the preset palette, nothing stored
await page.locator('#routes button', { hasText: 'use fractal’s own' }).click();
const ownNow = await palette();
assert.ok(!near(ownNow.at(-1)[1], [1, 0, 0]));
assert.equal(await page.evaluate(() => localStorage.getItem('flamebeat.palette')), null); console.log("use fractal's own ok");

// loading the mapping brings it back, and it survives a reload
await bar.locator('select').selectOption('pal');
assert.ok(near((await palette()).at(-1)[1], [1, 0, 0]));
await page.reload(); await ready();
assert.ok(near((await palette()).at(-1)[1], [1, 0, 0])); console.log('load mapping + reload keep the palette');

// a mapping without a palette (?mapping=) shows the fractal's own, without touching the stored one
await page.goto(base + q + '&mapping=mappings/teal-defaults.json'); await ready();
await page.waitForFunction(() => window.__flamebeat.preset === 'julia bloom teal');
assert.ok(!near((await palette()).at(-1)[1], [1, 0, 0]));
assert.notEqual(await page.evaluate(() => localStorage.getItem('flamebeat.palette')), null);
console.log('?mapping= without palette: fractal’s own, stored palette untouched');

console.log(errors.length ? errors : 'no page errors');
assert.equal(errors.length, 0);
await browser.close();
