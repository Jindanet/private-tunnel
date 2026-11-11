#include <Arduino.h>
#if defined(ESP8266)
#include <ESP8266WiFi.h>
#else
#include <WiFi.h>
#endif
#include <WiFiUdp.h>
#include <PrivateTunnelDevice.h>
#include <time.h>
#include <string.h>

// ========================================
// WIFI
// ========================================
static const char WIFI_SSID[] = "YOUR_WIFI";
static const char WIFI_PASSWORD[] = "YOUR_WIFI_PASSWORD";

// ========================================
// PRIVATE TUNNEL
// ========================================
static const char TUNNEL_HOST[] = "admin.example.com";
static const char TUNNEL_PATH[] = "/_private-tunnel/ws";

// ต้องเป็น Device Key ที่ถูกต้องตามไลบรารี
static const char DEVICE_KEY[] = "YOUR_PTK_DEVICE_KEY";

// ต้องตรงกับ Publish Domain ที่ Server รองรับ
static const char PUBLISH_DOMAIN[] = "YOUR_PUBLISH_DOMAIN";
static const char SUBDOMAIN[] = "pc-wol";
static const char CLIENT_ID[] = "esp32-pc-wol";

// วาง Root CA จริงของ Tunnel Server
static const char ROOT_CA[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
REPLACE_WITH_ACTUAL_ROOT_CA
-----END CERTIFICATE-----
)PEM";

// ========================================
// WEB AUTH
// ========================================
static const char WEB_USER[] = "admin";
static const char WEB_PASSWORD[] = "CHANGE_TO_STRONG_PASSWORD";

// ป้องกันการเดารหัสผ่านเบื้องต้น
static const uint8_t MAX_LOGIN_FAILS = 5;
static const uint32_t LOCKOUT_MS = 60000;

uint8_t loginFails = 0;
uint32_t lockedUntil = 0;

// ========================================
// WAKE ON LAN
// ========================================
static const uint8_t TARGET_MAC[6] = {
  0xDE, 0xAD, 0xBE,
  0xEF, 0x00, 0x01
};

static const IPAddress BROADCAST_IP(
  192, 168, 1, 255
);

static const uint16_t WOL_PORT = 9;
static const uint32_t WOL_COOLDOWN = 10000;

uint32_t lastWake = 0;
bool hasWoken = false;

PrivateTunnelDevice tunnel;
DeviceConfig config;
WiFiUDP udp;

// ========================================
// WEB DASHBOARD
// ========================================
static const char PAGE[] PROGMEM = R"HTML(
<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport"
 content="width=device-width,initial-scale=1">
<title>PC Remote Control</title>
<style>
*{box-sizing:border-box}
body{
 margin:0;
 min-height:100vh;
 display:grid;
 place-items:center;
 padding:20px;
 background:#0b1120;
 color:#f8fafc;
 font-family:Arial,sans-serif
}
.card{
 width:100%;
 max-width:420px;
 background:#172033;
 border:1px solid #334155;
 border-radius:20px;
 padding:30px;
 text-align:center
}
h1{font-size:25px;margin:0 0 12px}
p{color:#94a3b8;line-height:1.7}
input{
 display:block;
 width:100%;
 padding:15px;
 margin:12px 0;
 background:#0f172a;
 color:white;
 border:1px solid #475569;
 border-radius:10px;
 font-size:16px
}
button{
 width:100%;
 padding:16px;
 margin-top:12px;
 border:0;
 border-radius:12px;
 background:#22c55e;
 color:#052e16;
 font-size:17px;
 font-weight:bold;
 cursor:pointer
}
button:disabled{opacity:.5}
.secondary{
 background:#334155;
 color:#f8fafc
}
.hidden{display:none}
.status{
 margin-top:18px;
 min-height:22px;
 color:#cbd5e1;
 font-size:14px;
 overflow-wrap:anywhere
}
.info{font-size:13px}
</style>
</head>
<body>
<div class="card">

<section id="loginPanel">
<h1>PC Remote Control</h1>
<p>เข้าสู่ระบบเพื่อควบคุมคอมพิวเตอร์</p>

<form id="loginForm">
<input id="username"
 placeholder="Username"
 autocomplete="username"
 required maxlength="64">

<input id="password"
 type="password"
 placeholder="Password"
 autocomplete="current-password"
 required maxlength="128">

<button type="submit" id="loginBtn">
LOGIN
</button>
</form>
</section>

<section id="controlPanel" class="hidden">
<h1>PC Wake Control</h1>

<p class="info">
Wake on LAN<br>
MAC: DE-AD-BE-EF-00-01<br>
Broadcast: 192.168.1.255:9
</p>

<button id="wakeBtn" onclick="wakePC()">
POWER ON
</button>

<button class="secondary" onclick="logout()">
LOGOUT
</button>
</section>

<div id="status" class="status">Ready</div>

</div>

<script>
let credentials=null;

const statusEl=document.getElementById('status');
const loginPanel=document.getElementById('loginPanel');
const controlPanel=document.getElementById('controlPanel');

async function api(path,body){
 const response=await fetch(path,{
  method:'POST',
  cache:'no-store',
  headers:{'Content-Type':'text/plain'},
  body:body
 });
 const text=await response.text();
 let data={};
 try{data=JSON.parse(text)}catch(e){data={error:text||('HTTP '+response.status)}}
 return {ok:response.ok,data};
}

document.getElementById('loginForm')
.addEventListener('submit',async function(e){
 e.preventDefault();

 const user=document.getElementById('username').value;
 const pass=document.getElementById('password').value;
 const btn=document.getElementById('loginBtn');

 if(user.includes('\n')||pass.includes('\n')){
  statusEl.textContent='Invalid credentials';
  return;
 }

 btn.disabled=true;
 statusEl.textContent='กำลังตรวจสอบ...';

 try{
  const candidate=user+'\n'+pass;
  const r=await api('/login',candidate);

  if(r.ok && r.data.success){
   credentials=candidate;
   document.getElementById('password').value='';
   loginPanel.classList.add('hidden');
   controlPanel.classList.remove('hidden');
   statusEl.textContent='Login successful';
  }else{
   statusEl.textContent=r.data.error||'Login failed';
  }
 }catch(e){
  statusEl.textContent='Connection failed';
 }

 btn.disabled=false;
});

async function wakePC(){
 if(!credentials)return;

 const btn=document.getElementById('wakeBtn');
 btn.disabled=true;
 statusEl.textContent='Sending Magic Packet...';

 try{
  const r=await api('/wake',credentials);
  statusEl.textContent=
   r.data.message||r.data.error||'Request failed';
 }catch(e){
  statusEl.textContent='Connection failed';
 }

 setTimeout(()=>btn.disabled=false,3000);
}

function logout(){
 credentials=null;
 loginPanel.classList.remove('hidden');
 controlPanel.classList.add('hidden');
 statusEl.textContent='Logged out';
 document.getElementById('password').value='';
}
</script>
</body>
</html>
)HTML";

// ========================================
// AUTH HELPERS
// ========================================

// เปรียบเทียบแบบไม่หยุดเมื่อพบอักขระผิด
bool secureCompare(
  const uint8_t* input,
  size_t length,
  const char* expected
) {
  size_t expectedLen = strlen(expected);
  size_t maxLen = length > expectedLen
    ? length : expectedLen;

  unsigned int diff = (unsigned int)(length ^ expectedLen);

  for (size_t i = 0; i < maxLen; i++) {
    uint8_t a = i < length ? input[i] : 0;
    uint8_t b = i < expectedLen
      ? (uint8_t)expected[i] : 0;
    diff |= a ^ b;
  }

  return diff == 0;
}

bool isLocked() {
  return lockedUntil != 0 &&
    (int32_t)(millis() - lockedUntil) < 0;
}

bool checkAuth(
  const DeviceRequest& req,
  DeviceResponse& res
) {
  if (isLocked()) {
    res.json(429,
      "{\"error\":\"Too many attempts. Try later.\"}");
    return false;
  }

  if (strcmp(req.method, "POST") != 0) {
    res.json(405, "{\"error\":\"POST required\"}");
    return false;
  }

  if (strncmp(req.contentType, "text/plain", 10) != 0) {
    res.json(415, "{\"error\":\"Invalid content type\"}");
    return false;
  }

  // Request body = username + newline + password
  size_t userLen = strlen(WEB_USER);
  size_t passLen = strlen(WEB_PASSWORD);
  size_t expectedLen = userLen + 1 + passLen;

  // จำกัดขนาดข้อมูลที่รับ
  if (req.bodyLength > 256) {
    res.json(400, "{\"error\":\"Invalid request\"}");
    return false;
  }

  // สร้าง credential ที่คาดหวัง
  char expected[257];

  if (expectedLen >= sizeof(expected)) {
    res.json(500, "{\"error\":\"Auth configuration error\"}");
    return false;
  }

  memcpy(expected, WEB_USER, userLen);
  expected[userLen] = '\n';
  memcpy(expected + userLen + 1,
         WEB_PASSWORD, passLen);
  expected[expectedLen] = '\0';

  bool valid = secureCompare(
    req.body,
    req.bodyLength,
    expected
  );

  // ล้างข้อมูลชั่วคราว
  memset(expected, 0, sizeof(expected));

  if (!valid) {
    loginFails++;

    if (loginFails >= MAX_LOGIN_FAILS) {
      lockedUntil = millis() + LOCKOUT_MS;
      loginFails = 0;
      Serial.println("[AUTH] Locked for 60 seconds");
    }

    res.json(401, "{\"error\":\"Invalid credentials\"}");
    return false;
  }

  loginFails = 0;
  lockedUntil = 0;

  return true;
}

// ========================================
// MAGIC PACKET
// ========================================
bool sendMagicPacket() {
  uint8_t packet[102];

  memset(packet, 0xFF, 6);

  for (int i = 0; i < 16; i++) {
    memcpy(packet + 6 + i * 6, TARGET_MAC, 6);
  }

  if (!udp.beginPacket(BROADCAST_IP, WOL_PORT)) {
    return false;
  }

  size_t written = udp.write(packet, sizeof(packet));
  bool sent = udp.endPacket() == 1;

  return written == sizeof(packet) && sent;
}

// ========================================
// HTTP ROUTES
// ========================================
void handleHome(
  const DeviceRequest& req,
  DeviceResponse& res
) {
  if (strcmp(req.method, "GET") != 0) {
    res.json(405, "{\"error\":\"GET required\"}");
    return;
  }

  res.send_P(
    200,
    "text/html; charset=utf-8",
    PAGE,
    sizeof(PAGE) - 1
  );
}

void handleLogin(
  const DeviceRequest& req,
  DeviceResponse& res
) {
  if (!checkAuth(req, res)) return;

  Serial.println("[AUTH] Login successful");

  res.json(200, "{\"success\":true}");
}

void handleWake(
  const DeviceRequest& req,
  DeviceResponse& res
) {
  if (!checkAuth(req, res)) return;

  uint32_t now = millis();

  if (hasWoken &&
      now - lastWake < WOL_COOLDOWN) {
    res.json(429,
      "{\"error\":\"Please wait 10 seconds\"}");
    return;
  }

  if (!sendMagicPacket()) {
    res.json(500,
      "{\"error\":\"UDP send failed\"}");
    return;
  }

  lastWake = now;
  hasWoken = true;

  Serial.println("[WOL] Magic Packet sent");

  res.json(200,
    "{\"success\":true,\"message\":\"Magic Packet sent successfully\"}");
}

// ========================================
// NTP
// ========================================
bool syncTime() {
  Serial.println("[NTP] Synchronizing...");

  configTime(
    0, 0,
    "pool.ntp.org",
    "time.google.com",
    "time.cloudflare.com"
  );

  uint32_t start = millis();

  while (time(nullptr) < 1700000000) {
    if (millis() - start > 15000) {
      Serial.println("[NTP] Timeout");
      return false;
    }
    delay(250);
  }

  Serial.println("[NTP] Ready");
  return true;
}

// ========================================
// SETUP
// ========================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\nESP32 PC WAKE CONTROLLER");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("[WiFi] Connecting");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("[WiFi] IP: ");
  Serial.println(WiFi.localIP());

  while (!syncTime()) {
    delay(5000);
  }

  udp.begin(0);

  config.host = TUNNEL_HOST;
  config.port = 443;
  config.path = TUNNEL_PATH;
  config.key = DEVICE_KEY;
  config.caCertificate = ROOT_CA;
  config.clientId = CLIENT_ID;
  config.domain = PUBLISH_DOMAIN;
  config.subdomain = SUBDOMAIN;

  tunnel.onHttp("/", handleHome);
  tunnel.onHttp("/login", handleLogin);
  tunnel.onHttp("/wake", handleWake);

  Serial.println("[Tunnel] Starting...");

  if (!tunnel.begin(config)) {
    Serial.print("[Tunnel] Error: ");
    Serial.println(tunnel.lastError());
  }
}

// ========================================
// LOOP
// ========================================
void loop() {
  tunnel.poll();

  static uint32_t lastReport = 0;

  if (millis() - lastReport >= 5000) {
    lastReport = millis();

    Serial.println("\n===== STATUS =====");

    Serial.print("WiFi: ");
    Serial.println(
      WiFi.status() == WL_CONNECTED
        ? "CONNECTED" : "DISCONNECTED"
    );

    Serial.print("Free heap: ");
    Serial.println(ESP.getFreeHeap());

    Serial.print("Tunnel: ");
    Serial.println(
      tunnel.online() ? "ONLINE" : "OFFLINE"
    );

    Serial.print("Error: ");
    Serial.println(tunnel.lastError());

    if (tunnel.online()) {
      Serial.print("Public URL: ");
      Serial.println(tunnel.publicUrl());
    }

    Serial.println("==================");
  }
}
