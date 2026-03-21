# PrivateTunnel

**Self-hosted ngrok alternative** — Expose your localhost to the internet with a single command.

```bash
$ ptunnel localhost:3000

  PrivateTunnel   (Ctrl+C to quit)
  ────────────────────────────────────────────
  Status:      ● online
  Forwarding:  https://a7f3bc01.ex.example.com → localhost:3000
```

## Table of Contents

- [Background](#background)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Server Setup](#server-setup)
- [Client Usage](#client-usage)
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

1. **Client runs a single command** (`ptunnel localhost:3000`) and gets a unique public URL
2. **Each client gets a persistent subdomain** — reconnecting gives the same URL
3. **Server manages everything** — no port forwarding, no manual configuration
4. **Real-time dashboard** with authentication to monitor all tunnels and requests
5. **Minimal dependencies** — only Node.js built-ins + `ws` + `better-sqlite3`

The system is deployed at **ex.example.com** with wildcard subdomains (`*.ex.example.com`), so each tunnel client gets a URL like `https://a7f3bc01.ex.example.com`.

---

## Architecture

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

### Data Flow

1. Browser visits `https://abc123.ex.example.com/some/path`
2. Nginx terminates SSL, forwards to port 8082
3. Server extracts subdomain `abc123` from Host header
4. Server finds the WebSocket connection for that subdomain
5. Server serializes the HTTP request and sends it through WebSocket
6. Client receives the request, forwards it to `localhost:3000`
7. Local service responds
8. Client sends response back through WebSocket
9. Server writes the response back to the browser

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
│   ├── landing.js            # Landing page for ex.example.com
│   └── db.js                 # SQLite database — clients, request logs, config
│
├── client/
│   ├── bin/ptunnel.js        # CLI entry point (#!/usr/bin/env node)
│   ├── tunnel-client.js      # WebSocket client + request multiplexer
│   ├── local-forwarder.js    # Forwards requests to localhost:PORT
│   └── ui.js                 # Terminal UI (ANSI escape codes)
│
└── data/
    └── tunnel.db             # SQLite database (auto-created, gitignored)
```

---

## Prerequisites

- **Node.js** 18+ (tested on v22)
- **npm**
- **Nginx** (on server, for SSL termination and routing)
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

Now you can use `ptunnel` from anywhere.

---

## Server Setup

### Start the server

```bash
node server/index.js
```

This starts 3 services:

| Port | Service | Description |
|------|---------|-------------|
| 8080 | WebSocket Server | Tunnel client connections (`/ws`) |
| 8081 | Dashboard Server | Admin UI (`/dashboard`) + API (`/api/*`) |
| 8082 | HTTP Proxy | Tunnel traffic — routes `*.ex.example.com` requests |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_PORT` | `8080` | WebSocket server port |
| `DASHBOARD_PORT` | `8081` | Dashboard server port |
| `PROXY_PORT` | `8082` | HTTP proxy port |
| `DOMAIN` | `ex.example.com` | Base domain |
| `DB_PATH` | `./data/tunnel.db` | SQLite database path |

---

## Client Usage

```bash
# Basic — tunnel port 3000
ptunnel localhost:3000

# Shorthand
ptunnel 3000

# Custom server URL (for development/testing)
ptunnel 3000 --server ws://localhost:8080/ws

# Help
ptunnel --help
```

### Client Identity

On first run, a unique `clientId` (UUID) is generated and saved to `~/.ptunnel`. This ID is sent to the server on every connection, ensuring the same subdomain is assigned each time.

```
~/.ptunnel → {"clientId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"}
```

---

## Dashboard

Access at `https://ex.example.com/dashboard`

### Authentication
- Default password: set in `server/db.js` (configurable)
- Session-based (cookie, 24-hour TTL)

### Dashboard Tabs

**Active Tunnels:**
- Subdomain, Client IP, Hostname, OS, Port
- Request count, Bytes In/Out
- Recent requests per tunnel (visitor IP, method, path, status, latency, user-agent)

**Request Logs:**
- Full history stored in SQLite (auto-cleanup after 7 days)
- Time, Subdomain, Visitor IP, Method, Path, Status, Latency, User-Agent

**All Clients:**
- All registered clients (even offline)
- Client ID, Subdomain, IP, Hostname, OS, Created, Last Seen

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

We use **Let's Encrypt** wildcard certificates with DNS validation, bypassing Cloudflare's SSL entirely.

#### Step 1: Cloudflare DNS Records (DNS Only / Grey Cloud)

```
Type    Name    Content         Proxy Status
A       iam     168.x.x.x      DNS Only (grey)
A       *.iam   168.x.x.x      DNS Only (grey)
```

**Important:** Both records must be **DNS Only** (grey cloud), not Proxied (orange cloud).

#### Step 2: Obtain Wildcard Certificate

On Windows server, we used **[win-acme](https://www.win-acme.com/)** (WACS):

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

During validation, win-acme asks you to create TXT records at `_acme-challenge.ex.example.com` in Cloudflare. Two rounds (one for `*.ex.example.com`, one for `ex.example.com`).

Output files:
```
ex.example.com-chain.pem      # Full chain (cert + intermediate)
ex.example.com-key.pem        # Private key
ex.example.com-crt.pem        # Certificate only
ex.example.com-chain-only.pem # Intermediate only
```

**Note:** Certificate auto-renews via Windows Task Scheduler, but manual DNS validation is required each time. For automated renewal, use the Cloudflare DNS plugin for win-acme.

---

## Nginx Configuration

### SSL Configuration (`ssl_tunnel.conf`)

Separate SSL config for the tunnel (other services on the server may use different certificates):

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

    # WebSocket tunnel connections
    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_read_timeout  86400;
        proxy_send_timeout  86400;
    }

    # Dashboard API
    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # Dashboard UI
    location /dashboard {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_read_timeout 60s;
    }

    # Tunnel traffic (catch-all)
    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_connect_timeout  180s;
        proxy_read_timeout     180s;
        proxy_buffering        off;
        proxy_request_buffering off;
    }
}
```

**Important:** The `map` block for `$connection_upgrade` must be placed **outside** the `server` block (at the `http` level). Without it, nginx will fail with `unknown "connection_upgrade" variable`.

---

## Problems Encountered & Solutions

### 1. Cloudflare Free Plan — No Wildcard SSL

**Problem:** Cloudflare Free plan does not issue SSL certificates for wildcard subdomains. Visiting `abc123.ex.example.com` returned `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`.

**Tried:**
- Cloudflare Origin Certificate — only works with Proxied mode (orange cloud)
- Cloudflare Flexible SSL — conflicts with other services that require Full (Strict) mode
- DNS Only mode — no SSL at all

**Solution:** Use **Let's Encrypt wildcard certificate** via **win-acme** on Windows server with manual DNS-01 validation. Set DNS records to DNS Only (grey cloud).

### 2. Nginx `ssl.conf` Conflict

**Problem:** The tunnel's SSL config conflicted with other services' `ssl.conf` (duplicate `ssl_protocols`, `ssl_ciphers` directives).

```
nginx: [emerg] "ssl_ciphers" directive is duplicate in ssl_tunnel.conf:8
```

**Solution:** Created a separate `ssl_tunnel.conf` containing **only** the certificate paths. TLS protocols and ciphers are inherited from the main nginx config.

### 3. Nginx `$connection_upgrade` Variable Unknown

**Problem:** `nginx -t` failed with `unknown "connection_upgrade" variable`.

**Solution:** The `map` block was missing. It must be defined at the `http` level (outside `server` blocks):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

### 4. DNS Cache — `DNS_PROBE_FINISHED_NXDOMAIN`

**Problem:** After adding DNS records in Cloudflare, the domain resolved on other machines but not locally.

**Solution:**
1. `ipconfig /flushdns`
2. Change DNS server to Google DNS (`8.8.8.8`)
3. Use `nslookup ex.example.com 8.8.8.8` to verify resolution via Google DNS
4. Change system DNS in Windows Settings → Network → DNS

### 5. WebSocket `ws://` vs `wss://`

**Problem:** Client defaulted to `wss://` (SSL) but during testing without SSL, connections failed silently.

**Solution:** Match the client's default URL to the server's actual protocol. In production with nginx SSL: `wss://ex.example.com/ws`. During local development: `ws://localhost:8080/ws`.

### 6. Client-Server Architecture — Single Port vs Multi-Port

**Problem:** Initial design used a single port for everything. The nginx config required separate ports for different services.

**Solution:** Split into 3 ports:
- **8080** — WebSocket only (tunnel connections)
- **8081** — Dashboard (API + Web UI)
- **8082** — HTTP proxy (tunnel traffic)

Each mapped to a specific nginx `location` block.

### 7. SQLite Schema Migration

**Problem:** Adding new columns (IP, hostname, OS) to the `clients` table caused `table clients has no column named ip` error because the old database file still existed.

**Solution:** Delete the old `data/tunnel.db` file and restart the server. The new schema is created automatically.

---

## Wire Protocol

All communication happens over a single WebSocket connection per client.

### Control Messages (JSON text frames)

| Type | Direction | Description |
|------|-----------|-------------|
| `tunnel:open` | Client → Server | Request a tunnel (includes clientId, hostname, OS) |
| `tunnel:assigned` | Server → Client | Tunnel created (includes subdomain, URL) |
| `tunnel:close` | Client → Server | Graceful disconnect |
| `request:start` | Server → Client | Incoming HTTP request (method, path, headers) |
| `response:start` | Client → Server | HTTP response metadata (statusCode, headers) |
| `stream:end` | Both | Stream complete for a requestId |
| `stream:error` | Both | Error for a requestId |
| `ping` / `pong` | Both | Keepalive (every 30s) |

### Data Frames (Binary WebSocket frames)

```
[1 byte: frame type] [16 bytes: requestId UUID] [N bytes: data chunk]

Frame types:
  0x01 = Request body  (Server → Client)
  0x02 = Response body (Client → Server)
```

Multiple concurrent HTTP requests are multiplexed over the single WebSocket using `requestId` to route data chunks to the correct transaction.

---

## Database Schema

SQLite database at `data/tunnel.db`:

### `clients` — Registered tunnel clients
| Column | Type | Description |
|--------|------|-------------|
| client_id | TEXT PK | UUID from client's `~/.ptunnel` |
| subdomain | TEXT UNIQUE | Assigned 8-char hex subdomain |
| ip | TEXT | Client's public IP |
| hostname | TEXT | Client's OS hostname |
| os | TEXT | Client's OS info |
| created_at | TEXT | First connection time |
| last_seen | TEXT | Last connection time |

### `request_logs` — HTTP request history
| Column | Type | Description |
|--------|------|-------------|
| subdomain | TEXT | Which tunnel |
| visitor_ip | TEXT | Browser/visitor IP |
| method | TEXT | GET, POST, etc. |
| path | TEXT | Request path |
| host | TEXT | Host header |
| user_agent | TEXT | Browser user-agent |
| referer | TEXT | Referer header |
| status_code | INTEGER | HTTP response status |
| latency_ms | INTEGER | Round-trip time |
| created_at | TEXT | Timestamp |

Logs are auto-cleaned after 7 days.

### `config` — Server configuration
| Column | Type | Description |
|--------|------|-------------|
| key | TEXT PK | Config key |
| value | TEXT | Config value |

Used for dashboard password (stored as SHA-256 hash).

---

## License

MIT

---

Built by [Jindanet](https://github.com/Jindanet)
