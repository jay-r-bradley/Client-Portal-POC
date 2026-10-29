// Stateless sessions: an HMAC-signed, expiring token stored in an HttpOnly cookie.

const crypto = require('node:crypto');

const COOKIE_NAME = 'portal_session';

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function createSessionToken(payload, { secret, ttlHours }) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlHours * 3600 * 1000 })).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function readSessionToken(token, { secret }) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = sign(body, secret);
  if (!signature || signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function sessionCookie(token, { ttlHours, secure }) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlHours * 3600)}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

function clearSessionCookie({ secure }) {
  return [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', secure ? 'Secure' : null]
    .filter(Boolean).join('; ');
}

module.exports = { COOKIE_NAME, createSessionToken, readSessionToken, parseCookies, sessionCookie, clearSessionCookie };
