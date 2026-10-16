const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Opt in only against a disposable local MySQL server. The test creates and drops
// its own randomly named schema; it never loads .env or uses MYSQL_DATABASE.
// MYSQL_TEST=1 MYSQL_TEST_CONFIG='{"host":"127.0.0.1","port":...,
//   "user":"root","password":"..."}' node --test tests/mysql-integration.test.js
test('real MySQL preserves mapping ownership and password rotation', {
  skip: process.env.MYSQL_TEST !== '1' ? 'Set MYSQL_TEST=1 and MYSQL_TEST_CONFIG for a disposable local MySQL server' : false,
  timeout: 30000,
}, async (t) => {
  const config = JSON.parse(process.env.MYSQL_TEST_CONFIG || '{}');
  assert.ok(['127.0.0.1', '::1', 'localhost'].includes(config.host), 'MySQL integration tests require an explicit loopback host');
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535, 'An explicit MySQL port is required');
  assert.ok(typeof config.user === 'string' && config.user, 'An explicit MySQL test user is required');
  assert.ok(typeof config.password === 'string' && config.password, 'An explicit MySQL test password is required');

  const schema = `ptunnel_test_${crypto.randomBytes(12).toString('hex')}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-mysql-test-'));
  const previousEnvironment = { ...process.env };
  Object.assign(process.env, {
    DB_PROVIDER: 'mysql', DB_SYNC_TARGETS: '', DB_BOOTSTRAP_SYNC: 'false', DB_SYNC_STRICT: 'true',
    MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_USER: config.user,
    MYSQL_PASSWORD: config.password, MYSQL_DATABASE: schema,
    DATA_DIR: directory, SQLITE_PATH: path.join(directory, 'unused.db'),
    PRIMARY_DOMAIN: 'admin.example.test', DOMAIN: '', TUNNEL_DOMAIN: 'apps.example.test',
    DASHBOARD_PASSWORD: 'mysql-test-initial-password', TUNNEL_TOKEN: crypto.randomBytes(32).toString('hex'),
    ALLOW_UNAUTHENTICATED_TUNNELS: 'false',
  });
  const mysql = require('mysql2/promise');
  const db = require('../server/db');
  let inspector;
  t.after(async () => {
    try {
      await db.closeDatabase();
      if (inspector) await inspector.query(`DROP DATABASE IF EXISTS \`${schema}\``);
    } finally {
      if (inspector) await inspector.end();
      for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
      Object.assign(process.env, previousEnvironment);
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('ptunnel-mysql-test-'));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  inspector = await mysql.createConnection(config);
  await db.initDatabase();

  const payload = (subdomain, assignedHost, extra = {}) => ({
    subdomain, assignedHost, publishDomain: 'apps.example.test', publishMode: 'subdomain',
    ip: '127.0.0.1', hostname: 'test-host', os: 'test',
    createdAt: '2026-01-02T03:04:05.000Z', lastSeen: '2026-01-02T03:04:05.000Z', ...extra,
  });
  await db.saveMapping('victim', payload('reserved', 'reserved.apps.example.test'));
  await db.saveMapping('other-victim', payload('other-reserved', 'other.apps.example.test'));
  await db.saveMapping('existing-client', payload('existing', 'existing.apps.example.test'));
  const victim = await db.getClientMapping('victim');
  const otherVictim = await db.getClientMapping('other-victim');
  const existing = await db.getClientMapping('existing-client');

  await t.test('new clients cannot overwrite rows through either secondary unique key', async () => {
    for (const [id, value] of [
      ['new-host-conflict', payload('free-host-label', 'reserved.apps.example.test')],
      ['new-label-conflict', payload('reserved', 'free-label.apps.example.test')],
      ['new-two-conflicts', payload('reserved', 'other.apps.example.test')],
    ]) {
      await assert.rejects(db.saveMapping(id, value), { code: 'ER_DUP_ENTRY' });
      assert.equal(await db.getClientMapping(id), null);
      assert.deepEqual(await db.getClientMapping('victim'), victim);
      assert.deepEqual(await db.getClientMapping('other-victim'), otherVictim);
    }
  });

  await t.test('existing clients cannot claim another owner\'s host or subdomain', async () => {
    for (const value of [
      payload('free-existing-label', 'reserved.apps.example.test'),
      payload('reserved', 'free-existing.apps.example.test'),
      payload('reserved', 'other.apps.example.test'),
    ]) {
      await assert.rejects(db.saveMapping('existing-client', value), { code: 'ER_DUP_ENTRY' });
      assert.deepEqual(await db.getClientMapping('existing-client'), existing);
      assert.deepEqual(await db.getClientMapping('victim'), victim);
      assert.deepEqual(await db.getClientMapping('other-victim'), otherVictim);
    }
  });

  await t.test('owners can update their mapping while preserving its creation time', async () => {
    const value = payload('owner-updated', 'owner-updated.apps.example.test', {
      hostname: 'updated-host', ip: '127.0.0.2', createdAt: '2026-02-03T04:05:06.000Z',
      lastSeen: '2026-02-03T04:05:06.000Z',
    });
    await db.saveMapping('existing-client', value);
    await db.saveMapping('existing-client', value); // An unchanged write is valid too.
    const updated = await db.getClientMapping('existing-client');
    assert.equal(updated.subdomain, value.subdomain);
    assert.equal(updated.assigned_host, value.assignedHost);
    assert.equal(updated.hostname, value.hostname);
    assert.equal(updated.ip, value.ip);
    assert.deepEqual(updated.created_at, existing.created_at);
    assert.equal(updated.last_seen.toISOString(), value.lastSeen);
    assert.equal((await db.getClientMappingByAssignedHost(value.assignedHost)).client_id, 'existing-client');
    assert.equal(await db.getSubdomainForClient('existing-client'), value.subdomain);
  });

  await t.test('simultaneous first writes for one identity all succeed', async () => {
    const value = payload('concurrent-first', 'concurrent-first.apps.example.test');
    await Promise.all(Array.from({ length: 12 }, () => db.saveMapping('concurrent-client', value)));
    const rows = (await db.getAllClients()).filter((row) => row.client_id === 'concurrent-client');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assigned_host, value.assignedHost);
    assert.deepEqual(await db.getClientMapping('victim'), victim);
  });

  await t.test('legacy verification upgrades to scrypt and password rotation persists', async () => {
    assert.equal(await db.verifyPassword('mysql-test-initial-password'), true);
    const legacyPassword = 'mysql-test-legacy-password';
    const legacyHash = crypto.createHash('sha256').update(legacyPassword).digest('hex');
    await inspector.execute(`UPDATE \`${schema}\`.config SET value=? WHERE \`key\`=?`, [legacyHash, 'admin_password_hash']);
    assert.equal(await db.verifyPassword('incorrect'), false);
    const legacyAllowed = Date.now() < require('../server/security').LEGACY_PASSWORD_HASH_CUTOFF;
    assert.equal(await db.verifyPassword(legacyPassword), legacyAllowed);
    const [[upgraded]] = await inspector.execute(`SELECT value FROM \`${schema}\`.config WHERE \`key\`=?`, ['admin_password_hash']);
    if (legacyAllowed) assert.match(upgraded.value, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    else assert.equal(upgraded.value, legacyHash);
    await assert.rejects(db.setDashboardPassword('short'), /at least 10/);
    await db.setDashboardPassword('mysql-test-rotated-password');
    assert.equal(await db.verifyPassword(legacyPassword), false);
    assert.equal(await db.verifyPassword('mysql-test-rotated-password'), true);
    await db.closeDatabase();
    await db.initDatabase();
    assert.equal(await db.verifyPassword('mysql-test-rotated-password'), true);
    assert.equal(await db.verifyPassword(legacyPassword), false);
  });
});
