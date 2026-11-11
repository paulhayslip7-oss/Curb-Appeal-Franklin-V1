// The whole API as one function: handle(Request) -> Response.
// It is written against web-standard Request/Response so the same code runs
// under the plain Node server (server.js) and as a Netlify Function.

import { lookupAddress, suggestAddresses } from './geo.js';
import { createToken, hashPassword, newId, readToken, safeEqual, userIdFor, verifyPassword } from './auth.js';
import { ADDONS, DEFAULT_PRICING, computeQuote, mergePricing, planTasks } from '../public/js/pricing.js';

export const STATUSES = ['estimate', 'lead', 'contacted', 'walkthrough', 'client', 'lost'];
const COOKIE = 'ca_session';
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const MAX_PHOTOS_PER_VISIT = 12;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const bad = (message, status = 400) => { throw new HttpError(status, message); };

// ---------- validation helpers ----------
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numIn = (v, lo, hi, fallback = 0) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

function cleanMeasurements(m = {}) {
  return {
    lotSqft: Math.round(numIn(m.lotSqft, 0, 500000)),
    lawnSqft: Math.round(numIn(m.lawnSqft, 0, 500000)),
    canopySqft: Math.round(numIn(m.canopySqft, 0, 500000)),
    buildingSqft: Math.round(numIn(m.buildingSqft, 0, 100000)),
    hardscapeSqft: Math.round(numIn(m.hardscapeSqft, 0, 200000)),
    bedSqft: Math.round(numIn(m.bedSqft, 0, 100000)),
    shrubCount: Math.round(numIn(m.shrubCount, 0, 500)),
    treeCount: Math.round(numIn(m.treeCount, 0, 500)),
    edited: Boolean(m.edited),
  };
}
function cleanSelections(s = {}) {
  const addons = {};
  for (const a of ADDONS) if (s.addons?.[a.key]) addons[a.key] = true;
  return { addons, dogs: Math.round(numIn(s.dogs, 1, 8, 1)) };
}
function cleanRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3 || ring.length > 40) return null;
  const out = ring.map((p) => [numIn(p?.[0], -180, 180, NaN), numIn(p?.[1], -90, 90, NaN)]);
  return out.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])) ? out : null;
}

// ---------- very small in-memory rate limiter (per server instance) ----------
const hits = new Map();
function rateLimit(req, bucket, max, windowMs = 60_000) {
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) bad('Too many requests — please wait a minute and try again.', 429);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
}

/**
 * @param store storage backend (see store.js)
 * @param env   { ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET }
 */
export function createApp(store, env = {}) {
  let secretPromise;
  const getSecret = () =>
    (secretPromise ??= (async () => {
      if (env.SESSION_SECRET) return env.SESSION_SECRET;
      let saved = await store.get('config/secret');
      if (!saved) {
        saved = { value: newId(32) };
        await store.set('config/secret', saved);
      }
      return saved.value;
    })());
  const getPricing = async () => mergePricing(await store.get('config/pricing'));

  async function session(req) {
    const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? readToken(m[1], await getSecret()) : null;
  }
  async function sessionCookie(req, data) {
    const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
    const value = data ? createToken(data, await getSecret()) : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${data ? 30 * 86400 : 0}${secure ? '; Secure' : ''}`;
  }
  const requireUser = async (req) => (await session(req)) || bad('Please sign in.', 401);
  const requireAdmin = async (req) => {
    const s = await session(req);
    if (s?.role !== 'admin') bad('Admin sign-in required.', s ? 403 : 401);
    return s;
  };
  const body = async (req) => {
    try {
      const data = await req.json();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return bad('Invalid request body.');
    }
  };

  const getProperty = async (id) => (/^[A-Za-z0-9]{6,24}$/.test(id) ? store.get(`properties/${id}`) : null);
  const saveProperty = (p) => store.set(`properties/${p.id}`, { ...p, updatedAt: new Date().toISOString() });
  const allProperties = async () => (await Promise.all((await store.list('properties/')).map((k) => store.get(k)))).filter(Boolean);
  const visitsFor = async (id) =>
    (await Promise.all((await store.list(`visits/${id}/`)).map((k) => store.get(k))))
      .filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1));

  // What a customer is allowed to see of a property record.
  const publicProperty = (p) => {
    const { claimHash, adminNotes, ...rest } = p;
    return rest;
  };
  const canAccess = (p, s, claimToken) =>
    s?.role === 'admin' || (p.userId && s?.uid === p.userId) || (!p.userId && claimToken && p.claimHash && safeEqual(claimToken, p.claimHash));

  async function attachEstimate(userId, estimateId, claimToken) {
    if (!estimateId) return;
    const p = await getProperty(String(estimateId));
    if (!p || p.userId || !claimToken || !safeEqual(claimToken, p.claimHash)) return;
    p.userId = userId;
    if (p.status === 'estimate') p.status = 'lead';
    await saveProperty(p);
  }

  const routes = [
    // ---------- public ----------
    // Pricing for the estimator. The owner's cost assumptions stay private.
    ['GET', '/api/config', async (req) => {
      const { labor, ...pricing } = await getPricing();
      return json({ pricing: (await session(req))?.role === 'admin' ? { ...pricing, labor } : pricing });
    }],

    // Type-ahead for the address box.
    ['GET', '/api/suggest', async (req, url) => {
      rateLimit(req, 'suggest', 150);
      const q = str(url.searchParams.get('q'), 120);
      return json({ suggestions: q.length >= 3 ? await suggestAddresses(q) : [] });
    }],

    ['GET', '/api/lookup', async (req, url) => {
      rateLimit(req, 'lookup', 20);
      const address = str(url.searchParams.get('address'), 160);
      if (address.length < 6 || !/\d/.test(address)) bad('Please enter a full street address, including the house number.');
      const found = await lookupAddress(address);
      if (!found) bad("We couldn't find that address. Check the spelling and include the city and state.", 404);
      return json(found);
    }],

    // Save an estimate. Anonymous visitors get a claim token so the estimate
    // can be attached to their account when they sign up.
    ['POST', '/api/estimates', async (req) => {
      rateLimit(req, 'estimate', 20);
      const b = await body(req);
      const s = await session(req);
      const address = str(b.address, 160);
      const lot = cleanRing(b.lot);
      if (!address || !lot) bad('Missing address or lot outline.');
      const measurements = cleanMeasurements(b.measurements);
      const selections = cleanSelections(b.selections);
      const claimToken = newId(18);
      const now = new Date().toISOString();
      const p = {
        id: newId(),
        userId: s && s.role !== 'admin' ? s.uid : null,
        claimHash: claimToken,
        status: s && s.role !== 'admin' ? 'lead' : 'estimate',
        address,
        lat: numIn(b.lat, -90, 90),
        lon: numIn(b.lon, -180, 180),
        lot,
        measurements,
        selections,
        quote: computeQuote(await getPricing(), measurements, selections),
        finalMonthly: null,
        nextVisit: null,
        adminNotes: '',
        messages: [],
        createdAt: now,
      };
      await saveProperty(p);
      return json({ property: publicProperty(p), claimToken }, 201);
    }],

    ['PUT', '/api/estimates/:id', async (req, url, { id }) => {
      rateLimit(req, 'estimate-update', 60);
      const b = await body(req);
      const p = (await getProperty(id)) || bad('Estimate not found.', 404);
      if (!canAccess(p, await session(req), str(b.claimToken, 80))) bad('Not allowed.', 403);
      // Once someone is a client their plan is set by the owner, not the estimator.
      if (p.status === 'client') bad('This property is on an active plan — message us to change it.', 409);
      if (b.lot) p.lot = cleanRing(b.lot) || p.lot;
      if (b.measurements) p.measurements = cleanMeasurements(b.measurements);
      if (b.selections) p.selections = cleanSelections(b.selections);
      p.quote = computeQuote(await getPricing(), p.measurements, p.selections);
      await saveProperty(p);
      return json({ property: publicProperty(p) });
    }],

    // ---------- accounts ----------
    ['POST', '/api/auth/signup', async (req) => {
      rateLimit(req, 'auth', 10);
      const b = await body(req);
      const email = str(b.email, 120).toLowerCase();
      const name = str(b.name, 80);
      const password = typeof b.password === 'string' ? b.password : '';
      if (!name) bad('Please enter your name.');
      if (!isEmail(email)) bad('Please enter a valid email address.');
      if (password.length < 8 || password.length > 200) bad('Choose a password of at least 8 characters.');
      if (env.ADMIN_EMAIL && email === env.ADMIN_EMAIL.toLowerCase()) bad('That email is already registered. Try signing in.', 409);
      const id = userIdFor(email);
      if (await store.get(`users/${id}`)) bad('That email is already registered. Try signing in.', 409);
      const user = { id, email, name, phone: str(b.phone, 30), passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
      await store.set(`users/${id}`, user);
      await attachEstimate(id, b.estimateId, str(b.claimToken, 80));
      return json({ user: { id, email, name, role: 'customer' } }, 201, { 'set-cookie': await sessionCookie(req, { uid: id, role: 'customer' }) });
    }],

    ['POST', '/api/auth/login', async (req) => {
      rateLimit(req, 'auth', 10);
      const b = await body(req);
      const email = str(b.email, 120).toLowerCase();
      const password = typeof b.password === 'string' ? b.password : '';
      if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && email === env.ADMIN_EMAIL.toLowerCase()) {
        if (!safeEqual(password, env.ADMIN_PASSWORD)) bad('Wrong email or password.', 401);
        return json({ user: { id: 'admin', email, name: 'Owner', role: 'admin' } }, 200, { 'set-cookie': await sessionCookie(req, { uid: 'admin', role: 'admin' }) });
      }
      const user = isEmail(email) ? await store.get(`users/${userIdFor(email)}`) : null;
      if (!user || !(await verifyPassword(password, user.passwordHash))) bad('Wrong email or password.', 401);
      await attachEstimate(user.id, b.estimateId, str(b.claimToken, 80));
      return json({ user: { id: user.id, email: user.email, name: user.name, role: 'customer' } }, 200, { 'set-cookie': await sessionCookie(req, { uid: user.id, role: 'customer' }) });
    }],

    ['POST', '/api/auth/logout', async (req) => json({ ok: true }, 200, { 'set-cookie': await sessionCookie(req, null) })],

    ['GET', '/api/me', async (req) => {
      const s = await session(req);
      if (!s) return json({ user: null });
      if (s.role === 'admin') return json({ user: { id: 'admin', name: 'Owner', role: 'admin' } });
      const user = await store.get(`users/${s.uid}`);
      if (!user) return json({ user: null });
      const properties = (await allProperties()).filter((p) => p.userId === s.uid).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json({ user: { id: user.id, email: user.email, name: user.name, phone: user.phone, role: 'customer' }, properties: properties.map(publicProperty) });
    }],

    // ---------- client dashboard ----------
    ['GET', '/api/properties/:id', async (req, url, { id }) => {
      const s = await requireUser(req);
      const p = (await getProperty(id)) || bad('Property not found.', 404);
      if (!canAccess(p, s)) bad('Not allowed.', 403);
      return json({ property: s.role === 'admin' ? p : publicProperty(p), visits: await visitsFor(id), planTasks: planTasks(p.selections) });
    }],

    ['POST', '/api/properties/:id/messages', async (req, url, { id }) => {
      rateLimit(req, 'message', 20);
      const s = await requireUser(req);
      const p = (await getProperty(id)) || bad('Property not found.', 404);
      if (!canAccess(p, s)) bad('Not allowed.', 403);
      const text = str((await body(req)).text, 1500);
      if (!text) bad('Write a message first.');
      p.messages = [...(p.messages || []), { id: newId(6), from: s.role === 'admin' ? 'team' : 'client', text, at: new Date().toISOString() }].slice(-200);
      await saveProperty(p);
      return json({ messages: p.messages }, 201);
    }],

    ['GET', '/api/photos/:id/:photoId', async (req, url, { id, photoId }) => {
      const s = await requireUser(req);
      const p = (await getProperty(id)) || bad('Not found.', 404);
      if (!canAccess(p, s) || !/^[A-Za-z0-9]{6,24}$/.test(photoId)) bad('Not allowed.', 403);
      const blob = (await store.getBlob(`photos/${id}/${photoId}`)) || bad('Not found.', 404);
      return new Response(blob.data, { headers: { 'content-type': blob.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
    }],

    // ---------- owner / admin ----------
    ['GET', '/api/admin/properties', async (req) => {
      await requireAdmin(req);
      const props = await allProperties();
      const users = new Map();
      await Promise.all([...new Set(props.map((p) => p.userId).filter(Boolean))].map(async (uid) => {
        const u = await store.get(`users/${uid}`);
        if (u) users.set(uid, { name: u.name, email: u.email, phone: u.phone });
      }));
      props.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json({ properties: props.map((p) => ({ ...publicProperty(p), adminNotes: p.adminNotes, contact: users.get(p.userId) || null })) });
    }],

    ['PATCH', '/api/admin/properties/:id', async (req, url, { id }) => {
      await requireAdmin(req);
      const b = await body(req);
      const p = (await getProperty(id)) || bad('Property not found.', 404);
      if (b.status !== undefined) p.status = STATUSES.includes(b.status) ? b.status : bad('Unknown status.');
      if (b.finalMonthly !== undefined) p.finalMonthly = b.finalMonthly === null || b.finalMonthly === '' ? null : Math.round(numIn(b.finalMonthly, 0, 100000));
      if (b.adminNotes !== undefined) p.adminNotes = str(b.adminNotes, 4000);
      if (b.nextVisit !== undefined) {
        const date = str(b.nextVisit?.date, 10);
        p.nextVisit = /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date, note: str(b.nextVisit.note, 300) } : null;
      }
      if (b.measurements) p.measurements = cleanMeasurements({ ...b.measurements, edited: true });
      if (b.selections) p.selections = cleanSelections(b.selections);
      if (b.measurements || b.selections) p.quote = computeQuote(await getPricing(), p.measurements, p.selections);
      await saveProperty(p);
      return json({ property: p });
    }],

    ['DELETE', '/api/admin/properties/:id', async (req, url, { id }) => {
      await requireAdmin(req);
      const p = (await getProperty(id)) || bad('Property not found.', 404);
      for (const v of await visitsFor(id)) {
        for (const ph of v.photos || []) await store.delete(`photos/${id}/${ph.id}`);
        await store.delete(`visits/${id}/${v.id}`);
      }
      await store.delete(`properties/${p.id}`);
      return json({ ok: true });
    }],

    // Log a completed visit: multipart form with a "visit" JSON field and
    // any number of "photos" files (plus a parallel "tags" JSON array).
    ['POST', '/api/admin/properties/:id/visits', async (req, url, { id }) => {
      await requireAdmin(req);
      const p = (await getProperty(id)) || bad('Property not found.', 404);
      let form;
      try { form = await req.formData(); } catch { bad('Expected a form upload.'); }
      let v;
      let tags;
      try {
        v = JSON.parse(form.get('visit') || '{}');
        tags = JSON.parse(form.get('tags') || '[]');
      } catch { bad('Invalid visit data.'); }
      const date = str(v.date, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('Pick the date of the visit.');
      const tasks = (Array.isArray(v.tasks) ? v.tasks : []).slice(0, 40).map((t) => ({ label: str(t?.label, 120), done: Boolean(t?.done), note: str(t?.note, 200) })).filter((t) => t.label);
      if (!tasks.length) bad('Add at least one task.');
      const files = form.getAll('photos').filter((f) => typeof f === 'object' && f.size > 0);
      if (files.length > MAX_PHOTOS_PER_VISIT) bad(`Up to ${MAX_PHOTOS_PER_VISIT} photos per visit.`);
      const photos = [];
      for (const [i, f] of files.entries()) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) bad('Photos must be JPEG, PNG or WebP.');
        if (f.size > MAX_PHOTO_BYTES) bad('Each photo must be under 4 MB.');
        const photoId = newId();
        await store.setBlob(`photos/${id}/${photoId}`, new Uint8Array(await f.arrayBuffer()), f.type);
        photos.push({ id: photoId, tag: ['before', 'after'].includes(tags[i]) ? tags[i] : '' });
      }
      const visit = {
        id: newId(),
        propertyId: id,
        date,
        minutes: Math.round(numIn(v.minutes, 0, 1440)),
        crew: str(v.crew, 80),
        tasks,
        notes: str(v.notes, 2000),
        photos,
        createdAt: new Date().toISOString(),
      };
      await store.set(`visits/${id}/${visit.id}`, visit);
      return json({ visit }, 201);
    }],

    ['DELETE', '/api/admin/properties/:id/visits/:visitId', async (req, url, { id, visitId }) => {
      await requireAdmin(req);
      if (!/^[A-Za-z0-9]{6,24}$/.test(id) || !/^[A-Za-z0-9]{6,24}$/.test(visitId)) bad('Not found.', 404);
      const v = (await store.get(`visits/${id}/${visitId}`)) || bad('Visit not found.', 404);
      for (const ph of v.photos || []) await store.delete(`photos/${id}/${ph.id}`);
      await store.delete(`visits/${id}/${visitId}`);
      return json({ ok: true });
    }],

    ['PUT', '/api/admin/pricing', async (req) => {
      await requireAdmin(req);
      const b = await body(req);
      const pricing = b.reset ? structuredClone(DEFAULT_PRICING) : mergePricing(b.pricing);
      await store.set('config/pricing', pricing);
      return json({ pricing });
    }],
  ].map(([method, pattern, fn]) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
    return { method, re, names, fn };
  });

  return async function handle(req) {
    const url = new URL(req.url);
    try {
      // Cookie-authenticated writes must come from our own pages.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.get('origin');
        const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
        if (origin && new URL(origin).host !== host) bad('Cross-site request blocked.', 403);
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        return await r.fn(req, url, params);
      }
      return json({ error: 'Not found.' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on our end. Please try again.' }, 500);
    }
  };
}
