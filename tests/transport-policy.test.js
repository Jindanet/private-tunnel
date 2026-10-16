const test = require('node:test');
const assert = require('node:assert/strict');
const { requireSecureServerWebSocketUrl } = require('../client/server-url');
const TunnelClient = require('../client/tunnel-client');
const { authenticatePrincipal, bindClientIdentity } = require('../server/tunnel-identity');
const { createTcpVisitorFilter } = require('../server/tcp-access');

test('credentials cannot be sent to a remote cleartext or credential-bearing server URL', () => {
  for (const url of ['ws://remote.example', 'http://192.0.2.1', 'ws://localhost.evil.test',
    'wss://user:secret@remote.example', 'ftp://remote.example', 'wss://remote.example/#fragment']) {
    assert.throws(() => new TunnelClient({ serverUrl: url, token: 'must-not-be-sent' }));
  }
  for (const url of ['ws://127.0.0.1:8080', 'http://localhost:8080', 'ws://[::1]:8080',
    'https://remote.example', 'wss://remote.example', 'remote.example']) {
    assert.ok(requireSecureServerWebSocketUrl(url).includes('/_private-tunnel/ws'));
  }
});

test('per-client authentication never falls back to a query or shared secret without explicit compatibility', () => {
  const sharedToken = 'shared-test-key-with-at-least-32-characters';
  const accessKeyStore = { authenticate: (token) => token === 'individual-key' ? { id: 'owner', name: 'test owner' } : null };
  const request = (authorization, url = '/ws') => ({ headers: authorization ? { authorization } : {}, url });
  const options = { sharedToken, accessKeyStore };
  assert.equal(authenticatePrincipal(request(`Bearer ${sharedToken}`), options), null);
  assert.equal(authenticatePrincipal(request(null, '/ws?token=individual-key'), { ...options, allowLegacyQuery: true }), null);
  assert.equal(authenticatePrincipal(request('Bearer wrong', `/ws?token=${sharedToken}`),
    { ...options, allowShared: true, allowLegacyQuery: true }), null);
  assert.equal(authenticatePrincipal(request('Bearer individual-key'), options).kind, 'client-key');
  assert.equal(authenticatePrincipal(request(`Bearer ${sharedToken}`), { ...options, allowShared: true }).kind, 'shared');
});

test('the same asserted profile belongs to different owners and cannot enter another owner namespace', () => {
  const first = { kind: 'client-key', id: '10000000-0000-4000-8000-000000000001' };
  const second = { kind: 'client-key', id: '10000000-0000-4000-8000-000000000002' };
  const owned = bindClientIdentity(first, 'known-profile');
  assert.equal(bindClientIdentity(first, 'known-profile'), owned);
  assert.notEqual(bindClientIdentity(second, 'known-profile'), owned);
  assert.notEqual(bindClientIdentity(second, owned), owned);
  assert.throws(() => bindClientIdentity({ kind: 'shared' }, owned), /Reserved/);
  assert.throws(() => bindClientIdentity(null, owned.toUpperCase()), /Reserved/);
  assert.throws(() => bindClientIdentity(first, 'a'.repeat(192)), /Invalid/);
  assert.equal(bindClientIdentity({ kind: 'shared' }, 'legacy-profile'), 'legacy-profile');
  assert.ok(owned.length < 191, 'The owner-bound identity fits both database schemas');
});

test('TCP allowlists check real peer addresses including IPv4-mapped IPv6 and reject invalid rules', () => {
  const allow = createTcpVisitorFilter('192.0.2.0/24,2001:db8:1234::/48,127.0.0.1,::1');
  for (const ip of ['192.0.2.43', '::ffff:192.0.2.43', '::ffff:c000:22b', '2001:db8:1234:ff::1', '127.0.0.1', '::1']) {
    assert.equal(allow(ip), true, ip);
  }
  for (const ip of ['192.0.3.1', '2001:db8:1235::1', 'unknown', undefined]) assert.equal(allow(ip), false, String(ip));
  for (const rule of ['example.com', '192.0.2.0/33', '::1/129', '192.0.2.1/1e1', '192.0.2.1,,::1', '192.0.2.1/24/1']) {
    assert.throws(() => createTcpVisitorFilter(rule), /TCP_VISITOR_ALLOWLIST/);
  }
  assert.equal(createTcpVisitorFilter('')('192.0.2.1'), true, 'An omitted visitor policy retains explicit public TCP behavior');
});

test('production rejects cross-backend mirrors before initializing any database connection', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const result = spawnSync(process.execPath, ['-e',
    "require('./server/db').initDatabase().then(()=>process.exit(2)).catch(e=>{console.log(e.message);process.exit(1)})"], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, encoding: 'utf8',
    env: { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '',
      NODE_ENV: 'production', DB_PROVIDER: 'sqlite', DB_SYNC_TARGETS: 'mysql' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Production requires one database backend/);
});
