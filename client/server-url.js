const DEFAULT_TUNNEL_WS_PATH = '/_private-tunnel/ws';

function normalizeServerWebSocketUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';

  if (!/^[a-z]+:\/\//i.test(raw)) {
    raw = `wss://${raw}`;
  }

  raw = raw.replace(/^http:\/\//i, 'ws://');
  raw = raw.replace(/^https:\/\//i, 'wss://');

  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = DEFAULT_TUNNEL_WS_PATH;
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function requireSecureServerWebSocketUrl(value) {
  const normalized = normalizeServerWebSocketUrl(value);
  const url = new URL(normalized);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Use a WebSocket server URL without embedded credentials or fragments.');
  }
  if (url.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    const error = new Error('Use wss:// for a remote server. Unencrypted ws:// is allowed only on localhost.');
    error.code = 'EINSECURETRANSPORT';
    throw error;
  }
  return url.toString();
}

module.exports = {
  DEFAULT_TUNNEL_WS_PATH,
  normalizeServerWebSocketUrl,
  requireSecureServerWebSocketUrl,
};
