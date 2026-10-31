#!/usr/bin/env node
// Connects to the Zoho MCP server in ZOHO_MCP_URL, lists its tools and checks
// them against config/zoho-mcp-tools.json, then runs one read-only COQL query.
//
//   npm run mcp:check            # summary
//   npm run mcp:check -- --schemas   # also print each tool's input schema

const config = require('../src/config');
const { McpConnection } = require('../src/mcp/mcpConnection');
const { ZohoMcpApi, loadToolMap } = require('../src/mcp/zohoMcpApi');

async function main() {
  if (!config.zohoMcp.url) throw new Error('Set ZOHO_MCP_URL in .env first (Zoho CRM > Setup > Developer Hub > MCP for AI Agents).');
  const showSchemas = process.argv.includes('--schemas');
  const connection = new McpConnection({
    url: config.zohoMcp.url,
    headers: config.zohoMcp.authorization ? { Authorization: config.zohoMcp.authorization } : {},
  });

  const tools = await connection.listTools();
  console.log(`Connected. The server offers ${tools.length} tools:\n`);
  for (const tool of tools) {
    console.log(`- ${tool.name}${tool.description ? `: ${tool.description.split('\n')[0].slice(0, 100)}` : ''}`);
    if (showSchemas) console.log(JSON.stringify(tool.inputSchema, null, 2).replace(/^/gm, '    '));
  }

  const toolMap = loadToolMap(config.zohoMcp.toolMapPath);
  const names = new Set(tools.map((t) => t.name));
  console.log(`\nMapping in ${config.zohoMcp.toolMapPath}:`);
  let ok = true;
  for (const [operation, entry] of Object.entries(toolMap)) {
    const found = names.has(entry.tool);
    if (!found && operation === 'coql') ok = false;
    console.log(`  ${found ? 'OK     ' : 'MISSING'} ${operation} -> ${entry.tool}${found || operation === 'coql' ? '' : ' (optional; remove it or fix the name)'}`);
  }
  if (!ok) throw new Error('The required "coql" tool was not found. Edit the mapping file with the right tool name and argument shape.');

  const api = new ZohoMcpApi({ connection, toolMap, crm: config.crm });
  const rows = await api.coql(`select ${config.crm.deal.name}, ${config.crm.deal.stage} from ${config.crm.dealsModule} where ${config.crm.deal.stage} is not null limit 1`);
  console.log(`\nTest COQL query returned ${rows.length} deal row(s). The AI can read Zoho CRM over MCP.`);
  await connection.close();
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
