// Shared helpers for every page: API calls, formatting, sign-in modal.

export async function api(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Something went wrong (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape text for safe insertion into HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
export const sqft = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
export const fmtDate = (iso, opts = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) => {
  if (!iso) return '';
  // Date-only strings are local calendar dates, not UTC midnights.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('en-US', opts);
};
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function toast(text) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

// The estimate a not-yet-signed-in visitor is working on.
export const savedEstimate = {
  get() { try { return JSON.parse(localStorage.getItem('ca_estimate')) || null; } catch { return null; } },
  set(v) { try { localStorage.setItem('ca_estimate', JSON.stringify(v)); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem('ca_estimate'); } catch { /* private mode */ } },
};

export const STATUS_LABEL = { estimate: 'Estimate only', lead: 'New lead', contacted: 'Contacted', walkthrough: 'Walkthrough booked', client: 'Active client', lost: 'Lost' };

/**
 * Sign-in / create-account modal. Resolves with the user, or null if closed.
 * @param {'signup'|'login'} mode
 * @param {{ title?: string, intro?: string }} copy
 */
export function authModal(mode = 'login', copy = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const render = () => {
      const signup = mode === 'signup';
      back.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <button class="close" aria-label="Close">×</button>
          <h2 id="auth-title" style="font-size:1.5rem">${esc(signup ? copy.title || 'Create your account' : 'Welcome back')}</h2>
          <p class="muted small">${esc(signup ? copy.intro || 'Your dashboard keeps your estimate, your plan, and a record of every visit.' : 'Sign in to your Curb Appeal dashboard.')}</p>
          <form novalidate>
            ${signup ? `
            <div class="field"><label for="au-name">Full name</label><input id="au-name" name="name" autocomplete="name" required></div>
            <div class="field"><label for="au-phone">Mobile phone <span class="muted" style="font-weight:400">(so we can schedule your walkthrough)</span></label><input id="au-phone" name="phone" type="tel" autocomplete="tel"></div>` : ''}
            <div class="field"><label for="au-email">Email</label><input id="au-email" name="email" type="email" autocomplete="email" required></div>
            <div class="field"><label for="au-pass">Password${signup ? ' <span class="muted" style="font-weight:400">(8+ characters)</span>' : ''}</label><input id="au-pass" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="8"></div>
            <div class="error" role="alert"></div>
            <button class="btn block" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
          </form>
          <p class="small" style="margin:14px 0 0;text-align:center">
            ${signup ? 'Already have an account?' : 'New here?'}
            <button class="linkbtn" data-switch>${signup ? 'Sign in' : 'Create an account'}</button>
          </p>
        </div>`;
      $('input', back)?.focus();
    };
    const close = (user) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(user); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('.close')) close(null);
      if (e.target.closest('[data-switch]')) { mode = mode === 'signup' ? 'login' : 'signup'; render(); }
    });
    back.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const btn = $('button[type=submit]', form);
      const fields = Object.fromEntries(new FormData(form));
      const est = savedEstimate.get();
      btn.disabled = true;
      $('.error', form).textContent = '';
      try {
        const { user } = await api('POST', `/api/auth/${mode}`, { ...fields, estimateId: est?.id, claimToken: est?.claimToken });
        close(user);
      } catch (err) {
        $('.error', form).textContent = err.message;
        btn.disabled = false;
      }
    });
    render();
    document.body.append(back);
    $('input', back)?.focus();
  });
}

/** Wire up the header's account link: "Client sign in" or "My dashboard". */
export async function initHeader() {
  const link = $('#account-link');
  let user = null;
  try { ({ user } = await api('GET', '/api/me')); } catch { /* offline */ }
  if (link) {
    link.textContent = user ? (user.role === 'admin' ? 'Owner admin' : 'My dashboard') : 'Client sign in';
    link.href = user?.role === 'admin' ? '/admin.html' : '/portal.html';
  }
  return user;
}

export const dashboardUrl = (user) => (user?.role === 'admin' ? '/admin.html' : '/portal.html');
