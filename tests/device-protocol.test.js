'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TYPE, packet, decode, hello } = require('../shared/device-protocol');
test('device wire matches the C++ golden frame and rejects malformed envelopes', () => {
  const golden = Buffer.from([6, 0, 0x12, 0x34, 0, 2, 0, 0, 2, 0]);
  assert.deepEqual(packet(TYPE.CREDIT, 0x1234, Buffer.from([2, 0])), golden);
  assert.deepEqual(decode(golden), { type: 6, stream: 0x1234, payload: Buffer.from([2, 0]) });
  for (let n = 0; n < 8; ++n) assert.throws(() => decode(golden.subarray(0, n)));
  for (const index of [0, 1, 4, 5, 6, 7]) {
    const bad = Buffer.from(golden);bad[index] = 255;assert.throws(() => decode(bad));
  }
  assert.throws(() => packet(TYPE.DATA, 1, Buffer.alloc(513)));
  assert.equal(decode(packet(TYPE.DATA, 1, Buffer.alloc(512))).payload.length, 512);
  const h = Buffer.from([1, 2, 0, 1, 2, 0, 1, 0, 0, 0, 97]);
  assert.equal(hello(h).clientId, 'a');
  for (const index of [0, 1, 2, 3, 4, 5, 6]) { const bad = Buffer.from(h);bad[index] = 255;assert.throws(() => hello(bad)); }
  assert.throws(() => hello(Buffer.concat([h, Buffer.from([0])])));
});
