const { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu, nativeImage, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const { pathToFileURL } = require('node:url');
const { getExternalWebUrl, validateTunnelInput } = require('./security');
const WebSocket = require('ws');
const { normalizeServerWebSocketUrl } = require('../client/server-url');
const { MSG, sendControl } = require('../shared/protocol');

const CONFIG_PATH = path.resolve(
  process.env.PTUNNEL_CONFIG_PATH
  || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.ptunnel')
);

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(nextConfig) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2), { encoding: 'utf-8', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(CONFIG_PATH, 0o600);
}

function normalizeDesiredSubdomain(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTunnelConfig(tunnel) {
  return {
    ...tunnel,
    publishDomain: String(tunnel.publishDomain || '').trim().toLowerCase(),
    publishMode: tunnel.publishMode === 'root' ? 'root' : 'subdomain',
    desiredSubdomain: normalizeDesiredSubdomain(tunnel.desiredSubdomain || ''),
  };
}

function validateServerProfileInput(url, token) {
  const errors = {};
  const rawUrl = String(url || '').trim();
  const rawToken = String(token || '').trim();
  const normalizedUrl = normalizeServerWebSocketUrl(rawUrl);

  if (!rawUrl) {
    errors.serverUrl = 'Server WebSocket URL is required.';
  } else {
    try {
      const parsed = new URL(normalizedUrl);
      if (!/^wss?:$/i.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
        errors.serverUrl = 'Server URL must start with ws:// or wss://.';
      }
    } catch {
      errors.serverUrl = 'Enter a valid server hostname or WebSocket URL.';
    }
  }

  if (!rawToken) {
    errors.token = 'Access token is required before this GUI can create tunnels.';
  } else if (rawToken.length < 6) {
    errors.token = 'Access token looks too short. Paste the full token from the server hoster.';
  } else if (rawToken.length > 4096 || /[\r\n]/.test(rawToken)) {
    errors.token = 'Paste a single access key without line breaks.';
  }

  return {
    ok: !errors.serverUrl && !errors.token,
    errors,
    normalizedUrl,
    token: rawToken,
  };
}

function buildAuthenticatedWebSocketUrl(serverUrl) {
  const url = new URL(normalizeServerWebSocketUrl(serverUrl));
  url.searchParams.delete('token');
  return url.toString();
}

async function checkTunnelConfigWithServer({
  serverUrl,
  token,
  type,
  publishDomain,
  publishMode,
  desiredSubdomain,
  clientId,
}) {
  if (!serverUrl || !token) {
    return {
      available: false,
      message: 'Save the server profile first before checking custom host names.',
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(payload);
    };

    const ws = new WebSocket(buildAuthenticatedWebSocketUrl(serverUrl), {
      headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000, maxPayload: 1024 * 1024,
    });
    const timeout = setTimeout(() => {
      finish({
        available: false,
        message: 'The server did not respond to the host-name check in time.',
      });
    }, 20000);

    ws.on('open', () => {
      sendControl(ws, {
        type: MSG.TUNNEL_CHECK,
        tunnelType: type === 'tcp' ? 'tcp' : 'http',
        publishDomain: String(publishDomain || '').trim(),
        publishMode: publishMode === 'root' ? 'root' : 'subdomain',
        desiredSubdomain: normalizeDesiredSubdomain(desiredSubdomain || ''),
        clientId: clientId || null,
      });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === MSG.TUNNEL_CHECK_RESULT) {
          finish({ ...msg, reachable: true });
        } else if (msg.type === MSG.TUNNEL_ERROR) {
          finish({
            available: false,
            message: msg.message || 'The server rejected this tunnel configuration.',
          });
        }
      } catch {
        finish({
          available: false,
          message: 'Could not understand the server response while checking this host name.',
        });
      }
    });

    ws.on('close', (code) => {
      if (settled) return;
      if (code === 4001) {
        finish({
          available: false,
          message: 'The saved token is invalid for this server.',
          code: 'EUNAUTHORIZED',
        });
        return;
      }
      finish({
        available: false,
        message: 'The server closed the connection before returning a host-name check result.',
      });
    });

    ws.on('error', (error) => {
      finish({
        available: false,
        message: error && /Unexpected server response: 401/.test(error.message)
          ? 'The saved token is invalid for this server.'
          : error && error.message
          ? `Could not reach the server: ${error.message}`
          : 'Could not reach the server for this validation request.',
      });
    });
  });
}

let config = loadConfig();
if (!config.clientId) config.clientId = crypto.randomUUID();
if (!Array.isArray(config.tunnels)) config.tunnels = [];
if (config.serverUrl) config.serverUrl = normalizeServerWebSocketUrl(config.serverUrl);
config.token = String(config.token || '').trim() || null;
config.tunnels = config.tunnels.map(normalizeTunnelConfig);
saveConfig(config);

const tunnelInstances = new Map();
const pendingStarts = new Map();

function isLocalServiceReady(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: 'localhost', port });
    const finish = (ready) => { socket.destroy(); resolve(ready); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
let mainWindow = null;
let tray = null;
let isQuitting = false;
const RENDERER_PATH = path.join(__dirname, 'renderer', 'index.html');

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame
      || event.senderFrame.url !== pathToFileURL(RENDERER_PATH).href) {
      throw new Error('Untrusted application frame.');
    }
    return handler(event, ...args);
  });
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 380,
    minHeight: 540,
    useContentSize: true,
    resizable: true,
    maximizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.loadFile(RENDERER_PATH);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  const iconData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAA'
    + 'N0lEQVQ4jWNgGAWjgB5g////BwMDA8P/////MzAwMDCMWjAKhj8AAP//AwBnFiYBAAAA'
    + 'ABJRU5ErkJggg==',
    'base64'
  );
  const icon = nativeImage.createFromBuffer(iconData);
  tray = new Tray(icon);
  tray.setToolTip('PrivateTunnel');

  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow && (mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show()));
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  for (const [, client] of tunnelInstances) {
    try { client.disconnect(); } catch {}
  }
});

handleTrusted('get-config', () => ({
  ...config,
  configPath: CONFIG_PATH,
}));

handleTrusted('validate-server-profile', (_, payload) => {
  const result = validateServerProfileInput(payload && payload.serverUrl, payload && payload.token);
  return {
    ok: result.ok,
    errors: result.errors,
    normalizedUrl: result.normalizedUrl,
  };
});

handleTrusted('test-server-profile', async (_, payload) => {
  const result = validateServerProfileInput(payload && payload.serverUrl, payload && payload.token);
  if (!result.ok) return { ok: false, errors: result.errors };
  const check = await checkTunnelConfigWithServer({ serverUrl: result.normalizedUrl, token: result.token, type: 'http' });
  return { ok: check.reachable === true, message: check.reachable ? 'Server connection verified.' : check.message };
});

handleTrusted('save-server-profile', (_, payload) => {
  const result = validateServerProfileInput(payload && payload.serverUrl, payload && payload.token);
  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors,
      normalizedUrl: result.normalizedUrl,
    };
  }

  config.serverUrl = result.normalizedUrl;
  config.token = result.token;
  saveConfig(config);
  return {
    ok: true,
    serverUrl: config.serverUrl,
    tokenSaved: true,
  };
});

handleTrusted('check-tunnel-config', async (_, payload) => {
  return checkTunnelConfigWithServer({
    serverUrl: config.serverUrl,
    token: config.token,
    type: payload && payload.type,
    publishDomain: payload && payload.publishDomain,
    publishMode: payload && payload.publishMode,
    desiredSubdomain: payload && payload.desiredSubdomain,
    clientId: payload && payload.clientId,
  });
});

handleTrusted('add-tunnel', (_, payload) => {
  const validated = validateTunnelInput(payload);
  const requestedClientId = typeof payload.clientId === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(payload.clientId)
    ? payload.clientId : crypto.randomUUID();
  const tunnel = normalizeTunnelConfig({
    id: crypto.randomUUID(),
    clientId: requestedClientId,
    ...validated,
  });

  tunnel.name = tunnel.name || (tunnel.type === 'http' ? `HTTP :${tunnel.port}` : `TCP :${tunnel.port}`);

  config.tunnels.push(tunnel);
  saveConfig(config);
  return tunnel;
});

handleTrusted('delete-tunnel', (_, id) => {
  pendingStarts.delete(id);
  const client = tunnelInstances.get(id);
  if (client) {
    client.disconnect();
    tunnelInstances.delete(id);
  }
  config.tunnels = config.tunnels.filter((tunnel) => tunnel.id !== id);
  saveConfig(config);
  return true;
});

handleTrusted('start-tunnel', async (_, id) => {
  const tunnel = config.tunnels.find((item) => item.id === id);
  if (!tunnel) return { error: 'Tunnel not found' };
  try { validateTunnelInput(tunnel); } catch (error) { return { error: error.message }; }
  if (!config.serverUrl || !config.token) {
    return { error: 'Save the server profile first. This GUI requires both server URL and token.' };
  }
  const generation = Symbol('start');
  pendingStarts.set(id, generation);
  const ready = await isLocalServiceReady(tunnel.port);
  if (pendingStarts.get(id) !== generation) return { error: 'Start cancelled.' };
  pendingStarts.delete(id);
  if (!ready) return { error: `Your local app is not running on port ${tunnel.port}. Open it first, then try again.` };

  const existing = tunnelInstances.get(id);
  if (existing) {
    existing.disconnect();
    tunnelInstances.delete(id);
  }

  const TunnelClient = require('../client/tunnel-client');
  const client = new TunnelClient({
    serverUrl: config.serverUrl,
    token: config.token,
    localHost: 'localhost',
    localPort: tunnel.port,
    clientId: tunnel.clientId,
    tunnelType: tunnel.type,
    publishDomain: tunnel.publishDomain || '',
    publishMode: tunnel.publishMode === 'root' ? 'root' : 'subdomain',
    desiredSubdomain: tunnel.desiredSubdomain || '',
    onConnected: ({ url }) => {
      if (tunnelInstances.get(id) !== client) return;
      mainWindow?.webContents.send('tunnel-status', { id, status: 'online', url });
    },
    onDisconnected: () => {
      if (tunnelInstances.get(id) !== client) return;
      mainWindow?.webContents.send('tunnel-status', { id, status: 'reconnecting', url: '' });
    },
    onRequest: (info) => {
      if (tunnelInstances.get(id) !== client) return;
      mainWindow?.webContents.send('tunnel-request', { id, ...info });
    },
    onError: (error) => {
      if (tunnelInstances.get(id) !== client) return;
      if (error.code === 'ECONNREFUSED') {
        mainWindow?.webContents.send('tunnel-status', { id, status: 'reconnecting', url: '' });
      } else if (error.code === 'EUNAUTHORIZED') {
        mainWindow?.webContents.send('tunnel-status', {
          id,
          status: 'error',
          url: '',
          error: 'The saved token is invalid for this server profile.',
        });
      } else if (error.code === 'ETUNNELSETUP') {
        mainWindow?.webContents.send('tunnel-status', { id, status: 'error', url: '', error: error.message });
      }
    },
  });

  tunnelInstances.set(id, client);
  try { client.connect(); } catch (error) { tunnelInstances.delete(id); return { error: error.message }; }
  return { ok: true };
});

handleTrusted('stop-tunnel', (_, id) => {
  pendingStarts.delete(id);
  const client = tunnelInstances.get(id);
  if (client) {
    client.disconnect();
    tunnelInstances.delete(id);
  }
  mainWindow?.webContents.send('tunnel-status', { id, status: 'stopped', url: '' });
  return true;
});

handleTrusted('open-external', async (_, url) => {
  const safeUrl = getExternalWebUrl(url);
  if (!safeUrl) return false;
  await shell.openExternal(safeUrl);
  return true;
});

handleTrusted('copy-text', (_, text) => {
  if (typeof text !== 'string' || text.length > 65536) return false;
  clipboard.writeText(text);
  return true;
});
