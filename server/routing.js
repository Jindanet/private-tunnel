const DEFAULT_CONTROL_ROOT = '/_private-tunnel';
const LEGACY_TUNNEL_WS_PATH = '/ws';

function stripPort(host) {
  const value = String(host || '').trim();
  if (!value) return '';

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end >= 0 ? value.slice(1, end) : value;
  }

  const colonCount = (value.match(/:/g) || []).length;
  if (colonCount <= 1) {
    return value.split(':')[0];
  }

  return value;
}

function normalizeDomain(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) return '';

  host = host.replace(/^[a-z]+:\/\//, '');
  host = host.split('/')[0];
  host = stripPort(host);

  while (host.endsWith('.')) {
    host = host.slice(0, -1);
  }

  return host;
}

function normalizeControlRoot(value) {
  let nextValue = String(value || '').trim().toLowerCase();
  if (!nextValue) return '';
  if (!nextValue.startsWith('/')) {
    nextValue = `/${nextValue}`;
  }

  nextValue = nextValue.replace(/\/+/g, '/');
  if (nextValue.length > 1 && nextValue.endsWith('/')) {
    nextValue = nextValue.slice(0, -1);
  }

  if (!/^\/[a-z0-9/_-]+$/.test(nextValue)) {
    return '';
  }

  return nextValue;
}

function isValidControlRoot(value) {
  return !!normalizeControlRoot(value);
}

function isValidDomain(value) {
  const domain = normalizeDomain(value);
  if (!domain || !domain.includes('.')) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain);
}

function normalizePublishDomainEntry(entry) {
  if (!entry) return null;

  const domain = normalizeDomain(entry.domain || entry.hostname || entry.value || '');
  if (!domain || !isValidDomain(domain)) return null;

  return {
    domain,
    allowSubdomain: entry.allowSubdomain !== false,
    allowRoot: entry.allowRoot === true,
    certificatePath: String(entry.certificatePath || entry.certPath || '').trim(),
    certificateKeyPath: String(entry.certificateKeyPath || entry.keyPath || '').trim(),
  };
}

function normalizePublishDomains(input, fallbackDomain) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const domains = [];

  for (const item of list) {
    const normalized = normalizePublishDomainEntry(item);
    if (!normalized || seen.has(normalized.domain)) continue;
    seen.add(normalized.domain);
    domains.push(normalized);
  }

  const fallback = normalizeDomain(fallbackDomain);
  if (fallback && isValidDomain(fallback) && !seen.has(fallback)) {
    domains.push({
      domain: fallback,
      allowSubdomain: true,
      allowRoot: false,
    });
  }

  return domains;
}

function isExactHost(hostname, domain) {
  const host = normalizeDomain(hostname);
  const target = normalizeDomain(domain);
  return !!host && !!target && host === target;
}

function extractSingleSubdomain(hostname, domain) {
  const host = normalizeDomain(hostname);
  const base = normalizeDomain(domain);

  if (!host || !base || host === base) return null;
  if (!host.endsWith(`.${base}`)) return null;

  const prefix = host.slice(0, -(base.length + 1));
  if (!prefix || prefix.includes('.')) return null;

  return prefix;
}

function buildHttpHost(label, publishDomain, publishMode) {
  const domain = normalizeDomain(publishDomain);
  if (!domain) return '';
  return publishMode === 'root' ? domain : `${label}.${domain}`;
}

function matchManagedHttpHost(hostname, publishDomains) {
  const host = normalizeDomain(hostname);
  const domains = Array.isArray(publishDomains) ? publishDomains : [];

  for (const config of domains) {
    const domain = normalizeDomain(config && config.domain);
    if (!domain) continue;

    if (config.allowRoot && host === domain) {
      return { mode: 'root', domain, label: null };
    }

    if (config.allowSubdomain) {
      const label = extractSingleSubdomain(host, domain);
      if (label) {
        return { mode: 'subdomain', domain, label };
      }
    }
  }

  return null;
}

function getTunnelHttpOrigin(subdomain, config) {
  if (!subdomain) return '';
  if (String(subdomain).includes('.')) return `https://${subdomain}`;
  const tunnelDomain = normalizeDomain(config && config.tunnelDomain);
  return tunnelDomain ? `https://${subdomain}.${tunnelDomain}` : '';
}

function getTcpAddress(port, configOrDomain) {
  const tunnelDomain = typeof configOrDomain === 'string'
    ? normalizeDomain(configOrDomain)
    : normalizeDomain(configOrDomain && configOrDomain.tunnelDomain);
  if (!tunnelDomain || !port) return '';
  return `${tunnelDomain}:${port}`;
}

function getAdminOrigin(config) {
  const primaryDomain = normalizeDomain(config && config.primaryDomain);
  return primaryDomain ? `https://${primaryDomain}` : '';
}

function buildRuntimeRoutes(config) {
  const controlRoot = normalizeControlRoot(config && config.controlRoot) || DEFAULT_CONTROL_ROOT;
  const tunnelWsPath = `${controlRoot}/ws`;
  const adminBasePath = `${controlRoot}/admin`;
  const adminLoginPath = `${adminBasePath}/login`;
  const adminLogoutPath = `${adminBasePath}/logout`;
  const adminApiBasePath = `${adminBasePath}/api`;
  const adminWsPath = `${adminBasePath}/live`;

  return {
    controlRoot,
    tunnelWsPath,
    legacyTunnelWsPath: LEGACY_TUNNEL_WS_PATH,
    adminBasePath,
    adminLoginPath,
    adminLogoutPath,
    adminApiBasePath,
    adminWsPath,
  };
}

module.exports = {
  DEFAULT_CONTROL_ROOT,
  LEGACY_TUNNEL_WS_PATH,
  stripPort,
  normalizeDomain,
  normalizeControlRoot,
  isValidControlRoot,
  isValidDomain,
  normalizePublishDomains,
  isExactHost,
  extractSingleSubdomain,
  buildHttpHost,
  matchManagedHttpHost,
  getTunnelHttpOrigin,
  getTcpAddress,
  getAdminOrigin,
  buildRuntimeRoutes,
};
