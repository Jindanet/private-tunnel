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
        await Promise.all([db.initDatabase(), db.initDatabase()]);
        const settings = await db.getServerSettings();
        result = {
          initialized: true,
          token: settings.tunnelToken,
          passwordWorks: await db.verifyPassword(process.env.VERIFY_TEST_PASSWORD || process.env.DASHBOARD_PASSWORD),
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

test('a supplied weak bootstrap admin password cannot create credentials on first boot', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  t.after(() => removeTestDirectory(directory));
  for (const [index, password] of ['short', 'admin', 'your-password-here', 'x'.repeat(1025)].entries()) {
    const dataDirectory = path.join(directory, `invalid-password-${index}`);
    const result = startupResult(dataDirectory, '', {DASHBOARD_PASSWORD:password});
    assert.equal(result.initialized, false);
    assert.match(result.error, /at least 10|example DASHBOARD_PASSWORD|1024 characters/);
    assert.equal(result.liveSettingsAvailable, false);
    assert.equal(fs.existsSync(path.join(dataDirectory, 'admin-bootstrap.txt')), false);
    const databasePath = path.join(dataDirectory, 'test.db');
    if (fs.existsSync(databasePath)) {
      const inspector = new (require('better-sqlite3'))(databasePath, { readonly: true });
      try { assert.equal(inspector.prepare('SELECT COUNT(*) AS count FROM config').get().count, 0); }
      finally { inspector.close(); }
    }
  }
});

test('stored administrator credentials take precedence over stale bootstrap environment values', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  t.after(() => removeTestDirectory(directory));
  const token = crypto.randomBytes(32).toString('base64url');
  assert.equal(startupResult(directory, token).initialized, true);
  const Database = require('better-sqlite3');
  function storedHash() {
    const inspector = new Database(path.join(directory, 'test.db'), { readonly: true });
    try { return inspector.prepare('SELECT value FROM config WHERE key=?').get('admin_password_hash').value; }
    finally { inspector.close(); }
  }
  const originalHash = storedHash();
  for (const password of ['short', 'admin', 'your-password-here', 'x'.repeat(1025), '', 'different-valid-bootstrap-password']) {
    const result = startupResult(directory, token, { DASHBOARD_PASSWORD: password, VERIFY_TEST_PASSWORD: adminPassword });
    assert.equal(result.initialized, true, 'An existing password must make the bootstrap value irrelevant');
    assert.equal(result.passwordWorks, true, 'The original administrator password must keep working');
    assert.equal(storedHash(), originalHash, 'Startup must never reset or replace the saved hash');
    assert.equal(fs.existsSync(path.join(directory, 'admin-bootstrap.txt')), false);
  }
});

test('an existing legacy database password key is migrated before consulting the environment', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  t.after(() => removeTestDirectory(directory));
  const token = crypto.randomBytes(32).toString('base64url');
  assert.equal(startupResult(directory, token).initialized, true);
  const Database = require('better-sqlite3');
  let originalHash;
  const inspector = new Database(path.join(directory, 'test.db'));
  try {
    originalHash = inspector.prepare('SELECT value FROM config WHERE key=?').get('admin_password_hash').value;
    inspector.prepare('DELETE FROM config WHERE key=?').run('admin_password_hash');
    inspector.prepare('INSERT OR REPLACE INTO config (key,value) VALUES (?,?)').run('dashboard_password', originalHash);
  } finally { inspector.close(); }
  const result = startupResult(directory, token, { DASHBOARD_PASSWORD: 'admin', VERIFY_TEST_PASSWORD: adminPassword });
  assert.equal(result.initialized, true);
  assert.equal(result.passwordWorks, true);
  const after = new Database(path.join(directory, 'test.db'), { readonly: true });
  try {
    assert.equal(after.prepare('SELECT value FROM config WHERE key=?').get('admin_password_hash').value, originalHash);
    assert.equal(after.prepare('SELECT value FROM config WHERE key=?').get('dashboard_password')?.value ?? '', '');
  } finally { after.close(); }
});

test('an empty bootstrap password generates a private first-boot password that persists across restarts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-policy-'));
  t.after(() => removeTestDirectory(directory));
  const token = crypto.randomBytes(32).toString('base64url');
  assert.equal(startupResult(directory, token, { DASHBOARD_PASSWORD: '' }).initialized, true);
  const file = path.join(directory, 'admin-bootstrap.txt');
  const content = fs.readFileSync(file, 'utf8');
  const password = content.split(/\r?\n/)[2];
  assert.ok(password.length >= 10);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const restarted = startupResult(directory, token, { DASHBOARD_PASSWORD: '', VERIFY_TEST_PASSWORD: password });
  assert.equal(restarted.initialized, true);
  assert.equal(restarted.passwordWorks, true);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});
