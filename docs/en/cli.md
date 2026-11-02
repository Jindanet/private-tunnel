# Command-line client

[Overview](../../README.md) · [Thai guide](../th/cli.md)

The standalone `ptunnel.js` needs only Node.js **22.12+**. Native CLI downloads expose the same commands; replace `node ptunnel.js` with the downloaded executable or `ptunnel` if it is on PATH.

```bash
node ptunnel.js
node ptunnel.js setup
node ptunnel.js http 3000
node ptunnel.js tcp 22
node ptunnel.js http 192.168.1.50:80
node ptunnel.js http localhost:3000 --domain apps.example.com
node ptunnel.js http 3000 --domain demo.example.net --root
node ptunnel.js status
node ptunnel.js reset
node ptunnel.js --help
node ptunnel.js --version
```

With no arguments, the wizard sets up a new profile or resumes the last tunnel. `setup` changes saved configuration; afterward run the client to connect. `status` hides the key. `reset` clears the saved connection/target after installed boot jobs have been removed.

Targets can be a port, `host:port`, or a supported local HTTP URL. Bracket IPv6 addresses, for example `[::1]:3000`. The target must be reachable from the client machine. HTTP forwards plain HTTP locally; raw TCP preserves the service's bytes. There is no UDP or application-WebSocket passthrough.

`--domain` chooses an administrator-enabled publish domain. `--root` requests its exact hostname, which must explicitly allow root publishing. Otherwise the server assigns a subdomain. Names are reserved to the authenticated key owner and stable tunnel profile, not just an arbitrary client-supplied ID. Changing a target can produce a different profile and address.

For unattended initial configuration:

```bash
node ptunnel.js init --server admin.example.com --token YOUR_ACCESS_KEY
```

Use interactive setup when avoiding a secret in shell history/process arguments. A hostname becomes `wss://<host>/_private-tunnel/ws`; use a full URL if the administrator changed the path. Plain `ws://` is accepted only for exact localhost/loopback development targets. Remote connections require WSS.

| Command / option | Purpose |
| --- | --- |
| `http <target>`, `tcp <target>` | Save the latest tunnel and start it |
| `--plain` | Line-oriented output suited to basic terminals |
| `--startup` | Install that target as a boot job using saved connection settings |
| `--startup --dry-run` | Preview the boot installation |
| `startup install [--dry-run]` | Install the most recently saved target |
| `startup status` | List installed jobs and their IDs |
| `startup start ID` / `stop ID` | Start now or stop until the next boot |
| `startup remove ID` / `remove all` | Remove persistent startup configuration |

The CLI keeps a plaintext access key in `~/.ptunnel`, with mode `0600` on Unix. `PTUNNEL_CONFIG_PATH` can select another profile file. Protect the file and its backups. The desktop stores its own profile and uses the OS keyring instead; it can read a legacy CLI profile without rewriting that source file.

Network loss triggers bounded retries with backoff and jitter. An interrupted request or TCP connection does not resume. Authentication rejection requires updating the key. Ctrl+C stops an interactive client; removing the boot job is necessary to prevent an installed service from starting again.
