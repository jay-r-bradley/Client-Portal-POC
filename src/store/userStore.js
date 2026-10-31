// Portal login accounts. Three roles:
//   admin  - brokerage staff: manage access, see all activity
//   client - a buyer/tenant with an active deal, linked to their Zoho Contact
//   guest  - signed up on their own; a Zoho Lead who can browse and match properties
// Stored as a JSON file for the POC; swap for a database before production.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('../auth/passwords');

const ROLES = ['admin', 'client', 'guest'];

class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = [];
    if (filePath && fs.existsSync(filePath)) {
      this.users = (JSON.parse(fs.readFileSync(filePath, 'utf8')).users || []).map(withDefaults);
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

  list() {
    return [...this.users];
  }

  // Creates or replaces an account (used by seeding and the create-user script).
  async upsert({ email, password, contactId = null, name, role = 'client', mustChangePassword = false, createdBy = null, leadId = null, phone = null }) {
    if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
    if (role === 'client' && !contactId) throw new Error('A client account must be linked to a Zoho Contact.');
    const normalized = String(email).trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const existing = this.findByEmail(normalized);
    if (existing) {
      Object.assign(existing, { passwordHash, contactId, name, role, mustChangePassword, updatedAt: new Date().toISOString() });
      existing.sessionVersion += 1;
    } else {
      this.users.push(withDefaults({
        id: crypto.randomUUID(),
        email: normalized,
        passwordHash,
        contactId,
        name,
        role,
        mustChangePassword,
        createdBy,
        leadId,
        phone,
        createdAt: new Date().toISOString(),
      }));
    }
    this.save();
    return this.findByEmail(normalized);
  }

  // Applies a change and bumps the session version when it should sign the
  // user out everywhere (password change or reset, account disabled).
  update(id, changes, { revokeSessions = false } = {}) {
    const user = this.findById(id);
    if (!user) return null;
    Object.assign(user, changes, { updatedAt: new Date().toISOString() });
    if (revokeSessions) user.sessionVersion += 1;
    this.save();
    return user;
  }

  async setPassword(id, password, { mustChangePassword = false } = {}) {
    return this.update(id, { passwordHash: await hashPassword(password), mustChangePassword }, { revokeSessions: true });
  }

  get size() {
    return this.users.length;
  }
}

function withDefaults(user) {
  return { role: 'client', status: 'active', sessionVersion: 1, mustChangePassword: false, lastLoginAt: null, ...user };
}

// The fields safe to send to the browser.
function publicUser(user) {
  if (!user) return null;
  const { passwordHash: _hash, sessionVersion: _version, ...rest } = user;
  return rest;
}

module.exports = { UserStore, ROLES, publicUser };
