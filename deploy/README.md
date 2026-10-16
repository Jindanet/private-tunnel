# Deployment guide / คู่มือผู้ดูแล

This guide assumes one trusted server owner, a Linux server or Windows host, and Nginx on the **same machine** as PrivateTunnel. Read the [current limitations](../README.md#security-and-current-limitations) before offering tunnels to other people. The templates are starting points; no live service or firewall is changed by this repository.

## 1. DNS and TLS

For the example layout, point these DNS records to the server's public address:

```text
A  admin.example.com       -> SERVER_IP
A  *.apps.example.com      -> SERVER_IP
A  demo.example.net        -> SERVER_IP  (only if exact-root publishing is enabled)
```

Create the corresponding publish entries in the dashboard. A domain with subdomains disabled does not need a wildcard. A domain with exact-root publishing disabled does not publish the bare hostname.

On Linux, use an ACME client such as Certbot with the DNS plugin for your DNS provider. Request a certificate for `admin.example.com`, a wildcard certificate for `*.apps.example.com`, and the exact root hosts you intend to publish. If you publish both the root and wildcard names, request both names: `apps.example.com` and `*.apps.example.com`. Wildcards require **DNS-01**; an HTTP-only challenge cannot issue them. Use narrowly scoped DNS credentials, keep them outside the repository, and test automated renewal and the Nginx reload hook. Manual DNS validation needs a manual renewal process unless separately automated.

On Windows, win-acme can request certificates with DNS validation and export PEM files for Nginx. Configure automated DNS validation/renewal where your provider supports it. Use forward slashes in Nginx paths, for example `C:/nginx/certs/admin/fullchain.pem`.

See [Let's Encrypt challenge types](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge), [Certbot instructions](https://certbot.eff.org/instructions), and [win-acme DNS validation](https://www.win-acme.com/reference/plugins/validation/dns/).

## 2. Nginx host separation

Start with [nginx.example.conf](nginx.example.conf), or copy the generated template from the dashboard after configuring your domains. It belongs inside Nginx's `http` context (a typical `conf.d` include is already inside it). Replace all example hosts, certificate placeholders and internal ports. Keep only one copy of the `map` directive.

- The exact admin hostname has its own TLS block and only routes administrator and client-control paths.
- Every public host uses a separate block, including a wildcard under the admin domain. Each rejects the exact control root and all child paths before proxying normal traffic.
- WebSocket upgrade headers go to the admin/client control connections. Application WebSocket passthrough is not implemented by PrivateTunnel.
- `X-Real-IP`, `X-Forwarded-For` and `X-Forwarded-Proto` are overwritten by Nginx. Keep the internal listeners on loopback; only loopback peers can supply trusted forwarded headers.

Nginx 1.25.1+ accepts the separate `http2 on;` directive. If using an older supported distribution build, remove that line or adapt it to your distribution. The certificate paths are placeholders, so the template will deliberately fail until you replace them.

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Then verify that `https://admin.example.com/_private-tunnel/admin` loads and that `https://demo.apps.example.com/_private-tunnel/admin` returns 404, even if no tunnel is running. Also check the exact `/_private-tunnel` path. Normal application paths, including `/api`, should reach the HTTP proxy. See [Nginx server-name matching](https://nginx.org/en/docs/http/server_names.html) and [location matching](https://nginx.org/en/docs/http/ngx_http_core_module.html#location).

## 3. Linux service with systemd

Install Node.js 22.12+ using a trusted source and prepare dependencies on the target platform as a normal build user:

```bash
npm ci --omit=dev
```

Create the service account once. Install the runtime files from this checkout; do not copy Windows `node_modules` to Linux. The service account needs read access to the code and write access only to its state directory.

```bash
sudo useradd --system --home /var/lib/private-tunnel --shell /usr/sbin/nologin privatetunnel
sudo install -d -m 755 /opt/private-tunnel
sudo cp -a server shared node_modules package.json package-lock.json LICENSE deploy /opt/private-tunnel/
sudo install -d -o root -g privatetunnel -m 750 /etc/private-tunnel
sudo install -o root -g privatetunnel -m 640 .env /etc/private-tunnel/server.env
sudo install -m 644 deploy/private-tunnel.service /etc/systemd/system/private-tunnel.service
```

Edit `/etc/private-tunnel/server.env` with your real domains and database settings. For an existing MySQL deployment set `DB_PROVIDER=mysql` explicitly. systemd values from `EnvironmentFile=` can supersede the unit's `Environment=` defaults, so explicitly set these values in `/etc/private-tunnel/server.env`:

```dotenv
DATA_DIR=/var/lib/private-tunnel
SQLITE_PATH=/var/lib/private-tunnel/tunnel.db
INTERNAL_HOST=127.0.0.1
AUTO_FIREWALL=false
```

Use absolute paths: `DATA_DIR` does not override an explicit `SQLITE_PATH` or legacy `DB_PATH`. A copied relative SQLite path can otherwise point into `/opt/private-tunnel` instead of the service's writable state directory. Check `command -v node` and adjust `ExecStart` if Node is not installed at `/usr/bin/node`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now private-tunnel
sudo systemctl status private-tunnel
sudo journalctl -u private-tunnel -n 50
```

For a first installation, leave `TUNNEL_TOKEN` empty to generate a random 32-byte key. The initial control root is `/_private-tunnel`; `.env` does not configure it. Read `/var/lib/private-tunnel/admin-bootstrap.txt` privately, sign in through the TLS admin hostname and change the password. The file is removed on rotation. Get the generated client key from dashboard Settings.

A nonempty `TUNNEL_TOKEN` must be 32–4096 visible ASCII characters without whitespace and cannot begin with `your-`, `your_`, `replace-`, `replace_`, `change-`, `change_`, `example-` or `example_` (case insensitive). Invalid environment values stop startup even when a key is stored. Choose a cryptographically random key; the format check alone does not establish entropy.

```bash
curl --fail http://127.0.0.1:8081/healthz
```

This probe checks local process liveness only. Configure journal retention and host monitoring separately. A restart disconnects active tunnels and sessions; plan a maintenance window.

## 4. Linux Docker Compose alternative

The [Dockerfile](../Dockerfile) builds only the server runtime and runs it as the `node` user. The [Compose example](../compose.yaml) uses **Linux host networking**, a named data volume, a read-only root filesystem, no Linux capabilities and no privileged mode. It intentionally has no published internal ports.

Copy and edit `.env.example` as `.env`, then on a Linux Docker host:

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail 50 private-tunnel
```

Keep Nginx on that same Linux host and use loopback upstreams. Docker bridge networking changes the source IP seen by the server and does not match the current trusted-proxy policy. Docker Desktop is not the documented deployment target for this host-network configuration; use the native service or a Linux server.

TCP listeners also use the Linux host network. The operating system chooses an available public port when each TCP tunnel starts; the client/dashboard displays the assigned `host:port`. Allow that specific port in host/cloud firewalls and configure any upstream NAT forwarding after allocation. It can change on reconnect or restart. The provided configuration does not use Docker `ports:` mappings: static bridge mappings cannot predict ports assigned at runtime, so bridge-based public TCP deployment is not supported by this example. HTTP continues through the same Nginx loopback upstreams.

The named volume starts independently of an existing `./data` directory. It will **not** import an old database automatically. Back up and migrate the intended database before switching a live installation. Do not use `docker compose down --volumes` against data you intend to keep.

Read the bootstrap password privately with `docker compose exec private-tunnel cat /var/lib/private-tunnel/admin-bootstrap.txt`, sign in and rotate it. Use the dashboard for stored domain/key changes. A changed environment file requires recreating the container; restarting alone does not load new container environment values. Rebuild the image for code/dependency updates. MySQL on `127.0.0.1` refers to the Linux host with this network mode.

## 5. Windows service host

Install Node.js 22.12+, run `npm ci` from a normal account and configure `.env`. Keep `AUTO_FIREWALL=false` and the internal ports on loopback. Configure your existing Windows service manager to start `node server/index.js` with this checkout as the working directory, under a dedicated restricted account with access to the data directory. There is no Windows service installer included. Keep Nginx on the same host. Use the generated Nginx template with Windows PEM paths and test it before reload.

Do not elevate the whole tunnel server to Administrator for routine TCP allocation. The operating system selects each public TCP port automatically. After starting the tunnel, read the assigned `host:port` in the client/dashboard; a separate administrator should allow that exact port in Windows Defender Firewall and any cloud firewall, with router/NAT forwarding where needed. Review those rules when the address changes.

## 6. Backup, update and rollback

Stop the service for a simple consistent SQLite backup, then copy the database, `DATA_DIR/client-keys.json` registry and private configuration together to protected storage. Individual key hashes and stable owner IDs live in that registry; a database-only restore cannot restore authentication. An online SQLite copy needs a proper backup API; copying only the main file while WAL writes are active can lose data. MySQL requires its own consistent backup method. Keep secrets and bootstrap files private in backups.

Before an upgrade, save the current application version, database and configuration together. Review [1.1 migration notes](../README.md#upgrade-from-10-to-11), test the new version on copies, then schedule the restart. Review nonempty environment keys before starting: invalid values now stop startup. An invalid legacy stored access key permits administrator sign-in but denies tunnel authentication until rotation, and Settings requires replacing it before saving. Rotate to a random key and update all clients. To roll back, stop the new server and restore both the matching old code and its pre-upgrade database snapshot. Automatic schema changes and mirrored writes have no built-in versioned rollback.

Pre-authentication WebSocket upgrades have a per-IP limit of 60 attempts per minute across both tunnel routes and administrator live updates, independently of the HTTP administrator-login limit. Keep Nginx forwarding the real address as described above; clients behind one shared address can share this allowance.

Open HTTP/HTTPS ports for Nginx as required. Keep 8080–8082 private. For TCP on a native service or Linux host-network container, allow the displayed public port after allocation and configure upstream NAT if needed; PrivateTunnel has no fixed TCP allocation range. `TCP_BIND_HOST` can select a local interface IP; `TCP_VISITOR_ALLOWLIST` accepts comma-separated visitor IPs/CIDRs and checks actual socket addresses. An empty list keeps TCP public. Visitor TLS/login must be provided by the published application. Restrict the admin host at the proxy/firewall if your operational setup permits it.

For 1.2, issue individual keys in administrator Settings; shared-key authentication is disabled by default. Keep `REQUIRE_DATA_TRANSPORT_V4=true`. The optional shared-key and v1 switches are intended only for a trusted migration environment. Read the [1.2 upgrade steps](../README.md#upgrade-to-12-client-keys-and-profiles) before restarting an existing installation. `NODE_ENV=production` requires one primary database and rejects other mirror targets. Active HTTP streams use per-request inactivity (`HTTP_IDLE_TIMEOUT_MS`), with header limits kept separate; reverse-proxy timeouts still apply.
