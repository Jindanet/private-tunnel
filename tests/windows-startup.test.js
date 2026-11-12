'use strict';

// Real service lifecycle coverage belongs on disposable GitHub Windows runners.
// Local test runs never register a task, change ACLs or elevate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { createStartupManager } = require('../client/startup');
const { MSG } = require('../shared/protocol');
const execute = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve,ms));
const ps = (value) => "'" + String(value).replaceAll("'","''") + "'";
const powershell = (command) => execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:45000});
async function waitFor(predicate) {
  const end=Date.now()+25000;
  while(!predicate()){if(Date.now()>end)throw new Error('Windows worker state timed out');await delay(100);}
}

test('Windows startup stop kills orphan workers, rejects retries and recovers partial uninstall',{
  skip:process.platform!=='win32'||process.env.CI!=='true',timeout:150000,
},async(t)=>{
  const directory=path.join(process.env.ProgramData,'PrivateTunnel-ci-'+crypto.randomUUID());
  fs.mkdirSync(directory);
  const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await once(gateway,'listening');
  let connections=0,orphan,foreign,info;
  gateway.on('connection',(socket)=>{
    connections++;
    socket.on('message',(data,binary)=>{
      if(!binary&&JSON.parse(data).type===MSG.TUNNEL_OPEN)socket.send(JSON.stringify({type:MSG.TUNNEL_ASSIGNED,tunnelType:'tcp',url:'example.test:30000',dataTransportVersion:4}));
    });
  });
  const sid=(await powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')).stdout.trim();
  const boot=createStartupManager({configPath:path.join(directory,'user.json'),systemRoot:path.join(directory,'startup'),
    bundlePath:path.resolve(__dirname,'../ptunnel.js'),env:process.env,user:{sid},
    run:async(_command,args)=>{
      const script=/ -File "([^"]+install\.ps1)"/.exec(args.at(-1))?.[1];assert.ok(script);
      await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:45000});
    }});
  t.after(async()=>{
    for(const child of [orphan,foreign])if(child&&child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
    if(info)await powershell(`Stop-ScheduledTask -TaskName ${ps(info.job)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${ps(info.job)} -Confirm:$false -ErrorAction SilentlyContinue`);
    for(const socket of gateway.clients)socket.terminate();await new Promise((resolve)=>gateway.close(resolve));
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),path.resolve(process.env.ProgramData));
    assert.ok(path.basename(resolved).startsWith('PrivateTunnel-ci-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  info=await boot.enable({serverUrl:`ws://127.0.0.1:${gateway.address().port}`,token:'ci-only-key-at-least-thirty-two-characters',clientId:crypto.randomUUID(),tunnelType:'tcp',localPort:9});
  await waitFor(()=>boot.status()[0].status==='online');
  assert.equal(connections,1);
  await boot.control(info.id,'stop');
  assert.equal(gateway.clients.size,0,'Stop acknowledges a closed tunnel, not just a stopped wrapper');
  assert.equal(boot.status()[0].status,'stopped');
  await powershell(`Start-ScheduledTask -TaskName ${ps(info.job)}`);
  await delay(6000); // Simulate a queued OS retry without an explicit user Start.
  assert.equal(connections,1,'A retry cannot undo Stop in the same boot');
  assert.equal(boot.status()[0].status,'stopped','Old online heartbeats cannot reappear');
  await boot.control(info.id,'start');
  await waitFor(()=>connections===2&&boot.status()[0].status==='online');
  await boot.control(info.id,'stop');

  // An old/stuck worker ignores cooperative stop. The exact profile argument
  // identifies it even if its PowerShell parent is already gone.
  const stubborn=path.join(directory,'stubborn.cjs');
  fs.writeFileSync(stubborn,`const fs=require('node:fs'),path=require('node:path');const profile=JSON.parse(fs.readFileSync(process.argv.at(-1)));fs.writeFileSync(path.join(profile.stateDir,'status.json'),JSON.stringify({status:'online',pid:process.pid,updatedAt:new Date().toISOString()}));setInterval(()=>{},1000);`);
  orphan=spawn(process.execPath,[stubborn,'startup','run','--profile',info.profilePath],{windowsHide:true,stdio:'ignore'});
  await waitFor(()=>JSON.parse(fs.readFileSync(info.statusPath)).pid===orphan.pid);
  const orphanExit=once(orphan,'exit');
  await boot.control(info.id,'stop');await orphanExit;
  assert.equal(boot.status()[0].status,'stopped');

  // A different process holds the copied runtime open. It must survive Stop;
  // removal still clears the installed job, profile and manifest with a warning.
  foreign=spawn(info.executable,['-e','setInterval(()=>{},1000)','--','startup','run','--profile',info.profilePath+'.other'],{windowsHide:true,stdio:'ignore'});
  await once(foreign,'spawn');await delay(500);
  fs.unlinkSync(info.profilePath); // Recover the partial state reported in GUI.
  const removed=await boot.control(info.id,'remove');
  assert.equal(foreign.exitCode,null);assert.equal(foreign.signalCode,null);
  assert.equal(removed.cleanupPending,true);
  assert.equal(boot.status().length,0);
  const task=await powershell(`@(Get-ScheduledTask -TaskName ${ps(info.job)} -ErrorAction SilentlyContinue).Count`);
  assert.equal(task.stdout.trim(),'0');
});
