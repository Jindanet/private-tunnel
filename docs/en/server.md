# Server installation

[Overview](../../README.md) · [Thai guide](../th/server.md)

The server is the public entry point. Keep it separate from the local application: the client opens an outbound WSS connection and the server forwards visitors through it. I use separate administrator and publishing hostnames so a shared application's routes cannot become the administrator interface.

## Requirements and first boot

Use Node.js **22.12+**, persistent writable storage, a public IP/DNS and a reverse proxy on the same machine. SQLite is the default; MySQL is optional. Install dependencies on the actual server platform; do not copy native `node_modules` between operating systems.

```bash
git clone https://github.com/Jindanet/private-tunnel.git
cd private-tunnel
npm ci --omit=dev
cp .env.example .env
```

Set real domains, storage paths and any MySQL credentials in `.env`. Leave internal listeners on `127.0.0.1` when Nginx runs locally. Then run `npm run server` for initial setup, or install the supervised service described below. Do not run the server as root merely to manage firewall rules.

If no administrator password exists, first boot generates `DATA_DIR/admin-bootstrap.txt` with private permissions. Read it locally, sign in, and change the password; rotation deletes the bootstrap file and invalidates sessions. An existing database password takes precedence over `DASHBOARD_PASSWORD`. Domains are first-boot seeds; later settings are edited in the administrator UI.

## DNS and HTTPS

Example records, all pointing to the server:

```text
admin.example.com         A/AAAA → server address
*.apps.example.com       A/AAAA → server address
apps.example.com         A/AAAA → server address, only if publishing the root
```

Only publish an AAAA record when IPv6 is actually reachable. Obtain certificates for the exact administrator name, wildcard publishing name and any bare root names. A wildcard certificate does not cover its bare parent. Wildcard ACME issuance requires DNS validation; configure renewal and a reverse-proxy reload using your provider's supported tooling. [Let's Encrypt DNS validation](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge).

Use the administrator's generated Nginx configuration after setting publish domains, or adapt [`deploy/nginx.example.conf`](../../deploy/nginx.example.conf). Replace every hostname, certificate path and port placeholder. The detailed [deployment runbook](../../deploy/README.md) includes systemd, Docker and Windows examples.

| Internal service | Default | External route |
| --- | --- | --- |
| Client WebSocket | `127.0.0.1:8080` | Admin hostname, `/_private-tunnel/ws`; devices use the same route with their subprotocol |
| Administration | `127.0.0.1:8081` | Exact admin hostname, `/_private-tunnel/admin` |
| Published HTTP | `127.0.0.1:8082` | Enabled publish hostnames |

Overwrite forwarded headers at Nginx. Only loopback peers are trusted to provide them; do not expose internal ports directly or switch containers to bridge networking without a proper trusted-proxy design. Public hosts must reject the **exact control root and all children**, including `/_private-tunnel`, even when no tunnel exists. Application `/api` paths remain available. Application WebSocket upgrade forwarding is not implemented.

Validate the proxy configuration, reload it, and test the administrator path on the correct host and a 404 on a publishing host. The admin hostname itself cannot be used as a root publishing hostname. Custom control roots must be reflected in Nginx and client URLs.

## Keep it running

The Linux template [`deploy/private-tunnel.service`](../../deploy/private-tunnel.service) uses an unprivileged `privatetunnel` account, code in `/opt/private-tunnel`, a private environment file in `/etc/private-tunnel/server.env`, and writable state in `/var/lib/private-tunnel`. Follow the [complete commands](../../deploy/README.md#3-linux-service-with-systemd), including absolute storage paths and file ownership. Ensure the configured Node executable matches the installed path.

[`compose.yaml`](../../compose.yaml) uses **Linux host networking**, a persistent volume and a restricted container. A new volume does not import an old host database automatically. Do not delete a state volume to perform an ordinary update. Windows needs a separately configured server process supervisor/service manager; the client's `--startup` installer is not the server installer.

`/healthz` on the internal administration listener reports process liveness. It does not prove DNS, public TLS, a TCP firewall or a particular tunnel is reachable. Verify from another network too.

## TCP allocation and firewalls

Default `TCP_ALLOWED_PORTS=30000-40000` declares which ports can be allocated. Preopen that range in the host firewall, cloud firewall and any router/NAT. Occupied, reserved and disallowed ports are skipped while retaining the selected listener.

Additional fallback ports must be opened first and explicitly included in the policy. Allocation tries allowed ports in this order: **30000–40000**, **40001–65535**, then **1024–29999**. Exhaustion fails creation; it never silently chooses port zero or a privileged port. Old `TCP_PORT_MIN`/`TCP_PORT_MAX` variables do not control this policy.

Keep `AUTO_FIREWALL=false` and manage firewall rules separately. It cannot discover upstream firewall/NAT state. `TCP_VISITOR_ALLOWLIST` optionally limits visitors by real socket IP/CIDR, not user-supplied forwarded headers. Raw public TCP has no automatic TLS or user authentication; the forwarded service must provide those when needed.

## Keys, state and backups

Issue separate named keys in Settings. Desktop keys and device keys are different types. Device issuance reveals a second visitor password; rotation replaces both and disconnects that device's sessions. Rotation preserves ownership; issuing an entirely new key creates a new owner namespace.

Back up the database, `.env`/service environment, **`DATA_DIR/client-keys.json`**, and any operational certificate/proxy material according to your backup policy. The registry contains hashes, but its IDs are needed to preserve owners. Never edit it under a running server or commit it to Git.

For SQLite, stop the service for a consistent file copy or use a correct online backup procedure. Copying only the main database during WAL writes can lose committed data. Restore to a separate environment first and check keys, reserved hosts, administrator login and storage permissions. Database mirrors are not backups or automatic failover.
