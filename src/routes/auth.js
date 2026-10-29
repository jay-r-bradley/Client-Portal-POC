const express = require('express');
const { verifyPassword } = require('../auth/passwords');
const { createSessionToken, sessionCookie, clearSessionCookie } = require('../auth/session');
const { HttpError, requireAuth, LoginThrottle } = require('../middleware');

// Compared against when the email is unknown, so response time does not reveal
// which emails have portal accounts.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

function authRoutes({ config, crm, userStore }) {
  const router = express.Router();
  const cookieOptions = { ttlHours: config.sessionTtlHours, secure: config.isProduction };
  const throttle = new LoginThrottle();

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
      throw new HttpError(401, 'Incorrect email or password.');
    }
    throttle.recordSuccess(req);

    // The Zoho Contact is the source of truth: if it has been deleted, so is access.
    const contact = await crm.getContact(user.contactId);
    if (!contact) throw new HttpError(403, 'Your portal access is no longer active. Please contact your agent.');

    const token = createSessionToken({ uid: user.id, contactId: user.contactId }, { secret: config.sessionSecret, ttlHours: config.sessionTtlHours });
    res.set('Set-Cookie', sessionCookie(token, cookieOptions));
    res.json({ user: { name: contact.name, email: user.email } });
  });

  router.post('/logout', (req, res) => {
    res.set('Set-Cookie', clearSessionCookie(cookieOptions));
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(config), async (req, res) => {
    const user = userStore.findById(req.session.uid);
    const [contact, agent] = await Promise.all([crm.getContact(req.session.contactId), crm.getAgent(req.session.contactId)]);
    if (!user || !contact) throw new HttpError(401, 'Please sign in.');
    res.json({
      user: { name: contact.name, firstName: contact.firstName, email: user.email, phone: contact.phone },
      agent,
    });
  });

  return router;
}

module.exports = { authRoutes };
