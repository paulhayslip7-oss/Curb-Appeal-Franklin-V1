import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICING, computeQuote, jobEconomics, mergePricing, planTasks } from '../public/js/pricing.js';

const yard = { lawnSqft: 8000, shrubCount: 15, bedSqft: 210, hardscapeSqft: 1000, buildingSqft: 2500 };

test('core plan: 8,000 sq ft lawn, 15 shrubs, 210 sq ft of beds', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, {});
  // lawn $74 + upkeep (15 x $0.90 + 210 x $0.03 = $19.80, so the $20 minimum)
  assert.equal(q.core.perVisit, 94);
  assert.equal(q.core.visitsPerYear, 44);
  assert.equal(q.core.materials, 68); // ~0.65 cu yd of mulch
  assert.equal(q.monthly, 350);
  assert.ok(q.low < q.monthly && q.high > q.monthly);
  assert.equal(q.low % 5, 0);
  assert.equal(q.addons.length, 0);
});

test('tiny yards hit the lawn and upkeep minimums', () => {
  assert.equal(computeQuote(DEFAULT_PRICING, { lawnSqft: 500 }, {}).core.perVisit, 55 + 20);
});

test('bigger lawns and more plantings cost more', () => {
  const p = (m) => computeQuote(DEFAULT_PRICING, m, {}).core.perVisit;
  assert.ok(p({ lawnSqft: 5000 }) < p({ lawnSqft: 10000 }) && p({ lawnSqft: 10000 }) < p({ lawnSqft: 20000 }));
  assert.equal(p({ lawnSqft: 20000 }), 116 + 20);
  assert.ok(p({ lawnSqft: 8000, shrubCount: 40, bedSqft: 560 }) > p(yard));
});

test('add-ons are priced from measurements and annualised', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, { addons: { aeration: true, petWaste: true, pressureWash: true }, dogs: 2 });
  const by = Object.fromEntries(q.addons.map((a) => [a.key, a]));
  assert.equal(by.aeration.perVisit, 190); // $70 + 8 x $15
  assert.equal(by.petWaste.perVisit, 25); // $20 + one extra dog
  assert.equal(by.pressureWash.perVisit, 200); // 1,000 sq ft x $0.20
  assert.equal(q.discountPct, 8); // three add-ons
  const addons = 190 / 12 + 25 * 52 / 12 + 200 * 4 / 12;
  assert.equal(q.monthly, Math.round(q.core.monthly + addons * 0.92));
});

test('premium extras: flowers and porch detailing; gutters and windows are not offered', () => {
  const q = computeQuote(DEFAULT_PRICING, yard, { addons: { seasonalColor: true, windows: true, gutters: true, patioDetail: true } });
  const by = Object.fromEntries(q.addons.map((x) => [x.key, x]));
  assert.equal(by.seasonalColor.perVisit, 225); // minimum; $150 + 210 sq ft x $0.25 = $202.50
  assert.equal(q.addons.length, 2);
  assert.equal(DEFAULT_PRICING.addons.windows, undefined);
  assert.equal(DEFAULT_PRICING.addons.gutters, undefined);
  assert.equal(by.patioDetail.perVisit, 45);
  assert.equal(DEFAULT_PRICING.addons.binCleaning, undefined);
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
  const p = mergePricing({ mowing: { base: 50, minPerVisit: 'lots' }, addons: { aeration: { base: 90, enabled: false }, bogus: { x: 1 } } });
  assert.equal(p.mowing.base, 50);
  assert.equal(p.mowing.minPerVisit, DEFAULT_PRICING.mowing.minPerVisit);
  assert.equal(p.addons.aeration.base, 90);
  assert.equal(p.addons.aeration.enabled, false);
  assert.equal(p.addons.bogus, undefined);
});

test('default prices clear the crew-hour target on typical Franklin yards', () => {
  const yards = [
    yard,
    { lawnSqft: 9500, shrubCount: 27, bedSqft: 760, hardscapeSqft: 220, buildingSqft: 1600 },
    { lawnSqft: 16000, shrubCount: 35, bedSqft: 700, hardscapeSqft: 1800, buildingSqft: 3200 },
  ];
  for (const m of yards) {
    for (const sel of [{}, { addons: { petWaste: true, pressureWash: true, aeration: true, seasonalColor: true, patioDetail: true } }]) {
      const e = jobEconomics(DEFAULT_PRICING, m, sel, computeQuote(DEFAULT_PRICING, m, sel).monthly);
      assert.ok(e.onTarget, 'only $' + e.revenuePerHour + ' per crew hour on ' + m.lawnSqft + ' sq ft');
      assert.ok(e.grossMarginPct >= 55 && e.grossMarginPct <= 75);
    }
  }
  // Under-pricing a job is flagged.
  assert.equal(jobEconomics(DEFAULT_PRICING, yard, {}, 200).onTarget, false);
});

test('planTasks lists core tasks plus the selected add-ons', () => {
  const t = planTasks({ addons: { petWaste: true } });
  assert.ok(t.includes('Pull weeds in beds & hard surfaces') && t.includes('Scoop & remove pet waste'));
  assert.ok(!t.includes('Core-aerate lawn'));
  assert.ok(t.includes('Wipe down front porch entryway') && t.includes('Blow off all hard surfaces'));
});
