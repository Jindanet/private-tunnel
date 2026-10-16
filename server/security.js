const crypto = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(crypto.scrypt);

function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await derive(String(password), salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.trim().length < 10) throw new Error('Admin password must be at least 10 characters long');
  if (password.length > 1024) throw new Error('Admin password must be 1024 characters or fewer');
  return password;
}

async function verifyPasswordHash(password, stored) {
  if (typeof password !== 'string' || !password || password.length > 1024) return false;
  if (/^[a-f0-9]{64}$/i.test(stored || '')) {
    return constantTimeEquals(stored, crypto.createHash('sha256').update(password).digest('hex'));
  }
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  const key = await derive(password, parts[1], 64);
  return constantTimeEquals(parts[2], key.toString('hex'));
}

function serializeInlineJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function isLoopback(address) {
  return address === '::1' || /^(::ffff:)?127\./.test(address || '');
}

function clientIp(req) {
  // Only a local reverse proxy can assert visitor identity.
  const peer = req.socket.remoteAddress || 'unknown';
  return isLoopback(peer) ? String(req.headers['x-real-ip'] || peer).slice(0, 128) : peer;
}

function isAdminHost(req, primaryDomain) {
  try {
    const host = new URL(`http://${req.headers.host || ''}`).hostname.toLowerCase();
    if (primaryDomain) return host === primaryDomain.toLowerCase();
    return isLoopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '[::1]'].includes(host);
  } catch { return false; }
}

function isSameOriginMutation(req) {
  const origin = req.headers.origin;
  if (!origin || req.headers['sec-fetch-site'] === 'cross-site') return false;
  try {
    const parsed = new URL(origin);
    const secure = req.socket.encrypted || (isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https');
    return parsed.origin === `${secure ? 'https' : 'http'}://${req.headers.host}`;
  } catch { return false; }
}

function createAttemptLimiter({ max = 5, windowMs = 60000, capacity = 10000 } = {}) {
  const entries = new Map();
  return {
    take(key) {
      const now = Date.now();
      for (const [ip, entry] of entries) if (entry.until <= now) entries.delete(ip);
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= capacity) return false;
        entry = { count: 0, until: now + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= max;
    },
  };
}

function isValidTunnelToken(value) {
  return typeof value === 'string'
    && /^[\x21-\x7e]{32,4096}$/.test(value)
    && !/^(?:your[-_]|replace[-_]|change[-_]|example[-_])/i.test(value);
}

function validateTunnelToken(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new Error('Access key must be text.');
  const token = value.trim();
  if (allowEmpty && !token) return token;
  if (!isValidTunnelToken(token)) {
    throw new Error('Access key must contain 32–4096 visible ASCII characters without spaces and cannot be an example placeholder. Use a randomly generated key.');
  }
  return token;
}

function authenticateTunnel(req, expectedToken, { allowLegacyQuery = false, allowUnauthenticated = false } = {}) {
  if (expectedToken === '' || expectedToken == null) return allowUnauthenticated;
  // Reject legacy/imported weak keys at their consumer while keeping admin recovery available.
  if (!isValidTunnelToken(expectedToken)) return false;
  const authorization = req.headers.authorization;
  if (authorization) return constantTimeEquals(authorization, `Bearer ${expectedToken}`);
  if (!allowLegacyQuery) return false;
  try { return constantTimeEquals(new URL(req.url, 'http://localhost').searchParams.get('token'), expectedToken); }
  catch { return false; }
}

function redactLogUrl(value) {
  if (value == null) return value;
  const raw = String(value).split(/[?#]/, 1)[0];
  if (/^https?:\/\//i.test(raw)) {
    try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[invalid URL]'; }
  }
  return raw;
}

module.exports = { constantTimeEquals, hashPassword, verifyPasswordHash, validateNewPassword, serializeInlineJson,
  isLoopback, clientIp, isAdminHost, isSameOriginMutation, createAttemptLimiter, authenticateTunnel,
  isValidTunnelToken, validateTunnelToken, redactLogUrl };
