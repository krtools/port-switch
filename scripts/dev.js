#!/usr/bin/env node
// yarn dev: build, then run port-switch against a sandbox in .dev/ (its own servers.json,
// .env and run/) with the demo servers in scripts/dev-apps/. Nothing outside .dev/ is used.
//
//   yarn dev             build, start, then rebuild + restart the proxy on every change in
//                        src/ (it keeps its selected server); Ctrl+C stops everything
//   yarn dev --detach    build and start, then exit and leave it running
//   yarn dev:stop        stop everything the dev setup started
//   yarn dev:ctl ...     portctl against the dev setup, e.g. yarn dev:ctl status
//
// env: DEV_PORT (default 4100; the demo servers use the next few ports)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEV = path.join(ROOT, '.dev');
const CONFIG = path.join(DEV, 'servers.json');
const PORTCTL = path.join(ROOT, 'dist', 'portctl.js');
const BASE = Number(process.env.DEV_PORT) || 4100;
const PASSWORD = 'dev';
const AUTOSTART = ['site', 'chatty', 'slow-start'];

const servers = [
  { name: 'site', port: BASE + 1, cwd: '../scripts/dev-apps', cmd: 'node site.js', color: true },
  { name: 'chatty', port: BASE + 2, cwd: '../scripts/dev-apps', cmd: 'node chatty.js', color: true },
  { name: 'slow-start', port: BASE + 3, cwd: '../scripts/dev-apps', cmd: 'node slow.js' },
  { name: 'crashy', port: BASE + 4, cwd: '../scripts/dev-apps', cmd: 'node crashy.js', color: true },
  { name: 'no-cmd', port: BASE + 5 }, // can be switched to, not started
];

const env = { ...process.env, PORT_SWITCH_CONFIG: CONFIG };
const portctl = (args, extra = {}) =>
  spawnSync(process.execPath, [PORTCTL, ...args], { cwd: ROOT, stdio: 'inherit', env: { ...env, ...extra } }).status ?? 1;

function setup() {
  fs.mkdirSync(DEV, { recursive: true });
  // Rewritten every run so it tracks the demo list above; .env is only created once.
  fs.writeFileSync(CONFIG, `${JSON.stringify({ proxy: { port: BASE, path: '/switch' }, logs: { keep: 3 }, servers }, null, 2)}\n`);
  const envFile = path.join(DEV, '.env');
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, `SWITCH_PASSWORD=${PASSWORD}\n`);
}

function build() {
  const r = spawnSync('yarn -s build', { cwd: ROOT, shell: true, stdio: 'inherit' });
  return r.status === 0;
}

function stopAll() {
  portctl(['stop', '--all']);
  portctl(['stop', 'proxy']);
}

function banner() {
  const url = `http://localhost:${BASE}`;
  console.log(`
  port-switch dev is running (config, .env and logs in .dev/)

    switch page   ${url}/switch        password: ${PASSWORD}
    an app        ${url}/              (whichever server is selected)
    all logs      ${url}/switch/logs
    portctl       yarn dev:ctl status   (or start crashy, switch none, logs chatty, ...)

  Try: start "crashy" (it dies after 8s), "slow-start" (shows Starting), switch to None,
  filter the logs, open ${url}/redirect on "site".
`);
}

async function watch() {
  console.log('  watching src/ for changes (Ctrl+C stops everything)\n');
  let timer;
  let busy = false;
  const rebuild = async () => {
    if (busy) { timer = setTimeout(rebuild, 300); return; }
    busy = true;
    console.log(`\n[dev] ${new Date().toLocaleTimeString()} change in src/, rebuilding...`);
    if (build()) {
      portctl(['restart', 'proxy']); // the proxy restores its own selection (run/proxy.json)
      console.log('[dev] proxy restarted with the new build (reload the page)');
    } else {
      console.log('[dev] build failed; the proxy keeps running the previous build');
    }
    busy = false;
  };
  fs.watch(path.join(ROOT, 'src'), () => { clearTimeout(timer); timer = setTimeout(rebuild, 250); });
  const quit = () => { console.log('\n[dev] stopping...'); stopAll(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  process.on('SIGHUP', quit);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'stop') { if (fs.existsSync(PORTCTL)) stopAll(); return; }
  if (cmd === 'ctl') { process.exitCode = portctl(rest); return; }
  if (cmd && cmd !== '--detach') { console.error(`unknown argument "${cmd}" (use --detach, stop, or ctl ...)`); process.exitCode = 1; return; }

  setup();
  if (!build()) { process.exitCode = 1; return; }
  portctl(['start', 'proxy', ...AUTOSTART]);
  portctl(['switch', 'site']);
  banner();
  if (cmd === '--detach') return;
  await watch();
}

main();
