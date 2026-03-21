const { execSync } = require('node:child_process');

const platform = process.platform;

function isElevated() {
  try {
    if (platform === 'win32') {
      execSync('net session', { stdio: 'pipe' });
    } else {
      return process.getuid && process.getuid() === 0;
    }
    return true;
  } catch {
    return false;
  }
}

function warnIfNotElevated() {
  if (!isElevated()) {
    const cmd = platform === 'win32'
      ? 'Run as Administrator'
      : 'sudo node server/index.js';
    console.warn(`[Firewall] WARNING: Not running as admin/root — TCP firewall rules will NOT be added automatically.`);
    console.warn(`[Firewall]          To enable auto firewall: ${cmd}`);
  }
}

function openPort(port) {
  try {
    if (platform === 'win32') {
      execSync(
        `netsh advfirewall firewall add rule name="PTunnel-TCP-${port}" dir=in action=allow protocol=TCP localport=${port}`,
        { stdio: 'pipe' }
      );
    } else if (platform === 'linux') {
      // Try ufw first, fall back to iptables
      try {
        execSync(`ufw allow ${port}/tcp`, { stdio: 'pipe' });
      } catch {
        execSync(`iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport ${port} -j ACCEPT`, { stdio: 'pipe' });
      }
    }
    // macOS: application firewall, no port-level rules needed by default
    return true;
  } catch (err) {
    console.warn(`[Firewall] Could not open port ${port}: ${err.message.trim().split('\n')[0]} (run server as admin/root for auto firewall)`);
    return false;
  }
}

function closePort(port) {
  try {
    if (platform === 'win32') {
      execSync(
        `netsh advfirewall firewall delete rule name="PTunnel-TCP-${port}"`,
        { stdio: 'pipe' }
      );
    } else if (platform === 'linux') {
      try {
        execSync(`ufw delete allow ${port}/tcp`, { stdio: 'pipe' });
      } catch {
        execSync(`iptables -D INPUT -p tcp --dport ${port} -j ACCEPT`, { stdio: 'pipe' });
      }
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { openPort, closePort, warnIfNotElevated };
