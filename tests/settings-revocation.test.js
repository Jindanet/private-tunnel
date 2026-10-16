const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { authenticateTunnel } = require('../server/security');

const adminHost = 'admin.example.test';
const adminBase = '/_private-tunnel/admin';
const oldKey = 'previous-access-key-for-revocation-test-0123456789';
const newKey = 'replacement-access-key-for-revocation-test-9876543210';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function settings(tunnelToken = oldKey) {
  return {
    primaryDomain: adminHost,
    controlRoot: '/_private-tunnel',
    tunnelDomain: 'apps.example.test',
    publishDomains: [{ domain: 'apps.example.test', allowSubdomain: true, allowRoot: true }],
    tunnelToken,
  };
}

async function dashboardFixture(t, database, runtimeConfig, refreshRuntimeConfig) {
  const filename = path.join(__dirname, '../server/dashboard.js');
  const realRequire = createRequire(filename);
  const output = { exports: {} };
  const db = {
    verifyPassword: async () => true,
    setDashboardPassword: async () => {},
    getAllClients: async () => [],
    getRecentLogs: async () => [],
    getTotalRequestCount: async () => 0,
    getServerSettings: async () => ({ ...runtimeConfig }),
    prepareServerSettings: async (payload) => ({ ...await db.getServerSettings(), ...payload }),
    updateServerSettings: async () => {},
    getBootstrapPasswordFilePath: () => null,
    isUsingLegacyPasswordHash: async () => false,
    ...database,
  };
  // Load the actual route handler without importing a database or reading .env.
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => name === './db' ? db : realRequire(name),
    module: output,
    process: { env: {}, uptime: () => 0, memoryUsage: () => ({ rss: 0 }) },
    Buffer, URL, URLSearchParams, console, setInterval, clearInterval, setTimeout, clearTimeout,
  }, { filename });
  const server = output.exports.createDashboard({ getLiveTunnels: () => [] }, runtimeConfig, {
    refreshRuntimeConfig,
    ports: { wsPort: 8080, dashboardPort: 8081, proxyPort: 8082 },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  function request(route, { method = 'GET', body, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: route, method,
        headers: {
          host: adminHost, origin: `http://${adminHost}`, connection: 'close',
          'content-type': cookie ? 'application/json' : 'application/x-www-form-urlencoded',
          ...(cookie ? { cookie } : {}),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  const login = await request(`${adminBase}/login`, { method: 'POST', body: 'password=test-admin-password' });
  assert.equal(login.status, 302);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const mutate = (endpoint, payload) => request(`${adminBase}/api/${endpoint}`, {
    method: 'POST', body: JSON.stringify(payload), cookie,
  });
  return { server, request, cookie, mutate };
}

test('settings refresh the committed primary access key before returning a strict mirror error', { timeout: 5000 }, async (t) => {
  let primary = settings();
  const runtimeConfig = settings();
  let refreshes = 0;
  const fixture = await dashboardFixture(t, {
    updateServerSettings: async (next) => {
      primary = { ...next };
      throw new Error('Strict mirror unavailable after primary commit');
    },
  }, runtimeConfig, async () => {
    refreshes += 1;
    Object.assign(runtimeConfig, primary);
  });

  const result = await fixture.mutate('settings', { tunnelToken: newKey });
  assert.equal(result.status, 400);
  assert.match(JSON.parse(result.text).error, /Strict mirror unavailable/);
  assert.equal(primary.tunnelToken, newKey, 'the primary committed despite the mirror error');
  assert.equal(refreshes, 1, 'an unsuccessful mirror must not skip the authoritative reread');
  assert.equal(runtimeConfig.tunnelToken, newKey);
  const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` }, url: '/ws' });
  assert.equal(authenticateTunnel(bearer(oldKey), runtimeConfig.tunnelToken), false);
  assert.equal(authenticateTunnel(bearer(newKey), runtimeConfig.tunnelToken), true);
});

test('settings reload an unverifiable cached key before accepting a reviewed partial update', { timeout: 5000 }, async (t) => {
  let primary = settings(newKey);
  const runtimeConfig = { ...settings(oldKey), tunnelAuthenticationDisabled: true };
  let writes = 0;
  let refreshes = 0;
  const preparedArguments = [];
  const fixture = await dashboardFixture(t, {
    getServerSettings: async () => ({ ...primary }),
    prepareServerSettings: async (...args) => {
      preparedArguments.push(args);
      // Match the real DB helper: an optional second argument overrides its
      // authoritative default and would permit a stale cached key to return.
      return { ...(args[1] || primary), ...args[0] };
    },
    updateServerSettings: async (next) => { writes += 1; primary = { ...next }; },
  }, runtimeConfig, async () => {
    refreshes += 1;
    Object.assign(runtimeConfig, primary, { tunnelAuthenticationDisabled: false });
  });
  const partial = { tunnelDomain: 'reviewed.apps.example.test' };

  const reloaded = await fixture.mutate('settings', partial);
  assert.equal(reloaded.status, 409);
  assert.match(JSON.parse(reloaded.text).error, /Reload this page and review/);
  assert.equal(refreshes, 1);
  assert.equal(writes, 0, 'reloading after an unverifiable read must not write the unreviewed payload');
  assert.equal(preparedArguments.length, 0);
  assert.equal(runtimeConfig.tunnelToken, newKey);
  assert.equal(runtimeConfig.tunnelAuthenticationDisabled, false);

  const reviewed = await fixture.mutate('settings', partial);
  assert.equal(reviewed.status, 200);
  assert.equal(writes, 1);
  assert.equal(preparedArguments.length, 1);
  assert.equal(preparedArguments[0].length, 1, 'partial settings must inherit the DB helper default, without a cached runtime base');
  assert.equal(primary.tunnelToken, newKey);
  assert.equal(primary.tunnelDomain, partial.tunnelDomain);
  assert.equal(runtimeConfig.tunnelToken, newKey);
});

test('password rotation waits for an in-flight settings write and rejects settings queued by the old session', { timeout: 5000 }, async (t) => {
  const firstWriteEntered = deferred();
  const releaseFirstWrite = deferred();
  const events = [];
  const preparedKeys = [];
  const runtimeConfig = settings();
  let primary = settings();
  t.after(() => releaseFirstWrite.resolve());
  const fixture = await dashboardFixture(t, {
    prepareServerSettings: async (payload) => {
      preparedKeys.push(payload.tunnelToken);
      return { ...runtimeConfig, ...payload };
    },
    updateServerSettings: async (next) => {
      events.push('settings started');
      firstWriteEntered.resolve();
      await releaseFirstWrite.promise;
      primary = { ...next };
      events.push('settings committed');
    },
    setDashboardPassword: async () => { events.push('password committed'); },
  }, runtimeConfig, async () => { Object.assign(runtimeConfig, primary); });

  // Observe each complete HTTP body, then let its handler resume. This makes
  // queue order deterministic without timing sleeps or inspecting the queue.
  async function submitParsed(endpoint, payload) {
    const parsed = new Promise((resolve) => fixture.server.once('request', (req) => {
      req.once('end', () => setImmediate(resolve));
    }));
    const result = fixture.mutate(endpoint, payload);
    await parsed;
    return { result };
  }

  const first = fixture.mutate('settings', { tunnelToken: newKey });
  await firstWriteEntered.promise;
  const rotation = await submitParsed('password', { password: 'rotated-admin-password-for-test' });
  const stale = await submitParsed('settings', { tunnelToken: 'stale-session-attempted-access-key-0123456789' });
  const eventsBeforeRelease = [...events];
  releaseFirstWrite.resolve();
  const [firstResult, rotationResult, staleResult] = await Promise.all([first, rotation.result, stale.result]);

  assert.deepEqual(eventsBeforeRelease, ['settings started'], 'password persistence must wait for the admitted settings write');
  assert.equal(firstResult.status, 200);
  assert.equal(rotationResult.status, 200);
  assert.equal(staleResult.status, 401);
  assert.deepEqual(events, ['settings started', 'settings committed', 'password committed']);
  assert.deepEqual(preparedKeys, [newKey], 'the queued old-session mutation must be checked again before preparation');
  assert.equal(primary.tunnelToken, newKey);
  assert.equal((await fixture.request(`${adminBase}/api/overview`, { cookie: fixture.cookie })).status, 401);
  const newCookie = rotationResult.headers['set-cookie'][0].split(';')[0];
  assert.equal((await fixture.request(`${adminBase}/api/overview`, { cookie: newCookie })).status, 200);
});

async function indexFixture(initialToken) {
  const filename = path.join(__dirname, '../server/index.js');
  const realRequire = createRequire(filename);
  const ready = deferred();
  const httpServers = [];
  const peers = [];
  let primary = settings(initialToken);
  let readFailure = null;
  let runtimeConfig;
  let refreshRuntimeConfig;
  let wss;
  let dotenvCalls = 0;

  function server() {
    const result = new EventEmitter();
    result.listen = (_port, _host, callback) => { callback?.(); return result; };
    result.close = (callback) => { callback?.(); };
    result.closeAllConnections = () => {};
    return result;
  }

  class WebSocketServer extends EventEmitter {
    constructor() { super(); this.clients = new Set(); wss = this; }
    handleUpgrade(_req, _socket, _head, callback) {
      const peer = new EventEmitter();
      peer.closes = [];
      peer.close = (code, reason) => { peer.closes.push({ code, reason }); };
      peer.terminate = () => {};
      peers.push(peer);
      this.clients.add(peer);
      callback(peer);
    }
  }

  const modules = {
    dotenv: { config: () => { dotenvCalls += 1; } },
    'node:http': { createServer: () => { const value = server(); httpServers.push(value); return value; } },
    ws: { WebSocketServer },
    './tunnel-manager': class {
      handleNewClient() {}
      getLiveTunnels() { return []; }
    },
    './proxy': { handleProxy: () => {} },
    './dashboard': {
      createDashboard: (_manager, config, options) => {
        runtimeConfig = config;
        refreshRuntimeConfig = options.refreshRuntimeConfig;
        ready.resolve();
        return server();
      },
    },
    './landing': { getLandingHTML: () => '' },
    './firewall': { warnIfNotElevated: () => {} },
    './db': {
      initDatabase: async () => {},
      getServerSettings: async () => {
        if (readFailure) throw readFailure;
        return { ...primary };
      },
      getBootstrapPasswordFilePath: () => null,
      isUsingLegacyPasswordHash: async () => false,
      closeDatabase: async () => {},
    },
  };
  // All servers, persistence, dotenv and process hooks are isolated. Only the
  // production routing/security helpers and index source execute normally.
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => Object.hasOwn(modules, name) ? modules[name] : realRequire(name),
    process: {
      env: { ALLOW_UNAUTHENTICATED_TUNNELS: 'true', ALLOW_LEGACY_QUERY_TOKEN: 'true' },
      once: () => {},
      exit: (code) => ready.reject(new Error(`Unexpected server exit ${code}`)),
    },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, setTimeout, clearTimeout,
  }, { filename });
  await ready.promise;
  assert.equal(dotenvCalls, 1, 'dotenv was stubbed instead of reading the workspace environment');
  assert.equal(httpServers.length, 2);
  assert.ok(wss);

  function upgrade(token, { query = false, legacy = false } = {}) {
    const socket = new EventEmitter();
    socket.remoteAddress = '203.0.113.25';
    socket.response = '';
    socket.destroy = () => { socket.destroyed = true; };
    socket.write = (text) => { socket.response += text; };
    socket.end = (text, callback) => { socket.response += text; callback?.(); };
    const pathname = legacy ? '/ws' : runtimeConfig.tunnelWsPath;
    const req = {
      url: `${pathname}${query ? `?token=${encodeURIComponent(token)}` : ''}`,
      headers: { host: adminHost, ...(!query && token ? { authorization: `Bearer ${token}` } : {}) },
      socket,
    };
    const previous = peers.length;
    httpServers[0].emit('upgrade', req, socket, Buffer.alloc(0));
    return { accepted: peers.length > previous, response: socket.response, peer: peers.at(-1) };
  }

  return {
    runtimeConfig, refreshRuntimeConfig, upgrade,
    failReads: () => { readFailure = new Error('Authoritative primary read failed'); },
    recover: (token) => { readFailure = null; primary = settings(token); },
  };
}

test('an unverifiable primary access key disconnects peers and denies upgrades until an authoritative reread', { timeout: 5000 }, async (t) => {
  for (const [name, initialToken] of [['strong cached key', oldKey], ['explicit unauthenticated opt-in', '']]) {
    await t.test(name, async () => {
      const fixture = await indexFixture(initialToken);
      const admitted = fixture.upgrade(initialToken);
      assert.equal(admitted.accepted, true, 'the initial authoritative configuration admits its expected credential');

      fixture.failReads();
      await assert.rejects(fixture.refreshRuntimeConfig(), /Authoritative primary read failed/);
      assert.deepEqual(admitted.peer.closes.map((close) => close.code), [4001]);
      for (const candidate of [
        fixture.upgrade(initialToken), fixture.upgrade(''),
        fixture.upgrade(initialToken, { query: true, legacy: true }),
      ]) {
        assert.equal(candidate.accepted, false);
        assert.match(candidate.response, /^HTTP\/1\.1 401 Unauthorized/);
      }
      assert.equal(fixture.runtimeConfig.tunnelAuthenticationDisabled, true);

      fixture.recover(newKey);
      await fixture.refreshRuntimeConfig();
      assert.equal(fixture.runtimeConfig.tunnelAuthenticationDisabled, false);
      assert.equal(fixture.runtimeConfig.tunnelToken, newKey);
      assert.equal(fixture.upgrade(oldKey).accepted, false);
      assert.equal(fixture.upgrade('').accepted, false);
      assert.equal(fixture.upgrade(newKey).accepted, true);
      assert.equal(fixture.upgrade(newKey, { query: true, legacy: true }).accepted, true);
    });
  }
});

test('a successful authoritative key change disconnects every existing tunnel peer', { timeout: 5000 }, async () => {
  const fixture = await indexFixture(oldKey);
  const first = fixture.upgrade(oldKey);
  const second = fixture.upgrade(oldKey, { query: true, legacy: true });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);

  fixture.recover(newKey);
  await fixture.refreshRuntimeConfig();
  for (const { peer } of [first, second]) {
    assert.deepEqual(peer.closes.map((close) => close.code), [4001]);
  }
  assert.equal(fixture.upgrade(oldKey).accepted, false);
  assert.equal(fixture.upgrade(newKey).accepted, true);
});
