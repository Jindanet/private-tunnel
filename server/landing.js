function getLandingHTML(domain) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PrivateTunnel - Expose localhost to the internet</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Courier New',monospace;background:#0a0a0a;color:#e0e0e0;min-height:100vh}
.hero{max-width:900px;margin:0 auto;padding:60px 24px}
h1{font-size:48px;color:#00d4aa;margin-bottom:12px;letter-spacing:-1px}
h1 span{color:#e0e0e0}
.tagline{font-size:20px;color:#888;margin-bottom:48px;line-height:1.6}
.tagline em{color:#00d4aa;font-style:normal}

.terminal{background:#111;border:1px solid #333;border-radius:12px;overflow:hidden;margin-bottom:48px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.terminal-bar{background:#1a1a1a;padding:10px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #333}
.terminal-dot{width:12px;height:12px;border-radius:50%}
.terminal-dot.r{background:#ff5f56}.terminal-dot.y{background:#ffbd2e}.terminal-dot.g{background:#27c93f}
.terminal-title{color:#888;font-size:12px;margin-left:8px}
.terminal-body{padding:24px;font-family:'Courier New',monospace;font-size:14px;line-height:1.8}
.prompt{color:#00d4aa}
.cmd{color:#fff}
.output{color:#888}
.url-highlight{color:#f0c674}
.status-online{color:#27c93f}

.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px;margin-bottom:48px}
.feature{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:24px}
.feature h3{color:#00d4aa;font-size:16px;margin-bottom:8px}
.feature p{color:#888;font-size:14px;line-height:1.6}

.arch{margin-bottom:48px}
.arch h2{color:#e0e0e0;font-size:22px;margin-bottom:16px}
.arch-diagram{background:#111;border:1px solid #333;border-radius:8px;padding:24px;font-family:'Courier New',monospace;font-size:13px;color:#888;line-height:1.6;overflow-x:auto;white-space:pre}
.arch-diagram .hl{color:#00d4aa}
.arch-diagram .yl{color:#f0c674}
.arch-diagram .bl{color:#81a2be}

.setup{margin-bottom:48px}
.setup h2{color:#e0e0e0;font-size:22px;margin-bottom:16px}
.step{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;margin-bottom:12px}
.step-num{color:#00d4aa;font-size:13px;font-weight:bold;margin-bottom:6px}
.step code{background:#0a0a0a;padding:8px 12px;border-radius:4px;display:block;margin-top:8px;font-size:13px;color:#f0c674}

.footer{border-top:1px solid #222;padding:24px 0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
.footer a{color:#00d4aa;text-decoration:none;font-size:14px}
.footer a:hover{text-decoration:underline}
.footer .copy{color:#555;font-size:13px}
.gh-link{display:inline-flex;align-items:center;gap:6px;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:8px 16px;color:#e0e0e0;text-decoration:none;font-size:14px;transition:border-color .2s}
.gh-link:hover{border-color:#00d4aa;text-decoration:none}
.gh-link svg{fill:#e0e0e0;width:18px;height:18px}

.nav{display:flex;gap:16px;align-items:center;margin-bottom:48px}
.nav a{color:#888;text-decoration:none;font-size:14px;padding:6px 12px;border:1px solid transparent;border-radius:4px;transition:all .2s}
.nav a:hover{color:#00d4aa;border-color:#333}
</style>
</head>
<body>
<div class="hero">

<h1><span>Private</span>Tunnel</h1>
<p class="tagline">
  Expose your <em>localhost</em> to the internet with a single command.<br>
  Open-source, self-hosted, zero dependencies beyond Node.js.
</p>

<div class="nav">
  <a class="gh-link" href="https://github.com/Jindanet/private-tunnel" target="_blank">
    <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    GitHub
  </a>
  <a href="/dashboard">Dashboard</a>
</div>

<div class="terminal">
  <div class="terminal-bar">
    <div class="terminal-dot r"></div>
    <div class="terminal-dot y"></div>
    <div class="terminal-dot g"></div>
    <div class="terminal-title">Terminal</div>
  </div>
  <div class="terminal-body">
<span class="prompt">$</span> <span class="cmd">ptunnel localhost:3000</span><br>
<br>
<span class="output">  <b style="color:#00d4aa">Private Tunnel</b>   (Ctrl+C to quit)</span><br>
<span class="output">  ────────────────────────────────────────────</span><br>
<span class="output">  Status:      <span class="status-online">● online</span></span><br>
<span class="output">  Forwarding:  <span class="url-highlight">https://a7f3bc01.${domain}</span> → localhost:3000</span><br>
<span class="output">  Connections: 0</span><br>
<span class="output">  ────────────────────────────────────────────</span><br>
<span class="output">  METHOD  PATH                      STATUS   TIME</span><br>
<span class="output">  ────────────────────────────────────────────</span><br>
<span class="output">  Waiting for connections...</span>
  </div>
</div>

<div class="features">
  <div class="feature">
    <h3>One Command</h3>
    <p>Run <code style="background:#0a0a0a;padding:2px 6px;border-radius:3px">ptunnel 3000</code> and instantly get a public URL. No signup, no config files.</p>
  </div>
  <div class="feature">
    <h3>Persistent Subdomains</h3>
    <p>Each client gets a unique subdomain that persists across reconnects. Your URL stays the same.</p>
  </div>
  <div class="feature">
    <h3>Real-time Dashboard</h3>
    <p>Monitor all active tunnels, client info, request logs, and bandwidth usage from the web dashboard.</p>
  </div>
  <div class="feature">
    <h3>Self-hosted</h3>
    <p>Run on your own server. Full control over your data. No third-party dependencies. Works on Windows & Linux.</p>
  </div>
  <div class="feature">
    <h3>WebSocket Multiplexing</h3>
    <p>Single WebSocket connection per client. Multiple concurrent HTTP requests multiplexed via request IDs.</p>
  </div>
  <div class="feature">
    <h3>Minimal Dependencies</h3>
    <p>Only <code style="background:#0a0a0a;padding:2px 6px;border-radius:3px">ws</code> and <code style="background:#0a0a0a;padding:2px 6px;border-radius:3px">better-sqlite3</code>. Everything else uses Node.js built-ins.</p>
  </div>
</div>

<div class="arch">
<h2>Architecture</h2>
<div class="arch-diagram"><span class="bl">Browser</span> ──<span class="yl">HTTPS</span>──> <span class="hl">Nginx</span> (SSL + wildcard *.${domain})
    │
    ├── <span class="yl">/ws</span>         ──> Port <span class="hl">8080</span>  WebSocket tunnel connections
    ├── <span class="yl">/dashboard</span>  ──> Port <span class="hl">8081</span>  Admin dashboard + API
    └── <span class="yl">/</span>           ──> Port <span class="hl">8082</span>  HTTP proxy (tunnel traffic)
                          │
                    Subdomain routing
                    <span class="hl">abc123</span>.${domain}
                          │
                    ┌─────▼─────┐
                    │ WebSocket │  Multiplexed request/response
                    │ Connection│  via requestId
                    └─────┬─────┘
                          │
                    <span class="bl">Client (ptunnel)</span>
                          │
                    <span class="hl">localhost:3000</span></div>
</div>

<div class="setup">
<h2>Quick Start</h2>
<div class="step">
  <div class="step-num">1. Install</div>
  <p style="color:#888;font-size:14px">Clone the repository and install dependencies</p>
  <code>git clone https://github.com/Jindanet/private-tunnel.git<br>cd private-tunnel<br>npm install<br>npm link</code>
</div>
<div class="step">
  <div class="step-num">2. Configure</div>
  <p style="color:#888;font-size:14px">Copy <code style="background:#0a0a0a;padding:2px 6px;border-radius:3px">.env.example</code> to <code style="background:#0a0a0a;padding:2px 6px;border-radius:3px">.env</code> and set your domain</p>
  <code>cp .env.example .env<br># Edit .env: set DOMAIN=your-domain.com</code>
</div>
<div class="step">
  <div class="step-num">3. Start Server</div>
  <p style="color:#888;font-size:14px">Run on your server machine</p>
  <code>node server/index.js</code>
</div>
<div class="step">
  <div class="step-num">4. Connect Client</div>
  <p style="color:#888;font-size:14px">Run on your local machine</p>
  <code>ptunnel localhost:3000 --server wss://your-domain.com/ws</code>
</div>
</div>

<div class="footer">
  <a href="https://github.com/Jindanet/private-tunnel" target="_blank">github.com/Jindanet/private-tunnel</a>
  <span class="copy">PrivateTunnel &copy; 2026 Jindanet</span>
</div>

</div>
</body>
</html>`;
}

module.exports = { getLandingHTML };
