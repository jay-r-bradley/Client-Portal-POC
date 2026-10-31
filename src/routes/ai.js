const express = require('express');
const { HttpError, requireAuth } = require('../middleware');
const { CriteriaError } = require('../propertyCriteria');
const { AiLimitError } = require('../ai/aiService');
const { AiError } = require('../ai/openaiClient');

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

function aiRoutes({ config, ai, userStore, activity }) {
  const router = express.Router();
  router.use(requireAuth({ config, userStore }, { role: 'client' }));
  router.use((req, res, next) => (ai ? next() : next(new HttpError(404, 'AI features are not enabled.'))));

  router.post('/property-search', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (query.length < 3 || query.length > 500) {
      throw new HttpError(400, 'Describe what you are looking for in 3 to 500 characters.');
    }
    const result = await ai.propertySearch(req.session.contactId, query).catch((err) => { throw aiErrors(err); });
    activity.record({
      actor: req.user, action: 'property.ai_searched', req,
      details: { query, criteria: result.criteria, results: result.results.length, relaxed: result.relaxed },
    });
    res.json(result);
  });

  router.get('/insights', async (req, res) => {
    res.json(await ai.portfolioInsights(req.session.contactId).catch((err) => { throw aiErrors(err); }));
  });

  router.get('/deals/:id/insights', async (req, res) => {
    const insight = await ai.dealInsights(req.session.contactId, req.params.id).catch((err) => { throw aiErrors(err); });
    if (!insight) throw new HttpError(404, 'Deal not found.');
    res.json(insight);
  });

  return router;
}

module.exports = { aiRoutes };
