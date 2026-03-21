const { MSG, FRAME_REQUEST_BODY, generateRequestId, sendControl, sendData } = require('../shared/protocol');

const REQUEST_TIMEOUT = 30000;

function handleProxy(req, res, subdomain, tunnelManager) {
  const tunnel = tunnelManager.getTunnel(subdomain);

  if (!tunnel) {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(`<html><body><h1>502 Bad Gateway</h1><p>Tunnel not found: ${subdomain}</p></body></html>`);
    return;
  }

  if (tunnel.ws.readyState !== tunnel.ws.OPEN) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Tunnel client disconnected');
    return;
  }

  const requestId = generateRequestId();
  tunnel.stats.connections++;

  // Extract visitor info
  const visitorIp = req.headers['x-real-ip']
    || req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']
    || req.socket.remoteAddress;

  const timeout = setTimeout(() => {
    if (tunnel.pendingRequests.has(requestId)) {
      tunnel.pendingRequests.delete(requestId);
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
      }
      res.end('Gateway Timeout');
    }
  }, REQUEST_TIMEOUT);

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
    reqContentLength: req.headers['content-length'] ? parseInt(req.headers['content-length']) : null,
    statusCode: null,
    error: null,
  });

  // Track bytes in
  req.on('data', (chunk) => {
    tunnel.stats.bytesIn += chunk.length;
    sendData(tunnel.ws, FRAME_REQUEST_BODY, requestId, chunk);
  });

  // Forward request headers to client
  const headers = { ...req.headers };
  sendControl(tunnel.ws, {
    type: MSG.REQUEST_START,
    requestId,
    method: req.method,
    path: req.url,
    headers,
  });

  req.on('end', () => {
    sendControl(tunnel.ws, { type: MSG.STREAM_END, requestId, direction: 'request' });
  });

  req.on('error', (err) => {
    sendControl(tunnel.ws, { type: MSG.STREAM_ERROR, requestId, message: err.message });
  });
}

module.exports = { handleProxy };
