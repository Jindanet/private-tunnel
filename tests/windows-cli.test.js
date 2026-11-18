'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('CMD runs Node from the source folder and the isolated npm link instead of Windows Script Host',{
  skip:process.platform!=='win32',timeout:45000,
},(t)=>{
  const root=path.resolve(__dirname,'..');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ptunnel-cmd-'));
  const source=path.join(directory,'source folder & spaces'),prefix=path.join(directory,'npm-global');
  const linked=path.join(prefix,'node_modules','privatetunnel');
  t.after(()=>{
    if(fs.existsSync(linked))fs.unlinkSync(linked); // Remove the junction, never traverse into the checkout.
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('ptunnel-cmd-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  fs.mkdirSync(source);fs.mkdirSync(prefix);
  for(const file of ['ptunnel.js','ptunnel.cmd','ptn.cmd'])fs.copyFileSync(path.join(root,file),path.join(source,file));
  const config=path.join(directory,'never-created.json');
  const env={...process.env,PATH:prefix+path.delimiter+process.env.PATH,PTUNNEL_CONFIG_PATH:config,
    NPM_CONFIG_PREFIX:prefix,NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',NO_COLOR:'1'};
  const run=(command,cwd=source)=>spawnSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{
    cwd,env,windowsHide:true,encoding:'utf8',timeout:25000,
  });
  const resolution=run('where.exe ptunnel');
  assert.equal(resolution.status,0,resolution.stderr);
  assert.equal(fs.realpathSync.native(resolution.stdout.trim().split(/\r?\n/)[0]).toLowerCase(),fs.realpathSync.native(path.join(source,'ptunnel.cmd')).toLowerCase());
  const version=require('../package.json').version;
  for(const command of ['ptunnel --version','ptunnel.cmd --version','ptn --version','ptn.cmd --version']){
    const result=run(command);assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),version);
  }
  const bad=run('ptunnel --unknown-option');assert.equal(bad.status,1);assert.match(bad.stderr,/Unknown option/);
  const install=run('npm.cmd link --offline --ignore-scripts --no-audit --no-fund',root);
  assert.equal(install.status,0,install.stdout+install.stderr);
  for(const name of ['ptunnel','ptn']){
    const global=run(`${name} --version`,directory);assert.equal(global.status,0,global.stdout+global.stderr);assert.equal(global.stdout.trim(),version);
  }
  const help=run('ptunnel --help',root);assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/http 3000/);
  const shortHelp=run('ptn --help',directory);assert.equal(shortHelp.status,0,shortHelp.stderr);assert.match(shortHelp.stdout,/ptn http 80/);
  assert.equal(fs.existsSync(config),false,'Command lookup checks do not save or connect a user profile');
});
