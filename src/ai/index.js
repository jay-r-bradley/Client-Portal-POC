const { OpenAiClient } = require('./openaiClient');
const { AiService } = require('./aiService');
const { LiveCrm } = require('../zoho/liveCrm');
const { McpConnection } = require('../mcp/mcpConnection');
const { ZohoMcpApi, loadToolMap } = require('../mcp/zohoMcpApi');

// The CRM service the AI reads through. With ZOHO_MCP_URL set (live mode), every
// AI lookup goes over Zoho MCP; otherwise it shares the pages' CRM service.
function createAiCrm(config, crm) {
  if (!config.zohoMcp.url) return { aiCrm: crm, source: config.zohoMode === 'mock' ? 'mock data' : 'Zoho REST API' };
  if (config.zohoMode !== 'live') {
    console.warn('ZOHO_MCP_URL is ignored while ZOHO_MODE=mock, so the AI sees the same sample data as the pages.');
    return { aiCrm: crm, source: 'mock data' };
  }
  const connection = new McpConnection({
    url: config.zohoMcp.url,
    headers: config.zohoMcp.authorization ? { Authorization: config.zohoMcp.authorization } : {},
  });
  const api = new ZohoMcpApi({ connection, toolMap: loadToolMap(config.zohoMcp.toolMapPath), crm: config.crm });
  return { aiCrm: new LiveCrm(config, { api }), source: 'Zoho MCP' };
}

function createAi(config, crm) {
  if (!config.ai.enabled) return null;
  const { aiCrm, source } = createAiCrm(config, crm);
  const ai = new AiService({ client: new OpenAiClient(config.ai), crm: aiCrm, config });
  ai.source = source;
  return ai;
}

module.exports = { createAi, createAiCrm };
