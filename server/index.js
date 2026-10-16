require('dotenv').config();
const http = require('node:http');
const { WebSocketServer } = require('ws');
const TunnelManager = require('./tunnel-manager');
const { handleProxy } = require('./proxy');
const { createDashboard } = require('./dashboard');
const { getLandingHTML } = require('./landing');
const { warnIfNotElevated } = require('./firewall');
const {
  initDatabase,
  getServerSettings,
  getBootstrapPasswordFilePath,
  isUsingLegacyPasswordHash,
  closeDatabase,
} = require('./db');
const { buildRuntimeRoutes, isExactHost, matchManagedHttpHost, normalizeDomain } = require('./routing');
const { isValidTunnelToken, clientIp, createAttemptLimiter, isAdminHost } = require('./security');
const { createAccessKeyStore } = require('./access-keys');
const { authenticatePrincipal } = require('./tunnel-identity');

warnIfNotElevated();

const WS_PORT = process.env.WS_PORT || 8080;
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 8081;
const PROXY_PORT = process.env.PROXY_PORT || 8082;
const INTERNAL_HOST = process.env.INTERNAL_HOST || '127.0.0.1';
const runtimeConfig = {
  requestIdleTimeoutMs: process.env.HTTP_IDLE_TIMEOUT_MS ?? 30000,
  requireDataTransportV4: process.env.REQUIRE_DATA_TRANSPORT_V4 !== 'false',
  tcpBindHost: process.env.TCP_BIND_HOST || undefined,
  tcpVisitorAllowlist: process.env.TCP_VISITOR_ALLOWLIST || '',
};
let tunnelWebSockets = null;

async function refreshRuntimeConfig() {
  const previousToken = runtimeConfig.tunnelToken;
  let settings;
  try {
    settings = await getServerSettings();
  } catch (error) {
    // A failed mirror write may follow a committed primary key rotation.
    // Without an authoritative reread, stop trusting cached credentials.
    runtimeConfig.tunnelAuthenticationDisabled = true;
    if (tunnelWebSockets) for (const ws of tunnelWebSockets.clients) ws.close(4001, 'Access key could not be verified.');
    throw error;
  }
  Object.assign(runtimeConfig, settings, buildRuntimeRoutes(settings), { tunnelAuthenticationDisabled: false });
  if (tunnelWebSockets && previousToken !== runtimeConfig.tunnelToken) {
    for (const ws of tunnelWebSockets.clients) {
      if (ws.tunnelPrincipal?.kind !== 'client-key') ws.close(4001, 'Access key changed.');
    }
  }
  return runtimeConfig;
}

function isLandingHost(hostname) {
  const host = normalizeDomain(hostname);
  if (!host) return true;
  if (isExactHost(host, runtimeConfig.primaryDomain)) return true;

  const publishDomains = Array.isArray(runtimeConfig.publishDomains) ? runtimeConfig.publishDomains : [];
  return publishDomains.some((entry) => isExactHost(host, entry.domain));
}

async function main() {
  await initDatabase();
  await refreshRuntimeConfig();
  const accessKeyStore = createAccessKeyStore();
  const allowSharedToken = process.env.ALLOW_SHARED_TUNNEL_TOKEN === 'true';
  runtimeConfig.sharedTunnelTokenEnabled = allowSharedToken;

  if (!allowSharedToken) {
    console.log('[Auth] Per-client keys enabled. Issue a client key from admin Settings. Shared tunnel key authentication is disabled.');
  } else if (!runtimeConfig.tunnelToken && process.env.ALLOW_UNAUTHENTICATED_TUNNELS === 'true') {
    console.warn('[Auth] WARNING: Tunnel token is not configured — clients can connect without authentication.');
  } else if (!isValidTunnelToken(runtimeConfig.tunnelToken)) {
    console.warn('[Auth] Tunnel connections are disabled until the access key is replaced in admin Settings (32–4096 characters, randomly generated).');
  } else {
    console.log('[Auth] Token authentication enabled.');
  }

  if (!runtimeConfig.tunnelDomain) {
    console.warn('[Server] WARNING: Tunnel domain is not configured yet. Open the admin UI and finish setup before connecting clients.');
  }

  const bootstrapPasswordFile = getBootstrapPasswordFilePath();
  if (bootstrapPasswordFile) {
    console.warn(`[Dashboard] Initial admin password saved to: ${bootstrapPasswordFile}`);
  }
  if (await isUsingLegacyPasswordHash()) {
    console.warn('[Dashboard] WARNING: This installation uses a legacy password hash. Sign in and rotate it before 2027-01-01 UTC; legacy hash sign-in is disabled after that date.');
  }

  const tunnelManager = new TunnelManager(runtimeConfig);

  const wsServer = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket upgrade required');
  });

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  tunnelWebSockets = wss;
  const upgradeLimiter = createAttemptLimiter({ max: 60 });

  wsServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {}

    const acceptedPaths = new Set([runtimeConfig.tunnelWsPath, runtimeConfig.legacyTunnelWsPath]);
    if (!acceptedPaths.has(pathname)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!upgradeLimiter.take(clientIp(req))) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n', () => socket.destroy());
      return;
    }

    const principal = runtimeConfig.tunnelAuthenticationDisabled ? null : authenticatePrincipal(req, {
        accessKeyStore, sharedToken: runtimeConfig.tunnelToken, allowShared: allowSharedToken,
        allowLegacyQuery: process.env.ALLOW_LEGACY_QUERY_TOKEN === 'true',
        allowUnauthenticated: process.env.ALLOW_UNAUTHENTICATED_TUNNELS === 'true',
      });
    if (!principal || !isAdminHost(req, runtimeConfig.primaryDomain)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    if (wss.clients.size >= 200) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    if (principal.kind === 'client-key'
      && [...wss.clients].filter((ws) => ws.tunnelPrincipal?.id === principal.id).length >= 16) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.tunnelPrincipal = Object.freeze(principal);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    ws.on('error', () => {});
    const ip = clientIp(req);

    console.log(`[WS:8080] Tunnel client connected from ${ip}`);
    tunnelManager.handleNewClient(ws, ip);
  });

  wsServer.listen(WS_PORT, INTERNAL_HOST, () => {
    console.log(`[WS:${WS_PORT}] WebSocket server ready`);
  });

  const dashboardServer = createDashboard(tunnelManager, runtimeConfig, {
    accessKeyStore,
    onClientKeyRevoked(id) {
      for (const ws of wss.clients) {
        if (ws.tunnelPrincipal?.kind === 'client-key' && ws.tunnelPrincipal.id === id) {
          ws.close(4001, 'Client key revoked or rotated.');
        }
      }
    },
    refreshRuntimeConfig,
    ports: {
      wsPort: WS_PORT,
      dashboardPort: DASHBOARD_PORT,
      proxyPort: PROXY_PORT,
    },
  });

  dashboardServer.listen(DASHBOARD_PORT, INTERNAL_HOST, () => {
    console.log(`[Dashboard:${DASHBOARD_PORT}] Dashboard server ready`);
  });

  const proxyServer = http.createServer((req, res) => {
    const host = normalizeDomain(req.headers.host || '');
    const managedHost = matchManagedHttpHost(host, runtimeConfig.publishDomains);

    if (managedHost) {
      handleProxy(req, res, host, tunnelManager);
    } else if (!runtimeConfig.publishDomains?.length || isLandingHost(host)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getLandingHTML(runtimeConfig));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  proxyServer.listen(PROXY_PORT, INTERNAL_HOST, () => {
    console.log(`[Proxy:${PROXY_PORT}] HTTP proxy server ready`);
    if (runtimeConfig.primaryDomain) {
      console.log(`[Dashboard] Admin URL: https://${runtimeConfig.primaryDomain}${runtimeConfig.adminBasePath}`);
      console.log(`[Client] WebSocket URL: wss://${runtimeConfig.primaryDomain}${runtimeConfig.tunnelWsPath} (legacy ${runtimeConfig.legacyTunnelWsPath} also accepted)`);
    } else {
      console.log(`[Dashboard] Admin URL: http://<server>:${DASHBOARD_PORT}${runtimeConfig.adminBasePath}`);
    }
    if (runtimeConfig.publishDomains?.length) {
      const summary = runtimeConfig.publishDomains
        .map((entry) => `${entry.domain}${entry.allowSubdomain ? ' [*.subdomain]' : ''}${entry.allowRoot ? ' [root]' : ''}`)
        .join(', ');
      console.log(`[Server] Publish domains: ${summary}`);
    }
    console.log('[Server] All services started successfully');
  });

  for (const server of [wsServer, dashboardServer, proxyServer]) {
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
  }
  // HTTP uploads and responses are bounded by per-stream inactivity, not total duration.
  proxyServer.requestTimeout = 0;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const tunnel of tunnelManager.getLiveTunnels()) tunnelManager._removeTunnel(tunnel.tunnelKey);
    for (const ws of wss.clients) ws.terminate();
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    Promise.all([wsServer, dashboardServer, proxyServer].map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }))).then(() => closeDatabase()).then(() => { clearTimeout(deadline); process.exit(0); });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[Server] Startup failed:', error);
  process.exit(1);
});
