#!/usr/bin/env node
// Grants a client portal access by linking their email to their Zoho CRM Contact.
//
//   npm run create-user -- --email client@example.com --password 'S3cret!pass'
//
// The email must match a Contact in Zoho (looked up live, or in the sample data in mock mode).

const { parseArgs } = require('node:util');
const config = require('../src/config');
const { createCrm } = require('../src/zoho');
const { UserStore } = require('../src/store/userStore');

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      'contact-id': { type: 'string' },
    },
  });
  if (!values.email || !values.password) {
    throw new Error('Usage: npm run create-user -- --email <email> --password <password> [--contact-id <zoho contact id>]');
  }
  if (values.password.length < 8) throw new Error('Password must be at least 8 characters.');

  const crm = createCrm(config);
  const contact = values['contact-id']
    ? await crm.getContact(values['contact-id'])
    : await crm.findContactByEmail(values.email);
  if (!contact) throw new Error(`No Zoho Contact found for ${values['contact-id'] || values.email}.`);

  const store = new UserStore(config.userStorePath);
  const user = await store.upsert({ email: values.email, password: values.password, contactId: contact.id, name: contact.name });
  console.log(`Portal access granted: ${user.email} -> Zoho Contact ${contact.id} (${contact.name})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
