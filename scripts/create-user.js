#!/usr/bin/env node
// Creates a portal account from the command line. Day to day, admins invite
// clients from the admin console instead; use this for the first admin.
//
//   npm run create-user -- --role admin --email you@company.com --name "Your Name" --password '...'
//   npm run create-user -- --email client@example.com --password '...' [--contact-id <zoho contact id>]
//
// A client's email must match a Contact in Zoho (looked up live, or in the sample data in mock mode).

const { parseArgs } = require('node:util');
const config = require('../src/config');
const { createCrm } = require('../src/zoho');
const { UserStore } = require('../src/store/userStore');

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      role: { type: 'string', default: 'client' },
      name: { type: 'string' },
      'contact-id': { type: 'string' },
    },
  });
  if (!values.email || !values.password) {
    throw new Error('Usage: npm run create-user -- [--role admin|client] --email <email> --password <password> [--name <name>] [--contact-id <id>]');
  }
  if (values.password.length < 10) throw new Error('Password must be at least 10 characters.');
  const store = new UserStore(config.userStorePath);

  if (values.role === 'admin') {
    if (!values.name) throw new Error('Give the admin a --name.');
    const user = await store.upsert({ email: values.email, password: values.password, name: values.name, role: 'admin' });
    console.log(`Admin account ready: ${user.email} (${user.name})`);
    return;
  }

  const crm = createCrm(config);
  const contact = values['contact-id']
    ? await crm.getContact(values['contact-id'])
    : await crm.findContactByEmail(values.email);
  if (!contact) throw new Error(`No Zoho Contact found for ${values['contact-id'] || values.email}.`);
  const user = await store.upsert({ email: values.email, password: values.password, contactId: contact.id, name: contact.name });
  console.log(`Portal access granted: ${user.email} -> Zoho Contact ${contact.id} (${contact.name})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
