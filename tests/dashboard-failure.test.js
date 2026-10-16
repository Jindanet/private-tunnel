const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const http=require('node:http');
const {createRequire}=require('node:module');

test('a strict mirror failure cannot retain old sessions after a primary password write',{timeout:5000},async(t)=>{
  const filename=path.join(__dirname,'../server/dashboard.js');
  const realRequire=createRequire(filename);
  const output={exports:{}};
  let primaryChanged=false;
  const db={verifyPassword:async()=>true,setDashboardPassword:async()=>{primaryChanged=true;throw new Error('Mirror write failed after primary commit');}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:(name)=>name==='./db'?db:realRequire(name),module:output,
    process,Buffer,URL,URLSearchParams,console,setInterval,clearInterval,setTimeout,clearTimeout},{filename});
  const server=output.exports.createDashboard({}, {primaryDomain:'admin.example.com'});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise((resolve)=>server.close(resolve)));
  function request(route,{body,cookie}={}){
    return new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:body?'POST':'GET',
        headers:{host:'admin.example.com',origin:'http://admin.example.com','content-type':cookie?'application/json':'application/x-www-form-urlencoded',...(cookie?{cookie}:{})}},(res)=>{
        res.resume();res.on('end',()=>resolve({status:res.statusCode,headers:res.headers}));
      });req.on('error',reject);req.end(body);
    });
  }
  const signedIn=await request('/_private-tunnel/admin/login',{body:'password=test-password'});
  assert.equal(signedIn.status,302);
  const cookie=signedIn.headers['set-cookie'][0].split(';')[0];
  const rotation=await request('/_private-tunnel/admin/api/password',{body:'{"password":"new-test-password-long"}',cookie});
  assert.equal(primaryChanged,true);assert.equal(rotation.status,400);
  assert.equal((await request('/_private-tunnel/admin/api/overview',{cookie})).status,401);
});
