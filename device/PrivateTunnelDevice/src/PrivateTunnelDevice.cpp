#include "PrivateTunnelDevice.h"
#include <time.h>
#if defined(ESP8266)
#include <Hash.h>
#else
#include <mbedtls/sha1.h>
#include <esp_system.h>
#endif
using namespace ptdevice;
namespace {
uint32_t randomWord() {
#if defined(ESP32)
  return esp_random();
#else
  return ESP.random();
#endif
}
void base64(const uint8_t* in, size_t n, char* out) {
  const char* alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t at=0;
  for(size_t i=0;i<n;i+=3) {
    uint32_t v=uint32_t(in[i])<<16;
    if(i+1<n)v|=uint32_t(in[i+1])<<8;
    if(i+2<n)v|=in[i+2];
    out[at++]=alphabet[(v>>18)&63];out[at++]=alphabet[(v>>12)&63];
    out[at++]=i+1<n?alphabet[(v>>6)&63]:'=';out[at++]=i+2<n?alphabet[v&63]:'=';
  }
  out[at]=0;
}
bool printable(const char* s, size_t max, bool empty=false) {
  if(!s)return false;
  size_t n=strnlen(s,max+1);
  if(n>max || (!n&&!empty))return false;
  for(size_t i=0;i<n;++i)if(uint8_t(s[i])<33||uint8_t(s[i])>126)return false;
  return true;
}
}
bool PrivateTunnelDevice::onHttp(const char* path, Handler handler) {
  if(routeCount>=8 || !printable(path,192) || !handler)return false;
  routes[routeCount++]={path,handler};return true;
}
bool PrivateTunnelDevice::begin(const DeviceConfig& c) {
  stop();
  if(!printable(c.host,253)||!printable(c.path,191)||c.path[0]!='/'
    ||!printable(c.key,84)||strncmp(c.key,"ptk_",4)||strlen(c.key)!=84
    ||!printable(c.clientId,48)||!printable(c.domain,253,true)||!printable(c.subdomain,63,true)
    ||!c.caCertificate||!strstr(c.caCertificate,"-----BEGIN CERTIFICATE-----")||!c.port) {
    strlcpy(error,"Invalid device configuration or missing trusted CA",sizeof(error));return false;
  }
  config=c;
#if defined(ESP8266)
  trust.reset(new BearSSL::X509List(c.caCertificate));
  socket.setTrustAnchors(trust.get());
#else
  socket.setCACert(c.caCertificate);
  socket.setHandshakeTimeout(10);
#endif
  socket.setTimeout(5000);
  enabled=true;retryAt=millis();backoff=1000;error[0]=0;return true;
}
void PrivateTunnelDevice::stop() { enabled=false;socket.stop();connected=false;ready=false;resetStream(); }
void PrivateTunnelDevice::resetStream() {
  stream=0;request.bodyLength=0;responseBody=nullptr;responseLength=0;responseOffset=0;
  responding=false;requestEnded=false;txCredit=WINDOW;
}
void PrivateTunnelDevice::disconnect(const char* reason, bool terminal) {
  strlcpy(error,reason,sizeof(error));socket.stop();connected=false;ready=false;resetStream();
  rxUsed=rxLength=wsHeaderUsed=0;wsHeaderNeed=2;
  if(terminal)enabled=false;
  retryAt=millis()+backoff+(randomWord()%501);backoff=backoff<30000?backoff*2:60000;
}
bool PrivateTunnelDevice::connect() {
  if(!socket.connect(config.host,config.port)) { disconnect("TLS connection failed; check CA, clock, host and free heap");return false; }
  uint8_t nonce[16];for(size_t i=0;i<16;i+=4){uint32_t r=randomWord();memcpy(nonce+i,&r,4);}
  char key[25],accept[29],source[61];base64(nonce,16,key);
  snprintf(source,sizeof(source),"%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11",key);
  uint8_t hash[20];
#if defined(ESP8266)
  sha1(reinterpret_cast<const uint8_t*>(source),strlen(source),hash);
#else
  mbedtls_sha1(reinterpret_cast<const uint8_t*>(source),strlen(source),hash);
#endif
  base64(hash,20,accept);
  socket.print("GET ");socket.print(config.path);socket.print(" HTTP/1.1\r\nHost: ");socket.print(config.host);
  if(config.port!=443){socket.print(':');socket.print(config.port);}
  socket.print("\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ");socket.print(key);
  socket.print("\r\nSec-WebSocket-Protocol: ptunnel.device.v1\r\nAuthorization: Bearer ");socket.print(config.key);socket.print("\r\n\r\n");
  char line[512];size_t total=0;bool validAccept=false,protocol=false,upgrade=false,connection=false;
  uint32_t started=millis();
  for(unsigned count=0;count<32;++count) {
    size_t n=0;
    while(millis()-started<5000 && socket.connected()) {
      if(!socket.available()){delay(1);continue;}
      int ch=socket.read();if(ch<0)continue;
      if(ch=='\n')break;
      if(n+1>=sizeof(line)||++total>4096){disconnect("Oversized WebSocket handshake");return false;}
      line[n++]=char(ch);
    }
    if(millis()-started>=5000||!socket.connected()){disconnect("WebSocket handshake timed out");return false;}
    if(n&&line[n-1]=='\r')--n;
    line[n]=0;
    if(!count) {
      if(strcmp(line,"HTTP/1.1 101 Switching Protocols")) {
        bool auth=strstr(line," 401 ")||strstr(line," 403 ");
        disconnect(auth?"Device key rejected; reconfigure and restart":"WebSocket upgrade failed",auth);return false;
      }
    } else if(!n) {
      if(!validAccept||!protocol||!upgrade||!connection){disconnect("Invalid WebSocket upgrade response",true);return false;}
      connected=true;lastReceived=millis();rxUsed=rxLength=wsHeaderUsed=0;wsHeaderNeed=2;
      uint8_t p[410]={};p[0]=1;write16(p+1,FRAME);p[3]=1;write16(p+4,WINDOW);
#if defined(ESP8266)
      const char* board="esp8266";
#else
      const char* board="esp32";
#endif
      const char* fields[]={config.clientId,config.domain,config.subdomain,board};size_t at=10;
      for(size_t i=0;i<4;++i){size_t len=strlen(fields[i]);p[6+i]=len;memcpy(p+at,fields[i],len);at+=len;}
      return sendPacket(HELLO,0,p,at);
    } else {
      char* colon=strchr(line,':');if(!colon)continue;*colon++=0;while(*colon==' '||*colon=='\t')++colon;
      if(!strcasecmp(line,"Sec-WebSocket-Accept"))validAccept=!strcmp(colon,accept);
      if(!strcasecmp(line,"Sec-WebSocket-Protocol"))protocol=!strcmp(colon,"ptunnel.device.v1");
      if(!strcasecmp(line,"Upgrade"))upgrade=!strcasecmp(colon,"websocket");
      if(!strcasecmp(line,"Connection"))connection=!strcasecmp(colon,"Upgrade");
    }
  }
  disconnect("Too many WebSocket handshake headers");return false;
}
bool PrivateTunnelDevice::sendWebSocket(uint8_t opcode,const uint8_t* p,size_t n) {
  if(!connected||n>FRAME+8)return false;
  uint8_t out[FRAME+16];size_t at=0;out[at++]=0x80|opcode;
  if(n<126)out[at++]=0x80|n;else{out[at++]=0xfe;write16(out+at,n);at+=2;}
  uint32_t word=randomWord();uint8_t mask[4];memcpy(mask,&word,4);memcpy(out+at,mask,4);at+=4;
  for(size_t i=0;i<n;++i)out[at+i]=p[i]^mask[i%4];
  if(socket.write(out,at+n)!=at+n){disconnect("WebSocket send failed");return false;}return true;
}
bool PrivateTunnelDevice::sendPacket(Type type,uint16_t id,const uint8_t* data,size_t n) {
  if(n>FRAME)return false;
  header(tx,type,id,n);if(n)memcpy(tx+8,data,n);return sendWebSocket(2,tx,n+8);
}
void PrivateTunnelDevice::receivePacket(const uint8_t* p,size_t n) {
  if(!valid(p,n)){disconnect("Invalid device frame",true);return;}
  uint8_t type=p[0];uint16_t id=read16(p+2);p+=8;n-=8;
  if(!id) {
    if(type==READY&&!ready&&n>=9&&read16(p)==FRAME&&p[2]==1&&read16(p+3)==WINDOW
      &&read16(p+5)==BODY&&read16(p+7)==n-9&&n-9<sizeof(url)) {
      memcpy(url,p+9,n-9);url[n-9]=0;ready=true;backoff=1000;error[0]=0;return;
    }
    if(type==PING&&!n){sendPacket(PONG);return;}
    if(type==PONG&&!n)return;
    if(type==ERROR){disconnect("Tunnel rejected; check server device settings",true);return;}
    disconnect("Unexpected device connection frame",true);return;
  }
  if(!ready){disconnect("Device not ready",true);return;}
  if(type==OPEN) {
    if(stream||n<4||p[0]>8||read16(p+1)>192||p[3]>64||n!=size_t(4+p[0]+read16(p+1)+p[3])){
      disconnect("Invalid device request",true);return;
    }
    resetStream();stream=id;size_t at=4;
    memcpy(request.method,p+at,p[0]);request.method[p[0]]=0;at+=p[0];
    size_t len=read16(p+1);memcpy(request.path,p+at,len);request.path[len]=0;at+=len;
    memcpy(request.contentType,p+at,p[3]);request.contentType[p[3]]=0;return;
  }
  if(id!=stream)return; // frames already in flight after cancellation
  if(type==DATA&&!requestEnded&&n&&request.bodyLength+n<=BODY) {
    memcpy(request.body+request.bodyLength,p,n);request.bodyLength+=n;request.body[request.bodyLength]=0;
    uint8_t credit[2];write16(credit,n);sendPacket(CREDIT,id,credit,2);return;
  }
  if(type==END&&!requestEnded&&!n) {
    requestEnded=true;DeviceResponse response(*this);
    for(size_t i=0;i<routeCount;++i)if(!strcmp(request.path,routes[i].path)){routes[i].handler(request,response);break;}
    if(!responding)response.json(404,"{\"error\":\"route not found\"}");
    return;
  }
  if(type==CREDIT&&responding&&n==2&&read16(p)&&txCredit+read16(p)<=WINDOW){txCredit+=read16(p);return;}
  if(type==ptdevice::CANCEL&&!n){resetStream();return;}
  disconnect("Device stream limit or ordering violation",true);
}
bool PrivateTunnelDevice::respond(uint16_t status,const char* type,const uint8_t* data,size_t n,bool flash) {
  if(!stream||!requestEnded||responding||status<200||status>599||!type||strlen(type)>64
    ||(!flash&&n>sizeof(responseCopy))||(!data&&n))return false;
  uint8_t p[67];write16(p,status);p[2]=strlen(type);memcpy(p+3,type,p[2]);
  if(!sendPacket(RESPONSE,stream,p,3+p[2]))return false;
  if(!flash&&n){memcpy(responseCopy,data,n);data=responseCopy;}
  responseBody=data;responseLength=n;responseOffset=0;responseFlash=flash;responding=true;return true;
}
bool DeviceResponse::json(uint16_t s,const char* body){return body&&owner.respond(s,"application/json",reinterpret_cast<const uint8_t*>(body),strlen(body),false);}
bool DeviceResponse::text(uint16_t s,const char* body){return body&&owner.respond(s,"text/plain; charset=utf-8",reinterpret_cast<const uint8_t*>(body),strlen(body),false);}
bool DeviceResponse::send_P(uint16_t s,const char* type,PGM_P body,size_t n){return owner.respond(s,type,reinterpret_cast<const uint8_t*>(body),n,true);}
void PrivateTunnelDevice::poll() {
  if(!enabled)return;
  if(WiFi.status()!=WL_CONNECTED){if(connected)disconnect("Wi-Fi disconnected");return;}
  if(time(nullptr)<1700000000){strlcpy(error,"Waiting for a valid clock before TLS",sizeof(error));return;}
  if(!connected) { if(int32_t(millis()-retryAt)>=0)connect();return; }
  if(!socket.connected()){disconnect("Connection lost");return;}
  if(millis()-lastReceived>90000){disconnect("Server heartbeat timed out");return;}
  // Parse at most two bounded WebSocket frames per poll. No frame-sized malloc.
  for(unsigned frames=0;frames<2 && connected;++frames) {
    while(wsHeaderUsed<wsHeaderNeed&&socket.available())wsHeader[wsHeaderUsed++]=socket.read();
    if(wsHeaderUsed<wsHeaderNeed)break;
    if(wsHeaderNeed==2) {
      wsOpcode=wsHeader[0]&15;uint8_t size=wsHeader[1]&127;
      if(!(wsHeader[0]&0x80)||(wsHeader[0]&0x70)||(wsHeader[1]&0x80)||size==127
        ||(wsOpcode!=2&&wsOpcode!=8&&wsOpcode!=9&&wsOpcode!=10)
        ||(wsOpcode>=8&&size>=126)){disconnect("Unsupported WebSocket frame",true);return;}
      if(size==126){wsHeaderNeed=4;--frames;continue;}
      rxLength=size;
    } else rxLength=read16(wsHeader+2);
    if(rxLength>sizeof(rx)){disconnect("WebSocket frame exceeds device limit",true);return;}
    while(rxUsed<rxLength&&socket.available()){
      int count=socket.read(rx+rxUsed,rxLength-rxUsed);if(count<=0)break;rxUsed+=count;
    }
    if(rxUsed<rxLength)break;
    lastReceived=millis();
    if(wsOpcode==8) {
      uint16_t code=rxLength>=2?read16(rx):1000;
      disconnect(code==4001?"Device key revoked or rotated":"Server closed connection",code==4001||code==1008||code==1002);return;
    }
    if(wsOpcode==9)sendWebSocket(10,rx,rxLength);
    if(wsOpcode==2)receivePacket(rx,rxLength);
    wsHeaderUsed=rxUsed=rxLength=0;wsHeaderNeed=2;
  }
  if(connected&&responding) {
    size_t n=responseLength-responseOffset;if(n>txCredit)n=txCredit;if(n>FRAME)n=FRAME;
    if(n) {
      if(responseFlash)memcpy_P(tx+8,responseBody+responseOffset,n);else memcpy(tx+8,responseBody+responseOffset,n);
      header(tx,DATA,stream,n);
      if(!sendWebSocket(2,tx,n+8))return;
      txCredit-=n;responseOffset+=n;
    }
    if(responseOffset==responseLength){sendPacket(END,stream);resetStream();}
  }
  yield();
}
