'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const TunnelClient = require('../client/tunnel-client');
const { MSG } = require('../shared/protocol');

const LOOPBACK = '127.0.0.1';
const SHARED_TOKEN = 'client-key-integration-legacy-key-at-least-32-characters';
const PASSWORD = 'client-key-integration-admin-password';
const ADMIN = '/_private-tunnel/admin';
const KEYS = ADMIN + '/api/client-keys';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function deadline(promise, message, milliseconds = 6000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(predicate, message) {
  const expires = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() >= expires) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function listen(server) {
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  return server.address().port;
}

function service(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return server;
}

async function gateway(t, extraEnvironment = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-key-integration-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await deadline(exited, 'Isolated gateway did not exit', 6000);
    }
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('ptunnel-key-integration-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const reservations = await Promise.all([0, 1, 2].map(async () => {
    const server = net.createServer();
    await listen(server);
    return server;
  }));
  const [wsPort, dashboardPort, proxyPort] = reservations.map((server) => server.address().port);
  await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));
  // Deliberately omit ALLOW_SHARED_TUNNEL_TOKEN to exercise the secure default.
  // A temporary cwd and explicit environment prevent checkout .env/private DB reads.
  const environment = {
    PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '',
    TEMP: os.tmpdir(), TMP: os.tmpdir(), NODE_ENV: 'test',
    DB_PROVIDER: 'sqlite', DB_SYNC_TARGETS: '', DB_SYNC_STRICT: 'false', DB_BOOTSTRAP_SYNC: 'false',
    DATA_DIR: directory, SQLITE_PATH: path.join(directory, 'test.sqlite'),
    WS_PORT: String(wsPort), DASHBOARD_PORT: String(dashboardPort), PROXY_PORT: String(proxyPort),
    INTERNAL_HOST: LOOPBACK, PRIMARY_DOMAIN: LOOPBACK, TUNNEL_DOMAIN: 'apps.example.test',
    TUNNEL_TOKEN: SHARED_TOKEN, DASHBOARD_PASSWORD: PASSWORD,
    AUTO_FIREWALL: 'false', REQUEST_LOGGING: 'false',
    ALLOW_LEGACY_QUERY_TOKEN: 'false', ALLOW_UNAUTHENTICATED_TUNNELS: 'false',
    HTTP_IDLE_TIMEOUT_MS: '5000', ...extraEnvironment,
  };
  child = spawn(process.execPath, [path.resolve(__dirname, '../server/index.js')], {
    cwd: directory, env: environment, windowsHide: true,
  });
  const ready = deferred();
  let output = '';
  const capture = (chunk) => {
    output += chunk.toString();
    if (output.includes('All services started successfully')) ready.resolve();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', ready.reject);
  child.once('exit', (code, signal) => ready.reject(new Error(`Gateway exited (${code ?? signal}): ${output}`)));
  await deadline(ready.promise, 'Isolated gateway startup timed out', 10000);

  let cookie;
  function admin(route, { method = 'GET', data, form } = {}) {
    const body = form ?? (data === undefined ? undefined : JSON.stringify(data));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: LOOPBACK, port: dashboardPort, path: route, method, agent: false,
        headers: {
          host: `${LOOPBACK}:${dashboardPort}`, origin: `http://${LOOPBACK}:${dashboardPort}`,
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': form === undefined ? 'application/json' : 'application/x-www-form-urlencoded' }),
        },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.once('error', reject);
        res.once('end', () => {
          let data;
          try { data = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text, data });
        });
      });
      req.once('error', reject);
      req.end(body);
    });
  }
  const login = await admin(ADMIN + '/login', { method: 'POST', form: `password=${PASSWORD}` });
  assert.equal(login.status, 302);
  cookie = login.headers['set-cookie'][0].split(';')[0];
  const issue = async (name) => {
    const response = await admin(KEYS, { method: 'POST', data: { name } });
    assert.equal(response.status, 201);
    assert.equal(typeof response.data.token, 'string');
    return response.data;
  };
  return { wsPort, proxyPort, admin, issue };
}

async function connectClient(t, remote, key, servicePort, options = {}) {
  const assigned = deferred();
  const errors = [];
  const client = new TunnelClient({
    serverUrl: `ws://${LOOPBACK}:${remote.wsPort}`, token: key.token,
    localHost: LOOPBACK, localPort: servicePort, tunnelType: 'http',
    clientId: crypto.randomUUID(),
    ...options,
    onConnected: assigned.resolve,
    onError: (error) => { errors.push(error); assigned.reject(error); },
  });
  t.after(() => { client.disconnect(); client.ws?.terminate(); });
  client.connect();
  const assignment = await deadline(assigned.promise, 'Tunnel assignment timed out');
  assert.equal(assignment.dataTransportVersion, 4);
  return { client, assignment, errors };
}

function publicRequest(t, remote, assignment, route, { paused = false } = {}) {
  const opened = deferred();
  const completed = deferred();
  const chunks = [];
  const request = http.get({
    host: LOOPBACK, port: remote.proxyPort, path: route, agent: false,
    headers: { host: new URL(assignment.url).hostname },
  }, (res) => {
    if (paused) { res.pause(); res.socket.pause(); }
    res.on('data', (chunk) => chunks.push(chunk));
    res.once('error', completed.reject);
    res.once('aborted', () => completed.reject(new Error(`Public response aborted: ${route}`)));
    res.once('end', () => completed.resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
    opened.resolve(res);
  });
  request.once('error', (error) => { opened.reject(error); completed.reject(error); });
  t.after(() => request.destroy());
  return { opened: opened.promise, completed: completed.promise, chunks };
}

async function closeClient(client) {
  if (!client.ws || client.ws.readyState === WebSocket.CLOSED) return;
  const closed = once(client.ws, 'close');
  client.disconnect();
  await deadline(closed, 'Client WebSocket did not close');
}

async function rejectedUpgrade(remote, token) {
  const status = deferred();
  const socket = new WebSocket(`ws://${LOOPBACK}:${remote.wsPort}/_private-tunnel/ws`, {
    headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 2000,
  });
  socket.once('unexpected-response', (_request, response) => {
    status.resolve(response.statusCode);
    response.resume();
    socket.terminate();
  });
  socket.on('error', () => {});
  socket.once('open', () => { socket.terminate(); status.reject(new Error('Rejected credential unexpectedly upgraded')); });
  try { return await deadline(status.promise, 'Credential rejection timed out'); }
  finally { socket.terminate(); }
}

test('actual gateway binds reservations to issued keys and rotates or revokes only the selected principal', { timeout: 20000 }, async (t) => {
  const local = service(t, (_req, res) => res.end('local service'));
  const servicePort = await listen(local);
  const remote = await gateway(t);
  const alice = await remote.issue('Alice');
  const bob = await remote.issue('Bob');
  const profile = 'same-client-asserted-profile';
  assert.equal(await rejectedUpgrade(remote, SHARED_TOKEN), 401, 'Shared credentials are disabled by default');
  const first = await connectClient(t, remote, alice, servicePort, { clientId: profile, desiredSubdomain: 'alice-owned' });
  const host = first.assignment.publicHost;
  assert.equal((await deadline(publicRequest(t, remote, first.assignment, '/').completed, 'Alice request stalled')).status, 200);
  await closeClient(first.client);
  const stored = await remote.admin(ADMIN + '/api/clients');
  assert.equal(stored.status, 200);
  const owner = stored.data.clients.find((record) => record.assigned_host === host);
  assert.ok(owner);
  assert.ok(owner.client_id.startsWith(`key:${alice.key.id}:`));

  const checkSocket = new WebSocket(`ws://${LOOPBACK}:${remote.wsPort}/_private-tunnel/ws`, {
    headers: { authorization: `Bearer ${bob.token}` },
  });
  checkSocket.on('error', () => {});
  t.after(() => checkSocket.terminate());
  await deadline(once(checkSocket, 'open'), 'Bob route-check socket did not open');
  for (const clientId of [profile, owner.client_id]) {
    const result = deferred();
    const listener = (data, binary) => {
      if (!binary) {
        const message = JSON.parse(data.toString());
        if (message.type === MSG.TUNNEL_CHECK_RESULT) result.resolve(message);
      }
    };
    checkSocket.on('message', listener);
    checkSocket.send(JSON.stringify({
      type: MSG.TUNNEL_CHECK, tunnelType: 'http', clientId,
      desiredSubdomain: 'alice-owned', publishMode: 'subdomain',
    }));
    const preview = await deadline(result.promise, 'Cross-key route check timed out');
    checkSocket.removeListener('message', listener);
    assert.equal(preview.available, false, 'A key cannot assert another key owner identity in route checks');
    assert.match(preview.message, /reserved.*another client/i);
  }
  checkSocket.close();
  await assert.rejects(connectClient(t, remote, bob, servicePort, {
    clientId: profile, desiredSubdomain: 'alice-owned',
  }), /reserved.*another client/i);

  const aliceBack = await connectClient(t, remote, alice, servicePort, { clientId: profile });
  assert.equal(aliceBack.assignment.publicHost, host, 'The owner reuses its offline reservation');
  const bobLive = await connectClient(t, remote, bob, servicePort, { clientId: profile, desiredSubdomain: 'bob-owned' });
  const aliceClosed = once(aliceBack.client.ws, 'close');
  const rotation = await remote.admin(`${KEYS}/${alice.key.id}/rotate`, { method: 'POST', data: {} });
  assert.equal(rotation.status, 200);
  assert.equal(rotation.data.key.id, alice.key.id);
  assert.equal((await deadline(aliceClosed, 'Rotation did not disconnect Alice'))[0], 4001);
  assert.equal(aliceBack.client.shouldReconnect, false);
  assert.equal(bobLive.client.ws.readyState, WebSocket.OPEN, 'Rotating Alice leaves Bob connected');
  assert.equal((await deadline(publicRequest(t, remote, bobLive.assignment, '/after-alice-rotation').completed, 'Bob request stalled')).status, 200);
  assert.equal(await rejectedUpgrade(remote, alice.token), 401);

  const rotated = await connectClient(t, remote, rotation.data, servicePort, { clientId: profile });
  assert.equal(rotated.assignment.publicHost, host, 'Rotation preserves the authenticated owner and saved host');
  const clientsAfterRotation = await remote.admin(ADMIN + '/api/clients');
  const retainedOwner = clientsAfterRotation.data.clients.find((record) => record.assigned_host === host);
  assert.equal(retainedOwner.client_id, owner.client_id);
  const revokedClosed = once(rotated.client.ws, 'close');
  const revocation = await remote.admin(`${KEYS}/${alice.key.id}/revoke`, { method: 'POST', data: {} });
  assert.equal(revocation.status, 200);
  assert.equal((await deadline(revokedClosed, 'Revocation did not disconnect Alice'))[0], 4001);
  assert.equal(rotated.client.shouldReconnect, false);
  assert.equal(await rejectedUpgrade(remote, rotation.data.token), 401);
  assert.equal(bobLive.client.ws.readyState, WebSocket.OPEN);
  assert.equal((await deadline(publicRequest(t, remote, bobLive.assignment, '/after-alice-revoke').completed, 'Bob request stalled')).status, 200);
});

test('a paused public visitor downloading more than 20 MiB does not disconnect another HTTP stream', { timeout: 20000 }, async (t) => {
  const payload = Buffer.alloc(24 * 1024 * 1024 + 137);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >>> 8)) & 255;
  const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
  const local = service(t, (req, res) => {
    if (req.url === '/quick') return res.end('independent response');
    res.setHeader('content-type', 'application/octet-stream');
    res.end(payload);
  });
  const servicePort = await listen(local);
  const remote = await gateway(t);
  const key = await remote.issue('Slow download');
  const tunnel = await connectClient(t, remote, key, servicePort);
  const download = publicRequest(t, remote, tunnel.assignment, '/download', { paused: true });
  const visitor = await deadline(download.opened, 'Slow download never started');
  await waitFor(() => [...tunnel.client.requestStreams.values()].some((stream) =>
    stream.path === '/download' && stream.responseStream?.isPaused()), 'Download never reached producer backpressure');
  const quick = await deadline(publicRequest(t, remote, tunnel.assignment, '/quick').completed, 'Unrelated HTTP stream stalled behind slow download');
  assert.equal(quick.status, 200);
  assert.equal(quick.body.toString(), 'independent response');
  assert.equal(visitor.readableEnded, false);
  assert.equal(tunnel.client.ws.readyState, WebSocket.OPEN);
  visitor.socket.resume();
  visitor.resume();
  const completed = await deadline(download.completed, 'Slow download failed to resume', 10000);
  assert.equal(completed.status, 200);
  assert.equal(completed.complete, true);
  assert.equal(completed.body.length, payload.length);
  assert.equal(crypto.createHash('sha256').update(completed.body).digest('hex'), expectedHash);
  assert.deepEqual(tunnel.errors, []);
});

test('actual gateway preserves a continuously progressing binary response beyond 30 seconds', { timeout: 45000 }, async (t) => {
  const chunk = Buffer.from([0, 1, 2, 255, 128, 3, 254, 4]);
  const parts = 125;
  const local = service(t, (_req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    let sent = 0;
    const timer = setInterval(() => {
      res.write(chunk);
      if (++sent === parts) { clearInterval(timer); res.end(); }
    }, 250);
    res.once('close', () => clearInterval(timer));
  });
  const servicePort = await listen(local);
  const remote = await gateway(t);
  const key = await remote.issue('Long stream');
  const tunnel = await connectClient(t, remote, key, servicePort);
  const started = Date.now();
  const received = await deadline(publicRequest(t, remote, tunnel.assignment, '/long-binary-stream').completed,
    'Long binary response did not finish', 38000);
  assert.ok(Date.now() - started > 30000, 'The actual transfer crosses the old whole-request deadline');
  assert.equal(received.status, 200);
  assert.equal(received.complete, true);
  assert.deepEqual(received.body, Buffer.concat(Array.from({ length: parts }, () => chunk)));
  assert.deepEqual(tunnel.errors, []);
});
