# PrivateTunnel 1.2.0 — release candidate notes

Prepared on 16 October 2026. Package and lockfile versions are 1.2.0. Preparing source or local binaries does not publish a tag or release, and historical remote tags are not rewritten.

Read the [1.2 upgrade steps](../README.md#upgrade-to-12-client-keys-and-profiles). Back up the database and `DATA_DIR/client-keys.json` together. Individual keys are the default; create one per owner in administrator Settings, then update each client. Shared-key and v1 compatibility require explicit opt-in for trusted migration. Existing shared-key reservations are never automatically adopted by a new key.

Desktop credentials move to a separate OS-encrypted profile; the CLI profile remains separate. Sign in and change any legacy administrator password before 2027-01-01 UTC. Test database/schema upgrades on copies; versioned schema rollback is not implemented. Production requires one primary backend.

Run `npm test`, review all platform/backend results and build the intended platform. The source archive must come from the reviewed commit. The existing artifact workflow accepts a matching `v1.2.0` tag when an owner elects to create one; do not treat package metadata as proof that the tag exists.

Windows artifacts remain unsigned. Review independent security, real MySQL 8, long-running capacity, TLS/proxy and operational validation before public multi-user hosting. TCP has no built-in visitor TLS/login, UDP and application WebSocket passthrough are not implemented, and horizontal scaling is not supported.
