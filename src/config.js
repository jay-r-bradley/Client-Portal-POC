const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function list(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  port: Number(env.PORT || 3000),
  isProduction: env.NODE_ENV === 'production',

  // Shown in the portal header so each brokerage can white-label it.
  brandName: env.PORTAL_BRAND_NAME || 'Client Portal',
  currency: env.PORTAL_CURRENCY || 'USD',
  locale: env.PORTAL_LOCALE || 'en-US',

  // Signs the session cookie. Must be set to a long random value in production.
  sessionSecret: env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),

  // Where portal login accounts live (email -> password hash -> Zoho Contact id).
  userStorePath: env.USER_STORE_PATH || path.join(__dirname, '..', 'data', 'users.json'),

  // "mock" runs on built-in sample data; "live" talks to Zoho CRM.
  zohoMode: (env.ZOHO_MODE || 'mock').toLowerCase(),

  zoho: {
    // Data-centre specific hosts: .com, .eu, .in, .com.au, .jp, .ca, .sa
    accountsUrl: env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com',
    apiDomain: env.ZOHO_API_DOMAIN || 'https://www.zohoapis.com',
    apiVersion: env.ZOHO_API_VERSION || 'v8',
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    refreshToken: env.ZOHO_REFRESH_TOKEN,
  },

  // AI features (OpenAI). Disabled unless OPENAI_API_KEY is set.
  ai: {
    enabled: Boolean(env.OPENAI_API_KEY),
    apiKey: env.OPENAI_API_KEY,
    // Pick a current model from https://platform.openai.com/docs/models that
    // supports Structured Outputs (json_schema).
    model: env.OPENAI_MODEL || 'gpt-5-mini',
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    timeoutMs: Number(env.OPENAI_TIMEOUT_MS || 45000),
    maxRequestsPerHour: Number(env.AI_MAX_REQUESTS_PER_HOUR || 30),
    cacheMinutes: Number(env.AI_CACHE_MINUTES || 60),
  },

  // Zoho orgs customise module and field API names, so every name the portal
  // touches is configurable here instead of hard-coded in the client.
  crm: {
    contactsModule: env.CRM_CONTACTS_MODULE || 'Contacts',
    dealsModule: env.CRM_DEALS_MODULE || 'Deals',
    propertiesModule: env.CRM_PROPERTIES_MODULE || 'Properties',

    deal: {
      name: env.CRM_DEAL_NAME_FIELD || 'Deal_Name',
      stage: env.CRM_DEAL_STAGE_FIELD || 'Stage',
      amount: env.CRM_DEAL_AMOUNT_FIELD || 'Amount',
      closingDate: env.CRM_DEAL_CLOSING_DATE_FIELD || 'Closing_Date',
      contact: env.CRM_DEAL_CONTACT_FIELD || 'Contact_Name',
      property: env.CRM_DEAL_PROPERTY_FIELD || 'Property',
      type: env.CRM_DEAL_TYPE_FIELD || 'Type',
      description: env.CRM_DEAL_DESCRIPTION_FIELD || 'Description',
    },

    property: {
      name: env.CRM_PROPERTY_NAME_FIELD || 'Name',
      address: env.CRM_PROPERTY_ADDRESS_FIELD || 'Address',
      city: env.CRM_PROPERTY_CITY_FIELD || 'City',
      price: env.CRM_PROPERTY_PRICE_FIELD || 'Price',
      type: env.CRM_PROPERTY_TYPE_FIELD || 'Property_Type',
      listingType: env.CRM_PROPERTY_LISTING_TYPE_FIELD || 'Listing_Type',
      bedrooms: env.CRM_PROPERTY_BEDROOMS_FIELD || 'Bedrooms',
      bathrooms: env.CRM_PROPERTY_BATHROOMS_FIELD || 'Bathrooms',
      floorArea: env.CRM_PROPERTY_FLOOR_AREA_FIELD || 'Floor_Area',
      status: env.CRM_PROPERTY_STATUS_FIELD || 'Status',
      description: env.CRM_PROPERTY_DESCRIPTION_FIELD || 'Description',
      photoUrl: env.CRM_PROPERTY_PHOTO_FIELD || 'Photo_URL',
    },

    // Value of the property status field that means "can be offered to clients".
    availableStatus: env.CRM_PROPERTY_AVAILABLE_STATUS || 'Available',

    // Fallback pipeline order, used when the stage picklist cannot be read from Zoho.
    dealStages: list(env.CRM_DEAL_STAGES, [
      'Inquiry',
      'Viewing Scheduled',
      'Offer Made',
      'Negotiation',
      'Under Contract',
      'Closed Won',
      'Closed Lost',
    ]),
    wonStages: list(env.CRM_WON_STAGES, ['Closed Won']),
    lostStages: list(env.CRM_LOST_STAGES, ['Closed Lost']),

    // Notes created by the portal carry this prefix so the client only ever
    // sees their own messages, never the agent's internal notes. An agent
    // replies from inside Zoho by adding a note titled with the reply prefix.
    portalNotePrefix: env.CRM_PORTAL_NOTE_PREFIX || '[Client Portal]',
    portalReplyPrefix: env.CRM_PORTAL_REPLY_PREFIX || '[Portal Reply]',
  },
};

if (config.isProduction && config.sessionSecret.startsWith('dev-only')) {
  throw new Error('SESSION_SECRET must be set in production.');
}

module.exports = config;
