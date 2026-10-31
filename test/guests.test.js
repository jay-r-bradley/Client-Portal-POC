// Guest self sign-up (as a Zoho Lead), guest permissions, and the active-deal
// rule for client access.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { MockCrm } = require('../src/zoho/mockCrm');
const { UserStore } = require('../src/store/userStore');
const { ActivityLog } = require('../src/store/activityLog');
const { AiService } = require('../src/ai/aiService');
const { criteriaText } = require('../src/guests/guests');

let server;
let base;
let crm;
let activity;
let userStore;

test.before(async () => {
  crm = new MockCrm(config);
  userStore = new UserStore(null);
  activity = new ActivityLog(null);
  await userStore.upsert({ email: 'admin@brokerage.example', password: 'admin-pass-1', name: 'Dana', role: 'admin' });
  await userStore.upsert({ email: 'alex@client.example', password: 'demo1234', contactId: 'c1', name: 'Alex' });
  const app = createApp({ config: { ...config, zohoMode: 'mock' }, crm, userStore, activity });
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

const signup = (overrides = {}) => call('/auth/signup', {
  method: 'POST',
  body: { name: 'Taylor Morgan', email: 'taylor@guest.example', phone: '+1 555 0100', password: 'guest-password-1', listingType: 'Sale', budgetMax: 600000, location: 'Austin', consent: true, ...overrides },
});
const adminCookie = async () => (await call('/auth/login', { method: 'POST', body: { email: 'admin@brokerage.example', password: 'admin-pass-1' } })).cookie;

let guestCookie;

test('signing up creates a guest account and a hot Lead in Zoho', async () => {
  const res = await signup();
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'guest');
  assert.deepEqual(res.body.initialFilters, { budgetMax: 600000, locations: ['Austin'], listingType: 'Sale' });
  guestCookie = res.cookie;

  const lead = crm.data.leads.find((l) => l.email === 'taylor@guest.example');
  assert.ok(lead, 'Lead created');
  assert.equal(lead.source, 'Portal Sign-up');
  assert.equal(lead.lastName, 'Morgan');
  assert.match(lead.description, /Budget up to \$600,000/);
  assert.equal(userStore.findByEmail('taylor@guest.example').leadId, lead.id);

  const event = activity.query({ action: 'auth.signed_up', limit: 1 }).items[0];
  assert.equal(event.details.location, 'Austin');
  assert.ok(!JSON.stringify(event).includes('guest-password-1'));
  assert.ok(!JSON.stringify(event).includes('+1 555 0100'));
});

test('sign-up validation: duplicates, consent and password length', async () => {
  assert.equal((await signup()).status, 409);
  assert.equal((await signup({ email: 'alex@client.example' })).status, 409, 'an existing client cannot be overwritten');
  assert.match((await signup({ email: 'new1@guest.example', consent: false })).body.error, /agree to be contacted/);
  assert.equal((await signup({ email: 'new2@guest.example', password: 'short' })).status, 400);
  assert.equal(crm.data.leads.length, 1, 'no Lead for a failed sign-up');
});

test('guests can browse, search and view available listings', async () => {
  assert.equal((await call('/properties/featured', { cookie: guestCookie })).status, 200);
  assert.equal((await call('/properties/options', { cookie: guestCookie })).status, 200);
  const search = await call('/properties/search', { method: 'POST', cookie: guestCookie, body: { locations: ['Austin'], budgetMax: 600000, listingType: 'Sale' } });
  assert.equal(search.status, 200);
  assert.ok(search.body.count > 0);
  assert.equal((await call('/properties/p15', { cookie: guestCookie })).status, 200);
  assert.equal((await call('/auth/me', { cookie: guestCookie })).body.user.role, 'guest');
});

test('a guest search is written to their Lead for the agent', async () => {
  const lead = crm.data.leads.find((l) => l.email === 'taylor@guest.example');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(lead.criteria, /Locations: Austin/);
  assert.match(lead.criteria, /Budget up to: \$600,000/);
});

test('guests cannot see deals, messages, referrals, off-market listings or the admin console', async () => {
  for (const path of ['/dashboard', '/deals/d1', '/messages', '/referrals', '/admin/overview']) {
    assert.equal((await call(path, { cookie: guestCookie })).status, 403, path);
  }
  assert.equal((await call('/properties/p16', { cookie: guestCookie })).status, 404, 'sold listing');
  assert.equal((await call('/messages', { method: 'POST', cookie: guestCookie, body: { subject: 'x', body: 'y' } })).status, 403);
});

test('client invites require an active deal in Zoho', async () => {
  const admin = await adminCookie();
  const chris = await call('/admin/users', { method: 'POST', cookie: admin, body: { email: 'chris@client.example', role: 'client' } });
  assert.equal(chris.status, 422);
  assert.match(chris.body.error, /no active deal/);
  const guestInvite = await call('/admin/users', { method: 'POST', cookie: admin, body: { email: 'taylor@guest.example', role: 'guest' } });
  assert.equal(guestInvite.status, 400, 'guests sign up on their own');
});

test('an admin converts a guest to a client once they have an active deal; same login', async () => {
  const jordanSignup = await signup({ name: 'Jordan Lee', email: 'jordan@client.example' });
  assert.equal(jordanSignup.status, 201);
  const jordanCookie = jordanSignup.cookie;
  assert.equal((await call('/dashboard', { cookie: jordanCookie })).status, 403, 'no deals while a guest, even though a Contact exists');

  const admin = await adminCookie();
  const taylor = userStore.findByEmail('taylor@guest.example');
  assert.equal((await call(`/admin/users/${taylor.id}/convert-to-client`, { method: 'POST', cookie: admin, body: {} })).status, 404, 'no Zoho Contact yet');

  const jordan = userStore.findByEmail('jordan@client.example');
  const converted = await call(`/admin/users/${jordan.id}/convert-to-client`, { method: 'POST', cookie: admin, body: {} });
  assert.equal(converted.status, 200);
  assert.equal(converted.body.user.role, 'client');
  assert.equal(converted.body.user.contactId, 'c3');
  const dashboard = await call('/dashboard', { cookie: jordanCookie });
  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.body.deals.map((d) => d.id), ['d6']);
  assert.equal(activity.query({ action: 'admin.user_converted', limit: 1 }).items[0].details.leadId, jordan.leadId);

  const chris = await signup({ name: 'Chris Wong', email: 'chris@client.example' });
  const chrisUser = userStore.findByEmail('chris@client.example');
  assert.equal(chris.status, 201);
  assert.equal((await call(`/admin/users/${chrisUser.id}/convert-to-client`, { method: 'POST', cookie: admin, body: {} })).status, 422, 'closed deals only');
});

test('overview counts guests and sign-ups', async () => {
  const { body } = await call('/admin/overview', { cookie: await adminCookie() });
  assert.equal(body.kpis.guests, 2);
  assert.equal(body.kpis.guestSignups30d, 3);
});

test('sign-ups are rate limited per network', async () => {
  await signup({ email: 'g4@guest.example' });
  await signup({ email: 'g5@guest.example' });
  assert.equal((await signup({ email: 'g6@guest.example' })).status, 429);
});

test('guest AI matching has no deal tools and its own allowance', async () => {
  const done = { role: 'assistant', content: JSON.stringify({ interpretation: '', preferences: [], relaxed: false, overview: '', results: [] }) };
  const requests = [];
  const client = { chat: async (req) => { requests.push(req); return done; } };
  const ai = new AiService({ client, crm: new MockCrm(config), config: { ...config, ai: { ...config.ai, guestMaxRequestsPerHour: 1 } } });
  await ai.propertySearch(null, 'a home in Austin', { guestId: 'g1' });
  assert.deepEqual(requests[0].tools.map((t) => t.function.name).sort(), ['get_listing', 'search_listings']);
  await assert.rejects(ai.propertySearch(null, 'again', { guestId: 'g1' }), /hourly limit/);
});

test('criteria summary reads well on the Lead', () => {
  const summary = criteriaText({ budgetMin: null, budgetMax: 650000, locations: ['Austin', 'Dallas'], listingType: 'Sale', minBedrooms: 3 }, config, { query: '3 bed with a yard', at: new Date('2026-10-31T00:00:00Z') });
  assert.equal(summary, 'Looking to: buy\nBudget up to: $650,000\nLocations: Austin, Dallas\nBedrooms: 3+\nIn their words: "3 bed with a yard"\nLast searched on the portal: 2026-10-31');
});
