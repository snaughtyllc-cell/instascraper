const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');

function decodeChunks(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    const length = Number.parseInt(buffer.toString('ascii', offset, lineEnd).split(';')[0], 16);
    if (lineEnd < 0 || !Number.isFinite(length)) throw new Error('Invalid chunked test response');
    if (length === 0) return Buffer.concat(chunks);
    offset = lineEnd + 2;
    chunks.push(buffer.subarray(offset, offset + length));
    offset += length + 2;
  }
  throw new Error('Incomplete chunked test response');
}

// Dispatch real Node HTTP messages through Express without opening a socket.
function appRequest(app, { method = 'GET', path = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const writes = [];
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, callback) { writes.push(Buffer.from(chunk)); callback(); },
    });
    socket.remoteAddress = '127.0.0.1';
    socket.encrypted = false;
    const req = new IncomingMessage(socket);
    req.method = method.toUpperCase();
    req.url = path;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.headers = { host: 'localhost' };
    for (const [name, value] of Object.entries(headers)) req.headers[name.toLowerCase()] = value;
    let payload;
    if (body !== undefined) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (!req.headers['content-type']) req.headers['content-type'] = 'application/json';
      req.headers['content-length'] = String(payload.length);
    }
    req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).flatMap(item => [name, String(item)]));
    req.complete = true;
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    const fail = error => { socket.destroy(); reject(error); };
    req.on('error', fail);
    res.on('error', fail);
    socket.on('error', fail);
    res.on('finish', () => {
      try {
        const wire = Buffer.concat(writes);
        const headerEnd = wire.indexOf('\r\n\r\n');
        if (headerEnd < 0) throw new Error('Missing test response headers');
        const responseHeaders = {};
        const lines = wire.toString('latin1', 0, headerEnd).split('\r\n').slice(1);
        for (const line of lines) {
          const colon = line.indexOf(':');
          const name = line.slice(0, colon).toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (name === 'set-cookie') (responseHeaders[name] ||= []).push(value);
          else responseHeaders[name] = responseHeaders[name] ? `${responseHeaders[name]}, ${value}` : value;
        }
        const rawBody = wire.subarray(headerEnd + 4);
        const text = (/\bchunked\b/i.test(responseHeaders['transfer-encoding'] || '') ? decodeChunks(rawBody) : rawBody).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: responseHeaders, text, body: parsed });
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    try {
      app.handle(req, res);
      if (payload) req.push(payload);
      req.push(null);
    } catch (error) { fail(error); }
  });
}

module.exports = { appRequest };
