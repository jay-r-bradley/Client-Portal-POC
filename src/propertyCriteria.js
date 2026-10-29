// Validation and matching for the client's property search form.
// The same normalized criteria drive both the live COQL query and the mock data filter.

const MAX_LOCATIONS = 5;
const SORTS = {
  price_asc: { field: 'price', direction: 'asc' },
  price_desc: { field: 'price', direction: 'desc' },
  bedrooms_desc: { field: 'bedrooms', direction: 'desc' },
  area_desc: { field: 'floorArea', direction: 'desc' },
};

class CriteriaError extends Error {}

function optionalNumber(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CriteriaError(`${label} must be a positive number.`);
  return n;
}

function optionalText(value, maxLength = 80) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().slice(0, maxLength);
  return text || null;
}

function normalizeCriteria(input = {}) {
  const budgetMin = optionalNumber(input.budgetMin, 'Minimum budget');
  const budgetMax = optionalNumber(input.budgetMax, 'Maximum budget');
  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) {
    throw new CriteriaError('Minimum budget cannot be greater than maximum budget.');
  }

  const rawLocations = Array.isArray(input.locations)
    ? input.locations
    : [input.preferredLocation, ...String(input.otherLocations || '').split(',')];
  const locations = [...new Set(rawLocations.map((l) => optionalText(l)).filter(Boolean))];
  if (locations.length > MAX_LOCATIONS) {
    throw new CriteriaError(`Please list at most ${MAX_LOCATIONS} locations.`);
  }

  return {
    budgetMin,
    budgetMax,
    locations,
    propertyType: optionalText(input.propertyType),
    listingType: optionalText(input.listingType),
    minBedrooms: optionalNumber(input.minBedrooms, 'Bedrooms'),
    minBathrooms: optionalNumber(input.minBathrooms, 'Bathrooms'),
    minFloorArea: optionalNumber(input.minFloorArea, 'Floor area'),
    keywords: optionalText(input.keywords, 120),
    sort: SORTS[input.sort] ? input.sort : 'price_asc',
  };
}

function includesText(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(needle.toLowerCase());
}

// Keyword matching runs in the portal rather than in COQL, because Zoho does not
// allow LIKE comparisons on long-text fields such as Description.
function matchesKeywords(property, keywords) {
  if (!keywords) return true;
  return keywords
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => [property.name, property.address, property.city, property.description].some((f) => includesText(f, word)));
}

function matchesCriteria(property, c) {
  if (c.budgetMin !== null && !(property.price >= c.budgetMin)) return false;
  if (c.budgetMax !== null && !(property.price <= c.budgetMax)) return false;
  if (c.locations.length && !c.locations.some((loc) => includesText(property.city, loc))) return false;
  if (c.propertyType && property.propertyType !== c.propertyType) return false;
  if (c.listingType && property.listingType !== c.listingType) return false;
  if (c.minBedrooms !== null && !(property.bedrooms >= c.minBedrooms)) return false;
  if (c.minBathrooms !== null && !(property.bathrooms >= c.minBathrooms)) return false;
  if (c.minFloorArea !== null && !(property.floorArea >= c.minFloorArea)) return false;
  return matchesKeywords(property, c.keywords);
}

function sortProperties(properties, sortKey) {
  const { field, direction } = SORTS[sortKey] || SORTS.price_asc;
  const sign = direction === 'asc' ? 1 : -1;
  return [...properties].sort((a, b) => ((a[field] ?? 0) - (b[field] ?? 0)) * sign);
}

module.exports = { normalizeCriteria, matchesCriteria, matchesKeywords, sortProperties, CriteriaError, SORTS };
