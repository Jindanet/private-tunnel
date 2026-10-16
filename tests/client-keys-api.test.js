const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createAccessKeyStore } = require('../server/access-keys');

test('client key administration requires the current admin session and reveals secrets only on issuance', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-client-key-api-'));
  Object.assign(process.env, {
    DATA_DIR: directory, SQLITE_PATH: path.join(directory, 'test.db'), DB_PROVIDER: 'sqlite', DB_SYNC_TARGETS: '',
    PRIMARY_DOMAIN: 'admin.example.test', TUNNEL_DOMAIN: 'apps.example.test',
    TUNNEL_TOKEN: 'client-key-api-legacy-test-key-at-least-32-characters',
    DASHBOARD_PASSWORD: 'client-key-api-admin-password', DB_BOOTSTRAP_SYNC: 'false',
  });
  const db = require('../server/db');
  const { createDashboard } = require('../server/dashboard');
  await db.initDatabase();
  const filePath = path.join(directory, 'client-keys.json');
  let failWrites = false;
  const store = createAccessKeyStore({ filePath, fileSystem: { ...fs, renameSync(from, to) {
    if (failWrites) throw Object.assign(new Error('private storage location must not leak'), { code: 'EIO' });
    fs.renameSync(from, to);
  } } });
  const retired = [];
  const server = createDashboard({ getLiveTunnels: () => [] }, await db.getServerSettings(), {
    accessKeyStore: store, onClientKeyRevoked: (id) => retired.push(id),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const port = server.address().port;
  const base = '/_private-tunnel/admin';
  const keysPath = base + '/api/client-keys';
  const origin = 'http://admin.example.test';
  function request(route, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: route, method,
        headers: { host: 'admin.example.test', origin, connection: 'close', ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let data;
          try { data = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, data });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  assert.equal((await request(keysPath)).status, 401);
  assert.equal((await request(keysPath, { method: 'POST', body: '{"name":"Unauthorized"}', headers: { 'content-type': 'application/json' } })).status, 401);
  const login = await request(base + '/login', { method: 'POST', body: 'password=client-key-api-admin-password', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(login.status, 302);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const jsonHeaders = { cookie, 'content-type': 'application/json' };
  const post = (route, data, headers = {}) => request(route, { method: 'POST', body: JSON.stringify(data), headers: { ...jsonHeaders, ...headers } });

  assert.equal((await request(keysPath, { headers: { cookie, host: 'evil.example.test' } })).status, 421);
  assert.equal((await post(keysPath, { name: 'Cross-origin' }, { origin: 'http://evil.example.test' })).status, 403);
  assert.equal((await post(keysPath, { name: 'Wrong content type' }, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post(keysPath, { name: '' })).status, 400);
  assert.equal((await request(keysPath, { method: 'POST', body: '[]', headers: jsonHeaders })).status, 400);
  assert.deepEqual(store.list(), []);

  const aliceResponse = await post(keysPath, { name: 'Alice' });
  assert.equal(aliceResponse.status, 201);
  assert.equal(aliceResponse.headers['cache-control'], 'no-store');
  const alice = aliceResponse.data;
  assert.equal(alice.key.name, 'Alice');
  assert.equal(store.authenticate(alice.token).id, alice.key.id);
  const bob = (await post(keysPath, { name: 'Bob' })).data;
  const listing = await request(keysPath, { headers: { cookie } });
  assert.equal(listing.status, 200);
  assert.equal(listing.data.keys.length, 2);
  assert.doesNotMatch(listing.text, /tokenHash|"token"/);
  assert.equal(listing.text.includes(alice.token), false);
  assert.equal(fs.readFileSync(filePath, 'utf8').includes(alice.token), false);

  const rotatePath = `${keysPath}/${alice.key.id}/rotate`;
  assert.equal((await post(rotatePath, {}, { origin: 'http://evil.example.test' })).status, 403);
  assert.equal(store.authenticate(alice.token).id, alice.key.id);
  assert.equal(retired.length, 0);
  const rotation = await post(rotatePath, {});
  assert.equal(rotation.status, 200);
  assert.equal(rotation.data.key.id, alice.key.id);
  assert.notEqual(rotation.data.token, alice.token);
  assert.equal(store.authenticate(alice.token), null);
  assert.equal(store.authenticate(rotation.data.token).id, alice.key.id);
  assert.deepEqual(retired, [alice.key.id]);
  assert.equal(store.authenticate(bob.token).id, bob.key.id);

  failWrites = true;
  const failedRevoke = await post(`${keysPath}/${bob.key.id}/revoke`, {});
  assert.equal(failedRevoke.status, 500);
  assert.equal(failedRevoke.text.includes('private storage'), false);
  assert.equal(store.authenticate(bob.token).id, bob.key.id);
  assert.deepEqual(retired, [alice.key.id]);
  failWrites = false;
  const revoked = await post(`${keysPath}/${alice.key.id}/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.ok(revoked.data.key.revokedAt);
  assert.doesNotMatch(revoked.text, /tokenHash|"token"/);
  assert.equal(store.authenticate(rotation.data.token), null);
  assert.equal(createAccessKeyStore({ filePath }).authenticate(rotation.data.token), null);
  assert.deepEqual(retired, [alice.key.id, alice.key.id]);
  assert.equal((await post(`${keysPath}/${crypto.randomUUID()}/revoke`, {})).status, 404);
  assert.equal((await post(`${keysPath}/invalid/revoke`, {})).status, 400);

  async function holdMutation(route, prefix) {
    let held;
    const received = new Promise((resolve) => server.once('request', (req) => req.once('data', resolve)));
    const result = new Promise((resolve, reject) => {
      held = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
        headers: { host: 'admin.example.test', origin, connection: 'close', ...jsonHeaders } }, (res) => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      held.on('error', reject);
      held.write(prefix);
    });
    await received;
    return { request: held, result };
  }
  const heldIssue = await holdMutation(keysPath, '{"name":');
  const heldRevoke = await holdMutation(`${keysPath}/${bob.key.id}/revoke`, '{"unused":');
  const heldRotate = await holdMutation(`${keysPath}/${bob.key.id}/rotate`, '{"unused":');
  const registryBeforeRace = fs.readFileSync(filePath, 'utf8');
  const passwordChange = await post(base + '/api/password', { password: 'replacement-client-key-api-password' });
  assert.equal(passwordChange.status, 200);
  heldIssue.request.end('"Stale session"}');
  heldRevoke.request.end('true}');
  heldRotate.request.end('true}');
  assert.deepEqual(await Promise.all([heldIssue.result, heldRevoke.result, heldRotate.result]), [401, 401, 401]);
  assert.equal(fs.readFileSync(filePath, 'utf8'), registryBeforeRace);
  assert.equal(store.authenticate(bob.token).id, bob.key.id);
  assert.equal((await request(keysPath, { headers: { cookie } })).status, 401);
});
