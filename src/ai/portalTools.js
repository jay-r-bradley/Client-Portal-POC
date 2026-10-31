// The only tools the AI model can call. Each set is created per request and is
// bound to the signed-in client's Contact id in code, so no prompt can make the
// model read another client's deals. CRM lookups run through `crm`, which is the
// Zoho MCP-backed service when ZOHO_MCP_URL is configured.

const { normalizeCriteria, CriteriaError } = require('../propertyCriteria');

const MAX_LISTINGS_RETURNED = 25;
const DAY_MS = 24 * 3600 * 1000;

const nullable = (type) => ({ type: [type, 'null'] });
const nullableEnum = (values) => (values.length ? { type: ['string', 'null'], enum: [...values, null] } : nullable('string'));
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  const diff = new Date(to) - new Date(from);
  return Number.isFinite(diff) ? Math.round(diff / DAY_MS) : null;
}

// Only the listing facts the model needs to compare properties.
function listingForModel(p) {
  return {
    id: p.id, name: p.name, city: p.city, address: p.address, price: p.price, listingType: p.listingType,
    propertyType: p.propertyType, bedrooms: p.bedrooms, bathrooms: p.bathrooms, floorArea: p.floorArea,
    status: p.status, description: p.description,
  };
}

// Deal facts plus derived timing, without any contact details.
function dealFacts(deal, stages, { crm: { wonStages, lostStages } }, nowMs) {
  const openStages = stages.filter((s) => !wonStages.includes(s) && !lostStages.includes(s));
  const status = wonStages.includes(deal.stage) ? 'closed-won' : lostStages.includes(deal.stage) ? 'closed-lost' : 'open';
  return {
    id: deal.id,
    name: deal.name,
    type: deal.type,
    stage: deal.stage,
    status,
    stagePosition: status === 'open' && openStages.includes(deal.stage) ? `${openStages.indexOf(deal.stage) + 1} of ${openStages.length}` : null,
    pipeline: openStages,
    amount: deal.amount,
    targetClosingDate: deal.closingDate,
    daysUntilClosing: daysBetween(isoDay(nowMs), deal.closingDate),
    lastUpdated: deal.modifiedAt,
    daysSinceLastUpdate: daysBetween(deal.modifiedAt, new Date(nowMs).toISOString()),
    latestUpdateFromAgent: deal.description,
    propertyId: deal.property?.id || null,
    propertyName: deal.property?.name || null,
  };
}

async function createPortalTools({ crm, contactId, config, now = () => Date.now() }) {
  // Per-request memo: the model often asks for the same thing twice.
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn().catch((err) => { memo.delete(key); throw err; }));
    return memo.get(key);
  };
  // Guests have no Contact, so no deals.
  const myDeals = () => (contactId ? once('deals', () => crm.listDeals(contactId)) : Promise.resolve([]));
  const stages = () => once('stages', () => crm.getStages());

  // What the model has actually been shown, so its answer can be checked against it.
  const state = { listings: new Map(), searches: [] };
  const remember = (property) => {
    state.listings.set(property.id, property);
    return listingForModel(property);
  };

  const options = await crm.getPropertyFilterOptions().catch(() => ({ propertyTypes: [], listingTypes: [] }));

  const tools = [
    {
      name: 'list_my_deals',
      description: "List all of the client's deals with stage, amount, dates and timing.",
      inputSchema: object({}),
      handler: async () => {
        const [deals, pipeline] = await Promise.all([myDeals(), stages()]);
        return { deals: deals.map((d) => dealFacts(d, pipeline, config, now())) };
      },
    },
    {
      name: 'get_deal',
      description: "Get one of the client's deals by id, including full details of the linked property.",
      inputSchema: object({ deal_id: { type: 'string' } }),
      handler: async ({ deal_id: dealId }) => {
        const deal = (await myDeals()).find((d) => d.id === String(dealId));
        if (!deal) return { error: 'No deal with that id belongs to this client.' };
        const [pipeline, property] = await Promise.all([
          stages(),
          deal.property ? once(`property:${deal.property.id}`, () => crm.getProperty(deal.property.id)) : null,
        ]);
        return { deal: dealFacts(deal, pipeline, config, now()), property: property ? remember(property) : null };
      },
    },
    {
      name: 'search_listings',
      description:
        'Search currently available listings. Every non-null argument is a hard filter. Locations match city names (any of them). ' +
        `Prices are in ${config.currency}; rent is per month. Returns at most ${MAX_LISTINGS_RETURNED} listings, cheapest first.`,
      inputSchema: object({
        budget_min: nullable('number'),
        budget_max: nullable('number'),
        locations: { type: 'array', items: { type: 'string' } },
        listing_type: nullableEnum(options.listingTypes),
        property_type: nullableEnum(options.propertyTypes),
        min_bedrooms: nullable('number'),
        min_bathrooms: nullable('number'),
        min_floor_area: nullable('number'),
      }),
      handler: async (args) => {
        let criteria;
        try {
          criteria = normalizeCriteria({
            budgetMin: args.budget_min, budgetMax: args.budget_max, locations: (args.locations || []).slice(0, 5),
            listingType: args.listing_type, propertyType: args.property_type, minBedrooms: args.min_bedrooms,
            minBathrooms: args.min_bathrooms, minFloorArea: args.min_floor_area,
          });
        } catch (err) {
          if (err instanceof CriteriaError) return { error: err.message };
          throw err;
        }
        const results = await crm.searchProperties(criteria);
        state.searches.push({ criteria, results });
        return { count: results.length, listings: results.slice(0, MAX_LISTINGS_RETURNED).map(remember) };
      },
    },
    {
      name: 'get_listing',
      description: 'Get full details of one listing by id.',
      inputSchema: object({ listing_id: { type: 'string' } }),
      handler: async ({ listing_id: listingId }) => {
        const property = await once(`property:${listingId}`, () => crm.getProperty(String(listingId)));
        // Off-market listings are only visible if the client has a deal on them.
        const visible = property && (property.status === config.crm.availableStatus
          || (await myDeals()).some((d) => d.property?.id === property.id));
        return visible ? { listing: remember(property) } : { error: 'No available listing with that id.' };
      },
    },
  ];

  return {
    tools,
    state,
    pick: (...names) => tools.filter((t) => names.includes(t.name)),
    myDeals,
    stages,
  };
}

module.exports = { createPortalTools, dealFacts, listingForModel };
