#pragma once
constexpr int WL_CONNECTED=3;
inline struct FakeWiFi { int state=WL_CONNECTED;int status(){return state;} } WiFi;
