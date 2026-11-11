import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { fileStore } from '../src/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curb-test-'));
const app = createApp(fileStore(dir), { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'owner-password-1' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A minimal cookie-keeping client.
function client() {
  let cookie = '';
  return async (method, url, body, { form } = {}) => {
    const headers = { cookie, host: 'site.test', origin: 'http://site.test' };
    if (body && !form) headers['content-type'] = 'application/json';
    const res = await app(new Request(`http://site.test${url}`, { method, headers, body: form ? body : body ? JSON.stringify(body) : undefined }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data };
  };
}

const estimate = {
  address: '1 Test St, Franklin, TN, 37064', lat: 35.92, lon: -86.87,
  lot: [[-86.87, 35.92], [-86.869, 35.92], [-86.869, 35.921], [-86.87, 35.921]],
  measurements: { lotSqft: 12000, lawnSqft: 8000, shrubCount: 15, bedSqft: 210, hardscapeSqft: 1000, buildingSqft: 2500 },
  selections: { addons: { petWaste: true }, dogs: 1 },
};

test('full journey: estimate → account → client → visit report with photo', async () => {
  const visitor = client();
  const created = await visitor('POST', '/api/estimates', estimate);
  assert.equal(created.status, 201);
  const { property, claimToken } = created.data;
  assert.equal(property.status, 'estimate');
  assert.equal(property.quote.monthly, 437); // $350 grounds care + $87 pet waste
  assert.equal(property.claimHash, undefined, 'claim token must not leak back in the record');

  // Anonymous edits need the claim token.
  assert.equal((await client()('PUT', `/api/estimates/${property.id}`, { selections: {} })).status, 403);
  const edited = await visitor('PUT', `/api/estimates/${property.id}`, { claimToken, selections: { addons: {} } });
  assert.equal(edited.data.property.quote.monthly, 350);

  // Sign up: the estimate becomes a lead tied to the account.
  const signup = await visitor('POST', '/api/auth/signup', { name: 'Pat Client', email: 'Pat@Example.com', phone: '615-555-0100', password: 'correct horse', estimateId: property.id, claimToken });
  assert.equal(signup.status, 201);
  const me = await visitor('GET', '/api/me');
  assert.equal(me.data.user.email, 'pat@example.com');
  assert.equal(me.data.properties.length, 1);
  assert.equal(me.data.properties[0].status, 'lead');

  // Duplicate sign-up and wrong password are refused.
  assert.equal((await client()('POST', '/api/auth/signup', { name: 'X', email: 'pat@example.com', password: 'another one' })).status, 409);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'pat@example.com', password: 'nope nope' })).status, 401);

  // Customers can't reach admin routes; strangers can't see the property.
  assert.equal((await visitor('GET', '/api/admin/properties')).status, 403);
  assert.equal((await client()('GET', `/api/properties/${property.id}`)).status, 401);
  const stranger = client();
  await stranger('POST', '/api/auth/signup', { name: 'Sam', email: 'sam@example.com', password: 'password123' });
  assert.equal((await stranger('GET', `/api/properties/${property.id}`)).status, 403);

  // Owner converts the lead and logs a visit with a photo.
  const owner = client();
  assert.equal((await owner('POST', '/api/auth/login', { email: 'owner@example.com', password: 'wrong' })).status, 401);
  assert.equal((await owner('POST', '/api/auth/login', { email: 'owner@example.com', password: 'owner-password-1' })).status, 200);
  const list = await owner('GET', '/api/admin/properties');
  assert.equal(list.data.properties[0].contact.name, 'Pat Client');
  const patched = await owner('PATCH', `/api/admin/properties/${property.id}`, { status: 'client', finalMonthly: 199, adminNotes: 'gate code 1234', nextVisit: { date: '2026-12-01', note: 'First mow' } });
  assert.equal(patched.data.property.finalMonthly, 199);

  const form = new FormData();
  form.set('visit', JSON.stringify({ date: '2026-11-20', minutes: 45, crew: 'Paul', notes: 'All good', tasks: [{ label: 'Mow lawn', done: true }, { label: 'Edge', done: false, note: 'Too wet' }] }));
  form.set('tags', JSON.stringify(['after']));
  form.append('photos', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'a.jpg', { type: 'image/jpeg' }));
  const logged = await owner('POST', `/api/admin/properties/${property.id}/visits`, form, { form: true });
  assert.equal(logged.status, 201);
  const photoId = logged.data.visit.photos[0].id;

  // The client sees the plan, the visit and the photo — but never admin notes.
  const dash = await visitor('GET', `/api/properties/${property.id}`);
  assert.equal(dash.data.property.status, 'client');
  assert.equal(dash.data.property.adminNotes, undefined);
  assert.equal(dash.data.visits.length, 1);
  assert.equal(dash.data.visits[0].tasks[1].note, 'Too wet');
  const photo = await visitor('GET', `/api/photos/${property.id}/${photoId}`);
  assert.equal(photo.status, 200);
  assert.equal(photo.data.length, 4);
  assert.equal((await stranger('GET', `/api/photos/${property.id}/${photoId}`)).status, 403);

  // Active clients can't re-price themselves through the estimator.
  assert.equal((await visitor('PUT', `/api/estimates/${property.id}`, { selections: {} })).status, 409);

  // Messages go both ways.
  await visitor('POST', `/api/properties/${property.id}/messages`, { text: 'Please skip next week' });
  const thread = await owner('POST', `/api/properties/${property.id}/messages`, { text: 'Will do!' });
  assert.deepEqual(thread.data.messages.map((m) => m.from), ['client', 'team']);
});

test('pricing can be changed by the owner only', async () => {
  const owner = client();
  await owner('POST', '/api/auth/login', { email: 'owner@example.com', password: 'owner-password-1' });
  assert.equal((await client()('PUT', '/api/admin/pricing', { pricing: {} })).status, 401);
  const saved = await owner('PUT', '/api/admin/pricing', { pricing: { mowing: { base: 50 } } });
  assert.equal(saved.data.pricing.mowing.base, 50);
  assert.equal((await client()('GET', '/api/config')).data.pricing.mowing.base, 50);
  // Crew cost assumptions are for the owner's eyes only.
  assert.equal((await client()('GET', '/api/config')).data.pricing.labor, undefined);
  assert.equal((await owner('GET', '/api/config')).data.pricing.labor.loadedCostPerHour, 31);
  await owner('PUT', '/api/admin/pricing', { reset: true });
});

test('cross-site writes and bad input are rejected', async () => {
  const res = await app(new Request('http://site.test/api/auth/logout', { method: 'POST', headers: { host: 'site.test', origin: 'http://evil.test' } }));
  assert.equal(res.status, 403);
  assert.equal((await client()('POST', '/api/estimates', { address: 'x' })).status, 400);
  assert.equal((await client()('GET', '/api/lookup?address=nonumber')).status, 400);
  assert.equal((await client()('GET', '/api/properties/..%2Fconfig%2Fsecret')).status, 401);
});
