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

  async listFeaturedProperties(limit = 6) {
    const available = this.data.properties.filter((p) => p.status === this.crm.availableStatus);
    const featured = available.filter((p) => p.featured);
    const newestFirst = (a, b) => String(b.listedDate || '').localeCompare(String(a.listedDate || ''));
    return [...(featured.length ? featured : available)].sort(newestFirst).slice(0, limit);
  }

  async testConnection() {
    return { ok: true, note: 'Demo mode: sample data, no Zoho connection.' };
  }

  // Sample data has every field, but there is no real org to check.
  async checkFields(catalog) {
    return catalog.map((module) => ({ module: module.module, fields: module.fields.map((f) => ({ apiName: f.apiName, status: 'sample' })) }));
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

  toReferral(r) {
    const referrer = this.data.contacts[r.referrerId];
    return {
      id: r.id, name: r.name, email: r.email, phone: r.phone, interest: r.interest, notes: r.notes,
      leadStatus: r.leadStatus, createdAt: r.createdAt,
      referrer: referrer ? { contactId: referrer.id, name: referrer.name } : { contactId: r.referrerId, name: null },
      agent: this.data.agents[referrer?.ownerId] || null,
    };
  }

  async createReferral(contactId, referral) {
    const record = { id: `mock-ref-${this.nextId++}`, referrerId: contactId, ...referral, leadStatus: this.crm.referral.newStatus, createdAt: new Date().toISOString() };
    this.data.referrals.push(record);
    return this.toReferral(record);
  }

  async listReferrals(contactId) {
    return this.data.referrals.filter((r) => r.referrerId === contactId).map((r) => this.toReferral(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listAllReferrals() {
    return this.data.referrals.map((r) => this.toReferral(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
