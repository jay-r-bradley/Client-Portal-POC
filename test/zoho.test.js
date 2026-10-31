const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { buildPropertyQuery, mapDeal, quote } = require('../src/zoho/mappers');
const { normalizeCriteria } = require('../src/propertyCriteria');
const { LiveCrm } = require('../src/zoho/liveCrm');
const { ZohoApi } = require('../src/zoho/zohoApi');

const queryOptions = { module: 'Properties', fields: config.crm.property, availableStatus: 'Available' };

test('COQL query includes every criterion with explicit pairwise parentheses', () => {
  const criteria = normalizeCriteria({
    budgetMin: '200000', budgetMax: '600000', preferredLocation: 'Austin', otherLocations: 'Dallas, Plano',
    listingType: 'Sale', minBedrooms: '3', sort: 'price_desc',
  });
  const q = buildPropertyQuery(criteria, queryOptions);
  assert.match(q, /^select .* from Properties where /);
  assert.ok(q.includes("((City like '%Austin%' or City like '%Dallas%') or City like '%Plano%')"));
  assert.ok(q.includes("(((((Status = 'Available' and Price >= 200000) and Price <= 600000)"));
  assert.ok(q.includes("Listing_Type = 'Sale'"));
  assert.ok(q.includes('Bedrooms >= 3'));
  assert.ok(q.endsWith('order by Price desc limit 100'));
});

test('COQL literals escape quotes so client input cannot break out', () => {
  assert.equal(quote("O'Hare"), "'O\\'Hare'");
  assert.equal(quote("x\\' or 1=1"), "'x\\\\\\' or 1=1'");
  const q = buildPropertyQuery(normalizeCriteria({ preferredLocation: "a' or Status = 'Sold" }), queryOptions);
  assert.ok(q.includes("City like '%a\\' or Status = \\'Sold%'"));
});

test('criteria validation rejects bad budgets and too many locations', () => {
  assert.throws(() => normalizeCriteria({ budgetMin: 5, budgetMax: 1 }), /cannot be greater/);
  assert.throws(() => normalizeCriteria({ budgetMax: 'abc' }), /positive number/);
  assert.throws(() => normalizeCriteria({ otherLocations: 'a,b,c,d,e,f' }), /at most 5/);
  assert.deepEqual(normalizeCriteria({ preferredLocation: 'Austin', otherLocations: 'austin, Austin ,' }).locations, ['Austin', 'austin']);
});

test('mapDeal reads configured field names', () => {
  const deal = mapDeal({
    id: 123, Deal_Name: 'D', Stage: 'Negotiation', Amount: '1000', Contact_Name: { id: 9, name: 'C' },
    Property: { id: 5, name: 'Prop' }, Owner: { id: 7, name: 'Agent', email: 'a@x' },
  }, config.crm.deal);
  assert.equal(deal.id, '123');
  assert.equal(deal.amount, 1000);
  assert.equal(deal.contactId, '9');
  assert.deepEqual(deal.property, { id: '5', name: 'Prop' });
  assert.equal(deal.agent.email, 'a@x');
});

function fakeApi(overrides = {}) {
  const calls = [];
  return {
    calls,
    getRecord: async () => null,
    getRelatedRecords: async () => [],
    getUser: async (id) => ({ id, full_name: 'Agent Smith', email: 'agent@x' }),
    getFields: async () => [],
    createRecord: async (module, record) => {
      calls.push({ module, record });
      return { id: `${module}-1`, Created_Time: '2026-01-01T00:00:00Z' };
    },
    ...overrides,
  };
}

test('LiveCrm.getDeal hides deals that belong to another contact', async () => {
  const api = fakeApi({ getRecord: async () => ({ id: 'd1', Deal_Name: 'X', Contact_Name: { id: 'other' } }) });
  const crm = new LiveCrm(config, { api });
  assert.equal(await crm.getDeal('me', 'd1'), null);
});

test('LiveCrm.listMessages only exposes portal notes, never internal ones', async () => {
  const api = fakeApi({
    getRelatedRecords: async () => [
      { id: 1, Note_Title: '[Client Portal] Hello', Note_Content: 'from client', Created_Time: '2026-01-02T00:00:00Z' },
      { id: 2, Note_Title: 'Internal: client is price sensitive', Note_Content: 'secret', Created_Time: '2026-01-01T00:00:00Z' },
      { id: 3, Note_Title: '[Portal Reply] Re: Hello', Note_Content: 'from agent', Created_Time: '2026-01-03T00:00:00Z', Owner: { name: 'Maria' } },
    ],
  });
  const messages = await new LiveCrm(config, { api }).listMessages('c1');
  assert.deepEqual(messages.map((m) => [m.from, m.subject]), [['client', 'Hello'], ['agent', 'Re: Hello']]);
  assert.ok(!JSON.stringify(messages).includes('secret'));
});

test('LiveCrm.sendMessage creates a contact note and a task for the deal owner', async () => {
  const api = fakeApi({ getRecord: async () => ({ id: 'c1', Full_Name: 'Alex', Owner: { id: 'u-contact' } }) });
  const crm = new LiveCrm(config, { api });
  const deal = { id: 'd1', name: 'Deal', stage: 'Offer Made', agent: { id: 'u-deal' } };
  await crm.sendMessage('c1', { subject: 'Hi', body: 'Body', deal, property: null });

  const [note, task] = api.calls;
  assert.equal(note.module, 'Notes');
  assert.equal(note.record.Note_Title, '[Client Portal] Hi');
  assert.deepEqual(note.record.Parent_Id, { module: { api_name: 'Contacts' }, id: 'c1' });
  assert.equal(task.module, 'Tasks');
  assert.deepEqual(task.record.Owner, { id: 'u-deal' });
  assert.deepEqual(task.record.What_Id, { id: 'd1' });
  assert.equal(task.record.$se_module, 'Deals');
});

test('LiveCrm.getStages follows the Zoho picklist order', async () => {
  const api = fakeApi({
    getFields: async () => [{ api_name: 'Stage', pick_list_values: [
      { display_value: 'B', sequence_number: 2 }, { display_value: '-None-', sequence_number: 0 }, { display_value: 'A', sequence_number: 1 },
    ] }],
  });
  assert.deepEqual(await new LiveCrm(config, { api }).getStages(), ['A', 'B']);
});

test('ZohoApi refreshes the access token once and retries on INVALID_TOKEN', async () => {
  let tokenCalls = 0;
  let apiCalls = 0;
  const fetchImpl = async (url, opts) => {
    if (String(url).includes('/oauth/v2/token')) {
      tokenCalls++;
      return Response.json({ access_token: `t${tokenCalls}`, expires_in: 3600 });
    }
    apiCalls++;
    if (opts.headers.Authorization === 'Zoho-oauthtoken t1') {
      return Response.json({ code: 'INVALID_TOKEN', message: 'expired' }, { status: 401 });
    }
    return Response.json({ data: [{ id: 'c1' }] });
  };
  const api = new ZohoApi({ ...config.zoho, clientId: 'id', clientSecret: 's', refreshToken: 'r', fetchImpl });
  assert.deepEqual(await api.getRecord('Contacts', 'c1'), { id: 'c1' });
  assert.equal(tokenCalls, 2);
  assert.equal(apiCalls, 2);
});

test('ZohoApi treats 204 No Content as an empty result', async () => {
  const fetchImpl = async (url) =>
    String(url).includes('/oauth/') ? Response.json({ access_token: 't', expires_in: 3600 }) : new Response(null, { status: 204 });
  const api = new ZohoApi({ ...config.zoho, clientId: 'id', clientSecret: 's', refreshToken: 'r', fetchImpl });
  assert.deepEqual(await api.coql('select id from Properties where id is not null'), []);
});

test('featured query filters on the checkbox and orders by listing date', () => {
  const { buildFeaturedQuery } = require('../src/zoho/mappers');
  const q = buildFeaturedQuery({ module: 'Properties', fields: config.crm.property, availableStatus: 'Available', featuredOnly: true, limit: 6 });
  assert.match(q, /where \(Status = 'Available' and Featured = true\) order by Listed_Date desc limit 6$/);
  const newest = buildFeaturedQuery({ module: 'Properties', fields: config.crm.property, availableStatus: 'Available', featuredOnly: false, limit: 6 });
  assert.match(newest, /where Status = 'Available' order by Listed_Date desc limit 6$/);
});
