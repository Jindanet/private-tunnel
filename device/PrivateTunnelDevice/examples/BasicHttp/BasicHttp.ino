#include <PrivateTunnelDevice.h>
#include <time.h>

// Use the root CA that validates your server's certificate chain. Never paste
// the visitor password here: firmware needs only its device connection key.
static const char ROOT_CA[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
REPLACE_WITH_YOUR_TRUSTED_ROOT_CA_PEM
-----END CERTIFICATE-----
)PEM";
PrivateTunnelDevice tunnel;
DeviceConfig config;

void status(const DeviceRequest& request, DeviceResponse& response) {
  if(strcmp(request.method,"GET")&&strcmp(request.method,"HEAD")) {
    response.json(405,"{\"error\":\"GET required\"}");return;
  }
  char body[128];
  snprintf(body,sizeof(body),"{\"online\":true,\"uptime_ms\":%lu,\"free_heap\":%u}",
    static_cast<unsigned long>(millis()),ESP.getFreeHeap());
  response.json(200,body);
}
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin("YOUR_WIFI_SSID","YOUR_WIFI_PASSWORD");
  configTime(0,0,"pool.ntp.org","time.cloudflare.com");
  config.host="admin.example.com";
  // Copy the complete WebSocket path from admin Settings, including custom roots.
  config.path="/_private-tunnel/ws";
  config.key="YOUR_DEVICE_CONNECTION_KEY";
  config.caCertificate=ROOT_CA;
  config.clientId="sensor-one";
  config.domain="apps.example.com";
  config.subdomain="sensor-one";
  tunnel.onHttp("/status",status);
  if(!tunnel.begin(config))Serial.println(tunnel.lastError());
}
void loop() {
  tunnel.poll();
  static uint32_t report=0;
  if(millis()-report>10000){report=millis();Serial.println(tunnel.online()?tunnel.publicUrl():tunnel.lastError());}
  // Keep callbacks and other application work short; TLS handshakes can block.
}
