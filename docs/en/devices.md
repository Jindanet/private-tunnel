# PrivateTunnel Device

[Overview](../../README.md) · [Thai guide](../th/devices.md)

I added a separate device client because running the desktop client on a microcontroller is not practical. Node.js, large receive windows and general-purpose socket forwarding do not fit the same constraints as an ESP8266. This library keeps the work small: a verified outbound TLS connection, one HTTP request, and a C++ callback that reads a sensor or prepares a response.

Device support is **experimental**, library **0.1.1**, wire protocol **`ptunnel.device.v1`**. Automated tests exercise the actual server, and CI compiles BasicHttp, ProvisionedHttp and WakeOnLan for ESP32 core **3.3.12** and ESP8266 core **3.1.2**. These checks do not establish stability on physical hardware or provide a measured peak RAM figure.

## Choose a board

| Hardware | Current approach |
| --- | --- |
| ESP32 with the Arduino ESP32 core | Native library; start with a development board with USB serial |
| ESP8266, including NodeMCU | Same bounded native HTTP client; check free heap carefully |
| Arduino board based on ESP32 | Use the appropriate ESP32 board package and pin configuration |
| Classic Uno R3 / AVR | Use a gateway; 2 KiB SRAM is not a practical target for this TLS client |
| Other Arduino architectures, ESP-IDF without Arduino | Not supported by this library yet |

The API and limits are intentionally the same on ESP32 and ESP8266 in this release. ESP32 does not yet have the proposed two-stream mode or TCP relay.

## Install with Arduino IDE

1. Update the PrivateTunnel server to **1.4.0 or later**. Keep `REQUIRE_DATA_TRANSPORT_V4=true`; the device adapter does not require weakening desktop transport policy.
2. In administrator **Settings → Client access keys**, choose **ESP32 / ESP8266 device** and create a named key. Copy the **connection key** and **visitor password** immediately. Only hashes remain on the server.
3. Download `PrivateTunnelDevice-v1.4.1-arduino.zip` from [Releases](https://github.com/Jindanet/private-tunnel/releases) and use **Sketch → Include Library → Add .ZIP Library**. Alternatively, copy the complete [`device/PrivateTunnelDevice`](../../device/PrivateTunnelDevice) folder into the sketchbook's `libraries` directory; it directly contains `library.properties` and `src`. Restart the IDE if necessary. No separate WebSocket library is needed.
4. Add the matching board-manager index in Arduino IDE Preferences:

   ESP32: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`

   ESP8266: `https://arduino.esp8266.com/stable/package_esp8266com_index.json`

5. Install the board core, select your actual board and USB port, and open **File → Examples → PrivateTunnelDevice → ProvisionedHttp**.
6. Upload, then open Serial Monitor at **115200 baud**.

The tested compiler targets are `esp32:esp32:esp32` and `esp8266:esp8266:nodemcuv2`. Other boards can require different USB drivers, flash sizes, partitions or setup-button pins. The example uses **GPIO 0**; adapt it for a board without that button. Do not keep GPIO 0 held during reset, which can enter the ROM bootloader.

## Save settings once

On a fresh board, the example opens a temporary WPA2 Wi-Fi network named **`PrivateTunnel-Setup`**. Its random password appears only on Serial Monitor. Join it and open **`http://192.168.4.1/`**. The portal closes after five minutes if unused; this is a local setup page, not the public tunnel.

Enter:

| Field | Example / purpose |
| --- | --- |
| Wi-Fi SSID and password | The network the board should reconnect to |
| Server hostname | `admin.example.com`, without a scheme or path |
| WebSocket path | Copy the complete path from administrator Settings, normally `/_private-tunnel/ws` |
| Device connection key | The `ptk_...` key created with device type |
| Publish domain | `apps.example.com`, or empty to use the server's first eligible domain |
| Subdomain | `sensor-one`, or empty for an assigned name |
| Trusted root CA | PEM for the root that validates the server certificate chain, maximum 2047 characters in this example |

Save, reconnect your computer/phone to its normal Wi-Fi, and watch Serial Monitor. The board restarts, joins Wi-Fi, obtains time using SNTP, checks the TLS certificate and hostname, and opens its tunnel. It prints the public URL after connection; append **`/status`**.

To replace saved settings, reset normally, then **press BOOT/FLASH during the first three seconds after startup**. Release it during reset itself. If a wrong key is rejected, the client stops retrying until reconfigured/restarted rather than repeatedly hammering authentication.

The example owns an **EEPROM emulation sector**. Do not combine it with another EEPROM user without adapting storage. It stores Wi-Fi credentials, the device key and CA **without encryption** and writes only when Save is selected. Physical flash access can expose them. The basic example avoids a setup portal and takes configuration from your sketch instead.

## TLS and certificates

TLS is mandatory in this native client. There is no insecure-certificate switch or plaintext fallback. Obtain the root CA from the certificate authority or your server administrator through a trusted channel; a leaf certificate is not a durable substitute. The server must send its intermediate chain. Rotate the saved CA before a trust-root change.

`BasicHttp` embeds a placeholder CA deliberately: it must be replaced with a real PEM before connecting. The portal example also requires you to supply a valid root. Correct time is required for certificate validity, so allow SNTP or provide a reliable clock in your own firmware. A certificate-chain, hostname, DNS or clock problem must be fixed, not bypassed.

The core's usual TLS record buffers remain enabled. **A 512-byte tunnel frame does not make TLS use a 512-byte receive buffer.** The initial release does not negotiate reduced TLS records, implement session resumption explicitly, or guarantee a nonblocking handshake.

## Access the public device

Open `https://sensor-one.apps.example.com/status` and enter username **`device`** and the **visitor password**. For scripts:

```bash
curl -H "Authorization: Bearer $DEVICE_VISITOR_TOKEN" https://sensor-one.apps.example.com/status
```

By default, the server checks visitor authentication before forwarding any request to the board. The connection key cannot be used as a visitor password; ordinary desktop keys cannot connect as devices, and device keys cannot enter the desktop transport.

Rotating a device key changes **both secrets** and disconnects existing connections. Update the saved board key and the visitor's password. The same key ID and board identity preserve the address reservation. Revocation is permanent. Do not send either secret as a URL query parameter.

### Use the board's own login page

Server **1.4.1+** lets an administrator turn off **Require visitor password** on an existing device key in Settings. The next request goes directly to the firmware's page, without a second browser login. This setting applies immediately and does not rotate the connection key, disconnect the board or require reflashing. Newly created keys require a visitor password by default; the creation form can explicitly disable it too.

When off, the firmware is responsible for authenticating every protected action. The connection key is still required to connect the board. You can turn the visitor password back on at any time; its current value remains valid. The policy is saved per device key and applies to every board using that key.

Server **1.4.1+** forwards the actual content type and raw body, including `text/plain`, form data, binary data or JSON, within the existing limits. A supplied browser `Origin` must be the same HTTPS hostname. Use GET/HEAD for read-only actions; callbacks must validate methods, body format, values and operation permissions. This library does not parse credentials or JSON for you. `DeviceRequest::contentType` is a fixed character array; it cannot be a null pointer.

### Wake-on-LAN example

Open **File → Examples → PrivateTunnelDevice → WakeOnLan**. Set your Wi-Fi, server hostname/path, device connection key, trusted root CA, publish domain, target MAC, broadcast address and a strong `WEB_PASSWORD`. The supplied values are placeholders. Disable **Require visitor password** on that device key if you want only the example's own login page.

The page posts `text/plain` containing username, a newline and password. The board checks those credentials on both `/login` and `/wake`; the browser retains them in memory until logout or page close. There is no server-side session. Five failed attempts lock this example for sixty seconds, and wake requests have a ten-second cooldown. A successful response means a magic packet was sent, not confirmation that the PC booted.

The ESP and PC must be on a LAN that permits the configured broadcast. Enable Wake-on-LAN on the PC's firmware/network adapter and provide standby power/network connectivity. UDP is sent locally by the board; this does not add UDP tunneling to PrivateTunnel. Certificate/time failures must still be resolved before connecting. [Example source](../../device/PrivateTunnelDevice/examples/WakeOnLan/WakeOnLan.ino).

## Write a callback

`BasicHttp.ino` is the smallest complete example. Wi-Fi, a valid clock and long-lived configuration strings must be set before calling `begin`.

```cpp
#include <PrivateTunnelDevice.h>
PrivateTunnelDevice tunnel;

void registerRoutes() {
  tunnel.onHttp("/status", [](const DeviceRequest& req, DeviceResponse& res) {
    if (strcmp(req.method, "GET") != 0) {
      res.json(405, "{\"error\":\"GET required\"}");
      return;
    }
    res.json(200, "{\"online\":true}");
  });
}

void loop() {
  tunnel.poll();
  // Other short application work.
}
```

| API | Contract |
| --- | --- |
| `onHttp(path, handler)` | At most eight exact path matches, including the query string; keep path storage alive |
| `begin(config)` | Validates configuration and prepares TLS; connection progresses through `poll()` |
| `poll()` | Call frequently; processes up to two incoming WebSocket frames and one response chunk per call |
| `online()`, `publicUrl()`, `lastError()` | Current status and last diagnostic; never print the connection key |
| `stop()` | Disconnects and disables retries; `begin()` enables a new configuration |
| `DeviceRequest` | Method, raw path/query, content type and up to 1024 raw body bytes; `bodyLength` is authoritative |
| `response.json(status, text)` / `text(...)` | Copies up to 512 response bytes; returns false on an invalid or oversized response |
| `response.send_P(status, contentType, flashPointer, length)` | Streams a persistent PROGMEM buffer in chunks; the pointer must stay valid until completion |

`DeviceConfig` takes `host`, `port` (443), `path`, `key`, `caCertificate`, `clientId`, `domain` and `subdomain`. Strings are borrowed, not copied. Keep them alive while connected. `clientId` is a stable profile identifier, not an authentication credential. The provisioning example derives it from the board's MAC address.

Callbacks run only after the bounded request body arrives. Return promptly so networking and the watchdog can run. A route that does not prepare a response receives a 404 fallback. No asynchronous response object may be kept after the callback. Choose flash streaming for larger static responses. There is no dynamic routing, arbitrary response-header API, SSE generator or existing HTTP-server relay in this version.

## Limits and memory

| Item | Both supported chips |
| --- | --- |
| Tunnels / active requests | One per connection / one |
| Wire payload / envelope | 512 bytes / 8 bytes |
| Initial data credit | 512 bytes in each direction per request |
| Complete request body | 1024 bytes, including chunked uploads |
| Path and query | 192 bytes |
| Content type | 64 bytes |
| Small copied response | 512 bytes |
| Routes | Eight |
| Device ID / domain / subdomain | 48 / 253 / 63 bytes |

Protocol and application buffers are fixed inside the C++ object. Wi-Fi, TLS, certificate parsing, the Arduino core and the temporary setup web server allocate their own memory. The provisioning example also retains its settings structure. It prints `sizeof(tunnel)`, `sizeof(settings)` and free heap to help separate these costs. Compiler global-RAM reports are not peak TLS heap measurements.

ESP8266's BearSSL documentation describes roughly **6 KiB stack plus 22 KiB connection buffers** before other application costs. Do not promise a total 4–6 KiB client. Avoid a second TLS connection, large JSON documents or a second web server alongside this tunnel until measurements prove they fit. See [ESP8266 BearSSL documentation](https://arduino-esp8266.readthedocs.io/en/3.1.2/esp8266wifi/bearssl-client-secure-class.html).

The server rejects extra requests with **503**, oversized bodies with **413**, and long metadata with **431**. It does not impose JSON-only bodies. A callback can still reject a format it does not support. The server does not accumulate a request backlog on the board. A disconnected visitor cancels its stream. Response credit is returned after the public HTTP destination consumes the data.

## Wire protocol

WSS uses subprotocol `ptunnel.device.v1` on the existing client endpoint. Each unfragmented binary WebSocket message contains an eight-byte big-endian envelope: type, zero flags, 16-bit stream ID, 16-bit payload length and zero reserved bytes. Stream zero is connection-wide. There is no Base64 or compression.

| Type | Payload |
| --- | --- |
| HELLO (1) | Version u8, frame size u16, streams u8, receive window u16, four u8 lengths, then device ID/domain/subdomain/board ASCII strings |
| READY (2) | Frame u16, streams u8, window u16, body limit u16, URL length u16, URL |
| OPEN (3) | Method length u8, path length u16, content-type length u8, then those strings |
| DATA (4) | Nonempty raw bytes, bounded by remaining credit |
| END (5) | Empty; completes a request or response direction after DATA |
| CREDIT (6) | Positive u16 bytes consumed; cannot exceed the negotiated window |
| CANCEL (7) | Empty; releases a stream |
| ERROR (8) | Connection diagnostic; firmware stops rather than exposing secrets |
| PING/PONG (9/10) | Empty connection heartbeat |
| RESPONSE (11) | Status u16 (200–599), content-type length u8, content type |

The first release negotiates exactly one stream, 512-byte frames and a 512-byte window. Stream IDs are not reused on a connection. The server adapter translates into its internal manager representation; desktop clients still require v4 on the wire. This is not a legacy desktop-v1 opt-in.

Reconnects use exponential delays from one to sixty seconds plus jitter. No interrupted request resumes after a reconnect. Server heartbeats and a 90-second firmware watchdog detect stale connections. TLS handshakes can block for seconds; keep timing-critical control independent of tunnel work.

## Validate on real hardware before deployment

Measure minimum free heap, largest free block and handshake peak with your actual CA chain and sketch. Test repeated Wi-Fi loss, DNS/SNTP failure, certificate rejection, key rotation, visitor aborts, 1024-byte uploads, oversize rejection, large flash responses and prolonged operation. Check the watchdog and any sensor deadlines. CI compilation and simulated clients do not replace these measurements.

For a board that cannot spare the memory, use a gateway now:

```bash
node ptunnel.js http 192.168.1.50:80
```

The gateway must reach the board's HTTP service and stay running. This is ordinary desktop/CLI HTTP forwarding, so its public visitor authentication must be supplied by the application or an external gateway policy. It does not inherit device visitor-token enforcement.
