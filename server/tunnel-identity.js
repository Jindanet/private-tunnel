const crypto = require('node:crypto');
const { authenticateTunnel } = require('./security');

function authenticatePrincipal(req, { accessKeyStore, sharedToken, allowShared = false,
  allowLegacyQuery = false, allowUnauthenticated = false } = {}) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const key = accessKeyStore?.authenticate(authorization.slice(7));
    if (key) return { kind: 'client-key', id: key.id, name: key.name };
  }
  if (allowShared && authenticateTunnel(req, sharedToken, { allowLegacyQuery, allowUnauthenticated })) {
    return { kind: 'shared', id: 'legacy' };
  }
  return null;
}

function bindClientIdentity(principal, clientId) {
  if (clientId != null && (typeof clientId !== 'string' || !/^[\x21-\x7e]{1,191}$/.test(clientId))) {
    throw new Error('Invalid client profile identifier.');
  }
  if (principal?.kind === 'client-key') {
    if (!/^[a-f0-9-]{36}$/i.test(principal.id)) throw new Error('Invalid authenticated principal.');
    const profile = crypto.createHash('sha256').update(clientId || 'default').digest('hex');
    return `key:${principal.id}:${profile}`;
  }
  // Legacy callers cannot assert the reserved namespace of a key owner.
  if (clientId?.toLowerCase().startsWith('key:')) throw new Error('Reserved client profile identifier.');
  return clientId || null;
}

module.exports = { authenticatePrincipal, bindClientIdentity };
