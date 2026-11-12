import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { fileStore } from '../src/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curb-agreement-'));
const app = createApp(fileStore(dir), { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'owner-password-1' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = { cookie, host: 'site.test', origin: 'http://site.test', 'user-agent': 'test-browser', 'x-forwarded-for': '203.0.113.9' };
    if (body) headers['content-type'] = 'application/json';
    const res = await app(new Request(`http://site.test${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

test('annual agreement: owner sends, client e-signs, record is frozen', async () => {
  const pat = client();
  const owner = client();
  const stranger = client();
  const created = await pat('POST', '/api/estimates', {
    address: '1 Test St, Franklin, TN, 37064', lat: 35.92, lon: -86.87,
    lot: [[-86.87, 35.92], [-86.869, 35.92], [-86.869, 35.921]],
    measurements: { lawnSqft: 8000, shrubCount: 15, bedSqft: 210, buildingSqft: 2500 },
    selections: { addons: { patioDetail: true } },
  });
  const id = created.data.property.id;
  await pat('POST', '/api/auth/signup', { name: 'Pat Client', email: 'pat@example.com', password: 'correct horse', estimateId: id, claimToken: created.data.claimToken });
  await owner('POST', '/api/auth/login', { email: 'owner@example.com', password: 'owner-password-1' });
  await stranger('POST', '/api/auth/signup', { name: 'Sam Other', email: 'sam@example.com', password: 'password123' });

  // Can't send without a confirmed price; customers can't send at all.
  assert.equal((await owner('POST', `/api/admin/properties/${id}/agreement`, { startDate: '2027-01-01' })).status, 400);
  assert.equal((await pat('POST', `/api/admin/properties/${id}/agreement`, { startDate: '2027-01-01' })).status, 403);
  await owner('PATCH', `/api/admin/properties/${id}`, { finalMonthly: 425 });
  const sent = await owner('POST', `/api/admin/properties/${id}/agreement`, { startDate: '2027-01-01' });
  assert.equal(sent.status, 201);

  // The client sees exactly what will be signed.
  const seen = (await pat('GET', `/api/properties/${id}`)).data.property.agreement;
  assert.equal(seen.status, 'sent');
  assert.match(seen.text, /Pat Client/);
  assert.match(seen.text, /\$425 per month, in 12 equal monthly payments \(\$5,100 over the term\)/);
  assert.match(seen.text, /January 1, 2027/);
  assert.match(seen.text, /Porch & patio detailing/);
  assert.match(seen.text, /Wipe down front porch entryway/);
  assert.match(seen.hash, /^[0-9a-f]{64}$/);

  // Signing needs the right person, a full name, consent, and the current text.
  const sign = (who, body) => who('POST', `/api/properties/${id}/agreement/sign`, body);
  const good = { name: 'Pat Q. Client', consent: true, hash: seen.hash };
  assert.equal((await sign(stranger, good)).status, 403);
  assert.equal((await sign(owner, good)).status, 403);
  assert.equal((await sign(pat, { ...good, name: 'Pat' })).status, 400);
  assert.equal((await sign(pat, { ...good, consent: false })).status, 400);
  assert.equal((await sign(pat, { ...good, hash: 'stale' })).status, 409);
  const signed = await sign(pat, good);
  assert.equal(signed.status, 200);
  const a = signed.data.property.agreement;
  assert.equal(a.status, 'signed');
  assert.equal(a.signature.name, 'Pat Q. Client');
  assert.equal(a.signature.email, 'pat@example.com');
  assert.equal(a.signature.ip, '203.0.113.9');
  assert.equal(signed.data.property.status, 'client');

  // Signed means frozen: no re-signing, re-sending or withdrawing, and later
  // price or terms changes don't touch the signed copy.
  assert.equal((await sign(pat, good)).status, 409);
  assert.equal((await owner('POST', `/api/admin/properties/${id}/agreement`, { startDate: '2027-02-01' })).status, 409);
  assert.equal((await owner('DELETE', `/api/admin/properties/${id}/agreement`)).status, 409);
  await owner('PATCH', `/api/admin/properties/${id}`, { finalMonthly: 999 });
  await owner('PUT', '/api/admin/agreement-terms', { terms: 'Completely different terms that are long enough to save.' });
  const after = (await pat('GET', `/api/properties/${id}`)).data.property.agreement;
  assert.equal(after.text, seen.text);
  assert.equal(after.hash, seen.hash);
  assert.equal(after.monthly, 425);
});

test('agreement terms are owner-editable and an unsigned agreement can be withdrawn', async () => {
  const owner = client();
  await owner('POST', '/api/auth/login', { email: 'owner@example.com', password: 'owner-password-1' });
  assert.equal((await client()('GET', '/api/admin/agreement-terms')).status, 401);
  assert.equal((await owner('PUT', '/api/admin/agreement-terms', { terms: 'too short' })).status, 400);
  const reset = await owner('PUT', '/api/admin/agreement-terms', { reset: true });
  assert.match(reset.data.terms, /thirty days/);

  const lee = client();
  const created = await lee('POST', '/api/estimates', { address: '2 Test St, Franklin, TN', lat: 35.92, lon: -86.87, lot: [[-86.87, 35.92], [-86.869, 35.92], [-86.869, 35.921]], measurements: { lawnSqft: 6000 }, selections: {} });
  const id = created.data.property.id;
  // No account yet: nobody to sign.
  await owner('PATCH', `/api/admin/properties/${id}`, { finalMonthly: 300 });
  assert.equal((await owner('POST', `/api/admin/properties/${id}/agreement`, { startDate: '2027-01-01' })).status, 400);
  await lee('POST', '/api/auth/signup', { name: 'Lee Client', email: 'lee@example.com', password: 'correct horse', estimateId: id, claimToken: created.data.claimToken });
  assert.equal((await owner('POST', `/api/admin/properties/${id}/agreement`, { startDate: '2027-01-01' })).status, 201);
  assert.equal((await owner('DELETE', `/api/admin/properties/${id}/agreement`)).status, 200);
  assert.equal((await lee('GET', `/api/properties/${id}`)).data.property.agreement, null);
});
