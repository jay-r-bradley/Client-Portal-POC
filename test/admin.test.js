// User hierarchy, activity log and admin console API.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { MockCrm } = require('../src/zoho/mockCrm');
const { UserStore } = require('../src/store/userStore');
const { ActivityLog } = require('../src/store/activityLog');
const { csvCell } = require('../src/routes/admin');

let server;
let base;
let activity;
let userStore;

test.before(async () => {
  userStore = new UserStore(null);
  activity = new ActivityLog(null);
  await userStore.upsert({ email: 'admin@brokerage.example', password: 'admin-pass-1', name: 'Dana Brooks', role: 'admin' });
  await userStore.upsert({ email: 'admin2@brokerage.example', password: 'admin-pass-2', name: 'Sam Ortiz', role: 'admin' });
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
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, body: json, text, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function login(email, password) {
  const res = await call('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(res.status, 200, `login ${email}`);
  return res.cookie;
}
const adminLogin = () => login('admin@brokerage.example', 'admin-pass-1');
const clientLogin = () => login('alex@client.example', 'demo1234');

test('admins cannot use client pages, and clients cannot use the admin console', async () => {
  const admin = await adminLogin();
  const client = await clientLogin();
  assert.equal((await call('/dashboard', { cookie: admin })).status, 403);
  assert.equal((await call('/admin/overview', { cookie: client })).status, 403);
  assert.equal((await call('/admin/users', { cookie: client })).status, 403);
  assert.equal((await call('/admin/overview')).status, 401);
  assert.equal((await call('/admin/overview', { cookie: admin })).status, 200);
  assert.equal((await call('/auth/me', { cookie: admin })).body.user.role, 'admin');
});

test('client actions are recorded in the activity log', async () => {
  const cookie = await clientLogin();
  await call('/deals/d1', { cookie });
  await call('/properties/search', { method: 'POST', cookie, body: { preferredLocation: 'Austin', budgetMax: 600000 } });
  await call('/properties/p15', { cookie });
  await call('/messages', { method: 'POST', cookie, body: { subject: 'Viewing please', body: 'Private message text', propertyId: 'p15' } });

  const alex = userStore.findByEmail('alex@client.example');
  const { items } = activity.query({ userId: alex.id, limit: 10 });
  const actions = items.map((e) => e.action);
  for (const a of ['auth.login', 'deal.viewed', 'property.searched', 'property.viewed', 'message.sent']) assert.ok(actions.includes(a), a);
  const sent = items.find((e) => e.action === 'message.sent');
  assert.equal(sent.details.subject, 'Viewing please');
  assert.ok(!JSON.stringify(items).includes('Private message text'), 'message bodies stay out of the log');
  assert.equal(items.find((e) => e.action === 'property.searched').details.criteria.locations[0], 'Austin');
});

test('failed sign-ins are logged without the attempted password', async () => {
  await call('/auth/login', { method: 'POST', body: { email: 'priya@client.example', password: 'guess-123' } });
  const failed = activity.query({ action: 'auth.login_failed', limit: 1 }).items[0];
  assert.equal(failed.details.email, 'priya@client.example');
  assert.equal(failed.actor, null);
  assert.ok(!JSON.stringify(failed).includes('guess-123'));
});

test('admin can filter activity, page through it and export CSV', async () => {
  const admin = await adminLogin();
  const alex = userStore.findByEmail('alex@client.example');
  const filtered = await call(`/admin/activity?userId=${alex.id}&action=property`, { cookie: admin });
  assert.ok(filtered.body.items.length >= 2);
  assert.ok(filtered.body.items.every((e) => e.actor.id === alex.id && e.action.startsWith('property.')));

  const page1 = await call('/admin/activity?limit=2', { cookie: admin });
  const page2 = await call(`/admin/activity?limit=2&before=${page1.body.next}`, { cookie: admin });
  assert.equal(page1.body.items.length, 2);
  assert.notEqual(page2.body.items[0].id, page1.body.items[0].id);

  const csv = await call('/admin/activity.csv?action=auth', { cookie: admin });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text.split('\r\n')[0], /^Time \(UTC\),Action,User/);
  assert.ok(csv.text.includes('auth.login'));
});

test('CSV cells cannot run as spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('plain'), 'plain');
});

test('overview reports KPIs and buyer demand', async () => {
  const { body } = await call('/admin/overview', { cookie: await adminLogin() });
  assert.equal(body.kpis.clients, 2);
  assert.ok(body.kpis.signIns7d >= 1);
  assert.equal(body.activityByDay.length, 14);
  assert.ok(body.topLocations.some((l) => l.location === 'Austin'));
  assert.ok(body.topProperties.some((p) => p.propertyId === 'p15'));
});

test('admin invites a client who exists in Zoho; they must change the temporary password', async () => {
  const admin = await adminLogin();
  assert.equal((await call('/admin/users', { method: 'POST', cookie: admin, body: { email: 'nobody@client.example', role: 'client' } })).status, 404);
  assert.equal((await call('/admin/users', { method: 'POST', cookie: admin, body: { email: 'alex@client.example', role: 'client' } })).status, 409);

  const invite = await call('/admin/users', { method: 'POST', cookie: admin, body: { email: 'jordan@client.example', role: 'client' } });
  assert.equal(invite.status, 201);
  assert.equal(invite.body.user.contactId, 'c3');
  assert.equal(invite.body.user.passwordHash, undefined);

  const jordan = await login('jordan@client.example', invite.body.temporaryPassword);
  assert.equal((await call('/dashboard', { cookie: jordan })).status, 403, 'blocked until the password is changed');
  assert.equal((await call('/auth/me', { cookie: jordan })).body.user.mustChangePassword, true);
  const short = await call('/auth/change-password', { method: 'POST', cookie: jordan, body: { currentPassword: invite.body.temporaryPassword, newPassword: 'short' } });
  assert.equal(short.status, 400);
  const changed = await call('/auth/change-password', { method: 'POST', cookie: jordan, body: { currentPassword: invite.body.temporaryPassword, newPassword: 'a-much-longer-password' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('/dashboard', { cookie: changed.cookie })).status, 200);
  assert.equal((await call('/dashboard', { cookie: jordan })).status, 401, 'the old session is signed out');
});

test('disabling a user signs them out immediately and blocks sign-in', async () => {
  const admin = await adminLogin();
  const priyaCookie = await login('priya@client.example', 'demo1234');
  const priya = userStore.findByEmail('priya@client.example');

  assert.equal((await call(`/admin/users/${priya.id}/status`, { method: 'POST', cookie: admin, body: { status: 'disabled' } })).status, 200);
  assert.equal((await call('/dashboard', { cookie: priyaCookie })).status, 401);
  assert.equal((await call('/auth/login', { method: 'POST', body: { email: 'priya@client.example', password: 'demo1234' } })).status, 403);

  await call(`/admin/users/${priya.id}/status`, { method: 'POST', cookie: admin, body: { status: 'active' } });
  await login('priya@client.example', 'demo1234');
  const me = userStore.findByEmail('admin@brokerage.example');
  assert.equal((await call(`/admin/users/${me.id}/status`, { method: 'POST', cookie: admin, body: { status: 'disabled' } })).status, 400, 'cannot lock yourself out');
});

test('password reset issues a temporary password and revokes sessions', async () => {
  const admin = await adminLogin();
  const old = await clientLogin();
  const alex = userStore.findByEmail('alex@client.example');
  const reset = await call(`/admin/users/${alex.id}/reset-password`, { method: 'POST', cookie: admin, body: {} });
  assert.equal(reset.status, 200);
  assert.equal((await call('/dashboard', { cookie: old })).status, 401);
  assert.equal((await call('/auth/login', { method: 'POST', body: { email: 'alex@client.example', password: 'demo1234' } })).status, 401);
  const fresh = await login('alex@client.example', reset.body.temporaryPassword);
  await call('/auth/change-password', { method: 'POST', cookie: fresh, body: { currentPassword: reset.body.temporaryPassword, newPassword: 'demo1234-restored' } });
  await userStore.setPassword(alex.id, 'demo1234'); // restore for other tests
});

test('admin actions are audited too', async () => {
  const actions = activity.query({ action: 'admin', limit: 50 }).items.map((e) => e.action);
  for (const a of ['admin.user_invited', 'admin.user_disabled', 'admin.user_enabled', 'admin.password_reset', 'admin.activity_exported']) {
    assert.ok(actions.includes(a), a);
  }
});

test('user detail shows the client\'s Zoho contact, deals and timeline', async () => {
  const alex = userStore.findByEmail('alex@client.example');
  const { body } = await call(`/admin/users/${alex.id}`, { cookie: await adminLogin() });
  assert.equal(body.contact.id, 'c1');
  assert.equal(body.deals.length, 4);
  assert.ok(body.activity.length > 0);
});

test('integration page lists every Zoho field the portal needs', async () => {
  const { body } = await call('/admin/integration', { cookie: await adminLogin() });
  assert.equal(body.mode, 'mock');
  assert.equal(body.crm.ok, true);
  const properties = body.modules.find((m) => m.label === 'Properties');
  assert.ok(properties.fields.some((f) => f.apiName === 'Featured' && f.type === 'Checkbox'));
  assert.ok(body.modules.every((m) => m.fields.every((f) => f.status === 'sample')));
});
