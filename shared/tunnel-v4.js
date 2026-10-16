'use strict';

// The application control protocol remains v1. Only explicitly negotiated
// connections use this bounded, credit-controlled data transport.
const base = require('./protocol');

const DATA_TRANSPORT_VERSION = 4;
const TCP_END = 'tcp:end';
const WINDOW = 128 * 1024;
const CONNECTION_WINDOW = 1024 * 1024;
const MAX_FRAME_BYTES = 32 * 1024;
// Account for retained frame/token metadata as well as payload bytes. This also
// bounds the number of tiny frames a peer can leave awaiting destination writes.
const FRAME_CREDIT_OVERHEAD = 256;
const MAX_STREAM_QUEUE_BYTES = 512 * 1024;
const MAX_TOTAL_QUEUE_BYTES = 4 * 1024 * 1024;
const STREAM_QUEUE_SOFT_CHUNKS = 256;
const MAX_STREAM_QUEUE_CHUNKS = 1024;
const MAX_TOTAL_QUEUE_CHUNKS = 8192;
const MAX_RECORDS = 256;
const WS_HIGH_WATER = 256 * 1024;
const WS_HARD_LIMIT = 8 * 1024 * 1024;
const MAX_CONTROL_QUEUE_BYTES = 128 * 1024;
const MAX_FLUSH_BYTES = 256 * 1024;
const MAX_TOMBSTONES = 128;
const CREDIT = 0x44;
const FRAME_TOKEN = Symbol('v4 received frame');
const transports = new WeakMap();
const VALID_CONTROL_TYPES = new Set([...Object.values(base.MSG), TCP_END]);

function idOf(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

function current(ws) {
  return ws && transports.get(ws);
}

function open(state) {
  return !state.closed && state.ws.readyState === state.ws.OPEN;
}

function selectTransport(ws, version, { isServer = false } = {}) {
  if (version !== DATA_TRANSPORT_VERSION) throw new RangeError('Unsupported data transport version');
  if (!ws || typeof ws.send !== 'function') throw new TypeError('A WebSocket is required');
  const existing = current(ws);
  if (existing) {
    if (existing.closed) throw new Error('The selected transport has been disposed');
    if (existing.isServer !== Boolean(isServer)) throw new Error('Transport role cannot change');
    return existing;
  }
  const state = {
    ws, isServer: Boolean(isServer), closed: false,
    records: new Map(), tombstones: new Map(), ready: [], controls: [],
    queuedBytes: 0, queuedChunks: 0, controlQueuedBytes: 0,
    // Outstanding counters use credit units (payload + per-frame overhead).
    // Cumulative payload counters below keep traffic accounting in raw bytes.
    sentOutstandingBytes: 0, receivedOutstandingBytes: 0,
    sentPayloadBytes: 0, receivedPayloadBytes: 0,
    pausedSources: new Set(), immediate: null, timer: null,
  };
  state.onClose = () => disposeState(state);
  state.onError = () => disposeState(state);
  if (typeof ws.on === 'function') {
    ws.on('close', state.onClose);
    ws.on('error', state.onError);
  }
  transports.set(ws, state);
  return state;
}

function getTransportVersion(ws) {
  return current(ws) ? DATA_TRANSPORT_VERSION : base.PROTOCOL_VERSION;
}

function fail(state) {
  if (state.closed) return false;
  try { state.ws.terminate(); } catch { try { state.ws.close(1002, 'Invalid v4 transport'); } catch {} }
  disposeState(state);
  return false;
}

function rawSend(state, payload) {
  if (!open(state)) { disposeState(state); return false; }
  if ((state.ws.bufferedAmount || 0) + Buffer.byteLength(payload) > WS_HARD_LIMIT) return fail(state);
  try {
    state.ws.send(payload, { compress: false }, (error) => { if (error) fail(state); });
    return !state.closed;
  } catch { return fail(state); }
}

function findRecord(state, id) {
  return state.records.get(id) || state.tombstones.get(id);
}

function makeRecord(state, id, kind, locallyOpened) {
  if (!id || findRecord(state, id)) return null;
  while (state.records.size + state.tombstones.size >= MAX_RECORDS && state.tombstones.size) {
    state.tombstones.delete(state.tombstones.keys().next().value);
  }
  if (state.records.size >= MAX_RECORDS) return null;
  const record = {
    id, idBytes: base.uuidToBytes(id), kind, locallyOpened,
    startedOnWire: !locallyOpened, localEnded: false, localEndSent: false,
    remoteEnded: false, reset: false, tombstone: false,
    queue: [], queuedBytes: 0, sentOutstanding: 0, receivedOutstanding: 0,
    controlPending: 0, ready: false, sources: new Set(), tokens: new Set(), sinks: new Map(),
  };
  state.records.set(id, record);
  return record;
}

function expectedType(state, record, outgoing) {
  if (record.kind === 'tcp') return base.FRAME_TCP_DATA;
  return state.isServer === outgoing ? base.FRAME_REQUEST_BODY : base.FRAME_RESPONSE_BODY;
}

function retire(state, record) {
  if (state.closed || record.tombstone || record.queuedBytes || record.sentOutstanding
    || record.receivedOutstanding || record.controlPending) return;
  if (!record.reset && !(record.localEndSent && record.remoteEnded)) return;
  state.records.delete(record.id);
  record.tombstone = true;
  record.sources.clear();
  state.tombstones.set(record.id, record);
  while (state.tombstones.size > MAX_TOMBSTONES) {
    state.tombstones.delete(state.tombstones.keys().next().value);
  }
  syncSources(state);
}

function controlReady(entry) {
  return !entry.afterData || entry.record.queuedBytes === 0;
}

function sentControl(state, entry) {
  if (!entry.record) return;
  entry.record.controlPending--;
  if (entry.kind === 'start') entry.record.startedOnWire = true;
  if (entry.kind === 'end') entry.record.localEndSent = true;
  ready(state, entry.record);
  retire(state, entry.record);
}

function queueControl(state, payload, record = null, kind = 'control', afterData = false) {
  const bytes = Buffer.byteLength(payload);
  if (!open(state)) return false;
  if (bytes > MAX_CONTROL_QUEUE_BYTES || state.controlQueuedBytes + bytes > MAX_CONTROL_QUEUE_BYTES) return fail(state);
  const entry = { payload, bytes, record, kind, afterData };
  if (record) record.controlPending++;
  if (!state.controls.length && controlReady(entry) && (state.ws.bufferedAmount || 0) < WS_HIGH_WATER) {
    if (!rawSend(state, payload)) return false;
    sentControl(state, entry);
    return true;
  }
  state.controls.push(entry);
  state.controlQueuedBytes += bytes;
  schedule(state);
  syncSources(state);
  return true;
}

function eligible(state, record) {
  return !record.reset && !record.tombstone && record.startedOnWire && record.queuedBytes > 0
    && WINDOW - record.sentOutstanding > FRAME_CREDIT_OVERHEAD
    && CONNECTION_WINDOW - state.sentOutstandingBytes > FRAME_CREDIT_OVERHEAD;
}

function ready(state, record) {
  if (!record.ready && eligible(state, record)) {
    record.ready = true;
    state.ready.push(record);
  }
}

function hasWork(state) {
  return state.controls.some(controlReady) || state.ready.some((record) => eligible(state, record));
}

function schedule(state) {
  if (state.closed || state.immediate || state.timer || !hasWork(state)) return;
  state.immediate = setImmediate(() => flush(state));
  state.immediate.unref?.();
}

function pollDrain(state) {
  if (state.closed || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.closed) return;
    if (!open(state)) return disposeState(state);
    if ((state.ws.bufferedAmount || 0) > WS_HARD_LIMIT) return fail(state);
    syncSources(state);
    // Wait through the low-water mark as well: a source paused by WebSocket
    // pressure may have no queued data left to trigger another flush.
    if ((state.ws.bufferedAmount || 0) >= WS_HIGH_WATER / 2) pollDrain(state);
    else schedule(state);
  }, 5);
  state.timer.unref?.();
}

function take(state, record, size) {
  const parts = [];
  let remaining = size;
  while (remaining) {
    const head = record.queue[0];
    const length = Math.min(head.length, remaining);
    parts.push(head.subarray(0, length));
    if (length === head.length) { record.queue.shift(); state.queuedChunks--; }
    else record.queue[0] = head.subarray(length);
    remaining -= length;
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
}

function flush(state) {
  state.immediate = null;
  if (state.closed) return;
  if (!open(state)) return disposeState(state);
  if ((state.ws.bufferedAmount || 0) > WS_HARD_LIMIT) return fail(state);
  if ((state.ws.bufferedAmount || 0) >= WS_HIGH_WATER) {
    syncSources(state);
    return pollDrain(state);
  }
  let budget = MAX_FLUSH_BYTES;
  // A blocked stream end must not prevent credits and other streams' headers.
  let controls = state.controls.length;
  while (controls-- > 0 && budget > 0 && !state.closed) {
    const entry = state.controls.shift();
    if (!controlReady(entry)) { state.controls.push(entry); continue; }
    state.controlQueuedBytes -= entry.bytes;
    if (!rawSend(state, entry.payload)) return;
    budget -= entry.bytes;
    sentControl(state, entry);
    if ((state.ws.bufferedAmount || 0) >= WS_HIGH_WATER) break;
  }
  // Each visit sends at most one frame, then moves the stream to the back.
  while (state.ready.length && budget > 0 && !state.closed
    && (state.ws.bufferedAmount || 0) < WS_HIGH_WATER) {
    const record = state.ready.shift();
    record.ready = false;
    if (!eligible(state, record)) continue;
    const length = Math.min(MAX_FRAME_BYTES, record.queuedBytes,
      WINDOW - record.sentOutstanding - FRAME_CREDIT_OVERHEAD,
      CONNECTION_WINDOW - state.sentOutstandingBytes - FRAME_CREDIT_OVERHEAD);
    const chunk = take(state, record, length);
    record.queuedBytes -= length;
    state.queuedBytes -= length;
    const frame = Buffer.allocUnsafe(17 + length);
    frame[0] = 0x40 | expectedType(state, record, true);
    record.idBytes.copy(frame, 1);
    chunk.copy(frame, 17);
    // Account before send: a synchronous test peer can acknowledge immediately.
    const credit = length + FRAME_CREDIT_OVERHEAD;
    record.sentOutstanding += credit;
    state.sentOutstandingBytes += credit;
    state.sentPayloadBytes += length;
    if (!rawSend(state, frame)) return;
    budget -= frame.length;
    ready(state, record);
  }
  syncSources(state);
  if ((state.ws.bufferedAmount || 0) >= WS_HIGH_WATER) pollDrain(state);
  else schedule(state);
}

function syncSources(state) {
  if (state.closed) return;
  const desired = new Map();
  const buffered = state.ws.bufferedAmount || 0;
  for (const record of state.records.values()) {
    if (record.reset || record.localEndSent) continue;
    for (const source of record.sources) {
      const owned = state.pausedSources.has(source);
      const blocked = record.queuedBytes >= (owned ? WINDOW / 2 : WINDOW)
        || record.queue.length >= (owned ? STREAM_QUEUE_SOFT_CHUNKS / 2 : STREAM_QUEUE_SOFT_CHUNKS)
        || WINDOW - record.sentOutstanding <= FRAME_CREDIT_OVERHEAD
        || CONNECTION_WINDOW - state.sentOutstandingBytes <= FRAME_CREDIT_OVERHEAD
        || state.queuedBytes >= CONNECTION_WINDOW || buffered >= (owned ? WS_HIGH_WATER / 2 : WS_HIGH_WATER);
      desired.set(source, desired.get(source) || blocked);
    }
  }
  for (const [source, blocked] of desired) {
    if (!source || source.destroyed) continue;
    if (blocked && !state.pausedSources.has(source) && typeof source.pause === 'function') {
      try {
        if (typeof source.isPaused !== 'function' || !source.isPaused()) {
          source.pause();
          state.pausedSources.add(source);
        }
      } catch {}
    }
  }
  for (const source of [...state.pausedSources]) {
    if (desired.get(source)) continue;
    state.pausedSources.delete(source);
    try { if (!source.destroyed && typeof source.resume === 'function') source.resume(); } catch {}
  }
}

function dropControls(state, record) {
  state.controls = state.controls.filter((entry) => {
    if (entry.record !== record || entry.kind === 'credit') return true;
    state.controlQueuedBytes -= entry.bytes;
    record.controlPending--;
    return false;
  });
}

function releaseToken(token) {
  if (token.done || token.state.closed) return;
  token.done = true;
  const { state, record, credit: units } = token;
  record.tokens.delete(token);
  if (token.sink) {
    token.sink.tokens.delete(token);
    if (!token.sink.tokens.size) detachSink(record, token.sink);
  }
  record.receivedOutstanding -= units;
  state.receivedOutstandingBytes -= units;
  const credit = Buffer.allocUnsafe(21);
  credit[0] = CREDIT;
  record.idBytes.copy(credit, 1);
  credit.writeUInt32BE(units, 17);
  queueControl(state, credit, record, 'credit');
  retire(state, record);
}

function cancel(state, record, notify = false) {
  if (!record || record.reset || state.closed) return;
  record.reset = true;
  record.localEnded = record.remoteEnded = true;
  state.queuedBytes -= record.queuedBytes;
  state.queuedChunks -= record.queue.length;
  record.queuedBytes = 0;
  record.queue = [];
  record.ready = false;
  state.ready = state.ready.filter((entry) => entry !== record);
  dropControls(state, record);
  for (const token of [...record.tokens]) releaseToken(token);
  if (notify && (record.startedOnWire || !record.locallyOpened)) {
    const msg = record.kind === 'tcp'
      ? { type: base.MSG.TCP_CLOSE, connId: record.id }
      : { type: base.MSG.STREAM_ERROR, requestId: record.id, message: 'Tunnel stream cancelled' };
    queueControl(state, JSON.stringify(msg), record);
  }
  syncSources(state);
  retire(state, record);
  schedule(state);
}

function observeControl(state, msg, outgoing) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !VALID_CONTROL_TYPES.has(msg.type)) return null;
  const type = msg.type;
  if (type === base.MSG.REQUEST_START || type === base.MSG.TCP_CONNECT) {
    if (state.isServer !== outgoing) return null;
    const id = idOf(type === base.MSG.TCP_CONNECT ? msg.connId : msg.requestId);
    const record = makeRecord(state, id, type === base.MSG.TCP_CONNECT ? 'tcp' : 'http', outgoing);
    return record ? { record, kind: 'start' } : null;
  }
  const isTcp = type === base.MSG.TCP_CLOSE || type === TCP_END;
  if (![base.MSG.RESPONSE_START, base.MSG.STREAM_END, base.MSG.STREAM_ERROR, base.MSG.TCP_CLOSE, TCP_END].includes(type)) return {};
  const id = idOf(isTcp ? msg.connId : msg.requestId);
  if (!id) return null;
  const record = findRecord(state, id);
  // Cancellation and duplicate terminal messages can cross in flight.
  if (!record) return type === base.MSG.RESPONSE_START ? null : { ignored: true };
  if (record.kind !== (isTcp ? 'tcp' : 'http')) return null;
  if (type === base.MSG.STREAM_ERROR || type === base.MSG.TCP_CLOSE) {
    cancel(state, record);
    return { record, kind: 'reset' };
  }
  if (record.reset || record.tombstone) return { ignored: true };
  if (type === base.MSG.RESPONSE_START) {
    if (state.isServer === outgoing) return null;
    return { record };
  }
  if (type === base.MSG.STREAM_END) {
    const requestDirection = state.isServer === outgoing;
    if (requestDirection ? msg.direction !== 'request' : (msg.direction !== undefined && msg.direction !== 'response')) return null;
  }
  if (outgoing) {
    if (record.localEnded) return { ignored: true };
    record.localEnded = true;
    return { record, kind: 'end', afterData: true };
  }
  record.remoteEnded = true;
  retire(state, record);
  return { record, kind: 'end' };
}

function receiveControl(ws, msg) {
  const state = current(ws);
  if (!state) return true;
  if (state.closed) return false;
  let payload;
  try { payload = JSON.stringify(msg); } catch { return fail(state); }
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_CONTROL_QUEUE_BYTES) return fail(state);
  return observeControl(state, msg, false) !== null || fail(state);
}

function sendControl(ws, msg) {
  const state = current(ws);
  if (!state) return base.sendControl(ws, msg);
  if (state.closed) return false;
  let payload;
  try { payload = JSON.stringify(msg); } catch { return false; }
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_CONTROL_QUEUE_BYTES) return false;
  const observed = observeControl(state, msg, true);
  if (!observed) return false;
  if (observed.ignored) return true;
  return queueControl(state, payload, observed.record, observed.kind, observed.afterData);
}

function sendData(ws, frameType, requestId, chunk, source) {
  const state = current(ws);
  if (!state) return base.sendData(ws, frameType, requestId, chunk);
  const id = idOf(requestId);
  const record = id && state.records.get(id);
  if (!open(state) || !record || record.reset || record.localEnded
    || frameType !== expectedType(state, record, true) || !Buffer.isBuffer(chunk)) return false;
  if (chunk.length > MAX_STREAM_QUEUE_BYTES - record.queuedBytes
    || chunk.length > MAX_TOTAL_QUEUE_BYTES - state.queuedBytes
    || (chunk.length && (record.queue.length >= MAX_STREAM_QUEUE_CHUNKS || state.queuedChunks >= MAX_TOTAL_QUEUE_CHUNKS))) {
    cancel(state, record, true);
    return false;
  }
  if (chunk.length) {
    // One application readable produces each stream direction. Do not retain
    // arbitrary source objects passed with empty or repeated writes.
    if (source && !record.sources.size) record.sources.add(source);
    record.queue.push(chunk);
    record.queuedBytes += chunk.length;
    state.queuedBytes += chunk.length;
    state.queuedChunks++;
    ready(state, record);
    schedule(state);
  }
  syncSources(state);
  return true;
}

function decodeDataFrame(data, ws) {
  const state = current(ws);
  if (!state) return base.decodeDataFrame(data);
  if (state.closed) return null;
  if (!Buffer.isBuffer(data) || data.length < 17) { fail(state); return null; }
  const type = data[0];
  const id = base.bytesToUuid(data.subarray(1, 17));
  const record = findRecord(state, id);
  if (type === CREDIT) {
    if (data.length !== 21 || !record) { fail(state); return null; }
    const bytes = data.readUInt32BE(17);
    if (!bytes || bytes > record.sentOutstanding || bytes > state.sentOutstandingBytes) { fail(state); return null; }
    record.sentOutstanding -= bytes;
    state.sentOutstandingBytes -= bytes;
    for (const candidate of state.records.values()) ready(state, candidate);
    syncSources(state);
    retire(state, record);
    schedule(state);
    return null;
  }
  const frameType = type - 0x40;
  const bytes = data.length - 17;
  const credit = bytes + FRAME_CREDIT_OVERHEAD;
  if (type < 0x41 || type > 0x43 || !record || !bytes || bytes > MAX_FRAME_BYTES
    || frameType !== expectedType(state, record, false)
    || (!record.reset && record.remoteEnded)
    || credit > WINDOW - record.receivedOutstanding
    || credit > CONNECTION_WINDOW - state.receivedOutstandingBytes) {
    fail(state);
    return null;
  }
  record.receivedOutstanding += credit;
  state.receivedOutstandingBytes += credit;
  state.receivedPayloadBytes += bytes;
  const token = { state, record, credit, done: false, sink: null };
  record.tokens.add(token);
  if (record.reset) { releaseToken(token); return null; }
  const frame = { frameType, requestId: id, data: data.subarray(17) };
  Object.defineProperty(frame, FRAME_TOKEN, { value: token });
  return frame;
}

function detachSink(record, sink) {
  record.sinks.delete(sink.destination);
  if (typeof sink.destination.removeListener === 'function') {
    sink.destination.removeListener('error', sink.onFailure);
    sink.destination.removeListener('close', sink.onFailure);
  }
}

function attachSink(state, record, destination, token) {
  let sink = record.sinks.get(destination);
  if (!sink) {
    sink = { destination, tokens: new Set(), onFailure: () => cancel(state, record, true) };
    record.sinks.set(destination, sink);
    if (typeof destination.on === 'function') {
      destination.on('error', sink.onFailure);
      destination.on('close', sink.onFailure);
    }
  }
  token.sink = sink;
  sink.tokens.add(token);
}

function writeFrame(ws, frame, destination) {
  const state = current(ws);
  if (!state) return base.writeBounded(destination, frame.data);
  if (state.closed) return false;
  const token = frame && frame[FRAME_TOKEN];
  if (!token || token.state !== state || token.done || token.record.reset) return false;
  if (!destination || destination.destroyed || typeof destination.write !== 'function') {
    releaseToken(token);
    cancel(state, token.record, true);
    return false;
  }
  attachSink(state, token.record, destination, token);
  try {
    destination.write(frame.data, (error) => {
      if (state.closed || token.done) return;
      if (error) cancel(state, token.record, true);
      else releaseToken(token);
    });
    return true;
  } catch {
    cancel(state, token.record, true);
    return false;
  }
}

function discardFrame(ws, frame) {
  const state = current(ws);
  const token = frame && frame[FRAME_TOKEN];
  if (state && token && token.state === state) releaseToken(token);
}

function cancelStream(ws, requestId) {
  const state = current(ws);
  const id = idOf(requestId);
  if (state && id) cancel(state, findRecord(state, id), true);
}

function disposeState(state) {
  if (state.closed) return;
  state.closed = true;
  if (state.immediate) clearImmediate(state.immediate);
  if (state.timer) clearTimeout(state.timer);
  state.immediate = state.timer = null;
  if (typeof state.ws.removeListener === 'function') {
    state.ws.removeListener('close', state.onClose);
    state.ws.removeListener('error', state.onError);
  }
  for (const record of [...state.records.values(), ...state.tombstones.values()]) {
    record.queue = [];
    for (const token of record.tokens) token.done = true;
    record.tokens.clear();
    for (const sink of [...record.sinks.values()]) detachSink(record, sink);
    record.sources.clear();
  }
  state.records.clear();
  state.tombstones.clear();
  state.ready = [];
  state.controls = [];
  state.queuedBytes = state.queuedChunks = state.controlQueuedBytes = 0;
  state.sentOutstandingBytes = state.receivedOutstandingBytes = 0;
  for (const source of state.pausedSources) {
    try { if (!source.destroyed && typeof source.resume === 'function') source.resume(); } catch {}
  }
  state.pausedSources.clear();
}

function disposeTransport(ws) {
  const state = ws && transports.get(ws);
  if (state) disposeState(state);
}

function getTransportStats(ws) {
  const state = ws && transports.get(ws);
  if (!state) return { version: base.PROTOCOL_VERSION, streams: 0, activeStreams: 0, tombstones: 0, queuedBytes: 0, queuedChunks: 0,
    controlQueuedBytes: 0, sentOutstandingBytes: 0, receivedOutstandingBytes: 0, pausedSources: 0,
    sentPayloadBytes: 0, receivedPayloadBytes: 0, scheduled: false, drainTimer: false, closed: false };
  return {
    version: DATA_TRANSPORT_VERSION, streams: state.records.size + state.tombstones.size,
    activeStreams: [...state.records.values()].filter((record) => !record.reset).length,
    tombstones: state.tombstones.size, queuedBytes: state.queuedBytes, queuedChunks: state.queuedChunks,
    controlQueuedBytes: state.controlQueuedBytes,
    sentOutstandingBytes: state.sentOutstandingBytes, receivedOutstandingBytes: state.receivedOutstandingBytes,
    sentPayloadBytes: state.sentPayloadBytes, receivedPayloadBytes: state.receivedPayloadBytes,
    pausedSources: state.pausedSources.size, scheduled: Boolean(state.immediate), drainTimer: Boolean(state.timer),
    closed: state.closed,
  };
}

module.exports = {
  ...base, DATA_TRANSPORT_VERSION, TCP_END, WINDOW, CONNECTION_WINDOW,
  MAX_FRAME_BYTES, FRAME_CREDIT_OVERHEAD, MAX_STREAM_QUEUE_BYTES, MAX_TOTAL_QUEUE_BYTES,
  STREAM_QUEUE_SOFT_CHUNKS, MAX_STREAM_QUEUE_CHUNKS, MAX_TOTAL_QUEUE_CHUNKS, MAX_RECORDS,
  WS_HIGH_WATER, WS_HARD_LIMIT, MAX_CONTROL_QUEUE_BYTES,
  selectTransport, getTransportVersion, receiveControl, decodeDataFrame, writeFrame, discardFrame,
  sendData, sendControl, cancelStream, disposeTransport, getTransportStats,
};
