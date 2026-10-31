// CRM service backed by a real Zoho CRM org.

const { mapContact, mapDeal, mapProperty, mapUser, buildPropertyQuery, buildFeaturedQuery, quote } = require('./mappers');
const { matchesKeywords } = require('../propertyCriteria');
const { ZohoApi } = require('./zohoApi');

const STAGE_CACHE_MS = 10 * 60 * 1000;
const USER_CACHE_MS = 10 * 60 * 1000;

class LiveCrm {
  constructor(config, { api } = {}) {
    this.crm = config.crm;
    this.api = api || new ZohoApi(config.zoho);
    this.stageCache = null;
    this.userCache = new Map();
  }

  get dealFields() {
    return [...new Set([...Object.values(this.crm.deal), 'Owner', 'Modified_Time'])];
  }

  async getContact(contactId) {
    const record = await this.api.getRecord(this.crm.contactsModule, contactId, [
      'First_Name', 'Last_Name', 'Full_Name', 'Email', 'Phone', 'Mobile', 'Owner',
    ]);
    return record ? mapContact(record) : null;
  }

  async findContactByEmail(email) {
    const [record] = await this.api.searchByEmail(this.crm.contactsModule, email);
    return record ? mapContact(record) : null;
  }

  async getUser(userId) {
    if (!userId) return null;
    const cached = this.userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.user;
    const user = mapUser(await this.api.getUser(userId));
    this.userCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_MS });
    return user;
  }

  // The client's primary agent is the Zoho owner of their Contact record.
  async getAgent(contactId) {
    const contact = await this.getContact(contactId);
    return contact ? this.getUser(contact.ownerId) : null;
  }

  async listDeals(contactId) {
    // The Contact -> Deals related list only ever returns this client's deals,
    // so ownership is enforced by the query itself.
    const records = await this.api.getRelatedRecords(this.crm.contactsModule, contactId, this.crm.dealsModule, this.dealFields);
    const deals = records.map((r) => mapDeal(r, this.crm.deal));
    return Promise.all(deals.map((deal) => this.withAgentDetails(deal)));
  }

  async getDeal(contactId, dealId) {
    const record = await this.api.getRecord(this.crm.dealsModule, dealId, this.dealFields);
    if (!record) return null;
    const deal = mapDeal(record, this.crm.deal);
    // Never reveal another client's deal, even if its id is guessed.
    if (deal.contactId !== String(contactId)) return null;
    return this.withAgentDetails(deal);
  }

  async withAgentDetails(deal) {
    if (!deal.agent?.id) return deal;
    const agent = await this.getUser(deal.agent.id).catch(() => null);
    return { ...deal, agent: agent || deal.agent };
  }

  // Pipeline order comes from the Stage picklist in Zoho so the portal follows
  // whatever stages the brokerage has configured.
  async getStages() {
    if (this.stageCache && this.stageCache.expiresAt > Date.now()) return this.stageCache.stages;
    let stages = this.crm.dealStages;
    try {
      const fields = await this.api.getFields(this.crm.dealsModule);
      const stageField = fields.find((field) => field.api_name === this.crm.deal.stage);
      const values = (stageField?.pick_list_values || [])
        .filter((v) => v.display_value && v.display_value !== '-None-')
        .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0))
        .map((v) => v.display_value);
      if (values.length) stages = values;
    } catch (err) {
      console.warn('Could not read Deal stages from Zoho, using configured defaults:', err.message);
    }
    this.stageCache = { stages, expiresAt: Date.now() + STAGE_CACHE_MS };
    return stages;
  }

  async searchProperties(criteria) {
    const query = buildPropertyQuery(criteria, {
      module: this.crm.propertiesModule,
      fields: this.crm.property,
      availableStatus: this.crm.availableStatus,
    });
    const records = await this.api.coql(query);
    return records.map((r) => mapProperty(r, this.crm.property)).filter((p) => matchesKeywords(p, criteria.keywords));
  }

  async getPropertyFilterOptions() {
    const fields = await this.api.getFields(this.crm.propertiesModule).catch(() => []);
    const picklist = (apiName) =>
      (fields.find((field) => field.api_name === apiName)?.pick_list_values || [])
        .map((v) => v.display_value)
        .filter((v) => v && v !== '-None-');
    return {
      propertyTypes: picklist(this.crm.property.type),
      listingTypes: picklist(this.crm.property.listingType),
    };
  }

  async listFeaturedProperties(limit = 6) {
    const query = (featuredOnly) => buildFeaturedQuery({
      module: this.crm.propertiesModule, fields: this.crm.property, availableStatus: this.crm.availableStatus, featuredOnly, limit,
    });
    let records = await this.api.coql(query(true));
    if (!records.length) records = await this.api.coql(query(false));
    return records.map((r) => mapProperty(r, this.crm.property));
  }

  // Connection check for the admin console: reads Deals field metadata.
  async testConnection() {
    try {
      await this.api.getFields(this.crm.dealsModule);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Looks up which of the catalogue's fields exist in this org.
  async checkFields(catalog) {
    return Promise.all(catalog.map(async (module) => {
      if (!module.fields.length) return { module: module.module, fields: [] };
      try {
        const existing = new Set((await this.api.getFields(module.module)).map((f) => f.api_name));
        return { module: module.module, fields: module.fields.map((f) => ({ apiName: f.apiName, status: existing.has(f.apiName) ? 'found' : 'missing' })) };
      } catch (err) {
        return { module: module.module, error: err.message, fields: module.fields.map((f) => ({ apiName: f.apiName, status: 'unknown' })) };
      }
    }));
  }

  async getProperty(propertyId) {
    const record = await this.api.getRecord(this.crm.propertiesModule, propertyId);
    return record ? mapProperty(record, this.crm.property) : null;
  }

  async listMessages(contactId) {
    const { portalNotePrefix, portalReplyPrefix } = this.crm;
    const notes = await this.api.getRelatedRecords(this.crm.contactsModule, contactId, 'Notes', [
      'Note_Title', 'Note_Content', 'Created_Time', 'Owner',
    ]);
    return notes
      .map((note) => {
        const title = note.Note_Title || '';
        let from;
        if (title.startsWith(portalNotePrefix)) from = 'client';
        else if (title.startsWith(portalReplyPrefix)) from = 'agent';
        else return null; // internal agent note: never shown to the client
        const prefix = from === 'client' ? portalNotePrefix : portalReplyPrefix;
        return {
          id: String(note.id),
          from,
          subject: title.slice(prefix.length).trim(),
          body: note.Note_Content || '',
          author: from === 'agent' ? note.Owner?.name || null : null,
          createdAt: note.Created_Time,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  // A client message becomes (1) a Note on their Contact, visible on the CRM
  // timeline, and (2) a Task assigned to the agent so it lands in their queue.
  // ---- Guest sign-ups (Zoho Leads) ------------------------------------------

  async createSignupLead(g) {
    const { leadSource, leadOwnerId, criteriaField } = this.crm.signup;
    const details = await this.api.createRecord(this.crm.leadsModule, {
      First_Name: g.firstName || undefined,
      Last_Name: g.lastName,
      Email: g.email,
      Phone: g.phone || undefined,
      Lead_Source: leadSource,
      Lead_Status: this.crm.referral.newStatus,
      Description: g.description,
      [criteriaField]: g.criteria || undefined,
      ...(leadOwnerId ? { Owner: { id: leadOwnerId } } : {}),
    });
    return { id: String(details.id) };
  }

  async updateLeadCriteria(leadId, criteria) {
    await this.api.updateRecord(this.crm.leadsModule, leadId, { [this.crm.signup.criteriaField]: criteria });
  }

  // ---- Referral program (Zoho Leads) ----------------------------------------

  get referralColumns() {
    const { referredByField, interestField } = this.crm.referral;
    return ['First_Name', 'Last_Name', 'Email', 'Phone', 'Lead_Status', 'Description', 'Created_Time', 'Owner', referredByField, interestField];
  }

  mapReferral(lead) {
    const { referredByField, interestField } = this.crm.referral;
    const referrer = lead[referredByField];
    return {
      id: String(lead.id),
      name: [lead.First_Name, lead.Last_Name].filter(Boolean).join(' '),
      email: lead.Email || null,
      phone: lead.Phone || null,
      interest: lead[interestField] || null,
      notes: lead.Description || null,
      leadStatus: lead.Lead_Status || null,
      createdAt: lead.Created_Time || null,
      referrer: referrer?.id ? { contactId: String(referrer.id), name: referrer.name || null } : null,
      agent: lead.Owner?.id ? { id: String(lead.Owner.id), name: lead.Owner.name || null } : null,
    };
  }

  // The referral becomes a Lead owned by the referring client's agent, so it
  // lands in their CRM queue with the source and referrer attached.
  async createReferral(contactId, r) {
    const { leadSource, referredByField, interestField, newStatus } = this.crm.referral;
    const contact = await this.getContact(contactId);
    const details = await this.api.createRecord(this.crm.leadsModule, {
      First_Name: r.firstName || undefined,
      Last_Name: r.lastName,
      Email: r.email || undefined,
      Phone: r.phone || undefined,
      Lead_Source: leadSource,
      Lead_Status: newStatus,
      [interestField]: r.interest,
      [referredByField]: { id: contactId },
      Description: [`Referred through the client portal by ${contact?.name || 'a client'}.`, `Interested in: ${r.interest}.`, r.notes].filter(Boolean).join('\n'),
      ...(contact?.ownerId ? { Owner: { id: contact.ownerId } } : {}),
    });
    return {
      id: String(details.id), name: r.name, email: r.email, phone: r.phone, interest: r.interest, notes: r.notes,
      leadStatus: newStatus, createdAt: details.Created_Time || new Date().toISOString(),
      referrer: { contactId: String(contactId), name: contact?.name || null }, agent: null,
    };
  }

  // Note: Zoho moves converted Leads out of the Leads module, so a referral
  // that became a client no longer appears here.
  async listReferrals(contactId) {
    const { referredByField } = this.crm.referral;
    const rows = await this.api.coql(`select ${this.referralColumns.join(', ')} from ${this.crm.leadsModule} where ${referredByField} = ${quote(String(contactId))} order by Created_Time desc limit 200`);
    return rows.map((lead) => this.mapReferral(lead));
  }

  async listAllReferrals() {
    const { leadSource } = this.crm.referral;
    const rows = await this.api.coql(`select ${this.referralColumns.join(', ')} from ${this.crm.leadsModule} where Lead_Source = ${quote(leadSource)} order by Created_Time desc limit 200`);
    return rows.map((lead) => this.mapReferral(lead));
  }

  async sendMessage(contactId, { subject, body, deal, property }) {
    const context = [
      deal ? `Deal: ${deal.name} (${deal.stage || 'no stage'})` : null,
      property ? `Property: ${property.name}${property.address ? `, ${property.address}` : ''}` : null,
    ].filter(Boolean);
    const content = [body, context.length ? `\n— Sent from Client Portal\n${context.join('\n')}` : '\n— Sent from Client Portal']
      .join('\n');

    const note = await this.api.createRecord('Notes', {
      Note_Title: `${this.crm.portalNotePrefix} ${subject}`,
      Note_Content: content,
      Parent_Id: { module: { api_name: this.crm.contactsModule }, id: contactId },
    });

    const contact = await this.getContact(contactId);
    const agentId = deal?.agent?.id || contact?.ownerId;
    try {
      await this.api.createRecord('Tasks', {
        Subject: `Client Portal message from ${contact?.name || 'client'}: ${subject}`.slice(0, 255),
        Description: content,
        Due_Date: new Date().toISOString().slice(0, 10),
        Priority: 'High',
        Status: 'Not Started',
        Who_Id: { id: contactId },
        ...(deal ? { What_Id: { id: deal.id }, $se_module: this.crm.dealsModule } : {}),
        ...(agentId ? { Owner: { id: agentId } } : {}),
      });
    } catch (err) {
      // The note is the record of truth; a missing task should not lose the message.
      console.warn('Message saved as a note, but creating the follow-up task failed:', err.message);
    }

    return {
      id: String(note.id),
      from: 'client',
      subject,
      body: content,
      author: null,
      createdAt: note.Created_Time || new Date().toISOString(),
    };
  }
}

module.exports = { LiveCrm };
