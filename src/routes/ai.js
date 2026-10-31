const express = require('express');
const { HttpError, requireAuth } = require('../middleware');
const { CriteriaError } = require('../propertyCriteria');
const { AiLimitError } = require('../ai/aiService');
const { AiError } = require('../ai/openaiClient');
const { createLeadCriteriaSync } = require('../guests/guests');

// Maps AI-layer failures onto responses the client can act on.
function aiErrors(err) {
  if (err instanceof AiLimitError) return new HttpError(429, err.message);
  if (err instanceof CriteriaError) return new HttpError(400, `The assistant could not turn that into a search: ${err.message}`);
  if (err instanceof AiError) {
    console.error('[ai]', err.message);
    return new HttpError(502, 'The AI assistant is unavailable right now. Please try again, or use the search form.');
  }
  return err;
}

function aiRoutes({ config, ai, crm, userStore, activity }) {
  const router = express.Router();
  router.use(requireAuth({ config, userStore }, { role: ['client', 'guest'] }));
  const clientOnly = (req, res, next) => (req.user.role === 'client' ? next() : next(new HttpError(403, 'This is for clients with an active deal.')));
  const syncLeadCriteria = crm ? createLeadCriteriaSync({ crm, config }) : () => {};
  router.use((req, res, next) => (ai ? next() : next(new HttpError(404, 'AI features are not enabled.'))));

  router.post('/property-search', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (query.length < 3 || query.length > 500) {
      throw new HttpError(400, 'Describe what you are looking for in 3 to 500 characters.');
    }
    const guestId = req.user.role === 'guest' ? req.user.id : null;
    const result = await ai.propertySearch(req.session.contactId, query, { guestId }).catch((err) => { throw aiErrors(err); });
    syncLeadCriteria(req.user, result.criteria, { query });
    activity.record({
      actor: req.user, action: 'property.ai_searched', req,
      details: { query, criteria: result.criteria, results: result.results.length, relaxed: result.relaxed },
    });
    res.json(result);
  });

  router.get('/insights', clientOnly, async (req, res) => {
    res.json(await ai.portfolioInsights(req.session.contactId).catch((err) => { throw aiErrors(err); }));
  });

  router.get('/deals/:id/insights', clientOnly, async (req, res) => {
    const insight = await ai.dealInsights(req.session.contactId, req.params.id).catch((err) => { throw aiErrors(err); });
    if (!insight) throw new HttpError(404, 'Deal not found.');
    res.json(insight);
  });

  return router;
}

module.exports = { aiRoutes };
