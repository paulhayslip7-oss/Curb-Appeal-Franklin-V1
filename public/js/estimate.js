// The estimator: address -> aerial map -> measured yard -> live monthly price.
// It lives on /estimate.html, which is not linked from the public site.

import { $, $$, api, authModal, dashboardUrl, esc, initHeader, money, savedEstimate, sqft } from './common.js';
import { ADDONS, CORE, computeQuote, monthlyFor } from './pricing.js';
import { analyzeYard, groundResolution, lonLatToWorldPx, polygonAreaSqft, renderOverlay, worldPxToLonLat, SQFT_PER_SQM } from './analyze.js';
import { ZOOM, aerialLayer, loadTile, pickSource } from './imagery.js';

const ACRE = 43560;

const state = {
  user: null,
  pricing: null,
  place: null, // { label, lat, lon, precision, buildings }
  lot: [], // [[lon, lat], ...]
  lotSource: 'estimate', // 'parcel' once we have the recorded property line
  measured: null, // straight from the analyzer
  overrides: {}, // numbers the visitor typed in themselves
  selections: { addons: {}, dogs: 1 },
  source: 'tn',
  editing: false,
};
let map, lotLayer, overlayLayer, handleLayer, saveTimer, analyzeRun = 0;

const measurements = () => ({ ...state.measured, ...state.overrides, edited: Object.keys(state.overrides).length > 0 });

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
    // Over an acre: no calculator. Take their details for a formal proposal.
    const lotSqft = polygonAreaSqft(place.lot);
    if (lotSqft > ACRE) {
      proposalModal({ address: place.label, lat: place.lat, lon: place.lon, lot: place.lot, lotSource: place.lotSource, lotSqft });
      return;
    }
    savedEstimate.clear();
    state.place = place;
    state.lot = place.lot;
    state.lotSource = place.lotSource || 'estimate';
    state.overrides = {};
    state.source = await pickSource(place.lon, place.lat);
    showEstimator();
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Measure my property';
  }
});
// ---------- address suggestions while typing ----------
{
  const input = $('#address');
  const list = $('#address-suggestions');
  let items = [];
  let active = -1;
  let timer;
  let seq = 0;
  const close = () => { list.hidden = true; items = []; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const paint = () => {
    list.innerHTML = items.map((t, i) => `<li role="option" id="sug-${i}" aria-selected="${i === active}">${esc(t)}</li>`).join('');
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(items.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `sug-${active}`); else input.removeAttribute('aria-activedescendant');
  };
  const choose = (i) => {
    input.value = items[i];
    close();
    $('#address-form').requestSubmit();
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { seq++; close(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const { suggestions } = await api('GET', `/api/suggest?q=${encodeURIComponent(q)}`);
        if (mine !== seq) return; // a newer keystroke won
        items = suggestions;
        active = -1;
        paint();
      } catch { /* suggestions are a nicety; typing the full address still works */ }
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length + (active < 0 && e.key === 'ArrowUp' ? 1 : 0)) % items.length;
      paint();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') close();
  });
  // mousedown (not click) so it lands before the input loses focus.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); choose([...list.children].indexOf(li)); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  $('#address-form').addEventListener('submit', () => { seq++; clearTimeout(timer); close(); });
}

// ---------- over one acre: request a formal proposal ----------
function proposalModal(prop) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pr-title">
      <button class="close" aria-label="Close">×</button>
      <h2 id="pr-title" style="font-size:2rem">Let's walk this one.</h2>
      <p class="muted">This budgetary calculator is most accurate for properties under 1 acre. For properties over 1 acre, fill out this form and Paul will reach out.</p>
      <p class="small" style="margin-bottom:18px"><strong>${esc(prop.address)}</strong> · about ${(prop.lotSqft / ACRE).toFixed(1)} acres</p>
      <form novalidate>
        <div class="field"><label for="pr-name">Name</label><input id="pr-name" name="name" autocomplete="name" required></div>
        <div class="row">
          <div class="field"><label for="pr-phone">Mobile phone</label><input id="pr-phone" name="phone" type="tel" autocomplete="tel"></div>
          <div class="field"><label for="pr-email">Email</label><input id="pr-email" name="email" type="email" autocomplete="email"></div>
        </div>
        <div class="field"><label for="pr-kind">Property type</label><select id="pr-kind" name="kind"><option value="residential">Residential</option><option value="commercial">Commercial</option></select></div>
        <div class="field"><label for="pr-notes">Anything we should know? <span class="muted" style="font-weight:400">(optional)</span></label><textarea id="pr-notes" name="notes" rows="3" maxlength="1500"></textarea></div>
        <input name="company" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;min-height:0">
        <div class="error" role="alert"></div>
        <button class="btn block" type="submit">Request my proposal</button>
      </form>
    </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.close') || e.target.closest('[data-done]')) close(); });
  back.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (f.company) return close(); // spam bots fill hidden fields
    const btn = $('button[type=submit]', back);
    btn.disabled = true;
    $('.error', back).textContent = '';
    try {
      await api('POST', '/api/proposal-requests', { ...prop, name: f.name, phone: f.phone, email: f.email, kind: f.kind, notes: f.notes });
      // Also hand it to Netlify Forms, which emails the owner. Best effort:
      // the request is already saved for the admin page either way.
      fetch('/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'form-name': 'proposal', name: f.name, phone: f.phone, email: f.email, kind: f.kind, address: prop.address, acres: (prop.lotSqft / ACRE).toFixed(2), notes: f.notes }),
      }).catch(() => {});
      $('.modal', back).innerHTML = `
        <button class="close" aria-label="Close">×</button>
        <h2 style="font-size:2rem">Thank you, ${esc(f.name.split(' ')[0])}.</h2>
        <p class="muted">Paul will reach out to schedule a time to walk the property. If it's urgent, <a href="sms:+16159451614">text (615) 945-1614</a>.</p>
        <button class="btn block" data-done>Done</button>`;
    } catch (err) {
      $('.error', back).textContent = err.message;
      btn.disabled = false;
    }
  });
  document.body.append(back);
  $('#pr-name', back).focus();
}

$('#change-address').addEventListener('click', () => {
  $('#estimate').scrollIntoView({ behavior: 'smooth' });
  $('#address').focus({ preventScroll: true });
  $('#address').select();
});

// ---------- map + editable lot outline ----------
function showEstimator() {
  $('#estimator').hidden = false;
  $('#est-address').textContent = state.place.label;
  $('#map-tip').innerHTML = state.place.precision === 'street'
    ? '<strong>We found your street but not your exact house.</strong> Drag the corners onto your property.'
    : state.lotSource === 'parcel'
      ? '<strong>Your recorded property line</strong>, from the county parcel map. Drag a corner to adjust.'
      : '<strong>This outline is our estimate.</strong> Drag the corners to match your property line.';
  if (L.Browser.mobile) $('#map-tip').insertAdjacentHTML('beforeend', ' Use two fingers to move the map.');
  if (map) map.remove();
  // On phones one finger scrolls the page; two fingers move or zoom the map.
  map = L.map('map', { zoomControl: true, scrollWheelZoom: false, attributionControl: true, dragging: !L.Browser.mobile });
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
  // A 36px touch target around each small visible handle.
  const icon = (cls) => L.divIcon({ className: '', html: `<div class="vx"><div class="vertex ${cls}"></div></div>`, iconSize: [36, 36], iconAnchor: [18, 18] });
  state.lot.forEach((pt, i) => {
    const m = L.marker(toLatLng(pt), { draggable: true, icon: icon(''), title: 'Drag to adjust. Double-click to remove.', keyboard: false }).addTo(handleLayer);
    m.on('drag', (e) => {
      state.lot[i] = [e.latlng.lng, e.latlng.lat];
      lotLayer.setLatLngs(state.lot.map(toLatLng));
    });
    m.on('dragend', () => { state.lotSource = 'estimate'; drawLot(); analyze(); });
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
      <strong style="font:500 1.9rem/1.1 var(--serif)">${esc(CORE.label)}</strong>
      <span class="price num">${money(q.core.monthly)}<span class="small muted">/mo</span></span>
    </div>
    <div class="small muted">${esc(CORE.cadence)} · about ${q.core.visitsPerYear} visits a year</div>
    <ul>${CORE.tasks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="small" style="margin:10px 0 0"><strong>No separate bills</strong> for weeds, shrubs, mulch, leaves or winterizing your hose spigots.</p>`;

  $('#addons').innerHTML = ADDONS.filter((a) => pricing.addons[a.key]?.enabled).map((a) => {
    const on = Boolean(selections.addons[a.key]);
    const dogs = a.needsDogs && on
      ? `<div class="dogs">Dogs: <button type="button" data-dogs="-1" aria-label="Fewer dogs">−</button><strong class="num">${selections.dogs}</strong><button type="button" data-dogs="1" aria-label="More dogs">+</button></div>`
      : '';
    return `<label class="addon ${on ? 'on' : ''}">
      <input type="checkbox" data-addon="${a.key}" ${on ? 'checked' : ''}>
      <span class="body"><span class="name">${esc(a.label)}</span><br><span class="desc">${esc(a.blurb)} <em>${esc(a.cadence)}.</em></span>${dogs}</span>
      <span class="plus num">+${money(monthlyFor(pricing, a.key, m, selections))}/mo</span>
    </label>`;
  }).join('');

  const count = q.addons.length;
  const nextTier = [...pricing.bundle].sort((a, b) => a.count - b.count).find((b) => b.count > count);
  $('#bundle-hint').textContent = q.discountPct
    ? `Bundle discount: ${q.discountPct}% off add-ons`
    : nextTier ? `Pick ${nextTier.count} and save ${nextTier.pct}% on add-ons` : '';

  // The calculator is only for homes under one acre.
  if (m.lotSqft > ACRE) {
    $('#summary').innerHTML = `
    <div class="what">
      <div class="label">Over one acre</div>
      <div class="range">By formal proposal</div>
      <div class="lines">We walk larger properties in person and price them individually.</div>
    </div>
    <button class="btn light" id="proposal-cta">Request my proposal</button>`;
    return;
  }
  $('#summary').innerHTML = `
    <div class="what">
      <div class="label">Your budgetary range</div>
      <div class="range num">${money(q.low)}–${money(q.high)} <small>per month</small></div>
      <div class="lines">12 equal payments${count ? ` · ${count} extra${count > 1 ? 's' : ''}` : ''}${q.discountPct ? ` · ${q.discountPct}% bundle discount` : ''}</div>
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
  const payload = { lot: state.lot, lotSource: state.lotSource, measurements: measurements(), selections: state.selections };
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
  if (e.target.closest('#proposal-cta')) {
    proposalModal({ address: state.place.label, lat: state.place.lat, lon: state.place.lon, lot: state.lot, lotSource: state.lotSource, lotSqft: polygonAreaSqft(state.lot) });
    return;
  }
  if (!e.target.closest('#save-cta')) return;
  const btn = e.target.closest('#save-cta');
  btn.disabled = true;
  await save();
  if (!state.user) {
    state.user = await authModal('signup', { title: 'Save your estimate', intro: "Create your account and we'll be in touch to schedule your free walkthrough." });
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
// Coming back from a dashboard link like /?address=...
const preset = new URLSearchParams(location.search).get('address');
if (preset) {
  $('#address').value = preset;
  $('#address-form').requestSubmit();
}
