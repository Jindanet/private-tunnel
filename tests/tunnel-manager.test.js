const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { MSG, FRAME_RESPONSE_BODY, FRAME_TCP_DATA, PROTOCOL_VERSION, encodeDataFrame, MAX_BUFFERED_BYTES } = require('../shared/protocol');

const sourcePath = path.join(__dirname, '../server/tunnel-manager.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const localRequire = createRequire(sourcePath);
const requestId = '10000000-0000-4000-8000-000000000001';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ db: overrides = {}, autoListen = true, assignedPorts = [] } = {}) {
  const servers = [];
  const openedPorts = [];
  const closedPorts = [];
  let label = 0;
  let nextPort = 41000;
  const ports = [...assignedPorts];
  const db = {
    getClientMapping: async () => null,
    getClientMappingByAssignedHost: async () => null,
    isSubdomainTaken: async () => false,
    saveMapping: async () => {},
    touchClient: async () => {},
    logRequest: async () => {},
    ...overrides,
  };
  const net = {
    createServer(options, onConnection) {
      if (typeof options === 'function') onConnection = options;
      const server = new EventEmitter();
      server.closed = false;
      server.bound = false;
      if (onConnection) server.on('connection', onConnection);
      server.completeListen = () => {
        if (server.closed) return;
        server.bound = true;
        server.emit('listening');
      };
      server.listen = (requestedPort) => {
        server.requestedPort = requestedPort;
        server.port = ports.shift() ?? nextPort++;
        servers.push(server);
        if (autoListen) queueMicrotask(server.completeListen);
        return server;
      };
      server.address = () => server.bound ? { address: '::', family: 'IPv6', port: server.port } : null;
      server.close = (callback) => { server.closed = true; server.bound = false; if (callback) callback(); return server; };
      return server;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    require(name) {
      if (name === './db') return db;
      if (name === './firewall') return { openPort: (port) => openedPorts.push(port), closePort: (port) => closedPorts.push(port) };
      if (name === 'node:net') return net;
      if (name === './subdomain') return { generate: () => `generated-${++label}`, RESERVED: new Set() };
      return localRequire(name);
    },
    module,
    process: { env: {} },
    setInterval: () => ({}),
    clearInterval() {},
    clearTimeout,
    console: { log() {}, error() {} },
  }, { filename: sourcePath });
  const manager = new module.exports({
    publishDomains: [{ domain: 'publish.example.test', allowRoot: true, allowSubdomain: true }],
  });
  return { manager, db, servers, openedPorts, closedPorts };
}

function socket() {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.readyState = ws.OPEN;
  ws.messages = [];
  ws.send = (payload) => ws.messages.push(JSON.parse(payload.toString()));
  ws.close = () => {
    if (ws.readyState === 3) return;
    ws.readyState = 3;
    ws.emit('close');
  };
  ws.terminate = ws.close;
  ws.control = (payload) => ws.emit('message', Buffer.from(JSON.stringify(payload)), false);
  return ws;
}

function response() {
  return {
    destroyed: false,
    headersSent: false,
    writableLength: 0,
    chunks: [],
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; this.headersSent = true; },
    write(chunk) { this.chunks.push(chunk); },
    end(body) { this.ended = true; this.body = body; },
    destroy() { this.destroyed = true; },
  };
}

function activeTunnel(manager, ws, { tcp = false } = {}) {
  const key = tcp ? 'tcp:41000' : 'http:publish.example.test';
  const tunnel = manager._createBaseTunnel(ws, { tunnelType: tcp ? 'tcp' : 'http' }, '127.0.0.1', null, {
    tunnelKey: key,
    publicHost: 'publish.example.test',
    label: 'test-host',
  });
  if (tcp) {
    tunnel.tcpConnections = new Map();
    tunnel.tcpPort = 41000;
  } else {
    manager.httpHosts.set(tunnel.publicHost, key);
  }
  manager.tunnels.set(key, tunnel);
  return tunnel;
}

function pendingResponse(tunnel, res = response()) {
  const pending = { res, timeout: null, startTime: Date.now(), method: 'GET', path: '/', statusCode: null };
  tunnel.pendingRequests.set(requestId, pending);
  return pending;
}

test('concurrent opens are bounded while response traffic still progresses during a pending save', async () => {
  const save = deferred();
  let saves = 0;
  const { manager } = fixture({ db: { saveMapping: async () => { saves += 1; await save.promise; } } });
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN, clientId: 'profile-one' });
  await flush();
  assert.equal(manager.tunnels.size, 1);
  const tunnel = [...manager.tunnels.values()][0];
  const pending = pendingResponse(tunnel);
  ws.control({ type: MSG.TUNNEL_OPEN, clientId: 'profile-two' });
  ws.control({ type: MSG.RESPONSE_START, requestId, statusCode: 200, headers: { 'x-test': 'ok' } });
  await flush();
  assert.equal(saves, 1);
  assert.equal(manager.tunnels.size, 1);
  assert.equal(pending.res.statusCode, 200);
  assert.match(ws.messages.find((msg) => msg.type === MSG.TUNNEL_ERROR).message, /already being opened/);
  save.resolve();
  await flush();
  assert.equal(ws.messages.filter((msg) => msg.type === MSG.TUNNEL_ASSIGNED).length, 1);
  ws.close();
  assert.equal(manager.tunnels.size, 0);
});

test('sequential opens replace one socket tunnel without disconnecting other sockets sharing the profile', async () => {
  const { manager } = fixture();
  const one = socket();
  const two = socket();
  manager.handleNewClient(one, '127.0.0.1');
  manager.handleNewClient(two, '127.0.0.2');
  one.control({ type: MSG.TUNNEL_OPEN, clientId: 'shared-profile', desiredSubdomain: 'first-host' });
  await flush();
  two.control({ type: MSG.TUNNEL_OPEN, clientId: 'shared-profile', desiredSubdomain: 'second-host' });
  await flush();
  assert.equal(manager.tunnels.size, 2);
  assert.equal(one.readyState, one.OPEN);
  one.control({ type: MSG.TUNNEL_OPEN, clientId: 'shared-profile', desiredSubdomain: 'third-host' });
  await flush();
  assert.equal(manager.tunnels.size, 2);
  assert.equal(manager.httpHosts.has('first-host.publish.example.test'), false);
  assert.equal(manager.httpHosts.has('third-host.publish.example.test'), true);
  one.close();
  two.close();
  assert.equal(manager.tunnels.size, 0);
});

test('optional protocol negotiation accepts legacy and current clients while a mismatch preserves the active tunnel', async () => {
  const { manager } = fixture();
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN });
  await flush();
  const active = [...manager.tunnels.values()][0];
  for (const protocolVersion of [PROTOCOL_VERSION + 1, String(PROTOCOL_VERSION), null]) {
    ws.control({ type: MSG.TUNNEL_OPEN, protocolVersion });
    await flush();
    assert.equal(manager.tunnels.get(active.tunnelKey), active);
    assert.match(ws.messages.at(-1).message, /Unsupported tunnel protocol/);
  }
  ws.control({ type: MSG.TUNNEL_OPEN, protocolVersion: PROTOCOL_VERSION });
  await flush();
  assert.equal(manager.tunnels.size, 1);
  assert.notEqual([...manager.tunnels.values()][0], active);
  assert.equal(ws.messages.filter((message) => message.type === MSG.TUNNEL_ASSIGNED).length, 2);
  ws.close();
});

test('v4 negotiation is explicit, idempotent and cannot downgrade an active WebSocket', async () => {
  const { manager } = fixture();
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({type:MSG.TUNNEL_OPEN,protocolVersion:1,dataTransportVersions:[4,1]});
  await flush();
  const active = [...manager.tunnels.values()][0];
  assert.equal(active.dataTransportVersion,4);
  assert.equal(active.ready,true);
  assert.equal(ws.messages.at(-1).dataTransportVersion,4);
  for (const capabilities of [[1], '4', [4.5]]) {
    ws.control({type:MSG.TUNNEL_OPEN,protocolVersion:1,dataTransportVersions:capabilities});
    await flush();
    assert.equal(manager.tunnels.get(active.tunnelKey),active);
    assert.equal(ws.messages.at(-1).type,MSG.TUNNEL_ERROR);
  }
  ws.control({type:MSG.TUNNEL_OPEN,protocolVersion:1,dataTransportVersions:[4]});
  await flush();
  assert.equal(ws.messages.at(-1).dataTransportVersion,4);
  assert.equal(ws.readyState,ws.OPEN);
  ws.close();
});

test('modern publication waits for assignment while response headers retain wire order', async () => {
  const save = deferred();
  const { manager } = fixture({db:{saveMapping:()=>save.promise}});
  const ws = socket();
  manager.handleNewClient(ws,'127.0.0.1');
  ws.control({type:MSG.TUNNEL_OPEN,clientId:'saved-profile',dataTransportVersions:[4]});
  await flush();
  const tunnel=[...manager.tunnels.values()][0];
  const res=response();
  require('../server/proxy').handleProxy({headers:{}},res,tunnel.publicHost,manager);
  assert.equal(res.statusCode,503);
  save.resolve();await flush();
  assert.equal(tunnel.ready,true);
  ws.close();

  const legacy=socket();
  manager.handleNewClient(legacy,'127.0.0.2');
  legacy.control({type:MSG.TUNNEL_OPEN});await flush();
  const active=[...manager.tunnels.values()][0];
  const pending=pendingResponse(active);
  pending.res.write=(chunk)=>{
    assert.equal(pending.res.headersSent,true,'headers must be processed before the next binary WS message');
    pending.res.chunks.push(chunk);
  };
  legacy.control({type:MSG.RESPONSE_START,requestId,statusCode:200,headers:{}});
  legacy.emit('message',encodeDataFrame(FRAME_RESPONSE_BODY,requestId,Buffer.from('ordered')),true);
  assert.deepEqual(pending.res.chunks,[Buffer.from('ordered')]);
  legacy.close();
});

test('closing while client lookup or host lookup is pending cannot register a tunnel', async () => {
  for (const operation of ['getClientMapping', 'getClientMappingByAssignedHost']) {
    const gate = deferred();
    const { manager, openedPorts } = fixture({ db: { [operation]: () => gate.promise } });
    const ws = socket();
    manager.handleNewClient(ws, '127.0.0.1');
    ws.control({ type: MSG.TUNNEL_OPEN, clientId: 'profile-one' });
    await flush();
    ws.close();
    gate.resolve(null);
    await flush();
    assert.equal(manager.tunnels.size, 0, operation);
    assert.equal(manager.httpHosts.size, 0, operation);
    assert.equal(openedPorts.length, 0, operation);
    assert.equal(ws.messages.some((msg) => msg.type === MSG.TUNNEL_ASSIGNED), false, operation);
  }
});

test('a delayed failing save cannot remove a newer socket registration of the same public host', async () => {
  const save = deferred();
  const { manager } = fixture({ db: { saveMapping: () => save.promise } });
  const one = socket();
  manager.handleNewClient(one, '127.0.0.1');
  one.control({ type: MSG.TUNNEL_OPEN, clientId: 'profile-one', publishMode: 'root' });
  await flush();
  assert.equal(manager.tunnels.size, 1);
  one.close();
  const two = socket();
  manager.handleNewClient(two, '127.0.0.2');
  two.control({ type: MSG.TUNNEL_OPEN, publishMode: 'root' });
  await flush();
  const replacement = manager.getHttpTunnel('publish.example.test');
  assert.equal(replacement.ws, two);
  save.reject(new Error('Delayed database failure'));
  await flush();
  assert.equal(manager.getHttpTunnel('publish.example.test'), replacement);
  assert.equal(one.messages.some((msg) => msg.type === MSG.TUNNEL_ASSIGNED), false);
  two.close();
});

test('a failed active HTTP save releases its registration and permits a later open', async () => {
  let calls = 0;
  const { manager } = fixture({ db: { saveMapping: async () => { if (++calls === 1) throw new Error('Database unavailable'); } } });
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN, clientId: 'profile-one' });
  await flush();
  assert.equal(manager.tunnels.size, 0);
  ws.control({ type: MSG.TUNNEL_OPEN, clientId: 'profile-one' });
  await flush();
  assert.equal(manager.tunnels.size, 1);
  assert.equal(ws.messages.filter((msg) => msg.type === MSG.TUNNEL_ASSIGNED).length, 1);
  ws.close();
});

test('closing during a pending TCP bind settles opening and closes the listener without publication', async () => {
  const { manager, openedPorts, closedPorts, servers } = fixture({ autoListen: false });
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  const start = manager._startTcpServer.bind(manager);
  let settled = false;
  manager._startTcpServer = (...args) => start(...args).finally(() => { settled = true; });
  ws.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
  await flush();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].requestedPort, 0);
  assert.equal(manager.tunnels.size, 0);
  ws.close();
  servers[0].completeListen();
  await flush();
  assert.equal(settled, true);
  assert.equal(servers[0].closed, true);
  assert.equal(servers[0].listenerCount('listening'), 0);
  assert.equal(manager.tunnels.size, 0);
  assert.equal(openedPorts.length, 0);
  assert.equal(closedPorts.length, 0);
  assert.equal(ws.messages.some((msg) => msg.type === MSG.TUNNEL_ASSIGNED), false);
});

test('disconnecting after listening but before the opening continuation cannot leak the bound listener', async () => {
  const { manager, servers, openedPorts, closedPorts } = fixture({ autoListen: false });
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
  await flush();
  servers[0].completeListen();
  ws.close();
  await flush();
  assert.equal(servers[0].closed, true);
  assert.equal(manager.tunnels.size, 0);
  assert.equal(openedPorts.length, 0);
  assert.equal(closedPorts.length, 0);
  assert.equal(ws.messages.some((msg) => msg.type === MSG.TUNNEL_ASSIGNED), false);
});

test('closing during TCP save closes the listener and firewall once without a late assignment', async () => {
  const save = deferred();
  const { manager, servers, openedPorts, closedPorts } = fixture({ db: { saveMapping: () => save.promise } });
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp', clientId: 'profile-one' });
  await flush();
  assert.equal(manager.tunnels.size, 1);
  assert.deepEqual(openedPorts, [41000]);
  ws.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp', clientId: 'profile-two' });
  await flush();
  assert.equal(servers.length, 1);
  ws.close();
  assert.equal(servers[0].closed, true);
  assert.deepEqual(closedPorts, [41000]);
  save.resolve();
  await flush();
  assert.equal(manager.tunnels.size, 0);
  assert.deepEqual(closedPorts, [41000]);
  assert.equal(ws.messages.some((msg) => msg.type === MSG.TUNNEL_ASSIGNED), false);
});

test('concurrent TCP opens publish distinct OS-assigned ports only after their actual listeners bind', async () => {
  const { manager, servers, openedPorts, closedPorts } = fixture({ autoListen: false, assignedPorts: [42001, 52002] });
  const one = socket();
  const two = socket();
  manager.handleNewClient(one, '127.0.0.1');
  manager.handleNewClient(two, '127.0.0.2');
  one.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
  two.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
  await flush();
  assert.equal(servers.length, 2);
  assert.deepEqual(servers.map((server) => server.requestedPort), [0, 0]);
  assert.equal(manager.tunnels.size, 0);
  assert.equal(openedPorts.length, 0);
  assert.equal(one.messages.length + two.messages.length, 0);
  for (const server of servers) server.completeListen();
  await flush();
  assert.equal(manager.tunnels.size, 2);
  assert.deepEqual(openedPorts, [42001, 52002]);
  for (const [ws, port] of [[one, 42001], [two, 52002]]) {
    const assigned = ws.messages.find((msg) => msg.type === MSG.TUNNEL_ASSIGNED);
    assert.equal(assigned.tcpPort, port);
    assert.equal(assigned.url, `publish.example.test:${port}`);
    assert.equal(manager.tunnels.get(`tcp:${port}`).ws, ws);
    ws.close();
  }
  assert.deepEqual(closedPorts, [42001, 52002]);
  assert.equal(manager.tunnels.size, 0);
});

test('TCP bind failure closes the pending listener without assigning a port or opening a firewall rule', async () => {
  const { manager, servers, openedPorts, closedPorts } = fixture({ autoListen: false });
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
  await flush();
  servers[0].emit('error', new Error('Listen failed'));
  await flush();
  assert.equal(servers[0].closed, true);
  assert.equal(servers[0].listenerCount('listening'), 0);
  assert.equal(manager.tunnels.size, 0);
  assert.equal(openedPorts.length, 0);
  assert.equal(closedPorts.length, 0);
  assert.equal(ws.messages.at(-1).type, MSG.TUNNEL_ERROR);
  ws.close();
});

test('TCP listener failure releases its registration, reserved port and firewall', async () => {
  const { manager, servers, closedPorts } = fixture();
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
  await flush();
  servers[0].emit('error', new Error('Address in use'));
  assert.equal(manager.tunnels.size, 0);
  assert.deepEqual(closedPorts, [41000]);
  assert.equal(ws.messages.at(-1).type, MSG.TUNNEL_ERROR);
  ws.close();
});

test('a stale TCP socket cannot write to or remove another socket that reuses its released port', async () => {
  for (const action of ['close', 'reopen']) {
    const { manager, servers } = fixture({ assignedPorts: [41000, 41000, 41001] });
    const old = socket();
    manager.handleNewClient(old, '127.0.0.1');
    old.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
    await flush();
    servers[0].emit('error', new Error('Listener failed'));
    const next = socket();
    manager.handleNewClient(next, '127.0.0.2');
    next.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
    await flush();
    const replacement = manager.tunnels.get('tcp:41000');
    const destination = response();
    replacement.tcpConnections.set(requestId, destination);
    old.emit('message', encodeDataFrame(FRAME_TCP_DATA, requestId, Buffer.from('unrelated')), true);
    assert.equal(destination.chunks.length, 0);
    if (action === 'close') old.close();
    else {
      old.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
      await flush();
      assert.equal(manager.tunnels.size, 2);
    }
    assert.equal(manager.tunnels.get('tcp:41000'), replacement);
    old.close();
    next.close();
  }
});

test('reserved roots reject omitted and different client IDs in preview and actual opens', async () => {
  for (const clientId of [undefined, 'other-profile']) {
    const { manager } = fixture({ db: { getClientMappingByAssignedHost: async () => ({ client_id: 'owner-profile' }) } });
    const request = { type: MSG.TUNNEL_OPEN, publishMode: 'root', clientId };
    const preview = await manager.previewTunnelRequest(request);
    assert.equal(preview.available, false);
    assert.match(preview.message, /reserved/);
    const ws = socket();
    manager.handleNewClient(ws, '127.0.0.1');
    ws.control(request);
    await flush();
    assert.equal(manager.tunnels.size, 0);
    assert.match(ws.messages.find((msg) => msg.type === MSG.TUNNEL_ERROR).message, /reserved/);
    ws.close();
  }
});

test('unreserved anonymous root publishing remains available and assigned', async () => {
  const { manager } = fixture();
  const request = { type: MSG.TUNNEL_OPEN, publishMode: 'root' };
  assert.equal((await manager.previewTunnelRequest(request)).available, true);
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control(request);
  await flush();
  assert.equal(ws.messages.find((msg) => msg.type === MSG.TUNNEL_ASSIGNED).url, 'https://publish.example.test');
  ws.close();
});

test('same-owner root reconnect preserves saved mode and host after disconnection', async () => {
  const record = { client_id: 'owner-profile', subdomain: 'remembered-host', assigned_host: 'publish.example.test', publish_mode: 'root', publish_domain: 'publish.example.test' };
  const { manager } = fixture({ db: {
    getClientMapping: async () => record,
    getClientMappingByAssignedHost: async () => record,
    isSubdomainTaken: async () => true,
  } });
  assert.equal((await manager.previewTunnelRequest({ publishMode: 'root', clientId: record.client_id })).available, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ws = socket();
    manager.handleNewClient(ws, '127.0.0.1');
    ws.control({ type: MSG.TUNNEL_OPEN, clientId: record.client_id });
    await flush();
    const assigned = ws.messages.find((msg) => msg.type === MSG.TUNNEL_ASSIGNED);
    assert.equal(assigned.publishMode, 'root');
    assert.equal(assigned.publicHost, record.assigned_host);
    ws.close();
    assert.equal(manager.tunnels.size, 0);
  }
});

test('removing a TCP tunnel cannot remove an HTTP route sharing its publish domain', () => {
  const { manager } = fixture();
  const http = activeTunnel(manager, socket());
  const tcp = activeTunnel(manager, socket(), { tcp: true });
  manager._removeTunnel(tcp.tunnelKey);
  assert.equal(manager.getHttpTunnel(http.publicHost), http);
});

test('null, primitive, array and invalid binary messages cannot escape the socket handler', async () => {
  const { manager } = fixture();
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  for (const payload of [null, [], 'unexpected', 7, {}]) {
    assert.doesNotThrow(() => ws.control(payload));
  }
  ws.control({ type: MSG.TUNNEL_OPEN });
  await flush();
  manager._handleBinaryFrame = () => { throw new Error('Invalid binary frame'); };
  assert.doesNotThrow(() => ws.emit('message', Buffer.alloc(17), true));
  assert.doesNotThrow(() => ws.emit('message', encodeDataFrame(FRAME_RESPONSE_BODY, requestId, Buffer.from('data')), true));
  await flush();
  assert.equal(ws.messages.filter((msg) => msg.type === MSG.TUNNEL_ERROR).length, 6);
  ws.close();
});

test('invalid response status and headers complete the pending request with a safe gateway error', async () => {
  const invalid = [
    { statusCode: '<img src=x>', headers: {} },
    { statusCode: 99, headers: {} },
    { statusCode: 1000, headers: {} },
    { statusCode: 200, headers: null },
    { statusCode: 200, headers: [] },
    { statusCode: 200, headers: { 'x-invalid\r\nname': 'value' } },
    { statusCode: 200, headers: { 'x-test': 'value\r\ninjected: 1' } },
    { statusCode: 200, headers: { 'x-test': {} } },
  ];
  for (const metadata of invalid) {
    const { manager } = fixture();
    const ws = socket();
    const tunnel = activeTunnel(manager, ws);
    const pending = pendingResponse(tunnel);
    await manager._handleControlMessage(ws, { type: MSG.RESPONSE_START, requestId, ...metadata }, tunnel.tunnelKey, '127.0.0.1', () => {});
    assert.equal(tunnel.pendingRequests.size, 0);
    assert.equal(pending.res.statusCode, 502);
    assert.equal(pending.res.body, 'Bad Gateway');
    assert.equal(ws.messages.at(-1).type, MSG.STREAM_ERROR);
  }
});

test('normal response headers and multiple cookies pass through with transfer encoding removed case-insensitively', async () => {
  const { manager } = fixture();
  const ws = socket();
  const tunnel = activeTunnel(manager, ws);
  const pending = pendingResponse(tunnel);
  await manager._handleControlMessage(ws, {
    type: MSG.RESPONSE_START, requestId, statusCode: 200,
    headers: { 'Set-Cookie': ['a=1', 'b=2'], 'Transfer-Encoding': 'chunked', 'x-test': 'ok' },
  }, tunnel.tunnelKey, '127.0.0.1', () => {});
  assert.equal(pending.res.statusCode, 200);
  assert.deepEqual(pending.res.headers['Set-Cookie'], ['a=1', 'b=2']);
  assert.equal(pending.res.headers['x-test'], 'ok');
  assert.equal(Object.hasOwn(pending.res.headers, 'Transfer-Encoding'), false);
  assert.equal(tunnel.pendingRequests.size, 1);
});

test('HTTP body buffer overflow and write failures remove pending stream state', () => {
  for (const fail of ['overflow', 'throw']) {
    const { manager } = fixture();
    const ws = socket();
    const tunnel = activeTunnel(manager, ws);
    const res = response();
    if (fail === 'overflow') res.writableLength = MAX_BUFFERED_BYTES;
    else res.write = () => { throw new Error('Write failed'); };
    pendingResponse(tunnel, res);
    manager._handleBinaryFrame(encodeDataFrame(FRAME_RESPONSE_BODY, requestId, Buffer.from('body')), tunnel.tunnelKey);
    assert.equal(tunnel.pendingRequests.size, 0);
    assert.equal(tunnel.stats.bytesOut, 0);
    assert.equal(ws.messages.at(-1).type, MSG.STREAM_ERROR);
    if (fail === 'overflow') assert.equal(res.destroyed, true);
  }
});

test('normal HTTP and TCP body chunks retain their bytes and accounting', () => {
  const { manager } = fixture();
  const ws = socket();
  const http = activeTunnel(manager, ws);
  const pending = pendingResponse(http);
  const body = Buffer.from('ordinary body');
  manager._handleBinaryFrame(encodeDataFrame(FRAME_RESPONSE_BODY, requestId, body), http.tunnelKey);
  assert.deepEqual(pending.res.chunks, [body]);
  assert.equal(http.stats.bytesOut, body.length);
  const tcp = activeTunnel(manager, ws, { tcp: true });
  const destination = response();
  tcp.tcpConnections.set(requestId, destination);
  manager._handleBinaryFrame(encodeDataFrame(FRAME_TCP_DATA, requestId, body), tcp.tunnelKey);
  assert.deepEqual(destination.chunks, [body]);
  assert.equal(tcp.stats.bytesOut, body.length);
  destination.writableLength = MAX_BUFFERED_BYTES;
  manager._handleBinaryFrame(encodeDataFrame(FRAME_TCP_DATA, requestId, body), tcp.tunnelKey);
  assert.equal(destination.destroyed, true);
});

test('TCP listeners cap accepted connections and terminate idle sockets after five minutes', async () => {
  const { manager, servers } = fixture();
  const ws = socket();
  manager.handleNewClient(ws, '127.0.0.1');
  ws.control({ type: MSG.TUNNEL_OPEN, tunnelType: 'tcp' });
  await flush();
  const tunnel = [...manager.tunnels.values()][0];
  const connections = [];
  for (let index = 0; index < 129; index++) {
    const sock = new EventEmitter();
    sock.destroyed = false;
    sock.setTimeout = (delay, callback) => { sock.idleDelay = delay; sock.onIdle = callback; };
    sock.destroy = () => { if (!sock.destroyed) { sock.destroyed = true; sock.emit('close'); } };
    connections.push(sock);
    servers[0].emit('connection', sock);
  }
  assert.equal(tunnel.tcpConnections.size, 128);
  assert.equal(connections[128].destroyed, true);
  assert.equal(connections[0].idleDelay, 300000);
  connections[0].onIdle();
  assert.equal(connections[0].destroyed, true);
  assert.equal(tunnel.tcpConnections.size, 127);
  ws.close();
  assert.equal(tunnel.tcpConnections.size, 0);
  assert.equal(manager.tunnels.size, 0);
});

test('a TCP visitor is released immediately when its connect control cannot be sent', async () => {
  const {manager,servers}=fixture();
  const ws=socket();
  const tunnel=activeTunnel(manager,ws,{tcp:true});
  await manager._startTcpServer(ws,tunnel);
  const visitor=new EventEmitter();
  visitor.setTimeout=()=>{};
  visitor.destroy=()=>{visitor.destroyed=true;};
  ws.send=()=>{throw new Error('Send failed');};
  assert.doesNotThrow(()=>servers[0].emit('connection',visitor));
  assert.equal(visitor.destroyed,true);
  assert.equal(tunnel.tcpConnections.size,0);
  manager._removeTunnel(tunnel.tunnelKey);
  ws.close();
});
