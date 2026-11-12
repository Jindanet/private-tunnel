'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const { requireSecureServerWebSocketUrl } = require('./server-url');
const TunnelUI = require('./ui');
const { createStartupManager } = require('./startup');
const CLIENT_VERSION = require('../package.json').version;

function configPath() {
  return path.resolve(process.env.PTUNNEL_CONFIG_PATH || path.join(os.homedir(), '.ptunnel'));
}

function loadConfig(filename) {
  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid profile');
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read profile ${filename}. Check its permissions and JSON format.`);
  }
}

function saveConfig(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function connection(server, token) {
  const serverUrl = requireSecureServerWebSocketUrl(server);
  if (new URL(serverUrl).search) throw new Error('Server URL must not contain query parameters. Enter the access key separately.');
  const key = String(token || '').trim();
  if (!/^[\x21-\x7e]{32,4096}$/.test(key) || /^(?:your|replace|change|example)[-_]/i.test(key)) {
    throw new Error('Enter the access key from your administrator (32–4096 characters, no spaces).');
  }
  return { serverUrl, token: key };
}

function parseTarget(value) {
  const raw = String(value || '').trim();
  let localHost = 'localhost';
  let port = raw;
  if (/^http:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('Enter a local HTTP URL or host:port.'); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Use a local HTTP URL without credentials, path, query or fragment.');
    }
    localHost = url.hostname.replace(/^\[|\]$/g, '');
    port = url.port || '80';
  } else if (raw.includes(':')) {
    const parts = /^(?:\[([^\]]+)\]|([^:\s/]+)):(\d+)$/.exec(raw);
    if (!parts) throw new Error('Use host:port (IPv6: [::1]:3000).');
    localHost = parts[1] || parts[2];
    if (parts[1] && net.isIP(localHost) !== 6) throw new Error('Invalid IPv6 address.');
    port = parts[3];
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Port must be a whole number from 1 to 65535.');
  }
  return { localHost, localPort: Number(port) };
}

function tunnelProfile(type, target, domain = '', root = false) {
  if (!['http', 'tcp'].includes(type)) throw new Error('Tunnel type must be http or tcp.');
  if (root && type !== 'http') throw new Error('--root is only valid for HTTP tunnels.');
  if (type === 'tcp' && target.includes('://')) throw new Error('TCP target must be a port or host:port.');
  const publishDomain = String(domain).trim().toLowerCase();
  if (publishDomain && (publishDomain.length > 253 || !publishDomain.split('.').every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ))) throw new Error('Enter a publish domain without scheme, port or path.');
  return { tunnelType: type, ...parseTarget(target), publishDomain, publishMode: root ? 'root' : 'subdomain', desiredSubdomain: '' };
}

function targetOf(profile) {
  const host = String(profile.localHost || 'localhost');
  return `${host.includes(':') ? `[${host}]` : host}:${profile.localPort}`;
}

function savedTunnel(config) {
  const saved = config.lastTunnel;
  if (!saved) return null;
  return tunnelProfile(saved.tunnelType, targetOf(saved), saved.publishDomain, saved.publishMode === 'root');
}

function buildTunnelProfileClientId(baseClientId, profile) {
  const key = JSON.stringify({
    tunnelType: profile.tunnelType,
    localHost: profile.localHost.trim().toLowerCase(),
    localPort: profile.localPort,
    publishDomain: profile.publishDomain,
    publishMode: profile.publishMode,
    desiredSubdomain: profile.desiredSubdomain,
  });
  return `${baseClientId}:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

function parseArgs(argv) {
  const options = { root: false, plain: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--root') options.root = true;
    else if (arg === '--plain') options.plain = true;
    else if (arg === '--startup') options.startup = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (['--server', '--token', '--domain'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  return { options, positional };
}

class Prompt {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    if (!input.isTTY || !output.isTTY) {
      throw new Error('Setup needs an interactive terminal. Use init --server <address> --token <key>, then http <port> or tcp <port>.');
    }
    this.controller = new AbortController();
    this.muted = false;
    this.destination = output;
    this.output = new Writable({ write: (chunk, encoding, done) => {
      if (!this.muted) output.write(chunk, encoding);
      done();
    } });
    this.output.isTTY = true;
    this.output.columns = output.columns;
    this.rl = readline.createInterface({ input, output: this.output, terminal: true, historySize: 0 });
    this.rl.on('SIGINT', () => this.controller.abort());
    this.rl.on('close', () => this.controller.abort());
  }

  async ask(label, fallback = '', secret = false) {
    const hint = fallback ? ` [${fallback}]` : '';
    try {
      const answer = this.rl.question(`${label}${hint}: `, { signal: this.controller.signal });
      this.muted = secret;
      const value = (await answer).trim();
      return value || fallback;
    } finally {
      this.muted = false;
      if (secret) this.destination.write('\n');
    }
  }

  close() { this.rl.close(); this.output.end(); }
}

async function configure(config, { full = true, prompt = new Prompt() } = {}) {
  try {
    console.log('\nPrivateTunnel · ตั้งค่าครั้งแรก / Setup');
    console.log('ขอที่อยู่เซิร์ฟเวอร์และกุญแจจากผู้ดูแล / Ask your administrator for server + access key.');
    let next;
    while (!next) {
      const server = await prompt.ask('เซิร์ฟเวอร์ / Server', config.serverUrl || '');
      const key = await prompt.ask(config.token ? 'กุญแจ / Access key (Enter = keep saved key)' : 'กุญแจ / Access key (hidden)', '', true);
      try { next = { ...config, ...connection(server, key || config.token) }; }
      catch (error) { console.error(error.message); }
    }
    if (full) {
      let previous;
      try { previous = savedTunnel(config); } catch { /* Replace an invalid saved target in setup. */ }
      while (true) {
        const type = (await prompt.ask('ประเภท / Type: 1 = HTTP, 2 = TCP', previous?.tunnelType || 'http')).toLowerCase();
        const tunnelType = ({ '1': 'http', '2': 'tcp' })[type] || type;
        if (!['http', 'tcp'].includes(tunnelType)) { console.error('Choose 1 / http or 2 / tcp.'); continue; }
        const fallback = previous?.tunnelType === tunnelType ? targetOf(previous) : tunnelType === 'tcp' ? '25565' : '3000';
        const target = await prompt.ask('พอร์ตหรือ host:port / Local target', fallback);
        try {
          next.lastTunnel = tunnelProfile(tunnelType, target, previous?.publishDomain || '', tunnelType === 'http' && previous?.publishMode === 'root');
          break;
        } catch (error) { console.error(error.message); }
      }
    }
    return next;
  } finally { prompt.close(); }
}

function printHelp() {
  console.log(`
PrivateTunnel ${CLIENT_VERSION} · Termux / Node.js 22.12+

  node ptunnel.js                 ตั้งค่าครั้งแรก แล้วเปิด tunnel / Setup and start
                                  ครั้งถัดไปเปิดรายการเดิม / Resume saved tunnel
  node ptunnel.js setup           เปลี่ยนค่าที่บันทึก / Edit saved settings
  node ptunnel.js http 3000        แชร์เว็บไซต์ / Share HTTP
  node ptunnel.js tcp 25565        แชร์ TCP / Share TCP
  node ptunnel.js tcp 22 --startup เริ่มตั้งแต่บูต ก่อนล็อกอิน / Install boot service
  node ptunnel.js startup status   ดูบริการ / List boot services and their IDs
  node ptunnel.js startup install  ติดตั้งจากรายการล่าสุด / Use saved tunnel
  node ptunnel.js startup stop ID  หยุดชั่วคราว / Stop until next boot
  node ptunnel.js startup start ID เริ่มบริการ / Start service now
  node ptunnel.js startup remove ID|all  ถอนการเริ่มอัตโนมัติ / Uninstall
  --startup --dry-run             Preview installation without making changes
  node ptunnel.js http localhost:3000 --domain apps.example.com [--root]
  node ptunnel.js status          ดูค่าที่บันทึก / Show profile (key hidden)
  node ptunnel.js reset           ล้างการตั้งค่า / Clear saved settings
  node ptunnel.js init --server admin.example.com --token YOUR_ACCESS_KEY

  --plain                        Plain logs without terminal colors
  --version                      Show the client release version
  Config: ${configPath()}
  Ctrl+C to stop. Open your local service before starting a tunnel.
`);
}

function startTunnel(config, profile, options) {
  // Loaded only when starting: help and setup do not need third-party modules.
  const TunnelClient = require('./tunnel-client');
  const ui = new TunnelUI({ plain: options.plain, localTarget: targetOf(profile), tunnelType: profile.tunnelType });
  const client = new TunnelClient({
    ...connection(config.serverUrl, config.token), ...profile,
    clientId: buildTunnelProfileClientId(config.clientId, profile),
    onConnected: ({ url, tunnelType }) => ui.setConnected(url, targetOf(profile), tunnelType),
    onDisconnected: () => ui.setDisconnected(),
    onRequest: (info) => ui.addRequest(info),
    onError: (error) => {
      ui.setError(error.message);
      if (['EUNAUTHORIZED', 'ETUNNELSETUP'].includes(error.code)) {
        if (error.code === 'EUNAUTHORIZED') console.error('Run node ptunnel.js setup to update the access key.');
        stop(1);
      }
    },
  });
  let stopping = false;
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    client.disconnect();
    process.exitCode = code;
    // A peer can ignore the close handshake; do not leave Termux hanging.
    const timer = setTimeout(() => client.ws?.terminate(), 1500);
    timer.unref();
    client.ws?.once('close', () => clearTimeout(timer));
    ui.stop();
  }
  const interrupt = () => stop(0);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  ui.init();
  client.connect();
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'startup' && argv[1] === 'run') {
    if (argv.length !== 4 || argv[2] !== '--profile' || !path.isAbsolute(argv[3])) throw new Error('Internal startup runner requires an absolute --profile path.');
    require('./startup-runner').runStartup(argv[3]);
    return;
  }
  const { options, positional } = parseArgs(argv);
  if (options.version) { console.log(CLIENT_VERSION); return; }
  if (options.help) { printHelp(); return; }
  const filename = configPath();
  let config = loadConfig(filename);
  const startup = createStartupManager({ configPath: filename });
  const command = positional[0];
  if (command === 'startup') {
    if (options.server || options.token || options.domain || options.root || options.startup) throw new Error('Startup commands use saved profiles. Configure the server and target first.');
    const action = positional[1] || 'status';
    if (action === 'status' || action === 'list') {
      if (positional.length > 2) throw new Error('startup status takes no arguments.');
      const entries = startup.status();
      if (!entries.length) console.log('No boot tunnels. Run node ptunnel.js tcp 22 --startup.');
      for (const entry of entries) {
        console.log(`${entry.id}  ${entry.tunnelType} ${entry.localHost}:${entry.localPort}  ${entry.installed ? entry.status : 'installation missing'}`);
        if (entry.url) console.log(`Public: ${entry.url}`);
        if (entry.error) console.log(`Error: ${entry.error}`);
        console.log(`Provider: ${entry.provider}\nLog: ${entry.logPath}\n${entry.note}`);
      }
      return;
    }
    if (action === 'install' && positional.length === 2) {
      const profile = savedTunnel(config);
      if (!profile || !config.clientId) throw new Error('Save a tunnel first, e.g. node ptunnel.js tcp 22.');
      const result = await startup.enable({ ...connection(config.serverUrl, config.token), ...profile, clientId: buildTunnelProfileClientId(config.clientId, profile) }, { dryRun: options.dryRun });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!['start', 'stop', 'remove'].includes(action) || positional.length > 3 || options.dryRun) throw new Error('Use startup status, install [--dry-run], start ID, stop ID or remove ID|all.');
    const entries = startup.status();
    const id = positional[2] || (entries.length === 1 ? entries[0].id : '');
    const targets = id === 'all' && action === 'remove' ? entries.map((entry) => entry.id) : [id];
    if (!id) throw new Error('Choose a tunnel ID from startup status.');
    for (const target of targets) {
      const result = await startup.control(target, action);
      if (result.cleanupPending) console.warn('Startup removed. Some runtime files are locked; restart Windows before deleting the old service folder.');
    }
    console.log(`Startup ${action} complete.`);
    return;
  }
  if (options.dryRun && !options.startup) throw new Error('--dry-run requires --startup or startup install.');
  const profileCommand = ['status', 'reset', 'setup', 'init'].includes(command);
  if (profileCommand && positional.length !== 1) throw new Error(`${command} does not accept extra arguments.`);
  if ((profileCommand || options.server || options.token) && options.startup) throw new Error('--startup belongs to a tunnel command, e.g. tcp 22 --startup.');
  const settingConnection = options.server !== undefined || options.token !== undefined;
  if (settingConnection && command && command !== 'init') {
    throw new Error('Save --server and --token using init first, then run your tunnel command.');
  }
  if ((profileCommand || settingConnection) && (options.domain || options.root)) throw new Error('--domain and --root belong to tunnel commands.');
  if (command === 'status') {
    console.log(`Config: ${filename}\nServer: ${config.serverUrl || '(not set)'}\nAccess key: ${config.token ? '(saved, hidden)' : '(not set)'}`);
    const saved = savedTunnel(config);
    console.log(`Tunnel: ${saved ? `${saved.tunnelType} ${targetOf(saved)}` : '(not set)'}`);
    return;
  }
  if (command === 'reset') {
    if (startup.status().length) throw new Error('Remove boot services with startup remove all before resetting the saved profile.');
    delete config.serverUrl; delete config.token; delete config.lastTunnel;
    saveConfig(filename, config);
    console.log('Profile reset. Run node ptunnel.js to set up again.');
    return;
  }
  if (!config.clientId) config.clientId = crypto.randomUUID();
  if (command === 'init' || settingConnection) {
    config = settingConnection
      ? { ...config, ...connection(options.server || config.serverUrl, options.token || config.token) }
      : await configure(config, { full: false });
    saveConfig(filename, config);
    console.log('Profile saved. Run node ptunnel.js to choose a tunnel, or node ptunnel.js http 3000.');
    return;
  }
  if (command === 'setup') {
    config = await configure(config);
    saveConfig(filename, config);
    console.log('Settings saved. Run node ptunnel.js to start.');
    return;
  }
  let profile;
  if (!command) {
    if (options.domain || options.root) throw new Error('Specify http <port> with --domain or --root.');
    if (!config.serverUrl || !config.token || !config.lastTunnel) config = await configure(config);
    profile = savedTunnel(config);
  } else {
    const type = ['http', 'tcp'].includes(command) ? positional.shift() : 'http';
    if (positional.length !== 1) throw new Error('Specify one local target, e.g. http 3000 or tcp 25565.');
    profile = tunnelProfile(type, positional[0], options.domain, options.root);
    if (!config.serverUrl || !config.token) config = await configure(config, { full: false });
  }
  Object.assign(config, connection(config.serverUrl, config.token), { lastTunnel: profile });
  if (options.startup) {
    const serviceProfile = { ...connection(config.serverUrl, config.token), ...profile, clientId: buildTunnelProfileClientId(config.clientId, profile) };
    if (!options.dryRun) saveConfig(filename, config);
    const result = await startup.enable(serviceProfile, { dryRun: options.dryRun });
    console.log(options.dryRun ? 'Startup installation preview:' : 'Boot tunnel installed and started in the background.');
    console.log(`ID: ${result.id}\nProvider: ${result.provider}\nProfile: ${result.profilePath}\nLog: ${result.logPath}\n${result.note}`);
    console.log('The boot service uses a separate private access-key copy. Re-run this command to update its settings.');
    return;
  }
  saveConfig(filename, config);
  console.log(`Saved profile: ${filename}`);
  startTunnel(config, profile, options);
}

module.exports = { main, Prompt, parseArgs, parseTarget, tunnelProfile, savedTunnel, connection, buildTunnelProfileClientId, loadConfig, saveConfig, configure };
