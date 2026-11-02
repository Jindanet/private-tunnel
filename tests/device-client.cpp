#include "../device/PrivateTunnelDevice/src/PrivateTunnelDevice.h"
#include <cassert>
using namespace ptdevice;
std::vector<uint8_t> envelope(Type type,uint16_t id,std::vector<uint8_t> data={}) {
  std::vector<uint8_t> result(data.size()+8);header(result.data(),type,id,data.size());
  std::copy(data.begin(),data.end(),result.begin()+8);return result;
}
std::vector<uint8_t> websocket(std::vector<uint8_t> p,uint8_t opcode=2) {
  std::vector<uint8_t> frame={uint8_t(0x80|opcode)};
  if(p.size()<126)frame.push_back(p.size());else{frame.push_back(126);frame.push_back(p.size()>>8);frame.push_back(p.size()&255);}
  frame.insert(frame.end(),p.begin(),p.end());return frame;
}
std::vector<uint8_t> unmask(const std::vector<uint8_t>& f) {
  size_t at=(f[1]&127)==126?4:2;size_t n=f.size()-at-4;std::vector<uint8_t> p(n);
  assert(f[1]&128);for(size_t i=0;i<n;++i)p[i]=f[at+4+i]^f[at+i%4];return p;
}
int calls=0;
void route(const DeviceRequest& req,DeviceResponse& res) {
  ++calls;assert(!strcmp(req.method,"POST"));assert(!strcmp(req.path,"/echo"));
  assert(req.bodyLength==1024);for(auto p:req.body) { (void)p; }
  for(size_t i=0;i<req.bodyLength;++i)assert(req.body[i]=='a');
  static const char body[1024]={};assert(res.send_P(200,"application/octet-stream",body,sizeof(body)));
  assert(!res.text(200,"cannot respond twice"));
}
DeviceConfig settings() {
  DeviceConfig c;c.host="admin.example.test";c.key="ptk_00000000-0000-0000-0000-000000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  c.caCertificate="-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";return c;
}
void handshake(PrivateTunnelDevice& device) {
  const std::string reply="HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\nSec-WebSocket-Protocol: ptunnel.device.v1\r\n\r\n";
  network.feed(std::vector<uint8_t>(reply.begin(),reply.end()));device.poll();
  assert(network.ca);assert(network.handshake.find("Authorization: Bearer ptk_")!=std::string::npos);
  auto hello=unmask(network.output.back());assert(valid(hello.data(),hello.size()));assert(hello[0]==HELLO);
  std::vector<uint8_t> ready={2,0,1,2,0,4,0,0,0};network.feed(websocket(envelope(READY,0,ready)));device.poll();assert(device.online());
}
int main() {
  PrivateTunnelDevice device;assert(device.onHttp("/echo",route));assert(device.begin(settings()));handshake(device);
  std::vector<uint8_t> open={4,0,5,16};const std::string metadata="POST/echoapplication/json";open.insert(open.end(),metadata.begin(),metadata.end());
  auto frame=websocket(envelope(OPEN,1,open));
  // Exercise an extended WebSocket header and payload received one byte at a time.
  for(auto byte:frame){network.feed({byte});device.poll();}
  for(unsigned part=0;part<2;++part){auto upload=websocket(envelope(DATA,1,std::vector<uint8_t>(512,'a')));for(auto byte:upload){network.feed({byte});device.poll();}}
  network.feed(websocket(envelope(END,1)));device.poll();assert(calls==1);
  assert(unmask(network.output.back())[0]==DATA);
  const size_t sent=network.output.size();device.poll();assert(network.output.size()==sent); // no credit, no second DATA
  network.feed(websocket(envelope(CREDIT,1,{2,0})));device.poll();assert(unmask(network.output.back())[0]==END);
  network.feed(websocket(envelope(OPEN,2,open)));device.poll();
  network.feed(websocket(envelope(ptdevice::CANCEL,2)));device.poll();
  network.feed(websocket(envelope(END,2)));device.poll();assert(calls==1);
  network.feed(websocket({0x0f,0xa1},8));device.poll();assert(!device.online()); // close 4001 stops retries
  fakeMillis+=100000;const size_t old=network.output.size();device.poll();assert(network.output.size()==old);
  assert(device.begin(settings()));network.input.clear();network.handshake.clear();handshake(device);
  // Reject announced 521-byte payload before allocating or reading it.
  network.feed({0x82,126,2,9});device.poll();assert(!device.online());
  assert(strstr(device.lastError(),"limit"));
  assert(device.begin(settings()));network.input.clear();network.handshake.clear();handshake(device);
  network.feed({0x02,0});device.poll();assert(!device.online()); // fragmented message
  assert(device.begin(settings()));network.input.clear();network.handshake.clear();handshake(device);
  fakeMillis+=90001;device.poll();assert(!device.online());assert(strstr(device.lastError(),"heartbeat"));
}
