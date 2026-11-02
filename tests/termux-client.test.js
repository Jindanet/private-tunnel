'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');
const { WebSocketServer } = require('ws');
const {
  Prompt, parseTarget, tunnelProfile, savedTunnel, configure, connection,
  buildTunnelProfileClientId, saveConfig, loadConfig,
} = require('../client/cli');
const TunnelUI = require('../client/ui');
const v4 = require('../shared/tunnel-v4');
const { MSG, FRAME_REQUEST_BODY, FRAME_RESPONSE_BODY, FRAME_TCP_DATA } = v4;
const TOKEN = 'termux-test-only-access-key-32-characters';
const ROOT = path.resolve(__dirname, '..');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-termux-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ptunnel-termux-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'ptunnel.js');
  fs.copyFileSync(path.join(ROOT, 'ptunnel.js'), filename);
  const config = path.join(directory, 'profile.json');
  // No installed modules, npm, git, compiler, Electron or SQLite on PATH.
  const env = { ...process.env, PATH: '', NODE_PATH: '', PTUNNEL_CONFIG_PATH: config, NO_COLOR: '1' };
  return { directory, filename, config, env };
}

test('targets accept HTTP, host:port and IPv6 and reject malformed ports without truncation', () => {
  assert.deepEqual(parseTarget('3000'), { localHost: 'localhost', localPort: 3000 });
  assert.deepEqual(parseTarget('http://127.0.0.1:8080'), { localHost: '127.0.0.1', localPort: 8080 });
  assert.deepEqual(parseTarget('[::1]:25565'), { localHost: '::1', localPort: 25565 });
  for (const value of ['3000oops', '3.5', '0', '65536', '-2', 'host:3000:4', 'https://localhost:3000',
    'http://user:pass@localhost:3000', 'http://localhost:3000/path', '[example.com]:3000']) {
    assert.throws(() => parseTarget(value), undefined, value);
  }
  assert.throws(() => tunnelProfile('tcp', '3000', '', true), /HTTP/);
  assert.throws(() => tunnelProfile('tcp', 'http://localhost:3000'), /TCP target/);
  assert.throws(() => tunnelProfile('http', '3000', 'https://example.com'), /publish domain/);
});

test('connection validates secure endpoints and never accepts a URL query as credentials', () => {
  assert.equal(connection('admin.example.com', TOKEN).serverUrl, 'wss://admin.example.com/_private-tunnel/ws');
  for (const server of ['ws://remote.example.com', 'wss://user:secret@example.com', 'wss://example.com/?token=secret']) {
    assert.throws(() => connection(server, TOKEN));
  }
  for (const token of ['', 'short', 'your-' + 'a'.repeat(40), 'a'.repeat(32) + '\r\nX: test']) {
    assert.throws(() => connection('admin.example.com', token), /access key/);
  }
});

function scriptedPrompt(answers) {
  return {
    questions: [], closed: false,
    async ask(label, fallback, secret) {
      this.questions.push({ label, fallback, secret });
      assert.ok(answers.length, 'Unexpected extra prompt');
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer || fallback || '';
    },
    close() { this.closed = true; },
  };
}

test('first-run wizard builds a TCP profile, hides its key and keeps the existing identity', async () => {
  const prompt = scriptedPrompt(['admin.example.com', TOKEN, '2', '25565']);
  const original = { clientId: crypto.randomUUID() };
  const config = await configure(original, { prompt });
  assert.equal(config.clientId, original.clientId);
  assert.equal(config.token, TOKEN);
  assert.equal(config.lastTunnel.tunnelType, 'tcp');
  assert.equal(config.lastTunnel.localPort, 25565);
  assert.equal(prompt.questions[1].secret, true);
  assert.equal(prompt.closed, true);
  assert.equal(original.token, undefined, 'Wizard does not mutate the saved profile before completion');
  const editing = scriptedPrompt(['', '', '', '']);
  assert.deepEqual(await configure(config, { prompt: editing }), config);
});

test('cancelled wizard closes input without changing the prior saved profile', async () => {
  const original = { clientId: crypto.randomUUID(), ...connection('admin.example.com', TOKEN) };
  const prompt = scriptedPrompt(['', '', Object.assign(new Error('cancelled'), { name: 'AbortError' })]);
  await assert.rejects(configure(original, { prompt }), /cancelled/);
  assert.equal(prompt.closed, true);
  assert.equal(original.lastTunnel, undefined);
});

test('terminal input never echoes the access key and Ctrl+C cancels a pending prompt', async () => {
  const input = new PassThrough(); input.isTTY = true;
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  output.isTTY = true; output.columns = 40;
  const prompt = new Prompt({ input, output });
  try {
    const answer = prompt.ask('Access key', '', true);
    input.write(TOKEN + '\r');
    assert.equal(await answer, TOKEN);
    assert.ok(!text.includes(TOKEN));
    const cancelled = prompt.ask('Server');
    input.write('\x03');
    await assert.rejects(cancelled, { name: 'AbortError' });
  } finally { prompt.close(); input.destroy(); }
});

test('profile permissions, saved targets and deterministic identities survive restarts', (t) => {
  const f = fixture(t);
  const profile = tunnelProfile('http', 'localhost:3000', 'apps.example.com', true);
  const config = { clientId: crypto.randomUUID(), ...connection('admin.example.com', TOKEN), lastTunnel: profile };
  saveConfig(f.config, config);
  const loaded = loadConfig(f.config);
  assert.deepEqual(savedTunnel(loaded), profile);
  const id = buildTunnelProfileClientId(config.clientId, profile);
  assert.equal(buildTunnelProfileClientId(loaded.clientId, savedTunnel(loaded)), id);
  assert.notEqual(buildTunnelProfileClientId(loaded.clientId, tunnelProfile('tcp', '25565')), id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
  fs.writeFileSync(f.config, '{broken');
  assert.throws(() => loadConfig(f.config), /Cannot read profile/);
  assert.equal(fs.readFileSync(f.config, 'utf8'), '{broken');
});

test('standalone help, setup flags, status and reset work without any dependencies', (t) => {
  const f = fixture(t);
  const run = (args) => spawnSync(process.execPath, [f.filename, ...args], {
    cwd: f.directory, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  const version = run(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), require('../package.json').version);
  assert.match(help.stdout, /node ptunnel\.js/);
  assert.equal(fs.existsSync(f.config), false, 'Help does not create a credential profile');
  const setup = run(['init', '--server', 'admin.example.com', '--token', TOKEN]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(!setup.stdout.includes(TOKEN));
  const status = run(['status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /saved, hidden/);
  assert.ok(!status.stdout.includes(TOKEN));
  const prior = fs.readFileSync(f.config, 'utf8');
  for (const args of [['http', '3000junk'], ['tcp', '25565', '--root'], ['--server', 'other.example.com', 'http', '3000']]) {
    assert.equal(run(args).status, 1);
    assert.equal(fs.readFileSync(f.config, 'utf8'), prior);
  }
  assert.equal(run(['reset']).status, 0);
  const reset = JSON.parse(fs.readFileSync(f.config, 'utf8'));
  assert.equal(reset.token, undefined);
  assert.equal(reset.lastTunnel, undefined);
  const noTty = run([]);
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /interactive terminal/);
});

test('mobile logs preserve long public addresses, avoid cursor controls and sanitize remote text', () => {
  let output = '';
  const ui = new TunnelUI({ output: { columns: 40, write: (text) => { output += text; } } });
  const address = 'https://' + 'a'.repeat(45) + '.apps.example.com';
  ui.init(); ui.setConnected(address, 'localhost:3000', 'http');
  ui.addRequest({ method: 'GET', path: '/' + 'x'.repeat(100), statusCode: 200 });
  ui.setError('bad\x1b[2J\nserver'); ui.stop();
  assert.ok(output.includes(address));
  assert.ok(!output.includes('\x1b'));
  assert.ok(output.split('\n').find((line) => line.includes('GET')).length <= 40);
});

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server.address().port;
}

async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Standalone client timed out')), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

async function exchange(t, f, type, localPort, args) {
  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(gateway, 'listening');
  const payload = crypto.randomBytes(180000);
  const id = crypto.randomUUID();
  const config = loadConfig(f.config);
  saveConfig(f.config, { ...config, ...connection(`ws://127.0.0.1:${gateway.address().port}`, TOKEN) });
  let peer, child, output = '', opened, status;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    for (const socket of gateway.clients) socket.terminate();
    await new Promise((resolve) => gateway.close(resolve));
  });
  const chunks = [];
  let size = 0;
  const completed = new Promise((resolve, reject) => {
    gateway.on('connection', (socket, request) => {
      peer = socket;
      try {
        assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
        assert.ok(!request.url.includes(TOKEN));
      } catch (error) { reject(error); return; }
      socket.on('error', reject);
      socket.on('message', (data, binary) => {
        try {
          if (binary) {
            const frame = v4.decodeDataFrame(data, socket);
            if (!frame) return;
            assert.equal(frame.requestId, id);
            assert.equal(frame.frameType, type === 'http' ? FRAME_RESPONSE_BODY : FRAME_TCP_DATA);
            chunks.push(Buffer.from(frame.data)); size += frame.data.length;
            v4.discardFrame(socket, frame);
            if (type === 'tcp' && size === payload.length) resolve(Buffer.concat(chunks));
            return;
          }
          const message = JSON.parse(data.toString());
          if (message.type === MSG.TUNNEL_OPEN) {
            opened = message;
            assert.equal(message.tunnelType, type);
            assert.equal(message.localPort, localPort);
            assert.ok(message.dataTransportVersions.includes(4));
            v4.selectTransport(socket, 4, { isServer: true });
            v4.sendControl(socket, { type: MSG.TUNNEL_ASSIGNED, dataTransportVersion: 4, tunnelType: type,
              subdomain: 'termux', url: type === 'http' ? 'https://termux.apps.example.com' : 'example.com:30000' });
            if (type === 'http') {
              v4.sendControl(socket, { type: MSG.REQUEST_START, requestId: id, method: 'POST', path: '/termux',
                headers: { 'content-length': payload.length, 'content-type': 'application/octet-stream' } });
              assert.equal(v4.sendData(socket, FRAME_REQUEST_BODY, id, payload), true);
              v4.sendControl(socket, { type: MSG.STREAM_END, requestId: id, direction: 'request' });
            } else {
              v4.sendControl(socket, { type: MSG.TCP_CONNECT, connId: id });
              assert.equal(v4.sendData(socket, FRAME_TCP_DATA, id, payload), true);
            }
          } else {
            if (!v4.receiveControl(socket, message)) return;
            if (message.type === MSG.RESPONSE_START) status = message.statusCode;
            if (message.type === MSG.STREAM_END) resolve(Buffer.concat(chunks));
            if (message.type === MSG.STREAM_ERROR) reject(new Error(message.message));
          }
        } catch (error) { reject(error); }
      });
    });
  });
  child = spawn(process.execPath, [f.filename, ...args], { cwd: f.directory, env: f.env, windowsHide: true });
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const echoed = await deadline(completed);
  assert.deepEqual(echoed, payload);
  if (type === 'http') assert.equal(status, 200);
  assert.ok(!output.includes(TOKEN));
  assert.match(output, /ONLINE/);
  // A fatal server response must close the client without a reconnect loop.
  const exited = once(child, 'exit');
  peer.close(4001, 'Revoked');
  assert.equal((await deadline(exited))[0], 1);
  assert.match(output, /setup/);
  return opened.clientId;
}

test('standalone file forwards v4 HTTP and TCP and resumes the last tunnel with no arguments', { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  const sockets = new Set();
  const track = (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
  const web = http.createServer((req, res) => req.pipe(res));
  web.on('connection', track);
  const tcp = net.createServer((socket) => { track(socket); socket.pipe(socket); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([web, tcp].map((server) => new Promise((resolve) => server.close(resolve))));
  });
  const webPort = await listen(web), tcpPort = await listen(tcp);
  saveConfig(f.config, { clientId: crypto.randomUUID() });
  const first = await exchange(t, f, 'http', webPort, ['http', `127.0.0.1:${webPort}`]);
  assert.equal(await exchange(t, f, 'http', webPort, []), first);
  const tcpId = await exchange(t, f, 'tcp', tcpPort, ['tcp', `127.0.0.1:${tcpPort}`]);
  assert.notEqual(tcpId, first);
  assert.equal(await exchange(t, f, 'tcp', tcpPort, []), tcpId);
});
