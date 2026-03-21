const Database = require('better-sqlite3');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tunnel.db');

// Ensure data directory exists
const fs = require('node:fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── Tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    subdomain TEXT UNIQUE NOT NULL,
    ip TEXT,
    hostname TEXT,
    os TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subdomain TEXT NOT NULL,
    client_id TEXT,
    visitor_ip TEXT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    host TEXT,
    user_agent TEXT,
    referer TEXT,
    content_type TEXT,
    content_length INTEGER,
    status_code INTEGER,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_subdomain ON request_logs(subdomain);
  CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at);
`);

// ── Default config ──
const DEFAULT_PASSWORD = process.env.DASHBOARD_PASSWORD || 'AdminTunnel1234';
const getConfig = db.prepare('SELECT value FROM config WHERE key = ?');
const setConfig = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');

// Always update password from env if set, otherwise use default on first run
if (process.env.DASHBOARD_PASSWORD) {
  setConfig.run('dashboard_password', hashPassword(process.env.DASHBOARD_PASSWORD));
} else if (!getConfig.get('dashboard_password')) {
  setConfig.run('dashboard_password', hashPassword(DEFAULT_PASSWORD));
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

function verifyPassword(pw) {
  const row = getConfig.get('dashboard_password');
  if (!row) return false;
  return row.value === hashPassword(pw);
}

// ── Client statements ──
const stmts = {
  getByClientId: db.prepare('SELECT subdomain FROM clients WHERE client_id = ?'),
  getBySubdomain: db.prepare('SELECT client_id FROM clients WHERE subdomain = ?'),
  insert: db.prepare('INSERT INTO clients (client_id, subdomain, ip, hostname, os) VALUES (?, ?, ?, ?, ?)'),
  updateLastSeen: db.prepare("UPDATE clients SET last_seen = datetime('now'), ip = ? WHERE client_id = ?"),
  getAllClients: db.prepare('SELECT * FROM clients ORDER BY last_seen DESC'),
  getClient: db.prepare('SELECT * FROM clients WHERE client_id = ?'),
};

function getSubdomainForClient(clientId) {
  const row = stmts.getByClientId.get(clientId);
  return row ? row.subdomain : null;
}

function isSubdomainTaken(subdomain) {
  return !!stmts.getBySubdomain.get(subdomain);
}

function saveMapping(clientId, subdomain, ip, hostname, os) {
  stmts.insert.run(clientId, subdomain, ip || null, hostname || null, os || null);
}

function touchClient(clientId, ip) {
  stmts.updateLastSeen.run(ip || null, clientId);
}

function getAllClients() {
  return stmts.getAllClients.all();
}

// ── Request log statements ──
const logStmts = {
  insert: db.prepare(`
    INSERT INTO request_logs (subdomain, client_id, visitor_ip, method, path, host, user_agent, referer, content_type, content_length, status_code, latency_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getBySubdomain: db.prepare('SELECT * FROM request_logs WHERE subdomain = ? ORDER BY created_at DESC LIMIT ?'),
  getRecent: db.prepare('SELECT * FROM request_logs ORDER BY created_at DESC LIMIT ?'),
  getStats: db.prepare(`
    SELECT
      subdomain,
      COUNT(*) as total_requests,
      COUNT(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 END) as success_2xx,
      COUNT(CASE WHEN status_code >= 300 AND status_code < 400 THEN 1 END) as redirect_3xx,
      COUNT(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 END) as client_err_4xx,
      COUNT(CASE WHEN status_code >= 500 THEN 1 END) as server_err_5xx,
      ROUND(AVG(latency_ms), 1) as avg_latency_ms,
      MAX(latency_ms) as max_latency_ms
    FROM request_logs
    WHERE subdomain = ?
  `),
  countAll: db.prepare('SELECT COUNT(*) as count FROM request_logs'),
  cleanup: db.prepare("DELETE FROM request_logs WHERE created_at < datetime('now', '-7 days')"),
};

function logRequest(data) {
  logStmts.insert.run(
    data.subdomain, data.clientId || null, data.visitorIp || null,
    data.method, data.path, data.host || null,
    data.userAgent || null, data.referer || null,
    data.contentType || null, data.contentLength || null,
    data.statusCode || null, data.latencyMs || null, data.error || null
  );
}

function getRequestLogs(subdomain, limit = 100) {
  return logStmts.getBySubdomain.all(subdomain, limit);
}

function getRecentLogs(limit = 100) {
  return logStmts.getRecent.all(limit);
}

function getSubdomainStats(subdomain) {
  return logStmts.getStats.get(subdomain);
}

function getTotalRequestCount() {
  return logStmts.countAll.get().count;
}

// Cleanup old logs every hour
setInterval(() => logStmts.cleanup.run(), 3600000);

module.exports = {
  db, verifyPassword,
  getSubdomainForClient, isSubdomainTaken, saveMapping, touchClient, getAllClients,
  logRequest, getRequestLogs, getRecentLogs, getSubdomainStats, getTotalRequestCount,
};
