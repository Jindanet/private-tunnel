const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { verifyPassword, getAllClients, getRecentLogs, getRequestLogs, getSubdomainStats, getTotalRequestCount } = require('./db');

// Simple session store
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

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
  for (const c of cookies) {
    const [k, v] = c.trim().split('=');
    if (k === name) return v;
  }
  return null;
}

function isAuthenticated(req) {
  return isValidSession(getCookie(req, 'session'));
}

const MAX_BODY = 64 * 1024; // 64 KB

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => {
      if (body.length < MAX_BODY) body += d;
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

function createDashboard(tunnelManager, domain) {
  const dashClients = new Map(); // ws -> { authenticated }

  const server = http.createServer(async (req, res) => {
    // ── Login page ──
    if (req.url === '/dashboard/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getLoginHTML());
      return;
    }

    if (req.url === '/dashboard/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const params = new URLSearchParams(body);
      const password = params.get('password');

      if (verifyPassword(password)) {
        const token = createSession();
        res.writeHead(302, {
          'Set-Cookie': `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          'Location': '/dashboard',
        });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getLoginHTML('Invalid password'));
        return;
      }
      return;
    }

    if (req.url === '/dashboard/logout') {
      const token = getCookie(req, 'session');
      if (token) sessions.delete(token);
      res.writeHead(302, {
        'Set-Cookie': 'session=; Path=/; HttpOnly; Max-Age=0',
        'Location': '/dashboard/login',
      });
      res.end();
      return;
    }

    // ── Auth check for all other routes ──
    if (!isAuthenticated(req)) {
      res.writeHead(302, { 'Location': '/dashboard/login' });
      res.end();
      return;
    }

    // ── API Routes ──
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/api/status') {
      res.end(JSON.stringify({
        status: 'running',
        domain,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeTunnels: tunnelManager.tunnels.size,
        totalRequests: getTotalRequestCount(),
      }));
      return;
    }

    if (req.url === '/api/tunnels') {
      const tunnels = [];
      for (const [subdomain, tunnel] of tunnelManager.tunnels) {
        tunnels.push({
          subdomain,
          url: `https://${subdomain}.${domain}`,
          localPort: tunnel.localPort,
          clientId: tunnel.clientId ? tunnel.clientId.slice(0, 8) + '...' : null,
          clientIp: tunnel.clientIp,
          hostname: tunnel.hostname,
          os: tunnel.os,
          connectedAt: tunnel.connectedAt,
          connections: tunnel.stats.connections,
          bytesIn: tunnel.stats.bytesIn,
          bytesOut: tunnel.stats.bytesOut,
          pendingRequests: tunnel.pendingRequests.size,
          recentRequests: tunnel.requestLog.slice(0, 10),
        });
      }
      res.end(JSON.stringify({ tunnels }));
      return;
    }

    if (req.url === '/api/clients') {
      res.end(JSON.stringify({ clients: getAllClients() }));
      return;
    }

    if (req.url === '/api/logs') {
      res.end(JSON.stringify({ logs: getRecentLogs(200) }));
      return;
    }

    if (req.url.startsWith('/api/logs/')) {
      const subdomain = req.url.split('/api/logs/')[1];
      const logs = getRequestLogs(subdomain, 200);
      const stats = getSubdomainStats(subdomain);
      res.end(JSON.stringify({ logs, stats }));
      return;
    }

    // ── Dashboard Page ──
    if (req.url === '/dashboard' || req.url === '/dashboard/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(getDashboardHTML(domain));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // WebSocket for live updates
  const wss = new WebSocketServer({ server, path: '/dashboard/ws' });

  wss.on('connection', (ws, req) => {
    if (!isAuthenticated(req)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    dashClients.set(ws, { authenticated: true });
    ws.on('close', () => dashClients.delete(ws));
    ws.on('error', () => dashClients.delete(ws));

    // Send current state
    broadcastState(ws, tunnelManager, domain);
  });

  // Broadcast changes every 2s
  setInterval(() => {
    for (const [ws] of dashClients) {
      if (ws.readyState === ws.OPEN) {
        broadcastState(ws, tunnelManager, domain);
      }
    }
  }, 2000);

  return server;
}

function broadcastState(ws, tunnelManager, domain) {
  const tunnels = [];
  for (const [subdomain, tunnel] of tunnelManager.tunnels) {
    tunnels.push({
      subdomain,
      url: `https://${subdomain}.${domain}`,
      localPort: tunnel.localPort,
      clientId: tunnel.clientId ? tunnel.clientId.slice(0, 8) + '...' : null,
      clientIp: tunnel.clientIp,
      hostname: tunnel.hostname,
      os: tunnel.os,
      connectedAt: tunnel.connectedAt,
      connections: tunnel.stats.connections,
      bytesIn: tunnel.stats.bytesIn,
      bytesOut: tunnel.stats.bytesOut,
      pendingRequests: tunnel.pendingRequests.size,
      recentRequests: tunnel.requestLog.slice(0, 5),
    });
  }
  ws.send(JSON.stringify({ type: 'update', tunnels }));
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function getLoginHTML(error) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - PrivateTunnel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;background:#0a0a0a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh}
.login{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:40px;width:360px}
h1{color:#00d4aa;font-size:24px;margin-bottom:8px}
.sub{color:#666;margin-bottom:24px;font-size:14px}
label{display:block;color:#888;font-size:12px;text-transform:uppercase;margin-bottom:6px}
input{width:100%;padding:12px;background:#0a0a0a;border:1px solid #333;border-radius:6px;color:#e0e0e0;font-size:16px;margin-bottom:16px}
input:focus{outline:none;border-color:#00d4aa}
button{width:100%;padding:12px;background:#00d4aa;color:#0a0a0a;border:none;border-radius:6px;font-size:16px;font-weight:bold;cursor:pointer}
button:hover{background:#00b894}
.error{color:#ff6b6b;font-size:13px;margin-bottom:12px}
</style></head><body>
<div class="login">
<h1>PrivateTunnel</h1>
<p class="sub">Dashboard Login</p>
${error ? `<p class="error">${error}</p>` : ''}
<form method="POST" action="/dashboard/login">
<label>Password</label>
<input type="password" name="password" autofocus placeholder="Enter password">
<button type="submit">Login</button>
</form>
</div></body></html>`;
}

function getDashboardHTML(domain) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PrivateTunnel Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;background:#0a0a0a;color:#e0e0e0;padding:24px}
h1{color:#00d4aa;margin-bottom:4px;font-size:28px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.subtitle{color:#666;margin-bottom:24px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#00d4aa;margin-right:8px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.logout{color:#888;text-decoration:none;font-size:13px;padding:6px 12px;border:1px solid #333;border-radius:4px}
.logout:hover{border-color:#ff6b6b;color:#ff6b6b}
.stats{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:14px 20px;min-width:140px}
.stat .label{color:#888;font-size:11px;text-transform:uppercase}
.stat .val{color:#00d4aa;font-size:28px;font-weight:bold;margin-top:2px}
.tabs{display:flex;gap:4px;margin-bottom:16px}
.tab{padding:8px 16px;background:#1a1a1a;border:1px solid #333;border-radius:6px 6px 0 0;cursor:pointer;color:#888;font-size:13px}
.tab.active{background:#222;color:#00d4aa;border-bottom-color:#222}
.panel{display:none;background:#1a1a1a;border:1px solid #333;border-radius:0 8px 8px 8px;overflow:hidden}
.panel.active{display:block}
table{width:100%;border-collapse:collapse}
th{background:#222;color:#888;text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;white-space:nowrap}
td{padding:10px 14px;border-top:1px solid #2a2a2a;font-size:13px;white-space:nowrap}
.badge{background:#1a3a2a;color:#00d4aa;padding:2px 8px;border-radius:4px;font-size:12px}
.ip{color:#f0c674}
.url{color:#00d4aa}
.method{font-weight:bold}
.s2{color:#00d4aa}.s3{color:#81a2be}.s4{color:#f0c674}.s5{color:#cc6666}
.empty{text-align:center;padding:48px;color:#555}
.detail{background:#111;border:1px solid #333;border-radius:6px;margin:8px 14px 14px;padding:12px;font-size:12px}
.detail-grid{display:grid;grid-template-columns:120px 1fr;gap:4px 12px}
.detail-grid dt{color:#888}.detail-grid dd{color:#e0e0e0;word-break:break-all}
.expand{cursor:pointer;color:#00d4aa;font-size:11px}
.req-row{cursor:pointer}.req-row:hover{background:#222}
</style></head><body>
<div class="header"><h1>PrivateTunnel</h1><a href="/dashboard/logout" class="logout">Logout</a></div>
<p class="subtitle"><span class="dot"></span>Server running on ${domain}</p>

<div class="stats">
<div class="stat"><div class="label">Active Tunnels</div><div class="val" id="sTunnels">0</div></div>
<div class="stat"><div class="label">Total Requests</div><div class="val" id="sRequests">0</div></div>
<div class="stat"><div class="label">Bandwidth In</div><div class="val" id="sBytesIn">0</div></div>
<div class="stat"><div class="label">Bandwidth Out</div><div class="val" id="sBytesOut">0</div></div>
<div class="stat"><div class="label">Uptime</div><div class="val" id="sUptime">-</div></div>
</div>

<div class="tabs">
<div class="tab active" onclick="switchTab('tunnels')">Active Tunnels</div>
<div class="tab" onclick="switchTab('logs')">Request Logs</div>
<div class="tab" onclick="switchTab('clients')">All Clients</div>
</div>

<!-- Active Tunnels -->
<div class="panel active" id="pTunnels">
<table>
<thead><tr><th>Subdomain</th><th>Client IP</th><th>Hostname</th><th>OS</th><th>Port</th><th>Reqs</th><th>Bytes In/Out</th><th>Connected</th></tr></thead>
<tbody id="tTunnels"><tr><td colspan="8" class="empty">No active tunnels</td></tr></tbody>
</table>
</div>

<!-- Request Logs -->
<div class="panel" id="pLogs">
<table>
<thead><tr><th>Time</th><th>Subdomain</th><th>Visitor IP</th><th>Method</th><th>Path</th><th>Status</th><th>Latency</th><th>User-Agent</th></tr></thead>
<tbody id="tLogs"><tr><td colspan="8" class="empty">No requests yet</td></tr></tbody>
</table>
</div>

<!-- All Clients -->
<div class="panel" id="pClients">
<table>
<thead><tr><th>Client ID</th><th>Subdomain</th><th>IP</th><th>Hostname</th><th>OS</th><th>Created</th><th>Last Seen</th></tr></thead>
<tbody id="tClients"><tr><td colspan="7" class="empty">No clients</td></tr></tbody>
</table>
</div>

<script>
const ws = new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/dashboard/ws');
let tunnelData = [];

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'update') { tunnelData = msg.tunnels; renderTunnels(); }
};
ws.onclose = () => setTimeout(() => location.reload(), 3000);

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    const panels = ['tunnels','logs','clients'];
    const active = panels[i] === name;
    t.classList.toggle('active', active);
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('p'+name.charAt(0).toUpperCase()+name.slice(1)).classList.add('active');
  if (name === 'logs') loadLogs();
  if (name === 'clients') loadClients();
}

function fmtBytes(b) {
  if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(1)+' MB';
}

function fmtTime(iso) {
  if(!iso)return '-';
  const d=new Date(iso);
  return d.toLocaleTimeString();
}

function statusClass(s) {
  if(s>=500)return 's5';if(s>=400)return 's4';if(s>=300)return 's3';return 's2';
}

function renderTunnels() {
  const el = document.getElementById('tTunnels');
  document.getElementById('sTunnels').textContent = tunnelData.length;
  let totalReqs=0, totalIn=0, totalOut=0;
  tunnelData.forEach(t => { totalReqs+=t.connections; totalIn+=t.bytesIn; totalOut+=t.bytesOut; });
  document.getElementById('sRequests').textContent = totalReqs;
  document.getElementById('sBytesIn').textContent = fmtBytes(totalIn);
  document.getElementById('sBytesOut').textContent = fmtBytes(totalOut);

  if(!tunnelData.length) { el.innerHTML='<tr><td colspan="8" class="empty">No active tunnels</td></tr>'; return; }

  el.innerHTML = tunnelData.map(t => {
    const reqs = (t.recentRequests||[]).map(r =>
      '<tr><td></td><td colspan="7" style="font-size:12px;color:#888;padding:4px 14px">' +
      '<span class="method">'+r.method+'</span> '+r.path+
      ' <span class="'+statusClass(r.statusCode)+'">'+r.statusCode+'</span>'+
      ' '+r.latencyMs+'ms'+
      ' <span class="ip">'+( r.visitorIp||'')+'</span>'+
      ' <span style="color:#555">'+( r.userAgent||'').slice(0,60)+'</span>'+
      '</td></tr>'
    ).join('');

    return '<tr class="req-row" onclick="this.nextElementSibling&&this.nextElementSibling.classList.toggle(\\'detail\\')||false">'+
      '<td><span class="badge">'+t.subdomain+'</span></td>'+
      '<td class="ip">'+(t.clientIp||'-')+'</td>'+
      '<td>'+(t.hostname||'-')+'</td>'+
      '<td>'+(t.os||'-')+'</td>'+
      '<td>'+t.localPort+'</td>'+
      '<td>'+t.connections+'</td>'+
      '<td>'+fmtBytes(t.bytesIn)+' / '+fmtBytes(t.bytesOut)+'</td>'+
      '<td>'+fmtTime(t.connectedAt)+'</td>'+
    '</tr>' + reqs;
  }).join('');
}

async function loadLogs() {
  const res = await fetch('/api/logs');
  const {logs} = await res.json();
  const el = document.getElementById('tLogs');
  if(!logs.length) { el.innerHTML='<tr><td colspan="8" class="empty">No requests yet</td></tr>'; return; }
  el.innerHTML = logs.map(l =>
    '<tr>'+
    '<td>'+fmtTime(l.created_at)+'</td>'+
    '<td><span class="badge">'+l.subdomain+'</span></td>'+
    '<td class="ip">'+(l.visitor_ip||'-')+'</td>'+
    '<td class="method">'+l.method+'</td>'+
    '<td>'+(l.path||'').slice(0,60)+'</td>'+
    '<td class="'+statusClass(l.status_code)+'">'+(l.status_code||'-')+'</td>'+
    '<td>'+(l.latency_ms||'-')+'ms</td>'+
    '<td style="color:#888;max-width:200px;overflow:hidden;text-overflow:ellipsis">'+(l.user_agent||'-')+'</td>'+
    '</tr>'
  ).join('');
}

async function loadClients() {
  const res = await fetch('/api/clients');
  const {clients} = await res.json();
  const el = document.getElementById('tClients');
  if(!clients.length) { el.innerHTML='<tr><td colspan="7" class="empty">No clients</td></tr>'; return; }
  el.innerHTML = clients.map(c =>
    '<tr>'+
    '<td style="font-size:12px">'+(c.client_id||'').slice(0,12)+'...</td>'+
    '<td><span class="badge">'+c.subdomain+'</span></td>'+
    '<td class="ip">'+(c.ip||'-')+'</td>'+
    '<td>'+(c.hostname||'-')+'</td>'+
    '<td>'+(c.os||'-')+'</td>'+
    '<td>'+c.created_at+'</td>'+
    '<td>'+c.last_seen+'</td>'+
    '</tr>'
  ).join('');
}

// Uptime
fetch('/api/status').then(r=>r.json()).then(d=>{
  const start=Date.now()/1000-d.uptime;
  setInterval(()=>{
    const s=Math.floor(Date.now()/1000-start);
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
    document.getElementById('sUptime').textContent=h>0?h+'h '+m+'m':m+'m';
  },1000);
  document.getElementById('sRequests').textContent=d.totalRequests;
});
</script></body></html>`;
}

module.exports = { createDashboard };
