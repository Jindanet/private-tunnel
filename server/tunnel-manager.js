const { MSG, sendControl } = require('../shared/protocol');
const { generateUnique } = require('./subdomain');
const { getSubdomainForClient, isSubdomainTaken, saveMapping, touchClient } = require('./db');

class TunnelManager {
  constructor(domain) {
    this.domain = domain || process.env.DOMAIN;
    this.tunnels = new Map();
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
          localPort: msg.localPort,
          clientId: msg.clientId || null,
          clientIp,
          hostname: msg.hostname || null,
          os: msg.os || null,
          connectedAt: new Date().toISOString(),
          pendingRequests: new Map(),
          stats: { connections: 0, bytesIn: 0, bytesOut: 0 },
          requestLog: [], // Last 50 requests in memory for live view
        };
        this.tunnels.set(subdomain, tunnel);
        setSubdomain(subdomain);

        sendControl(ws, {
          type: MSG.TUNNEL_ASSIGNED,
          subdomain,
          url: `https://${subdomain}.${this.domain}`,
        });

        console.log(`[TunnelManager] Tunnel opened: ${subdomain} -> localhost:${msg.localPort} from ${clientIp}${msg.clientId ? ' (client: ' + msg.clientId.slice(0, 8) + '...)' : ''}`);
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
          pending.res.end();
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
          if (!pending.res.headersSent) {
            pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          pending.res.end(`Tunnel error: ${msg.message || 'Unknown error'}`);
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

    const { decodeDataFrame, FRAME_RESPONSE_BODY } = require('../shared/protocol');
    const frame = decodeDataFrame(data);

    if (frame.frameType === FRAME_RESPONSE_BODY) {
      const pending = tunnel.pendingRequests.get(frame.requestId);
      if (pending && !pending.res.destroyed) {
        pending.res.write(frame.data);
        tunnel.stats.bytesOut += frame.data.length;
      }
    }
  }

  getTunnel(subdomain) {
    return this.tunnels.get(subdomain);
  }

  _removeTunnel(subdomain) {
    const tunnel = this.tunnels.get(subdomain);
    if (tunnel) {
      for (const [reqId, pending] of tunnel.pendingRequests) {
        clearTimeout(pending.timeout);
        if (!pending.res.headersSent) {
          pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        pending.res.end('Tunnel disconnected');
      }
      tunnel.pendingRequests.clear();
      this.tunnels.delete(subdomain);
    }
  }
}

module.exports = TunnelManager;
