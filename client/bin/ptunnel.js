#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TunnelClient = require('../tunnel-client');
const TunnelUI = require('../ui');
const { DEFAULT_TUNNEL_WS_PATH, normalizeServerWebSocketUrl } = require('../server-url');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || '.';
const CONFIG_PATH = path.resolve(process.env.PTUNNEL_CONFIG_PATH || path.join(HOME_DIR, '.ptunnel'));

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

let config = loadConfig();

// Ensure clientId exists
if (!config.clientId) {
  config.clientId = crypto.randomUUID();
  saveConfig(config);
}

const clientId = config.clientId;

const args = process.argv.slice(2);

function maskSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) return '(not set)';
  if (raw.length <= 8) return '*'.repeat(raw.length);
  return `${raw.slice(0, 4)}${'*'.repeat(Math.max(4, raw.length - 8))}${raw.slice(-4)}`;
}

function printHelp() {
  console.log(`
  ptunnel - Expose local servers to the internet

  First-time setup:
    ptunnel --server wss://example.com${DEFAULT_TUNNEL_WS_PATH} --token YOUR_TOKEN

  Then use:
    ptunnel http 3000
    ptunnel tcp 25565
    ptunnel 8080

  Optional tunnel flags:
    --domain <host>   Choose which configured publish domain this tunnel should use
    --root            HTTP only: publish on the exact root host instead of a random subdomain

  Profile commands:
    ptunnel status
    ptunnel reset
    ptunnel --server wss://example.com${DEFAULT_TUNNEL_WS_PATH} --token YOUR_TOKEN

  Notes:
    - Save server + token once first. After that, do not repeat them on every tunnel command.
    - Config file: ${CONFIG_PATH}
    - --server and --token are setup-only flags, not per-tunnel flags.
    - --domain and --root stay available per tunnel when you want to choose a domain or root host.
  `);
}

function printSetupGuide(reason) {
  if (reason) {
    console.error(`Error: ${reason}`);
    console.error('');
  }

  console.error('PrivateTunnel needs a saved server profile before it can open tunnels.');
  console.error('');
  console.error('1. Save your server once:');
  console.error(`   ptunnel --server wss://example.com${DEFAULT_TUNNEL_WS_PATH} --token YOUR_TOKEN`);
  console.error('');
  console.error('2. Then start tunnels with short commands:');
  console.error('   ptunnel http 3000');
  console.error('   ptunnel tcp 25565');
  console.error('   ptunnel http 3000 --domain devshop.com');
  console.error('   ptunnel http 3000 --domain devshop.com --root');
  console.error('');
  console.error(`Config file: ${CONFIG_PATH}`);
}

function parseArgs(argv) {
  const options = {
    help: false,
    root: false,
    server: '',
    token: '',
    domain: '',
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--root') {
      options.root = true;
      continue;
    }

    if (arg === '--server' || arg === '--token' || arg === '--domain') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        console.error(`Error: ${arg} requires a value.`);
        process.exit(1);
      }
      if (arg === '--server') options.server = next;
      if (arg === '--token') options.token = next;
      if (arg === '--domain') options.domain = next.trim();
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      console.error(`Error: Unknown option ${arg}`);
      process.exit(1);
    }

    positional.push(arg);
  }

  return { options, positional };
}

function hasSavedConnection() {
  return Boolean(String(config.serverUrl || '').trim() && String(config.token || '').trim());
}

function saveConnectionProfile({ server, token }) {
  const nextServer = server ? normalizeServerWebSocketUrl(server) : normalizeServerWebSocketUrl(config.serverUrl || '');
  const nextToken = token ? String(token).trim() : String(config.token || '').trim();

  if (!nextServer || !nextToken) {
    printSetupGuide('Both server and token are required for initial setup.');
    process.exit(1);
  }

  config.serverUrl = nextServer;
  config.token = nextToken;
  saveConfig(config);

  console.log('PrivateTunnel profile saved.');
  console.log(`Server: ${config.serverUrl}`);
  console.log(`Token:  ${maskSecret(config.token)}`);
  console.log('');
  console.log('Next steps:');
  console.log('  ptunnel http 3000');
  console.log('  ptunnel tcp 25565');
}

function printStatus() {
  console.log('PrivateTunnel profile');
  console.log(`Config:  ${CONFIG_PATH}`);
  console.log(`Server:  ${config.serverUrl || '(not set)'}`);
  console.log(`Token:   ${maskSecret(config.token)}`);
  console.log(`Client:  ${clientId}`);
}

function resetProfile() {
  delete config.serverUrl;
  delete config.token;
  saveConfig(config);
  console.log('PrivateTunnel profile reset.');
  console.log(`Run: ptunnel --server wss://example.com${DEFAULT_TUNNEL_WS_PATH} --token YOUR_TOKEN`);
}

if (args.length === 0) {
  printHelp();
  process.exit(0);
}

const { options, positional } = parseArgs(args);

if (options.help) {
  printHelp();
  process.exit(0);
}

if (positional[0] === 'status') {
  printStatus();
  process.exit(0);
}

if (positional[0] === 'reset') {
  resetProfile();
  process.exit(0);
}

if (positional[0] === 'init') {
  saveConnectionProfile({ server: options.server, token: options.token });
  process.exit(0);
}

if ((options.server || options.token) && positional.length === 0) {
  saveConnectionProfile({ server: options.server, token: options.token });
  process.exit(0);
}

if ((options.server || options.token) && positional.length > 0) {
  printSetupGuide('Set server + token first in a separate command, then run your tunnel command without --server or --token.');
  process.exit(1);
}

if (!hasSavedConnection()) {
  printSetupGuide('No saved server profile was found.');
  process.exit(1);
}

let localHost = 'localhost';
let localPort;
let tunnelType = 'http';

// Check if first positional arg is a type keyword
if (positional[0] === 'tcp' || positional[0] === 'http') {
  tunnelType = positional[0];
  positional.shift();
}

if (positional.length > 1) {
  console.error(`Error: Unexpected extra arguments: ${positional.slice(1).join(' ')}`);
  process.exit(1);
}

const target = positional[0];
if (!target) {
  console.error('Error: Please specify a port (e.g., ptunnel http 3000 or ptunnel tcp 25565).');
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

const serverUrl = normalizeServerWebSocketUrl(config.serverUrl);
if (serverUrl !== config.serverUrl) {
  config.serverUrl = serverUrl;
  saveConfig(config);
}

const token = String(config.token || '').trim();
if (!serverUrl || !token) {
  printSetupGuide('Saved profile is incomplete.');
  process.exit(1);
}

const publishDomain = options.domain;
const publishMode = options.root ? 'root' : 'subdomain';

if (publishMode === 'root' && tunnelType !== 'http') {
  console.error('Error: --root is only valid for HTTP tunnels.');
  process.exit(1);
}

// Initialize UI
const ui = new TunnelUI();
ui.init();

// Create tunnel client
const client = new TunnelClient({
  serverUrl,
  token,
  localHost,
  localPort,
  clientId,
  tunnelType,
  publishDomain,
  publishMode,
  onConnected: ({ subdomain, publicHost, url, tunnelType: type }) => {
    ui.setConnected(url, `${localHost}:${localPort}`, type);
  },
  onDisconnected: () => {
    ui.setDisconnected();
  },
  onRequest: (info) => {
    ui.addRequest(info);
  },
  onError: (err) => {
    if (err.code === 'ECONNREFUSED') {
      ui.setDisconnected();
    } else if (err.code === 'EUNAUTHORIZED') {
      process.stdout.write('\n');
      console.error(`Error: ${err.message}`);
      console.error('Update your saved profile and try again:');
      console.error('  ptunnel --token YOUR_TOKEN');
      process.exit(1);
    } else if (err.code === 'ETUNNELSETUP') {
      process.stdout.write('\n');
      console.error(`Error: ${err.message}`);
      console.error('Ask the server hoster to finish configuring the domain and routing in the admin UI first.');
      process.exit(1);
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
