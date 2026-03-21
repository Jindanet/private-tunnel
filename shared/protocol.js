const crypto = require('node:crypto');

// Control message types
const MSG = {
  TUNNEL_OPEN: 'tunnel:open',
  TUNNEL_ASSIGNED: 'tunnel:assigned',
  TUNNEL_CLOSE: 'tunnel:close',
  REQUEST_START: 'request:start',
  RESPONSE_START: 'response:start',
  STREAM_END: 'stream:end',
  STREAM_ERROR: 'stream:error',
  PING: 'ping',
  PONG: 'pong',
};

// Binary frame types
const FRAME_REQUEST_BODY = 0x01;
const FRAME_RESPONSE_BODY = 0x02;

function generateRequestId() {
  return crypto.randomUUID();
}

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(buf) {
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function encodeDataFrame(frameType, requestId, chunk) {
  const header = Buffer.alloc(17);
  header[0] = frameType;
  uuidToBytes(requestId).copy(header, 1);
  return Buffer.concat([header, chunk]);
}

function decodeDataFrame(buffer) {
  return {
    frameType: buffer[0],
    requestId: bytesToUuid(buffer.slice(1, 17)),
    data: buffer.slice(17),
  };
}

function sendControl(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function sendData(ws, frameType, requestId, chunk) {
  ws.send(encodeDataFrame(frameType, requestId, chunk));
}

module.exports = {
  MSG,
  FRAME_REQUEST_BODY,
  FRAME_RESPONSE_BODY,
  generateRequestId,
  uuidToBytes,
  bytesToUuid,
  encodeDataFrame,
  decodeDataFrame,
  sendControl,
  sendData,
};
