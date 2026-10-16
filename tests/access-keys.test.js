const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAccessKeyStore } = require('../server/access-keys');

function location(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-access-keys-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, 'client-keys.json') };
}

test('issued client keys survive restart while the registry and listings contain no secrets', async (t) => {
  const { directory, filePath } = location(t);
  const store = createAccessKeyStore({ filePath });
  const issued = await Promise.all([store.issue(' Alice '), store.issue('Bob')]);
  assert.notEqual(issued[0].token, issued[1].token);
  assert.notEqual(issued[0].key.id, issued[1].key.id);
  assert.equal(issued[0].key.name, 'Alice');
  const raw = fs.readFileSync(filePath, 'utf8');
  const registry = JSON.parse(raw);
  for (const { key, token } of issued) {
    assert.match(key.id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    assert.match(token, new RegExp(`^ptk_${key.id}_[A-Za-z0-9_-]{43}$`));
    assert.equal(raw.includes(token), false);
    assert.equal(JSON.stringify(store.list()).includes(token), false);
    assert.equal(JSON.stringify(store.list()).includes('tokenHash'), false);
    assert.equal(registry.keys.find((item) => item.id === key.id).tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.deepEqual(store.authenticate(token), key);
    assert.deepEqual(createAccessKeyStore({ filePath }).authenticate(token), key);
  }
  const listed = store.list();
  listed[0].name = 'Changed outside the store';
  listed.push({ id: 'external' });
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].name, 'Alice');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});

test('rotation preserves the owner and revocation persists without affecting other clients', async (t) => {
  const { filePath } = location(t);
  const store = createAccessKeyStore({ filePath });
  const alice = await store.issue('Alice');
  const bob = await store.issue('Bob');
  const rotated = await store.rotate(alice.key.id);
  assert.equal(rotated.key.id, alice.key.id);
  assert.equal(rotated.key.createdAt, alice.key.createdAt);
  assert.ok(rotated.key.rotatedAt);
  assert.notEqual(rotated.token, alice.token);
  assert.equal(store.authenticate(alice.token), null);
  assert.deepEqual(store.authenticate(rotated.token), rotated.key);
  assert.deepEqual(store.authenticate(bob.token), bob.key);
  const restarted = createAccessKeyStore({ filePath });
  assert.equal(restarted.authenticate(alice.token), null);
  assert.deepEqual(restarted.authenticate(rotated.token), rotated.key);
  const revoked = await restarted.revoke(alice.key.id);
  assert.ok(revoked.revokedAt);
  assert.equal(restarted.authenticate(rotated.token), null);
  assert.deepEqual(await restarted.revoke(alice.key.id), revoked);
  assert.equal(createAccessKeyStore({ filePath }).authenticate(rotated.token), null);
  assert.deepEqual(restarted.authenticate(bob.token), bob.key);
  await assert.rejects(restarted.rotate(alice.key.id), /revoked/);
  assert.equal(await restarted.revoke(crypto.randomUUID()), null);
  assert.equal(await restarted.rotate(crypto.randomUUID()), null);
});

test('invalid credentials and malformed inputs cannot authenticate or create a key', async (t) => {
  const { filePath } = location(t);
  const store = createAccessKeyStore({ filePath });
  for (const name of [null, '', '   ', 'a'.repeat(101), 'Alice\nBob', {}]) {
    await assert.rejects(store.issue(name), { code: 'EACCESSKEYINPUT' });
  }
  const issued = await store.issue('Only client');
  for (const value of [null, {}, '', 'wrong', 'Bearer ' + issued.token, issued.token + 'x', issued.token.replace(/.$/, issued.token.endsWith('A') ? 'B' : 'A')]) {
    assert.equal(store.authenticate(value), null);
  }
  for (const id of ['', '../client-keys.json', {}, 'A'.repeat(36)]) {
    await assert.rejects(store.revoke(id), { code: 'EACCESSKEYINPUT' });
    await assert.rejects(store.rotate(id), { code: 'EACCESSKEYINPUT' });
  }
  assert.equal(store.list().length, 1);
});

test('a malformed or unreadable registry fails closed without replacing its contents', async (t) => {
  const { filePath } = location(t);
  const store = createAccessKeyStore({ filePath });
  await store.issue('Existing owner');
  const good = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cases = [
    '{broken',
    JSON.stringify({ version: 2, keys: [] }),
    JSON.stringify({ version: 1, keys: {} }),
    JSON.stringify({ ...good, keys: [...good.keys, good.keys[0]] }),
    JSON.stringify({ ...good, keys: [{ ...good.keys[0], tokenHash: 'bad' }] }),
    JSON.stringify({ ...good, keys: [{ ...good.keys[0], token: 'plaintext must not be accepted' }] }),
  ];
  for (const raw of cases) {
    fs.writeFileSync(filePath, raw);
    assert.throws(() => createAccessKeyStore({ filePath }), /registry is invalid/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), raw);
  }
  const deniedFs = { ...fs, readFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.throws(() => createAccessKeyStore({ filePath, fileSystem: deniedFs }), /denied/);
});

test('failed atomic writes retain the prior credentials and the mutation queue recovers', async (t) => {
  const { directory, filePath } = location(t);
  let failWrites = false;
  const fileSystem = { ...fs, renameSync(from, to) {
    if (failWrites) throw Object.assign(new Error('simulated storage failure'), { code: 'EIO' });
    fs.renameSync(from, to);
  } };
  const store = createAccessKeyStore({ filePath, fileSystem });
  const original = await store.issue('Original');
  const priorFile = fs.readFileSync(filePath, 'utf8');
  failWrites = true;
  await assert.rejects(store.issue('Not persisted'), /storage failure/);
  await assert.rejects(store.rotate(original.key.id), /storage failure/);
  await assert.rejects(store.revoke(original.key.id), /storage failure/);
  assert.deepEqual(store.list(), [original.key]);
  assert.deepEqual(store.authenticate(original.token), original.key);
  assert.equal(fs.readFileSync(filePath, 'utf8'), priorFile);
  assert.deepEqual(fs.readdirSync(directory), ['client-keys.json']);
  failWrites = false;
  const replacement = await store.rotate(original.key.id);
  assert.equal(store.authenticate(original.token), null);
  assert.deepEqual(store.authenticate(replacement.token), replacement.key);
});
