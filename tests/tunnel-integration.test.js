const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const TunnelClient = require('../client/tunnel-client');
const { WebSocket } = require('ws');

test('actual gateway/client forward HTTP and OS-assigned TCP, reject unauthorized upgrades and revoke connections', {timeout:20000}, async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ptunnel-integration-'));
  const reservations=await Promise.all([0,1,2].map(async()=>{
    const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');return server;
  }));
  const [wsPort,dashboardPort,proxyPort]=reservations.map((server)=>server.address().port);
  await Promise.all(reservations.map((server)=>new Promise((resolve)=>server.close(resolve))));
  const child=spawn(process.execPath,[path.join(__dirname,'../server/index.js')],{cwd:path.join(__dirname,'..'),windowsHide:true,
    env:{...process.env,DB_PROVIDER:'sqlite',DB_SYNC_TARGETS:'',DB_BOOTSTRAP_SYNC:'false',DATA_DIR:directory,SQLITE_PATH:path.join(directory,'test.db'),
      WS_PORT:String(wsPort),DASHBOARD_PORT:String(dashboardPort),PROXY_PORT:String(proxyPort),INTERNAL_HOST:'127.0.0.1',PRIMARY_DOMAIN:'127.0.0.1',
      TUNNEL_DOMAIN:'apps.example.net',TUNNEL_TOKEN:'integration-only-secret-at-least-32-characters',DASHBOARD_PASSWORD:'integration-only-password',AUTO_FIREWALL:'false',
      ALLOW_LEGACY_QUERY_TOKEN:'false',ALLOW_UNAUTHENTICATED_TUNNELS:'false'}});
  let output='';child.stdout.on('data',(data)=>output+=data);child.stderr.on('data',(data)=>output+=data);
  let client;
  const tcpClients=[];
  const tcpSockets=new Set();
  let tcpLocal;
  const local=http.createServer((req,res)=>{let body='';req.on('data',(chunk)=>body+=chunk);req.on('end',()=>{res.setHeader('X-Integration','yes');res.end(req.method+' '+req.url+' '+body);});});
  t.after(async()=>{
    for(const tunnel of tcpClients)tunnel.disconnect();
    for(const socket of tcpSockets)socket.destroy();
    if(tcpLocal?.listening)await new Promise((resolve)=>tcpLocal.close(resolve));
    client?.disconnect();await new Promise((resolve)=>local.close(resolve));
    child.kill();if(child.exitCode===null)await once(child,'exit');
    fs.rmSync(directory,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Gateway startup timed out: '+output)),10000);
    const check=()=>{if(output.includes('All services started successfully')){clearTimeout(timer);resolve();}};
    child.stdout.on('data',check);child.once('exit',(code)=>{clearTimeout(timer);reject(new Error('Gateway exited '+code+': '+output));});check();
  });
  async function rawReject(port,route,status,ip){
    const socket=net.connect(port,'127.0.0.1');await once(socket,'connect');
    let text='';socket.on('data',(chunk)=>text+=chunk);
    const closed=once(socket,'close');
    socket.write(`GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${ip ? `X-Real-IP: ${ip}\r\n` : ''}Authorization: Bearer wrong\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    await Promise.race([closed,new Promise((_,reject)=>{const timer=setTimeout(()=>{socket.destroy();reject(new Error('Rejected socket was retained'));},2000);timer.unref();})]);
    assert.match(text,new RegExp('HTTP/1.1 '+status));
  }
  await rawReject(wsPort,'/_private-tunnel/ws',401);
  await rawReject(dashboardPort,'/_private-tunnel/admin/live',403);
  // Model the documented loopback proxy identity headers. Both tunnel routes share one bucket.
  for(let i=0;i<60;i++) {
    await rawReject(wsPort,i%2?'/_private-tunnel/ws':'/ws',401,'203.0.113.20');
    await rawReject(dashboardPort,'/_private-tunnel/admin/live',403,'203.0.113.20');
  }
  await rawReject(wsPort,'/_private-tunnel/ws',429,'203.0.113.20');
  await rawReject(wsPort,'/ws',429,'203.0.113.20');
  await rawReject(dashboardPort,'/_private-tunnel/admin/live',429,'203.0.113.20');
  await rawReject(wsPort,'/_private-tunnel/ws',401,'203.0.113.21');
  await new Promise((resolve)=>local.listen(0,'127.0.0.1',resolve));
  const publicUrl=await new Promise((resolve,reject)=>{
    client=new TunnelClient({serverUrl:`ws://127.0.0.1:${wsPort}`,token:'integration-only-secret-at-least-32-characters',localHost:'127.0.0.1',localPort:local.address().port,
      clientId:'10000000-0000-4000-8000-000000000001',tunnelType:'http',onConnected:({url})=>resolve(url),onError:reject});client.connect();
  });
  const result=await new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:proxyPort,path:'/hello?secret=not-in-logs',method:'POST',headers:{host:new URL(publicUrl).hostname}},(res)=>{
      let body='';res.on('data',(chunk)=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end('payload');
  });
  assert.equal(result.status,200);assert.equal(result.headers['x-integration'],'yes');
  assert.equal(result.body,'POST /hello?secret=not-in-logs payload');
  tcpLocal=net.createServer((socket)=>{
    tcpSockets.add(socket);
    socket.on('close',()=>tcpSockets.delete(socket));
    socket.on('error',()=>socket.destroy());
    socket.on('data',(chunk)=>socket.write(chunk));
  });
  await new Promise((resolve)=>tcpLocal.listen(0,'127.0.0.1',resolve));
  const tcpAssignments=await Promise.all([2,3].map((suffix)=>new Promise((resolve,reject)=>{
    const tunnel=new TunnelClient({serverUrl:`ws://127.0.0.1:${wsPort}`,token:'integration-only-secret-at-least-32-characters',localHost:'127.0.0.1',localPort:tcpLocal.address().port,
      clientId:`10000000-0000-4000-8000-00000000000${suffix}`,tunnelType:'tcp',onConnected:resolve,onError:reject});
    tcpClients.push(tunnel);
    tunnel.connect();
  })));
  const tcpPorts=tcpAssignments.map(({url})=>Number(new URL('tcp://'+url).port));
  assert.ok(tcpPorts.every((port)=>Number.isInteger(port)&&port>0&&port<=65535));
  assert.equal(new Set(tcpPorts).size,2,'Concurrent listeners keep distinct OS-assigned ports bound');
  const payload=Buffer.from([0,1,2,127,128,254,255,65,66,67]);
  await Promise.all(tcpPorts.map(async(port)=>{
    const visitor=net.connect(port,'127.0.0.1');
    tcpSockets.add(visitor);
    visitor.on('close',()=>tcpSockets.delete(visitor));
    await once(visitor,'connect');
    const echoed=new Promise((resolve,reject)=>{
      const chunks=[];let size=0;
      visitor.once('error',reject);
      visitor.setTimeout(3000,()=>visitor.destroy(new Error('TCP echo timed out')));
      visitor.on('data',(chunk)=>{chunks.push(chunk);size+=chunk.length;if(size>=payload.length)resolve(Buffer.concat(chunks));});
    });
    visitor.write(payload);
    assert.deepEqual(await echoed,payload,'Assigned public port forwards binary TCP bytes');
    visitor.destroy();
  }));
  async function adminRequest(route, body, cookie) {
    return new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:dashboardPort,path:route,method:'POST',headers:{host:`127.0.0.1:${dashboardPort}`,origin:`http://127.0.0.1:${dashboardPort}`,
        'content-type':cookie?'application/json':'application/x-www-form-urlencoded','x-real-ip':'203.0.113.20',...(cookie?{cookie}:{})}},(res)=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));});
      req.on('error',reject);req.end(body);
    });
  }
  const signedIn=await adminRequest('/_private-tunnel/admin/login','password=integration-only-password');
  assert.equal(signedIn.status,302);
  const live=new WebSocket(`ws://127.0.0.1:${dashboardPort}/_private-tunnel/admin/live`,{headers:{
    origin:`http://127.0.0.1:${dashboardPort}`,cookie:signedIn.headers['set-cookie'][0].split(';')[0]}});
  await once(live,'open');
  const liveClosed=once(live,'close');live.close();await liveClosed;
  const disconnected=once(client.ws,'close');
  const tcpDisconnected=tcpClients.map((tunnel)=>once(tunnel.ws,'close'));
  const rotated=await adminRequest('/_private-tunnel/admin/api/settings',JSON.stringify({tunnelToken:'rotated-integration-only-secret-at-least-32-characters'}),signedIn.headers['set-cookie'][0].split(';')[0]);
  assert.equal(rotated.status,200);
  assert.equal((await disconnected)[0],4001);
  assert.equal(client.shouldReconnect,false,'rotated access keys revoke existing tunnel connections');
  for(const [index,closed] of (await Promise.all(tcpDisconnected)).entries()){
    assert.equal(closed[0],4001);
    assert.equal(tcpClients[index].shouldReconnect,false,'Key rotation also revokes TCP tunnels');
  }
  for(const port of tcpPorts){
    const deadline=Date.now()+2000;
    let released=false;
    while(!released&&Date.now()<deadline){
      released=await new Promise((resolve)=>{
        const probe=net.connect(port,'127.0.0.1');
        probe.once('connect',()=>{probe.destroy();resolve(false);});
        probe.once('error',(error)=>{probe.destroy();resolve(error.code==='ECONNREFUSED');});
      });
      if(!released)await new Promise((resolve)=>setTimeout(resolve,20));
    }
    assert.equal(released,true,'Revoking the tunnel releases its actual public listener');
  }
});
