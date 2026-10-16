const net = require('node:net');

function createTcpVisitorFilter(value = '') {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid TCP_VISITOR_ALLOWLIST.');
  if (!value.trim()) return () => true;
  const rules = value.split(',').map((rule) => rule.trim());
  if (rules.length > 256) throw new Error('TCP_VISITOR_ALLOWLIST accepts at most 256 rules.');
  const list = new net.BlockList();
  for (const rule of rules) {
    const parts = rule.split('/');
    const address = parts[0];
    const family = net.isIP(address);
    const maximum = family === 4 ? 32 : 128;
    if (!family || parts.length > 2 || (parts.length === 2
      && (!/^(0|[1-9][0-9]*)$/.test(parts[1]) || Number(parts[1]) > maximum))) {
      throw new Error('TCP_VISITOR_ALLOWLIST must contain comma-separated IP addresses or CIDR networks.');
    }
    if (parts.length === 2) list.addSubnet(address, Number(parts[1]), family === 4 ? 'ipv4' : 'ipv6');
    else list.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
  }
  return (address) => {
    const family = net.isIP(address);
    return Boolean(family && list.check(address, family === 4 ? 'ipv4' : 'ipv6'));
  };
}

module.exports = { createTcpVisitorFilter };
