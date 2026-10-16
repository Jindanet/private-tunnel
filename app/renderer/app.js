'use strict';

const LANG_KEY = 'ptGuiLang';
const I18N = {
  en: {
    documentTitle: 'PrivateTunnel', setupBadge: 'WELCOME TO PRIVATETUNNEL', setupTitle: 'Your local app. One shareable link.',
    setupHero: 'Connect to your PrivateTunnel server, then share a website or game running on this computer.',
    fieldServerUrl: 'Server address', fieldToken: 'Access key',
    placeholderServerUrl: 'tunnel.example.com',
    placeholderToken: 'Paste the key from your server administrator',
    setupUrlHint: 'Paste the address exactly as provided. A hostname also works.',
    setupTokenHint: 'This key allows your computer to use the server. Keep it private.',
    saveAndContinue: 'Check connection and continue', saveServerProfile: 'Check and save',
    setupNote: "You'll choose what to share next. Saving these details does not start sharing.",
    openQuickGuide: 'I need help getting started', showKey: 'Show', hideKey: 'Hide', help: 'Help', settings: 'Settings', close: 'Close',
    serverLabel: 'Server', tokenSaved: 'Connection saved', tokenMissing: 'Setup needed',
    mainEyebrow: 'YOUR WORKSPACE', tunnelProfiles: 'Share from your computer',
    tunnelProfilesSub: 'Give your local website or game a public address.', emptyTitle: 'Your first link starts here',
    emptyStep1: 'Run your local app', emptyStep2: 'Enter its address', emptyStep3: 'Share the link',
    emptyDescription: 'Show someone your website or invite friends to your game. Your app stays on this computer.',
    quickStart: 'What would you like to share?', desktopApp: 'DESKTOP',
    setupStepConnect: 'Connect to your server', setupStepChoose: 'Choose a website or game', setupStepShare: 'Copy its public address',
    summarySharing: '{count} sharing', summaryNone: 'Nothing shared yet', openWebsite: 'Open website', editConnection: 'Edit connection',
    shareTcpAddress: 'Server address for your TCP app',
    addTunnel: 'Add service', keepOpen: 'Keep PrivateTunnel and your local app open while sharing.', addStep: 'NEW SHARED SERVICE',
    createTunnelProfile: 'What would you like to share?', createTunnelProfileSub: 'Choose the app, paste its local address, and we will create a public address.',
    serviceType: 'Service type', httpType: 'Website', httpTypeDesc: 'Website, API or webhook (HTTP)',
    tcpType: 'Game or TCP app', tcpTypeDesc: 'Minecraft Java, SSH or database', fieldLocalPort: 'Local address or port',
    placeholderPort: 'localhost:3000 or 3000', portHint: 'Paste your http://localhost address, or enter its port number.',
    fieldTcpPort: 'Game or app port', placeholderTcpPort: 'For example, 25565', tcpPortHint: 'Use the port from your game or app settings. Minecraft Java usually uses 25565.',
    fieldTunnelName: 'Name (optional)', placeholderTunnelName: 'For example, My website',
    advancedOptions: 'Name & custom address (optional)', advancedHint: 'The server chooses a public address when these fields are empty.',
    fieldPublishDomain: 'Public domain', placeholderPublishDomain: 'example.com (leave empty for automatic)',
    fieldHttpPublishMode: 'Address type', modeSubdomain: 'An address under the domain', modeRoot: 'The exact domain',
    fieldCustomHost: 'Address name (optional)', placeholderCustomHost: 'my-site',
    customHostHint: 'For example, my-site creates my-site.example.com.',
    check: 'Check', cancel: 'Cancel', saveAndStart: 'Start sharing', starting: 'Starting…', saving: 'Saving…',
    checkingServer: 'Checking the server address and access key…', checkingRoute: 'Checking the address with your server…',
    addCheckHint: 'The server will choose a public address automatically.',
    exposureNote: 'Anyone with the public address can reach this service. Only share services you want others to access.',
    invalidPort: 'Enter a port from 1 to 65535 or a local HTTP address, such as localhost:3000. HTTPS and remote addresses are not supported.',
    desiredTooShort: 'Use 3 to 63 characters for the address name.',
    desiredPattern: 'Use a-z, 0-9 and hyphens. Do not start or end with a hyphen.',
    saveProfileFirst: 'Open Settings and save the server address and access key first.',
    profileSaved: 'Settings saved. You can now add a service.',
    profileUpdated: 'Settings saved. They will be used the next time you start a service.',
    serverProfile: 'Server settings', serverProfileSub: 'Saved details are used the next time you start a service.',
    start: 'Start sharing', retry: 'Try again', stop: 'Stop sharing', delete: 'Remove',
    deleteConfirm: 'Remove "{name}"? Sharing will stop and its saved settings will be deleted.',
    copy: 'Copy address', copied: 'Address copied',
    statusStopped: 'Stopped', statusOnline: 'Sharing', statusConnecting: 'Connecting', statusReconnecting: 'Reconnecting', statusError: 'Needs attention',
    notStarted: 'Your public address will appear here when you start sharing.',
    reconnectingHint: 'Reconnecting to the server. The address will return when the connection is ready.',
    shareAddress: 'Public address', localTarget: '{type} · localhost:{port}', customAddress: 'Requested address: {host}',
    recentActivity: 'Recent activity', noActivity: 'No requests yet.',
    trySettings: 'Check your local service and server settings, then try again.',
    requestFailed: 'The action could not be completed. Please try again.',
    configLoadFailed: 'Could not load your saved settings. Close and reopen PrivateTunnel, then try again.',
    checkFailed: 'Could not check this address. Check the server address and access key in Settings.',
    checkTimeout: 'The server did not respond in time. Check your connection and try again.',
    invalidKey: 'The server rejected the access key. Open Settings and paste the key from your server administrator.',
    unreachableServer: 'Could not reach the server. Check your internet connection and the server address.',
    requiredServer: 'Enter the server address from your server administrator.',
    invalidServer: 'Enter a valid server hostname or a ws:// or wss:// address.',
    requiredKey: 'Paste the access key from your server administrator.', shortKey: 'The access key looks incomplete. Paste the full key.',
    portPresets: 'Common ports', servicesLabel: 'Shared services',
    howToUse: 'Getting started', guideWebsite: 'Website', guideGame: 'Minecraft', guideSsh: 'SSH',
    guideCommon: 'First, save the server address and access key supplied by your server administrator.',
    guideKeepOpen: 'Keep PrivateTunnel and your local service open while sharing. Stop sharing when you are finished.',
    guideWebsite1: 'Open your local website',
    guideWebsite1Body: 'Check that the website works in your browser, for example at http://localhost:3000. The number after the colon is its port.',
    guideWebsite2: 'Add the website',
    guideWebsite2Body: 'Choose Add service, select Website and enter that port. Leave Custom address empty unless your administrator gave you specific settings.',
    guideWebsite3: 'Start sharing and copy the address',
    guideWebsite3Body: 'When the status says Sharing, copy the public address. Other people can open it in a browser.',
    guideGame1: 'Start Minecraft Java Edition',
    guideGame1Body: 'Run a Java Edition server on your computer and note its port. The usual port is 25565.',
    guideGame2: 'Choose TCP service',
    guideGame2Body: 'Choose Add service, select TCP service, then choose the Minecraft Java preset.',
    guideGame3: 'Share the server address',
    guideGame3Body: 'Copy the address including its port and give it to players. This app supports TCP. Minecraft Bedrock and games that require UDP are not supported.',
    guideSsh1: 'Check SSH on your computer', guideSsh1Body: 'Enable SSH and confirm that you can connect locally. Its usual port is 22.',
    guideSsh2: 'Add a TCP service', guideSsh2Body: 'Choose Add service, select TCP service and choose SSH. Start sharing and copy the public address.',
    guideSsh3: 'Connect using the assigned port',
    guideSsh3Body: 'Use the host and port in the copied address with your SSH client. Keep SSH authentication enabled.',
  },
  th: {
    documentTitle: 'PrivateTunnel', setupBadge: 'ยินดีต้อนรับสู่ PRIVATETUNNEL', setupTitle: 'แชร์เว็บในเครื่อง ด้วยลิงก์เดียว',
    setupHero: 'เชื่อมต่อเซิร์ฟเวอร์ PrivateTunnel แล้วเลือกเว็บไซต์หรือเกมในเครื่องที่ต้องการแชร์',
    fieldServerUrl: 'ที่อยู่เซิร์ฟเวอร์', fieldToken: 'กุญแจเข้าใช้งาน (Access key)',
    placeholderServerUrl: 'tunnel.example.com',
    placeholderToken: 'วางกุญแจที่ได้รับจากผู้ดูแลเซิร์ฟเวอร์',
    setupUrlHint: 'วางที่อยู่ตามที่ได้รับมา หรือกรอกชื่อโฮสต์ของเซิร์ฟเวอร์',
    setupTokenHint: 'กุญแจนี้อนุญาตให้เครื่องของคุณใช้เซิร์ฟเวอร์ได้ ควรเก็บเป็นความลับ',
    saveAndContinue: 'ตรวจสอบและไปต่อ', saveServerProfile: 'ตรวจสอบและบันทึก',
    setupNote: 'ขั้นตอนถัดไปจะให้เลือกสิ่งที่ต้องการแชร์ การบันทึกข้อมูลนี้ยังไม่เริ่มแชร์',
    openQuickGuide: 'ดูวิธีเริ่มใช้งาน', showKey: 'แสดง', hideKey: 'ซ่อน', help: 'วิธีใช้', settings: 'ตั้งค่า', close: 'ปิด',
    serverLabel: 'เซิร์ฟเวอร์', tokenSaved: 'บันทึกข้อมูลแล้ว', tokenMissing: 'ต้องตั้งค่า',
    mainEyebrow: 'พื้นที่ของคุณ', tunnelProfiles: 'แชร์จากเครื่องนี้',
    tunnelProfilesSub: 'ให้คนอื่นเปิดเว็บไซต์หรือเข้าเกมที่รันอยู่ในเครื่องคุณ', emptyTitle: 'สร้างลิงก์แรกของคุณ',
    emptyStep1: 'เปิดแอปในเครื่อง', emptyStep2: 'ใส่ที่อยู่ในเครื่อง', emptyStep3: 'ส่งลิงก์ให้ผู้อื่น',
    emptyDescription: 'ส่งเว็บให้คนอื่นลอง หรือชวนเพื่อนเข้าเกม โดยแอปยังทำงานอยู่บนคอมพิวเตอร์ของคุณ',
    quickStart: 'เลือกสิ่งที่ต้องการแชร์', desktopApp: 'DESKTOP',
    setupStepConnect: 'เชื่อมต่อเซิร์ฟเวอร์', setupStepChoose: 'เลือกเว็บไซต์หรือเกม', setupStepShare: 'คัดลอกที่อยู่ไปแชร์',
    summarySharing: 'กำลังแชร์ {count} รายการ', summaryNone: 'ยังไม่ได้แชร์', openWebsite: 'เปิดเว็บ', editConnection: 'แก้ไขการเชื่อมต่อ',
    shareTcpAddress: 'ที่อยู่สำหรับเชื่อมต่อแอป TCP',
    addTunnel: 'เพิ่มรายการ', keepOpen: 'เปิด PrivateTunnel และแอปในเครื่องไว้ตลอดช่วงที่แชร์', addStep: 'เพิ่มรายการแชร์',
    createTunnelProfile: 'ต้องการแชร์อะไร?', createTunnelProfileSub: 'เลือกแอป วางที่อยู่ในเครื่อง แล้วรับที่อยู่สำหรับส่งให้ผู้อื่น',
    serviceType: 'ประเภทบริการ', httpType: 'เว็บไซต์', httpTypeDesc: 'เว็บไซต์, API หรือเว็บฮุก (HTTP)',
    tcpType: 'เกมหรือแอป TCP', tcpTypeDesc: 'Minecraft Java, SSH หรือฐานข้อมูล', fieldLocalPort: 'ที่อยู่ในเครื่อง หรือหมายเลขพอร์ต',
    placeholderPort: 'localhost:3000 หรือ 3000', portHint: 'วางที่อยู่ http://localhost ของเว็บ หรือกรอกเฉพาะหมายเลขพอร์ต',
    fieldTcpPort: 'พอร์ตของเกมหรือแอป', placeholderTcpPort: 'เช่น 25565', tcpPortHint: 'ใช้พอร์ตที่ตั้งไว้ในเกมหรือแอป โดย Minecraft Java มักใช้ 25565',
    fieldTunnelName: 'ชื่อบริการ (ไม่จำเป็น)', placeholderTunnelName: 'เช่น เว็บไซต์ของฉัน',
    advancedOptions: 'ชื่อและที่อยู่แบบกำหนดเอง (ไม่จำเป็น)', advancedHint: 'ปล่อยว่างเพื่อให้เซิร์ฟเวอร์เลือกที่อยู่ให้อัตโนมัติ',
    fieldPublishDomain: 'โดเมนสาธารณะ', placeholderPublishDomain: 'example.com (ปล่อยว่างเพื่อเลือกอัตโนมัติ)',
    fieldHttpPublishMode: 'รูปแบบที่อยู่', modeSubdomain: 'ที่อยู่ย่อยภายใต้โดเมน', modeRoot: 'ใช้ชื่อโดเมนตรงตัว',
    fieldCustomHost: 'ชื่อในที่อยู่ (ไม่จำเป็น)', placeholderCustomHost: 'my-site',
    customHostHint: 'เช่น my-site จะได้ที่อยู่ my-site.example.com',
    check: 'ตรวจสอบ', cancel: 'ยกเลิก', saveAndStart: 'เริ่มแชร์', starting: 'กำลังเริ่มแชร์…', saving: 'กำลังบันทึก…',
    checkingServer: 'กำลังตรวจสอบที่อยู่เซิร์ฟเวอร์และกุญแจเข้าใช้งาน…', checkingRoute: 'กำลังตรวจสอบที่อยู่กับเซิร์ฟเวอร์…',
    addCheckHint: 'เซิร์ฟเวอร์จะเลือกที่อยู่สาธารณะให้อัตโนมัติ',
    exposureNote: 'ผู้ที่มีที่อยู่สาธารณะจะเข้าถึงบริการนี้ได้ เลือกแชร์เฉพาะบริการที่ต้องการให้ผู้อื่นเข้าถึง',
    invalidPort: 'กรอกพอร์ต 1 ถึง 65535 หรือที่อยู่เว็บในเครื่อง เช่น localhost:3000 ยังไม่รองรับ HTTPS หรือที่อยู่เครื่องอื่น',
    desiredTooShort: 'ชื่อในที่อยู่ต้องยาว 3 ถึง 63 ตัวอักษร',
    desiredPattern: 'ใช้ a-z, 0-9 และขีดกลาง ห้ามขึ้นต้นหรือลงท้ายด้วยขีดกลาง',
    saveProfileFirst: 'เปิดหน้าตั้งค่า แล้วบันทึกที่อยู่เซิร์ฟเวอร์และกุญแจเข้าใช้งานก่อน',
    profileSaved: 'บันทึกการตั้งค่าแล้ว เพิ่มบริการเพื่อเริ่มแชร์ได้เลย',
    profileUpdated: 'บันทึกแล้ว ระบบจะใช้ข้อมูลนี้ในการเริ่มแชร์ครั้งถัดไป',
    serverProfile: 'ตั้งค่าเซิร์ฟเวอร์', serverProfileSub: 'ระบบจะใช้ข้อมูลที่บันทึกไว้ในการเริ่มแชร์ครั้งถัดไป',
    start: 'เริ่มแชร์', retry: 'ลองอีกครั้ง', stop: 'หยุดแชร์', delete: 'ลบ',
    deleteConfirm: 'ลบบริการ “{name}” หรือไม่? ระบบจะหยุดแชร์และลบการตั้งค่าที่บันทึกไว้ของบริการนี้',
    copy: 'คัดลอกที่อยู่', copied: 'คัดลอกที่อยู่แล้ว',
    statusStopped: 'หยุดอยู่', statusOnline: 'กำลังแชร์', statusConnecting: 'กำลังเชื่อมต่อ', statusReconnecting: 'กำลังเชื่อมต่อใหม่', statusError: 'ต้องแก้ไข',
    notStarted: 'ที่อยู่สาธารณะจะปรากฏที่นี่หลังเริ่มแชร์',
    reconnectingHint: 'กำลังเชื่อมต่อเซิร์ฟเวอร์ใหม่ ที่อยู่จะแสดงเมื่อพร้อมใช้งาน',
    shareAddress: 'ที่อยู่สาธารณะ', localTarget: '{type} · localhost:{port}', customAddress: 'ที่อยู่ที่เลือก: {host}',
    recentActivity: 'การใช้งานล่าสุด', noActivity: 'ยังไม่มีคำขอเข้ามา',
    trySettings: 'ตรวจสอบบริการในเครื่องและการตั้งค่าเซิร์ฟเวอร์ แล้วลองอีกครั้ง',
    requestFailed: 'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง',
    configLoadFailed: 'โหลดการตั้งค่าที่บันทึกไว้ไม่ได้ กรุณาปิดและเปิด PrivateTunnel ใหม่ แล้วลองอีกครั้ง',
    checkFailed: 'ตรวจสอบที่อยู่นี้ไม่ได้ กรุณาตรวจสอบที่อยู่เซิร์ฟเวอร์และกุญแจในหน้าตั้งค่า',
    checkTimeout: 'เซิร์ฟเวอร์ไม่ตอบกลับตามเวลาที่กำหนด ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง',
    invalidKey: 'เซิร์ฟเวอร์ปฏิเสธกุญแจเข้าใช้งาน เปิดหน้าตั้งค่าแล้ววางกุญแจที่ได้รับจากผู้ดูแลเซิร์ฟเวอร์',
    unreachableServer: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตและที่อยู่เซิร์ฟเวอร์',
    requiredServer: 'กรอกที่อยู่เซิร์ฟเวอร์ที่ได้รับจากผู้ดูแล',
    invalidServer: 'กรอกชื่อโฮสต์หรือที่อยู่ที่ขึ้นต้นด้วย ws:// หรือ wss:// ให้ถูกต้อง',
    requiredKey: 'วางกุญแจเข้าใช้งานที่ได้รับจากผู้ดูแลเซิร์ฟเวอร์', shortKey: 'กุญแจเข้าใช้งานดูไม่ครบ กรุณาวางกุญแจแบบเต็ม',
    portPresets: 'พอร์ตที่ใช้บ่อย', servicesLabel: 'บริการที่แชร์',
    howToUse: 'วิธีเริ่มใช้งาน', guideWebsite: 'เว็บไซต์', guideGame: 'Minecraft', guideSsh: 'SSH',
    guideCommon: 'เริ่มจากบันทึกที่อยู่เซิร์ฟเวอร์และกุญแจเข้าใช้งานที่ได้รับจากผู้ดูแลเซิร์ฟเวอร์',
    guideKeepOpen: 'เปิด PrivateTunnel และบริการในเครื่องไว้ตลอดช่วงที่แชร์ เมื่อใช้เสร็จให้กดหยุดแชร์',
    guideWebsite1: 'เปิดเว็บไซต์ในเครื่อง',
    guideWebsite1Body: 'ตรวจว่าเว็บไซต์เปิดในเบราว์เซอร์ได้ เช่น http://localhost:3000 ตัวเลขหลังเครื่องหมาย : คือพอร์ต',
    guideWebsite2: 'เพิ่มเว็บไซต์',
    guideWebsite2Body: 'กดเพิ่มรายการ เลือกเว็บไซต์ แล้ววางที่อยู่ localhost หรือกรอกพอร์ต ปล่อยตัวเลือกขั้นสูงว่างไว้ได้',
    guideWebsite3: 'เริ่มแชร์และคัดลอกที่อยู่',
    guideWebsite3Body: 'เมื่อสถานะแสดงว่ากำลังแชร์ ให้คัดลอกที่อยู่สาธารณะ ผู้อื่นสามารถเปิดที่อยู่นั้นในเบราว์เซอร์ได้',
    guideGame1: 'เปิดเซิร์ฟเวอร์ Minecraft Java Edition',
    guideGame1Body: 'เริ่มเซิร์ฟเวอร์ Java Edition ในเครื่องและดูพอร์ตที่ใช้ โดยทั่วไปคือ 25565',
    guideGame2: 'เลือกเกมหรือแอป TCP', guideGame2Body: 'กดเพิ่มรายการ เลือกเกมหรือแอป TCP แล้วกดตัวเลือก Minecraft Java',
    guideGame3: 'ส่งที่อยู่ให้ผู้เล่น',
    guideGame3Body: 'คัดลอกที่อยู่พร้อมหมายเลขพอร์ตให้ผู้เล่น แอปนี้รองรับ TCP จึงยังไม่รองรับ Minecraft Bedrock หรือเกมที่ต้องใช้ UDP',
    guideSsh1: 'ตรวจสอบ SSH ในเครื่อง', guideSsh1Body: 'เปิดใช้งาน SSH และทดสอบว่าเชื่อมต่อในเครื่องได้ พอร์ตทั่วไปคือ 22',
    guideSsh2: 'เพิ่มแอป TCP', guideSsh2Body: 'กดเพิ่มรายการ เลือกเกมหรือแอป TCP แล้วกด SSH จากนั้นเริ่มแชร์และคัดลอกที่อยู่สาธารณะ',
    guideSsh3: 'เชื่อมต่อด้วยพอร์ตที่ได้รับ',
    guideSsh3Body: 'ใช้ชื่อโฮสต์และพอร์ตในที่อยู่ที่คัดลอกกับโปรแกรม SSH โดยคงการยืนยันตัวตนของ SSH ไว้',
  },
};

const $ = (id) => document.getElementById(id);
const compactLayout = window.matchMedia('(max-width: 760px)');
const text = (value, limit = 2000) => String(value ?? '').slice(0, limit);
let currentLang = /^th\b/i.test(navigator.language || '') ? 'th' : 'en';
try {
  const savedLanguage = localStorage.getItem(LANG_KEY);
  if (savedLanguage === 'en' || savedLanguage === 'th') currentLang = savedLanguage;
} catch { /* Language still works when local storage is unavailable. */ }
let config = { tunnels: [] };
const states = new Map();
const pendingActions = new Set();
const savingProfiles = new Set();
const rememberedStatus = { setup: null, settings: null, addCheck: { kind: 'hint', key: 'addCheckHint' } };
let selType = 'http';
let activeGuideTab = 'website';
let addCheckTimer = null;
let addCheckVersion = 0;
let addClientId = '';
let addSubmitting = false;

function t(key, vars = {}) {
  let value = I18N[currentLang][key] || I18N.en[key] || key;
  for (const [name, replacement] of Object.entries(vars)) value = value.split('{' + name + '}').join(text(replacement));
  return value;
}

function node(tag, className, content) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (content !== undefined) result.textContent = text(content);
  return result;
}

function translateRuntimeText(message) {
  const raw = text(message instanceof Error ? message.message : message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  const keys = {
    'Server WebSocket URL is required.': 'requiredServer',
    'Server URL must start with ws:// or wss://.': 'invalidServer',
    'Enter a valid server hostname or WebSocket URL.': 'invalidServer',
    'Access token is required before this GUI can create tunnels.': 'requiredKey',
    'Access token looks too short. Paste the full token from the server hoster.': 'shortKey',
    'The saved token is invalid for this server.': 'invalidKey',
    'The saved token is invalid for this server profile.': 'invalidKey',
    'Save the server profile first. This GUI requires both server URL and token.': 'saveProfileFirst',
    'Save the server profile first before checking custom host names.': 'saveProfileFirst',
    'Enter a valid local port between 1 and 65535.': 'invalidPort',
    'Could not validate this tunnel configuration.': 'checkFailed',
    'The server did not respond to the host-name check in time.': 'checkTimeout',
    'The server closed the connection before returning a host-name check result.': 'checkFailed',
    'Could not understand the server response while checking this host name.': 'checkFailed',
    'Custom host name must be 3-63 characters, use only a-z, 0-9, or -, and cannot start/end with -.': 'desiredPattern',
    'Random subdomain mode is ready.': 'addCheckHint',
    'Random subdomain mode is ready. The server will assign a free public host when you start this tunnel.': 'addCheckHint',
  };
  if (keys[raw]) return t(keys[raw]);
  if (/^(Could not reach the server|connect E|WebSocket.*closed|Opening handshake has timed out)/i.test(raw)) return t('unreachableServer');
  if (currentLang === 'th') {
    const localPort = raw.match(/^Your local app is not running on port (\d+)\. Open it first, then try again\.$/);
    if (localPort) return 'ยังไม่มีบริการเปิดอยู่ที่พอร์ต ' + localPort[1] + ' กรุณาเปิดเว็บไซต์หรือบริการในเครื่องก่อน แล้วลองอีกครั้ง';
    let match = raw.match(/^The host (.+) is available\. PrivateTunnel will remember this host name in the saved tunnel profile\.$/);
    if (match) return 'ที่อยู่ ' + match[1] + ' ใช้งานได้ ระบบจะบันทึกที่อยู่นี้ไว้';
    match = raw.match(/^The host (.+) is already reserved for this client profile and will be reused\.$/);
    if (match) return 'ที่อยู่ ' + match[1] + ' ถูกจองไว้ให้บริการนี้แล้ว และจะใช้ที่อยู่เดิม';
    match = raw.match(/^The (?:custom host name|root host) (.+) is already (?:used by another live tunnel(?: right now)?|reserved by another client profile)\.$/);
    if (match) return 'ที่อยู่ ' + match[1] + ' ถูกใช้งานแล้ว กรุณาเลือกชื่ออื่น';
    match = raw.match(/^TCP tunnels will publish on (.+) with an allocated TCP port when you start the tunnel\.$/);
    if (match) return 'บริการ TCP จะใช้โดเมน ' + match[1] + ' โดยระบบจะกำหนดพอร์ตให้เมื่อเริ่มแชร์';
    if (raw === 'Enter a valid publish domain.') return 'กรอกชื่อโดเมนสาธารณะให้ถูกต้อง หรือปล่อยว่างเพื่อเลือกอัตโนมัติ';
    if (raw === 'Name must be 100 characters or fewer.') return 'ชื่อบริการต้องไม่เกิน 100 ตัวอักษร';
    if (raw === 'Tunnel not found') return 'ไม่พบบริการนี้ กรุณาปิดและเปิดแอปใหม่';
  }
  return raw || t('requestFailed');
}

function renderStatus(id, payload, className = 'form-status') {
  const target = $(id);
  target.className = className + (payload?.kind ? ' ' + payload.kind : '');
  target.textContent = payload ? (payload.key ? t(payload.key, payload.vars) : translateRuntimeText(payload.message)) : '';
  target.setAttribute('role', payload?.kind === 'error' ? 'alert' : 'status');
}

function setRememberedStatus(name, payload) {
  rememberedStatus[name] = payload;
  renderStatus(name === 'addCheck' ? 'add-check-status' : name + '-status', payload, name === 'addCheck' ? 'check-status' : 'form-status');
}

function setFieldError(inputId, message) {
  const input = $(inputId);
  const error = $(inputId + '-error');
  input.classList.toggle('field-invalid', Boolean(message));
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (error) error.textContent = message ? translateRuntimeText(message) : '';
}

function applyI18n() {
  document.documentElement.lang = currentLang;
  document.title = t('documentTitle');
  document.querySelectorAll('[data-i18n]').forEach((item) => { item.textContent = t(item.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((item) => { item.placeholder = t(item.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-label]').forEach((item) => { item.setAttribute('aria-label', t(item.dataset.i18nLabel)); });
  document.querySelectorAll('[data-lang]').forEach((item) => {
    const active = item.dataset.lang === currentLang;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-toggle-password]').forEach(updatePasswordButton);
  for (const [name, payload] of Object.entries(rememberedStatus)) {
    renderStatus(name === 'addCheck' ? 'add-check-status' : name + '-status', payload, name === 'addCheck' ? 'check-status' : 'form-status');
  }
  for (const prefix of savingProfiles) $(prefix === 'setup' ? 'setup-connect-btn' : 'save-settings-btn').textContent = t('saving');
  if (addSubmitting) $('confirm-add-btn').textContent = t('starting');
  $('presets').setAttribute('aria-label', t('portPresets'));
  $('tunnel-list').setAttribute('aria-label', t('servicesLabel'));
  updateServerMeta();
  renderList();
  renderPresets();
  updatePublishModeVisibility();
  showGuide(activeGuideTab);
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => {
    const visible = view.id === 'view-' + name;
    view.hidden = !visible;
    view.inert = !visible;
  });
}

function openPanel(id) {
  const panel = $(id);
  if (panel.open) return;
  panel._returnFocus = document.activeElement;
  const inline = id === 'panel-add';
  panel.setAttribute('aria-modal', String(!inline));
  if (inline) {
    panel.show();
    $('workspace').inert = true;
    syncEditorNavigation();
  } else panel.showModal();
  panel.scrollTop = 0;
  const focusId = id === 'panel-add' ? 'add-port' : id === 'panel-settings' ? 'settings-url' : 'tab-' + activeGuideTab;
  $(focusId)?.focus({ preventScroll: true });
}

function closePanel(id, force = false) {
  if (!force && ((id === 'panel-add' && addSubmitting) || (id === 'panel-settings' && savingProfiles.has('settings')))) return;
  const panel = $(id);
  if (!panel.open) return;
  if (id === 'panel-add') { $('workspace').inert = false; document.querySelector('.sidebar').inert = false; }
  panel.close();
  if (panel._returnFocus?.isConnected) panel._returnFocus.focus({ preventScroll: true });
}

document.querySelectorAll('dialog').forEach((panel) => {
  panel.addEventListener('cancel', (event) => {
    event.preventDefault();
    closePanel(panel.id);
  });
  panel.addEventListener('click', (event) => {
    if (event.target !== panel) return;
    const rect = panel.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePanel(panel.id);
  });
  panel.addEventListener('close', () => {
    // A queued close event may arrive after this editor has already reopened.
    if (panel.open) return;
    if (panel.id === 'panel-add') { invalidateAddCheck(); $('workspace').inert = false; syncEditorNavigation(); }
    if (panel.id === 'panel-settings') hidePassword('settings-token');
    if (document.activeElement === document.body && panel._returnFocus?.isConnected) panel._returnFocus.focus({ preventScroll: true });
  });
});

function syncEditorNavigation() {
  const sidebar = document.querySelector('.sidebar');
  const covered = $('panel-add').open && compactLayout.matches;
  const moveFocus = covered && sidebar.contains(document.activeElement);
  sidebar.inert = covered;
  if (moveFocus) $('add-port').focus({ preventScroll: true });
}
compactLayout.addEventListener('change', syncEditorNavigation);

function updateServerMeta() {
  const server = $('server-url-text');
  let display = config.serverUrl || '';
  try { display = new URL(config.serverUrl).host; } catch { /* Invalid saved profiles can still be edited. */ }
  server.textContent = display;
  server.title = config.serverUrl || '';
  const online = (config.tunnels || []).filter((tunnel) => states.get(tunnel.id)?.status === 'online').length;
  $('server-token-state').textContent = online ? t('summarySharing', { count: online }) : t(config.token ? 'tokenSaved' : 'tokenMissing');
}

function setFormBusy(formId, busy) {
  const form = $(formId);
  form.setAttribute('aria-busy', String(busy));
  form.querySelectorAll('input,select,button').forEach((item) => { item.disabled = busy; });
}

function applyProfileErrors(prefix, errors = {}) {
  setFieldError(prefix + '-url', errors.serverUrl || '');
  setFieldError(prefix + '-token', errors.token || '');
}

async function saveProfile(prefix) {
  if (savingProfiles.has(prefix)) return false;
  savingProfiles.add(prefix);
  const button = $(prefix === 'setup' ? 'setup-connect-btn' : 'save-settings-btn');
  const payload = { serverUrl: $(prefix + '-url').value.trim(), token: $(prefix + '-token').value.trim() };
  applyProfileErrors(prefix);
  setFormBusy(prefix + '-form', true);
  button.textContent = t('saving');
  setRememberedStatus(prefix, { kind: 'pending', key: 'checkingServer' });
  let focusInput = '';
  try {
    const validation = await window.api.validateServerProfile(payload);
    if (!validation?.ok) {
      applyProfileErrors(prefix, validation?.errors);
      focusInput = validation?.errors?.serverUrl ? prefix + '-url' : prefix + '-token';
      setRememberedStatus(prefix, null);
      return false;
    }
    if (validation.normalizedUrl) {
      payload.serverUrl = validation.normalizedUrl;
      $(prefix + '-url').value = payload.serverUrl;
    }
    if (typeof window.api.testServerProfile === 'function') {
      const check = await window.api.testServerProfile(payload);
      if (!check?.ok) {
        if (check?.errors) {
          applyProfileErrors(prefix, check.errors);
          focusInput = check.errors.serverUrl ? prefix + '-url' : check.errors.token ? prefix + '-token' : '';
        }
        setRememberedStatus(prefix, { kind: 'error', message: check?.message || t('unreachableServer') });
        return false;
      }
    }
    const result = await window.api.saveServerProfile(payload);
    if (!result?.ok) {
      applyProfileErrors(prefix, result?.errors);
      focusInput = result?.errors?.serverUrl ? prefix + '-url' : result?.errors?.token ? prefix + '-token' : '';
      setRememberedStatus(prefix, { kind: 'error', message: result?.message || t('requestFailed') });
      return false;
    }
    config.serverUrl = result.serverUrl || payload.serverUrl;
    config.token = payload.token;
    invalidateAddCheck();
    updateServerMeta();
    hidePassword(prefix + '-token');
    setRememberedStatus(prefix, { kind: 'success', key: prefix === 'setup' ? 'profileSaved' : 'profileUpdated' });
    if (prefix === 'setup') {
      showView('main');
      $('add-tunnel-btn').focus();
    }
    return true;
  } catch (error) {
    setRememberedStatus(prefix, { kind: 'error', message: error.message || t('requestFailed') });
    return false;
  } finally {
    savingProfiles.delete(prefix);
    setFormBusy(prefix + '-form', false);
    button.textContent = t(prefix === 'setup' ? 'saveAndContinue' : 'saveServerProfile');
    if (focusInput) $(focusInput).focus();
  }
}

function actionButton(label, className, action, tunnel, handler) {
  const result = node('button', className, label);
  result.type = 'button';
  result.dataset.action = action;
  result.dataset.tunnelId = tunnel.id;
  result.setAttribute('aria-label', label + ': ' + tunnel.name);
  result.disabled = pendingActions.has(tunnel.id);
  result.addEventListener('click', handler);
  return result;
}

function captureCardFocus() {
  const active = document.activeElement;
  const card = active?.closest('.tcard');
  return card && active.dataset.action ? { id: card.dataset.tunnelId, action: active.dataset.action } : null;
}

function restoreCardFocus(focus) {
  if (!focus) return;
  const card = $('card-' + focus.id);
  const target = card && [...card.querySelectorAll('[data-action]')].find((item) => item.dataset.action === focus.action);
  target?.focus({ preventScroll: true });
}

function makeCard(tunnel) {
  const state = states.get(tunnel.id) || { status: 'stopped', url: '', requests: [] };
  const status = ['online', 'reconnecting', 'connecting', 'error'].includes(state.status) ? state.status : 'stopped';
  const running = ['online', 'reconnecting', 'connecting'].includes(status);
  const card = node('article', 'tcard ' + status);
  card.id = 'card-' + tunnel.id;
  card.dataset.tunnelId = tunnel.id;
  const top = node('div', 'tcard-top');
  const identity = node('div', 'tcard-identity');
  const icon = node('span', 'service-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(node('span', 'ui-icon ' + (tunnel.type === 'tcp' ? 'icon-game' : 'icon-window')));
  const heading = node('div', 'tcard-left');
  heading.append(node('h2', 'tcard-name', tunnel.name || (tunnel.type === 'tcp' ? 'TCP' : 'HTTP') + ' :' + tunnel.port));
  heading.append(node('p', 'tcard-port', t('localTarget', { type: tunnel.type === 'tcp' ? t('tcpType') : t('httpType'), port: tunnel.port })));
  if (tunnel.publishMode === 'root' && tunnel.publishDomain) {
    heading.append(node('p', 'tcard-port', t('customAddress', { host: tunnel.publishDomain })));
  } else if (tunnel.desiredSubdomain) {
    heading.append(node('p', 'tcard-port', t('customAddress', { host: tunnel.desiredSubdomain + (tunnel.publishDomain ? '.' + tunnel.publishDomain : '') })));
  }
  const statusLabel = node('span', 'status-label ' + status, t('status' + status[0].toUpperCase() + status.slice(1)));
  statusLabel.setAttribute('role', 'status');
  identity.append(icon, heading);
  top.append(identity, statusLabel);
  card.append(top);
  const address = node('div', 'tcard-url');
  if (status === 'online' && state.url) {
    address.append(node('span', 'share-label', t(tunnel.type === 'tcp' ? 'shareTcpAddress' : 'shareAddress')));
    const share = node('div', 'share-address');
    let canOpen = false;
    try { const url = new URL(state.url); canOpen = tunnel.type === 'http' && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { /* TCP addresses are copy-only. */ }
    const urlText = node(canOpen ? 'a' : 'span', 'url-text' + (canOpen ? '' : ' plain'), state.url);
    if (canOpen) {
      urlText.href = state.url;
      urlText.dataset.action = 'open';
      urlText.addEventListener('click', async (event) => {
        event.preventDefault();
        try { await window.api.openExternal(state.url); } catch (error) { toast(error.message); }
      });
    }
    const shareActions = node('div', 'share-actions');
    shareActions.append(actionButton(t('copy'), 'copy-btn', 'copy', tunnel, async () => {
      try { await window.api.copyText(state.url); toast(t('copied')); } catch (error) { toast(error.message); }
    }));
    if (canOpen) shareActions.append(actionButton(t('openWebsite'), 'open-btn', 'open-website', tunnel, async () => {
      try { await window.api.openExternal(state.url); } catch (error) { toast(error.message); }
    }));
    share.append(urlText, shareActions);
    address.append(share);
  } else if (state.error) {
    const error = node('div', 'url-error', translateRuntimeText(state.error));
    error.setAttribute('role', 'alert');
    if (/token|key|profile|server|auth/i.test(state.error)) {
      const recovery = node('button', 'recovery-button', t('editConnection'));
      recovery.type = 'button';
      recovery.dataset.action = 'settings';
      recovery.addEventListener('click', openSettings);
      error.append(recovery);
    }
    address.append(error);
  } else {
    address.append(node('p', 'url-none', t(running ? 'reconnectingHint' : 'notStarted')));
  }
  if (state.actionError) {
    const error = node('p', 'url-error', translateRuntimeText(state.actionError));
    error.setAttribute('role', 'alert');
    address.append(error);
  }
  card.append(address);
  const actions = node('div', 'tcard-actions');
  actions.append(running
    ? actionButton(t('stop'), 'btn-stop', 'stop', tunnel, () => doStop(tunnel.id))
    : actionButton(t(status === 'error' ? 'retry' : 'start'), 'btn-start', 'start', tunnel, () => doStart(tunnel.id)));
  actions.append(actionButton(t('delete'), 'btn-del', 'delete', tunnel, () => doDel(tunnel.id)));
  card.append(actions);
  if (state.requests?.length) {
    const details = node('details', 'request-details');
    details.open = Boolean(state.logOpen);
    details.addEventListener('toggle', () => { state.logOpen = details.open; });
    const summary = node('summary', '', t('recentActivity'));
    summary.dataset.action = 'logs';
    const log = node('div', 'tcard-log');
    log.id = 'log-' + tunnel.id;
    renderLog(log, state.requests);
    details.append(summary, log);
    card.append(details);
  }
  return card;
}

function renderList() {
  const focus = captureCardFocus();
  const list = $('tunnel-list');
  list.querySelectorAll('.tcard').forEach((card) => card.remove());
  const tunnels = config.tunnels || [];
  $('empty-state').hidden = tunnels.length > 0;
  for (const tunnel of tunnels) list.append(makeCard(tunnel));
  updateSharingSummary();
  updateDot();
  restoreCardFocus(focus);
}

function refreshCard(id) {
  const old = $('card-' + id);
  const tunnel = (config.tunnels || []).find((item) => item.id === id);
  if (!old || !tunnel) return;
  const focus = captureCardFocus();
  old.replaceWith(makeCard(tunnel));
  updateSharingSummary();
  restoreCardFocus(focus);
}

function stateFor(id) {
  if (!states.has(id)) states.set(id, { status: 'stopped', url: '', requests: [] });
  return states.get(id);
}

async function doStart(id) {
  if (pendingActions.has(id)) return;
  pendingActions.add(id);
  const state = stateFor(id);
  Object.assign(state, { status: 'connecting', url: '', error: null, actionError: null });
  refreshCard(id);
  updateDot();
  try {
    const result = await window.api.startTunnel(id);
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    Object.assign(state, { status: 'error', url: '', error: error.message || t('requestFailed') });
  } finally {
    pendingActions.delete(id);
    refreshCard(id);
    updateDot();
  }
}

async function doStop(id) {
  if (pendingActions.has(id)) return;
  pendingActions.add(id);
  const state = stateFor(id);
  state.actionError = null;
  refreshCard(id);
  try {
    const result = await window.api.stopTunnel(id);
    if (result?.error) throw new Error(result.error);
    Object.assign(state, { status: 'stopped', url: '', error: null });
  } catch (error) {
    state.actionError = error.message || t('requestFailed');
  } finally {
    pendingActions.delete(id);
    refreshCard(id);
    updateDot();
  }
}

async function doDel(id) {
  if (pendingActions.has(id)) return;
  const tunnel = (config.tunnels || []).find((item) => item.id === id);
  if (!tunnel || !window.confirm(t('deleteConfirm', { name: tunnel.name }))) return;
  pendingActions.add(id);
  refreshCard(id);
  try {
    const result = await window.api.deleteTunnel(id);
    if (result?.error) throw new Error(result.error);
    config.tunnels = config.tunnels.filter((item) => item.id !== id);
    states.delete(id);
    renderList();
    $('add-tunnel-btn').focus();
  } catch (error) {
    stateFor(id).actionError = error.message || t('requestFailed');
  } finally {
    pendingActions.delete(id);
    refreshCard(id);
    updateDot();
  }
}

function onTunnelStatus(payload = {}) {
  const { id } = payload;
  if (!(config.tunnels || []).some((item) => item.id === id)) return;
  const state = stateFor(id);
  const status = ['online', 'stopped', 'error', 'connecting', 'reconnecting'].includes(payload.status) ? payload.status : 'stopped';
  state.status = status;
  state.url = status === 'online' ? text(payload.url || state.url) : '';
  state.error = payload.error ? text(payload.error) : null;
  refreshCard(id);
  updateDot();
}

function onTunnelRequest(payload = {}) {
  if (!states.has(payload.id)) return;
  const state = states.get(payload.id);
  state.requests.unshift({
    method: text(payload.method, 30), path: text(payload.path, 1000),
    statusCode: Number.isInteger(Number(payload.statusCode)) ? Number(payload.statusCode) : 0,
    latency: Number(payload.latency),
  });
  state.requests = state.requests.slice(0, 5);
  const target = $('log-' + payload.id);
  if (target) renderLog(target, state.requests);
  else refreshCard(payload.id);
}

function renderLog(target, requests) {
  target.replaceChildren();
  for (const request of requests.slice(0, 3)) {
    const code = Number.isInteger(Number(request.statusCode)) ? Number(request.statusCode) : 0;
    const level = code >= 500 ? 'err' : code >= 400 ? 'warn' : code > 0 && code < 300 ? 'ok' : '';
    const row = node('div', 'log-row');
    row.append(node('span', 'log-m', request.method), node('span', 'log-p', request.path), node('span', 'log-s ' + level, code || 'TCP'));
    if (Number.isFinite(request.latency) && request.latency >= 0) row.title = Math.round(request.latency) + ' ms';
    target.append(row);
  }
}

function updateDot() {
  const statuses = (config.tunnels || []).map((tunnel) => states.get(tunnel.id)?.status);
  $('header-dot').className = 'brand-dot' + (statuses.includes('online') ? ' online' : statuses.some((status) => ['connecting', 'reconnecting'].includes(status)) ? ' connecting' : '');
  updateServerMeta();
}

function updateSharingSummary() {
  const tunnels = config.tunnels || [];
  const count = tunnels.filter((tunnel) => states.get(tunnel.id)?.status === 'online').length;
  $('service-count').textContent = String(tunnels.length);
  $('sharing-summary').textContent = t(count ? 'summarySharing' : 'summaryNone', { count });
}

const PRESETS = {
  http: [
    { name: 'React / Node.js', port: 3000 }, { name: 'Vite', port: 5173 }, { name: 'Web server', th: 'เว็บเซิร์ฟเวอร์', port: 8080 },
  ],
  tcp: [
    { name: 'Minecraft Java', port: 25565 }, { name: 'SSH', port: 22 }, { name: 'MySQL', port: 3306 },
  ],
};

function renderPresets() {
  const container = $('presets');
  container.replaceChildren();
  for (const preset of PRESETS[selType]) {
    const name = currentLang === 'th' && preset.th ? preset.th : preset.name;
    const button = node('button', 'preset-chip', name + ' ');
    button.type = 'button';
    button.disabled = addSubmitting;
    button.append(node('span', '', ':' + preset.port));
    button.addEventListener('click', () => {
      $('add-port').value = preset.port;
      if (!$('add-name').value.trim()) $('add-name').value = name;
      setFieldError('add-port', '');
      $('add-port').focus();
    });
    container.append(button);
  }
}

function updatePublishModeVisibility() {
  const isHttp = selType === 'http';
  const label = document.querySelector('label[for="add-port"]');
  label.dataset.i18n = isHttp ? 'fieldLocalPort' : 'fieldTcpPort';
  label.textContent = t(label.dataset.i18n);
  $('add-port').dataset.i18nPlaceholder = isHttp ? 'placeholderPort' : 'placeholderTcpPort';
  $('add-port').placeholder = t($('add-port').dataset.i18nPlaceholder);
  $('add-port-hint').dataset.i18n = isHttp ? 'portHint' : 'tcpPortHint';
  $('add-port-hint').textContent = t($('add-port-hint').dataset.i18n);
  $('add-mode-wrap').hidden = !isHttp;
  $('add-subdomain-wrap').hidden = !isHttp || $('add-mode').value === 'root';
}

function invalidateAddCheck() {
  clearTimeout(addCheckTimer);
  addCheckTimer = null;
  addCheckVersion += 1;
}

function getRouteInput() {
  const publishMode = selType === 'http' && $('add-mode').value === 'root' ? 'root' : 'subdomain';
  return {
    type: selType, publishDomain: $('add-domain').value.trim().toLowerCase(), publishMode,
    desiredSubdomain: selType === 'http' && publishMode === 'subdomain' ? $('add-subdomain').value.trim().toLowerCase() : '',
    clientId: addClientId,
  };
}

function validateDesiredSubdomain(value) {
  if (!value) return '';
  if (value.length < 3 || value.length > 63) return t('desiredTooShort');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) return t('desiredPattern');
  return '';
}

async function runTunnelConfigCheck() {
  invalidateAddCheck();
  const version = addCheckVersion;
  const input = getRouteInput();
  if (!config.serverUrl || !config.token) {
    setRememberedStatus('addCheck', { kind: 'error', key: 'saveProfileFirst' });
    return null;
  }
  const invalid = validateDesiredSubdomain(input.desiredSubdomain);
  if (invalid) {
    setRememberedStatus('addCheck', { kind: 'error', message: invalid });
    $('advanced-options').open = true;
    $('add-subdomain').setAttribute('aria-invalid', 'true');
    $('add-subdomain').focus();
    return null;
  }
  $('add-subdomain').setAttribute('aria-invalid', 'false');
  setRememberedStatus('addCheck', { kind: 'pending', key: 'checkingRoute' });
  let timeout;
  try {
    const result = await Promise.race([
      window.api.checkTunnelConfig(input),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(t('checkTimeout'))), 26000); }),
    ]);
    if (version !== addCheckVersion || !$('panel-add').open) return null;
    if (result?.publishDomain) $('add-domain').value = text(result.publishDomain);
    setRememberedStatus('addCheck', {
      kind: result?.available ? 'success' : 'error',
      message: result?.message || (result?.available ? t('addCheckHint') : t('checkFailed')),
    });
    return result;
  } catch (error) {
    if (version === addCheckVersion && $('panel-add').open) setRememberedStatus('addCheck', { kind: 'error', message: error.message || t('checkFailed') });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleTunnelConfigCheck() {
  invalidateAddCheck();
  setRememberedStatus('addCheck', { kind: 'hint', key: 'addCheckHint' });
  addCheckTimer = setTimeout(() => { runTunnelConfigCheck(); }, 650);
}

function resetAddForm() {
  invalidateAddCheck();
  $('add-form').reset();
  $('advanced-options').open = false;
  selType = 'http';
  addClientId = crypto.randomUUID();
  setFieldError('add-port', '');
  $('add-subdomain').setAttribute('aria-invalid', 'false');
  document.querySelectorAll('.type-card').forEach((button) => {
    const active = button.dataset.type === selType;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  updatePublishModeVisibility();
  renderPresets();
  setRememberedStatus('addCheck', { kind: 'hint', key: 'addCheckHint' });
}

async function submitAdd() {
  if (addSubmitting) return;
  const port = parseLocalPort($('add-port').value);
  if (port === null) {
    setFieldError('add-port', t('invalidPort'));
    $('add-port').focus();
    return;
  }
  setFieldError('add-port', '');
  addSubmitting = true;
  setFormBusy('add-form', true);
  $('confirm-add-btn').textContent = t('starting');
  try {
    const preview = await runTunnelConfigCheck();
    if (!preview?.available) return;
    const input = getRouteInput();
    const tunnel = await window.api.addTunnel({
      ...input, port, name: $('add-name').value.trim() || t(selType === 'tcp' ? 'tcpType' : 'httpType') + ' · ' + port,
      publishDomain: preview.publishDomain || input.publishDomain,
    });
    if (!tunnel?.id || tunnel.error) throw new Error(tunnel?.error || t('requestFailed'));
    config.tunnels.push(tunnel);
    stateFor(tunnel.id);
    closePanel('panel-add', true);
    renderList();
    await doStart(tunnel.id);
  } catch (error) {
    setRememberedStatus('addCheck', { kind: 'error', message: error.message || t('requestFailed') });
  } finally {
    addSubmitting = false;
    setFormBusy('add-form', false);
    $('confirm-add-btn').textContent = t('saveAndStart');
    if ($('panel-add').open && $('add-subdomain').getAttribute('aria-invalid') === 'true') $('add-subdomain').focus();
  }
}

// Pasted local addresses describe the same loopback service as a numeric port.
// The forwarding client uses HTTP on 127.0.0.1, so do not silently accept remote hosts or HTTPS.
function parseLocalPort(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let port;
  if (/^\d+$/.test(raw)) port = Number(raw);
  else {
    try {
      const url = new URL(raw.includes('://') ? raw : 'http://' + raw);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.username || url.password) return null;
      port = Number(url.port || 80);
    } catch { return null; }
  }
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function showGuide(tab) {
  activeGuideTab = ['website', 'game', 'ssh'].includes(tab) ? tab : 'website';
  document.querySelectorAll('.g-tab').forEach((button) => {
    const active = button.dataset.g === activeGuideTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  const body = $('guide-body');
  body.setAttribute('aria-labelledby', 'tab-' + activeGuideTab);
  body.replaceChildren(node('p', 'guide-intro', t('guideCommon')));
  const prefix = 'guide' + activeGuideTab[0].toUpperCase() + activeGuideTab.slice(1);
  const steps = node('ol', 'guide-steps');
  for (let number = 1; number <= 3; number += 1) {
    const item = node('li');
    item.append(node('strong', '', t(prefix + number)), node('p', '', t(prefix + number + 'Body')));
    steps.append(item);
  }
  body.append(steps, node('p', 'guide-note', t('guideKeepOpen')));
}

function updatePasswordButton(button) {
  const shown = $(button.dataset.togglePassword).type === 'text';
  button.textContent = t(shown ? 'hideKey' : 'showKey');
  button.setAttribute('aria-pressed', String(shown));
}

function hidePassword(id) {
  $(id).type = 'password';
  document.querySelectorAll('[data-toggle-password]').forEach((button) => {
    if (button.dataset.togglePassword === id) updatePasswordButton(button);
  });
}

function toast(message) {
  const target = $('toast');
  target.textContent = translateRuntimeText(message);
  target.classList.add('show');
  clearTimeout(target._timer);
  target._timer = setTimeout(() => target.classList.remove('show'), 3200);
}

$('setup-form').addEventListener('submit', (event) => { event.preventDefault(); saveProfile('setup'); });
$('settings-form').addEventListener('submit', (event) => { event.preventDefault(); saveProfile('settings'); });
$('add-form').addEventListener('submit', (event) => { event.preventDefault(); submitAdd(); });
$('add-tunnel-btn').addEventListener('click', () => {
  try { resetAddForm(); openPanel('panel-add'); } catch (error) { toast(error.message); }
});
$('services-btn').addEventListener('click', () => { closePanel('panel-add'); });
document.querySelectorAll('[data-quick]').forEach((button) => button.addEventListener('click', () => {
  resetAddForm();
  if (button.dataset.quick === 'game') document.querySelector('[data-type="tcp"]').click();
  $('add-port').value = button.dataset.quick === 'game' ? '25565' : '3000';
  if (button.dataset.quick === 'game') $('add-name').value = 'Minecraft Java';
  openPanel('panel-add');
}));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('panel-add').open && !document.querySelector('dialog:modal')) {
    event.preventDefault();
    closePanel('panel-add');
  }
});
$('close-add-btn').addEventListener('click', () => closePanel('panel-add'));
$('cancel-add-btn').addEventListener('click', () => closePanel('panel-add'));
$('close-guide-btn').addEventListener('click', () => closePanel('panel-guide'));
$('close-settings-btn').addEventListener('click', () => closePanel('panel-settings'));
$('check-subdomain-btn').addEventListener('click', () => { runTunnelConfigCheck(); });
$('add-domain').addEventListener('input', scheduleTunnelConfigCheck);
$('add-subdomain').addEventListener('input', scheduleTunnelConfigCheck);
$('add-mode').addEventListener('change', () => { updatePublishModeVisibility(); scheduleTunnelConfigCheck(); });
$('add-port').addEventListener('input', () => setFieldError('add-port', ''));

document.querySelectorAll('.type-card').forEach((button) => {
  button.addEventListener('click', () => {
    if (addSubmitting) return;
    selType = button.dataset.type === 'tcp' ? 'tcp' : 'http';
    document.querySelectorAll('.type-card').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    invalidateAddCheck();
    updatePublishModeVisibility();
    renderPresets();
    setRememberedStatus('addCheck', { kind: 'hint', key: 'addCheckHint' });
  });
});
for (const id of ['setup-guide-btn', 'guide-btn']) $(id).addEventListener('click', () => { showGuide(activeGuideTab); openPanel('panel-guide'); });
function openSettings() {
  $('settings-url').value = config.serverUrl || '';
  $('settings-token').value = config.token || '';
  applyProfileErrors('settings');
  setRememberedStatus('settings', null);
  hidePassword('settings-token');
  openPanel('panel-settings');
}
$('settings-btn').addEventListener('click', openSettings);
document.querySelectorAll('.g-tab').forEach((button) => {
  button.addEventListener('click', () => showGuide(button.dataset.g));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('.g-tab')];
    let index = tabs.indexOf(button);
    index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    showGuide(tabs[index].dataset.g);
    tabs[index].focus();
  });
});
document.querySelectorAll('[data-toggle-password]').forEach((button) => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.togglePassword);
    input.type = input.type === 'password' ? 'text' : 'password';
    updatePasswordButton(button);
  });
});
document.querySelectorAll('[data-lang]').forEach((button) => {
  button.addEventListener('click', () => {
    currentLang = button.dataset.lang === 'th' ? 'th' : 'en';
    try { localStorage.setItem(LANG_KEY, currentLang); } catch { /* A language choice does not require storage access. */ }
    applyI18n();
  });
});

async function init() {
  applyI18n();
  $('setup-connect-btn').disabled = true;
  try {
    const saved = await window.api.getConfig();
    config = { ...saved, tunnels: Array.isArray(saved?.tunnels) ? saved.tunnels : [] };
    window.api.onTunnelStatus(onTunnelStatus);
    window.api.onTunnelRequest(onTunnelRequest);
    updateServerMeta();
    renderList();
    const hasProfile = Boolean(config.serverUrl && config.token);
    showView(hasProfile ? 'main' : 'setup');
    if (!hasProfile) {
      $('setup-url').value = config.serverUrl || '';
      $('setup-url').focus();
    }
  } catch {
    showView('setup');
    setRememberedStatus('setup', { kind: 'error', key: 'configLoadFailed' });
  } finally {
    $('setup-connect-btn').disabled = false;
  }
}

init();
