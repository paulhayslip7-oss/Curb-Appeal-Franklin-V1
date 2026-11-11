import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICING, computeQuote, mergePricing, planTasks } from '../public/js/pricing.js';

const yard = { lawnSqft: 8000, shrubCount: 15, bedSqft: 210, hardscapeSqft: 1000, buildingSqft: 2500 };

test('core plan: 8,000 sq ft lawn lands in a sane monthly range', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, {});
  assert.equal(q.core.perVisit, 66.8);
  assert.equal(q.core.visitsPerYear, 34);
  assert.equal(q.monthly, 189);
  assert.ok(q.low < q.monthly && q.high > q.monthly);
  assert.equal(q.low % 5, 0);
  assert.equal(q.addons.length, 0);
});

test('tiny lawns hit the minimum per-visit price', () => {
  assert.equal(computeQuote(DEFAULT_PRICING, { lawnSqft: 500 }, {}).core.perVisit, 48);
});

test('bigger lawns cost more, at a lower rate past 10k sq ft', () => {
  const p = (sq) => computeQuote(DEFAULT_PRICING, { lawnSqft: sq }, {}).core.perVisit;
  assert.ok(p(5000) < p(10000) && p(10000) < p(20000));
  assert.ok(p(20000) - p(10000) < p(10000) - p(0) + 10);
  assert.equal(p(20000), 98);
});

test('add-ons are priced from measurements and annualised', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, { addons: { shrubs: true, petWaste: true, pressureWash: true }, dogs: 2 });
  const by = Object.fromEntries(q.addons.map((a) => [a.key, a]));
  assert.equal(by.shrubs.perVisit, 105); // 15 shrubs x $7
  assert.equal(by.petWaste.perVisit, 22); // $18 + one extra dog
  assert.equal(by.pressureWash.perVisit, 160); // 1,000 sq ft x $0.16
  assert.equal(q.discountPct, 5); // three add-ons
  const addons = 105 * 3 / 12 + 22 * 52 / 12 + 160 * 4 / 12;
  assert.equal(q.monthly, Math.round(66.8 * 34 / 12 + addons * 0.95));
});

test('disabled add-ons are never charged', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, { addons: { lawnTreatment: true } });
  assert.equal(q.addons.length, 0);
});

test('mergePricing keeps defaults for missing or junk values', () => {
  const p = mergePricing({ mowing: { base: 50, minPerVisit: 'lots' }, addons: { shrubs: { perShrub: 9, enabled: false }, bogus: { x: 1 } } });
  assert.equal(p.mowing.base, 50);
  assert.equal(p.mowing.minPerVisit, DEFAULT_PRICING.mowing.minPerVisit);
  assert.equal(p.addons.shrubs.perShrub, 9);
  assert.equal(p.addons.shrubs.enabled, false);
  assert.equal(p.addons.bogus, undefined);
});

test('planTasks lists core tasks plus the selected add-ons', () => {
  const t = planTasks({ addons: { petWaste: true } });
  assert.ok(t.includes('Mow lawn') && t.includes('Scoop & remove pet waste'));
  assert.ok(!t.includes('Clear gutters'));
});
