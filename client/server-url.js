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

module.exports = {
  DEFAULT_TUNNEL_WS_PATH,
  normalizeServerWebSocketUrl,
};
