'use strict';

const DEFAULT_TCP_ALLOWED_PORTS = '30000-40000';
const ALLOCATION_ORDER = [[30000, 40000], [40001, 65535], [1024, 29999]];

// This is an operator declaration of ports opened in all relevant firewalls/NAT,
// not an inference from bind() or a claim of external reachability.
function parseTcpAllowedPorts(value = DEFAULT_TCP_ALLOWED_PORTS) {
  const invalid = () => new Error('TCP_ALLOWED_PORTS must list ports/ranges between 1024 and 65535, e.g. 30000-40000,45000-45010.');
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw invalid();
  const entries = value.split(',');
  if (entries.length > 256) throw invalid();
  const ranges = entries.map((entry) => {
    const match = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(entry.trim());
    if (!match) throw invalid();
    const first = Number(match[1]);
    const last = Number(match[2] || match[1]);
    if (first < 1024 || last > 65535 || first > last) throw invalid();
    return [first, last];
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [first, last] of ranges) {
    const previous = merged.at(-1);
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  return merged;
}

function* publicTcpPorts(allowedRanges) {
  for (const [preferredFirst, preferredLast] of ALLOCATION_ORDER) {
    for (const [allowedFirst, allowedLast] of allowedRanges) {
      const last = Math.min(preferredLast, allowedLast);
      for (let port = Math.max(preferredFirst, allowedFirst); port <= last; port++) yield port;
    }
  }
}

module.exports = { DEFAULT_TCP_ALLOWED_PORTS, parseTcpAllowedPorts, publicTcpPorts };
