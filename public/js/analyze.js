// Yard analyzer — turns an aerial image + a lot outline into measurements.
//
// Pure functions, no DOM: the same file runs in the browser (on a <canvas>
// ImageData) and in Node (tests). Everything here is a heuristic on RGB
// aerial photos. It is meant to produce a solid *budgetary* measurement that
// a person confirms on site, not a survey.

export const CLASS = { OUT: 0, LAWN: 1, CANOPY: 2, BUILDING: 3, HARDSCAPE: 4, OTHER: 5 };

export const SQFT_PER_SQM = 10.7639;
export const SQFT_PER_ACRE = 43560;

/** Metres per pixel for Web-Mercator tiles at a latitude and zoom. */
export function groundResolution(lat, zoom) {
  return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/** Longitude/latitude -> global pixel coordinates at a zoom (256px tiles). */
export function lonLatToWorldPx(lon, lat, zoom) {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * size, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size];
}

/** Inverse of lonLatToWorldPx. */
export function worldPxToLonLat(x, y, zoom) {
  const size = 256 * 2 ** zoom;
  const n = Math.PI - (2 * Math.PI * y) / size;
  return [(x / size) * 360 - 180, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
}

/** Area of a lon/lat ring in square feet (local flat-earth approximation). */
export function polygonAreaSqft(ring) {
  if (!ring || ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110540;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * mx * (y2 * my) - x2 * mx * (y1 * my);
  }
  return (Math.abs(a) / 2) * SQFT_PER_SQM;
}

function rasterizePolygon(poly, w, h) {
  // Even-odd scanline fill. poly is [[x, y], ...] in pixel coordinates.
  const mask = new Uint8Array(w * h);
  const n = poly.length;
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % n];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
        xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = from; x <= to; x++) mask[y * w + x] = 1;
    }
  }
  return mask;
}

function localStdDev(lum, w, h, radius) {
  // Standard deviation of luminance in a (2r+1)^2 window via integral images.
  const W = w + 1;
  const s1 = new Float64Array(W * (h + 1));
  const s2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x];
      r1 += v;
      r2 += v * v;
      s1[(y + 1) * W + x + 1] = s1[y * W + x + 1] + r1;
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + r2;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      const n = (x1 - x0) * (y1 - y0);
      const a = s1[y1 * W + x1] - s1[y0 * W + x1] - s1[y1 * W + x0] + s1[y0 * W + x0];
      const b = s2[y1 * W + x1] - s2[y0 * W + x1] - s2[y1 * W + x0] + s2[y0 * W + x0];
      const mean = a / n;
      out[y * w + x] = Math.sqrt(Math.max(0, b / n - mean * mean));
    }
  }
  return out;
}

/** Label 4-connected components of `mask`. Returns {labels, areas} (label 0 = none). */
function connectedComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const areas = [0];
  const stack = [];
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    next++;
    let area = 0;
    labels[i] = next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      area++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack.push(p + 1); }
      if (p >= w && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack.push(p - w); }
      if (p < w * (h - 1) && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack.push(p + w); }
    }
    areas.push(area);
  }
  return { labels, areas };
}

function erode(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = mask[i] & mask[i - 1] & mask[i + 1] & mask[i - w] & mask[i + w];
    }
  }
  return out;
}

function dilate(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] =
        mask[i] |
        (x > 0 ? mask[i - 1] : 0) |
        (x < w - 1 ? mask[i + 1] : 0) |
        (y > 0 ? mask[i - w] : 0) |
        (y < h - 1 ? mask[i + w] : 0);
    }
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const s = Float32Array.from(values).sort();
  return s[s.length >> 1];
}

/**
 * Classify every pixel inside the lot and total it up.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image RGBA pixels
 * @param {object} opts
 * @param {number[][]} opts.polygon   lot outline in pixel coordinates
 * @param {number[][][]} [opts.buildings] known building outlines in pixel coordinates
 * @param {number[]}  [opts.seed]     a pixel on the house roof (used only when no outlines are known)
 * @param {number}    opts.sqftPerPx  ground area of one pixel
 * @returns {{measurements: object, classMap: Uint8Array}}
 */
export function analyzeYard(image, opts) {
  const { data, width: w, height: h } = image;
  const { polygon, seed, sqftPerPx, buildings } = opts;
  const N = w * h;
  const pxPerFt = 1 / Math.sqrt(sqftPerPx);

  const inside = rasterizePolygon(polygon, w, h);
  const lum = new Float32Array(N);
  const sat = new Float32Array(N);
  const exg = new Float32Array(N); // "excess green" on chromaticity
  const c1 = new Float32Array(N); // red share
  const c2 = new Float32Array(N); // blue share
  let insidePx = 0;
  let greenPx = 0;
  for (let i = 0, p = 0; i < N; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const sum = r + g + b + 1;
    const mx = Math.max(r, g, b);
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = mx ? (mx - Math.min(r, g, b)) / mx : 0;
    exg[i] = (2 * g - r - b) / sum;
    c1[i] = r / sum;
    c2[i] = b / sum;
    if (inside[i]) {
      insidePx++;
      if (exg[i] > 0.04 && g > b) greenPx++;
    }
  }
  const tex = localStdDev(lum, w, h, 2);
  const lotSqftRaw = insidePx * sqftPerPx;

  // --- 1. Buildings. Best case we are handed real footprints. Otherwise grow
  // a region outward from the address point across similar roof colour: try
  // loose tolerances first and tighten if the region floods the yard.
  let building = new Uint8Array(N);
  let buildingFound = false;
  for (const ring of buildings || []) {
    const m = rasterizePolygon(ring, w, h);
    for (let i = 0; i < N; i++) if (m[i] && inside[i]) { building[i] = 1; buildingFound = true; }
  }
  const maxBuildingSqft = Math.min(4800, lotSqftRaw * 0.4);
  const grow = (start, tol) => {
    const mask = new Uint8Array(N);
    const queue = [start];
    mask[start] = 1;
    const limit = (maxBuildingSqft / sqftPerPx) * 1.2;
    let n = 0;
    let m1 = 0;
    let m2 = 0;
    let ml = 0;
    for (let head = 0; head < queue.length; head++) {
      if (n > limit) return { mask, px: Infinity };
      const p = queue[head];
      n++;
      m1 += (c1[p] - m1) / n;
      m2 += (c2[p] - m2) / n;
      ml += (lum[p] - ml) / n;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) {
        if (q < 0 || q >= N || mask[q] || !inside[q]) continue;
        const stepC = Math.abs(c1[q] - c1[p]) + Math.abs(c2[q] - c2[p]);
        const driftC = Math.abs(c1[q] - m1) + Math.abs(c2[q] - m2);
        if (stepC < tol.stepC && driftC < tol.driftC && Math.abs(lum[q] - lum[p]) < tol.stepL && Math.abs(lum[q] - ml) < tol.driftL) {
          mask[q] = 1;
          queue.push(q);
        }
      }
    }
    return { mask, px: n };
  };
  if (seed && !buildingFound) {
    const sx = Math.round(seed[0]);
    const sy = Math.round(seed[1]);
    // The address point can sit on a ridge line, vent or tree: try a few
    // starting pixels around it and keep the most house-like result.
    const starts = [];
    const reach = Math.round(10 * pxPerFt);
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = sx + Math.round((dx * reach) / 2);
      const y = sy + Math.round((dy * reach) / 2);
      if (x >= 0 && y >= 0 && x < w && y < h && inside[y * w + x] && tex[y * w + x] < 14) starts.push(y * w + x);
    }
    const tolerances = [
      { stepC: 0.03, driftC: 0.05, stepL: 34, driftL: 70 },
      { stepC: 0.022, driftC: 0.036, stepL: 26, driftL: 55 },
      { stepC: 0.015, driftC: 0.025, stepL: 18, driftL: 40 },
      { stepC: 0.01, driftC: 0.016, stepL: 12, driftL: 28 },
    ];
    let best = null;
    for (const tol of tolerances) {
      for (const start of starts) {
        const res = grow(start, tol);
        const sqft = res.px * sqftPerPx;
        if (sqft >= 450 && sqft <= maxBuildingSqft && (!best || res.px > best.px)) best = res;
      }
      if (best) break;
    }
    if (best) {
      // Close small gaps (vents, ridge lines, dormers).
      let closed = best.mask;
      for (let k = 0; k < 3; k++) closed = dilate(closed, w, h);
      for (let k = 0; k < 3; k++) closed = erode(closed, w, h);
      for (let i = 0; i < N; i++) building[i] = (closed[i] || best.mask[i]) && inside[i] ? 1 : 0;
      buildingFound = true;
    }
  }

  // --- 2. Everything else.
  // Aerial photos come in two flavours: summer (lawns are green) and winter
  // (warm-season turf is dormant and nothing is reliably green). In winter
  // imagery we work by subtraction: yard = lot - house - pavement - plantings.
  const summer = greenPx / Math.max(1, insidePx) > 0.22;
  const cls = new Uint8Array(N);
  const softLums = [];
  for (let i = 0; i < N; i++) {
    if (!inside[i]) continue;
    if (building[i]) { cls[i] = CLASS.BUILDING; continue; }
    const paved = sat[i] < 0.13 && lum[i] > 125 && exg[i] < 0.04;
    if (paved) { cls[i] = CLASS.HARDSCAPE; continue; }
    cls[i] = CLASS.LAWN;
    if (i % 3 === 0) softLums.push(lum[i]);
  }
  const medSoft = median(softLums) || 100;

  const dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (cls[i] !== CLASS.LAWN) continue;
    const green = exg[i] > 0.04;
    if (summer) {
      if (green) {
        // Darker than the turf, and not just the blurry edge beside pavement.
        if (lum[i] < medSoft * 0.8 && tex[i] > 6) dark[i] = 1; // shrubs / canopy
        else if (tex[i] > 13 && lum[i] < medSoft * 0.93) dark[i] = 1;
      } else if (lum[i] < medSoft * 0.62) {
        dark[i] = 2; // shadow
      } else if (!(sat[i] > 0.18 && c1[i] > c2[i] && tex[i] < 11)) {
        cls[i] = CLASS.OTHER; // bare ground, mulch, pool, etc. (tan dormant turf stays lawn)
      }
    } else if (lum[i] < medSoft * 0.74) {
      dark[i] = 1;
    }
  }

  // Dark blobs: shrub-sized ones are plantings; big ones are tree canopy when
  // green and otherwise just shadow lying on the yard.
  {
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = dark[i] === 1 ? 1 : 0;
    const { labels, areas } = connectedComponents(mask, w, h);
    const greenSum = new Float64Array(areas.length);
    for (let i = 0; i < N; i++) if (labels[i]) greenSum[labels[i]] += exg[i];
    for (let i = 0; i < N; i++) {
      const l = labels[i];
      if (!l) continue;
      const sqft = areas[l] * sqftPerPx;
      if (sqft < 6) continue;
      if (sqft <= 160 || greenSum[l] / areas[l] > 0.04) cls[i] = CLASS.CANOPY;
    }
  }

  // --- Despeckle with a 3x3 majority vote.
  const smoothed = new Uint8Array(cls);
  const votes = new Uint8Array(6);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!inside[i] || cls[i] === CLASS.BUILDING) continue;
      votes.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) votes[cls[i + dy * w + dx]]++;
      let best = cls[i];
      for (let c = 1; c < 6; c++) if (votes[c] > votes[best]) best = c;
      if (votes[best] >= 6) smoothed[i] = best;
    }
  }

  // --- Totals.
  const px = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < N; i++) px[smoothed[i]]++;

  // --- Count plantings: small canopy blobs are shrubs, large ones are trees.
  const canopyMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) canopyMask[i] = smoothed[i] === CLASS.CANOPY ? 1 : 0;
  const { areas } = connectedComponents(canopyMask, w, h);
  let shrubCount = 0;
  let treeCount = 0;
  let shrubSqft = 0;
  for (let l = 1; l < areas.length; l++) {
    const sqft = areas[l] * sqftPerPx;
    if (sqft < 5) continue; // noise
    if (sqft <= 140) {
      shrubCount += Math.max(1, Math.round(sqft / 22)); // hedges read as one blob
      shrubSqft += sqft;
    } else {
      treeCount += Math.max(1, Math.round(sqft / 500));
    }
  }

  const round = (v, step) => Math.round(v / step) * step;
  const lotSqft = (N - px[CLASS.OUT]) * sqftPerPx;
  let lawn = px[CLASS.LAWN] * sqftPerPx;
  let buildingSqft = px[CLASS.BUILDING] * sqftPerPx;
  if (!buildingFound) {
    // Couldn't outline the house: assume a typical footprint so the lawn
    // isn't overstated.
    buildingSqft = Math.min(2600, lotSqft * 0.22);
    lawn = Math.max(0, lawn - buildingSqft);
  }
  const measurements = {
    lotSqft: round(lotSqft, 10),
    lotAcres: Math.round((lotSqft / SQFT_PER_ACRE) * 100) / 100,
    lawnSqft: round(lawn, 10),
    canopySqft: round(px[CLASS.CANOPY] * sqftPerPx, 10),
    buildingSqft: round(buildingSqft, 10),
    buildingFound,
    season: summer ? 'summer' : 'dormant',
    hardscapeSqft: round(px[CLASS.HARDSCAPE] * sqftPerPx, 10),
    otherSqft: round(px[CLASS.OTHER] * sqftPerPx, 10),
    // Planting beds are mostly hidden under the shrubs that sit in them.
    bedSqft: round(Math.max(shrubCount * 14, shrubSqft * 1.6), 10),
    shrubCount,
    treeCount,
  };
  return { measurements, classMap: smoothed };
}

/** Paint the class map as a translucent RGBA overlay (same size as the image). */
export function renderOverlay(classMap, width, height) {
  const colors = {
    [CLASS.LAWN]: [86, 214, 96, 120],
    [CLASS.CANOPY]: [16, 110, 52, 165],
    [CLASS.BUILDING]: [240, 96, 72, 130],
    [CLASS.HARDSCAPE]: [80, 160, 255, 140],
    [CLASS.OTHER]: [0, 0, 0, 0],
  };
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < classMap.length; i++) {
    const c = colors[classMap[i]];
    if (!c) continue;
    out.set(c, i * 4);
  }
  return out;
}
