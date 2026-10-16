const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const net = require('node:net');

const platform = process.platform;
const ownedRules = new Map();
const commandOptions = {
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 5000,
  maxBuffer: 16384,
  windowsHide: true,
};

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function run(file, args) {
  execFileSync(file, args, commandOptions);
}

function errorSummary(error) {
  return String(error && error.message || error || 'Unknown error').trim().split('\n')[0];
}

function manualAdvice() {
  return 'Configure firewall rules separately with AUTO_FIREWALL=false so PrivateTunnel can run without elevated privileges.';
}

function isElevated() {
  try {
    if (platform === 'win32') {
      run('net', ['session']);
      return true;
    }
    return typeof process.getuid === 'function' && process.getuid() === 0;
  } catch {
    return false;
  }
}

function warnIfNotElevated() {
  if (process.env.AUTO_FIREWALL !== 'true') return;
  if (platform !== 'win32' && platform !== 'linux') {
    console.warn(`[Firewall] Automatic local firewall rules are unsupported on ${platform}. ${manualAdvice()}`);
  } else if (!isElevated()) {
    console.warn(`[Firewall] Automatic local firewall rules may be unavailable to this account. ${manualAdvice()}`);
  }
}

function ruleProviders(host) {
  if (host !== undefined && (typeof host !== 'string' || !net.isIP(host))) return null;
  if (platform === 'win32') return ['netsh'];
  if (platform !== 'linux') return null;
  if (host === undefined || (net.isIP(host) === 6 && /^[0:]+$/.test(host.split('%')[0]))) {
    return ['iptables', 'ip6tables'];
  }
  return [net.isIP(host) === 4 ? 'iptables' : 'ip6tables'];
}

function makeRule(provider, port, name) {
  if (provider === 'netsh') {
    return {
      provider,
      name,
      add: ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`,
        'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`],
      remove: ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`],
    };
  }
  const match = ['INPUT', '-p', 'tcp', '--dport', String(port), '-m', 'comment', '--comment', name, '-j', 'ACCEPT'];
  return {
    provider,
    name,
    add: ['-w', '2', '-I', ...match],
    remove: ['-w', '2', '-D', ...match],
  };
}

function releaseRules(port, lease) {
  const remaining = [];
  for (const rule of [...lease.rules].reverse()) {
    try {
      run(rule.provider, rule.remove);
    } catch (error) {
      remaining.unshift(rule);
      console.warn(`[Firewall] Could not remove owned local rule ${rule.name} for port ${port}: ${errorSummary(error)}`);
    }
  }
  lease.rules = remaining;
  if (!remaining.length && ownedRules.get(port) === lease) ownedRules.delete(port);
  return remaining.length === 0;
}

function openPort(port, options = {}) {
  if (!validPort(port)) return false;
  // Eligibility is checked against the server owner's declared port policy elsewhere.
  // A no-op or successful local command does not verify cloud firewall/NAT reachability.
  if (process.env.AUTO_FIREWALL !== 'true') return true;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return false;
  const providers = ruleProviders(options.host);
  if (!providers) {
    console.warn(`[Firewall] Automatic local firewall rules need a supported Windows/Linux provider and a valid bind IP. ${manualAdvice()}`);
    return false;
  }

  const existing = ownedRules.get(port);
  if (existing) {
    if (existing.ready) {
      return providers.every((provider) => existing.rules.some((rule) => rule.provider === provider));
    }
    // Keep uncertain rules owned and retry their exact cleanup before reusing the port.
    if (!releaseRules(port, existing)) return false;
  }

  const name = `PTunnel-TCP-${randomUUID()}-${port}`;
  const lease = { ready: false, rules: [] };
  ownedRules.set(port, lease);
  try {
    for (const provider of providers) {
      const rule = makeRule(provider, port, name);
      // Record the unique identity first: a timed-out command may already have applied it.
      lease.rules.push(rule);
      run(rule.provider, rule.add);
    }
    lease.ready = true;
    return true;
  } catch (error) {
    console.warn(`[Firewall] Could not add local rules for port ${port}: ${errorSummary(error)}. ${manualAdvice()}`);
    releaseRules(port, lease);
    return false;
  }
}

function closePort(port) {
  if (!validPort(port)) return false;
  const lease = ownedRules.get(port);
  // Never inspect or delete existing administrator-managed rules.
  if (!lease) return true;
  lease.ready = false;
  return releaseRules(port, lease);
}

module.exports = { openPort, closePort, warnIfNotElevated };
