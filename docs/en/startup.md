# Start at boot, before login

[Overview](../../README.md) · [Thai guide](../th/startup.md)

I use a headless boot worker so a saved tunnel does not depend on opening the desktop app. Configure and verify the server/key/target first, then install the exact tunnel:

```bash
node ptunnel.js tcp 22 --startup
node ptunnel.js http 3000 --startup --dry-run
node ptunnel.js startup install
node ptunnel.js startup status
node ptunnel.js startup stop JOB_ID
node ptunnel.js startup start JOB_ID
node ptunnel.js startup remove JOB_ID
node ptunnel.js startup remove all
```

The desktop's per-tunnel startup control installs the same kind of worker. Installation can request OS elevation. Later boots run the tunnel without the GUI and retry when networking becomes available. The local application, SSH daemon or game server must also be configured to start independently; PrivateTunnel does not start those applications.

| OS | Installation | Important behavior |
| --- | --- | --- |
| Windows | Scheduled task triggered at startup | Runs as LocalService with protected profile/runtime files; no interactive sign-in required |
| Linux | System-wide systemd service | Runs as the installing user, with privilege restrictions; systemd must actually be present |
| macOS | LaunchDaemon | Runs as the installing user before desktop sign-in |
| Termux | Script in `~/.termux/boot` | Requires Termux:Boot from the same compatible source, opened once, and background permissions |

Android is not a desktop OS boot-service environment. Storage unlocking, vendor power management and Android restrictions can delay or stop Termux. Do not promise pre-unlock startup on every phone.

Each job stores a private **snapshot** of its server, key, target, profile identity and publishing settings. This copy is necessary because a pre-login worker cannot depend on an unlocked desktop keyring. Unix profiles use private permissions; Windows uses restricted ACLs. The key copy is plaintext within that protected file. Installing startup explicitly opts into this additional credential copy.

Enabling startup on an already shared tunnel switches workers and interrupts active TCP sessions once. Reconnect after installation using the currently reported address. After a client update, reinstall its startup jobs as well; otherwise the protected copy can keep running the older client, including older timeout behavior.

Use the ID and paths shown by installation/status to inspect the generated service and log files. Output logs rotate at roughly 1 MiB with one backup. A worker heartbeat updates every three seconds and becomes stale after fifteen seconds; a stopped/stale status is not evidence that a public firewall is open. Duplicate-worker protection checks the lock holder's process identity before deciding another worker is active.

`stop` is temporary: the next boot starts the installed job again. `remove` disables the persistent job and removes its service configuration. Changing the regular CLI profile does not rewrite existing job snapshots; remove/reinstall affected jobs after key rotation, changed targets or runtime updates. Keep Node and Linux/macOS executable paths stable. Windows stages the runtime in its protected service location.

On Windows, Stop sharing and `startup stop` request a graceful shutdown, wait for the actual worker, and terminate a stuck worker only after matching its exact service profile and process creation time. A pause saved for the current Windows boot prevents Task Scheduler retries from restarting a stopped tunnel. Start clears the pause; a new boot also clears it. The GUI suppresses old heartbeat updates while the action is pending. Stop ends active TCP/RDP sessions.

For the older `Access to the path 'PrivateTunnel.exe' is denied` uninstall failure, close the old GUI and open the new release from its extracted application folder. Turn startup off again, approve the administrator prompt, then turn it back on to install the new snapshot. The new remover can recover even when the previous attempt already deleted the service profile. If an unrelated process still locks runtime files, startup is removed and the GUI reports that file cleanup is pending; restart Windows before deleting that old service folder. Do not delete a profile while its tunnel is still running.

New worker logs record their version, WebSocket disconnect causes and TCP close byte counts without payloads or access keys. `startup status` shows the live worker version and negotiated data transport. A worker with no version predates this diagnostic; the newly downloaded GUI's version alone does not identify the installed boot worker.

CLI status lists the jobs belonging to that CLI configuration. For desktop jobs on Windows, open `%ProgramData%\PrivateTunnel\startup` in File Explorer and find the affected job's `state\service.log` and `state\status.json`. Those files contain the runtime version and connection diagnostics; `profile.json` contains the private access key and should not be included in a bug report.

This is the **client** startup installer. It does not install the public server as a Windows service. Use the separate [server deployment guide](server.md) for server process supervision.
