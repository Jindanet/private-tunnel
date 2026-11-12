const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

async function loadMain({available=true,startup=null}={}) {
  const root = path.resolve(__dirname,'..');
  const filename = path.join(root,'app/main.js');
  const realRequire = createRequire(filename);
  const handlers = new Map();
  const external = [];
  const writes = [];
  const events = [], polls = [];
  let window;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options=options; window=this;
      const contents=new EventEmitter(); contents.mainFrame={url:''};
      contents.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){}};
      contents.setWindowOpenHandler=(fn)=>{contents.popup=fn;};
      contents.send=(channel,payload)=>events.push({channel,payload});this.webContents=contents;
    }
    loadFile(file) {this.webContents.mainFrame.url=pathToFileURL(file).href;}
    show(){} focus(){}
  }
  class FakeTray {setToolTip(){}setContextMenu(){}on(){}}
  let ready=false;
  const app = new EventEmitter();app.whenReady=()=>Promise.resolve().then(()=>{ready=true;});app.isReady=()=>ready;
  const electron={app,BrowserWindow:FakeWindow,nativeTheme:{themeSource:'system'},ipcMain:{handle:(channel,fn)=>handlers.set(channel,fn)},
    shell:{openExternal:async(url)=>external.push(url)},clipboard:{writeText(){}},Tray:FakeTray,
    Menu:{buildFromTemplate:()=>[]},nativeImage:{createFromBuffer:()=>({})},
    safeStorage:{isEncryptionAvailable:()=>{assert.equal(ready,true);return available;},getSelectedStorageBackend:()=> 'gnome_libsecret',
      encryptString:(value)=>Buffer.from('test-ciphertext:'+value),decryptString:(value)=>value.toString().slice('test-ciphertext:'.length)}};
  const fakeFs={readFileSync:()=>{assert.equal(ready,true);return JSON.stringify({serverUrl:'wss://admin.example.com',token:'dummy-test-key',tunnels:[]});},
    mkdirSync(){},writeFileSync:(...args)=>{assert.equal(ready,true);writes.push(args);},chmodSync(){},renameSync(){},
    unlinkSync(){throw Object.assign(new Error('No temporary file'),{code:'ENOENT'});}};
  const isolatedProcess={...process,env:{USERPROFILE:path.join(root,'tests','fake-home'),PTUNNEL_CONFIG_PATH:path.join(root,'tests','fake-home','desktop.json')}};
  const context={require:(name)=>name==='electron'?electron:name==='node:fs'?fakeFs:name==='../client/startup'&&startup?{createStartupManager:()=>startup}:realRequire(name),
    __dirname:path.dirname(filename),process:isolatedProcess,console,Buffer,URL,
    setTimeout:(callback,delay)=>{if(delay===3000){polls.push(callback);return {unref(){}};}return setTimeout(callback,delay);},
    clearTimeout,module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
  assert.equal(writes.length,0,'No credentials are rewritten before Electron is ready');
  await new Promise((resolve)=>setImmediate(resolve));
  const trusted={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  return {handlers,trusted,window,writes,external,events,poll:()=>polls.at(-1)()};
}

test('actual main IPC rejects untrusted documents and validates privileged actions', async () => {
  const {handlers,trusted,window,writes,external}=await loadMain();
  for(const handler of handlers.values()) assert.throws(()=>handler({sender:{},senderFrame:{url:trusted.senderFrame.url}}),/Untrusted/);
  const config=handlers.get('get-config')(trusted);assert.equal(config.token,'dummy-test-key');
  const originalUrl=trusted.senderFrame.url;trusted.senderFrame.url='https://evil.example.com';
  assert.throws(()=>handlers.get('get-config')(trusted),/Untrusted/);trusted.senderFrame.url=originalUrl;
  for(const url of ['file:///C:/probe','javascript:alert(1)','https://u:p@example.com']) {
    assert.equal(await handlers.get('open-external')(trusted,url),false);
  }
  assert.equal(external.length,0);
  assert.equal(await handlers.get('open-external')(trusted,'https://demo.example.com'),true);
  assert.deepEqual(external,['https://demo.example.com/']);
  assert.throws(()=>handlers.get('add-tunnel')(trusted,{type:'http',port:'70000junk'}),/valid local port/);
  const clientId='00000000-0000-4000-8000-000000000001';
  const tunnel=handlers.get('add-tunnel')(trusted,{type:'http',port:3000,clientId});
  assert.equal(tunnel.port,3000);assert.equal(tunnel.clientId,clientId);
  handlers.get('delete-tunnel')(trusted,tunnel.id);
  const remote={serverUrl:'ws://remote.example.com',token:'test-key-never-send'};
  const beforeInvalid=writes.length;
  for(const channel of ['validate-server-profile','test-server-profile','save-server-profile']){
    const result=await handlers.get(channel)(trusted,remote);assert.equal(result.ok,false);assert.match(result.errors.serverUrl,/wss:\/\//);
  }
  assert.equal(writes.length,beforeInvalid);
  assert.equal(handlers.get('save-server-profile')(trusted,{serverUrl:'ws://localhost:9000',token:'replacement-test-key'}).ok,true);
  assert.equal(handlers.get('get-config')(trusted).token,'replacement-test-key');
  assert.equal(handlers.get('get-config')(trusted).credential,undefined);
  for(const [,content] of writes){const disk=JSON.parse(content);assert.equal(disk.token,undefined);assert.equal(disk.credential.version,1);
    assert.equal(content.includes('dummy-test-key'),false);assert.equal(content.includes('replacement-test-key'),false);}
  assert.equal(writes.at(-1)[2].mode,0o600);
  assert.equal(window.options.webPreferences.sandbox,true);
  assert.equal(window.webContents.popup().action,'deny');
  let prevented=false;window.webContents.emit('will-navigate',{preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
});

test('desktop startup IPC uses the headless service, preserves profiles on failure and removes jobs before deleting', async () => {
  const entries = [], calls = [];
  let rejected = false;
  const startup = {
    status: () => entries,
    async enable(profile) {
      if (rejected) throw new Error('Administrator approval cancelled');
      calls.push({ action: 'enable', profile });
      entries.push({ id: 'service-id', clientId: profile.clientId, installed: true, status: 'online', url: 'example.com:30000' });
      return { note: 'Starts before sign-in' };
    },
    async control(id, action) { calls.push({ id, action }); if (action === 'remove') entries.length = 0; },
  };
  const {handlers, trusted} = await loadMain({startup});
  const tunnel = handlers.get('add-tunnel')(trusted, {type:'tcp',port:22});
  rejected = true;
  assert.match((await handlers.get('set-tunnel-startup')(trusted,{id:tunnel.id,enabled:true})).error,/cancelled/);
  assert.equal(handlers.get('get-config')(trusted).tunnels[0].startup,false);
  rejected = false;
  assert.equal((await handlers.get('set-tunnel-startup')(trusted,{id:tunnel.id,enabled:true})).ok,true);
  assert.equal(calls[0].profile.localPort,22);
  assert.equal(calls[0].profile.clientId,tunnel.clientId);
  const saved = handlers.get('get-config')(trusted).tunnels[0];
  assert.equal(saved.startup,true);assert.equal(saved.startupState.status,'online');
  assert.equal((await handlers.get('start-tunnel')(trusted,tunnel.id)).ok,true);
  await handlers.get('stop-tunnel')(trusted,tunnel.id);
  assert.deepEqual(calls.slice(-2).map((item)=>item.action),['start','stop']);
  await handlers.get('delete-tunnel')(trusted,tunnel.id);
  assert.equal(calls.at(-1).action,'remove');
  assert.equal(handlers.get('get-config')(trusted).tunnels.length,0);
});

test('actual main IPC preserves non-secret settings while unavailable storage clears the access key', async () => {
  const {handlers,trusted,writes}=await loadMain({available:false});
  const getConfig=()=>handlers.get('get-config')(trusted);
  assert.equal(getConfig().token,null);
  assert.match(getConfig().credentialStorageError,/Unlock.*restart.*re-enter/);
  for(const channel of ['validate-server-profile','test-server-profile','save-server-profile']){
    const result=await handlers.get(channel)(trusted,{serverUrl:'wss://admin.example.com',token:'test-key-never-store'});
    assert.equal(result.ok,false);assert.match(result.errors.token,/not saved/);
  }
  const tunnel=handlers.get('add-tunnel')(trusted,{type:'http',port:3000});
  assert.match((await handlers.get('start-tunnel')(trusted,tunnel.id)).error,/Save the server profile/);
  handlers.get('delete-tunnel')(trusted,tunnel.id);
  assert.equal(getConfig().token,null);
  assert.match(getConfig().credentialStorageError,/not saved/);
  for(const [,content] of writes){const disk=JSON.parse(content);assert.equal(disk.token,undefined);assert.equal(disk.credential,undefined);}
});

test('desktop polling cannot restore online status while a boot worker Stop is pending',async()=>{
  const entries=[];
  let finish;
  const startup={status:()=>entries,control:()=>new Promise((resolve)=>{finish=()=>{entries[0].status='stopped';resolve({ok:true});};})};
  const {handlers,trusted,events,poll}=await loadMain({startup});
  const tunnel=handlers.get('add-tunnel')(trusted,{type:'tcp',port:3389});
  entries.push({id:'service-id',clientId:tunnel.clientId,installed:true,status:'online',url:'example.test:30000'});
  const stopping=handlers.get('stop-tunnel')(trusted,tunnel.id);
  poll();
  assert.equal(events.filter((event)=>event.channel==='tunnel-status').length,0,'No stale heartbeat during Stop');
  const overlapping=await handlers.get('start-tunnel')(trusted,tunnel.id);
  assert.match(overlapping.error,/already in progress/);
  finish();assert.equal(await stopping,true);poll();
  assert.ok(events.filter((event)=>event.channel==='tunnel-status').every((event)=>event.payload.status==='stopped'));
});
