'use strict';

// Browser integration uses a local, test-only bridge. It never loads server configuration.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../app/renderer');

function browserBridge() {
  localStorage.setItem('ptGuiLang', 'en');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fixture = window.__rendererFixture = {
    config: { serverUrl: '', token: '', tunnels: [] },
    checks: [], adds: [], saves: 0, pendingChecks: [], manualChecks: false,
    startFailure: '', addFailure: '', checkFailure: '', serverFailure: false,
    emitStatus: () => {}, emitRequest: () => {},
  };
  window.api = {
    getConfig: async () => structuredClone(fixture.config),
    validateServerProfile: async ({serverUrl, token}) => {
      const errors = {};
      if (!serverUrl) errors.serverUrl = 'Server WebSocket URL is required.';
      if (!token) errors.token = 'Access token is required before this GUI can create tunnels.';
      return {ok: !Object.keys(errors).length, errors, normalizedUrl: serverUrl.startsWith('ws') ? serverUrl : 'wss://' + serverUrl + '/_private-tunnel/ws'};
    },
    testServerProfile: async () => {
      await pause(30);
      return fixture.serverFailure ? {ok:false, message:'The saved token is invalid for this server.'} : {ok:true};
    },
    saveServerProfile: async (input) => {
      fixture.saves += 1;
      Object.assign(fixture.config, input);
      return {ok:true, serverUrl:input.serverUrl};
    },
    checkTunnelConfig: async (input) => {
      fixture.checks.push(structuredClone(input));
      if (fixture.checkFailure) throw new Error(fixture.checkFailure);
      if (fixture.manualChecks) return new Promise((resolve) => fixture.pendingChecks.push(resolve));
      return {available:true, publishDomain:input.publishDomain || 'public.example.test', message:'Random subdomain mode is ready.'};
    },
    addTunnel: async (input) => {
      if (fixture.addFailure) throw new Error(fixture.addFailure);
      const tunnel = {...input, id:crypto.randomUUID(), name:input.name || 'My service'};
      fixture.adds.push(structuredClone(tunnel));
      fixture.config.tunnels.push(tunnel);
      return tunnel;
    },
    startTunnel: async (id) => {
      if (fixture.startFailure) return {error:fixture.startFailure};
      fixture.emitStatus({id, status:'online', url:'https://shared.public.example.test'});
      return {ok:true};
    },
    stopTunnel: async (id) => { fixture.emitStatus({id,status:'stopped',url:''}); return true; },
    deleteTunnel: async () => true,
    copyText: async (value) => { fixture.copied = value; },
    openExternal: async (value) => { fixture.opened = value; },
    onTunnelStatus: (callback) => { fixture.emitStatus = callback; },
    onTunnelRequest: (callback) => { fixture.emitRequest = callback; },
  };
}

async function startFixture() {
  const bridge = '(' + browserBridge.toString() + ')();';
  const server = http.createServer((req, res) => {
    const routes = {
      '/': ['text/html; charset=utf-8', () => fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('<script src="app.js">', '<script src="test-bridge.js"></script><script src="app.js">')],
      '/app.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(path.join(root, 'app.js'))],
      '/style.css': ['text/css; charset=utf-8', () => fs.readFileSync(path.join(root, 'style.css'))],
      '/test-bridge.js': ['text/javascript; charset=utf-8', () => bridge],
    };
    const route = routes[new URL(req.url, 'http://localhost').pathname];
    if (!route) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {'Content-Type':route[0], 'Cache-Control':'no-store'});
    res.end(route[1]());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {server, url: 'http://127.0.0.1:' + server.address().port};
}

async function runElectronChecks() {
  const assert = require('node:assert/strict');
  const {app, BrowserWindow} = require('electron');
  if (process.env.PT_RENDERER_USER_DATA) app.setPath('userData', process.env.PT_RENDERER_USER_DATA);
  // Trusted local fixture only. Linux CI/container hosts do not provide Chromium's sandbox setup.
  if (process.platform === 'linux' && process.env.CI === 'true') app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-proxy-server');
  const fixture = await startFixture();
  await app.whenReady();
  const win = new BrowserWindow({
    show:false, width:600, height:820, useContentSize:true,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false,partition:'renderer-tests-' + process.pid},
  });
  const errors = [];
  const capture = async (name) => {
    if (!process.env.PT_RENDERER_CAPTURE_DIR) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.mkdirSync(process.env.PT_RENDERER_CAPTURE_DIR, {recursive:true});
    fs.writeFileSync(path.join(process.env.PT_RENDERER_CAPTURE_DIR, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !message.includes('favicon')) errors.push(message);
  });
  try {
    await win.loadURL(fixture.url);
    win.webContents.setZoomFactor(1);
    await capture('setup');
    if (process.env.PT_RENDERER_CAPTURE_DIR) {
      await win.webContents.executeJavaScript('document.querySelector("#view-setup [data-lang=th]").click()');
      await capture('setup-th');
      win.setContentSize(1040,780);
      await capture('setup-wide-th');
      win.setContentSize(600,820);
      await win.webContents.executeJavaScript('document.querySelector("#view-setup [data-lang=en]").click()');
    }
    const results = await win.webContents.executeJavaScript('(' + browserChecks.toString() + ')()');
    assert.equal(results.length, 13);
    assert.deepEqual(errors, []);
    await win.webContents.executeJavaScript('document.getElementById("close-guide-btn").click(); document.getElementById("add-tunnel-btn").click(); document.getElementById("advanced-options").open=true');
    win.setContentSize(380,540);
    win.webContents.setZoomFactor(1.25);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const addReflow = await win.webContents.executeJavaScript('({body:document.body.scrollWidth,viewport:innerWidth,panel:document.getElementById("panel-add").scrollWidth,panelWidth:document.getElementById("panel-add").clientWidth,footerBottom:document.querySelector("#panel-add .panel-actions").getBoundingClientRect().bottom,height:innerHeight})');
    assert.ok(addReflow.body <= addReflow.viewport + 1 && addReflow.panel <= addReflow.panelWidth + 1, JSON.stringify(addReflow));
    assert.ok(addReflow.footerBottom <= addReflow.height + 1, 'Start sharing remains visible at minimum window size and 125% zoom: ' + JSON.stringify(addReflow));
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".sidebar").inert'), true, 'Covered sidebar is removed from keyboard navigation');
    await win.webContents.executeJavaScript('document.getElementById("confirm-add-btn").focus()');
    for (let index = 0; index < 8; index += 1) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      const hiddenFocus = await win.webContents.executeJavaScript('document.querySelector(".sidebar").contains(document.activeElement)');
      assert.equal(hiddenFocus, false, 'Tab cannot reach controls covered by the creation editor');
    }
    await win.webContents.executeJavaScript('document.getElementById("add-subdomain").focus()');
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.id'), 'add-subdomain');
    await win.webContents.executeJavaScript('document.getElementById("cancel-add-btn").click()');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector(".sidebar").inert'), false, 'Cancel restores sidebar navigation');
    win.setContentSize(600,820);
    win.webContents.setZoomFactor(1);
    if (process.env.PT_RENDERER_CAPTURE_DIR) {
      await win.webContents.executeJavaScript('window.__rendererFixture.config.tunnels[0].name="เว็บไซต์ทีมของฉัน"; window.__rendererFixture.emitStatus({id:window.__rendererFixture.adds[0].id,status:"online",url:"https://shared.public.example.test"}); document.querySelector(".request-details").open=false; document.getElementById("toast").hidden=true');
      await capture('sharing-th');
      await win.webContents.executeJavaScript('document.getElementById("add-tunnel-btn").click()');
      await capture('add-th');
      await win.webContents.executeJavaScript('document.getElementById("cancel-add-btn").click()');
      win.setContentSize(1040,780);
      await capture('sharing-wide-th');
      await win.webContents.executeJavaScript('window.__rendererFixture.emitStatus({id:window.__rendererFixture.adds[0].id,status:"error",error:"The saved token is invalid for this server profile."})');
      await capture('error-wide-th');
      await win.webContents.executeJavaScript('window.__rendererFixture.emitStatus({id:window.__rendererFixture.adds[0].id,status:"stopped",url:""})');
      await capture('stopped-wide-th');
      await win.webContents.executeJavaScript('window.__captureTunnels=config.tunnels; config.tunnels=[]; renderList()');
      await capture('empty-wide-th');
      await win.webContents.executeJavaScript('config.tunnels=window.__captureTunnels; renderList(); document.getElementById("add-tunnel-btn").click()');
      await capture('add-wide-th');
      await win.webContents.executeJavaScript('document.getElementById("cancel-add-btn").click(); document.getElementById("guide-btn").click()');
    }
    await win.webContents.executeJavaScript('document.getElementById("guide-btn").click()');
    win.setContentSize(380, 540);
    win.webContents.setZoomFactor(2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const reflow = await win.webContents.executeJavaScript('({body:document.body.scrollWidth, viewport:innerWidth, panel:document.querySelector("dialog[open]")?.scrollWidth, panelWidth:document.querySelector("dialog[open]")?.clientWidth})');
    assert.ok(reflow.body <= reflow.viewport + 1, JSON.stringify(reflow));
    assert.ok(reflow.panel <= reflow.panelWidth + 1, JSON.stringify(reflow));
    await win.webContents.executeJavaScript('document.activeElement.blur(); document.getElementById("close-guide-btn").focus()');
    for (let index = 0; index < 12; index += 1) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    }
    const contained = await win.webContents.executeJavaScript('document.getElementById("panel-guide").contains(document.activeElement)');
    assert.equal(contained, true, 'Native dialog keeps keyboard focus inside');
    console.log(JSON.stringify({passed:results, addReflow, reflow, keyboardFocusContained:contained}));
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    app.exit(1);
  } finally {
    fixture.server.close();
    if (!win.isDestroyed()) win.destroy();
  }
}

async function browserChecks() {
  const el = (id) => document.getElementById(id);
  const fixture = window.__rendererFixture;
  const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  const passed = [];
  await pause();
  ensure(!el('view-setup').hidden && el('view-main').hidden, 'First run shows setup');
  ensure([...document.querySelectorAll('input,select')].every((input) => document.querySelector('label[for="' + input.id + '"]')), 'Fields have labels');
  ensure(document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("script-src 'self'"), 'Strict CSP is present');
  passed.push('first run, labels and CSP');

  el('setup-connect-btn').click();
  await pause();
  ensure(el('setup-url-error').textContent && fixture.saves === 0, 'Invalid profile stays inline');
  passed.push('inline profile validation');

  el('setup-url').value = 'server.example.test';
  el('setup-token').value = 'test-key-not-a-real-secret';
  el('setup-connect-btn').click();
  el('setup-form').dispatchEvent(new Event('submit', {cancelable:true}));
  await pause(80);
  ensure(fixture.saves === 1 && !el('view-main').hidden && fixture.adds.length === 0, 'Saving is guarded and does not publish');
  document.querySelector('[data-quick="game"]').click();
  ensure(el('add-port').value === '25565' && document.querySelector('[data-type="tcp"]').getAttribute('aria-pressed') === 'true', 'Minecraft quick start chooses correct transport and port');
  ensure(el('workspace').inert && el('panel-add').getAttribute('aria-modal') === 'false', 'Add is an inline editor with the service workspace inactive');
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
  await pause();
  ensure(!el('panel-add').open && !el('workspace').inert && fixture.adds.length === 0, 'Escape cancels inline creation without publishing');
  passed.push('verified profile, duplicate save guard');

  el('add-tunnel-btn').focus();
  el('add-tunnel-btn').click();
  ensure(el('panel-add').open && document.activeElement === el('add-port') && !el('advanced-options').open, 'Creation starts simple and focused');
  el('add-port').value = '3000.5';
  el('confirm-add-btn').click();
  await pause();
  ensure(el('add-port-error').textContent && fixture.checks.length === 0, 'Fractional ports rejected');
  for (const invalid of ['https://localhost:3000', 'http://example.com:3000', 'http://user:password@localhost:3000', 'localhost:0']) {
    el('add-port').value = invalid;
    el('confirm-add-btn').click();
    await pause();
    ensure(el('add-port-error').textContent && fixture.checks.length === 0, 'Unsupported target rejected: ' + invalid);
  }
  passed.push('simple form and strict port validation');

  el('add-port').value = 'http://localhost:3000/preview';
  el('add-name').value = '<img src=x onerror=alert(1)>';
  el('confirm-add-btn').click();
  el('add-form').dispatchEvent(new Event('submit', {cancelable:true}));
  await pause(40);
  ensure(fixture.adds.length === 1 && fixture.checks.length === 1, 'Duplicate publication prevented');
  ensure(fixture.adds[0].port === 3000, 'Pasted local URL resolves to its numeric port');
  ensure(fixture.adds[0].clientId === fixture.checks[0].clientId && /^[a-f0-9-]{36}$/.test(fixture.adds[0].clientId), 'Check and add share one new UUID');
  ensure(document.querySelector('.status-label').textContent === 'Sharing' && document.querySelector('.url-text'), 'Online address shown');
  ensure(el('server-url-text').textContent === 'server.example.test' && el('sharing-summary').textContent === '1 sharing', 'Summary hides internal endpoint and reflects live sharing');
  document.querySelector('.open-btn').click();
  await pause();
  ensure(fixture.opened === 'https://shared.public.example.test', 'Visible Open action uses assigned address');
  ensure(!document.querySelector('img'), 'Service names render as text');
  passed.push('one publication with same checked UUID');

  const id = fixture.adds[0].id;
  fixture.emitRequest({id,method:'<img src=x>',path:'/<script>alert(1)</script>',statusCode:'<svg onload=alert(1)>'});
  document.querySelector('.request-details').open = true;
  await pause();
  ensure(document.querySelector('.log-m').textContent === '<img src=x>' && !document.querySelector('img,svg,script:not([src])'), 'Log fields are text');
  document.querySelector('#view-main [data-lang="th"]').click();
  ensure(document.querySelector('.log-p').textContent === '/<script>alert(1)</script>', 'Logs survive rerender');
  ensure(document.querySelector('.request-details').open, 'Log disclosure survives language change');
  passed.push('untrusted logs are safe and persist');

  document.querySelector('.copy-btn').click();
  await pause();
  ensure(fixture.copied === 'https://shared.public.example.test', 'Copy uses actual address');
  fixture.emitStatus({id,status:'reconnecting',url:''});
  ensure(!document.querySelector('.url-text') && !document.querySelector('.copy-btn'), 'Disconnected URL cleared');
  fixture.emitStatus({id,status:'error',error:'The saved token is invalid for this server profile.'});
  ensure(document.querySelector('.btn-start').textContent === 'ลองอีกครั้ง' && !document.querySelector('.btn-stop'), 'Errors offer retry');
  document.querySelector('.recovery-button').click();
  ensure(el('panel-settings').open && el('settings-token').type === 'password', 'Rejected key offers direct connection settings with a masked key');
  el('close-settings-btn').click();
  await pause();
  passed.push('copy, disconnect and retry states');

  fixture.startFailure = 'start rejected for test';
  document.querySelector('.btn-start').click();
  await pause();
  ensure(document.querySelector('.url-error').textContent.includes(fixture.startFailure), 'Start rejection remains inline');
  fixture.startFailure = '';
  passed.push('bridge start failure');

  el('add-tunnel-btn').focus();
  el('add-tunnel-btn').click();
  el('advanced-options').open = true;
  fixture.manualChecks = true;
  el('add-domain').value = 'first.example.test';
  el('check-subdomain-btn').click();
  el('add-domain').value = 'second.example.test';
  el('add-domain').dispatchEvent(new Event('input'));
  el('check-subdomain-btn').click();
  fixture.pendingChecks[1]({available:true,publishDomain:'second.example.test',message:'second response'});
  await pause();
  fixture.pendingChecks[0]({available:false,publishDomain:'first.example.test',message:'old response'});
  await pause();
  ensure(el('add-domain').value === 'second.example.test' && el('add-check-status').textContent === 'second response', 'Old route response ignored');
  passed.push('stale route response ignored');

  const previousClientId = fixture.checks[1].clientId;
  el('cancel-add-btn').click();
  await pause();
  ensure(document.activeElement === el('add-tunnel-btn'), 'Dialog restores focus');
  el('add-tunnel-btn').click();
  fixture.manualChecks = false;
  fixture.checkFailure = 'check rejected for test';
  el('check-subdomain-btn').click();
  await pause();
  ensure(el('add-check-status').textContent === fixture.checkFailure, 'Check rejection remains inline');
  ensure(fixture.checks.at(-1).clientId !== previousClientId, 'New profile has its own client ID');
  fixture.checkFailure = '';
  passed.push('dialog focus, new identity and check failure');

  fixture.addFailure = 'add rejected for test';
  el('add-port').value = '3000';
  el('confirm-add-btn').click();
  await pause();
  ensure(el('add-check-status').textContent === fixture.addFailure && !el('confirm-add-btn').disabled, 'Add rejection releases submission lock');
  fixture.addFailure = '';
  el('cancel-add-btn').click();
  await pause();
  passed.push('bridge add failure recovers');

  el('settings-btn').click();
  fixture.serverFailure = true;
  el('save-settings-btn').click();
  await pause(60);
  ensure(el('settings-status').textContent.includes('กุญแจ') && fixture.saves === 1 && !el('save-settings-btn').disabled, 'Rejected access key never saves');
  fixture.serverFailure = false;
  el('close-settings-btn').click();
  await pause();
  passed.push('failed server verification does not save');

  el('guide-btn').click();
  ensure(el('panel-guide').open && el('guide-body').textContent.includes('เว็บไซต์'), 'Bilingual guide opens');
  document.getElementById('tab-game').click();
  ensure(el('guide-body').textContent.includes('UDP'), 'TCP limitation is explicit');
  passed.push('bilingual guide and transport limits');
  return passed;
}

if (process.argv.includes('--renderer-integration')) {
  runElectronChecks().catch((error) => { console.error(error.stack); process.exit(1); });
} else if (process.argv.includes('--serve')) {
  startFixture().then(({url}) => { console.log('Renderer fixture: ' + url); });
} else {
  const {test} = require('node:test');
  const assert = require('node:assert/strict');
  const {spawn} = require('node:child_process');
  test('desktop renderer integration with isolated test bridge', {timeout:45000}, async (context) => {
    const environment = {...process.env};
    const testProfile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ptunnel-renderer-user-'));
    environment.PT_RENDERER_USER_DATA = testProfile;
    context.after(() => {
      if (path.dirname(testProfile) === require('node:os').tmpdir() && path.basename(testProfile).startsWith('ptunnel-renderer-user-')) {
        fs.rmSync(testProfile, {recursive:true,force:true,maxRetries:5,retryDelay:100});
      }
    });
    delete environment.ELECTRON_RUN_AS_NODE;
    const args = [...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : []), __filename, '--renderer-integration'];
    const child = spawn(require('electron'), args, {env:environment, windowsHide:true, stdio:['ignore','pipe','pipe']});
    context.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve,reject) => { child.on('exit',resolve); child.on('error',reject); });
    assert.equal(code, 0, output);
    console.log(output.trim());
  });
}
