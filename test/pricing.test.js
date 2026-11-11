import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICING, computeQuote, mergePricing, planTasks } from '../public/js/pricing.js';

const yard = { lawnSqft: 8000, shrubCount: 15, bedSqft: 210, hardscapeSqft: 1000, buildingSqft: 2500 };

test('core plan: 8,000 sq ft lawn, 15 shrubs, 210 sq ft of beds', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, {});
  // lawn $66.80 + upkeep (15 x $0.75 + 210 x $0.02 = $15.45)
  assert.equal(q.core.perVisit, 82.25);
  assert.equal(q.core.visitsPerYear, 44);
  assert.equal(q.core.materials, 68); // ~0.65 cu yd of mulch
  assert.equal(q.monthly, 307);
  assert.ok(q.low < q.monthly && q.high > q.monthly);
  assert.equal(q.low % 5, 0);
  assert.equal(q.addons.length, 0);
});

test('tiny yards hit the lawn and upkeep minimums', () => {
  assert.equal(computeQuote(DEFAULT_PRICING, { lawnSqft: 500 }, {}).core.perVisit, 48 + 15);
});

test('bigger lawns and more plantings cost more', () => {
  const p = (m) => computeQuote(DEFAULT_PRICING, m, {}).core.perVisit;
  assert.ok(p({ lawnSqft: 5000 }) < p({ lawnSqft: 10000 }) && p({ lawnSqft: 10000 }) < p({ lawnSqft: 20000 }));
  assert.equal(p({ lawnSqft: 20000 }), 98 + 15);
  assert.ok(p({ lawnSqft: 8000, shrubCount: 40, bedSqft: 560 }) > p(yard));
});

test('add-ons are priced from measurements and annualised', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, { addons: { gutters: true, petWaste: true, pressureWash: true }, dogs: 2 });
  const by = Object.fromEntries(q.addons.map((a) => [a.key, a]));
  assert.equal(by.gutters.perVisit, 175); // $100 + 2,500 sq ft roof x $0.03
  assert.equal(by.petWaste.perVisit, 22); // $18 + one extra dog
  assert.equal(by.pressureWash.perVisit, 160); // 1,000 sq ft x $0.16
  assert.equal(q.discountPct, 8); // three add-ons
  const addons = 175 * 2 / 12 + 22 * 52 / 12 + 160 * 4 / 12;
  assert.equal(q.monthly, Math.round(q.core.monthly + addons * 0.92));
});

test('work that is now part of every visit is no longer sold separately', () => {
  for (const key of ['shrubs', 'bedWeeding', 'mulch', 'leafCleanup']) assert.equal(DEFAULT_PRICING.addons[key], undefined);
  const q = computeQuote(DEFAULT_PRICING, yard, { addons: { shrubs: true, mulch: true } });
  assert.equal(q.addons.length, 0);
});

test('disabled add-ons are never charged', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, { addons: { lawnTreatment: true } });
  assert.equal(q.addons.length, 0);
});

test('mergePricing keeps defaults for missing or junk values', () => {
  const p = mergePricing({ mowing: { base: 50, minPerVisit: 'lots' }, addons: { gutters: { base: 90, enabled: false }, bogus: { x: 1 } } });
  assert.equal(p.mowing.base, 50);
  assert.equal(p.mowing.minPerVisit, DEFAULT_PRICING.mowing.minPerVisit);
  assert.equal(p.addons.gutters.base, 90);
  assert.equal(p.addons.gutters.enabled, false);
  assert.equal(p.addons.bogus, undefined);
});

test('planTasks lists core tasks plus the selected add-ons', () => {
  const t = planTasks({ addons: { petWaste: true } });
  assert.ok(t.includes('Pull weeds in beds & hard surfaces') && t.includes('Scoop & remove pet waste'));
  assert.ok(!t.includes('Clear gutters'));
});
