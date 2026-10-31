// Two weeks of plausible portal activity for demo mode, so the admin console
// has something to show on first run. Only used with ZOHO_MODE=mock and an
// empty activity log; real deployments start with an empty log.

const DAY_MS = 24 * 3600 * 1000;

function seedDemoActivity(activity, userStore, { now = Date.now() } = {}) {
  const alex = userStore.findByEmail('alex@client.example');
  const priya = userStore.findByEmail('priya@client.example');
  const admin = userStore.list().find((u) => u.role === 'admin');
  if (!alex || !priya || !admin) return;

  const req = (ip) => ({ ip, headers: { 'user-agent': 'Mozilla/5.0 (demo)' } });
  const events = [];
  const at = (daysAgo, hour, minute = 0) => now - daysAgo * DAY_MS - (24 - hour) * 3600 * 1000 + minute * 60 * 1000;
  const add = (time, actor, action, target = null, details = {}, ip = '203.0.113.10') => events.push({ time, actor, action, target, details, ip });
  const search = (locations, budgetMax, minBedrooms, listingType = 'Sale') => ({
    criteria: { budgetMin: null, budgetMax, locations, listingType, propertyType: null, minBedrooms, minBathrooms: null, minFloorArea: null, keywords: null },
  });

  add(at(13, 9), admin, 'auth.login', null, {}, '198.51.100.4');
  add(at(13, 9, 5), admin, 'admin.user_invited', { userId: priya.id, email: priya.email, name: priya.name }, { role: 'client', contactId: priya.contactId }, '198.51.100.4');
  const alexDays = [12, 10, 9, 7, 6, 4, 3, 2, 1, 0];
  for (const d of alexDays) {
    add(at(d, 19), alex, 'auth.login');
    add(at(d, 19, 1), alex, 'portal.dashboard_viewed', null, { deals: 4 });
    if (d % 2 === 0) add(at(d, 19, 3), alex, 'deal.viewed', { dealId: 'd1', name: 'Rivera - Lakeview Townhouse purchase' }, { stage: 'Negotiation' });
    if (d <= 9) add(at(d, 19, 6), alex, d % 3 === 0 ? 'property.ai_searched' : 'property.searched', null,
      { ...(d % 3 === 0 ? { query: '3-bed home in Austin under 650k with a home office' } : {}), ...search(['Austin'], 650000, 3), results: 3 });
    add(at(d, 19, 8), alex, 'property.viewed', { propertyId: d < 5 ? 'p18' : 'p15', name: d < 5 ? 'Mueller Park Rowhome' : 'Zilker Park Townhome' }, { price: d < 5 ? 545000 : 599000, city: 'Austin' });
  }
  add(at(4, 19, 12), alex, 'message.sent', { propertyId: 'p18', name: 'Mueller Park Rowhome' }, { subject: 'Interested in Mueller Park Rowhome' });
  add(at(1, 20), alex, 'message.sent', { dealId: 'd1', name: 'Rivera - Lakeview Townhouse purchase' }, { subject: 'Any word from the seller?' });

  for (const d of [11, 8, 5, 3, 1]) {
    add(at(d, 12), priya, 'auth.login', null, {}, '192.0.2.44');
    add(at(d, 12, 2), priya, 'deal.viewed', { dealId: 'd5', name: 'Shah - Uptown Skyline Condo' }, { stage: 'Under Contract' }, '192.0.2.44');
    add(at(d, 12, 5), priya, 'property.searched', null, search(['Dallas', 'Plano'], 900000, 2), '192.0.2.44');
    add(at(d, 12, 7), priya, 'property.viewed', { propertyId: d > 4 ? 'p6' : 'p17', name: d > 4 ? 'Lakewood Craftsman' : 'Barton Creek Estate' }, { city: d > 4 ? 'Dallas' : 'Austin' }, '192.0.2.44');
  }
  add(at(3, 12, 9), priya, 'referral.submitted', { referralId: 'r2', name: 'Grace Kim' }, { interest: 'Buying a home' }, '192.0.2.44');
  add(at(2, 23, 40), null, 'auth.login_failed', { userId: priya.id, email: priya.email }, { email: priya.email }, '45.67.89.10');
  add(at(2, 23, 41), null, 'auth.login_failed', { userId: priya.id, email: priya.email }, { email: priya.email }, '45.67.89.10');

  const realNow = activity.now;
  for (const e of events.sort((a, b) => a.time - b.time)) {
    activity.now = () => e.time;
    activity.record({ actor: e.actor, action: e.action, target: e.target, details: { ...e.details, demo: true }, req: req(e.ip) });
  }
  activity.now = realNow;
  for (const user of [alex, priya, admin]) {
    const last = activity.lastEventFor(user.id, 'auth.login');
    if (last) userStore.update(user.id, { lastLoginAt: last.at });
  }
}

module.exports = { seedDemoActivity };
