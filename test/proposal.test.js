import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { fileStore } from '../src/store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curb-proposal-'));
const app = createApp(fileStore(dir), { ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'owner-password-1' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = { cookie, host: 'site.test', origin: 'http://site.test' };
    if (body) headers['content-type'] = 'application/json';
    const res = await app(new Request(`http://site.test${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}
const owner = client();
test.before(() => owner('POST', '/api/auth/login', { email: 'owner@example.com', password: 'owner-password-1' }));

test('over one acre: a proposal request lands in the owner pipeline with contact details', async () => {
  const visitor = client();
  const req = { address: '9 Big Lot Rd, Franklin, TN', lat: 35.9, lon: -86.85, lotSqft: 101740, lot: [[-86.85, 35.9], [-86.849, 35.9], [-86.849, 35.901]], lotSource: 'parcel', name: 'Dana Estate', phone: '615-555-0142', email: '', kind: 'commercial', notes: 'Gate on the north side.' };
  assert.equal((await visitor('POST', '/api/proposal-requests', { ...req, name: '' })).status, 400);
  assert.equal((await visitor('POST', '/api/proposal-requests', { ...req, phone: '', email: '' })).status, 400);
  assert.equal((await visitor('POST', '/api/proposal-requests', { ...req, email: 'not-an-email' })).status, 400);
  assert.equal((await visitor('POST', '/api/proposal-requests', req)).status, 201);

  const { properties } = (await owner('GET', '/api/admin/properties')).data;
  const p = properties.find((x) => x.address === req.address);
  assert.equal(p.status, 'lead');
  assert.deepEqual(p.contact, { name: 'Dana Estate', email: '', phone: '615-555-0142' });
  assert.equal(p.proposal.kind, 'commercial');
  assert.equal(p.proposal.notes, 'Gate on the north side.');
  assert.equal(p.measurements.lotSqft, 101740);
});

test('reviews: owner-managed, public to read, hidden when empty', async () => {
  assert.deepEqual((await client()('GET', '/api/config')).data.reviews, []);
  assert.equal((await client()('PUT', '/api/admin/reviews', { reviews: [] })).status, 401);
  const saved = await owner('PUT', '/api/admin/reviews', { reviews: [{ name: 'A. Client', text: 'Great work.', stars: 9, source: 'Google review' }, { name: '', text: 'no name' }] });
  assert.deepEqual(saved.data.reviews, [{ name: 'A. Client', text: 'Great work.', stars: 5, source: 'Google review' }]);
  assert.equal((await client()('GET', '/api/config')).data.reviews.length, 1);
});

test('get started form: every field is required and the inquiry lands in the pipeline', async () => {
  const good = { firstName: 'Jordan', lastName: 'Reed', phone: '(615) 555-0177', email: 'Jordan@Example.com', address: '12 Sample Ct, Franklin, TN', services: ['mowing', 'windows', 'not-a-service'] };
  for (const missing of ['firstName', 'lastName', 'phone', 'email', 'address']) {
    assert.equal((await client()('POST', '/api/inquiries', { ...good, [missing]: '' })).status, 400, missing);
  }
  assert.equal((await client()('POST', '/api/inquiries', good)).status, 201);
  const p = (await owner('GET', '/api/admin/properties')).data.properties.find((x) => x.address === good.address);
  assert.deepEqual(p.contact, { name: 'Jordan Reed', email: 'jordan@example.com', phone: '(615) 555-0177' });
  assert.equal(p.inquiry.wantsCore, true);
  assert.deepEqual(p.selections.addons, { windows: true });
  assert.equal(p.status, 'lead');
});
