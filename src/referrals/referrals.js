// Client referral program: shared validation and the mapping between Zoho Lead
// statuses and the simple progress a referring client sees.

const INTERESTS = ['Buying a home', 'Land or a lot', 'Selling a property', 'Renting', 'Investment property'];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class ReferralError extends Error {}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeReferral(input = {}) {
  const name = text(input.name, 120);
  const email = text(input.email, 200).toLowerCase();
  const phone = text(input.phone, 40);
  const interest = text(input.interest, 60);
  const notes = text(input.notes, 1000);
  if (name.split(/\s+/).filter(Boolean).length < 1) throw new ReferralError("Enter your friend's name.");
  if (!email && !phone) throw new ReferralError('Enter an email address or phone number so the agent can reach them.');
  if (email && !EMAIL_PATTERN.test(email)) throw new ReferralError('That email address does not look right.');
  if (!INTERESTS.includes(interest)) throw new ReferralError('Choose what they are interested in.');
  if (input.consent !== true && input.consent !== 'on' && input.consent !== 'true') {
    throw new ReferralError('Please confirm they have agreed to be contacted.');
  }
  const parts = name.split(/\s+/);
  return {
    name,
    firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : null,
    lastName: parts[parts.length - 1],
    email: email || null,
    phone: phone || null,
    interest,
    notes: notes || null,
  };
}

// Zoho's default Lead Status values, folded into four client-friendly steps.
const STATUS_STEPS = {
  received: ['Not Contacted', 'New', null, ''],
  in_touch: ['Attempted to Contact', 'Contacted', 'Contact in Future'],
  qualified: ['Pre-Qualified', 'Qualified', 'Converted'],
  closed: ['Junk Lead', 'Lost Lead', 'Not Qualified'],
};
const STATUS_LABELS = { received: 'Received', in_touch: 'Agent in touch', qualified: 'Qualified', closed: 'Closed' };

function referralProgress(leadStatus) {
  const step = Object.keys(STATUS_STEPS).find((key) => STATUS_STEPS[key].includes(leadStatus ?? null)) || 'in_touch';
  return { step, label: STATUS_LABELS[step] };
}

module.exports = { INTERESTS, normalizeReferral, referralProgress, ReferralError };
