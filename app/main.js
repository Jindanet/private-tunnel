const { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const CONFIG_PATH = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.ptunnel');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf-8');
}

let config = loadConfig();
if (!config.clientId) { config.clientId = crypto.randomUUID(); saveConfig(config); }
if (!config.tunnels) { config.tunnels = []; saveConfig(config); }

const tunnelInstances = new Map(); // id -> TunnelClient
let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── Window ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 660,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0a',
    show: false, // wait for ready-to-show before displaying
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

  mainWindow.on('close', (e) => {
    if (isQuitting) return; // allow close on quit
    e.preventDefault();
    mainWindow.hide();
  });
}

// ── Tray ────────────────────────────────────────────────
function createTray() {
  // Simple 16x16 green dot as tray icon (base64 PNG)
  const iconData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABmJLR0QA/wD/AP+gvaeTAAAA' +
    'N0lEQVQ4jWNgGAWjgB5g////BwMDA8P/////MzAwMDCMWjAKhj8AAP//AwBnFiYBAAAA' +
    'ABJRU5ErkJggg==', 'base64'
  );
  const icon = nativeImage.createFromBuffer(iconData);
  tray = new Tray(icon);
  tray.setToolTip('PrivateTunnel');

  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow && mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow && (mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show()));
}

// ── App lifecycle ────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {}); // keep running in tray

app.on('before-quit', () => {
  isQuitting = true;
  for (const [, client] of tunnelInstances) {
    try { client.disconnect(); } catch {}
  }
});

// ── IPC ──────────────────────────────────────────────────
ipcMain.handle('get-config', () => ({ ...config }));

ipcMain.handle('save-server-url', (_, url) => {
  config.serverUrl = url;
  saveConfig(config);
  return true;
});

ipcMain.handle('save-token', (_, token) => {
  config.token = token || null;
  saveConfig(config);
  return true;
});

ipcMain.handle('add-tunnel', (_, { name, type, port }) => {
  const tunnel = {
    id: crypto.randomUUID(),
    clientId: crypto.randomUUID(), // unique per tunnel → unique subdomain
    name: name || (type === 'http' ? `HTTP :${port}` : `TCP :${port}`),
    type,
    port: parseInt(port),
  };
  config.tunnels.push(tunnel);
  saveConfig(config);
  return tunnel;
});

ipcMain.handle('delete-tunnel', (_, id) => {
  const client = tunnelInstances.get(id);
  if (client) { client.disconnect(); tunnelInstances.delete(id); }
  config.tunnels = config.tunnels.filter(t => t.id !== id);
  saveConfig(config);
  return true;
});

ipcMain.handle('start-tunnel', (_, id) => {
  const t = config.tunnels.find(t => t.id === id);
  if (!t) return { error: 'Tunnel not found' };
  if (!config.serverUrl) return { error: 'Server URL not configured' };

  const existing = tunnelInstances.get(id);
  if (existing) { existing.disconnect(); tunnelInstances.delete(id); }

  const TunnelClient = require('../client/tunnel-client');
  const client = new TunnelClient({
    serverUrl: config.serverUrl,
    token: config.token || null,
    localHost: 'localhost',
    localPort: t.port,
    clientId: t.clientId,
    tunnelType: t.type,
    onConnected: ({ url, tunnelType }) => {
      mainWindow?.webContents.send('tunnel-status', { id, status: 'online', url });
    },
    onDisconnected: () => {
      mainWindow?.webContents.send('tunnel-status', { id, status: 'reconnecting', url: '' });
    },
    onRequest: (info) => {
      mainWindow?.webContents.send('tunnel-request', { id, ...info });
    },
    onError: (err) => {
      if (err.code === 'ECONNREFUSED') {
        mainWindow?.webContents.send('tunnel-status', { id, status: 'reconnecting', url: '' });
      } else if (err.code === 'EUNAUTHORIZED') {
        mainWindow?.webContents.send('tunnel-status', { id, status: 'error', url: '', error: 'Invalid token' });
      }
    },
  });

  client.connect();
  tunnelInstances.set(id, client);
  return { ok: true };
});

ipcMain.handle('stop-tunnel', (_, id) => {
  const client = tunnelInstances.get(id);
  if (client) { client.disconnect(); tunnelInstances.delete(id); }
  mainWindow?.webContents.send('tunnel-status', { id, status: 'stopped', url: '' });
  return true;
});

ipcMain.handle('open-external', (_, url) => { shell.openExternal(url); return true; });
ipcMain.handle('copy-text', (_, text) => { clipboard.writeText(text); return true; });
