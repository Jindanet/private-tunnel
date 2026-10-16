const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');

const sourcePath = path.join(__dirname, '../server/firewall.js');
const source = fs.readFileSync(sourcePath, 'utf8');
let nextUuid = 0;

function fixture({ platform = 'linux', auto = 'true', uid = 1000, beforeCommand, afterCommand,
  rules = new Set(['iptables:operator-rule', 'netsh:PTunnel-TCP-30000']) } = {}) {
  const commands = [];
  const warnings = [];
  const env = { AUTO_FIREWALL: auto };
  let uidChecks = 0;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'node:net') return net;
      if (name === 'node:crypto') return {
        randomUUID: () => `00000000-0000-4000-8000-${String(++nextUuid).padStart(12, '0')}`,
      };
      assert.equal(name, 'node:child_process');
      return {
        execFileSync(file, args, options) {
          const command = { file, args: Array.from(args), options: { ...options } };
          commands.push(command);
          beforeCommand?.(command);
          if (file !== 'net') {
            const name = file === 'netsh'
              ? args.find((arg) => arg.startsWith('name=')).slice(5)
              : args[args.indexOf('--comment') + 1];
            command.rule = `${file}:${name}`;
            const adding = file === 'netsh' ? args.includes('add') : args.includes('-I');
            if (adding) rules.add(command.rule);
            else rules.delete(command.rule);
          }
          afterCommand?.(command);
          return Buffer.alloc(0);
        },
      };
    },
    module,
    process: { platform, env, getuid: () => { uidChecks++; return uid; } },
    console: { warn: (message) => warnings.push(message) },
  }, { filename: sourcePath });
  return { ...module.exports, commands, warnings, env, rules, uidChecks: () => uidChecks };
}

function ownedCommands(f) {
  return f.commands.filter((command) => command.file !== 'net');
}

function assertBoundedCommands(commands) {
  for (const { file, args, options } of commands) {
    assert.ok(Array.isArray(args));
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 16384);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
    if (file === 'iptables' || file === 'ip6tables') assert.deepEqual(args.slice(0, 2), ['-w', '2']);
  }
}

test('manual firewall mode requires no commands, permission checks or elevation on any platform', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const f = fixture({ platform, auto: 'false', beforeCommand: () => { throw new Error('Must never run'); } });
    f.warnIfNotElevated();
    assert.equal(f.openPort(30000), true);
    assert.equal(f.openPort(30001, { host: 'unused-in-manual-mode' }), true);
    assert.equal(f.closePort(30000), true);
    assert.equal(f.closePort(30001), true);
    assert.equal(f.uidChecks(), 0);
    assert.equal(f.commands.length, 0);
    assert.equal(f.warnings.length, 0);
    assert.equal(f.rules.size, 2);
  }
});

test('invalid numeric ports are rejected before all manual or automatic operations', () => {
  for (const auto of ['true', 'false']) {
    const f = fixture({ auto });
    for (const port of [-1, 0, 65536, 1.5, NaN, Infinity, '30000', null, undefined, {}]) {
      assert.equal(f.openPort(port), false);
      assert.equal(f.closePort(port), false);
    }
    assert.equal(f.commands.length, 0);
  }
  const manual = fixture({ auto: 'false' });
  assert.equal(manual.openPort(1), true);
  assert.equal(manual.openPort(65535), true);
});

test('unsupported automatic providers and invalid bind addresses fail without commands', () => {
  for (const platform of ['darwin', 'freebsd']) {
    const f = fixture({ platform });
    assert.equal(f.openPort(30000), false);
    f.warnIfNotElevated();
    assert.equal(f.commands.length, 0);
    assert.match(f.warnings.join('\n'), /AUTO_FIREWALL=false/);
  }
  for (const host of ['', 'example.com', '127.0.0.1; echo unsafe', 4, null, {}, []]) {
    const f = fixture();
    assert.equal(f.openPort(30000, { host }), false);
    assert.equal(f.commands.length, 0);
  }
  for (const options of [null, [], '127.0.0.1']) {
    const f = fixture();
    assert.equal(f.openPort(30000, options), false);
    assert.equal(f.commands.length, 0);
  }
});

test('Linux default listeners receive both address-family rules and exact owned cleanup', () => {
  const f = fixture();
  assert.equal(f.openPort(30000), true);
  assert.deepEqual(f.commands.map(({ file }) => file), ['iptables', 'ip6tables']);
  for (const { args } of f.commands) {
    assert.deepEqual(args.slice(0, 10), ['-w', '2', '-I', 'INPUT', '-p', 'tcp', '--dport', '30000', '-m', 'comment']);
    assert.equal(args[10], '--comment');
    assert.match(args[11], /^PTunnel-TCP-[0-9a-f-]+-30000$/);
    assert.deepEqual(args.slice(12), ['-j', 'ACCEPT']);
  }
  assert.equal(f.commands[0].args[11], f.commands[1].args[11]);
  const additions = f.commands.map(({ file, args }) => ({ file, args: [...args] }));
  assert.equal(f.closePort(30000), true);
  assert.deepEqual(f.commands.slice(2).map(({ file }) => file), ['ip6tables', 'iptables']);
  for (const [index, command] of f.commands.slice(2).entries()) {
    const addition = additions[1 - index];
    const expected = [...addition.args];
    expected[2] = '-D';
    assert.equal(command.file, addition.file);
    assert.deepEqual(command.args, expected);
  }
  assert.equal(f.closePort(30000), true);
  assert.equal(f.closePort(30001), true);
  assert.equal(f.commands.length, 4);
  assert.deepEqual([...f.rules].sort(), ['iptables:operator-rule', 'netsh:PTunnel-TCP-30000']);
  assertBoundedCommands(f.commands);
});

test('Linux rules follow explicit bind families, including equivalent IPv6 wildcard addresses', () => {
  for (const [host, providers] of [
    ['127.0.0.1', ['iptables']],
    ['0.0.0.0', ['iptables']],
    ['2001:db8::1', ['ip6tables']],
    ['::1', ['ip6tables']],
    ['::', ['iptables', 'ip6tables']],
    ['0:0:0:0:0:0:0:0', ['iptables', 'ip6tables']],
  ]) {
    const f = fixture();
    assert.equal(f.openPort(30000, { host }), true);
    assert.deepEqual(f.commands.map(({ file }) => file), providers);
    assert.equal(f.closePort(30000), true);
    assert.equal(f.rules.size, 2);
  }
});

test('Windows deletes only unique rules owned by its module instance, preserving other owners', () => {
  const rules = new Set(['netsh:PTunnel-TCP-30000']);
  const one = fixture({ platform: 'win32', rules });
  const two = fixture({ platform: 'win32', rules });
  assert.equal(one.openPort(30000), true);
  assert.equal(two.openPort(30000), true);
  const first = one.commands[0];
  const second = two.commands[0];
  assert.equal(first.file, 'netsh');
  assert.deepEqual(first.args.slice(0, 4), ['advfirewall', 'firewall', 'add', 'rule']);
  assert.match(first.args[4], /^name=PTunnel-TCP-[0-9a-f-]+-30000$/);
  assert.notEqual(first.args[4], second.args[4]);
  assert.deepEqual(first.args.slice(5), ['dir=in', 'action=allow', 'protocol=TCP', 'localport=30000']);
  assert.equal(one.closePort(30000), true);
  assert.deepEqual(one.commands[1].args, ['advfirewall', 'firewall', 'delete', 'rule', first.args[4]]);
  assert.ok(rules.has(second.rule));
  assert.ok(rules.has('netsh:PTunnel-TCP-30000'));
  assert.equal(one.closePort(30000), true);
  assert.equal(one.commands.length, 2);
  assert.equal(two.closePort(30000), true);
  assert.deepEqual([...rules], ['netsh:PTunnel-TCP-30000']);
  assertBoundedCommands([...one.commands, ...two.commands]);
});

test('repeated opens do not duplicate rules or claim a broader bind family than was opened', () => {
  const f = fixture();
  assert.equal(f.openPort(30000, { host: '127.0.0.1' }), true);
  assert.equal(f.openPort(30000, { host: '127.0.0.1' }), true);
  assert.equal(f.openPort(30000), false);
  assert.equal(f.commands.length, 1);
  const firstName = f.commands[0].args[11];
  assert.equal(f.closePort(30000), true);
  assert.equal(f.openPort(30000, { host: '127.0.0.1' }), true);
  assert.notEqual(f.commands[2].args[11], firstName);
  assert.equal(f.closePort(30000), true);
  assert.equal(f.rules.size, 2);
});

test('creation failures return false and attempt only exact owned rollback', () => {
  const f = fixture({ beforeCommand: ({ args }) => {
    if (args.includes('-I')) throw new Error('Permission denied');
  } });
  assert.equal(f.openPort(30000, { host: '127.0.0.1' }), false);
  assert.equal(f.commands.length, 2);
  const expected = [...f.commands[0].args];
  expected[2] = '-D';
  assert.deepEqual(f.commands[1].args, expected);
  assert.match(f.warnings.join('\n'), /AUTO_FIREWALL=false/);
  assert.equal(f.closePort(30000), true);
  assert.equal(f.commands.length, 2);
  assert.equal(f.rules.size, 2);
});

test('failure after applying the second family rolls back both attempted rules', () => {
  const f = fixture({ afterCommand: ({ file, args }) => {
    if (file === 'ip6tables' && args.includes('-I')) throw new Error('Command timed out after applying rule');
  } });
  assert.equal(f.openPort(30000), false);
  assert.deepEqual(f.commands.map(({ file, args }) => `${file}:${args[2]}`),
    ['iptables:-I', 'ip6tables:-I', 'ip6tables:-D', 'iptables:-D']);
  assert.equal(f.rules.size, 2);
  assert.equal(f.closePort(30000), true);
  assert.equal(f.commands.length, 4);
});

test('failed cleanup preserves ownership, retries safely and eventually releases all owned rules', () => {
  let failCleanup = true;
  const f = fixture({ beforeCommand: ({ args }) => {
    if (failCleanup && args.includes('-D')) throw new Error('Temporary cleanup failure');
  } });
  assert.equal(f.openPort(30000), true);
  assert.equal(f.closePort(30000), false);
  assert.equal(f.rules.size, 4);
  assert.equal(f.openPort(30000), false);
  assert.ok(f.commands.slice(2).every(({ args }) => args.includes('-D')));
  assert.match(f.warnings.join('\n'), /PTunnel-TCP-[0-9a-f-]+-30000/);
  failCleanup = false;
  assert.equal(f.openPort(30000), true);
  assert.equal(f.rules.size, 4);
  assert.equal(f.closePort(30000), true);
  const finalCount = f.commands.length;
  assert.equal(f.closePort(30000), true);
  assert.equal(f.commands.length, finalCount);
  assert.equal(f.rules.size, 2);
});

test('an unsuccessful add with uncertain cleanup remains owned until an exact retry succeeds', () => {
  let failing = true;
  const f = fixture({ beforeCommand: () => { if (failing) throw new Error('Provider unavailable'); } });
  assert.equal(f.openPort(30000), false);
  assert.equal(f.closePort(30000), false);
  failing = false;
  assert.equal(f.openPort(30000), true);
  assert.equal(f.closePort(30000), true);
  assert.equal(f.rules.size, 2);
});

test('owned rules still receive cleanup after automatic management is disabled', () => {
  const f = fixture();
  assert.equal(f.openPort(30000), true);
  f.env.AUTO_FIREWALL = 'false';
  assert.equal(f.closePort(30000), true);
  assert.equal(f.rules.size, 2);
  const count = f.commands.length;
  assert.equal(f.openPort(30001), true);
  assert.equal(f.closePort(30001), true);
  assert.equal(f.commands.length, count);
});

test('permission warnings recommend separate configuration without requesting elevated server execution', () => {
  const linux = fixture();
  linux.warnIfNotElevated();
  assert.equal(linux.commands.length, 0);
  assert.equal(linux.uidChecks(), 1);
  assert.match(linux.warnings[0], /Configure firewall rules separately.*without elevated privileges/);
  assert.doesNotMatch(linux.warnings[0], /sudo|Run as Administrator/);
  const root = fixture({ uid: 0 });
  root.warnIfNotElevated();
  assert.equal(root.warnings.length, 0);
  const windows = fixture({ platform: 'win32', beforeCommand: ({ file }) => {
    if (file === 'net') throw new Error('Access denied');
  } });
  windows.warnIfNotElevated();
  assert.deepEqual(windows.commands[0].args, ['session']);
  assert.match(windows.warnings[0], /AUTO_FIREWALL=false/);
  assertBoundedCommands(windows.commands);
  assert.equal(ownedCommands(windows).length, 0);
});
