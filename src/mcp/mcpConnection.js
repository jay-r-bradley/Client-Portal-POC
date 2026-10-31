// A lazily-connected MCP client (Streamable HTTP) with JSON result parsing.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

class McpToolError extends Error {
  constructor(message, { tool } = {}) {
    super(message);
    this.name = 'McpToolError';
    this.tool = tool;
  }
}

// MCP tools return content blocks. Prefer structured content; otherwise parse
// the text blocks as JSON (Zoho returns its REST payloads as JSON text).
function parseToolResult(result, tool) {
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (result.isError) throw new McpToolError(text || `MCP tool ${tool} failed`, { tool });
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class McpConnection {
  // `transportFactory` lets tests connect to an in-memory server instead of a URL.
  constructor({ url, headers = {}, name = 'client-portal', transportFactory } = {}) {
    if (!url && !transportFactory) throw new Error('An MCP server URL is required.');
    this.url = url;
    this.headers = headers;
    this.name = name;
    this.transportFactory = transportFactory || (() => new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    this.client = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.connecting) {
      const client = new Client({ name: this.name, version: '0.1.0' });
      this.connecting = client.connect(this.transportFactory())
        .then(() => {
          this.client = client;
          return client;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  async listTools() {
    const client = await this.connect();
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name, args, retried = false) {
    let result;
    try {
      const client = await this.connect();
      result = await client.callTool({ name, arguments: args });
    } catch (err) {
      // Remote sessions expire; reconnect once before giving up.
      if (retried) throw new McpToolError(`MCP call ${name} failed: ${err.message}`, { tool: name });
      await this.close();
      return this.callTool(name, args, true);
    }
    return parseToolResult(result, name);
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client) await client.close().catch(() => {});
  }
}

module.exports = { McpConnection, McpToolError, parseToolResult };
