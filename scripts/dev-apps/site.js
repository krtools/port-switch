// Demo app for `yarn dev`: a page with a live WebSocket (like a dev server's HMR socket),
// 404 "Cannot GET" for unknown paths (like Express), and a redirect to localhost:<port>.
const http = require('http');
const crypto = require('crypto');

const port = Number(process.env.PORT);
const stamp = () => new Date().toISOString().slice(11, 19);

const page = `<!doctype html><meta charset="utf-8"><title>site</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px">
<h1 style="font-size:20px">site</h1>
<p>A demo app on <code>:${port}</code>, served through port-switch.</p>
<p id="ws">WebSocket: connecting…</p>
<ul>
  <li><a href="/missing">/missing</a>: a 404 from the app ("Cannot GET")</li>
  <li><a href="/redirect">/redirect</a>: redirects to <code>http://localhost:${port}/</code>, rewritten to <code>/</code> by the proxy</li>
  <li><a href="/switch">/switch</a>: the switch page</li>
</ul>
<script>
  const el = document.getElementById('ws');
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
  ws.onopen = () => ws.send('hello from the page');
  ws.onmessage = (e) => { el.textContent = 'WebSocket: ' + e.data; };
  ws.onclose = () => { el.textContent = 'WebSocket: closed (switched away, or the server stopped)'; };
</script>`;

const server = http.createServer((req, res) => {
  console.log(`\x1b[90m${stamp()}\x1b[0m ${req.method} ${req.url}`);
  if (req.url === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page); return; }
  if (req.url === '/redirect') { res.writeHead(302, { location: `http://localhost:${port}/` }); res.end(); return; }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end(`Cannot GET ${req.url}`);
});

// Minimal WebSocket server on /ws: echoes text messages and sends the time every few seconds.
// Anything else that asks to upgrade gets a plain 404, like an app with no socket there.
const frame = (text) => {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
};
server.on('upgrade', (req, sock) => {
  sock.on('error', () => {});
  if (req.url !== '/ws' || !req.headers['sec-websocket-key']) {
    console.log(`\x1b[33m${stamp()} upgrade ${req.url} declined (404)\x1b[0m`);
    sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  console.log(`\x1b[32m${stamp()} websocket connected\x1b[0m`);
  const tick = setInterval(() => sock.write(frame(`server time ${stamp()}`)), 3000);
  sock.on('data', (buf) => {
    if ((buf[0] & 0x0f) === 8) { sock.end(); return; } // close frame
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
    const mask = buf.subarray(off, off + 4);
    const text = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4])).toString();
    console.log(`${stamp()} websocket says: ${text}`);
    sock.write(frame(`echo: ${text}`));
  });
  sock.on('close', () => { clearInterval(tick); console.log(`${stamp()} websocket closed`); });
});

server.listen(port, () => console.log(`\x1b[32msite\x1b[0m listening on :${port}`));
