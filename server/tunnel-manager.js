const net = require('node:net');
const { MSG, FRAME_RESPONSE_BODY, FRAME_TCP_DATA, decodeDataFrame, sendControl, sendData } = require('../shared/protocol');
const { generateUnique } = require('./subdomain');
const { getSubdomainForClient, saveMapping, touchClient } = require('./db');
const { openPort, closePort } = require('./firewall');

const TCP_PORT_MIN = parseInt(process.env.TCP_PORT_MIN) || 30000;
const TCP_PORT_MAX = parseInt(process.env.TCP_PORT_MAX) || 40000;

// Check if a port is actually free on the OS level
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

class TunnelManager {
  constructor(domain) {
    this.domain = domain || process.env.DOMAIN;
    this.tunnels = new Map();
    this.usedTcpPorts = new Set();
  }

  async _allocateTcpPort() {
    for (let port = TCP_PORT_MIN; port <= TCP_PORT_MAX; port++) {
      if (this.usedTcpPorts.has(port)) continue;
      if (await isPortFree(port)) {
        this.usedTcpPorts.add(port);
        return port;
      }
      // Port busy by another process — skip silently
    }
    return null;
  }

  handleNewClient(ws, clientIp) {
    let assignedSubdomain = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this._handleBinaryFrame(data, assignedSubdomain);
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        this._handleControlMessage(ws, msg, assignedSubdomain, clientIp, (sub) => {
          assignedSubdomain = sub;
        });
      } catch (e) {
        console.error('[TunnelManager] Invalid message:', e.message);
      }
    });

    ws.on('close', () => {
      if (assignedSubdomain) {
        this._removeTunnel(assignedSubdomain);
        console.log(`[TunnelManager] Tunnel closed: ${assignedSubdomain}`);
      }
    });

    ws.on('error', (err) => {
      console.error('[TunnelManager] WebSocket error:', err.message);
    });

    // Keepalive ping every 30s
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        sendControl(ws, { type: MSG.PING });
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));
  }

  _handleControlMessage(ws, msg, currentSubdomain, clientIp, setSubdomain) {
    switch (msg.type) {
      case MSG.TUNNEL_OPEN: {
        const tunnelType = msg.tunnelType === 'tcp' ? 'tcp' : 'http';
        let subdomain = null;

        // If client has an ID, try to reuse their previous subdomain
        if (msg.clientId) {
          const saved = getSubdomainForClient(msg.clientId);
          if (saved && !this.tunnels.has(saved)) {
            subdomain = saved;
            touchClient(msg.clientId, clientIp);
          }
        }

        // Generate new subdomain if needed
        if (!subdomain) {
          subdomain = generateUnique(this.tunnels);
          if (msg.clientId) {
            try {
              saveMapping(msg.clientId, subdomain, clientIp, msg.hostname || null, msg.os || null);
            } catch (e) {
              console.log(`[TunnelManager] Could not save mapping: ${e.message}`);
            }
          }
        }

        const tunnel = {
          ws,
          tunnelType,
          localPort: msg.localPort,
          clientId: msg.clientId || null,
          clientIp,
          hostname: msg.hostname || null,
          os: msg.os || null,
          connectedAt: new Date().toISOString(),
          pendingRequests: new Map(),
          stats: { connections: 0, bytesIn: 0, bytesOut: 0 },
          requestLog: [],
        };

        if (tunnelType === 'tcp') {
          this._allocateTcpPort().then((tcpPort) => {
            // If client disconnected while we were allocating, abort
            if (ws.readyState !== ws.OPEN) {
              if (tcpPort) this.usedTcpPorts.delete(tcpPort);
              return;
            }

            if (!tcpPort) {
              sendControl(ws, { type: MSG.STREAM_ERROR, message: 'No TCP ports available in range' });
              return;
            }

            // Auto-open firewall (best-effort)
            openPort(tcpPort);

            tunnel.tcpPort = tcpPort;
            tunnel.tcpConnections = new Map();
            tunnel.tcpServer = this._startTcpServer(tcpPort, subdomain, ws, tunnel);

            this.tunnels.set(subdomain, tunnel);
            setSubdomain(subdomain);

            sendControl(ws, {
              type: MSG.TUNNEL_ASSIGNED,
              tunnelType: 'tcp',
              subdomain,
              tcpPort,
              url: `${this.domain}:${tcpPort}`,
            });
            console.log(`[TunnelManager] TCP tunnel: ${subdomain} port ${tcpPort} -> localhost:${msg.localPort} from ${clientIp}`);
          }).catch((err) => {
            console.error('[TunnelManager] TCP allocation error:', err.message);
          });
        } else {
          this.tunnels.set(subdomain, tunnel);
          setSubdomain(subdomain);

          sendControl(ws, {
            type: MSG.TUNNEL_ASSIGNED,
            tunnelType: 'http',
            subdomain,
            url: `https://${subdomain}.${this.domain}`,
          });
          console.log(`[TunnelManager] HTTP tunnel: ${subdomain} -> localhost:${msg.localPort} from ${clientIp}${msg.clientId ? ' (client: ' + msg.clientId.slice(0, 8) + '...)' : ''}`);
        }
        break;
      }

      case MSG.TCP_CLOSE: {
        if (!currentSubdomain) return;
        const tunnel = this.tunnels.get(currentSubdomain);
        if (!tunnel || !tunnel.tcpConnections) return;
        const sock = tunnel.tcpConnections.get(msg.connId);
        if (sock) {
          sock.destroy();
          tunnel.tcpConnections.delete(msg.connId);
        }
        break;
      }

      case MSG.RESPONSE_START: {
        if (!currentSubdomain) return;
        const tunnel = this.tunnels.get(currentSubdomain);
        if (!tunnel) return;

        const pending = tunnel.pendingRequests.get(msg.requestId);
        if (!pending) return;

        pending.statusCode = msg.statusCode;
        const headers = { ...msg.headers };
        delete headers['transfer-encoding'];
        pending.res.writeHead(msg.statusCode, headers);
        break;
      }

      case MSG.STREAM_END: {
        if (!currentSubdomain) return;
        const tunnel = this.tunnels.get(currentSubdomain);
        if (!tunnel) return;

        const pending = tunnel.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          if (!pending.res.destroyed) pending.res.end();
          this._logCompletedRequest(currentSubdomain, tunnel, pending);
          tunnel.pendingRequests.delete(msg.requestId);
        }
        break;
      }

      case MSG.STREAM_ERROR: {
        if (!currentSubdomain) return;
        const tunnel = this.tunnels.get(currentSubdomain);
        if (!tunnel) return;

        const pending = tunnel.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          if (!pending.res.destroyed) {
            if (!pending.res.headersSent) {
              pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
            }
            pending.res.end(`Tunnel error: ${msg.message || 'Unknown error'}`);
          }
          pending.statusCode = 502;
          pending.error = msg.message;
          this._logCompletedRequest(currentSubdomain, tunnel, pending);
          tunnel.pendingRequests.delete(msg.requestId);
        }
        break;
      }

      case MSG.PONG:
        break;

      case MSG.TUNNEL_CLOSE: {
        if (currentSubdomain) {
          this._removeTunnel(currentSubdomain);
          ws.close();
        }
        break;
      }
    }
  }

  _logCompletedRequest(subdomain, tunnel, pending) {
    const latencyMs = Date.now() - pending.startTime;
    const logEntry = {
      subdomain,
      clientId: tunnel.clientId,
      visitorIp: pending.visitorIp,
      method: pending.method,
      path: pending.path,
      host: pending.host,
      userAgent: pending.userAgent,
      referer: pending.referer,
      contentType: pending.reqContentType,
      contentLength: pending.reqContentLength,
      statusCode: pending.statusCode || 0,
      latencyMs,
      error: pending.error || null,
      time: new Date().toISOString(),
    };

    // Keep last 50 in memory
    tunnel.requestLog.unshift(logEntry);
    if (tunnel.requestLog.length > 50) tunnel.requestLog.pop();

    // Save to DB
    try {
      const { logRequest } = require('./db');
      logRequest(logEntry);
    } catch (e) {
      console.error('[TunnelManager] Log error:', e.message);
    }
  }

  _handleBinaryFrame(data, subdomain) {
    if (!subdomain) return;
    const tunnel = this.tunnels.get(subdomain);
    if (!tunnel) return;

    const frame = decodeDataFrame(data);
    if (!frame) return;

    if (frame.frameType === FRAME_RESPONSE_BODY) {
      const pending = tunnel.pendingRequests.get(frame.requestId);
      if (pending && !pending.res.destroyed) {
        pending.res.write(frame.data);
        tunnel.stats.bytesOut += frame.data.length;
      }
    } else if (frame.frameType === FRAME_TCP_DATA) {
      const sock = tunnel.tcpConnections && tunnel.tcpConnections.get(frame.requestId);
      if (sock && !sock.destroyed) {
        sock.write(frame.data);
        tunnel.stats.bytesOut += frame.data.length;
      }
    }
  }

  _startTcpServer(port, subdomain, ws, tunnel) {
    const server = net.createServer((sock) => {
      const connId = require('node:crypto').randomUUID();
      tunnel.tcpConnections.set(connId, sock);
      tunnel.stats.connections++;

      sendControl(ws, { type: MSG.TCP_CONNECT, connId });

      sock.on('data', (chunk) => {
        tunnel.stats.bytesIn += chunk.length;
        if (ws.readyState === ws.OPEN) {
          sendData(ws, FRAME_TCP_DATA, connId, chunk);
        }
      });

      sock.on('close', () => {
        tunnel.tcpConnections.delete(connId);
        if (ws.readyState === ws.OPEN) {
          sendControl(ws, { type: MSG.TCP_CLOSE, connId });
        }
      });

      sock.on('error', () => sock.destroy());
    });

    server.listen(port, () => {
      console.log(`[TCP] Listening on port ${port} for tunnel ${subdomain}`);
    });

    server.on('error', (err) => {
      console.error(`[TCP] Server error on port ${port}:`, err.message);
    });

    return server;
  }

  getTunnel(subdomain) {
    return this.tunnels.get(subdomain);
  }

  _removeTunnel(subdomain) {
    const tunnel = this.tunnels.get(subdomain);
    if (tunnel) {
      // HTTP cleanup
      for (const [, pending] of tunnel.pendingRequests) {
        clearTimeout(pending.timeout);
        if (!pending.res.destroyed) {
          if (!pending.res.headersSent) {
            pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          pending.res.end('Tunnel disconnected');
        }
      }
      tunnel.pendingRequests.clear();

      // TCP cleanup
      if (tunnel.tcpServer) {
        tunnel.tcpServer.close();
        this.usedTcpPorts.delete(tunnel.tcpPort);
        closePort(tunnel.tcpPort);
      }
      if (tunnel.tcpConnections) {
        for (const [, sock] of tunnel.tcpConnections) {
          sock.destroy();
        }
        tunnel.tcpConnections.clear();
      }

      this.tunnels.delete(subdomain);
    }
  }
}

module.exports = TunnelManager;
