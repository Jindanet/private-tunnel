const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { authenticateTunnel, isValidTunnelToken, validateTunnelToken } = require('../server/security');

const adminPassword = 'key-policy-test-admin-password';
const databaseModulePath = require.resolve('../server/db');
const invalidKeys = [
  '', 'short', 'x'.repeat(31),
  'your_' + 'x'.repeat(40), 'REPLACE-' + 'x'.repeat(40),
  'Change_' + 'x'.repeat(40), 'example-' + 'x'.repeat(40),
  'x'.repeat(32) + ' ' + 'y'.repeat(32),
  'x'.repeat(32) + '\n' + 'y'.repeat(32),
  'x'.repeat(32) + '\u00e9', 'x'.repeat(4097),
  null, undefined, false, 1234567890123456789012345678901234567890,
  ['x'.repeat(40)], { toString: () => 'x'.repeat(40) },
];

function isolatedEnvironment(directory, token) {
  return {
    DATA_DIR: directory,
    SQLITE_PATH: path.join(directory, 'test.db'),
    DB_PATH: path.join(directory, 'test.db'),
    DB_PROVIDER: 'sqlite', DB_SYNC_TARGETS: '', DB_BOOTSTRAP_SYNC: 'false', DB_SYNC_STRICT: 'true',
    DOMAIN: '', PRIMARY_DOMAIN: 'admin.example.test', TUNNEL_DOMAIN: 'apps.example.test',
    TUNNEL_TOKEN: token, DASHBOARD_PASSWORD: adminPassword,
    ALLOW_UNAUTHENTICATED_TUNNELS: 'false',
    NODE_OPTIONS: '',
  };
}

function removeTestDirectory(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('ptunnel-key-policy-'));
  fs.rmSync(directory, { recursive: true, force: true });
}

function startupResult(directory, token, extraEnvironment = {}) {
  // Require the database directly: neither this test nor the child loads dotenv or .env.
  const source = `
    const db = require(${JSON.stringify(databaseModulePath)});
    (async () => {
      let result;
      try {
        await db.initDatabase();
        const settings = await db.getServerSettings();
        result = {
          initialized: true,
          token: settings.tunnelToken,
          passwordWorks: await db.verifyPassword(process.env.DASHBOARD_PASSWORD),
        };
      } catch (error) {
        let liveSettingsAvailable = false;
        try { await db.getServerSettings(); liveSettingsAvailable = true; } catch {}
        result = { initialized: false, error: error.message, liveSettingsAvailable };
      } finally {
        await db.closeDatabase();
      }
      console.log(JSON.stringify({ keyPolicyStartup: result }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ['-e', source], {
    env: { ...process.env, ...isolatedEnvironment(directory, token), ...extraEnvironment },
    encoding: 'utf8', timeout: 15000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `Startup child failed:\n${child.stderr}\n${child.stdout}`);
  const output = child.stdout.trim().split(/\r?\n/).at(-1);
  return JSON.parse(output).keyPolicyStartup;
}

test('access keys reject short, placeholder, non-text and malformed values', () => {
  for (const value of invalidKeys) {
    assert.equal(isValidTunnelToken(value), false);
    assert.throws(() => validateTunnelToken(value), /Access key/);
  }
  for (const value of ['x'.repeat(32), crypto.randomBytes(32).toString('base64url'), 'x'.repeat(4096)]) {
    assert.equal(isValidTunnelToken(value), true);
    assert.equal(validateTunnelToken(` ${value}\n`), value);
  }
  assert.equal(validateTunnelToken('  ', { allowEmpty: true }), '');
  assert.throws(() => validateTunnelToken('short', { allowEmpty: true }), /Access key/);
  assert.throws(() => validateTunnelToken(null, { allowEmpty: true }), /Access key/);
});

test('settings reject weak keys without writes and allow admin recovery from a legacy key', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  const initialKey = crypto.randomBytes(32).toString('base64url');
  const environment = isolatedEnvironment(directory, initialKey);
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  let db;
  t.after(async () => {
    try {
      if (db) await db.closeDatabase();
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete require.cache[databaseModulePath];
      removeTestDirectory(directory);
    }
  });
  Object.assign(process.env, environment);
  db = require('../server/db');
  await db.initDatabase();
  const originalSettings = await db.getServerSettings();
  assert.equal(originalSettings.tunnelToken, initialKey);
  assert.equal(await db.isUsingLegacyPasswordHash(), false);

  await t.test('prepare and update reject every invalid key before changing settings', async () => {
    for (const tunnelToken of invalidKeys) {
      await assert.rejects(db.prepareServerSettings({ publishDomains: [], tunnelToken }), /Access key/);
      await assert.rejects(db.updateServerSettings({ publishDomains: [], tunnelToken }), /Access key/);
      assert.deepEqual(await db.getServerSettings(), originalSettings);
    }
    process.env.ALLOW_UNAUTHENTICATED_TUNNELS = 'true';
    try {
      await assert.rejects(db.updateServerSettings({ publishDomains: [], tunnelToken: 'short' }), /Access key/);
      assert.deepEqual(await db.getServerSettings(), originalSettings);
    } finally {
      process.env.ALLOW_UNAUTHENTICATED_TUNNELS = 'false';
    }
  });

  await t.test('a saved legacy key fails authentication while the admin can rotate it', async () => {
    await db.closeDatabase();
    const Database = require('better-sqlite3');
    const inspector = new Database(environment.SQLITE_PATH);
    const weakKey = 'legacy-weak-key';
    try {
      const changed = inspector.prepare('UPDATE config SET value = ? WHERE key = ?').run(weakKey, 'tunnel_token');
      assert.equal(changed.changes, 1);
      const passwordChanged = inspector.prepare('UPDATE config SET value = ? WHERE key = ?').run(
        crypto.createHash('sha256').update(adminPassword).digest('hex'), 'admin_password_hash'
      );
      assert.equal(passwordChanged.changes, 1);
    } finally {
      inspector.close();
    }
    await db.initDatabase();
    const legacySettings = await db.getServerSettings();
    assert.equal(legacySettings.tunnelToken, weakKey);
    const bearer = { headers: { authorization: `Bearer ${weakKey}` }, url: '/ws' };
    const query = { headers: {}, url: `/ws?token=${encodeURIComponent(weakKey)}` };
    const legacyOptIn = { allowLegacyQuery: true, allowUnauthenticated: true };
    assert.equal(authenticateTunnel(bearer, legacySettings.tunnelToken, legacyOptIn), false);
    assert.equal(authenticateTunnel(query, legacySettings.tunnelToken, legacyOptIn), false);
    assert.equal(await db.isUsingLegacyPasswordHash(), true);
    assert.equal(await db.verifyPassword('wrong-admin-password'), false);
    assert.equal(await db.isUsingLegacyPasswordHash(), true);
    assert.equal(await db.verifyPassword(adminPassword), true);
    assert.equal(await db.isUsingLegacyPasswordHash(), false);

    const rotatedKey = crypto.randomBytes(32).toString('base64url');
    const rotatedSettings = await db.updateServerSettings({ publishDomains: [], tunnelToken: rotatedKey });
    assert.equal(rotatedSettings.tunnelToken, rotatedKey);
    assert.equal(authenticateTunnel({ headers: { authorization: `Bearer ${rotatedKey}` }, url: '/ws' }, rotatedKey), true);
    assert.equal(authenticateTunnel({ headers: {}, url: `/ws?token=${rotatedKey}` }, rotatedKey, legacyOptIn), true);
    assert.equal(authenticateTunnel(bearer, rotatedKey, legacyOptIn), false);
    await db.closeDatabase();
    await db.initDatabase();
    assert.equal((await db.getServerSettings()).tunnelToken, rotatedKey);
    assert.equal(await db.verifyPassword(adminPassword), true);
  });

  await t.test('an imported whitespace key cannot become opt-in unauthenticated access', async () => {
    await db.closeDatabase();
    const Database = require('better-sqlite3');
    const inspector = new Database(environment.SQLITE_PATH);
    try {
      inspector.prepare('UPDATE config SET value = ? WHERE key = ?').run('   ', 'tunnel_token');
    } finally { inspector.close(); }
    process.env.ALLOW_UNAUTHENTICATED_TUNNELS = 'true';
    try {
      await db.initDatabase();
      const settings = await db.getServerSettings();
      assert.equal(settings.tunnelToken, '   ');
      assert.equal(authenticateTunnel({headers:{},url:'/ws'}, settings.tunnelToken, {allowUnauthenticated:true}), false);
      assert.equal(await db.verifyPassword(adminPassword), true);
    } finally { process.env.ALLOW_UNAUTHENTICATED_TUNNELS = 'false'; }
  });
});

test('weak startup environment keys fail before creating database or live settings', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  t.after(() => removeTestDirectory(directory));
  const weakKeys = ['short', 'your_' + 'x'.repeat(40), 'change-' + 'x'.repeat(40)];
  for (const [index, token] of weakKeys.entries()) {
    for (const allowUnauthenticated of ['false', 'true']) {
      const dataDirectory = path.join(directory, `${index}-${allowUnauthenticated}`);
      const result = startupResult(dataDirectory, token, { ALLOW_UNAUTHENTICATED_TUNNELS: allowUnauthenticated });
      assert.equal(result.initialized, false);
      assert.match(result.error, /Access key/);
      assert.equal(result.liveSettingsAvailable, false);
      assert.equal(fs.existsSync(dataDirectory), false);
    }
  }
});

test('empty first-boot environment creates an independent valid random key', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  t.after(() => removeTestDirectory(directory));
  const generatedKeys = [];
  const Database = require('better-sqlite3');
  for (let index = 0; index < 2; index += 1) {
    const dataDirectory = path.join(directory, String(index));
    const result = startupResult(dataDirectory, '');
    assert.equal(result.initialized, true);
    assert.equal(result.passwordWorks, true);
    assert.equal(isValidTunnelToken(result.token), true);
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    const inspector = new Database(path.join(dataDirectory, 'test.db'), { readonly: true });
    try {
      assert.equal(inspector.prepare('SELECT value FROM config WHERE key = ?').get('tunnel_token').value, result.token);
    } finally {
      inspector.close();
    }
    generatedKeys.push(result.token);
  }
  assert.notEqual(generatedKeys[0], generatedKeys[1]);
});

test('a supplied weak bootstrap admin password fails before creating state', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  t.after(() => removeTestDirectory(directory));
  const dataDirectory = path.join(directory, 'invalid-password');
  const result = startupResult(dataDirectory, '', {DASHBOARD_PASSWORD:'short'});
  assert.equal(result.initialized, false);
  assert.match(result.error, /at least 10/);
  assert.equal(fs.existsSync(dataDirectory), false);
});
