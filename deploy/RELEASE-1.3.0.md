# PrivateTunnel 1.3.0

รุ่นนี้รวม **client สำหรับ Termux แบบไฟล์เดียว** และ **การเริ่ม tunnel ตั้งแต่บูตก่อนล็อกอิน** สำหรับ CLI และ GUI ซึ่งยังไม่มีในไฟล์ดาวน์โหลดรุ่น 1.2.2

This release packages the standalone Termux client and pre-login boot startup that were added after 1.2.2. Updating source alone does not update an installed desktop app or CLI binary: download the new 1.3.0 files below.

## เลือกไฟล์ / Downloads

- **Windows GUI:** `PrivateTunnel-v1.3.0-windows-x64-unsigned.zip`. Extract the entire ZIP and open `PrivateTunnel.exe` from the extracted folder. Close the old app before replacing its files. The desktop build remains unsigned.
- **Windows CLI:** `ptunnel-v1.3.0-windows-x64.exe`.
- **Linux CLI:** `ptunnel-v1.3.0-linux-x64`.
- **macOS CLI:** `ptunnel-v1.3.0-macos-x64` for Intel, or `ptunnel-v1.3.0-macos-arm64` for Apple Silicon. On Linux/macOS, make the downloaded CLI executable with `chmod +x FILE`.
- **Termux / source:** `PrivateTunnel-v1.3.0-source.zip` contains the standalone `ptunnel.js`, desktop sources and server sources. Existing Git users can pull `main`. No npm installation is needed to run the standalone JavaScript client with Node.js 22.12+.
- **Checksums:** `SHA256SUMS.txt` covers all six release files. A matching checksum verifies file integrity, not publisher identity.

The release provides a Windows GUI archive and native CLI binaries for Windows, Linux and macOS. Linux/macOS GUI applications can be built from source using the documented desktop build commands; GUI binaries for those platforms are not included in these assets.

## Termux

```bash
pkg update -y && pkg install nodejs-lts git -y && git clone --depth 1 https://github.com/Jindanet/private-tunnel.git "$HOME/private-tunnel" && cd "$HOME/private-tunnel" && node ptunnel.js
```

First run asks for the server, hidden access key, HTTP/TCP type and local target. Later runs resume the saved tunnel. The client needs no npm, compiler, Electron or database.

## เริ่มตอนบูต / Boot startup

Save your server address and access key, then install a boot tunnel:

```bash
ptunnel tcp 22 --startup
ptunnel startup status
```

For the standalone JavaScript client, use `node ptunnel.js tcp 22 --startup`. In the GUI, enable **เริ่มแชร์ตั้งแต่บูต ก่อนล็อกอิน / Start sharing at boot, before sign-in** under the saved tunnel and approve the operating system authorization prompt.

Windows uses an AtStartup task under LocalService with protected runtime files. Linux uses a systemd system service, and macOS uses a LaunchDaemon under the original user account. The background worker continues when the GUI exits. `startup stop ID` stops the current run, `startup start ID` starts it again, and `startup remove ID` disables and removes the boot job. CLI `--dry-run` previews installation without changing machine settings.

Boot startup needs a separate private service profile because the GUI keyring may still be locked before sign-in. This profile contains a protected access-key copy; credentials are kept out of command arguments and task/unit/plist definitions. Reinstall the startup entry after changing its server, access key or target settings. The local SSH/web/game service must also be configured to start on its own.

Termux boot startup requires Termux:Boot from the same installation source, opening that add-on once, and background permission. Android may require device unlock after reboot. Encrypted disks/home folders and runtime placement can also affect pre-login startup on desktop systems. Physical reboot validation across every supported OS remains outstanding; worker, installer-generation and GUI behavior are covered by automated tests.

## ตรวจรุ่น / Verify the update

```bash
ptunnel --version
# standalone:
node ptunnel.js --version
```

The result must be `1.3.0`. Release builds check this against the expected version on each native CLI runner. Existing profiles and access keys remain compatible; this release does not change server authentication policy, TCP firewall requirements, signing or automatic-update limitations.
