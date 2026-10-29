// In-memory CRM service with the same interface as LiveCrm, for demos and tests.

const { matchesCriteria, sortProperties } = require('../propertyCriteria');
const seed = require('./mockData');

class MockCrm {
  constructor(config) {
    this.crm = config.crm;
    // Copy the seed so tests and demo sessions never mutate the module data.
    this.data = structuredClone(seed);
    this.nextId = 1;
  }

  async getContact(contactId) {
    return this.data.contacts[contactId] || null;
  }

  async findContactByEmail(email) {
    return Object.values(this.data.contacts).find((c) => c.email.toLowerCase() === email.toLowerCase()) || null;
  }

  async getAgent(contactId) {
    const contact = this.data.contacts[contactId];
    return contact ? this.data.agents[contact.ownerId] || null : null;
  }

  toDeal(raw) {
    const property = this.data.properties.find((p) => p.id === raw.propertyId);
    return {
      id: raw.id,
      name: raw.name,
      stage: raw.stage,
      amount: raw.amount,
      closingDate: raw.closingDate,
      type: raw.type,
      description: raw.description,
      contactId: raw.contactId,
      property: property ? { id: property.id, name: property.name } : null,
      agent: this.data.agents[raw.agentId] || null,
      modifiedAt: raw.modifiedAt,
    };
  }

  async listDeals(contactId) {
    return this.data.deals.filter((d) => d.contactId === contactId).map((d) => this.toDeal(d));
  }

  async getDeal(contactId, dealId) {
    const raw = this.data.deals.find((d) => d.id === dealId && d.contactId === contactId);
    return raw ? this.toDeal(raw) : null;
  }

  async getStages() {
    return this.crm.dealStages;
  }

  async searchProperties(criteria) {
    const matches = this.data.properties.filter((p) => p.status === this.crm.availableStatus && matchesCriteria(p, criteria));
    return sortProperties(matches, criteria.sort);
  }

  async getPropertyFilterOptions() {
    const unique = (key) => [...new Set(this.data.properties.map((p) => p[key]).filter(Boolean))].sort();
    return { propertyTypes: unique('propertyType'), listingTypes: unique('listingType') };
  }

  async getProperty(propertyId) {
    return this.data.properties.find((p) => p.id === propertyId) || null;
  }

  async listMessages(contactId) {
    return this.data.messages
      .filter((m) => m.contactId === contactId)
      .map(({ contactId: _omit, ...m }) => m)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  async sendMessage(contactId, { subject, body, deal, property }) {
    const context = [deal && `Deal: ${deal.name}`, property && `Property: ${property.name}`].filter(Boolean);
    const message = {
      id: `mock-msg-${this.nextId++}`,
      contactId,
      from: 'client',
      author: null,
      subject,
      body: context.length ? `${body}\n\n— ${context.join(' · ')}` : body,
      createdAt: new Date().toISOString(),
    };
    this.data.messages.push(message);
    const { contactId: _omit, ...publicMessage } = message;
    return publicMessage;
  }
}

module.exports = { MockCrm };
