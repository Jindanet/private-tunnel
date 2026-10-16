const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const base = require('../shared/protocol');
const protocol = require('../shared/tunnel-v4');

const {
  MSG, FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA,
  WINDOW, CONNECTION_WINDOW, MAX_FRAME_BYTES, MAX_STREAM_QUEUE_BYTES,
  MAX_TOTAL_QUEUE_BYTES, MAX_RECORDS, WS_HIGH_WATER, FRAME_CREDIT_OVERHEAD,
  STREAM_QUEUE_SOFT_CHUNKS, MAX_STREAM_QUEUE_CHUNKS, MAX_TOTAL_QUEUE_CHUNKS,
  MAX_CONTROL_QUEUE_BYTES,
} = protocol;

const id = (number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }
async function eventually(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(predicate(), message);
}

// Delivery happens asynchronously, with WebSocket message boundaries and FIFO order.
// This lets credit frames take the same receive path as ordinary binary messages.
class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
    this.terminated = false;
  }
  send(payload, options, callback) {
    if (this.readyState !== this.OPEN) throw new Error('WebSocket is closed');
    const data = Buffer.isBuffer(payload) ? Buffer.from(payload) : String(payload);
    this.sent.push(data);
    const done = typeof options === 'function' ? options : callback;
    queueMicrotask(() => {
      if (this.peer?.readyState === this.peer.OPEN) {
        this.peer.emit('message', Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data), Buffer.isBuffer(data));
      }
      if (typeof done === 'function') done();
    });
  }
  terminate() { this.terminated = true; this.close(); }
  close() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}

class Destination extends EventEmitter {
  constructor({ hold = false } = {}) {
    super();
    this.hold = hold;
    this.destroyed = false;
    this.writableLength = 0;
    this.writes = [];
    this.callbacks = [];
  }
  write(chunk, callback) {
    assert.equal(this.destroyed, false);
    this.writes.push(Buffer.from(chunk));
    this.writableLength += chunk.length;
    const complete = () => {
      this.writableLength -= chunk.length;
      if (typeof callback === 'function') callback();
      if (!this.writableLength) this.emit('drain');
    };
    if (this.hold) this.callbacks.push(complete);
    else queueMicrotask(complete);
    return !this.hold;
  }
  releaseOne() { this.callbacks.shift()?.(); }
  releaseAll() { for (const callback of this.callbacks.splice(0)) callback(); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

function readable() {
  const source = new EventEmitter();
  Object.assign(source, { destroyed: false, paused: false, pauses: 0, resumes: 0 });
  source.pause = () => { source.paused = true; source.pauses++; return source; };
  source.resume = () => { source.paused = false; source.resumes++; return source; };
  source.isPaused = () => source.paused;
  return source;
}

function pair(t, { selected = true, clientDestination, serverDestination } = {}) {
  const server = new FakeWebSocket();
  const client = new FakeWebSocket();
  server.peer = client;
  client.peer = server;
  for (const [ws, isServer, destination] of [[server, true, serverDestination], [client, false, clientDestination]]) {
    ws.frames = [];
    ws.controls = [];
    ws.events = [];
    ws.destination = destination || new Destination();
    ws.on('message', (data, binary) => {
      if (binary) {
        const frame = protocol.decodeDataFrame(data, ws);
        if (frame) {
          ws.frames.push(frame);
          ws.events.push({ kind: 'data', requestId: frame.requestId, bytes: frame.data.length });
          const target = typeof ws.destination === 'function' ? ws.destination(frame) : ws.destination;
          if (target) protocol.writeFrame(ws, frame, target);
        }
      } else {
        const control = JSON.parse(data.toString());
        ws.controls.push(control);
        ws.events.push({ kind: 'control', ...control });
        protocol.receiveControl(ws, control);
      }
    });
    if (selected) protocol.selectTransport(ws, 4, { isServer });
  }
  t.after(() => {
    protocol.disposeTransport(server);
    protocol.disposeTransport(client);
    server.close();
    client.close();
  });
  return { server, client };
}

async function startTcp(server, client, streamId) {
  assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: streamId }), true);
  await eventually(() => client.controls.some((message) => message.type === MSG.TCP_CONNECT && message.connId === streamId), 'TCP start reaches the peer');
}

function dataSent(ws, streamId) {
  return ws.sent.filter((data) => Buffer.isBuffer(data) && data[0] >= 0x41 && data[0] <= 0x43 && base.bytesToUuid(data.subarray(1, 17)) === streamId);
}

function rawFrame(type, streamId, payload) {
  return Buffer.concat([Buffer.from([type]), base.uuidToBytes(streamId), payload]);
}

function receivedUnits(ws, streamId) {
  return ws.frames.filter((frame) => !streamId || frame.requestId === streamId)
    .reduce((sum, frame) => sum + frame.data.length + FRAME_CREDIT_OVERHEAD, 0);
}

function payloadForWindow(window) {
  let remaining = window;
  let bytes = 0;
  while (remaining > FRAME_CREDIT_OVERHEAD) {
    const length = Math.min(MAX_FRAME_BYTES, remaining - FRAME_CREDIT_OVERHEAD);
    bytes += length;
    remaining -= length + FRAME_CREDIT_OVERHEAD;
  }
  return bytes;
}

test('legacy connections retain v1 control and data bytes; selecting v4 is explicit and idempotent', async (t) => {
  const { server, client } = pair(t, { selected: false });
  const streamId = id(1);
  const payload = Buffer.from([0, 255, 128, 10, 65]);
  assert.equal(protocol.PROTOCOL_VERSION, 1);
  assert.equal(protocol.DATA_TRANSPORT_VERSION, 4);
  assert.equal(protocol.getTransportVersion(server), 1);
  assert.equal(protocol.sendControl(server, { type: MSG.PING }), true);
  assert.equal(server.sent[0], JSON.stringify({ type: MSG.PING }));
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, payload), true);
  assert.deepEqual(server.sent[1], base.encodeDataFrame(FRAME_TCP_DATA, streamId, payload));
  assert.deepEqual(protocol.decodeDataFrame(server.sent[1], client), base.decodeDataFrame(server.sent[1]));
  await settle();
  const state = protocol.selectTransport(server, 4, { isServer: true });
  assert.equal(protocol.selectTransport(server, 4, { isServer: true }), state);
  assert.equal(protocol.getTransportVersion(server), 4);
  assert.throws(() => protocol.selectTransport(new FakeWebSocket(), 99), RangeError);
  assert.equal(base.PROTOCOL_VERSION, 1);
});

test('v4 splits arbitrary HTTP and TCP bytes into bounded frames in both directions', async (t) => {
  const { server, client } = pair(t);
  const httpId = id(2);
  assert.equal(protocol.sendControl(server, { type: MSG.REQUEST_START, requestId: httpId, method: 'POST', path: '/' }), true);
  await settle();
  const request = randomBytes(MAX_FRAME_BYTES * 3 + 19);
  const response = randomBytes(MAX_FRAME_BYTES + 1);
  assert.equal(protocol.sendData(server, FRAME_REQUEST_BODY, httpId, request), true);
  assert.equal(protocol.sendData(client, FRAME_RESPONSE_BODY, httpId, response), true);
  await eventually(() => Buffer.concat(client.frames.map((frame) => frame.data)).length === request.length && Buffer.concat(server.frames.map((frame) => frame.data)).length === response.length, 'HTTP request and response bytes arrive');
  assert.deepEqual(Buffer.concat(client.frames.map((frame) => frame.data)), request);
  assert.deepEqual(Buffer.concat(server.frames.map((frame) => frame.data)), response);
  assert.ok(client.frames.every((frame) => frame.frameType === FRAME_REQUEST_BODY && frame.requestId === httpId));
  assert.ok(server.frames.every((frame) => frame.frameType === FRAME_RESPONSE_BODY && frame.requestId === httpId));

  const tcpId = id(3);
  await startTcp(server, client, tcpId);
  const forward = randomBytes(MAX_FRAME_BYTES * 2 + 7);
  const reverse = randomBytes(MAX_FRAME_BYTES + 11);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, tcpId, forward), true);
  assert.equal(protocol.sendData(client, FRAME_TCP_DATA, tcpId, reverse), true);
  await eventually(() => client.frames.filter((frame) => frame.requestId === tcpId).reduce((sum, frame) => sum + frame.data.length, 0) === forward.length && server.frames.filter((frame) => frame.requestId === tcpId).reduce((sum, frame) => sum + frame.data.length, 0) === reverse.length, 'TCP preserves bytes in both directions');
  assert.deepEqual(Buffer.concat(client.frames.filter((frame) => frame.requestId === tcpId).map((frame) => frame.data)), forward);
  assert.deepEqual(Buffer.concat(server.frames.filter((frame) => frame.requestId === tcpId).map((frame) => frame.data)), reverse);
  for (const ws of [server, client]) {
    for (const data of ws.sent.filter((data) => Buffer.isBuffer(data) && data[0] >= 0x41 && data[0] <= 0x43)) {
      assert.ok(data.length <= MAX_FRAME_BYTES + 17);
      assert.equal(base.decodeDataFrame(data), null, 'v4 data cannot be mistaken for a legacy frame');
    }
    assert.equal(ws.terminated, false);
  }
});

test('a destination write callback controls credit while another stream continues', async (t) => {
  const slowId = id(4);
  const fastId = id(5);
  const slow = new Destination({ hold: true });
  const fast = new Destination();
  const { server, client } = pair(t, { clientDestination: (frame) => frame.requestId === slowId ? slow : fast });
  await startTcp(server, client, slowId);
  await startTcp(server, client, fastId);
  const source = readable();
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, slowId, Buffer.alloc(WINDOW + MAX_FRAME_BYTES, 0x61), source), true);
  await eventually(() => receivedUnits(client, slowId) === WINDOW && source.paused, 'slow writes exhaust only this stream window and pause its source');
  assert.equal(dataSent(server, slowId).reduce((sum, frame) => sum + frame.length - 17, 0), payloadForWindow(WINDOW));
  assert.equal(client.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 0x44).length, 0, 'write(false) does not return credit before its callback');
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, fastId, Buffer.from('fast stream')), true);
  await eventually(() => fast.writes.length > 0, 'an unrelated stream makes progress while slow callbacks are held');
  assert.deepEqual(Buffer.concat(fast.writes), Buffer.from('fast stream'));
  slow.releaseAll();
  await eventually(() => slow.writes.reduce((sum, chunk) => sum + chunk.length, 0) === WINDOW + MAX_FRAME_BYTES, 'consumed credit releases the remaining queued bytes');
  await eventually(() => source.resumes > 0, 'source resumes after its queued bytes drain');
  assert.equal(server.terminated, false);
  slow.releaseAll();
});

test('connection credit bounds aggregate writes across otherwise independent streams', async (t) => {
  const sink = new Destination({ hold: true });
  const { server, client } = pair(t, { clientDestination: sink });
  const count = Math.floor(CONNECTION_WINDOW / WINDOW) + 1;
  for (let index = 0; index < count; index++) {
    const streamId = id(20 + index);
    await startTcp(server, client, streamId);
    assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.alloc(WINDOW, index)), true);
  }
  await eventually(() => receivedUnits(client) === CONNECTION_WINDOW, 'the connection permits exactly its aggregate receive window including frame metadata');
  await settle();
  assert.equal(receivedUnits(client), CONNECTION_WINDOW);
  const bytesBeforeCredit = sink.writes.reduce((sum, chunk) => sum + chunk.length, 0);
  const stats = protocol.getTransportStats(server);
  assert.equal(stats.sentOutstandingBytes, CONNECTION_WINDOW);
  assert.ok(stats.queuedBytes > 0);
  sink.releaseOne();
  await eventually(() => sink.writes.reduce((sum, chunk) => sum + chunk.length, 0) > bytesBeforeCredit, 'returning connection credit permits more data');
  assert.equal(client.terminated, false);
  sink.releaseAll();
});

test('discarding an admitted frame returns its credit exactly once', async (t) => {
  const { server, client } = pair(t, { clientDestination: () => null });
  const streamId = id(39);
  await startTcp(server, client, streamId);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.alloc(WINDOW + MAX_FRAME_BYTES)), true);
  await eventually(() => receivedUnits(client) === WINDOW, 'discard test reaches its window limit');
  const frame = client.frames[0];
  protocol.discardFrame(client, frame);
  await eventually(() => client.frames.reduce((sum, received) => sum + received.data.length, 0) > payloadForWindow(WINDOW), 'discard releases more queued data');
  const credits = client.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 0x44).length;
  assert.equal(client.sent.find((data) => Buffer.isBuffer(data) && data[0] === 0x44).readUInt32BE(17), frame.data.length + FRAME_CREDIT_OVERHEAD);
  protocol.discardFrame(client, frame);
  await settle();
  assert.equal(client.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 0x44).length, credits);
  assert.equal(server.terminated, false);
  for (const received of client.frames) protocol.discardFrame(client, received);
  await eventually(() => client.frames.reduce((sum, received) => sum + received.data.length, 0) === WINDOW + MAX_FRAME_BYTES, 'discarded frames release the full queued tail');
  for (const received of client.frames) protocol.discardFrame(client, received);
});

test('oversized chunks are rejected before enqueue and do not poison other streams', async (t) => {
  const { server, client } = pair(t);
  const rejectedId = id(40);
  const healthyId = id(41);
  await startTcp(server, client, rejectedId);
  await startTcp(server, client, healthyId);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, rejectedId, Buffer.alloc(MAX_STREAM_QUEUE_BYTES + 1)), false);
  assert.equal(protocol.getTransportStats(server).queuedBytes, 0);
  assert.equal(dataSent(server, rejectedId).length, 0);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, healthyId, Buffer.from('still live')), true);
  await eventually(() => client.frames.some((frame) => frame.requestId === healthyId), 'rejecting a large chunk preserves the other stream');
  assert.equal(server.terminated, false);
});

test('per-stream and connection queue bounds apply while the WebSocket is congested', async (t) => {
  const { server } = pair(t);
  server.bufferedAmount = WS_HIGH_WATER + 1;
  const streamId = id(50);
  assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: streamId }), true);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.alloc(MAX_STREAM_QUEUE_BYTES)), true);
  assert.equal(protocol.getTransportStats(server).queuedBytes, MAX_STREAM_QUEUE_BYTES);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from([1])), false);
  assert.equal(protocol.getTransportStats(server).queuedBytes, 0, 'reset releases the rejected stream queue');
  assert.equal(dataSent(server, streamId).length, 0);
  const count = Math.floor(MAX_TOTAL_QUEUE_BYTES / MAX_STREAM_QUEUE_BYTES);
  for (let index = 0; index < count; index++) {
    const nextId = id(60 + index);
    assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: nextId }), true);
    assert.equal(protocol.sendData(server, FRAME_TCP_DATA, nextId, Buffer.alloc(MAX_STREAM_QUEUE_BYTES)), true);
  }
  assert.equal(protocol.getTransportStats(server).queuedBytes, MAX_TOTAL_QUEUE_BYTES);
  const overflowId = id(80);
  assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: overflowId }), true);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, overflowId, Buffer.from([1])), false);
  assert.equal(protocol.getTransportStats(server).queuedBytes, MAX_TOTAL_QUEUE_BYTES);
  assert.equal(dataSent(server, overflowId).length, 0);
  assert.equal(server.terminated, false);
});

test('stream record admission is bounded independently of queued bytes', async (t) => {
  const { server } = pair(t);
  server.bufferedAmount = WS_HIGH_WATER + 1;
  for (let index = 0; index < MAX_RECORDS; index++) {
    assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: id(1000 + index) }), true);
  }
  assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: id(2000) }), false);
  assert.ok(protocol.getTransportStats(server).streams <= MAX_RECORDS);
  assert.equal(protocol.getTransportStats(server).queuedBytes, 0);
});

test('tiny queued chunks have soft source pressure and hard metadata budgets', async (t) => {
  const { server } = pair(t);
  server.bufferedAmount = WS_HIGH_WATER + 1;
  const source = readable();
  const streamId = id(81);
  assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: streamId }), true);
  // Register the source before introducing WebSocket pressure, so this pause
  // specifically checks the queue-count threshold rather than its byte size.
  server.bufferedAmount = 0;
  for (let index = 0; index < STREAM_QUEUE_SOFT_CHUNKS; index++) {
    assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from([1]), source), true);
  }
  assert.equal(source.paused, true);
  assert.equal(protocol.getTransportStats(server).queuedBytes, STREAM_QUEUE_SOFT_CHUNKS);
  server.bufferedAmount = WS_HIGH_WATER + 1;
  for (let index = STREAM_QUEUE_SOFT_CHUNKS; index < MAX_STREAM_QUEUE_CHUNKS; index++) {
    assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from([1]), source), true);
  }
  assert.equal(protocol.getTransportStats(server).queuedChunks, MAX_STREAM_QUEUE_CHUNKS);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from([1]), source), false);
  assert.equal(protocol.getTransportStats(server).queuedChunks, 0);
  assert.equal(protocol.getTransportStats(server).queuedBytes, 0);
  const count = Math.floor(MAX_TOTAL_QUEUE_CHUNKS / MAX_STREAM_QUEUE_CHUNKS);
  for (let index = 0; index < count; index++) {
    const nextId = id(3000 + index);
    assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: nextId }), true);
    for (let chunk = 0; chunk < MAX_STREAM_QUEUE_CHUNKS; chunk++) {
      assert.equal(protocol.sendData(server, FRAME_TCP_DATA, nextId, Buffer.from([1])), true);
    }
  }
  assert.equal(protocol.getTransportStats(server).queuedChunks, MAX_TOTAL_QUEUE_CHUNKS);
  assert.equal(protocol.getTransportStats(server).queuedBytes, MAX_TOTAL_QUEUE_CHUNKS);
  const overflowId = id(4000);
  assert.equal(protocol.sendControl(server, { type: MSG.TCP_CONNECT, connId: overflowId }), true);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, overflowId, Buffer.from([1])), false);
  assert.equal(protocol.getTransportStats(server).queuedChunks, MAX_TOTAL_QUEUE_CHUNKS);
  assert.equal(server.terminated, false);
});

test('one-byte incoming frames consume metadata credit instead of creating unbounded write tokens', async (t) => {
  const { server, client } = pair(t);
  const streamId = id(82);
  await startTcp(server, client, streamId);
  const frame = rawFrame(0x43, streamId, Buffer.from([1]));
  const count = Math.floor(WINDOW / (1 + FRAME_CREDIT_OVERHEAD));
  for (let index = 0; index < count; index++) {
    const received = protocol.decodeDataFrame(frame, client);
    assert.equal(received?.data.length, 1);
  }
  assert.equal(protocol.getTransportStats(client).receivedOutstandingBytes, count * (1 + FRAME_CREDIT_OVERHEAD));
  assert.equal(client.terminated, false);
  assert.equal(protocol.decodeDataFrame(frame, client), null);
  assert.equal(client.terminated, true);
});

test('a source paused by WebSocket pressure resumes after the low-water mark without queued work', async (t) => {
  const { server, client } = pair(t);
  const streamId = id(83);
  await startTcp(server, client, streamId);
  const originalSend = server.send.bind(server);
  server.send = (payload, ...args) => {
    originalSend(payload, ...args);
    if (Buffer.isBuffer(payload) && payload[0] === 0x43) server.bufferedAmount = WS_HIGH_WATER;
  };
  const source = readable();
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from('data'), source), true);
  await eventually(() => source.paused && protocol.getTransportStats(server).queuedBytes === 0 && protocol.getTransportStats(server).drainTimer, 'last DATA leaves a paused source with an active drain poll');
  server.bufferedAmount = 200 * 1024;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(source.paused, true);
  assert.equal(protocol.getTransportStats(server).drainTimer, true, 'poll remains active through the hysteresis range');
  server.bufferedAmount = 0;
  await eventually(() => !source.paused && !protocol.getTransportStats(server).drainTimer && !protocol.getTransportStats(server).scheduled, 'source resumes below low water and polling finishes');
  assert.deepEqual(Buffer.concat(client.frames.map((frame) => frame.data)), Buffer.from('data'));
});

test('invalid v4 frames terminate the connection instead of mutating flow credit', async (t) => {
  const malformed = [
    ['truncated data header', () => Buffer.alloc(16, 0x43)],
    ['unknown frame family', (streamId) => rawFrame(0x49, streamId, Buffer.from([1]))],
    ['oversized data payload', (streamId) => rawFrame(0x43, streamId, Buffer.alloc(MAX_FRAME_BYTES + 1))],
    ['unknown stream', () => rawFrame(0x43, id(9999), Buffer.from([1]))],
    ['truncated credit', (streamId) => rawFrame(0x44, streamId, Buffer.alloc(3))],
    ['credit for unsent bytes', (streamId) => rawFrame(0x44, streamId, Buffer.from([0, 0, 0, 1]))],
    ['credit with trailing bytes', (streamId) => rawFrame(0x44, streamId, Buffer.alloc(5))],
  ];
  for (const [name, encode] of malformed) {
    await t.test(name, async (t) => {
      const { server, client } = pair(t);
      const streamId = id(90);
      await startTcp(server, client, streamId);
      assert.equal(protocol.decodeDataFrame(encode(streamId), server), null);
      assert.equal(server.terminated, true);
      assert.equal(server.frames.length, 0);
    });
  }
});

test('HTTP frame direction is tied to the endpoint role and stream kind', async (t) => {
  const { server, client } = pair(t);
  const streamId = id(91);
  protocol.sendControl(server, { type: MSG.REQUEST_START, requestId: streamId, method: 'POST', path: '/' });
  await settle();
  assert.equal(protocol.decodeDataFrame(rawFrame(0x41, streamId, Buffer.from('wrong direction')), server), null);
  assert.equal(server.terminated, true);
  assert.equal(client.terminated, false);
});

test('selected transports reject oversized, unknown, and invalid-role inbound controls', async (t) => {
  const cases = [
    ['oversized JSON control', { type: MSG.PING, padding: 'x'.repeat(MAX_CONTROL_QUEUE_BYTES) }],
    ['unknown control type', { type: 'unexpected:message' }],
    ['client-originated stream start', { type: MSG.TCP_CONNECT, connId: id(98) }],
  ];
  for (const [name, control] of cases) {
    await t.test(name, (t) => {
      const { server } = pair(t);
      assert.equal(protocol.receiveControl(server, control), false);
      assert.equal(server.terminated, true);
      assert.equal(protocol.getTransportStats(server).queuedBytes, 0);
    });
  }
});

for (const kind of ['TCP', 'HTTP']) {
  test(`${kind} EOF stays behind final DATA while stream credit is exhausted`, async (t) => {
    const sink = new Destination({ hold: true });
    const { server, client } = pair(t, { clientDestination: sink });
    const streamId = id(kind === 'TCP' ? 92 : 93);
    if (kind === 'TCP') await startTcp(server, client, streamId);
    else {
      protocol.sendControl(server, { type: MSG.REQUEST_START, requestId: streamId, method: 'POST', path: '/' });
      await settle();
    }
    const frameType = kind === 'TCP' ? FRAME_TCP_DATA : FRAME_REQUEST_BODY;
    const end = kind === 'TCP'
      ? { type: protocol.TCP_END, connId: streamId }
      : { type: MSG.STREAM_END, requestId: streamId, direction: 'request' };
    const payload = randomBytes(WINDOW + MAX_FRAME_BYTES);
    assert.equal(protocol.sendData(server, frameType, streamId, payload), true);
    assert.equal(protocol.sendControl(server, end), true);
    await eventually(() => receivedUnits(client) === WINDOW, 'DATA waits at the exhausted window');
    assert.equal(client.controls.some((message) => message.type === end.type), false);
    sink.releaseAll();
    await eventually(() => client.controls.some((message) => message.type === end.type), 'EOF follows the final released DATA');
    assert.deepEqual(Buffer.concat(sink.writes), payload);
    const endIndex = client.events.findIndex((event) => event.kind === 'control' && event.type === end.type);
    const finalDataIndex = client.events.findLastIndex((event) => event.kind === 'data' && event.requestId === streamId);
    assert.ok(finalDataIndex >= 0 && finalDataIndex < endIndex);
    sink.releaseAll();
  });
}

test('cancelled streams release queues and tolerate late write callbacks without reanimation', async (t) => {
  const sink = new Destination({ hold: true });
  const { server, client } = pair(t, { clientDestination: sink });
  const streamId = id(94);
  await startTcp(server, client, streamId);
  const source = readable();
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.alloc(WINDOW + MAX_FRAME_BYTES), source), true);
  await eventually(() => receivedUnits(client) === WINDOW && source.paused, 'stream has both outstanding and queued bytes');
  protocol.cancelStream(server, streamId);
  assert.equal(protocol.getTransportStats(server).queuedBytes, 0);
  assert.equal(protocol.getTransportStats(server).pausedSources, 0);
  const sentBeforeCallbacks = dataSent(server, streamId).length;
  sink.releaseAll();
  await settle();
  assert.equal(dataSent(server, streamId).length, sentBeforeCallbacks);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from('late')), false);
  assert.equal(server.terminated, false);
  const healthyId = id(95);
  await startTcp(server, client, healthyId);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, healthyId, Buffer.from('healthy')), true);
  await eventually(() => client.frames.some((frame) => frame.requestId === healthyId), 'other streams survive cancellation');
});

test('WebSocket close disposes paused sources and suppresses late write credit', async (t) => {
  const sink = new Destination({ hold: true });
  const { server, client } = pair(t, { clientDestination: sink });
  const streamId = id(96);
  await startTcp(server, client, streamId);
  const source = readable();
  protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.alloc(WINDOW + MAX_FRAME_BYTES), source);
  await eventually(() => receivedUnits(client) === WINDOW && source.paused, 'stream is paused before closing');
  server.close();
  client.close();
  const resumesAfterClose = source.resumes;
  const clientSendCount = client.sent.length;
  const serverDataCount = dataSent(server, streamId).length;
  sink.releaseAll();
  await settle();
  assert.equal(client.sent.length, clientSendCount, 'late write callbacks do not send credit on a closed transport');
  assert.equal(dataSent(server, streamId).length, serverDataCount);
  assert.equal(source.resumes, resumesAfterClose, 'late callbacks do not resume a disposed source');
  const stats = protocol.getTransportStats(server);
  assert.equal(stats.queuedBytes, 0);
  assert.equal(stats.pausedSources, 0);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from('late')), false);
});

test('explicitly disposed v4 wrappers fail closed even while the WebSocket remains open', async (t) => {
  const { server, client } = pair(t);
  const streamId = id(97);
  await startTcp(server, client, streamId);
  protocol.disposeTransport(server);
  const sendCount = server.sent.length;
  const destination = new Destination();
  const legacyFrame = base.decodeDataFrame(base.encodeDataFrame(FRAME_TCP_DATA, streamId, Buffer.from('legacy')));
  assert.equal(server.readyState, server.OPEN);
  assert.equal(protocol.getTransportVersion(server), 4);
  assert.equal(protocol.sendData(server, FRAME_TCP_DATA, streamId, Buffer.from('late')), false);
  assert.equal(protocol.sendControl(server, { type: MSG.PING }), false);
  assert.equal(protocol.receiveControl(server, { type: MSG.PING }), false);
  assert.equal(protocol.decodeDataFrame(base.encodeDataFrame(FRAME_TCP_DATA, streamId, Buffer.from('late')), server), null);
  assert.equal(protocol.writeFrame(server, legacyFrame, destination), false);
  assert.throws(() => protocol.selectTransport(server, 4, { isServer: true }));
  protocol.discardFrame(server, legacyFrame);
  protocol.cancelStream(server, streamId);
  await settle();
  assert.equal(server.sent.length, sendCount);
  assert.equal(destination.writes.length, 0);
  assert.equal(protocol.getTransportStats(server).closed, true);
  assert.equal(protocol.getTransportStats(server).scheduled, false);
  assert.equal(protocol.getTransportStats(server).drainTimer, false);
});

test('sequential HTTP requests exceed the active-record limit without a lifetime admission cap', { timeout: 10000 }, async (t) => {
  const { server, client } = pair(t);
  const requests = [];
  const responses = [];
  async function deliverControl(from, to, message) {
    let listener;
    let timeout;
    let waiting = true;
    const keepLoopAlive = () => { if (waiting) setImmediate(keepLoopAlive); };
    const received = new Promise((resolve, reject) => {
      listener = (data, binary) => {
        if (binary) return;
        const control = JSON.parse(data.toString());
        if (control.type !== message.type || control.requestId !== message.requestId) return;
        resolve();
      };
      to.on('message', listener);
      // Real WebSockets keep the loop active; these fake peers need a referenced
      // turn while the transport's unref'ed flush is pending.
      timeout = setTimeout(() => reject(new Error(`Control receipt timed out: ${message.type}`)), 2000);
    });
    try {
      assert.equal(protocol.sendControl(from, message), true);
      setImmediate(keepLoopAlive);
      await received;
    } finally {
      waiting = false;
      clearTimeout(timeout);
      to.removeListener('message', listener);
    }
  }
  const count = MAX_RECORDS + 64;
  for (let index = 0; index < count; index++) {
    const streamId = id(5000 + index);
    await deliverControl(server, client, { type: MSG.REQUEST_START, requestId: streamId, method: 'POST', path: `/${index}` });
    const request = Buffer.from(`request-${index}\0`);
    requests.push(request);
    assert.equal(protocol.sendData(server, FRAME_REQUEST_BODY, streamId, request), true);
    await deliverControl(server, client, { type: MSG.STREAM_END, requestId: streamId, direction: 'request' });
    await deliverControl(client, server, { type: MSG.RESPONSE_START, requestId: streamId, statusCode: 200, headers: {} });
    const response = Buffer.from(`response-${index}\xff`, 'latin1');
    responses.push(response);
    assert.equal(protocol.sendData(client, FRAME_RESPONSE_BODY, streamId, response), true);
    await deliverControl(client, server, { type: MSG.STREAM_END, requestId: streamId });
    await tick();
    for (const ws of [server, client]) {
      const stats = protocol.getTransportStats(ws);
      assert.equal(stats.activeStreams, 0, `request ${index} retires after both EOFs and credits`);
      assert.ok(stats.streams <= MAX_RECORDS);
      assert.ok(stats.tombstones <= MAX_RECORDS);
      assert.equal(stats.closed, false);
      assert.equal(ws.terminated, false);
    }
  }
  assert.equal(client.frames.length, count);
  assert.equal(server.frames.length, count);
  assert.deepEqual(Buffer.concat(client.frames.map((frame) => frame.data)), Buffer.concat(requests));
  assert.deepEqual(Buffer.concat(server.frames.map((frame) => frame.data)), Buffer.concat(responses));
});
