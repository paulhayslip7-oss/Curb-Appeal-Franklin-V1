import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeYard, groundResolution, lonLatToWorldPx, polygonAreaSqft, CLASS } from '../public/js/analyze.js';
import { guessLot } from '../src/geo.js';

// Paint a synthetic 200x200 "aerial": 1 px = 1 sq ft.
function scene(lawnRgb) {
  const w = 200, h = 200, data = new Uint8ClampedArray(w * h * 4);
  const rect = (x0, y0, x1, y1, [r, g, b]) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([r, g, b, 255], (y * w + x) * 4); };
  rect(0, 0, w, h, lawnRgb);              // yard
  rect(70, 60, 130, 110, [92, 96, 104]);  // house roof 60x50 = 3,000
  rect(90, 110, 110, 190, [200, 198, 190]); // concrete drive 20x80 = 1,600
  for (const [x, y] of [[30, 40], [30, 60], [160, 40], [160, 150]]) rect(x, y, x + 4, y + 4, [40, 52, 44]); // 4 shrubs
  return { data, width: w, height: h };
}
const lot = [[10, 10], [190, 10], [190, 190], [10, 190]];
const house = [[70, 60], [130, 60], [130, 110], [70, 110]];
const near = (actual, expected, tol) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} not within ${tol} of ${expected}`);

for (const [season, rgb] of [['dormant', [128, 120, 100]], ['summer', [96, 140, 70]]]) {
  test(`${season} imagery with a known house footprint`, () => {
    const { measurements: m, classMap } = analyzeYard(scene(rgb), { polygon: lot, buildings: [house], sqftPerPx: 1 });
    assert.equal(m.season, season);
    near(m.lotSqft, 32400, 400);
    near(m.buildingSqft, 3000, 100);
    near(m.hardscapeSqft, 1600, 150);
    near(m.lawnSqft, 32400 - 3000 - 1600 - 64, 500);
    assert.equal(m.shrubCount, 4);
    assert.equal(classMap[85 * 200 + 100], CLASS.BUILDING);
    assert.equal(classMap[150 * 200 + 100], CLASS.HARDSCAPE);
    assert.equal(classMap[150 * 200 + 40], CLASS.LAWN);
    assert.equal(classMap[5 * 200 + 5], CLASS.OUT);
  });
}

test('without a footprint the house is found from the address point', () => {
  const { measurements: m } = analyzeYard(scene([128, 120, 100]), { polygon: lot, seed: [100, 85], sqftPerPx: 1 });
  assert.equal(m.buildingFound, true);
  near(m.buildingSqft, 3000, 200);
});

test('with no footprint and no seed a typical house is assumed', () => {
  const { measurements: m } = analyzeYard(scene([128, 120, 100]), { polygon: lot, sqftPerPx: 1 });
  assert.equal(m.buildingFound, false);
  assert.equal(m.buildingSqft, 2600);
});

test('map maths', () => {
  near(groundResolution(35.92, 19), 0.2418, 0.001);
  const [x, y] = lonLatToWorldPx(0, 0, 0);
  assert.deepEqual([x, y], [128, 128]);
  // ~100 m x 100 m square at Franklin's latitude ≈ 107,639 sq ft
  const dLat = 100 / 110540, dLon = 100 / (111320 * Math.cos(35.92 * Math.PI / 180));
  near(polygonAreaSqft([[0, 35.92], [dLon, 35.92], [dLon, 35.92 + dLat], [0, 35.92 + dLat]]), 107639, 300);
});

test('lot guess squares up to the house and stops halfway to neighbours', () => {
  const lat = 35.92, lon = -86.87;
  const mx = 111320 * Math.cos(lat * Math.PI / 180), my = 110540;
  const rect = (cx, cy, w, d) => [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2], [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]].map(([x, y]) => [lon + x / mx, lat + y / my]);
  // House 16x12 m at origin; neighbours 24 m east and west; street 20 m south.
  const { lot: ring, house } = guessLot({ lat, lon }, { lat: lat - 20 / my, lon }, [rect(0, 0, 16, 12), rect(24, 0, 16, 12), rect(-24, 0, 16, 12)]);
  assert.ok(house);
  const xs = ring.map((p) => (p[0] - lon) * mx), ys = ring.map((p) => (p[1] - lat) * my);
  near(Math.max(...xs) - Math.min(...xs), 24, 0.5);  // 16 m house + 4 m each side
  near(Math.min(...ys), -15, 0.5);                    // 5 m short of the street centreline
  assert.ok(Math.max(...ys) > 16 && Math.max(...ys) < 33);
  // No footprints at all still gives a usable rectangle.
  assert.equal(guessLot({ lat, lon }, null, []).lot.length, 4);
});
