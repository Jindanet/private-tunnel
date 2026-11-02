#pragma once
#include <stddef.h>
#include <stdint.h>
namespace ptdevice {
enum Type : uint8_t { HELLO=1, READY=2, OPEN=3, DATA=4, END=5, CREDIT=6,
  CANCEL=7, ERROR=8, PING=9, PONG=10, RESPONSE=11 };
constexpr size_t FRAME=512, WINDOW=512, BODY=1024;
inline uint16_t read16(const uint8_t* p) { return (uint16_t(p[0])<<8)|p[1]; }
inline void write16(uint8_t* p, uint16_t n) { p[0]=uint8_t(n>>8); p[1]=uint8_t(n); }
inline bool valid(const uint8_t* p, size_t n) {
  return n>=8 && n<=FRAME+8 && p[0]>=HELLO && p[0]<=RESPONSE && p[1]==0
    && read16(p+4)==n-8 && read16(p+6)==0;
}
inline size_t header(uint8_t* p, Type type, uint16_t stream, uint16_t length) {
  p[0]=type; p[1]=0; write16(p+2,stream); write16(p+4,length); write16(p+6,0); return 8;
}
}
