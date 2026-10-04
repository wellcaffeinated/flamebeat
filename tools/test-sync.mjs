// Node checks for web/src/timeline.js + mapping.js against a real timeline.
// usage: node test-sync.mjs ../web/timelines/Funkorama.json
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Timeline } from '../web/src/timeline.js';
import { Mapper, applyMods, MAP_DEFAULTS } from '../web/src/mapping.js';
import { presets } from '../web/src/presets.js';

globalThis.structuredClone ??= (x) => JSON.parse(JSON.stringify(x));
const json = JSON.parse(fs.readFileSync(process.argv[2] ?? '../web/timelines/Funkorama.json', 'utf8'));
const tl = new Timeline(json);
let n = 0;
const ok = (name) => { n++; console.log('ok', n, name); };

// continuous sampling: exact frames and interpolation
const vol = json.continuous.volume;
assert.equal(tl.sample('volume', 10), Math.fround(vol[1000])); ok('sample on frame');
const mid = tl.sample('volume', 10.005);
assert.ok(Math.abs(mid - (vol[1000] + vol[1001]) / 2) < 1e-6); ok('linear interpolation');
assert.equal(tl.sample('volume', -1), Math.fround(vol[0])); ok('clamp before start');
assert.equal(tl.sample('volume', 1e6), Math.fround(vol.at(-1))); ok('clamp after end');
assert.ok(tl.has('energy.intensity') && tl.has('drums.kick') && tl.has('pitch.bass.f0')); ok('nested stream names');

// events
const kicks = json.events.drums.filter((d) => d.type === 'kick');
const k = kicks[100];
assert.deepEqual(tl.eventsIn('kick', k.t - 1e-6, k.t).map((e) => e.t), [k.t]); ok('eventsIn includes t1');
assert.equal(tl.eventsIn('kick', k.t, k.t + 1e-6).length, 0); ok('eventsIn excludes t0');

// impulse with lookahead: fires `lookahead` early, peaks at strength
const la = 0.03;
assert.equal(tl.impulse('kick', k.t - la - 0.01, { attack: 0, release: 0.1, lookahead: la }) >= 0, true);
const atHit = tl.impulse('kick', k.t - la, { attack: 0, release: 0.1, lookahead: la });
assert.ok(Math.abs(atHit - k.strength) < 1e-9 || atHit >= k.strength); ok('impulse peaks lookahead early');
const later = tl.impulse('kick', k.t - la + 0.1, { attack: 0, release: 0.1, lookahead: la });
assert.ok(later < atHit); ok('impulse decays');

// mapper: deterministic after seek, frozen while paused, stateless sampling
const m1 = new Mapper(tl), m2 = new Mapper(tl);
for (let t = 0; t < 60; t += 1 / 60) m1.update(t);
m1.update(120);                      // seek forward
const a = m1.update(120);
m2.update(120);
const b = m2.update(120);
for (const key of Object.keys(a)) if (key !== 'spinPhase') assert.ok(Math.abs(a[key] - b[key]) < 1e-9, key);
ok('seek resets envelopes (same state as fresh start)');
const p1 = m1.update(120).spinPhase, p2 = m1.update(120).spinPhase;
assert.equal(p1, p2); ok('paused (t constant) -> spin frozen');

// mapping keeps affines contractive and changes params over time
let maxGain = 0;
const m3 = new Mapper(tl);
for (let t = 30; t < 90; t += 1 / 30) {
  const { flame } = applyMods(presets[0], m3.update(t), MAP_DEFAULTS);
  for (const x of flame.xforms) {
    const [aa, bb, , dd, ee] = x.affine;
    const s1 = aa * aa + bb * bb + dd * dd + ee * ee, det = aa * ee - bb * dd;
    maxGain = Math.max(maxGain, Math.sqrt((s1 + Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))) / 2));
  }
}
assert.ok(maxGain <= 0.98 + 1e-9, `gain ${maxGain}`); ok(`affines stay contractive (max gain ${maxGain.toFixed(3)})`);

// summary of modulation ranges over the groove section
const m4 = new Mapper(tl);
const ranges = {};
for (let t = 30; t < 90; t += 1 / 60) {
  for (const [key, v] of Object.entries(m4.update(t))) {
    ranges[key] ??= [Infinity, -Infinity];
    ranges[key][0] = Math.min(ranges[key][0], v); ranges[key][1] = Math.max(ranges[key][1], v);
  }
}
for (const [key, [lo, hi]] of Object.entries(ranges)) console.log(`   ${key.padEnd(12)} ${lo.toFixed(3)} .. ${hi.toFixed(3)}`);
console.log(`all ${n} checks passed`);
