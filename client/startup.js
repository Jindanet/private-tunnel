'use strict';

// Install explicit, per-tunnel boot jobs. Credentials are copied to a private
// service profile, never to arguments, unit definitions or the user manifest.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { requireSecureServerWebSocketUrl } = require('./server-url');
// A CLI launched from PowerShell 7 can inherit its incompatible module path.
// These helpers deliberately use Windows PowerShell's own built-in modules.
const WINDOWS_POWERSHELL_INIT = "$env:PSModulePath = Join-Path $PSHOME 'Modules'; ";

const sh = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
const ps = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const unit = (value) => '"' + String(value).replace(/%/g, '%%').replace(/\$/g, '$$').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

function writePrivate(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
    if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

function readJson(filename, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function execute(command, args, { interactive = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (data) => { output = (output + data).slice(-8192); });
    child.stderr?.on('data', (data) => { output = (output + data).slice(-8192); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output.trim() || `Installer exited ${code}. Authorization may have been cancelled.`)));
  });
}

function validateProfile(profile) {
  const serverUrl = requireSecureServerWebSocketUrl(profile.serverUrl);
  if (new URL(serverUrl).search || !/^[\x21-\x7e]{32,4096}$/.test(profile.token || '')) throw new Error('Save a valid server address and access key before enabling startup.');
  if (!['http', 'tcp'].includes(profile.tunnelType) || !Number.isInteger(profile.localPort) || profile.localPort < 1 || profile.localPort > 65535) throw new Error('Save a valid HTTP/TCP target before enabling startup.');
  if (typeof profile.clientId !== 'string' || !profile.clientId || profile.clientId.length > 190) throw new Error('A saved client identity is required.');
  const localHost = String(profile.localHost || 'localhost');
  if (/[\x00-\x20\x7f]/.test(localHost) || localHost.length > 253) throw new Error('Invalid local host.');
  return { serverUrl, token: profile.token, clientId: profile.clientId, tunnelType: profile.tunnelType,
    localHost, localPort: profile.localPort, publishDomain: String(profile.publishDomain || ''),
    publishMode: profile.publishMode === 'root' ? 'root' : 'subdomain', desiredSubdomain: String(profile.desiredSubdomain || '') };
}

function createStartupManager({ configPath, channel = 'cli', platform = process.platform, env = process.env,
  home = os.homedir(), user = os.userInfo(), gui = false, runtime = process.execPath,
  bundledBinary = Boolean(process.pkg), electronNode = false, bundlePath,
  run = execute, systemRoot } = {}) {
  const filePath = platform === 'win32' ? path.win32 : path.posix;
  const termux = platform === 'android' || (platform === 'linux' && /com\.termux/.test(env.PREFIX || ''));
  if (!termux && !['win32', 'linux', 'darwin'].includes(platform)) throw new Error('Boot startup supports Windows, macOS, Linux with systemd, and Termux.');
  const owner = crypto.createHash('sha256').update(`${path.resolve(configPath)}:${channel}`).digest('hex').slice(0, 12);
  const manifestPath = `${configPath}.startup.json`;
  const provider = termux ? 'termux-boot' : platform === 'win32' ? 'windows-task' : platform === 'darwin' ? 'launchd' : 'systemd';
  const base = systemRoot || (termux ? filePath.join(home, '.local/share/privatetunnel/startup')
    : platform === 'win32' ? filePath.join(env.ProgramData || 'C:\\ProgramData', 'PrivateTunnel', 'startup')
      : platform === 'darwin' ? '/Library/Application Support/PrivateTunnel/startup' : '/var/lib/privatetunnel/startup');
  const defaultBundle = typeof __PTUNNEL_STANDALONE__ !== 'undefined' && __PTUNNEL_STANDALONE__
    ? process.argv[1] : path.resolve(__dirname, '..', 'ptunnel.js');
  const source = bundledBinary ? runtime : bundlePath || defaultBundle;

  function load() {
    const manifest = readJson(manifestPath, { version: 1, entries: [] });
    if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.some((item) => !/^[a-f0-9]{16}$/.test(item.id))) throw new Error('Invalid startup manifest. Restore it before changing startup services.');
    return manifest;
  }

  function describe(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid startup ID.');
    const job = `privatetunnel-${owner}-${id}`;
    const directory = filePath.join(base, owner, id);
    const stateDir = filePath.join(directory, 'state');
    const runner = filePath.join(directory, bundledBinary ? (platform === 'win32' ? 'ptunnel.exe' : 'ptunnel') : 'ptunnel.js');
    const runtimeDir = filePath.join(directory, 'runtime');
    const executable = platform === 'win32' && electronNode ? filePath.join(runtimeDir, filePath.basename(runtime))
      : platform === 'win32' && !bundledBinary ? filePath.join(directory, 'node.exe') : bundledBinary ? runner : runtime;
    const profilePath = filePath.join(directory, 'profile.json');
    const args = [...(bundledBinary ? [] : [runner]), 'startup', 'run', '--profile', profilePath];
    const definition = termux ? filePath.join(home, '.termux/boot', job)
      : platform === 'win32' ? filePath.join(directory, 'launch.ps1')
        : platform === 'darwin' ? `/Library/LaunchDaemons/com.jindanet.${job}.plist` : `/etc/systemd/system/${job}.service`;
    return { id, job, provider, directory, stateDir, profilePath, runner, runtimeDir, executable, args, definition,
      logPath: filePath.join(stateDir, 'service.log'), statusPath: filePath.join(stateDir, 'status.json'),
      note: termux ? 'Install Termux:Boot from the same source as Termux, open it once, and allow background activity. Android may require device unlock after reboot.' : 'Starts at boot before sign-in. Administrator approval is required to install or remove it.' };
  }

  function status(id) {
    return load().entries.filter((entry) => !id || entry.id === id).map((entry) => {
      const info = describe(entry.id);
      let state = null, error = null;
      try { state = readJson(info.statusPath); } catch { error = 'Cannot read the boot service status. Check its file permissions.'; }
      const fresh = state?.updatedAt && Date.now() - Date.parse(state.updatedAt) < 15000;
      return { ...entry, ...info, status: fresh || state?.status === 'error' ? state.status : 'stopped', url: fresh ? String(state.url || '') : '',
        error: error || state?.error || null, installed: fs.existsSync(info.profilePath),
        workerVersion: state?.version || null, dataTransportVersion: state?.dataTransportVersion || null,
        lastStatus: state?.status || null, updatedAt: state?.updatedAt || null };
    });
  }

  function windowsPauseGuard(info) {
    const pause = ps(filePath.join(info.stateDir, 'paused.json'));
    const stop = ps(filePath.join(info.stateDir, 'stop'));
    return `# PrivateTunnel boot pause guard v1\r\n${WINDOWS_POWERSHELL_INIT}\r\n$ErrorActionPreference = 'Stop'\r\nif (Test-Path -LiteralPath ${pause}) {\r\n$pause = Get-Content -LiteralPath ${pause} -Raw | ConvertFrom-Json\r\n$bootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')\r\nif ($pause.bootId -eq $bootId) { exit 0 }\r\nRemove-Item -LiteralPath ${pause} -Force\r\nRemove-Item -LiteralPath ${stop} -Force -ErrorAction SilentlyContinue\r\n}\r\n`;
  }

  function definition(info) {
    const command = [info.executable, ...info.args];
    if (termux) {
      const prefix = env.PREFIX || '/data/data/com.termux/files/usr';
      return `#!${prefix}/bin/sh\n# PrivateTunnel boot job\ncommand -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock\nnohup ${command.map(sh).join(' ')} >/dev/null 2>&1 &\n`;
    }
    if (platform === 'win32') return `${windowsPauseGuard(info)}${electronNode ? "$env:ELECTRON_RUN_AS_NODE = '1'\r\n" : ''}& ${ps(info.executable)} @(${info.args.map(ps).join(', ')})\r\nexit $LASTEXITCODE\r\n`;
    if (platform === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.jindanet.${info.job}</string><key>UserName</key><string>${xml(user.username)}</string><key>ProgramArguments</key><array>${command.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>EnvironmentVariables</key><dict>${electronNode ? '<key>ELECTRON_RUN_AS_NODE</key><string>1</string>' : ''}</dict></dict></plist>\n`;
    return `[Unit]\nDescription=PrivateTunnel boot tunnel\nWants=network-online.target\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nUser=${Number(user.uid)}\nGroup=${Number(user.gid)}\nExecStart=${command.map(unit).join(' ')}\n${electronNode ? 'Environment=ELECTRON_RUN_AS_NODE=1\n' : ''}${electronNode && env.APPIMAGE ? 'Environment=APPIMAGE_EXTRACT_AND_RUN=1\n' : ''}Restart=on-failure\nRestartPreventExitStatus=1 2\nRestartSec=15\nTimeoutStopSec=10\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=multi-user.target\n`;
  }

  function windowsStop(info, { resumeTask = true } = {}) {
    return [
      `$profilePath = ${ps(info.profilePath)}`,
      `$stateDir = ${ps(info.stateDir)}`,
      `$workerPattern = '(?i)(?:^|\\s)startup\\s+run\\s+--profile\\s+(?:"' + [Regex]::Escape($profilePath) + '"|' + [Regex]::Escape($profilePath) + ')(?:\\s|$)'`,
      `function Get-TunnelWorkers { @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%--profile%'" | Where-Object { $_.CommandLine -match $workerPattern }) }`,
      `$task = Get-ScheduledTask -TaskName $job -ErrorAction SilentlyContinue`,
      `$taskEnabled = $task -and $task.Settings.Enabled`,
      `$resumeTask = $false`,
      `if ($taskEnabled) { Disable-ScheduledTask -TaskName $job | Out-Null }`,
      `try {`,
      `if (Test-Path -LiteralPath $stateDir) {`,
      `$bootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')`,
      `$pause = @{ bootId = $bootId } | ConvertTo-Json -Compress`,
      `[IO.File]::WriteAllText((Join-Path $stateDir 'paused.json'), $pause)`,
      `[IO.File]::WriteAllText((Join-Path $stateDir 'stop'), '')`,
      `}`,
      // Allow the worker to close its WebSocket and TCP streams voluntarily.
      // Stopping only the PowerShell task can leave its Node child alive.
      `$deadline = [DateTime]::UtcNow.AddSeconds(6)`,
      `while (@(Get-TunnelWorkers).Count -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }`,
      `if ($task) { Stop-ScheduledTask -TaskName $job -ErrorAction SilentlyContinue }`,
      `foreach ($worker in @(Get-TunnelWorkers)) {`,
      `$workerProcess = Get-Process -Id $worker.ProcessId -ErrorAction SilentlyContinue`,
      // Creation time plus the exact profile argument protects against PID reuse.
      `if ($workerProcess -and [Math]::Abs(($workerProcess.StartTime.ToUniversalTime() - $worker.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1) { Stop-Process -InputObject $workerProcess -Force -ErrorAction SilentlyContinue }`,
      `}`,
      `$deadline = [DateTime]::UtcNow.AddSeconds(5)`,
      `while ((@(Get-TunnelWorkers).Count -or (Get-ScheduledTask -TaskName $job -ErrorAction SilentlyContinue).State -eq 'Running') -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }`,
      `if (@(Get-TunnelWorkers).Count -or (Get-ScheduledTask -TaskName $job -ErrorAction SilentlyContinue).State -eq 'Running') { throw 'The boot tunnel is still running. Stop was not confirmed.' }`,
      `if (Test-Path -LiteralPath $stateDir) {`,
      `$stopped = @{ status = 'stopped'; url = ''; error = $null; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress`,
      `[IO.File]::WriteAllText((Join-Path $stateDir 'status.json'), $stopped)`,
      `}`,
      ...(resumeTask ? [
        // Upgrade the launcher guard as well: old runtime snapshots do not yet
        // understand paused.json. Preserve their original runtime command.
        `if ($taskEnabled) {`,
        `$launcherPath = ${ps(info.definition)}`,
        `if (!(Test-Path -LiteralPath $launcherPath)) { throw 'The boot launcher is missing. Turn startup off and reinstall it.' }`,
        `$launcher = [IO.File]::ReadAllText($launcherPath)`,
        `if (!$launcher.StartsWith('# PrivateTunnel boot pause guard v1')) { [IO.File]::WriteAllText($launcherPath, ${ps('\ufeff' + windowsPauseGuard(info))} + $launcher) }`,
        `$resumeTask = $true`,
        `}`,
      ] : []),
      `} finally { if ($resumeTask) { Enable-ScheduledTask -TaskName $job | Out-Null } }`,
    ];
  }

  function installer(info, action, stage) {
    const installing = action === 'install';
    const stopping = action === 'stop' || action === 'remove';
    const stagedSource = bundledBinary ? source : path.join(stage, 'runner');
    if (platform === 'win32' && !termux) {
      const qdir = ps(info.directory), qjob = ps(info.job);
      const content = ["$ErrorActionPreference = 'Stop'", `$dir = ${qdir}`, `$job = ${qjob}`];
      if (installing) {
        content.push(`$base = ${ps(base)}`, `$namespace = ${ps(filePath.dirname(info.directory))}`,
          `foreach ($parent in @(${ps(filePath.dirname(base))}, $base, $namespace)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null; if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Service parents must not be links.' }; $parentAcl = New-Object Security.AccessControl.DirectorySecurity; $parentAcl.SetAccessRuleProtection($true,$false); $parentAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544'))); foreach ($parentRule in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-19','ReadAndExecute'),@('S-1-5-32-545','ReadAndExecute'))) { $parentAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($parentRule[0])), $parentRule[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }; Set-Acl -LiteralPath $parent -AclObject $parentAcl }`,
          `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
          `if ((Get-Item -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Service directory must not be a link.' }`,
          `$ownerSid = ${ps(user.sid || '')}`, "if (!$ownerSid) { throw 'Missing installing user SID.' }",
          `$acl = New-Object Security.AccessControl.DirectorySecurity`, `$acl.SetAccessRuleProtection($true, $false)`,
          `$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))`,
          `foreach ($rule in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-19','ReadAndExecute'),@($ownerSid,'ReadAndExecute'))) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($rule[0])), $rule[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }`,
          `Set-Acl -LiteralPath $dir -AclObject $acl`,
          ...windowsStop(info, { resumeTask: false }),
          `Copy-Item -LiteralPath ${ps(stagedSource)} -Destination ${ps(info.runner)} -Force`,
          ...(!bundledBinary && !electronNode ? [`Copy-Item -LiteralPath ${ps(runtime)} -Destination ${ps(info.executable)} -Force`] : []),
          ...(electronNode ? [
            `$runtimeSource = ${ps(filePath.dirname(runtime))}`,
            `if (Get-ChildItem -LiteralPath $runtimeSource -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'The installed application runtime must not contain filesystem links.' }`,
            `New-Item -ItemType Directory -Force -Path ${ps(info.runtimeDir)} | Out-Null`,
            `Get-ChildItem -LiteralPath $runtimeSource -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination ${ps(info.runtimeDir)} -Recurse -Force }`,
          ] : []),
          `Copy-Item -LiteralPath ${ps(path.join(stage, 'profile.json'))} -Destination ${ps(info.profilePath)} -Force`,
          `Copy-Item -LiteralPath ${ps(path.join(stage, 'definition'))} -Destination ${ps(info.definition)} -Force`,
          `New-Item -ItemType Directory -Force -Path ${ps(info.stateDir)} | Out-Null`,
          `$stateAcl = Get-Acl -LiteralPath ${ps(info.stateDir)}`,
          `$stateAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-19')), 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))`,
          `Set-Acl -LiteralPath ${ps(info.stateDir)} -AclObject $stateAcl`,
          ...['stop', 'paused.json', 'status.json'].map((name) => `Remove-Item -LiteralPath ${ps(filePath.join(info.stateDir, name))} -Force -ErrorAction SilentlyContinue`),
          `$ownedFiles = @(${[info.runner,info.profilePath,info.definition,...(!bundledBinary&&!electronNode?[info.executable]:[])].map(ps).join(', ')})`,
          ...(electronNode ? [`$ownedFiles += @(${ps(info.runtimeDir)}); $ownedFiles += @(Get-ChildItem -LiteralPath ${ps(info.runtimeDir)} -Recurse -Force | ForEach-Object { $_.FullName })`] : []),
          `foreach ($ownedFile in $ownedFiles) { $fileAcl = Get-Acl -LiteralPath $ownedFile; $fileAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544'))); Set-Acl -LiteralPath $ownedFile -AclObject $fileAcl }`,
          `$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Argument ${ps('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + info.definition + '"')}`,
          `$trigger = New-ScheduledTaskTrigger -AtStartup`,
          `$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited`,
          `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)`,
          `Register-ScheduledTask -TaskName $job -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'PrivateTunnel: starts at boot before sign-in' -Force | Out-Null`,
          `Start-ScheduledTask -TaskName $job`);
      } else if (action === 'remove') {
        content.push(...windowsStop(info, { resumeTask: false }),
          `Unregister-ScheduledTask -TaskName $job -Confirm:$false -ErrorAction SilentlyContinue`,
          `if (Get-ScheduledTask -TaskName $job -ErrorAction SilentlyContinue) { throw 'The startup task could not be removed. Service files were preserved.' }`,
          ...[info.profilePath, info.definition].map((file) => `if (Test-Path -LiteralPath ${ps(file)}) { Remove-Item -LiteralPath ${ps(file)} -Force }`),
          // Executables can remain locked by scanners after the worker exits.
          // That must not resurrect an already unregistered startup job.
          ...[info.runner, ...(!bundledBinary && !electronNode ? [info.executable] : [])].map((file) => `if (Test-Path -LiteralPath ${ps(file)}) { try { Remove-Item -LiteralPath ${ps(file)} -Force } catch { [IO.File]::WriteAllText(${ps(path.join(stage, 'cleanup-pending'))}, 'runtime') } }`));
        if (electronNode) content.push(`$runtimeRoot = [IO.Path]::GetFullPath(${ps(info.runtimeDir)})`,
          `$serviceRoot = [IO.Path]::GetFullPath($dir) + [IO.Path]::DirectorySeparatorChar`,
          `if (!$runtimeRoot.StartsWith($serviceRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime cleanup must stay inside its service directory.' }`,
          `if (Test-Path -LiteralPath $runtimeRoot) { if ((Get-Item -LiteralPath $runtimeRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime cleanup cannot follow a link.' }; try { Remove-Item -LiteralPath $runtimeRoot -Recurse -Force } catch { [IO.File]::WriteAllText(${ps(path.join(stage, 'cleanup-pending'))}, 'runtime') } }`);
      } else if (stopping) content.push(...windowsStop(info));
      else content.push(...['stop', 'paused.json', 'status.json'].map((name) => `Remove-Item -LiteralPath ${ps(filePath.join(info.stateDir, name))} -Force -ErrorAction SilentlyContinue`), `Start-ScheduledTask -TaskName $job`);
      content.push(`[IO.File]::WriteAllText(${ps(path.join(stage, 'success'))}, 'ok')`);
      return `${WINDOWS_POWERSHELL_INIT}\r\n$ErrorActionPreference = 'Stop'\r\ntry {\r\n${content.join('\r\n')}\r\n} catch { [IO.File]::WriteAllText(${ps(path.join(stage, 'error'))}, $_.Exception.Message); exit 1 }\r\n`;
    }
    const lines = ['#!/bin/sh', 'set -eu'];
    const uid = Number(user.uid), gid = Number(user.gid);
    if (installing) {
      if (!termux && (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0)) throw new Error('Run PrivateTunnel as a regular user. The installer will request administrator access itself.');
      lines.push(`[ ! -L ${sh(info.directory)} ] || { echo 'Service directory must not be a link.' >&2; exit 1; }`,
        `mkdir -p ${sh(info.directory)} ${sh(info.stateDir)}`);
      if (provider === 'systemd') lines.push(`command -v systemctl >/dev/null || { echo 'Linux boot startup requires systemd.' >&2; exit 1; }`, `systemctl stop ${sh(info.job)} 2>/dev/null || true`);
      if (provider === 'launchd') lines.push(`launchctl bootout system/${sh('com.jindanet.' + info.job)} 2>/dev/null || true`);
      lines.push(`cp ${sh(stagedSource)} ${sh(info.runner)}`, `cp ${sh(path.join(stage, 'profile.json'))} ${sh(info.profilePath)}`,
        `mkdir -p ${sh(filePath.dirname(info.definition))}`, `cp ${sh(path.join(stage, 'definition'))} ${sh(info.definition)}`,
        `chmod 600 ${sh(info.profilePath)}`, `chmod ${bundledBinary ? '755' : '644'} ${sh(info.runner)}`, `chmod 700 ${sh(info.stateDir)}`);
      if (!termux) lines.push(`chown 0:${gid} ${sh(info.directory)} ${sh(info.runner)}`, `chmod 750 ${sh(info.directory)}`,
        `chown ${uid}:${gid} ${sh(info.profilePath)} ${sh(info.stateDir)}`, `chown 0:0 ${sh(info.definition)}`, `chmod 644 ${sh(info.definition)}`);
      else lines.push(`chmod 700 ${sh(info.directory)} ${sh(info.definition)}`);
    }
    if (provider === 'systemd') {
      if (installing) lines.push('systemctl daemon-reload', `systemctl enable --now ${sh(info.job)}`);
      else if (action === 'remove') lines.push(`systemctl disable --now ${sh(info.job)}`, `rm -f ${sh(info.definition)} ${sh(info.profilePath)} ${sh(info.runner)}`, 'systemctl daemon-reload');
      else lines.push(`systemctl ${stopping ? 'stop' : 'start'} ${sh(info.job)}`);
    } else if (provider === 'launchd') {
      if (installing) lines.push(`launchctl enable system/${sh('com.jindanet.' + info.job)}`, `launchctl bootstrap system ${sh(info.definition)}`);
      else if (action === 'remove' || action === 'stop') {
        lines.push(`launchctl bootout system/${sh('com.jindanet.' + info.job)} 2>/dev/null || true`);
        if (action === 'remove') lines.push(`rm -f ${sh(info.definition)} ${sh(info.profilePath)} ${sh(info.runner)}`);
      } else lines.push(`if launchctl print system/${sh('com.jindanet.' + info.job)} >/dev/null 2>&1; then launchctl kickstart system/${sh('com.jindanet.' + info.job)}; else launchctl bootstrap system ${sh(info.definition)}; fi`);
    } else {
      // The runner checks a stop marker and owns a pid lock; never kill an
      // arbitrary process using a potentially recycled pid from disk.
      if (stopping) lines.push(`touch ${sh(filePath.join(info.stateDir, 'stop'))}`);
      else lines.push(`rm -f ${sh(filePath.join(info.stateDir, 'stop'))}`, `sh ${sh(info.definition)}`);
      if (action === 'remove') lines.push(`rm -f ${sh(info.definition)} ${sh(info.profilePath)}`);
    }
    lines.push(`printf ok > ${sh(path.join(stage, 'success'))}`);
    return lines.join('\n') + '\n';
  }

  async function apply(info, action, profile) {
    if (termux && action === 'install') {
      const lockPath = filePath.join(info.stateDir, 'runner.lock');
      const lock = readJson(lockPath);
      if (Number.isInteger(lock?.pid)) {
        let alive = false;
        try { process.kill(lock.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (alive) {
          writePrivate(filePath.join(info.stateDir, 'stop'), '');
          for (let attempt = 0; attempt < 30 && fs.existsSync(lockPath); attempt++) await new Promise((resolve) => setTimeout(resolve, 200));
          if (fs.existsSync(lockPath)) throw new Error('The previous Termux worker did not stop. Try startup stop, then install again.');
        }
      }
    }
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ptunnel-startup-'));
    if (process.platform !== 'win32') fs.chmodSync(stage, 0o700);
    const windows = platform === 'win32' && !termux;
    const script = path.join(stage, windows ? 'install.ps1' : 'install.sh');
    try {
      if (profile) writePrivate(path.join(stage, 'profile.json'), JSON.stringify({ version: 1, profile, stateDir: info.stateDir }));
      // Extract the JS with Electron's fs support before elevation: OS tools
      // cannot copy a file located inside a packaged app.asar archive.
      if (profile && !bundledBinary) writePrivate(path.join(stage, 'runner'), fs.readFileSync(source));
      writePrivate(path.join(stage, 'definition'), (windows ? '\ufeff' : '') + definition(info));
      writePrivate(script, (windows ? '\ufeff' : '') + installer(info, action, stage));
      if (windows) {
        const inner = `-NoProfile -ExecutionPolicy Bypass -File "${script}"`;
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${WINDOWS_POWERSHELL_INIT}$p = Start-Process -FilePath powershell.exe -ArgumentList ${ps(inner)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`]);
      } else if (termux) await run(filePath.join(env.PREFIX || '/data/data/com.termux/files/usr', 'bin/sh'), [script]);
      else if (process.getuid?.() === 0) await run('/bin/sh', [script]);
      else if (platform === 'darwin') await run('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify('/bin/sh ' + sh(script))} with administrator privileges`]);
      else await run(gui ? 'pkexec' : 'sudo', ['/bin/sh', script], { interactive: !gui });
      if (!fs.existsSync(path.join(stage, 'success'))) throw new Error('Startup installation was not confirmed. No startup entry was saved.');
      return { cleanupPending: fs.existsSync(path.join(stage, 'cleanup-pending')) };
    } catch (error) {
      const detailPath = path.join(stage, 'error');
      const detail = fs.existsSync(detailPath) ? fs.readFileSync(detailPath, 'utf8') : error.message;
      throw new Error(`Startup ${action} failed: ${detail}`);
    } finally {
      // Remove only the known staging files, never arbitrary recursive paths.
      for (const name of ['profile.json', 'runner', 'definition', windows ? 'install.ps1' : 'install.sh', 'success', 'error', 'cleanup-pending']) {
        try { fs.unlinkSync(path.join(stage, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      fs.rmdirSync(stage);
    }
  }

  async function enable(input, { dryRun = false } = {}) {
    const profile = validateProfile(input);
    const id = crypto.createHash('sha256').update(profile.clientId).digest('hex').slice(0, 16);
    const info = describe(id);
    if (dryRun) return { ...info, executable: info.executable, credentialNote: 'A separate access key copy is stored in a private service profile. No key is placed in command arguments.' };
    if (!fs.existsSync(source) || !fs.existsSync(runtime)) throw new Error('The startup runtime is missing. Reinstall PrivateTunnel or rebuild ptunnel.js first.');
    if (platform === 'win32' && !user.sid) {
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
      user = { ...user, sid: result.trim() };
      if (!/^S-1-[0-9-]+$/.test(user.sid)) throw new Error('Cannot determine your Windows user SID.');
    }
    await apply(info, 'install', profile);
    const manifest = load();
    const entry = { id, clientId: profile.clientId, tunnelType: profile.tunnelType, localHost: profile.localHost, localPort: profile.localPort, installedAt: new Date().toISOString() };
    manifest.entries = manifest.entries.filter((item) => item.id !== id).concat(entry);
    writePrivate(manifestPath, JSON.stringify(manifest, null, 2));
    return { ...entry, ...info };
  }

  async function control(id, action) {
    if (!['start', 'stop', 'remove'].includes(action)) throw new Error('Invalid startup action.');
    const manifest = load();
    const entry = manifest.entries.find((item) => item.id === id);
    if (!entry) throw new Error('Startup tunnel not found. Run startup status to list IDs.');
    const result = await apply(describe(id), action);
    if (action === 'remove') {
      manifest.entries = manifest.entries.filter((item) => item.id !== id);
      writePrivate(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return { ok: true, ...result };
  }

  let mutations = Promise.resolve();
  const serial = (operation) => (...args) => {
    const result = mutations.then(() => operation(...args));
    mutations = result.catch(() => {});
    return result;
  };
  return { enable: serial(enable), control: serial(control), status, describe, definition, installer, manifestPath, provider };
}

module.exports = { createStartupManager, validateProfile, writePrivate, readJson, execute, WINDOWS_POWERSHELL_INIT };
