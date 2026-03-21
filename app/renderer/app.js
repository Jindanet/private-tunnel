// ── State ───────────────────────────────────────────────
let config = {};
const states = new Map(); // tunnelId → { status, url, requests[] }

// ── Init ────────────────────────────────────────────────
async function init() {
  config = await window.api.getConfig();
  window.api.onTunnelStatus(onTunnelStatus);
  window.api.onTunnelRequest(onTunnelRequest);

  if (!config.serverUrl) {
    showView('setup');
  } else {
    showView('main');
    document.getElementById('server-url-text').textContent = config.serverUrl;
    renderList();
  }
}

// ── Views ────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + id)?.classList.remove('hidden');
}

function openPanel(id) {
  document.getElementById('backdrop').classList.remove('hidden');
  document.getElementById(id).classList.add('open');
}

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
  if (!document.querySelector('.panel.open')) {
    document.getElementById('backdrop').classList.add('hidden');
  }
}

document.getElementById('backdrop').addEventListener('click', () => {
  document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  document.getElementById('backdrop').classList.add('hidden');
});

// ── Setup ────────────────────────────────────────────────
document.getElementById('setup-connect-btn').addEventListener('click', async () => {
  const url = document.getElementById('setup-url').value.trim();
  if (!url.startsWith('ws')) { shake('setup-url'); return; }
  const token = document.getElementById('setup-token').value.trim();
  await window.api.saveServerUrl(url);
  await window.api.saveToken(token || null);
  config.serverUrl = url;
  config.token = token || null;
  config.tunnels = config.tunnels || [];
  document.getElementById('server-url-text').textContent = url;
  showView('main');
  renderList();
});
document.getElementById('setup-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('setup-connect-btn').click();
});
document.getElementById('setup-token').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('setup-connect-btn').click();
});
document.getElementById('setup-guide-btn').addEventListener('click', () => {
  openPanel('panel-guide'); showGuide('website');
});

// ── Tunnel list ──────────────────────────────────────────
function renderList() {
  const list = document.getElementById('tunnel-list');
  list.querySelectorAll('.tcard').forEach(c => c.remove());
  const tunnels = config.tunnels || [];
  document.getElementById('empty-state').style.display = tunnels.length ? 'none' : 'flex';
  tunnels.forEach(t => list.appendChild(makeCard(t)));
}

function makeCard(t) {
  const s = states.get(t.id) || { status: 'stopped', url: '', requests: [] };
  const running = s.status !== 'stopped';
  const card = document.createElement('div');
  card.id = 'card-' + t.id;
  card.className = 'tcard' + (s.status !== 'stopped' && s.status !== 'error' ? ' ' + s.status : s.status === 'error' ? ' error' : '');

  card.innerHTML = `
    <div class="tcard-top">
      <div class="tcard-left">
        <div class="type-badge ${t.type}">${t.type === 'http' ? '🌐' : '🔌'}</div>
        <div>
          <div class="tcard-name">${esc(t.name)}</div>
          <div class="tcard-port">${t.type.toUpperCase()} → localhost:${t.port}</div>
        </div>
      </div>
      <div class="status-pip ${s.status !== 'stopped' ? s.status : ''}"></div>
    </div>
    <div class="tcard-url">
      ${s.url
        ? `<span class="url-text" data-url="${esc(s.url)}">${esc(s.url)}</span>
           <button class="copy-btn" data-copy="${esc(s.url)}">Copy</button>`
        : s.error
          ? `<span class="url-none" style="color:#ff5f56">⚠ ${esc(s.error)}</span>`
          : `<span class="url-none">${running ? 'Connecting…' : 'Not started'}</span>`}
    </div>
    <div class="tcard-actions">
      ${running
        ? `<button class="btn-stop" data-id="${t.id}">■ Stop</button>`
        : `<button class="btn-start" data-id="${t.id}">▶ Start</button>`}
      <button class="btn-del" data-del="${t.id}">Delete</button>
    </div>
    <div class="tcard-log" id="log-${t.id}"></div>
  `;

  card.querySelector('.btn-start')?.addEventListener('click', () => doStart(t.id));
  card.querySelector('.btn-stop')?.addEventListener('click', () => doStop(t.id));
  card.querySelector('.btn-del')?.addEventListener('click', () => doDel(t.id));
  card.querySelector('.copy-btn')?.addEventListener('click', e => {
    window.api.copyText(e.target.dataset.copy);
    toast('Copied!');
  });
  card.querySelector('.url-text')?.addEventListener('click', e => {
    const url = e.target.dataset.url;
    if (url) window.api.openExternal(url);
  });

  renderLog(t.id, s.requests || []);
  return card;
}

function refreshCard(id) {
  const old = document.getElementById('card-' + id);
  if (!old) return;
  const t = (config.tunnels || []).find(t => t.id === id);
  if (!t) return;
  old.replaceWith(makeCard(t));
}

// ── Tunnel ops ───────────────────────────────────────────
async function doStart(id) {
  if (!states.has(id)) states.set(id, { status: 'stopped', url: '', requests: [] });
  states.get(id).status = 'reconnecting';
  refreshCard(id);
  const res = await window.api.startTunnel(id);
  if (res?.error) { toast(res.error); states.get(id).status = 'stopped'; refreshCard(id); }
  updateDot();
}

async function doStop(id) {
  await window.api.stopTunnel(id);
  states.set(id, { status: 'stopped', url: '', requests: [] });
  refreshCard(id); updateDot();
}

async function doDel(id) {
  await window.api.deleteTunnel(id);
  config.tunnels = (config.tunnels || []).filter(t => t.id !== id);
  states.delete(id);
  renderList(); updateDot();
}

function onTunnelStatus({ id, status, url, error }) {
  if (!states.has(id)) states.set(id, { status: 'stopped', url: '', requests: [] });
  const s = states.get(id);
  s.status = status;
  s.error = error || null;
  if (url) s.url = url;
  if (status === 'stopped' || status === 'error') s.url = '';
  refreshCard(id); updateDot();
}

function onTunnelRequest({ id, method, path, statusCode, latency }) {
  if (!states.has(id)) return;
  const s = states.get(id);
  if (!s.requests) s.requests = [];
  s.requests.unshift({ method, path, statusCode, latency });
  if (s.requests.length > 5) s.requests.pop();
  renderLog(id, s.requests);
}

function renderLog(id, reqs) {
  const el = document.getElementById('log-' + id);
  if (!el || !reqs?.length) return;
  el.innerHTML = reqs.slice(0, 3).map(r => {
    const sc = r.statusCode || 0;
    const cls = sc === 0 ? '' : sc < 300 ? 'ok' : sc < 400 ? 'redir' : sc < 500 ? 'warn' : 'err';
    const label = sc === 0 ? 'TCP' : sc;
    return `<div class="log-row">
      <span class="log-m">${r.method || ''}</span>
      <span class="log-p">${esc(r.path || '')}</span>
      <span class="log-s ${cls}">${label}</span>
    </div>`;
  }).join('');
}

function updateDot() {
  const dot = document.getElementById('header-dot');
  const vals = [...states.values()];
  dot.className = 'brand-dot'
    + (vals.some(s => s.status === 'online') ? ' online'
      : vals.some(s => s.status === 'reconnecting') ? ' connecting' : '');
}

// ── Add tunnel panel ─────────────────────────────────────
const PRESETS = {
  http: [
    { port: 3000,  name: 'Node.js / React',  icon: '⚛️' },
    { port: 5173,  name: 'Vite',             icon: '⚡' },
    { port: 8080,  name: 'Web Server',       icon: '🌐' },
    { port: 8000,  name: 'Django / Laravel', icon: '🐍' },
    { port: 4200,  name: 'Angular',          icon: '🔺' },
    { port: 3001,  name: 'Alt Node',         icon: '🟢' },
  ],
  tcp: [
    { port: 25565, name: 'Minecraft',  icon: '⛏️' },
    { port: 7777,  name: 'Terraria',   icon: '🗡️' },
    { port: 2456,  name: 'Valheim',    icon: '🪓' },
    { port: 27015, name: 'CS2 / TF2',  icon: '🎯' },
    { port: 22,    name: 'SSH',        icon: '🔑' },
    { port: 3306,  name: 'MySQL',      icon: '🐬' },
  ],
};

function renderPresets(type) {
  const container = document.getElementById('presets');
  container.innerHTML = PRESETS[type].map(p =>
    `<button class="preset-chip" data-port="${p.port}" data-name="${esc(p.name)}">
      ${p.icon} ${p.name} <span>:${p.port}</span>
    </button>`
  ).join('');
  container.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('add-port').value = chip.dataset.port;
      document.getElementById('add-name').value = chip.dataset.name;
    });
  });
}

let selType = 'http';

document.getElementById('add-tunnel-btn').addEventListener('click', () => {
  selType = 'http';
  document.querySelectorAll('.type-card').forEach(b => b.classList.toggle('active', b.dataset.type === 'http'));
  document.getElementById('add-port').value = '';
  document.getElementById('add-name').value = '';
  renderPresets('http');
  openPanel('panel-add');
  setTimeout(() => document.getElementById('add-port').focus(), 320);
});

document.querySelectorAll('.type-card').forEach(b => b.addEventListener('click', () => {
  selType = b.dataset.type;
  document.querySelectorAll('.type-card').forEach(x => x.classList.toggle('active', x === b));
  renderPresets(b.dataset.type);
}));

document.getElementById('cancel-add-btn').addEventListener('click', () => closePanel('panel-add'));

document.getElementById('confirm-add-btn').addEventListener('click', async () => {
  const port = parseInt(document.getElementById('add-port').value);
  if (!port || port < 1 || port > 65535) { shake('add-port'); return; }
  const name = document.getElementById('add-name').value.trim();
  const tunnel = await window.api.addTunnel({ type: selType, port, name });
  config.tunnels = config.tunnels || [];
  config.tunnels.push(tunnel);
  states.set(tunnel.id, { status: 'stopped', url: '', requests: [] });
  closePanel('panel-add');
  renderList();
  setTimeout(() => doStart(tunnel.id), 300);
});

document.getElementById('add-port').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('confirm-add-btn').click();
});

// ── Guide ────────────────────────────────────────────────
const guideHTML = {
  website: `
    <div class="g-intro">Share your local website or API with a public HTTPS URL — anyone can access it from anywhere.</div>
    <div class="g-step"><div class="g-num">1</div><div class="g-content">
      <strong>Start your web app</strong>
      <p>Run your app locally first. Common commands:</p>
      <p><code>npm run dev</code> <code>npm start</code> <code>python -m http.server 8080</code></p>
    </div></div>
    <div class="g-step"><div class="g-num">2</div><div class="g-content">
      <strong>Find the port number</strong>
      <p>Check your terminal for something like <em>Local: http://localhost:<b>3000</b></em></p>
      <p>Common ports: Vite/React <code>5173</code>, Node <code>3000</code>, Laravel <code>8000</code></p>
    </div></div>
    <div class="g-step"><div class="g-num">3</div><div class="g-content">
      <strong>Add an HTTP Tunnel</strong>
      <p>Click <strong>＋ Add Tunnel</strong> → choose <strong>HTTP</strong> → enter port → <strong>Add &amp; Start</strong></p>
    </div></div>
    <div class="g-step"><div class="g-num">4</div><div class="g-content">
      <strong>Share the URL</strong>
      <p>Click <strong>Copy</strong> next to the URL and send it to anyone.</p>
      <p>Example: <code>https://a7f3bc01.yourdomain.com</code></p>
    </div></div>
    <div class="g-tip"><strong>💡 Tip:</strong> The URL is permanent — same URL every time you reconnect!</div>`,

  game: `
    <div class="g-intro">Host a game server and let friends join with a single address. Works with Minecraft, Terraria, Valheim, and any game supporting Direct Connect.</div>
    <div class="g-step"><div class="g-num">1</div><div class="g-content">
      <strong>Start your game server</strong>
      <p>Launch the server on your PC first. Default ports:</p>
      <p><code>Minecraft 25565</code> <code>Terraria 7777</code> <code>Valheim 2456</code> <code>CS2 27015</code></p>
    </div></div>
    <div class="g-step"><div class="g-num">2</div><div class="g-content">
      <strong>Add a TCP Tunnel</strong>
      <p>Click <strong>＋ Add Tunnel</strong> → choose <strong>TCP</strong> → enter game port → Add</p>
      <p>Name it something like <em>"Minecraft Server"</em></p>
    </div></div>
    <div class="g-step"><div class="g-num">3</div><div class="g-content">
      <strong>Copy the address</strong>
      <p>You get an address like: <code>yourdomain.com:30001</code></p>
      <p>Send this to your friends.</p>
    </div></div>
    <div class="g-step"><div class="g-num">4</div><div class="g-content">
      <strong>Friends connect</strong>
      <p><strong>Minecraft:</strong> Multiplayer → Add Server → paste address</p>
      <p><strong>Other games:</strong> Direct Connect / Join by IP → paste address</p>
    </div></div>
    <div class="g-tip"><strong>⚠️ Keep this app open</strong> while friends are playing. Closing PrivateTunnel = server goes offline for them.</div>`,

  ssh: `
    <div class="g-intro">Access your computer remotely from anywhere using SSH. Good for remote work, file transfers, or running commands on your home PC.</div>
    <div class="g-step"><div class="g-num">1</div><div class="g-content">
      <strong>Enable SSH on your computer</strong>
      <p><strong>Windows:</strong> Settings → Apps → Optional Features → OpenSSH Server → Install, then start it</p>
      <p><strong>Linux:</strong> <code>sudo systemctl enable --now ssh</code></p>
      <p><strong>macOS:</strong> System Settings → Sharing → Remote Login ✓</p>
    </div></div>
    <div class="g-step"><div class="g-num">2</div><div class="g-content">
      <strong>Add a TCP Tunnel on port 22</strong>
      <p>Click <strong>＋ Add Tunnel</strong> → TCP → port <code>22</code> → Add</p>
    </div></div>
    <div class="g-step"><div class="g-num">3</div><div class="g-content">
      <strong>Connect from anywhere</strong>
      <p>Replace with your domain and port:</p>
      <p><code>ssh youruser@yourdomain.com -p 30001</code></p>
    </div></div>
    <div class="g-tip"><strong>🔒 Security tip:</strong> Use SSH key authentication for better security. Disable password auth in <code>sshd_config</code>.</div>`,
};

function showGuide(tab) {
  document.querySelectorAll('.g-tab').forEach(t => t.classList.toggle('active', t.dataset.g === tab));
  document.getElementById('guide-body').innerHTML = guideHTML[tab] || '';
}

document.getElementById('guide-btn').addEventListener('click', () => { openPanel('panel-guide'); showGuide('website'); });
document.getElementById('close-guide-btn').addEventListener('click', () => closePanel('panel-guide'));
document.querySelectorAll('.g-tab').forEach(t => t.addEventListener('click', () => showGuide(t.dataset.g)));

// ── Settings ─────────────────────────────────────────────
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-url').value = config.serverUrl || '';
  document.getElementById('settings-token').value = config.token || '';
  openPanel('panel-settings');
});
document.getElementById('close-settings-btn').addEventListener('click', () => closePanel('panel-settings'));
document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const url = document.getElementById('settings-url').value.trim();
  if (!url) { shake('settings-url'); return; }
  const token = document.getElementById('settings-token').value.trim();
  await window.api.saveServerUrl(url);
  await window.api.saveToken(token || null);
  config.serverUrl = url;
  config.token = token || null;
  document.getElementById('server-url-text').textContent = url;
  closePanel('panel-settings');
  toast('Saved!');
});

// ── Utils ────────────────────────────────────────────────
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

function shake(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.borderColor = '#ff5f56';
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(() => { el.style.borderColor = ''; el.classList.remove('shake'); }, 500);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Start ────────────────────────────────────────────────
init();
