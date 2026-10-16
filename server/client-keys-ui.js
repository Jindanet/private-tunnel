const clientKeysPanel = `
<section class="box" aria-labelledby="clientKeysHeading">
  <h2 id="clientKeysHeading" data-i18n="clientKeysHeading">Client access keys</h2>
  <p class="settings-form-note" data-i18n="clientKeysIntro">Create a separate key for each person. Their apps keep their own reserved public addresses.</p>
  <form id="clientKeyForm">
    <div class="field"><label for="clientKeyName" data-i18n="clientKeyName">Person or device name</label><input id="clientKeyName" name="client-name" maxlength="100" required autocomplete="off" data-i18n-placeholder="clientKeyNamePlaceholder" placeholder="For example, Alice's laptop"><small data-i18n="clientKeySetupHint">Send the new key and this server's address to its owner. They save both in the desktop app or CLI.</small></div>
    <div class="actions"><button type="submit" class="btn primary" id="clientKeyIssue" data-i18n="clientKeyIssue">Create client key</button><button type="button" class="btn secondary" id="clientKeysRefresh" data-i18n="clientKeysRefresh">Refresh list</button></div>
  </form>
  <div id="clientKeySecretPanel" class="field" hidden style="margin-top:24px">
    <label for="clientKeySecret" data-i18n="clientKeySecretLabel">New access key</label>
    <p class="sub" id="clientKeySecretOwner" style="overflow-wrap:anywhere"></p>
    <input id="clientKeySecret" type="password" readonly autocomplete="off" spellcheck="false" aria-describedby="clientKeySecretHint">
    <small id="clientKeySecretHint" data-i18n="clientKeySecretHint">Copy and send it now. The server stores only a hash and cannot show this key again. Dismiss or leave Settings to clear it.</small>
    <div class="actions"><button type="button" class="btn secondary" id="clientKeyShow" aria-controls="clientKeySecret" aria-pressed="false" data-i18n="showKey">Show</button><button type="button" class="btn primary" id="clientKeyCopy" data-i18n="clientKeyCopy">Copy key</button><button type="button" class="btn secondary" id="clientKeyDismiss" data-i18n="clientKeyDismiss">Dismiss</button></div>
  </div>
  <p id="clientKeyStatus" class="status" role="status" aria-live="polite" style="margin-top:16px"></p>
  <div id="clientKeysList" class="form-grid" style="margin-top:20px"></div>
  <p class="sub" style="margin-top:20px" data-i18n="clientKeyRevokeHint">Rotating or revoking a key disconnects all apps using it. Rotation keeps the owner's reserved addresses; revocation cannot be undone.</p>
</section>`;

const clientKeysBehavior = String.raw`
Object.assign(I18N.en,{
  clientKeysHeading:'Client access keys',clientKeysIntro:'Create a separate key for each person. Their apps keep their own reserved public addresses.',
  clientKeyName:'Person or device name',clientKeyNamePlaceholder:"For example, Alice's laptop",clientKeySetupHint:'Send the new key and this server\'s address to its owner. They save both in the desktop app or CLI.',
  clientKeyIssue:'Create client key',clientKeysRefresh:'Refresh list',clientKeySecretLabel:'New access key',
  clientKeySecretHint:'Copy and send it now. The server stores only a hash and cannot show this key again. Dismiss or leave Settings to clear it.',
  clientKeyCopy:'Copy key',clientKeyDismiss:'Dismiss',clientKeyRevokeHint:'Rotating or revoking a key disconnects all apps using it. Rotation keeps the owner\'s reserved addresses; revocation cannot be undone.',
  clientKeysEmpty:'No client keys yet. Create one for the first person who will connect.',clientKeysLoading:'Loading client keys…',clientKeysReady:'Client keys are managed separately from server settings.',
  clientKeyActive:'Active',clientKeyRevoked:'Revoked',clientKeyCreated:'Created {date}',clientKeyRotate:'Rotate key',clientKeyRevoke:'Revoke & disconnect',
  clientKeyRotateNamed:'Rotate key for {name}',clientKeyRevokeNamed:'Revoke key and disconnect apps for {name}',
  clientKeyCreating:'Creating client key…',clientKeyRotating:'Rotating key and disconnecting apps…',clientKeyRevoking:'Revoking key and disconnecting apps…',
  clientKeyIssued:'Key created. Copy it below and send it to its owner.',clientKeyRotated:'Key rotated. Send the new key to its owner so they can reconnect.',clientKeyRevokedDone:'Key revoked. Its apps have been disconnected.',
  clientKeySecretCleared:'The new key was cleared when you left Settings. Rotate that key to receive another secret.',clientKeyCopied:'Key copied.',clientKeyCopyFailed:'Copy is unavailable. Select Show, then select the key and copy it manually.',
  clientKeyLoadFailed:'Could not load client keys. Select Refresh list to try again.',clientKeySaveFailed:'Could not update client keys. Check the server and try again.',
  clientKeyNameError:'Enter a name of 1–100 characters without line breaks.',clientKeyUnavailable:'Client key management is unavailable on this server.',
  fieldTunnelToken:'Legacy shared key',legacySharedAccess:'Advanced: shared-key compatibility',legacySharedHint:'Unused by default. ALLOW_SHARED_TUNNEL_TOKEN=true enables this key for migration. Everyone using it shares one owner; use separate client keys above for new connections.'
});
Object.assign(I18N.th,{
  clientKeysHeading:'รหัสเชื่อมต่อแยกผู้ใช้',clientKeysIntro:'สร้างรหัสแยกให้แต่ละคน แอปของแต่ละคนจะมีที่อยู่สาธารณะที่สงวนไว้เป็นของตัวเอง',
  clientKeyName:'ชื่อผู้ใช้หรืออุปกรณ์',clientKeyNamePlaceholder:'เช่น แล็ปท็อปของคุณเอ',clientKeySetupHint:'ส่งรหัสใหม่และที่อยู่เซิร์ฟเวอร์นี้ให้เจ้าของ เพื่อนำไปบันทึกในแอปเดสก์ท็อปหรือ CLI',
  clientKeyIssue:'สร้างรหัสเชื่อมต่อ',clientKeysRefresh:'โหลดรายการใหม่',clientKeySecretLabel:'รหัสเชื่อมต่อใหม่',
  clientKeySecretHint:'คัดลอกและส่งให้เจ้าของตอนนี้ เซิร์ฟเวอร์เก็บเฉพาะค่าแฮช จึงแสดงรหัสนี้ซ้ำไม่ได้ เมื่อกดปิดหรือออกจากหน้าตั้งค่า รหัสจะถูกล้าง',
  clientKeyCopy:'คัดลอกรหัส',clientKeyDismiss:'ปิดและล้างรหัส',clientKeyRevokeHint:'การเปลี่ยนหรือเพิกถอนรหัสจะตัดการเชื่อมต่อทุกแอปที่ใช้รหัสนั้น การเปลี่ยนรหัสยังคงที่อยู่ที่สงวนไว้ให้เจ้าของ ส่วนการเพิกถอนไม่สามารถยกเลิกได้',
  clientKeysEmpty:'ยังไม่มีรหัสเชื่อมต่อ สร้างรหัสให้ผู้ใช้คนแรกที่จะเชื่อมต่อ',clientKeysLoading:'กำลังโหลดรหัสเชื่อมต่อ…',clientKeysReady:'จัดการรหัสเชื่อมต่อแยกจากการตั้งค่าเซิร์ฟเวอร์',
  clientKeyActive:'ใช้งานได้',clientKeyRevoked:'เพิกถอนแล้ว',clientKeyCreated:'สร้างเมื่อ {date}',clientKeyRotate:'เปลี่ยนรหัส',clientKeyRevoke:'เพิกถอนและตัดการเชื่อมต่อ',
  clientKeyRotateNamed:'เปลี่ยนรหัสของ {name}',clientKeyRevokeNamed:'เพิกถอนรหัสและตัดการเชื่อมต่อแอปของ {name}',
  clientKeyCreating:'กำลังสร้างรหัสเชื่อมต่อ…',clientKeyRotating:'กำลังเปลี่ยนรหัสและตัดการเชื่อมต่อแอป…',clientKeyRevoking:'กำลังเพิกถอนรหัสและตัดการเชื่อมต่อแอป…',
  clientKeyIssued:'สร้างรหัสแล้ว คัดลอกรหัสด้านล่างและส่งให้เจ้าของ',clientKeyRotated:'เปลี่ยนรหัสแล้ว ส่งรหัสใหม่ให้เจ้าของเพื่อเชื่อมต่ออีกครั้ง',clientKeyRevokedDone:'เพิกถอนรหัสและตัดการเชื่อมต่อแอปที่ใช้รหัสนี้แล้ว',
  clientKeySecretCleared:'ล้างรหัสใหม่แล้วเมื่อออกจากหน้าตั้งค่า หากต้องการรหัสใหม่ ให้กดเปลี่ยนรหัสของรายการนั้น',clientKeyCopied:'คัดลอกรหัสแล้ว',clientKeyCopyFailed:'คัดลอกอัตโนมัติไม่ได้ กดแสดง จากนั้นเลือกรหัสและคัดลอกด้วยตัวเอง',
  clientKeyLoadFailed:'โหลดรหัสเชื่อมต่อไม่ได้ กดโหลดรายการใหม่เพื่อลองอีกครั้ง',clientKeySaveFailed:'อัปเดตรหัสเชื่อมต่อไม่ได้ ตรวจสอบเซิร์ฟเวอร์แล้วลองอีกครั้ง',
  clientKeyNameError:'กรอกชื่อ 1–100 ตัวอักษร โดยไม่ขึ้นบรรทัดใหม่',clientKeyUnavailable:'เซิร์ฟเวอร์นี้ยังไม่พร้อมให้จัดการรหัสเชื่อมต่อ',
  fieldTunnelToken:'รหัสร่วมแบบเดิม',legacySharedAccess:'ขั้นสูง: รองรับรหัสร่วมแบบเดิม',legacySharedHint:'ค่าเริ่มต้นไม่ใช้รหัสนี้ เปิด ALLOW_SHARED_TUNNEL_TOKEN=true เพื่อย้ายจากระบบเดิม ผู้ที่ใช้รหัสร่วมจะถือเป็นเจ้าของเดียวกัน สำหรับการเชื่อมต่อใหม่ให้สร้างรหัสแยกด้านบน'
});
let clientKeysData=[];
let clientKeysLoaded=false;
let clientKeysLoading=false;
let clientKeysBusy=false;
let clientKeysMessage='clientKeysReady';
let clientKeysSecretGeneration=0;

function clearClientKeySecret(){
  clientKeysSecretGeneration+=1;
  el('clientKeySecret').value='';
  el('clientKeySecret').type='password';
  el('clientKeySecretOwner').textContent='';
  el('clientKeySecretPanel').hidden=true;
  el('clientKeyShow').setAttribute('aria-pressed','false');
  el('clientKeyShow').textContent=t('showKey');
}
function clientKeyErrorMessage(error,fallback){
  const message=String(error&&error.message||'');
  if(message.startsWith('Client name must'))return 'clientKeyNameError';
  if(message==='Client key management is unavailable.')return 'clientKeyUnavailable';
  return fallback;
}
function renderClientKeys(){
  const target=el('clientKeysList');
  target.replaceChildren();
  if(!clientKeysLoaded){target.appendChild(create('p','sub',t(clientKeysLoading?'clientKeysLoading':'clientKeysEmpty')));}
  else if(!clientKeysData.length){target.appendChild(create('p','sub',t('clientKeysEmpty')));}
  clientKeysData.forEach((key)=>{
    const row=create('div','field');
    row.dataset.clientKeyId=key.id;
    row.style.borderTop='1px solid var(--line)';
    row.style.paddingTop='16px';
    const name=create('strong','',key.name);
    name.style.overflowWrap='anywhere';
    row.appendChild(name);
    row.appendChild(create('small','',t(key.revokedAt?'clientKeyRevoked':'clientKeyActive')+' · '+t('clientKeyCreated',{date:new Date(key.createdAt).toLocaleString(currentLang==='th'?'th-TH':'en-US')})));
    if(!key.revokedAt){
      const actions=create('div','actions');
      ['rotate','revoke'].forEach((action)=>{
        const button=create('button',action==='revoke'?'btn danger':'btn secondary',t(action==='revoke'?'clientKeyRevoke':'clientKeyRotate'));
        button.type='button';button.dataset.keyAction=action;
        button.disabled=clientKeysBusy||clientKeysLoading;
        button.setAttribute('aria-label',t(action==='revoke'?'clientKeyRevokeNamed':'clientKeyRotateNamed',{name:key.name}));
        button.addEventListener('click',()=>changeClientKey(key.id,action));
        actions.appendChild(button);
      });
      row.appendChild(actions);
    }
    target.appendChild(row);
  });
  el('clientKeyIssue').disabled=clientKeysBusy||clientKeysLoading;
  el('clientKeyName').disabled=clientKeysBusy;
  el('clientKeysRefresh').disabled=clientKeysBusy||clientKeysLoading;
  el('clientKeyStatus').textContent=t(clientKeysMessage);
  el('clientKeyShow').textContent=t(el('clientKeySecret').type==='password'?'showKey':'hideKey');
}
async function loadClientKeys(){
  if(clientKeysLoading||clientKeysBusy)return;
  clientKeysLoading=true;clientKeysMessage='clientKeysLoading';renderClientKeys();
  try{
    const payload=await api(currentRoutes.adminApiBasePath+'/client-keys');
    clientKeysData=Array.isArray(payload.keys)?payload.keys:[];clientKeysLoaded=true;clientKeysMessage='clientKeysReady';
  }catch(error){clientKeysMessage=clientKeyErrorMessage(error,'clientKeyLoadFailed');}
  finally{clientKeysLoading=false;renderClientKeys();}
}
function revealClientKey(result,generation){
  if(generation!==clientKeysSecretGeneration||!el('pSettings').classList.contains('active')){
    clientKeysMessage='clientKeySecretCleared';return;
  }
  el('clientKeySecret').value=result.token;
  el('clientKeySecretOwner').textContent=result.key.name;
  el('clientKeySecretPanel').hidden=false;
}
async function issueClientKey(){
  if(clientKeysBusy||clientKeysLoading)return;
  clearClientKeySecret();
  const generation=clientKeysSecretGeneration;
  clientKeysBusy=true;clientKeysMessage='clientKeyCreating';renderClientKeys();
  try{
    const result=await api(currentRoutes.adminApiBasePath+'/client-keys',{method:'POST',body:JSON.stringify({name:el('clientKeyName').value})});
    clientKeysData.push(result.key);clientKeysLoaded=true;el('clientKeyName').value='';clientKeysMessage='clientKeyIssued';
    revealClientKey(result,generation);
  }catch(error){clientKeysMessage=clientKeyErrorMessage(error,'clientKeySaveFailed');}
  finally{clientKeysBusy=false;renderClientKeys();}
}
async function changeClientKey(id,action){
  if(clientKeysBusy||clientKeysLoading)return;
  clearClientKeySecret();
  const generation=clientKeysSecretGeneration;
  clientKeysBusy=true;clientKeysMessage=action==='rotate'?'clientKeyRotating':'clientKeyRevoking';renderClientKeys();
  try{
    const result=await api(currentRoutes.adminApiBasePath+'/client-keys/'+encodeURIComponent(id)+'/'+action,{method:'POST',body:'{}'});
    clientKeysData=clientKeysData.map((key)=>key.id===id?result.key:key);
    clientKeysMessage=action==='rotate'?'clientKeyRotated':'clientKeyRevokedDone';
    if(action==='rotate')revealClientKey(result,generation);
  }catch(error){clientKeysMessage=clientKeyErrorMessage(error,'clientKeySaveFailed');}
  finally{clientKeysBusy=false;renderClientKeys();}
}
el('clientKeyForm').addEventListener('submit',(event)=>{event.preventDefault();issueClientKey();});
el('clientKeysRefresh').addEventListener('click',()=>loadClientKeys());
el('clientKeyShow').addEventListener('click',()=>{
  const input=el('clientKeySecret');const show=input.type==='password';input.type=show?'text':'password';
  el('clientKeyShow').setAttribute('aria-pressed',String(show));el('clientKeyShow').textContent=t(show?'hideKey':'showKey');
});
el('clientKeyCopy').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(el('clientKeySecret').value);clientKeysMessage='clientKeyCopied';}
  catch{el('clientKeySecret').focus();el('clientKeySecret').select();clientKeysMessage='clientKeyCopyFailed';}
  renderClientKeys();
});
el('clientKeyDismiss').addEventListener('click',()=>{clearClientKeySecret();el('clientKeyName').focus();});
const clientKeysPreviousSwitchTab=switchTab;
switchTab=function(name){
  if(name!=='settings')clearClientKeySecret();
  clientKeysPreviousSwitchTab(name);
  if(name==='settings')loadClientKeys();
};
const clientKeysPreviousRenderSettings=renderSettings;
renderSettings=function(){clientKeysPreviousRenderSettings();renderClientKeys();};
window.addEventListener('pagehide',()=>clearClientKeySecret());
`;

module.exports = { clientKeysPanel, clientKeysBehavior };
