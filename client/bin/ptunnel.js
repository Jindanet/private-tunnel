#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TunnelClient = require('../tunnel-client');
const TunnelUI = require('../ui');

// ── Client Config (~/.ptunnel) ──
const CONFIG_PATH = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.ptunnel');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

let config = loadConfig();

// Ensure clientId exists
if (!config.clientId) {
  config.clientId = crypto.randomUUID();
  saveConfig(config);
}

const clientId = config.clientId;

// Parse arguments
const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
  ptunnel - Expose local servers to the internet

  Usage:
    ptunnel http <port>                 HTTP tunnel  → https://{id}.domain
    ptunnel tcp  <port>                 TCP tunnel   → domain:PORT
    ptunnel <port>                      Shorthand for http tunnel

  Examples:
    ptunnel http 3000
    ptunnel tcp 25565
    ptunnel 8080

  Options:
    --server <url>    Server WebSocket URL (saved to ~/.ptunnel after first use)
    --help, -h        Show this help message
  `);
  process.exit(0);
}

// Parse tunnel type and target
let localHost = 'localhost';
let localPort;
let tunnelType = 'http';

const positional = args.filter(a => !a.startsWith('--'));

// Check if first positional arg is a type keyword
if (positional[0] === 'tcp' || positional[0] === 'http') {
  tunnelType = positional[0];
  positional.shift();
}

const target = positional[0];
if (!target) {
  console.error('Error: Please specify a port (e.g., ptunnel http 3000 or ptunnel tcp 25565)');
  process.exit(1);
}

if (target.includes(':')) {
  const parts = target.split(':');
  localHost = parts[0] || 'localhost';
  localPort = parseInt(parts[1], 10);
} else {
  localPort = parseInt(target, 10);
}

if (isNaN(localPort) || localPort < 1 || localPort > 65535) {
  console.error(`Error: Invalid port: ${target}`);
  process.exit(1);
}

// Parse server URL — use arg, fallback to saved config
const serverIdx = args.indexOf('--server');
let serverUrl = serverIdx !== -1 && args[serverIdx + 1] ? args[serverIdx + 1] : null;

if (serverUrl) {
  // Save to config for next time
  if (config.serverUrl !== serverUrl) {
    config.serverUrl = serverUrl;
    saveConfig(config);
  }
} else if (config.serverUrl) {
  serverUrl = config.serverUrl;
} else {
  console.error('Error: --server <url> is required on first run. Example:\n  ptunnel 3000 --server wss://tunnel.example.com/ws\n\nAfter first run it will be saved automatically.');
  process.exit(1);
}

// Initialize UI
const ui = new TunnelUI();
ui.init();

// Create tunnel client
const client = new TunnelClient({
  serverUrl,
  localHost,
  localPort,
  clientId,
  tunnelType,
  onConnected: ({ subdomain, url, tunnelType: type }) => {
    ui.setConnected(url, `${localHost}:${localPort}`, type);
  },
  onDisconnected: () => {
    ui.setDisconnected();
  },
  onRequest: (info) => {
    ui.addRequest(info);
  },
  onError: (err) => {
    // Don't crash on connection errors during reconnect
    if (err.code === 'ECONNREFUSED') {
      ui.setDisconnected();
    }
  },
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  client.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  client.disconnect();
  process.exit(0);
});

// Connect!
client.connect();
