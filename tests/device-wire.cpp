#include "../device/PrivateTunnelDevice/src/DeviceProtocol.h"
#include <cassert>
#include <cstring>
int main() {
  uint8_t bytes[10];ptdevice::header(bytes,ptdevice::CREDIT,0x1234,2);ptdevice::write16(bytes+8,512);
  const uint8_t golden[]={6,0,0x12,0x34,0,2,0,0,2,0};
  assert(!memcmp(bytes,golden,sizeof(bytes)));assert(ptdevice::valid(bytes,sizeof(bytes)));
  for(size_t n=0;n<8;++n)assert(!ptdevice::valid(bytes,n));
  bytes[1]=1;assert(!ptdevice::valid(bytes,sizeof(bytes)));bytes[1]=0;
  bytes[7]=1;assert(!ptdevice::valid(bytes,sizeof(bytes)));bytes[7]=0;
  assert(!ptdevice::valid(bytes,9));
  uint8_t maximum[520]={};ptdevice::header(maximum,ptdevice::DATA,1,512);
  assert(ptdevice::valid(maximum,sizeof(maximum)));
  for(unsigned n=0;n<=65535;++n){ptdevice::write16(bytes,uint16_t(n));assert(ptdevice::read16(bytes)==n);}
}
