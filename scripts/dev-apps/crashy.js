// Demo app for `yarn dev`: comes up, logs a little, then crashes with a stack trace and
// exit code 1 -- for the "exited" path, restart markers and previous-run dividers.
const http = require('http');

const port = Number(process.env.PORT);
http.createServer((req, res) => res.end('crashy: enjoy it while it lasts')).listen(port, () => {
  console.log(`\x1b[32mcrashy\x1b[0m listening on :${port}, crashing in 8s`);
  setTimeout(() => console.log('\x1b[33mwarn\x1b[0m  memory looks high'), 3000);
  setTimeout(() => { throw new Error('crashy crashed on purpose'); }, 8000);
});
