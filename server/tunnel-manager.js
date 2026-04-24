const net = require('node:net');
const crypto = require('node:crypto');
const { MSG, FRAME_RESPONSE_BODY, FRAME_TCP_DATA, decodeDataFrame, sendControl, sendData } = require('../shared/protocol');
const { generate, RESERVED } = require('./subdomain');
const { getClientMapping, getClientMappingByAssignedHost, isSubdomainTaken, saveMapping, touchClient, logRequest } = require('./db');
const { openPort, closePort } = require('./firewall');
const { normalizeDomain, buildHttpHost, getTcpAddress, getTunnelHttpOrigin } = require('./routing');

const TCP_PORT_MIN = parseInt(process.env.TCP_PORT_MIN, 10) || 30000;
const TCP_PORT_MAX = parseInt(process.env.TCP_PORT_MAX, 10) || 40000;

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

class TunnelManager {
  constructor(runtimeConfig) {
    this.runtimeConfig = runtimeConfig || {};
    this.tunnels = new Map();
    this.httpHosts = new Map();
    this.usedTcpPorts = new Set();
  }

  async _allocateTcpPort() {
    for (let port = TCP_PORT_MIN; port <= TCP_PORT_MAX; port++) {
      if (this.usedTcpPorts.has(port)) continue;
      if (await isPortFree(port)) {
        this.usedTcpPorts.add(port);
        return port;
      }
    }

    return null;
  }

  handleNewClient(ws, clientIp) {
    let assignedTunnelKey = null;

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this._handleBinaryFrame(data, assignedTunnelKey);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (error) {
        console.error('[TunnelManager] Invalid message:', error.message);
        return;
      }

      Promise.resolve(
        this._handleControlMessage(ws, msg, assignedTunnelKey, clientIp, (tunnelKey) => {
          assignedTunnelKey = tunnelKey;
        })
      ).catch((error) => {
        console.error('[TunnelManager] Control error:', error.message);
        if (ws.readyState === ws.OPEN) {
          try {
            sendControl(ws, { type: MSG.TUNNEL_ERROR, message: error.message || 'Tunnel error' });
          } catch {}
        }
      });
    });

    ws.on('close', () => {
      if (!assignedTunnelKey) return;

      const removed = this._removeTunnel(assignedTunnelKey);
      if (removed) {
        console.log(`[TunnelManager] Tunnel closed: ${removed.publicHost || removed.label || assignedTunnelKey}`);
      }
    });

    ws.on('error', (err) => {
      console.error('[TunnelManager] WebSocket error:', err.message);
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        sendControl(ws, { type: MSG.PING });
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));
  }

  async _handleControlMessage(ws, msg, currentTunnelKey, clientIp, setTunnelKey) {
    switch (msg.type) {
      case MSG.TUNNEL_OPEN: {
        if (currentTunnelKey) {
          this._removeTunnel(currentTunnelKey);
          setTunnelKey(null);
        }

        const tunnelType = msg.tunnelType === 'tcp' ? 'tcp' : 'http';
        const clientRecord = msg.clientId ? await getClientMapping(msg.clientId) : null;
        if (msg.clientId) {
          this._disconnectExistingClientTunnel(msg.clientId, ws);
          await touchClient(msg.clientId, clientIp);
        }

        if (tunnelType === 'tcp') {
          await this._openTcpTunnel(ws, msg, clientIp, clientRecord, setTunnelKey);
        } else {
          await this._openHttpTunnel(ws, msg, clientIp, clientRecord, setTunnelKey);
        }
        break;
      }

      case MSG.TUNNEL_CHECK: {
        const startTime = Date.now();
        const preview = await this.previewTunnelRequest(msg);
        const duration = Date.now() - startTime;
        if (duration > 3000) {
          console.log(`[TunnelManager] Slow TUNNEL_CHECK: ${duration}ms for type=${msg.tunnelType}, domain=${msg.publishDomain}`);
        }
        sendControl(ws, {
          type: MSG.TUNNEL_CHECK_RESULT,
          ...preview,
        });
        break;
      }

      case MSG.TCP_CLOSE: {
        if (!currentTunnelKey) return;
        const tunnel = this.tunnels.get(currentTunnelKey);
        if (!tunnel || !tunnel.tcpConnections) return;

        const sock = tunnel.tcpConnections.get(msg.connId);
        if (sock) {
          sock.destroy();
          tunnel.tcpConnections.delete(msg.connId);
        }
        break;
      }

      case MSG.RESPONSE_START: {
        if (!currentTunnelKey) return;
        const tunnel = this.tunnels.get(currentTunnelKey);
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
        if (!currentTunnelKey) return;
        const tunnel = this.tunnels.get(currentTunnelKey);
        if (!tunnel) return;

        const pending = tunnel.pendingRequests.get(msg.requestId);
        if (!pending) return;

        clearTimeout(pending.timeout);
        if (!pending.res.destroyed) pending.res.end();
        this._logCompletedRequest(tunnel, pending);
        tunnel.pendingRequests.delete(msg.requestId);
        break;
      }

      case MSG.STREAM_ERROR: {
        if (!currentTunnelKey) return;
        const tunnel = this.tunnels.get(currentTunnelKey);
        if (!tunnel) return;

        const pending = tunnel.pendingRequests.get(msg.requestId);
        if (!pending) return;

        clearTimeout(pending.timeout);
        if (!pending.res.destroyed) {
          if (!pending.res.headersSent) {
            pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
          }
          pending.res.end(`Tunnel error: ${msg.message || 'Unknown error'}`);
        }
        pending.statusCode = 502;
        pending.error = msg.message;
        this._logCompletedRequest(tunnel, pending);
        tunnel.pendingRequests.delete(msg.requestId);
        break;
      }

      case MSG.PONG:
        break;

      case MSG.TUNNEL_CLOSE: {
        if (!currentTunnelKey) return;
        this._removeTunnel(currentTunnelKey);
        ws.close();
        break;
      }
    }
  }

  async _openHttpTunnel(ws, msg, clientIp, clientRecord, setTunnelKey) {
    const assignment = await this._resolveHttpAssignment(msg, clientRecord);
    if (assignment.error) {
      sendControl(ws, { type: MSG.TUNNEL_ERROR, message: assignment.error });
      return;
    }

    if (this.httpHosts.has(assignment.publicHost)) {
      sendControl(ws, {
        type: MSG.TUNNEL_ERROR,
        message: `The public host ${assignment.publicHost} is already in use by another live tunnel.`,
      });
      return;
    }

    const tunnelKey = `http:${assignment.publicHost}`;
    const tunnel = this._createBaseTunnel(ws, msg, clientIp, clientRecord, {
      tunnelKey,
      label: assignment.label,
      publicHost: assignment.publicHost,
      publishDomain: assignment.publishDomain,
      publishMode: assignment.publishMode,
      publicUrl: getTunnelHttpOrigin(assignment.publicHost, this.runtimeConfig),
    });

    this.tunnels.set(tunnelKey, tunnel);
    this.httpHosts.set(assignment.publicHost, tunnelKey);
    setTunnelKey(tunnelKey);

    if (msg.clientId) {
      try {
        await saveMapping(msg.clientId, {
          subdomain: assignment.label,
          assignedHost: assignment.publicHost,
          publishDomain: assignment.publishDomain,
          publishMode: assignment.publishMode,
          ip: clientIp,
          hostname: msg.hostname || null,
          os: msg.os || null,
        });
      } catch (error) {
        this._removeTunnel(tunnelKey);
        setTunnelKey(null);
        sendControl(ws, {
          type: MSG.TUNNEL_ERROR,
          message: this._formatMappingError(error, assignment.publicHost),
        });
        return;
      }
    }

    sendControl(ws, {
      type: MSG.TUNNEL_ASSIGNED,
      tunnelType: 'http',
      subdomain: assignment.label,
      publicHost: assignment.publicHost,
      publishDomain: assignment.publishDomain,
      publishMode: assignment.publishMode,
      url: tunnel.publicUrl,
    });
    console.log(`[TunnelManager] HTTP tunnel: ${assignment.publicHost} -> localhost:${msg.localPort} from ${clientIp}${msg.clientId ? ' (client: ' + msg.clientId.slice(0, 8) + '...)' : ''}`);
  }

  async _openTcpTunnel(ws, msg, clientIp, clientRecord, setTunnelKey) {
    const domainChoice = this._resolvePublishDomainChoice(msg.publishDomain, null, clientRecord, 'tcp');
    if (domainChoice.error) {
      sendControl(ws, { type: MSG.TUNNEL_ERROR, message: domainChoice.error });
      return;
    }

    const label = await this._generateLabel(clientRecord && clientRecord.subdomain, {
      allowPreferredReuse: Boolean(clientRecord && clientRecord.subdomain),
    });
    const tunnel = this._createBaseTunnel(ws, msg, clientIp, clientRecord, {
      tunnelKey: null,
      label,
      publicHost: normalizeDomain(domainChoice.domain),
      publishDomain: normalizeDomain(domainChoice.domain),
      publishMode: 'subdomain',
      publicUrl: '',
    });

    const tcpPort = await this._allocateTcpPort();
    if (ws.readyState !== ws.OPEN) {
      if (tcpPort) this.usedTcpPorts.delete(tcpPort);
      return;
    }

    if (!tcpPort) {
      sendControl(ws, { type: MSG.TUNNEL_ERROR, message: 'No TCP ports available in the configured range' });
      return;
    }

    const tunnelKey = `tcp:${tcpPort}`;
    tunnel.tunnelKey = tunnelKey;
    tunnel.tcpPort = tcpPort;
    tunnel.publicUrl = getTcpAddress(tcpPort, domainChoice.domain);
    tunnel.tcpConnections = new Map();
    tunnel.tcpServer = this._startTcpServer(tcpPort, ws, tunnel);

    openPort(tcpPort);

    this.tunnels.set(tunnelKey, tunnel);
    setTunnelKey(tunnelKey);

    if (msg.clientId) {
      try {
        await saveMapping(msg.clientId, {
          subdomain: label,
          assignedHost: '',
          publishDomain: domainChoice.domain,
          publishMode: clientRecord && clientRecord.publish_mode === 'root' ? 'root' : 'subdomain',
          ip: clientIp,
          hostname: msg.hostname || null,
          os: msg.os || null,
        });
      } catch (error) {
        console.log(`[TunnelManager] Could not save mapping: ${error.message}`);
      }
    }

    sendControl(ws, {
      type: MSG.TUNNEL_ASSIGNED,
      tunnelType: 'tcp',
      subdomain: label,
      publicHost: normalizeDomain(domainChoice.domain),
      publishDomain: normalizeDomain(domainChoice.domain),
      url: tunnel.publicUrl,
      tcpPort,
    });
    console.log(`[TunnelManager] TCP tunnel: ${domainChoice.domain}:${tcpPort} -> localhost:${msg.localPort} from ${clientIp}`);
  }

  _createBaseTunnel(ws, msg, clientIp, clientRecord, details) {
    return {
      ws,
      tunnelKey: details.tunnelKey,
      tunnelType: msg.tunnelType === 'tcp' ? 'tcp' : 'http',
      localPort: msg.localPort,
      clientId: msg.clientId || null,
      clientIp,
      hostname: msg.hostname || null,
      os: msg.os || null,
      connectedAt: new Date().toISOString(),
      label: details.label,
      publicHost: details.publicHost,
      publishDomain: details.publishDomain,
      publishMode: details.publishMode,
      publicUrl: details.publicUrl,
      savedAssignedHost: clientRecord && clientRecord.assigned_host ? normalizeDomain(clientRecord.assigned_host) : '',
      pendingRequests: new Map(),
      stats: { connections: 0, bytesIn: 0, bytesOut: 0 },
      requestLog: [],
    };
  }

  async _resolveHttpAssignment(msg, clientRecord) {
    const publishMode = Object.prototype.hasOwnProperty.call(msg, 'publishMode')
      ? (msg.publishMode === 'root' ? 'root' : 'subdomain')
      : (clientRecord && clientRecord.publish_mode === 'root' ? 'root' : 'subdomain');
    const domainChoice = this._resolvePublishDomainChoice(msg.publishDomain, publishMode, clientRecord, 'http');
    if (domainChoice.error) return domainChoice;

    const requestedLabel = publishMode === 'subdomain'
      ? this._normalizeRequestedLabel(msg.desiredSubdomain || '')
      : '';
    const label = await this._generateLabel(requestedLabel || (clientRecord && clientRecord.subdomain), {
      allowPreferredReuse: Boolean(clientRecord && clientRecord.subdomain),
      forcePreferred: Boolean(requestedLabel),
    });
    const publicHost = buildHttpHost(label, domainChoice.domain, publishMode);
    if (!publicHost) {
      return { error: 'Could not generate a public host for this tunnel.' };
    }

    return {
      label,
      publishDomain: normalizeDomain(domainChoice.domain),
      publishMode,
      publicHost: publishMode === 'root' ? normalizeDomain(domainChoice.domain) : publicHost,
    };
  }

  _resolvePublishDomainChoice(requestedDomain, requestedMode, clientRecord, tunnelType) {
    const publishDomains = Array.isArray(this.runtimeConfig.publishDomains) ? this.runtimeConfig.publishDomains : [];
    if (!publishDomains.length) {
      return {
        error: 'No publish domains are configured yet. Open the admin UI and add at least one domain first.',
      };
    }

    const desiredMode = requestedMode === 'root' ? 'root' : 'subdomain';
    const explicitRequestedDomain = normalizeDomain(requestedDomain || '');
    const savedDomain = normalizeDomain((clientRecord && clientRecord.publish_domain) || '');
    const preferredDomain = explicitRequestedDomain || savedDomain;

    const candidates = publishDomains.filter((entry) => {
      if (tunnelType === 'tcp') return true;
      return desiredMode === 'root' ? entry.allowRoot : entry.allowSubdomain;
    });

    if (!candidates.length) {
      const modeLabel = desiredMode === 'root' ? 'root-domain' : 'subdomain';
      return {
        error: `No publish domains currently allow ${modeLabel} HTTP tunnels.`,
      };
    }

    if (preferredDomain) {
      const match = candidates.find((entry) => entry.domain === preferredDomain);
      if (match) {
        return match;
      }

      if (explicitRequestedDomain) {
        return {
          error: desiredMode === 'root'
            ? `The domain ${preferredDomain} is not available for root-host HTTP tunnels.`
            : `The domain ${preferredDomain} is not available for tunnel publishing.`,
        };
      }
    }

    return candidates[0];
  }

  async _generateLabel(preferredLabel, options = {}) {
    const normalized = this._normalizeRequestedLabel(preferredLabel || '');
    if (options.allowPreferredReuse && this._isPreferredReusableLabel(normalized)) {
      return normalized;
    }

    if (await this._isReusableLabel(normalized)) {
      return normalized;
    }

    if (options.forcePreferred && normalized) {
      throw new Error(this._describeLabelConflict(normalized));
    }

    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = generate();
      if (await this._isReusableLabel(candidate)) {
        return candidate;
      }
    }

    throw new Error('Failed to generate unique subdomain');
  }

  async _isReusableLabel(label) {
    if (!label) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (RESERVED.has(label)) return false;
    if (this._isActiveLabel(label)) return false;
    return !(await isSubdomainTaken(label));
  }

  _isPreferredReusableLabel(label) {
    if (!label) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (RESERVED.has(label)) return false;
    return !this._isActiveLabel(label);
  }

  _normalizeRequestedLabel(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  }

  _isValidRequestedLabel(label) {
    if (!label) return false;
    if (label.length < 3 || label.length > 63) return false;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
    if (RESERVED.has(label)) return false;
    return true;
  }

  _describeLabelConflict(label) {
    if (!this._isValidRequestedLabel(label)) {
      return 'Custom host names must be 3-63 characters, use only a-z, 0-9, or -, and cannot start/end with -.';
    }
    if (this._isActiveLabel(label)) {
      return `The custom host name ${label} is already used by another live tunnel.`;
    }
    return `The custom host name ${label} is already reserved by another client.`;
  }

  _isActivePublicHost(hostname, clientId) {
    const normalized = normalizeDomain(hostname);
    if (!normalized) return false;

    for (const tunnel of this.tunnels.values()) {
      if (normalizeDomain(tunnel.publicHost) !== normalized) continue;
      if (clientId && tunnel.clientId === clientId) continue;
      return true;
    }

    return false;
  }

  async previewTunnelRequest(msg) {
    const tunnelType = msg.tunnelType === 'tcp' ? 'tcp' : 'http';

    if (tunnelType === 'tcp') {
      const domainChoice = this._resolvePublishDomainChoice(msg.publishDomain, null, null, 'tcp');
      if (domainChoice.error) {
        return {
          available: false,
          message: domainChoice.error,
          tunnelType,
        };
      }

      return {
        available: true,
        tunnelType,
        publishDomain: normalizeDomain(domainChoice.domain),
        publishMode: 'subdomain',
        message: `TCP tunnels will publish on ${normalizeDomain(domainChoice.domain)} with an allocated TCP port when you start the tunnel.`,
      };
    }

    const publishMode = msg.publishMode === 'root' ? 'root' : 'subdomain';
    const domainChoice = this._resolvePublishDomainChoice(msg.publishDomain, publishMode, null, 'http');
    if (domainChoice.error) {
      return {
        available: false,
        tunnelType,
        publishMode,
        message: domainChoice.error,
      };
    }

    const publishDomain = normalizeDomain(domainChoice.domain);

    if (publishMode === 'root') {
      const publicHost = publishDomain;
      if (this._isActivePublicHost(publicHost, msg.clientId || null)) {
        return {
          available: false,
          tunnelType,
          publishDomain,
          publishMode,
          publicHost,
          message: `The root host ${publicHost} is already used by another live tunnel right now.`,
        };
      }

      if (msg.clientId) {
        const savedHost = await getClientMappingByAssignedHost(publicHost);
        if (savedHost && savedHost.client_id !== msg.clientId) {
          return {
            available: false,
            tunnelType,
            publishDomain,
            publishMode,
            publicHost,
            message: `The root host ${publicHost} is already reserved by another client profile.`,
          };
        }
      }

      return {
        available: true,
        tunnelType,
        publishDomain,
        publishMode,
        publicHost,
        message: `The root host ${publicHost} is available. This tunnel profile will remember that root domain preference.`,
      };
    }

    const desiredSubdomain = this._normalizeRequestedLabel(msg.desiredSubdomain || '');
    if (!desiredSubdomain) {
      return {
        available: true,
        tunnelType,
        publishDomain,
        publishMode,
        message: `Random subdomain mode is ready on ${publishDomain}. If you type a custom host name, the server will check and reserve it for this tunnel profile.`,
      };
    }

    if (!this._isValidRequestedLabel(desiredSubdomain)) {
      return {
        available: false,
        tunnelType,
        publishDomain,
        publishMode,
        desiredSubdomain,
        message: this._describeLabelConflict(desiredSubdomain),
      };
    }

    if (this._isActiveLabel(desiredSubdomain)) {
      return {
        available: false,
        tunnelType,
        publishDomain,
        publishMode,
        desiredSubdomain,
        publicHost: `${desiredSubdomain}.${publishDomain}`,
        message: `The custom host name ${desiredSubdomain} is already used by another live tunnel.`,
      };
    }

    const [taken, clientRecord] = await Promise.all([
      isSubdomainTaken(desiredSubdomain),
      msg.clientId ? getClientMapping(msg.clientId) : null,
    ]);

    const sameClientReuse = clientRecord && clientRecord.client_id === msg.clientId && clientRecord.subdomain === desiredSubdomain;
    if (taken && !sameClientReuse) {
      return {
        available: false,
        tunnelType,
        publishDomain,
        publishMode,
        desiredSubdomain,
        publicHost: `${desiredSubdomain}.${publishDomain}`,
        message: `The custom host name ${desiredSubdomain} is already reserved by another client profile.`,
      };
    }

    return {
      available: true,
      tunnelType,
      publishDomain,
      publishMode,
      desiredSubdomain,
      publicHost: `${desiredSubdomain}.${publishDomain}`,
      remembered: true,
      message: sameClientReuse
        ? `The host ${desiredSubdomain}.${publishDomain} is already reserved for this client profile and will be reused.`
        : `The host ${desiredSubdomain}.${publishDomain} is available. PrivateTunnel will remember this host name in the saved tunnel profile.`,
    };
  }

  _isActiveLabel(label) {
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.label === label) return true;
    }

    return false;
  }

  _formatMappingError(error, publicHost) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      if (String(error.message || '').includes('idx_clients_assigned_host')) {
        return `The public host ${publicHost} is already reserved by another client.`;
      }
      if (String(error.message || '').includes('idx_clients_subdomain')) {
        return 'Could not reserve a unique tunnel label. Please reconnect and try again.';
      }
    }

    return `Could not save tunnel mapping: ${error.message}`;
  }

  _logCompletedRequest(tunnel, pending) {
    const latencyMs = Date.now() - pending.startTime;
    const publicHost = tunnel.publicHost || tunnel.label || 'unknown';
    const logEntry = {
      subdomain: publicHost,
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

    tunnel.requestLog.unshift(logEntry);
    if (tunnel.requestLog.length > 50) tunnel.requestLog.pop();

    logRequest(logEntry).catch((error) => {
      console.error('[TunnelManager] Log error:', error.message);
    });
  }

  _handleBinaryFrame(data, tunnelKey) {
    if (!tunnelKey) return;
    const tunnel = this.tunnels.get(tunnelKey);
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

  _startTcpServer(port, ws, tunnel) {
    const server = net.createServer((sock) => {
      const connId = crypto.randomUUID();
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
      console.log(`[TCP] Listening on port ${port} for tunnel ${tunnel.publicUrl || tunnel.label}`);
    });

    server.on('error', (err) => {
      console.error(`[TCP] Server error on port ${port}:`, err.message);
    });

    return server;
  }

  getTunnel(identifier) {
    const normalized = normalizeDomain(identifier);
    if (this.httpHosts.has(normalized)) {
      return this.tunnels.get(this.httpHosts.get(normalized));
    }

    return this.tunnels.get(identifier);
  }

  getHttpTunnel(hostname) {
    return this.getTunnel(hostname);
  }

  getLiveTunnels() {
    return [...this.tunnels.values()];
  }

  _disconnectExistingClientTunnel(clientId, nextWs) {
    if (!clientId) return;

    for (const [tunnelKey, tunnel] of this.tunnels.entries()) {
      if (tunnel.clientId !== clientId) continue;
      if (tunnel.ws === nextWs) continue;

      const removed = this._removeTunnel(tunnelKey);
      if (removed && removed.ws && removed.ws.readyState === removed.ws.OPEN) {
        try {
          sendControl(removed.ws, {
            type: MSG.TUNNEL_ERROR,
            message: 'This tunnel was replaced by a newer connection for the same client.',
          });
        } catch {}

        try {
          removed.ws.close();
        } catch {}
      }
    }
  }

  _removeTunnel(tunnelKey) {
    const tunnel = this.tunnels.get(tunnelKey);
    if (!tunnel) return null;

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

    if (tunnel.publicHost) {
      this.httpHosts.delete(normalizeDomain(tunnel.publicHost));
    }

    this.tunnels.delete(tunnelKey);
    return tunnel;
  }
}

module.exports = TunnelManager;
