const config = require('./config');
const { createApp } = require('./app');
const { createCrm } = require('./zoho');
const { UserStore } = require('./store/userStore');
const { ActivityLog } = require('./store/activityLog');
const { createAi } = require('./ai');
const { seedDemoActivity } = require('./demo/seedActivity');

async function seedDemoUsers(userStore) {
  if (!userStore.findByEmail('admin@brokerage.example')) {
    await userStore.upsert({ email: 'admin@brokerage.example', password: 'admin1234', name: 'Dana Brooks', role: 'admin' });
  }
  if (!userStore.findByEmail('alex@client.example')) {
    await userStore.upsert({ email: 'alex@client.example', password: 'demo1234', contactId: 'c1', name: 'Alex Rivera' });
  }
  if (!userStore.findByEmail('priya@client.example')) {
    await userStore.upsert({ email: 'priya@client.example', password: 'demo1234', contactId: 'c2', name: 'Priya Shah' });
  }
  console.log('Demo logins: admin@brokerage.example / admin1234 (admin), alex@client.example / demo1234 (client)');
}

async function main() {
  const crm = createCrm(config);
  const userStore = new UserStore(config.userStorePath);
  const activity = new ActivityLog(config.activityLogPath);
  if (config.zohoMode === 'mock') {
    await seedDemoUsers(userStore);
    if (activity.events.length === 0) seedDemoActivity(activity, userStore);
  }
  if (!userStore.list().some((u) => u.role === 'admin')) {
    console.warn('No admin account yet. Create one with: npm run create-user -- --role admin --email you@company.com --name "Your Name" --password ...');
  }

  const ai = createAi(config, crm);

  createApp({ config, crm, userStore, activity, ai, integrations: { mcp: ai?.mcp || null } }).listen(config.port, () => {
    console.log(`${config.brandName} running at http://localhost:${config.port} (Zoho mode: ${config.zohoMode})`);
    console.log(ai ? `AI features enabled (model: ${config.ai.model}, CRM access: ${ai.source})` : 'AI features disabled (set OPENAI_API_KEY to enable)');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
