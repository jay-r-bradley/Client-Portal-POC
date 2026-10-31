const { COOKIE_NAME, parseCookies, readSessionToken } = require('./auth/session');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Resolves the signed-in user from the session cookie on every request, so a
// disabled account or a reset password takes effect immediately. `role` (one
// role or a list) restricts who may use the route.
function requireAuth({ config, userStore }, { role } = {}) {
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = readSessionToken(token, { secret: config.sessionSecret });
    const user = session && userStore.findById(session.uid);
    if (!user || user.status !== 'active' || session.sv !== user.sessionVersion) {
      return next(new HttpError(401, 'Please sign in.'));
    }
    if (role && ![].concat(role).includes(user.role)) return next(new HttpError(403, 'You do not have access to this page.'));
    // Until a temporary password is replaced, only the change-password endpoint works.
    if (user.mustChangePassword && !req.allowPendingPasswordChange) {
      return next(new HttpError(403, 'Please set a new password to continue.'));
    }
    req.user = user;
    req.session = { uid: user.id, contactId: user.contactId, role: user.role };
    next();
  };
}

function allowPendingPasswordChange(req, res, next) {
  req.allowPendingPasswordChange = true;
  next();
}

// CSRF defence for cookie-authenticated writes: state-changing requests must be
// JSON (which a cross-site HTML form cannot send) and, when the browser sends an
// Origin header, it must match this host.
function sameOriginWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.is('application/json')) return next(new HttpError(415, 'Requests must be JSON.'));
  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(new HttpError(403, 'Bad origin.'));
    }
    if (originHost !== req.headers.host) return next(new HttpError(403, 'Cross-site request blocked.'));
  }
  next();
}

// Locks out an IP + email pair after too many failed sign-ins in a window.
// Successful sign-ins clear the counter, so normal use is never throttled.
class LoginThrottle {
  constructor({ maxFailures = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.failures = new Map();
  }

  key(req) {
    return `${req.ip}|${String(req.body?.email || '').trim().toLowerCase()}`;
  }

  assertAllowed(req, res) {
    const entry = this.failures.get(this.key(req));
    if (entry && entry.resetAt > Date.now() && entry.count >= this.maxFailures) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - Date.now()) / 1000)));
      throw new HttpError(429, 'Too many sign-in attempts. Please try again later.');
    }
  }

  recordFailure(req) {
    const now = Date.now();
    const key = this.key(req);
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt < now) this.failures.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
    if (this.failures.size > 10000) {
      for (const [k, v] of this.failures) if (v.resetAt < now) this.failures.delete(k);
    }
  }

  recordSuccess(req) {
    this.failures.delete(this.key(req));
  }
}

function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Malformed JSON body.');
  // HttpErrors and body-parser errors (e.g. 413) are safe to show the client.
  if (err instanceof HttpError || (err.expose && err.status < 500)) {
    return res.status(err.status).json({ error: err.message });
  }
  // Zoho or unexpected failures: log details server-side, keep the client message generic.
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  res.status(err.name === 'ZohoApiError' ? 502 : 500).json({ error: 'Something went wrong. Please try again.' });
}

module.exports = { HttpError, requireAuth, allowPendingPasswordChange, sameOriginWrites, LoginThrottle, errorHandler };
