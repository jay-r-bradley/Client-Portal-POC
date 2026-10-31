// AI features. The model works as a small agent: it calls client-scoped portal
// tools (see portalTools.js), which read the CRM through Zoho MCP when it is
// configured. Answers are schema-checked, and anything the model says about a
// listing or deal is matched back to records the tools actually returned.

const crypto = require('node:crypto');
const { runAgent } = require('./agent');
const { createPortalTools, dealFacts } = require('./portalTools');
const { propertySearchPrompt, dealInsightPrompt, portfolioInsightPrompt } = require('./prompts');

class AiLimitError extends Error {}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

class AiService {
  // `crm` is the CRM service the AI reads through: Zoho MCP-backed in live
  // setups, otherwise the same service the pages use.
  constructor({ client, crm, config, now = () => Date.now() }) {
    this.client = client;
    this.crm = crm;
    this.config = config;
    this.now = now;
    this.cache = new Map();
    this.usage = new Map();
  }

  today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  // ---- Guards -------------------------------------------------------------

  // Per-account hourly cap so one account cannot run up the OpenAI bill.
  consume(key, max = this.config.ai.maxRequestsPerHour) {
    const windowStart = this.now() - 3600 * 1000;
    const recent = (this.usage.get(key) || []).filter((t) => t > windowStart);
    if (recent.length >= max) {
      throw new AiLimitError('You have reached the hourly limit for the AI assistant. Please try again later.');
    }
    recent.push(this.now());
    this.usage.set(key, recent);
  }

  async cached(key, compute) {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const value = await compute();
    this.cache.set(key, { value, expiresAt: this.now() + this.config.ai.cacheMinutes * 60 * 1000 });
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  portalTools(contactId) {
    return createPortalTools({ crm: this.crm, contactId, config: this.config, now: this.now });
  }

  agent(prompt, { user, tools }) {
    return runAgent({ client: this.client, ...prompt, user, tools, maxSteps: this.config.ai.maxSteps });
  }

  // ---- Natural-language property search -----------------------------------

  // Guests (no Zoho Contact) get the same matcher without any deal tools, under
  // their own, smaller hourly allowance.
  async propertySearch(contactId, query, { guestId = null } = {}) {
    if (guestId) this.consume(`guest:${guestId}`, this.config.ai.guestMaxRequestsPerHour);
    else this.consume(contactId);
    const portal = await this.portalTools(guestId ? null : contactId);
    const { result } = await this.agent(propertySearchPrompt({ currency: this.config.currency, today: this.today() }), {
      user: { clientRequest: query },
      tools: guestId ? portal.pick('search_listings', 'get_listing') : portal.pick('search_listings', 'get_listing', 'list_my_deals'),
    });

    // Trust the model for order and wording only; property data comes from the CRM.
    const { listings, searches } = portal.state;
    const seen = new Set();
    const results = [];
    for (const r of [...(result.results || [])].sort((a, b) => b.score - a.score)) {
      const property = listings.get(r.id);
      if (!property || seen.has(r.id) || property.status !== this.config.crm.availableStatus) continue;
      seen.add(r.id);
      results.push({ property, score: Math.max(0, Math.min(100, r.score)), reason: r.reason });
    }
    // Keep matches from the final search that the model did not rank.
    const finalSearch = searches[searches.length - 1];
    for (const p of finalSearch?.results || []) if (!seen.has(p.id)) results.push({ property: p, score: null, reason: null });

    const firstSearchEmpty = searches.length > 0 && searches[0].results.length === 0;
    return {
      criteria: finalSearch?.criteria || null,
      preferences: result.preferences || [],
      interpretation: result.interpretation,
      relaxed: Boolean(results.length && (result.relaxed || firstSearchEmpty)),
      overview: result.overview,
      results,
    };
  }

  // ---- Deal insights ------------------------------------------------------

  async dealInsights(contactId, dealId) {
    const portal = await this.portalTools(contactId);
    const deal = (await portal.myDeals()).find((d) => d.id === String(dealId));
    if (!deal) return null;
    const facts = dealFacts(deal, await portal.stages(), this.config, this.now());
    // Regenerated only when the deal (or the day) changes.
    return this.cached(`deal:${contactId}:${hash({ facts, day: this.today() })}`, async () => {
      this.consume(contactId);
      const { result } = await this.agent(dealInsightPrompt({ today: this.today(), currency: this.config.currency }), {
        user: { deal: facts },
        tools: portal.pick('get_listing', 'list_my_deals'),
      });
      return result;
    });
  }

  async portfolioInsights(contactId) {
    const portal = await this.portalTools(contactId);
    const [deals, stages] = await Promise.all([portal.myDeals(), portal.stages()]);
    if (!deals.length) return { overview: null, priorities: [] };
    const facts = deals.map((d) => dealFacts(d, stages, this.config, this.now()));

    const insight = await this.cached(`portfolio:${contactId}:${hash({ facts, day: this.today() })}`, async () => {
      this.consume(contactId);
      const prompt = portfolioInsightPrompt({ today: this.today(), currency: this.config.currency, dealIds: deals.map((d) => d.id) });
      const { result } = await this.agent(prompt, { user: { deals: facts }, tools: portal.pick('get_deal') });
      return result;
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

module.exports = { AiService, AiLimitError };
