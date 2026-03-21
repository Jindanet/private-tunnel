const WebSocket = require('ws');
const net = require('node:net');
const os = require('node:os');
const { MSG, FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA, decodeDataFrame, sendControl, sendData } = require('../shared/protocol');
const { forwardRequest } = require('./local-forwarder');

class TunnelClient {
  constructor(options) {
    this.serverUrl = options.serverUrl;
    this.localHost = options.localHost || 'localhost';
    this.localPort = options.localPort;
    this.clientId = options.clientId || null;
    this.tunnelType = options.tunnelType || 'http';
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

    // HTTP: track incoming request bodies and metadata
    this.requestBodies = new Map();
    this._pendingRequests = new Map();

    // TCP: connId -> net.Socket
    this.tcpSockets = new Map();
  }

  connect() {
    this.ws = new WebSocket(this.serverUrl);

    this.ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;

      // Request a tunnel
      sendControl(this.ws, {
        type: MSG.TUNNEL_OPEN,
        tunnelType: this.tunnelType,
        localPort: this.localPort,
        clientId: this.clientId,
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

    this.ws.on('close', () => {
      this.connected = false;
      if (this.shouldReconnect) {
        this.onDisconnected();
        this._reconnect();
      }
    });

    this.ws.on('error', (err) => {
      this.onError(err);
    });
  }

  _handleControlMessage(msg) {
    switch (msg.type) {
      case MSG.TUNNEL_ASSIGNED:
        this.subdomain = msg.subdomain;
        this.url = msg.url;
        this.onConnected({ subdomain: msg.subdomain, url: msg.url, tunnelType: msg.tunnelType });
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
        this.requestBodies.delete(msg.requestId);
        break;

      case MSG.PING:
        sendControl(this.ws, { type: MSG.PONG });
        break;
    }
  }

  _handleBinaryFrame(data) {
    const frame = decodeDataFrame(data);

    if (frame.frameType === FRAME_REQUEST_BODY) {
      if (!this.requestBodies.has(frame.requestId)) {
        this.requestBodies.set(frame.requestId, []);
      }
      this.requestBodies.get(frame.requestId).push(frame.data);
    } else if (frame.frameType === FRAME_TCP_DATA) {
      const sock = this.tcpSockets.get(frame.requestId);
      if (sock && !sock.destroyed) {
        sock.write(frame.data);
      }
    }
  }

  _handleTcpConnect(connId) {
    const sock = net.createConnection({ host: this.localHost, port: this.localPort });
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

  async _handleRequestStart(msg) {
    const { requestId, method, path, headers } = msg;
    const startTime = Date.now();

    // Initialize body buffer
    this.requestBodies.set(requestId, []);

    // For bodyless methods, forward immediately
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS') {
      await this._forwardToLocal(requestId, method, path, headers, []);
    } else {
      // For POST/PUT/PATCH, store metadata and wait for stream:end
      this._pendingRequests.set(requestId, { method, path, headers });
    }
  }

  async _handleRequestEnd(requestId) {
    // This is called when the request body stream is complete
    // Find the pending request info — we need the original request details
    // They were already processed in _handleRequestStart for bodyless methods
    const bodyChunks = this.requestBodies.get(requestId);
    if (!bodyChunks) return; // Already handled (GET, etc.)

    // For requests with body, we need to store request metadata too
    // Let's refactor: store request metadata alongside body
    if (this._pendingRequests && this._pendingRequests.has(requestId)) {
      const { method, path, headers } = this._pendingRequests.get(requestId);
      this._pendingRequests.delete(requestId);
      await this._forwardToLocal(requestId, method, path, headers, bodyChunks);
    }

    this.requestBodies.delete(requestId);
  }

  async _forwardToLocal(requestId, method, path, headers, bodyChunks) {
    const startTime = Date.now();

    try {
      const result = await forwardRequest(
        this.localHost,
        this.localPort,
        method,
        path,
        headers,
        bodyChunks
      );

      const latency = Date.now() - startTime;

      // Send response headers
      sendControl(this.ws, {
        type: MSG.RESPONSE_START,
        requestId,
        statusCode: result.statusCode,
        headers: result.headers,
      });

      // Stream response body
      result.bodyStream.on('data', (chunk) => {
        sendData(this.ws, FRAME_RESPONSE_BODY, requestId, chunk);
      });

      result.bodyStream.on('end', () => {
        sendControl(this.ws, { type: MSG.STREAM_END, requestId });
      });

      result.bodyStream.on('error', (err) => {
        sendControl(this.ws, { type: MSG.STREAM_ERROR, requestId, message: err.message });
      });

      // Notify UI
      this.onRequest({ method, path, statusCode: result.statusCode, latency });

    } catch (err) {
      const latency = Date.now() - startTime;

      // Local service connection failed
      sendControl(this.ws, {
        type: MSG.STREAM_ERROR,
        requestId,
        message: err.code === 'ECONNREFUSED'
          ? `Connection refused: localhost:${this.localPort}`
          : err.message,
      });

      this.onRequest({ method, path, statusCode: 502, latency, error: err.message });
    }
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
    for (const [, sock] of this.tcpSockets) {
      sock.destroy();
    }
    this.tcpSockets.clear();
    if (this.ws) {
      sendControl(this.ws, { type: MSG.TUNNEL_CLOSE });
      this.ws.close();
    }
  }
}

module.exports = TunnelClient;
