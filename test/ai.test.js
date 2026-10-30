const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { OpenAiClient, AiError } = require('../src/ai/openaiClient');
const { AiService, AiLimitError } = require('../src/ai/aiService');
const { MockCrm } = require('../src/zoho/mockCrm');
const { createApp } = require('../src/app');
const { UserStore } = require('../src/store/userStore');

const aiConfig = { ...config, ai: { ...config.ai, maxRequestsPerHour: 30, cacheMinutes: 60 } };

const criteria = (overrides = {}) => ({
  summary: 'You want a home in Austin.', budgetMin: null, budgetMax: null, locations: [], listingType: null,
  propertyType: null, minBedrooms: null, minBathrooms: null, minFloorArea: null, preferences: [], ...overrides,
});

// Fake model: answers each prompt by schema name, records what it was sent.
function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    async completeJson(req) {
      calls.push(req);
      const answer = answers[req.name];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(req) : answer;
    },
  };
}

test('OpenAiClient requests strict JSON-schema output and parses it', async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
  };
  const client = new OpenAiClient({ apiKey: 'sk-test', model: 'test-model', fetchImpl });
  const out = await client.completeJson({ name: 'x', schema: { type: 'object' }, system: 'sys', user: { a: 1 } });
  assert.deepEqual(out, { ok: true });
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer sk-test');
  assert.equal(sent.body.model, 'test-model');
  assert.equal(sent.body.response_format.json_schema.strict, true);
  assert.equal(sent.body.messages[1].content, '{"a":1}');
});

test('OpenAiClient surfaces refusals and HTTP errors as AiError', async () => {
  const refuse = new OpenAiClient({ apiKey: 'k', model: 'm', fetchImpl: async () => Response.json({ choices: [{ message: { refusal: 'no' } }] }) });
  await assert.rejects(refuse.completeJson({ name: 'x', schema: {}, system: '', user: '' }), AiError);
  const fail = new OpenAiClient({ apiKey: 'k', model: 'm', fetchImpl: async () => Response.json({ error: { message: 'bad key' } }, { status: 401 }) });
  await assert.rejects(fail.completeJson({ name: 'x', schema: {}, system: '', user: '' }), /bad key/);
});

test('AI search uses extracted criteria as hard filters and keeps CRM data authoritative', async () => {
  const client = fakeClient({
    property_search_criteria: criteria({ budgetMax: 650000, locations: ['Austin'], listingType: 'Sale', minBedrooms: 3, preferences: ['pool'] }),
    property_ranking: (req) => {
      assert.deepEqual(req.schema.properties.results.items.properties.id.enum.sort(), ['p1', 'p15']);
      return { overview: 'Two good options.', results: [
        { id: 'p15', score: 90, reason: 'Near Zilker Park.' },
        { id: 'p999', score: 99, reason: 'Hallucinated listing.' },
      ] };
    },
  });
  const ai = new AiService({ client, crm: new MockCrm(config), config: aiConfig });
  const out = await ai.propertySearch('c1', '3 bed in Austin under 650k with a pool');

  assert.equal(out.relaxed, false);
  assert.deepEqual(out.results.map((r) => r.property.id), ['p15', 'p1']); // ranked first, unranked kept, fake id dropped
  assert.equal(out.results[0].property.price, 599000);
  assert.equal(out.results[1].reason, null);
  assert.deepEqual(out.preferences, ['pool']);
  assert.equal(out.criteria.keywords, null, 'soft preferences must not become a hard text filter');
});

test('AI search falls back to near matches when nothing meets every requirement', async () => {
  const client = fakeClient({
    property_search_criteria: criteria({ budgetMax: 400000, locations: ['Austin'], listingType: 'Sale', minBedrooms: 3 }),
    property_ranking: (req) => {
      assert.match(req.system, /near matches/);
      return { overview: 'Closest options.', results: [] };
    },
  });
  const out = await new AiService({ client, crm: new MockCrm(config), config: aiConfig }).propertySearch('c1', 'cheap 3 bed in Austin');
  assert.equal(out.relaxed, true);
  assert.ok(out.results.length > 0);
  assert.ok(out.results.every((r) => r.property.listingType === 'Sale' && r.property.price <= 460000));
});

test('deal insights only cover the client\'s own deals and are cached', async () => {
  const insight = { headline: 'Negotiating', summary: 's', nextSteps: [], watchOuts: [], questionsToAsk: [] };
  const client = fakeClient({ deal_insight: insight });
  const ai = new AiService({ client, crm: new MockCrm(config), config: aiConfig });

  assert.equal(await ai.dealInsights('c1', 'd5'), null); // d5 belongs to c2
  assert.deepEqual(await ai.dealInsights('c1', 'd1'), insight);
  await ai.dealInsights('c1', 'd1');
  assert.equal(client.calls.length, 1);

  const sent = client.calls[0].user.deal;
  assert.equal(sent.stage, 'Negotiation');
  assert.equal(sent.stagePosition, '4 of 5');
  assert.equal(typeof sent.daysUntilClosing, 'number');
  assert.ok(!JSON.stringify(client.calls[0]).includes('@'), 'no email addresses are sent to the model');
});

test('portfolio insights drop priorities for unknown deals', async () => {
  const client = fakeClient({
    portfolio_insight: { overview: 'Two open deals.', priorities: [{ dealId: 'd1', note: 'Closing soon.' }, { dealId: 'd5', note: 'x' }] },
  });
  const out = await new AiService({ client, crm: new MockCrm(config), config: aiConfig }).portfolioInsights('c1');
  assert.deepEqual(out.priorities, [{ dealId: 'd1', dealName: 'Rivera - Lakeview Townhouse purchase', note: 'Closing soon.' }]);
  assert.deepEqual(client.calls[0].schema.properties.priorities.items.properties.dealId.enum, ['d1', 'd2', 'd3', 'd4']);
});

test('AI usage is capped per client per hour', async () => {
  const client = fakeClient({ property_search_criteria: criteria(), property_ranking: { overview: '', results: [] } });
  const ai = new AiService({ client, crm: new MockCrm(config), config: { ...aiConfig, ai: { ...aiConfig.ai, maxRequestsPerHour: 2 } } });
  await ai.propertySearch('c1', 'anything');
  await ai.propertySearch('c1', 'anything');
  await assert.rejects(ai.propertySearch('c1', 'anything'), AiLimitError);
  await ai.propertySearch('c2', 'anything'); // other clients are unaffected
});

async function startApp(ai) {
  const userStore = new UserStore(null);
  await userStore.upsert({ email: 'alex@client.example', password: 'demo1234', contactId: 'c1', name: 'Alex' });
  const app = createApp({ config, crm: new MockCrm(config), userStore, ai });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alex@client.example', password: 'demo1234' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (path, body) => fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { server, base, call };
}

test('AI endpoints are hidden when no OpenAI key is configured', async () => {
  const { server, base, call } = await startApp(null);
  try {
    assert.equal((await (await fetch(`${base}/config`)).json()).aiEnabled, false);
    assert.equal((await call('/ai/insights')).status, 404);
  } finally {
    server.close();
  }
});

test('AI endpoints require sign-in, validate input and hide provider errors', async () => {
  const client = fakeClient({ property_search_criteria: new AiError('upstream exploded with secret details') });
  const { server, base, call } = await startApp(new AiService({ client, crm: new MockCrm(config), config: aiConfig }));
  try {
    assert.equal((await fetch(`${base}/ai/insights`)).status, 401);
    assert.equal((await call('/ai/property-search', { query: 'x' })).status, 400);
    const res = await call('/ai/property-search', { query: 'a flat in Dallas' });
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('secret'));
  } finally {
    server.close();
  }
});
