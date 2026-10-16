'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { EventEmitter, once } = require('node:events');
const { MSG, FRAME_RESPONSE_BODY, encodeDataFrame } = require('../shared/protocol');

// Advance the real request deadline deterministically, including Timeout.refresh().
function clock() {
  let now = 0;
  const timers = new Set();
  return {
    timers,
    setTimeout(callback, delay) {
      const timer = {
        callback, delay, due: now + delay, active: true,
        refresh() { this.active = true; this.due = now + this.delay; timers.add(this); return this; },
        unref() { return this; },
      };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) { timer.active = false; timers.delete(timer); } },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter((timer) => timer.active && timer.due <= target)
          .sort((left, right) => left.due - right.due)[0];
        if (!next) break;
        now = next.due;
        next.active = false;
        timers.delete(next);
        next.callback();
      }
      now = target;
    },
  };
}

function fixture(options = {}) {
  const time = clock();
  const db = {
    getClientMapping: async () => null,
    getClientMappingByAssignedHost: async () => null,
    isSubdomainTaken: async () => false,
    saveMapping: async () => {}, touchClient: async () => {}, logRequest: async () => {},
  };
  const load = (relative) => {
    const filename = path.resolve(__dirname, relative);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require(name) {
        if (name === './db') return db;
        if (name === './firewall') return { openPort() {}, closePort() {} };
        return localRequire(name);
      },
      module, Buffer, Date, process: { env: { REQUEST_LOGGING: 'false' } },
      setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
      setInterval: () => ({}), clearInterval() {},
      console: { log() {}, error() {} },
    }, { filename });
    return module.exports;
  };
  const TunnelManager = load('../server/tunnel-manager.js');
  const { handleProxy } = load('../server/proxy.js');
  const manager = new TunnelManager(options);
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, readyState: 1, bufferedAmount: 0, controls: [] });
  ws.send = (payload) => { if (!Buffer.isBuffer(payload)) ws.controls.push(JSON.parse(payload)); };
  ws.terminate = () => { ws.readyState = 3; ws.emit('close'); };
  const tunnel = manager._createBaseTunnel(ws, { tunnelType: 'http' }, '127.0.0.1', null, {
    tunnelKey: 'http:stream.example.test', publicHost: 'stream.example.test', label: 'stream',
  });
  tunnel.ready = true;
  manager.tunnels.set(tunnel.tunnelKey, tunnel);
  manager.httpHosts.set(tunnel.publicHost, tunnel.tunnelKey);
  const responseStart = (requestId) => manager._handleControlMessage(ws, {
    type: MSG.RESPONSE_START, requestId, statusCode: 200,
    headers: { 'content-type': 'application/octet-stream' },
  }, tunnel.tunnelKey, '127.0.0.1', () => {});
  const responseBody = (requestId, bytes) => manager._handleBinaryFrame(
    encodeDataFrame(FRAME_RESPONSE_BODY, requestId, bytes), tunnel.tunnelKey,
  );
  const responseEnd = (requestId) => manager._handleControlMessage(ws, {
    type: MSG.STREAM_END, requestId,
  }, tunnel.tunnelKey, '127.0.0.1', () => {});
  return { time, manager, ws, tunnel, handleProxy, responseStart, responseBody, responseEnd };
}

function request(f, method = 'GET') {
  const req = new EventEmitter();
  Object.assign(req, {
    method, url: '/', headers: { host: f.tunnel.publicHost },
    socket: { remoteAddress: '127.0.0.1' }, resume() { return this; },
  });
  const res = new EventEmitter();
  Object.assign(res, {
    destroyed: false, headersSent: false, writableEnded: false, writableLength: 0, chunks: [],
    writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
    write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; this.emit('close'); },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  f.handleProxy(req, res, f.tunnel.publicHost, f.manager);
  const requestId = f.ws.controls.filter((message) => message.type === MSG.REQUEST_START).at(-1).requestId;
  return { req, res, requestId };
}

test('response progress keeps a binary stream alive beyond the original 30-second deadline', async () => {
  const f = fixture();
  const stream = request(f);
  stream.req.emit('end');
  f.time.advance(29000);
  await f.responseStart(stream.requestId);
  f.time.advance(29000);
  assert.equal(f.tunnel.pendingRequests.size, 1, 'Response headers refresh this request deadline');
  const parts = [Buffer.from([0, 1, 255]), Buffer.from([2, 3, 254])];
  f.responseBody(stream.requestId, parts[0]);
  f.time.advance(29000);
  f.responseBody(stream.requestId, parts[1]);
  f.time.advance(29000);
  assert.equal(f.tunnel.pendingRequests.size, 1, 'Body progress continues refreshing the deadline');
  await f.responseEnd(stream.requestId);
  assert.deepEqual(Buffer.concat(stream.res.chunks), Buffer.concat(parts));
  assert.equal(stream.res.statusCode, 200);
  assert.equal(stream.res.destroyed, false);
  assert.equal(stream.res.writableEnded, true);
  assert.equal(f.tunnel.pendingRequests.size, 0);
  assert.equal(f.time.timers.size, 0);
});

test('upload progress refreshes only its own request while an idle sibling expires', () => {
  const f = fixture();
  const upload = request(f, 'POST');
  const idle = request(f);
  f.time.advance(29000);
  upload.req.emit('data', Buffer.from('upload is still progressing'));
  f.time.advance(1000);
  assert.equal(idle.res.statusCode, 504);
  assert.equal(idle.res.writableEnded, true);
  assert.equal(f.tunnel.pendingRequests.has(idle.requestId), false);
  assert.equal(f.tunnel.pendingRequests.has(upload.requestId), true);
  f.time.advance(28999);
  assert.equal(f.tunnel.pendingRequests.has(upload.requestId), true);
  f.time.advance(1);
  assert.equal(upload.res.statusCode, 504);
  assert.equal(f.tunnel.pendingRequests.size, 0);
  assert.equal(f.time.timers.size, 0);
});

test('the configured request idle deadline returns 504 before any response starts', () => {
  const f = fixture({ requestIdleTimeoutMs: 1234 });
  const stream = request(f);
  f.time.advance(1233);
  assert.equal(stream.res.headersSent, false);
  f.time.advance(1);
  assert.equal(stream.res.statusCode, 504);
  assert.equal(stream.res.writableEnded, true);
  assert.equal(f.tunnel.pendingRequests.size, 0);
  assert.equal(f.ws.controls.filter((message) => message.type === MSG.STREAM_ERROR).length, 1);
  f.time.advance(30000);
  assert.equal(f.ws.controls.filter((message) => message.type === MSG.STREAM_ERROR).length, 1);
});

test('visitor abort and response disconnect clear their timers and cancel once', () => {
  for (const trigger of ['abort', 'disconnect']) {
    const f = fixture();
    const stream = request(f);
    if (trigger === 'abort') stream.req.emit('aborted');
    else stream.res.destroy();
    assert.equal(f.tunnel.pendingRequests.size, 0);
    assert.equal(f.time.timers.size, 0);
    f.time.advance(60000);
    assert.equal(f.ws.controls.filter((message) => message.type === MSG.STREAM_ERROR).length, 1);
  }
});

test('HTTP failures after status 200 abort the binary response without appending gateway text', { timeout: 5000 }, async (t) => {
  for (const cause of ['timeout', 'peer error', 'tunnel disconnect']) {
    await t.test(cause, async (t) => {
      const f = fixture();
      const bytes = Buffer.from([0, 1, 2, 255]);
      let requestId;
      const sockets = new Set();
      const server = http.createServer((req, res) => {
        f.handleProxy(req, res, f.tunnel.publicHost, f.manager);
        requestId = [...f.tunnel.pendingRequests.keys()][0];
        f.responseStart(requestId);
        f.responseBody(requestId, bytes);
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise((resolve) => server.close(resolve));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      let received;
      let ready;
      const firstChunk = new Promise((resolve) => { ready = resolve; });
      const chunks = [];
      const terminal = new Promise((resolve, reject) => {
        const visitor = http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, (res) => {
          received = res;
          res.on('data', (chunk) => { chunks.push(chunk); ready(); });
          res.once('end', () => resolve('end'));
          res.once('aborted', () => resolve('aborted'));
          res.on('error', () => {});
        });
        visitor.on('error', reject);
        t.after(() => visitor.destroy());
      });
      await firstChunk;
      if (cause === 'timeout') f.time.advance(30000);
      else if (cause === 'peer error') await f.manager._handleControlMessage(f.ws, {
        type: MSG.STREAM_ERROR, requestId, message: 'Local service failed',
      }, f.tunnel.tunnelKey, '127.0.0.1', () => {});
      else f.manager._removeTunnel(f.tunnel.tunnelKey);
      assert.equal(await terminal, 'aborted', 'Failure must remain visible to the HTTP consumer');
      assert.equal(received.statusCode, 200);
      assert.equal(received.complete, false);
      assert.deepEqual(Buffer.concat(chunks), bytes);
      assert.equal(f.tunnel.pendingRequests.size, 0);
      assert.equal(f.time.timers.size, 0);
    });
  }
});
