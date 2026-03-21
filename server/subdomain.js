const crypto = require('node:crypto');

const RESERVED = new Set(['tunnel', 'www', 'api', 'admin', 'mail', 'ftp']);

function generate() {
  return crypto.randomBytes(4).toString('hex'); // 8-char hex string
}

function generateUnique(activeTunnels) {
  let subdomain;
  let attempts = 0;
  do {
    subdomain = generate();
    attempts++;
    if (attempts > 100) throw new Error('Failed to generate unique subdomain');
  } while (activeTunnels.has(subdomain) || RESERVED.has(subdomain));
  return subdomain;
}

module.exports = { generate, generateUnique, RESERVED };
