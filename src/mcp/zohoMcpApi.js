// Read-only Zoho CRM access through a Zoho MCP server.
//
// Implements the subset of the ZohoApi surface that LiveCrm needs for reading,
// so `new LiveCrm(config, { api: new ZohoMcpApi(...) })` gives the AI a CRM
// service whose every lookup goes over MCP. Record reads are expressed as COQL,
// so only one Zoho MCP tool (COQL) is strictly required; user and field-metadata
// tools are optional. Tool names and argument shapes come from a mapping file,
// because they depend on how the Zoho MCP server was configured.

const fs = require('node:fs');
const { quote } = require('../zoho/mappers');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const COQL_LIMIT = 200;

function loadToolMap(filePath) {
  const map = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete map._comment;
  return map;
}

// Fills a JSON argument template. A string that is exactly "{name}" becomes the
// raw value (any type); "{name}" inside a longer string is interpolated; a key
// whose value resolves to undefined is dropped.
function fillTemplate(template, values) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{(\w+)\}$/);
    if (whole) return values[whole[1]];
    return template.replace(/\{(\w+)\}/g, (_, key) => (values[key] === undefined ? '' : String(values[key])));
  }
  if (Array.isArray(template)) return template.map((t) => fillTemplate(t, values)).filter((v) => v !== undefined);
  if (template && typeof template === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(template)) {
      const filled = fillTemplate(value, values);
      if (filled !== undefined) out[key] = filled;
    }
    return out;
  }
  return template;
}

// Zoho MCP tools wrap REST endpoints, so results usually carry the REST
// envelope ({ data: [...] }, { users: [...] }, { fields: [...] }).
function unwrap(result, key) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result[key])) return result[key];
  if (result && result.data && Array.isArray(result.data[key])) return result.data[key];
  return [];
}

function assertId(id) {
  if (!ID_PATTERN.test(String(id))) throw new Error(`Invalid record id: ${id}`);
  return String(id);
}

class ZohoMcpApi {
  constructor({ connection, toolMap, crm }) {
    if (!toolMap.coql) throw new Error('The Zoho MCP tool map must define a "coql" tool.');
    this.connection = connection;
    this.toolMap = toolMap;
    this.crm = crm;
  }

  async call(operation, values) {
    const entry = this.toolMap[operation];
    if (!entry) throw new Error(`No Zoho MCP tool is mapped for "${operation}".`);
    return this.connection.callTool(entry.tool, fillTemplate(entry.args || {}, values));
  }

  async coql(selectQuery) {
    return unwrap(await this.call('coql', { query: selectQuery }), 'data');
  }

  defaultFields(module) {
    if (module === this.crm.propertiesModule) return Object.values(this.crm.property);
    if (module === this.crm.dealsModule) return [...Object.values(this.crm.deal), 'Owner', 'Modified_Time'];
    return ['Owner', 'Modified_Time'];
  }

  async getRecord(module, id, fields) {
    const columns = [...new Set(fields || this.defaultFields(module))].join(', ');
    const [record] = await this.coql(`select ${columns} from ${module} where id = ${quote(assertId(id))} limit 1`);
    return record || null;
  }

  // Only the Contact -> Deals relation is needed; it is the deal's contact lookup.
  async getRelatedRecords(module, id, relatedList, fields) {
    if (module !== this.crm.contactsModule || relatedList !== this.crm.dealsModule) {
      throw new Error(`Related list ${module}/${relatedList} is not available over MCP.`);
    }
    const columns = [...new Set(fields)].join(', ');
    return this.coql(`select ${columns} from ${relatedList} where ${this.crm.deal.contact} = ${quote(assertId(id))} limit ${COQL_LIMIT}`);
  }

  async getUser(id) {
    if (!this.toolMap.getUser) return null;
    const [user] = unwrap(await this.call('getUser', { id: assertId(id) }), 'users');
    return user || null;
  }

  async getFields(module) {
    if (!this.toolMap.getFields) return [];
    return unwrap(await this.call('getFields', { module }), 'fields');
  }

  // The AI path is read-only by design: portal messages are written over REST.
  async createRecord() {
    throw new Error('The Zoho MCP connection is read-only.');
  }

  async searchByEmail() {
    throw new Error('Contact lookup by email is not available over MCP.');
  }
}

module.exports = { ZohoMcpApi, loadToolMap, fillTemplate, unwrap };
