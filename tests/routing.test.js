const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeDomain, normalizeControlRoot, normalizePublishDomains, isValidDomain,
  isExactHost, extractSingleSubdomain, matchManagedHttpHost, buildHttpHost,
  buildRuntimeRoutes, getAdminOrigin, getTunnelHttpOrigin, getTcpAddress,
} = require('../server/routing');

test('host comparison handles case, trailing dots and ports without suffix confusion', () => {
  assert.equal(normalizeDomain(' HTTPS://Admin.Example.COM.:443/path '), 'admin.example.com');
  assert.equal(isExactHost('ADMIN.example.com:443', 'admin.example.com'), true);
  for (const host of ['eviladmin.example.com', 'admin.example.com.attacker.test', 'demo.admin.example.com']) {
    assert.equal(isExactHost(host, 'admin.example.com'), false);
  }
  assert.equal(isValidDomain('bad domain.example'), false);
  assert.equal(isValidDomain('example.com;return'), false);
});

test('only one immediate subdomain label matches a publish base', () => {
  assert.equal(extractSingleSubdomain('demo.apps.example.com', 'apps.example.com'), 'demo');
  for (const host of ['apps.example.com', 'nested.demo.apps.example.com', 'evilapps.example.com', 'apps.example.com.attacker.test']) {
    assert.equal(extractSingleSubdomain(host, 'apps.example.com'), null);
  }
});

test('root and subdomain publishing respect independent settings', () => {
  const domains = [
    {domain: 'apps.example.com', allowSubdomain: true, allowRoot: false},
    {domain: 'demo.example.net', allowSubdomain: false, allowRoot: true},
  ];
  assert.deepEqual(matchManagedHttpHost('test.apps.example.com', domains), {mode: 'subdomain', domain: 'apps.example.com', label: 'test'});
  assert.deepEqual(matchManagedHttpHost('demo.example.net', domains), {mode: 'root', domain: 'demo.example.net', label: null});
  for (const host of ['apps.example.com', 'nested.test.apps.example.com', 'test.demo.example.net', 'unknown.example.net']) {
    assert.equal(matchManagedHttpHost(host, domains), null);
  }
  assert.equal(buildHttpHost('test', 'apps.example.com', 'subdomain'), 'test.apps.example.com');
  assert.equal(buildHttpHost('ignored', 'demo.example.net', 'root'), 'demo.example.net');
});

test('publish domain normalization removes duplicates and invalid entries', () => {
  const domains = normalizePublishDomains([
    {domain: 'APPS.example.com', allowRoot: true},
    {domain: 'apps.example.com', allowRoot: false},
    {domain: 'bad domain.example'},
    null,
  ], 'fallback.example.com');
  assert.equal(domains.length, 2);
  assert.equal(domains[0].domain, 'apps.example.com');
  assert.equal(domains[0].allowRoot, true);
  assert.equal(domains[1].domain, 'fallback.example.com');
  assert.equal(domains[1].allowRoot, false);
  assert.equal(domains[1].allowSubdomain, true);
});

test('control routes remain in the configured reserved namespace', () => {
  assert.equal(normalizeControlRoot(' Custom//Control/ '), '/custom/control');
  for (const value of ['/', '/bad?query', '/bad#fragment', '/bad;directive', '/bad value']) assert.equal(normalizeControlRoot(value), '');
  const routes = buildRuntimeRoutes({controlRoot: '/custom/control/'});
  assert.deepEqual(routes, {
    controlRoot: '/custom/control', tunnelWsPath: '/custom/control/ws', legacyTunnelWsPath: '/ws',
    adminBasePath: '/custom/control/admin', adminLoginPath: '/custom/control/admin/login',
    adminLogoutPath: '/custom/control/admin/logout', adminApiBasePath: '/custom/control/admin/api',
    adminWsPath: '/custom/control/admin/live',
  });
  assert.equal(buildRuntimeRoutes({}).controlRoot, '/_private-tunnel');
  assert.equal(buildRuntimeRoutes({controlRoot: '/invalid?query'}).controlRoot, '/_private-tunnel');
});

test('public addresses distinguish exact HTTP hosts and raw TCP addresses', () => {
  const config = {primaryDomain: 'admin.example.com', tunnelDomain: 'apps.example.com'};
  assert.equal(getAdminOrigin(config), 'https://admin.example.com');
  assert.equal(getTunnelHttpOrigin('demo', config), 'https://demo.apps.example.com');
  assert.equal(getTunnelHttpOrigin('demo.example.net', config), 'https://demo.example.net');
  assert.equal(getTcpAddress(30001, config), 'apps.example.com:30001');
  assert.equal(getTcpAddress(30001, 'games.example.com'), 'games.example.com:30001');
  assert.equal(getTunnelHttpOrigin('', config), '');
  assert.equal(getAdminOrigin({}), '');
});
