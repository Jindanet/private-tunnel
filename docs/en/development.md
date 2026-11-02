# Development and releases

[Overview](../../README.md) · [Thai guide](../th/development.md)

## Source layout

| Path | Responsibility |
| --- | --- |
| `app/` | Electron desktop main process, IPC, credential storage and renderer |
| `client/` | CLI, HTTP/TCP forwarding and boot-service installation/worker |
| `ptunnel.js` | Generated standalone CLI, including WebSocket code and license notices |
| `server/` | HTTP/WebSocket listeners, administrator UI, database, authentication and routing |
| `server/device-bridge.js` | Server-created adapter for the bounded device wire |
| `shared/protocol.js`, `shared/tunnel-v4.js` | Desktop control and current credit-controlled transport |
| `shared/device-protocol.js` | Device wire validation and constants |
| `device/PrivateTunnelDevice/` | Arduino library, bounded WebSocket parser and two examples |
| `tests/` | Unit, gateway, Electron, startup and native firmware-parser checks |
| `deploy/`, `.github/` | Service/proxy examples and CI/release automation |

## Work on the app

Use Node.js **22.12+** and dependencies from the lockfile:

```bash
npm ci
npm run app
npm test
```

These are instructions for a development environment where execution is permitted. **`npm test` launches Electron and isolated local servers.** It is not a static check. For this update, execution and firmware compilation were performed on GitHub Actions instead of the maintainer's computer.

Tests use temporary state and loopback fixtures. CI runs on Windows/Linux with Node 22/24, a virtual display on Linux, generated-bundle checking and production-dependency audit. MySQL integration requires a deliberately configured test database; do not point tests at production state.

When changing client sources or bundled package metadata, regenerate the standalone file in an authorized development/CI environment:

```bash
npm run build:termux
npm run check:termux
```

The freshness check compares the generated result with the checked-in file and verifies no external runtime dependency remains. Do not treat editing generated code as the normal source workflow.

## Compile firmware

The Arduino library has no third-party WebSocket dependency. CI pins Arduino CLI **1.5.1**, ESP32 core **3.3.12** and ESP8266 core **3.1.2**, and compiles `BasicHttp` plus `ProvisionedHttp` for both boards. A local equivalent, after installing the matching core:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 --library device/PrivateTunnelDevice device/PrivateTunnelDevice/examples/ProvisionedHttp
arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2 --library device/PrivateTunnelDevice device/PrivateTunnelDevice/examples/ProvisionedHttp
```

Native C++ tests check the shared wire golden frame, byte-at-a-time parsing, request bodies, response credit, cancellation, terminal authentication close, oversize frame rejection and heartbeat timeout. Host doubles model Arduino networking; they **do not test cryptography, real TLS verification, Wi-Fi or hardware timing**. Actual gateway tests cover device/desktop key isolation, visitor auth, 1 KiB uploads, large credit-controlled responses, overload, cancellation and key rotation.

Physical-board validation remains a separate task; see the [device measurement plan](devices.md#validate-on-real-hardware-before-deployment). CI firmware artifacts are compiler outputs for the named board targets, not a universal preconfigured firmware. The setup example requires the user's own server, key and CA.

## Build and publish

The package includes platform CLI build scripts and Electron Builder scripts. Windows GUI ZIPs are currently published; Linux/macOS GUI builds can be produced from source. Building a GUI package does not sign it or install an updater.

The release workflow starts on `main`, matching version tags or a manual dispatch. It validates package/lockfile versions, refuses moved tags or downgrades, and skips an already published version. A change needs a **new package version** to produce a new public build.

Before publishing, it tests source, checks the standalone bundle, builds Windows desktop/CLI, Linux CLI and both macOS CLIs, and compiles/tests the native device library. Source packaging also creates an Arduino-installable library ZIP. Publication waits for all required jobs, validates the complete asset set and writes `SHA256SUMS.txt` before making the release visible. Failed uploads remain drafts that can be resumed without replacing a published version.

Use `deploy/RELEASE-x.y.z.md` for user-facing release notes, update the changelog and both documentation languages, and keep limitations explicit. Do not include `.env`, private databases, the key registry, EEPROM dumps or screenshots containing real credentials in commits or artifacts.
