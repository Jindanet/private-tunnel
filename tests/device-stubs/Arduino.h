#pragma once
// Host-only Arduino/core doubles. They do not implement or test TLS security.
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <vector>
#define PROGMEM
using PGM_P=const char*;
#define memcpy_P memcpy
inline uint32_t fakeMillis=1;
inline uint32_t millis(){return fakeMillis;}
inline void delay(uint32_t n){fakeMillis+=n;}
inline void yield(){}
inline size_t strlcpy(char* out,const char* in,size_t size){size_t n=strlen(in);if(size){memcpy(out,in,std::min(n,size-1));out[std::min(n,size-1)]=0;}return n;}
