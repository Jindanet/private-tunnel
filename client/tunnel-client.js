const WebSocket = require('ws');
const net = require('node:net');
const os = require('node:os');
const { MSG, PROTOCOL_VERSION, FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA, decodeDataFrame, sendControl, sendData, writeBounded } = require('../shared/protocol');
const { createForwardRequest } = require('./local-forwarder');
const { normalizeServerWebSocketUrl } = require('./server-url');

class TunnelClient {
  constructor(options) {
    this.serverUrl = normalizeServerWebSocketUrl(options.serverUrl);
    this.token = options.token || null;
    this.localHost = options.localHost || 'localhost';
    this.localPort = options.localPort;
    this.clientId = options.clientId || null;
    this.tunnelType = options.tunnelType || 'http';
    this.publishDomain = options.publishDomain || '';
    this.publishMode = options.publishMode === 'root' ? 'root' : 'subdomain';
    this.desiredSubdomain = String(options.desiredSubdomain || '').trim().toLowerCase();
    this.ws = null;
    this.subdomain = null;
    this.url = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.shouldReconnect = true;

    // Callbacks
    this.onConnected = options.onConnected || (() => {});
    this.onDisconnected = options.onDisconnected || (() => {});
    this.onRequest = options.onRequest || (() => {});
    this.onError = options.onError || (() => {});

    // HTTP: requestId -> active local request/response stream state
    this.requestStreams = new Map();

    // TCP: connId -> net.Socket
    this.tcpSockets = new Map();
  }

  connect() {
    const url = new URL(this.serverUrl);
    url.searchParams.delete('token');
    this.ws = new WebSocket(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024,
    });

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;

      // Request a tunnel
      sendControl(this.ws, {
        type: MSG.TUNNEL_OPEN,
        protocolVersion: PROTOCOL_VERSION,
        tunnelType: this.tunnelType,
        localPort: this.localPort,
        clientId: this.clientId,
        publishDomain: this.publishDomain || null,
        publishMode: this.publishMode,
        desiredSubdomain: this.desiredSubdomain || null,
        hostname: os.hostname(),
        os: `${os.platform()} ${os.release()} (${os.arch()})`,
      });
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this._handleBinaryFrame(data);
      } else {
        try {
          const msg = JSON.parse(data.toString());
          this._handleControlMessage(msg);
        } catch (e) {
          this.onError(e);
        }
      }
    });

    this.ws.on('close', (code) => {
      this.connected = false;
      this._clearRequestStreams(new Error('Tunnel WebSocket closed'));
      this._clearTcpSockets();
      if (code === 4001) {
        // Unauthorized — wrong or missing token, don't reconnect
        this.shouldReconnect = false;
        this.onError(Object.assign(new Error('Unauthorized: invalid or missing token'), { code: 'EUNAUTHORIZED' }));
        return;
      }
      if (this.shouldReconnect) {
        this.onDisconnected();
        this._reconnect();
      }
    });

    this.ws.on('error', (err) => {
      if (err.message && /Unexpected server response: 401/.test(err.message)) {
        this.shouldReconnect = false;
        err.code = 'EUNAUTHORIZED';
      }
      this.onError(err);
    });
  }

  _handleControlMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    switch (msg.type) {
      case MSG.TUNNEL_ASSIGNED:
        this.subdomain = msg.subdomain;
        this.url = msg.url;
        this.onConnected({
          subdomain: msg.subdomain,
          publicHost: msg.publicHost || '',
          publishDomain: msg.publishDomain || this.publishDomain || '',
          publishMode: msg.publishMode || this.publishMode,
          url: msg.url,
          tunnelType: msg.tunnelType,
        });
        break;

      case MSG.TUNNEL_ERROR:
        this.shouldReconnect = false;
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          this.ws.close();
        }
        this.onError(Object.assign(new Error(msg.message || 'Tunnel setup failed'), { code: 'ETUNNELSETUP' }));
        break;

      case MSG.TCP_CONNECT:
        this._handleTcpConnect(msg.connId);
        break;

      case MSG.TCP_CLOSE:
        this._handleTcpClose(msg.connId);
        break;

      case MSG.REQUEST_START:
        this._handleRequestStart(msg);
        break;

      case MSG.STREAM_END:
        if (msg.direction === 'request') {
          this._handleRequestEnd(msg.requestId);
        }
        break;

      case MSG.STREAM_ERROR:
        this._abortRequestStream(msg.requestId, msg.message || 'Request cancelled by server');
        break;

      case MSG.PING:
        sendControl(this.ws, { type: MSG.PONG });
        break;
    }
  }

  _handleBinaryFrame(data) {
    const frame = decodeDataFrame(data);
    if (!frame) return;

    if (frame.frameType === FRAME_REQUEST_BODY) {
      const stream = this.requestStreams.get(frame.requestId);
      if (stream && stream.localReq && !stream.localReq.destroyed) {
        writeBounded(stream.localReq, frame.data);
      }
    } else if (frame.frameType === FRAME_TCP_DATA) {
      const sock = this.tcpSockets.get(frame.requestId);
      if (sock && !sock.destroyed) {
        writeBounded(sock, frame.data);
      }
    }
  }

  _handleTcpConnect(connId) {
    if (typeof connId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(connId)) return;
    if (this.tcpSockets.has(connId) || this.tcpSockets.size >= 128) return;
    const sock = net.createConnection({ host: this.localHost, port: this.localPort });
    sock.setTimeout(300000, () => sock.destroy());
    this.tcpSockets.set(connId, sock);
    this.onRequest({ method: 'TCP', path: `→ localhost:${this.localPort}`, statusCode: 0, latency: 0 });

    sock.on('data', (chunk) => {
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        sendData(this.ws, FRAME_TCP_DATA, connId, chunk);
      }
    });

    sock.on('close', () => {
      this.tcpSockets.delete(connId);
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        sendControl(this.ws, { type: MSG.TCP_CLOSE, connId });
      }
    });

    sock.on('connect', () => {
      this.onRequest({ method: 'TCP', path: `connected → localhost:${this.localPort}`, statusCode: 200, latency: 0 });
    });

    sock.on('error', (err) => {
      this.tcpSockets.delete(connId);
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        sendControl(this.ws, { type: MSG.TCP_CLOSE, connId });
      }
    });
  }

  _handleTcpClose(connId) {
    const sock = this.tcpSockets.get(connId);
    if (sock) {
      sock.destroy();
      this.tcpSockets.delete(connId);
    }
  }

  _handleRequestStart(msg) {
    const { requestId, method, path, headers } = msg;
    if (typeof requestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId)) return;
    if (this.requestStreams.has(requestId) || this.requestStreams.size >= 128) {
      sendControl(this.ws, { type: MSG.STREAM_ERROR, requestId, message: 'Too many active requests.' });
      return;
    }
    const forward = createForwardRequest(
      this.localHost,
      this.localPort,
      method,
      path,
      headers
    );

    const stream = {
      requestId,
      method,
      path,
      startedAt: Date.now(),
      localReq: forward.localReq,
      abort: forward.abort,
      reported: false,
    };

    this.requestStreams.set(requestId, stream);
    this._wireLocalResponse(stream, forward.responsePromise);
  }

  _handleRequestEnd(requestId) {
    const stream = this.requestStreams.get(requestId);
    if (stream && stream.localReq && !stream.localReq.destroyed) {
      stream.localReq.end();
    }
  }

  _wireLocalResponse(stream, responsePromise) {
    responsePromise.then((result) => {
      const current = this.requestStreams.get(stream.requestId);
      if (!current) {
        result.bodyStream.destroy();
        return;
      }

      current.responseStream = result.bodyStream;

      if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
        result.bodyStream.destroy();
        this.requestStreams.delete(stream.requestId);
        return;
      }

      sendControl(this.ws, {
        type: MSG.RESPONSE_START,
        requestId: stream.requestId,
        statusCode: result.statusCode,
        headers: result.headers,
      });

      result.bodyStream.on('data', (chunk) => {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          sendData(this.ws, FRAME_RESPONSE_BODY, stream.requestId, chunk);
        }
      });

      result.bodyStream.on('end', () => {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          sendControl(this.ws, { type: MSG.STREAM_END, requestId: stream.requestId });
        }
        this._reportRequest(stream, result.statusCode, null);
        this.requestStreams.delete(stream.requestId);
      });

      result.bodyStream.on('error', (err) => {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          sendControl(this.ws, { type: MSG.STREAM_ERROR, requestId: stream.requestId, message: err.message });
        }
        this._reportRequest(stream, 502, err.message);
        this.requestStreams.delete(stream.requestId);
      });
    }).catch((err) => {
      const current = this.requestStreams.get(stream.requestId);
      if (!current) return;

      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        sendControl(this.ws, {
          type: MSG.STREAM_ERROR,
          requestId: stream.requestId,
          message: err.code === 'ECONNREFUSED'
            ? `Connection refused: localhost:${this.localPort}`
            : err.message,
        });
      }

      this._reportRequest(stream, 502, err.message);
      this.requestStreams.delete(stream.requestId);
    });
  }

  _reportRequest(stream, statusCode, error) {
    if (!stream || stream.reported) return;
    stream.reported = true;
    this.onRequest({
      method: stream.method,
      path: stream.path,
      statusCode,
      latency: Date.now() - stream.startedAt,
      error: error || null,
    });
  }

  _abortRequestStream(requestId, message) {
    const stream = this.requestStreams.get(requestId);
    if (!stream) return;

    if (stream.abort) {
      stream.abort(new Error(message || 'Request aborted'));
    }
    if (stream.responseStream && !stream.responseStream.destroyed) {
      stream.responseStream.destroy();
    }

    this.requestStreams.delete(requestId);
  }

  _clearRequestStreams(err) {
    for (const [requestId] of this.requestStreams) {
      this._abortRequestStream(requestId, err && err.message);
    }
  }

  _clearTcpSockets() {
    for (const [, sock] of this.tcpSockets) {
      sock.destroy();
    }
    this.tcpSockets.clear();
  }

  _reconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    this._clearRequestStreams(new Error('Tunnel disconnected by client'));
    this._clearTcpSockets();
    if (this.ws) {
      sendControl(this.ws, { type: MSG.TUNNEL_CLOSE });
      this.ws.close();
    }
  }
}

module.exports = TunnelClient;
