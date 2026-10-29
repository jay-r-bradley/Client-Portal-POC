// Converts raw Zoho CRM records into the portal's own shapes, and builds the
// COQL used for property search. Pure functions so they can be unit tested.

const { SORTS } = require('../propertyCriteria');

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lookup(value) {
  if (!value || !value.id) return null;
  return { id: String(value.id), name: value.name || null };
}

function mapUser(user) {
  if (!user) return null;
  return {
    id: String(user.id),
    name: user.full_name || user.name || [user.first_name, user.last_name].filter(Boolean).join(' ') || null,
    email: user.email || null,
    phone: user.mobile || user.phone || null,
  };
}

function mapContact(record) {
  return {
    id: String(record.id),
    name: record.Full_Name || [record.First_Name, record.Last_Name].filter(Boolean).join(' '),
    firstName: record.First_Name || null,
    email: record.Email || null,
    phone: record.Mobile || record.Phone || null,
    ownerId: record.Owner?.id ? String(record.Owner.id) : null,
  };
}

function mapDeal(record, f) {
  return {
    id: String(record.id),
    name: record[f.name] || 'Untitled deal',
    stage: record[f.stage] || null,
    amount: num(record[f.amount]),
    closingDate: record[f.closingDate] || null,
    type: record[f.type] || null,
    description: record[f.description] || null,
    contactId: record[f.contact]?.id ? String(record[f.contact].id) : null,
    property: lookup(record[f.property]),
    agent: record.Owner ? mapUser(record.Owner) : null,
    modifiedAt: record.Modified_Time || null,
  };
}

function mapProperty(record, f) {
  return {
    id: String(record.id),
    name: record[f.name] || 'Property',
    address: record[f.address] || null,
    city: record[f.city] || null,
    price: num(record[f.price]),
    propertyType: record[f.type] || null,
    listingType: record[f.listingType] || null,
    bedrooms: num(record[f.bedrooms]),
    bathrooms: num(record[f.bathrooms]),
    floorArea: num(record[f.floorArea]),
    status: record[f.status] || null,
    description: record[f.description] || null,
    photoUrl: record[f.photoUrl] || null,
  };
}

// COQL string literal: wrap in single quotes and escape backslashes and quotes,
// so client-supplied text can never break out of the literal.
function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// COQL requires every pair of conditions to be explicitly parenthesised:
// (a and b), ((a and b) and c), ...
function combine(conditions, operator) {
  return conditions.reduce((acc, cond) => (acc ? `(${acc} ${operator} ${cond})` : cond), '');
}

function buildPropertyQuery(criteria, { module, fields: f, availableStatus, limit = 100 }) {
  const conditions = [`${f.status} = ${quote(availableStatus)}`];
  if (criteria.budgetMin !== null) conditions.push(`${f.price} >= ${Number(criteria.budgetMin)}`);
  if (criteria.budgetMax !== null) conditions.push(`${f.price} <= ${Number(criteria.budgetMax)}`);
  if (criteria.locations.length) {
    const byLocation = criteria.locations.map((loc) => `${f.city} like ${quote(`%${loc}%`)}`);
    conditions.push(byLocation.length > 1 ? combine(byLocation, 'or') : byLocation[0]);
  }
  if (criteria.propertyType) conditions.push(`${f.type} = ${quote(criteria.propertyType)}`);
  if (criteria.listingType) conditions.push(`${f.listingType} = ${quote(criteria.listingType)}`);
  if (criteria.minBedrooms !== null) conditions.push(`${f.bedrooms} >= ${Number(criteria.minBedrooms)}`);
  if (criteria.minBathrooms !== null) conditions.push(`${f.bathrooms} >= ${Number(criteria.minBathrooms)}`);
  if (criteria.minFloorArea !== null) conditions.push(`${f.floorArea} >= ${Number(criteria.minFloorArea)}`);

  const sort = SORTS[criteria.sort] || SORTS.price_asc;
  const sortField = { price: f.price, bedrooms: f.bedrooms, floorArea: f.floorArea }[sort.field];
  const columns = [...new Set(Object.values(f))].join(', ');

  return `select ${columns} from ${module} where ${combine(conditions, 'and')} order by ${sortField} ${sort.direction} limit ${limit}`;
}

module.exports = { mapContact, mapDeal, mapProperty, mapUser, buildPropertyQuery, quote, combine };
