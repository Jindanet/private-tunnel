const http = require('node:http');

const request = http.get({
  hostname: '127.0.0.1',
  port: Number(process.env.DASHBOARD_PORT || 8081),
  path: '/healthz',
  headers: { Host: 'localhost' },
  timeout: 3000,
}, (response) => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy(new Error('Health check timed out')));
request.on('error', () => { process.exitCode = 1; });
