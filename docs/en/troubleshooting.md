# Troubleshooting

[Overview](../../README.md) · [Thai guide](../th/troubleshooting.md)

| Symptom | Check |
| --- | --- |
| Client key rejected | Use an individual key issued by this server. Check rotation/revocation and device versus desktop type. Update the saved profile and installed boot snapshots. |
| WebSocket 404 / upgrade failed | Use the full administrator hostname and correct control path; confirm Nginx upgrade routing. A public application hostname is not the control endpoint. |
| Certificate or WSS failure | Check hostname, full certificate chain, CA trust, time, DNS and renewal. Remote plaintext is not a workaround. |
| Public HTTP 502 | Start the actual local service, check the target port/host from the client, and verify the tunnel is connected now. |
| Public HTTP 504 | Check progress and `HTTP_IDLE_TIMEOUT_MS`; inactivity differs from total request duration. |
| Long response ends abruptly | Look for a client disconnect or inactivity. Once response headers were sent, failure closes the response rather than adding gateway error text to its body. |
| Custom name unavailable | Check administrator publishing policy, syntax, a live tunnel and an offline reservation belonging to another key. Rotation retains ownership; issuing a different key does not. |
| TCP works locally but not externally | Preopen the assigned allowed port in all firewalls/NAT, check DNS and test from another network. A declared port range does not prove reachability. |
| TCP port changes | Use the currently assigned `host:port`. Occupied or reserved ports are skipped on reconnect. |
| Android stops sharing | Check battery/background permissions and Termux:Boot setup. Reconnect logic cannot restart a killed process by itself. |
| Startup shows stale / missing | Inspect the listed job/log paths, runtime location and OS service status. Reinstall after key or executable changes. Confirm the target service starts too. |
| Startup returns after stopping | `stop` lasts until next boot. Use `startup remove ID` to uninstall. |
| Desktop cannot save/decrypt key | Restore/unlock the OS keyring, especially Secret Service/KWallet on Linux. Enter the key again if needed; plaintext fallback is intentionally rejected. |
| Changed `.env` but domains/password remain | Existing settings are stored in the database. Use administrator Settings; verify the selected DB/path before any reset. |
| Old binary despite new source | Compare `--version` with the release tag. Download the platform asset again and reinstall any staged boot runtime. A same-version source push skips release publishing. |

## Device-specific checks

| Symptom | Check |
| --- | --- |
| No setup Wi-Fi | Watch Serial at 115200. Reset normally and press BOOT/FLASH within three seconds afterward; holding GPIO 0 during reset can start the ROM uploader. Adapt the pin for your board. |
| Setup network disappears | The portal expires after five minutes or restarts after saving. Reset to reopen it when no valid settings exist. |
| Waiting for clock | Allow SNTP/DNS or supply a reliable application clock before TLS. |
| TLS fails on ESP8266 | Check the real CA/chain/time and free heap, including the largest free block. The 512-byte protocol does not shrink core TLS buffers. Use a gateway if your sketch cannot fit. |
| 401 on public `/status` | Use username `device` plus the visitor password, or Bearer visitor token. The connection key is not accepted here. |
| 403 / 415 | Cross-origin browser writes are rejected; write methods need `application/json`. Callbacks should check methods too. |
| 413 / 431 / 503 | Respect the 1024-byte body, 192-byte path, 64-byte content type and one-active-request limits. Retry later for 503. |
| 404 on a registered route | Paths match exactly, including query strings. The sketch's route must prepare a valid response; check response API return values. |
| Device no longer retries | Authentication/policy rejection or malformed protocol is terminal until restart/reconfiguration. Inspect `lastError()` and server logs without printing keys. |

When reporting a bug, include version/commit, OS or board/core, sanitized settings, status code and the smallest reproducer. Remove keys, visitor passwords, private hostnames and personal request paths. Do not post the key registry or raw EEPROM contents.
