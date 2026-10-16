const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { app, BrowserWindow } = require('electron');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ptunnel-real-main-'));
process.env.PTUNNEL_CONFIG_PATH=path.join(directory,'profile.json');
app.setPath('userData',path.join(directory,'electron'));
app.commandLine.appendSwitch('disable-gpu');
if(process.platform==='linux'&&process.env.CI==='true')app.commandLine.appendSwitch('no-sandbox');
// Exercise the production entry point without showing a test window or changing the user's profile.
BrowserWindow.prototype.show=function(){};
BrowserWindow.prototype.focus=function(){};
require('../../app/main');

(async()=>{
  await app.whenReady();
  const win=BrowserWindow.getAllWindows()[0];
  if(win.webContents.isLoading())await once(win.webContents,'did-finish-load');
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise((resolve)=>probe.close(resolve));
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const config=await window.api.getConfig();
    const blocked=await window.api.openExternal('file:///C:/test-only-never-open');
    const profile=await window.api.saveServerProfile({serverUrl:'ws://localhost:9000',token:'test-only-key'});
    const tunnel=await window.api.addTunnel({type:'http',port:${port},name:'Isolated smoke test'});
    const started=await window.api.startTunnel(tunnel.id);
    await window.api.deleteTunnel(tunnel.id);
    return {configPath:config.configPath,blocked,profile,started,title:document.title};
  })()`);
  assert.equal(result.configPath,process.env.PTUNNEL_CONFIG_PATH);
  assert.equal(result.blocked,false);assert.equal(result.profile.ok,true);
  assert.match(result.started.error,/Your local app is not running/);
  assert.match(result.title,/PrivateTunnel/);
  console.log('Production Electron entry/preload/IPC/local-port checks passed.');
  app.quit();
})().catch((error)=>{console.error(error);app.exit(1);});
