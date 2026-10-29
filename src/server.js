const config = require('./config');
const { createApp } = require('./app');
const { createCrm } = require('./zoho');
const { UserStore } = require('./store/userStore');

async function seedDemoUsers(userStore) {
  if (userStore.size > 0) return;
  await userStore.upsert({ email: 'alex@client.example', password: 'demo1234', contactId: 'c1', name: 'Alex Rivera' });
  await userStore.upsert({ email: 'priya@client.example', password: 'demo1234', contactId: 'c2', name: 'Priya Shah' });
  console.log('Seeded demo logins: alex@client.example / demo1234, priya@client.example / demo1234');
}

async function main() {
  const crm = createCrm(config);
  const userStore = new UserStore(config.userStorePath);
  if (config.zohoMode === 'mock') await seedDemoUsers(userStore);

  createApp({ config, crm, userStore }).listen(config.port, () => {
    console.log(`${config.brandName} running at http://localhost:${config.port} (Zoho mode: ${config.zohoMode})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
