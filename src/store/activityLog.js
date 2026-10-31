// Append-only audit trail of everything users do in the portal: sign-ins,
// searches, views, messages and admin actions. Stored as JSON lines for the
// POC (one event per line, so a crash never corrupts earlier entries); the
// most recent events are kept in memory for fast filtering. Move to a database
// before production.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IN_MEMORY = 50000;
const DAY_MS = 24 * 3600 * 1000;

class ActivityLog {
  constructor(filePath, { now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.events = [];
    if (filePath && fs.existsSync(filePath)) {
      for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // Skip a partially written last line.
        }
      }
      this.events = this.events.slice(-MAX_IN_MEMORY);
    }
  }

  // actor: the signed-in user (or null for anonymous events such as a failed sign-in).
  record({ actor, action, target = null, details = {}, req = null }) {
    const event = {
      id: crypto.randomUUID(),
      at: new Date(this.now()).toISOString(),
      action,
      actor: actor ? { id: actor.id, email: actor.email, name: actor.name || null, role: actor.role } : null,
      target,
      details,
      ip: req?.ip || null,
      userAgent: req?.headers?.['user-agent']?.slice(0, 200) || null,
    };
    this.events.push(event);
    if (this.events.length > MAX_IN_MEMORY) this.events.shift();
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
    return event;
  }

  // Newest first. `before` is the id of the last event of the previous page.
  query({ userId, action, from, to, q, before, limit = 50 } = {}) {
    const fromMs = from ? Date.parse(from) : null;
    const toMs = to ? Date.parse(to) + (to.length === 10 ? DAY_MS : 0) : null; // a bare date includes that whole day
    const needle = q ? q.toLowerCase() : null;
    let started = !before;
    const items = [];
    for (let i = this.events.length - 1; i >= 0 && items.length < limit; i--) {
      const e = this.events[i];
      if (!started) {
        if (e.id === before) started = true;
        continue;
      }
      if (userId && e.actor?.id !== userId && e.target?.userId !== userId) continue;
      if (action && !(e.action === action || e.action.startsWith(`${action}.`))) continue;
      const at = Date.parse(e.at);
      if (fromMs !== null && at < fromMs) continue;
      if (toMs !== null && at >= toMs) continue;
      if (needle && !JSON.stringify([e.actor, e.target, e.details]).toLowerCase().includes(needle)) continue;
      items.push(e);
    }
    const last = items[items.length - 1];
    return { items, next: items.length === limit && last ? last.id : null };
  }

  since(ms) {
    const cutoff = this.now() - ms;
    const out = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (Date.parse(this.events[i].at) < cutoff) break;
      out.push(this.events[i]);
    }
    return out;
  }

  lastEventFor(userId, action) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.actor?.id === userId && e.action === action) return e;
    }
    return null;
  }
}

module.exports = { ActivityLog };
