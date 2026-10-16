# Security reporting

Security fixes target the current 1.2.x source line. Upgrade older builds before relying on the current defaults; package metadata alone does not identify a published release.

Report suspected vulnerabilities privately using GitHub's private vulnerability reporting for this repository if it is enabled. If no private channel is available, open an issue requesting a private reporting contact without including exploit details, credentials, traffic payloads or personal data. No guaranteed response time or bounty is promised.

Include the affected commit/version, configuration with secrets removed, the reachable entry point, expected and observed behavior, and a minimal reproducer using disposable data. Never test against another person's deployment without authorization. Authentication, cross-owner hostname access, administrator session/IPC boundaries, data corruption and remotely reachable resource exhaustion are relevant reports.

Known limitations and deployment requirements are described in the [README](README.md#security-and-current-limitations) and [deployment guide](deploy/README.md). These descriptions are not a production certification or a blanket exclusion of findings. A passing test suite does not establish security for every configuration or deployment.
