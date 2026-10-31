// End-to-end API tests against the mock CRM.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { MockCrm } = require('../src/zoho/mockCrm');
const { UserStore } = require('../src/store/userStore');
const { ActivityLog } = require('../src/store/activityLog');

let server;
let base;

test.before(async () => {
  const userStore = new UserStore(null); // in-memory
  await userStore.upsert({ email: 'alex@client.example', password: 'demo1234', contactId: 'c1', name: 'Alex' });
  await userStore.upsert({ email: 'priya@client.example', password: 'demo1234', contactId: 'c2', name: 'Priya' });
  const app = createApp({ config: { ...config, zohoMode: 'mock' }, crm: new MockCrm(config), userStore, activity: new ActivityLog(null) });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
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

async function login(email = 'alex@client.example', password = 'demo1234') {
  const res = await call('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(res.status, 200);
  return res.cookie;
}

test('portal endpoints require a session', async () => {
  for (const path of ['/dashboard', '/deals/d1', '/messages', '/auth/me']) {
    assert.equal((await call(path)).status, 401, path);
  }
});

test('login rejects a wrong password', async () => {
  const res = await call('/auth/login', { method: 'POST', body: { email: 'alex@client.example', password: 'nope' } });
  assert.equal(res.status, 401);
});

test('dashboard summarizes the client deals', async () => {
  const cookie = await login();
  const { status, body } = await call('/dashboard', { cookie });
  assert.equal(status, 200);
  assert.deepEqual({ total: body.summary.total, active: body.summary.active, won: body.summary.won, lost: body.summary.lost },
    { total: 4, active: 2, won: 1, lost: 1 });
  assert.ok(body.deals.every((d) => d.contactId === 'c1'));
});

test('a client cannot open another client\'s deal', async () => {
  const cookie = await login();
  assert.equal((await call('/deals/d5', { cookie })).status, 404);
  assert.equal((await call('/deals/d1', { cookie })).status, 200);
});

test('property search matches budget, locations and bedrooms', async () => {
  const cookie = await login();
  const { status, body } = await call('/properties/search', {
    method: 'POST',
    cookie,
    body: { budgetMax: 600000, preferredLocation: 'austin', otherLocations: 'Dallas', minBedrooms: 2, listingType: 'Sale' },
  });
  assert.equal(status, 200);
  assert.deepEqual(body.properties.map((p) => p.id), ['p1', 'p18', 'p15']);
});

test('search never returns off-market listings', async () => {
  const cookie = await login();
  const { body } = await call('/properties/search', { method: 'POST', cookie, body: { preferredLocation: 'Cedar Park' } });
  assert.equal(body.count, 0);
  // ...but a client with a deal on that property can still view it.
  assert.equal((await call('/properties/p16', { cookie })).status, 200);
  assert.equal((await call('/properties/p16', { cookie: await login('priya@client.example') })).status, 404);
});

test('invalid search criteria return 400', async () => {
  const cookie = await login();
  const res = await call('/properties/search', { method: 'POST', cookie, body: { budgetMin: 10, budgetMax: 5 } });
  assert.equal(res.status, 400);
});

test('messages are sent and listed, scoped to the client', async () => {
  const cookie = await login();
  const sent = await call('/messages', { method: 'POST', cookie, body: { subject: 'Viewing', body: 'Can I see it Friday?', propertyId: 'p3' } });
  assert.equal(sent.status, 201);
  assert.match(sent.body.message.body, /Hill Country Family Home/);

  const mine = await call('/messages', { cookie });
  assert.ok(mine.body.messages.some((m) => m.subject === 'Viewing'));
  assert.equal(mine.body.agent.name, 'Maria Santos');

  const theirs = await call('/messages', { cookie: await login('priya@client.example') });
  assert.ok(!theirs.body.messages.some((m) => m.subject === 'Viewing'));
});

test('cannot attach a message to someone else\'s deal', async () => {
  const cookie = await login();
  const res = await call('/messages', { method: 'POST', cookie, body: { subject: 'x', body: 'y', dealId: 'd5' } });
  assert.equal(res.status, 404);
});

test('writes must be JSON and same-origin', async () => {
  const cookie = await login();
  const form = await fetch(`${base}/messages`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'subject=a&body=b',
  });
  assert.equal(form.status, 415);
  const crossSite = await fetch(`${base}/messages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ subject: 'a', body: 'b' }),
  });
  assert.equal(crossSite.status, 403);
});

test('tampered session cookies are rejected', async () => {
  const cookie = await login();
  const [name, value] = cookie.split('=');
  const [body, sig] = decodeURIComponent(value).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), contactId: 'c2' })).toString('base64url');
  assert.equal((await call('/dashboard', { cookie: `${name}=${forged}.${sig}` })).status, 401);
});

test('repeated failed sign-ins are throttled', async () => {
  const attempt = () => call('/auth/login', { method: 'POST', body: { email: 'priya@client.example', password: 'wrong' } });
  for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('featured listings show newly acquired, flagged properties, newest first', async () => {
  const cookie = await login();
  const { status, body } = await call('/properties/featured?limit=3', { cookie });
  assert.equal(status, 200);
  assert.deepEqual(body.properties.map((p) => p.id), ['p17', 'p18', 'p19']);
  assert.ok(body.properties.every((p) => p.featured && p.status === 'Available'));
  assert.equal((await call('/properties/featured')).status, 401);
});
