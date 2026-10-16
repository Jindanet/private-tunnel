const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-dashboard-test-'));
Object.assign(process.env, { DATA_DIR: testDir, SQLITE_PATH: path.join(testDir, 'test.db'), DB_PROVIDER: 'sqlite', DB_SYNC_TARGETS: '',
  PRIMARY_DOMAIN: 'admin.example.com', TUNNEL_DOMAIN: 'apps.example.net', TUNNEL_TOKEN: 'dashboard-test-only-key-at-least-32-characters',
  DASHBOARD_PASSWORD: 'test-only-password-long', DB_BOOTSTRAP_SYNC: 'false' });
const db = require('../server/db');
const { createDashboard } = require('../server/dashboard');

test('real dashboard enforces admin boundaries and safely renders hostile metadata', async (t) => {
  await db.initDatabase();
  const config = await db.getServerSettings();
  const attack = '</script><script>globalThis.compromised=true</script>';
  const tunnel = { tunnelType:'http', label:'demo', publicHost:'demo.apps.example.net', hostname:attack,
    connectedAt:new Date().toISOString(), stats:{connections:1,bytesIn:0,bytesOut:0}, pendingRequests:new Map(),
    requestLog:[{userAgent:attack,method:'GET',path:'/'}] };
  const server = createDashboard({getLiveTunnels:()=>[tunnel]}, config, {ports:{wsPort:8080,dashboardPort:8081,proxyPort:8082}});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve)=>server.close(resolve)); await db.closeDatabase(); fs.rmSync(testDir,{recursive:true,force:true}); });
  const port = server.address().port;
  const base = '/_private-tunnel/admin';
  function request(route, {method='GET',body,headers={}} = {}) {
    return new Promise((resolve,reject) => {
      const req=http.request({host:'127.0.0.1',port,path:route,method,
        headers:{host:'admin.example.com',origin:'http://admin.example.com',...headers}},(res)=>{
        let text='';res.setEncoding('utf8');res.on('data',(chunk)=>text+=chunk);
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
      });req.on('error',reject);req.end(body);
    });
  }
  const login = () => request(base+'/login',{method:'POST',body:'password=test-only-password-long',headers:{'content-type':'application/x-www-form-urlencoded'}});
  assert.equal((await request('/healthz')).status,200);
  assert.equal((await request(base,{headers:{host:'evil.example.com'}})).status,421);
  assert.equal((await request(base+'/api/overview')).status,401);
  const signedIn=await login();assert.equal(signedIn.status,302);
  let cookie=signedIn.headers['set-cookie'][0].split(';')[0];
  assert.match(signedIn.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);
  const dashboard=await request(base,{headers:{cookie}});
  assert.equal(dashboard.status,200);
  assert.equal(dashboard.text.includes(attack),false);
  assert.match(dashboard.text,/\\u003c\/script\\u003e/);
  assert.doesNotMatch(dashboard.headers['content-security-policy'],/script-src 'unsafe-inline'/);
  const nonce=dashboard.headers['content-security-policy'].match(/nonce-([^']+)/)[1];
  const scripts=[...dashboard.text.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);assert.equal(scripts[0][1],nonce);
  assert.doesNotThrow(()=>new vm.Script(scripts[0][2]));
  const mutation={method:'POST',body:JSON.stringify({password:'changed-test-password-long'}),headers:{cookie,'content-type':'application/json'}};
  assert.equal((await request(base+'/api/password',{...mutation,headers:{...mutation.headers,origin:'http://evil.example.com'}})).status,403);
  assert.equal((await request(base+'/api/password',{...mutation,headers:{...mutation.headers,'content-type':'text/plain'}})).status,403);
  async function holdMutation(route, prefix) {
    let releaseRequest;
    const received=new Promise((resolve)=>server.once('request',(req)=>req.once('data',resolve)));
    const result=new Promise((resolve,reject)=>{
      releaseRequest=http.request({host:'127.0.0.1',port,path:route,method:'POST',headers:{host:'admin.example.com',origin:'http://admin.example.com',cookie,'content-type':'application/json'}},(res)=>{
        res.resume();res.on('end',()=>resolve(res.statusCode));
      });releaseRequest.on('error',reject);releaseRequest.write(prefix);
    });
    await received;
    return {request:releaseRequest,result};
  }
  const heldPassword=await holdMutation(base+'/api/password','{"password":');
  const heldSettings=await holdMutation(base+'/api/settings','{"primaryDomain":');
  const changed=await request(base+'/api/password',mutation);assert.equal(changed.status,200);
  heldPassword.request.end('"attacker-test-password"}');
  heldSettings.request.end('"attacker.example.com"}');
  assert.equal(await heldPassword.result,401);
  assert.equal(await heldSettings.result,401);
  const newCookie=changed.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(newCookie,cookie);
  assert.equal((await request(base+'/api/overview',{headers:{cookie}})).status,401);
  assert.equal((await request(base+'/api/overview',{headers:{cookie:newCookie}})).status,200);
  assert.equal(await db.verifyPassword('changed-test-password-long'),true);
  const Database=require('better-sqlite3');
  const sqlite=new Database(path.join(testDir,'test.db'));
  sqlite.prepare('UPDATE config SET value=? WHERE key=?').run(require('node:crypto').createHash('sha256').update('legacy-test-password').digest('hex'),'admin_password_hash');
  sqlite.close();
  const [legacyAccepted]=await Promise.all([db.verifyPassword('legacy-test-password'),db.setDashboardPassword('rotated-after-legacy-password')]);
  assert.equal(legacyAccepted,true);
  assert.equal(await db.verifyPassword('legacy-test-password'),false);
  assert.equal(await db.verifyPassword('rotated-after-legacy-password'),true);
  const rejections=[];
  for(let i=0;i<6;i++) rejections.push((await request(base+'/login',{method:'POST',body:'password=wrong'})).status);
  assert.equal(rejections.at(-1),429);
});
