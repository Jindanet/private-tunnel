'use strict';

// Device wire v1 is deliberately independent of the desktop v4 transport.
const SUBPROTOCOL = 'ptunnel.device.v1';
const MAX_FRAME = 512;
const WINDOW = 512;
const MAX_BODY = 1024;
const TYPE = Object.freeze({ HELLO: 1, READY: 2, OPEN: 3, DATA: 4, END: 5,
  CREDIT: 6, CANCEL: 7, ERROR: 8, PING: 9, PONG: 10, RESPONSE: 11 });
function packet(type, stream = 0, payload = Buffer.alloc(0)) {
  if (!Object.values(TYPE).includes(type) || !Number.isInteger(stream) || stream < 0 || stream > 65535
    || payload.length > MAX_FRAME) throw new Error('Invalid device packet');
  const out = Buffer.alloc(8 + payload.length);
  out[0] = type; out.writeUInt16BE(stream, 2); out.writeUInt16BE(payload.length, 4);
  payload.copy(out, 8);
  return out;
}
function decode(data) {
  if (!Buffer.isBuffer(data) || data.length < 8 || data.length > MAX_FRAME + 8
    || data[1] || data.readUInt16BE(6) || data.readUInt16BE(4) !== data.length - 8
    || !Object.values(TYPE).includes(data[0])) throw new Error('Invalid device frame');
  return { type: data[0], stream: data.readUInt16BE(2), payload: data.subarray(8) };
}
function hello(payload) {
  if (payload.length < 10 || payload[0] !== 1 || payload.readUInt16BE(1) !== MAX_FRAME
    || payload[3] !== 1 || payload.readUInt16BE(4) !== WINDOW) throw new Error('Unsupported device capabilities');
  const limits = [48, 253, 63, 24];
  let at = 10;
  const values = limits.map((limit, i) => {
    const n = payload[6 + i];
    if (n > limit || at + n > payload.length) throw new Error('Invalid device identity');
    const value = payload.subarray(at, at += n).toString('utf8');
    if (!/^[\x21-\x7e]*$/.test(value)) throw new Error('Invalid device identity');
    return value;
  });
  if (at !== payload.length || !values[0]) throw new Error('Invalid device identity');
  return { clientId: values[0], domain: values[1], subdomain: values[2], board: values[3] };
}
module.exports = { SUBPROTOCOL, MAX_FRAME, WINDOW, MAX_BODY, TYPE, packet, decode, hello };
