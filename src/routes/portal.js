const express = require('express');
const { HttpError, requireAuth } = require('../middleware');
const { normalizeCriteria, CriteriaError } = require('../propertyCriteria');

function summarize(deals, { wonStages, lostStages }) {
  const byStage = {};
  for (const deal of deals) byStage[deal.stage || 'Unassigned'] = (byStage[deal.stage || 'Unassigned'] || 0) + 1;
  const won = deals.filter((d) => wonStages.includes(d.stage)).length;
  const lost = deals.filter((d) => lostStages.includes(d.stage)).length;
  return { total: deals.length, active: deals.length - won - lost, won, lost, byStage };
}

function portalRoutes({ config, crm }) {
  const router = express.Router();
  router.use(requireAuth(config));

  router.get('/dashboard', async (req, res) => {
    const [deals, stages] = await Promise.all([crm.listDeals(req.session.contactId), crm.getStages()]);
    deals.sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0));
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
    const [property, stages] = await Promise.all([
      deal.property ? crm.getProperty(deal.property.id) : null,
      crm.getStages(),
    ]);
    res.json({ deal, property, stages, wonStages: config.crm.wonStages, lostStages: config.crm.lostStages });
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
    res.status(201).json({ message });
  });

  return router;
}

module.exports = { portalRoutes, summarize };
