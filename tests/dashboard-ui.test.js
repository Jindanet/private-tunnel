'use strict';

// Exercises the real dashboard over loopback with a temporary SQLite database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function browserRun() {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, nativeTheme } = require('electron');
  // The product stays dark even when the operating system requests a light theme.
  nativeTheme.themeSource = 'light';
  if (process.env.PT_ADMIN_USER_DATA) app.setPath('userData', process.env.PT_ADMIN_USER_DATA);
  if (process.platform === 'linux' && process.env.CI === 'true') app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-proxy-server');
  await app.whenReady();
  const win = new BrowserWindow({show:false,width:1280,height:960,useContentSize:true,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false,partition:'dashboard-ui-' + process.pid}});
  const failures = [];
  const errors = [];
  const evaluate = (fn) => win.webContents.executeJavaScript('(' + fn.toString() + ')()');
  const key = async (name, code) => {
    if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    const params={key:name,code:name===' '?'Space':name,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code};
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',text:name==='Enter'?'\r':name,unmodifiedText:name==='Enter'?'\r':name,...params});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...params});
  };
  const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
  const capture = async (name) => {
    if (!process.env.PT_ADMIN_CAPTURE_DIR) return;
    await pause();
    fs.mkdirSync(process.env.PT_ADMIN_CAPTURE_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.PT_ADMIN_CAPTURE_DIR,name), (await win.webContents.capturePage()).toPNG());
  };
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !String(message).includes('favicon')) errors.push(message);
  });
  try {
    const url = process.env.PT_DASHBOARD_PREVIEW_URL;
    await win.loadURL(url + '/_private-tunnel/admin/login');
    win.webContents.setZoomFactor(1);
    const login = await evaluate(() => ({
      title:document.title, label:document.querySelector('label[for="passwordInput"]')?.textContent,
      masked:document.getElementById('passwordInput').type === 'password',
      errors:document.getElementById('loginError').textContent,
      body:document.body.scrollWidth, viewport:innerWidth,
    }));
    assert.ok(login.title && login.label && login.masked, JSON.stringify(login));
    assert.ok(login.body <= login.viewport + 1);
    const theme = await evaluate(() => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      const luminance=(color)=>{context.fillStyle=color;context.fillRect(0,0,1,1);const rgb=[...context.getImageData(0,0,1,1).data].slice(0,3).map((value)=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
      const contrast=(a,b)=>{const aa=luminance(a),bb=luminance(b);return (Math.max(aa,bb)+.05)/(Math.min(aa,bb)+.05);};
      const body=getComputedStyle(document.body),button=getComputedStyle(document.getElementById('loginButton')),input=getComputedStyle(document.getElementById('passwordInput')),hint=getComputedStyle(document.getElementById('loginHint'));
      return {scheme:body.colorScheme,bodyLuminance:luminance(body.backgroundColor),bodyContrast:contrast(body.color,body.backgroundColor),hintContrast:contrast(hint.color,body.backgroundColor),actionContrast:contrast(button.color,button.backgroundColor),inputBorderContrast:contrast(input.borderTopColor,input.backgroundColor)};
    });
    assert.equal(theme.scheme,'dark');
    assert.ok(theme.bodyLuminance<.05,'Login stays dark with the system in light mode');
    assert.ok(theme.bodyContrast>=4.5 && theme.hintContrast>=4.5 && theme.actionContrast>=4.5,JSON.stringify(theme));
    assert.ok(theme.inputBorderContrast>=3,JSON.stringify(theme));
    await capture('admin-login-preview.png');
    const rejectedLogin = new Promise((resolve) => win.webContents.once('did-finish-load',resolve));
    await evaluate(() => {document.getElementById('passwordInput').value='wrong-dashboard-password';document.getElementById('loginButton').click();});
    await rejectedLogin;
    assert.equal(await evaluate(() => document.getElementById('loginError').textContent),'Invalid password');
    await capture('admin-login-error-preview.png');
    const loaded = new Promise((resolve) => win.webContents.once('did-finish-load',resolve));
    await evaluate(() => {
      document.getElementById('passwordInput').value = 'dashboard-ui-test-password';
      document.getElementById('loginButton').click();
    });
    await loaded;
    await pause(180);
    assert.equal(new URL(win.webContents.getURL()).pathname,'/_private-tunnel/admin');
    const state = await evaluate(() => ({
      steps:document.querySelectorAll('.setup-progress li').length,
      panels:document.querySelectorAll('.panel.active').length,
      tabs:[...document.querySelectorAll('.tab')].map((tab)=>tab.tagName),
      tokenType:document.getElementById('tunnel-token').type,
      advancedClosed:!document.getElementById('control-root').closest('details').open,
      initialized:document.getElementById('serverLabel').textContent === '127.0.0.1',
    }));
    assert.deepEqual(state,{steps:3,panels:1,tabs:['BUTTON','BUTTON','BUTTON','BUTTON','BUTTON'],tokenType:'password',advancedClosed:true,initialized:true});
    await evaluate(() => document.querySelector('[data-lang="th"]').click());
    assert.equal(await evaluate(() => /\{(?:to|end)\}/.test(document.getElementById('tunnelRange').textContent)),false,'Pager values interpolate in Thai');
    const requestMetric = await evaluate(() => ({
      label:document.querySelector('[data-i18n="statTotalRequests"]').textContent,
      count:document.getElementById('sRequests').textContent,
      hint:document.getElementById('sRequests').closest('.stat').title,
    }));
    assert.equal(requestMetric.label,'คำขอที่บันทึก');
    assert.equal(requestMetric.count,'24','The logged-request metric uses real persisted fixture logs');
    assert.match(requestMetric.hint,/7/);
    await capture('admin-preview.png');

    const unsaved = await evaluate(() => {
      document.querySelector('[data-onboard="settings"]').click();
      const primary = document.getElementById('primary-domain');
      primary.value = 'draft.example.test';
      primary.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('addPublishDomain').click();
      const rows = document.querySelectorAll('.publish-row');
      const last = rows[rows.length-1];
      last.querySelector('.publish-domain').value = 'draft-apps.example.test';
      last.querySelector('.publish-root').checked = true;
      last.querySelector('.publish-root').dispatchEvent(new Event('change',{bubbles:true}));
      const token = document.getElementById('tunnel-token');
      token.value = 'unsaved-test-key';
      token.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-lang="en"]').click();
      return {
        primary:primary.value, token:token.value,
        count:document.querySelectorAll('.publish-row').length,
        last:document.querySelectorAll('.publish-domain')[rows.length-1].value,
        root:document.querySelectorAll('.publish-root')[rows.length-1].checked,
        remove:[...document.querySelectorAll('.remove-publish')].map((item)=>item.textContent),
        checkLabels:[...document.querySelectorAll('.publish-subdomain-label')].map((item)=>item.textContent),
      };
    });
    assert.equal(unsaved.primary,'draft.example.test');
    assert.equal(unsaved.token,'unsaved-test-key');
    assert.equal(unsaved.count,2);
    assert.equal(unsaved.last,'draft-apps.example.test');
    assert.equal(unsaved.root,true);
    if (unsaved.remove.some((value)=>value !== 'Remove')) failures.push('Draft publish-domain rows keep their old language after switching to English: ' + JSON.stringify(unsaved.remove));
    await capture('admin-settings-preview.png');

    await evaluate(() => document.querySelector('[data-tab="logs"]').focus());
    await key('Enter',13);
    await pause();
    assert.equal(await evaluate(() => document.querySelector('.panel.active').id),'pLogs');
    await capture('admin-activity-preview.png');
    await evaluate(() => {document.getElementById('logSearch').value='no-matching-request';document.getElementById('logSearch').dispatchEvent(new Event('input',{bubbles:true}));});
    assert.match(await evaluate(() => document.querySelector('#tLogs .empty').textContent),/No matching results/);
    await capture('admin-empty-preview.png');
    await evaluate(() => document.querySelector('[data-tab="settings"]').focus());
    await key(' ',32);
    await pause();
    assert.equal(await evaluate(() => document.querySelector('.panel.active').id),'pSettings');
    win.setContentSize(380,800);
    await pause();
    const reflow = await evaluate(() => ({
      viewport:innerWidth,body:document.body.scrollWidth,
      controls:[...document.querySelectorAll('#settingsForm input,#settingsForm button')].filter((item)=>item.getClientRects().length).map((item)=>({id:item.id||item.className,right:item.getBoundingClientRect().right,width:item.getBoundingClientRect().width})),
      badNodes:[...document.querySelectorAll('body *')].filter((item)=>item.getClientRects().length && item.getBoundingClientRect().right>innerWidth+1 && !item.closest('pre,.table-wrap,.tabs')).slice(0,10).map((item)=>({tag:item.tagName,cls:item.className,width:item.getBoundingClientRect().width,right:item.getBoundingClientRect().right})),
    }));
    if (reflow.body > reflow.viewport + 1) failures.push('380px settings overflow: ' + JSON.stringify(reflow));
    await evaluate(() => document.getElementById('primary-domain').scrollIntoView({block:'start'}));
    await capture('admin-mobile-preview.png');
    assert.deepEqual(errors,[],'No page script/CSP errors');
    console.log(JSON.stringify({theme,login:true,realOriginLogin:true,gettingStartedSteps:3,maskedToken:true,draftPreserved:true,nativeKeyboardButtons:true,reflow,failures,scriptErrors:errors}));
    if (failures.length) throw new Error(failures.join('\n'));
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    win.destroy();
    app.exit(1);
  }
}

if (process.argv.includes('--dashboard-ui-browser')) {
  browserRun().catch((error) => {console.error(error.stack);process.exit(1);});
} else {
  const {test} = require('node:test');
  const assert = require('node:assert/strict');
  const {spawn} = require('node:child_process');
  test('real administrator UI login, drafts, keyboard and responsive layout', {timeout:45000}, async (context) => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(),'ptunnel-admin-ui-'));
    Object.assign(process.env,{DATA_DIR:testDir,SQLITE_PATH:path.join(testDir,'preview.db'),DB_PROVIDER:'sqlite',DB_SYNC_TARGETS:'',DB_BOOTSTRAP_SYNC:'false',
      PRIMARY_DOMAIN:'127.0.0.1',TUNNEL_DOMAIN:'apps.example.test',TUNNEL_TOKEN:'admin-ui-test-key-at-least-32-characters',DASHBOARD_PASSWORD:'dashboard-ui-test-password'});
    const db = require('../server/db');
    const {createDashboard} = require('../server/dashboard');
    await db.initDatabase();
    const config = await db.getServerSettings();
    // Populate the retained request counter through the real temporary database.
    for (let index=0; index<24; index+=1) {
      await db.logRequest({subdomain:'team-site',clientId:'dashboard-preview-device',
        visitorIp:'192.0.2.34',method:'GET',path:index%3===0?'/':'/assets/app.js',
        host:'team-site.apps.example.test',userAgent:'PrivateTunnel UI verification',
        statusCode:200,latencyMs:12+index,createdAt:new Date().toISOString()});
    }
    const tunnel = {tunnelType:'http',label:'team-site',publicHost:'team-site.apps.example.test',localPort:3000,clientIp:'127.0.0.1',
      hostname:'Team computer',os:'Windows',connectedAt:new Date().toISOString(),
      stats:{connections:24,bytesIn:18420,bytesOut:223400},pendingRequests:new Map(),requestLog:[]};
    const server = createDashboard({getLiveTunnels:()=>[tunnel]},config,{ports:{wsPort:8080,dashboardPort:8081,proxyPort:8082}});
    await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
    let observedLoginOrigin='';
    server.on('request',(req)=>{if(req.method==='POST'&&req.url.endsWith('/login'))observedLoginOrigin=req.headers.origin;});
    context.after(async()=>{
      await new Promise((resolve)=>server.close(resolve));
      await db.closeDatabase();
      if(path.dirname(testDir)===os.tmpdir()&&path.basename(testDir).startsWith('ptunnel-admin-ui-'))fs.rmSync(testDir,{recursive:true,force:true});
    });
    const previewUrl='http://127.0.0.1:'+server.address().port;
    const browserProfile=path.join(testDir,'browser');fs.mkdirSync(browserProfile,{recursive:true});
    const environment={...process.env,PT_DASHBOARD_PREVIEW_URL:previewUrl,PT_ADMIN_USER_DATA:browserProfile};
    delete environment.ELECTRON_RUN_AS_NODE;
    const args=[...(process.platform==='linux'&&process.env.CI==='true'?['--no-sandbox']:[]),__filename,'--dashboard-ui-browser'];
    const child=spawn(require('electron'),args,{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
    context.after(()=>{if(child.exitCode===null)child.kill();});
    let output='';
    child.stdout.on('data',(chunk)=>{output+=chunk;});
    child.stderr.on('data',(chunk)=>{output+=chunk;});
    const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
    assert.equal(code,0,output);
    assert.equal(observedLoginOrigin,previewUrl,'Native form sends the exact Origin required by the server');
    console.log(output.trim());
  });
}
