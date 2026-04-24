const LANG_KEY = 'ptGuiLang';
const DEFAULT_LANG = 'en';

const I18N = {
  en: {
    documentTitle: 'PrivateTunnel Desktop',
    setupBadge: 'Initial Setup',
    setupHero: 'Save the server profile once, then create short, reusable tunnel profiles inside this GUI.',
    setupNoteTitle: 'This GUI requires a complete server profile before it can open tunnels.',
    setupNoteBody: 'The WebSocket URL and access token are saved together, reused automatically, and shown again in Server Profile settings.',
    fieldServerUrl: 'Server WebSocket URL',
    fieldToken: 'Access Token',
    fieldLocalPort: 'Local Port',
    fieldTunnelName: 'Tunnel Name',
    fieldPublishDomain: 'Publish Domain',
    fieldHttpPublishMode: 'HTTP Publish Mode',
    fieldCustomHost: 'Custom Host Name',
    placeholderServerUrl: 'wss://example.com/_private-tunnel/ws',
    placeholderToken: 'Paste token from the server hoster',
    placeholderTokenUpdated: 'Paste updated access token',
    placeholderPort: '3000',
    placeholderTunnelName: 'My staging API',
    placeholderPublishDomain: 'devshop.com',
    placeholderCustomHost: 'mystaging',
    setupUrlHint: 'Paste the full WebSocket URL from the server hoster, or a hostname if they told you to use the default PrivateTunnel path.',
    setupTokenHint: 'This desktop client requires a token so every tunnel starts from a clear, reusable server profile.',
    settingsUrlHint: 'The app normalizes the server URL before saving it.',
    settingsTokenHint: 'A token is required in this GUI so the server profile stays explicit and reusable.',
    saveServerProfile: 'Save Server Profile',
    openQuickGuide: 'Open Quick Guide',
    brandSub: 'Hoster-linked local tunnel client',
    serverLabel: 'Server',
    tokenSaved: 'TOKEN SAVED',
    tokenMissing: 'TOKEN MISSING',
    tunnelProfiles: 'Tunnel Profiles',
    tunnelProfilesSub: 'Create reusable tunnel entries, validate custom hosts, then start or stop them on demand.',
    emptyTitle: 'No tunnel profiles yet',
    emptyHint: 'Add a tunnel, choose a domain or remembered host name, and let the server validate it before start.',
    addTunnel: 'Add Tunnel',
    createTunnelProfile: 'Create Tunnel Profile',
    createTunnelProfileSub: 'Choose the local port, publish domain, and optional remembered host name. The server can check if that host is already reserved.',
    httpType: 'HTTP',
    httpTypeDesc: 'Web app / API / webhook',
    tcpType: 'TCP',
    tcpTypeDesc: 'Game / SSH / database',
    modeSubdomain: 'Remembered/custom subdomain',
    modeRoot: 'Exact root domain',
    customHostHint: 'If available, the server will remember this host label for this tunnel profile and request it again on reconnect.',
    cancel: 'Cancel',
    saveAndStart: 'Save and Start',
    check: 'Check',
    howToUse: 'How to Use',
    guideWebsite: 'Website',
    guideGame: 'Game',
    guideSsh: 'SSH',
    serverProfile: 'Server Profile',
    serverProfileSub: 'Update the saved server profile used by every tunnel in this GUI.',
    titleGuide: 'How to use',
    titleSettings: 'Server profile',
    start: 'Start',
    stop: 'Stop',
    delete: 'Delete',
    copy: 'Copy',
    copied: 'Copied',
    connecting: 'Connecting…',
    notStarted: 'Not started',
    randomSubdomainReady: 'Random subdomain mode is ready. The server will assign a free public host when you start this tunnel.',
    addCheckHint: 'Optional: choose a publish domain and custom host name. The server will verify whether that host is already reserved.',
    checkingRoute: 'Checking this tunnel route with the server…',
    saveProfileFirst: 'Save the server profile first. This GUI requires both server URL and token.',
    profileSaved: 'Server profile saved. PrivateTunnel will use this server and token for every tunnel in this GUI.',
    profileUpdated: 'Server profile updated.',
    tcpRoutingDomain: 'TCP routing domain: {domain}',
    tcpRoutingDefault: 'TCP routing domain: server default',
    rootDomain: 'Root domain: {domain}',
    rootDomainDefault: 'Root domain: server-selected root publish domain',
    rememberedHost: 'Remembered host: {host}',
    rememberedHostLabel: 'Remembered host label: {label} (domain chosen by server)',
    randomOnDomain: 'Random subdomain on {domain}',
    randomOnDefault: 'Random subdomain on server default domain',
    invalidPort: 'Enter a valid local port between 1 and 65535.',
    desiredTooShort: 'Custom host name must be between 3 and 63 characters.',
    desiredPattern: 'Use only a-z, 0-9, and -. It cannot start or end with -.',
    statusStopped: 'Stopped',
    statusOnline: 'Online',
    statusReconnecting: 'Reconnecting',
    setupStatusIntro: 'Save the server profile once, then all new tunnel profiles can reuse it immediately.',
  },
  th: {
    documentTitle: 'PrivateTunnel Desktop',
    setupBadge: 'ตั้งค่าครั้งแรก',
    setupHero: 'บันทึก server profile ครั้งเดียว แล้วค่อยสร้าง tunnel profile แบบสั้นและใช้ซ้ำได้ภายใน GUI นี้',
    setupNoteTitle: 'GUI นี้ต้องมี server profile ที่ครบก่อน จึงจะเปิด tunnels ได้',
    setupNoteBody: 'ระบบจะบันทึก WebSocket URL และ access token ไว้คู่กัน ใช้ซ้ำอัตโนมัติ และแก้ไขภายหลังได้ในหน้า Server Profile',
    fieldServerUrl: 'Server WebSocket URL',
    fieldToken: 'Access Token',
    fieldLocalPort: 'Local Port',
    fieldTunnelName: 'Tunnel Name',
    fieldPublishDomain: 'Publish Domain',
    fieldHttpPublishMode: 'HTTP Publish Mode',
    fieldCustomHost: 'Custom Host Name',
    placeholderServerUrl: 'wss://example.com/_private-tunnel/ws',
    placeholderToken: 'วาง token จากผู้ดูแล server',
    placeholderTokenUpdated: 'วาง access token ใหม่',
    placeholderPort: '3000',
    placeholderTunnelName: 'My staging API',
    placeholderPublishDomain: 'devshop.com',
    placeholderCustomHost: 'mystaging',
    setupUrlHint: 'วาง WebSocket URL แบบเต็มจากผู้ดูแล server หรือใช้ hostname หากเขาแจ้งให้ใช้ path มาตรฐานของ PrivateTunnel',
    setupTokenHint: 'Desktop client นี้บังคับใช้ token เพื่อให้ทุก tunnel เริ่มจาก server profile ที่ชัดเจนและใช้ซ้ำได้',
    settingsUrlHint: 'แอปจะ normalize server URL ให้อัตโนมัติก่อนบันทึก',
    settingsTokenHint: 'GUI นี้บังคับให้มี token เพื่อให้ server profile ชัดเจนและใช้ซ้ำได้',
    saveServerProfile: 'บันทึก Server Profile',
    openQuickGuide: 'เปิดคู่มือแบบย่อ',
    brandSub: 'ไคลเอนต์ tunnel ที่ผูกกับ hoster',
    serverLabel: 'Server',
    tokenSaved: 'TOKEN บันทึกแล้ว',
    tokenMissing: 'ยังไม่มี TOKEN',
    tunnelProfiles: 'Tunnel Profiles',
    tunnelProfilesSub: 'สร้างรายการ tunnel ที่ใช้ซ้ำได้ ตรวจ custom host ก่อน แล้วค่อย start หรือ stop ตามต้องการ',
    emptyTitle: 'ยังไม่มี tunnel profile',
    emptyHint: 'เพิ่ม tunnel เลือกโดเมนหรือ remembered host name แล้วให้ server ตรวจสอบก่อนเริ่มใช้งาน',
    addTunnel: 'เพิ่ม Tunnel',
    createTunnelProfile: 'สร้าง Tunnel Profile',
    createTunnelProfileSub: 'เลือก local port, publish domain และ remembered host name ได้ โดย server จะเช็กให้ว่าชื่อนี้ถูกจองไว้แล้วหรือไม่',
    httpType: 'HTTP',
    httpTypeDesc: 'เว็บแอป / API / webhook',
    tcpType: 'TCP',
    tcpTypeDesc: 'เกม / SSH / database',
    modeSubdomain: 'จำ custom subdomain',
    modeRoot: 'ใช้ root domain ตรง ๆ',
    customHostHint: 'หากใช้ได้ server จะจำ host label นี้ไว้ให้ tunnel profile นี้ และจะขอใช้ซ้ำตอน reconnect',
    cancel: 'ยกเลิก',
    saveAndStart: 'บันทึกและเริ่ม',
    check: 'ตรวจสอบ',
    howToUse: 'วิธีใช้งาน',
    guideWebsite: 'เว็บไซต์',
    guideGame: 'เกม',
    guideSsh: 'SSH',
    serverProfile: 'Server Profile',
    serverProfileSub: 'อัปเดต server profile ที่ GUI นี้ใช้ร่วมกันกับทุก tunnel',
    titleGuide: 'วิธีใช้งาน',
    titleSettings: 'Server profile',
    start: 'เริ่ม',
    stop: 'หยุด',
    delete: 'ลบ',
    copy: 'คัดลอก',
    copied: 'คัดลอกแล้ว',
    connecting: 'กำลังเชื่อมต่อ…',
    notStarted: 'ยังไม่เริ่ม',
    randomSubdomainReady: 'โหมด random subdomain พร้อมแล้ว เมื่อเริ่ม tunnel ระบบจะให้ public host ที่ว่างอัตโนมัติ',
    addCheckHint: 'ตัวเลือกเสริม: เลือก publish domain และ custom host name แล้วให้ server ตรวจว่าชื่อนี้ถูกจองไว้หรือยัง',
    checkingRoute: 'กำลังตรวจ tunnel route กับ server…',
    saveProfileFirst: 'กรุณาบันทึก server profile ก่อน GUI นี้ต้องมีทั้ง server URL และ token',
    profileSaved: 'บันทึก server profile แล้ว PrivateTunnel จะใช้ server และ token ชุดนี้กับทุก tunnel ใน GUI นี้',
    profileUpdated: 'อัปเดต server profile แล้ว',
    tcpRoutingDomain: 'โดเมนสำหรับ TCP route: {domain}',
    tcpRoutingDefault: 'โดเมนสำหรับ TCP route: ค่าเริ่มต้นของ server',
    rootDomain: 'Root domain: {domain}',
    rootDomainDefault: 'Root domain: server จะเลือก root publish domain ให้',
    rememberedHost: 'โฮสต์ที่จำไว้: {host}',
    rememberedHostLabel: 'label โฮสต์ที่จำไว้: {label} (server จะเลือกโดเมนให้)',
    randomOnDomain: 'สุ่ม subdomain บน {domain}',
    randomOnDefault: 'สุ่ม subdomain บนโดเมนค่าเริ่มต้นของ server',
    invalidPort: 'กรุณาใส่ local port ที่ถูกต้องระหว่าง 1 ถึง 65535',
    desiredTooShort: 'Custom host name ต้องยาวระหว่าง 3 ถึง 63 ตัวอักษร',
    desiredPattern: 'ใช้ได้เฉพาะ a-z, 0-9 และ - และห้ามขึ้นต้นหรือจบด้วย -',
    statusStopped: 'หยุดอยู่',
    statusOnline: 'ออนไลน์',
    statusReconnecting: 'กำลังเชื่อมใหม่',
    setupStatusIntro: 'บันทึก server profile เพียงครั้งเดียว แล้ว tunnel profile ใหม่ทั้งหมดจะใช้งานต่อได้ทันที',
  },
};

const GUIDE_HTML = {
  en: {
    website: `
      <div class="g-intro">Expose a local website, API, or webhook through the saved server profile. English is the default working language, but you can switch to Thai at any time.</div>
      <div class="g-step"><div class="g-num">1</div><div class="g-content"><strong>Save the server profile</strong><p>Paste the WebSocket URL and token from the server hoster. This GUI remembers them and reuses them for every tunnel profile.</p></div></div>
      <div class="g-step"><div class="g-num">2</div><div class="g-content"><strong>Start your local app</strong><p>Run your app first, then note the port, such as <code>3000</code>, <code>5173</code>, or <code>8080</code>.</p></div></div>
      <div class="g-step"><div class="g-num">3</div><div class="g-content"><strong>Create an HTTP tunnel profile</strong><p>Choose a publish domain if needed. Add a custom host label if you want a memorable URL and let the server check whether it is already reserved.</p></div></div>
      <div class="g-step"><div class="g-num">4</div><div class="g-content"><strong>Start and share</strong><p>The tunnel profile can remember that host name for future reconnects, so you do not need to re-enter it every time.</p></div></div>
    `,
    game: `
      <div class="g-intro">Expose game servers and raw TCP services with reusable tunnel profiles. Good for Minecraft, Terraria, Valheim, SSH, or databases.</div>
      <div class="g-step"><div class="g-num">1</div><div class="g-content"><strong>Start the local service</strong><p>Make sure the service is already listening on your machine, for example <code>25565</code> or <code>22</code>.</p></div></div>
      <div class="g-step"><div class="g-num">2</div><div class="g-content"><strong>Create a TCP tunnel profile</strong><p>Choose the local port and optionally specify which publish domain should front that TCP tunnel.</p></div></div>
      <div class="g-step"><div class="g-num">3</div><div class="g-content"><strong>Start when needed</strong><p>The server allocates the TCP entry point after start and returns the public address for sharing.</p></div></div>
    `,
    ssh: `
      <div class="g-intro">Use the same saved server profile for admin workflows such as SSH, remote maintenance, or secure internal tools.</div>
      <div class="g-step"><div class="g-num">1</div><div class="g-content"><strong>Enable SSH locally</strong><p>Confirm that SSH is working on your machine before exposing it through PrivateTunnel.</p></div></div>
      <div class="g-step"><div class="g-num">2</div><div class="g-content"><strong>Create a TCP profile for port 22</strong><p>Give it a clear name so it is easy to recognize in the desktop client later.</p></div></div>
      <div class="g-step"><div class="g-num">3</div><div class="g-content"><strong>Connect through the generated public address</strong><p>Keep the desktop client open while the tunnel is being used.</p></div></div>
    `,
  },
  th: {
    website: `
      <div class="g-intro">เปิดเว็บไซต์, API หรือ webhook จากเครื่องของคุณผ่าน server profile ที่บันทึกไว้ ภาษาเริ่มต้นของแอปคือ English แต่สามารถสลับเป็นไทยได้ตลอดเวลา</div>
      <div class="g-step"><div class="g-num">1</div><div class="g-content"><strong>บันทึก server profile ก่อน</strong><p>วาง WebSocket URL และ token จากผู้ดูแล server GUI จะจำค่าไว้และใช้ซ้ำกับทุก tunnel profile</p></div></div>
      <div class="g-step"><div class="g-num">2</div><div class="g-content"><strong>เปิดแอปในเครื่องก่อน</strong><p>เริ่มรันแอปของคุณและดู port ที่ใช้งาน เช่น <code>3000</code>, <code>5173</code> หรือ <code>8080</code></p></div></div>
      <div class="g-step"><div class="g-num">3</div><div class="g-content"><strong>สร้าง HTTP tunnel profile</strong><p>เลือก publish domain ได้ตามต้องการ และใส่ custom host label หากอยากได้ URL จำง่าย โดย server จะช่วยตรวจว่าชื่อนี้ถูกจองไว้หรือไม่</p></div></div>
      <div class="g-step"><div class="g-num">4</div><div class="g-content"><strong>เริ่มใช้งานและแชร์</strong><p>tunnel profile จะจำ host name นี้ไว้ใช้ซ้ำตอน reconnect จึงไม่ต้องกรอกใหม่ทุกครั้ง</p></div></div>
    `,
    game: `
      <div class="g-intro">เปิด game server และบริการ TCP อื่น ๆ ผ่าน tunnel profile ที่ใช้ซ้ำได้ เหมาะกับ Minecraft, Terraria, Valheim, SSH หรือฐานข้อมูล</div>
      <div class="g-step"><div class="g-num">1</div><div class="g-content"><strong>เปิดบริการในเครื่องก่อน</strong><p>ตรวจให้แน่ใจว่าบริการนั้นฟังบนเครื่องคุณอยู่แล้ว เช่น <code>25565</code> หรือ <code>22</code></p></div></div>
      <div class="g-step"><div class="g-num">2</div><div class="g-content"><strong>สร้าง TCP tunnel profile</strong><p>เลือก local port และถ้าต้องการก็ระบุ publish domain ที่จะใช้เป็นหน้าบ้านของ TCP tunnel นี้</p></div></div>
      <div class="g-step"><div class="g-num">3</div><div class="g-content"><strong>เริ่มใช้เมื่อพร้อม</strong><p>หลัง start แล้ว server จะจัดสรร TCP entry point และส่ง public address กลับมาให้แชร์</p></div></div>
    `,
    ssh: `
      <div class="g-intro">ใช้ server profile เดียวกันนี้กับงานดูแลระบบ เช่น SSH, remote maintenance หรือเครื่องมือภายในที่ต้องการความปลอดภัย</div>
      <div class="g-step"><div class="g-num">1</div><div class="g-content"><strong>เปิด SSH ในเครื่องให้พร้อม</strong><p>ทดสอบให้แน่ใจก่อนว่า SSH ใช้งานบนเครื่องคุณได้จริง ก่อนนำมาเปิดผ่าน PrivateTunnel</p></div></div>
      <div class="g-step"><div class="g-num">2</div><div class="g-content"><strong>สร้าง TCP profile สำหรับ port 22</strong><p>ตั้งชื่อให้จำง่าย เพื่อให้หาเจอได้เร็วใน desktop client ภายหลัง</p></div></div>
      <div class="g-step"><div class="g-num">3</div><div class="g-content"><strong>เชื่อมต่อผ่าน public address ที่ระบบสร้างให้</strong><p>เปิด desktop client ทิ้งไว้ตลอดช่วงที่ต้องใช้งาน tunnel</p></div></div>
    `,
  },
};

let config = {};
let currentLang = localStorage.getItem(LANG_KEY) === 'th' ? 'th' : DEFAULT_LANG;
const states = new Map();
let selType = 'http';
let addCheckTimer = null;
let lastAddCheckKey = '';
let lastAddCheckResult = null;
let activeGuideTab = 'website';
let rememberedStatus = {
  setup: null,
  settings: null,
  addCheck: { kind: 'hint', key: 'addCheckHint' },
};

function t(key, vars) {
  let value = (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
  if (!vars) return value;
  Object.keys(vars).forEach((name) => {
    value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(vars[name]));
  });
  return value;
}

function applyI18n() {
  document.documentElement.lang = currentLang;
  document.title = t('documentTitle');
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.getAttribute('data-i18n-title'));
  });
  document.querySelectorAll('[data-lang]').forEach((button) => {
    const lang = button.getAttribute('data-lang');
    button.classList.toggle('active', lang === currentLang);
    button.textContent = lang === 'th' ? 'ไทย' : 'EN';
  });
  updateServerMeta();
  renderRememberedStatuses();
  renderList();
  renderPresets(selType);
  updatePublishModeVisibility();
  showGuide(activeGuideTab);
}

function setRememberedStatus(name, payload) {
  rememberedStatus[name] = payload;
  renderRememberedStatuses();
}

function renderRememberedStatuses() {
  renderFormStatus('setup-status', rememberedStatus.setup);
  renderFormStatus('settings-status', rememberedStatus.settings);
  renderCheckStatus(rememberedStatus.addCheck);
}

function renderFormStatus(id, payload) {
  const node = document.getElementById(id);
  if (!node) return;
  node.className = 'form-status' + (payload && payload.kind ? ` ${payload.kind}` : '');
  node.textContent = !payload ? '' : (payload.key ? t(payload.key, payload.vars) : translateRuntimeText(payload.text || ''));
}

function renderCheckStatus(payload) {
  const node = document.getElementById('add-check-status');
  if (!node) return;
  node.className = `check-status ${payload && payload.kind ? payload.kind : 'hint'}`;
  node.textContent = !payload ? t('addCheckHint') : (payload.key ? t(payload.key, payload.vars) : translateRuntimeText(payload.text || ''));
}

function setFieldError(inputId, errorId, message) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  if (!input || !error) return;
  const localized = translateRuntimeText(message || '');
  input.classList.toggle('field-invalid', Boolean(localized));
  input.classList.toggle('field-valid', !localized && input.value.trim().length > 0);
  error.textContent = localized;
}

function translateRuntimeText(message) {
  const text = String(message || '');
  if (!text || currentLang === 'en') return text;

  if (text === 'Server WebSocket URL is required.') return 'จำเป็นต้องกรอก Server WebSocket URL';
  if (text === 'Access token is required before this GUI can create tunnels.') return 'ต้องมี access token ก่อน GUI นี้จึงจะสร้าง tunnels ได้';
  if (text === 'Access token looks too short. Paste the full token from the server hoster.') return 'Access token ดูสั้นเกินไป กรุณาวาง token แบบเต็มจากผู้ดูแล server';
  if (text === 'Server URL must start with ws:// or wss://.') return 'Server URL ต้องขึ้นต้นด้วย ws:// หรือ wss://';
  if (text === 'Enter a valid server hostname or WebSocket URL.') return 'กรุณากรอก hostname หรือ WebSocket URL ของ server ให้ถูกต้อง';
  if (text === 'Save the server profile first. This GUI requires both server URL and token.') return t('saveProfileFirst');
  if (text === 'The saved token is invalid for this server.') return 'token ที่บันทึกไว้ไม่ถูกต้องสำหรับ server นี้';
  if (text === 'The saved token is invalid for this server profile.') return 'token ที่บันทึกไว้ไม่ถูกต้องสำหรับ server profile นี้';
  if (text === 'Tunnel not found') return 'ไม่พบ tunnel ที่ต้องการ';
  if (text === 'Could not validate this tunnel configuration.') return 'ไม่สามารถตรวจ tunnel configuration นี้ได้';
  if (text === 'The server did not respond to the host-name check in time.') return 'server ไม่ตอบกลับการตรวจ host name ภายในเวลาที่กำหนด';
  if (text === 'The server closed the connection before returning a host-name check result.') return 'server ปิดการเชื่อมต่อก่อนส่งผลการตรวจ host name กลับมา';
  if (text === 'Could not understand the server response while checking this host name.') return 'ไม่สามารถอ่านผลตอบกลับของ server ระหว่างตรวจ host name นี้ได้';
  if (text.startsWith('Could not reach the server: ')) return `ไม่สามารถเชื่อมต่อไปยัง server ได้: ${text.slice('Could not reach the server: '.length)}`;
  if (text === 'Could not reach the server for this validation request.') return 'ไม่สามารถเชื่อมต่อไปยัง server เพื่อส่งคำขอตรวจสอบนี้ได้';
  if (text === 'Random subdomain mode is ready. The server will assign a free public host when you start this tunnel.') return t('randomSubdomainReady');
  if (text === 'Random subdomain mode is ready.') return 'โหมด random subdomain พร้อมแล้ว';
  if (text === 'Custom host name must be 3-63 characters, use only a-z, 0-9, or -, and cannot start/end with -.') return 'Custom host name ต้องยาว 3-63 ตัวอักษร ใช้ได้เฉพาะ a-z, 0-9 หรือ - และห้ามขึ้นต้นหรือจบด้วย -';
  if (text === 'Custom host name must be between 3 and 63 characters.') return t('desiredTooShort');
  if (text === 'Use only a-z, 0-9, and -. It cannot start or end with -.') return t('desiredPattern');

  const customLive = text.match(/^The custom host name ([a-z0-9-]+) is already used by another live tunnel\.$/);
  if (customLive) return `Custom host name ${customLive[1]} ถูกใช้งานอยู่โดย live tunnel อื่นแล้ว`;
  const customReserved = text.match(/^The custom host name ([a-z0-9-]+) is already reserved by another client profile\.$/);
  if (customReserved) return `Custom host name ${customReserved[1]} ถูกจองไว้โดย client profile อื่นแล้ว`;
  const rootLive = text.match(/^The root host (.+) is already used by another live tunnel right now\.$/);
  if (rootLive) return `Root host ${rootLive[1]} ถูกใช้งานอยู่โดย live tunnel อื่นแล้วในขณะนี้`;
  const rootReserved = text.match(/^The root host (.+) is already reserved by another client profile\.$/);
  if (rootReserved) return `Root host ${rootReserved[1]} ถูกจองไว้โดย client profile อื่นแล้ว`;
  const hostAvailable = text.match(/^The host (.+) is available\. PrivateTunnel will remember this host name in the saved tunnel profile\.$/);
  if (hostAvailable) return `โฮสต์ ${hostAvailable[1]} ใช้งานได้ และ PrivateTunnel จะจำ host name นี้ไว้ใน tunnel profile ที่บันทึกไว้`;
  const hostReused = text.match(/^The host (.+) is already reserved for this client profile and will be reused\.$/);
  if (hostReused) return `โฮสต์ ${hostReused[1]} ถูกจองไว้ให้ client profile นี้อยู่แล้ว และระบบจะนำกลับมาใช้ซ้ำ`;
  const tcpRoute = text.match(/^TCP tunnels will publish on (.+) with an allocated TCP port when you start the tunnel\.$/);
  if (tcpRoute) return `TCP tunnel จะใช้งานบน ${tcpRoute[1]} และ server จะจัดสรร TCP port ให้เมื่อคุณเริ่ม tunnel`;

  return text;
}

function showView(id) {
  document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden'));
  document.getElementById(`view-${id}`)?.classList.remove('hidden');
}

function openPanel(id) {
  document.getElementById('backdrop').classList.remove('hidden');
  document.getElementById(id).classList.add('open');
}

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
  if (!document.querySelector('.panel.open')) {
    document.getElementById('backdrop').classList.add('hidden');
  }
}

document.getElementById('backdrop').addEventListener('click', () => {
  document.querySelectorAll('.panel.open').forEach((panel) => panel.classList.remove('open'));
  document.getElementById('backdrop').classList.add('hidden');
});

function updateServerMeta() {
  const serverNode = document.getElementById('server-url-text');
  const tokenNode = document.getElementById('server-token-state');
  if (serverNode) serverNode.textContent = config.serverUrl || '—';
  if (tokenNode) tokenNode.textContent = config.token ? t('tokenSaved') : t('tokenMissing');
}

async function init() {
  config = await window.api.getConfig();
  window.api.onTunnelStatus(onTunnelStatus);
  window.api.onTunnelRequest(onTunnelRequest);
  applyI18n();

  const hasProfile = Boolean(config.serverUrl && config.token);
  if (!hasProfile) {
    showView('setup');
    setRememberedStatus('setup', { kind: '', key: 'setupStatusIntro' });
    document.getElementById('setup-url').focus();
    return;
  }

  activateMainView();
}

function activateMainView() {
  showView('main');
  updateServerMeta();
  renderList();
}

function clearProfileErrors(prefix) {
  setFieldError(`${prefix}-url`, `${prefix}-url-error`, '');
  setFieldError(`${prefix}-token`, `${prefix}-token-error`, '');
  setRememberedStatus(prefix, null);
}

async function saveProfile(prefix) {
  const serverUrl = document.getElementById(`${prefix}-url`).value.trim();
  const token = document.getElementById(`${prefix}-token`).value.trim();
  clearProfileErrors(prefix);

  const validation = await window.api.validateServerProfile({ serverUrl, token });
  if (!validation.ok) {
    setFieldError(`${prefix}-url`, `${prefix}-url-error`, validation.errors.serverUrl || '');
    setFieldError(`${prefix}-token`, `${prefix}-token-error`, validation.errors.token || '');
    if (validation.normalizedUrl && !validation.errors.serverUrl) {
      document.getElementById(`${prefix}-url`).value = validation.normalizedUrl;
    }
    return false;
  }

  if (validation.normalizedUrl) {
    document.getElementById(`${prefix}-url`).value = validation.normalizedUrl;
  }

  const result = await window.api.saveServerProfile({ serverUrl, token });
  if (!result.ok) {
    setFieldError(`${prefix}-url`, `${prefix}-url-error`, result.errors.serverUrl || '');
    setFieldError(`${prefix}-token`, `${prefix}-token-error`, result.errors.token || '');
    return false;
  }

  config.serverUrl = result.serverUrl;
  config.token = token;
  updateServerMeta();
  setRememberedStatus(prefix, { kind: 'success', key: 'profileSaved' });
  return true;
}

document.getElementById('setup-connect-btn').addEventListener('click', async () => {
  const ok = await saveProfile('setup');
  if (!ok) return;
  config.tunnels = config.tunnels || [];
  activateMainView();
});

document.getElementById('setup-guide-btn').addEventListener('click', () => {
  openPanel('panel-guide');
  activeGuideTab = 'website';
  showGuide('website');
});

document.getElementById('setup-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('setup-connect-btn').click();
});
document.getElementById('setup-token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('setup-connect-btn').click();
});

function buildPublishLabel(tunnel) {
  if (tunnel.type === 'tcp') {
    return tunnel.publishDomain
      ? t('tcpRoutingDomain', { domain: tunnel.publishDomain })
      : t('tcpRoutingDefault');
  }
  if (tunnel.publishMode === 'root') {
    return tunnel.publishDomain
      ? t('rootDomain', { domain: tunnel.publishDomain })
      : t('rootDomainDefault');
  }
  if (tunnel.desiredSubdomain && tunnel.publishDomain) {
    return t('rememberedHost', { host: `${tunnel.desiredSubdomain}.${tunnel.publishDomain}` });
  }
  if (tunnel.desiredSubdomain) {
    return t('rememberedHostLabel', { label: tunnel.desiredSubdomain });
  }
  if (tunnel.publishDomain) {
    return t('randomOnDomain', { domain: tunnel.publishDomain });
  }
  return t('randomOnDefault');
}

function renderList() {
  const list = document.getElementById('tunnel-list');
  list.querySelectorAll('.tcard').forEach((card) => card.remove());
  const tunnels = config.tunnels || [];
  document.getElementById('empty-state').style.display = tunnels.length ? 'none' : 'flex';
  tunnels.forEach((tunnel) => list.appendChild(makeCard(tunnel)));
}

function makeCard(tunnel) {
  const state = states.get(tunnel.id) || { status: 'stopped', url: '', requests: [] };
  const running = state.status !== 'stopped';
  const publishLabel = buildPublishLabel(tunnel);
  const card = document.createElement('div');
  card.id = `card-${tunnel.id}`;
  card.className = 'tcard' + (state.status !== 'stopped' && state.status !== 'error'
    ? ` ${state.status}`
    : state.status === 'error'
      ? ' error'
      : '');

  card.innerHTML = `
    <div class="tcard-top">
      <div class="tcard-left">
        <div class="type-badge ${tunnel.type}">${tunnel.type === 'http' ? '🌐' : '🔌'}</div>
        <div>
          <div class="tcard-name">${esc(tunnel.name)}</div>
          <div class="tcard-port">${tunnel.type.toUpperCase()} → localhost:${tunnel.port}</div>
          <div class="tcard-port">${esc(publishLabel)}</div>
        </div>
      </div>
      <div class="status-pip ${state.status !== 'stopped' ? state.status : ''}" title="${t(`status${state.status.charAt(0).toUpperCase() + state.status.slice(1)}`) || ''}"></div>
    </div>
    <div class="tcard-url">
      ${state.url
        ? `<span class="url-text" data-url="${esc(state.url)}">${esc(state.url)}</span>
           <button class="copy-btn" data-copy="${esc(state.url)}">${t('copy')}</button>`
        : state.error
          ? `<span class="url-none url-error">⚠ ${esc(translateRuntimeText(state.error))}</span>`
          : `<span class="url-none">${running ? t('connecting') : t('notStarted')}</span>`}
    </div>
    <div class="tcard-actions">
      ${running
        ? `<button class="btn-stop" data-id="${tunnel.id}">■ ${t('stop')}</button>`
        : `<button class="btn-start" data-id="${tunnel.id}">▶ ${t('start')}</button>`}
      <button class="btn-del" data-del="${tunnel.id}">${t('delete')}</button>
    </div>
    <div class="tcard-log" id="log-${tunnel.id}"></div>
  `;

  card.querySelector('.btn-start')?.addEventListener('click', () => doStart(tunnel.id));
  card.querySelector('.btn-stop')?.addEventListener('click', () => doStop(tunnel.id));
  card.querySelector('.btn-del')?.addEventListener('click', () => doDel(tunnel.id));
  card.querySelector('.copy-btn')?.addEventListener('click', (event) => {
    window.api.copyText(event.target.dataset.copy);
    toast({ key: 'copied' });
  });
  card.querySelector('.url-text')?.addEventListener('click', (event) => {
    const url = event.target.dataset.url;
    if (url) window.api.openExternal(url);
  });

  renderLog(tunnel.id, state.requests || []);
  return card;
}

function refreshCard(id) {
  const old = document.getElementById(`card-${id}`);
  if (!old) return;
  const tunnel = (config.tunnels || []).find((item) => item.id === id);
  if (!tunnel) return;
  old.replaceWith(makeCard(tunnel));
}

async function doStart(id) {
  if (!states.has(id)) states.set(id, { status: 'stopped', url: '', requests: [] });
  states.get(id).status = 'reconnecting';
  states.get(id).error = null;
  refreshCard(id);
  const result = await window.api.startTunnel(id);
  if (result?.error) {
    states.get(id).status = 'stopped';
    states.get(id).error = result.error;
    refreshCard(id);
    toast({ text: result.error });
  }
  updateDot();
}

async function doStop(id) {
  await window.api.stopTunnel(id);
  states.set(id, { status: 'stopped', url: '', requests: [] });
  refreshCard(id);
  updateDot();
}

async function doDel(id) {
  await window.api.deleteTunnel(id);
  config.tunnels = (config.tunnels || []).filter((tunnel) => tunnel.id !== id);
  states.delete(id);
  renderList();
  updateDot();
}

function onTunnelStatus({ id, status, url, error }) {
  if (!states.has(id)) states.set(id, { status: 'stopped', url: '', requests: [] });
  const state = states.get(id);
  state.status = status;
  state.error = error || null;
  if (url) state.url = url;
  if (status === 'stopped' || status === 'error') state.url = '';
  refreshCard(id);
  updateDot();
}

function onTunnelRequest({ id, method, path, statusCode, latency }) {
  if (!states.has(id)) return;
  const state = states.get(id);
  state.requests = state.requests || [];
  state.requests.unshift({ method, path, statusCode, latency });
  if (state.requests.length > 5) state.requests.pop();
  renderLog(id, state.requests);
}

function renderLog(id, requests) {
  const target = document.getElementById(`log-${id}`);
  if (!target || !requests?.length) return;
  target.innerHTML = requests.slice(0, 3).map((request) => {
    const code = request.statusCode || 0;
    const cls = code === 0 ? '' : code < 300 ? 'ok' : code < 400 ? 'redir' : code < 500 ? 'warn' : 'err';
    const label = code === 0 ? 'TCP' : code;
    return `<div class="log-row">
      <span class="log-m">${request.method || ''}</span>
      <span class="log-p">${esc(request.path || '')}</span>
      <span class="log-s ${cls}">${label}</span>
    </div>`;
  }).join('');
}

function updateDot() {
  const dot = document.getElementById('header-dot');
  const values = [...states.values()];
  dot.className = 'brand-dot'
    + (values.some((item) => item.status === 'online')
      ? ' online'
      : values.some((item) => item.status === 'reconnecting')
        ? ' connecting'
        : '');
}

const PRESETS = {
  http: [
    { port: 3000, icon: '⚛️', names: { en: 'Node.js / React', th: 'Node.js / React' } },
    { port: 5173, icon: '⚡', names: { en: 'Vite', th: 'Vite' } },
    { port: 8080, icon: '🌐', names: { en: 'Web Server', th: 'เว็บเซิร์ฟเวอร์' } },
    { port: 8000, icon: '🐍', names: { en: 'Django / Laravel', th: 'Django / Laravel' } },
    { port: 4200, icon: '🔺', names: { en: 'Angular', th: 'Angular' } },
    { port: 3001, icon: '🟢', names: { en: 'Alt Node', th: 'Node สำรอง' } },
  ],
  tcp: [
    { port: 25565, icon: '⛏️', names: { en: 'Minecraft', th: 'Minecraft' } },
    { port: 7777, icon: '🗡️', names: { en: 'Terraria', th: 'Terraria' } },
    { port: 2456, icon: '🪓', names: { en: 'Valheim', th: 'Valheim' } },
    { port: 27015, icon: '🎯', names: { en: 'CS2 / TF2', th: 'CS2 / TF2' } },
    { port: 22, icon: '🔑', names: { en: 'SSH', th: 'SSH' } },
    { port: 3306, icon: '🐬', names: { en: 'MySQL', th: 'MySQL' } },
  ],
};

function getPresetName(preset) {
  return preset.names?.[currentLang] || preset.names?.en || '';
}

function renderPresets(type) {
  const container = document.getElementById('presets');
  const presets = PRESETS[type] || [];
  container.innerHTML = presets.map((preset) => `
    <button class="preset-chip" data-port="${preset.port}" data-name="${esc(getPresetName(preset))}">
      ${preset.icon} ${esc(getPresetName(preset))} <span>:${preset.port}</span>
    </button>
  `).join('');

  container.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('add-port').value = chip.dataset.port;
      document.getElementById('add-name').value = chip.dataset.name;
    });
  });
}

function setAddCheckStatus(kind, payload = {}) {
  lastAddCheckResult = kind === 'success' ? payload.result || lastAddCheckResult : (kind === 'error' ? null : lastAddCheckResult);
  if (payload.key || payload.text) {
    setRememberedStatus('addCheck', { kind, key: payload.key, text: payload.text, vars: payload.vars });
    return;
  }
  setRememberedStatus('addCheck', { kind, key: 'addCheckHint' });
}

function normalizeDesiredSubdomain(value) {
  return String(value || '').trim().toLowerCase();
}

function validateDesiredSubdomain(value) {
  const desired = normalizeDesiredSubdomain(value);
  if (!desired) return '';
  if (desired.length < 3 || desired.length > 63) return t('desiredTooShort');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(desired)) return t('desiredPattern');
  return '';
}

function updatePublishModeVisibility() {
  const modeWrap = document.getElementById('add-mode-wrap');
  const subdomainWrap = document.getElementById('add-subdomain-wrap');
  const mode = document.getElementById('add-mode').value;
  const isHttp = selType === 'http';
  modeWrap.style.display = isHttp ? '' : 'none';
  subdomainWrap.style.display = isHttp && mode === 'subdomain' ? '' : 'none';

  if (!isHttp) {
    document.getElementById('add-mode').value = 'subdomain';
    document.getElementById('add-subdomain').value = '';
  }

  if (mode !== 'subdomain') {
    document.getElementById('add-subdomain').value = '';
  }
}

async function runTunnelConfigCheck(manual = false) {
  clearTimeout(addCheckTimer);
  addCheckTimer = null;

  if (!config.serverUrl || !config.token) {
    setAddCheckStatus('error', { key: 'saveProfileFirst' });
    if (manual) shake('add-domain');
    return null;
  }

  const publishDomain = document.getElementById('add-domain').value.trim().toLowerCase();
  const publishMode = selType === 'http' && document.getElementById('add-mode').value === 'root'
    ? 'root'
    : 'subdomain';
  const desiredSubdomain = publishMode === 'subdomain'
    ? normalizeDesiredSubdomain(document.getElementById('add-subdomain').value)
    : '';

  if (publishMode === 'subdomain') {
    const validationMessage = validateDesiredSubdomain(desiredSubdomain);
    if (validationMessage) {
      setAddCheckStatus('error', { text: validationMessage });
      if (manual) shake('add-subdomain');
      return null;
    }
  }

  const requestKey = JSON.stringify({
    type: selType,
    publishDomain,
    publishMode,
    desiredSubdomain,
  });

  if (!manual && requestKey === lastAddCheckKey && lastAddCheckResult) {
    return lastAddCheckResult;
  }

  lastAddCheckKey = requestKey;
  setAddCheckStatus('pending', { key: 'checkingRoute' });

  try {
    const result = await Promise.race([
      window.api.checkTunnelConfig({
        type: selType,
        publishDomain,
        publishMode,
        desiredSubdomain,
        clientId: config.clientId || null,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('The server did not respond to the host-name check in time.')), 25000)
      ),
    ]);

    if (result?.publishDomain) {
      document.getElementById('add-domain').value = result.publishDomain;
    }

    lastAddCheckResult = result || null;
    setAddCheckStatus(result?.available ? 'success' : 'error', {
      text: result?.message || 'Could not validate this tunnel configuration.',
      result,
    });

    return result;
  } catch (error) {
    lastAddCheckResult = null;
    setAddCheckStatus('error', { text: error.message || 'Could not validate this tunnel configuration.' });
    return null;
  }
}

function scheduleTunnelConfigCheck() {
  clearTimeout(addCheckTimer);
  addCheckTimer = setTimeout(() => {
    runTunnelConfigCheck(false).catch((error) => {
      setAddCheckStatus('error', { text: error.message });
    });
  }, 800);
}

function resetAddForm() {
  document.getElementById('add-port').value = '';
  document.getElementById('add-name').value = '';
  document.getElementById('add-domain').value = '';
  document.getElementById('add-mode').value = 'subdomain';
  document.getElementById('add-subdomain').value = '';
  selType = 'http';
  lastAddCheckKey = '';
  lastAddCheckResult = null;
  document.querySelectorAll('.type-card').forEach((button) => {
    button.classList.toggle('active', button.dataset.type === 'http');
  });
  renderPresets('http');
  updatePublishModeVisibility();
  setRememberedStatus('addCheck', { kind: 'hint', key: 'addCheckHint' });
}

document.getElementById('add-tunnel-btn').addEventListener('click', () => {
  resetAddForm();
  openPanel('panel-add');
  setTimeout(() => document.getElementById('add-port').focus(), 320);
});

document.querySelectorAll('.type-card').forEach((button) => button.addEventListener('click', () => {
  selType = button.dataset.type === 'tcp' ? 'tcp' : 'http';
  document.querySelectorAll('.type-card').forEach((item) => item.classList.toggle('active', item === button));
  renderPresets(selType);
  updatePublishModeVisibility();
  scheduleTunnelConfigCheck();
}));

document.getElementById('add-mode').addEventListener('change', () => {
  updatePublishModeVisibility();
  scheduleTunnelConfigCheck();
});

document.getElementById('add-domain').addEventListener('input', scheduleTunnelConfigCheck);
document.getElementById('add-subdomain').addEventListener('input', () => {
  document.getElementById('add-subdomain').value = normalizeDesiredSubdomain(document.getElementById('add-subdomain').value);
  scheduleTunnelConfigCheck();
});

document.getElementById('check-subdomain-btn').addEventListener('click', () => {
  runTunnelConfigCheck(true).catch((error) => {
    setAddCheckStatus('error', { text: error.message });
  });
});

document.getElementById('cancel-add-btn').addEventListener('click', () => closePanel('panel-add'));

document.getElementById('confirm-add-btn').addEventListener('click', async () => {
  const port = Number.parseInt(document.getElementById('add-port').value, 10);
  if (!port || port < 1 || port > 65535) {
    setAddCheckStatus('error', { key: 'invalidPort' });
    shake('add-port');
    return;
  }

  const preview = await runTunnelConfigCheck(true);
  if (!preview?.available) return;

  const publishMode = selType === 'http' && document.getElementById('add-mode').value === 'root'
    ? 'root'
    : 'subdomain';
  const desiredSubdomain = publishMode === 'subdomain'
    ? normalizeDesiredSubdomain(document.getElementById('add-subdomain').value)
    : '';
  const name = document.getElementById('add-name').value.trim();

  const tunnel = await window.api.addTunnel({
    type: selType,
    port,
    name,
    publishDomain: preview.publishDomain || document.getElementById('add-domain').value.trim().toLowerCase(),
    publishMode,
    desiredSubdomain,
  });

  config.tunnels = config.tunnels || [];
  config.tunnels.push(tunnel);
  states.set(tunnel.id, { status: 'stopped', url: '', requests: [] });
  closePanel('panel-add');
  renderList();
  updateDot();
  setTimeout(() => doStart(tunnel.id), 260);
});

document.getElementById('add-port').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('confirm-add-btn').click();
});

function showGuide(tab) {
  activeGuideTab = tab || 'website';
  document.querySelectorAll('.g-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.g === activeGuideTab);
  });
  document.getElementById('guide-body').innerHTML = GUIDE_HTML[currentLang]?.[activeGuideTab]
    || GUIDE_HTML.en[activeGuideTab]
    || '';
}

document.getElementById('guide-btn').addEventListener('click', () => {
  openPanel('panel-guide');
  showGuide(activeGuideTab || 'website');
});
document.getElementById('close-guide-btn').addEventListener('click', () => closePanel('panel-guide'));
document.querySelectorAll('.g-tab').forEach((button) => button.addEventListener('click', () => showGuide(button.dataset.g)));

document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-url').value = config.serverUrl || '';
  document.getElementById('settings-token').value = config.token || '';
  clearProfileErrors('settings');
  openPanel('panel-settings');
});
document.getElementById('close-settings-btn').addEventListener('click', () => closePanel('panel-settings'));
document.getElementById('save-settings-btn').addEventListener('click', async () => {
  const ok = await saveProfile('settings');
  if (!ok) return;
  setRememberedStatus('settings', { kind: 'success', key: 'profileUpdated' });
  toast({ key: 'profileUpdated' });
});
document.getElementById('settings-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('save-settings-btn').click();
});
document.getElementById('settings-token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') document.getElementById('save-settings-btn').click();
});

document.querySelectorAll('[data-lang]').forEach((button) => button.addEventListener('click', () => {
  const nextLang = button.getAttribute('data-lang') === 'th' ? 'th' : 'en';
  if (currentLang === nextLang) return;
  currentLang = nextLang;
  localStorage.setItem(LANG_KEY, currentLang);
  applyI18n();
}));

function toast({ key, text }) {
  const node = document.getElementById('toast');
  node.textContent = key ? t(key) : translateRuntimeText(text || '');
  node.classList.add('show');
  clearTimeout(node._hideTimer);
  node._hideTimer = setTimeout(() => node.classList.remove('show'), 2200);
}

function shake(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.classList.remove('shake');
  void node.offsetWidth;
  node.classList.add('shake');
  setTimeout(() => node.classList.remove('shake'), 450);
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const openPanelNode = document.querySelector('.panel.open');
  if (!openPanelNode) return;
  closePanel(openPanelNode.id);
});

init();
