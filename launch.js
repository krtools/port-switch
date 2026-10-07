#!/usr/bin/env node
// launch.js: start/stop the servers listed in servers.json as background processes.
// Each running server gets run/<name>.pid and run/<name>.log next to this file.
// Also used as a module by switch.js (start/stop buttons, status dots).

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'servers.json');
const RUN_DIR = path.join(ROOT, 'run');
const COMMANDS = ['stop', 'restart', 'status', 'logs'];
const RESERVED = new Set(['self', 'help', ...COMMANDS]);

const USAGE = `usage:
  node launch.js [name]            start a server (prompts if no name)
  node launch.js stop [name]       stop a server (prompts if no name)
  node launch.js restart [name]
  node launch.js status
  node launch.js logs [name]       follow its log
  Use --self in place of a name for the proxy itself (switch.js).`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- config ----------------------------------------------------------------
function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const proxy = { port: 3000, ...raw.proxy };
  const names = new Set();
  const ports = new Set([proxy.port]);
  const servers = (raw.servers || []).map((s, i) => {
    const where = `servers.json servers[${i}]`;
    if (!/^[\w.-]+$/.test(s.name || '')) throw new Error(`${where}: "name" must be letters, digits, _ . -`);
    if (RESERVED.has(s.name)) throw new Error(`${where}: "${s.name}" is a reserved name`);
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error(`${where}: bad "port"`);
    if (names.has(s.name)) throw new Error(`${where}: duplicate name "${s.name}"`);
    if (ports.has(s.port)) throw new Error(`${where}: port ${s.port} is already used`);
    names.add(s.name);
    ports.add(s.port);
    return s;
  });
  return { proxy, servers };
}

// The proxy itself, launchable with --self.
function selfEntry(config) {
  return { name: 'self', port: config.proxy.port, cwd: ROOT, cmd: `${JSON.stringify(process.execPath)} switch.js` };
}

function findEntry(config, name) {
  return name === 'self' ? selfEntry(config) : config.servers.find((s) => s.name === name);
}

// ---- process state ---------------------------------------------------------
const pidFile = (name) => path.join(RUN_DIR, `${name}.pid`);
const logFile = (name) => path.join(RUN_DIR, `${name}.log`);
const resolveCwd = (entry) => path.resolve(ROOT, (entry.cwd || '.').replace(/^~(?=$|[\\/])/, os.homedir()));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// pid if the server is running, else null (removing a stale pid file).
function getPid(name) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile(name), 'utf8')); } catch { return null; }
  if (pid > 0 && isAlive(pid)) return pid;
  fs.rmSync(pidFile(name), { force: true });
  return null;
}

function probe(port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (up) => { sock.destroy(); resolve(up); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// running: ours and answering | starting: ours, port not answering yet
// external: port answering, not started by us | stopped
async function getState(entry) {
  const pid = getPid(entry.name);
  const up = await probe(entry.port);
  const state = pid ? (up ? 'running' : 'starting') : (up ? 'external' : 'stopped');
  return { pid, up, state };
}

function tail(name, lines = 40) {
  try { return fs.readFileSync(logFile(name), 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

// ---- start / stop ----------------------------------------------------------
const WIN_WRAPPER = `require('child_process')
  .spawn(process.argv[1], { shell: true, stdio: 'inherit', windowsHide: true })
  .on('exit', (code) => process.exit(code ?? 1));`;

async function start(entry) {
  if (!entry.cmd) throw new Error(`${entry.name} has no "cmd" in servers.json`);
  const running = getPid(entry.name);
  if (running) throw new Error(`${entry.name} is already running (pid ${running})`);
  if (await probe(entry.port)) throw new Error(`port ${entry.port} is already in use by something else`);
  const cwd = resolveCwd(entry);
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(logFile(entry.name), `# ${new Date().toISOString()}  (cwd ${cwd})\n$ ${entry.cmd}\n`);
  const log = fs.openSync(logFile(entry.name), 'a');
  const opts = {
    cwd,
    detached: true, // own process group, survives this process / the SSH session
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ...entry.env, PORT: String(entry.port) },
  };
  // On Windows a detached (console-less) cmd.exe doesn't pass the log handles on to the
  // programs it runs, so detach a small node wrapper and let it run the shell normally.
  const child = process.platform === 'win32'
    ? spawn(process.execPath, ['-e', WIN_WRAPPER, entry.cmd], opts)
    : spawn(entry.cmd, { ...opts, shell: true });
  fs.closeSync(log);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  fs.writeFileSync(pidFile(entry.name), String(child.pid));
  return child.pid;
}

// Kill the whole tree: the pid is the shell, and e.g. `npm run dev` puts the real server in a child.
function killTree(pid, force) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

function groupAlive(pid) {
  if (process.platform === 'win32') return isAlive(pid);
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function stop(entry) {
  const pid = getPid(entry.name);
  if (!pid) return false;
  killTree(pid, false);
  for (let i = 0; i < 30 && groupAlive(pid); i++) await sleep(100);
  if (groupAlive(pid)) killTree(pid, true);
  fs.rmSync(pidFile(entry.name), { force: true });
  return true;
}

// ---- CLI -------------------------------------------------------------------
async function waitUp(entry, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    if (await probe(entry.port)) return 'up';
    if (!getPid(entry.name)) return 'exited';
  }
  return 'timeout';
}

async function cliStart(entry) {
  const pid = await start(entry);
  process.stdout.write(`started ${entry.name} (pid ${pid}), waiting for :${entry.port} `);
  const result = await waitUp(entry);
  if (result === 'up') return console.log('... up');
  console.log(result === 'exited' ? '... exited!' : '... not answering yet');
  console.log(`--- ${path.relative(process.cwd(), logFile(entry.name))} ---\n${tail(entry.name, 20)}`);
  if (result === 'exited') process.exitCode = 1;
}

async function cliStop(entry) {
  console.log((await stop(entry)) ? `stopped ${entry.name}` : `${entry.name} is not running`);
}

async function cliStatus(config) {
  const entries = [...config.servers, selfEntry(config)];
  const states = await Promise.all(entries.map(getState));
  const w = Math.max(...entries.map((e) => e.name.length));
  entries.forEach((e, i) => {
    const s = states[i];
    console.log(`${e.name.padEnd(w)}  :${String(e.port).padEnd(5)}  ${s.state.padEnd(8)}  ${s.pid ? `pid ${s.pid}` : ''}`);
  });
}

function cliLogs(entry) {
  const file = logFile(entry.name);
  if (!fs.existsSync(file)) throw new Error(`no log for ${entry.name} yet`);
  process.stdout.write(tail(entry.name) + '\n');
  let pos = fs.statSync(file).size;
  fs.watchFile(file, { interval: 500 }, (cur) => {
    if (cur.size < pos) pos = 0; // truncated by a restart
    if (cur.size === pos) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(cur.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = cur.size;
    process.stdout.write(buf);
  });
}

async function pick(config, cmd) {
  let entries = [...config.servers];
  const states = await Promise.all(entries.map(getState));
  let list = entries.map((e, i) => ({ e, s: states[i] }));
  if (cmd === 'start') list = list.filter(({ e }) => e.cmd);
  if (cmd === 'stop' || cmd === 'restart') list = list.filter(({ s }) => s.pid);
  if (cmd === 'logs') list = list.filter(({ e }) => fs.existsSync(logFile(e.name)));
  if (!list.length) throw new Error(`nothing to ${cmd}`);

  list.forEach(({ e, s }, i) => console.log(`  ${String(i + 1).padStart(2)}) ${e.name}  :${e.port}  [${s.state}]`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await new Promise((r) => rl.question(`${cmd} which? `, r))).trim();
  rl.close();
  const hit = list[Number(answer) - 1] || list.find(({ e }) => e.name === answer);
  if (!hit) throw new Error(`no such choice: ${answer || '(none)'}`);
  return hit.e;
}

async function main(argv) {
  const args = argv.map((a) => (a === '--self' ? 'self' : a));
  if (['help', '-h', '--help'].includes(args[0])) return console.log(USAGE);
  const config = loadConfig();
  const [cmd, name] = COMMANDS.includes(args[0]) ? args : ['start', args[0]];
  if (cmd === 'status') return cliStatus(config);

  const entry = name ? findEntry(config, name) : await pick(config, cmd);
  if (!entry) throw new Error(`unknown server "${name}" (have: ${config.servers.map((s) => s.name).join(', ')})`);
  if (cmd === 'start') return cliStart(entry);
  if (cmd === 'stop') return cliStop(entry);
  if (cmd === 'restart') { await cliStop(entry); return cliStart(entry); }
  if (cmd === 'logs') return cliLogs(entry);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { loadConfig, findEntry, getState, getPid, probe, start, stop, tail, logFile };
