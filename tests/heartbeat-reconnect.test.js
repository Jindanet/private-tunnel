'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { MSG } = require('../shared/protocol');

function timers() {
  const intervals = new Set();
  const timeouts = new Set();
  const make = (collection, callback, delay) => {
    const handle = { callback, delay, unref() { return this; } };
    collection.add(handle);
    return handle;
  };
  return {
    intervals, timeouts,
    setInterval: (callback, delay) => make(intervals, callback, delay),
    clearInterval: (handle) => intervals.delete(handle),
    setTimeout: (callback, delay) => make(timeouts, callback, delay),
    clearTimeout: (handle) => timeouts.delete(handle),
    tick() { for (const handle of [...intervals]) handle.callback(); },
    fire(handle) { if (timeouts.delete(handle)) handle.callback(); },
  };
}

class Socket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor() {
    super();
    this.OPEN = Socket.OPEN;
    this.readyState = Socket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    this.terminations = 0;
  }
  open() { this.readyState = this.OPEN; this.emit('open'); }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  control(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code);
  }
  terminate() { this.terminations++; this.close(); }
}

function managerFixture() {
  const time = timers();
  const filename = path.resolve(__dirname, '../server/tunnel-manager.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const db = {
    getClientMapping: async () => null, getClientMappingByAssignedHost: async () => null,
    isSubdomainTaken: async () => false, saveMapping: async () => {}, touchClient: async () => {},
    logRequest: async () => {},
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer,
    require(name) {
      if (name === './db') return db;
      if (name === './firewall') return { openPort() {}, closePort() {} };
      return localRequire(name);
    },
    setInterval: time.setInterval, clearInterval: time.clearInterval,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    process: { env: { REQUEST_LOGGING: 'false' } }, console: { log() {}, error() {} },
  }, { filename });
  const manager = new module.exports({
    publishDomains: [{ domain: 'apps.example.test', allowRoot: true, allowSubdomain: true }],
  });
  const connect = () => {
    const ws = new Socket();
    ws.open();
    manager.handleNewClient(ws, '127.0.0.1');
    return ws;
  };
  return { time, manager, connect };
}

test('a peer missing two heartbeat replies is terminated before a third ping', () => {
  const f = managerFixture();
  const ws = f.connect();
  assert.equal([...f.time.intervals][0].delay, 30000);
  f.time.tick();
  assert.equal(ws.sent.filter((message) => message.type === MSG.PING).length, 1);
  assert.equal(ws.readyState, ws.OPEN);
  f.time.tick();
  assert.equal(ws.sent.filter((message) => message.type === MSG.PING).length, 2);
  assert.equal(ws.readyState, ws.OPEN, 'Allow the second reply interval to elapse');
  f.time.tick();
  assert.equal(ws.terminations, 1);
  assert.equal(ws.sent.filter((message) => message.type === MSG.PING).length, 2);
  assert.equal(f.time.intervals.size, 0);
  f.time.tick();
  assert.equal(ws.terminations, 1);
});

test('PONG keeps its peer alive without extending an unresponsive sibling connection', () => {
  const f = managerFixture();
  const healthy = f.connect();
  const silent = f.connect();
  for (let round = 0; round < 6; round++) {
    f.time.tick();
    healthy.control({ type: MSG.PONG });
  }
  assert.equal(healthy.readyState, healthy.OPEN);
  assert.equal(healthy.terminations, 0);
  assert.equal(silent.terminations, 1);
  assert.equal(f.time.intervals.size, 1);
  healthy.close();
  assert.equal(f.time.intervals.size, 0);
});

test('a delayed second-round PONG resets the missed-reply allowance', () => {
  const f = managerFixture();
  const ws = f.connect();
  for (let cycle = 0; cycle < 3; cycle++) {
    f.time.tick();
    f.time.tick();
    assert.equal(ws.terminations, 0);
    ws.control({ type: MSG.PONG });
  }
  f.time.tick();
  assert.equal(ws.terminations, 0);
  ws.close();
  assert.equal(f.time.intervals.size, 0);
});

test('heartbeat eviction releases an assigned HTTP host through normal socket teardown', async () => {
  const f = managerFixture();
  const ws = f.connect();
  ws.control({ type: MSG.TUNNEL_OPEN, protocolVersion: 1, tunnelType: 'http' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.manager.tunnels.size, 1);
  assert.equal(f.manager.httpHosts.size, 1);
  f.time.tick();
  f.time.tick();
  f.time.tick();
  assert.equal(ws.terminations, 1);
  assert.equal(f.manager.tunnels.size, 0);
  assert.equal(f.manager.httpHosts.size, 0);
  assert.equal(f.time.intervals.size, 0);
});

function clientFixture(random = 0.5) {
  const time = timers();
  const filename = path.resolve(__dirname, '../client/tunnel-client.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const math = Object.create(Math);
  math.random = () => random;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, URL, Math: math,
    require(name) {
      if (name === 'ws') return Socket;
      if (name === 'node:os') return { hostname: () => 'test', platform: () => 'test', release: () => 'test', arch: () => 'test' };
      return localRequire(name);
    },
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    console: { log() {}, error() {} },
  }, { filename });
  const errors = [];
  const client = new module.exports({
    serverUrl: 'ws://127.0.0.1:8080', localPort: 3000,
    onError: (error) => errors.push(error),
  });
  return { time, client, errors };
}

test('a silent server is terminated locally and retried, while heartbeat refresh and disconnect clear the watchdog', () => {
  const f = clientFixture();
  f.client.connect();
  const ws = f.client.ws;
  ws.open();
  const original = f.client.serverSilenceTimer;
  assert.equal(original.delay, 90000);
  ws.control({ type: MSG.PING });
  assert.equal(f.time.timeouts.has(original), false);
  const refreshed = f.client.serverSilenceTimer;
  assert.notEqual(refreshed, original);
  assert.equal(ws.sent.at(-1).type, MSG.PONG);
  f.time.fire(refreshed);
  assert.equal(ws.terminations, 1);
  assert.ok(f.client.reconnectTimer, 'A local termination schedules reconnect without a remote close packet');
  f.client.disconnect();
  assert.equal(f.time.timeouts.size, 0);
});

test('reconnect delays have jitter within half to full exponential caps, including the maximum', () => {
  const firstDelays = [];
  for (const random of [0, 0.5, 0.999999]) {
    const f = clientFixture(random);
    f.client.connect = () => {};
    for (const attempt of [0, 1, 4, 5, 30]) {
      f.client.reconnectAttempts = attempt;
      f.client._reconnect();
      assert.equal(f.time.timeouts.size, 1);
      const timer = [...f.time.timeouts][0];
      const cap = Math.min(1000 * 2 ** attempt, 30000);
      assert.ok(timer.delay >= cap / 2, `Delay ${timer.delay} must remain above half of ${cap}`);
      assert.ok(timer.delay <= cap, `Delay ${timer.delay} must remain below ${cap}`);
      if (attempt === 0) firstDelays.push(timer.delay);
      f.time.fire(timer);
    }
    f.client.disconnect();
  }
  assert.equal(new Set(firstDelays).size, 3, 'Different random samples must spread reconnect attempts');
});

test('reconnect keeps one pending retry and disconnect cancels it', () => {
  const f = clientFixture();
  let connections = 0;
  f.client.connect = () => { connections++; };
  f.client._reconnect();
  const timer = [...f.time.timeouts][0];
  const attemptCount = f.client.reconnectAttempts;
  f.client._reconnect();
  assert.equal(f.time.timeouts.size, 1);
  assert.equal(f.client.reconnectAttempts, attemptCount);
  f.time.fire(timer);
  assert.equal(connections, 1);
  f.client._reconnect();
  const cancelled = [...f.time.timeouts][0];
  f.client.disconnect();
  assert.equal(f.time.timeouts.size, 0);
  cancelled.callback(); // A callback already queued when disconnect occurred stays harmless.
  assert.equal(connections, 1);
});

test('a WebSocket open does not reset backoff before successful tunnel assignment', () => {
  const f = clientFixture();
  f.client.reconnectAttempts = 4;
  f.client.connect();
  f.client.ws.open();
  assert.equal(f.client.reconnectAttempts, 4);
  f.client.ws.control({ type: MSG.TUNNEL_ASSIGNED, tunnelType: 'http', url: 'https://stream.example.test', subdomain: 'stream' });
  assert.equal(f.client.reconnectAttempts, 0);
  f.client.disconnect();
  assert.equal(f.time.timeouts.size, 0);
});

test('auth revocation, HTTP 401 and terminal setup errors still suppress reconnection', () => {
  for (const cause of ['revocation', 'HTTP 401', 'setup']) {
    const f = clientFixture();
    f.client.connect();
    f.client.ws.open();
    if (cause === 'revocation') f.client.ws.close(4001);
    else if (cause === 'HTTP 401') {
      f.client.ws.emit('error', new Error('Unexpected server response: 401'));
      f.client.ws.close();
    } else f.client.ws.control({ type: MSG.TUNNEL_ERROR, message: 'Host unavailable' });
    assert.equal(f.client.shouldReconnect, false);
    assert.equal(f.time.timeouts.size, 0);
    assert.equal(f.errors.length, 1);
  }
});
