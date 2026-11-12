'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateProfile, writePrivate, readJson, WINDOWS_POWERSHELL_INIT } = require('./startup');
const TunnelClient = require('./tunnel-client');
const { version } = require('../package.json');

function windowsBootId() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    WINDOWS_POWERSHELL_INIT + "[Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"],
  { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error('Cannot verify Windows boot identity. Try starting the boot service again.');
  return result.stdout.trim();
}

function sameWorker(pid, profilePath) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (['linux', 'android'].includes(process.platform)) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(profilePath); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/ps';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', `${WINDOWS_POWERSHELL_INIT}$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if($p){[Console]::Write($p.CommandLine)}`]
    : ['-p', String(pid), '-o', 'command='];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  if (result.error || result.status !== 0) throw new Error('Cannot verify the previous startup worker. Inspect runner.lock before restarting.');
  return process.platform === 'win32' ? result.stdout.toLowerCase().includes(profilePath.toLowerCase()) : result.stdout.includes(profilePath);
}

// A service never prompts or reads the interactive user's default profile.
// Network failures reconnect in TunnelClient; OS managers handle process crashes.
function runStartup(profilePath, { Client = TunnelClient, intervalMs = 3000, bootId = windowsBootId } = {}) {
  const data = readJson(profilePath);
  if (data?.version !== 1 || typeof data.stateDir !== 'string' || !path.isAbsolute(data.stateDir)) throw new Error('Invalid startup service profile. Reinstall the startup tunnel.');
  const profile = validateProfile(data.profile);
  const stateDir = data.stateDir;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, 'runner.lock');
  const stopPath = path.join(stateDir, 'stop');
  const pausePath = path.join(stateDir, 'paused.json');
  // A task retry must not undo an explicit Stop. The pause belongs to this
  // Windows boot only, so the installed AtStartup trigger still works tomorrow.
  const pause = readJson(pausePath);
  if (pause) {
    if (typeof pause.bootId !== 'string' || !pause.bootId) throw new Error('Invalid boot service pause. Use startup start to clear it.');
    if (pause.bootId === bootId()) return null;
    fs.unlinkSync(pausePath);
    try { fs.unlinkSync(stopPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readJson(lockPath);
    if (!Number.isInteger(previous?.pid)) throw new Error('Invalid startup lock. Inspect runner.lock before restarting.');
    // A PID can be reused after a reboot or crash. Compare its actual launch
    // command, not just its existence, before treating the old lock as active.
    if (sameWorker(previous.pid, profilePath)) return null;
    fs.unlinkSync(lockPath);
    lock = fs.openSync(lockPath, 'wx', 0o600);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); fs.closeSync(lock);
  let stopped = false, timer;
  const logPath = path.join(stateDir, 'service.log');
  let state = { status: 'connecting', url: '', error: null };
  const clean = (value) => String(value || '').replaceAll(profile.token, '[hidden]').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 2000);
  function save() { writePrivate(path.join(stateDir, 'status.json'), JSON.stringify({ ...state, version, pid: process.pid, updatedAt: new Date().toISOString() })); }
  function log(message) {
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 1024 * 1024) fs.renameSync(logPath, logPath + '.1');
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${clean(message)}\n`, { mode: 0o600 });
    } catch { /* Logging must not interrupt forwarding. */ }
  }
  function update(next) { state = { ...state, ...next }; save(); log(`${state.status} ${state.error || state.url}`); }
  const client = new Client({ ...profile,
    onConnected: ({ url, dataTransportVersion }) => { if (!stopped) update({ status: 'online', url: clean(url), error: null, dataTransportVersion }); },
    onDiagnostic: log,
    onDisconnected: (info) => { if (!stopped) update({ status: 'reconnecting', url: '', error: clean(info?.message || 'Tunnel connection closed; reconnecting.') }); },
    onError: (error) => {
      if (stopped) return;
      const terminal = ['EUNAUTHORIZED', 'ETUNNELSETUP'].includes(error.code) || !client.shouldReconnect;
      update({ status: terminal ? 'error' : 'reconnecting', error: clean(error.message), url: '' });
      if (terminal) stop(true);
    },
  });
  function stop(failed = false) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.removeListener('SIGINT', signalStop); process.removeListener('SIGTERM', signalStop);
    client.disconnect();
    if (!failed) state = { status: 'stopped', url: '', error: null };
    save();
    fs.unlinkSync(lockPath);
    try { fs.unlinkSync(stopPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const timeout = setTimeout(() => client.ws?.terminate(), 1500); timeout.unref();
    client.ws?.once('close', () => clearTimeout(timeout));
    // Authentication/configuration failures remain visible and do not restart
    // forever under launchd's SuccessfulExit or Task Scheduler's retry policy.
    process.exitCode = 0;
  }
  const signalStop = () => stop();
  process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
  timer = setInterval(() => {
    try { if (fs.existsSync(stopPath) || fs.existsSync(pausePath)) stop(); else save(); }
    catch (error) { log(error.message); stop(true); }
  }, intervalMs);
  try { log(`worker version=${version}`); save(); client.connect(); }
  catch (error) { state = { status: 'error', url: '', error: clean(error.message) }; stop(true); throw error; }
  return { stop, client, get state() { return state; } };
}

module.exports = { runStartup };
