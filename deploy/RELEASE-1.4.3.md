# PrivateTunnel 1.4.3

Fix Windows boot tunnels remaining online after Stop sharing and recover startup removal when the protected runtime is locked. The previous implementation stopped the Scheduled Task wrapper without confirming that its tunnel worker had exited; the desktop could also restore a stale online heartbeat while Stop was in progress.

- Stop requests graceful shutdown, waits for the worker and checks for orphan processes using the exact service-profile argument and process creation time before force stopping a stuck worker.
- A pause bound to the current Windows boot prevents task retries from undoing Stop. Start or the next boot resumes the installed job.
- Stop adds a pause guard to legacy launchers while preserving their runtime command. Installation/removal keep the old task disabled throughout file changes. Windows PowerShell helpers use their own built-in module path, including when launched from PowerShell 7.
- Startup removal handles profiles already deleted by a failed older uninstall. If a separate process locks only runtime binaries, the job and profile are removed, with a visible file-cleanup warning instead of retaining a broken startup entry.
- GUI polling waits for startup actions and rejects overlapping actions. Stop also cancels pending interactive starts and disconnects any interactive instance belonging to the tunnel.
- Worker status/logs expose their actual version, negotiated data transport, WebSocket disconnect causes and TCP close byte counts without logging payloads or access keys.

After downloading the new desktop release, close the old GUI, open the extracted new application, turn the affected startup option off, approve elevation, then turn it on again. The private boot runtime is a separate copy and is not updated simply by replacing the GUI. CLI users can remove/reinstall their boot jobs. Update the public server as well to retain the 1.4.2 idle-timeout fix and obtain server-side disconnect diagnostics.

Validation includes a real LocalService Scheduled Task lifecycle on disposable Windows CI runners, a stubborn orphan worker, a retry after Stop, explicit Start, partial profile deletion and an unrelated process locking the copied runtime. TCP integration transfers binary data simultaneously in both directions, idles across two real heartbeat cycles and verifies intact data afterward. No application or service was run on the maintainer's computer for these checks.

This release fixes the startup lifecycle defects. It does not claim that a real RDP `0x1104` session has been reproduced or repaired; collect the new worker/server diagnostics if it persists after updating both endpoints and reinstalling the boot snapshot.

[English startup guide](../docs/en/startup.md) · [Thai startup guide](../docs/th/startup.md)
