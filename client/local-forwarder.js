const http = require('node:http');

function createForwardRequest(host, port, method, path, headers) {
  const fwdHeaders = { ...headers };
  fwdHeaders.host = `${host}:${port}`;
  delete fwdHeaders.connection;
  delete fwdHeaders.upgrade;

  let localReq = null;
  let settled = false;
  let rejectResponse;
  const responsePromise = new Promise((resolve, reject) => {
    rejectResponse = reject;

    localReq = http.request({
      hostname: host,
      port,
      method,
      path,
      headers: fwdHeaders,
    }, (localRes) => {
      settled = true;
      resolve({
        statusCode: localRes.statusCode,
        headers: localRes.headers,
        bodyStream: localRes,
      });
    });

    localReq.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });

  return {
    localReq,
    responsePromise,
    abort(err) {
      if (!settled && rejectResponse) {
        settled = true;
        rejectResponse(err);
      }
      if (localReq && !localReq.destroyed) {
        localReq.destroy(err);
      }
    },
  };
}

async function forwardRequest(host, port, method, path, headers, bodyChunks) {
  const stream = createForwardRequest(host, port, method, path, headers);
  for (const chunk of bodyChunks) {
    stream.localReq.write(chunk);
  }
  stream.localReq.end();
  return stream.responsePromise;
}

module.exports = { forwardRequest, createForwardRequest };
