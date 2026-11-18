'use strict';

// Render the actual CLI frame using example data, on CI only. This does not
// create a tunnel, read credentials or launch the production desktop app.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const TunnelUI = require('../../client/ui');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ptunnel-terminal-preview-'));
app.setPath('userData',directory);app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed',()=>{}); // Capture the second size before explicitly quitting.
const escape=(text)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function html(line){
  const colors={31:'#e74856',32:'#16c60c',33:'#f9f1a5',36:'#3a96dd',37:'#cccccc'};
  let result='',at=0;
  for(const match of line.matchAll(/\x1b\[([\d;]+)m/g)){
    result+=escape(line.slice(at,match.index));
    const codes=match[1].split(';');
    result+='</span><span style="color:'+(colors[codes.at(-1)]||'#cccccc')+';font-weight:'+(codes.includes('1')?'700':'400')+'">';
    at=match.index+match[0].length;
  }
  return '<span>'+result+escape(line.slice(at))+'</span>';
}
(async()=>{
  await app.whenReady();fs.mkdirSync(process.env.PT_TERMINAL_CAPTURE_DIR,{recursive:true});
  for(const columns of [120,70]){
    const output=new EventEmitter();Object.assign(output,{isTTY:true,columns,rows:24,write(){}});
    const ui=new TunnelUI({output,lifecycle:new EventEmitter(),env:{},localTarget:'localhost:80'});
    ui.setConnected('https://demo.example.test','localhost:80','http');
    for(const [method,route,statusCode,latency] of [['GET','/',200,12],['GET','/api/status',200,3],['POST','/api/settings',204,24],['GET','/missing',404,2]])ui.addRequest({method,path:route,statusCode,latency});
    await new Promise((resolve)=>setImmediate(resolve));
    const content=ui.frame().map(html).join('\n');
    const win=new BrowserWindow({width:Math.ceil(columns*8.5)+32,height:24*22+32,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#0c0c0c;color:#ccc}pre{margin:0;font:14px/22px "Noto Sans Mono",Consolas,monospace;white-space:pre}</style><pre>'+content+'</pre>'));
    await win.webContents.executeJavaScript('document.fonts.ready');
    const image=await win.webContents.capturePage();
    fs.writeFileSync(path.join(process.env.PT_TERMINAL_CAPTURE_DIR,columns===120?'terminal-dashboard.png':'terminal-compact.png'),image.toPNG());
    ui.stop();win.destroy();
  }
  app.quit();
})().catch((error)=>{console.error(error);app.exit(1);});
