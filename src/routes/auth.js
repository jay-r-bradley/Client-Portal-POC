const express = require('express');
const { verifyPassword } = require('../auth/passwords');
const { COOKIE_NAME, parseCookies, readSessionToken, createSessionToken, sessionCookie, clearSessionCookie } = require('../auth/session');
const { HttpError, requireAuth, allowPendingPasswordChange, LoginThrottle } = require('../middleware');
const { normalizeSignup, signupDescription, SignupError } = require('../guests/guests');

const MAX_SIGNUPS_PER_IP_PER_HOUR = 5;

// Compared against when the email is unknown, so response time does not reveal
// which emails have portal accounts.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
const MIN_PASSWORD_LENGTH = 10;

function validateNewPassword(password, user) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Use at least ${MIN_PASSWORD_LENGTH} characters for your new password.`);
  }
  if (password.toLowerCase() === user.email) throw new HttpError(400, 'Your password cannot be your email address.');
}

function authRoutes({ config, crm, userStore, activity }) {
  const router = express.Router();
  const cookieOptions = { ttlHours: config.sessionTtlHours, secure: config.isProduction };
  const throttle = new LoginThrottle();
  const issueSession = (res, user) => {
    const token = createSessionToken({ uid: user.id, sv: user.sessionVersion }, { secret: config.sessionSecret, ttlHours: config.sessionTtlHours });
    res.set('Set-Cookie', sessionCookie(token, cookieOptions));
  };

  router.post('/login', async (req, res) => {
    throttle.assertAllowed(req, res);
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      throw new HttpError(400, 'Email and password are required.');
    }
    const user = userStore.findByEmail(email);
    const valid = await verifyPassword(password, user?.passwordHash || DUMMY_HASH);
    if (!user || !valid) {
      throttle.recordFailure(req);
      activity.record({
        actor: null, action: 'auth.login_failed', req,
        target: user ? { userId: user.id, email: user.email } : null,
        details: { email: email.trim().toLowerCase().slice(0, 200) },
      });
      throw new HttpError(401, 'Incorrect email or password.');
    }
    throttle.recordSuccess(req);

    if (user.status !== 'active') {
      activity.record({ actor: user, action: 'auth.login_blocked', req, details: { reason: 'Account disabled' } });
      throw new HttpError(403, 'Your portal access has been disabled. Please contact your agent.');
    }
    // For clients, the Zoho Contact is the source of truth: if it has been deleted, so is access.
    let name = user.name;
    if (user.role === 'client') {
      const contact = await crm.getContact(user.contactId);
      if (!contact) {
        activity.record({ actor: user, action: 'auth.login_blocked', req, details: { reason: 'Zoho Contact not found' } });
        throw new HttpError(403, 'Your portal access is no longer active. Please contact your agent.');
      }
      name = contact.name;
    }

    userStore.update(user.id, { lastLoginAt: new Date().toISOString(), name });
    activity.record({ actor: user, action: 'auth.login', req });
    issueSession(res, user);
    res.json({ user: { name, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword } });
  });

  // Self sign-up: creates a guest account and a Lead in Zoho CRM. Accounts are
  // accepted immediately. A guest is never linked to an existing Zoho Contact
  // here (emails are not verified yet); an admin converts them to a client.
  const signupsByIp = new Map();
  router.post('/signup', async (req, res) => {
    const hourAgo = Date.now() - 3600 * 1000;
    const recent = (signupsByIp.get(req.ip) || []).filter((t) => t > hourAgo);
    if (recent.length >= MAX_SIGNUPS_PER_IP_PER_HOUR) throw new HttpError(429, 'Too many sign-ups from this network. Please try again later.');

    let guest;
    try {
      guest = normalizeSignup(req.body || {});
    } catch (err) {
      if (err instanceof SignupError) throw new HttpError(400, err.message);
      throw err;
    }
    const password = req.body?.password;
    validateNewPassword(password, { email: guest.email });
    if (userStore.findByEmail(guest.email)) throw new HttpError(409, 'An account with this email already exists. Please sign in instead.');

    let lead;
    try {
      lead = await crm.createSignupLead({ ...guest, description: signupDescription(guest, config) });
    } catch (err) {
      console.error('Sign-up Lead could not be created in Zoho:', err.message);
      throw new HttpError(502, 'We could not create your account right now. Please try again shortly.');
    }

    const user = await userStore.upsert({ email: guest.email, password, name: guest.name, phone: guest.phone, role: 'guest', leadId: lead.id });
    signupsByIp.set(req.ip, [...recent, Date.now()]);
    userStore.update(user.id, { lastLoginAt: new Date().toISOString() });
    activity.record({
      actor: user, action: 'auth.signed_up', req,
      target: { leadId: lead.id },
      details: { listingType: guest.listingType, budgetMax: guest.budgetMax, location: guest.location },
    });
    issueSession(res, user);
    res.status(201).json({
      user: { name: user.name, email: user.email, role: 'guest' },
      // The sign-up answers seed the guest's first property search.
      initialFilters: { budgetMax: guest.budgetMax, locations: guest.location ? [guest.location] : [], listingType: guest.listingType },
    });
  });

  router.post('/logout', (req, res) => {
    const session = readSessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME], { secret: config.sessionSecret });
    const user = session && userStore.findById(session.uid);
    if (user) activity.record({ actor: user, action: 'auth.logout', req });
    res.set('Set-Cookie', clearSessionCookie(cookieOptions));
    res.json({ ok: true });
  });

  router.post('/change-password', allowPendingPasswordChange, requireAuth({ config, userStore }), async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!(await verifyPassword(String(currentPassword || ''), req.user.passwordHash))) {
      throw new HttpError(400, 'Your current password is incorrect.');
    }
    validateNewPassword(newPassword, req.user);
    if (newPassword === currentPassword) throw new HttpError(400, 'Choose a password different from your current one.');
    // Signs out every other session; this one gets a fresh cookie.
    const user = await userStore.setPassword(req.user.id, newPassword);
    activity.record({ actor: user, action: 'auth.password_changed', req });
    issueSession(res, user);
    res.json({ ok: true });
  });

  router.get('/me', allowPendingPasswordChange, requireAuth({ config, userStore }), async (req, res) => {
    const { user } = req;
    const base = { name: user.name, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword };
    if (user.role !== 'client') return res.json({ user: base, agent: null });

    const [contact, agent] = await Promise.all([crm.getContact(user.contactId), crm.getAgent(user.contactId)]);
    if (!contact) throw new HttpError(401, 'Please sign in.');
    res.json({ user: { ...base, name: contact.name, firstName: contact.firstName, phone: contact.phone }, agent });
  });

  return router;
}

module.exports = { authRoutes, validateNewPassword, MIN_PASSWORD_LENGTH };
