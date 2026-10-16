const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {spawn}=require('node:child_process');

test('production Electron entry point and preload enforce real IPC and local service checks',{timeout:45000},async(t)=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const args=[...(process.platform==='linux'&&process.env.CI==='true'?['--no-sandbox']:[]),path.join(__dirname,'fixtures/electron-main.cjs')];
  const child=spawn(require('electron'),args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let output='';child.stdout.on('data',(chunk)=>output+=chunk);child.stderr.on('data',(chunk)=>output+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  assert.equal(code,0,output);
});
