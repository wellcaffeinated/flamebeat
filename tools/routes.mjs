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
await row(n0).locator('button', { hasText: '×' }).click();
assert.equal(await page.locator('#routes .route').count(), n0);
console.log('add/remove ok');

// help: (?) next to the parameter pins its description under the row; header (?) shows the column legend
const help = row(0).locator('button.help').nth(1);
assert.match(await help.getAttribute('title'), /^zoom pulse: Zooms/);   // row 0 was retargeted above
await help.click();
assert.match(await page.locator('#routes .route-help').first().textContent(), /^zoom pulse/);
await help.click();
assert.equal(await page.locator('#routes .route-help').first().isVisible(), false);
await page.locator('#routes .routes-head button.help').click();
assert.equal(await page.locator('#routes .routes-legend').isVisible(), true); console.log('help ok');

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

// range fold: ▸ opens the detail line; the range sets what the route produces at amount 1
for (let i = 1; i < n0; i++) {
  if (await row(i).locator('select').nth(1).inputValue() === 'brightness') await row(i).locator('input[type=range]').fill('0');
}
const fold = row(0).locator('button.fold');
const details = page.locator('#routes .route-details').first();
assert.equal(await details.isVisible(), false);
await fold.click();
assert.equal(await details.isVisible(), true);
assert.equal(await details.locator('select.smooth').count(), 1);   // smoothing moved into the fold
const [lo, hi] = [details.locator('input[type=number]').nth(0), details.locator('input[type=number]').nth(1)];
await lo.fill('1.5'); await hi.fill('1.5');
assert.ok(Math.abs((await mods()).brightness - 1.5) < 1e-6);
assert.deepEqual(await page.evaluate(() => window.__routes.rows[0].out), [1.5, 1.5]);
assert.equal(await fold.evaluate((b) => b.classList.contains('custom')), true);
console.log('range 1.5..1.5: brightness 1.5, fold marked custom');
// the bar widened to show 1.5; drag the right end to the far right of it
const box = await details.locator('.range-bar').boundingBox();
const end = await details.locator('.range-bar .end').nth(1).boundingBox();
await page.mouse.move(end.x + end.width / 2 + 1, box.y + box.height / 2);
await page.mouse.down(); await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
const dragged = await page.evaluate(() => window.__routes.rows[0].out);
assert.ok(dragged[1] > 1.5 && Math.abs(dragged[0] - 1.5) < 1e-9); console.log('drag right end ->', JSON.stringify(dragged));
await details.locator('button', { hasText: 'default' }).click();
assert.equal(await page.evaluate(() => 'out' in window.__routes.rows[0]), false);
assert.equal(await fold.evaluate((b) => b.classList.contains('custom')), false);
console.log('range default ok');

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
