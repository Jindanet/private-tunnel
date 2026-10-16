const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_TCP_ALLOWED_PORTS, parseTcpAllowedPorts, publicTcpPorts } = require('../server/tcp-ports');

test('public TCP defaults to exactly the firewall-declared preferred range', () => {
  assert.equal(DEFAULT_TCP_ALLOWED_PORTS, '30000-40000');
  const ports = [...publicTcpPorts(parseTcpAllowedPorts())];
  assert.equal(ports.length, 10001);
  assert.equal(ports[0], 30000);
  assert.equal(ports.at(-1), 40000);
  assert.ok(!ports.includes(55525), 'Old OS-selected ports outside the default firewall range are excluded');
});

test('declared port ranges are validated, sorted and merged without duplicates', () => {
  const ranges = parseTcpAllowedPorts(' 45000-45002, 30002,30000 - 30001,45001-45004, 30000 ');
  assert.deepEqual(ranges, [[30000, 30002], [45000, 45004]]);
  assert.deepEqual([...publicTcpPorts(ranges)], [30000, 30001, 30002, 45000, 45001, 45002, 45003, 45004]);
});

test('all approved candidates follow preferred, high fallback, then other unprivileged ports', () => {
  const ports = [...publicTcpPorts(parseTcpAllowedPorts('1024-65535'))];
  assert.equal(ports.length, 65535 - 1024 + 1);
  assert.equal(new Set(ports).size, ports.length);
  assert.equal(ports[0], 30000);
  assert.equal(ports[10000], 40000);
  assert.equal(ports[10001], 40001);
  assert.equal(ports[35535], 65535);
  assert.equal(ports[35536], 1024);
  assert.equal(ports.at(-1), 29999);
  assert.ok(ports.every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535));
});

test('policy order never overrides allocation priority or adds undeclared candidates', () => {
  const ports = [...publicTcpPorts(parseTcpAllowedPorts('25000-25001,65535,40000-40001,30001'))];
  assert.deepEqual(ports, [30001, 40000, 40001, 65535, 25000, 25001]);
});

test('invalid, privileged, ephemeral, malformed and oversized policies fail closed', () => {
  const values = ['', ' ', null, false, 30000, [], {}, '0', '80', '1023', '65536', '-1',
    '40000-30000', '30000-', '30000,,30001', '30000,', ',30000', '30000.5', '3e4',
    '30000-65536', '1023-30000', '30000;echo unsafe', '30000\n30001', '1'.repeat(4097),
    Array(257).fill('30000').join(',')];
  for (const value of values) assert.throws(() => parseTcpAllowedPorts(value), /TCP_ALLOWED_PORTS/);
});
