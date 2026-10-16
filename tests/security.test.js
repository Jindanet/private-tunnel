const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hashPassword, verifyPasswordHash, serializeInlineJson, isAdminHost, isSameOriginMutation,
  authenticateTunnel, isValidTunnelToken, validateTunnelToken, createAttemptLimiter, clientIp, redactLogUrl } = require('../server/security');
const { getExternalWebUrl, validateTunnelInput } = require('../app/security');

test('passwords use independent salts and legacy hashes remain verifiable', async () => {
  const password = 'a long test-only password';
  const first = await hashPassword(password);
  assert.notEqual(first, await hashPassword(password));
  assert.equal(await verifyPasswordHash(password, first), true);
  assert.equal(await verifyPasswordHash('wrong', first), false);
  assert.equal(await verifyPasswordHash(password, crypto.createHash('sha256').update(password).digest('hex')), true);
  assert.equal(await verifyPasswordHash(password, 'scrypt$invalid$invalid'), false);
  assert.equal(await verifyPasswordHash('x'.repeat(1025), first), false);
});

test('inline JSON cannot close a script and preserves original data', () => {
  const value = { hostname: '</ScRiPt><script>alert(1)</script>', method: '<img src=x onerror=alert(1)>', separators: '\u2028\u2029&' };
  const encoded = serializeInlineJson(value);
  assert.equal(/[<>&\u2028\u2029]/.test(encoded), false);
  assert.deepEqual(JSON.parse(encoded), value);
});

test('only web URLs can reach external open; TCP remains copyable text', () => {
  assert.equal(getExternalWebUrl('https://demo.example.com/a?q=1'), 'https://demo.example.com/a?q=1');
  assert.equal(getExternalWebUrl('http://localhost:3000/'), 'http://localhost:3000/');
  for (const value of ['file:///C:/probe', 'javascript:alert(1)', 'ms-settings:test', 'games.example.com:30001', 'https://user:pass@example.com', '']) {
    assert.equal(getExternalWebUrl(value), null);
  }
});

test('tunnel inputs are validated at the privileged boundary', () => {
  assert.equal(validateTunnelInput({type: 'http', port: '3000'}).port, 3000);
  for (const port of ['3000junk', '1.5', 0, 65536, NaN]) assert.throws(() => validateTunnelInput({type: 'http', port}));
  assert.throws(() => validateTunnelInput({type: 'http', port: 3000, publishDomain: 'example.com/evil'}));
  assert.equal(validateTunnelInput({type: 'tcp', port: 22, desiredSubdomain: '', publishMode: 'root'}).publishMode, 'subdomain');
});

function request(host = 'admin.example.com', origin = 'https://admin.example.com') {
  return { headers: {host, origin, 'x-forwarded-proto': 'https'}, socket: { remoteAddress: '127.0.0.1' } };
}

test('admin mutations reject sibling origins, missing origins and host confusion', () => {
  assert.equal(isSameOriginMutation(request()), true);
  assert.equal(isSameOriginMutation(request('admin.example.com', 'https://evil.example.com')), false);
  assert.equal(isSameOriginMutation(request('admin.example.com', 'http://admin.example.com')), false);
  const noOrigin = request(); delete noOrigin.headers.origin;
  assert.equal(isSameOriginMutation(noOrigin), false);
  assert.equal(isAdminHost(request(), 'admin.example.com'), true);
  assert.equal(isAdminHost(request('demo.admin.example.com'), 'admin.example.com'), false);
  const remote = request(); remote.socket.remoteAddress = '203.0.113.1';
  assert.equal(isSameOriginMutation(remote), false);
  remote.headers['x-real-ip'] = 'fake';
  assert.equal(clientIp(remote), '203.0.113.1');
});

test('new authentication uses a header and fails closed', () => {
  const token = crypto.randomBytes(32).toString('base64url');
  const req = {headers: {authorization:`Bearer ${token}`}, url:'/ws?token=wrong'};
  assert.equal(authenticateTunnel(req, token), true);
  assert.equal(authenticateTunnel({headers:{},url:`/ws?token=${token}`}, token), false);
  assert.equal(authenticateTunnel({headers:{},url:`/ws?token=${token}`}, token, {allowLegacyQuery:true}), true);
  assert.equal(authenticateTunnel({headers:{authorization:'Bearer wrong'},url:`/ws?token=${token}`}, token, {allowLegacyQuery:true}), false);
  assert.equal(authenticateTunnel({headers:{},url:'/ws'}, ''), false);
  assert.equal(authenticateTunnel({headers:{},url:'/ws'}, '', {allowUnauthenticated:true}), true);
});

test('access key policy rejects weak configured values without opening unauthenticated access', () => {
  assert.equal(isValidTunnelToken('a'.repeat(32)), true);
  assert.equal(isValidTunnelToken('a'.repeat(4096)), true);
  assert.equal(validateTunnelToken('  ' + 'a'.repeat(32) + '  '), 'a'.repeat(32));
  for (const value of [null, 42, {}, '', 'short', 'a'.repeat(31), 'a'.repeat(4097),
    'your-secret-token-here', 'REPLACE_WITH_A_REAL_SECRET_AT_LEAST_32_CHARACTERS',
    'change-me-' + 'a'.repeat(32), 'example_' + 'a'.repeat(32), 'a'.repeat(32)+' space',
    'a'.repeat(32)+'\ninside', 'a'.repeat(32)+'\u0e01']) {
    assert.equal(isValidTunnelToken(value), false);
    assert.throws(() => validateTunnelToken(value));
    if (value !== '' && value != null) {
      const req = {headers:{authorization:`Bearer ${value}`},url:'/ws'};
      assert.equal(authenticateTunnel(req, value, {allowUnauthenticated:true,allowLegacyQuery:true}), false);
    }
  }
  assert.equal(validateTunnelToken('', {allowEmpty:true}), '');
});

test('attempt limiter bounds attempts and identity storage', () => {
  const limiter = createAttemptLimiter({max:2,capacity:1});
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.take('b'), false);
});

test('metadata logs redact URL secrets while forwarding URLs can remain intact', () => {
  assert.equal(redactLogUrl('/callback?token=secret#key'),'/callback');
  assert.equal(redactLogUrl('https://user:secret@example.com/page?secret=1#private'),'https://example.com/page');
  assert.equal(redactLogUrl(null),null);
  assert.equal(redactLogUrl('/plain/path'),'/plain/path');
});
