const { MSG, FRAME_REQUEST_BODY, DATA_TRANSPORT_VERSION, generateRequestId, sendControl, sendData } = require('../shared/tunnel-v4');
const { normalizeDomain } = require('./routing');
const { clientIp } = require('./security');

function handleProxy(req, res, publicHost, tunnelManager) {
  const host = normalizeDomain(publicHost);
  const tunnel = tunnelManager.getHttpTunnel(host);

  if (!tunnel) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Tunnel not found: ${host}`);
    return;
  }

  if (tunnel.ws.readyState !== tunnel.ws.OPEN) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Tunnel client disconnected');
    return;
  }
  if (tunnel.dataTransportVersion === DATA_TRANSPORT_VERSION && !tunnel.ready) {
    res.writeHead(503, {'Content-Type': 'text/plain', 'Retry-After': '1'});
    res.end('Tunnel setup is still completing');
    return;
  }
  if (tunnel.pendingRequests.size >= 128) {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
    res.end('This tunnel is busy. Try again shortly.');
    return;
  }

  const requestId = generateRequestId();
  tunnel.stats.connections++;

  // Extract visitor info
  const visitorIp = clientIp(req);

  const timeout = setTimeout(() => {
    tunnelManager._failPendingResponse(tunnel, requestId, 'Gateway Timeout', { statusCode: 504 });
  }, tunnelManager.requestIdleTimeoutMs || 30000);
  timeout.unref?.();

  // Register pending request with visitor details
  tunnel.pendingRequests.set(requestId, {
    req, res, timeout,
    startTime: Date.now(),
    visitorIp,
    method: req.method,
    path: req.url,
    host: req.headers.host,
    userAgent: req.headers['user-agent'] || null,
    referer: req.headers['referer'] || null,
    reqContentType: req.headers['content-type'] || null,
    reqContentLength: req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : null,
    statusCode: null,
    error: null,
  });

  // Track bytes in
  req.on('data', (chunk) => {
    if (!tunnel.pendingRequests.has(requestId)) return;
    timeout.refresh();
    tunnel.stats.bytesIn += chunk.length;
    if (!sendData(tunnel.ws, FRAME_REQUEST_BODY, requestId, chunk, req)) {
      tunnelManager._failPendingResponse(tunnel, requestId, 'Request queue limit exceeded');
      req.resume();
    }
  });

  // Forward request headers to client
  const headers = { ...req.headers };
  const started = sendControl(tunnel.ws, {
    type: MSG.REQUEST_START,
    requestId,
    method: req.method,
    path: req.url,
    headers,
  });
  if (!started) {
    tunnelManager._failPendingResponse(tunnel, requestId, 'Could not forward request headers');
    req.resume();
    return;
  }

  req.on('end', () => {
    if (!tunnel.pendingRequests.has(requestId)) return;
    timeout.refresh();
    sendControl(tunnel.ws, { type: MSG.STREAM_END, requestId, direction: 'request' });
  });

  req.on('error', (err) => {
    tunnelManager._failPendingResponse(tunnel, requestId, err.message);
  });

  req.on('aborted', () => {
    if (tunnel.pendingRequests.has(requestId)) {
      clearTimeout(timeout);
      tunnel.pendingRequests.delete(requestId);
      sendControl(tunnel.ws, { type: MSG.STREAM_ERROR, requestId, message: 'Client aborted the request' });
    }
  });

  res.on('close', () => {
    if (tunnel.pendingRequests.has(requestId) && !res.writableEnded) {
      clearTimeout(timeout);
      tunnel.pendingRequests.delete(requestId);
      sendControl(tunnel.ws, { type: MSG.STREAM_ERROR, requestId, message: 'Client disconnected before the response finished' });
    }
  });
}

module.exports = { handleProxy };
