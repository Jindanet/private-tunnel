require('dotenv').config();
const http = require('node:http');
const { WebSocketServer } = require('ws');
const TunnelManager = require('./tunnel-manager');
const { handleProxy } = require('./proxy');
const { createDashboard } = require('./dashboard');
const { getLandingHTML } = require('./landing');
const { warnIfNotElevated } = require('./firewall');

warnIfNotElevated();

const WS_PORT = process.env.WS_PORT || 8080;
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 8081;
const PROXY_PORT = process.env.PROXY_PORT || 8082;
const DOMAIN = process.env.DOMAIN;
if (!DOMAIN) {
  console.error('[Server] ERROR: DOMAIN environment variable is required. Set it in .env file.');
  process.exit(1);
}

const tunnelManager = new TunnelManager(DOMAIN);

// ─────────────────────────────────────────────
// Port 8080 — WebSocket server for tunnel clients
// ─────────────────────────────────────────────
const wsServer = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('WebSocket upgrade required');
});

const wss = new WebSocketServer({ server: wsServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-real-ip']
    || req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']
    || req.socket.remoteAddress;
  console.log(`[WS:8080] Tunnel client connected from ${ip}`);
  tunnelManager.handleNewClient(ws, ip);
});

wsServer.listen(WS_PORT, () => {
  console.log(`[WS:${WS_PORT}] WebSocket server ready`);
});

// ─────────────────────────────────────────────
// Port 8081 — Dashboard API + UI
// ─────────────────────────────────────────────
const dashboardServer = createDashboard(tunnelManager, DOMAIN);

dashboardServer.listen(DASHBOARD_PORT, () => {
  console.log(`[Dashboard:${DASHBOARD_PORT}] Dashboard server ready`);
});

// ─────────────────────────────────────────────
// Port 8082 — HTTP proxy (tunnel traffic)
// ─────────────────────────────────────────────
const proxyServer = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  const parts = host.split('.');
  const domainParts = DOMAIN.split('.');
  const subdomainDepth = parts.length - domainParts.length;

  if (subdomainDepth === 1) {
    const subdomain = parts[0];
    handleProxy(req, res, subdomain, tunnelManager);
  } else if (subdomainDepth <= 0) {
    // Root domain — landing page
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getLandingHTML(DOMAIN));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

proxyServer.listen(PROXY_PORT, () => {
  console.log(`[Proxy:${PROXY_PORT}] HTTP proxy server ready`);
  console.log(`[Server] Domain: *.${DOMAIN}`);
  console.log(`[Server] All services started successfully`);
});
