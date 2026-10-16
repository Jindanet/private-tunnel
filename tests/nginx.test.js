const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNginxConfig } = require('../server/nginx');
const { buildRuntimeRoutes } = require('../server/routing');

function serverBlocks(config) {
  // Each server starts at column zero; nested locations are indented.
  return [...config.matchAll(/^server \{\n[\s\S]*?^\}/gm)].map((match) => match[0]);
}

test('the exact primary host never shares an admin block with wildcard publish hosts', () => {
  const config = buildNginxConfig({ primaryDomain: 'example.com', publishDomains: [
    { domain: 'example.com', allowRoot: true, allowSubdomain: true },
    { domain: 'apps.example.com', allowRoot: true, allowSubdomain: true },
    { domain: 'demo.example.net', allowRoot: true, allowSubdomain: false },
  ] });
  const tls = serverBlocks(config).filter((block) => block.includes('listen 443 ssl;'));
  const admin = tls.filter((block) => block.includes(':8081;'));
  assert.equal(admin.length, 1);
  assert.match(admin[0], /server_name example\.com;/);
  assert.doesNotMatch(admin[0], /server_name[^;]*\*/);
  const publish = tls.filter((block) => block.includes(':8082;'));
  assert.equal(publish.length, 3);
  assert.match(publish[0], /server_name \*\.example\.com;/);
  assert.match(publish[1], /server_name apps\.example\.com \*\.apps\.example\.com;/);
  assert.match(publish[2], /server_name demo\.example\.net;/);
  for (const block of publish) {
    assert.match(block, /location = \/_private-tunnel \{ return 404; \}/);
    assert.match(block, /location \^~ \/_private-tunnel\/ \{ return 404; \}/);
    assert.doesNotMatch(block, /:8080;|:8081;/);
  }
});

test('custom control roots use slash boundaries and route WS independently', () => {
  const runtime = { primaryDomain: 'admin.example.com', controlRoot: '/control/secure', publishDomains: [
    { domain: 'publish.example.com', allowSubdomain: false, allowRoot: true },
  ] };
  const config = buildNginxConfig(runtime, buildRuntimeRoutes(runtime), { wsPort: 9000, dashboardPort: 9001, proxyPort: 9002 });
  assert.match(config, /location = \/control\/secure\/ws \{\n        proxy_pass http:\/\/127\.0\.0\.1:9000;/);
  assert.match(config, /location \^~ \/control\/secure\/admin\/ \{/);
  assert.doesNotMatch(config, /location \^~ \/control\/secure\/admin \{/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(config, /proxy_set_header Connection \$pt_connection_upgrade;/);
  for (const block of serverBlocks(config).filter((block) => block.includes('proxy_pass'))) {
    assert.match(block, /proxy_set_header X-Real-IP \$remote_addr;/);
    assert.match(block, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  }
  assert.doesNotMatch(config, /proxy_add_x_forwarded_for/);
});

test('disabled publish modes do not create servers and invalid config cannot inject directives', () => {
  const config = buildNginxConfig({ primaryDomain: 'admin.example.com', publishDomains: [
    { domain: 'disabled.example.com', allowSubdomain: false, allowRoot: false },
    { domain: 'evil.example.com; return 200;', allowRoot: true },
  ] });
  assert.doesNotMatch(config, /disabled\.example\.com|evil\.example\.com/);
  assert.equal(serverBlocks(config).length, 2);
  assert.throws(() => buildNginxConfig({primaryDomain: 'admin.example.com', controlRoot: '/;return'}));
  assert.throws(() => buildNginxConfig({primaryDomain: 'admin.example.com'}, {}, {wsPort: '8080; bad'}));
  assert.match(buildNginxConfig({}), /Configure a valid primary/);
  assert.match(config, /DNS-01/);
});
