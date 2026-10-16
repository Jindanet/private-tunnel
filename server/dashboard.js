const http = require('node:http');
const { buildNginxConfig } = require('./nginx');
const { loginStyles, dashboardStyles, gettingStartedMarkup, dashboardBehavior, brandMark } = require('./dashboard-ui');
const { clientKeysPanel, clientKeysBehavior } = require('./client-keys-ui');
const { sendControl } = require('../shared/protocol');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { serializeInlineJson, clientIp, isAdminHost, isSameOriginMutation, isLoopback, createAttemptLimiter, validateNewPassword, isValidTunnelToken } = require('./security');
const {
  verifyPassword,
  setDashboardPassword,
  getAllClients,
  getRecentLogs,
  getTotalRequestCount,
  prepareServerSettings,
  updateServerSettings,
  getBootstrapPasswordFilePath,
  isUsingLegacyPasswordHash,
} = require('./db');
const {
  buildRuntimeRoutes,
  getAdminOrigin,
  getTcpAddress,
  getTunnelHttpOrigin,
} = require('./routing');

const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;
const MAX_BODY = 128 * 1024;
const JSON_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};
const HTML_SECURITY_HEADERS = {
  ...JSON_SECURITY_HEADERS,
  'Content-Security-Policy': [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    "script-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function createSession() {
  for (const [key, session] of sessions) if (Date.now() - session.created > SESSION_TTL) sessions.delete(key);
  if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { created: Date.now() });
  return token;
}

function isValidSession(token) {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const item of cookies) {
    const [key, value] = item.trim().split('=');
    if (key === name) return value;
  }
  return null;
}

function isAuthenticated(req) {
  return isValidSession(getCookie(req, 'session'));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        resolve('');
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', () => resolve(''));
  });
}

async function parseJsonBody(req) {
  const raw = await parseBody(req);
  if (!raw) throw new Error('A JSON object body is required (maximum 128 KiB).');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON object');
    return value;
  } catch {
    throw new Error('A valid JSON object body is required.');
  }
}

function redirect(res, location) {
  res.writeHead(302, { ...JSON_SECURITY_HEADERS, Location: location });
  res.end();
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...JSON_SECURITY_HEADERS,
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, render) {
  const nonce = crypto.randomBytes(24).toString('base64');
  res.writeHead(200, {
    ...HTML_SECURITY_HEADERS,
    'Content-Security-Policy': HTML_SECURITY_HEADERS['Content-Security-Policy'].replace("script-src 'none'", `script-src 'nonce-${nonce}'`),
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(render(nonce));
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return (isLoopback(req.socket.remoteAddress) && forwardedProto === 'https') || !!req.socket.encrypted;
}

function buildSessionCookie(token, maxAge, req) {
  const parts = [
    `session=${token || ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Number(maxAge) || 0)}`,
  ];

  if (isSecureRequest(req)) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(1)} GB`;
}

async function buildWarnings(runtimeConfig) {
  const warnings = [];
  const publishDomains = Array.isArray(runtimeConfig.publishDomains) ? runtimeConfig.publishDomains : [];

  if (!runtimeConfig.primaryDomain) {
    warnings.push('Primary domain is not configured yet. Set it before sharing the admin UI or client WebSocket endpoint.');
  }

  if (!runtimeConfig.controlRoot) {
    warnings.push('Control namespace is empty. Use a dedicated path such as /_private-tunnel.');
  }

  if (!publishDomains.length) {
    warnings.push('No publish domains are configured yet. Clients cannot receive public URLs until you add at least one domain.');
  }

  if (!runtimeConfig.tunnelToken && process.env.ALLOW_UNAUTHENTICATED_TUNNELS === 'true') {
    warnings.push('Tunnel token is empty. Any client that knows your WebSocket URL can open tunnels.');
  } else if (!isValidTunnelToken(runtimeConfig.tunnelToken)) {
    warnings.push('Tunnel connections are disabled. Replace the access key with a randomly generated key of 32–4096 visible ASCII characters without spaces, then update saved client profiles.');
  }
  if (runtimeConfig.tunnelAuthenticationDisabled) {
    warnings.push('Tunnel connections are paused because the current access key could not be verified from the primary database. Restore database access and save Settings again.');
  }

  if (runtimeConfig.bootstrapPasswordFile) {
    warnings.push(`A bootstrap admin password is still available on disk at ${runtimeConfig.bootstrapPasswordFile}. Rotate it after your first successful login.`);
  }

  if (await isUsingLegacyPasswordHash()) {
    warnings.push('This installation uses a legacy password hash. Sign in to upgrade its storage, then rotate the admin password.');
  }

  if (!publishDomains.some((entry) => entry.allowSubdomain)) {
    warnings.push('No publish domain currently allows random subdomains. HTTP clients must explicitly choose a root domain, and only root-enabled domains will work.');
  }

  if (publishDomains.some((entry) => entry.domain === runtimeConfig.primaryDomain && entry.allowRoot)) {
    warnings.push('The primary domain root is reserved for the control plane. Root publishing on the primary domain has been disabled automatically.');
  }

  if (
    runtimeConfig.primaryDomain
    && publishDomains.some((entry) => entry.domain !== runtimeConfig.primaryDomain && !entry.domain.endsWith(`.${runtimeConfig.primaryDomain}`))
  ) {
    warnings.push('Some publish domains live outside the primary DNS zone. Make sure those extra domains also point to this server and have valid TLS certificates.');
  }

  return warnings;
}

function buildDnsSnippet(runtimeConfig) {
  const publishDomains = Array.isArray(runtimeConfig.publishDomains) ? runtimeConfig.publishDomains : [];
  const hosts = new Set();
  if (runtimeConfig.primaryDomain) hosts.add(runtimeConfig.primaryDomain);
  for (const entry of publishDomains) {
    hosts.add(entry.domain);
    if (entry.allowSubdomain) {
      hosts.add(`*.${entry.domain}`);
    }
  }

  if (!hosts.size) {
    return 'Set your primary domain and at least one publish domain first, then this panel will generate DNS records to copy.';
  }

  return [...hosts]
    .map((host) => `A     ${host.padEnd(30, ' ')} -> <your-server-ip>`)
    .join('\n');
}

function buildClientSnippet(runtimeConfig, routes) {
  const publishDomains = Array.isArray(runtimeConfig.publishDomains) ? runtimeConfig.publishDomains : [];
  const wsHost = runtimeConfig.primaryDomain || runtimeConfig.tunnelDomain || publishDomains[0]?.domain;
  if (!wsHost) {
    return 'Set a primary domain first. The client WebSocket URL will appear here automatically.';
  }

  const base = `wss://${wsHost}${routes.tunnelWsPath}`;
  const examples = [`ptunnel init --server ${base} --token YOUR_ACCESS_KEY`, ''];
  const defaultSubdomainDomain = publishDomains.find((entry) => entry.allowSubdomain)?.domain;
  const rootDomain = publishDomains.find((entry) => entry.allowRoot)?.domain;
  const tcpDomain = publishDomains[0]?.domain;

  if (defaultSubdomainDomain) {
    examples.push(`ptunnel http 3000 --domain ${defaultSubdomainDomain}`);
  } else {
    examples.push('ptunnel http 3000');
  }
  if (rootDomain) {
    examples.push(`ptunnel http 3000 --domain ${rootDomain} --root`);
  }
  if (tcpDomain) {
    examples.push(`ptunnel tcp 25565 --domain ${tcpDomain}`);
  }

  return examples.join('\n');
}

function buildNginxSnippet(runtimeConfig, routes, ports) {
  const publishDomains = Array.isArray(runtimeConfig.publishDomains) ? runtimeConfig.publishDomains : [];
  if (!runtimeConfig.primaryDomain && !publishDomains.length) {
    return 'Set your domains first. This panel will then generate the DNS, route summary, and nginx example you can copy into your own setup.';
  }

  const primaryDomain = runtimeConfig.primaryDomain || publishDomains[0]?.domain;
  const redirectHosts = new Set([primaryDomain].filter(Boolean));
  const tunnelEntries = [];

  for (const entry of publishDomains) {
    redirectHosts.add(entry.domain);
    if (entry.allowSubdomain) {
      const wildcard = `*.${entry.domain}`;
      redirectHosts.add(wildcard);
    }
    if (entry.domain !== primaryDomain) tunnelEntries.push(entry);
  }

  const adminServerNames = [primaryDomain].filter(Boolean);
  const summary = [
    '# Nginx Routing Summary',
    `Primary admin host: ${primaryDomain || 'example.com'}`,
    `Admin/dashboard route: ${routes.adminBasePath} -> 127.0.0.1:${ports.dashboardPort}`,
    `Client WebSocket route: ${routes.tunnelWsPath} -> 127.0.0.1:${ports.wsPort}`,
    `Legacy WebSocket route: ${routes.legacyTunnelWsPath} -> 127.0.0.1:${ports.wsPort}`,
    `Tunnel traffic route: / -> 127.0.0.1:${ports.proxyPort}`,
    `HTTP redirect hosts: ${[...redirectHosts].join(', ') || 'configure at least one domain'}`,
    `Admin TLS server_name: ${adminServerNames.join(', ') || 'example.com'}`,
  ];

  if (tunnelEntries.length) {
    summary.push(`Extra publish domains: ${tunnelEntries.map((entry) => entry.domain).join(', ')}`);
  }

  return summary.join('\n');
}

function buildNginxGuideSnippet(runtimeConfig, routes, ports) {
  return buildNginxConfig(runtimeConfig, routes, ports);
}

function serializeTunnel(tunnel, runtimeConfig) {
  const publicUrl = tunnel.publicUrl
    || (tunnel.tunnelType === 'tcp'
      ? getTcpAddress(tunnel.tcpPort, tunnel.publishDomain || runtimeConfig)
      : getTunnelHttpOrigin(tunnel.publicHost, runtimeConfig));

  return {
    subdomain: tunnel.label,
    publicHost: tunnel.publicHost || '',
    publishDomain: tunnel.publishDomain || '',
    publishMode: tunnel.publishMode || 'subdomain',
    tunnelType: tunnel.tunnelType,
    publicUrl,
    localPort: tunnel.localPort,
    tcpPort: tunnel.tcpPort || null,
    clientId: tunnel.clientId || null,
    clientIp: tunnel.clientIp || null,
    hostname: tunnel.hostname || null,
    os: tunnel.os || null,
    connectedAt: tunnel.connectedAt,
    connections: tunnel.stats.connections,
    bytesIn: tunnel.stats.bytesIn,
    bytesOut: tunnel.stats.bytesOut,
    pendingRequests: tunnel.pendingRequests.size,
    recentRequests: tunnel.requestLog.slice(0, 8),
  };
}

async function collectLiveData(tunnelManager, runtimeConfig) {
  const tunnels = [];
  let totalBytesIn = 0;
  let totalBytesOut = 0;
  let totalConnections = 0;

  const liveTunnels = typeof tunnelManager.getLiveTunnels === 'function'
    ? tunnelManager.getLiveTunnels()
    : [...tunnelManager.tunnels.values()];

  for (const tunnel of liveTunnels) {
    const record = serializeTunnel(tunnel, runtimeConfig);
    tunnels.push(record);
    totalBytesIn += record.bytesIn;
    totalBytesOut += record.bytesOut;
    totalConnections += record.connections;
  }

  tunnels.sort((left, right) => String(right.connectedAt).localeCompare(String(left.connectedAt)));

  return {
    tunnels,
    totals: {
      activeTunnels: tunnels.length,
      totalConnections,
      totalBytesIn,
      totalBytesOut,
      totalRequests: await getTotalRequestCount(),
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRss: process.memoryUsage().rss,
    },
  };
}

async function buildOverview(tunnelManager, runtimeConfig, routes, ports) {
  const live = await collectLiveData(tunnelManager, runtimeConfig);
  const adminOrigin = getAdminOrigin(runtimeConfig);
  const subdomainEntry = runtimeConfig.publishDomains?.find((entry) => entry.allowSubdomain);
  const rootEntry = runtimeConfig.publishDomains?.find((entry) => entry.allowRoot);

  return {
    settings: {
      primaryDomain: runtimeConfig.primaryDomain || '',
      controlRoot: runtimeConfig.controlRoot || '',
      tunnelDomain: runtimeConfig.tunnelDomain || '',
      publishDomains: Array.isArray(runtimeConfig.publishDomains) ? runtimeConfig.publishDomains : [],
      tunnelToken: runtimeConfig.tunnelToken || '',
      bootstrapPasswordFile: getBootstrapPasswordFilePath(),
    },
    routes,
    warnings: await buildWarnings(runtimeConfig),
    live,
    snippets: {
      adminUrl: adminOrigin ? `${adminOrigin}${routes.adminBasePath}` : '',
      websocketUrl: adminOrigin ? `wss://${runtimeConfig.primaryDomain}${routes.tunnelWsPath}` : '',
      legacyWebsocketUrl: adminOrigin ? `wss://${runtimeConfig.primaryDomain}${routes.legacyTunnelWsPath}` : '',
      tunnelPattern: subdomainEntry
        ? `https://{subdomain}.${subdomainEntry.domain}`
        : rootEntry
          ? `https://${rootEntry.domain} (root host)`
          : '',
      tcpPattern: runtimeConfig.publishDomains?.[0]?.domain ? `${runtimeConfig.publishDomains[0].domain}:{allocated-port}` : '',
      dns: buildDnsSnippet(runtimeConfig),
      client: buildClientSnippet(runtimeConfig, routes),
      nginx: buildNginxSnippet(runtimeConfig, routes, ports),
      nginxGuide: buildNginxGuideSnippet(runtimeConfig, routes, ports),
    },
    meta: {
      dashboardPort: ports.dashboardPort,
      proxyPort: ports.proxyPort,
      wsPort: ports.wsPort,
      bandwidthInLabel: formatBytes(live.totals.totalBytesIn),
      bandwidthOutLabel: formatBytes(live.totals.totalBytesOut),
      memoryLabel: formatBytes(live.totals.memoryRss),
    },
  };
}

function getLoginHTML(routes, error, nonce = '') {
  const i18n = {
    en: {
      documentTitle: 'Login - PrivateTunnel',
      overline: 'Server administration',
      title: 'Sign in to your server',
      subtitle: 'Manage shared apps, connected devices and server settings.',
      adminPath: 'Admin path',
      passwordLabel: 'Password',
      passwordPlaceholder: 'Enter your password',
      login: 'Login',
      hint: 'First time signing in? Use the password set by your server owner. If none was set, find admin-bootstrap.txt in the server data folder.',
      invalidPassword: 'Invalid password',
      langEnglish: 'English',
      langThai: 'Thai',
    },
    th: {
      documentTitle: 'เข้าสู่ระบบ - PrivateTunnel',
      overline: 'สำหรับผู้ดูแลเซิร์ฟเวอร์',
      title: 'เข้าสู่ระบบเซิร์ฟเวอร์',
      subtitle: 'จัดการแอปที่แชร์ อุปกรณ์ที่เชื่อมต่อ และการตั้งค่าเซิร์ฟเวอร์',
      adminPath: 'พาธแอดมิน',
      passwordLabel: 'รหัสผ่าน',
      passwordPlaceholder: 'กรอกรหัสผ่าน',
      login: 'เข้าสู่ระบบ',
      hint: 'เข้าใช้งานครั้งแรก ใช้รหัสผ่านที่ผู้ดูแลเซิร์ฟเวอร์ตั้งไว้ หากยังไม่ได้ตั้ง ให้ดูไฟล์ admin-bootstrap.txt ในโฟลเดอร์ข้อมูลของเซิร์ฟเวอร์',
      invalidPassword: 'รหัสผ่านไม่ถูกต้อง',
      langEnglish: 'English',
      langThai: 'ไทย',
    },
  };

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - PrivateTunnel</title>
<style>${loginStyles}</style></head><body>
<div class="shell">
  <div class="brand login-brand">${brandMark}<span>PrivateTunnel</span></div>
  <div class="topbar"><span class="login-admin-label" id="loginOverline"></span><div class="lang-switch" aria-label="Language"><button type="button" data-lang="en"></button><button type="button" data-lang="th"></button></div></div>
  <section class="hero"><h1 id="loginTitle"></h1><p id="loginSubtitle"></p><span class="path-chip" id="loginAdminPathLabel"></span></section>
  <section class="panel"><h2 id="formTitle"></h2><p class="panel-sub" id="formSubtitle"></p>
    <p id="loginError" role="alert" class="error${error ? '' : ' hidden'}">${escapeHtml(error || '')}</p>
    <form method="POST" action="${routes.adminLoginPath}"><label id="passwordLabel" for="passwordInput"></label><input id="passwordInput" type="password" name="password" autocomplete="current-password" required maxlength="1024" aria-describedby="loginError loginHint" autofocus><button class="cta" type="submit" id="loginButton"></button></form>
  </section>
  <p class="hint-card" id="loginHint"></p>
</div>
<script nonce="${nonce}">
const I18N=${serializeInlineJson(i18n)};
const ERROR_MESSAGE=${serializeInlineJson(error || '')};
const LANG_KEY='ptAdminLang';
let currentLang=localStorage.getItem(LANG_KEY)||((navigator.language||'').toLowerCase().startsWith('th')?'th':'en');
function t(key){return (I18N[currentLang]&&I18N[currentLang][key])||I18N.en[key]||key;}
function translateError(message){if(!message)return '';if(message==='Invalid password')return t('invalidPassword');return message;}
function updateLangButtons(){document.querySelectorAll('[data-lang]').forEach((button)=>{const lang=button.getAttribute('data-lang');button.classList.toggle('active',lang===currentLang);button.textContent=lang==='th'?t('langThai'):t('langEnglish');});}
function applyI18n(){document.title=t('documentTitle');document.documentElement.lang=currentLang;document.getElementById('loginOverline').textContent=t('overline');document.getElementById('loginTitle').textContent=t('title');document.getElementById('loginSubtitle').textContent=t('subtitle');document.getElementById('loginAdminPathLabel').textContent=t('adminPath');document.getElementById('loginHint').textContent=t('hint');document.getElementById('formTitle').textContent=t('subtitle');document.getElementById('formSubtitle').textContent=t('hint');document.getElementById('passwordLabel').textContent=t('passwordLabel');document.getElementById('passwordInput').placeholder=t('passwordPlaceholder');document.getElementById('loginButton').textContent=t('login');const errorNode=document.getElementById('loginError');if(ERROR_MESSAGE){errorNode.textContent=translateError(ERROR_MESSAGE);errorNode.classList.remove('hidden');}updateLangButtons();}
document.querySelectorAll('[data-lang]').forEach((button)=>button.addEventListener('click',()=>{currentLang=button.getAttribute('data-lang');localStorage.setItem(LANG_KEY,currentLang);applyI18n();}));
applyI18n();
</script>
</body></html>`;
}

function getDashboardHTML(routes, initialOverview, nonce = '') {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="color-scheme" content="dark"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PrivateTunnel Dashboard</title>
<style>${dashboardStyles}
</style></head><body>
<div class="app-shell">
<aside class="sidebar"><div class="brand">${brandMark}<span>PrivateTunnel</span></div><div class="nav-caption" data-i18n="navCaption">Workspace</div><nav class="tabs" aria-label="Main navigation"><button type="button" class="tab active" data-tab="tunnels" aria-current="page"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/></svg><span data-i18n="tabTunnels">Shared apps</span></button>
<button type="button" class="tab" data-tab="logs" aria-current="false"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h13"/></svg><span data-i18n="tabLogs">Activity</span></button>
<button type="button" class="tab" data-tab="clients" aria-current="false"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg><span data-i18n="tabClients">Devices</span></button>
<button type="button" class="tab" data-tab="settings" aria-current="false"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/></svg><span data-i18n="tabSettings">Settings</span></button>
<button type="button" class="tab" data-tab="guide" aria-current="false"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/></svg><span data-i18n="tabGuide">Setup guide</span></button></nav><div class="sidebar-footer"><p><strong>PrivateTunnel</strong><br><span data-i18n="serverCaption">Self-hosted server</span></p></div></aside>
<main class="workspace">
<header class="header"><div><p class="eyebrow" data-i18n="workspaceLabel">SERVER MANAGEMENT</p><h1 id="workspaceTitle" data-i18n="workspaceTitle">Overview</h1><p class="subtitle"><span class="dot" aria-hidden="true"></span><span id="serverLabel">loading...</span><span class="mini" id="wsLabel"></span></p></div><div class="header-actions"><div class="lang-switch" aria-label="Language"><button type="button" data-lang="en"></button><button type="button" data-lang="th"></button></div><a href="${routes.adminLogoutPath}" class="logout" data-i18n="logout">Sign out</a></div></header>
${gettingStartedMarkup}
<div class="stats" aria-label="Server activity">
<div class="stat"><div class="label" data-i18n="statActiveTunnels">Apps sharing</div><div class="val" id="sTunnels">0</div></div>
<div class="stat"><div class="label" data-i18n="statTotalRequests">Logged requests</div><div class="val" id="sRequests">0</div></div>
<div class="stat"><div class="label" data-i18n="statBandwidthIn">Received</div><div class="val" id="sBytesIn">0</div></div>
<div class="stat"><div class="label" data-i18n="statBandwidthOut">Sent</div><div class="val" id="sBytesOut">0</div></div>
<div class="stat"><div class="label" data-i18n="statUptime">Uptime</div><div class="val" id="sUptime">-</div></div>
</div>
<div class="panel active" id="pTunnels"><div class="panel-head"><div><h2 data-i18n="tabTunnels">Active Tunnels</h2><div class="sub" data-i18n="tunnelsNote">Optimized for scanning active tunnels quickly, even when many clients are online.</div></div><div class="panel-meta" id="tunnelMeta"></div></div><div class="panel-pad"><div class="toolbar"><div class="toolbar-main"><input id="tunnelSearch" class="search" data-i18n-placeholder="searchTunnels" placeholder="Search active tunnels"><select id="tunnelPageSize" class="select"><option>25</option><option>50</option><option>100</option></select></div><div class="toolbar-side"><span class="range-label" id="tunnelRange"></span><div class="pager"><button type="button" id="tunnelPrev" data-i18n="prev">Prev</button><span class="page-label" id="tunnelPage"></span><button type="button" id="tunnelNext" data-i18n="next">Next</button></div></div></div></div><div class="table-wrap"><table><thead><tr><th data-i18n="colPublicHost">Public Host</th><th data-i18n="colClientIp">Client IP</th><th data-i18n="colHostname">Hostname</th><th data-i18n="colOs">OS</th><th data-i18n="colPort">Port</th><th data-i18n="colRequests">Reqs</th><th data-i18n="colBandwidth">Bytes In/Out</th><th data-i18n="colConnected">Connected</th></tr></thead><tbody id="tTunnels"><tr><td colspan="8" class="empty">No active tunnels</td></tr></tbody></table></div></div>
<div class="panel" id="pLogs"><div class="panel-head"><div><h2 data-i18n="tabLogs">Request Logs</h2><div class="sub" data-i18n="logsNote">Searchable, paginated recent traffic view for high-volume hosts.</div></div><div class="panel-meta" id="logMeta"></div></div><div class="panel-pad"><div class="toolbar"><div class="toolbar-main"><input id="logSearch" class="search" data-i18n-placeholder="searchLogs" placeholder="Search request logs"><select id="logPageSize" class="select"><option>25</option><option>50</option><option>100</option></select></div><div class="toolbar-side"><span class="range-label" id="logRange"></span><div class="pager"><button type="button" id="logPrev" data-i18n="prev">Prev</button><span class="page-label" id="logPage"></span><button type="button" id="logNext" data-i18n="next">Next</button></div></div></div></div><div class="table-wrap"><table><thead><tr><th data-i18n="colTime">Time</th><th data-i18n="colHost">Host</th><th data-i18n="colVisitorIp">Visitor IP</th><th data-i18n="colMethod">Method</th><th data-i18n="colPath">Path</th><th data-i18n="colStatus">Status</th><th data-i18n="colLatency">Latency</th><th data-i18n="colUserAgent">User-Agent</th></tr></thead><tbody id="tLogs"><tr><td colspan="8" class="empty">No requests yet</td></tr></tbody></table></div></div>
<div class="panel" id="pClients"><div class="panel-head"><div><h2 data-i18n="tabClients">All Clients</h2><div class="sub" data-i18n="clientsNote">Review assigned hosts, publish modes, and client metadata without rendering every row at once.</div></div><div class="panel-meta" id="clientMeta"></div></div><div class="panel-pad"><div class="toolbar"><div class="toolbar-main"><input id="clientSearch" class="search" data-i18n-placeholder="searchClients" placeholder="Search clients"><select id="clientPageSize" class="select"><option>25</option><option>50</option><option>100</option></select></div><div class="toolbar-side"><span class="range-label" id="clientRange"></span><div class="pager"><button type="button" id="clientPrev" data-i18n="prev">Prev</button><span class="page-label" id="clientPage"></span><button type="button" id="clientNext" data-i18n="next">Next</button></div></div></div></div><div class="table-wrap"><table><thead><tr><th data-i18n="colClientId">Client ID</th><th data-i18n="colPublicHost">Public Host</th><th data-i18n="colDomain">Domain</th><th data-i18n="colMode">Mode</th><th data-i18n="colLabel">Label</th><th data-i18n="colIp">IP</th><th data-i18n="colHostname">Hostname</th><th data-i18n="colOs">OS</th><th data-i18n="colLastSeen">Last Seen</th></tr></thead><tbody id="tClients"><tr><td colspan="9" class="empty">No clients</td></tr></tbody></table></div></div>
<section class="panel" id="pSettings"><div class="panel-head"><div><h2 data-i18n="tabSettings">Settings</h2><p class="sub" data-i18n="settingsNote"></p></div></div>
<div class="split"><div class="grid">${clientKeysPanel}<section class="box"><h2 data-i18n="boxServerSettings">Connection settings</h2><p class="settings-form-note" data-i18n="settingsFormNote"></p>
<form id="settingsForm"><div class="form-grid">
<div class="field"><label for="primary-domain" data-i18n="fieldPrimaryDomain">Server domain</label><input id="primary-domain" data-i18n-placeholder="placeholderPrimaryDomain" placeholder="server.example.com" autocomplete="off" spellcheck="false"></div>
<details class="field"><summary data-i18n="legacySharedAccess">Advanced: shared-key compatibility</summary><label for="tunnel-token" data-i18n="fieldTunnelToken">Legacy shared key</label><div class="input-row"><input type="password" autocomplete="off" id="tunnel-token" data-i18n-placeholder="placeholderTunnelToken"><button type="button" class="btn secondary" id="toggleAccessKey" aria-pressed="false" aria-controls="tunnel-token">Show</button></div><small data-i18n="legacySharedHint">Unused by default. Enable shared-key compatibility on the server only for migration.</small></details>
<div class="field"><label data-i18n="fieldPublishDomains">Domains for shared apps</label><div id="publishList" class="publish-list"></div><small data-i18n="publishDomainsHelp"></small><div class="actions"><button id="addPublishDomain" class="btn secondary" type="button" data-i18n="addPublishDomain">Add domain</button></div></div>
<details class="field"><summary data-i18n="advancedRouting">Advanced routing</summary><label for="control-root" data-i18n="fieldControlRoot">Reserved control path</label><input id="control-root" data-i18n-placeholder="placeholderControlRoot" placeholder="/_private-tunnel" spellcheck="false"></details>
</div><div class="actions"><button class="btn primary" id="saveBtn" type="submit" data-i18n="saveSettings">Save changes</button><span class="status" id="settingsStatus" role="status" aria-live="polite"></span></div></form></section>
<section class="box password-section"><h2 data-i18n="boxAdminPassword">Administrator password</h2><form id="passwordForm"><div class="field"><label for="admin-password" data-i18n="fieldNewPassword">New password</label><input id="admin-password" type="password" autocomplete="new-password" data-i18n-placeholder="placeholderPassword" placeholder="At least 10 characters"><small data-i18n="passwordHelp"></small></div><div class="actions"><button class="btn danger" type="submit" data-i18n="rotatePassword">Change password</button><span class="status" id="passwordStatus" role="status" aria-live="polite"></span></div></form></section></div>
<aside class="settings-aside"><section class="box"><h2 data-i18n="boxWarnings">Server checks</h2><div id="warnings"></div></section><details class="reference-details"><summary data-i18n="referenceToggle">Show addresses &amp; CLI commands</summary><div class="reference-content"><p class="sub" data-i18n="snippetsSub"></p><div><div class="sub" data-i18n="snippetAdminUrl"></div><code id="snippetAdminUrl">-</code></div><div><div class="sub" data-i18n="snippetClientWs"></div><code id="snippetWsUrl">-</code></div><div><div class="sub" data-i18n="snippetLegacyWs"></div><code id="snippetLegacyWsUrl">-</code></div><div><div class="sub" data-i18n="snippetTunnelPattern"></div><code id="snippetTunnelPattern">-</code></div><div><div class="sub" data-i18n="snippetClientCommands"></div><pre id="snippetClient">-</pre></div><div><div class="sub" data-i18n="snippetDnsRecords"></div><pre id="snippetDns">-</pre></div><div><div class="sub" data-i18n="snippetNginxSummary"></div><pre id="snippetNginx">-</pre></div></div></details></aside></div></section>
<div class="panel" id="pGuide"><div class="panel-head"><div><h2 data-i18n="guideTitle">Setup Guide</h2><div class="sub" data-i18n="guideNote">Separate operational guide for nginx, DNS, SSL, and publishing modes.</div></div></div><div class="panel-pad"><div class="summary-cards"><div class="summary-card"><span class="k" data-i18n="snippetAdminUrl">Admin URL</span><div class="v" id="guideAdminUrl">-</div></div><div class="summary-card"><span class="k" data-i18n="snippetClientWs">Client WebSocket</span><div class="v" id="guideWsUrl">-</div></div><div class="summary-card"><span class="k" data-i18n="snippetTunnelPattern">Tunnel Pattern</span><div class="v" id="guideTunnelPattern">-</div></div></div><div class="guide-grid"><div class="box"><h2 data-i18n="snippetDnsRecords">DNS Records</h2><pre id="guideDns">-</pre></div><div class="box"><h2 data-i18n="snippetClientCommands">Client Commands</h2><pre id="guideClient">-</pre></div><div class="box full"><h2 data-i18n="snippetNginxSummary">Nginx Routing Summary</h2><pre id="guideRouting">-</pre></div><div class="box full"><h2 data-i18n="guideFullTitle">Bilingual Nginx Setup Guide</h2><pre id="nginxPreview" data-i18n="loadingGuide">Nginx setup guide will appear here.</pre></div></div></div></div>
</main></div>
<script nonce="${nonce}">
const ROUTES=${serializeInlineJson(routes)};
const INITIAL_OVERVIEW=${serializeInlineJson(initialOverview || null)};
const I18N={
  en:{
    appName:'PrivateTunnel',
    dashboardTitle:'PrivateTunnel Dashboard',
    heroPrefix:'Server dashboard on',
    adminPath:'Admin path',
    clientWs:'Client WS',
    logout:'Logout',
    langEnglish:'English',
    langThai:'Thai',
    statActiveTunnels:'Active Tunnels',
    statTotalRequests:'Total Requests',
    statBandwidthIn:'Bandwidth In',
    statBandwidthOut:'Bandwidth Out',
    statUptime:'Uptime',
    tabTunnels:'Active Tunnels',
    tabLogs:'Request Logs',
    tabClients:'All Clients',
    tabSettings:'Server Settings',
    tabGuide:'Setup Guide',
    tunnelsNote:'Optimized for scanning active tunnels quickly, even when many clients are online.',
    logsNote:'Searchable, paginated recent traffic view for high-volume hosts.',
    clientsNote:'Review assigned hosts, publish modes, and client metadata without rendering every row at once.',
    settingsNote:'Server-side management for hosters: domains, control route, token, and publish behavior.',
    guideTitle:'Setup Guide',
    guideNote:'Separate operational guide for nginx, DNS, SSL, and publishing modes.',
    guideFullTitle:'Bilingual Nginx Setup Guide',
    snippetsSub:'Generated from current server settings.',
    fieldPrimaryDomain:'Primary Domain',
    fieldControlRoot:'Control Root',
    fieldTunnelToken:'Tunnel Token',
    fieldPublishDomains:'Publish Domains',
    fieldNewPassword:'New Password',
    addPublishDomain:'Add Publish Domain',
    publishDomainsHelp:'Add or remove domains freely. Each domain can publish random subdomains, exact root host, or both.',
    saveSettings:'Save Settings',
    saving:'Saving...',
    boxWarnings:'Warnings',
    boxSnippets:'Quick Snippets',
    boxServerSettings:'Server Settings',
    boxAdminPassword:'Admin Password',
    passwordHelp:'Stored as a hash. Rotate the bootstrap password after first login.',
    rotatePassword:'Rotate Admin Password',
    passwordUnique:'Use a unique password for the hoster account.',
    passwordRotated:'Admin password rotated successfully.',
    snippetAdminUrl:'Admin URL',
    snippetClientWs:'Client WebSocket',
    snippetLegacyWs:'Legacy WebSocket',
    snippetTunnelPattern:'Tunnel Pattern',
    snippetClientCommands:'Client Commands',
    snippetDnsRecords:'DNS Records',
    snippetNginxSummary:'Nginx Routing Summary',
    searchTunnels:'Search active tunnels',
    searchLogs:'Search request logs',
    searchClients:'Search clients',
    prev:'Prev',
    next:'Next',
    pageSize:'Rows',
    colPublicHost:'Public Host',
    colClientIp:'Client IP',
    colHostname:'Hostname',
    colOs:'OS',
    colPort:'Port',
    colRequests:'Reqs',
    colBandwidth:'Bytes In/Out',
    colConnected:'Connected',
    colTime:'Time',
    colHost:'Host',
    colVisitorIp:'Visitor IP',
    colMethod:'Method',
    colPath:'Path',
    colStatus:'Status',
    colLatency:'Latency',
    colUserAgent:'User-Agent',
    colClientId:'Client ID',
    colDomain:'Domain',
    colMode:'Mode',
    colLabel:'Label',
    colIp:'IP',
    colLastSeen:'Last Seen',
    loading:'loading...',
    waitingConfig:'Waiting for configuration...',
    notConfigured:'Not configured yet',
    settingsStored:'Settings are stored in the primary database.',
    settingsSaved:'Settings saved.',
    warningHealthy:'Everything looks healthy.',
    noActiveTunnels:'No active tunnels',
    noRequests:'No requests yet',
    noClients:'No clients',
    loadedRows:'Loaded {count}',
    showingRows:'Showing {from}-{to} of {total}',
    showingRowsEmpty:'Showing 0 of 0',
    pageStatus:'Page {page}/{total}',
    dashboardError:'Dashboard error',
    failedLoad:'Failed to load dashboard',
    sessionExpired:'Session expired. Redirecting to login...',
    requestFailed:'Request failed',
    remove:'Remove',
    randomSubdomains:'Random subdomains',
    exactRootHost:'Exact root domain',
placeholderPrimaryDomain:'ex.example.com',
    placeholderControlRoot:'/_private-tunnel',
    placeholderTunnelToken:'Recommended',
    placeholderPassword:'At least 10 characters',
    loadingGuide:'Nginx setup guide will appear here.',
    uptimeHours:'h',
    uptimeMinutes:'m'
  },
  th:{
    appName:'PrivateTunnel',
    dashboardTitle:'แดชบอร์ด PrivateTunnel',
    heroPrefix:'แดชบอร์ดเซิร์ฟเวอร์ของ',
    adminPath:'พาธแอดมิน',
    clientWs:'Client WS',
    logout:'ออกจากระบบ',
    langEnglish:'English',
    langThai:'ไทย',
    statActiveTunnels:'ท่อที่ออนไลน์',
    statTotalRequests:'คำขอทั้งหมด',
    statBandwidthIn:'ทราฟฟิกเข้า',
    statBandwidthOut:'ทราฟฟิกออก',
    statUptime:'เวลาออนไลน์',
    tabTunnels:'ท่อที่ออนไลน์',
    tabLogs:'บันทึกคำขอ',
    tabClients:'ไคลเอนต์ทั้งหมด',
    tabSettings:'ตั้งค่าเซิร์ฟเวอร์',
    tabGuide:'คู่มือตั้งค่า',
    tunnelsNote:'ออกแบบให้ไล่ดู active tunnels ได้เร็ว แม้มีหลาย client ออนไลน์พร้อมกัน',
    logsNote:'มุมมอง recent traffic แบบค้นหาและแบ่งหน้า รองรับโฮสต์ที่มีข้อมูลจำนวนมาก',
    clientsNote:'ตรวจ assigned host, publish mode และข้อมูลเครื่องลูกข่าย โดยไม่ต้อง render ทุกแถวพร้อมกัน',
    settingsNote:'หน้าจัดการสำหรับผู้ดูแลโฮสต์: โดเมน, control route, token และรูปแบบการ publish',
    guideTitle:'คู่มือตั้งค่า',
    guideNote:'พื้นที่แยกสำหรับคู่มือ nginx, DNS, SSL และรูปแบบการ publish',
    guideFullTitle:'คู่มือตั้งค่า Nginx แบบสองภาษา',
    snippetsSub:'สร้างจากค่าปัจจุบันของเซิร์ฟเวอร์',
    fieldPrimaryDomain:'Primary Domain',
    fieldControlRoot:'Control Root',
    fieldTunnelToken:'Tunnel Token',
    fieldPublishDomains:'Publish Domains',
    fieldNewPassword:'รหัสผ่านใหม่',
    addPublishDomain:'เพิ่ม Publish Domain',
    publishDomainsHelp:'เพิ่มหรือลบโดเมนได้อิสระ แต่ละโดเมนเปิด random subdomain, exact root host หรือทั้งสองแบบได้',
    saveSettings:'บันทึกการตั้งค่า',
    saving:'กำลังบันทึก...',
    boxWarnings:'คำเตือน',
    boxSnippets:'ชุดคำสั่งสั้น',
    boxServerSettings:'ตั้งค่าเซิร์ฟเวอร์',
    boxAdminPassword:'รหัสผ่านแอดมิน',
    passwordHelp:'เก็บเป็น hash ควรเปลี่ยน bootstrap password หลังล็อกอินครั้งแรก',
    rotatePassword:'เปลี่ยนรหัสผ่านแอดมิน',
    passwordUnique:'ควรใช้รหัสผ่านเฉพาะสำหรับบัญชีผู้ดูแลโฮสต์',
    passwordRotated:'เปลี่ยนรหัสผ่านแอดมินเรียบร้อยแล้ว',
    snippetAdminUrl:'Admin URL',
    snippetClientWs:'Client WebSocket',
    snippetLegacyWs:'Legacy WebSocket',
    snippetTunnelPattern:'รูปแบบโดเมนท่อ',
    snippetClientCommands:'คำสั่งสำหรับ Client',
    snippetDnsRecords:'DNS Records',
    snippetNginxSummary:'สรุปเส้นทาง Nginx',
    searchTunnels:'ค้นหา active tunnels',
    searchLogs:'ค้นหา request logs',
    searchClients:'ค้นหา clients',
    prev:'ก่อนหน้า',
    next:'ถัดไป',
    pageSize:'จำนวนแถว',
    colPublicHost:'Public Host',
    colClientIp:'IP ของ Client',
    colHostname:'Hostname',
    colOs:'OS',
    colPort:'พอร์ต',
    colRequests:'คำขอ',
    colBandwidth:'Bytes เข้า/ออก',
    colConnected:'เวลาเชื่อมต่อ',
    colTime:'เวลา',
    colHost:'Host',
    colVisitorIp:'IP ผู้เยี่ยมชม',
    colMethod:'Method',
    colPath:'Path',
    colStatus:'สถานะ',
    colLatency:'เวลา',
    colUserAgent:'User-Agent',
    colClientId:'Client ID',
    colDomain:'โดเมน',
    colMode:'โหมด',
    colLabel:'Label',
    colIp:'IP',
    colLastSeen:'ล่าสุดที่เห็น',
    loading:'กำลังโหลด...',
    waitingConfig:'รอการตั้งค่า...',
    notConfigured:'ยังไม่ได้ตั้งค่า',
    settingsStored:'การตั้งค่าถูกเก็บไว้ในฐานข้อมูลหลัก',
    settingsSaved:'บันทึกการตั้งค่าแล้ว',
    warningHealthy:'ทุกอย่างดูปกติดี',
    noActiveTunnels:'ยังไม่มี active tunnels',
    noRequests:'ยังไม่มีคำขอ',
    noClients:'ยังไม่มี client',
    loadedRows:'โหลดแล้ว {count}',
    showingRows:'แสดง {from}-{to} จาก {total}',
    showingRowsEmpty:'แสดง 0 จาก 0',
    pageStatus:'หน้า {page}/{total}',
    dashboardError:'แดชบอร์ดมีปัญหา',
    failedLoad:'โหลดแดชบอร์ดไม่สำเร็จ',
    sessionExpired:'session หมดอายุ กำลังพาไปหน้า login...',
    requestFailed:'คำขอล้มเหลว',
    remove:'ลบ',
    randomSubdomains:'สุ่ม subdomain',
    exactRootHost:'ใช้ root domain ตรง ๆ',
placeholderPrimaryDomain:'ex.example.com',
    placeholderControlRoot:'/_private-tunnel',
    placeholderTunnelToken:'แนะนำให้ตั้งค่า',
    placeholderPassword:'อย่างน้อย 10 ตัวอักษร',
    loadingGuide:'คู่มือตั้งค่า Nginx จะแสดงที่นี่',
    uptimeHours:'ชม.',
    uptimeMinutes:'นาที'
  }
};
const LANG_KEY='ptAdminLang';
const LOCALE_MAP={en:'en-US',th:'th-TH'};
let currentRoutes=Object.assign({}, ROUTES);
let overview=INITIAL_OVERVIEW || null;
let tunnelData=(overview&&overview.live&&overview.live.tunnels)||[];
let logsData=[];
let clientsData=[];
let uptimeSeconds=(overview&&overview.live&&overview.live.totals&&overview.live.totals.uptimeSeconds)||0;
let currentLang=localStorage.getItem(LANG_KEY)||((navigator.language||'').toLowerCase().startsWith('th')?'th':'en');
const tableState={tunnel:{page:1,pageSize:25},log:{page:1,pageSize:25},client:{page:1,pageSize:25}};
function el(id){return document.getElementById(id);}function create(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=String(text);return node;}function t(key,vars){let value=(I18N[currentLang]&&I18N[currentLang][key])||I18N.en[key]||key;if(!vars)return value;Object.keys(vars).forEach((name)=>{value=value.replace(new RegExp('\\{' + name + '\\}','g'),String(vars[name]));});return value;}function fmtBytes(value){const b=Number(value)||0;if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(1)+' GB';}function fmtTime(value){if(!value)return '-';return new Date(value).toLocaleString(LOCALE_MAP[currentLang]||'en-US');}function statusClass(status){const s=Number(status)||0;if(s>=500)return's5';if(s>=400)return's4';if(s>=300)return's3';return's2';}function clean(value){return String(value||'').trim();}function normalizeDomain(value){return clean(value).toLowerCase().replace(/^[a-z]+:\\/\\//,'').split('/')[0].replace(/:\\d+$/,'').replace(/\\.+$/,'');}function normalizeControlRoot(value){let next=clean(value).toLowerCase();if(!next)return'';if(!next.startsWith('/'))next='/'+next;next=next.replace(/\\/+/g,'/');if(next.length>1&&next.endsWith('/'))next=next.slice(0,-1);return /^\\/[a-z0-9/_-]+$/.test(next)?next:'';}function queryMatch(query,values){if(!query)return true;return values.filter(Boolean).join(' ').toLowerCase().includes(query);}function setText(id,value,fallback){const target=el(id);if(!target)return;const next=value==null||value===''?(fallback==null?'-':fallback):value;target.textContent=String(next);}function rememberMessage(id,key,text){const target=el(id);if(!target)return;if(key){target.dataset.messageKey=key;delete target.dataset.messageText;target.textContent=t(key);return;}delete target.dataset.messageKey;target.dataset.messageText=String(text||'');target.textContent=translateRuntimeText(text);}function refreshRememberedMessage(id,fallbackKey){const target=el(id);if(!target)return;if(target.dataset.messageKey){target.textContent=t(target.dataset.messageKey);return;}if(target.dataset.messageText){target.textContent=translateRuntimeText(target.dataset.messageText);return;}target.textContent=t(fallbackKey);}function translateRuntimeText(message){const text=String(message||'');if(!text)return '';if(currentLang!=='th')return text;if(text==='Invalid password')return 'รหัสผ่านไม่ถูกต้อง';if(text==='Unauthorized')return 'ยังไม่ได้รับอนุญาต';if(text==='Not found')return 'ไม่พบเส้นทางที่ร้องขอ';if(text==='Database has not been initialized yet')return 'ฐานข้อมูลยังไม่พร้อมใช้งาน';if(text==='Admin password must be at least 10 characters long')return 'รหัสผ่านแอดมินต้องยาวอย่างน้อย 10 ตัวอักษร';if(text==='Primary domain must be a valid hostname')return 'Primary domain ต้องเป็น hostname ที่ถูกต้อง';if(text==='Control namespace must be a safe path like /_private-tunnel')return 'Control namespace ต้องเป็น path ที่ปลอดภัย เช่น /_private-tunnel';if(text==='Publish domains must be an array')return 'Publish domains ต้องเป็นรายการแบบ array';if(text==='Tunnel domain must be a valid hostname')return 'Tunnel domain ต้องเป็น hostname ที่ถูกต้อง';if(text==='Primary domain is not configured yet. Set it before sharing the admin UI or client WebSocket endpoint.')return 'ยังไม่ได้ตั้งค่า Primary domain ควรกำหนดก่อนแชร์หน้าแอดมินหรือ WebSocket สำหรับ client';if(text==='Control namespace is empty. Use a dedicated path such as /_private-tunnel.')return 'Control namespace ยังว่างอยู่ ควรใช้ path เฉพาะ เช่น /_private-tunnel';if(text==='No publish domains are configured yet. Clients cannot receive public URLs until you add at least one domain.')return 'ยังไม่มี publish domains ดังนั้น client จะยังไม่ได้ public URL จนกว่าจะเพิ่มอย่างน้อยหนึ่งโดเมน';if(text==='Tunnel token is empty. Any client that knows your WebSocket URL can open tunnels.')return 'Tunnel token ยังว่างอยู่ หากใครรู้ WebSocket URL ก็อาจเปิด tunnel ได้';if(text==='Tunnel token is still using the example placeholder value. Replace it with a real secret and update saved client configs.')return 'Tunnel token ยังใช้ค่า placeholder ตัวอย่างอยู่ ควรเปลี่ยนเป็น secret จริงและอัปเดต config ของ client ที่บันทึกไว้';if(text==='This installation is still using the old default admin password from previous versions. Rotate it immediately from the Admin Password panel.')return 'ระบบนี้ยังใช้รหัสผ่านแอดมินค่าเริ่มต้นจากเวอร์ชันเก่า ควรเปลี่ยนทันทีในส่วน Admin Password';if(text==='No publish domain currently allows random subdomains. HTTP clients must explicitly choose a root domain, and only root-enabled domains will work.')return 'ตอนนี้ยังไม่มี publish domain ที่อนุญาต random subdomain ดังนั้น HTTP client ต้องเลือก root domain แบบชัดเจน และใช้ได้เฉพาะโดเมนที่เปิด root mode';if(text==='The primary domain root is reserved for the control plane. Root publishing on the primary domain has been disabled automatically.')return 'root ของ primary domain ถูกสงวนไว้ให้ control plane แล้ว ระบบจึงปิด root publishing บนโดเมนหลักให้อัตโนมัติ';if(text==='Some publish domains live outside the primary DNS zone. Make sure those extra domains also point to this server and have valid TLS certificates.')return 'มีบาง publish domains อยู่คนนอก primary DNS zone กรุณาตรวจว่าโดเมนเหล่านั้นชี้มาที่เซิร์ฟเวอร์นี้และมี TLS certificate ที่ใช้งานได้';if(text==='Set your primary domain and at least one publish domain first, then this panel will generate DNS records to copy.')return 'ตั้งค่า primary domain และเพิ่มอย่างน้อยหนึ่ง publish domain ก่อน แล้วแผงนี้จะสร้าง DNS records ให้คัดลอกได้';if(text==='Set a primary domain first. The client WebSocket URL will appear here automatically.')return 'ตั้งค่า primary domain ก่อน แล้ว URL ของ Client WebSocket จะปรากฏตรงนี้อัตโนมัติ';const bootstrapPrefix='A bootstrap admin password is still available on disk at ';const bootstrapSuffix='. Rotate it after your first successful login.';if(text.startsWith(bootstrapPrefix)&&text.endsWith(bootstrapSuffix)){const filePath=text.slice(bootstrapPrefix.length,text.length-bootstrapSuffix.length);return 'ยังมี bootstrap admin password เก็บอยู่บนดิสก์ที่ ' + filePath + ' ควรเปลี่ยนรหัสผ่านหลังล็อกอินสำเร็จครั้งแรก';}if(/ is required$/.test(text)){return text.replace(/ is required$/,' จำเป็นต้องกรอก');}if(/ contains invalid characters$/.test(text)){return text.replace(/ contains invalid characters$/,' มีอักขระที่ไม่ปลอดภัย');}return text;}function applyI18n(){document.documentElement.lang=currentLang;document.title=t('dashboardTitle');document.querySelectorAll('[data-i18n]').forEach((node)=>{node.textContent=t(node.getAttribute('data-i18n'));});document.querySelectorAll('[data-i18n-placeholder]').forEach((node)=>{node.placeholder=t(node.getAttribute('data-i18n-placeholder'));});document.querySelectorAll('[data-lang]').forEach((button)=>{const lang=button.getAttribute('data-lang');button.classList.toggle('active',lang===currentLang);button.textContent=lang==='th'?t('langThai'):t('langEnglish');});}function updateUptime(){const seconds=Math.max(0,Number(uptimeSeconds)||0);const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60);setText('sUptime',h>0?h+t('uptimeHours')+' '+m+t('uptimeMinutes'):m+t('uptimeMinutes'));}function startUptime(){setInterval(()=>{uptimeSeconds+=1;updateUptime();},1000);}async function api(path,options){const nextOptions=Object.assign({credentials:'same-origin'},options||{});if(nextOptions.body){nextOptions.headers=Object.assign({'Content-Type':'application/json'},nextOptions.headers||{});}const response=await fetch(path,nextOptions);const raw=await response.text();let payload={};try{payload=raw?JSON.parse(raw):{};}catch{payload={message:translateRuntimeText(raw||t('requestFailed'))};}if(response.status===401){location.assign(currentRoutes.adminLoginPath);throw new Error(t('sessionExpired'));}if(!response.ok)throw new Error(translateRuntimeText(payload.error||payload.message||t('requestFailed')));return payload;}function switchTab(name){document.querySelectorAll('.tab').forEach((item)=>item.classList.toggle('active',item.getAttribute('data-tab')===name));document.querySelectorAll('.panel').forEach((item)=>item.classList.remove('active'));const target=el('p'+name.charAt(0).toUpperCase()+name.slice(1));if(target)target.classList.add('active');if(name==='logs')loadLogs();if(name==='clients')loadClients();if(name==='settings')renderSettings();if(name==='guide')renderGuide();}function pagerInfo(name,total){const pageCount=Math.max(1,Math.ceil(total/tableState[name].pageSize));if(tableState[name].page>pageCount)tableState[name].page=pageCount;const start=total?((tableState[name].page-1)*tableState[name].pageSize)+1:0;const end=Math.min(total,tableState[name].page*tableState[name].pageSize);setText(name+'Range',total?t('showingRows',{from:start,to:end,end:end,total:total}):t('showingRowsEmpty'));setText(name+'Page',t('pageStatus',{page:tableState[name].page,total:pageCount}));setText(name+'Meta',t('loadedRows',{count:total}));el(name+'Prev').disabled=tableState[name].page<=1;el(name+'Next').disabled=tableState[name].page>=pageCount;}function pageSlice(name,rows){pagerInfo(name,rows.length);const start=(tableState[name].page-1)*tableState[name].pageSize;return rows.slice(start,start+tableState[name].pageSize);}
function renderTunnels(){const tbody=el('tTunnels');tbody.replaceChildren();const query=clean(el('tunnelSearch').value).toLowerCase();const rows=(tunnelData||[]).filter((item)=>queryMatch(query,[item.publicHost,item.subdomain,item.publishDomain,item.clientIp,item.hostname,item.os,item.localPort]));const pageRows=pageSlice('tunnel',rows);setText('sTunnels',rows.length);if(!pageRows.length){const tr=create('tr');const td=create('td','empty',t('noActiveTunnels'));td.colSpan=8;tr.appendChild(td);tbody.appendChild(tr);return;}pageRows.forEach((item)=>{const tr=create('tr');const hostTd=create('td');const address=create('span','badge',item.publicHost||item.subdomain||'-');hostTd.appendChild(address);try{const linkUrl=new URL(item.publicUrl||'');if(['https:','http:'].includes(linkUrl.protocol)&&!linkUrl.username&&!linkUrl.password){const link=create('a','public-link',item.publicHost||linkUrl.host);link.href=linkUrl.href;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label',t('openApp')+': '+linkUrl.host);hostTd.replaceChildren(link);}}catch{}tr.appendChild(hostTd);tr.appendChild(create('td','ip',item.clientIp||'-'));tr.appendChild(create('td','',item.hostname||'-'));tr.appendChild(create('td','',item.os||'-'));tr.appendChild(create('td','',item.localPort||'-'));tr.appendChild(create('td','',item.connections||0));tr.appendChild(create('td','',fmtBytes(item.bytesIn)+' / '+fmtBytes(item.bytesOut)));tr.appendChild(create('td','',fmtTime(item.connectedAt)));tbody.appendChild(tr);});}
function renderLogs(){const tbody=el('tLogs');tbody.replaceChildren();const query=clean(el('logSearch').value).toLowerCase();const rows=(logsData||[]).filter((item)=>queryMatch(query,[item.host,item.subdomain,item.visitor_ip,item.method,item.path,item.status_code,item.user_agent]));const pageRows=pageSlice('log',rows);if(!pageRows.length){const tr=create('tr');const td=create('td','empty',t(query?'noSearchResults':'noRequests'));td.colSpan=8;tr.appendChild(td);tbody.appendChild(tr);return;}pageRows.forEach((item)=>{const tr=create('tr');tr.appendChild(create('td','',fmtTime(item.created_at)));const hostTd=create('td');hostTd.appendChild(create('span','badge',item.host||item.subdomain||'-'));tr.appendChild(hostTd);tr.appendChild(create('td','ip',item.visitor_ip||'-'));tr.appendChild(create('td','method',item.method||'-'));tr.appendChild(create('td','',item.path||'-'));tr.appendChild(create('td',statusClass(item.status_code),item.status_code||'-'));tr.appendChild(create('td','',(item.latency_ms||'-')+'ms'));tr.appendChild(create('td','',item.user_agent||'-'));tbody.appendChild(tr);});}
function renderClients(){const tbody=el('tClients');tbody.replaceChildren();const query=clean(el('clientSearch').value).toLowerCase();const rows=(clientsData||[]).filter((item)=>queryMatch(query,[item.client_id,item.assigned_host,item.publish_domain,item.publish_mode,item.subdomain,item.ip,item.hostname,item.os,item.last_seen]));const pageRows=pageSlice('client',rows);if(!pageRows.length){const tr=create('tr');const td=create('td','empty',t('noClients'));td.colSpan=9;tr.appendChild(td);tbody.appendChild(tr);return;}pageRows.forEach((item)=>{const tr=create('tr');tr.appendChild(create('td','',item.client_id?item.client_id.slice(0,12)+'...':'-'));const hostTd=create('td');hostTd.appendChild(create('span','badge',item.assigned_host||'-'));tr.appendChild(hostTd);tr.appendChild(create('td','',item.publish_domain||'-'));tr.appendChild(create('td','',item.publish_mode||'-'));tr.appendChild(create('td','',item.subdomain||'-'));tr.appendChild(create('td','ip',item.ip||'-'));tr.appendChild(create('td','',item.hostname||'-'));tr.appendChild(create('td','',item.os||'-'));tr.appendChild(create('td','',fmtTime(item.last_seen)));tbody.appendChild(tr);});}
function createPublishRow(entry){const wrapper=create('div','publish-row');wrapper.innerHTML='<div class="publish-head"><input class="publish-domain" placeholder="devshop.com"><button type="button" class="btn secondary remove-publish"></button></div><div class="publish-checks"><label><input type="checkbox" class="publish-subdomain"> <span class="publish-subdomain-label"></span></label><label><input type="checkbox" class="publish-root"> <span class="publish-root-label"></span></label></div>';wrapper.querySelector('.publish-domain').setAttribute('aria-label',t('fieldPublishDomains'));wrapper.querySelector('.publish-domain').value=(entry&&entry.domain)||'';wrapper.querySelector('.publish-subdomain').checked=entry?entry.allowSubdomain!==false:true;wrapper.querySelector('.publish-root').checked=entry?entry.allowRoot===true:false;wrapper.querySelector('.remove-publish').textContent=t('remove');wrapper.querySelector('.publish-subdomain-label').textContent=t('randomSubdomains');wrapper.querySelector('.publish-root-label').textContent=t('exactRootHost');wrapper.querySelector('.remove-publish').addEventListener('click',()=>wrapper.remove());return wrapper;}
function renderWarnings(list){const target=el('warnings');target.replaceChildren();const items=Array.isArray(list)?list:[];if(!items.length){target.appendChild(create('div','ok',t('warningHealthy')));return;}items.forEach((item)=>target.appendChild(create('div','warning',translateRuntimeText(item))));}
function renderSettings(){if(!overview)return;const settings=overview.settings||{};const snippets=overview.snippets||{};setText('serverLabel',settings.primaryDomain||settings.tunnelDomain||'',t('waitingConfig'));setText('wsLabel',snippets.websocketUrl||'',t('notConfigured'));el('primary-domain').value=settings.primaryDomain||'';el('control-root').value=settings.controlRoot||'';el('tunnel-token').value=settings.tunnelToken||'';renderWarnings(overview.warnings||[]);setText('snippetAdminUrl',snippets.adminUrl||'',t('notConfigured'));setText('snippetWsUrl',snippets.websocketUrl||'',t('notConfigured'));setText('snippetLegacyWsUrl',snippets.legacyWebsocketUrl||'',t('notConfigured'));setText('snippetTunnelPattern',snippets.tunnelPattern||'',t('notConfigured'));setText('snippetClient',snippets.client||'',t('waitingConfig'));setText('snippetDns',snippets.dns||'',t('waitingConfig'));setText('snippetNginx',snippets.nginx||'',t('waitingConfig'));setText('guideAdminUrl',snippets.adminUrl||'',t('notConfigured'));setText('guideWsUrl',snippets.websocketUrl||'',t('notConfigured'));setText('guideTunnelPattern',snippets.tunnelPattern||'',t('notConfigured'));setText('guideDns',snippets.dns||'',t('waitingConfig'));setText('guideClient',snippets.client||'',t('waitingConfig'));setText('guideRouting',snippets.nginx||'',t('waitingConfig'));setText('nginxPreview',snippets.nginxGuide||'',t('loadingGuide'));const publishList=el('publishList');publishList.replaceChildren();const domains=Array.isArray(settings.publishDomains)?settings.publishDomains:[];if(!domains.length){publishList.appendChild(createPublishRow({}));}else{domains.forEach((item)=>publishList.appendChild(createPublishRow(item)));}refreshRememberedMessage('settingsStatus','settingsStored');refreshRememberedMessage('passwordStatus','passwordUnique');}
function renderGuide(){renderSettings();}
function updateStats(data){const totals=(data&&data.live&&data.live.totals)||(data&&data.totals)||{};setText('sTunnels',totals.activeTunnels||0);setText('sRequests',totals.totalRequests||0);setText('sBytesIn',fmtBytes(totals.totalBytesIn||0));setText('sBytesOut',fmtBytes(totals.totalBytesOut||0));if(Number.isFinite(Number(totals.uptimeSeconds)))uptimeSeconds=Number(totals.uptimeSeconds);updateUptime();}
function applyOverview(data){if(!data)return;overview=data;currentRoutes=Object.assign({},currentRoutes,data.routes||{});tunnelData=(data.live&&data.live.tunnels)||[];updateStats(data);renderTunnels();renderLogs();renderClients();renderSettings();}
async function loadOverview(){applyOverview(await api(currentRoutes.adminApiBasePath + '/overview'));}async function loadLogs(){const data=await api(currentRoutes.adminApiBasePath + '/logs');logsData=data.logs||[];renderLogs();}async function loadClients(){const data=await api(currentRoutes.adminApiBasePath + '/clients');clientsData=data.clients||[];renderClients();}
function collectPublishDomains(){return [...document.querySelectorAll('.publish-row')].map((row)=>({domain:normalizeDomain(row.querySelector('.publish-domain').value),allowSubdomain:row.querySelector('.publish-subdomain').checked,allowRoot:row.querySelector('.publish-root').checked})).filter((item)=>item.domain);}async function submitSettings(){const saveBtn=el('saveBtn');const previousAdminPath=currentRoutes.adminBasePath;const previousPrimary=(overview&&overview.settings&&overview.settings.primaryDomain)||location.hostname;saveBtn.disabled=true;saveBtn.textContent=t('saving');try{const payload={primaryDomain:normalizeDomain(el('primary-domain').value),controlRoot:normalizeControlRoot(el('control-root').value),tunnelToken:clean(el('tunnel-token').value),publishDomains:collectPublishDomains()};const response=await api(currentRoutes.adminApiBasePath + '/settings',{method:'POST',body:JSON.stringify(payload)});settingsDirty=false;applyOverview(response.overview||null);rememberMessage('settingsStatus','settingsSaved');const nextRoutes=response.routes||{};const nextAdminPath=nextRoutes.adminBasePath||currentRoutes.adminBasePath;const nextPrimary=(response.settings&&response.settings.primaryDomain)||previousPrimary;if(nextAdminPath!==previousAdminPath){location.assign(nextAdminPath);return;}if(nextPrimary&&nextPrimary!==previousPrimary){location.assign('https://' + nextPrimary + nextAdminPath);return;}await Promise.all([loadLogs().catch(()=>{}),loadClients().catch(()=>{})]);}catch(error){rememberMessage('settingsStatus',null,error.message);}finally{saveBtn.disabled=false;saveBtn.textContent=t('saveSettings');}}
function openLiveSocket(){const scheme=location.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(scheme + '//' + location.host + currentRoutes.adminWsPath);socket.addEventListener('message',(event)=>{const payload=JSON.parse(event.data||'{}');if(!payload||payload.type!=='live')return;if(!overview)overview={settings:{},snippets:{},routes:currentRoutes};overview.live=payload.live;tunnelData=(payload.live&&payload.live.tunnels)||[];updateStats(payload.live);renderTunnels();});socket.addEventListener('close',()=>setTimeout(openLiveSocket,3000));}
document.querySelectorAll('.tab').forEach((tab)=>tab.addEventListener('click',()=>switchTab(tab.getAttribute('data-tab'))));
document.querySelectorAll('[data-lang]').forEach((button)=>button.addEventListener('click',()=>{currentLang=button.getAttribute('data-lang');localStorage.setItem(LANG_KEY,currentLang);applyI18n();renderSettings();renderTunnels();renderLogs();renderClients();}));
el('tunnelSearch').addEventListener('input',()=>{tableState.tunnel.page=1;renderTunnels();});
el('logSearch').addEventListener('input',()=>{tableState.log.page=1;renderLogs();});
el('clientSearch').addEventListener('input',()=>{tableState.client.page=1;renderClients();});
el('tunnelPageSize').addEventListener('change',(event)=>{tableState.tunnel.pageSize=Number(event.target.value)||25;tableState.tunnel.page=1;renderTunnels();});
el('logPageSize').addEventListener('change',(event)=>{tableState.log.pageSize=Number(event.target.value)||25;tableState.log.page=1;renderLogs();});
el('clientPageSize').addEventListener('change',(event)=>{tableState.client.pageSize=Number(event.target.value)||25;tableState.client.page=1;renderClients();});
el('tunnelPrev').addEventListener('click',()=>{if(tableState.tunnel.page>1){tableState.tunnel.page-=1;renderTunnels();}});
el('tunnelNext').addEventListener('click',()=>{tableState.tunnel.page+=1;renderTunnels();});
el('logPrev').addEventListener('click',()=>{if(tableState.log.page>1){tableState.log.page-=1;renderLogs();}});
el('logNext').addEventListener('click',()=>{tableState.log.page+=1;renderLogs();});
el('clientPrev').addEventListener('click',()=>{if(tableState.client.page>1){tableState.client.page-=1;renderClients();}});
el('clientNext').addEventListener('click',()=>{tableState.client.page+=1;renderClients();});
el('addPublishDomain').addEventListener('click',()=>el('publishList').appendChild(createPublishRow({})));
el('settingsForm').addEventListener('submit',(event)=>{event.preventDefault();submitSettings();});
el('passwordForm').addEventListener('submit',async(event)=>{event.preventDefault();try{await api(currentRoutes.adminApiBasePath + '/password',{method:'POST',body:JSON.stringify({password:el('admin-password').value})});el('admin-password').value='';rememberMessage('passwordStatus','passwordRotated');await loadOverview();}catch(error){rememberMessage('passwordStatus',null,error.message);}});

async function initDashboard(){
  try{
    applyI18n();
    applyOverview(INITIAL_OVERVIEW||{live:{tunnels:[],totals:{}}});
    startUptime();
    openLiveSocket();
    await Promise.all([loadOverview(),loadLogs(),loadClients()]);
  }catch(error){
    console.error('Dashboard init failed:', error);
    setText('serverLabel',t('dashboardError'));
    setText('wsLabel',translateRuntimeText(error.message||t('failedLoad')));
    rememberMessage('settingsStatus',null,error.message||t('failedLoad'));
  }
}

${dashboardBehavior}
${clientKeysBehavior}
initDashboard();
</script></body></html>`;
}

function createDashboard(tunnelManager, runtimeConfig, options = {}) {
  const dashClients = new Set();
  const loginLimiter = createAttemptLimiter();
  const globalLoginLimiter = createAttemptLimiter({ max: 60 });
  const liveUpgradeLimiter = createAttemptLimiter({ max: 60 });
  let credentialGeneration = 0;
  let mutationQueue = Promise.resolve();
  const serializeMutation = (operation) => {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => {});
    return result;
  };
  const refreshRuntimeConfig = typeof options.refreshRuntimeConfig === 'function'
    ? options.refreshRuntimeConfig
    : (() => runtimeConfig);
  const ports = options.ports || {};
  const getRoutes = () => buildRuntimeRoutes(runtimeConfig);

  const server = http.createServer(async (req, res) => {
    try {
    const routes = getRoutes();
    if (req.url === '/healthz' && req.method === 'GET' && isLoopback(req.socket.remoteAddress)) {
      sendJson(res, 200, { status: 'ok' }); return;
    }
    if (!isAdminHost(req, runtimeConfig.primaryDomain)) {
      sendJson(res, 421, { error: 'Use the primary administrator hostname.' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/healthz' && req.method === 'GET') { sendJson(res, 200, { status: 'ok' }); return; }

    if (pathname === routes.adminLoginPath && req.method === 'GET') {
      sendHtml(res, (nonce) => getLoginHTML(routes, '', nonce));
      return;
    }

    if (pathname === routes.adminLoginPath && req.method === 'POST') {
      if (!isSameOriginMutation(req)) { sendJson(res, 403, { error: 'Same-origin request required.' }); return; }
      if (!loginLimiter.take(clientIp(req)) || !globalLoginLimiter.take('all')) {
        res.setHeader('Retry-After', '60');
        sendJson(res, 429, { error: 'Too many sign-in attempts. Wait one minute and try again.' });
        return;
      }
      const raw = await parseBody(req);
      const params = new URLSearchParams(raw);
      const password = params.get('password');

      const loginGeneration = credentialGeneration;
      if (!await verifyPassword(password) || loginGeneration !== credentialGeneration) {
        sendHtml(res, (nonce) => getLoginHTML(routes, 'Invalid password', nonce));
        return;
      }

      const token = createSession();
      res.writeHead(302, {
        ...JSON_SECURITY_HEADERS,
        'Set-Cookie': buildSessionCookie(token, 86400, req),
        Location: routes.adminBasePath,
      });
      res.end();
      return;
    }

    if (pathname === routes.adminLogoutPath) {
      const token = getCookie(req, 'session');
      if (token) sessions.delete(token);
      res.writeHead(302, {
        ...JSON_SECURITY_HEADERS,
        'Set-Cookie': buildSessionCookie('', 0, req),
        Location: routes.adminLoginPath,
      });
      res.end();
      return;
    }

    if (!pathname.startsWith(routes.adminBasePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    if (!isAuthenticated(req)) {
      if (pathname.startsWith(routes.adminApiBasePath)) {
        sendJson(res, 401, { error: 'Unauthorized' });
      } else {
        redirect(res, routes.adminLoginPath);
      }
      return;
    }
    const requestGeneration = credentialGeneration;

    if (req.method === 'POST' && (!isSameOriginMutation(req)
      || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) {
      sendJson(res, 403, { error: 'Same-origin JSON request required.' });
      return;
    }

    if (pathname === routes.adminBasePath || pathname === `${routes.adminBasePath}/`) {
      const overview = await buildOverview(tunnelManager, runtimeConfig, routes, ports);
      sendHtml(res, (nonce) => getDashboardHTML(routes, overview, nonce));
      return;
    }

    if (pathname === `${routes.adminApiBasePath}/overview` && req.method === 'GET') {
      sendJson(res, 200, await buildOverview(tunnelManager, runtimeConfig, routes, ports));
      return;
    }

    if (pathname === `${routes.adminApiBasePath}/logs` && req.method === 'GET') {
      sendJson(res, 200, { logs: await getRecentLogs(200) });
      return;
    }

    if (pathname === `${routes.adminApiBasePath}/clients` && req.method === 'GET') {
      sendJson(res, 200, { clients: await getAllClients() });
      return;
    }

    const clientKeysPath = `${routes.adminApiBasePath}/client-keys`;
    const clientKeyAction = pathname.startsWith(`${clientKeysPath}/`)
      ? pathname.slice(clientKeysPath.length + 1).split('/') : [];
    if ((pathname === clientKeysPath && ['GET', 'POST'].includes(req.method))
      || (req.method === 'POST' && clientKeyAction.length === 2 && ['revoke', 'rotate'].includes(clientKeyAction[1]))) {
      const store = options.accessKeyStore;
      if (!store) {
        sendJson(res, 503, { error: 'Client key management is unavailable.' }); return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { keys: store.list() }); return;
      }
      let payload;
      try { payload = await parseJsonBody(req); }
      catch (error) { sendJson(res, 400, { error: error.message }); return; }
      try {
        await serializeMutation(async () => {
          if (!isAuthenticated(req) || requestGeneration !== credentialGeneration) {
            sendJson(res, 401, { error: 'Session expired. Sign in again.' }); return;
          }
          if (pathname === clientKeysPath) {
            sendJson(res, 201, await store.issue(payload.name)); return;
          }
          const [id, action] = clientKeyAction;
          const result = await store[action](id);
          if (!result) { sendJson(res, 404, { error: 'Client key was not found.' }); return; }
          if (typeof options.onClientKeyRevoked === 'function') await options.onClientKeyRevoked(id);
          sendJson(res, 200, action === 'rotate' ? result : { key: result });
        });
      } catch (error) {
        sendJson(res, error.code === 'EACCESSKEYINPUT' ? 400 : 500, {
          error: error.code === 'EACCESSKEYINPUT' ? error.message : 'Could not update client access keys.',
        });
      }
      return;
    }

    if (pathname === `${routes.adminApiBasePath}/settings` && req.method === 'POST') {
      try {
        const payload = await parseJsonBody(req);
        await serializeMutation(async () => {
        if (!isAuthenticated(req) || requestGeneration !== credentialGeneration) {
          sendJson(res, 401, { error: 'Session expired. Sign in again.' }); return;
        }
        if (runtimeConfig.tunnelAuthenticationDisabled) {
          await refreshRuntimeConfig();
          sendJson(res, 409, { error: 'Stored settings were reloaded after a database failure. Reload this page and review the access key before saving.' });
          return;
        }
        // Omitted fields must inherit the authoritative DB state, never a stale runtime key.
        const nextSettings = await prepareServerSettings(payload);
        if (!isAuthenticated(req) || requestGeneration !== credentialGeneration) {
          sendJson(res, 401, { error: 'Session expired. Sign in again.' }); return;
        }
        try {
          await updateServerSettings(nextSettings);
        } finally {
          // Strict mirror errors can occur after the primary has committed a new key.
          await refreshRuntimeConfig();
        }
        const nextRoutes = getRoutes();
        sendJson(res, 200, {
          ok: true,
          settings: runtimeConfig,
          routes: nextRoutes,
          overview: await buildOverview(tunnelManager, runtimeConfig, nextRoutes, ports),
        });
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (pathname === `${routes.adminApiBasePath}/password` && req.method === 'POST') {
      try {
        const payload = await parseJsonBody(req);
        await serializeMutation(async () => {
        if (!isAuthenticated(req) || requestGeneration !== credentialGeneration) {
          sendJson(res, 401, { error: 'Session expired. Sign in again.' }); return;
        }
        const nextPassword = validateNewPassword(payload.password);
        credentialGeneration += 1;
        sessions.clear();
        for (const socket of dashClients) socket.close(4001, 'Sign in again');
        await setDashboardPassword(nextPassword);
        res.setHeader('Set-Cookie', buildSessionCookie(createSession(), 86400, req));
        sendJson(res, 200, { ok: true });
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[Dashboard] Request failed:', error.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'The server could not complete this request.' });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  let lastLivePayload = '';

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (!liveUpgradeLimiter.take(clientIp(req))) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n', () => socket.destroy());
      return;
    }
    if (!isAdminHost(req, runtimeConfig.primaryDomain) || !isAuthenticated(req) || !isSameOriginMutation(req) || dashClients.size >= 64) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    const routes = getRoutes();
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {}

    if (pathname !== routes.adminWsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    ws.on('error', () => dashClients.delete(ws));
    if (!isAuthenticated(req)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    dashClients.add(ws);
    ws._adminRequest = req;
    ws.on('close', () => dashClients.delete(ws));
    ws.on('error', () => dashClients.delete(ws));

    try {
      sendControl(ws, {
        type: 'live',
        live: await collectLiveData(tunnelManager, runtimeConfig),
      });
    } catch {}
  });

  let liveBroadcastInFlight = false;
  const liveTimer = setInterval(() => {
    for (const ws of dashClients) {
      if (!isAuthenticated(ws._adminRequest)) { ws.close(4001, 'Session expired'); dashClients.delete(ws); }
    }
    if (!dashClients.size) return;
    if (liveBroadcastInFlight) return;

    liveBroadcastInFlight = true;
    (async () => {
      const payload = JSON.stringify({
        type: 'live',
        live: await collectLiveData(tunnelManager, runtimeConfig),
      });

      if (payload === lastLivePayload) return;
      lastLivePayload = payload;

      for (const ws of dashClients) {
        if (ws.readyState === ws.OPEN) {
          sendControl(ws, JSON.parse(payload));
        }
      }
    })().catch(() => {
    }).finally(() => {
      liveBroadcastInFlight = false;
    });
  }, 2000);
  liveTimer.unref();
  server.on('close', () => { clearInterval(liveTimer); for (const ws of dashClients) ws.terminate(); wss.close(); });

  return server;
}

module.exports = { createDashboard };


