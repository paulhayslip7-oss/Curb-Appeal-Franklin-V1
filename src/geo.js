// Address lookup + first-guess lot outline.
//
// Data sources (all free, no API key):
//   1. Tennessee statewide address points (tnmap.tn.gov) — rooftop-accurate in TN.
//   2. US Census geocoder — street-level fallback, also tells us which side
//      of the house the street is on.
//   3. FEMA "USA Structures" building footprints (public ArcGIS layer) — the
//      true outline of the house and its neighbours.
// There is no free parcel-boundary source for Williamson County, so the lot
// outline is an educated guess: it is squared up to the house, runs from the
// street to a typical back-yard depth, and stops halfway to each neighbour.
// The customer can drag it, and it is confirmed at the walkthrough.

const TN_LOCATOR =
  'https://tnmap.tn.gov/arcgis/rest/services/LOCATORS/TN_ADDRESSPOINTS/GeocodeServer/findAddressCandidates';
const STRUCTURES =
  'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

async function getJson(url, ms = 7000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function tnAddressPoint(singleLine) {
  const url = `${TN_LOCATOR}?${new URLSearchParams({ SingleLine: singleLine, outSR: '4326', maxLocations: '1', outFields: 'AddNum,StName,City,Postal,Addr_type', f: 'json' })}`;
  const data = await getJson(url);
  const c = data.candidates?.[0];
  if (!c || c.score < 95 || c.attributes?.Addr_type !== 'PointAddress') return null;
  // The locator will happily match the right street in the wrong town.
  const typedNumber = singleLine.match(/^\s*(\d+)/)?.[1];
  if (typedNumber && typedNumber !== String(c.attributes.AddNum)) return null;
  return {
    label: titleCase(c.address),
    lon: c.location.x,
    lat: c.location.y,
    number: parseInt(c.attributes.AddNum, 10),
    street: c.attributes.StName,
  };
}

async function censusPoint(singleLine) {
  const url = `${CENSUS}?${new URLSearchParams({ address: singleLine, benchmark: 'Public_AR_Current', format: 'json' })}`;
  const data = await getJson(url);
  const m = data.result?.addressMatches?.[0];
  if (!m) return null;
  return { label: titleCase(m.matchedAddress), lon: m.coordinates.x, lat: m.coordinates.y };
}

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/, ([A-Za-z]{2}),/, (_, st) => `, ${st.toUpperCase()},`)
    .replace(/, ([A-Za-z]{2})$/, (_, st) => `, ${st.toUpperCase()}`);
}

// Small local-metres helpers around an origin.
function projector(lat0, lon0) {
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const my = 110540;
  return {
    toM: (lon, lat) => [(lon - lon0) * mx, (lat - lat0) * my],
    toLL: ([x, y]) => [lon0 + x / mx, lat0 + y / my],
  };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function nearbyBuildings(lon, lat, radiusM = 85) {
  const dLat = radiusM / 110540;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  const url = `${STRUCTURES}?${new URLSearchParams({
    geometry: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'SQFEET',
    outSR: '4326',
    geometryPrecision: '6', // (adding resultRecordCount makes this service hang)
    f: 'geojson',
  })}`;
  const data = await getJson(url, 8000);
  const out = [];
  for (const f of data.features || []) {
    const g = f.geometry;
    const rings = g?.type === 'Polygon' ? [g.coordinates[0]] : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : [];
    for (const ring of rings) if (ring?.length >= 4) out.push(ring.slice(0, -1)); // drop closing point
  }
  return out;
}

function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringAreaM(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

const centroid = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const extent = (ring, axis) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ring) {
    const v = p[0] * axis[0] + p[1] * axis[1];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
};

/** Direction of the longest-wall-aligned minimum bounding box of a ring (unit vector). */
function houseAxis(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1.5) continue;
    const t = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const [t0, t1] = extent(ring, t);
    const [n0, n1] = extent(ring, [-t[1], t[0]]);
    const area = (t1 - t0) * (n1 - n0);
    if (!best || area < best.area) best = { area, t };
  }
  return best ? best.t : [1, 0];
}

/**
 * Guess a lot outline.
 * @param roof       {lon, lat} the address point
 * @param street     {lon, lat}|null a point on the street out front
 * @param footprints rings of [lon, lat] for nearby buildings
 * @returns {{ lot: number[][], house: number[][]|null }}
 */
export function guessLot(roof, street, footprints = []) {
  const P = projector(roof.lat, roof.lon);
  const s = street ? P.toM(street.lon, street.lat) : null;
  const rings = footprints.map((r) => r.map(([lon, lat]) => P.toM(lon, lat)));

  // Which footprint is this address's house? The one under (or nearest) the point.
  let houseIdx = rings.findIndex((r) => pointInRing([0, 0], r));
  if (houseIdx < 0) {
    let bestD = 28;
    rings.forEach((r, i) => {
      const c = centroid(r);
      const d = Math.hypot(c[0], c[1]);
      if (d < bestD && ringAreaM(r) > 45) { bestD = d; houseIdx = i; }
    });
  }
  const corners = (t, u, t0, t1, u0, u1) =>
    [[t0, u0], [t1, u0], [t1, u1], [t0, u1]].map(([a, b]) => P.toLL([t[0] * a + u[0] * b, t[1] * a + u[1] * b]));

  if (houseIdx < 0) {
    // No footprint: a generic lot running back from the street.
    const sDist = s ? Math.hypot(s[0], s[1]) : 0;
    let u = [0, 1];
    if (s && sDist > 6 && sDist < 150) u = [-s[0] / sDist, -s[1] / sDist];
    const t = [u[1], -u[0]];
    const setback = sDist > 8 && sDist < 120 ? sDist : 20;
    return { lot: corners(t, u, -13, 13, -(setback - 5), clamp(setback * 1.15, 16, 45)), house: null };
  }

  const house = rings[houseIdx];
  const hc = centroid(house);
  // Square the lot up to the house. u points from the street to the back yard.
  let t = houseAxis(house);
  let u = [-t[1], t[0]];
  if (s) {
    const toHouse = [hc[0] - s[0], hc[1] - s[1]];
    if (Math.abs(toHouse[0] * t[0] + toHouse[1] * t[1]) > Math.abs(toHouse[0] * u[0] + toHouse[1] * u[1])) [t, u] = [u, t];
    if (toHouse[0] * u[0] + toHouse[1] * u[1] < 0) u = [-u[0], -u[1]];
  }
  const [ht0, ht1] = extent(house, t);
  const [hu0, hu1] = extent(house, u);

  // Sides and back: stop halfway to the neighbouring houses.
  let left = 7.5;
  let right = 7.5;
  let rear = clamp((hu1 - hu0) * 1.1 + 6, 10, 26);
  rings.forEach((r, i) => {
    if (i === houseIdx || ringAreaM(r) < 60) return; // ignore sheds
    const [rt0, rt1] = extent(r, t);
    const [ru0, ru1] = extent(r, u);
    const overlapsU = ru0 < hu1 + 4 && ru1 > hu0 - 4;
    const overlapsT = rt0 < ht1 && rt1 > ht0;
    if (overlapsU && rt1 <= ht0 + 1) left = Math.min(left, Math.max(1, (ht0 - rt1) / 2));
    if (overlapsU && rt0 >= ht1 - 1) right = Math.min(right, Math.max(1, (rt0 - ht1) / 2));
    if (overlapsT && ru0 >= hu1 - 1) rear = Math.min(rear, Math.max(4, (ru0 - hu1) / 2));
  });

  // Front: run to ~16 ft short of the street centreline (i.e. the curb).
  let frontYard = 9;
  if (s) {
    const su = s[0] * u[0] + s[1] * u[1];
    const d = hu0 - su - 5;
    if (d > 2 && d < 32) frontYard = d;
  }
  return {
    lot: corners(t, u, ht0 - left, ht1 + right, hu0 - frontYard, hu1 + rear),
    house: footprints[houseIdx],
  };
}

/**
 * Look up an address. Returns null when nothing matches.
 * {
 *   label, lat, lon,
 *   precision: 'rooftop' | 'street',
 *   lot:       [[lon, lat], ...]   first-guess outline
 *   buildings: [[[lon, lat], ...]] nearby building footprints
 * }
 */
export async function lookupAddress(input) {
  const q = input.trim().replace(/\s+/g, ' ');
  const [tn, census] = await Promise.all([
    tnAddressPoint(q).catch(() => null),
    censusPoint(q).catch(() => null),
  ]);
  const hit = tn || census;
  if (!hit) return null;
  const buildings = await nearbyBuildings(hit.lon, hit.lat).catch(() => []);
  // A street-level match sits on the road, so it can't tell us which house.
  const { lot } = guessLot(hit, tn ? census : null, tn ? buildings : []);
  return {
    label: hit.label,
    lat: hit.lat,
    lon: hit.lon,
    precision: tn ? 'rooftop' : 'street',
    lot,
    buildings,
  };
}
