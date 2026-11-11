# PrivateTunnel 1.4.1

Fix device web logins that use `text/plain` or forms. The server now forwards the actual content type and raw body instead of rejecting non-JSON POST requests with 415.

In administrator **Settings → Client access keys**, turn off **Require visitor password** on the relevant device key when its firmware already provides a login page. This removes the extra browser authentication prompt immediately, without rotating the connection key or reflashing the board. Device connection authentication remains required. The firmware is responsible for protecting its own actions when this option is off.

Existing keys remain protected by default. The policy is saved per device key and preserved on rotation. A saved policy adds a registry field; back up `client-keys.json` before changing it and restore a compatible backup if downgrading to 1.4.0.

The Arduino ZIP includes a **WakeOnLan** example with its own login page, text credential checks, retry lockout and wake cooldown. Configure the server, device key, root CA, Wi-Fi, MAC/broadcast and web password before uploading. This example sends local UDP; it does not add UDP tunnels. The library remains experimental and requires physical-board validation.

Update the server to receive this fix. An existing sketch using `text/plain` does not need rewriting solely for the gateway change. Certificate/clock errors are separate and still need valid TLS configuration.

[English guide](../docs/en/devices.md#use-the-boards-own-login-page) · [Thai guide](../docs/th/devices.md)
