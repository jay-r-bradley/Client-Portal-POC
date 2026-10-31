// Admin console API (brokerage staff only): portfolio-wide activity, client
// access management and the Zoho connection / field check.

const crypto = require('node:crypto');
const express = require('express');
const { HttpError, requireAuth } = require('../middleware');
const { publicUser } = require('../store/userStore');
const { fieldCatalog } = require('../zoho/fieldCatalog');
const { referralProgress } = require('../referrals/referrals');

const DAY_MS = 24 * 3600 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Readable one-time password the admin hands to the client; they must change it on first sign-in.
function temporaryPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

function countBy(events, keyFn) {
  const counts = new Map();
  for (const e of events) {
    for (const key of [].concat(keyFn(e) || [])) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Spreadsheet apps execute cells starting with these characters as formulas.
function csvCell(value) {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function activityFilters(query) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined);
  return { userId: text(query.userId), action: text(query.action), from: text(query.from), to: text(query.to), q: text(query.q) };
}

function adminRoutes({ config, crm, userStore, activity, ai, integrations }) {
  const isOpenDeal = (deal) => !config.crm.wonStages.includes(deal.stage) && !config.crm.lostStages.includes(deal.stage);

  // Client access requires a Zoho Contact with this email and at least one open deal.
  async function contactWithActiveDeal(email) {
    const contact = await crm.findContactByEmail(email);
    if (!contact) throw new HttpError(404, 'No Zoho CRM Contact has that email. Add them in Zoho (or convert their Lead) first.');
    const deals = await crm.listDeals(contact.id);
    const open = deals.filter(isOpenDeal);
    if (!open.length) {
      throw new HttpError(422, `${contact.name} has no active deal in Zoho. Client access is given once they have an open deal.`);
    }
    return { contact, openDeals: open };
  }

  const router = express.Router();
  router.use(requireAuth({ config, userStore }, { role: 'admin' }));
  const log = (req, action, target, details) => activity.record({ actor: req.user, action, target, details, req });

  function findUser(id) {
    const user = userStore.findById(id);
    if (!user) throw new HttpError(404, 'User not found.');
    return user;
  }

  // ---- Overview -------------------------------------------------------------

  router.get('/overview', (req, res) => {
    const now = Date.now();
    const last30 = activity.since(30 * DAY_MS);
    const last7 = last30.filter((e) => now - Date.parse(e.at) <= 7 * DAY_MS);
    const clientEvents = last30.filter((e) => e.actor?.role === 'client');
    const count = (events, ...actions) => events.filter((e) => actions.includes(e.action)).length;
    const clients = userStore.list().filter((u) => u.role === 'client');

    // Client activity per day for the last 14 days (oldest first).
    const days = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * DAY_MS).toISOString().slice(0, 10));
    const perDay = new Map(days.map((d) => [d, 0]));
    for (const e of clientEvents) {
      const day = e.at.slice(0, 10);
      if (perDay.has(day)) perDay.set(day, perDay.get(day) + 1);
    }

    const byUser = new Map(countBy(clientEvents, (e) => e.actor.id));
    res.json({
      kpis: {
        clients: clients.length,
        activeClients30d: byUser.size,
        signIns7d: count(last7, 'auth.login'),
        failedSignIns7d: count(last7, 'auth.login_failed'),
        searches7d: count(last7, 'property.searched', 'property.ai_searched'),
        propertyViews7d: count(last7, 'property.viewed'),
        messages7d: count(last7, 'message.sent'),
        referrals30d: count(last30, 'referral.submitted'),
        guestSignups30d: count(last30, 'auth.signed_up'),
        guests: userStore.list().filter((u) => u.role === 'guest').length,
      },
      activityByDay: days.map((date) => ({ date, events: perDay.get(date) })),
      // Demand signals: what clients look at and where they want to live.
      topProperties: countBy(clientEvents.filter((e) => e.action === 'property.viewed' || (e.action === 'message.sent' && e.target?.propertyId)),
        (e) => `${e.target.propertyId}\u0000${e.target.name}`)
        .slice(0, 5).map(([key, n]) => ({ propertyId: key.split('\u0000')[0], name: key.split('\u0000')[1], interactions: n })),
      topLocations: countBy(clientEvents.filter((e) => e.details?.criteria?.locations),
        (e) => e.details.criteria.locations.map((l) => l.trim().replace(/\b\w/g, (c) => c.toUpperCase())))
        .slice(0, 5).map(([location, searches]) => ({ location, searches })),
      mostActiveClients: [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, events]) => {
        const u = userStore.findById(id);
        return { id, name: u?.name || null, email: u?.email || null, events, lastLoginAt: u?.lastLoginAt || null };
      }),
      recent: activity.query({ limit: 10 }).items,
    });
  });

  // ---- Activity log -----------------------------------------------------------

  router.get('/activity', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    res.json(activity.query({ ...activityFilters(req.query), before, limit }));
  });

  router.get('/activity.csv', (req, res) => {
    const filters = activityFilters(req.query);
    const { items } = activity.query({ ...filters, limit: 10000 });
    log(req, 'admin.activity_exported', null, { filters, rows: items.length });
    const header = ['Time (UTC)', 'Action', 'User', 'Email', 'Role', 'Target', 'Details', 'IP'];
    const rows = items.map((e) => [e.at, e.action, e.actor?.name, e.actor?.email, e.actor?.role, e.target?.name || e.target?.email, e.details, e.ip]);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="portal-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'));
  });

  // ---- Users ------------------------------------------------------------------

  router.get('/users', (req, res) => {
    const events30 = new Map(countBy(activity.since(30 * DAY_MS), (e) => e.actor?.id));
    const users = userStore.list()
      .map((u) => ({ ...publicUser(u), events30d: events30.get(u.id) || 0 }))
      .sort((a, b) => a.role.localeCompare(b.role) || String(a.name || a.email).localeCompare(String(b.name || b.email)));
    res.json({ users });
  });

  router.get('/users/:id', async (req, res) => {
    const user = findUser(req.params.id);
    let contact = null;
    let deals = null;
    if (user.role === 'client') {
      [contact, deals] = await Promise.all([crm.getContact(user.contactId), crm.listDeals(user.contactId).catch(() => null)]);
    }
    res.json({
      user: publicUser(user),
      contact,
      deals: deals && deals.map((d) => ({ id: d.id, name: d.name, stage: d.stage, amount: d.amount, closingDate: d.closingDate })),
      activity: activity.query({ userId: user.id, limit: 100 }).items,
    });
  });

  // Grants portal access. Clients must already exist as a Zoho Contact with this email.
  router.post('/users', async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || 'client');
    if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!['client', 'admin'].includes(role)) throw new HttpError(400, 'Invite a client or an admin. Guests sign up on their own.');
    const existing = userStore.findByEmail(email);
    if (existing?.role === 'guest') throw new HttpError(409, 'That email already has a guest account. Use "Convert to client" on it instead.');
    if (existing) throw new HttpError(409, 'That email already has portal access.');

    let contactId = null;
    let name = String(req.body?.name || '').trim().slice(0, 120) || null;
    let openDeals = 0;
    if (role === 'client') {
      const { contact, openDeals: open } = await contactWithActiveDeal(email);
      contactId = contact.id;
      openDeals = open.length;
      name = contact.name;
    } else if (!name) {
      throw new HttpError(400, 'Enter the admin\'s name.');
    }

    const password = temporaryPassword();
    const user = await userStore.upsert({ email, password, contactId, name, role, mustChangePassword: true, createdBy: req.user.id });
    log(req, 'admin.user_invited', { userId: user.id, email: user.email, name: user.name }, { role, contactId, openDeals });
    res.status(201).json({ user: publicUser(user), temporaryPassword: password });
  });

  // A guest becomes a client once their Lead is a Contact with an open deal in
  // Zoho. Same login and password; they see their deals on next page load.
  router.post('/users/:id/convert-to-client', async (req, res) => {
    const user = findUser(req.params.id);
    if (user.role !== 'guest') throw new HttpError(400, 'Only guest accounts can be converted.');
    const { contact, openDeals } = await contactWithActiveDeal(user.email);
    if (userStore.list().some((u) => u.contactId === contact.id && u.id !== user.id)) {
      throw new HttpError(409, 'Another portal account is already linked to that Zoho Contact.');
    }
    const updated = userStore.update(user.id, { role: 'client', contactId: contact.id, name: contact.name, convertedAt: new Date().toISOString() });
    log(req, 'admin.user_converted', { userId: user.id, email: user.email, name: contact.name }, { contactId: contact.id, leadId: user.leadId, openDeals: openDeals.length });
    res.json({ user: publicUser(updated) });
  });

  router.post('/users/:id/status', (req, res) => {
    const user = findUser(req.params.id);
    const status = req.body?.status;
    if (!['active', 'disabled'].includes(status)) throw new HttpError(400, 'Status must be active or disabled.');
    if (user.id === req.user.id) throw new HttpError(400, 'You cannot change the status of your own account.');
    const updated = userStore.update(user.id, { status }, { revokeSessions: status === 'disabled' });
    log(req, status === 'disabled' ? 'admin.user_disabled' : 'admin.user_enabled', { userId: user.id, email: user.email, name: user.name });
    res.json({ user: publicUser(updated) });
  });

  router.post('/users/:id/reset-password', async (req, res) => {
    const user = findUser(req.params.id);
    if (user.id === req.user.id) throw new HttpError(400, 'Use "Change password" for your own account.');
    const password = temporaryPassword();
    const updated = await userStore.setPassword(user.id, password, { mustChangePassword: true });
    log(req, 'admin.password_reset', { userId: user.id, email: user.email, name: user.name });
    res.json({ user: publicUser(updated), temporaryPassword: password });
  });

  // ---- Referrals ----------------------------------------------------------------

  router.get('/referrals', async (req, res) => {
    const byContact = new Map(userStore.list().filter((u) => u.contactId).map((u) => [u.contactId, u]));
    const referrals = await crm.listAllReferrals();
    res.json({
      leadSource: config.crm.referral.leadSource,
      referrals: referrals.map((r) => {
        const user = r.referrer && byContact.get(r.referrer.contactId);
        return {
          ...r,
          progress: referralProgress(r.leadStatus),
          referrer: r.referrer ? { ...r.referrer, name: r.referrer.name || user?.name || null, userId: user?.id || null } : null,
        };
      }),
    });
  });

  // ---- Zoho integration -------------------------------------------------------

  router.get('/integration', async (req, res) => {
    const catalog = fieldCatalog(config);
    const [connection, checks] = await Promise.all([crm.testConnection(), crm.checkFields(catalog)]);
    const statusFor = new Map(checks.flatMap((m) => m.fields.map((f) => [`${m.module}.${f.apiName}`, f.status])));
    res.json({
      mode: config.zohoMode,
      crm: {
        ...connection,
        apiDomain: config.zohoMode === 'live' ? config.zoho.apiDomain : null,
        apiVersion: config.zoho.apiVersion,
      },
      mcp: { configured: Boolean(integrations.mcp), usedByAi: ai?.source === 'Zoho MCP' },
      ai: { enabled: Boolean(ai), model: ai ? config.ai.model : null, crmAccess: ai?.source || null },
      modules: catalog.map((m) => ({
        ...m,
        error: checks.find((c) => c.module === m.module)?.error || null,
        fields: m.fields.map((f) => ({ ...f, status: statusFor.get(`${m.module}.${f.apiName}`) || 'unknown' })),
      })),
    });
  });

  router.post('/integration/test-mcp', async (req, res) => {
    if (!integrations.mcp) throw new HttpError(400, 'Zoho MCP is not configured. Set ZOHO_MCP_URL (with ZOHO_MODE=live).');
    try {
      const tools = await integrations.mcp.listTools();
      log(req, 'admin.integration_tested', null, { target: 'Zoho MCP', ok: true, tools: tools.length });
      res.json({ ok: true, tools: tools.map((t) => t.name) });
    } catch (err) {
      log(req, 'admin.integration_tested', null, { target: 'Zoho MCP', ok: false });
      res.json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = { adminRoutes, csvCell };
