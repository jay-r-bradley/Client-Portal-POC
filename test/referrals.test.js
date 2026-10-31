// Client referral program.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { MockCrm } = require('../src/zoho/mockCrm');
const { LiveCrm } = require('../src/zoho/liveCrm');
const { UserStore } = require('../src/store/userStore');
const { ActivityLog } = require('../src/store/activityLog');
const { referralProgress } = require('../src/referrals/referrals');

let server;
let base;
let activity;

test.before(async () => {
  const userStore = new UserStore(null);
  activity = new ActivityLog(null);
  await userStore.upsert({ email: 'admin@brokerage.example', password: 'admin-pass-1', name: 'Dana', role: 'admin' });
  await userStore.upsert({ email: 'alex@client.example', password: 'demo1234', contactId: 'c1', name: 'Alex' });
  await userStore.upsert({ email: 'priya@client.example', password: 'demo1234', contactId: 'c2', name: 'Priya' });
  const app = createApp({ config: { ...config, zohoMode: 'mock' }, crm: new MockCrm(config), userStore, activity });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(() => server.close());

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

const login = async (email, password = 'demo1234') => (await call('/auth/login', { method: 'POST', body: { email, password } })).cookie;
const friend = (overrides = {}) => ({
  name: 'Morgan Diaz', email: 'morgan@example.net', phone: '', interest: 'Land or a lot',
  notes: 'Wants acreage near Dripping Springs', consent: true, ...overrides,
});

test('a client refers a friend and sees only their own referrals', async () => {
  const alex = await login('alex@client.example');
  const created = await call('/referrals', { method: 'POST', cookie: alex, body: friend() });
  assert.equal(created.status, 201);
  assert.equal(created.body.referral.progress.label, 'Received');

  const mine = await call('/referrals', { cookie: alex });
  assert.deepEqual(mine.body.referrals.map((r) => r.name), ['Morgan Diaz', 'Sam Patel']);
  assert.ok(mine.body.interests.includes('Land or a lot'));
  assert.equal(mine.body.referrals[1].progress.label, 'Agent in touch');

  const priya = await call('/referrals', { cookie: await login('priya@client.example') });
  assert.ok(!priya.body.referrals.some((r) => r.name === 'Morgan Diaz'));
});

test('referrals need consent, a way to reach the person, and a known interest', async () => {
  const alex = await login('alex@client.example');
  assert.match((await call('/referrals', { method: 'POST', cookie: alex, body: friend({ email: 'x@example.net', consent: false }) })).body.error, /agreed to be contacted/);
  assert.equal((await call('/referrals', { method: 'POST', cookie: alex, body: friend({ email: '', phone: '' }) })).status, 400);
  assert.equal((await call('/referrals', { method: 'POST', cookie: alex, body: friend({ email: 'y@example.net', interest: 'Spaceships' }) })).status, 400);
  assert.equal((await call('/referrals', { method: 'POST', cookie: alex, body: friend() })).status, 409, 'duplicate email');
});

test('the activity log records the referral without the friend\'s contact details', async () => {
  const event = activity.query({ action: 'referral', limit: 1 }).items[0];
  assert.equal(event.target.name, 'Morgan Diaz');
  assert.equal(event.details.interest, 'Land or a lot');
  assert.ok(!JSON.stringify(event).includes('morgan@example.net'));
});

test('admins see every referral with the referring client; clients cannot', async () => {
  const admin = await login('admin@brokerage.example', 'admin-pass-1');
  const { body } = await call('/admin/referrals', { cookie: admin });
  const morgan = body.referrals.find((r) => r.name === 'Morgan Diaz');
  assert.equal(morgan.referrer.name, 'Alex Rivera');
  assert.ok(morgan.referrer.userId);
  assert.equal(body.referrals.length, 3);
  assert.equal((await call('/admin/referrals', { cookie: await login('alex@client.example') })).status, 403);
  assert.equal((await call('/admin/overview', { cookie: admin })).body.kpis.referrals30d, 1);
});

test('Zoho lead statuses map to the client-facing progress', () => {
  assert.equal(referralProgress('Not Contacted').label, 'Received');
  assert.equal(referralProgress('Attempted to Contact').label, 'Agent in touch');
  assert.equal(referralProgress('Pre-Qualified').label, 'Qualified');
  assert.equal(referralProgress('Junk Lead').label, 'Closed');
});

test('LiveCrm creates the referral as a Lead owned by the client\'s agent', async () => {
  const calls = [];
  const api = {
    getRecord: async () => ({ id: '101', Full_Name: 'Alex Rivera', Owner: { id: 'agent-9' } }),
    createRecord: async (module, record) => { calls.push({ module, record }); return { id: 'lead-1' }; },
  };
  const crm = new LiveCrm(config, { api });
  await crm.createReferral('101', { name: 'Morgan Diaz', firstName: 'Morgan', lastName: 'Diaz', email: 'm@example.net', phone: null, interest: 'Land or a lot', notes: 'Acreage' });
  const { module, record } = calls[0];
  assert.equal(module, 'Leads');
  assert.equal(record.Lead_Source, 'Client Referral');
  assert.deepEqual(record.Referred_By, { id: '101' });
  assert.deepEqual(record.Owner, { id: 'agent-9' });
  assert.equal(record.Inquiry_Type, 'Land or a lot');
  assert.equal(record.Last_Name, 'Diaz');
});
