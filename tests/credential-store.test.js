const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createCredentialStore } = require('../app/credential-store');

function fixture(t, { available = true, backend = 'gnome_libsecret', platform = process.platform } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-credentials-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'desktop.json');
  const legacyPath = path.join(directory, 'cli.json');
  let ready = false;
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString('utf8');
    },
  };
  const store = createCredentialStore({ configPath, legacyPath, safeStorage, platform, isReady: () => ready });
  return { directory, configPath, legacyPath, store, safeStorage, ready: () => { ready = true; },
    read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}

test('credential I/O waits for Electron readiness and legacy migration preserves the CLI file', (t) => {
  const item = fixture(t);
  const legacy = { serverUrl: 'wss://server.example.test', token: 'legacy-secret-test-key', tunnels: [{ id: 'kept' }] };
  const original = JSON.stringify(legacy);
  fs.writeFileSync(item.legacyPath, original);
  assert.throws(() => item.store.load(), /before Electron is ready/);
  assert.throws(() => item.store.save(legacy), /before Electron is ready/);
  assert.equal(fs.existsSync(item.configPath), false);
  item.ready();
  const loaded = item.store.load();
  assert.deepEqual(loaded.config, legacy);
  assert.equal(loaded.credentialStorageError, null);
  assert.equal(fs.readFileSync(item.legacyPath, 'utf8'), original);
  assert.equal(item.read().token, undefined);
  assert.equal(item.read().credential.version, 1);
  assert.equal(fs.readFileSync(item.configPath, 'utf8').includes(legacy.token), false);
  assert.equal(item.store.load().config.token, legacy.token);
  item.store.save({ ...loaded.config, tunnels: [] });
  assert.equal(item.store.load().config.token, legacy.token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(item.configPath).mode & 0o777, 0o600);
});

test('a plaintext desktop profile migrates and clearing it removes the encrypted credential', (t) => {
  const item = fixture(t); item.ready();
  fs.writeFileSync(item.configPath, JSON.stringify({ token: 'desktop-test-secret', clientId: 'kept' }));
  assert.equal(item.store.load().config.token, 'desktop-test-secret');
  assert.equal(item.read().token, undefined);
  const saved = item.store.save({ token: null, clientId: 'kept' });
  assert.equal(saved.config.token, null);
  assert.deepEqual(item.read(), { clientId: 'kept' });
  assert.equal(item.store.load().config.token, null);
});

for (const options of [{ available: false }, { platform: 'linux', backend: 'basic_text' }, { platform: 'linux', backend: 'unknown' }]) {
  test(`insecure or unavailable storage fails closed: ${JSON.stringify(options)}`, (t) => {
    const item = fixture(t, options); item.ready();
    let encryptionAttempts = 0;
    item.safeStorage.encryptString = () => { encryptionAttempts++; throw new Error('Encryption must not be attempted'); };
    fs.writeFileSync(item.configPath, JSON.stringify({ token: 'never-persist-this-key', serverUrl: 'wss://kept.example.test' }));
    const result = item.store.load();
    assert.equal(result.config.token, null);
    assert.match(result.credentialStorageError, /re-enter.*not saved/);
    assert.deepEqual(item.read(), { serverUrl: 'wss://kept.example.test' });
    assert.equal(item.store.save({ ...result.config, token: 'another-test-key' }).config.token, null);
    assert.equal(item.read().credential, undefined);
    assert.equal(encryptionAttempts, 0);
  });
}

test('encryption and decryption failures never fall back to persisted plaintext', (t) => {
  const item = fixture(t); item.ready();
  item.safeStorage.encryptString = () => { throw new Error('Keyring locked'); };
  const failed = item.store.save({ token: 'test-secret', tunnels: [] });
  assert.equal(failed.config.token, null); assert.match(failed.credentialStorageError, /not saved/);
  assert.deepEqual(item.read(), { tunnels: [] });
  fs.writeFileSync(item.configPath, JSON.stringify({ token: 'must-not-fallback', credential: { version: 1, ciphertext: 'ZmFrZQ==' }, clientId: 'kept' }));
  item.safeStorage.decryptString = () => { throw new Error('Wrong OS account'); };
  const loaded = item.store.load();
  assert.equal(loaded.config.token, null); assert.match(loaded.credentialStorageError, /could not be unlocked/);
  assert.deepEqual(item.read(), { clientId: 'kept' });
});

test('explicit isolated profiles do not import legacy files and cannot overwrite the CLI path', (t) => {
  const item = fixture(t); item.ready();
  fs.writeFileSync(item.legacyPath, JSON.stringify({ token: 'cli-secret-kept' }));
  const isolated = createCredentialStore({ configPath: item.configPath, legacyPath: item.legacyPath,
    importLegacy: false, safeStorage: item.safeStorage, isReady: () => true });
  assert.equal(isolated.load().config.token, null);
  assert.equal(JSON.parse(fs.readFileSync(item.legacyPath)).token, 'cli-secret-kept');
  assert.throws(() => createCredentialStore({ configPath: item.legacyPath, legacyPath: item.legacyPath,
    safeStorage: item.safeStorage, isReady: () => true }), /different file from the CLI profile/);
});
