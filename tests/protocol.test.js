const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROTOCOL_VERSION, MSG, FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA,
  MAX_BUFFERED_BYTES, generateRequestId, uuidToBytes, bytesToUuid,
  encodeDataFrame, decodeDataFrame, sendControl, sendData, writeBounded,
} = require('../shared/protocol');

const requestId = 'aabbccdd-1234-4678-abcd-1234567890ef';

test('wire messages retain unique names and a declared protocol version', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MSG.TUNNEL_OPEN, 'tunnel:open');
  assert.equal(MSG.TUNNEL_ASSIGNED, 'tunnel:assigned');
  assert.equal(new Set(Object.values(MSG)).size, Object.keys(MSG).length);
});

test('all binary frame families preserve request identity and arbitrary payload bytes', () => {
  const payload = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f]);
  for (const frameType of [FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA]) {
    const encoded = encodeDataFrame(frameType, requestId, payload);
    assert.equal(encoded.length, 17 + payload.length);
    assert.deepEqual(decodeDataFrame(encoded), {frameType, requestId, data: payload});
    assert.deepEqual(decodeDataFrame(encodeDataFrame(frameType, requestId, Buffer.alloc(0))).data, Buffer.alloc(0));
  }
  const generated = generateRequestId();
  assert.equal(bytesToUuid(uuidToBytes(generated)), generated);
  assert.equal(bytesToUuid(uuidToBytes(requestId.toUpperCase())), requestId);
});

test('truncated, unknown and non-buffer frames fail closed', () => {
  for (let length = 0; length < 17; length++) assert.equal(decodeDataFrame(Buffer.alloc(length)), null);
  const unknown = Buffer.alloc(18); unknown[0] = 0xff;
  for (const input of [unknown, null, undefined, 'invalid', new Uint8Array(18)]) assert.equal(decodeDataFrame(input), null);
  for (const value of ['', 'not-an-id', 'aabbccdd12344678abcd1234567890ef', requestId + '00', null]) {
    assert.throws(() => uuidToBytes(value));
    assert.throws(() => encodeDataFrame(FRAME_REQUEST_BODY, value, Buffer.alloc(0)));
  }
  assert.throws(() => bytesToUuid(Buffer.alloc(15)));
  assert.throws(() => bytesToUuid(Buffer.alloc(17)));
  assert.throws(() => encodeDataFrame(0xff, requestId, Buffer.alloc(0)));
});

function socket(overrides = {}) {
  return {OPEN: 1, readyState: 1, bufferedAmount: 0, sent: [], terminated: false,
    send(payload) { this.sent.push(payload); }, terminate() { this.terminated = true; }, ...overrides};
}

test('control and data sends reject closed or congested connections', () => {
  const open = socket();
  assert.equal(sendControl(open, {type: MSG.PING}), true);
  assert.deepEqual(JSON.parse(open.sent[0]), {type: MSG.PING});
  assert.equal(sendData(open, FRAME_TCP_DATA, requestId, Buffer.from('data')), true);
  assert.equal(decodeDataFrame(open.sent[1]).requestId, requestId);
  const congested = socket({bufferedAmount: MAX_BUFFERED_BYTES});
  assert.equal(sendData(congested, FRAME_TCP_DATA, requestId, Buffer.from('more')), false);
  assert.equal(congested.terminated, true);
  assert.equal(congested.sent.length, 0);
  assert.equal(sendControl(socket({readyState: 3}), {type: MSG.PING}), false);
  assert.equal(sendControl(null, {type: MSG.PING}), false);
  assert.equal(sendControl(socket({send() { throw new Error('connection lost'); }}), {type: MSG.PING}), false);
  assert.equal(sendData(open, 255, requestId, Buffer.alloc(0)), false);
});

test('slow local sockets cannot accumulate an unlimited write buffer', () => {
  const destination = {destroyed: false, writableLength: MAX_BUFFERED_BYTES, writes: [],
    write(chunk) { this.writes.push(chunk); }, destroy() { this.destroyed = true; }};
  assert.equal(writeBounded(destination, Buffer.from('too much')), false);
  assert.equal(destination.destroyed, true);
  assert.equal(destination.writes.length, 0);
  assert.equal(writeBounded(destination, Buffer.from('closed')), false);
  assert.equal(writeBounded(null, Buffer.from('closed')), false);
  const healthy = {...destination, destroyed: false, writableLength: 0, writes: []};
  assert.equal(writeBounded(healthy, Buffer.from('ok')), true);
  assert.deepEqual(healthy.writes, [Buffer.from('ok')]);
});
