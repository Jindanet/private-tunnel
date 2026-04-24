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
  isUsingLegacyDefaultPassword,
} = require('./db');
const { buildRuntimeRoutes, isExactHost, matchManagedHttpHost, normalizeDomain } = require('./routing');

warnIfNotElevated();

const WS_PORT = process.env.WS_PORT || 8080;
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 8081;
const PROXY_PORT = process.env.PROXY_PORT || 8082;
const runtimeConfig = {};

async function refreshRuntimeConfig() {
  const settings = await getServerSettings();
  Object.assign(runtimeConfig, settings, buildRuntimeRoutes(settings));
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

  if (!runtimeConfig.hasTunnelToken) {
    console.warn('[Auth] WARNING: Tunnel token is not configured — clients can connect without authentication.');
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
  if (await isUsingLegacyDefaultPassword()) {
    console.warn('[Dashboard] WARNING: This installation is still using the legacy default admin password. Rotate it from the admin UI.');
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
  });

  wsServer.on('upgrade', (req, socket, head) => {
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

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const ip = req.headers['x-real-ip']
      || req.headers['cf-connecting-ip']
      || req.headers['x-forwarded-for']
      || req.socket.remoteAddress;

    if (runtimeConfig.tunnelToken) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const token = urlObj.searchParams.get('token');
        if (token !== runtimeConfig.tunnelToken) {
          console.log(`[Auth] Rejected unauthorized connection from ${ip}`);
          ws.close(4001, 'Unauthorized: invalid or missing token');
          return;
        }
      } catch {
        ws.close(4001, 'Unauthorized');
        return;
      }
    }

    console.log(`[WS:8080] Tunnel client connected from ${ip}`);
    tunnelManager.handleNewClient(ws, ip);
  });

  wsServer.listen(WS_PORT, () => {
    console.log(`[WS:${WS_PORT}] WebSocket server ready`);
  });

  const dashboardServer = createDashboard(tunnelManager, runtimeConfig, {
    refreshRuntimeConfig,
    ports: {
      wsPort: WS_PORT,
      dashboardPort: DASHBOARD_PORT,
      proxyPort: PROXY_PORT,
    },
  });

  dashboardServer.listen(DASHBOARD_PORT, () => {
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

  proxyServer.listen(PROXY_PORT, () => {
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
}

main().catch((error) => {
  console.error('[Server] Startup failed:', error);
  process.exit(1);
});
