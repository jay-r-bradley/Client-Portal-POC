// Every Zoho CRM module and field the portal uses, with a label, type and
// purpose. This is the single source for docs/ZOHO_FIELDS.md and for the admin
// console's field check. API names come from config, so an org that names a
// field differently only changes .env.

function fieldCatalog({ crm }) {
  const { deal: d, property: p } = crm;
  return [
    {
      module: crm.contactsModule,
      label: 'Contacts',
      kind: 'Standard module',
      purpose: 'The client. One portal login is linked to one Contact.',
      fields: [
        { apiName: 'First_Name', label: 'First Name', type: 'Single line', standard: true, purpose: 'Greeting on the dashboard' },
        { apiName: 'Last_Name', label: 'Last Name', type: 'Single line', standard: true, required: true, purpose: 'Client name' },
        { apiName: 'Email', label: 'Email', type: 'Email', standard: true, required: true, purpose: 'Matches the portal login to this Contact' },
        { apiName: 'Phone', label: 'Phone', type: 'Phone', standard: true, purpose: 'Shown on the client profile' },
        { apiName: 'Mobile', label: 'Mobile', type: 'Phone', standard: true, purpose: 'Used when Phone is empty' },
        { apiName: 'Owner', label: 'Contact Owner', type: 'User lookup', standard: true, required: true, purpose: 'The client\'s agent (name, email, phone in the portal)' },
      ],
    },
    {
      module: crm.dealsModule,
      label: 'Deals',
      kind: 'Standard module',
      purpose: 'The client\'s purchases, leases and offers.',
      fields: [
        { apiName: d.name, label: 'Deal Name', type: 'Single line', standard: true, required: true, purpose: 'Deal title' },
        { apiName: d.stage, label: 'Stage', type: 'Picklist', standard: true, required: true, purpose: 'Pipeline status and progress tracker. Stage order comes from the picklist.' },
        { apiName: d.amount, label: 'Amount', type: 'Currency', standard: true, purpose: 'Deal amount' },
        { apiName: d.closingDate, label: 'Closing Date', type: 'Date', standard: true, purpose: 'Target closing date and AI timing insights' },
        { apiName: d.contact, label: 'Contact Name', type: 'Lookup (Contacts)', standard: true, required: true, purpose: 'Links the deal to the client. Clients only ever see deals linked to them.' },
        { apiName: d.type, label: 'Type', type: 'Picklist', standard: true, purpose: 'e.g. Purchase, Lease' },
        { apiName: d.description, label: 'Description', type: 'Multi-line', standard: true, purpose: 'Shown to the client as the agent\'s "Latest update". Keep it client-friendly.' },
        { apiName: d.property, label: 'Property', type: 'Lookup (Properties)', standard: false, purpose: 'The listing the deal is about' },
        { apiName: 'Owner', label: 'Deal Owner', type: 'User lookup', standard: true, purpose: 'Agent for messages about this deal' },
      ],
    },
    {
      module: crm.propertiesModule,
      label: 'Properties',
      kind: 'Custom module (create it)',
      purpose: 'The brokerage\'s listings, used for search and the featured showcase.',
      fields: [
        { apiName: p.name, label: 'Property Name', type: 'Single line (module name field)', standard: true, required: true, purpose: 'Listing title' },
        { apiName: p.address, label: 'Address', type: 'Single line', standard: false, purpose: 'Street address' },
        { apiName: p.city, label: 'City', type: 'Single line', standard: false, required: true, purpose: 'Location filter in search' },
        { apiName: p.price, label: 'Price', type: 'Currency', standard: false, required: true, purpose: 'Budget filter. Rentals: monthly rent.' },
        { apiName: p.type, label: 'Property Type', type: 'Picklist', standard: false, purpose: 'e.g. Single Family, Condo, Townhouse. Values become the "Home type" filter.' },
        { apiName: p.listingType, label: 'Listing Type', type: 'Picklist (Sale, Rent)', standard: false, required: true, purpose: 'Buy / Rent filter' },
        { apiName: p.bedrooms, label: 'Bedrooms', type: 'Number', standard: false, purpose: 'Beds filter' },
        { apiName: p.bathrooms, label: 'Bathrooms', type: 'Decimal', standard: false, purpose: 'Bathrooms filter' },
        { apiName: p.floorArea, label: 'Floor Area', type: 'Number (sq ft)', standard: false, purpose: 'Floor area filter' },
        { apiName: p.status, label: 'Status', type: `Picklist (must include "${crm.availableStatus}")`, standard: false, required: true, purpose: 'Only listings with this status are shown to clients' },
        { apiName: p.description, label: 'Description', type: 'Multi-line', standard: false, purpose: 'Listing details; also read by AI search' },
        { apiName: p.photoUrl, label: 'Photo URL', type: 'URL (https)', standard: false, purpose: 'Main photo on cards and the property page' },
        { apiName: p.featured, label: 'Featured', type: 'Checkbox', standard: false, purpose: 'Shows the listing in the "Featured & newly acquired" showcase' },
        { apiName: p.listedDate, label: 'Listed Date', type: 'Date', standard: false, purpose: 'Acquisition / listing date: showcase order and "New" badge (30 days)' },
      ],
    },
    {
      module: crm.leadsModule,
      label: 'Leads',
      kind: 'Standard module',
      purpose: 'Client referrals. Each referral becomes a Lead owned by the referring client\'s agent.',
      fields: [
        { apiName: 'First_Name', label: 'First Name', type: 'Single line', standard: true, purpose: 'Referred person\'s first name' },
        { apiName: 'Last_Name', label: 'Last Name', type: 'Single line', standard: true, required: true, purpose: 'Referred person\'s last name' },
        { apiName: 'Email', label: 'Email', type: 'Email', standard: true, purpose: 'Contact details the client provided' },
        { apiName: 'Phone', label: 'Phone', type: 'Phone', standard: true, purpose: 'Contact details the client provided' },
        { apiName: 'Lead_Source', label: 'Lead Source', type: `Picklist (add value "${crm.referral.leadSource}")`, standard: true, required: true, purpose: 'Marks the Lead as a client referral' },
        { apiName: 'Lead_Status', label: 'Lead Status', type: 'Picklist', standard: true, required: true, purpose: 'Shown to the referring client as Received / Agent in touch / Qualified / Closed' },
        { apiName: crm.referral.referredByField, label: 'Referred By', type: 'Lookup (Contacts)', standard: false, required: true, purpose: 'Links the Lead to the client who referred them' },
        { apiName: crm.referral.interestField, label: 'Inquiry Type', type: 'Picklist (Buying a home, Land or a lot, Selling a property, Renting, Investment property)', standard: false, purpose: 'What the referred person is looking for' },
        { apiName: 'Description', label: 'Description', type: 'Multi-line', standard: true, purpose: 'Notes from the client about the referral' },
        { apiName: 'Owner', label: 'Lead Owner', type: 'User lookup', standard: true, purpose: 'Set to the referring client\'s agent' },
      ],
    },
    {
      module: 'Notes',
      label: 'Notes',
      kind: 'Standard module',
      purpose: `Client messages are saved as Notes titled "${crm.portalNotePrefix} …". Agents reply with a Note titled "${crm.portalReplyPrefix} …". No new fields needed.`,
      fields: [],
    },
    {
      module: 'Tasks',
      label: 'Tasks',
      kind: 'Standard module',
      purpose: 'Each client message creates a high-priority Task for the agent. No new fields needed.',
      fields: [],
    },
  ];
}

module.exports = { fieldCatalog };
