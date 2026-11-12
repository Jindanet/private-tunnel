'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { createStartupManager, validateProfile, writePrivate } = require('../client/startup');
const { runStartup } = require('../client/startup-runner');
const { WebSocketServer } = require('ws');
const v4 = require('../shared/tunnel-v4');
const crypto = require('node:crypto');
const BUNDLE = path.resolve(__dirname, '../ptunnel.js');
const TOKEN = 'startup-test-only-secret-at-least-32-characters';
const PROFILE = { serverUrl: 'wss://admin.example.com', token: TOKEN, clientId: 'startup-test-identity',
  localHost: '127.0.0.1', localPort: 22, tunnelType: 'tcp', publishMode: 'subdomain' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-startup-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ptunnel-startup-test-'));
    fs.rmSync(directory,{recursive:true,force:true});
  });
  return directory;
}

function manager(directory, platform, extra = {}) {
  return createStartupManager({ configPath:path.join(directory,'user.json'), platform,
    home:directory, systemRoot:path.join(directory,'installed'), bundlePath:BUNDLE,
    user:{username:'test user',uid:1000,gid:1000,sid:'S-1-5-21-123-456-1000'}, env:{}, ...extra });
}

function stagedDirectory(args) {
  const script = args.find((value) => value.endsWith('install.sh')) || / -File "([^"]+install\.ps1)"/.exec(args.at(-1))?.[1];
  assert.ok(script, 'Installer must identify its staging script');
  return path.dirname(script);
}

test('boot definitions use pre-login providers and never include credentials', async (t) => {
  for (const platform of ['win32','darwin','linux','android']) {
    const directory = fixture(t);
    const boot = manager(directory,platform);
    const preview = await boot.enable(PROFILE,{dryRun:true});
    const definition = boot.definition(preview);
    const install = boot.installer(preview,'install',directory);
    assert.ok(!JSON.stringify(preview).includes(TOKEN));
    assert.ok(!definition.includes(TOKEN));assert.ok(!install.includes(TOKEN));
    assert.ok(!fs.existsSync(boot.manifestPath),'Preview has no installation side effects');
    assert.equal((await boot.enable({...PROFILE,localPort:80},{dryRun:true})).id,preview.id,'A saved client identity has one service');
    if (platform==='win32') {
      assert.match(install,/New-ScheduledTaskTrigger -AtStartup/);
      assert.match(install,/S-1-5-19/);assert.ok(!install.includes("-UserId 'SYSTEM'"));
      assert.match(install,/SetAccessRuleProtection\(\$true/);
      assert.match(install,/SetOwner/);assert.match(install,/-WindowStyle Hidden/);
    } else if (platform==='darwin') {
      assert.match(preview.definition,/LaunchDaemons/);assert.match(definition,/<key>UserName<\/key><string>test user/);
      assert.match(definition,/<key>RunAtLoad<\/key><true/);
    } else if (platform==='linux') {
      assert.match(definition,/WantedBy=multi-user.target/);assert.match(definition,/User=1000/);
      assert.match(definition,/After=network-online.target/);assert.match(definition,/NoNewPrivileges=true/);
    } else { assert.match(preview.definition,/\.termux\/boot/);assert.match(preview.note,/Termux:Boot/); }
  }
});

test('generated installers escape hostile path characters and parse without executing', async (t) => {
  const directory = fixture(t);
  const hostileRuntime = "C:\\Tools\\Node's $folder\\node.exe";
  const boot = manager(directory,'win32',{runtime:hostileRuntime});
  const info = await boot.enable(PROFILE,{dryRun:true});
  const script = boot.installer(info,'install',directory);
  assert.ok(script.includes("Node''s $folder"));
  const powershell = process.platform==='win32'?'powershell.exe':null;
  if (powershell) {
    const command = '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object ToString; exit 1}';
    for (const content of [script,boot.definition(info),...['remove','start','stop'].map((action)=>boot.installer(info,action,directory))]) {
      const result = spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',command],{input:content,encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stdout+result.stderr);
    }
    const acl = script.slice(script.indexOf('$acl = New-Object'),script.indexOf('Set-Acl -LiteralPath $dir'));
    const probe = spawnSync(powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $ownerSid='S-1-5-21-123-456-1000'; "+acl],{encoding:'utf8',windowsHide:true});
    assert.equal(probe.status,0,probe.stdout+probe.stderr);
  }
  const bash = process.platform==='win32'?'C:\\Program Files\\Git\\bin\\bash.exe':'/bin/sh';
  if (fs.existsSync(bash)) {
    for (const platform of ['darwin','linux','android']) {
      const provider = manager(directory,platform,{runtime:"/opt/node's path/$(false)/node"});
      const preview = await provider.enable(PROFILE,{dryRun:true});
      for (const action of ['install','remove','start','stop']) {
        const result=spawnSync(bash,['-n'],{input:provider.installer(preview,action,directory),encoding:'utf8',windowsHide:true});
        assert.equal(result.status,0,result.stderr);
      }
    }
  }
});

test('installation confirms elevation, saves only metadata and retains recoverability after cancellation', async (t) => {
  const directory=fixture(t);
  let approved=false, calls=0, stagedProfile;
  const boot=manager(directory,process.platform,{run:async(_command,args)=>{
    calls++;
    if(!approved)throw new Error('Authorization cancelled');
    // Inspect the staged files without executing any machine registration.
    const stage=stagedDirectory(args);
    stagedProfile=JSON.parse(fs.readFileSync(path.join(stage,'profile.json'),'utf8'));
    assert.equal(fs.readFileSync(path.join(stage,'runner'),'utf8'),fs.readFileSync(BUNDLE,'utf8'),'Packaged JS is extracted before privileged OS copying');
    assert.equal(stagedProfile.profile.token,TOKEN);
    assert.ok(!JSON.stringify(args).includes(TOKEN));
    fs.writeFileSync(path.join(stage,'success'),'ok');
  }});
  await assert.rejects(boot.enable(PROFILE),/cancelled/);
  assert.ok(!fs.existsSync(boot.manifestPath));
  approved=true;
  const first=await boot.enable(PROFILE);
  await boot.enable({...PROFILE,localPort:8080});
  assert.equal(boot.status().length,1);
  assert.equal(boot.status()[0].localPort,8080);
  assert.ok(!fs.readFileSync(boot.manifestPath,'utf8').includes(TOKEN));
  assert.equal(stagedProfile.profile.clientId,PROFILE.clientId);
  assert.ok(calls>=3);
  // Control actions deliberately use a different mock to avoid machine changes.
  const controls=manager(directory,process.platform,{run:async(_command,args)=>{
    fs.writeFileSync(path.join(stagedDirectory(args),'success'),'ok');
  }});
  await controls.control(first.id,'remove');assert.equal(controls.status().length,0);
});

test('missing installer receipt and invalid profiles cannot claim successful boot installation', async (t) => {
  const directory=fixture(t);
  const boot=manager(directory,process.platform,{run:async()=>''});
  await assert.rejects(boot.enable(PROFILE),/not confirmed/);
  assert.ok(!fs.existsSync(boot.manifestPath));
  for(const bad of [{token:'short'},{localPort:0},{tunnelType:'udp'},{serverUrl:'ws://remote.example.com'},{clientId:''}])assert.throws(()=>validateProfile({...PROFILE,...bad}));
});

test('Linux desktop jobs use the persistent AppImage in Node mode with no FUSE requirement', async (t) => {
  const directory=fixture(t);
  const boot=manager(directory,'linux',{electronNode:true,runtime:'/opt/PrivateTunnel.AppImage',env:{APPIMAGE:'/opt/PrivateTunnel.AppImage'}});
  const preview=await boot.enable(PROFILE,{dryRun:true});
  const definition=boot.definition(preview);
  assert.match(definition,/ExecStart="\/opt\/PrivateTunnel.AppImage"/);
  assert.match(definition,/Environment=ELECTRON_RUN_AS_NODE=1/);
  assert.match(definition,/Environment=APPIMAGE_EXTRACT_AND_RUN=1/);
});

test('Windows desktop services use their protected runtime copy and bounded uninstall path', async (t) => {
  const directory=fixture(t);
  const boot=manager(directory,'win32',{electronNode:true,runtime:'C:\\Users\\test\\Apps\\PrivateTunnel.exe'});
  const preview=await boot.enable(PROFILE,{dryRun:true});
  assert.ok(preview.executable.startsWith(preview.directory));assert.ok(preview.executable.includes('runtime'));
  const script=boot.installer(preview,'install',directory);
  assert.match(script,/\$ownedFiles/);assert.match(script,/fileAcl.SetOwner/);
  assert.match(script,/ReparsePoint/);
  const uninstall=boot.installer(preview,'remove',directory);
  assert.ok(uninstall.indexOf('StartsWith($serviceRoot')<uninstall.indexOf('Remove-Item -LiteralPath $runtimeRoot -Recurse'));
  if(process.platform==='win32') {
    const command='$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | ForEach-Object ToString; exit 1}';
    for(const content of [script,uninstall]) {
      const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{input:content,encoding:'utf8',windowsHide:true});
      assert.equal(result.status,0,result.stdout+result.stderr);
    }
  }
});

test('standalone CLI previews startup without touching machine settings or printing the access key', (t) => {
  const directory=fixture(t), configPath=path.join(directory,'user.json');
  const config={...PROFILE,clientId:'base-client-id',lastTunnel:PROFILE};
  writePrivate(configPath,JSON.stringify(config));
  const env={...process.env,PTUNNEL_CONFIG_PATH:configPath};
  const run=(args)=>spawnSync(process.execPath,[BUNDLE,...args],{env,cwd:directory,encoding:'utf8',windowsHide:true});
  for(const args of [['tcp','22','--startup','--dry-run'],['startup','install','--dry-run'],['startup','status']]){
    const result=run(args);assert.equal(result.status,0,result.stderr);assert.ok(!result.stdout.includes(TOKEN));
  }
  assert.ok(!fs.existsSync(configPath+'.startup.json'));
  assert.equal(run(['tcp','22','--dry-run']).status,1);
});

test('fatal authentication errors stop the worker, retain a visible error and redact its key', (t) => {
  const directory=fixture(t), stateDir=path.join(directory,'state'), filename=path.join(directory,'service.json');
  writePrivate(filename,JSON.stringify({version:1,profile:PROFILE,stateDir}));
  class RejectedClient {
    constructor(options){this.options=options;this.shouldReconnect=true;}
    connect(){this.options.onError(Object.assign(new Error('Rejected '+TOKEN),{code:'EUNAUTHORIZED'}));}
    disconnect(){this.shouldReconnect=false;}
  }
  const worker=runStartup(filename,{Client:RejectedClient});
  assert.equal(worker.state.status,'error');assert.ok(!worker.state.error.includes(TOKEN));
  assert.ok(!fs.existsSync(path.join(stateDir,'runner.lock')));
  assert.ok(!fs.readFileSync(path.join(stateDir,'service.log'),'utf8').includes(TOKEN));
});

test('a PID reused by another process cannot block the tunnel after a crash or reboot', (t) => {
  const directory=fixture(t), stateDir=path.join(directory,'state'), filename=path.join(directory,'service.json');
  writePrivate(filename,JSON.stringify({version:1,profile:PROFILE,stateDir}));
  writePrivate(path.join(stateDir,'runner.lock'),JSON.stringify({pid:process.pid,bootedAt:Date.now()-os.uptime()*1000}));
  class IdleClient { constructor(){this.shouldReconnect=true;}connect(){}disconnect(){} }
  const worker=runStartup(filename,{Client:IdleClient});
  assert.ok(worker,'Foreign process PID is not an active startup worker');
  worker.stop();
});

test('a stopped boot worker cannot reconnect on a task retry, but resumes on a new boot', (t) => {
  const directory=fixture(t),stateDir=path.join(directory,'state'),filename=path.join(directory,'service.json');
  writePrivate(filename,JSON.stringify({version:1,profile:PROFILE,stateDir}));
  const pausePath=path.join(stateDir,'paused.json');
  writePrivate(pausePath,JSON.stringify({bootId:'boot-one'}));
  let connections=0;
  class Client { connect(){connections++;} disconnect(){} }
  assert.equal(runStartup(filename,{Client,bootId:()=> 'boot-one'}),null);
  assert.equal(connections,0);
  assert.ok(fs.existsSync(pausePath),'A retry must not consume the pause');
  assert.equal(runStartup(filename,{Client,bootId:()=> 'boot-one'}),null);
  writePrivate(path.join(stateDir,'stop'),'');
  const worker=runStartup(filename,{Client,bootId:()=> 'boot-two'});
  assert.equal(connections,1);
  assert.ok(!fs.existsSync(pausePath));assert.ok(!fs.existsSync(path.join(stateDir,'stop')));
  worker.stop();
});

test('runtime cleanup warnings do not retain a removed startup job, even with missing profile files',async(t)=>{
  const directory=fixture(t);
  const boot=manager(directory,process.platform,{run:async(_command,args)=>{
    fs.writeFileSync(path.join(stagedDirectory(args),'success'),'ok');
  }});
  const info=await boot.enable(PROFILE);
  assert.equal(boot.status()[0].installed,false);
  const removing=manager(directory,process.platform,{run:async(_command,args)=>{
    const stage=stagedDirectory(args);
    fs.writeFileSync(path.join(stage,'cleanup-pending'),'runtime');
    fs.writeFileSync(path.join(stage,'success'),'ok');
  }});
  assert.deepEqual(await removing.control(info.id,'remove'),{ok:true,cleanupPending:true});
  assert.equal(removing.status().length,0);
});

async function deadline(promise) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Boot runner timed out')),8000);})]);}
  finally{clearTimeout(timer);}
}

test('headless boot runner forwards TCP independently of GUI/profile, prevents duplicates and stops cleanly', {timeout:20000}, async(t)=>{
  const directory=fixture(t), stateDir=path.join(directory,'state'), profilePath=path.join(directory,'service.json');
  const gateway=new WebSocketServer({host:'127.0.0.1',port:0});await once(gateway,'listening');
  const local=net.createServer((socket)=>{socket.on('error',()=>{});socket.pipe(socket);});
  local.listen(0,'127.0.0.1');await once(local,'listening');
  const profile={...PROFILE,localPort:local.address().port,serverUrl:`ws://127.0.0.1:${gateway.address().port}`};
  writePrivate(profilePath,JSON.stringify({version:1,profile,stateDir}));
  let peer,connections=0,child;
  const payload=crypto.randomBytes(150000), id=crypto.randomUUID(), chunks=[];
  const complete=new Promise((resolve,reject)=>{
    gateway.on('connection',(socket,request)=>{
      connections++;peer=socket;
      assert.equal(request.headers.authorization,`Bearer ${TOKEN}`);
      socket.on('message',(data,binary)=>{
        try{
          if(binary){const frame=v4.decodeDataFrame(data,socket);if(!frame)return;chunks.push(Buffer.from(frame.data));v4.discardFrame(socket,frame);if(Buffer.concat(chunks).length===payload.length)resolve(Buffer.concat(chunks));return;}
          const msg=JSON.parse(data);
          if(msg.type===v4.MSG.TUNNEL_OPEN){
            assert.equal(msg.clientId,PROFILE.clientId);assert.equal(msg.localPort,profile.localPort);
            v4.selectTransport(socket,4,{isServer:true});v4.sendControl(socket,{type:v4.MSG.TUNNEL_ASSIGNED,tunnelType:'tcp',dataTransportVersion:4,url:'example.com:30000'});
            v4.sendControl(socket,{type:v4.MSG.TCP_CONNECT,connId:id});v4.sendData(socket,v4.FRAME_TCP_DATA,id,payload);
          }else v4.receiveControl(socket,msg);
        }catch(error){reject(error);}
      });
    });
  });
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}
    for(const socket of gateway.clients)socket.terminate();
    await new Promise((resolve)=>gateway.close(resolve));await new Promise((resolve)=>local.close(resolve));
  });
  const args=[BUNDLE,'startup','run','--profile',profilePath];
  child=spawn(process.execPath,args,{env:{...process.env,PATH:'',PTUNNEL_CONFIG_PATH:path.join(directory,'missing-gui-profile.json')},cwd:directory,windowsHide:true});
  let output='';child.stdout.on('data',(data)=>{output+=data;});child.stderr.on('data',(data)=>{output+=data;});
  assert.deepEqual(await deadline(complete),payload);
  const status=JSON.parse(fs.readFileSync(path.join(stateDir,'status.json'),'utf8'));assert.equal(status.status,'online');
  assert.ok(!fs.readFileSync(path.join(stateDir,'service.log'),'utf8').includes(TOKEN));
  const oldLock=JSON.parse(fs.readFileSync(path.join(stateDir,'runner.lock'),'utf8'));oldLock.bootedAt=0;
  writePrivate(path.join(stateDir,'runner.lock'),JSON.stringify(oldLock));
  const duplicate=spawn(process.execPath,args,{windowsHide:true});assert.equal((await deadline(once(duplicate,'exit')))[0],0);assert.equal(connections,1);
  const exited=once(child,'exit');fs.writeFileSync(path.join(stateDir,'stop'),'');
  assert.equal((await deadline(exited))[0],0);assert.ok(!fs.existsSync(path.join(stateDir,'runner.lock')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir,'status.json'),'utf8')).status,'stopped');
  assert.ok(!output.includes(TOKEN));assert.ok(peer);
});
