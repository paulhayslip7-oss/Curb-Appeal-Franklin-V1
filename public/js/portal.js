// Client dashboard: the plan, what's next, and a report for every visit.

import { $, api, authModal, esc, fmtDate, money, sqft, STATUS_LABEL, toast } from './common.js';
import { lightbox, visitHtml } from './visits.js';
import { aerialLayer, pickSource } from './imagery.js';
import { BUSINESS_PHONE, BUSINESS_SMS } from './agreement.js';

const app = $('#app');
let me = null;
let currentId = null;

function signedOut() {
  $('#signout').hidden = true;
  app.innerHTML = `
    <div class="card auth-box" style="text-align:center">
      <h1 style="font-size:2.2rem">Your Curb Appeal dashboard</h1>
      <p class="muted">See your plan, your next visit, and a photo report of everything we've done.</p>
      <p><button class="btn block" id="do-login">Sign in</button></p>
      <p class="small muted" style="margin:0">Not a client yet? <a href="/">Get your monthly price in a minute</a>.</p>
    </div>`;
  $('#do-login').addEventListener('click', async () => { if (await authModal('login')) start(); });
}

const STAGES = [['lead', 'Estimate saved'], ['walkthrough', 'Walkthrough'], ['agreement', 'Agreement'], ['client', 'Active plan']];
function stageHtml(status, agreement) {
  const idx = status === 'client' ? 3 : agreement?.status === 'sent' ? 2 : status === 'walkthrough' ? 1 : 0;
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
      <h2 style="font-size:1.7rem;margin:0">${isClient ? 'Your plan' : 'Your estimate'}</h2>
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
    <h2 style="font-size:1.7rem">What we do at your home</h2>
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
    <h2 style="font-size:1.7rem">Notes for your crew</h2>
    <div class="thread" id="thread">${msgs.length ? msgs.map((m) => `<div class="msg ${m.from === 'client' ? 'mine' : ''}">${esc(m.text)}<time>${m.from === 'client' ? 'You' : 'Curb Appeal'} · ${esc(fmtDate(m.at, { month: 'short', day: 'numeric' }))}</time></div>`).join('') : '<p class="small muted" style="margin:0">Gate code changed? Want to skip a week? Leave us a note here.</p>'}</div>
    <form id="msg-form"><label for="msg" class="small">New note</label><textarea id="msg" rows="2" maxlength="1500" required></textarea><button class="btn small" style="margin-top:10px">Send</button></form>
    <p class="small muted" style="margin:14px 0 0">Need a quick answer? <a href="${BUSINESS_SMS}">Text ${BUSINESS_PHONE}</a></p>
  </div>`;
}

function propertyHtml(p) {
  const m = p.measurements;
  return `<div class="card">
    <h2 style="font-size:1.7rem">Your property</h2>
    <div class="mini-map" id="mini-map"></div>
    <dl class="kv">
      <dt>Lot</dt><dd class="num">${sqft(m.lotSqft)} sq ft (${(m.lotSqft / 43560).toFixed(2)} ac)</dd>
      <dt>Lawn</dt><dd class="num">${sqft(m.lawnSqft)} sq ft</dd>
      <dt>Shrubs</dt><dd class="num">${sqft(m.shrubCount)}</dd>
      <dt>Hard surfaces</dt><dd class="num">${sqft(m.hardscapeSqft)} sq ft</dd>
    </dl>
    <p class="small muted" style="margin:10px 0 0">${p.lotSource === 'parcel' ? 'Lot line from the county parcel record. ' : ''}Measured from aerial imagery${p.status === 'client' ? ' and confirmed on site' : '; confirmed at your walkthrough'}.</p>
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

let currentProperty = null;

function agreementHtml(p) {
  const a = p.agreement;
  if (!a) return '';
  if (a.status === 'signed') {
    return `<div class="card">
      <div class="eyebrow" style="margin-bottom:10px">Service agreement</div>
      <div style="font:500 1.6rem/1.15 var(--serif)">Signed by ${esc(a.signature.name)}</div>
      <p class="small muted" style="margin:6px 0 14px">${esc(fmtDate(a.signature.at))} · ${money(a.monthly)} per month · ${a.termMonths} months from ${esc(fmtDate(a.startDate, { month: 'long', day: 'numeric', year: 'numeric' }))}</p>
      <button class="btn ghost small" data-agreement="view">View or print</button>
    </div>`;
  }
  return `<div class="card" style="border:1px solid var(--ink)">
    <div class="eyebrow" style="margin-bottom:10px">Ready for your signature</div>
    <div style="font:500 1.9rem/1.1 var(--serif)">Your annual service agreement</div>
    <p class="muted" style="margin:8px 0 16px">${money(a.monthly)} per month for ${a.termMonths} months, beginning ${esc(fmtDate(a.startDate, { month: 'long', day: 'numeric', year: 'numeric' }))}. Read it through and sign here. It takes about two minutes.</p>
    <button class="btn" data-agreement="sign">Review &amp; sign</button>
    <p class="small muted" style="margin:14px 0 0">A question first? <a href="${BUSINESS_SMS}">Text us at ${BUSINESS_PHONE}</a>.</p>
  </div>`;
}

function openAgreement(p, mode) {
  const a = p.agreement;
  const signed = a.status === 'signed';
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="ag-title">
      <button class="close" aria-label="Close">×</button>
      <h2 id="ag-title" style="font-size:2rem">${signed ? 'Your signed agreement' : 'Review and sign'}</h2>
      <div class="agreement-text" tabindex="0">${esc(a.text)}</div>
      ${signed ? `
        <p class="sig">Signed electronically by <strong>${esc(a.signature.name)}</strong> on ${esc(new Date(a.signature.at).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }))}.<br><span class="muted small">Document fingerprint ${esc(a.hash.slice(0, 16))}</span></p>
        <button class="btn" data-print>Print or save as PDF</button>` : `
        <form novalidate>
          <div class="field"><label for="ag-name">Type your full legal name to sign</label><input id="ag-name" autocomplete="name" required></div>
          <label style="display:flex;gap:10px;align-items:flex-start;font-weight:400"><input type="checkbox" id="ag-consent"><span>I have read this agreement, and I agree to sign it electronically.</span></label>
          <div class="error" role="alert"></div>
          <button class="btn block" type="submit">Sign agreement</button>
          <p class="small muted" style="margin:12px 0 0;text-align:center">Questions before you sign? <a href="${BUSINESS_SMS}">Text ${BUSINESS_PHONE}</a></p>
        </form>`}
    </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('.close')) close();
    if (e.target.closest('[data-print]')) {
      const w = window.open('', '_blank');
      if (!w) return toast('Allow pop-ups to print');
      const sig = `Signed electronically by ${a.signature.name} on ${new Date(a.signature.at).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })} (${a.signature.email}). Document fingerprint ${a.hash}.`;
      w.document.write(`<!doctype html><title>Service agreement</title><body style="font:15px/1.6 Georgia,serif;max-width:720px;margin:40px auto;padding:0 24px"><pre style="white-space:pre-wrap;font:inherit">${esc(a.text)}</pre><hr><p>${esc(sig)}</p></body>`);
      w.document.close();
      w.focus();
      w.print();
    }
  });
  back.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', back);
    btn.disabled = true;
    $('.error', back).textContent = '';
    try {
      await api('POST', `/api/properties/${p.id}/agreement/sign`, { name: $('#ag-name', back).value, consent: $('#ag-consent', back).checked, hash: a.hash });
      close();
      toast('Agreement signed. Welcome aboard.');
      await showProperty(p.id);
    } catch (err) {
      $('.error', back).textContent = err.message;
      btn.disabled = false;
    }
  });
  document.body.append(back);
  (signed ? $('.agreement-text', back) : $('#ag-name', back)).focus({ preventScroll: true });
}

async function showProperty(id) {
  currentId = id;
  const { property: p, visits, planTasks } = await api('GET', `/api/properties/${id}`);
  currentProperty = p;
  const isClient = p.status === 'client';
  const firstName = esc(me.user.name.split(' ')[0]);
  const others = me.properties.length > 1
    ? `<select id="switch" aria-label="Choose a property" style="max-width:340px">${me.properties.map((x) => `<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${esc(x.address)}</option>`).join('')}</select>`
    : `<span class="muted">${esc(p.address)}</span>`;

  let next = '';
  if (p.nextVisit) {
    next = `<div class="card" style="background:var(--green-900);color:#fff;border:0">
      <div style="color:#d9c391;font:var(--label);letter-spacing:.18em;text-transform:uppercase">${isClient ? 'Next visit' : 'Your walkthrough'}</div>
      <div style="font:500 2.3rem/1.1 var(--serif);margin:8px 0 4px">${esc(fmtDate(p.nextVisit.date))}</div>
      ${p.nextVisit.note ? `<div class="small" style="color:#c3cfc4">${esc(p.nextVisit.note)}</div>` : ''}
    </div>`;
  } else if (!isClient) {
    next = `<div class="card" style="background:var(--green-900);color:#fff;border:0">
      <div style="font:500 1.9rem/1.1 var(--serif);margin-bottom:8px">Next step: your free walkthrough</div>
      <div class="small" style="color:#c3cfc4">We'll call or text within one business day to find a time. We walk the property together and confirm your fixed monthly price. Prefer to reach us? <a href="${BUSINESS_SMS}" style="color:#fff">Text ${BUSINESS_PHONE}</a></div>
    </div>`;
  }

  const history = visits.length
    ? visits.map((v) => visitHtml(v, p.id)).join('')
    : `<div class="empty">${isClient ? 'Your first visit report will appear here — a checklist of what we did, notes from your crew, and before & after photos.' : 'Once you\'re a client, every visit shows up here: the checklist we worked from, what was completed, notes from your crew, and before & after photos.'}</div>`;

  app.innerHTML = `
    <div class="dash-head"><div><h1>Hi, ${firstName}.</h1>${others}</div></div>
    ${p.status === 'lost' ? '' : stageHtml(p.status, p.agreement)}
    <div class="dash-grid">
      <div class="stack">
        ${agreementHtml(p)}
        ${next}
        ${isClient || visits.length ? statsHtml(visits) : ''}
        <div><h2 style="font-size:1.7rem">Visit reports</h2>${history}</div>
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
app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-agreement]');
  if (b && currentProperty) openAgreement(currentProperty, b.dataset.agreement);
});
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
    app.innerHTML = `<div class="card auth-box" style="text-align:center"><h1 style="font-size:2.2rem">Welcome, ${esc(me.user.name.split(' ')[0])}.</h1><p class="muted">You don't have a property on your account yet. Measure your yard to get started.</p><a class="btn" href="/">Get my monthly price</a></div>`;
    return;
  }
  // Prefer an active plan over older estimates.
  const first = me.properties.find((p) => p.status === 'client') || me.properties[0];
  await showProperty(first.id);
}

start().catch((err) => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
