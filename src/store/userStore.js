// Portal login accounts. Each account links a client's email/password to the
// id of their Contact record in Zoho CRM. Stored as a JSON file for the POC;
// swap for a database before going to production.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('../auth/passwords');

class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = [];
    if (filePath && fs.existsSync(filePath)) {
      this.users = JSON.parse(fs.readFileSync(filePath, 'utf8')).users || [];
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash mid-write never corrupts the store.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  findByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    return this.users.find((u) => u.email === normalized) || null;
  }

  findById(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  async upsert({ email, password, contactId, name }) {
    const normalized = String(email).trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const existing = this.findByEmail(normalized);
    if (existing) {
      Object.assign(existing, { passwordHash, contactId, name, updatedAt: new Date().toISOString() });
    } else {
      this.users.push({
        id: crypto.randomUUID(),
        email: normalized,
        passwordHash,
        contactId,
        name,
        createdAt: new Date().toISOString(),
      });
    }
    this.save();
    return this.findByEmail(normalized);
  }

  get size() {
    return this.users.length;
  }
}

module.exports = { UserStore };
