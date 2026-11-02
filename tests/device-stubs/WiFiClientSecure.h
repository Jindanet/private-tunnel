#pragma once
#include <Arduino.h>
inline struct FakeNetwork {
  bool connected=false,failConnect=false,failWrite=false;
  std::deque<uint8_t> input;
  std::vector<std::vector<uint8_t>> output;
  std::string handshake;
  const char* ca=nullptr;
  void feed(const std::vector<uint8_t>& data){for(auto byte:data)input.push_back(byte);}
} network;
class WiFiClientSecure {
 public:
  void setCACert(const char* ca){network.ca=ca;}
  void setHandshakeTimeout(unsigned){}
  void setTimeout(unsigned){}
  bool connect(const char*,uint16_t){network.connected=!network.failConnect;return network.connected;}
  bool connected(){return network.connected;}
  void stop(){network.connected=false;}
  int available(){return int(network.input.size());}
  int read(){if(network.input.empty())return -1;auto value=network.input.front();network.input.pop_front();return value;}
  int read(uint8_t* target,size_t n){size_t count=std::min(n,network.input.size());for(size_t i=0;i<count;++i)target[i]=read();return int(count);}
  void print(const char* text){network.handshake+=text;}
  void print(char ch){network.handshake+=ch;}
  void print(uint16_t n){network.handshake+=std::to_string(n);}
  size_t write(const uint8_t* p,size_t n){if(network.failWrite)return 0;network.output.emplace_back(p,p+n);return n;}
};
