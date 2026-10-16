# PrivateTunnel 1.2.2

Fixes public TCP tunnels receiving an OS-selected port outside an administrator's open firewall range, such as `55525` on a Windows host that permits only `30000-40000`.

The default public TCP range is now **30000–40000 inclusive**. The server skips occupied or OS-reserved ports and keeps the actual listener bound throughout setup. It allocates only from the administrator-declared `TCP_ALLOWED_PORTS` policy, which defaults to `30000-40000` without additional configuration.

For fallback, first open the additional ports in every host/cloud firewall and router/NAT layer, then include them in `TCP_ALLOWED_PORTS` and restart the server. Eligible candidates are tried in this order: `30000-40000`, `40001-65535`, then `1024-29999`. Exhaustion returns an error instead of advertising an undeclared port. Privileged ports and OS-selected port `0` are excluded. The obsolete `TCP_PORT_MIN` and `TCP_PORT_MAX` keys remain unused.

With the recommended `AUTO_FIREWALL=false`, the server does not modify firewall rules. The declared policy is not firewall autodiscovery or proof of external reachability; test the assigned address from outside the server's network. Optional legacy automatic rules fail setup on command failure, use bounded structured commands, and clean up only uniquely owned rules. Visitor connections are rejected until setup completes.

Update the server source and restart its process, then reconnect TCP tunnels. Existing Windows installations that already open `30000-40000` can use the default policy. Review the deployment guide before enabling any fallback ports. This release retains the existing 1.2 authentication and deployment limitations.
