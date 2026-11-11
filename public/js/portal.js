// Client dashboard: the plan, what's next, and a report for every visit.

import { $, api, authModal, esc, fmtDate, money, sqft, STATUS_LABEL, toast } from './common.js';
import { lightbox, visitHtml } from './visits.js';
import { aerialLayer, pickSource } from './imagery.js';

const app = $('#app');
let me = null;
let currentId = null;

function signedOut() {
  $('#signout').hidden = true;
  app.innerHTML = `
    <div class="card auth-box" style="text-align:center">
      <h1 style="font-size:1.7rem">Your Curb Appeal dashboard</h1>
      <p class="muted">See your plan, your next visit, and a photo report of everything we've done.</p>
      <p><button class="btn block" id="do-login">Sign in</button></p>
      <p class="small muted" style="margin:0">Not a client yet? <a href="/">Get your monthly price in a minute</a>.</p>
    </div>`;
  $('#do-login').addEventListener('click', async () => { if (await authModal('login')) start(); });
}

const STAGES = [['lead', 'Estimate saved'], ['walkthrough', 'Walkthrough'], ['client', 'Active plan']];
function stageHtml(status) {
  const idx = status === 'client' ? 2 : status === 'walkthrough' ? 1 : 0;
  return `<ol class="stage" aria-label="Where things stand">${STAGES.map(([, label], i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${label}</li>`).join('')}</ol>`;
}

function planHtml(p) {
  const isClient = p.status === 'client';
  const price = p.finalMonthly
    ? `<div class="price-big num">${money(p.finalMonthly)} <small>per month · fixed</small></div>`
    : `<div class="price-big num">${money(p.quote.low)}–${money(p.quote.high)} <small>per month · budgetary range</small></div>`;
  const lines = [p.quote.core, ...p.quote.addons];
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
      <h2 style="font-size:1.3rem;margin:0">${isClient ? 'Your plan' : 'Your estimate'}</h2>
      <span class="pill ${p.status}">${esc(STATUS_LABEL[p.status] === 'New lead' ? 'Estimate saved' : STATUS_LABEL[p.status])}</span>
    </div>
    ${price}
    <p class="small muted" style="margin:6px 0 0">${p.finalMonthly ? '12 equal payments on your annual agreement. Same price every month.' : "We'll confirm your fixed monthly price at your free walkthrough."}</p>
    <ul class="plan-list">${lines.map((l) => `<li><span><strong>${esc(l.label)}</strong><br><span class="cad">${esc(l.cadence)}</span></span>${p.finalMonthly ? '' : `<span class="num muted">${money(l.monthly)}/mo</span>`}</li>`).join('')}</ul>
    ${isClient ? '' : `<p style="margin:14px 0 0"><a class="btn ghost small" href="/?address=${encodeURIComponent(p.address)}">Re-measure or change add-ons</a></p>`}
  </div>`;
}

function whatsIncludedHtml(planTasks) {
  return `<div class="card">
    <h2 style="font-size:1.3rem">What we do at your home</h2>
    <p class="small muted">This is the checklist your crew works from. Every visit report shows which of these were completed.</p>
    <ul class="checks" style="margin-bottom:0">${planTasks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
  </div>`;
}

function statsHtml(visits) {
  const year = String(new Date().getFullYear());
  const thisYear = visits.filter((v) => v.date.startsWith(year));
  const tasks = visits.reduce((s, v) => s + v.tasks.filter((t) => t.done).length, 0);
  const photos = visits.reduce((s, v) => s + (v.photos?.length || 0), 0);
  const cells = [
    [thisYear.length, `Visits in ${year}`],
    [tasks, 'Tasks completed'],
    [photos, 'Photos on file'],
    [visits[0] ? fmtDate(visits[0].date, { month: 'short', day: 'numeric' }) : '—', 'Last visit'],
  ];
  return `<div class="stats">${cells.map(([v, k]) => `<div class="stat"><div class="v num">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('')}</div>`;
}

function messagesHtml(p) {
  const msgs = p.messages || [];
  return `<div class="card">
    <h2 style="font-size:1.3rem">Notes for your crew</h2>
    <div class="thread" id="thread">${msgs.length ? msgs.map((m) => `<div class="msg ${m.from === 'client' ? 'mine' : ''}">${esc(m.text)}<time>${m.from === 'client' ? 'You' : 'Curb Appeal'} · ${esc(fmtDate(m.at, { month: 'short', day: 'numeric' }))}</time></div>`).join('') : '<p class="small muted" style="margin:0">Gate code changed? Want to skip a week? Leave us a note here.</p>'}</div>
    <form id="msg-form"><label for="msg" class="small">New note</label><textarea id="msg" rows="2" maxlength="1500" required></textarea><button class="btn small" style="margin-top:8px">Send</button></form>
  </div>`;
}

function propertyHtml(p) {
  const m = p.measurements;
  return `<div class="card">
    <h2 style="font-size:1.3rem">Your property</h2>
    <div class="mini-map" id="mini-map"></div>
    <dl class="kv">
      <dt>Lot</dt><dd class="num">${sqft(m.lotSqft)} sq ft (${(m.lotSqft / 43560).toFixed(2)} ac)</dd>
      <dt>Lawn</dt><dd class="num">${sqft(m.lawnSqft)} sq ft</dd>
      <dt>Shrubs</dt><dd class="num">${sqft(m.shrubCount)}</dd>
      <dt>Hard surfaces</dt><dd class="num">${sqft(m.hardscapeSqft)} sq ft</dd>
    </dl>
    <p class="small muted" style="margin:10px 0 0">Measured from aerial imagery${p.status === 'client' ? ' and confirmed on site' : '; confirmed at your walkthrough'}.</p>
  </div>`;
}

async function drawMiniMap(p) {
  const el = $('#mini-map');
  if (!el || !window.L) return;
  const map = L.map(el, { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false });
  aerialLayer(await pickSource(p.lon, p.lat)).addTo(map);
  const lot = L.polygon(p.lot.map(([lon, lat]) => [lat, lon]), { color: '#fff', weight: 3, fillColor: '#56d660', fillOpacity: 0.15 }).addTo(map);
  map.fitBounds(lot.getBounds().pad(0.2), { maxZoom: 20 });
}

async function showProperty(id) {
  currentId = id;
  const { property: p, visits, planTasks } = await api('GET', `/api/properties/${id}`);
  const isClient = p.status === 'client';
  const firstName = esc(me.user.name.split(' ')[0]);
  const others = me.properties.length > 1
    ? `<select id="switch" aria-label="Choose a property" style="max-width:340px">${me.properties.map((x) => `<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${esc(x.address)}</option>`).join('')}</select>`
    : `<span class="muted">${esc(p.address)}</span>`;

  let next = '';
  if (p.nextVisit) {
    next = `<div class="card" style="background:var(--green-900);color:#fff;border:0">
      <div class="small" style="color:#e3c377;font-weight:600;letter-spacing:.08em;text-transform:uppercase">${isClient ? 'Next visit' : 'Your walkthrough'}</div>
      <div style="font:600 1.5rem var(--serif)">${esc(fmtDate(p.nextVisit.date))}</div>
      ${p.nextVisit.note ? `<div class="small" style="color:#c5d8c7">${esc(p.nextVisit.note)}</div>` : ''}
    </div>`;
  } else if (!isClient) {
    next = `<div class="card" style="background:var(--green-900);color:#fff;border:0">
      <div style="font:600 1.3rem var(--serif)">Next step: your free walkthrough</div>
      <div class="small" style="color:#c5d8c7">We'll call or text within one business day to find a time. We walk the property together and confirm your fixed monthly price. Prefer to reach us? <a href="tel:+16159451614" style="color:#fff">(615) 945-1614</a></div>
    </div>`;
  }

  const history = visits.length
    ? visits.map((v) => visitHtml(v, p.id)).join('')
    : `<div class="empty">${isClient ? 'Your first visit report will appear here — a checklist of what we did, notes from your crew, and before & after photos.' : 'Once you\'re a client, every visit shows up here: the checklist we worked from, what was completed, notes from your crew, and before & after photos.'}</div>`;

  app.innerHTML = `
    <div class="dash-head"><div><h1>Hi, ${firstName}.</h1>${others}</div></div>
    ${p.status === 'lost' ? '' : stageHtml(p.status)}
    <div class="dash-grid">
      <div class="stack">
        ${next}
        ${isClient || visits.length ? statsHtml(visits) : ''}
        <div><h2 style="font-size:1.3rem">Visit reports</h2>${history}</div>
      </div>
      <div class="stack">
        ${planHtml(p)}
        ${whatsIncludedHtml(planTasks)}
        ${messagesHtml(p)}
        ${propertyHtml(p)}
      </div>
    </div>`;
  const thread = $('#thread');
  thread.scrollTop = thread.scrollHeight;
  drawMiniMap(p);
}

app.addEventListener('click', lightbox);
app.addEventListener('change', (e) => { if (e.target.id === 'switch') showProperty(e.target.value); });
app.addEventListener('submit', async (e) => {
  if (e.target.id !== 'msg-form') return;
  e.preventDefault();
  const text = $('#msg').value.trim();
  if (!text) return;
  try {
    await api('POST', `/api/properties/${currentId}/messages`, { text });
    toast('Note sent to your crew');
    showProperty(currentId);
  } catch (err) { toast(err.message); }
});
$('#signout').addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.href = '/'; });

async function start() {
  me = await api('GET', '/api/me');
  if (!me.user) return signedOut();
  if (me.user.role === 'admin') { location.href = '/admin.html'; return; }
  $('#who').textContent = me.user.email;
  $('#signout').hidden = false;
  if (!me.properties.length) {
    app.innerHTML = `<div class="card auth-box" style="text-align:center"><h1 style="font-size:1.6rem">Welcome, ${esc(me.user.name.split(' ')[0])}.</h1><p class="muted">You don't have a property on your account yet. Measure your yard to get started.</p><a class="btn" href="/">Get my monthly price</a></div>`;
    return;
  }
  // Prefer an active plan over older estimates.
  const first = me.properties.find((p) => p.status === 'client') || me.properties[0];
  await showProperty(first.id);
}

start().catch((err) => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
