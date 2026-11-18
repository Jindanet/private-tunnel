# PrivateTunnel 1.4.4

Restore the live terminal dashboard that was replaced with append-only logs during the Termux client work. Interactive terminals now show status, forwarding, connection count and recent requests in one updating view. Narrow terminals, redirected output and `--plain` retain readable line-by-line logs. No additional npm dependencies are needed.

The dashboard bounds its request history, combines request bursts into one redraw, adapts on resize, keeps long public addresses complete and restores the cursor on stop/exit. Remote text cannot inject terminal cursor or clipboard commands. Authentication recovery instructions stay inside the dashboard rather than disrupting its redraw.

Add a Windows `ptunnel.cmd` launcher to the source folder. CMD previously found the checkout's `ptunnel.js` before the npm-linked command and could open it with Windows Script Host, producing no terminal output. The launcher explicitly uses Node.js and forwards arguments and exit codes. `ptunnel 80`, `ptunnel http 80`, `ptunnel.cmd http 80` and `node ptunnel.js http 80` remain supported; no Windows file associations or PATH settings are changed.

Validation covers dashboard lifecycle, burst rendering, narrow/plain output, Unicode paths, long addresses, terminal escape filtering and resizing. Windows integration checks real CMD command lookup from a folder containing spaces and an ampersand, plus an isolated `npm link` outside that folder. Builds and tests run on GitHub Actions; the application is not run on the maintainer's computer.
