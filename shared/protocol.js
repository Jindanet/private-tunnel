const crypto = require('node:crypto');
const PROTOCOL_VERSION = 1;

// Control message types
const MSG = {
  TUNNEL_OPEN: 'tunnel:open',
  TUNNEL_CHECK: 'tunnel:check',
  TUNNEL_CHECK_RESULT: 'tunnel:check-result',
  TUNNEL_ASSIGNED: 'tunnel:assigned',
  TUNNEL_ERROR: 'tunnel:error',
  TUNNEL_CLOSE: 'tunnel:close',
  REQUEST_START: 'request:start',
  RESPONSE_START: 'response:start',
  STREAM_END: 'stream:end',
  STREAM_ERROR: 'stream:error',
  TCP_CONNECT: 'tcp:connect',
  TCP_CLOSE: 'tcp:close',
  PING: 'ping',
  PONG: 'pong',
};

// Binary frame types
const FRAME_REQUEST_BODY = 0x01;
const FRAME_RESPONSE_BODY = 0x02;
const FRAME_TCP_DATA = 0x03;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

function generateRequestId() {
  return crypto.randomUUID();
}

function uuidToBytes(uuid) {
  if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(uuid)) throw new Error('Invalid request ID');
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 16) throw new Error('Invalid request ID bytes');
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeDataFrame(frameType, requestId, chunk) {
  if (![FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA].includes(frameType)) throw new Error('Invalid frame type');
  const header = Buffer.alloc(17);
  header[0] = frameType;
  uuidToBytes(requestId).copy(header, 1);
  return Buffer.concat([header, chunk]);
}

function decodeDataFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 17 || ![FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA].includes(buffer[0])) return null;
  return {
    frameType: buffer[0],
    requestId: bytesToUuid(buffer.slice(1, 17)),
    data: buffer.slice(17),
  };
}

function sendControl(ws, msg) {
  return sendBounded(ws, JSON.stringify(msg));
}

function sendData(ws, frameType, requestId, chunk) {
  try { return sendBounded(ws, encodeDataFrame(frameType, requestId, chunk)); } catch { return false; }
}

function sendBounded(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  if ((ws.bufferedAmount || 0) + Buffer.byteLength(payload) > MAX_BUFFERED_BYTES) {
    ws.terminate();
    return false;
  }
  try { ws.send(payload); return true; } catch { return false; }
}

function writeBounded(destination, chunk) {
  if (!destination || destination.destroyed) return false;
  if ((destination.writableLength || 0) + chunk.length > MAX_BUFFERED_BYTES) {
    destination.destroy();
    return false;
  }
  destination.write(chunk);
  return true;
}

module.exports = {
  PROTOCOL_VERSION,
  MSG,
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  FRAME_TCP_DATA,
  generateRequestId,
  uuidToBytes,
  bytesToUuid,
  encodeDataFrame,
  decodeDataFrame,
  sendControl,
  sendData,
  writeBounded,
  MAX_BUFFERED_BYTES,
};
