const path = require('node:path');
const express = require('express');
const { authRoutes } = require('./routes/auth');
const { portalRoutes } = require('./routes/portal');
const { aiRoutes } = require('./routes/ai');
const { adminRoutes } = require('./routes/admin');
const { sameOriginWrites, errorHandler, HttpError } = require('./middleware');

// `ai` is an AiService, or null when AI features are disabled.
function createApp({ config, crm, userStore, activity, ai = null, integrations = {} }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.use('/api', express.json({ limit: '50kb' }), sameOriginWrites);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/config', (req, res) => {
    res.json({ brandName: config.brandName, currency: config.currency, locale: config.locale, mode: config.zohoMode, aiEnabled: Boolean(ai) });
  });
  app.use('/api/auth', authRoutes({ config, crm, userStore, activity }));
  app.use('/api/admin', adminRoutes({ config, crm, userStore, activity, ai, integrations }));
  app.use('/api/ai', aiRoutes({ config, ai, userStore, activity }));
  app.use('/api', portalRoutes({ config, crm, userStore, activity }));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found.')));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Client-side routes (#/...) all load the single-page app.
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
