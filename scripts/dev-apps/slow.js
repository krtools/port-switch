// Demo app for `yarn dev`: takes a few seconds before it listens, so the switch page shows
// it as "starting" and portctl waits for it.
const http = require('http');

const port = Number(process.env.PORT);
const delay = Number(process.env.DELAY_MS) || 6000;
console.log(`booting (listening in ${delay / 1000}s)...`);
let left = delay / 1000;
const t = setInterval(() => { left -= 1; if (left > 0) console.log(`  still booting, ${left}s`); }, 1000);
setTimeout(() => {
  clearInterval(t);
  http.createServer((req, res) => res.end('slow-start: finally up')).listen(port, () => console.log(`slow-start listening on :${port}`));
}, delay);
