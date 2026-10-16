const { buildRuntimeRoutes, normalizeControlRoot, normalizeDomain, isValidDomain } = require('./routing');

function checkedPort(value, fallback) {
  const port = value == null ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid upstream port');
  return port;
}

function proxyLocation(path, port, { websocket = false, streaming = false } = {}) {
  return [
    `    location ${path} {`,
    `        proxy_pass http://127.0.0.1:${port};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $remote_addr;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    ...(websocket ? [
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection $pt_connection_upgrade;',
      '        proxy_read_timeout 3600s;',
      '        proxy_send_timeout 3600s;',
    ] : []),
    ...(streaming ? ['        proxy_buffering off;', '        proxy_request_buffering off;'] : []),
    '    }',
  ].join('\n');
}

function tlsServer(names, certificateName, locations) {
  return [
    'server {',
    '    listen 443 ssl;',
    '    http2 on; # Nginx 1.25.1+; remove this line on older installations.',
    `    server_name ${names.join(' ')};`,
    `    ssl_certificate /REPLACE_WITH_CERT_DIRECTORY/${certificateName}/fullchain.pem;`,
    `    ssl_certificate_key /REPLACE_WITH_CERT_DIRECTORY/${certificateName}/privkey.pem;`,
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '    client_max_body_size 32m;',
    '',
    ...locations,
    '}',
  ].join('\n');
}

// Generates a manual template only. Never reads certificates or changes Nginx on disk.
function buildNginxConfig(runtimeConfig = {}, routes = {}, ports = {}) {
  const primaryDomain = normalizeDomain(runtimeConfig.primaryDomain);
  if (!isValidDomain(primaryDomain)) return '# Configure a valid primary admin domain first. / ตั้งค่าโดเมนแอดมินก่อน';
  const controlRoot = normalizeControlRoot(routes.controlRoot || runtimeConfig.controlRoot);
  if ((routes.controlRoot || runtimeConfig.controlRoot) && !controlRoot) throw new TypeError('Invalid control root');
  const resolvedRoutes = buildRuntimeRoutes({ controlRoot: controlRoot || undefined });
  const wsPort = checkedPort(ports.wsPort, 8080);
  const dashboardPort = checkedPort(ports.dashboardPort, 8081);
  const proxyPort = checkedPort(ports.proxyPort, 8082);
  const publishEntries = [];
  const seen = new Set();
  for (const entry of runtimeConfig.publishDomains || []) {
    const domain = normalizeDomain(entry && entry.domain);
    if (!isValidDomain(domain) || seen.has(domain)) continue;
    seen.add(domain);
    const names = [];
    if (entry.allowRoot && domain !== primaryDomain) names.push(domain);
    if (entry.allowSubdomain) names.push(`*.${domain}`);
    if (names.length) publishEntries.push({ domain, names });
  }
  const redirects = [primaryDomain, ...publishEntries.flatMap((entry) => entry.names)];
  const denyControl = [
    `    location = ${resolvedRoutes.controlRoot} { return 404; }`,
    `    location ^~ ${resolvedRoutes.controlRoot}/ { return 404; }`,
  ];
  const adminLocations = [
    `    location = / { return 302 ${resolvedRoutes.adminBasePath}; }`,
    ...denyControl,
    proxyLocation(`= ${resolvedRoutes.tunnelWsPath}`, wsPort, { websocket: true }),
    proxyLocation(`= ${resolvedRoutes.legacyTunnelWsPath}`, wsPort, { websocket: true }),
    proxyLocation(`= ${resolvedRoutes.adminBasePath}`, dashboardPort, { websocket: true }),
    proxyLocation(`^~ ${resolvedRoutes.adminBasePath}/`, dashboardPort, { websocket: true }),
    '    location / { return 404; }',
  ];
  return [
    '# Manual template / ตัวอย่างสำหรับผู้ดูแล: put these directives in the http context.',
    '# Replace every certificate placeholder before nginx -t, then reload Nginx.',
    '# Linux PEM example: /etc/letsencrypt/live/your-certificate-name/fullchain.pem',
    '# Windows PEM example: C:/nginx/certs/your-certificate-name/fullchain.pem',
    '# Wildcard certificates require DNS-01 validation; automate DNS validation and renewal.',
    '# A wildcard certificate does not cover the bare domain: include both names if needed.',
    '# Keep ports 8080/8081/8082 private. This template assumes Nginx runs on the same host.',
    '# Public application WebSocket passthrough is not supported by the tunnel protocol.',
    'map $http_upgrade $pt_connection_upgrade {',
    '    default upgrade;',
    "    '' close;",
    '}',
    '',
    'server {',
    '    listen 80;',
    `    server_name ${redirects.join(' ')};`,
    '    return 301 https://$host$request_uri;',
    '}',
    '',
    '# Exact admin host only. Wildcards always use a separate publish block.',
    tlsServer([primaryDomain], primaryDomain, adminLocations),
    ...publishEntries.map(({ domain, names }) => [
      '',
      '# Publish host: control paths are reserved and rejected on this host.',
      tlsServer(names, domain, [...denyControl, proxyLocation('/', proxyPort, { streaming: true })]),
    ].join('\n')),
    '',
  ].join('\n');
}

module.exports = { buildNginxConfig };
