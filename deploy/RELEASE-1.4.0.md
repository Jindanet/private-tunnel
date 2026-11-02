# PrivateTunnel 1.4.0

PrivateTunnel Device is the first native C++ client for ESP32 and ESP8266. It exposes small HTTP callbacks through the existing server using an outbound, certificate-verified WSS connection, without a computer or Node.js on the board.

Device support is experimental. Both example sketches are compiled for pinned ESP32 and ESP8266 cores, and the native parser and real gateway paths are tested in CI. Peak TLS memory and sustained reliability have not yet been measured on physical hardware.

## Install

- Desktop/CLI: download the matching platform asset. Termux can still use the one-line install and `node ptunnel.js`.
- Arduino: install `PrivateTunnelDevice-v1.4.0-arduino.zip` through **Sketch → Include Library → Add .ZIP Library**, install the matching ESP core, and open the `ProvisionedHttp` example.
- Server: update the source and dependencies, preserve state, and create an **ESP32 / ESP8266 device** key in administrator Settings. Save its separate visitor password too.

The device setup Wi-Fi saves configuration once and reconnects on power-up. The current API supports one request at a time, 512-byte frames/windows, a 1024-byte request body and static flash response streaming. Native TCP, UDP, multi-stream device mode and AVR firmware are not included.

## Upgrade notes

Back up the database, environment and `client-keys.json` before upgrading. New device keys add registry fields that older servers do not understand; a downgrade needs a compatible pre-device backup. Existing desktop keys, ownership and v4 transport remain supported. Device key rotation replaces both the connection and visitor secrets and disconnects active sessions.

The main README is now English with a separate Thai README. Detailed guides cover everyday use, Termux, pre-login startup, devices, server deployment, configuration and limits. Screenshots reuse existing captures; no app was launched locally for this documentation update.

[English documentation](../README.md) · [Thai documentation](../README.th.md) · [Device guide](../docs/en/devices.md)
