# PrivateTunnel 1.2.0 — release candidate notes

Prepared on 16 October 2026. Package and lockfile versions are 1.2.0. Preparing source or local binaries does not publish a tag or release, and historical remote tags are not rewritten.

Read the [1.2 upgrade steps](../README.md#upgrade-to-12-client-keys-and-profiles). Back up the database and `DATA_DIR/client-keys.json` together. Individual keys are the default; create one per owner in administrator Settings, then update each client. Shared-key and v1 compatibility require explicit opt-in for trusted migration. Existing shared-key reservations are never automatically adopted by a new key.

Desktop credentials move to a separate OS-encrypted profile; the CLI profile remains separate. Sign in and change any legacy administrator password before 2027-01-01 UTC. Test database/schema upgrades on copies; versioned schema rollback is not implemented. Production requires one primary backend.

Push a new stable package/lockfile version to `main` to trigger **Build and publish release**. It runs Linux/Windows tests and production audits, builds source and unsigned Windows desktop archives plus Windows/Linux/macOS CLI binaries, and publishes the tag, assets and checksums only after every platform succeeds. This creates `v1.2.0` automatically for this version; no manual release upload is needed. Existing published releases are skipped, failed draft uploads can be resumed by rerunning their original workflow, and historical tags are never rewritten. Release notes fall back to GitHub-generated notes when a version-specific file is absent.

Windows artifacts remain unsigned. Review independent security, real MySQL 8, long-running capacity, TLS/proxy and operational validation before public multi-user hosting. TCP has no built-in visitor TLS/login, UDP and application WebSocket passthrough are not implemented, and horizontal scaling is not supported.
