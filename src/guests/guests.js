// Guest sign-up: validation, the Lead written to Zoho, and keeping the Lead's
// "what they're looking for" field current as the guest searches.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LISTING_TYPES = ['Sale', 'Rent'];
const CRITERIA_SYNC_INTERVAL_MS = 10 * 60 * 1000;

class SignupError extends Error {}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeSignup(input = {}) {
  const name = text(input.name, 120);
  const email = text(input.email, 200).toLowerCase();
  const phone = text(input.phone, 40) || null;
  const location = text(input.location, 80) || null;
  const listingType = LISTING_TYPES.includes(input.listingType) ? input.listingType : null;
  const budgetMax = input.budgetMax === '' || input.budgetMax === null || input.budgetMax === undefined ? null : Number(input.budgetMax);
  if (!name) throw new SignupError('Enter your name.');
  if (!EMAIL_PATTERN.test(email)) throw new SignupError('Enter a valid email address.');
  if (budgetMax !== null && !(Number.isFinite(budgetMax) && budgetMax > 0)) throw new SignupError('Budget must be a positive number.');
  if (input.consent !== true && input.consent !== 'on' && input.consent !== 'true') {
    throw new SignupError('Please agree to be contacted about properties so we can create your account.');
  }
  const parts = name.split(/\s+/);
  return {
    name,
    firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : null,
    lastName: parts[parts.length - 1],
    email,
    phone,
    listingType,
    budgetMax,
    location,
  };
}

function money(amount, { currency, locale }) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

// Plain-text summary of what a guest is looking for, as agents will read it on the Lead.
function criteriaText(criteria, config, { query = null, at = new Date() } = {}) {
  if (!criteria) return null;
  const parts = [];
  if (criteria.listingType) parts.push(`Looking to: ${criteria.listingType === 'Rent' ? 'rent' : 'buy'}`);
  if (criteria.budgetMin !== null && criteria.budgetMin !== undefined) parts.push(`Budget from: ${money(criteria.budgetMin, config)}`);
  if (criteria.budgetMax !== null && criteria.budgetMax !== undefined) parts.push(`Budget up to: ${money(criteria.budgetMax, config)}`);
  if (criteria.locations?.length) parts.push(`Locations: ${criteria.locations.join(', ')}`);
  if (criteria.propertyType) parts.push(`Type: ${criteria.propertyType}`);
  if (criteria.minBedrooms) parts.push(`Bedrooms: ${criteria.minBedrooms}+`);
  if (criteria.minBathrooms) parts.push(`Bathrooms: ${criteria.minBathrooms}+`);
  if (criteria.minFloorArea) parts.push(`Floor area: ${criteria.minFloorArea}+ sq ft`);
  if (query) parts.push(`In their words: "${query}"`);
  parts.push(`Last searched on the portal: ${at.toISOString().slice(0, 10)}`);
  return parts.join('\n');
}

function signupDescription(guest, config) {
  return [
    `Signed up on the ${config.brandName} portal.`,
    guest.listingType ? `Looking to ${guest.listingType === 'Rent' ? 'rent' : 'buy'}.` : null,
    guest.budgetMax ? `Budget up to ${money(guest.budgetMax, config)}.` : null,
    guest.location ? `Preferred location: ${guest.location}.` : null,
  ].filter(Boolean).join(' ');
}

// Writes a guest's latest search to their Lead, at most every 10 minutes per guest,
// without ever slowing down or failing the search itself.
function createLeadCriteriaSync({ crm, config, now = () => Date.now() }) {
  const lastSync = new Map();
  return (user, criteria, { query } = {}) => {
    if (user.role !== 'guest' || !user.leadId || !criteria) return;
    const last = lastSync.get(user.id) || 0;
    if (now() - last < CRITERIA_SYNC_INTERVAL_MS) return;
    lastSync.set(user.id, now());
    const summary = criteriaText(criteria, config, { query, at: new Date(now()) });
    Promise.resolve(crm.updateLeadCriteria(user.leadId, summary)).catch((err) => {
      console.warn(`Could not update Lead ${user.leadId} with search criteria:`, err.message);
    });
  };
}

module.exports = { normalizeSignup, signupDescription, criteriaText, createLeadCriteriaSync, SignupError };
