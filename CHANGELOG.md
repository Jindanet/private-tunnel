# Changelog

## 1.4.1 — 2026-11-11

- Forward device request bodies with their actual content type instead of rejecting non-JSON writes. Preserve text, form and binary bytes within existing size and credit limits.
- Let administrators disable the visitor-password prompt per device key when firmware handles its own login. Preserve the protected default, connection-key authentication, secrets and live board connections; policy changes apply to the next request.
- Add a WakeOnLan Arduino example adapted from the reported login flow, with text credentials, method checks, cooldown and clearer HTTP errors. Compile all three examples for both ESP cores in CI and release gates.
- Test firmware login over the actual gateway, policy persistence, admin session/origin checks, failed saves and bilingual controls. Update English/Thai documentation and package the corrected example.

## 1.4.0 — 2026-11-02

- Add experimental native Arduino clients for ESP32 and ESP8266, without Node.js or a third-party WebSocket dependency. Use verified TLS, bounded binary frames, credit, one active HTTP callback and a 1 KiB request-body limit.
- Add basic and Wi-Fi provisioning examples with saved settings, automatic boot connection, bounded retries, heartbeat/cancellation and flash response streaming. Keep TLS memory costs and unverified hardware reliability explicit.
- Add a scoped device transport adapter that reuses server host ownership and logging while retaining desktop v4 policy. Enforce device-only keys and a separate visitor password, shown once and rotated together.
- Compile both firmware examples on pinned ESP32/ESP8266 cores in GitHub Actions; test native parser behavior and actual gateway visitor auth, uploads, response credit, overload and key rotation.
- Rewrite the documentation as English and Thai overview READMEs with separate guides for installation, CLI, boot services, devices, server deployment, configuration, architecture, troubleshooting and development. Reuse existing screenshots without launching the app locally.
- Publish an Arduino-installable library ZIP and gate releases on firmware compilation as well as desktop/CLI checks.

## 1.3.0 — 2026-11-02

- Add boot startup before sign-in for CLI and GUI: `ptunnel tcp 22 --startup` or the per-tunnel desktop toggle installs Windows boot tasks, Linux systemd services, macOS LaunchDaemons, or Termux:Boot scripts. Request OS elevation during installation and use unprivileged service identities.
- Save private, independent boot profiles; preserve HTTP/TCP target, client identity and domain settings; expose status, logs, preview, start/stop and uninstall commands. Keep desktop credentials encrypted separately, explain the service key copy, and prevent duplicate workers with a lock.
- Add a standalone `ptunnel.js` client for Termux and Node.js 22.12+. Bundle the WebSocket client and MIT notices so users can run it after `pkg install nodejs-lts git -y`, without npm, native compilation, Electron or SQLite.
- Guide first-time users through server, hidden access-key, HTTP/TCP and local-target setup. Save a private profile, resume the most recent tunnel with `node ptunnel.js`, and provide setup, status and reset commands.
- Use readable mobile terminal logs with copyable public addresses, visible connection errors and bounded shutdown. Keep credentials in the Authorization header and require TLS for remote servers.
- Document a one-line Termux install/start command, Android background limitations and bundle maintenance. Check generated-client freshness in CI and release builds, and test standalone HTTP/TCP forwarding without installed dependencies.
- Report the client version with `--version` and compare native CLI versions during release smoke tests. Publish the previously unreleased Termux and boot-startup changes under a new version instead of skipping an already published 1.2.2 release.

## 1.2.2 — 2026-10-16

- Default public TCP allocation to 30000–40000, skipping occupied or OS-reserved ports while keeping the actual listener bound. Explicitly approved fallback ports are tried in 40001–65535, then 1024–29999; privileged and OS-selected ports are excluded.
- Restrict allocation to the administrator-declared `TCP_ALLOWED_PORTS` firewall/NAT policy (default `30000-40000`). Exhaustion or automatic local firewall failure cancels tunnel creation before advertising an address. A declared policy does not verify public reachability.
- Track uniquely owned automatic firewall rules, remove only those rules on cleanup, and reject visitor connections until TCP setup completes. Document the Windows out-of-range port issue and Linux deployment requirements.

## 1.2.1 — 2026-10-16

- Check current and legacy administrator credentials in the database before consulting `DASHBOARD_PASSWORD`. A stale, short or placeholder bootstrap value no longer blocks an existing installation or changes its password.
- Validate supplied bootstrap passwords only when creating the first administrator credential. Close initialized database connections on failed startup and make concurrent initialization callers wait for completion.
- Add restart regressions for saved hashes, legacy credential keys, invalid first-boot values and generated bootstrap credentials.

## 1.2.0 — 2026-10-16

- Automatically test, build and publish new package versions pushed to main, including Windows desktop, Windows/Linux/macOS CLI assets and checksums; skip published versions and resume incomplete drafts safely.

- Issue, rotate and revoke client-specific keys from the Thai/English administrator UI. Store only key digests, bind saved host ownership to the authenticated key owner, and disable shared-key authentication by default.
- Use per-request HTTP inactivity instead of a total 30-second lifetime; abort incomplete responses after headers without appending error text. Require v4 receive-credit transport by default, retaining explicit legacy migration opt-in.
- Enforce heartbeat replies, add cancelable reconnect jitter, require TLS for remote client connections, and add TCP interface/visitor IP-CIDR controls while keeping OS-selected ports.
- Encrypt desktop credentials with OS-backed safeStorage in a separate profile; preserve the CLI profile during migration and fail closed on unavailable/insecure storage.
- Require one database backend in production, default migration mirrors to strict errors, and expire legacy SHA-256 administrator sign-in on 2027-01-01 UTC.
- Add ownership, streaming, slow-consumer, timeout, credential-store, heartbeat and administrator UI regressions. Update migration, backup and security reporting guidance.

## 1.1.0 — 2026-10-15 (release preparation)

This version is prepared in source. A remote tag, public release and signed binaries have not been published by this change.

### User experience

- Dark mode is the default across desktop startup, sharing, settings, administrator pages and login, independent of the OS theme.
- Clearer Thai/English desktop onboarding with guided server setup, simple local-port sharing and optional advanced settings.
- More direct status, public-address and recovery information for desktop users.
- Administrator setup guidance separates client onboarding from server operations.
- Redesigned desktop workspace and administrator navigation with readable Thai/English labels, compact status, prominent Copy/Open actions and a full-page creation flow.
- Accept local HTTP addresses as well as numeric ports in the desktop; website and Minecraft Java quick-start choices prefill common ports.
- Context-specific recovery actions and optional advanced settings keep the daily sharing workflow short. CLI examples use a separate initialization command and a key placeholder.

### Security and reliability

- Negotiate data transport v4 for HTTP/TCP while preserving the v1 base protocol and legacy peers. Add per-stream/connection receive credit, bounded fair send queues, producer pause/resume, ordered EOF and TCP half-close handling. Supplied v2/v3/game helpers remain inactive reference prototypes.

- Default internal listeners bind to loopback; automatic privileged firewall changes are disabled by default.
- Empty first-boot client keys generate a random key; network authentication fails closed by default. Current clients send the key in an Authorization header. Legacy query-token support is explicitly opt-in.
- Supplied access keys require 32–4096 visible ASCII characters without whitespace and reject recognizable placeholder prefixes (case insensitive). Invalid nonempty environment keys stop startup. Legacy invalid stored keys keep administrator sign-in available but deny tunnel authentication until rotation; Settings requires replacing them before saving. Empty first boot generates a random 32-byte key; key length alone does not establish entropy.
- Salted scrypt administrator password storage with migration after successful legacy login, tighter admin host/origin checks and bounded authentication attempts.
- Detect legacy password hashes reliably and validate supplied bootstrap passwords. Serialize settings/password changes, and reconcile committed key rotations even after strict mirror failures; unverifiable database credentials pause tunnel admission and revoke existing connections.
- Pre-authentication WebSocket upgrades are limited to 60 attempts per IP per minute across both tunnel routes and administrator live updates, independently of HTTP login throttling.
- Safer inline JSON/HTML handling, external-link and desktop input checks, bounded WebSocket buffering and tighter tunnel/runtime validation.
- Exact admin Nginx block separated from all publish hosts. Reserved control paths are rejected on publish hosts, including primary-domain wildcards.
- Local liveness probe, bounded shutdown and request-log privacy controls.

### Maintenance

- Public TCP listeners use an OS-assigned available port; the fixed range configuration has been removed. Read the assigned address and update firewall/NAT rules when it changes.
- Node.js 22.12+ baseline and updated runtime/build dependencies.
- SQLite is the default backend. Optional MySQL/SQLite mirrors remain supported; mirrors and bootstrap copying are disabled by default.
- Added protocol, routing, Nginx and security/runtime regression tests, plus Linux/Windows CI on Node 22 and 24.
- MIT license, deployment guides, a non-root server container and systemd unit.
- Documented the fixed initial control root, explicit SQLite path precedence and systemd environment-file precedence; expanded ignores for private environment variants, client profile variants and SQLite state/backups.
- Version-checked source and unsigned Windows artifact workflow with SHA-256 checksums. Signing, notarization and public publication remain separate tasks.

### Upgrade notes

- Existing MySQL users who relied on the previous default **must explicitly set `DB_PROVIDER=mysql`** before upgrade.
- Existing non-loopback proxy arrangements need review; the documented setup keeps Nginx on the same host.
- Update old query-token clients or enable `ALLOW_LEGACY_QUERY_TOKEN` temporarily, then disable it and rotate the shared key.
- Replace invalid environment access keys before restarting. Rotate invalid legacy stored keys in Settings and update all clients before resuming tunnels; administrator sign-in remains available for recovery.
- For systemd, explicitly set absolute `DATA_DIR` and `SQLITE_PATH`, `INTERNAL_HOST=127.0.0.1` and `AUTO_FIREWALL=false` in `/etc/private-tunnel/server.env`. The environment file can supersede unit defaults, and changing `DATA_DIR` does not override an explicit SQLite path.
- Preserve private databases and client profiles before upgrading. Read the complete [migration notes](README.md#upgrade-from-10-to-11).

### Known limits

Shared access keys and client-supplied IDs do not provide multi-user isolation. Per-client key revocation, UDP, application WebSocket passthrough, public TCP encryption/access control, HA, horizontal scaling and signed/automatic desktop updates remain unimplemented. See [README limitations](README.md#security-and-current-limitations).

## 1.0.0 — earlier source baseline

Initial self-hosted HTTP/TCP tunnel implementation, desktop and CLI clients, administrator dashboard, publish-domain routing and SQLite/MySQL storage. No release date or published release artifact is asserted here.
