#include <PrivateTunnelDevice.h>
#include <EEPROM.h>
#include <time.h>
#if defined(ESP8266)
#include <ESP8266WebServer.h>
using SetupServer=ESP8266WebServer;
#else
#include <WebServer.h>
#include <esp_system.h>
using SetupServer=WebServer;
#endif

// This example owns the EEPROM emulation sector. Do not combine it with other
// EEPROM users. Settings (including Wi-Fi/device secrets) are not encrypted.
struct Settings {
  uint32_t magic,checksum;
  char ssid[33],password[65],host[254],path[192],key[85],domain[254],subdomain[64],ca[2048];
} settings={};
static_assert(sizeof(Settings)<=4096,"Settings must fit ESP8266 EEPROM");
PrivateTunnelDevice tunnel;
DeviceConfig connection;
char identity[32];
bool portal=false;
uint32_t portalStarted=0;
SetupServer* setupServer=nullptr;
uint32_t checksum() {
  const uint8_t* p=reinterpret_cast<const uint8_t*>(&settings)+8;uint32_t h=2166136261UL;
  for(size_t i=8;i<sizeof(settings);++i)h=(h^*p++)*16777619UL;
  return h;
}
bool terminated() {
  return memchr(settings.ssid,0,sizeof(settings.ssid))&&memchr(settings.password,0,sizeof(settings.password))
    &&memchr(settings.host,0,sizeof(settings.host))&&memchr(settings.path,0,sizeof(settings.path))
    &&memchr(settings.key,0,sizeof(settings.key))&&memchr(settings.domain,0,sizeof(settings.domain))
    &&memchr(settings.subdomain,0,sizeof(settings.subdomain))&&memchr(settings.ca,0,sizeof(settings.ca));
}
const char FORM[] PROGMEM=R"HTML(<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PrivateTunnel Device setup</title><style>body{font:16px system-ui;max-width:36rem;margin:2rem auto;padding:1rem}label{display:block;margin:1rem 0}input,textarea,button{box-sizing:border-box;width:100%;padding:.7rem}small{display:block}</style><h1>PrivateTunnel Device</h1><p>Save once. This board reconnects when powered on. Use an ESP device key from your server's admin Settings.</p><form method="post" action="/save"><label>Wi-Fi SSID<input name="ssid" maxlength="32" required></label><label>Wi-Fi password<input name="password" type="password" maxlength="64"></label><label>Server hostname<input name="host" placeholder="admin.example.com" maxlength="253" required></label><label>WebSocket path<input name="path" value="/_private-tunnel/ws" maxlength="191" required></label><label>Device connection key<input name="key" type="password" maxlength="84" required></label><label>Publish domain<input name="domain" placeholder="apps.example.com" maxlength="253"></label><label>Subdomain<input name="subdomain" maxlength="63"></label><label>Trusted root CA certificate (PEM)<textarea name="ca" rows="10" maxlength="2047" required></textarea></label><small>The visitor password stays with the person accessing the public URL. It is not saved on this board. Settings use unencrypted EEPROM storage. Saving replaces this firmware's previous settings.</small><button>Save and restart</button></form></html>)HTML";
bool copyField(const char* name,char* target,size_t size) {
  String value=setupServer->arg(name);
  if(value.length()>=size)return false;
  memcpy(target,value.c_str(),value.length()+1);return true;
}
void startPortal() {
  portal=true;portalStarted=millis();WiFi.mode(WIFI_AP);
  char password[17];
#if defined(ESP8266)
  uint32_t first=ESP.random(),second=ESP.random();
#else
  uint32_t first=esp_random(),second=esp_random();
#endif
  snprintf(password,sizeof(password),"pt%06lx%06lx",static_cast<unsigned long>(first&0xffffff),static_cast<unsigned long>(second&0xffffff));
  if(!WiFi.softAP("PrivateTunnel-Setup",password)){Serial.println("Could not start setup Wi-Fi");return;}
  Serial.printf("Setup Wi-Fi: PrivateTunnel-Setup\nPassword: %s\nOpen http://192.168.4.1/ (expires in 5 minutes)\n",password);
  setupServer=new SetupServer(80);
  setupServer->on("/",HTTP_GET,[]{setupServer->sendHeader("Cache-Control","no-store");setupServer->send_P(200,"text/html",FORM);});
  setupServer->on("/save",HTTP_POST,[]{
    if(!copyField("ssid",settings.ssid,sizeof(settings.ssid))||!copyField("password",settings.password,sizeof(settings.password))
      ||!copyField("host",settings.host,sizeof(settings.host))||!copyField("path",settings.path,sizeof(settings.path))
      ||!copyField("key",settings.key,sizeof(settings.key))||!copyField("domain",settings.domain,sizeof(settings.domain))
      ||!copyField("subdomain",settings.subdomain,sizeof(settings.subdomain))||!copyField("ca",settings.ca,sizeof(settings.ca))
      ||!settings.ssid[0]||!settings.host[0]||strlen(settings.key)!=84||strncmp(settings.key,"ptk_",4)
      ||settings.path[0]!='/'||!strstr(settings.ca,"-----BEGIN CERTIFICATE-----")) {
      setupServer->send(400,"text/plain","Invalid or oversized settings. Go back and check each field.");return;
    }
    if(!EEPROM.begin(sizeof(Settings))){setupServer->send(500,"text/plain","Settings storage is unavailable.");return;}
    settings.magic=0x50544431;settings.checksum=checksum();EEPROM.put(0,settings);
    bool saved=EEPROM.commit();EEPROM.end();
    if(!saved){setupServer->send(500,"text/plain","Settings could not be saved. Retry setup.");return;}
    setupServer->sendHeader("Cache-Control","no-store");setupServer->send(200,"text/plain","Saved. Rebooting. Reconnect to your usual Wi-Fi and watch Serial for the public URL.");
    delay(700);ESP.restart();
  });
  setupServer->begin();
}
void setup() {
  Serial.begin(115200);pinMode(0,INPUT_PULLUP);delay(50);
  Serial.println("Press BOOT/FLASH now within 3 seconds to configure Wi-Fi (release during reset).");
  bool configure=false;uint32_t started=millis();
  while(millis()-started<3000){if(digitalRead(0)==LOW)configure=true;delay(10);}
  if(EEPROM.begin(sizeof(Settings))){EEPROM.get(0,settings);EEPROM.end();}
  if(configure||settings.magic!=0x50544431||settings.checksum!=checksum()||!terminated()) {startPortal();return;}
  WiFi.mode(WIFI_STA);WiFi.begin(settings.ssid,settings.password);
  configTime(0,0,"pool.ntp.org","time.cloudflare.com");
  snprintf(identity,sizeof(identity),"board-%s",WiFi.macAddress().c_str());
  connection.host=settings.host;connection.path=settings.path;connection.key=settings.key;
  connection.caCertificate=settings.ca;connection.clientId=identity;connection.domain=settings.domain;connection.subdomain=settings.subdomain;
  tunnel.onHttp("/status",[](const DeviceRequest& req,DeviceResponse& res){
    if(strcmp(req.method,"GET")&&strcmp(req.method,"HEAD")){res.json(405,"{\"error\":\"GET required\"}");return;}
    char body[96];snprintf(body,sizeof(body),"{\"online\":true,\"free_heap\":%u}",unsigned(ESP.getFreeHeap()));res.json(200,body);
  });
  if(!tunnel.begin(connection))Serial.println(tunnel.lastError());
  Serial.printf("Protocol object: %u bytes; saved settings: %u bytes\n",unsigned(sizeof(tunnel)),unsigned(sizeof(settings)));
}
void loop() {
  if(portal) {
    if(setupServer)setupServer->handleClient();
    if(millis()-portalStarted>300000){Serial.println("Setup expired. Reset to try again.");if(setupServer)setupServer->stop();WiFi.softAPdisconnect(true);portal=false;}
    delay(1);return;
  }
  tunnel.poll();
  static uint32_t report=0;
  if(millis()-report>10000){report=millis();Serial.println(tunnel.online()?tunnel.publicUrl():tunnel.lastError());}
}
