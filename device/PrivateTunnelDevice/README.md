# PrivateTunnel Device

Experimental native Arduino HTTP client for ESP32 and ESP8266. Library version 0.1.1; device protocol v1 needs server 1.4.0+. Use server 1.4.1+ for the WakeOnLan example and configurable visitor authentication.

Install the matching ESP board core, open **File → Examples → PrivateTunnelDevice → ProvisionedHttp**, select your board and upload. Serial Monitor at **115200** prints the temporary setup Wi-Fi password. Join that network and open `http://192.168.4.1/` to save your server, device key, trusted root CA and Wi-Fi once.

Create an **ESP32 / ESP8266 device** key in server Settings. Firmware uses the connection key; by default, visitors use username `device` and the separate visitor password. If your firmware handles login, turn off **Require visitor password** on that key. This takes effect immediately without changing the firmware key. Do not put the visitor password in firmware.

The **WakeOnLan** example includes its own login and sends a local UDP magic packet after authentication. Configure Wi-Fi, server/key/CA, target MAC, broadcast and the web password before upload. Disable the outer visitor prompt to use one login page. Text bodies are forwarded as-is by server 1.4.1+; the example checks `text/plain` and does not need JSON credentials.

One HTTP callback request at a time, 512-byte frames, 1024-byte request bodies. No native TCP or AVR client. TLS and Wi-Fi allocate additional RAM. Automated compilation is not a physical-board stability or peak-memory measurement.

The provisioning example owns the EEPROM emulation area and stores secrets without encryption. Adapt storage/button pins for your board. Press BOOT/FLASH within the first three seconds after a normal reset to reconfigure; release it during reset itself.

[English installation and API](https://github.com/Jindanet/private-tunnel/blob/main/docs/en/devices.md) · [Thai installation and API](https://github.com/Jindanet/private-tunnel/blob/main/docs/th/devices.md)

MIT license; see LICENSE. TLS/Wi-Fi are supplied by the separately licensed Arduino board core.
