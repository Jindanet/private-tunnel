function getExternalWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function validateTunnelInput(payload) {
  if (!payload || !['http', 'tcp'].includes(payload.type)) throw new Error('Choose a website or TCP service.');
  const port = Number(payload.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a valid local port between 1 and 65535.');
  const name = String(payload.name || '').trim();
  const publishDomain = String(payload.publishDomain || '').trim().toLowerCase();
  const desiredSubdomain = String(payload.desiredSubdomain || '').trim().toLowerCase();
  if (name.length > 100) throw new Error('Name must be 100 characters or fewer.');
  if (publishDomain && (publishDomain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(publishDomain))) {
    throw new Error('Enter a valid publish domain.');
  }
  if (desiredSubdomain && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(desiredSubdomain)) {
    throw new Error('Custom host name must be 3-63 characters, use only a-z, 0-9, or -, and cannot start/end with -.');
  }
  return { type: payload.type, port, name, publishDomain,
    publishMode: payload.type === 'http' && payload.publishMode === 'root' ? 'root' : 'subdomain',
    desiredSubdomain: payload.type === 'http' && payload.publishMode !== 'root' ? desiredSubdomain : '' };
}

module.exports = { getExternalWebUrl, validateTunnelInput };
