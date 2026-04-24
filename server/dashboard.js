const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const {
  verifyPassword,
  setDashboardPassword,
  getAllClients,
  getRecentLogs,
  getTotalRequestCount,
  prepareServerSettings,
  updateServerSettings,
  getBootstrapPasswordFilePath,
  isUsingLegacyDefaultPassword,
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
    "connect-src 'self' ws: wss:",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function createSession() {
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
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
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

function sendHtml(res, html) {
  res.writeHead(200, {
    ...HTML_SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(html);
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwardedProto === 'https' || !!req.socket.encrypted;
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

  if (!runtimeConfig.hasTunnelToken) {
    warnings.push('Tunnel token is empty. Any client that knows your WebSocket URL can open tunnels.');
  } else if (runtimeConfig.tunnelToken === 'your-secret-token-here') {
    warnings.push('Tunnel token is still using the example placeholder value. Replace it with a real secret and update saved client configs.');
  }

  if (runtimeConfig.bootstrapPasswordFile) {
    warnings.push(`A bootstrap admin password is still available on disk at ${runtimeConfig.bootstrapPasswordFile}. Rotate it after your first successful login.`);
  }

  if (await isUsingLegacyDefaultPassword()) {
    warnings.push('This installation is still using the old default admin password from previous versions. Rotate it immediately from the Admin Password panel.');
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
  const token = runtimeConfig.tunnelToken ? ` --token ${runtimeConfig.tunnelToken}` : '';
  const examples = [];
  const defaultSubdomainDomain = publishDomains.find((entry) => entry.allowSubdomain)?.domain;
  const rootDomain = publishDomains.find((entry) => entry.allowRoot)?.domain;
  const tcpDomain = publishDomains[0]?.domain;

  if (defaultSubdomainDomain) {
    examples.push(`ptunnel http 3000 --server ${base} --domain ${defaultSubdomainDomain}${token}`);
  } else {
    examples.push(`ptunnel http 3000 --server ${base}${token}`);
  }
  if (rootDomain) {
    examples.push(`ptunnel http 3000 --server ${base} --domain ${rootDomain} --root${token}`);
  }
  if (tcpDomain) {
    examples.push(`ptunnel tcp 25565 --server ${base} --domain ${tcpDomain}${token}`);
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
  if (publishDomains.find((entry) => entry.domain === primaryDomain && entry.allowSubdomain)) {
    adminServerNames.push(`*.${primaryDomain}`);
  }
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
  const publishDomains = Array.isArray(runtimeConfig.publishDomains) ? runtimeConfig.publishDomains : [];
  const primaryDomain = runtimeConfig.primaryDomain || 'example.com';
  const defaultPublishDomain = publishDomains[0]?.domain || 'example.com';
  const subdomainEntry = publishDomains.find((entry) => entry.allowSubdomain) || { domain: defaultPublishDomain, allowSubdomain: true };
  const rootEntry = publishDomains.find((entry) => entry.allowRoot && entry.domain !== primaryDomain)
    || publishDomains.find((entry) => entry.allowRoot)
    || { domain: 'root-example.com', allowRoot: true };
  const wildcardDomains = publishDomains
    .filter((entry) => entry.allowSubdomain)
    .map((entry) => `*.${entry.domain}`);
  const winAcmeHosts = [primaryDomain, ...wildcardDomains]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
  const extraPublishDomains = publishDomains
    .filter((entry) => entry.domain !== primaryDomain)
    .map((entry) => entry.domain);
  const httpRedirectNames = [primaryDomain, ...wildcardDomains, ...extraPublishDomains]
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .join(' ');
  const subdomainExampleHost = `demo.${subdomainEntry.domain}`;
  const rootExampleHost = rootEntry.domain;

  return [
    '# Manual nginx + win-acme guide',
    '# English is the primary language. Thai notes are included below each section.',
    '# PrivateTunnel does not edit nginx files on this host anymore.',
    '# Keep your current nginx structure, then add only the routes/server blocks you need.',
    '',
    '================================================================================',
    '1) OVERVIEW (EN)',
    `- Admin dashboard host: ${primaryDomain}`,
    `- Admin/dashboard path: ${routes.adminBasePath} -> 127.0.0.1:${ports.dashboardPort}`,
    `- Client WebSocket path: ${routes.tunnelWsPath} -> 127.0.0.1:${ports.wsPort}`,
    `- Legacy WebSocket path: ${routes.legacyTunnelWsPath} -> 127.0.0.1:${ports.wsPort}`,
    `- Tunnel HTTP/TCP reverse-proxy path: / -> 127.0.0.1:${ports.proxyPort}`,
    `- Example subdomain publish host: ${subdomainExampleHost}`,
    `- Example root publish host: ${rootExampleHost}`,
    '',
    '1) ภาพรวม (TH)',
    `- โดเมนสำหรับหน้าแอดมิน: ${primaryDomain}`,
    `- path ของ dashboard/admin: ${routes.adminBasePath} -> 127.0.0.1:${ports.dashboardPort}`,
    `- path ของ client websocket: ${routes.tunnelWsPath} -> 127.0.0.1:${ports.wsPort}`,
    `- path websocket แบบเก่า: ${routes.legacyTunnelWsPath} -> 127.0.0.1:${ports.wsPort}`,
    `- path สำหรับ tunnel traffic: / -> 127.0.0.1:${ports.proxyPort}`,
    `- ตัวอย่างโดเมนแบบ subdomain: ${subdomainExampleHost}`,
    `- ตัวอย่างโดเมนแบบ root domain: ${rootExampleHost}`,
    '',
    '================================================================================',
    '2) DNS RECORDS (EN)',
    '# Point every publish hostname to the same server IP.',
    `#    A     ${primaryDomain}                    -> <your-server-ip>`,
    `#    A     *.${subdomainEntry.domain}                  -> <your-server-ip>`,
    ...extraPublishDomains.map((domain) => `#    A     ${domain}                    -> <your-server-ip>`),
    '',
    '2) DNS RECORDS (TH)',
    '# ให้ทุกโดเมนที่ต้องการใช้งานชี้มาที่ IP เดียวกันของเครื่องเซิร์ฟเวอร์',
    '# ถ้าจะใช้ wildcard subdomain ต้องมี A/AAAA หรือ DNS setup ที่ครอบคลุม *.domain นั้น',
    '',
    '================================================================================',
    '3) CREATE SSL WITH WIN-ACME (EN)',
    '# Recommended flow:',
    '# - Open win-acme (wacs.exe)',
    '# - Create a new certificate',
    '# - Add the hostnames below',
    '# - Use DNS validation when requesting wildcard names such as *.example.com',
    '# - Export in PEM format for nginx, or use your normal nginx-compatible export flow',
    `#    Hosts: ${winAcmeHosts.join(', ')}`,
    '',
    '3) CREATE SSL WITH WIN-ACME (TH)',
    '# ขั้นตอนแนะนำ:',
    '# - เปิด win-acme (wacs.exe)',
    '# - สร้าง certificate ใหม่',
    '# - ใส่ hostname ตามรายการด้านบน',
    '# - ถ้าขอ wildcard เช่น *.example.com ให้ใช้ DNS validation',
    '# - export เป็น PEM สำหรับ nginx หรือใช้รูปแบบ export ที่ nginx ของคุณรองรับอยู่แล้ว',
    '',
    '================================================================================',
    '4) BASE HTTP -> HTTPS REDIRECT BLOCK (EN)',
    '# Use one redirect block for all tunnel/admin hosts that should force HTTPS.',
    'server {',
    '    listen 80;',
    `    server_name ${httpRedirectNames || `${primaryDomain} *.${subdomainEntry.domain}`};`,
    '    return 301 https://$host$request_uri;',
    '}',
    '',
    '4) BASE HTTP -> HTTPS REDIRECT BLOCK (TH)',
    '# บล็อกนี้ใช้ redirect ทุกโดเมนจาก http ไป https',
    '# ใส่ทุก host ที่ต้องการบังคับใช้งาน SSL ไว้ใน server_name',
    '',
    '================================================================================',
    '5) PRIMARY ADMIN + DEFAULT TUNNEL ENTRY (EN)',
    '# This server block handles:',
    `# - Admin UI on https://${primaryDomain}${routes.adminBasePath}`,
    `# - Client WebSocket on https://${primaryDomain}${routes.tunnelWsPath}`,
    `# - Legacy WebSocket on https://${primaryDomain}${routes.legacyTunnelWsPath}`,
    `# - Any fallback traffic on ${primaryDomain} routed to the proxy port`,
    '# Replace certificate paths with the PEM files exported by win-acme.',
    'map $http_upgrade $connection_upgrade {',
    '    default upgrade;',
    "    ''      close;",
    '}',
    '',
    'server {',
    '    listen 443 ssl;',
    '    http2 on;',
    `    server_name ${primaryDomain};`,
    '    ssl_certificate     C:/path/to/win-acme/fullchain.pem;',
    '    ssl_certificate_key C:/path/to/win-acme/privkey.pem;',
    '',
    `    location = ${routes.legacyTunnelWsPath} {`,
    `        proxy_pass http://127.0.0.1:${ports.wsPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    '        proxy_set_header Host $host;',
    '    }',
    '',
    `    location = ${routes.tunnelWsPath} {`,
    `        proxy_pass http://127.0.0.1:${ports.wsPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "upgrade";',
    '        proxy_set_header Host $host;',
    '    }',
    '',
    `    location ^~ ${routes.adminBasePath} {`,
    `        proxy_pass http://127.0.0.1:${ports.dashboardPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection $connection_upgrade;',
    '        proxy_set_header Host $host;',
    '    }',
    '',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${ports.proxyPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_buffering off;',
    '        proxy_request_buffering off;',
    '    }',
    '}',
    '',
    '5) PRIMARY ADMIN + DEFAULT TUNNEL ENTRY (TH)',
    '# บล็อกนี้ใช้กับโดเมนหลักของระบบ',
    '# - หน้าแอดมินอยู่ที่ primary domain + admin path',
    '# - websocket ของ client อยู่ที่ primary domain + ws path',
    '# - request อื่น ๆ ที่เหลือจะถูกส่งไป port proxy',
    '',
    '================================================================================',
    '6) EXTRA SUBDOMAIN PUBLISH BLOCK (EN)',
    `# Use this when clients should receive random hosts like ${subdomainExampleHost}`,
    '# This block accepts both the bare domain and wildcard subdomains.',
    'server {',
    '    listen 443 ssl;',
    `    server_name ${subdomainEntry.domain} *.${subdomainEntry.domain};`,
    '    ssl_certificate     C:/path/to/win-acme/fullchain.pem;',
    '    ssl_certificate_key C:/path/to/win-acme/privkey.pem;',
    '',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${ports.proxyPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_buffering off;',
    '        proxy_request_buffering off;',
    '    }',
    '}',
    '',
    '6) EXTRA SUBDOMAIN PUBLISH BLOCK (TH)',
    `# ใช้กรณีต้องการแจกโดเมนแบบสุ่ม เช่น ${subdomainExampleHost}`,
    '# บล็อกนี้จะรับทั้งโดเมนหลักและ wildcard subdomain ของโดเมนนั้น',
    '',
    '================================================================================',
    '7) EXTRA ROOT DOMAIN PUBLISH BLOCK (EN)',
    `# Use this when a client should publish on the exact root host ${rootExampleHost}`,
    '# This is for root-mode publishing, not random subdomains.',
    '# In the dashboard, enable "Exact root host" for this domain.',
    'server {',
    '    listen 443 ssl;',
    `    server_name ${rootExampleHost};`,
    '    ssl_certificate     C:/path/to/win-acme/fullchain.pem;',
    '    ssl_certificate_key C:/path/to/win-acme/privkey.pem;',
    '',
    '    location / {',
    `        proxy_pass http://127.0.0.1:${ports.proxyPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_buffering off;',
    '        proxy_request_buffering off;',
    '    }',
    '}',
    '',
    '7) EXTRA ROOT DOMAIN PUBLISH BLOCK (TH)',
    `# ใช้กรณีต้องการให้ client ออกที่ root domain ตรง ๆ เช่น ${rootExampleHost}`,
    '# แบบนี้ไม่ใช่การสุ่ม subdomain แต่เป็นการ publish ที่โดเมนหลักของ entry นั้นโดยตรง',
    '# ใน dashboard ให้เปิดตัวเลือก "Exact root host" สำหรับโดเมนนี้',
    '',
    '================================================================================',
    '8) HOW TO DECIDE WHICH BLOCK TO ADD (EN)',
    `# - Want random hosts like abc123.${subdomainEntry.domain}? Use the SUBDOMAIN block.`,
    `# - Want one exact website like ${rootExampleHost}? Use the ROOT block.`,
    '# - Want both on the same domain? Keep both "Random subdomains" and "Exact root host" enabled,',
    '#   then create nginx server_name entries that cover both the bare domain and wildcard domain.',
    '',
    '8) วิธีเลือกใช้แต่ละบล็อก (TH)',
    `# - ถ้าต้องการลิงก์สุ่มแบบ abc123.${subdomainEntry.domain} ให้ใช้บล็อก SUBDOMAIN`,
    `# - ถ้าต้องการใช้โดเมนตรง ๆ เช่น ${rootExampleHost} ให้ใช้บล็อก ROOT`,
    '# - ถ้าต้องการทั้งสองแบบในโดเมนเดียวกัน ให้เปิดทั้ง Random subdomains และ Exact root host',
    '#   และตั้ง server_name ให้ครอบคลุมทั้ง domain ปกติและ wildcard',
    '',
    '================================================================================',
    '9) IMPORTANT NOTES (EN)',
    '# - Keep the admin path isolated under the control root to avoid collisions with tunnel traffic.',
    '# - WebSocket paths must point to the ws port, not the dashboard port.',
    '# - General tunnel traffic must point to the proxy port.',
    '# - If you already have your own nginx layout, copy only the relevant location/server blocks.',
    '',
    '9) หมายเหตุสำคัญ (TH)',
    '# - แยก admin path ไว้ใต้ control root เพื่อไม่ชนกับ tunnel traffic',
    '# - path ของ WebSocket ต้องชี้ไปที่ ws port ไม่ใช่ dashboard port',
    '# - traffic ปกติของ tunnel ต้องชี้ไปที่ proxy port',
    '# - ถ้าคุณมีโครงสร้าง nginx เดิมอยู่แล้ว ให้คัดลอกเฉพาะ location/server block ที่จำเป็นไปใช้',
  ].join('\n');
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

function getLoginHTML(routes, error) {
  const i18n = {
    en: {
      documentTitle: 'Login - PrivateTunnel',
      overline: 'Hoster-first access',
      title: 'PrivateTunnel',
      subtitle: 'Dashboard login',
      adminPath: 'Admin path',
      passwordLabel: 'Password',
      passwordPlaceholder: 'Enter your password',
      login: 'Login',
      hint: 'If DASHBOARD_PASSWORD was empty on first boot, check the bootstrap password file inside the server data directory.',
      invalidPassword: 'Invalid password',
      langEnglish: 'English',
      langThai: 'Thai',
    },
    th: {
      documentTitle: 'เข้าสู่ระบบ - PrivateTunnel',
      overline: 'ทางเข้าแอดมินสำหรับผู้ดูแลโฮสต์',
      title: 'PrivateTunnel',
      subtitle: 'เข้าสู่ระบบแดชบอร์ด',
      adminPath: 'พาธแอดมิน',
      passwordLabel: 'รหัสผ่าน',
      passwordPlaceholder: 'กรอกรหัสผ่าน',
      login: 'เข้าสู่ระบบ',
      hint: 'ถ้า DASHBOARD_PASSWORD ว่างตอนบูตครั้งแรก ให้ตรวจสอบไฟล์ bootstrap password ในโฟลเดอร์ข้อมูลของเซิร์ฟเวอร์',
      invalidPassword: 'รหัสผ่านไม่ถูกต้อง',
      langEnglish: 'English',
      langThai: 'ไทย',
    },
  };

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - PrivateTunnel</title>
<style>
:root{--bg:#0b1013;--panel:#11191d;--panel-2:#162127;--line:#27343b;--text:#eef6f1;--muted:#8ca0a4;--accent:#9bf3d0;--accent-2:#f4c278;--danger:#ff9b98}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Aptos','Segoe UI Variable','Trebuchet MS',sans-serif;background:radial-gradient(circle at top left,#18343a 0,#0b1013 42%),linear-gradient(180deg,#0b1013,#0d1519);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.shell{width:min(960px,100%);display:grid;grid-template-columns:1.05fr .95fr;border:1px solid rgba(155,243,208,.16);border-radius:28px;overflow:hidden;box-shadow:0 40px 80px rgba(0,0,0,.45)}
.hero{background:linear-gradient(160deg,rgba(155,243,208,.15),rgba(255,255,255,.02));padding:38px;display:flex;flex-direction:column;justify-content:space-between;gap:28px;position:relative}
.hero:before{content:'';position:absolute;inset:18px;border:1px solid rgba(255,255,255,.08);border-radius:22px;pointer-events:none}
.hero-inner{position:relative;z-index:1}
.overline{color:var(--accent);letter-spacing:.18em;text-transform:uppercase;font-size:11px;margin-bottom:14px}
.hero h1{font-size:44px;line-height:1;margin-bottom:12px}
.hero p{color:#c8d7d0;line-height:1.75;font-size:15px;max-width:34ch}
.path-chip{display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.08);font-family:Consolas,'Courier New',monospace;font-size:13px;color:var(--accent-2);margin-top:18px}
.hint-card{position:relative;z-index:1;background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:18px;color:var(--muted);line-height:1.7;font-size:13px}
.panel{background:var(--panel);padding:32px;display:flex;flex-direction:column;gap:18px}
.topbar{display:flex;justify-content:flex-end}
.lang-switch{display:inline-flex;gap:8px;padding:6px;border-radius:999px;border:1px solid var(--line);background:#0d1418}
.lang-switch button{border:none;background:transparent;color:var(--muted);padding:8px 12px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer}
.lang-switch button.active{background:var(--accent);color:#09231b}
.panel h2{font-size:28px;line-height:1.1}
.panel-sub{color:var(--muted);line-height:1.7;font-size:14px}
form{display:grid;gap:14px}
label{display:block;color:var(--muted);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
input{width:100%;padding:14px 15px;margin-top:8px;background:var(--panel-2);border:1px solid var(--line);border-radius:16px;color:var(--text);font-size:15px}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px rgba(155,243,208,.12)}
.cta{border:none;border-radius:16px;background:linear-gradient(135deg,var(--accent),#63d7ca);color:#082119;padding:14px 18px;font-weight:800;font-size:15px;cursor:pointer}
.cta:hover{filter:brightness(1.03)}
.error{padding:12px 14px;border-radius:16px;background:rgba(138,28,31,.18);border:1px solid rgba(255,155,152,.28);color:#ffc4c1;font-size:14px}
.error.hidden{display:none}
.meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:12px}
.meta span{padding:8px 10px;background:#0d1418;border:1px solid var(--line);border-radius:999px}
code{font-family:Consolas,'Courier New',monospace}
@media (max-width:860px){.shell{grid-template-columns:1fr}.hero{padding:28px}.panel{padding:26px}}
</style></head><body>
<div class="shell">
  <section class="hero">
    <div class="hero-inner">
      <div class="overline" id="loginOverline"></div>
      <h1 id="loginTitle"></h1>
      <p id="loginSubtitle"></p>
      <div class="path-chip"><span id="loginAdminPathLabel"></span><code>${escapeHtml(routes.adminBasePath || '/')}</code></div>
    </div>
    <div class="hint-card" id="loginHint"></div>
  </section>
  <section class="panel">
    <div class="topbar">
      <div class="lang-switch" aria-label="Language switcher">
        <button type="button" data-lang="en"></button>
        <button type="button" data-lang="th"></button>
      </div>
    </div>
    <h2 id="formTitle"></h2>
    <p class="panel-sub" id="formSubtitle"></p>
    <p id="loginError" class="error${error ? '' : ' hidden'}">${escapeHtml(error || '')}</p>
    <form method="POST" action="${routes.adminLoginPath}">
      <label id="passwordLabel" for="passwordInput"></label>
      <input id="passwordInput" type="password" name="password" autofocus>
      <button class="cta" type="submit" id="loginButton"></button>
    </form>
    <div class="meta">
      <span>Path: <code>${escapeHtml(routes.adminBasePath || '/')}</code></span>
      <span>Route: <code>${escapeHtml(routes.adminLoginPath || '/')}</code></span>
    </div>
  </section>
</div>
<script>
const I18N=${JSON.stringify(i18n)};
const ERROR_MESSAGE=${JSON.stringify(error || '')};
const LANG_KEY='ptAdminLang';
let currentLang=(localStorage.getItem(LANG_KEY)==='th')?'th':'en';
function t(key){return (I18N[currentLang]&&I18N[currentLang][key])||I18N.en[key]||key;}
function translateError(message){if(!message)return '';if(message==='Invalid password')return t('invalidPassword');return message;}
function updateLangButtons(){document.querySelectorAll('[data-lang]').forEach((button)=>{const lang=button.getAttribute('data-lang');button.classList.toggle('active',lang===currentLang);button.textContent=lang==='th'?t('langThai'):t('langEnglish');});}
function applyI18n(){document.title=t('documentTitle');document.documentElement.lang=currentLang;document.getElementById('loginOverline').textContent=t('overline');document.getElementById('loginTitle').textContent=t('title');document.getElementById('loginSubtitle').textContent=t('subtitle');document.getElementById('loginAdminPathLabel').textContent=t('adminPath');document.getElementById('loginHint').textContent=t('hint');document.getElementById('formTitle').textContent=t('subtitle');document.getElementById('formSubtitle').textContent=t('hint');document.getElementById('passwordLabel').textContent=t('passwordLabel');document.getElementById('passwordInput').placeholder=t('passwordPlaceholder');document.getElementById('loginButton').textContent=t('login');const errorNode=document.getElementById('loginError');if(ERROR_MESSAGE){errorNode.textContent=translateError(ERROR_MESSAGE);errorNode.classList.remove('hidden');}updateLangButtons();}
document.querySelectorAll('[data-lang]').forEach((button)=>button.addEventListener('click',()=>{currentLang=button.getAttribute('data-lang');localStorage.setItem(LANG_KEY,currentLang);applyI18n();}));
applyI18n();
</script>
</body></html>`;
}

function getDashboardHTML(routes, initialOverview) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PrivateTunnel Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;background:#0a0a0a;color:#e0e0e0;padding:24px}
h1{color:#00d4aa;margin-bottom:4px;font-size:28px}
.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:12px;flex-wrap:wrap}
.header-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.subtitle{color:#666;margin-bottom:24px;line-height:1.6}.mini{font-size:12px;color:#777}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#00d4aa;margin-right:8px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.logout{color:#888;text-decoration:none;font-size:13px;padding:6px 12px;border:1px solid #333;border-radius:999px}
.logout:hover{border-color:#ff6b6b;color:#ff6b6b}
.lang-switch{display:inline-flex;gap:6px;padding:4px;background:#111;border:1px solid #333;border-radius:999px}
.lang-switch button{border:none;background:transparent;color:#888;padding:7px 12px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer}
.lang-switch button.active{background:#00d4aa;color:#0a0a0a}
.stats{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:14px 20px;min-width:140px}.stat .label{color:#888;font-size:11px;text-transform:uppercase}.stat .val{color:#00d4aa;font-size:28px;font-weight:bold;margin-top:2px}
.tabs{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}.tab{padding:8px 16px;background:#1a1a1a;border:1px solid #333;border-radius:6px 6px 0 0;cursor:pointer;color:#888;font-size:13px}.tab.active{background:#222;color:#00d4aa;border-bottom-color:#222}
.panel{display:none;background:#1a1a1a;border:1px solid #333;border-radius:0 8px 8px 8px;overflow:hidden}.panel.active{display:block}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:16px 16px 0 16px}
.panel-meta{color:#888;font-size:12px}
.panel-pad{padding:16px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.split{display:grid;grid-template-columns:1.25fr .75fr;gap:16px}
.toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.toolbar-main,.toolbar-side,.pager{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pager button{padding:8px 12px;background:#111;border:1px solid #333;color:#ddd;border-radius:6px;cursor:pointer}
.pager button:disabled{opacity:.45;cursor:not-allowed}
.page-label,.range-label{color:#888;font-size:12px}
.select{padding:10px 12px;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:13px}
.search{width:100%;padding:10px 12px;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:13px}
table{width:100%;border-collapse:collapse}.table-wrap{overflow:auto;max-height:64vh;border-top:1px solid #222}
th{position:sticky;top:0;z-index:1;background:#222;color:#888;text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;white-space:nowrap}td{padding:10px 14px;border-top:1px solid #2a2a2a;font-size:13px;white-space:nowrap;vertical-align:top}
.badge{background:#1a3a2a;color:#00d4aa;padding:2px 8px;border-radius:4px;font-size:12px}.ip{color:#f0c674}.method{font-weight:bold}.s2{color:#00d4aa}.s3{color:#81a2be}.s4{color:#f0c674}.s5{color:#cc6666}.empty{text-align:center;padding:48px;color:#555}
.box{background:#111;border:1px solid #333;border-radius:8px;padding:14px}.box h2{color:#00d4aa;font-size:18px;margin-bottom:14px}.sub{color:#888;font-size:13px;line-height:1.6;margin-bottom:12px}.muted{color:#666}
.warning{padding:10px 12px;border:1px solid #4b2a2a;background:#251515;color:#ffb4b4;border-radius:6px;font-size:13px;line-height:1.55;margin-bottom:10px}.ok{padding:10px 12px;border:1px solid #1f3d2a;background:#112117;color:#8fe6af;border-radius:6px;font-size:13px}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field label{display:block;color:#888;font-size:12px;text-transform:uppercase;margin-bottom:6px}.field input{width:100%;padding:11px 12px;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:14px}.field input:focus{outline:none;border-color:#00d4aa}.field small{display:block;color:#666;font-size:12px;line-height:1.5;margin-top:6px}.field.full{grid-column:1/-1}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:14px}.btn{padding:10px 14px;border:none;border-radius:6px;font-size:13px;font-weight:bold;cursor:pointer}.btn.primary{background:#00d4aa;color:#0a0a0a}.btn.secondary{background:#222;color:#e0e0e0;border:1px solid #333}.btn.ghost{background:#173328;color:#82f3c7;border:1px solid #24543f}.btn.danger{background:#3a1c1c;color:#ffb4b4;border:1px solid #5a2a2a}.btn:disabled{opacity:.6;cursor:not-allowed}.status{color:#888;font-size:12px}
.publish-list{display:grid;gap:10px;margin-top:8px}.publish-row{background:#111;border:1px solid #333;border-radius:8px;padding:12px}.publish-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:start}.publish-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}.publish-checks{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;color:#bbb;font-size:13px}.publish-checks label{display:flex;gap:6px;align-items:center}
pre,code{display:block;white-space:pre-wrap;word-break:break-word;color:#d7e7ff;background:#0a0a0a;border:1px solid #222;border-radius:6px;padding:12px;font-family:Consolas,'Courier New',monospace;font-size:12px;line-height:1.6}
.guide-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.guide-grid .full{grid-column:1/-1}
.summary-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}
.summary-card{background:#111;border:1px solid #333;border-radius:8px;padding:14px}
.summary-card .k{display:block;color:#888;font-size:11px;text-transform:uppercase;margin-bottom:8px}
.summary-card .v{font-size:13px;color:#f0c674;word-break:break-word;line-height:1.6}
@media (max-width:980px){.grid,.form-grid,.publish-grid,.split,.guide-grid,.summary-cards{grid-template-columns:1fr}}
</style></head><body>
<div class="header"><div><h1 data-i18n="appName">PrivateTunnel</h1><p class="subtitle"><span class="dot"></span><span data-i18n="heroPrefix">Server dashboard on</span> <span id="serverLabel">loading...</span><br><span class="mini"><span data-i18n="adminPath">Admin path</span>: ${escapeHtml(routes.adminBasePath || '/')} | <span data-i18n="clientWs">Client WS</span>: <span id="wsLabel">loading...</span></span></p></div><div class="header-actions"><div class="lang-switch"><button type="button" data-lang="en"></button><button type="button" data-lang="th"></button></div><a href="${routes.adminLogoutPath}" class="logout" data-i18n="logout">Logout</a></div></div>
<div class="stats">
<div class="stat"><div class="label" data-i18n="statActiveTunnels">Active Tunnels</div><div class="val" id="sTunnels">0</div></div>
<div class="stat"><div class="label" data-i18n="statTotalRequests">Total Requests</div><div class="val" id="sRequests">0</div></div>
<div class="stat"><div class="label" data-i18n="statBandwidthIn">Bandwidth In</div><div class="val" id="sBytesIn">0</div></div>
<div class="stat"><div class="label" data-i18n="statBandwidthOut">Bandwidth Out</div><div class="val" id="sBytesOut">0</div></div>
<div class="stat"><div class="label" data-i18n="statUptime">Uptime</div><div class="val" id="sUptime">-</div></div>
</div>
<div class="tabs">
<div class="tab active" data-tab="tunnels" data-i18n="tabTunnels">Active Tunnels</div>
<div class="tab" data-tab="logs" data-i18n="tabLogs">Request Logs</div>
<div class="tab" data-tab="clients" data-i18n="tabClients">All Clients</div>
<div class="tab" data-tab="settings" data-i18n="tabSettings">Server Settings</div>
<div class="tab" data-tab="guide" data-i18n="tabGuide">Setup Guide</div>
</div>
<div class="panel active" id="pTunnels"><div class="panel-head"><div><h2 data-i18n="tabTunnels">Active Tunnels</h2><div class="sub" data-i18n="tunnelsNote">Optimized for scanning active tunnels quickly, even when many clients are online.</div></div><div class="panel-meta" id="tunnelMeta"></div></div><div class="panel-pad"><div class="toolbar"><div class="toolbar-main"><input id="tunnelSearch" class="search" data-i18n-placeholder="searchTunnels" placeholder="Search active tunnels"><select id="tunnelPageSize" class="select"><option>25</option><option>50</option><option>100</option></select></div><div class="toolbar-side"><span class="range-label" id="tunnelRange"></span><div class="pager"><button type="button" id="tunnelPrev" data-i18n="prev">Prev</button><span class="page-label" id="tunnelPage"></span><button type="button" id="tunnelNext" data-i18n="next">Next</button></div></div></div></div><div class="table-wrap"><table><thead><tr><th data-i18n="colPublicHost">Public Host</th><th data-i18n="colClientIp">Client IP</th><th data-i18n="colHostname">Hostname</th><th data-i18n="colOs">OS</th><th data-i18n="colPort">Port</th><th data-i18n="colRequests">Reqs</th><th data-i18n="colBandwidth">Bytes In/Out</th><th data-i18n="colConnected">Connected</th></tr></thead><tbody id="tTunnels"><tr><td colspan="8" class="empty">No active tunnels</td></tr></tbody></table></div></div>
<div class="panel" id="pLogs"><div class="panel-head"><div><h2 data-i18n="tabLogs">Request Logs</h2><div class="sub" data-i18n="logsNote">Searchable, paginated recent traffic view for high-volume hosts.</div></div><div class="panel-meta" id="logMeta"></div></div><div class="panel-pad"><div class="toolbar"><div class="toolbar-main"><input id="logSearch" class="search" data-i18n-placeholder="searchLogs" placeholder="Search request logs"><select id="logPageSize" class="select"><option>25</option><option>50</option><option>100</option></select></div><div class="toolbar-side"><span class="range-label" id="logRange"></span><div class="pager"><button type="button" id="logPrev" data-i18n="prev">Prev</button><span class="page-label" id="logPage"></span><button type="button" id="logNext" data-i18n="next">Next</button></div></div></div></div><div class="table-wrap"><table><thead><tr><th data-i18n="colTime">Time</th><th data-i18n="colHost">Host</th><th data-i18n="colVisitorIp">Visitor IP</th><th data-i18n="colMethod">Method</th><th data-i18n="colPath">Path</th><th data-i18n="colStatus">Status</th><th data-i18n="colLatency">Latency</th><th data-i18n="colUserAgent">User-Agent</th></tr></thead><tbody id="tLogs"><tr><td colspan="8" class="empty">No requests yet</td></tr></tbody></table></div></div>
<div class="panel" id="pClients"><div class="panel-head"><div><h2 data-i18n="tabClients">All Clients</h2><div class="sub" data-i18n="clientsNote">Review assigned hosts, publish modes, and client metadata without rendering every row at once.</div></div><div class="panel-meta" id="clientMeta"></div></div><div class="panel-pad"><div class="toolbar"><div class="toolbar-main"><input id="clientSearch" class="search" data-i18n-placeholder="searchClients" placeholder="Search clients"><select id="clientPageSize" class="select"><option>25</option><option>50</option><option>100</option></select></div><div class="toolbar-side"><span class="range-label" id="clientRange"></span><div class="pager"><button type="button" id="clientPrev" data-i18n="prev">Prev</button><span class="page-label" id="clientPage"></span><button type="button" id="clientNext" data-i18n="next">Next</button></div></div></div></div><div class="table-wrap"><table><thead><tr><th data-i18n="colClientId">Client ID</th><th data-i18n="colPublicHost">Public Host</th><th data-i18n="colDomain">Domain</th><th data-i18n="colMode">Mode</th><th data-i18n="colLabel">Label</th><th data-i18n="colIp">IP</th><th data-i18n="colHostname">Hostname</th><th data-i18n="colOs">OS</th><th data-i18n="colLastSeen">Last Seen</th></tr></thead><tbody id="tClients"><tr><td colspan="9" class="empty">No clients</td></tr></tbody></table></div></div>
<div class="panel" id="pSettings"><div class="panel-head"><div><h2 data-i18n="tabSettings">Server Settings</h2><div class="sub" data-i18n="settingsNote">Server-side management for hosters: domains, control route, token, and publish behavior.</div></div></div><div class="panel-pad"><div class="split"><div class="grid"><div class="box"><h2 data-i18n="boxWarnings">Warnings</h2><div id="warnings"></div></div><div class="box"><h2 data-i18n="boxSnippets">Quick Snippets</h2><div class="sub" data-i18n="snippetsSub">Generated from current server settings.</div><div class="sub" style="margin-top:10px" data-i18n="snippetAdminUrl">Admin URL</div><code id="snippetAdminUrl">-</code><div class="sub" style="margin-top:10px" data-i18n="snippetClientWs">Client WebSocket</div><code id="snippetWsUrl">-</code><div class="sub" style="margin-top:10px" data-i18n="snippetLegacyWs">Legacy WebSocket</div><code id="snippetLegacyWsUrl">-</code><div class="sub" style="margin-top:10px" data-i18n="snippetTunnelPattern">Tunnel Pattern</div><code id="snippetTunnelPattern">-</code><div class="sub" style="margin-top:10px" data-i18n="snippetClientCommands">Client Commands</div><pre id="snippetClient">-</pre><div class="sub" style="margin-top:10px" data-i18n="snippetDnsRecords">DNS Records</div><pre id="snippetDns">-</pre><div class="sub" style="margin-top:10px" data-i18n="snippetNginxSummary">Nginx Routing Summary</div><pre id="snippetNginx">-</pre></div></div><div class="grid"><div class="box"><h2 data-i18n="boxServerSettings">Server Settings</h2><form id="settingsForm"><div class="form-grid"><div class="field"><label for="primary-domain" data-i18n="fieldPrimaryDomain">Primary Domain</label><input id="primary-domain" data-i18n-placeholder="placeholderPrimaryDomain" placeholder="ex.example.com"></div><div class="field"><label for="control-root" data-i18n="fieldControlRoot">Control Root</label><input id="control-root" data-i18n-placeholder="placeholderControlRoot" placeholder="/_private-tunnel"></div><div class="field full"><label for="tunnel-token" data-i18n="fieldTunnelToken">Tunnel Token</label><input id="tunnel-token" data-i18n-placeholder="placeholderTunnelToken" placeholder="Recommended"></div><div class="field full"><label data-i18n="fieldPublishDomains">Publish Domains</label><div id="publishList" class="publish-list"></div><div class="actions"><button id="addPublishDomain" class="btn secondary" type="button" data-i18n="addPublishDomain">Add Publish Domain</button></div><small class="muted" data-i18n="publishDomainsHelp">Add or remove publish domains freely. Each domain can enable random subdomains, exact root publishing, or both.</small></div></div><div class="actions"><button class="btn primary" id="saveBtn" type="submit" data-i18n="saveSettings">Save Settings</button><span class="status" id="settingsStatus">Settings are stored in the primary database.</span></div></form></div><div class="box"><h2 data-i18n="boxAdminPassword">Admin Password</h2><form id="passwordForm"><div class="field"><label for="admin-password" data-i18n="fieldNewPassword">New Password</label><input id="admin-password" type="password" data-i18n-placeholder="placeholderPassword" placeholder="At least 10 characters"><small data-i18n="passwordHelp">Stored as a hash. Rotate the bootstrap password after first login.</small></div><div class="actions"><button class="btn danger" type="submit" data-i18n="rotatePassword">Rotate Admin Password</button><span class="status" id="passwordStatus">Use a unique password for the hoster account.</span></div></form></div></div></div></div></div>
<div class="panel" id="pGuide"><div class="panel-head"><div><h2 data-i18n="guideTitle">Setup Guide</h2><div class="sub" data-i18n="guideNote">Separate operational guide for nginx, DNS, SSL, and publishing modes.</div></div></div><div class="panel-pad"><div class="summary-cards"><div class="summary-card"><span class="k" data-i18n="snippetAdminUrl">Admin URL</span><div class="v" id="guideAdminUrl">-</div></div><div class="summary-card"><span class="k" data-i18n="snippetClientWs">Client WebSocket</span><div class="v" id="guideWsUrl">-</div></div><div class="summary-card"><span class="k" data-i18n="snippetTunnelPattern">Tunnel Pattern</span><div class="v" id="guideTunnelPattern">-</div></div></div><div class="guide-grid"><div class="box"><h2 data-i18n="snippetDnsRecords">DNS Records</h2><pre id="guideDns">-</pre></div><div class="box"><h2 data-i18n="snippetClientCommands">Client Commands</h2><pre id="guideClient">-</pre></div><div class="box full"><h2 data-i18n="snippetNginxSummary">Nginx Routing Summary</h2><pre id="guideRouting">-</pre></div><div class="box full"><h2 data-i18n="guideFullTitle">Bilingual Nginx Setup Guide</h2><pre id="nginxPreview" data-i18n="loadingGuide">Nginx setup guide will appear here.</pre></div></div></div></div>
<script>
const ROUTES=${JSON.stringify(routes)};
const INITIAL_OVERVIEW=${JSON.stringify(initialOverview || null)};
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
let currentLang=(localStorage.getItem(LANG_KEY)==='th')?'th':'en';
const tableState={tunnel:{page:1,pageSize:25},log:{page:1,pageSize:25},client:{page:1,pageSize:25}};
function el(id){return document.getElementById(id);}function create(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=String(text);return node;}function t(key,vars){let value=(I18N[currentLang]&&I18N[currentLang][key])||I18N.en[key]||key;if(!vars)return value;Object.keys(vars).forEach((name)=>{value=value.replace(new RegExp('\\{' + name + '\\}','g'),String(vars[name]));});return value;}function fmtBytes(value){const b=Number(value)||0;if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(1)+' GB';}function fmtTime(value){if(!value)return '-';return new Date(value).toLocaleString(LOCALE_MAP[currentLang]||'en-US');}function statusClass(status){const s=Number(status)||0;if(s>=500)return's5';if(s>=400)return's4';if(s>=300)return's3';return's2';}function clean(value){return String(value||'').trim();}function normalizeDomain(value){return clean(value).toLowerCase().replace(/^[a-z]+:\\/\\//,'').split('/')[0].replace(/:\\d+$/,'').replace(/\\.+$/,'');}function normalizeControlRoot(value){let next=clean(value).toLowerCase();if(!next)return'';if(!next.startsWith('/'))next='/'+next;next=next.replace(/\\/+/g,'/');if(next.length>1&&next.endsWith('/'))next=next.slice(0,-1);return /^\\/[a-z0-9/_-]+$/.test(next)?next:'';}function queryMatch(query,values){if(!query)return true;return values.filter(Boolean).join(' ').toLowerCase().includes(query);}function setText(id,value,fallback){const target=el(id);if(!target)return;const next=value==null||value===''?(fallback==null?'-':fallback):value;target.textContent=String(next);}function rememberMessage(id,key,text){const target=el(id);if(!target)return;if(key){target.dataset.messageKey=key;delete target.dataset.messageText;target.textContent=t(key);return;}delete target.dataset.messageKey;target.dataset.messageText=String(text||'');target.textContent=translateRuntimeText(text);}function refreshRememberedMessage(id,fallbackKey){const target=el(id);if(!target)return;if(target.dataset.messageKey){target.textContent=t(target.dataset.messageKey);return;}if(target.dataset.messageText){target.textContent=translateRuntimeText(target.dataset.messageText);return;}target.textContent=t(fallbackKey);}function translateRuntimeText(message){const text=String(message||'');if(!text)return '';if(currentLang!=='th')return text;if(text==='Invalid password')return 'รหัสผ่านไม่ถูกต้อง';if(text==='Unauthorized')return 'ยังไม่ได้รับอนุญาต';if(text==='Not found')return 'ไม่พบเส้นทางที่ร้องขอ';if(text==='Database has not been initialized yet')return 'ฐานข้อมูลยังไม่พร้อมใช้งาน';if(text==='Admin password must be at least 10 characters long')return 'รหัสผ่านแอดมินต้องยาวอย่างน้อย 10 ตัวอักษร';if(text==='Primary domain must be a valid hostname')return 'Primary domain ต้องเป็น hostname ที่ถูกต้อง';if(text==='Control namespace must be a safe path like /_private-tunnel')return 'Control namespace ต้องเป็น path ที่ปลอดภัย เช่น /_private-tunnel';if(text==='Publish domains must be an array')return 'Publish domains ต้องเป็นรายการแบบ array';if(text==='Tunnel domain must be a valid hostname')return 'Tunnel domain ต้องเป็น hostname ที่ถูกต้อง';if(text==='Primary domain is not configured yet. Set it before sharing the admin UI or client WebSocket endpoint.')return 'ยังไม่ได้ตั้งค่า Primary domain ควรกำหนดก่อนแชร์หน้าแอดมินหรือ WebSocket สำหรับ client';if(text==='Control namespace is empty. Use a dedicated path such as /_private-tunnel.')return 'Control namespace ยังว่างอยู่ ควรใช้ path เฉพาะ เช่น /_private-tunnel';if(text==='No publish domains are configured yet. Clients cannot receive public URLs until you add at least one domain.')return 'ยังไม่มี publish domains ดังนั้น client จะยังไม่ได้ public URL จนกว่าจะเพิ่มอย่างน้อยหนึ่งโดเมน';if(text==='Tunnel token is empty. Any client that knows your WebSocket URL can open tunnels.')return 'Tunnel token ยังว่างอยู่ หากใครรู้ WebSocket URL ก็อาจเปิด tunnel ได้';if(text==='Tunnel token is still using the example placeholder value. Replace it with a real secret and update saved client configs.')return 'Tunnel token ยังใช้ค่า placeholder ตัวอย่างอยู่ ควรเปลี่ยนเป็น secret จริงและอัปเดต config ของ client ที่บันทึกไว้';if(text==='This installation is still using the old default admin password from previous versions. Rotate it immediately from the Admin Password panel.')return 'ระบบนี้ยังใช้รหัสผ่านแอดมินค่าเริ่มต้นจากเวอร์ชันเก่า ควรเปลี่ยนทันทีในส่วน Admin Password';if(text==='No publish domain currently allows random subdomains. HTTP clients must explicitly choose a root domain, and only root-enabled domains will work.')return 'ตอนนี้ยังไม่มี publish domain ที่อนุญาต random subdomain ดังนั้น HTTP client ต้องเลือก root domain แบบชัดเจน และใช้ได้เฉพาะโดเมนที่เปิด root mode';if(text==='The primary domain root is reserved for the control plane. Root publishing on the primary domain has been disabled automatically.')return 'root ของ primary domain ถูกสงวนไว้ให้ control plane แล้ว ระบบจึงปิด root publishing บนโดเมนหลักให้อัตโนมัติ';if(text==='Some publish domains live outside the primary DNS zone. Make sure those extra domains also point to this server and have valid TLS certificates.')return 'มีบาง publish domains อยู่คนนอก primary DNS zone กรุณาตรวจว่าโดเมนเหล่านั้นชี้มาที่เซิร์ฟเวอร์นี้และมี TLS certificate ที่ใช้งานได้';if(text==='Set your primary domain and at least one publish domain first, then this panel will generate DNS records to copy.')return 'ตั้งค่า primary domain และเพิ่มอย่างน้อยหนึ่ง publish domain ก่อน แล้วแผงนี้จะสร้าง DNS records ให้คัดลอกได้';if(text==='Set a primary domain first. The client WebSocket URL will appear here automatically.')return 'ตั้งค่า primary domain ก่อน แล้ว URL ของ Client WebSocket จะปรากฏตรงนี้อัตโนมัติ';const bootstrapPrefix='A bootstrap admin password is still available on disk at ';const bootstrapSuffix='. Rotate it after your first successful login.';if(text.startsWith(bootstrapPrefix)&&text.endsWith(bootstrapSuffix)){const filePath=text.slice(bootstrapPrefix.length,text.length-bootstrapSuffix.length);return 'ยังมี bootstrap admin password เก็บอยู่บนดิสก์ที่ ' + filePath + ' ควรเปลี่ยนรหัสผ่านหลังล็อกอินสำเร็จครั้งแรก';}if(/ is required$/.test(text)){return text.replace(/ is required$/,' จำเป็นต้องกรอก');}if(/ contains invalid characters$/.test(text)){return text.replace(/ contains invalid characters$/,' มีอักขระที่ไม่ปลอดภัย');}return text;}function applyI18n(){document.documentElement.lang=currentLang;document.title=t('dashboardTitle');document.querySelectorAll('[data-i18n]').forEach((node)=>{node.textContent=t(node.getAttribute('data-i18n'));});document.querySelectorAll('[data-i18n-placeholder]').forEach((node)=>{node.placeholder=t(node.getAttribute('data-i18n-placeholder'));});document.querySelectorAll('[data-lang]').forEach((button)=>{const lang=button.getAttribute('data-lang');button.classList.toggle('active',lang===currentLang);button.textContent=lang==='th'?t('langThai'):t('langEnglish');});}function updateUptime(){const seconds=Math.max(0,Number(uptimeSeconds)||0);const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60);setText('sUptime',h>0?h+t('uptimeHours')+' '+m+t('uptimeMinutes'):m+t('uptimeMinutes'));}function startUptime(){setInterval(()=>{uptimeSeconds+=1;updateUptime();},1000);}async function api(path,options){const nextOptions=Object.assign({credentials:'same-origin'},options||{});if(nextOptions.body){nextOptions.headers=Object.assign({'Content-Type':'application/json'},nextOptions.headers||{});}const response=await fetch(path,nextOptions);const raw=await response.text();let payload={};try{payload=raw?JSON.parse(raw):{};}catch{payload={message:translateRuntimeText(raw||t('requestFailed'))};}if(response.status===401){location.assign(currentRoutes.adminLoginPath);throw new Error(t('sessionExpired'));}if(!response.ok)throw new Error(translateRuntimeText(payload.error||payload.message||t('requestFailed')));return payload;}function switchTab(name){document.querySelectorAll('.tab').forEach((item)=>item.classList.toggle('active',item.getAttribute('data-tab')===name));document.querySelectorAll('.panel').forEach((item)=>item.classList.remove('active'));const target=el('p'+name.charAt(0).toUpperCase()+name.slice(1));if(target)target.classList.add('active');if(name==='logs')loadLogs();if(name==='clients')loadClients();if(name==='settings')renderSettings();if(name==='guide')renderGuide();}function pagerInfo(name,total){const pageCount=Math.max(1,Math.ceil(total/tableState[name].pageSize));if(tableState[name].page>pageCount)tableState[name].page=pageCount;const start=total?((tableState[name].page-1)*tableState[name].pageSize)+1:0;const end=Math.min(total,tableState[name].page*tableState[name].pageSize);setText(name+'Range',total?t('showingRows',{from:start,end:end,total:total}):t('showingRowsEmpty'));setText(name+'Page',t('pageStatus',{page:tableState[name].page,total:pageCount}));setText(name+'Meta',t('loadedRows',{count:total}));el(name+'Prev').disabled=tableState[name].page<=1;el(name+'Next').disabled=tableState[name].page>=pageCount;}function pageSlice(name,rows){pagerInfo(name,rows.length);const start=(tableState[name].page-1)*tableState[name].pageSize;return rows.slice(start,start+tableState[name].pageSize);}
function renderTunnels(){const tbody=el('tTunnels');tbody.replaceChildren();const query=clean(el('tunnelSearch').value).toLowerCase();const rows=(tunnelData||[]).filter((item)=>queryMatch(query,[item.publicHost,item.subdomain,item.publishDomain,item.clientIp,item.hostname,item.os,item.localPort]));const pageRows=pageSlice('tunnel',rows);setText('sTunnels',rows.length);if(!pageRows.length){const tr=create('tr');const td=create('td','empty',t('noActiveTunnels'));td.colSpan=8;tr.appendChild(td);tbody.appendChild(tr);return;}pageRows.forEach((item)=>{const tr=create('tr');const hostTd=create('td');hostTd.appendChild(create('span','badge',item.publicHost||item.subdomain||'-'));tr.appendChild(hostTd);tr.appendChild(create('td','ip',item.clientIp||'-'));tr.appendChild(create('td','',item.hostname||'-'));tr.appendChild(create('td','',item.os||'-'));tr.appendChild(create('td','',item.localPort||'-'));tr.appendChild(create('td','',item.connections||0));tr.appendChild(create('td','',fmtBytes(item.bytesIn)+' / '+fmtBytes(item.bytesOut)));tr.appendChild(create('td','',fmtTime(item.connectedAt)));tbody.appendChild(tr);});}
function renderLogs(){const tbody=el('tLogs');tbody.replaceChildren();const query=clean(el('logSearch').value).toLowerCase();const rows=(logsData||[]).filter((item)=>queryMatch(query,[item.host,item.subdomain,item.visitor_ip,item.method,item.path,item.status_code,item.user_agent]));const pageRows=pageSlice('log',rows);if(!pageRows.length){const tr=create('tr');const td=create('td','empty',t('noRequests'));td.colSpan=8;tr.appendChild(td);tbody.appendChild(tr);return;}pageRows.forEach((item)=>{const tr=create('tr');tr.appendChild(create('td','',fmtTime(item.created_at)));const hostTd=create('td');hostTd.appendChild(create('span','badge',item.host||item.subdomain||'-'));tr.appendChild(hostTd);tr.appendChild(create('td','ip',item.visitor_ip||'-'));tr.appendChild(create('td','method',item.method||'-'));tr.appendChild(create('td','',item.path||'-'));tr.appendChild(create('td',statusClass(item.status_code),item.status_code||'-'));tr.appendChild(create('td','',(item.latency_ms||'-')+'ms'));tr.appendChild(create('td','',item.user_agent||'-'));tbody.appendChild(tr);});}
function renderClients(){const tbody=el('tClients');tbody.replaceChildren();const query=clean(el('clientSearch').value).toLowerCase();const rows=(clientsData||[]).filter((item)=>queryMatch(query,[item.client_id,item.assigned_host,item.publish_domain,item.publish_mode,item.subdomain,item.ip,item.hostname,item.os,item.last_seen]));const pageRows=pageSlice('client',rows);if(!pageRows.length){const tr=create('tr');const td=create('td','empty',t('noClients'));td.colSpan=9;tr.appendChild(td);tbody.appendChild(tr);return;}pageRows.forEach((item)=>{const tr=create('tr');tr.appendChild(create('td','',item.client_id?item.client_id.slice(0,12)+'...':'-'));const hostTd=create('td');hostTd.appendChild(create('span','badge',item.assigned_host||'-'));tr.appendChild(hostTd);tr.appendChild(create('td','',item.publish_domain||'-'));tr.appendChild(create('td','',item.publish_mode||'-'));tr.appendChild(create('td','',item.subdomain||'-'));tr.appendChild(create('td','ip',item.ip||'-'));tr.appendChild(create('td','',item.hostname||'-'));tr.appendChild(create('td','',item.os||'-'));tr.appendChild(create('td','',fmtTime(item.last_seen)));tbody.appendChild(tr);});}
function createPublishRow(entry){const wrapper=create('div','publish-row');wrapper.innerHTML='<div class="publish-head"><input class="publish-domain" placeholder="devshop.com"><button type="button" class="btn secondary remove-publish"></button></div><div class="publish-checks"><label><input type="checkbox" class="publish-subdomain"> <span class="publish-subdomain-label"></span></label><label><input type="checkbox" class="publish-root"> <span class="publish-root-label"></span></label></div>';wrapper.querySelector('.publish-domain').value=(entry&&entry.domain)||'';wrapper.querySelector('.publish-subdomain').checked=entry?entry.allowSubdomain!==false:true;wrapper.querySelector('.publish-root').checked=entry?entry.allowRoot===true:false;wrapper.querySelector('.remove-publish').textContent=t('remove');wrapper.querySelector('.publish-subdomain-label').textContent=t('randomSubdomains');wrapper.querySelector('.publish-root-label').textContent=t('exactRootHost');wrapper.querySelector('.remove-publish').addEventListener('click',()=>wrapper.remove());return wrapper;}
function renderWarnings(list){const target=el('warnings');target.replaceChildren();const items=Array.isArray(list)?list:[];if(!items.length){target.appendChild(create('div','ok',t('warningHealthy')));return;}items.forEach((item)=>target.appendChild(create('div','warning',translateRuntimeText(item))));}
function renderSettings(){if(!overview)return;const settings=overview.settings||{};const snippets=overview.snippets||{};setText('serverLabel',settings.primaryDomain||settings.tunnelDomain||'',t('waitingConfig'));setText('wsLabel',snippets.websocketUrl||'',t('notConfigured'));el('primary-domain').value=settings.primaryDomain||'';el('control-root').value=settings.controlRoot||'';el('tunnel-token').value=settings.tunnelToken||'';renderWarnings(overview.warnings||[]);setText('snippetAdminUrl',snippets.adminUrl||'',t('notConfigured'));setText('snippetWsUrl',snippets.websocketUrl||'',t('notConfigured'));setText('snippetLegacyWsUrl',snippets.legacyWebsocketUrl||'',t('notConfigured'));setText('snippetTunnelPattern',snippets.tunnelPattern||'',t('notConfigured'));setText('snippetClient',snippets.client||'',t('waitingConfig'));setText('snippetDns',snippets.dns||'',t('waitingConfig'));setText('snippetNginx',snippets.nginx||'',t('waitingConfig'));setText('guideAdminUrl',snippets.adminUrl||'',t('notConfigured'));setText('guideWsUrl',snippets.websocketUrl||'',t('notConfigured'));setText('guideTunnelPattern',snippets.tunnelPattern||'',t('notConfigured'));setText('guideDns',snippets.dns||'',t('waitingConfig'));setText('guideClient',snippets.client||'',t('waitingConfig'));setText('guideRouting',snippets.nginx||'',t('waitingConfig'));setText('nginxPreview',snippets.nginxGuide||'',t('loadingGuide'));const publishList=el('publishList');publishList.replaceChildren();const domains=Array.isArray(settings.publishDomains)?settings.publishDomains:[];if(!domains.length){publishList.appendChild(createPublishRow({}));}else{domains.forEach((item)=>publishList.appendChild(createPublishRow(item)));}refreshRememberedMessage('settingsStatus','settingsStored');refreshRememberedMessage('passwordStatus','passwordUnique');}
function renderGuide(){renderSettings();}
function updateStats(data){const totals=(data&&data.live&&data.live.totals)||(data&&data.totals)||{};setText('sTunnels',totals.activeTunnels||0);setText('sRequests',totals.totalRequests||0);setText('sBytesIn',fmtBytes(totals.totalBytesIn||0));setText('sBytesOut',fmtBytes(totals.totalBytesOut||0));if(Number.isFinite(Number(totals.uptimeSeconds)))uptimeSeconds=Number(totals.uptimeSeconds);updateUptime();}
function applyOverview(data){if(!data)return;overview=data;currentRoutes=Object.assign({},currentRoutes,data.routes||{});tunnelData=(data.live&&data.live.tunnels)||[];updateStats(data);renderTunnels();renderLogs();renderClients();renderSettings();}
async function loadOverview(){applyOverview(await api(currentRoutes.adminApiBasePath + '/overview'));}async function loadLogs(){const data=await api(currentRoutes.adminApiBasePath + '/logs');logsData=data.logs||[];renderLogs();}async function loadClients(){const data=await api(currentRoutes.adminApiBasePath + '/clients');clientsData=data.clients||[];renderClients();}
function collectPublishDomains(){return [...document.querySelectorAll('.publish-row')].map((row)=>({domain:normalizeDomain(row.querySelector('.publish-domain').value),allowSubdomain:row.querySelector('.publish-subdomain').checked,allowRoot:row.querySelector('.publish-root').checked})).filter((item)=>item.domain);}async function submitSettings(){const saveBtn=el('saveBtn');const previousAdminPath=currentRoutes.adminBasePath;const previousPrimary=(overview&&overview.settings&&overview.settings.primaryDomain)||location.hostname;saveBtn.disabled=true;saveBtn.textContent=t('saving');try{const payload={primaryDomain:normalizeDomain(el('primary-domain').value),controlRoot:normalizeControlRoot(el('control-root').value),tunnelToken:clean(el('tunnel-token').value),publishDomains:collectPublishDomains()};const response=await api(currentRoutes.adminApiBasePath + '/settings',{method:'POST',body:JSON.stringify(payload)});applyOverview(response.overview||null);rememberMessage('settingsStatus','settingsSaved');const nextRoutes=response.routes||{};const nextAdminPath=nextRoutes.adminBasePath||currentRoutes.adminBasePath;const nextPrimary=(response.settings&&response.settings.primaryDomain)||previousPrimary;if(nextAdminPath!==previousAdminPath){location.assign(nextAdminPath);return;}if(nextPrimary&&nextPrimary!==previousPrimary){location.assign('https://' + nextPrimary + nextAdminPath);return;}await Promise.all([loadLogs().catch(()=>{}),loadClients().catch(()=>{})]);}catch(error){rememberMessage('settingsStatus',null,error.message);}finally{saveBtn.disabled=false;saveBtn.textContent=t('saveSettings');}}
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

initDashboard();
</script></body></html>`;
}

function createDashboard(tunnelManager, runtimeConfig, options = {}) {
  const dashClients = new Set();
  const refreshRuntimeConfig = typeof options.refreshRuntimeConfig === 'function'
    ? options.refreshRuntimeConfig
    : (() => runtimeConfig);
  const ports = options.ports || {};
  const getRoutes = () => buildRuntimeRoutes(runtimeConfig);

  const server = http.createServer(async (req, res) => {
    const routes = getRoutes();
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === routes.adminLoginPath && req.method === 'GET') {
      sendHtml(res, getLoginHTML(routes));
      return;
    }

    if (pathname === routes.adminLoginPath && req.method === 'POST') {
      const raw = await parseBody(req);
      const params = new URLSearchParams(raw);
      const password = params.get('password');

      if (!await verifyPassword(password)) {
        sendHtml(res, getLoginHTML(routes, 'Invalid password'));
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

    if (pathname === routes.adminBasePath || pathname === `${routes.adminBasePath}/`) {
      sendHtml(res, getDashboardHTML(routes, await buildOverview(tunnelManager, runtimeConfig, routes, ports)));
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

    if (pathname === `${routes.adminApiBasePath}/settings` && req.method === 'POST') {
      try {
        const payload = await parseJsonBody(req);
        const nextSettings = await prepareServerSettings(payload, runtimeConfig);
        await updateServerSettings(nextSettings);
        await refreshRuntimeConfig();
        const nextRoutes = getRoutes();
        sendJson(res, 200, {
          ok: true,
          settings: runtimeConfig,
          routes: nextRoutes,
          overview: await buildOverview(tunnelManager, runtimeConfig, nextRoutes, ports),
        });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    if (pathname === `${routes.adminApiBasePath}/password` && req.method === 'POST') {
      try {
        const payload = await parseJsonBody(req);
        await setDashboardPassword(payload.password || '');
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  const wss = new WebSocketServer({ noServer: true });
  let lastLivePayload = '';

  server.on('upgrade', (req, socket, head) => {
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
    if (!isAuthenticated(req)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    dashClients.add(ws);
    ws.on('close', () => dashClients.delete(ws));
    ws.on('error', () => dashClients.delete(ws));

    try {
      ws.send(JSON.stringify({
        type: 'live',
        live: await collectLiveData(tunnelManager, runtimeConfig),
      }));
    } catch {}
  });

  let liveBroadcastInFlight = false;
  setInterval(() => {
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
          try { ws.send(payload); } catch {}
        }
      }
    })().catch(() => {
    }).finally(() => {
      liveBroadcastInFlight = false;
    });
  }, 2000);

  return server;
}

module.exports = { createDashboard };


