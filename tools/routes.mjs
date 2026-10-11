// Headless check of the route editor (M): change source/target/amount, add/remove, persistence.
// usage: node routes.mjs <out.png> [baseUrl]
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import os from 'node:os'; import path from 'node:path';
const out = process.argv[2] ?? 'routes.png';
const base = process.argv[3] ?? 'http://localhost:8000/web/';
const exe = process.env.CHROME ?? path.join(os.homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const browser = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '?chains=4096&iters=4&clock=manual&t=64.4');
await page.waitForFunction(() => window.__flamebeat?.timeline, null, { timeout: 30000 });
await page.evaluate(() => localStorage.clear());
const mods = async () => { await page.waitForTimeout(150); return page.evaluate(() => window.__flamebeat.mods); };
const row = (i) => page.locator('#routes .route').nth(i);

await page.keyboard.press('m');
assert.equal(await page.locator('#routes').isVisible(), true);
const n0 = await page.locator('#routes .route').count();
console.log('rows:', n0);
// other routes share the brightness target; silence them so row 0 can be checked alone
for (let i = 1; i < n0; i++) {
  if (await row(i).locator('select').nth(1).inputValue() === 'brightness') await row(i).locator('input[type=range]').fill('0');
}
const b1 = (await mods()).brightness;

// amount 0 on volume->brightness => neutral brightness 1
await row(0).locator('input[type=range]').fill('0');
assert.equal((await mods()).brightness, 1); console.log(`amount 0: brightness ${b1.toFixed(3)} -> 1`);
// amount 2 doubles the deviation
await row(0).locator('input[type=range]').fill('2');
const b2 = (await mods()).brightness;
assert.ok(Math.abs((b2 - 1) - 2 * (b1 - 1)) < 1e-6); console.log(`amount 2: brightness ${b2.toFixed(3)}`);

// response curve: it acts before the envelope, which only moves when time
// does, so compare after time jumps (a jump resets the envelopes)
const at = async (t) => { await page.evaluate((x) => window.__setTime(x), t); return (await mods()).brightness; };
const curve = row(0).locator('select.curve');
const bd = await at(70);
await curve.selectOption('quad');
await at(64.4);
const bq = await at(70);
assert.ok(Math.abs(bq - bd) > 1e-4); console.log(`curve quad @70 s: brightness ${bd.toFixed(3)} -> ${bq.toFixed(3)}`);
await curve.selectOption('');
assert.equal(await page.evaluate(() => 'curve' in window.__routes.rows[0]), false);
assert.ok(Math.abs(await at(64.4) - b2) < 1e-6); console.log('curve back to default ok');

// retarget: volume -> zoom pulse, brightness goes neutral
await row(0).locator('select').nth(1).selectOption('zoomPulse');
let m = await mods();
assert.equal(m.brightness, 1); console.log(`retarget: brightness ${m.brightness}, zoomPulse ${m.zoomPulse.toFixed(3)}`);
// change source
await row(0).locator('select').nth(0).selectOption('high');
m = await mods(); console.log(`source high: zoomPulse ${m.zoomPulse.toFixed(3)}`);

await page.locator('#routes button', { hasText: 'add route' }).click();
assert.equal(await page.locator('#routes .route').count(), n0 + 1);
await row(n0).locator('button').click();
assert.equal(await page.locator('#routes .route').count(), n0);
console.log('add/remove ok');

// persisted across reload
await page.reload();
await page.waitForFunction(() => window.__flamebeat?.timeline, null, { timeout: 30000 });
const saved = await page.evaluate(() => window.__routes.rows[0]);
assert.deepEqual(saved, { src: 'high', target: 'zoomPulse', amount: 2 }); console.log('persisted:', JSON.stringify(saved));
await page.keyboard.press('m');
await page.waitForTimeout(300);
await page.screenshot({ path: out });
await page.locator('#routes button', { hasText: 'reset' }).click();
assert.equal(await page.evaluate(() => window.__routes.rows[0].src), 'volume'); console.log('reset ok');

// routes saved against older defaults: the panel and the routes button say so
await page.evaluate(() => localStorage.setItem('flamebeat.routes.v2.defaults', '[]'));
await page.reload();
await page.waitForFunction(() => window.__flamebeat?.timeline, null, { timeout: 30000 });
assert.equal(await page.locator('#routes-btn.stale').count(), 1);
await page.keyboard.press('m');
await page.locator('#routes button', { hasText: 'use new defaults' }).click();
assert.equal(await page.locator('#routes .routes-stale').count(), 0);
assert.equal(await page.locator('#routes-btn.stale').count(), 0); console.log('stale defaults banner ok');
console.log(errors.length ? errors : 'no page errors');
assert.equal(errors.length, 0);
await browser.close();
