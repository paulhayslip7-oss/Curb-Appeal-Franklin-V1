// Owner admin: leads pipeline, client records, visit reports, pricing.

import { $, $$, api, authModal, esc, fmtDate, money, sqft, STATUS_LABEL, toast, todayIso } from './common.js';
import { ADDONS, CORE, jobEconomics, planTasks } from './pricing.js';
import { lightbox, visitHtml } from './visits.js';
import { agreementText } from './agreement.js';

const app = $('#app');
const state = { tab: 'pipeline', filter: 'open', properties: [], pricing: null, detail: null, photos: [] };
const STATUSES = ['estimate', 'lead', 'contacted', 'walkthrough', 'client', 'lost'];

async function load() {
  const [{ properties }, { pricing }] = await Promise.all([api('GET', '/api/admin/properties'), api('GET', '/api/config')]);
  state.properties = properties;
  state.pricing = pricing;
  state.terms = (await api('GET', '/api/admin/agreement-terms')).terms;
  state.reviews = (await api('GET', '/api/config')).reviews || [];
}

const econOf = (p) => jobEconomics(state.pricing, p.measurements, p.selections, p.finalMonthly || p.quote.monthly);
const priceOf = (p) => (p.finalMonthly ? `${money(p.finalMonthly)}/mo` : `${money(p.quote.low)}–${money(p.quote.high)}`);

// ---------- pipeline ----------
function pipelineHtml() {
  const filters = [['open', 'Open leads'], ['client', 'Clients'], ['estimate', 'Address only'], ['lost', 'Lost'], ['all', 'Everything']];
  const match = (p) =>
    state.filter === 'all' ? true : state.filter === 'open' ? ['lead', 'contacted', 'walkthrough'].includes(p.status) : p.status === state.filter;
  const rows = state.properties.filter(match);
  const count = (f) => state.properties.filter((p) => (f === 'all' ? true : f === 'open' ? ['lead', 'contacted', 'walkthrough'].includes(p.status) : p.status === f)).length;
  const mrr = state.properties.filter((p) => p.status === 'client').reduce((s, p) => s + (p.finalMonthly || p.quote.monthly), 0);
  const pipeline = state.properties.filter((p) => ['lead', 'contacted', 'walkthrough'].includes(p.status)).reduce((s, p) => s + p.quote.monthly, 0);
  return `
    <div class="stats" style="margin-bottom:20px">
      <div class="stat"><div class="v num">${count('client')}</div><div class="k">Active clients</div></div>
      <div class="stat"><div class="v num">${money(mrr)}</div><div class="k">Monthly recurring revenue</div></div>
      <div class="stat"><div class="v num">${count('open')}</div><div class="k">Open leads</div></div>
      <div class="stat"><div class="v num">${money(pipeline)}</div><div class="k">Monthly value in pipeline</div></div>
    </div>
    <div class="filters">${filters.map(([k, label]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-filter="${k}">${label} (${count(k)})</button>`).join('')}</div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Address</th><th>Contact</th><th>Status</th><th>Lawn</th><th>Add-ons</th><th>Monthly</th><th>Per crew hour</th><th>Created</th></tr></thead>
      <tbody>${rows.map((p) => `<tr data-open="${p.id}" tabindex="0">
        <td><strong>${esc(p.address)}</strong>${p.proposal ? ' <span class="pill lead">Over 1 acre</span>' : ''}${p.inquiry ? ' <span class="pill lead">Inquiry</span>' : ''}${(p.messages || []).at(-1)?.from === 'client' ? ' <span class="pill lead">New note</span>' : ''}</td>
        <td>${p.contact ? `${esc(p.contact.name)}<br><span class="small muted">${esc(p.contact.phone || p.contact.email)}</span>` : '<span class="muted">No account yet</span>'}</td>
        <td><span class="pill ${p.status}">${esc(STATUS_LABEL[p.status])}</span></td>
        <td class="num">${sqft(p.measurements.lawnSqft)} sq ft</td>
        <td class="num">${p.quote.addons.length}</td>
        <td class="num"><strong>${(p.proposal || p.inquiry) && !p.finalMonthly ? (p.inquiry ? 'To quote' : 'Proposal') : priceOf(p)}</strong></td>
        <td class="num" style="color:${econOf(p).onTarget ? 'var(--green-700)' : 'var(--red)'}">${money(econOf(p).revenuePerHour)}</td>
        <td class="small">${esc(fmtDate(p.createdAt, { month: 'short', day: 'numeric' }))}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing here yet. Every address entered on the website shows up in this list.</div>'}`;
}

// ---------- one property ----------
function detailHtml() {
  const { property: p, visits } = state.detail;
  const m = p.measurements;
  const c = state.properties.find((x) => x.id === p.id)?.contact;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}`;
  const lines = [p.quote.core, ...p.quote.addons];
  const tasks = planTasks(p.selections);
  const e = econOf(p);
  // Pre-tick what happens on a routine visit; seasonal work is ticked when it's done.
  const everyVisit = new Set([...CORE.tasks.filter((t) => !t.includes('late fall')), ...ADDONS.find((a) => a.key === 'petWaste').tasks]);
  return `
    <p><button class="linkbtn" data-back>← All properties</button></p>
    <div class="dash-head">
      <div><h1>${esc(p.address)}</h1><span class="pill ${p.status}">${esc(STATUS_LABEL[p.status])}</span> <a class="small" href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps ↗</a></div>
    </div>
    <div class="dash-grid">
      <div class="stack">
        <div class="card">
          <h2 style="font-size:1.7rem">Log a completed visit</h2>
          <p class="small muted">This becomes a report on the client's dashboard the moment you save it.</p>
          <form id="visit-form">
            <div class="row">
              <div class="field"><label for="v-date">Date</label><input id="v-date" type="date" value="${todayIso()}" required></div>
              <div class="field"><label for="v-min">Minutes on site</label><input id="v-min" type="number" min="0" max="1440" inputmode="numeric"></div>
              <div class="field"><label for="v-crew">Crew</label><input id="v-crew" maxlength="80"></div>
            </div>
            <label>Tasks <span class="muted" style="font-weight:400">— tick what was done today. Unticked tasks are left off the report unless you add a note saying why.</span></label>
            <div id="task-rows">${tasks.map((t) => taskRow(t, everyVisit.has(t))).join('')}</div>
            <p class="small"><button type="button" class="linkbtn" id="add-task">+ Add another task</button></p>
            <div class="field"><label for="v-notes">Note to the client</label><textarea id="v-notes" rows="2" maxlength="2000" placeholder="Anything they should know — a leaking sprinkler head, a loose fence board…"></textarea></div>
            <div class="field"><label for="v-photos">After photo <span class="muted" style="font-weight:400">(one is plenty)</span></label><input id="v-photos" type="file" accept="image/*" multiple><div class="photo-pick" id="photo-pick"></div></div>
            <div class="error" role="alert"></div>
            <button class="btn">Save visit report</button>
          </form>
        </div>
        <div><h2 style="font-size:1.7rem">Visit reports (${visits.length})</h2>${visits.length ? visits.map((v) => visitHtml(v, p.id, { admin: true })).join('') : '<div class="empty">No visits logged yet.</div>'}</div>
      </div>
      <div class="stack">
        <div class="card">
          <h2 style="font-size:1.7rem">Contact</h2>
          ${c ? `<dl class="kv"><dt>Name</dt><dd>${esc(c.name)}</dd><dt>Phone</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '—'}</dd><dt>Email</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd></dl>` : '<p class="muted small" style="margin:0">This visitor measured their yard but hasn\'t created an account yet. A door hanger or postcard to this address is your follow-up.</p>'}
        </div>
        ${p.inquiry ? `<div class="card" style="border-color:var(--ink)">
          <h2 style="font-size:1.7rem">Website inquiry</h2>
          <p class="small muted">Sent ${esc(fmtDate(p.inquiry.at, { month: 'short', day: 'numeric', year: 'numeric' }))} from the Get started form. Interested in:</p>
          <ul class="checks" style="margin-bottom:0">${[...(p.inquiry.wantsCore ? [CORE.label] : []), ...ADDONS.filter((a) => p.selections.addons[a.key]).map((a) => a.label)].map((l) => `<li>${esc(l)}</li>`).join('') || '<li class="skip">Nothing ticked</li>'}</ul>
          <p class="small muted" style="margin:12px 0 0">The property hasn't been measured yet, so the figures below are placeholders. Enter measurements after you walk it.</p>
        </div>` : ''}
        ${p.proposal ? `<div class="card" style="border-color:var(--ink)">
          <h2 style="font-size:1.7rem">Proposal request</h2>
          <dl class="kv"><dt>Property</dt><dd>${p.proposal.kind === 'commercial' ? 'Commercial' : 'Residential'}, about ${(m.lotSqft / 43560).toFixed(1)} acres</dd><dt>Requested</dt><dd>${esc(fmtDate(p.proposal.at, { month: 'short', day: 'numeric', year: 'numeric' }))}</dd></dl>
          ${p.proposal.notes ? `<div class="note">${esc(p.proposal.notes)}</div>` : ''}
          <p class="small muted" style="margin:10px 0 0">Over an acre, so no online price was shown. The figures below are placeholders until you walk it and set a confirmed price.</p>
        </div>` : ''}
        <div class="card">
          <h2 style="font-size:1.7rem">Status &amp; price</h2>
          <form id="status-form">
            <div class="field"><label for="s-status">Status</label><select id="s-status">${STATUSES.map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}</select></div>
            <div class="field"><label for="s-final">Confirmed monthly price <span class="muted" style="font-weight:400">(after walkthrough)</span></label><input id="s-final" type="number" min="0" inputmode="numeric" value="${p.finalMonthly ?? ''}" placeholder="Budgetary: ${money(p.quote.low)}–${money(p.quote.high)}"></div>
            <div class="row">
              <div class="field"><label for="s-next">Next visit / walkthrough</label><input id="s-next" type="date" value="${esc(p.nextVisit?.date || '')}"></div>
              <div class="field"><label for="s-next-note">Shown to client</label><input id="s-next-note" maxlength="300" value="${esc(p.nextVisit?.note || '')}" placeholder="e.g. Arriving 8–10am"></div>
            </div>
            <div class="field"><label for="s-notes">Private notes <span class="muted" style="font-weight:400">(never shown to the client)</span></label><textarea id="s-notes" rows="3" maxlength="4000">${esc(p.adminNotes || '')}</textarea></div>
            <button class="btn small">Save</button>
          </form>
        </div>
        <div class="card">
          <h2 style="font-size:1.7rem">Service agreement</h2>
          ${agreementAdminHtml(p, c)}
        </div>
        <div class="card" style="border-color:${e.onTarget ? 'var(--green-500)' : 'var(--red)'}">
          <h2 style="font-size:1.7rem">Does this job pay?</h2>
          <p class="small muted">At ${p.finalMonthly ? 'your confirmed price' : 'the calculated price'} of <strong>${money(p.finalMonthly || p.quote.monthly)}/mo</strong>, with a crew doing the work. Estimated from the measurements — check it against real time on site.</p>
          <dl class="kv">
            <dt>Yearly revenue</dt><dd class="num">${money(e.revenue)}</dd>
            <dt>Crew time</dt><dd class="num">~${e.hoursPerYear} hrs/yr (${e.minutesPerVisit} min on site per mowing visit)</dd>
            <dt>Crew cost at ${money(state.pricing.labor.loadedCostPerHour)}/hr</dt><dd class="num">−${money(e.laborCost)}</dd>
            <dt>Mulch</dt><dd class="num">−${money(e.materials)}</dd>
            <dt>Left for overhead &amp; profit</dt><dd class="num">${money(e.grossProfit)} (${e.grossMarginPct}%)</dd>
            <dt>Revenue per crew hour</dt><dd class="num" style="color:${e.onTarget ? 'var(--green-700)' : 'var(--red)'}">${money(e.revenuePerHour)} <span class="muted" style="font-weight:400">(target ${money(state.pricing.labor.targetRevenuePerHour)})</span></dd>
          </dl>
          ${e.onTarget ? '' : '<p class="warn" style="margin:10px 0 0">Below your target. Raise the confirmed price, or check whether the shrub and bed numbers are overstated.</p>'}
        </div>
        <div class="card">
          <h2 style="font-size:1.7rem">Plan &amp; measurements</h2>
          <p class="small muted">Correct these after the walkthrough — the quote recalculates from your pricing.</p>
          <form id="plan-form">
            <div class="row">
              ${[['lawnSqft', 'Lawn sq ft'], ['shrubCount', 'Shrubs'], ['bedSqft', 'Bed sq ft'], ['hardscapeSqft', 'Hard surface sq ft'], ['buildingSqft', 'Roof sq ft']].map(([k, l]) => `<div class="field"><label for="m-${k}">${l}</label><input id="m-${k}" data-m="${k}" type="number" min="0" inputmode="numeric" value="${m[k] || 0}"></div>`).join('')}
              <div class="field"><label for="m-dogs">Dogs</label><input id="m-dogs" type="number" min="1" max="8" value="${p.selections.dogs || 1}"></div>
            </div>
            ${ADDONS.map((a) => `<label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-bottom:6px"><input type="checkbox" data-addon="${a.key}" ${p.selections.addons[a.key] ? 'checked' : ''}>${esc(a.label)}${state.pricing.addons[a.key].enabled ? '' : ' <span class="muted small">(not offered)</span>'}</label>`).join('')}
            <button class="btn small" style="margin-top:8px">Recalculate &amp; save</button>
          </form>
          <ul class="plan-list">${lines.map((l) => `<li><span><strong>${esc(l.label)}</strong><br><span class="cad">${money(l.perVisit)} × ${l.visitsPerYear} visits/yr${l.materials ? ` + ${money(l.materials)} mulch` : ''}</span></span><span class="num">${money(l.monthly)}/mo</span></li>`).join('')}
            ${p.quote.discountPct ? `<li><span>Bundle discount (${p.quote.discountPct}%)</span><span class="num">−${money(p.quote.discountMonthly)}/mo</span></li>` : ''}
            <li><strong>Calculated</strong><strong class="num">${money(p.quote.monthly)}/mo · ${money(p.quote.annual)}/yr</strong></li>
            <li><span>Range shown to prospect</span><span class="num">${money(p.quote.low)}–${money(p.quote.high)}</span></li>
          </ul>
          <dl class="kv" style="margin-top:10px"><dt>Lot</dt><dd class="num">${sqft(m.lotSqft)} sq ft (${(m.lotSqft / 43560).toFixed(2)} ac)</dd><dt>Lot outline</dt><dd>${p.lotSource === 'parcel' ? 'County parcel record' : 'Estimated'}</dd>${m.edited ? '<dt>Measurements</dt><dd>Edited by hand</dd>' : ''}</dl>
        </div>
        <div class="card">
          <h2 style="font-size:1.7rem">Messages</h2>
          <div class="thread" id="thread">${(p.messages || []).length ? p.messages.map((x) => `<div class="msg ${x.from === 'team' ? 'mine' : ''}">${esc(x.text)}<time>${x.from === 'team' ? 'You' : 'Client'} · ${esc(fmtDate(x.at, { month: 'short', day: 'numeric' }))}</time></div>`).join('') : '<p class="small muted" style="margin:0">No messages yet.</p>'}</div>
          ${p.userId ? '<form id="msg-form"><label for="msg" class="small">Reply</label><textarea id="msg" rows="2" maxlength="1500" required></textarea><button class="btn small" style="margin-top:8px">Send</button></form>' : ''}
        </div>
        <p><button class="btn danger small" id="delete-property">Delete this property</button></p>
      </div>
    </div>`;
}

function agreementAdminHtml(p, contact) {
  const a = p.agreement;
  if (a?.status === 'signed') {
    return `<p style="margin:0 0 8px"><span class="pill client">Signed</span></p>
      <dl class="kv"><dt>Signed by</dt><dd>${esc(a.signature.name)}</dd><dt>When</dt><dd>${esc(new Date(a.signature.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</dd><dt>Account</dt><dd>${esc(a.signature.email)}</dd><dt>IP address</dt><dd>${esc(a.signature.ip || '—')}</dd><dt>Price</dt><dd class="num">${money(a.monthly)}/mo × ${a.termMonths}</dd><dt>Starts</dt><dd>${esc(fmtDate(a.startDate, { month: 'short', day: 'numeric', year: 'numeric' }))}</dd></dl>
      <details style="margin-top:12px"><summary class="linkbtn">Read the signed text</summary><div class="agreement-text" style="margin-top:10px">${esc(a.text)}</div><p class="small muted">Fingerprint ${esc(a.hash)}</p></details>`;
  }
  if (a?.status === 'sent') {
    return `<p style="margin:0 0 8px"><span class="pill lead">Waiting for signature</span></p>
      <p class="small muted">Sent ${esc(fmtDate(a.sentAt, { month: 'short', day: 'numeric' }))} at ${money(a.monthly)}/mo, starting ${esc(fmtDate(a.startDate, { month: 'short', day: 'numeric', year: 'numeric' }))}. It is waiting on the client's dashboard. Signing makes them an active client automatically.</p>
      <details><summary class="linkbtn">Read what was sent</summary><div class="agreement-text" style="margin-top:10px">${esc(a.text)}</div></details>
      <p style="margin:14px 0 0"><button class="btn danger small" id="withdraw-agreement">Withdraw agreement</button></p>`;
  }
  if (!contact) return '<p class="small muted" style="margin:0">Once this visitor creates an account you can send them an agreement to sign.</p>';
  if (!p.finalMonthly) return '<p class="small muted" style="margin:0">Save a confirmed monthly price above, then you can send the agreement for e-signature.</p>';
  return `<p class="small muted">Sends a 12-month agreement at <strong>${money(p.finalMonthly)}/mo</strong> for the plan below to ${esc(contact.name)}'s dashboard to sign. Change the plan or price first if needed.</p>
    <form id="agreement-form">
      <div class="field"><label for="a-start">Service start date</label><input id="a-start" type="date" value="${todayIso()}" required></div>
      <div class="error" role="alert"></div>
      <button class="btn small">Send for signature</button>
    </form>`;
}

function reviewsHtml() {
  return `
    <p class="muted" style="max-width:70ch">Reviews you add here appear on the home page. Only add real reviews from real clients, word for word, and say where each one came from. Posting invented reviews is against FTC rules and Google's terms.</p>
    ${state.reviews.length ? `<div class="table-wrap" style="margin:18px 0"><table><thead><tr><th>Name</th><th>Review</th><th>Stars</th><th>Source</th><th></th></tr></thead><tbody>${state.reviews.map((r, i) => `<tr style="cursor:default"><td>${esc(r.name)}</td><td style="display:table-cell">${esc(r.text)}</td><td style="display:table-cell">${r.stars}</td><td>${esc(r.source)}</td><td style="display:table-cell"><button class="btn danger small" data-del-review="${i}">Remove</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="margin:18px 0">No reviews yet. The reviews section stays hidden on the home page until you add one.</div>'}
    <form id="review-form" class="card" style="max-width:640px">
      <h2 style="font-size:1.7rem">Add a review</h2>
      <div class="row">
        <div class="field"><label for="rv-name">Client's name</label><input id="rv-name" maxlength="60" required></div>
        <div class="field"><label for="rv-source">Where it was posted</label><input id="rv-source" maxlength="40" placeholder="Google review" value="Google review"></div>
        <div class="field" style="flex:0 1 110px"><label for="rv-stars">Stars</label><select id="rv-stars"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select></div>
      </div>
      <div class="field"><label for="rv-text">Their words, exactly</label><textarea id="rv-text" rows="4" maxlength="600" required></textarea></div>
      <div class="error" role="alert"></div>
      <button class="btn small">Add review</button>
    </form>`;
}

function termsHtml() {
  const sample = agreementText({ clientName: 'Pat Client', address: '123 Example Ln, Franklin, TN', monthly: 485, startDate: todayIso(), termMonths: 12, services: [{ label: CORE.label, cadence: CORE.cadence }], tasks: CORE.tasks, terms: state.terms });
  return `
    <p class="muted" style="max-width:70ch">This is section 4 of every agreement you send. The client's name, property, services, price and dates are filled in automatically. Changes apply to agreements sent from now on; signed agreements never change.</p>
    <p class="warn" style="max-width:70ch">These default terms are a plain-English starting point, not legal advice. Have a Tennessee attorney read them before you rely on them, especially payment, cancellation and liability.</p>
    <form id="terms-form" style="margin-top:18px">
      <div class="field"><label for="terms">Terms</label><textarea id="terms" rows="16" maxlength="12000">${esc(state.terms)}</textarea></div>
      <div class="error" role="alert"></div>
      <button class="btn">Save terms</button> <button type="button" class="btn ghost" id="reset-terms">Reset to default</button>
    </form>
    <h2 style="font-size:1.7rem;margin-top:36px">What the client will read</h2>
    <div class="agreement-text" style="max-height:none">${esc(sample)}</div>`;
}

const taskRow = (label, done) => `<div class="task-row"><input type="checkbox" ${done ? 'checked' : ''} aria-label="Done"><input type="text" class="lbl" value="${esc(label)}" maxlength="120" aria-label="Task"><input type="text" class="why" maxlength="200" placeholder="Note (optional)" aria-label="Note"></div>`;

/** Shrink a phone photo to a web-friendly JPEG before upload. */
async function shrink(file, max = 1600) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob || file;
  } catch {
    return file; // unsupported format (e.g. HEIC on some browsers) — let the server decide
  }
}

function renderPhotoPick() {
  $('#photo-pick').innerHTML = state.photos.map((ph, i) => `<div class="ph"><img src="${ph.url}" alt="Photo ${i + 1}"><select data-tag="${i}" aria-label="Photo ${i + 1} label"><option value="">No label</option><option value="before" ${ph.tag === 'before' ? 'selected' : ''}>Before</option><option value="after" ${ph.tag === 'after' ? 'selected' : ''}>After</option></select></div>`).join('');
}

// ---------- pricing ----------
const LABELS = {
  base: 'Lawn: base per visit ($)', per1kFirst10k: 'Lawn: per 1,000 sq ft, first 10k ($)', per1kAfter10k: 'Lawn: per 1,000 sq ft after 10k ($)', minPerVisit: 'Minimum per visit ($)', visitsPerYear: 'Visits per year',
  upkeepPerShrub: 'Bed & shrub upkeep: per shrub, per visit ($)', upkeepPerBedSqft: 'Bed & shrub upkeep: per sq ft of bed, per visit ($)', minUpkeepPerVisit: 'Bed & shrub upkeep: minimum per visit ($)', mulchPerCubicYard: 'Mulch top-ups: per cubic yard ($)', mulchInchesPerYear: 'Mulch top-ups: inches added per year',
  loadedCostPerHour: 'Crew cost per hour, with taxes & insurance ($)', targetRevenuePerHour: 'Target revenue per crew hour ($)', driveMinutesPerVisit: 'Drive time per visit (minutes)', mowSqftPerHour: 'Mowing speed: sq ft per hour, one person',
  perShrub: 'Per shrub ($)', perBedSqft: 'Per sq ft of bed ($)', perVisit: 'Per visit ($)', perExtraDog: 'Per extra dog ($)', perSqft: 'Per sq ft ($)', mowMultiple: 'Multiple of a mowing visit (×)',
  perCubicYard: 'Per cubic yard installed ($)', depthInches: 'Mulch depth (inches)', perRoofSqft: 'Per sq ft of roof ($)', per1k: 'Per 1,000 sq ft of lawn ($)',
};
function pricingHtml() {
  const pr = state.pricing;
  const fields = (group, obj) => Object.entries(obj).filter(([k]) => k !== 'enabled').map(([k, v]) => `<div class="f"><label for="p-${group}-${k}" style="margin:0;font-weight:400">${LABELS[k] || k}</label><input id="p-${group}-${k}" type="number" step="any" min="0" data-p="${group}.${k}" value="${v}"></div>`).join('');
  return `
    <p class="muted">These numbers drive every estimate on the website. Each service is priced per visit, multiplied by visits per year, and spread over 12 equal monthly payments. Changes apply to new estimates right away.</p>
    <form id="pricing-form">
      <div class="pricing-grid">
        <div class="card"><h3>${esc(CORE.label)} (core plan)</h3><p class="small muted">Per visit = lawn + bed &amp; shrub upkeep. The year's mulch is added on top, then everything is split into 12 payments.</p>${fields('mowing', pr.mowing)}</div>
        ${ADDONS.map((a) => `<div class="card"><h3><span>${esc(a.label)}</span><label style="margin:0;display:inline-flex;gap:6px;align-items:center;font:400 .8rem var(--sans)"><input type="checkbox" data-enabled="${a.key}" ${pr.addons[a.key].enabled ? 'checked' : ''}>Offer</label></h3>
          ${a.key === 'lawnTreatment' ? '<p class="warn">Applying fertilizer or weed killer for hire in Tennessee requires a state pest-control charter and a licensed applicator (TN Dept. of Agriculture). Leave this off until you are licensed or have a licensed subcontractor.</p>' : ''}
          ${fields(`addons.${a.key}`, pr.addons[a.key])}</div>`).join('')}
        <div class="card"><h3>Crew cost assumptions</h3><p class="small muted">Private — used only for the "Does this job pay?" check on each property. Healthy maintenance companies bring in about $75–95 per crew hour and keep crew cost near a third of revenue.</p>${fields('labor', pr.labor)}</div>
        <div class="card"><h3>Range &amp; bundle discount</h3>
          <div class="f"><label for="p-low" style="margin:0;font-weight:400">Range: below calculated (%)</label><input id="p-low" type="number" min="0" max="50" step="any" data-p="rangeLowPct" value="${pr.rangeLowPct}"></div>
          <div class="f"><label for="p-high" style="margin:0;font-weight:400">Range: above calculated (%)</label><input id="p-high" type="number" min="0" max="100" step="any" data-p="rangeHighPct" value="${pr.rangeHighPct}"></div>
          ${pr.bundle.map((b, i) => `<div class="f"><label for="p-b${i}" style="margin:0;font-weight:400">${b.count}+ add-ons: % off add-ons</label><input id="p-b${i}" type="number" min="0" max="50" step="any" data-bundle="${i}" value="${b.pct}"></div>`).join('')}
        </div>
      </div>
      <p style="margin-top:18px"><button class="btn">Save pricing</button> <button type="button" class="btn ghost" id="reset-pricing">Reset to defaults</button></p>
    </form>`;
}

// ---------- shell ----------
function render() {
  if (state.detail) { app.innerHTML = detailHtml(); const t = $('#thread'); if (t) t.scrollTop = t.scrollHeight; return; }
  app.innerHTML = `
    <div class="dash-head"><h1>Owner admin</h1></div>
    <div class="tabs" role="tablist"><button role="tab" class="${state.tab === 'pipeline' ? 'on' : ''}" data-tab="pipeline">Leads &amp; clients</button><button role="tab" class="${state.tab === 'pricing' ? 'on' : ''}" data-tab="pricing">Pricing</button><button role="tab" class="${state.tab === 'terms' ? 'on' : ''}" data-tab="terms">Agreement</button><button role="tab" class="${state.tab === 'reviews' ? 'on' : ''}" data-tab="reviews">Reviews</button></div>
    ${state.tab === 'pipeline' ? pipelineHtml() : state.tab === 'terms' ? termsHtml() : state.tab === 'reviews' ? reviewsHtml() : pricingHtml()}`;
}

async function openDetail(id) {
  state.detail = await api('GET', `/api/properties/${id}`);
  state.photos = [];
  render();
  window.scrollTo(0, 0);
}
const refreshDetail = async () => { await load(); await openDetail(state.detail.property.id); };

app.addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.tab) { state.tab = t.dataset.tab; render(); }
    else if (t.dataset.filter) { state.filter = t.dataset.filter; render(); }
    else if (t.closest('[data-open]')) await openDetail(t.closest('[data-open]').dataset.open);
    else if (t.closest('[data-back]')) { state.detail = null; await load(); render(); }
    else if (t.id === 'add-task') $('#task-rows').insertAdjacentHTML('beforeend', taskRow('', true));
    else if (t.dataset.deleteVisit) {
      if (!confirm('Delete this visit report and its photos? The client will no longer see it.')) return;
      await api('DELETE', `/api/admin/properties/${state.detail.property.id}/visits/${t.dataset.deleteVisit}`);
      await refreshDetail();
      toast('Report deleted');
    } else if (t.id === 'delete-property') {
      if (!confirm('Delete this property, its visit reports and photos? This cannot be undone.')) return;
      await api('DELETE', `/api/admin/properties/${state.detail.property.id}`);
      state.detail = null;
      await load();
      render();
      toast('Property deleted');
    } else if (t.dataset.delReview !== undefined) {
      if (!confirm('Remove this review from the home page?')) return;
      state.reviews = (await api('PUT', '/api/admin/reviews', { reviews: state.reviews.filter((_, i) => i !== Number(t.dataset.delReview)) })).reviews;
      render();
      toast('Review removed');
    } else if (t.id === 'withdraw-agreement') {
      if (!confirm('Withdraw this agreement? The client will no longer be able to sign it.')) return;
      await api('DELETE', `/api/admin/properties/${state.detail.property.id}/agreement`);
      await refreshDetail();
      toast('Agreement withdrawn');
    } else if (t.id === 'reset-terms') {
      if (!confirm('Replace your terms with the built-in default?')) return;
      state.terms = (await api('PUT', '/api/admin/agreement-terms', { reset: true })).terms;
      render();
      toast('Terms reset');
    } else if (t.id === 'reset-pricing') {
      if (!confirm('Reset every price to the built-in defaults?')) return;
      state.pricing = (await api('PUT', '/api/admin/pricing', { reset: true })).pricing;
      render();
      toast('Pricing reset');
    } else lightbox(e);
  } catch (err) { toast(err.message); }
});
app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.open) openDetail(e.target.dataset.open); });

app.addEventListener('change', async (e) => {
  if (e.target.id === 'v-photos') {
    for (const f of e.target.files) {
      if (state.photos.length >= 12) { toast('Up to 12 photos per visit'); break; }
      const blob = await shrink(f);
      state.photos.push({ blob, url: URL.createObjectURL(blob), tag: 'after' });
    }
    e.target.value = '';
    renderPhotoPick();
  } else if (e.target.dataset.tag !== undefined) {
    state.photos[Number(e.target.dataset.tag)].tag = e.target.value;
  }
});

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('button:not([type=button])', form);
  const id = state.detail?.property.id;
  btn.disabled = true;
  try {
    if (form.id === 'visit-form') {
      const tasks = $$('.task-row', form).map((r) => ({ done: $('input[type=checkbox]', r).checked, label: $('.lbl', r).value.trim(), note: $('.why', r).value.trim() })).filter((t) => t.label && (t.done || t.note));
      const fd = new FormData();
      fd.set('visit', JSON.stringify({ date: $('#v-date').value, minutes: Number($('#v-min').value) || 0, crew: $('#v-crew').value, notes: $('#v-notes').value, tasks }));
      fd.set('tags', JSON.stringify(state.photos.map((p) => p.tag)));
      state.photos.forEach((p, i) => fd.append('photos', p.blob, `photo-${i + 1}.jpg`));
      await api('POST', `/api/admin/properties/${id}/visits`, fd);
      await refreshDetail();
      toast('Visit report published to the client dashboard');
    } else if (form.id === 'status-form') {
      const date = $('#s-next').value;
      await api('PATCH', `/api/admin/properties/${id}`, { status: $('#s-status').value, finalMonthly: $('#s-final').value === '' ? null : Number($('#s-final').value), adminNotes: $('#s-notes').value, nextVisit: date ? { date, note: $('#s-next-note').value } : null });
      await refreshDetail();
      toast('Saved');
    } else if (form.id === 'plan-form') {
      const measurements = { ...state.detail.property.measurements };
      $$('[data-m]', form).forEach((i) => { measurements[i.dataset.m] = Number(i.value) || 0; });
      const addons = {};
      $$('[data-addon]', form).forEach((i) => { if (i.checked) addons[i.dataset.addon] = true; });
      await api('PATCH', `/api/admin/properties/${id}`, { measurements, selections: { addons, dogs: Number($('#m-dogs').value) || 1 } });
      await refreshDetail();
      toast('Plan recalculated');
    } else if (form.id === 'msg-form') {
      await api('POST', `/api/properties/${id}/messages`, { text: $('#msg').value });
      await refreshDetail();
    } else if (form.id === 'review-form') {
      const review = { name: $('#rv-name').value, text: $('#rv-text').value, stars: Number($('#rv-stars').value), source: $('#rv-source').value };
      state.reviews = (await api('PUT', '/api/admin/reviews', { reviews: [...state.reviews, review] })).reviews;
      render();
      toast('Review added to the home page');
    } else if (form.id === 'agreement-form') {
      await api('POST', `/api/admin/properties/${id}/agreement`, { startDate: $('#a-start').value });
      await refreshDetail();
      toast('Agreement sent to the client dashboard');
    } else if (form.id === 'terms-form') {
      state.terms = (await api('PUT', '/api/admin/agreement-terms', { terms: $('#terms').value })).terms;
      render();
      toast('Terms saved');
    } else if (form.id === 'pricing-form') {
      const pricing = structuredClone(state.pricing);
      $$('[data-p]', form).forEach((i) => {
        const path = i.dataset.p.split('.');
        const last = path.pop();
        path.reduce((o, k) => o[k], pricing)[last] = Number(i.value);
      });
      $$('[data-enabled]', form).forEach((i) => { pricing.addons[i.dataset.enabled].enabled = i.checked; });
      $$('[data-bundle]', form).forEach((i) => { pricing.bundle[Number(i.dataset.bundle)].pct = Number(i.value); });
      state.pricing = (await api('PUT', '/api/admin/pricing', { pricing })).pricing;
      render();
      toast('Pricing saved');
    }
  } catch (err) {
    const el = $('.error', form);
    if (el) el.textContent = err.message; else toast(err.message);
  } finally {
    if (btn.isConnected) btn.disabled = false;
  }
});

$('#signout').addEventListener('click', async () => { await api('POST', '/api/auth/logout'); location.href = '/'; });

async function start() {
  const { user } = await api('GET', '/api/me');
  if (user?.role !== 'admin') {
    app.innerHTML = `<div class="card auth-box" style="text-align:center"><h1 style="font-size:2.2rem">Owner sign-in</h1><p class="muted">${user ? 'You are signed in as a client. Sign out first, then sign in with the owner account.' : 'Sign in with the owner email and password.'}</p>${user ? '<a class="btn" href="/portal.html">Go to my dashboard</a>' : '<button class="btn block" id="do-login">Sign in</button>'}</div>`;
    $('#do-login')?.addEventListener('click', async () => { if (await authModal('login')) start(); });
    return;
  }
  $('#signout').hidden = false;
  await load();
  render();
}
start().catch((err) => { app.innerHTML = `<p class="error">${esc(err.message)}</p>`; });
