'use strict';
const { EventEmitter } = require('node:events');
const base = require('../shared/protocol');
const wire = require('../shared/device-protocol');
const { TYPE: T, MAX_FRAME, WINDOW, MAX_BODY, packet, decode, hello } = wire;
const bridges = new WeakSet();

// A server-created adapter, never a capability asserted by remote JSON. Reuses
// the manager's route ownership, persistence, logging and disconnect handling.
class DeviceBridge extends EventEmitter {
  constructor(socket, manager, ip, accessKeys) {
    super();
    if (socket.tunnelPrincipal?.clientType !== 'device') throw new Error('Authenticated device key required');
    bridges.add(this);
    this.socket = socket; this.OPEN = 1; this.readyState = 1;
    this.tunnelPrincipal = socket.tunnelPrincipal;
    this.streams = new Map(); this.nextStream = 1; this.started = false;
    this.deadline = setTimeout(() => this.close(1002, 'Device HELLO timeout'), 10000);
    this.deadline.unref?.();
    this.accessKeys = accessKeys;
    socket.on('message', (data, binary) => {
      try {
        if (!binary) throw new Error('Binary device frames required');
        const frame = decode(data);
        if (!this.started) {
          if (frame.type !== T.HELLO || frame.stream) throw new Error('Device HELLO required');
          const info = hello(frame.payload);
          this.started = true;
          clearTimeout(this.deadline);
          manager.handleNewClient(this, ip);
          this.inject({ type: base.MSG.TUNNEL_OPEN, protocolVersion: 1, dataTransportVersions: [1],
            tunnelType: 'http', clientId: info.clientId, publishDomain: info.domain || undefined,
            desiredSubdomain: info.subdomain || undefined, hostname: info.board, os: 'PrivateTunnel Device v1', localPort: 0 });
        } else this.receive(frame);
      } catch { this.close(1002, 'Invalid device protocol'); }
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  get bufferedAmount() { return this.socket.bufferedAmount || 0; }
  finish() {
    if (this.readyState === 3) return;
    this.readyState = 3; clearTimeout(this.deadline); this.streams.clear(); this.emit('close');
  }
  close(code = 1000, reason = '') { this.finish(); this.socket.close(code, reason); }
  terminate() { this.finish(); this.socket.terminate(); }
  inject(msg) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  transmit(type, stream = 0, payload = Buffer.alloc(0)) {
    if (this.readyState !== this.OPEN) return;
    const data = packet(type, stream, payload);
    if (this.bufferedAmount + data.length > 16384) { this.terminate(); return; }
    this.socket.send(data, { compress: false }, (error) => { if (error) this.terminate(); });
  }
  authorizeVisitor(req) {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (header.startsWith('Basic ') && header.length < 256) {
      const text = Buffer.from(header.slice(6), 'base64').toString('utf8');
      if (text.startsWith('device:')) token = text.slice(7);
    }
    return this.accessKeys.authorizeVisitor(this.tunnelPrincipal.id, token);
  }
  send(data) {
    if (Buffer.isBuffer(data)) {
      const f = base.decodeDataFrame(data);
      const s = f && this.streams.get(f.requestId);
      if (!s || f.frameType !== base.FRAME_REQUEST_BODY || s.ended) throw new Error('Invalid device request');
      s.bodyBytes += f.data.length;
      if (s.bodyBytes > MAX_BODY) throw new Error('Device body limit exceeded');
      // At most one 1 KiB request is retained, regardless of visitor chunking.
      s.queue = Buffer.concat([s.queue, f.data]);
      this.pump(s);
      return;
    }
    const msg = JSON.parse(data);
    switch (msg.type) {
      case base.MSG.TUNNEL_ASSIGNED: {
        const url = Buffer.from(msg.url || '');
        if (url.length > 384) throw new Error('Device URL too long');
        const p = Buffer.alloc(9 + url.length);
        p.writeUInt16BE(MAX_FRAME); p[2] = 1; p.writeUInt16BE(WINDOW, 3);
        p.writeUInt16BE(MAX_BODY, 5); p.writeUInt16BE(url.length, 7); url.copy(p, 9);
        this.transmit(T.READY, 0, p); break;
      }
      case base.MSG.TUNNEL_ERROR:
        this.transmit(T.ERROR, 0, Buffer.from('Tunnel could not be opened; check device settings and server logs.'));
        this.close(1008, 'Device tunnel rejected'); break;
      case base.MSG.PING: this.transmit(T.PING); break;
      case base.MSG.REQUEST_START: {
        if (this.streams.size >= 1 || this.nextStream > 65535) { this.close(1012, 'Reconnect device'); return; }
        const method = Buffer.from(msg.method), path = Buffer.from(msg.path);
        const contentType = Buffer.from(msg.headers['content-type'] || '');
        if (method.length > 8 || path.length > 192 || contentType.length > 64) throw new Error('Device metadata limit');
        const p = Buffer.alloc(4 + method.length + path.length + contentType.length);
        p[0] = method.length; p.writeUInt16BE(path.length, 1); p[3] = contentType.length;
        Buffer.concat([method, path, contentType]).copy(p, 4);
        const s = { id: this.nextStream++, requestId: msg.requestId, queue: Buffer.alloc(0),
          txCredit: WINDOW, rxCredit: WINDOW, bodyBytes: 0, ended: false, endSent: false, response: false };
        this.streams.set(msg.requestId, s); this.transmit(T.OPEN, s.id, p); break;
      }
      case base.MSG.STREAM_END: {
        const s = this.streams.get(msg.requestId);
        if (s) { s.ended = true; this.pump(s); } break;
      }
      case base.MSG.STREAM_ERROR: {
        const s = this.streams.get(msg.requestId);
        if (s) { this.transmit(T.CANCEL, s.id); this.streams.delete(msg.requestId); } break;
      }
    }
  }
  pump(s) {
    while (s.queue.length && s.txCredit && this.readyState === this.OPEN) {
      const n = Math.min(MAX_FRAME, s.txCredit, s.queue.length);
      this.transmit(T.DATA, s.id, s.queue.subarray(0, n));
      s.queue = s.queue.subarray(n); s.txCredit -= n;
    }
    if (s.ended && !s.queue.length && !s.endSent) { s.endSent = true; this.transmit(T.END, s.id); }
  }
  receive({ type, stream, payload: p }) {
    if (!stream) {
      if (p.length || ![T.PING, T.PONG].includes(type)) throw new Error('Invalid device connection frame');
      if (type === T.PING) this.transmit(T.PONG);
      else this.inject({ type: base.MSG.PONG });
      return;
    }
    const s = [...this.streams.values()].find((record) => record.id === stream);
    // A cancelled stream may still have frames in flight, but future IDs are invalid.
    if (!s) { if (stream >= this.nextStream) throw new Error('Unknown device stream'); return; }
    if (type === T.CREDIT) {
      if (p.length !== 2) throw new Error('Invalid credit');
      const n = p.readUInt16BE();
      if (!n || s.txCredit + n > WINDOW) throw new Error('Excess device credit');
      s.txCredit += n; this.pump(s);
    } else if (type === T.RESPONSE) {
      if (!s.endSent || s.response || p.length < 3 || p[2] > 64 || p.length !== 3 + p[2]) throw new Error('Invalid response');
      const statusCode = p.readUInt16BE();
      if (statusCode < 200 || statusCode > 599) throw new Error('Invalid status');
      s.response = true;
      this.inject({ type: base.MSG.RESPONSE_START, requestId: s.requestId,
        statusCode, headers: { 'content-type': p.subarray(3).toString('utf8') || 'application/octet-stream',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } else if (type === T.DATA) {
      if (!s.response || !p.length || p.length > s.rxCredit) throw new Error('Device receive window exceeded');
      s.rxCredit -= p.length;
      this.emit('message', base.encodeDataFrame(base.FRAME_RESPONSE_BODY, s.requestId, p), true);
    } else if (type === T.END) {
      if (!s.response || p.length) throw new Error('Invalid response end');
      this.inject({ type: base.MSG.STREAM_END, requestId: s.requestId, direction: 'response' });
      this.streams.delete(s.requestId);
    } else if (type === T.CANCEL) {
      if (p.length) throw new Error('Invalid cancellation');
      this.inject({ type: base.MSG.STREAM_ERROR, requestId: s.requestId, message: 'Device cancelled request' });
      this.streams.delete(s.requestId);
    } else throw new Error('Unexpected device frame');
  }
  writeDeviceResponse(frame, destination) {
    const s = this.streams.get(frame.requestId);
    if (!s || destination.destroyed || (destination.writableLength || 0) > WINDOW) return false;
    destination.write(frame.data, (error) => {
      if (error || this.streams.get(frame.requestId) !== s || this.readyState !== this.OPEN) return;
      s.rxCredit += frame.data.length;
      const p = Buffer.alloc(2); p.writeUInt16BE(frame.data.length); this.transmit(T.CREDIT, s.id, p);
    });
    return true;
  }
}
module.exports = { DeviceBridge, isDeviceBridge: (ws) => bridges.has(ws) };
