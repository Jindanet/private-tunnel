# PrivateTunnel

**Self-hosted ngrok alternative** — Expose your localhost to the internet with a single command. Supports both HTTP and raw TCP tunneling.

```bash
# HTTP tunnel → https://{id}.your-domain.com
$ ptunnel http 3000

  PrivateTunnel   (Ctrl+C to quit)
  ────────────────────────────────────────────
  Status:      ● online
  Forwarding:  https://a7f3bc01.ex.example.com → localhost:3000

# TCP tunnel (Minecraft, SSH, game servers, etc.)
$ ptunnel tcp 25565

  Status:      ● online
  Forwarding:  [TCP] ex.example.com:30001 → localhost:25565
```

## Table of Contents

- [Background](#background)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Server Setup](#server-setup)
- [Client Usage](#client-usage)
- [Pre-built Binaries](#pre-built-binaries)
- [Dashboard](#dashboard)
- [DNS & SSL Configuration](#dns--ssl-configuration)
- [Nginx Configuration](#nginx-configuration)
- [Problems Encountered & Solutions](#problems-encountered--solutions)
- [Wire Protocol](#wire-protocol)
- [Database Schema](#database-schema)
- [License](#license)

---

## Background

We needed a self-hosted tunnel solution similar to ngrok for exposing local development servers to the internet. The requirements were:

1. **Client runs a single command** (`ptunnel http 3000` or `ptunnel tcp 25565`) and gets a unique public URL
2. **Each client gets a persistent subdomain** — reconnecting gives the same URL
3. **Server manages everything** — no port forwarding, no manual configuration
4. **Real-time dashboard** with authentication to monitor all tunnels and requests
5. **Minimal dependencies** — only Node.js built-ins + `ws` + `better-sqlite3`
6. **TCP tunneling** — raw TCP for game servers, SSH, databases, etc. with auto firewall management

---

## Architecture

### HTTP Tunnels

```
Browser ──HTTPS──> Nginx (SSL termination, wildcard *.ex.example.com)
    │
    ├── /ws         ──> Port 8080  WebSocket tunnel connections
    ├── /api/*      ──> Port 8081  Dashboard API
    ├── /dashboard  ──> Port 8081  Dashboard Web UI
    └── /           ──> Port 8082  HTTP proxy (tunnel traffic)
                          │
                    Subdomain routing
                    abc123.ex.example.com → lookup WebSocket for "abc123"
                          │
                    ┌─────────────┐
                    │  WebSocket  │  Single connection per client
                    │  Multiplex  │  Multiple concurrent requests via requestId
                    └──────┬──────┘
                           │
                    Client (ptunnel)
                           │
                    localhost:3000
```

### TCP Tunnels

```
TCP Client ──> Server:30001 (direct, bypasses Nginx)
                    │
              net.Server on allocated port
                    │
              WebSocket (same connection, FRAME_TCP_DATA frames)
                    │
              Client (ptunnel)
                    │
              localhost:25565
```

TCP tunnels bypass Nginx entirely and connect directly to the allocated port. The server auto-manages firewall rules when run with admin/root privileges.

---

## Project Structure

```
PrivateTunnel/
├── package.json              # Dependencies: ws, better-sqlite3
├── .gitignore
├── README.md
│
├── shared/
│   └── protocol.js           # Wire protocol — message types, binary frame encoding
│
├── server/
│   ├── index.js              # Entry point — starts 3 HTTP servers (8080, 8081, 8082)
│   ├── tunnel-manager.js     # Core — maps subdomains to WebSocket connections
│   ├── subdomain.js          # Random 8-char hex subdomain generation
│   ├── proxy.js              # HTTP-to-WebSocket proxy — forwards browser requests
│   ├── dashboard.js          # Dashboard API + Web UI with authentication
│   ├── landing.js            # Landing page for the root domain
│   ├── firewall.js           # Auto firewall open/close (Windows/Linux)
│   └── db.js                 # SQLite database — clients, request logs, config
│
├── client/
│   ├── bin/ptunnel.js        # CLI entry point (#!/usr/bin/env node)
│   ├── tunnel-client.js      # WebSocket client + HTTP/TCP multiplexer
│   ├── local-forwarder.js    # Forwards HTTP requests to localhost:PORT
│   └── ui.js                 # Terminal UI (ANSI escape codes)
│
└── data/
    └── tunnel.db             # SQLite database (auto-created, gitignored)
```

---

## Prerequisites

- **Node.js** 18+ (tested on v22)
- **npm**
- **Nginx** (on server, for SSL termination and HTTP routing)
- A **domain** with wildcard DNS (e.g., `*.ex.example.com`)
- **SSL certificate** covering the wildcard domain

---

## Installation

```bash
git clone https://github.com/Jindanet/private-tunnel.git
cd private-tunnel
npm install
```

### Register global `ptunnel` command (optional)

```bash
npm link
```

---

## Server Setup

### Start the server

```bash
# Normal
node server/index.js

# With auto firewall management for TCP tunnels (recommended)
# Windows: Run as Administrator
# Linux/macOS:
sudo node server/index.js
```

If the server is not running with admin/root privileges, a warning is shown at startup:
```
[Firewall] WARNING: Not running as admin/root — TCP firewall rules will NOT be added automatically.
[Firewall]          To enable auto firewall: Run as Administrator
```

TCP tunnels still work without admin, but you must open the port range manually.

### Using PM2 (recommended for production)

```bash
npm install -g pm2
# Run as Administrator (Windows) or root (Linux)
pm2 start server/index.js --name ptunnel
pm2 save
pm2 startup   # Auto-start on boot
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `8080` | WebSocket server port |
| `DASHBOARD_PORT` | `8081` | Dashboard server port |
| `PROXY_PORT` | `8082` | HTTP proxy port |
| `DOMAIN` | *(required)* | Base domain (e.g. `ex.example.com`) |
| `DASHBOARD_PASSWORD` | `AdminTunnel1234` | Dashboard login password |
| `DB_PATH` | `./data/tunnel.db` | SQLite database path |
| `TCP_PORT_MIN` | `30000` | Start of TCP tunnel port range |
| `TCP_PORT_MAX` | `40000` | End of TCP tunnel port range |

---

## Client Usage

```bash
# HTTP tunnel → https://{id}.your-domain.com
ptunnel http 3000
ptunnel http localhost:3000

# TCP tunnel → your-domain.com:PORT
ptunnel tcp 25565      # Minecraft
ptunnel tcp 22         # SSH
ptunnel tcp 3306       # MySQL

# Shorthand (defaults to HTTP)
ptunnel 3000

# First run — save server URL
ptunnel http 3000 --server wss://your-domain.com/ws

# Subsequent runs — URL is remembered
ptunnel http 3000

# Help
ptunnel --help
```

### Client Identity

On first run, a unique `clientId` (UUID) is generated and saved to `~/.ptunnel`. This ensures the same subdomain is assigned on reconnect.

```json
~/.ptunnel → {"clientId": "a1b2c3d4-...", "serverUrl": "wss://your-domain.com/ws"}
```

---

## Pre-built Binaries

Build standalone executables (no Node.js required on client):

```bash
npm run build          # All platforms
npm run build:win      # Windows x64  → dist/ptunnel-win.exe
npm run build:linux    # Linux x64    → dist/ptunnel-linux
npm run build:macos    # macOS x64    → dist/ptunnel-macos
npm run build:macos-arm # macOS ARM64 → dist/ptunnel-macos-arm64 (run on macOS/Linux only)
```

Usage on Linux/macOS:
```bash
chmod +x ptunnel-linux
./ptunnel-linux http 3000 --server wss://your-domain.com/ws
```

---

## TCP Firewall Management

When a TCP tunnel is opened, the server automatically:
1. Finds a free port in `TCP_PORT_MIN`–`TCP_PORT_MAX` (skips ports in use by other processes)
2. Opens the firewall rule for that port
3. Closes the firewall rule when the client disconnects

| Platform | Firewall Command |
|----------|-----------------|
| Windows | `netsh advfirewall firewall add/delete rule` |
| Linux | `ufw allow/delete` → fallback `iptables` |
| macOS | Not needed (app-based firewall) |

**Requires admin/root.** Without it, auto-firewall is skipped and a warning is shown.

Manual firewall (Windows, open range once):
```powershell
netsh advfirewall firewall add rule name="PTunnel TCP" dir=in action=allow protocol=TCP localport=30000-40000
```

---

## Dashboard

Access at `https://your-domain.com/dashboard`

### Authentication
- Password set via `DASHBOARD_PASSWORD` in `.env`
- Session-based (cookie, 24-hour TTL)

### Dashboard Tabs

**Active Tunnels:**
- Subdomain, Client IP, Hostname, OS, Port, Tunnel type (HTTP/TCP)
- Request count, Bytes In/Out
- Recent requests per tunnel

**Request Logs:**
- Full history stored in SQLite (auto-cleanup after 7 days)

**All Clients:**
- All registered clients (even offline)

### Dashboard API

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | Server status, uptime, memory, tunnel count |
| `GET /api/tunnels` | Active tunnels with details |
| `GET /api/clients` | All registered clients from DB |
| `GET /api/logs` | Recent 200 request logs |
| `GET /api/logs/:subdomain` | Logs + stats for a specific subdomain |

---

## DNS & SSL Configuration

### The Problem

We use **Cloudflare** for DNS. The tunnel system requires wildcard subdomains (`*.ex.example.com`). However:

- **Cloudflare Free plan** does NOT issue SSL certificates for wildcard subdomains
- **Cloudflare Origin Certificate** only works when traffic passes through Cloudflare proxy (orange cloud)
- Wildcard proxy requires **Cloudflare Pro** ($20/month)

### The Solution: Let's Encrypt + DNS Only

Use **Let's Encrypt** wildcard certificates with DNS-01 validation, bypassing Cloudflare's SSL entirely.

#### Step 1: Cloudflare DNS Records (DNS Only / Grey Cloud)

```
Type    Name    Content         Proxy Status
A       iam     168.x.x.x      DNS Only (grey)
A       *.iam   168.x.x.x      DNS Only (grey)
```

**Important:** Both records must be **DNS Only** (grey cloud).

#### Step 2: Obtain Wildcard Certificate (Windows — win-acme)

```powershell
wacs.exe
```

Interactive setup:
1. `M` — Create certificate (full options)
2. `2` — Manual input
3. Host: `ex.example.com,*.ex.example.com`
4. `4` — Single certificate
5. `6` — DNS-01 manual validation
6. `2` — RSA key
7. `2` — PEM encoded files
8. Path: `/path/to/nginx/ssl`
9. Password: `1` — None
10. Additional store: `5` — No
11. Installation: `3` — No

During validation, create TXT records at `_acme-challenge.ex.example.com` in Cloudflare (two rounds).

Output files:
```
ex.example.com-chain.pem      # Full chain
ex.example.com-key.pem        # Private key
```

---

## Nginx Configuration

### SSL Configuration (`ssl_tunnel.conf`)

```nginx
ssl_certificate     /path/to/nginx/ssl/ex.example.com-chain.pem;
ssl_certificate_key /path/to/nginx/ssl/ex.example.com-key.pem;
```

### Site Configuration

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name ex.example.com *.ex.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ex.example.com *.ex.example.com;

    include /path/to/nginx/conf/ssl_tunnel.conf;

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_read_timeout  86400;
        proxy_send_timeout  86400;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
    }

    location /dashboard {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
    }

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_buffering        off;
        proxy_request_buffering off;
        proxy_connect_timeout  180s;
        proxy_read_timeout     180s;
    }
}
```

**Note:** TCP tunnel ports (30000–40000) bypass Nginx entirely — clients connect directly to the server IP.

---

## Problems Encountered & Solutions

### 1. Cloudflare Free Plan — No Wildcard SSL

**Problem:** `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` on wildcard subdomains.

**Solution:** Let's Encrypt wildcard certificate via win-acme with manual DNS-01 validation. DNS records set to DNS Only (grey cloud).

### 2. Nginx `ssl.conf` Conflict

**Problem:** `"ssl_ciphers" directive is duplicate` — tunnel SSL config conflicted with other services.

**Solution:** Created a separate `ssl_tunnel.conf` with only certificate paths. TLS protocols/ciphers inherited from main nginx config.

### 3. Nginx `$connection_upgrade` Variable Unknown

**Problem:** `nginx -t` failed with `unknown "connection_upgrade" variable`.

**Solution:** Add `map` block at the `http` level (outside all `server` blocks).

### 4. DNS Cache — `DNS_PROBE_FINISHED_NXDOMAIN`

**Problem:** DNS resolved on other machines but not locally after Cloudflare update.

**Solution:** `ipconfig /flushdns` + change DNS to Google `8.8.8.8`.

### 5. WebSocket `ws://` vs `wss://`

**Problem:** Protocol mismatch caused silent connection failures.

**Solution:** Use `wss://` in production (behind nginx SSL), `ws://` for local dev.

### 6. UI Rendering Flat on Windows

**Problem:** ANSI `\x1b[2J` (clear screen) didn't work on Windows Terminal — all output appeared on one line.

**Solution:** Switched to per-line cursor movement (`MOVE_UP` + `CLEAR_LINE`) and `\r\n` line endings on Windows.

### 7. SQLite Schema Migration

**Problem:** `table clients has no column named ip` after schema update.

**Solution:** Delete `data/tunnel.db` and restart — schema is recreated automatically.

### 8. TCP Firewall on Non-Admin Process

**Problem:** `netsh`/`iptables` fail silently when server runs without admin/root.

**Solution:** Detect elevation at startup and print a clear warning. TCP tunnels still work if firewall rules are pre-configured manually.

---

## Wire Protocol

All communication happens over a single WebSocket connection per client.

### Control Messages (JSON text frames)

| Type | Direction | Description |
|------|-----------|-------------|
| `tunnel:open` | Client → Server | Request a tunnel (includes `tunnelType`, clientId, hostname, OS) |
| `tunnel:assigned` | Server → Client | Tunnel created (subdomain, URL, tcpPort if TCP) |
| `tunnel:close` | Client → Server | Graceful disconnect |
| `request:start` | Server → Client | Incoming HTTP request (method, path, headers) |
| `response:start` | Client → Server | HTTP response metadata (statusCode, headers) |
| `stream:end` | Both | Stream complete for a requestId |
| `stream:error` | Both | Error for a requestId |
| `tcp:connect` | Server → Client | New TCP connection arrived (connId) |
| `tcp:close` | Both | TCP connection closed (connId) |
| `ping` / `pong` | Both | Keepalive (every 30s) |

### Data Frames (Binary WebSocket frames)

```
[1 byte: frame type] [16 bytes: ID (UUID)] [N bytes: data chunk]

Frame types:
  0x01 = HTTP request body   (Server → Client)
  0x02 = HTTP response body  (Client → Server)
  0x03 = TCP data            (Both directions, keyed by connId)
```

---

## Database Schema

SQLite database at `data/tunnel.db`:

### `clients`
| Column | Type | Description |
|--------|------|-------------|
| client_id | TEXT PK | UUID from client's `~/.ptunnel` |
| subdomain | TEXT UNIQUE | Assigned 8-char hex subdomain |
| ip | TEXT | Client's public IP |
| hostname | TEXT | Client's OS hostname |
| os | TEXT | Client's OS info |
| created_at | TEXT | First connection time |
| last_seen | TEXT | Last connection time |

### `request_logs`
| Column | Type | Description |
|--------|------|-------------|
| subdomain | TEXT | Which tunnel |
| visitor_ip | TEXT | Browser/visitor IP |
| method | TEXT | GET, POST, etc. |
| path | TEXT | Request path |
| status_code | INTEGER | HTTP response status |
| latency_ms | INTEGER | Round-trip time |
| created_at | TEXT | Timestamp |

Logs are auto-cleaned after 7 days.

### `config`
| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PK | Config key |
| value | TEXT | Config value (dashboard password stored as SHA-256 hash) |

---

## License

MIT

---

Built by [Jindanet](https://github.com/Jindanet)
