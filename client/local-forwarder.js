const http = require('node:http');

function forwardRequest(host, port, method, path, headers, bodyChunks) {
  return new Promise((resolve, reject) => {
    const fwdHeaders = { ...headers };
    // Rewrite host to local target
    fwdHeaders['host'] = `${host}:${port}`;
    // Remove headers that shouldn't be forwarded
    delete fwdHeaders['connection'];
    delete fwdHeaders['upgrade'];

    const options = {
      hostname: host,
      port,
      method,
      path,
      headers: fwdHeaders,
    };

    const localReq = http.request(options, (localRes) => {
      resolve({
        statusCode: localRes.statusCode,
        headers: localRes.headers,
        bodyStream: localRes,
      });
    });

    localReq.on('error', (err) => {
      reject(err);
    });

    // Write body chunks
    for (const chunk of bodyChunks) {
      localReq.write(chunk);
    }
    localReq.end();
  });
}

// Streaming version — returns response as soon as headers arrive
function createForwardStream(host, port, method, path, headers) {
  return new Promise((resolve, reject) => {
    const fwdHeaders = { ...headers };
    fwdHeaders['host'] = `${host}:${port}`;
    delete fwdHeaders['connection'];
    delete fwdHeaders['upgrade'];

    const localReq = http.request({
      hostname: host,
      port,
      method,
      path,
      headers: fwdHeaders,
    }, (localRes) => {
      resolve({ localReq, localRes });
    });

    localReq.on('error', reject);
    resolve({ localReq, localRes: null });
  });
}

module.exports = { forwardRequest, createForwardStream };
