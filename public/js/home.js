// The home page: services list, reviews, and the "Get started" form.

import { $, api, esc, initHeader } from './common.js';
import { ADDONS, CORE, DEFAULT_PRICING } from './pricing.js';

// Start from the built-in service list so the page works even if the
// data service is slow or down; the live settings replace it when they load.
const state = { pricing: DEFAULT_PRICING };

function renderServices() {
  const extras = ADDONS.filter((a) => state.pricing.addons[a.key]?.enabled);
  const card = (s) => `<div class="service"><h3>${esc(s.label)}</h3><p>${esc(s.blurb)}</p><p class="cad">${esc(s.cadence)}</p></div>`;
  $('#service-grid').innerHTML = `
    <div class="service core"><h3>${esc(CORE.label)} <span class="pill client">Every plan</span></h3><p>${esc(CORE.blurb)}</p><p class="cad">${esc(CORE.cadence)}</p></div>
    <div class="service-sub">Optional extras</div>
    ${extras.map(card).join('')}`;
}

// ---------- the home page's one call to action: a short inquiry form ----------
function inquiryModal() {
  const services = [CORE, ...ADDONS.filter((a) => state.pricing.addons[a.key]?.enabled)];
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="in-title">
      <button class="close" aria-label="Close">×</button>
      <h2 id="in-title" style="font-size:2.1rem">Let's get started.</h2>
      <p class="muted">Tell us where the property is and what you'd like handled. Paul will be in touch.</p>
      <form novalidate>
        <div class="row">
          <div class="field"><label for="in-first">First name</label><input id="in-first" name="firstName" autocomplete="given-name" required></div>
          <div class="field"><label for="in-last">Last name</label><input id="in-last" name="lastName" autocomplete="family-name" required></div>
        </div>
        <div class="row">
          <div class="field"><label for="in-phone">Phone number</label><input id="in-phone" name="phone" type="tel" autocomplete="tel" required></div>
          <div class="field"><label for="in-email">Email</label><input id="in-email" name="email" type="email" autocomplete="email" required></div>
        </div>
        <div class="field"><label for="in-address">Address for service</label><input id="in-address" name="address" autocomplete="street-address" required></div>
        <fieldset class="pick">
          <legend>Services you might bundle together</legend>
          ${services.map((s) => `<label><input type="checkbox" name="services" value="${s.key}"><span>${esc(s.label)}</span></label>`).join('')}
        </fieldset>
        <input name="company" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;min-height:0">
        <div class="error" role="alert"></div>
        <button class="btn block" type="submit">Send</button>
      </form>
    </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.close') || e.target.closest('[data-done]')) close(); });
  back.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const f = Object.fromEntries(fd);
    if (f.company) return close(); // spam bots fill hidden fields
    const picked = fd.getAll('services');
    const btn = $('button[type=submit]', back);
    btn.disabled = true;
    $('.error', back).textContent = '';
    // Two independent routes, so a lead is never lost to one of them failing:
    // the admin pipeline, and Netlify Forms (which emails the owner).
    const problem =
      [['firstName', 'your first name'], ['lastName', 'your last name'], ['phone', 'a phone number'], ['email', 'an email address'], ['address', 'the address for service']]
        .filter(([k]) => !String(f[k] || '').trim()).map(([, label]) => `Please enter ${label}.`)[0]
      || (String(f.phone).replace(/\D/g, '').length < 7 && 'Please enter a full phone number.')
      || (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(f.email).trim()) && 'Please enter a valid email address.');
    if (problem) {
      $('.error', back).textContent = problem;
      btn.disabled = false;
      return;
    }
    try {
      const labels = services.filter((s) => picked.includes(s.key)).map((s) => s.label);
      const saved = api('POST', '/api/inquiries', { firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email, address: f.address, services: picked });
      const emailed = fetch('/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'form-name': 'inquiry', first_name: f.firstName, last_name: f.lastName, phone: f.phone, email: f.email, address: f.address, services: labels.join(', ') || 'None selected' }),
      }).then((r) => { if (!r.ok) throw new Error('email route failed'); });
      const [a, b] = await Promise.allSettled([saved, emailed]);
      // A validation message from the server (bad email, etc.) is shown as is.
      if (a.status === 'rejected' && a.reason?.status === 400) throw a.reason;
      if (a.status === 'rejected' && b.status === 'rejected') throw new Error('We couldn\'t send that just now. Please text (615) 945-1614.');
      $('.modal', back).innerHTML = `
        <button class="close" aria-label="Close">×</button>
        <h2 style="font-size:2.1rem">Thank you, ${esc(f.firstName)}.</h2>
        <p class="muted">Paul will reach out shortly. If it's urgent, <a href="sms:+16159451614">text (615) 945-1614</a>.</p>
        <button class="btn block" data-done>Done</button>`;
    } catch (err) {
      $('.error', back).textContent = err.message;
      btn.disabled = false;
    }
  });
  document.body.append(back);
  $('#in-first', back).focus();
}
// The buttons are real links to /get-started.html, so they still work if
// this script never loads. When it does load, open the form in place instead.
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-start]')) return;
  try {
    inquiryModal();
    e.preventDefault();
  } catch (err) {
    console.error(err); // fall through to the plain page
  }
});


// ---------- start ----------
// The services are already in the page's HTML. Everything below is an
// optional refresh from live settings; any failure leaves the page as it is.
(async () => {
  initHeader().catch(() => {});
  try {
    const { pricing, reviews } = await api('GET', '/api/config');
    if (pricing?.addons) {
      state.pricing = pricing;
      renderServices();
    }
    if (reviews?.length) {
      $('#review-grid').innerHTML = reviews.map((r) => `<figure class="review"><div class="stars" role="img" aria-label="${r.stars} out of 5 stars">${'★'.repeat(r.stars)}</div><blockquote>${esc(r.text)}</blockquote><figcaption><strong>${esc(r.name)}</strong>${r.source ? ` · ${esc(r.source)}` : ''}</figcaption></figure>`).join('');
      $('#reviews').hidden = false;
    }
  } catch {
    // Keep what the page already shows.
  }
})();
