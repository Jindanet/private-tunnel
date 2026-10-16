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
const { WebSocketServer } = require('ws');
const TunnelClient = require('../client/tunnel-client');
const {
  MSG, PROTOCOL_VERSION, FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY,
  encodeDataFrame, decodeDataFrame,
} = require('../shared/protocol');

const LOOPBACK = '127.0.0.1';
const TOKEN = 'v4-integration-only-secret-at-least-32-characters';
const TIMEOUT = 30000;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A fixture may fail before its event is awaited; keep cleanup from producing
  // an unrelated unhandled rejection in that case.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function deadline(promise, message, milliseconds = 6000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(predicate, message) {
  const expires = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() >= expires) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function bytes(length, seed = 17) {
  const buffer = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) buffer[i] = (seed + i * 31 + (i >>> 8)) & 255;
  return buffer;
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function listen(server) {
  server.listen(0, LOOPBACK);
  await once(server, 'listening');
  return server.address().port;
}

function trackServer(t, server) {
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

async function gateway(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-v4-integration-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await deadline(exited, 'Gateway child did not exit during cleanup', 6000);
    }
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('ptunnel-v4-integration-'));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const reservations = await Promise.all([0, 1, 2].map(async () => {
    const server = net.createServer();
    await listen(server);
    return server;
  }));
  const [wsPort, dashboardPort, proxyPort] = reservations.map((server) => server.address().port);
  await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));

  // Use an explicit environment and a temporary cwd, so dotenv cannot read the
  // checkout's .env and no configured production database can be selected.
  const environment = {
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    TEMP: os.tmpdir(), TMP: os.tmpdir(),
    NODE_ENV: 'test',
    DB_PROVIDER: 'sqlite', DB_SYNC_TARGETS: '', DB_SYNC_STRICT: 'false', DB_BOOTSTRAP_SYNC: 'false',
    DATA_DIR: directory, SQLITE_PATH: path.join(directory, 'test.sqlite'),
    WS_PORT: String(wsPort), DASHBOARD_PORT: String(dashboardPort), PROXY_PORT: String(proxyPort),
    INTERNAL_HOST: LOOPBACK, PRIMARY_DOMAIN: LOOPBACK, TUNNEL_DOMAIN: 'apps.example.test',
    TUNNEL_TOKEN: TOKEN, DASHBOARD_PASSWORD: 'v4-integration-only-password',
    AUTO_FIREWALL: 'false', REQUEST_LOGGING: 'false',
    ALLOW_SHARED_TUNNEL_TOKEN: 'true', REQUIRE_DATA_TRANSPORT_V4: 'false',
    ALLOW_LEGACY_QUERY_TOKEN: 'false', ALLOW_UNAUTHENTICATED_TUNNELS: 'false',
  };
  child = spawn(process.execPath, [path.resolve(__dirname, '../server/index.js')], {
    cwd: directory, windowsHide: true, env: environment,
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
  await deadline(ready.promise, 'Gateway startup timed out', 10000);
  return { wsPort, proxyPort };
}

async function connectTunnel(t, servicePort, serverPort, options = {}) {
  const assigned = deferred();
  const errors = [];
  const client = new TunnelClient({
    serverUrl: `ws://${LOOPBACK}:${serverPort}`,
    token: TOKEN, localHost: LOOPBACK, localPort: servicePort,
    clientId: crypto.randomUUID(), tunnelType: 'http',
    ...options,
    onConnected: assigned.resolve,
    onError: (error) => { errors.push(error); assigned.reject(error); },
  });
  t.after(() => {
    client.disconnect();
    client.ws?.terminate();
  });
  client.connect();
  const assignment = await deadline(assigned.promise, 'Tunnel assignment timed out');
  return { client, assignment, errors };
}

function assertSelected(tunnel, version) {
  assert.equal(tunnel.assignment.dataTransportVersion, version, 'The assignment callback exposes the negotiated data transport');
  assert.equal(tunnel.client.dataTransportVersion, version, 'The running client uses the negotiated data transport');
}

function publicRequest(t, gatewayInfo, assignment, route, body, extra = {}) {
  const response = deferred();
  const request = http.request({
    host: LOOPBACK, port: gatewayInfo.proxyPort,
    path: route, method: body ? 'POST' : 'GET', agent: false,
    headers: {
      host: new URL(assignment.url).hostname,
      ...(body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {}),
    },
    ...extra,
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.once('error', response.reject);
    res.once('aborted', () => response.reject(new Error(`Response aborted: ${route}`)));
    res.once('end', () => response.resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  request.once('error', response.reject);
  request.setTimeout(15000, () => request.destroy(new Error(`HTTP request timed out: ${route}`)));
  t.after(() => request.destroy());
  request.end(body);
  return { request, response: response.promise };
}

test('v4 gateway/client preserve large binary HTTP uploads and downloads', { timeout: TIMEOUT }, async (t) => {
  const upload = bytes(2 * 1024 * 1024 + 137);
  const download = bytes(2 * 1024 * 1024 + 791, 53);
  const local = trackServer(t, http.createServer((req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    if (req.url === '/download') return res.end(download);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => res.end(Buffer.concat(chunks)));
  }));
  const port = await listen(local);
  const remote = await gateway(t);
  const tunnel = await connectTunnel(t, port, remote.wsPort);
  assertSelected(tunnel, 4);

  const echoed = await deadline(publicRequest(t, remote, tunnel.assignment, '/echo', upload).response, 'Large binary upload/echo did not complete');
  assert.equal(echoed.status, 200);
  assert.equal(echoed.body.length, upload.length);
  assert.equal(digest(echoed.body), digest(upload));
  assert.deepEqual(echoed.body, upload);

  const received = await deadline(publicRequest(t, remote, tunnel.assignment, '/download').response, 'Large binary download did not complete');
  assert.equal(received.status, 200);
  assert.equal(received.body.length, download.length);
  assert.equal(digest(received.body), digest(download));
  assert.deepEqual(received.body, download);
  assert.deepEqual(tunnel.errors, []);
});

test('a v4 upload blocked by its local consumer does not block another HTTP stream', { timeout: TIMEOUT }, async (t) => {
  const blocked = deferred();
  let resumeUpload;
  let uploadReadEnded = false;
  const local = trackServer(t, http.createServer((req, res) => {
    if (req.url === '/quick') return res.end('quick response');
    const hash = crypto.createHash('sha256');
    let length = 0;
    req.on('data', (chunk) => { hash.update(chunk); length += chunk.length; });
    req.on('end', () => {
      uploadReadEnded = true;
      res.end(JSON.stringify({ length, hash: hash.digest('hex') }));
    });
    req.pause();
    req.socket.pause();
    resumeUpload = () => { req.socket.resume(); req.resume(); };
    blocked.resolve();
  }));
  const port = await listen(local);
  const remote = await gateway(t);
  const tunnel = await connectTunnel(t, port, remote.wsPort);
  assertSelected(tunnel, 4);

  const payload = bytes(20 * 1024 * 1024 + 317, 97);
  const upload = publicRequest(t, remote, tunnel.assignment, '/blocked', payload);
  await deadline(blocked.promise, 'The blocked local upload was never opened');
  await waitFor(() => [...tunnel.client.requestStreams.values()].some((stream) =>
    stream.path === '/blocked' && stream.localReq?.writableNeedDrain),
  'The upload never reached local socket backpressure');

  // The consumer stays paused until the second request has fully completed.
  // This checks progress directly, without making a throughput claim.
  const quick = await deadline(publicRequest(t, remote, tunnel.assignment, '/quick').response,
    'An unrelated HTTP stream stalled behind the blocked upload');
  assert.equal(quick.status, 200);
  assert.equal(quick.body.toString(), 'quick response');
  assert.equal(uploadReadEnded, false);

  resumeUpload();
  const completed = await deadline(upload.response, 'The blocked upload failed to resume', 10000);
  assert.equal(completed.status, 200);
  assert.deepEqual(JSON.parse(completed.body), { length: payload.length, hash: digest(payload) });
  assert.deepEqual(tunnel.errors, []);
});

test('v4 TCP preserves an upload larger than its window and the response after visitor EOF', { timeout: TIMEOUT }, async (t) => {
  const payload = bytes(1024 * 1024 + 619, 11);
  const reply = bytes(1024 * 1024 + 997, 193);
  const localComplete = deferred();
  const local = trackServer(t, net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', () => {
      try {
        const received = Buffer.concat(chunks);
        assert.equal(received.length, payload.length, 'EOF follows all uploaded TCP bytes');
        assert.equal(digest(received), digest(payload));
        assert.deepEqual(received, payload);
        localComplete.resolve();
        // Do not reply until EOF. A full close in place of a half-close loses
        // this response, and an early END loses upload bytes above the window.
        socket.end(reply);
      } catch (error) {
        localComplete.reject(error);
        socket.destroy();
      }
    });
  }));
  const port = await listen(local);
  const remote = await gateway(t);
  const tunnel = await connectTunnel(t, port, remote.wsPort, { tunnelType: 'tcp' });
  assertSelected(tunnel, 4);
  const publicPort = Number(new URL(`tcp://${tunnel.assignment.url}`).port);
  assert.ok(Number.isInteger(publicPort) && publicPort > 0);

  const visitor = net.createConnection({ host: LOOPBACK, port: publicPort, allowHalfOpen: true });
  t.after(() => visitor.destroy());
  const completed = deferred();
  const chunks = [];
  let sawEof = false;
  visitor.on('data', (chunk) => chunks.push(chunk));
  visitor.once('error', completed.reject);
  visitor.once('end', () => { sawEof = true; completed.resolve(Buffer.concat(chunks)); });
  visitor.once('close', () => {
    if (!sawEof) completed.reject(new Error('TCP closed before returning response EOF'));
  });
  visitor.setTimeout(10000, () => visitor.destroy(new Error('TCP half-close exchange timed out')));
  await once(visitor, 'connect');
  visitor.end(payload);

  const received = await deadline(completed.promise, 'TCP response after visitor EOF did not complete', 12000);
  await deadline(localComplete.promise, 'The local TCP service did not receive upload EOF');
  assert.equal(sawEof, true);
  assert.equal(received.length, reply.length);
  assert.equal(digest(received), digest(reply));
  assert.deepEqual(received, reply);
  assert.deepEqual(tunnel.errors, []);
});

test('an explicit v1 client option still negotiates and forwards through the actual gateway', { timeout: TIMEOUT }, async (t) => {
  const payload = bytes(96 * 1024 + 71, 67);
  const local = trackServer(t, http.createServer((req, res) => req.pipe(res)));
  const port = await listen(local);
  const remote = await gateway(t);
  const tunnel = await connectTunnel(t, port, remote.wsPort, { dataTransportVersions: [1] });
  assertSelected(tunnel, 1);
  const echoed = await deadline(publicRequest(t, remote, tunnel.assignment, '/legacy', payload).response,
    'The explicitly selected v1 HTTP request did not complete');
  assert.equal(echoed.status, 200);
  assert.deepEqual(echoed.body, payload);
  assert.deepEqual(tunnel.errors, []);
});

test('a default client advertises v4 and falls back when an old server omits the selection', { timeout: TIMEOUT }, async (t) => {
  const payload = bytes(96 * 1024 + 73, 101);
  const local = trackServer(t, http.createServer((req, res) => {
    res.setHeader('x-old-server-test', 'yes');
    req.pipe(res);
  }));
  const localPort = await listen(local);
  const oldServer = new WebSocketServer({ host: LOOPBACK, port: 0, perMessageDeflate: false });
  t.after(async () => {
    for (const socket of oldServer.clients) socket.terminate();
    await new Promise((resolve) => oldServer.close(resolve));
  });
  await once(oldServer, 'listening');

  const opened = deferred();
  const complete = deferred();
  const requestId = crypto.randomUUID();
  const chunks = [];
  let responseStart;
  let peer;
  oldServer.on('connection', (socket) => {
    peer = socket;
    socket.on('error', complete.reject);
    socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          const frame = decodeDataFrame(data);
          assert.ok(frame, 'Fallback data uses the legacy UUID binary frame');
          assert.equal(frame.frameType, FRAME_RESPONSE_BODY);
          assert.equal(frame.requestId, requestId);
          chunks.push(frame.data);
          return;
        }
        const message = JSON.parse(data.toString());
        assert.equal(Array.isArray(message), false, 'The existing JSON control message format is preserved');
        if (message.type === MSG.TUNNEL_OPEN) {
          assert.equal(message.protocolVersion, PROTOCOL_VERSION);
          assert.ok(message.dataTransportVersions.includes(4), 'Default negotiation offers the v4 data transport');
          opened.resolve(message);
          socket.send(JSON.stringify({
            type: MSG.TUNNEL_ASSIGNED, tunnelType: 'http',
            subdomain: 'old', url: 'http://old.apps.example.test',
          }));
        } else if (message.type === MSG.RESPONSE_START) {
          assert.equal(message.requestId, requestId);
          responseStart = message;
        } else if (message.type === MSG.STREAM_END && message.requestId === requestId) {
          complete.resolve(Buffer.concat(chunks));
        } else if (message.type === MSG.STREAM_ERROR) {
          complete.reject(new Error(message.message));
        }
      } catch (error) {
        opened.reject(error);
        complete.reject(error);
      }
    });
  });
  const connecting = connectTunnel(t, localPort, oldServer.address().port);
  const [, tunnel] = await Promise.all([
    deadline(opened.promise, 'The old server did not receive tunnel negotiation'),
    connecting,
  ]);
  assertSelected(tunnel, 1);

  peer.send(JSON.stringify({
    type: MSG.REQUEST_START, requestId, method: 'POST', path: '/old-server',
    headers: { 'content-type': 'application/octet-stream', 'content-length': payload.length },
  }));
  peer.send(encodeDataFrame(FRAME_REQUEST_BODY, requestId, payload));
  peer.send(JSON.stringify({ type: MSG.STREAM_END, requestId, direction: 'request' }));
  const echoed = await deadline(complete.promise, 'The fallback legacy HTTP exchange did not complete');
  assert.equal(responseStart?.statusCode, 200);
  assert.equal(responseStart.headers['x-old-server-test'], 'yes');
  assert.deepEqual(echoed, payload);
  assert.deepEqual(tunnel.errors, []);
});

test('an established v4 connection rejects a second assignment that tries to select v1', {timeout: TIMEOUT}, async (t) => {
  const local = trackServer(t, http.createServer((_req,res)=>res.end('local')));
  const localPort = await listen(local);
  const server = new WebSocketServer({host:LOOPBACK,port:0,perMessageDeflate:false});
  t.after(async()=>{
    for(const socket of server.clients)socket.terminate();
    await new Promise((resolve)=>server.close(resolve));
  });
  await once(server,'listening');
  let peer;
  server.on('connection',(socket)=>{
    peer=socket;socket.on('error',()=>{});
    socket.on('message',(data,binary)=>{
      if(!binary && JSON.parse(data.toString()).type===MSG.TUNNEL_OPEN)socket.send(JSON.stringify({
        type:MSG.TUNNEL_ASSIGNED,tunnelType:'http',url:'http://selected.apps.example.test',dataTransportVersion:4,
      }));
    });
  });
  const tunnel=await connectTunnel(t,localPort,server.address().port);
  assertSelected(tunnel,4);
  const closed=once(tunnel.client.ws,'close');
  peer.send(JSON.stringify({type:MSG.TUNNEL_ASSIGNED,tunnelType:'http',url:'http://stale.apps.example.test'}));
  assert.equal((await deadline(closed,'Client accepted a transport downgrade'))[0],1002);
  assert.equal(tunnel.client.dataTransportVersion,4);
  assert.equal(tunnel.client.shouldReconnect,false);
  assert.match(tunnel.errors.at(-1).message,/unsupported data transport/i);
});
