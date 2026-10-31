const express = require('express');
const { HttpError, requireAuth } = require('../middleware');
const { normalizeCriteria, CriteriaError } = require('../propertyCriteria');
const { INTERESTS, normalizeReferral, referralProgress, ReferralError } = require('../referrals/referrals');

const MAX_REFERRALS_PER_DAY = 10;

function summarize(deals, { wonStages, lostStages }) {
  const byStage = {};
  for (const deal of deals) byStage[deal.stage || 'Unassigned'] = (byStage[deal.stage || 'Unassigned'] || 0) + 1;
  const won = deals.filter((d) => wonStages.includes(d.stage)).length;
  const lost = deals.filter((d) => lostStages.includes(d.stage)).length;
  return { total: deals.length, active: deals.length - won - lost, won, lost, byStage };
}

// Client-facing routes. Every request is scoped to the signed-in client's Zoho
// Contact, and the meaningful ones are written to the activity log.
function portalRoutes({ config, crm, userStore, activity }) {
  const router = express.Router();
  router.use(requireAuth({ config, userStore }, { role: 'client' }));
  const log = (req, action, target, details) => activity.record({ actor: req.user, action, target, details, req });

  router.get('/dashboard', async (req, res) => {
    const [deals, stages] = await Promise.all([crm.listDeals(req.session.contactId), crm.getStages()]);
    deals.sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0));
    log(req, 'portal.dashboard_viewed', null, { deals: deals.length });
    res.json({
      summary: summarize(deals, config.crm),
      stages,
      wonStages: config.crm.wonStages,
      lostStages: config.crm.lostStages,
      deals,
    });
  });

  router.get('/deals/:id', async (req, res) => {
    const deal = await crm.getDeal(req.session.contactId, req.params.id);
    if (!deal) throw new HttpError(404, 'Deal not found.');
    log(req, 'deal.viewed', { dealId: deal.id, name: deal.name }, { stage: deal.stage });
    const [property, stages] = await Promise.all([
      deal.property ? crm.getProperty(deal.property.id) : null,
      crm.getStages(),
    ]);
    res.json({ deal, property, stages, wonStages: config.crm.wonStages, lostStages: config.crm.lostStages });
  });

  router.get('/properties/featured', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 12);
    res.json({ properties: await crm.listFeaturedProperties(limit) });
  });

  router.get('/properties/options', async (req, res) => {
    res.json(await crm.getPropertyFilterOptions());
  });

  router.post('/properties/search', async (req, res) => {
    let criteria;
    try {
      criteria = normalizeCriteria(req.body || {});
    } catch (err) {
      if (err instanceof CriteriaError) throw new HttpError(400, err.message);
      throw err;
    }
    const properties = await crm.searchProperties(criteria);
    log(req, 'property.searched', null, { criteria, results: properties.length });
    res.json({ criteria, count: properties.length, properties });
  });

  router.get('/properties/:id', async (req, res) => {
    const property = await crm.getProperty(req.params.id);
    if (!property) throw new HttpError(404, 'Property not found.');
    // Off-market listings are only visible to clients who have a deal on them.
    if (property.status !== config.crm.availableStatus) {
      const deals = await crm.listDeals(req.session.contactId);
      if (!deals.some((d) => d.property?.id === property.id)) throw new HttpError(404, 'Property not found.');
    }
    log(req, 'property.viewed', { propertyId: property.id, name: property.name }, { price: property.price, city: property.city });
    res.json({ property });
  });

  router.get('/messages', async (req, res) => {
    const [messages, agent] = await Promise.all([
      crm.listMessages(req.session.contactId),
      crm.getAgent(req.session.contactId),
    ]);
    res.json({ agent, messages });
  });

  router.post('/messages', async (req, res) => {
    const subject = String(req.body?.subject || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!subject || subject.length > 120) throw new HttpError(400, 'Please enter a subject (up to 120 characters).');
    if (!body || body.length > 4000) throw new HttpError(400, 'Please enter a message (up to 4000 characters).');

    const { dealId, propertyId } = req.body;
    const deal = dealId ? await crm.getDeal(req.session.contactId, String(dealId)) : null;
    if (dealId && !deal) throw new HttpError(404, 'Deal not found.');
    const property = propertyId ? await crm.getProperty(String(propertyId)) : null;
    if (propertyId && !property) throw new HttpError(404, 'Property not found.');

    const message = await crm.sendMessage(req.session.contactId, { subject, body, deal, property });
    // The subject and context are logged; the message body stays in Zoho only.
    log(req, 'message.sent', deal ? { dealId: deal.id, name: deal.name } : property ? { propertyId: property.id, name: property.name } : null, { subject });
    res.status(201).json({ message });
  });

  // ---- Referral program -----------------------------------------------------

  const clientReferral = (r) => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone, interest: r.interest, notes: r.notes,
    createdAt: r.createdAt, progress: referralProgress(r.leadStatus),
  });

  router.get('/referrals', async (req, res) => {
    const referrals = await crm.listReferrals(req.session.contactId);
    res.json({ referrals: referrals.map(clientReferral), interests: INTERESTS, rewardText: config.crm.referral.rewardText || null });
  });

  router.post('/referrals', async (req, res) => {
    let referral;
    try {
      referral = normalizeReferral(req.body || {});
    } catch (err) {
      if (err instanceof ReferralError) throw new HttpError(400, err.message);
      throw err;
    }
    const today = activity.since(24 * 3600 * 1000).filter((e) => e.actor?.id === req.user.id && e.action === 'referral.submitted');
    if (today.length >= MAX_REFERRALS_PER_DAY) throw new HttpError(429, 'You have sent the maximum number of referrals for today. Please try again tomorrow.');
    const existing = await crm.listReferrals(req.session.contactId);
    if (referral.email && existing.some((r) => r.email && r.email.toLowerCase() === referral.email)) {
      throw new HttpError(409, 'You have already referred someone with that email.');
    }

    const created = await crm.createReferral(req.session.contactId, referral);
    // The referred person's contact details stay in Zoho; the log keeps the name and interest only.
    log(req, 'referral.submitted', { referralId: created.id, name: referral.name }, { interest: referral.interest });
    res.status(201).json({ referral: clientReferral(created) });
  });

  return router;
}

module.exports = { portalRoutes, summarize };
