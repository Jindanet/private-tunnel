# PrivateTunnel 1.4.2

Fix healthy TCP tunnels being disconnected after five minutes without application data. This affected long-lived connections such as idle Remote Desktop and SSH sessions. Both the client and server had a fixed idle timer; the default now keeps idle streams open while TCP keepalive and tunnel heartbeats still detect dead connections.

Update **both the public server and the desktop/CLI client**. For installed startup jobs, reinstall their private runtime snapshot after updating: turn the GUI startup option off and back on, or remove/reinstall the CLI job. Reinstalling a job interrupts its existing TCP sessions once; reconnect using the currently assigned public address.

The optional server setting `TCP_IDLE_TIMEOUT_MS=0` disables application-data idle expiry. A positive integer up to 2147483647 sets an explicit limit in milliseconds. Restart the server after changing it. The existing HTTP inactivity setting is separate.

RDP can use TCP without UDP. This update does not add UDP forwarding or change Windows RDP policies. The reported `0x1104` is not proof of one particular cause; this release fixes the confirmed idle-disconnect mechanism, with regression tests that advance beyond the previous five-minute limit. If a session still fails after upgrading both endpoints, inspect tunnel reconnects and RDP events to distinguish remaining causes.

[English troubleshooting](../docs/en/troubleshooting.md) · [Thai troubleshooting](../docs/th/troubleshooting.md)
