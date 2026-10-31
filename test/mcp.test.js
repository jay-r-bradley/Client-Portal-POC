// Zoho-over-MCP tests against an in-memory MCP server built with the official SDK.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const config = require('../src/config');
const { McpConnection, McpToolError } = require('../src/mcp/mcpConnection');
const { ZohoMcpApi, fillTemplate } = require('../src/mcp/zohoMcpApi');
const { LiveCrm } = require('../src/zoho/liveCrm');

const toolMap = {
  coql: { tool: 'ExecuteCOQLQuery', args: { body: { select_query: '{query}' } } },
  getUser: { tool: 'GetUser', args: { path_variables: { user: '{id}' } } },
};

// Fake Zoho MCP server: answers COQL by module, records every query it receives.
function fakeZohoMcp() {
  const queries = [];
  const server = new Server({ name: 'fake-zoho-crm', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ['ExecuteCOQLQuery', 'GetUser'].map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const reply = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
    if (params.name === 'GetUser') {
      return reply({ users: [{ id: params.arguments.path_variables.user, full_name: 'Maria Santos', email: 'maria@x' }] });
    }
    const query = params.arguments.body.select_query;
    queries.push(query);
    if (query.includes('BROKEN')) return { isError: true, content: [{ type: 'text', text: 'INVALID_QUERY' }] };
    if (query.includes('from Deals where Contact_Name')) {
      return reply({ data: [{ id: '501', Deal_Name: 'Rivera - Lakeview', Stage: 'Negotiation', Amount: 478000, Contact_Name: { id: '101' }, Owner: { id: '9' } }] });
    }
    if (query.includes("from Deals where id = '502'")) {
      return reply({ data: [{ id: '502', Deal_Name: 'Someone else', Contact_Name: { id: '999' } }] });
    }
    if (query.includes('from Properties')) {
      return reply({ data: [{ id: '701', Name: 'Lakeview Townhouse', City: 'Austin', Price: 485000, Status: 'Available' }] });
    }
    return { content: [] }; // 204-style empty result
  });
  return { server, queries };
}

async function connect() {
  const fake = fakeZohoMcp();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await fake.server.connect(serverTransport);
  const connection = new McpConnection({ transportFactory: () => clientTransport });
  const api = new ZohoMcpApi({ connection, toolMap, crm: config.crm });
  return { ...fake, connection, api, crm: new LiveCrm(config, { api }) };
}

test('fillTemplate substitutes whole values and interpolates strings', () => {
  assert.deepEqual(
    fillTemplate({ body: { q: '{query}', list: '{ids}' }, path: 'x/{id}', gone: '{missing}' }, { query: 'select 1', ids: [1, 2], id: 7 }),
    { body: { q: 'select 1', list: [1, 2] }, path: 'x/7' },
  );
});

test('LiveCrm reads a client\'s deals over Zoho MCP using the client-scoped COQL', async () => {
  const { crm, queries, connection } = await connect();
  const deals = await crm.listDeals('101');
  assert.equal(deals.length, 1);
  assert.equal(deals[0].stage, 'Negotiation');
  assert.equal(deals[0].agent.name, 'Maria Santos', 'agent details via the mapped GetUser tool');
  assert.match(queries[0], /^select .* from Deals where Contact_Name = '101' limit 200$/);
  await connection.close();
});

test('a deal belonging to another contact is not returned over MCP either', async () => {
  const { crm, connection } = await connect();
  assert.equal(await crm.getDeal('101', '502'), null);
  await connection.close();
});

test('property search runs as COQL through the MCP tool', async () => {
  const { crm, queries, connection } = await connect();
  const results = await crm.searchProperties({ budgetMin: null, budgetMax: 500000, locations: ['Austin'], propertyType: null, listingType: null, minBedrooms: null, minBathrooms: null, minFloorArea: null, keywords: null, sort: 'price_asc' });
  assert.deepEqual(results.map((p) => p.name), ['Lakeview Townhouse']);
  assert.match(queries[0], /from Properties where .*Price <= 500000/);
  await connection.close();
});

test('record ids are validated before they reach a COQL query', async () => {
  const { api, queries, connection } = await connect();
  await assert.rejects(api.getRecord('Deals', "1' or id != '0"), /Invalid record id/);
  assert.equal(queries.length, 0);
  await connection.close();
});

test('MCP tool errors surface as McpToolError, and the connection is read-only', async () => {
  const { api, connection } = await connect();
  await assert.rejects(api.coql('select BROKEN'), McpToolError);
  await assert.rejects(api.createRecord('Notes', {}), /read-only/);
  await connection.close();
});

test('stage lookups fall back to configured stages when no fields tool is mapped', async () => {
  const { crm, connection } = await connect();
  assert.deepEqual(await crm.getStages(), config.crm.dealStages);
  await connection.close();
});
