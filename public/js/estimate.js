// The estimator: address -> aerial map -> measured yard -> live monthly price.

import { $, $$, api, authModal, dashboardUrl, esc, initHeader, money, savedEstimate, sqft } from './common.js';
import { ADDONS, CORE, computeQuote, monthlyFor } from './pricing.js';
import { analyzeYard, groundResolution, lonLatToWorldPx, polygonAreaSqft, renderOverlay, worldPxToLonLat, SQFT_PER_SQM } from './analyze.js';
import { ZOOM, aerialLayer, loadTile, pickSource } from './imagery.js';

const state = {
  user: null,
  pricing: null,
  place: null, // { label, lat, lon, precision, buildings }
  lot: [], // [[lon, lat], ...]
  measured: null, // straight from the analyzer
  overrides: {}, // numbers the visitor typed in themselves
  selections: { addons: {}, dogs: 1 },
  source: 'tn',
  editing: false,
};
let map, lotLayer, overlayLayer, handleLayer, saveTimer, analyzeRun = 0;

const measurements = () => ({ ...state.measured, ...state.overrides, edited: Object.keys(state.overrides).length > 0 });

// ---------- services list on the landing page ----------
function renderServices() {
  $('#service-grid').innerHTML = [{ ...CORE, icon: '🌿' }, ...ADDONS.filter((a) => state.pricing.addons[a.key]?.enabled)]
    .map((s, i) => `<div class="service"${i === 0 ? ' style="border-color:var(--green-700);background:#f3f8f2"' : ''}><div class="icon" aria-hidden="true">${s.icon}</div><h3>${esc(s.label)}${s.key === 'mowing' ? ' <span class="pill client">Every plan</span>' : ' <span class="pill">Optional</span>'}</h3><p>${esc(s.blurb)}</p><p class="small" style="margin-top:6px"><em>${esc(s.cadence)}</em></p></div>`)
    .join('');
}

// ---------- address lookup ----------
$('#address-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('button', e.target);
  const errorEl = $('#address-error');
  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Finding your home…';
  try {
    const place = await api('GET', `/api/lookup?address=${encodeURIComponent($('#address').value)}`);
    savedEstimate.clear();
    state.place = place;
    state.lot = place.lot;
    state.overrides = {};
    state.source = await pickSource(place.lon, place.lat);
    showEstimator();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Measure my yard';
  }
});
$('#change-address').addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#address').focus();
  $('#address').select();
});

// ---------- map + editable lot outline ----------
function showEstimator() {
  $('#estimator').hidden = false;
  $('#est-address').textContent = state.place.label;
  $('#map-tip').innerHTML = state.place.precision === 'street'
    ? '<strong>We found your street but not your exact house.</strong> Drag the white corners so the outline sits on your property.'
    : '<strong>Not quite your property line?</strong> Drag the white corners to fix it — the numbers update as you go.';
  if (map) map.remove();
  map = L.map('map', { zoomControl: true, scrollWheelZoom: false, attributionControl: true });
  aerialLayer(state.source).addTo(map);
  lotLayer = L.polygon([], { color: '#fff', weight: 3, fill: false, dashArray: '6 6' }).addTo(map);
  handleLayer = L.layerGroup().addTo(map);
  drawLot();
  map.fitBounds(lotLayer.getBounds().pad(0.25), { maxZoom: 20 });
  $('#estimator').scrollIntoView({ behavior: 'smooth', block: 'start' });
  analyze();
}

const toLatLng = ([lon, lat]) => [lat, lon];

function drawLot() {
  lotLayer.setLatLngs(state.lot.map(toLatLng));
  handleLayer.clearLayers();
  const icon = (cls) => L.divIcon({ className: '', html: `<div class="vertex ${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
  state.lot.forEach((pt, i) => {
    const m = L.marker(toLatLng(pt), { draggable: true, icon: icon(''), title: 'Drag to adjust. Double-click to remove.', keyboard: false }).addTo(handleLayer);
    m.on('drag', (e) => {
      state.lot[i] = [e.latlng.lng, e.latlng.lat];
      lotLayer.setLatLngs(state.lot.map(toLatLng));
    });
    m.on('dragend', () => { drawLot(); analyze(); });
    m.on('dblclick', (e) => {
      L.DomEvent.stop(e);
      if (state.lot.length > 3) { state.lot.splice(i, 1); drawLot(); analyze(); }
    });
    // A smaller handle halfway along each edge adds a new corner.
    const next = state.lot[(i + 1) % state.lot.length];
    const mid = L.marker([(pt[1] + next[1]) / 2, (pt[0] + next[0]) / 2], { draggable: true, icon: icon('mid'), title: 'Drag to add a corner', keyboard: false }).addTo(handleLayer);
    mid.on('dragstart', () => state.lot.splice(i + 1, 0, [0, 0]));
    mid.on('drag', (e) => {
      state.lot[i + 1] = [e.latlng.lng, e.latlng.lat];
      lotLayer.setLatLngs(state.lot.map(toLatLng));
    });
    mid.on('dragend', () => { drawLot(); analyze(); });
  });
}

// ---------- measuring ----------
async function analyze() {
  const run = ++analyzeRun;
  $('#analyzing').hidden = false;
  try {
    const px = state.lot.map(([lon, lat]) => lonLatToWorldPx(lon, lat, ZOOM));
    const pad = 12;
    const minX = Math.floor(Math.min(...px.map((p) => p[0]))) - pad;
    const minY = Math.floor(Math.min(...px.map((p) => p[1]))) - pad;
    const w = Math.ceil(Math.max(...px.map((p) => p[0]))) + pad - minX;
    const h = Math.ceil(Math.max(...px.map((p) => p[1]))) + pad - minY;
    if (w * h > 2200 * 2200) throw new Error('That outline is too large to measure — pull the corners in closer to the home.');

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let ty = Math.floor(minY / 256); ty <= Math.floor((minY + h) / 256); ty++) {
      for (let tx = Math.floor(minX / 256); tx <= Math.floor((minX + w) / 256); tx++) {
        jobs.push(loadTile(state.source, ZOOM, tx, ty).then((img) => ctx.drawImage(img, tx * 256 - minX, ty * 256 - minY)));
      }
    }
    await Promise.all(jobs);
    if (run !== analyzeRun) return; // a newer run superseded this one
    const image = ctx.getImageData(0, 0, w, h);

    const local = ([lon, lat]) => {
      const [x, y] = lonLatToWorldPx(lon, lat, ZOOM);
      return [x - minX, y - minY];
    };
    const res = groundResolution(state.place.lat, ZOOM);
    const { measurements: m, classMap } = analyzeYard(image, {
      polygon: state.lot.map(local),
      buildings: (state.place.buildings || []).map((ring) => ring.map(local)),
      seed: state.place.precision === 'rooftop' ? local([state.place.lon, state.place.lat]) : null,
      sqftPerPx: res * res * SQFT_PER_SQM,
    });
    // The outline's true area is more exact than counting pixels.
    m.lotSqft = Math.round(polygonAreaSqft(state.lot) / 10) * 10;
    state.measured = m;

    // Colour overlay on the map.
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').putImageData(new ImageData(renderOverlay(classMap, w, h), w, h), 0, 0);
    const [west, north] = worldPxToLonLat(minX, minY, ZOOM);
    const [east, south] = worldPxToLonLat(minX + w, minY + h, ZOOM);
    if (overlayLayer) overlayLayer.remove();
    overlayLayer = L.imageOverlay(out.toDataURL(), [[south, west], [north, east]], { opacity: 0.85, interactive: false });
    if ($('#overlay-toggle').checked) overlayLayer.addTo(map);
    lotLayer.bringToFront();
  } catch (err) {
    console.error(err);
    if (run !== analyzeRun) return;
    // Imagery couldn't be read: fall back to typical proportions of the lot
    // so the visitor still gets a number (they can correct it by hand).
    const lot = polygonAreaSqft(state.lot);
    const building = Math.min(2600, lot * 0.22);
    state.measured = { lotSqft: Math.round(lot), lawnSqft: Math.round((lot - building) * 0.72), buildingSqft: Math.round(building), hardscapeSqft: Math.round(lot * 0.09), canopySqft: 0, bedSqft: 200, shrubCount: 14, treeCount: 0, approximate: true };
  } finally {
    if (run === analyzeRun) {
      $('#analyzing').hidden = true;
      render();
      queueSave();
    }
  }
}
$('#overlay-toggle').addEventListener('change', (e) => {
  if (!overlayLayer) return;
  if (e.target.checked) overlayLayer.addTo(map); else overlayLayer.remove();
});

// ---------- rendering ----------
const TILES = [
  { key: 'lotSqft', label: 'Lot', unit: 'sq ft', fixed: true },
  { key: 'lawnSqft', label: 'Lawn', unit: 'sq ft' },
  { key: 'shrubCount', label: 'Shrubs', unit: '' },
  { key: 'hardscapeSqft', label: 'Hard surfaces', unit: 'sq ft' },
];

function renderTiles() {
  const m = measurements();
  $('#tiles').innerHTML = TILES.map((t) => {
    const acres = t.key === 'lotSqft' ? ` <small>(${(m.lotSqft / 43560).toFixed(2)} ac)</small>` : '';
    const value = state.editing && !t.fixed
      ? `<input type="number" min="0" step="${t.unit ? 50 : 1}" inputmode="numeric" data-measure="${t.key}" value="${Math.round(m[t.key] || 0)}" aria-label="${t.label}${t.unit ? ` in ${t.unit}` : ''}">`
      : `<div class="v num">${sqft(m[t.key])} <small>${t.unit}</small>${acres}</div>`;
    return `<div class="tile"><div class="k">${t.label}</div>${value}</div>`;
  }).join('');
  $('#edit-measure').textContent = state.editing ? 'Done' : Object.keys(state.overrides).length ? 'Adjust these numbers (edited)' : 'Adjust these numbers';
}
$('#tiles').addEventListener('input', (e) => {
  const key = e.target.dataset.measure;
  if (!key) return;
  const v = Math.max(0, Math.round(Number(e.target.value) || 0));
  state.overrides[key] = v;
  // More shrubs means more bed to weed and mulch.
  if (key === 'shrubCount') state.overrides.bedSqft = v * 14;
  renderPlan();
  queueSave();
});
$('#edit-measure').addEventListener('click', () => { state.editing = !state.editing; renderTiles(); });

function renderPlan() {
  const { pricing, selections } = state;
  const m = measurements();
  const q = computeQuote(pricing, m, selections);

  $('#core-card').innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">
      <strong>🌿 ${esc(CORE.label)} <span class="pill client" style="margin-left:6px">Included</span></strong>
      <span class="price num">${money(q.core.monthly)}<span class="small muted">/mo</span></span>
    </div>
    <div class="small muted">${esc(CORE.cadence)} · about ${q.core.visitsPerYear} visits a year</div>
    <ul>${CORE.tasks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="small" style="margin:10px 0 0"><strong>No separate bills</strong> for weed pulling, shrub trimming, mulch or leaf cleanup — it's all part of every visit.</p>`;

  $('#addons').innerHTML = ADDONS.filter((a) => pricing.addons[a.key]?.enabled).map((a) => {
    const on = Boolean(selections.addons[a.key]);
    const dogs = a.needsDogs && on
      ? `<div class="dogs">Dogs: <button type="button" data-dogs="-1" aria-label="Fewer dogs">−</button><strong class="num">${selections.dogs}</strong><button type="button" data-dogs="1" aria-label="More dogs">+</button></div>`
      : '';
    return `<label class="addon ${on ? 'on' : ''}">
      <input type="checkbox" data-addon="${a.key}" ${on ? 'checked' : ''}>
      <span class="body"><span class="name">${a.icon} ${esc(a.label)}</span><br><span class="desc">${esc(a.blurb)} <em>${esc(a.cadence)}.</em></span>${dogs}</span>
      <span class="plus num">+${money(monthlyFor(pricing, a.key, m, selections))}/mo</span>
    </label>`;
  }).join('');

  const count = q.addons.length;
  const nextTier = [...pricing.bundle].sort((a, b) => a.count - b.count).find((b) => b.count > count);
  $('#bundle-hint').textContent = q.discountPct
    ? `Bundle discount: ${q.discountPct}% off add-ons`
    : nextTier ? `Pick ${nextTier.count} and save ${nextTier.pct}% on add-ons` : '';

  $('#summary').innerHTML = `
    <div class="what">
      <div class="label">Your budgetary range</div>
      <div class="range num">${money(q.low)}–${money(q.high)} <small>per month</small></div>
      <div class="lines">12 equal payments, all year · ${esc(CORE.label)}${count ? ` + ${count} add-on${count > 1 ? 's' : ''}` : ''}${q.discountPct ? ` · ${q.discountPct}% bundle discount` : ''}</div>
    </div>
    <button class="btn light" id="save-cta">${state.user ? 'Save to my dashboard' : 'Save my estimate'}</button>`;
}

function render() {
  renderTiles();
  renderPlan();
}

$('#addons').addEventListener('change', (e) => {
  const key = e.target.dataset.addon;
  if (!key) return;
  if (e.target.checked) state.selections.addons[key] = true; else delete state.selections.addons[key];
  renderPlan();
  queueSave();
  $(`[data-addon="${key}"]`)?.focus();
});
$('#addons').addEventListener('click', (e) => {
  const step = Number(e.target.dataset.dogs);
  if (!step) return;
  e.preventDefault();
  state.selections.dogs = Math.min(8, Math.max(1, state.selections.dogs + step));
  renderPlan();
  queueSave();
});

// ---------- saving (every estimate is captured as a lead) ----------
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 900);
}
async function save() {
  clearTimeout(saveTimer);
  if (!state.place || !state.measured) return null;
  const payload = { lot: state.lot, measurements: measurements(), selections: state.selections };
  const existing = savedEstimate.get();
  try {
    if (existing?.id) {
      await api('PUT', `/api/estimates/${existing.id}`, { ...payload, claimToken: existing.claimToken });
      return existing;
    }
    const { property, claimToken } = await api('POST', '/api/estimates', { ...payload, address: state.place.label, lat: state.place.lat, lon: state.place.lon });
    const saved = { id: property.id, claimToken };
    savedEstimate.set(saved);
    return saved;
  } catch (err) {
    console.error(err);
    return null;
  }
}

$('#summary').addEventListener('click', async (e) => {
  if (!e.target.closest('#save-cta')) return;
  const btn = e.target.closest('#save-cta');
  btn.disabled = true;
  await save();
  if (!state.user) {
    state.user = await authModal('signup', { title: 'Save your estimate', intro: "Create your account and we'll reach out to schedule a free walkthrough. Your estimate will be waiting in your dashboard." });
  }
  btn.disabled = false;
  if (state.user) {
    savedEstimate.clear();
    location.href = dashboardUrl(state.user);
  }
});

// ---------- start ----------
const [{ pricing }, user] = await Promise.all([api('GET', '/api/config'), initHeader()]);
state.pricing = pricing;
state.user = user;
renderServices();
// Coming back from a dashboard link like /?address=...
const preset = new URLSearchParams(location.search).get('address');
if (preset) {
  $('#address').value = preset;
  $('#address-form').requestSubmit();
}
