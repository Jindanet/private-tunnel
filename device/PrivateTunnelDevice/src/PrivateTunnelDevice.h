#pragma once
#include <Arduino.h>
#include <memory>
#if defined(ESP8266)
#include <ESP8266WiFi.h>
#include <WiFiClientSecureBearSSL.h>
#elif defined(ESP32)
#include <WiFi.h>
#include <WiFiClientSecure.h>
#else
#error PrivateTunnelDevice requires an ESP32 or ESP8266 Arduino core
#endif
#include "DeviceProtocol.h"

struct DeviceConfig {
  const char* host=nullptr;
  uint16_t port=443;
  const char* path="/_private-tunnel/ws";
  const char* key=nullptr;
  const char* caCertificate=nullptr;
  const char* clientId="device";
  const char* domain="";
  const char* subdomain="";
};
struct DeviceRequest {
  char method[9]={}, path[193]={}, contentType[65]={};
  uint8_t body[ptdevice::BODY+1]={};
  size_t bodyLength=0;
};
class PrivateTunnelDevice;
class DeviceResponse {
 public:
  // Copies small responses; flash responses must remain valid until sent.
  bool json(uint16_t status, const char* body);
  bool text(uint16_t status, const char* body);
  bool send_P(uint16_t status, const char* contentType, PGM_P body, size_t length);
 private:
  friend class PrivateTunnelDevice;
  explicit DeviceResponse(PrivateTunnelDevice& owner): owner(owner) {}
  PrivateTunnelDevice& owner;
};
class PrivateTunnelDevice {
 public:
  using Handler=void (*)(const DeviceRequest&, DeviceResponse&);
  bool onHttp(const char* path, Handler handler);
  // Config strings must outlive this object. Wi-Fi and time are initialized by
  // the sketch. begin never enables insecure TLS or shrinks TLS record buffers.
  bool begin(const DeviceConfig& config);
  void poll();
  void stop();
  bool online() const { return ready; }
  const char* publicUrl() const { return url; }
  const char* lastError() const { return error; }
 private:
  friend class DeviceResponse;
#if defined(ESP8266)
  BearSSL::WiFiClientSecure socket;
  std::unique_ptr<BearSSL::X509List> trust;
#else
  WiFiClientSecure socket;
#endif
  DeviceConfig config;
  struct Route { const char* path; Handler handler; } routes[8]={};
  uint8_t routeCount=0;
  DeviceRequest request;
  uint8_t rx[ptdevice::FRAME+8]={}, tx[ptdevice::FRAME+8]={};
  size_t rxUsed=0, rxLength=0;
  uint8_t wsHeader[4]={};
  uint8_t wsHeaderUsed=0, wsHeaderNeed=2, wsOpcode=0;
  uint16_t stream=0, txCredit=0;
  uint8_t responseCopy[512]={};
  const uint8_t* responseBody=nullptr;
  size_t responseLength=0, responseOffset=0;
  bool responseFlash=false, responding=false, requestEnded=false;
  bool enabled=false, connected=false, ready=false;
  uint32_t retryAt=0, backoff=1000, lastReceived=0;
  char url[385]={}, error[96]={};
  bool connect();
  void disconnect(const char* reason, bool terminal=false);
  bool sendPacket(ptdevice::Type type, uint16_t id=0, const uint8_t* data=nullptr, size_t length=0);
  bool sendWebSocket(uint8_t opcode, const uint8_t* data, size_t length);
  void receivePacket(const uint8_t* data, size_t length);
  bool respond(uint16_t status, const char* type, const uint8_t* data, size_t length, bool flash);
  void resetStream();
};
