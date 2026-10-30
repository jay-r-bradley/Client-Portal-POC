// AI features layered on top of the CRM. The model only ever sees the signed-in
// client's own data, never contact details, and every answer is schema-checked.

const crypto = require('node:crypto');
const { normalizeCriteria } = require('../propertyCriteria');
const { criteriaPrompt, rankingPrompt, dealInsightPrompt, portfolioInsightPrompt } = require('./prompts');

const MAX_RANKED = 20;
const DAY_MS = 24 * 3600 * 1000;

class AiLimitError extends Error {}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  const diff = new Date(to) - new Date(from);
  return Number.isFinite(diff) ? Math.round(diff / DAY_MS) : null;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

// Only the listing facts the model needs to compare properties.
function listingForModel(p) {
  return {
    id: p.id, name: p.name, city: p.city, address: p.address, price: p.price, listingType: p.listingType,
    propertyType: p.propertyType, bedrooms: p.bedrooms, bathrooms: p.bathrooms, floorArea: p.floorArea,
    description: p.description,
  };
}

class AiService {
  constructor({ client, crm, config, now = () => Date.now() }) {
    this.client = client;
    this.crm = crm;
    this.config = config;
    this.now = now;
    this.cache = new Map();
    this.usage = new Map();
  }

  // ---- Guards -------------------------------------------------------------

  // Per-client hourly cap so one account cannot run up the OpenAI bill.
  consume(contactId) {
    const windowStart = this.now() - 3600 * 1000;
    const recent = (this.usage.get(contactId) || []).filter((t) => t > windowStart);
    if (recent.length >= this.config.ai.maxRequestsPerHour) {
      throw new AiLimitError('You have reached the hourly limit for the AI assistant. Please try again later.');
    }
    recent.push(this.now());
    this.usage.set(contactId, recent);
  }

  async cached(key, compute) {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const value = await compute();
    this.cache.set(key, { value, expiresAt: this.now() + this.config.ai.cacheMinutes * 60 * 1000 });
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  // ---- Natural-language property search -----------------------------------

  async propertySearch(contactId, query) {
    this.consume(contactId);
    const { currency } = this.config;
    const options = await this.crm.getPropertyFilterOptions();

    const extracted = await this.client.completeJson({
      ...criteriaPrompt({ ...options, currency, today: today() }),
      user: { clientRequest: query },
    });
    const criteria = normalizeCriteria({
      ...extracted,
      locations: (extracted.locations || []).slice(0, 5),
      keywords: null, // preferences are ranked by the model, not used as a hard text filter
    });

    let relaxed = false;
    let properties = await this.crm.searchProperties(criteria);
    if (!properties.length) {
      relaxed = true;
      properties = await this.crm.searchProperties(relax(criteria));
      if (!properties.length) properties = await this.crm.searchProperties({ ...relax(criteria), locations: [] });
    }

    const result = { criteria, preferences: extracted.preferences || [], interpretation: extracted.summary, relaxed };
    if (!properties.length) return { ...result, overview: null, results: [] };

    const candidates = properties.slice(0, MAX_RANKED);
    const ranking = await this.client.completeJson({
      ...rankingPrompt({ candidateIds: candidates.map((p) => p.id), relaxed, currency }),
      user: {
        clientRequest: query,
        preferences: extracted.preferences,
        filtersApplied: criteria,
        candidates: candidates.map(listingForModel),
      },
    });

    // Trust the model for order and wording only; property data comes from the CRM.
    const byId = new Map(properties.map((p) => [p.id, p]));
    const seen = new Set();
    const ranked = [];
    for (const r of [...(ranking.results || [])].sort((a, b) => b.score - a.score)) {
      if (!byId.has(r.id) || seen.has(r.id)) continue;
      seen.add(r.id);
      ranked.push({ property: byId.get(r.id), score: Math.max(0, Math.min(100, r.score)), reason: r.reason });
    }
    for (const p of properties) if (!seen.has(p.id)) ranked.push({ property: p, score: null, reason: null });

    return { ...result, overview: ranking.overview, results: ranked };
  }

  // ---- Deal insights ------------------------------------------------------

  dealFacts(deal, stages, property) {
    const { wonStages, lostStages } = this.config.crm;
    const openStages = stages.filter((s) => !wonStages.includes(s) && !lostStages.includes(s));
    const status = wonStages.includes(deal.stage) ? 'closed-won' : lostStages.includes(deal.stage) ? 'closed-lost' : 'open';
    return {
      id: deal.id,
      name: deal.name,
      type: deal.type,
      stage: deal.stage,
      status,
      stagePosition: status === 'open' ? `${openStages.indexOf(deal.stage) + 1} of ${openStages.length}` : null,
      pipeline: openStages,
      amount: deal.amount,
      targetClosingDate: deal.closingDate,
      daysUntilClosing: daysBetween(today(), deal.closingDate),
      lastUpdated: deal.modifiedAt,
      daysSinceLastUpdate: daysBetween(deal.modifiedAt, new Date(this.now()).toISOString()),
      latestUpdateFromAgent: deal.description,
      property: property ? listingForModel(property) : deal.property?.name || null,
    };
  }

  async dealInsights(contactId, dealId) {
    const deal = await this.crm.getDeal(contactId, dealId);
    if (!deal) return null;
    const [stages, property] = await Promise.all([
      this.crm.getStages(),
      deal.property ? this.crm.getProperty(deal.property.id) : null,
    ]);
    const facts = this.dealFacts(deal, stages, property);
    // Re-generated only when the deal (or the day) changes.
    return this.cached(`deal:${contactId}:${hash({ facts, day: today() })}`, () => {
      this.consume(contactId);
      return this.client.completeJson({
        ...dealInsightPrompt({ today: today(), currency: this.config.currency }),
        user: { deal: facts },
      });
    });
  }

  async portfolioInsights(contactId) {
    const [deals, stages] = await Promise.all([this.crm.listDeals(contactId), this.crm.getStages()]);
    if (!deals.length) return { overview: null, priorities: [] };
    const facts = deals.map((d) => this.dealFacts(d, stages, null));
    const insight = await this.cached(`portfolio:${contactId}:${hash({ facts, day: today() })}`, () => {
      this.consume(contactId);
      return this.client.completeJson({
        ...portfolioInsightPrompt({ today: today(), currency: this.config.currency, dealIds: deals.map((d) => d.id) }),
        user: { deals: facts },
      });
    });
    const names = new Map(deals.map((d) => [d.id, d.name]));
    return {
      overview: insight.overview,
      priorities: (insight.priorities || [])
        .filter((p) => names.has(p.dealId))
        .map((p) => ({ dealId: p.dealId, dealName: names.get(p.dealId), note: p.note })),
    };
  }
}

// Near-match search: allow ~15% over budget, one fewer bedroom, and drop the
// secondary size filters.
function relax(c) {
  return {
    ...c,
    budgetMin: null,
    budgetMax: c.budgetMax !== null ? Math.round(c.budgetMax * 1.15) : null,
    minBedrooms: c.minBedrooms ? Math.max(0, c.minBedrooms - 1) : null,
    minBathrooms: null,
    minFloorArea: null,
  };
}

module.exports = { AiService, AiLimitError, relax };
