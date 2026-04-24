# PrivateTunnel

Hoster-first self-hosted tunnel platform for HTTP and TCP services.

PrivateTunnel lets a server owner manage publish domains, admin routes, authentication, request visibility, and client onboarding from one place while keeping the client side short and simple.

```bash
# First-time client setup
ptunnel init --server wss://ex.example.com/_private-tunnel/ws --token YOUR_TOKEN

# After that, daily usage stays short
ptunnel http 3000
ptunnel tcp 25565
ptunnel http 3000 --domain app.ex.example.com
ptunnel http 3000 --domain demo.ex.example.com --root
```

## What Changed

This project now includes:

- Hoster-first server settings stored in the database, seeded from `.env` on first boot
- Multiple publish domains per server, each with independent `subdomain` and `root` publishing flags
- Dedicated control namespace under `/_private-tunnel/*` so normal site routes and `/api` do not collide with the tunnel system
- Bilingual admin/dashboard UI with English as the primary language and Thai as an optional switch
- Bilingual desktop GUI client with clearer onboarding copy and mandatory saved server profile
- Safer admin bootstrap behavior: if `DASHBOARD_PASSWORD` is empty, a random bootstrap password is generated and written under `DATA_DIR`
- Dual database support: SQLite, MySQL, or both with optional mirror sync
- Remembered custom host labels for HTTP tunnels, plus server-side availability checking before the tunnel starts
- Updated client onboarding flow so users save `--server` and `--token` once instead of repeating them on every command

## Architecture

PrivateTunnel uses three internal ports:

- `WS_PORT` for tunnel client WebSocket connections
- `DASHBOARD_PORT` for the admin UI and admin API
- `PROXY_PORT` for public HTTP tunnel traffic

Recommended external layout behind Nginx:

```text
Internet
  |
  +-- https://ex.example.com/_private-tunnel/admin   -> Dashboard
  +-- wss://ex.example.com/_private-tunnel/ws        -> Tunnel client WebSocket
  +-- https://*.app.ex.example.com                   -> HTTP tunnels
  +-- https://demo.ex.example.com                    -> Optional exact-root HTTP tunnels
  +-- tcp://games.ex.example.com:30001+             -> TCP tunnels (direct, not through Nginx)
```

Control-plane routes are isolated under `/_private-tunnel`:

- Admin UI: `/_private-tunnel/admin`
- Admin API: `/_private-tunnel/admin/api/*`
- Admin live updates: `/_private-tunnel/admin/live`
- Client WebSocket: `/_private-tunnel/ws`

The legacy client WebSocket path `/ws` is still accepted by the server for compatibility, but all current examples use `/_private-tunnel/ws`.

## Project Structure

```text
PrivateTunnel/
├── app/                    # Electron desktop client
├── client/                 # CLI client and tunnel runtime
├── server/                 # Server, dashboard, routing, database
├── shared/                 # Wire protocol
├── data/                   # Runtime data (gitignored)
├── .env.example
├── package.json
└── README.md
```

Important server files:

- `server/index.js`: boots WebSocket, dashboard, and proxy services
- `server/dashboard.js`: admin UI, admin API, snippets, bilingual dashboard
- `server/db.js`: SQLite/MySQL storage and config bootstrap logic
- `server/routing.js`: route/domain normalization and runtime route generation
- `server/tunnel-manager.js`: tunnel assignment, remembered host logic, preview validation

Important client files:

- `client/bin/ptunnel.js`: CLI onboarding and tunnel commands
- `client/tunnel-client.js`: runtime client for HTTP and TCP tunnels
- `client/server-url.js`: default control path normalization
- `app/main.js`: desktop app main process and secure IPC bridge
- `app/renderer/*`: bilingual desktop UI

## Requirements

- Node.js 18+
- npm
- Nginx on the server
- One or more domains pointed at the server
- TLS certificates for the domains you publish
- MySQL if you want MySQL as the primary backend

## Installation

```bash
git clone https://github.com/Jindanet/private-tunnel.git
cd private-tunnel
npm install
```

Optional global CLI install:

```bash
npm link
```

Start the server:

```bash
node server/index.js
```

For TCP tunnel firewall automation, run with elevated privileges:

- Windows: run as Administrator
- Linux/macOS: run with `sudo`

## Environment Variables

The server reads `.env` on startup, then stores hoster settings in the database. On first boot, `.env` seeds the database. After that, the admin UI becomes the main place to manage domains, control route, and tunnel token.

### Core network settings

| Variable | Default | Description |
| --- | --- | --- |
| `WS_PORT` | `8080` | Internal WebSocket server port for tunnel clients |
| `DASHBOARD_PORT` | `8081` | Internal dashboard/admin API port |
| `PROXY_PORT` | `8082` | Internal public HTTP proxy port |
| `PRIMARY_DOMAIN` | empty | Main control-plane domain for the admin UI and default client WebSocket |
| `TUNNEL_DOMAIN` | empty | Optional legacy/default publish domain used during initial bootstrap |
| `TUNNEL_TOKEN` | empty | Client access secret. Leave empty only for fully open/private test setups |
| `DASHBOARD_PASSWORD` | empty | Optional explicit admin password. If empty, a random bootstrap password is generated |
| `DATA_DIR` | `./data` | Runtime data directory |
| `TCP_PORT_MIN` | `30000` | First TCP tunnel port |
| `TCP_PORT_MAX` | `40000` | Last TCP tunnel port |

### Database settings

| Variable | Default | Description |
| --- | --- | --- |
| `DB_PROVIDER` | `mysql` | Primary backend: `mysql` or `sqlite` |
| `DB_SYNC_TARGETS` | empty | Optional mirror backends, comma-separated, for example `sqlite` or `mysql,sqlite` |
| `DB_SYNC_STRICT` | `false` | When `true`, mirror write failures also fail the main request |
| `DB_BOOTSTRAP_SYNC` | `true` | Auto-seed empty backends from the first backend that already has data |
| `SQLITE_PATH` | `./data/tunnel.db` | SQLite file path |
| `MYSQL_HOST` | `127.0.0.1` | MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port |
| `MYSQL_USER` | `privatetunnel` in `.env.example` | MySQL username |
| `MYSQL_PASSWORD` | empty | MySQL password |
| `MYSQL_DATABASE` | `privatetunnel` | Database name |
| `DB_PATH` | alias | Backward-compatible alias for old SQLite-only installs |

### Example `.env`

```env
WS_PORT=8080
DASHBOARD_PORT=8081
PROXY_PORT=8082

PRIMARY_DOMAIN=ex.example.com
TUNNEL_DOMAIN=tunnel.ex.example.com
TUNNEL_TOKEN=replace-with-a-real-secret
DASHBOARD_PASSWORD=

DB_PROVIDER=mysql
DB_SYNC_TARGETS=sqlite
DB_SYNC_STRICT=false
DB_BOOTSTRAP_SYNC=true

SQLITE_PATH=./data/tunnel.db
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=privatetunnel
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=privatetunnel
```

## Database Modes

PrivateTunnel supports three practical setups:

### 1. SQLite only

```env
DB_PROVIDER=sqlite
DB_SYNC_TARGETS=
```

Good for small single-host setups.

### 2. MySQL only

```env
DB_PROVIDER=mysql
DB_SYNC_TARGETS=
```

Recommended for production and larger installs.

### 3. MySQL primary with SQLite mirror

```env
DB_PROVIDER=mysql
DB_SYNC_TARGETS=sqlite
DB_BOOTSTRAP_SYNC=true
```

Useful during migration or when you want a local mirror.

### Migration notes

- Schema creation is automatic on startup for both backends.
- Missing columns and indexes are added automatically.
- Empty backends can be bootstrapped from a backend that already has data when `DB_BOOTSTRAP_SYNC=true`.
- This means older SQLite installs can be moved toward MySQL without a separate manual migration script, as long as both backends are configured and the server is started with sync enabled.

## First Boot

On first startup:

1. The configured database schema is created or upgraded.
2. `PRIMARY_DOMAIN`, `TUNNEL_DOMAIN`, `TUNNEL_TOKEN`, and the default control root are seeded into the database if missing.
3. If `DASHBOARD_PASSWORD` is set, it is hashed and stored.
4. If `DASHBOARD_PASSWORD` is empty, PrivateTunnel generates a random bootstrap password and writes it to:

```text
<DATA_DIR>/admin-bootstrap.txt
```

Rotate that password from the admin UI after the first successful login.

## Admin Dashboard

Default admin URL:

```text
https://ex.example.com/_private-tunnel/admin
```

The dashboard is designed for the server owner, not tunnel end-users.

What the dashboard manages:

- Primary domain and control namespace
- Tunnel token
- Publish domains
- Admin password rotation
- Active tunnels
- Known clients
- Recent request logs
- Generated DNS/client/Nginx snippets

### Publish domains

Each publish domain can independently allow:

- Random or remembered subdomains
- Exact root publishing

Examples:

- `app.ex.example.com` with `allowSubdomain=true`, `allowRoot=false`
- `demo.ex.example.com` with `allowSubdomain=true`, `allowRoot=true`
- `games.ex.example.com` for TCP address branding

The primary control-plane domain root is reserved for the admin/control plane. Root publishing on the primary domain is automatically disabled.

### Dashboard API

Key endpoints:

- `GET /_private-tunnel/admin/api/overview`
- `GET /_private-tunnel/admin/api/clients`
- `GET /_private-tunnel/admin/api/logs`
- `POST /_private-tunnel/admin/api/settings`
- `POST /_private-tunnel/admin/api/password`

These live under the admin namespace so they do not collide with your public website `/api` routes.

## Client CLI

The CLI now uses a two-step onboarding flow.

### Step 1. Save the server profile once

```bash
ptunnel init --server wss://ex.example.com/_private-tunnel/ws --token YOUR_TOKEN
```

Equivalent setup form:

```bash
ptunnel --server wss://ex.example.com/_private-tunnel/ws --token YOUR_TOKEN
```

This stores the server URL and token in the client config file:

```text
~/.ptunnel
```

Useful commands:

```bash
ptunnel status
ptunnel reset
```

### Step 2. Use short tunnel commands

```bash
ptunnel http 3000
ptunnel tcp 25565
ptunnel 8080
```

Optional publish-domain flags:

```bash
ptunnel http 3000 --domain app.ex.example.com
ptunnel http 3000 --domain demo.ex.example.com --root
```

Important behavior:

- `--server` and `--token` are now setup-only inputs
- The CLI refuses to mix `--server` or `--token` with a tunnel command in the same call
- The server profile must exist before a tunnel can start
- The saved profile is normalized to the default `/_private-tunnel/ws` path if you provide only a hostname

## Desktop GUI

The desktop app is the friendliest client for non-technical users.

Current desktop app behavior:

- Requires a saved server profile before any tunnel can be created
- Bilingual UI with English as the default language and Thai as an optional switch
- Clear setup screen for server WebSocket URL and token
- Reusable tunnel profiles for HTTP and TCP
- Optional publish domain selection
- Optional remembered custom host label with server-side availability checking
- One-click start and stop
- Per-tunnel recent activity preview

Build the desktop app:

```bash
npm run build:app:win
npm run build:app:linux
npm run build:app:mac
```

Run in development:

```bash
npm run app
```

### Troubleshooting Build Errors

If you encounter errors during the build process, follow these steps:

#### 1. Native Module Build Error (EPERM)

If you see an error like:
```
⨯ [Error: EPERM: operation not permitted, unlink '...\better-sqlite3\build\Release\better_sqlite3.node']
```

**Solution:**
```bash
# Remove the locked file
rm -f node_modules/better-sqlite3/build/Release/better_sqlite3.node

# Try building again
npm run build:app:win
```

#### 2. Code Signing Tools Error (Symbolic Links)

If you see errors about creating symbolic links during code signing:
```
ERROR: Cannot create symbolic link : A required privilege is not held by the client
```

**Solution:**
```bash
# The app actually built successfully! The error only affects the final ZIP creation.
# Your unpacked app is available at: dist-app/win-unpacked/PrivateTunnel.exe

# Create the distribution ZIP manually:
cd dist-app
powershell Compress-Archive -Path "win-unpacked\*" -DestinationPath "PrivateTunnel-win-x64.zip" -Force

# Your distribution is ready at: dist-app/PrivateTunnel-win-x64.zip
```

#### 3. Alternative: Build without Code Signing

To avoid code signing errors entirely, you can disable signing in `package.json`:

```json
"win": {
  "target": [{"target": "zip", "arch": ["x64"]}],
  "signingHashAlgorithms": [],
  "sign": null
}
```

Then build normally and manually create the ZIP if needed.

#### 4. Run as Administrator (Windows)

For persistent build issues, try running your terminal as Administrator before building.

## Nginx Setup

PrivateTunnel no longer tries to manage Nginx for you. Instead, the dashboard provides setup guidance and examples. This keeps the app from rewriting unrelated Nginx configuration on the host.

The key rule is:

- Reserve `/_private-tunnel/*` for the control plane
- Send all normal public tunnel traffic to the proxy server
- Keep your site-specific SSL includes under your own Nginx layout

### Why the dedicated control namespace matters

Older `/api` or `/dashboard` style paths can collide with real applications behind the tunnel. Using `/_private-tunnel/*` avoids that conflict.

### Example 1. Control plane + subdomain publishing

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name ex.example.com *.app.ex.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ex.example.com *.app.ex.example.com;

    include C:/path/to/your-own-ssl/ex.example.com.conf;

    location ^~ /_private-tunnel/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }

    location = /_private-tunnel/ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

### Example 2. Exact root publish domain

This is for a domain that should publish directly at the root, such as `demo.ex.example.com`.

```nginx
server {
    listen 80;
    server_name demo.ex.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name demo.ex.example.com;

    include C:/path/to/your-own-ssl/demo.ex.example.com.conf;

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

### Example 3. TCP publishing

TCP tunnels do not pass through Nginx. The server returns addresses like:

```text
games.ex.example.com:30001
games.ex.example.com:30002
```

Open the configured TCP port range on your firewall.

## DNS and TLS

Suggested DNS records:

```text
A     ex.example.com           -> <your-server-ip>
A     *.app.ex.example.com     -> <your-server-ip>
A     demo.ex.example.com      -> <your-server-ip>
A     games.ex.example.com     -> <your-server-ip>
```

### Win-acme workflow on Windows

If you manage certificates with win-acme:

1. Run `wacs.exe`
2. Create certificates for each hostname or wildcard you plan to publish
3. Export PEM files
4. Keep your own SSL include files per domain
5. Reference those include files from your Nginx vhosts

PrivateTunnel only generates guidance and examples. It does not replace your existing SSL include layout.

## Security Notes

- Always set a strong `TUNNEL_TOKEN`
- Rotate the bootstrap admin password after first login
- Keep the admin UI behind TLS
- Do not publish the control-plane namespace through unrelated reverse proxies
- Root publishing on the primary control domain is intentionally blocked

## Wire Protocol

Control messages are JSON text frames over one WebSocket per client. Binary frames carry HTTP body chunks or TCP stream data.

Main message families:

- `tunnel:open`
- `tunnel:assigned`
- `tunnel:check`
- `tunnel:check-result`
- `request:start`
- `response:start`
- `stream:end`
- `stream:error`
- `tcp:connect`
- `tcp:close`
- `ping`
- `pong`

See `shared/protocol.js` for the canonical message list.

## Development Scripts

```bash
npm run server
npm run client
npm run app
npm run build:win
npm run build:linux
npm run build:macos
npm run build:app:win
```

## License

MIT
