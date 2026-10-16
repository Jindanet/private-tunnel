const WebSocket = require('ws');
const net = require('node:net');
const os = require('node:os');
const { MSG, PROTOCOL_VERSION, DATA_TRANSPORT_VERSION, TCP_END, FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA,
  selectTransport, getTransportVersion, receiveControl, decodeDataFrame, sendControl, sendData, writeFrame, discardFrame, cancelStream } = require('../shared/tunnel-v4');
const { createForwardRequest } = require('./local-forwarder');
const { requireSecureServerWebSocketUrl } = require('./server-url');

class TunnelClient {
  constructor(options) {
    this.serverUrl = requireSecureServerWebSocketUrl(options.serverUrl);
    this.token = options.token || null;
    this.localHost = options.localHost || 'localhost';
    this.localPort = options.localPort;
    this.clientId = options.clientId || null;
    this.tunnelType = options.tunnelType || 'http';
    this.publishDomain = options.publishDomain || '';
    this.publishMode = options.publishMode === 'root' ? 'root' : 'subdomain';
    this.desiredSubdomain = String(options.desiredSubdomain || '').trim().toLowerCase();
    this.dataTransportVersions = Array.isArray(options.dataTransportVersions)
      ? options.dataTransportVersions.filter((value) => value === 1 || value === DATA_TRANSPORT_VERSION)
      : [DATA_TRANSPORT_VERSION, 1];
    this.dataTransportVersion = 1;
    this.dataTransportSelected = false;
    this.ws = null;
    this.subdomain = null;
    this.url = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.shouldReconnect = true;
    this.reconnectTimer = null;
    this.serverSilenceTimer = null;

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
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.serverSilenceTimer);
    this.serverSilenceTimer = null;
    const url = new URL(this.serverUrl);
    url.searchParams.delete('token');
    this.dataTransportVersion = 1;
    this.dataTransportSelected = false;
    const ws = this.ws = new WebSocket(url, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });

    this.ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this._watchServer(ws);

      // Request a tunnel
      sendControl(this.ws, {
        type: MSG.TUNNEL_OPEN,
        protocolVersion: PROTOCOL_VERSION,
        dataTransportVersions: this.dataTransportVersions,
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
      if (this.ws !== ws || ws.readyState !== ws.OPEN) return;
      this._watchServer(ws);
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
      if (this.ws !== ws) return;
      clearTimeout(this.serverSilenceTimer);
      this.serverSilenceTimer = null;
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
      if (this.ws !== ws) return;
      if (err.message && /Unexpected server response: 401/.test(err.message)) {
        this.shouldReconnect = false;
        err.code = 'EUNAUTHORIZED';
      }
      this.onError(err);
    });
  }

  _handleControlMessage(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.type === MSG.TUNNEL_ASSIGNED) {
      const version = msg.dataTransportVersion == null ? 1 : msg.dataTransportVersion;
      if ((this.dataTransportSelected && version !== this.dataTransportVersion)
        || (version !== 1 && (version !== DATA_TRANSPORT_VERSION || !this.dataTransportVersions.includes(version)))) {
        this.shouldReconnect = false;
        this.ws.close(1002, 'Unsupported data transport');
        this.onError(new Error('Server selected an unsupported data transport.'));
        return;
      }
      if (version === DATA_TRANSPORT_VERSION) selectTransport(this.ws, version, { isServer: false });
      this.dataTransportVersion = version;
      this.dataTransportSelected = true;
    }
    if (!receiveControl(this.ws, msg)) return;
    switch (msg.type) {
      case MSG.TUNNEL_ASSIGNED:
        this.reconnectAttempts = 0;
        this.subdomain = msg.subdomain;
        this.url = msg.url;
        this.onConnected({
          subdomain: msg.subdomain,
          publicHost: msg.publicHost || '',
          publishDomain: msg.publishDomain || this.publishDomain || '',
          publishMode: msg.publishMode || this.publishMode,
          url: msg.url,
          tunnelType: msg.tunnelType,
          dataTransportVersion: this.dataTransportVersion,
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

      case TCP_END:
        if (getTransportVersion(this.ws) === DATA_TRANSPORT_VERSION) this.tcpSockets.get(msg.connId)?.end();
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
    const frame = decodeDataFrame(data, this.ws);
    if (!frame) return;

    if (frame.frameType === FRAME_REQUEST_BODY) {
      const stream = this.requestStreams.get(frame.requestId);
      if (stream && stream.localReq && !stream.localReq.destroyed) {
        if (!writeFrame(this.ws, frame, stream.localReq)) {
          sendControl(this.ws, {type: MSG.STREAM_ERROR, requestId: frame.requestId, message: 'Local request write failed'});
          this._abortRequestStream(frame.requestId, 'Local request write failed');
        }
      } else {
        discardFrame(this.ws, frame);
      }
    } else if (frame.frameType === FRAME_TCP_DATA) {
      const sock = this.tcpSockets.get(frame.requestId);
      if (sock && !sock.destroyed) {
        if (!writeFrame(this.ws, frame, sock)) sock.destroy();
      } else {
        discardFrame(this.ws, frame);
      }
    } else {
      discardFrame(this.ws, frame);
    }
  }

  _handleTcpConnect(connId) {
    if (typeof connId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(connId)) return;
    if (this.tcpSockets.has(connId) || this.tcpSockets.size >= 128) return;
    const modern = getTransportVersion(this.ws) === DATA_TRANSPORT_VERSION;
    const sock = net.createConnection({ host: this.localHost, port: this.localPort, allowHalfOpen: modern });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30000);
    sock.setTimeout(300000, () => sock.destroy());
    this.tcpSockets.set(connId, sock);
    this.onRequest({ method: 'TCP', path: `→ localhost:${this.localPort}`, statusCode: 0, latency: 0 });

    sock.on('data', (chunk) => {
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        if (!sendData(this.ws, FRAME_TCP_DATA, connId, chunk, sock)) sock.destroy();
      }
    });

    sock.on('end', () => {
      if (modern) sendControl(this.ws, {type: TCP_END, connId});
    });

    sock.on('close', (hadError) => {
      this.tcpSockets.delete(connId);
      if (!sock._tunnelRemoteReset && (hadError || !modern || !sock.readableEnded || !sock.writableFinished)
        && this.ws && this.ws.readyState === this.ws.OPEN) {
        sendControl(this.ws, { type: MSG.TCP_CLOSE, connId });
      }
    });

    sock.on('connect', () => {
      this.onRequest({ method: 'TCP', path: `connected → localhost:${this.localPort}`, statusCode: 200, latency: 0 });
    });

    sock.on('error', () => {}); // close performs the stream reset once.
  }

  _handleTcpClose(connId) {
    cancelStream(this.ws, connId);
    const sock = this.tcpSockets.get(connId);
    if (sock) {
      sock._tunnelRemoteReset = true;
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

      const headersSent = sendControl(this.ws, {
        type: MSG.RESPONSE_START,
        requestId: stream.requestId,
        statusCode: result.statusCode,
        headers: result.headers,
      });
      if (!headersSent) {
        this._reportRequest(stream, 502, 'Could not forward response headers');
        this._abortRequestStream(stream.requestId, 'Could not forward response headers');
        return;
      }

      result.bodyStream.on('data', (chunk) => {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
          if (!sendData(this.ws, FRAME_RESPONSE_BODY, stream.requestId, chunk, result.bodyStream)) {
            result.bodyStream.destroy(new Error('Tunnel response queue limit exceeded'));
          }
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
    cancelStream(this.ws, requestId);
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
    for (const [connId, sock] of this.tcpSockets) {
      cancelStream(this.ws, connId);
      sock.destroy();
    }
    this.tcpSockets.clear();
  }

  _watchServer(ws) {
    if (this.serverSilenceTimer?.refresh) {
      this.serverSilenceTimer.refresh();
      return;
    }
    clearTimeout(this.serverSilenceTimer);
    this.serverSilenceTimer = setTimeout(() => {
      this.serverSilenceTimer = null;
      if (this.ws === ws && ws.readyState === ws.OPEN && this.shouldReconnect) ws.terminate();
    }, 90000);
    this.serverSilenceTimer.unref?.();
  }

  _reconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const cap = Math.min(
      1000 * Math.pow(2, Math.min(this.reconnectAttempts, 30)),
      this.maxReconnectDelay
    );
    const delay = Math.floor(cap * (0.5 + Math.random() * 0.5));
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearTimeout(this.serverSilenceTimer);
    this.serverSilenceTimer = null;
    this._clearRequestStreams(new Error('Tunnel disconnected by client'));
    this._clearTcpSockets();
    if (this.ws) {
      sendControl(this.ws, { type: MSG.TUNNEL_CLOSE });
      this.ws.close();
    }
  }
}

module.exports = TunnelClient;
