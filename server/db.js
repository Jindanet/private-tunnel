const Database = require('better-sqlite3');
const mysql = require('mysql2/promise');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  normalizeDomain,
  normalizeControlRoot,
  isValidControlRoot,
  isValidDomain,
  normalizePublishDomains,
} = require('./routing');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const SQLITE_PATH = path.resolve(process.env.SQLITE_PATH || process.env.DB_PATH || path.join(DATA_DIR, 'tunnel.db'));
const BOOTSTRAP_PASSWORD_PATH = path.join(DATA_DIR, 'admin-bootstrap.txt');
const MYSQL_HOST = String(process.env.MYSQL_HOST || '127.0.0.1').trim();
const MYSQL_PORT = Number.parseInt(process.env.MYSQL_PORT, 10) || 3306;
const MYSQL_USER = String(process.env.MYSQL_USER || 'root').trim();
const MYSQL_PASSWORD = String(process.env.MYSQL_PASSWORD || '').trim();
const MYSQL_DATABASE = String(process.env.MYSQL_DATABASE || 'privatetunnel').trim();
const DB_PROVIDER = normalizeBackend(process.env.DB_PROVIDER || 'mysql');
const DB_SYNC_TARGETS = parseBackendList(process.env.DB_SYNC_TARGETS || '');
const DB_SYNC_STRICT = parseBooleanEnv(process.env.DB_SYNC_STRICT, false);
const DB_BOOTSTRAP_SYNC = parseBooleanEnv(process.env.DB_BOOTSTRAP_SYNC, true);
const ENV_PRIMARY_DOMAIN = normalizeDomain(process.env.PRIMARY_DOMAIN || process.env.DOMAIN || '');
const ENV_TUNNEL_DOMAIN = normalizeDomain(process.env.TUNNEL_DOMAIN || process.env.DOMAIN || '');
const ENV_TUNNEL_TOKEN = String(process.env.TUNNEL_TOKEN || '').trim();
const ENV_DASHBOARD_PASSWORD = String(process.env.DASHBOARD_PASSWORD || '').trim();
const LEGACY_DEFAULT_PASSWORD_HASH = crypto.randomBytes(32).toString('hex');
const CONFIG_KEYS = {
  legacyDashboardPassword: 'dashboard_password',
  adminPasswordHash: 'admin_password_hash',
  primaryDomain: 'primary_domain',
  controlRoot: 'control_root',
  tunnelDomain: 'tunnel_domain',
  publishDomains: 'publish_domains',
  tunnelToken: 'tunnel_token',
};

let primaryAdapter = null;
let activeAdapters = new Map();
let initPromise = null;
let cleanupTimer = null;

function normalizeBackend(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'mysql';
  if (normalized !== 'mysql' && normalized !== 'sqlite') {
    throw new Error(`Unsupported DB backend: ${value}`);
  }
  return normalized;
}

function parseBackendList(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];

  const seen = new Set();
  const backends = [];
  for (const item of raw.split(',')) {
    const backend = normalizeBackend(item);
    if (seen.has(backend)) continue;
    seen.add(backend);
    backends.push(backend);
  }

  return backends;
}

function parseBooleanEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function escapeIdentifier(value, fieldName) {
  const input = String(value || '').trim();
  if (!input) {
    throw new Error(`${fieldName} is required`);
  }
  if (!/^[a-zA-Z0-9_$-]+$/.test(input)) {
    throw new Error(`${fieldName} contains invalid characters`);
  }
  return `\`${input.replace(/`/g, '``')}\``;
}

function parsePublishDomainsValue(rawValue) {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildPublishDomains(input, fallbackDomain, primaryDomain) {
  return normalizePublishDomains(input, fallbackDomain).map((entry) => ({
    ...entry,
    allowRoot: entry.domain === primaryDomain ? false : entry.allowRoot,
  }));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function constantTimeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getBootstrapPasswordFilePath() {
  return fs.existsSync(BOOTSTRAP_PASSWORD_PATH) ? BOOTSTRAP_PASSWORD_PATH : null;
}

function removeBootstrapPasswordFile() {
  try {
    if (fs.existsSync(BOOTSTRAP_PASSWORD_PATH)) {
      fs.unlinkSync(BOOTSTRAP_PASSWORD_PATH);
    }
  } catch {}
}

function writeBootstrapPasswordFile(password) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const content = [
    'PrivateTunnel initial admin password',
    '',
    password,
    '',
    'Delete or rotate this password from the admin UI after your first login.',
    '',
  ].join('\n');

  fs.writeFileSync(BOOTSTRAP_PASSWORD_PATH, content, 'utf8');
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    return new Date();
  }
  return date;
}

function toIsoTimestamp(value) {
  return normalizeTimestamp(value).toISOString();
}

function toMySqlDateTime(value) {
  return toIsoTimestamp(value).slice(0, 19).replace('T', ' ');
}

function buildLogSyncKey(data) {
  const payload = [
    data.createdAt,
    data.subdomain,
    data.clientId || '',
    data.visitorIp || '',
    data.method || '',
    data.path || '',
    data.host || '',
    data.userAgent || '',
    data.referer || '',
    data.contentType || '',
    data.contentLength == null ? '' : String(data.contentLength),
    data.statusCode == null ? '' : String(data.statusCode),
    data.latencyMs == null ? '' : String(data.latencyMs),
    data.error || '',
  ].join('\u0001');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

function normalizeLogPayload(data) {
  const createdAt = toIsoTimestamp(data.createdAt || data.time || new Date());
  const syncKey = String(data.syncKey || buildLogSyncKey({ ...data, createdAt }));

  return {
    syncKey,
    createdAt,
    subdomain: String(data.subdomain || '').trim(),
    clientId: data.clientId || null,
    visitorIp: data.visitorIp || null,
    method: String(data.method || '').trim(),
    path: String(data.path || '').trim() || '/',
    host: data.host || null,
    userAgent: data.userAgent || null,
    referer: data.referer || null,
    contentType: data.contentType || null,
    contentLength: data.contentLength == null ? null : Number(data.contentLength),
    statusCode: data.statusCode == null ? null : Number(data.statusCode),
    latencyMs: data.latencyMs == null ? null : Number(data.latencyMs),
    error: data.error || null,
  };
}

function buildEnabledBackends() {
  const enabled = new Set([DB_PROVIDER, ...DB_SYNC_TARGETS]);
  return [...enabled];
}

function hasSnapshotData(stats) {
  return (stats.configCount || 0) > 0 || (stats.clientCount || 0) > 0 || (stats.logCount || 0) > 0;
}

async function getPrimaryAdapter() {
  if (!primaryAdapter) {
    throw new Error('Database has not been initialized yet');
  }
  return primaryAdapter;
}

async function withPrimaryRead(methodName, ...args) {
  const adapter = await getPrimaryAdapter();
  return adapter[methodName](...args);
}

async function fanoutWrite(methodName, args, description) {
  const adapter = await getPrimaryAdapter();
  const primaryResult = await adapter[methodName](...args);

  const mirrorEntries = [...activeAdapters.entries()].filter(([kind]) => kind !== adapter.kind);
  await Promise.all(mirrorEntries.map(async ([kind, target]) => {
    try {
      await target[methodName](...args);
    } catch (error) {
      const message = `[DB] Mirror write failed (${description}) on ${kind}: ${error.message}`;
      if (DB_SYNC_STRICT) {
        throw new Error(message);
      }
      console.warn(message);
    }
  }));

  return primaryResult;
}

function normalizeClientPayload(payload) {
  return {
    subdomain: String(payload.subdomain || '').trim(),
    ip: payload.ip || null,
    hostname: payload.hostname || null,
    os: payload.os || null,
    publishDomain: normalizeDomain(payload.publishDomain || '') || null,
    publishMode: payload.publishMode === 'root' ? 'root' : 'subdomain',
    assignedHost: normalizeDomain(payload.assignedHost || '') || null,
    createdAt: toIsoTimestamp(payload.createdAt || new Date()),
    lastSeen: toIsoTimestamp(payload.lastSeen || new Date()),
  };
}

class SqliteAdapter {
  constructor(filePath) {
    this.kind = 'sqlite';
    this.filePath = filePath;
    this.db = null;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new Database(this.filePath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        subdomain TEXT NOT NULL,
        ip TEXT,
        hostname TEXT,
        os TEXT,
        publish_domain TEXT,
        publish_mode TEXT,
        assigned_host TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_seen TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_key TEXT UNIQUE,
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
    `);

    this.ensureColumn('clients', 'publish_domain', 'TEXT');
    this.ensureColumn('clients', 'publish_mode', 'TEXT');
    this.ensureColumn('clients', 'assigned_host', 'TEXT');
    this.ensureColumn('request_logs', 'sync_key', 'TEXT');

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_subdomain ON clients(subdomain);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_assigned_host ON clients(assigned_host);
      CREATE INDEX IF NOT EXISTS idx_logs_subdomain ON request_logs(subdomain);
      CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs(created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_sync_key ON request_logs(sync_key);
    `);
  }

  ensureColumn(tableName, columnName, typeSql) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (columns.some((column) => column.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${typeSql}`);
  }

  async getStats() {
    return {
      configCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM config').get().count) || 0,
      clientCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM clients').get().count) || 0,
      logCount: Number(this.db.prepare('SELECT COUNT(*) AS count FROM request_logs').get().count) || 0,
    };
  }

  async getConfigValue(key) {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  async getConfigMap() {
    const rows = this.db.prepare('SELECT key, value FROM config').all();
    const map = new Map();
    for (const row of rows) {
      map.set(row.key, row.value);
    }
    return map;
  }

  async setConfigValue(key, value) {
    const nextValue = value == null ? '' : String(value).trim();
    if (!nextValue) {
      this.db.prepare('DELETE FROM config WHERE key = ?').run(key);
      return;
    }

    this.db.prepare(`
      INSERT INTO config (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, nextValue);
  }

  async getAllConfigEntries() {
    return this.db.prepare('SELECT key, value FROM config ORDER BY key ASC').all();
  }

  async importConfigEntries(entries) {
    const stmt = this.db.prepare(`
      INSERT INTO config (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    const tx = this.db.transaction((items) => {
      for (const entry of items) {
        stmt.run(entry.key, entry.value);
      }
    });
    tx(entries);
  }

  async getSubdomainForClient(clientId) {
    const row = this.db.prepare('SELECT subdomain FROM clients WHERE client_id = ? LIMIT 1').get(clientId);
    return row ? row.subdomain : null;
  }

  async getClientMapping(clientId) {
    return this.db.prepare(`
      SELECT client_id, subdomain, ip, hostname, os, created_at, last_seen, publish_domain, publish_mode, assigned_host
      FROM clients
      WHERE client_id = ?
      LIMIT 1
    `).get(clientId) || null;
  }

  async isSubdomainTaken(subdomain) {
    return !!this.db.prepare('SELECT 1 FROM clients WHERE subdomain = ? LIMIT 1').get(subdomain);
  }

  async getClientMappingByAssignedHost(assignedHost) {
    return this.db.prepare(`
      SELECT client_id, subdomain, ip, hostname, os, created_at, last_seen, publish_domain, publish_mode, assigned_host
      FROM clients
      WHERE assigned_host = ?
      LIMIT 1
    `).get(assignedHost) || null;
  }

  async saveMapping(clientId, payload) {
    const nextPayload = normalizeClientPayload(payload);
    this.db.prepare(`
      INSERT INTO clients (
        client_id,
        subdomain,
        ip,
        hostname,
        os,
        publish_domain,
        publish_mode,
        assigned_host,
        created_at,
        last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        subdomain = excluded.subdomain,
        ip = excluded.ip,
        hostname = excluded.hostname,
        os = excluded.os,
        publish_domain = excluded.publish_domain,
        publish_mode = excluded.publish_mode,
        assigned_host = excluded.assigned_host,
        last_seen = excluded.last_seen
    `).run(
      clientId,
      nextPayload.subdomain,
      nextPayload.ip,
      nextPayload.hostname,
      nextPayload.os,
      nextPayload.publishDomain,
      nextPayload.publishMode,
      nextPayload.assignedHost,
      nextPayload.createdAt,
      nextPayload.lastSeen,
    );
  }

  async importClients(rows) {
    const tx = this.db.transaction((items) => {
      for (const row of items) {
        this.saveMapping(row.client_id, {
          subdomain: row.subdomain,
          ip: row.ip,
          hostname: row.hostname,
          os: row.os,
          publishDomain: row.publish_domain,
          publishMode: row.publish_mode,
          assignedHost: row.assigned_host,
          createdAt: row.created_at,
          lastSeen: row.last_seen,
        });
      }
    });
    tx(rows);
  }

  async touchClient(clientId, ip) {
    this.db.prepare(`
      UPDATE clients
      SET last_seen = ?, ip = ?
      WHERE client_id = ?
    `).run(toIsoTimestamp(new Date()), ip || null, clientId);
  }

  async getAllClients() {
    return this.db.prepare('SELECT * FROM clients ORDER BY last_seen DESC').all();
  }

  async getAllRequestLogs() {
    return this.db.prepare(`
      SELECT sync_key, subdomain, client_id, visitor_ip, method, path, host, user_agent, referer, content_type, content_length, status_code, latency_ms, error, created_at
      FROM request_logs
      ORDER BY created_at ASC, id ASC
    `).all();
  }

  async logRequest(data) {
    const entry = normalizeLogPayload(data);
    this.db.prepare(`
      INSERT OR IGNORE INTO request_logs (
        sync_key,
        subdomain,
        client_id,
        visitor_ip,
        method,
        path,
        host,
        user_agent,
        referer,
        content_type,
        content_length,
        status_code,
        latency_ms,
        error,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.syncKey,
      entry.subdomain,
      entry.clientId,
      entry.visitorIp,
      entry.method,
      entry.path,
      entry.host,
      entry.userAgent,
      entry.referer,
      entry.contentType,
      entry.contentLength,
      entry.statusCode,
      entry.latencyMs,
      entry.error,
      entry.createdAt,
    );
  }

  async importRequestLogs(rows) {
    const tx = this.db.transaction((items) => {
      for (const row of items) {
        this.logRequest({
          syncKey: row.sync_key,
          createdAt: row.created_at,
          subdomain: row.subdomain,
          clientId: row.client_id,
          visitorIp: row.visitor_ip,
          method: row.method,
          path: row.path,
          host: row.host,
          userAgent: row.user_agent,
          referer: row.referer,
          contentType: row.content_type,
          contentLength: row.content_length,
          statusCode: row.status_code,
          latencyMs: row.latency_ms,
          error: row.error,
        });
      }
    });
    tx(rows);
  }

  async getRequestLogs(subdomain, limit = 100) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.db.prepare(`
      SELECT *
      FROM request_logs
      WHERE subdomain = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(subdomain, safeLimit);
  }

  async getRecentLogs(limit = 100) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.db.prepare(`
      SELECT *
      FROM request_logs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(safeLimit);
  }

  async getSubdomainStats(subdomain) {
    return this.db.prepare(`
      SELECT
        subdomain,
        COUNT(*) AS total_requests,
        SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS success_2xx,
        SUM(CASE WHEN status_code >= 300 AND status_code < 400 THEN 1 ELSE 0 END) AS redirect_3xx,
        SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS client_err_4xx,
        SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_err_5xx,
        ROUND(AVG(latency_ms), 1) AS avg_latency_ms,
        MAX(latency_ms) AS max_latency_ms
      FROM request_logs
      WHERE subdomain = ?
    `).get(subdomain) || null;
  }

  async getTotalRequestCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM request_logs').get().count) || 0;
  }

  async cleanupOldLogs() {
    this.db.prepare(`
      DELETE FROM request_logs
      WHERE created_at < datetime('now', '-7 days')
    `).run();
  }
}

class MySqlAdapter {
  constructor() {
    this.kind = 'mysql';
    this.pool = null;
  }

  async init() {
    await this.ensureDatabaseExists();
    this.pool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 50,
      queueLimit: 100,
      maxIdle: 10,
      idleTimeout: 60000,
      acquireTimeout: 15000,
      timeout: 15000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      charset: 'utf8mb4',
      supportBigNumbers: true,
      multipleStatements: false,
      timezone: 'Z',
    });

    await this.createSchema();
  }

  async ensureDatabaseExists() {
    const server = await mysql.createConnection({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      multipleStatements: false,
    });

    try {
      await server.query(
        `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(MYSQL_DATABASE, 'MYSQL_DATABASE')} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } finally {
      await server.end();
    }
  }

  async query(sql, params = []) {
    const [rows] = await this.pool.query(sql, params);
    return rows;
  }

  async execute(sql, params = []) {
    const [result] = await this.pool.execute(sql, params);
    return result;
  }

  async ensureColumn(tableName, columnName, definitionSql) {
    const rows = await this.query(
      `
        SELECT 1
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1
      `,
      [MYSQL_DATABASE, tableName, columnName]
    );

    if (rows.length) return;
    await this.query(`ALTER TABLE ${escapeIdentifier(tableName, 'table')} ADD COLUMN ${escapeIdentifier(columnName, 'column')} ${definitionSql}`);
  }

  async ensureIndex(tableName, indexName, ddlSql) {
    const rows = await this.query(
      `
        SELECT 1
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          AND INDEX_NAME = ?
        LIMIT 1
      `,
      [MYSQL_DATABASE, tableName, indexName]
    );

    if (rows.length) return;
    await this.query(ddlSql);
  }

  async createSchema() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id VARCHAR(191) PRIMARY KEY,
        subdomain VARCHAR(191) NOT NULL,
        ip VARCHAR(255) NULL,
        hostname VARCHAR(255) NULL,
        os VARCHAR(255) NULL,
        publish_domain VARCHAR(191) NULL,
        publish_mode VARCHAR(32) NULL,
        assigned_host VARCHAR(191) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        sync_key VARCHAR(64) NULL,
        subdomain VARCHAR(191) NOT NULL,
        client_id VARCHAR(191) NULL,
        visitor_ip VARCHAR(255) NULL,
        method VARCHAR(32) NOT NULL,
        path TEXT NOT NULL,
        host VARCHAR(255) NULL,
        user_agent TEXT NULL,
        referer TEXT NULL,
        content_type VARCHAR(255) NULL,
        content_length BIGINT NULL,
        status_code INT NULL,
        latency_ms INT NULL,
        error TEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_logs_subdomain (subdomain),
        INDEX idx_logs_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS config (
        \`key\` VARCHAR(191) PRIMARY KEY,
        value LONGTEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await this.ensureColumn('clients', 'publish_domain', 'VARCHAR(191) NULL');
    await this.ensureColumn('clients', 'publish_mode', 'VARCHAR(32) NULL');
    await this.ensureColumn('clients', 'assigned_host', 'VARCHAR(191) NULL');
    await this.ensureColumn('request_logs', 'sync_key', 'VARCHAR(64) NULL');
    await this.ensureIndex('clients', 'idx_clients_subdomain', 'CREATE UNIQUE INDEX idx_clients_subdomain ON clients (subdomain)');
    await this.ensureIndex('clients', 'idx_clients_assigned_host', 'CREATE UNIQUE INDEX idx_clients_assigned_host ON clients (assigned_host)');
    await this.ensureIndex('request_logs', 'idx_logs_sync_key', 'CREATE UNIQUE INDEX idx_logs_sync_key ON request_logs (sync_key)');
  }

  async getStats() {
    const [configRow] = await this.query('SELECT COUNT(*) AS count FROM config');
    const [clientRow] = await this.query('SELECT COUNT(*) AS count FROM clients');
    const [logRow] = await this.query('SELECT COUNT(*) AS count FROM request_logs');

    return {
      configCount: Number(configRow && configRow.count) || 0,
      clientCount: Number(clientRow && clientRow.count) || 0,
      logCount: Number(logRow && logRow.count) || 0,
    };
  }

  async getConfigValue(key) {
    const rows = await this.query('SELECT value FROM config WHERE `key` = ? LIMIT 1', [key]);
    return rows[0] ? rows[0].value : null;
  }

  async getConfigMap() {
    const rows = await this.query('SELECT `key`, value FROM config');
    const map = new Map();
    for (const row of rows) {
      map.set(row.key, row.value);
    }
    return map;
  }

  async setConfigValue(key, value) {
    const nextValue = value == null ? '' : String(value).trim();
    if (!nextValue) {
      await this.execute('DELETE FROM config WHERE `key` = ?', [key]);
      return;
    }

    await this.execute(
      'INSERT INTO config (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [key, nextValue]
    );
  }

  async getAllConfigEntries() {
    return this.query('SELECT `key` AS `key`, value FROM config ORDER BY `key` ASC');
  }

  async importConfigEntries(entries) {
    for (const entry of entries) {
      await this.execute(
        'INSERT INTO config (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [entry.key, entry.value]
      );
    }
  }

  async getSubdomainForClient(clientId) {
    const rows = await this.query('SELECT subdomain FROM clients WHERE client_id = ? LIMIT 1', [clientId]);
    return rows[0] ? rows[0].subdomain : null;
  }

  async getClientMapping(clientId) {
    const rows = await this.query(`
      SELECT client_id, subdomain, ip, hostname, os, created_at, last_seen, publish_domain, publish_mode, assigned_host
      FROM clients
      WHERE client_id = ?
      LIMIT 1
    `, [clientId]);
    return rows[0] || null;
  }

  async isSubdomainTaken(subdomain) {
    const rows = await this.query('SELECT 1 FROM clients WHERE subdomain = ? LIMIT 1', [subdomain]);
    return rows.length > 0;
  }

  async getClientMappingByAssignedHost(assignedHost) {
    const rows = await this.query(`
      SELECT client_id, subdomain, ip, hostname, os, created_at, last_seen, publish_domain, publish_mode, assigned_host
      FROM clients
      WHERE assigned_host = ?
      LIMIT 1
    `, [assignedHost]);
    return rows[0] || null;
  }

  async saveMapping(clientId, payload) {
    const nextPayload = normalizeClientPayload(payload);
    await this.execute(`
      INSERT INTO clients (
        client_id,
        subdomain,
        ip,
        hostname,
        os,
        publish_domain,
        publish_mode,
        assigned_host,
        created_at,
        last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        subdomain = VALUES(subdomain),
        ip = VALUES(ip),
        hostname = VALUES(hostname),
        os = VALUES(os),
        publish_domain = VALUES(publish_domain),
        publish_mode = VALUES(publish_mode),
        assigned_host = VALUES(assigned_host),
        last_seen = VALUES(last_seen)
    `, [
      clientId,
      nextPayload.subdomain,
      nextPayload.ip,
      nextPayload.hostname,
      nextPayload.os,
      nextPayload.publishDomain,
      nextPayload.publishMode,
      nextPayload.assignedHost,
      toMySqlDateTime(nextPayload.createdAt),
      toMySqlDateTime(nextPayload.lastSeen),
    ]);
  }

  async importClients(rows) {
    for (const row of rows) {
      await this.saveMapping(row.client_id, {
        subdomain: row.subdomain,
        ip: row.ip,
        hostname: row.hostname,
        os: row.os,
        publishDomain: row.publish_domain,
        publishMode: row.publish_mode,
        assignedHost: row.assigned_host,
        createdAt: row.created_at,
        lastSeen: row.last_seen,
      });
    }
  }

  async touchClient(clientId, ip) {
    await this.execute(`
      UPDATE clients
      SET last_seen = UTC_TIMESTAMP(),
          ip = ?
      WHERE client_id = ?
    `, [ip || null, clientId]);
  }

  async getAllClients() {
    return this.query('SELECT * FROM clients ORDER BY last_seen DESC');
  }

  async getAllRequestLogs() {
    return this.query(`
      SELECT sync_key, subdomain, client_id, visitor_ip, method, path, host, user_agent, referer, content_type, content_length, status_code, latency_ms, error, created_at
      FROM request_logs
      ORDER BY created_at ASC, id ASC
    `);
  }

  async logRequest(data) {
    const entry = normalizeLogPayload(data);
    await this.execute(`
      INSERT IGNORE INTO request_logs (
        sync_key,
        subdomain,
        client_id,
        visitor_ip,
        method,
        path,
        host,
        user_agent,
        referer,
        content_type,
        content_length,
        status_code,
        latency_ms,
        error,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.syncKey,
      entry.subdomain,
      entry.clientId,
      entry.visitorIp,
      entry.method,
      entry.path,
      entry.host,
      entry.userAgent,
      entry.referer,
      entry.contentType,
      entry.contentLength,
      entry.statusCode,
      entry.latencyMs,
      entry.error,
      toMySqlDateTime(entry.createdAt),
    ]);
  }

  async importRequestLogs(rows) {
    for (const row of rows) {
      await this.logRequest({
        syncKey: row.sync_key,
        createdAt: row.created_at,
        subdomain: row.subdomain,
        clientId: row.client_id,
        visitorIp: row.visitor_ip,
        method: row.method,
        path: row.path,
        host: row.host,
        userAgent: row.user_agent,
        referer: row.referer,
        contentType: row.content_type,
        contentLength: row.content_length,
        statusCode: row.status_code,
        latencyMs: row.latency_ms,
        error: row.error,
      });
    }
  }

  async getRequestLogs(subdomain, limit = 100) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.query(`
      SELECT *
      FROM request_logs
      WHERE subdomain = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `, [subdomain, safeLimit]);
  }

  async getRecentLogs(limit = 100) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    return this.query(`
      SELECT *
      FROM request_logs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `, [safeLimit]);
  }

  async getSubdomainStats(subdomain) {
    const rows = await this.query(`
      SELECT
        subdomain,
        COUNT(*) AS total_requests,
        SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS success_2xx,
        SUM(CASE WHEN status_code >= 300 AND status_code < 400 THEN 1 ELSE 0 END) AS redirect_3xx,
        SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) AS client_err_4xx,
        SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_err_5xx,
        ROUND(AVG(latency_ms), 1) AS avg_latency_ms,
        MAX(latency_ms) AS max_latency_ms
      FROM request_logs
      WHERE subdomain = ?
      GROUP BY subdomain
    `, [subdomain]);
    return rows[0] || null;
  }

  async getTotalRequestCount() {
    const rows = await this.query('SELECT COUNT(*) AS count FROM request_logs');
    return Number(rows[0] && rows[0].count) || 0;
  }

  async cleanupOldLogs() {
    await this.query('DELETE FROM request_logs WHERE created_at < (UTC_TIMESTAMP() - INTERVAL 7 DAY)');
  }
}

async function initializeAdapter(kind) {
  const adapter = kind === 'sqlite'
    ? new SqliteAdapter(SQLITE_PATH)
    : new MySqlAdapter();
  await adapter.init();
  return adapter;
}

async function buildAdapterSet() {
  const kinds = buildEnabledBackends();
  const adapters = new Map();

  const primary = await initializeAdapter(DB_PROVIDER);
  adapters.set(DB_PROVIDER, primary);

  for (const kind of kinds) {
    if (kind === DB_PROVIDER) continue;
    try {
      const adapter = await initializeAdapter(kind);
      adapters.set(kind, adapter);
    } catch (error) {
      if (DB_SYNC_STRICT) {
        throw error;
      }
      console.warn(`[DB] Disabled mirror backend ${kind}: ${error.message}`);
    }
  }

  return adapters;
}

async function bootstrapEmptyBackends() {
  if (!DB_BOOTSTRAP_SYNC || activeAdapters.size < 2) {
    return;
  }

  const statsByKind = new Map();
  for (const [kind, adapter] of activeAdapters.entries()) {
    statsByKind.set(kind, await adapter.getStats());
  }

  let sourceKind = DB_PROVIDER;
  let sourceStats = statsByKind.get(sourceKind);
  if (!hasSnapshotData(sourceStats)) {
    for (const [kind, stats] of statsByKind.entries()) {
      if (hasSnapshotData(stats)) {
        sourceKind = kind;
        sourceStats = stats;
        break;
      }
    }
  }

  if (!hasSnapshotData(sourceStats)) {
    return;
  }

  const sourceAdapter = activeAdapters.get(sourceKind);
  const snapshot = {
    configEntries: await sourceAdapter.getAllConfigEntries(),
    clients: await sourceAdapter.getAllClients(),
    requestLogs: await sourceAdapter.getAllRequestLogs(),
  };

  for (const [kind, adapter] of activeAdapters.entries()) {
    if (kind === sourceKind) continue;
    if (hasSnapshotData(statsByKind.get(kind))) continue;

    await adapter.importConfigEntries(snapshot.configEntries);
    await adapter.importClients(snapshot.clients);
    await adapter.importRequestLogs(snapshot.requestLogs);
    console.log(`[DB] Bootstrapped ${kind} from ${sourceKind}.`);
  }
}

async function getConfigValue(key) {
  return withPrimaryRead('getConfigValue', key);
}

async function setConfigValue(key, value) {
  return fanoutWrite('setConfigValue', [key, value], `config:${key}`);
}

async function seedServerConfig() {
  if (!await getConfigValue(CONFIG_KEYS.primaryDomain) && ENV_PRIMARY_DOMAIN) {
    await setConfigValue(CONFIG_KEYS.primaryDomain, ENV_PRIMARY_DOMAIN);
  }

  if (!await getConfigValue(CONFIG_KEYS.controlRoot)) {
    await setConfigValue(CONFIG_KEYS.controlRoot, normalizeControlRoot('/_private-tunnel'));
  }

  if (!await getConfigValue(CONFIG_KEYS.tunnelDomain) && ENV_TUNNEL_DOMAIN) {
    await setConfigValue(CONFIG_KEYS.tunnelDomain, ENV_TUNNEL_DOMAIN);
  }

  const storedPrimaryDomain = await getConfigValue(CONFIG_KEYS.primaryDomain);
  const storedTunnelDomain = await getConfigValue(CONFIG_KEYS.tunnelDomain);

  if (!storedTunnelDomain && storedPrimaryDomain) {
    await setConfigValue(CONFIG_KEYS.tunnelDomain, storedPrimaryDomain);
  }

  if (!storedPrimaryDomain && storedTunnelDomain) {
    await setConfigValue(CONFIG_KEYS.primaryDomain, storedTunnelDomain);
  }

  if (!await getConfigValue(CONFIG_KEYS.tunnelToken) && ENV_TUNNEL_TOKEN) {
    await setConfigValue(CONFIG_KEYS.tunnelToken, ENV_TUNNEL_TOKEN);
  }

  if (!await getConfigValue(CONFIG_KEYS.publishDomains)) {
    const primaryDomain = normalizeDomain(await getConfigValue(CONFIG_KEYS.primaryDomain) || ENV_PRIMARY_DOMAIN || '');
    const tunnelDomain = normalizeDomain(
      await getConfigValue(CONFIG_KEYS.tunnelDomain)
      || ENV_TUNNEL_DOMAIN
      || primaryDomain
      || ''
    );

    const publishDomains = normalizePublishDomains(
      tunnelDomain
        ? [{ domain: tunnelDomain, allowSubdomain: true, allowRoot: tunnelDomain !== primaryDomain }]
        : [],
      tunnelDomain
    );

    if (publishDomains.length) {
      await setConfigValue(CONFIG_KEYS.publishDomains, JSON.stringify(publishDomains));
    }
  }

}

async function ensureAdminPassword() {
  const existingHash = await getConfigValue(CONFIG_KEYS.adminPasswordHash);
  if (existingHash) return;

  const legacyHash = await getConfigValue(CONFIG_KEYS.legacyDashboardPassword);
  if (legacyHash) {
    await setConfigValue(CONFIG_KEYS.adminPasswordHash, legacyHash);
    await setConfigValue(CONFIG_KEYS.legacyDashboardPassword, '');
    return;
  }

  if (ENV_DASHBOARD_PASSWORD) {
    await setConfigValue(CONFIG_KEYS.adminPasswordHash, hashPassword(ENV_DASHBOARD_PASSWORD));
    removeBootstrapPasswordFile();
    return;
  }

  const bootstrapPassword = crypto.randomBytes(18).toString('base64url');
  await setConfigValue(CONFIG_KEYS.adminPasswordHash, hashPassword(bootstrapPassword));
  writeBootstrapPasswordFile(bootstrapPassword);
}

async function initDatabase() {
  if (primaryAdapter) {
    return primaryAdapter;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    activeAdapters = await buildAdapterSet();
    primaryAdapter = activeAdapters.get(DB_PROVIDER);

    if (!primaryAdapter) {
      throw new Error(`Primary DB provider ${DB_PROVIDER} could not be initialized`);
    }

    await bootstrapEmptyBackends();
    await seedServerConfig();
    await ensureAdminPassword();

    console.log(`[DB] Primary backend: ${DB_PROVIDER}${activeAdapters.size > 1 ? ` | Mirrors: ${[...activeAdapters.keys()].filter((kind) => kind !== DB_PROVIDER).join(', ')}` : ''}`);

    if (!cleanupTimer) {
      cleanupTimer = setInterval(() => {
        for (const [kind, adapter] of activeAdapters.entries()) {
          Promise.resolve(adapter.cleanupOldLogs()).catch((error) => {
            console.error(`[DB] Log cleanup failed on ${kind}:`, error.message);
          });
        }
      }, 3600000);
      if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
      }
    }

    return primaryAdapter;
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    primaryAdapter = null;
    activeAdapters = new Map();
    throw error;
  }
}

async function hasDashboardPassword() {
  return !!await getConfigValue(CONFIG_KEYS.adminPasswordHash);
}

async function isUsingLegacyDefaultPassword() {
  const value = await getConfigValue(CONFIG_KEYS.adminPasswordHash);
  return !!value && constantTimeEquals(value, LEGACY_DEFAULT_PASSWORD_HASH);
}

async function verifyPassword(password) {
  if (!password) return false;
  const value = await getConfigValue(CONFIG_KEYS.adminPasswordHash);
  if (!value) return false;
  return constantTimeEquals(value, hashPassword(password));
}

async function setDashboardPassword(password) {
  const nextPassword = String(password || '');
  if (nextPassword.trim().length < 10) {
    throw new Error('Admin password must be at least 10 characters long');
  }

  await setConfigValue(CONFIG_KEYS.adminPasswordHash, hashPassword(nextPassword));
  removeBootstrapPasswordFile();
}

async function getServerSettings() {
  const config = await withPrimaryRead('getConfigMap');
  const primaryDomain = normalizeDomain(config.get(CONFIG_KEYS.primaryDomain) || ENV_PRIMARY_DOMAIN || '');
  const controlRoot = normalizeControlRoot(config.get(CONFIG_KEYS.controlRoot) || '/_private-tunnel') || '/_private-tunnel';
  const legacyTunnelDomain = normalizeDomain(
    config.get(CONFIG_KEYS.tunnelDomain)
    || ENV_TUNNEL_DOMAIN
    || primaryDomain
    || ''
  );
  const publishDomains = buildPublishDomains(
    parsePublishDomainsValue(config.get(CONFIG_KEYS.publishDomains)),
    legacyTunnelDomain || primaryDomain,
    primaryDomain
  );
  const tunnelDomain = publishDomains.find((entry) => entry.allowSubdomain)?.domain
    || publishDomains[0]?.domain
    || legacyTunnelDomain;
  const tunnelToken = String(config.get(CONFIG_KEYS.tunnelToken) || ENV_TUNNEL_TOKEN || '').trim();

  return {
    primaryDomain,
    controlRoot,
    tunnelDomain,
    publishDomains,
    tunnelToken,
    hasTunnelToken: !!tunnelToken,
    bootstrapPasswordFile: getBootstrapPasswordFilePath(),
  };
}

async function prepareServerSettings(input, baseSettings) {
  const payload = input || {};
  const resolvedBaseSettings = baseSettings || await getServerSettings();
  const nextPrimaryDomain = Object.prototype.hasOwnProperty.call(payload, 'primaryDomain')
    ? normalizeDomain(payload.primaryDomain)
    : normalizeDomain(resolvedBaseSettings.primaryDomain || '');
  if (nextPrimaryDomain && !isValidDomain(nextPrimaryDomain)) {
    throw new Error('Primary domain must be a valid hostname');
  }

  const nextControlRoot = Object.prototype.hasOwnProperty.call(payload, 'controlRoot')
    ? normalizeControlRoot(payload.controlRoot)
    : normalizeControlRoot(resolvedBaseSettings.controlRoot || '/_private-tunnel');
  if (!isValidControlRoot(nextControlRoot)) {
    throw new Error('Control namespace must be a safe path like /_private-tunnel');
  }

  let nextPublishDomains;
  if (Object.prototype.hasOwnProperty.call(payload, 'publishDomains')) {
    if (!Array.isArray(payload.publishDomains)) {
      throw new Error('Publish domains must be an array');
    }
    nextPublishDomains = buildPublishDomains(payload.publishDomains, '', nextPrimaryDomain);
  } else {
    nextPublishDomains = buildPublishDomains(resolvedBaseSettings.publishDomains, '', nextPrimaryDomain);
  }

  const requestedTunnelDomain = Object.prototype.hasOwnProperty.call(payload, 'tunnelDomain')
    ? normalizeDomain(payload.tunnelDomain)
    : normalizeDomain(resolvedBaseSettings.tunnelDomain || '');
  if (requestedTunnelDomain && !isValidDomain(requestedTunnelDomain)) {
    throw new Error('Tunnel domain must be a valid hostname');
  }

  const tunnelDomain = requestedTunnelDomain
    || nextPublishDomains.find((entry) => entry.allowSubdomain)?.domain
    || nextPublishDomains[0]?.domain
    || nextPrimaryDomain
    || '';
  if (!nextPublishDomains.length && tunnelDomain) {
    nextPublishDomains = buildPublishDomains(
      [{ domain: tunnelDomain, allowSubdomain: true, allowRoot: tunnelDomain !== nextPrimaryDomain }],
      tunnelDomain,
      nextPrimaryDomain
    );
  }

  const nextSettings = {
    primaryDomain: nextPrimaryDomain || tunnelDomain,
    controlRoot: nextControlRoot,
    tunnelDomain: tunnelDomain || nextPrimaryDomain,
    publishDomains: buildPublishDomains(nextPublishDomains, tunnelDomain, nextPrimaryDomain || tunnelDomain),
    tunnelToken: Object.prototype.hasOwnProperty.call(payload, 'tunnelToken')
      ? String(payload.tunnelToken || '').trim()
      : String(resolvedBaseSettings.tunnelToken || '').trim(),
  };

  nextSettings.publishDomains = buildPublishDomains(
    nextSettings.publishDomains,
    nextSettings.tunnelDomain || nextSettings.primaryDomain,
    nextSettings.primaryDomain
  );
  nextSettings.hasTunnelToken = !!nextSettings.tunnelToken;
  nextSettings.bootstrapPasswordFile = getBootstrapPasswordFilePath();

  return nextSettings;
}

async function persistServerSettings(settings) {
  await setConfigValue(CONFIG_KEYS.primaryDomain, settings.primaryDomain);
  await setConfigValue(CONFIG_KEYS.controlRoot, settings.controlRoot);
  await setConfigValue(CONFIG_KEYS.tunnelDomain, settings.tunnelDomain);
  await setConfigValue(
    CONFIG_KEYS.publishDomains,
    settings.publishDomains && settings.publishDomains.length ? JSON.stringify(settings.publishDomains) : ''
  );
  await setConfigValue(CONFIG_KEYS.tunnelToken, settings.tunnelToken);
}

async function updateServerSettings(input) {
  const nextSettings = input && input.publishDomains ? input : await prepareServerSettings(input);
  await persistServerSettings(nextSettings);
  return getServerSettings();
}

async function getSubdomainForClient(clientId) {
  return withPrimaryRead('getSubdomainForClient', clientId);
}

async function getClientMapping(clientId) {
  return withPrimaryRead('getClientMapping', clientId);
}

async function isSubdomainTaken(subdomain) {
  return withPrimaryRead('isSubdomainTaken', subdomain);
}

async function getClientMappingByAssignedHost(assignedHost) {
  return withPrimaryRead('getClientMappingByAssignedHost', assignedHost);
}

async function saveMapping(clientId, subdomainOrData, ip, hostname, os) {
  const payload = typeof subdomainOrData === 'object' && subdomainOrData
    ? subdomainOrData
    : {
        subdomain: subdomainOrData,
        ip,
        hostname,
        os,
      };
  return fanoutWrite('saveMapping', [clientId, payload], `client:${clientId}`);
}

async function touchClient(clientId, ip) {
  return fanoutWrite('touchClient', [clientId, ip], `touch:${clientId}`);
}

async function getAllClients() {
  return withPrimaryRead('getAllClients');
}

async function logRequest(data) {
  return fanoutWrite('logRequest', [normalizeLogPayload(data)], `request-log:${data.subdomain || 'unknown'}`);
}

async function getRequestLogs(subdomain, limit = 100) {
  return withPrimaryRead('getRequestLogs', subdomain, limit);
}

async function getRecentLogs(limit = 100) {
  return withPrimaryRead('getRecentLogs', limit);
}

async function getSubdomainStats(subdomain) {
  return withPrimaryRead('getSubdomainStats', subdomain);
}

async function getTotalRequestCount() {
  return withPrimaryRead('getTotalRequestCount');
}

module.exports = {
  initDatabase,
  verifyPassword,
  hasDashboardPassword,
  isUsingLegacyDefaultPassword,
  setDashboardPassword,
  getBootstrapPasswordFilePath,
  getServerSettings,
  prepareServerSettings,
  updateServerSettings,
  getSubdomainForClient,
  getClientMapping,
  getClientMappingByAssignedHost,
  isSubdomainTaken,
  saveMapping,
  touchClient,
  getAllClients,
  logRequest,
  getRequestLogs,
  getRecentLogs,
  getSubdomainStats,
  getTotalRequestCount,
};
