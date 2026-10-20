// Demo app for `yarn dev`: a steady stream of colored log output to exercise the log
// viewer -- levels, 256/true colors, a \r progress bar now and then, and stack traces.
const http = require('http');

// Started with "portEnv": "CHATTY_PORT" in yarn dev's servers.json, so that's where its port is.
const port = Number(process.env.CHATTY_PORT);
if (!port) { console.error('chatty: CHATTY_PORT is not set'); process.exit(1); }
if (process.env.PORT) console.log(`(PORT is also set: ${process.env.PORT}, which it shouldn't be)`);
const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
const stamp = () => c(90, new Date().toISOString().slice(11, 23));
const lines = [
  () => `${c(32, 'GET')} /api/cart ${c(32, 200)} ${Math.round(Math.random() * 40)}ms`,
  () => `${c(32, 'GET')} /checkout ${c(32, 200)} ${Math.round(Math.random() * 90)}ms`,
  () => `${c(36, 'info')}  cache hit ratio ${(0.8 + Math.random() * 0.19).toFixed(2)}`,
  () => `${c(33, 'warn')}  slow query (${Math.round(300 + Math.random() * 900)}ms): SELECT * FROM orders`,
  () => `${c(31, 'ERROR')} fetch /api/inventory failed: timeout after 5000ms`,
  () => `${c('38;5;208', 'event')} user.signup ${c('38;2;255;105;180', '{"plan":"pro"}')} ✨`,
  () => `${c(32, 'POST')} /api/orders ${c(33, 201)} ${Math.round(Math.random() * 120)}ms`,
];

let n = 0;
setInterval(() => {
  n++;
  if (n % 25 === 0) {
    console.log(`${stamp()} ${c(31, 'ERROR')} Unhandled rejection in worker`);
    console.log(new Error('connection reset by peer').stack.split('\n').slice(0, 4).join('\n'));
    return;
  }
  if (n % 40 === 0) { // a progress bar redrawn with \r, like a bundler
    let p = 0;
    const bar = setInterval(() => {
      p += 10;
      process.stdout.write(`\r${stamp()} rebuilding ${'#'.repeat(p / 10).padEnd(10)} ${p}%`);
      if (p >= 100) { clearInterval(bar); process.stdout.write(`\n${stamp()} ${c(32, 'compiled')} in 1.2s\n`); }
    }, 80);
    return;
  }
  console.log(`${stamp()} ${lines[n % lines.length]()}`);
}, 700);

http.createServer((req, res) => res.end('chatty: see its log')).listen(port, () => console.log(`${c(32, 'chatty')} listening on :${port}`));
