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
  const issue = async (name, type = 'desktop') => {
    const response = await admin(KEYS, { method: 'POST', data: { name, type } });
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

test('native device wire uses a separate key, visitor authentication, bounded bodies, credit and revocation', { timeout: 30000 }, async (t) => {
  const { TYPE: T, packet, decode, SUBPROTOCOL } = require('../shared/device-protocol');
  const remote = await gateway(t);
  const key = await remote.issue('ESP sensor', 'device');
  assert.equal(key.key.type, 'device');
  assert.ok(key.visitorToken.startsWith('ptv_'));
  assert.equal(await rejectedUpgrade(remote, key.token), 403, 'A device key cannot enter desktop transport');
  const desktop = await remote.issue('Desktop');
  async function deviceUpgrade(token, expectRejected = false) {
    const ws = new WebSocket(`ws://${LOOPBACK}:${remote.wsPort}/_private-tunnel/ws`, SUBPROTOCOL, {
      headers: { authorization: `Bearer ${token}` }, perMessageDeflate: false,
    });
    ws.on('error', () => {});t.after(() => ws.terminate());
    if (expectRejected) {
      const rejected = once(ws, 'unexpected-response');
      const [, response] = await deadline(rejected, 'Cross-protocol key rejection stalled');
      assert.equal(response.statusCode, 403);response.resume();ws.terminate();return;
    }
    await deadline(once(ws, 'open'), 'Device upgrade stalled');return ws;
  }
  await deviceUpgrade(desktop.token, true);
  const ws = await deviceUpgrade(key.token);
  const ready = deferred();
  let host, response, held = false, active, opens = 0, cancellations = 0;
  function pump() {
    while (active && active.credit && active.offset < active.output.length) {
      const n = Math.min(512, active.credit, active.output.length - active.offset);
      ws.send(packet(T.DATA, active.id, active.output.subarray(active.offset, active.offset + n)));
      active.offset += n;active.credit -= n;
    }
    if (active && active.offset === active.output.length) { ws.send(packet(T.END, active.id));active = null; }
  }
  ws.on('message', (data, binary) => {
    assert.equal(binary, true);
    const frame = decode(data), p = frame.payload;
    if (frame.type === T.READY) {
      assert.equal(p.readUInt16BE(), 512);assert.equal(p[2], 1);assert.equal(p.readUInt16BE(5), 1024);
      host = new URL(p.subarray(9).toString()).hostname;ready.resolve();
    } else if (frame.type === T.OPEN) {
      ++opens;
      const methodEnd = 4 + p[0], pathEnd = methodEnd + p.readUInt16BE(1);
      active = { id: frame.stream, body: [], credit: 512, offset: 0,
        method: p.subarray(4, methodEnd).toString(), path: p.subarray(methodEnd, pathEnd).toString(),
        contentType: p.subarray(pathEnd).toString() };
    }
    else if (frame.type === T.DATA) {
      active.body.push(p);const credit = Buffer.alloc(2);credit.writeUInt16BE(p.length);ws.send(packet(T.CREDIT, frame.stream, credit));
    } else if (frame.type === T.END && !held) {
      response = Buffer.concat(active.body);active.output = response.length ? response : Buffer.alloc(8192, 'd');
      let status = 200, contentType = 'application/octet-stream';
      if (active.path === '/login') {
        assert.equal(active.method, 'POST');assert.equal(active.contentType, 'text/plain');
        status = response.equals(Buffer.from('admin\ncorrect-password')) ? 200 : 401;
        active.output = Buffer.from(status === 200 ? '{"success":true}' : '{"error":"Invalid credentials"}');
        contentType = 'application/json';
      }
      const type = Buffer.from(contentType), header = Buffer.alloc(3 + type.length);
      header.writeUInt16BE(status);header[2] = type.length;type.copy(header, 3);
      ws.send(packet(T.RESPONSE, frame.stream, header));pump();
    } else if (frame.type === T.CREDIT && active) { active.credit += p.readUInt16BE();pump(); }
    else if (frame.type === T.CANCEL) { ++cancellations;active = null; }
    else if (frame.type === T.PING) ws.send(packet(T.PONG));
  });
  const strings = ['sensor-fixed', 'apps.example.test', 'sensor-native', 'esp8266'];
  const fields = strings.map((s) => Buffer.from(s));const hello = Buffer.alloc(10);
  hello[0] = 1;hello.writeUInt16BE(512, 1);hello[3] = 1;hello.writeUInt16BE(512, 4);
  fields.forEach((p, i) => { hello[6 + i] = p.length; });
  ws.send(packet(T.HELLO, 0, Buffer.concat([hello, ...fields])));
  await deadline(ready.promise, 'Device READY stalled');
  assert.equal(host, 'sensor-native.apps.example.test');
  function request({ token = key.visitorToken, method = 'GET', path = '/status', body, headers = {}, chunked = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: LOOPBACK, port: remote.proxyPort, path, method, agent: false,
        headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json', ...(!chunked ? { 'content-length': body.length } : {}) } : {}), ...headers } }, (res) => {
        const chunks = [];res.on('data', (p) => chunks.push(p));res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });req.on('error', reject);if (chunked && body) { req.write(body);req.end(); } else req.end(body);
    });
  }
  assert.equal((await request({ token: '' })).status, 401);
  assert.equal((await request({ token: key.token })).status, 401, 'Connection secret is not visitor authentication');
  assert.equal(opens, 0);
  assert.equal((await request({ headers: { origin: 'https://evil.example' } })).status, 403);
  const downloaded = await deadline(request(), 'Credit-controlled response stalled');
  assert.equal(downloaded.status, 200);assert.deepEqual(downloaded.body, Buffer.alloc(8192, 'd'));
  const echoed = await deadline(request({ method: 'POST', body: Buffer.alloc(1024, 'q') }), 'Bounded upload stalled');
  assert.deepEqual(echoed.body, Buffer.alloc(1024, 'q'));
  assert.equal((await request({ method: 'POST', body: Buffer.alloc(1025) })).status, 413);
  assert.equal((await request({ method: 'POST', body: Buffer.alloc(1025), chunked: true })).status, 413);
  await waitFor(() => !active, 'Oversized upload was not cancelled');
  const basic = await request({ token: '', headers: { authorization: `Basic ${Buffer.from('device:' + key.visitorToken).toString('base64')}` } });
  assert.equal(basic.status, 200);
  const policyPath = `${KEYS}/${key.key.id}/visitor-auth`;
  for (const enabled of ['false', null, 0]) {
    assert.equal((await remote.admin(policyPath, { method: 'POST', data: { enabled } })).status, 400);
  }
  const disabled = await remote.admin(policyPath, { method: 'POST', data: { enabled: false } });
  assert.equal(disabled.status, 200);assert.equal(disabled.data.key.visitorAuth, false);
  assert.equal(ws.readyState, WebSocket.OPEN, 'Changing visitor policy needs no board reconfiguration');
  const login = await request({ token: '', path: '/login', method: 'POST', body: Buffer.from('admin\ncorrect-password'), headers: { 'content-type': 'text/plain' } });
  assert.equal(login.status, 200);assert.deepEqual(JSON.parse(login.body), { success: true });
  assert.equal(login.headers['www-authenticate'], undefined, 'No outer browser login when the application handles it');
  const badLogin = await request({ token: '', path: '/login', method: 'POST', body: Buffer.from('admin\nwrong'), headers: { 'content-type': 'text/plain' } });
  assert.equal(badLogin.status, 401);assert.deepEqual(JSON.parse(badLogin.body), { error: 'Invalid credentials' });
  for (const type of ['application/x-www-form-urlencoded', 'application/octet-stream', '']) {
    const body = Buffer.from([0, 1, 10, 0, 255]);
    const echoed = await request({ token: '', method: 'POST', body, headers: { 'content-type': type } });
    assert.equal(echoed.status, 200);assert.deepEqual(echoed.body, body);
  }
  assert.equal((await request({ token: '', method: 'POST', body: Buffer.alloc(1025), headers: { 'content-type': 'text/plain' } })).status, 413);
  assert.equal((await request({ token: '', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await remote.admin(policyPath, { method: 'POST', data: { enabled: true } })).status, 200);
  assert.equal((await request({ token: '' })).status, 401, 'Re-enabling visitor auth applies to the next request');
  assert.equal((await request()).status, 200, 'The existing visitor password remains valid');
  held = true;
  const pending = request();
  await waitFor(() => !!active, 'Held request not opened');
  assert.equal((await request()).status, 503, 'No unbounded backlog on a tiny device');
  const closed = once(ws, 'close');
  const rotation = await remote.admin(`${KEYS}/${key.key.id}/rotate`, { method: 'POST', data: {} });
  assert.equal(rotation.status, 200);assert.notEqual(rotation.data.visitorToken, key.visitorToken);
  const [code] = await deadline(closed, 'Device was not disconnected on key rotation');
  assert.equal(code, 4001);assert.equal((await pending).status, 502);
  assert.ok(cancellations >= 1, 'Oversized chunked upload cancels its device stream');
});

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
