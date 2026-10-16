const net = require('node:net');
const { validateHeaderName, validateHeaderValue } = require('node:http');
const crypto = require('node:crypto');
const { redactLogUrl } = require('./security');
const { MSG, FRAME_RESPONSE_BODY, FRAME_TCP_DATA, PROTOCOL_VERSION, DATA_TRANSPORT_VERSION, TCP_END,
  selectTransport, getTransportVersion, receiveControl, decodeDataFrame, sendControl, sendData, writeFrame, discardFrame, cancelStream } = require('../shared/tunnel-v4');
const { generate, RESERVED } = require('./subdomain');
const { getClientMapping, getClientMappingByAssignedHost, isSubdomainTaken, saveMapping, touchClient, logRequest } = require('./db');
const { openPort, closePort } = require('./firewall');
const { normalizeDomain, buildHttpHost, getTcpAddress, getTunnelHttpOrigin } = require('./routing');
const { bindClientIdentity } = require('./tunnel-identity');
const { createTcpVisitorFilter } = require('./tcp-access');
const { parseTcpAllowedPorts, publicTcpPorts } = require('./tcp-ports');

class TunnelManager {
  constructor(runtimeConfig) {
    this.runtimeConfig = runtimeConfig || {};
    this.tunnels = new Map();
    this.httpHosts = new Map();
    const idleTimeout = Number(this.runtimeConfig.requestIdleTimeoutMs ?? 30000);
    if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 50 || idleTimeout > 3600000) {
      throw new Error('HTTP_IDLE_TIMEOUT_MS must be an integer between 50 and 3600000.');
    }
    this.requestIdleTimeoutMs = idleTimeout;
    if (this.runtimeConfig.tcpBindHost && !net.isIP(this.runtimeConfig.tcpBindHost)) {
      throw new Error('TCP_BIND_HOST must be a local interface IP address.');
    }
    this.allowTcpVisitor = createTcpVisitorFilter(this.runtimeConfig.tcpVisitorAllowlist || '');
    this.tcpPortRanges = parseTcpAllowedPorts(this.runtimeConfig.tcpAllowedPorts);
  }

  handleNewClient(ws, clientIp) {
    let assignedTunnelKey = null;
    let opening = false;
    let checking = false;
    let closed = false;
    const removeAssignedTunnel = () => {
      const tunnel = this.tunnels.get(assignedTunnelKey);
      const removed = tunnel && tunnel.ws === ws ? this._removeTunnel(assignedTunnelKey, tunnel) : null;
      assignedTunnelKey = null;
      return removed;
    };
    const reportError = (error) => {
      const message = error && error.message ? error.message : 'Tunnel error';
      console.error('[TunnelManager] Control error:', message);
      if (!closed && ws.readyState === ws.OPEN) {
        sendControl(ws, { type: MSG.TUNNEL_ERROR, message });
      }
    };
    const setTunnelKey = (tunnelKey) => {
      if (tunnelKey && (closed || ws.readyState !== ws.OPEN)) {
        const tunnel = this.tunnels.get(tunnelKey);
        if (tunnel && tunnel.ws === ws) this._removeTunnel(tunnelKey, tunnel);
        return;
      }
      assignedTunnelKey = tunnelKey;
    };

    ws.on('message', (data, isBinary) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      let msg;
      try {
        if (isBinary) {
          const frame = decodeDataFrame(data, ws);
          if (!frame) return;
          if (this.tunnels.get(assignedTunnelKey)?.ws === ws) {
            this._handleBinaryFrame(null, assignedTunnelKey, frame);
          } else {
            discardFrame(ws, frame);
          }
          return;
        }
        msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
          throw new Error('Invalid control message');
        }
      } catch (error) {
        reportError(error);
        return;
      }

      const isOpening = msg.type === MSG.TUNNEL_OPEN;
      const isChecking = msg.type === MSG.TUNNEL_CHECK;
      if (isChecking) {
        if (checking) {
          sendControl(ws, { type: MSG.TUNNEL_CHECK_RESULT, available: false, message: 'A route check is already in progress.' });
          return;
        }
        checking = true;
      }
      if (isOpening) {
        if (opening) {
          sendControl(ws, { type: MSG.TUNNEL_ERROR, message: 'A tunnel is already being opened on this connection.' });
          return;
        }
        opening = true;
      }
      // Invoke stream controls now: a following binary message must not overtake its headers/FIN.
      let operation;
      try {
        if (!receiveControl(ws, msg)) return;
        operation = this._handleControlMessage(ws, msg, assignedTunnelKey, clientIp, setTunnelKey);
      } catch (error) { operation = Promise.reject(error); }
      Promise.resolve(operation).catch((error) => {
        if (isOpening) removeAssignedTunnel();
        reportError(error);
      }).finally(() => {
        if (isOpening) opening = false;
        if (isChecking) checking = false;
      });
    });

    ws.on('close', () => {
      closed = true;
      const removed = removeAssignedTunnel();
      if (removed) {
        console.log(`[TunnelManager] Tunnel closed: ${removed.publicHost || removed.label || removed.tunnelKey}`);
      }
    });

    ws.on('error', (err) => {
      console.error('[TunnelManager] WebSocket error:', err.message);
    });

    ws.tunnelMissedPongs = 0;
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        if (ws.tunnelMissedPongs >= 2) {
          clearInterval(pingInterval);
          ws.terminate();
          return;
        }
        ws.tunnelMissedPongs++;
        sendControl(ws, { type: MSG.PING });
      } else {
        clearInterval(pingInterval);
      }
    }, 30000);
    pingInterval.unref?.();

    ws.on('close', () => clearInterval(pingInterval));
  }

  async _handleControlMessage(ws, msg, currentTunnelKey, clientIp, setTunnelKey) {
    if (msg.type === MSG.TUNNEL_OPEN || msg.type === MSG.TUNNEL_CHECK) {
      msg = { ...msg, clientId: bindClientIdentity(ws.tunnelPrincipal, msg.clientId) };
    }
    if (currentTunnelKey && this.tunnels.get(currentTunnelKey)?.ws !== ws) {
      currentTunnelKey = null;
      setTunnelKey(null);
    }
    switch (msg.type) {
      case MSG.TUNNEL_OPEN: {
        if (Object.prototype.hasOwnProperty.call(msg, 'protocolVersion') && msg.protocolVersion !== PROTOCOL_VERSION) {
          sendControl(ws, { type: MSG.TUNNEL_ERROR, message: 'Unsupported tunnel protocol version.' });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(msg, 'dataTransportVersions')
          && (!Array.isArray(msg.dataTransportVersions) || msg.dataTransportVersions.length > 8
            || msg.dataTransportVersions.some((value) => !Number.isSafeInteger(value) || value < 1))) {
          sendControl(ws, {type: MSG.TUNNEL_ERROR, message: 'Invalid data transport capabilities.'});
          return;
        }
        const selectedVersion = msg.dataTransportVersions?.includes(DATA_TRANSPORT_VERSION) ? DATA_TRANSPORT_VERSION : 1;
        if (selectedVersion !== DATA_TRANSPORT_VERSION && this.runtimeConfig.requireDataTransportV4) {
          sendControl(ws, { type: MSG.TUNNEL_ERROR, message: 'Update your client: this server requires data transport v4.' });
          return;
        }
        if ((currentTunnelKey || getTransportVersion(ws) === DATA_TRANSPORT_VERSION)
          && selectedVersion !== getTransportVersion(ws)) {
          sendControl(ws, {type: MSG.TUNNEL_ERROR, message: 'Reconnect to change the data transport.'});
          return;
        }
        if (selectedVersion === DATA_TRANSPORT_VERSION) selectTransport(ws, selectedVersion, {isServer: true});
        if (currentTunnelKey) {
          this._removeTunnel(currentTunnelKey);
          setTunnelKey(null);
        }

        const tunnelType = msg.tunnelType === 'tcp' ? 'tcp' : 'http';
        const clientRecord = msg.clientId ? await getClientMapping(msg.clientId) : null;
        if (ws.readyState !== ws.OPEN) return;
        if (msg.clientId) {
          await touchClient(msg.clientId, clientIp);
          if (ws.readyState !== ws.OPEN) return;
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
        if (ws.readyState !== ws.OPEN) return;
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
          sock._tunnelRemoteReset = true;
          sock.destroy();
          tunnel.tcpConnections.delete(msg.connId);
        }
        break;
      }

      case TCP_END: {
        if (getTransportVersion(ws) === DATA_TRANSPORT_VERSION) {
          this.tunnels.get(currentTunnelKey)?.tcpConnections?.get(msg.connId)?.end();
        }
        break;
      }

      case MSG.RESPONSE_START: {
        if (!currentTunnelKey) return;
        const tunnel = this.tunnels.get(currentTunnelKey);
        if (!tunnel) return;

        const pending = tunnel.pendingRequests.get(msg.requestId);
        if (!pending) return;

        try {
          if (!Number.isInteger(msg.statusCode) || msg.statusCode < 100 || msg.statusCode > 999) {
            throw new Error('Invalid response status');
          }
          if (!msg.headers || typeof msg.headers !== 'object' || Array.isArray(msg.headers)) {
            throw new Error('Invalid response headers');
          }
          const headers = { ...msg.headers };
          for (const [name, value] of Object.entries(headers)) {
            validateHeaderName(name);
            for (const item of Array.isArray(value) ? value : [value]) {
              if (typeof item !== 'string' && typeof item !== 'number') throw new Error('Invalid response header value');
              validateHeaderValue(name, item);
            }
            if (name.toLowerCase() === 'transfer-encoding') delete headers[name];
          }
          pending.res.writeHead(msg.statusCode, headers);
          pending.statusCode = msg.statusCode;
          pending.timeout?.refresh?.();
        } catch {
          this._failPendingResponse(tunnel, msg.requestId, 'Invalid response metadata');
        }
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

        this._failPendingResponse(tunnel, msg.requestId, msg.message || 'Unknown error', { notifyPeer: false });
        break;
      }

      case MSG.PONG:
        ws.tunnelMissedPongs = 0;
        break;

      case MSG.TUNNEL_CLOSE: {
        if (currentTunnelKey) this._removeTunnel(currentTunnelKey);
        setTunnelKey(null);
        ws.close();
        break;
      }
    }
  }

  async _openHttpTunnel(ws, msg, clientIp, clientRecord, setTunnelKey) {
    const assignment = await this._resolveHttpAssignment(msg, clientRecord);
    if (ws.readyState !== ws.OPEN) return;
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
        this._removeTunnel(tunnelKey, tunnel);
        setTunnelKey(null);
        if (ws.readyState !== ws.OPEN) return;
        sendControl(ws, {
          type: MSG.TUNNEL_ERROR,
          message: this._formatMappingError(error, assignment.publicHost),
        });
        return;
      }
    }

    if (ws.readyState !== ws.OPEN || this.tunnels.get(tunnelKey) !== tunnel) {
      this._removeTunnel(tunnelKey, tunnel);
      setTunnelKey(null);
      return;
    }

    const assigned = sendControl(ws, {
      type: MSG.TUNNEL_ASSIGNED,
      dataTransportVersion: tunnel.dataTransportVersion,
      tunnelType: 'http',
      subdomain: assignment.label,
      publicHost: assignment.publicHost,
      publishDomain: assignment.publishDomain,
      publishMode: assignment.publishMode,
      url: tunnel.publicUrl,
    });
    if (!assigned) { this._removeTunnel(tunnelKey, tunnel); setTunnelKey(null); return; }
    tunnel.ready = true;
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
    if (ws.readyState !== ws.OPEN) return;
    const tunnel = this._createBaseTunnel(ws, msg, clientIp, clientRecord, {
      tunnelKey: null,
      label,
      publicHost: normalizeDomain(domainChoice.domain),
      publishDomain: normalizeDomain(domainChoice.domain),
      publishMode: 'subdomain',
      publicUrl: '',
    });

    tunnel.tcpConnections = new Map();
    const tcpPort = await this._startTcpServer(ws, tunnel);
    if (!tcpPort) return;
    if (ws.readyState !== ws.OPEN) {
      try { tunnel.tcpServer.close(); } catch {}
      return;
    }

    const tunnelKey = `tcp:${tcpPort}`;
    tunnel.tunnelKey = tunnelKey;
    tunnel.tcpPort = tcpPort;
    tunnel.publicUrl = getTcpAddress(tcpPort, domainChoice.domain);
    this.tunnels.set(tunnelKey, tunnel);
    setTunnelKey(tunnelKey);
    try {
      if (openPort(tcpPort, { host: this.runtimeConfig.tcpBindHost }) !== true) {
        throw new Error('Could not open the TCP firewall rule. Configure the firewall and TCP_ALLOWED_PORTS before retrying.');
      }
    } catch (error) {
      this._removeTunnel(tunnelKey, tunnel);
      setTunnelKey(null);
      throw error;
    }

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

    if (ws.readyState !== ws.OPEN || this.tunnels.get(tunnelKey) !== tunnel) {
      this._removeTunnel(tunnelKey, tunnel);
      setTunnelKey(null);
      return;
    }

    const assigned = sendControl(ws, {
      type: MSG.TUNNEL_ASSIGNED,
      dataTransportVersion: tunnel.dataTransportVersion,
      tunnelType: 'tcp',
      subdomain: label,
      publicHost: normalizeDomain(domainChoice.domain),
      publishDomain: normalizeDomain(domainChoice.domain),
      url: tunnel.publicUrl,
      tcpPort,
    });
    if (!assigned) { this._removeTunnel(tunnelKey, tunnel); setTunnelKey(null); return; }
    tunnel.ready = true;
    console.log(`[TunnelManager] TCP tunnel: ${domainChoice.domain}:${tcpPort} -> localhost:${msg.localPort} from ${clientIp}`);
  }

  _createBaseTunnel(ws, msg, clientIp, clientRecord, details) {
    return {
      ws,
      dataTransportVersion: getTransportVersion(ws),
      ready: false,
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
      allowPreferredReuse: Boolean(clientRecord && clientRecord.subdomain && (!requestedLabel || requestedLabel === clientRecord.subdomain)),
      forcePreferred: Boolean(requestedLabel),
    });
    const publicHost = buildHttpHost(label, domainChoice.domain, publishMode);
    if (!publicHost) {
      return { error: 'Could not generate a public host for this tunnel.' };
    }
    if (await this._isPublicHostReserved(publicHost, msg.clientId)) {
      return { error: `The public host ${publicHost} is already reserved by another client profile.` };
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

  async _isPublicHostReserved(publicHost, clientId) {
    const savedHost = await getClientMappingByAssignedHost(publicHost);
    return Boolean(savedHost && (!clientId || savedHost.client_id !== clientId));
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

      if (await this._isPublicHostReserved(publicHost, msg.clientId)) {
        return {
          available: false,
          tunnelType,
          publishDomain,
          publishMode,
          publicHost,
          message: `The root host ${publicHost} is already reserved by another client profile.`,
        };
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
    if (process.env.REQUEST_LOGGING === 'false') return;
    const latencyMs = Date.now() - pending.startTime;
    const publicHost = tunnel.publicHost || tunnel.label || 'unknown';
    const logEntry = {
      subdomain: publicHost,
      clientId: tunnel.clientId,
      visitorIp: pending.visitorIp,
      method: pending.method,
      path: redactLogUrl(pending.path),
      host: pending.host,
      userAgent: pending.userAgent,
      referer: redactLogUrl(pending.referer),
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

  _handleBinaryFrame(data, tunnelKey, decodedFrame) {
    if (!tunnelKey) return;
    const tunnel = this.tunnels.get(tunnelKey);
    if (!tunnel) return;

    const frame = decodedFrame || decodeDataFrame(data, tunnel.ws);
    if (!frame) return;

    if (frame.frameType === FRAME_RESPONSE_BODY) {
      const pending = tunnel.pendingRequests.get(frame.requestId);
      if (pending && !pending.res.destroyed) {
        try {
          if (writeFrame(tunnel.ws, frame, pending.res)) {
            tunnel.stats.bytesOut += frame.data.length;
            pending.timeout?.refresh?.();
          } else {
            this._failPendingResponse(tunnel, frame.requestId, 'Response buffer limit exceeded');
          }
        } catch {
          this._failPendingResponse(tunnel, frame.requestId, 'Could not write response body');
        }
      } else {
        discardFrame(tunnel.ws, frame);
      }
    } else if (frame.frameType === FRAME_TCP_DATA) {
      const sock = tunnel.tcpConnections && tunnel.tcpConnections.get(frame.requestId);
      if (sock && !sock.destroyed) {
        try {
          if (writeFrame(tunnel.ws, frame, sock)) tunnel.stats.bytesOut += frame.data.length;
          else sock.destroy();
        } catch {
          sock.destroy();
        }
      } else {
        discardFrame(tunnel.ws, frame);
      }
    } else {
      discardFrame(tunnel.ws, frame);
    }
  }

  _failPendingResponse(tunnel, requestId, message, { statusCode = 502, notifyPeer = true } = {}) {
    const pending = tunnel.pendingRequests.get(requestId);
    if (!pending) return;
    tunnel.pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.statusCode = pending.res.headersSent ? (pending.statusCode || 200) : statusCode;
    pending.error = message;
    try {
      if (!pending.res.destroyed) {
        if (pending.res.headersSent) pending.res.destroy();
        else {
          pending.res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
          pending.res.end(statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway');
        }
      }
    } catch {
      try { pending.res.destroy(); } catch {}
    }
    this._logCompletedRequest(tunnel, pending);
    if (notifyPeer) sendControl(tunnel.ws, { type: MSG.STREAM_ERROR, requestId, message });
  }

  _startTcpServer(ws, tunnel) {
    const modern = getTransportVersion(ws) === DATA_TRANSPORT_VERSION;
    const server = net.createServer({allowHalfOpen: modern}, (sock) => {
      if (ws.readyState !== ws.OPEN || this.tunnels.get(tunnel.tunnelKey) !== tunnel
        || !tunnel.ready || tunnel.tcpConnections.size >= 128
        || !this.allowTcpVisitor(sock.remoteAddress)) {
        sock.destroy();
        return;
      }
      const connId = crypto.randomUUID();
      tunnel.tcpConnections.set(connId, sock);
      tunnel.stats.connections++;
      sock.setTimeout(5 * 60 * 1000, () => sock.destroy());
      sock.setNoDelay?.(true);
      sock.setKeepAlive?.(true, 30000);

      if (!sendControl(ws, { type: MSG.TCP_CONNECT, connId })) {
        tunnel.tcpConnections.delete(connId);
        sock.destroy();
        return;
      }

      sock.on('data', (chunk) => {
        tunnel.stats.bytesIn += chunk.length;
        if (ws.readyState === ws.OPEN) {
          if (!sendData(ws, FRAME_TCP_DATA, connId, chunk, sock)) sock.destroy();
        }
      });

      sock.on('end', () => {
        if (modern) sendControl(ws, {type: TCP_END, connId});
      });

      sock.on('close', (hadError) => {
        tunnel.tcpConnections.delete(connId);
        if (!sock._tunnelRemoteReset && (hadError || !modern || !sock.readableEnded || !sock.writableFinished)
          && ws.readyState === ws.OPEN) {
          sendControl(ws, { type: MSG.TCP_CLOSE, connId });
        }
      });

      sock.on('error', () => sock.destroy());
    });

    tunnel.tcpServer = server;
    return new Promise((resolve, reject) => {
      let settled = false;
      let allocatedPort = null;
      let candidatePort = null;
      let retry = null;
      const ports = publicTcpPorts(this.tcpPortRanges);
      const finish = (error, port) => {
        if (settled) return;
        settled = true;
        allocatedPort = port || null;
        if (retry) clearImmediate(retry);
        retry = null;
        ws.removeListener('close', onDisconnect);
        server.removeListener('listening', onListening);
        if (error || !port) {
          try { server.close(); } catch {}
        }
        if (error) reject(error);
        else resolve(port);
      };
      const onDisconnect = () => finish(null, null);
      const onListening = () => {
        const address = server.address();
        if (!address || address.port !== candidatePort) {
          finish(new Error('Could not determine the public TCP port.'));
          return;
        }
        if (ws.readyState !== ws.OPEN) {
          finish(null, null);
          return;
        }
        console.log(`[TCP] Listening on port ${address.port} for tunnel ${tunnel.label}`);
        finish(null, address.port);
      };
      const onError = (error) => {
        if (!settled) {
          if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
            // Windows can reserve/exclude a port even without an active listener.
            // Yield between attempts so exhausted ranges cannot block other tunnels
            // or delay cancellation when the client disconnects.
            if (!retry) retry = setImmediate(listenNext);
            return;
          }
          console.error(`[TCP] Could not bind port ${candidatePort}:`, error.message);
          finish(error);
          return;
        }
        if (!allocatedPort) return;
        console.error(`[TCP] Server error on port ${allocatedPort}:`, error.message);
        const removed = this._removeTunnel(tunnel.tunnelKey, tunnel);
        if (removed && ws.readyState === ws.OPEN) {
          sendControl(ws, { type: MSG.TUNNEL_ERROR, message: 'Could not listen on the allocated TCP port.' });
        }
      };
      const listenNext = () => {
        retry = null;
        if (settled) return;
        if (ws.readyState !== ws.OPEN) return onDisconnect();
        const next = ports.next();
        if (next.done) {
          finish(new Error('No public TCP port is available in TCP_ALLOWED_PORTS. Allocation order: 30000-40000, 40001-65535, 1024-29999. Open firewall/NAT rules and configure TCP_ALLOWED_PORTS before using additional ports.'));
          return;
        }
        candidatePort = next.value;
        try {
          // Keep the actual listener bound throughout setup; do not probe then
          // release the candidate before binding the public tunnel.
          if (this.runtimeConfig.tcpBindHost) server.listen(candidatePort, this.runtimeConfig.tcpBindHost);
          else server.listen(candidatePort);
        } catch (error) {
          onError(error);
        }
        if (ws.readyState !== ws.OPEN) onDisconnect();
      };
      ws.once('close', onDisconnect);
      server.once('listening', onListening);
      server.on('error', onError);
      listenNext();
    });
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

  _removeTunnel(tunnelKey, expectedTunnel) {
    const tunnel = this.tunnels.get(tunnelKey);
    if (!tunnel || (expectedTunnel && tunnel !== expectedTunnel)) return null;

    this.tunnels.delete(tunnelKey);
    if (this.httpHosts.get(normalizeDomain(tunnel.publicHost)) === tunnelKey) {
      this.httpHosts.delete(normalizeDomain(tunnel.publicHost));
    }

    for (const [requestId, pending] of tunnel.pendingRequests) {
      cancelStream(tunnel.ws, requestId);
      this._failPendingResponse(tunnel, requestId, 'Tunnel disconnected', { notifyPeer: false });
    }
    tunnel.pendingRequests.clear();

    if (tunnel.tcpServer) {
      try { tunnel.tcpServer.close(); } catch {}
    }
    if (tunnel.tcpPort) {
      closePort(tunnel.tcpPort);
    }

    if (tunnel.tcpConnections) {
      for (const [connId, sock] of tunnel.tcpConnections) {
        cancelStream(tunnel.ws, connId);
        try { sock.destroy(); } catch {}
      }
      tunnel.tcpConnections.clear();
    }

    return tunnel;
  }
}

module.exports = TunnelManager;
