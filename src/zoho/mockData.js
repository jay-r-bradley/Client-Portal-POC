// Sample brokerage data used when ZOHO_MODE=mock, so the portal can be demoed
// without a Zoho org. Shapes match what LiveCrm returns after mapping.

const agents = {
  u1: { id: 'u1', name: 'Maria Santos', email: 'maria.santos@brokerage.example', phone: '+1 512 555 0141' },
  u2: { id: 'u2', name: 'James Carter', email: 'james.carter@brokerage.example', phone: '+1 214 555 0177' },
};

const contacts = {
  c1: { id: 'c1', name: 'Alex Rivera', firstName: 'Alex', email: 'alex@client.example', phone: '+1 512 555 0100', ownerId: 'u1' },
  c2: { id: 'c2', name: 'Priya Shah', firstName: 'Priya', email: 'priya@client.example', phone: '+1 214 555 0199', ownerId: 'u2' },
};

const properties = [
  ['p1', 'Lakeview Modern Townhouse', '1820 Lakeshore Dr', 'Austin', 485000, 'Townhouse', 'Sale', 3, 2.5, 1850, 'Bright end-unit townhouse with lake views, rooftop terrace and two-car garage.'],
  ['p2', 'Downtown Loft 12B', '400 Congress Ave #12B', 'Austin', 389000, 'Condo', 'Sale', 1, 1, 920, 'Industrial-style loft with floor-to-ceiling windows, walking distance to everything.'],
  ['p3', 'Hill Country Family Home', '77 Live Oak Ln', 'Austin', 725000, 'Single Family', 'Sale', 4, 3, 2900, 'Spacious family home on a half-acre lot with pool and mature oak trees.'],
  ['p4', 'East Side Bungalow', '1105 Chicon St', 'Austin', 2950, 'Single Family', 'Rent', 2, 1, 1100, 'Renovated bungalow with a big backyard, pet friendly.'],
  ['p5', 'Uptown Skyline Condo', '2500 McKinney Ave #1804', 'Dallas', 615000, 'Condo', 'Sale', 2, 2, 1400, 'High-floor condo with skyline views, concierge, pool and gym.'],
  ['p6', 'Lakewood Craftsman', '6420 Lakewood Blvd', 'Dallas', 849000, 'Single Family', 'Sale', 4, 3.5, 3200, 'Classic craftsman near White Rock Lake, fully updated kitchen.'],
  ['p7', 'Bishop Arts Studio', '410 N Bishop Ave #3', 'Dallas', 1650, 'Condo', 'Rent', 0, 1, 550, 'Cozy studio above shops and cafes in the Bishop Arts District.'],
  ['p8', 'Plano Starter Home', '3309 Parkhaven Dr', 'Plano', 365000, 'Single Family', 'Sale', 3, 2, 1650, 'Move-in ready home in a top-rated school district.'],
  ['p9', 'Heights Victorian', '1123 Heights Blvd', 'Houston', 699000, 'Single Family', 'Sale', 3, 2.5, 2400, 'Restored Victorian with wraparound porch on the Heights boulevard.'],
  ['p10', 'Midtown Garden Apartment', '3100 Smith St #210', 'Houston', 2100, 'Apartment', 'Rent', 2, 2, 1050, 'Garden-level apartment with private patio, close to light rail.'],
  ['p11', 'Galleria Luxury Penthouse', '5000 Westheimer Rd PH2', 'Houston', 1450000, 'Condo', 'Sale', 3, 3.5, 3100, 'Penthouse with private elevator, chef kitchen and panoramic views.'],
  ['p12', 'Pearl District Duplex', '215 Karnes St', 'San Antonio', 540000, 'Multi-Family', 'Sale', 4, 4, 2600, 'Income-producing duplex near the Pearl, both units leased.'],
  ['p13', 'Alamo Heights Cottage', '118 Montclair St', 'San Antonio', 459000, 'Single Family', 'Sale', 2, 2, 1450, 'Charming cottage with updated systems on a tree-lined street.'],
  ['p14', 'Round Rock Commercial Suite', '901 S Mays St Ste 200', 'Round Rock', 4800, 'Commercial', 'Rent', 0, 2, 2200, 'Second-floor office suite with reception, four offices and conference room.'],
  ['p15', 'Zilker Park Townhome', '2208 Barton Hills Dr', 'Austin', 599000, 'Townhouse', 'Sale', 3, 2.5, 1720, 'Walk to Zilker Park and Barton Springs; private courtyard.'],
  ['p16', 'Sold: Cedar Park Ranch', '45 Brushy Creek Rd', 'Cedar Park', 520000, 'Single Family', 'Sale', 4, 2, 2300, 'Ranch-style home on a large lot.', 'Sold'],
].map(([id, name, address, city, price, propertyType, listingType, bedrooms, bathrooms, floorArea, description, status = 'Available']) => ({
  id, name, address, city, price, propertyType, listingType, bedrooms, bathrooms, floorArea, description, status, photoUrl: null,
}));

const deals = [
  { id: 'd1', contactId: 'c1', name: 'Rivera - Lakeview Townhouse purchase', stage: 'Negotiation', amount: 478000, closingDate: '2026-12-15', type: 'Purchase', propertyId: 'p1', agentId: 'u1', modifiedAt: '2026-10-26T15:20:00Z', description: 'Counter-offer of $478k submitted; awaiting seller response.' },
  { id: 'd2', contactId: 'c1', name: 'Rivera - Zilker Park Townhome viewing', stage: 'Viewing Scheduled', amount: 599000, closingDate: '2027-02-01', type: 'Purchase', propertyId: 'p15', agentId: 'u1', modifiedAt: '2026-10-24T10:00:00Z', description: 'Viewing booked for Saturday 11am.' },
  { id: 'd3', contactId: 'c1', name: 'Rivera - East Side Bungalow lease', stage: 'Closed Won', amount: 2950, closingDate: '2026-03-01', type: 'Lease', propertyId: 'p4', agentId: 'u1', modifiedAt: '2026-03-01T09:00:00Z', description: '12-month lease signed.' },
  { id: 'd4', contactId: 'c1', name: 'Rivera - Cedar Park Ranch offer', stage: 'Closed Lost', amount: 510000, closingDate: '2026-06-30', type: 'Purchase', propertyId: 'p16', agentId: 'u1', modifiedAt: '2026-06-30T09:00:00Z', description: 'Outbid by a cash offer.' },
  { id: 'd5', contactId: 'c2', name: 'Shah - Uptown Skyline Condo', stage: 'Under Contract', amount: 605000, closingDate: '2026-11-20', type: 'Purchase', propertyId: 'p5', agentId: 'u2', modifiedAt: '2026-10-27T18:45:00Z', description: 'Inspection passed, financing in underwriting.' },
];

const messages = [
  { id: 'm1', contactId: 'c1', from: 'agent', author: 'Maria Santos', subject: 'Welcome to your client portal', body: 'Hi Alex, you can follow all of your deals here and message me any time.', createdAt: '2026-10-20T09:00:00Z' },
];

module.exports = { agents, contacts, properties, deals, messages };
