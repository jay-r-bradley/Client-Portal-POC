const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { OpenAiClient, AiError } = require('../src/ai/openaiClient');
const { runAgent } = require('../src/ai/agent');
const { AiService, AiLimitError } = require('../src/ai/aiService');
const { createPortalTools } = require('../src/ai/portalTools');
const { MockCrm } = require('../src/zoho/mockCrm');
const { createApp } = require('../src/app');
const { UserStore } = require('../src/store/userStore');

const aiConfig = { ...config, ai: { ...config.ai, maxRequestsPerHour: 30, cacheMinutes: 60, maxSteps: 6 } };

// ---- Scripted model ---------------------------------------------------------

let callSeq = 0;
const toolCall = (name, args) => ({ id: `call_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const callTools = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const answer = (json) => ({ role: 'assistant', content: JSON.stringify(json) });

// Plays back one scripted reply per model turn; a step may be a function of the request.
function scriptedClient(steps) {
  const requests = [];
  return {
    requests,
    async chat(req) {
      requests.push(structuredClone(req));
      const step = steps[requests.length - 1];
      if (!step) throw new Error('Model was called more times than scripted');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(req) : step;
    },
  };
}

const toolResults = (req) => req.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));

// ---- OpenAI client & agent loop --------------------------------------------

test('OpenAiClient sends tools and a strict output schema together', async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
  };
  const client = new OpenAiClient({ apiKey: 'sk-test', model: 'test-mini', fetchImpl });
  const message = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
    output: { name: 'out', schema: { type: 'object' } },
  });
  assert.equal(message.content, '{"ok":true}');
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent.auth, 'Bearer sk-test');
  assert.equal(sent.body.model, 'test-mini');
  assert.equal(sent.body.tool_choice, 'auto');
  assert.equal(sent.body.response_format.json_schema.strict, true);
});

test('OpenAiClient surfaces refusals and HTTP errors as AiError', async () => {
  const refuse = new OpenAiClient({ apiKey: 'k', model: 'm', fetchImpl: async () => Response.json({ choices: [{ message: { refusal: 'no' } }] }) });
  await assert.rejects(refuse.completeJson({ name: 'x', schema: {}, system: '', user: '' }), AiError);
  const fail = new OpenAiClient({ apiKey: 'k', model: 'm', fetchImpl: async () => Response.json({ error: { message: 'bad key' } }, { status: 401 }) });
  await assert.rejects(fail.completeJson({ name: 'x', schema: {}, system: '', user: '' }), /bad key/);
});

test('agent runs tool calls, feeds results back, and forces an answer on the last step', async () => {
  const tools = [{ name: 'echo', description: '', inputSchema: {}, handler: async ({ v }) => ({ echoed: v }) }];
  const client = scriptedClient([
    callTools(toolCall('echo', { v: 1 }), toolCall('missing_tool', {})),
    (req) => {
      assert.deepEqual(toolResults(req), [{ echoed: 1 }, { error: 'Unknown tool: missing_tool' }]);
      return callTools(toolCall('echo', { v: 2 }));
    },
    (req) => {
      assert.equal(req.toolChoice, 'none');
      return answer({ done: true });
    },
  ]);
  const { result, trace } = await runAgent({ client, system: 's', user: 'u', tools, output: { name: 'o', schema: {} }, maxSteps: 3 });
  assert.deepEqual(result, { done: true });
  assert.deepEqual(trace.map((t) => t.tool), ['echo', 'missing_tool', 'echo']);
});

test('agent hides tool failure details from the model', async () => {
  const tools = [{ name: 'boom', description: '', inputSchema: {}, handler: async () => { throw new Error('db password=hunter2'); } }];
  const client = scriptedClient([
    callTools(toolCall('boom', {})),
    (req) => {
      assert.ok(!JSON.stringify(req.messages).includes('hunter2'));
      return answer({});
    },
  ]);
  await runAgent({ client, system: 's', user: 'u', tools, output: { name: 'o', schema: {} } });
});

// ---- Portal tools: client isolation -----------------------------------------

test('portal tools are bound to the signed-in client', async () => {
  const portal = await createPortalTools({ crm: new MockCrm(config), contactId: 'c1', config });
  const call = (name, args) => portal.tools.find((t) => t.name === name).handler(args);

  assert.deepEqual((await call('list_my_deals', {})).deals.map((d) => d.id), ['d1', 'd2', 'd3', 'd4']);
  assert.match((await call('get_deal', { deal_id: 'd5' })).error, /No deal/); // Priya's deal
  assert.equal((await call('get_deal', { deal_id: 'd1' })).property.id, 'p1');
  assert.ok((await call('get_listing', { listing_id: 'p16' })).listing, 'off-market, but Alex has a deal on it');

  const priya = await createPortalTools({ crm: new MockCrm(config), contactId: 'c2', config });
  assert.match((await priya.tools.find((t) => t.name === 'get_listing').handler({ listing_id: 'p16' })).error, /No available listing/);
});

test('every portal tool schema is valid for strict function calling', async () => {
  const { tools } = await createPortalTools({ crm: new MockCrm(config), contactId: 'c1', config });
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.deepEqual(tool.inputSchema.required.sort(), Object.keys(tool.inputSchema.properties).sort(), tool.name);
  }
});

// ---- AI features ------------------------------------------------------------

const searchArgs = (overrides) => ({
  budget_min: null, budget_max: null, locations: [], listing_type: null, property_type: null,
  min_bedrooms: null, min_bathrooms: null, min_floor_area: null, ...overrides,
});

test('AI search: the agent searches via tools and results are matched back to CRM records', async () => {
  const client = scriptedClient([
    callTools(toolCall('search_listings', searchArgs({ budget_max: 650000, locations: ['Austin'], listing_type: 'Sale', min_bedrooms: 3 }))),
    (req) => {
      assert.deepEqual(toolResults(req)[0].listings.map((l) => l.id), ['p1', 'p18', 'p15']);
      return answer({
        interpretation: 'A 3-bed home in Austin under $650k.', preferences: ['pool'], relaxed: false, overview: 'Two options.',
        results: [{ id: 'p15', score: 90, reason: 'Near Zilker Park.' }, { id: 'p999', score: 99, reason: 'Invented listing.' }],
      });
    },
  ]);
  const ai = new AiService({ client, crm: new MockCrm(config), config: aiConfig });
  const out = await ai.propertySearch('c1', '3 bed in Austin under 650k with a pool');

  assert.deepEqual(out.results.map((r) => r.property.id), ['p15', 'p1', 'p18']); // ranked, then unranked; invented id dropped
  assert.equal(out.results[0].property.price, 599000);
  assert.equal(out.results[1].reason, null);
  assert.equal(out.relaxed, false);
  assert.equal(out.criteria.budgetMax, 650000, 'the form is filled from the filters actually applied');
});

test('AI search: an empty first search followed by a looser one is reported as relaxed', async () => {
  const client = scriptedClient([
    callTools(toolCall('search_listings', searchArgs({ budget_max: 400000, locations: ['Austin'], listing_type: 'Sale', min_bedrooms: 3 }))),
    callTools(toolCall('search_listings', searchArgs({ budget_max: 460000, listing_type: 'Sale', min_bedrooms: 2 }))),
    (req) => {
      const [first, second] = toolResults(req);
      assert.equal(first.count, 0);
      return answer({ interpretation: 'x', preferences: [], relaxed: false, overview: 'Closest options.', results: second.listings.map((l) => ({ id: l.id, score: 60, reason: 'Outside Austin.' })) });
    },
  ]);
  const out = await new AiService({ client, crm: new MockCrm(config), config: aiConfig }).propertySearch('c1', 'cheap 3 bed in Austin');
  assert.equal(out.relaxed, true);
  assert.ok(out.results.length > 0 && out.results.every((r) => r.property.price <= 460000));
});

test('deal insights only cover the client\'s own deals, send no contact details, and are cached', async () => {
  const insight = { headline: 'Negotiating', summary: 's', nextSteps: [], watchOuts: [], questionsToAsk: [] };
  const client = scriptedClient([callTools(toolCall('get_listing', { listing_id: 'p1' })), answer(insight)]);
  const ai = new AiService({ client, crm: new MockCrm(config), config: aiConfig });

  assert.equal(await ai.dealInsights('c1', 'd5'), null); // d5 belongs to c2
  assert.deepEqual(await ai.dealInsights('c1', 'd1'), insight);
  await ai.dealInsights('c1', 'd1');
  assert.equal(client.requests.length, 2, 'second request served from cache');

  const sent = JSON.stringify(client.requests);
  assert.match(sent, /Negotiation/);
  assert.match(sent, /4 of 5/);
  assert.ok(!sent.includes('@'), 'no email addresses reach the model');
  assert.deepEqual(client.requests[0].tools.map((t) => t.function.name).sort(), ['get_listing', 'list_my_deals']);
});

test('portfolio insights drop priorities for unknown deals', async () => {
  const client = scriptedClient([
    answer({ overview: 'Two open deals.', priorities: [{ dealId: 'd1', note: 'Closing soon.' }, { dealId: 'd5', note: 'x' }] }),
  ]);
  const out = await new AiService({ client, crm: new MockCrm(config), config: aiConfig }).portfolioInsights('c1');
  assert.deepEqual(out.priorities, [{ dealId: 'd1', dealName: 'Rivera - Lakeview Townhouse purchase', note: 'Closing soon.' }]);
  assert.deepEqual(client.requests[0].output.schema.properties.priorities.items.properties.dealId.enum, ['d1', 'd2', 'd3', 'd4']);
});

test('AI usage is capped per client per hour', async () => {
  const done = answer({ interpretation: '', preferences: [], relaxed: false, overview: '', results: [] });
  const client = scriptedClient([done, done, done]);
  const ai = new AiService({ client, crm: new MockCrm(config), config: { ...aiConfig, ai: { ...aiConfig.ai, maxRequestsPerHour: 2 } } });
  await ai.propertySearch('c1', 'anything');
  await ai.propertySearch('c1', 'anything');
  await assert.rejects(ai.propertySearch('c1', 'anything'), AiLimitError);
  await ai.propertySearch('c2', 'anything'); // other clients are unaffected
});

// ---- HTTP endpoints -----------------------------------------------------------

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
  const client = scriptedClient([new AiError('upstream exploded with secret details')]);
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
