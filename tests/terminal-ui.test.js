'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { stripVTControlCharacters } = require('node:util');
const TunnelUI = require('../client/ui');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function terminal({ columns = 120, rows = 24, tty = true, plain = false, env = {} } = {}) {
  const output = new EventEmitter(), lifecycle = new EventEmitter();
  Object.assign(output, { columns, rows, isTTY: tty, writes: [], write(text) { this.writes.push(text); return true; } });
  const ui = new TunnelUI({ output, lifecycle, plain, env, localTarget: 'localhost:80' });
  return { ui, output, lifecycle, last: () => stripVTControlCharacters(output.writes.at(-1)) };
}

test('interactive consoles restore the dashboard, batch request bursts and release the cursor',async(t)=>{
  const f=terminal();t.after(()=>f.ui.stop());
  f.ui.init();
  assert.match(f.output.writes[0],/\x1b\[\?25l/);
  assert.match(f.last(),/Private Tunnel.*Ctrl\+C/);
  assert.match(f.last(),/METHOD\s+PATH\s+STATUS\s+TIME/);
  f.ui.setConnected('https://demo.example.test','localhost:80','http');
  assert.match(f.last(),/Forwarding:.*https:\/\/demo.example.test.*localhost:80/);
  const before=f.output.writes.length;
  for(let i=0;i<2000;i++)f.ui.addRequest({method:'GET',path:'/request/'+i,statusCode:200,latency:12});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(f.output.writes.length,before+1,'A burst produces one redraw');
  assert.equal(f.ui.requests.length,50,'History stays bounded');
  assert.match(f.last(),/Connections:\s+2000/);assert.match(f.last(),/\/request\/1999/);
  assert.ok(!f.last().includes('/request/0 '));
  assert.ok(f.ui.physicalRows(f.ui.frame())<f.output.rows,'The frame leaves room for the shell cursor');
  f.ui.setError('Invalid access key','Run node ptunnel.js setup');
  assert.match(f.last(),/Invalid access key/);assert.match(f.last(),/node ptunnel\.js setup/);
  f.ui.stop();
  assert.match(f.output.writes.at(-1),/\x1b\[\?25h/);
  assert.equal(f.output.listenerCount('resize'),0);assert.equal(f.lifecycle.listenerCount('exit'),0);
  const stopped=f.output.writes.join('');f.ui.addRequest({path:'/late'});f.ui.setConnected('https://late.test','localhost:80','http');f.ui.stop();
  assert.equal(f.output.writes.join(''),stopped,'Late callbacks cannot redraw a stopped UI');
});

test('plain output, redirected streams and narrow terminals keep complete addresses without cursor controls',()=>{
  for(const options of [{plain:true},{tty:false},{columns:40},{rows:8},{env:{TERM:'dumb'}}]){
    const f=terminal({...options,env:{NO_COLOR:'1',...options.env}});
    const address='https://'+'a'.repeat(110)+'.example.test';
    f.ui.init();f.ui.setConnected(address,'localhost:80','http');f.ui.stop();
    const text=f.output.writes.join('');
    assert.ok(text.includes(address));assert.ok(!text.includes('\x1b'));
    assert.match(text,/ONLINE/);assert.match(text,/Stopped/);
  }
});

test('resize preserves a long address and remote terminal escapes never reach the console',async(t)=>{
  const f=terminal({columns:80,rows:30});t.after(()=>f.ui.stop());
  const address='https://'+'a'.repeat(100)+'.example.test';
  f.ui.init();f.ui.setConnected(address,'localhost:80','http\x1b[2J');
  assert.ok(f.last().includes(address),'Long dashboard addresses are not truncated');
  f.ui.addRequest({method:'GET\x1b[2J',path:'/ภาษาไทย/你好/🙂/'+'界'.repeat(100)+'\x1b]52;c;payload\x07',statusCode:200});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.ok(!f.output.writes.join('').includes('\x1b[2J'));
  assert.ok(!f.output.writes.join('').includes('\x1b]52'));
  assert.match(f.last(),/\/ภาษาไทย\/你好\/🙂\//);
  f.output.columns=40;f.output.emit('resize');
  assert.ok(f.output.writes.join('').includes('\x1b[?25h'));
  assert.ok(f.output.writes.slice(-4).join('').includes(address));
  f.output.columns=100;f.output.emit('resize');
  assert.match(f.last(),/METHOD\s+PATH\s+STATUS/);
  f.lifecycle.emit('exit');assert.match(f.output.writes.at(-1),/\x1b\[\?25h/);
});

test('capture terminal previews on the disposable CI display',{
  skip:!process.env.PT_TERMINAL_CAPTURE_DIR,timeout:25000,
},async()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),['--no-sandbox',path.join(__dirname,'fixtures/terminal-preview.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',(data)=>output+=data);child.stderr.on('data',(data)=>output+=data);
  const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  assert.equal(result,0,output);
  for(const name of ['terminal-dashboard.png','terminal-compact.png']){
    assert.ok(fs.statSync(path.join(process.env.PT_TERMINAL_CAPTURE_DIR,name)).size>500,`${name} was captured`);
  }
});
