const { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2), 'utf-8');
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
      if (!/^wss?:$/i.test(parsed.protocol)) {
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
  }

  return {
    ok: !errors.serverUrl && !errors.token,
    errors,
    normalizedUrl,
    token: rawToken,
  };
}

function buildAuthenticatedWebSocketUrl(serverUrl, token) {
  const url = new URL(normalizeServerWebSocketUrl(serverUrl));
  url.searchParams.set('token', String(token || '').trim());
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

    const ws = new WebSocket(buildAuthenticatedWebSocketUrl(serverUrl, token));
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
          finish(msg);
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
        message: error && error.message
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
let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 760,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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

ipcMain.handle('get-config', () => ({
  ...config,
  configPath: CONFIG_PATH,
}));

ipcMain.handle('validate-server-profile', (_, payload) => {
  const result = validateServerProfileInput(payload && payload.serverUrl, payload && payload.token);
  return {
    ok: result.ok,
    errors: result.errors,
    normalizedUrl: result.normalizedUrl,
  };
});

ipcMain.handle('save-server-profile', (_, payload) => {
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

ipcMain.handle('check-tunnel-config', async (_, payload) => {
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

ipcMain.handle('add-tunnel', (_, payload) => {
  const tunnel = normalizeTunnelConfig({
    id: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    name: payload && payload.name ? payload.name : '',
    type: payload && payload.type === 'tcp' ? 'tcp' : 'http',
    port: Number.parseInt(payload && payload.port, 10),
    publishDomain: payload && payload.publishDomain,
    publishMode: payload && payload.publishMode,
    desiredSubdomain: payload && payload.desiredSubdomain,
  });

  tunnel.name = tunnel.name || (tunnel.type === 'http' ? `HTTP :${tunnel.port}` : `TCP :${tunnel.port}`);

  config.tunnels.push(tunnel);
  saveConfig(config);
  return tunnel;
});

ipcMain.handle('delete-tunnel', (_, id) => {
  const client = tunnelInstances.get(id);
  if (client) {
    client.disconnect();
    tunnelInstances.delete(id);
  }
  config.tunnels = config.tunnels.filter((tunnel) => tunnel.id !== id);
  saveConfig(config);
  return true;
});

ipcMain.handle('start-tunnel', (_, id) => {
  const tunnel = config.tunnels.find((item) => item.id === id);
  if (!tunnel) return { error: 'Tunnel not found' };
  if (!config.serverUrl || !config.token) {
    return { error: 'Save the server profile first. This GUI requires both server URL and token.' };
  }

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
      mainWindow?.webContents.send('tunnel-status', { id, status: 'online', url });
    },
    onDisconnected: () => {
      mainWindow?.webContents.send('tunnel-status', { id, status: 'reconnecting', url: '' });
    },
    onRequest: (info) => {
      mainWindow?.webContents.send('tunnel-request', { id, ...info });
    },
    onError: (error) => {
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

  client.connect();
  tunnelInstances.set(id, client);
  return { ok: true };
});

ipcMain.handle('stop-tunnel', (_, id) => {
  const client = tunnelInstances.get(id);
  if (client) {
    client.disconnect();
    tunnelInstances.delete(id);
  }
  mainWindow?.webContents.send('tunnel-status', { id, status: 'stopped', url: '' });
  return true;
});

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
  return true;
});

ipcMain.handle('copy-text', (_, text) => {
  clipboard.writeText(text);
  return true;
});
