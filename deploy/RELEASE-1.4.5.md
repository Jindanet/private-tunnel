# PrivateTunnel 1.4.5

This release fixes a TCP cancellation race reproduced on Windows CI. Late data for a cancelled connection could lose its receive record after other connections came and went, terminating the shared WebSocket and every active TCP session on it.

New endpoints negotiate a TCP reset acknowledgement before retiring locally cancelled records. Queue, credit and record limits remain bounded; older endpoints keep their existing wire behavior. Update the server and client together, then reinstall startup jobs because they contain separate client copies. The worker log reports `tcp-reset-ack=on` when the new capability is active.

Server TCP close logs now include the matching connection ID, reason, byte counts and duration. Client WebSocket diagnostics include the close code, connection duration, active TCP count and local WebSocket error code when available. Logs do not contain traffic payloads or access keys.

The tests cover delayed cancellation and churn, crossed resets, record reclamation, bounded pending acknowledgements, older-peer negotiation, and duplex traffic with idle heartbeats. This is a fix for a reproduced transport defect, not a claim that every RDP `0x1104` or abnormal network disconnect is resolved. See the English and Thai troubleshooting guides for collecting matching client/server logs.

Builds and runtime tests run on GitHub Actions. No application or service is launched on the maintainer's local machine for this update. Existing screenshots remain in use.
