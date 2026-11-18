# PrivateTunnel 1.4.4

Restore the live terminal dashboard that was replaced with append-only logs during the Termux client work. Interactive terminals now show status, forwarding, connection count and recent requests in one updating view. Narrow terminals, redirected output and `--plain` retain readable line-by-line logs. No additional npm dependencies are needed.

The dashboard bounds its request history, combines request bursts into one redraw, adapts on resize, keeps long public addresses complete and restores the cursor on stop/exit. Remote text cannot inject terminal cursor or clipboard commands. Authentication recovery instructions stay inside the dashboard rather than disrupting its redraw.

Add Windows `ptunnel.cmd` and `ptn.cmd` launchers to the source folder. CMD previously found the checkout's `ptunnel.js` before the npm-linked command and could open it with Windows Script Host, producing no terminal output. The launchers explicitly use Node.js and forward arguments and exit codes; no Windows file associations or PATH settings are changed.

Register `ptn` as an npm command alongside `ptunnel`. Both use the same bundled entry point, saved profile, identity and commands: `ptn http 80`, `ptn tcp 3389`, `ptn 80` or `ptn` to resume the last tunnel. Run `npm link --ignore-scripts` once after updating an existing source installation to register the new short name.

Validation covers dashboard lifecycle, burst rendering, narrow/plain output, Unicode paths, long addresses, terminal escape filtering and resizing. Windows integration checks real CMD command lookup from a folder containing spaces and an ampersand, plus an isolated `npm link` outside that folder. Builds and tests run on GitHub Actions; the application is not run on the maintainer's computer.
