#!/usr/bin/env node
// portctl: manage the servers listed in servers.json as background processes.
// Each running server gets run/<name>.pid and run/<name>.log next to this file.
// Also used as a module by switch.js (start/stop buttons, status dots).

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'servers.json');
const RUN_DIR = path.join(ROOT, 'run');
const ENV_FILE = path.join(ROOT, '.env');
const PROXY = 'proxy'; // the proxy itself (switch.js); --self is an alias
const RESERVED = new Set([PROXY, 'self', 'all']);

// .env next to this file (KEY=value lines, # comments); real environment variables win.
// Keys from it are kept out of the servers' environments (only the proxy gets them).
const ENV_KEYS = new Set(['SWITCH_PASSWORD']);
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    ENV_KEYS.add(m[1]);
    process.env[m[1]] ??= m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

// ---- help ------------------------------------------------------------------
const HELP = {
  portctl: `portctl - run the servers in servers.json in the background, behind the port-switch proxy

usage: portctl <command> [args]

commands:
  status  [name...]               show servers (the default with no command)
  start   [name...|--all]         start servers
  stop    [name...|--all]         stop servers
  restart [name...|--all]         restart servers (starts them if stopped)
  logs    [name] [-n N] [--no-follow]
                                  show and follow a server's log
  switch  [name|port]             point the running proxy at a server
  help    [command]               help for a command (or: portctl <command> --help)

Commands that take names show a picker when no name is given.
"${PROXY}" is the proxy itself (switch.js); --self is an alias. --all never includes it.

files: ${CONFIG_FILE}
       ${ENV_FILE}  (SWITCH_PASSWORD for the /switch page)
       ${RUN_DIR}${path.sep}<name>.pid, <name>.log`,

  status: `usage: portctl status [name...]

Show each server's port, state, pid and uptime. The proxy line shows which
server it's pointing at; that server is marked "* active".

states:
  running    started by portctl and answering on its port
  starting   started by portctl, port not answering yet
  stopped    not running
  external   something not started by portctl is using the port

Exit code is 3 if any named server isn't running (0 when listing everything).`,

  start: `usage: portctl start [name...|--all]

Start servers in the background and wait (up to 15s) for their ports to answer.
If one exits right away, the end of its log is printed.

  name...   one or more servers (or "${PROXY}"); picker if omitted
  --all     every server that is stopped (not the proxy)

Output goes to run/<name>.log, which is cleared on each start.
Starting a server that's already running is not an error.`,

  stop: `usage: portctl stop [name...|--all]

Stop servers, including any child processes they started. Sends SIGTERM to the
process group, then SIGKILL after 3s (on Windows: taskkill /T /F).

  name...   one or more servers (or "${PROXY}"); picker if omitted
  --all     every running server (not the proxy)`,

  restart: `usage: portctl restart [name...|--all]

Stop then start servers. A stopped server is just started.

  name...   one or more servers (or "${PROXY}"); picker if omitted
  --all     every server with a "cmd", except ports in use by something else (not the proxy)`,

  logs: `usage: portctl logs [name] [-n N] [--no-follow]

Print the end of run/<name>.log and keep following it (Ctrl+C to quit).

  name           server (or "${PROXY}"); picker if omitted
  -n, --lines N  lines to show first (default 40)
  --no-follow    print and exit`,

  switch: `usage: portctl switch [name|port]

Point the running proxy at a server (same as visiting /switch/<port>).
Any port works, registered or not. Picker if omitted.`,

  help: `usage: portctl help [command]

Show help for portctl or one of its commands.`,
};
const COMMANDS = Object.keys(HELP).filter((k) => k !== 'portctl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- config ----------------------------------------------------------------
function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const proxy = { port: 3000, path: '/switch', ...raw.proxy };
  const names = new Set();
  const ports = new Set([proxy.port]);
  const servers = (raw.servers || []).map((s, i) => {
    const where = `servers.json servers[${i}]`;
    if (!/^\w[\w.-]*$/.test(s.name || '')) throw new Error(`${where}: "name" must be letters, digits, _ . - (not starting with . or -)`);
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

function proxyEntry(config) {
  return { name: PROXY, port: config.proxy.port, cwd: ROOT, cmd: `${JSON.stringify(process.execPath)} switch.js` };
}

function findEntry(config, name) {
  return name === PROXY || name === 'self' ? proxyEntry(config) : config.servers.find((s) => s.name === name);
}

function resolveNames(config, names) {
  const entries = [...new Set(names)].map((name) => {
    const entry = findEntry(config, name);
    if (!entry) throw new Error(`unknown server "${name}" (have: ${[PROXY, ...config.servers.map((s) => s.name)].join(', ')})`);
    return entry;
  });
  return [...new Map(entries.map((e) => [e.name, e])).values()]; // "self" + "proxy" -> one
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

function uptime(name) {
  let ms;
  try { ms = Date.now() - fs.statSync(pidFile(name)).mtimeMs; } catch { return '-'; }
  const s = Math.floor(ms / 1000);
  const [d, h, m] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function tail(name, lines = 40) {
  try {
    return fs.readFileSync(logFile(name), 'utf8').replace(/\n$/, '').split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// GET a path on the running proxy -> { status, body }
function proxyRequest(config, urlPath) {
  return new Promise((resolve, reject) => {
    const headers = process.env.SWITCH_PASSWORD ? { authorization: `Bearer ${process.env.SWITCH_PASSWORD}` } : {};
    const req = http.get({ host: '127.0.0.1', port: config.proxy.port, path: urlPath, headers, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function proxyState(config) {
  try {
    const res = await proxyRequest(config, `${config.proxy.path}/api/state`);
    return res.status === 200 ? JSON.parse(res.body) : null;
  } catch { return null; }
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
  if (entry.name !== PROXY) for (const k of ENV_KEYS) delete opts.env[k];
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

const indent = (text) => text.split('\n').map((l) => `    ${l}`).join('\n');

async function startOne(e) {
  const pid = getPid(e.name);
  if (pid) return { ok: true, msg: `already running (pid ${pid})` };
  try { await start(e); } catch (err) { return { ok: false, msg: `error: ${err.message}` }; }
  const result = await waitUp(e);
  if (result === 'up') return { ok: true, msg: `up on :${e.port}` };
  if (result === 'timeout') return { ok: true, msg: `started, but :${e.port} isn't answering yet` };
  return { ok: false, msg: `exited! end of ${path.relative(process.cwd(), logFile(e.name))}:\n${indent(tail(e.name, 15))}` };
}

async function stopOne(e) {
  return { ok: true, msg: (await stop(e)) ? 'stopped' : 'not running' };
}

async function restartOne(e) {
  await stop(e);
  return startOne(e);
}

const ACTIONS = {
  start: { fn: startOne, verb: 'starting' },
  stop: { fn: stopOne },
  restart: { fn: restartOne, verb: 'restarting' },
};

async function runEach(cmd, entries) {
  const { fn, verb } = ACTIONS[cmd];
  if (verb) console.log(`${verb} ${entries.map((e) => e.name).join(', ')} ...`);
  const results = await Promise.all(entries.map(fn));
  entries.forEach((e, i) => {
    console.log(`${e.name}: ${results[i].msg}`);
    if (!results[i].ok) process.exitCode = 1;
  });
}

async function runAll(config, cmd) {
  const entries = config.servers.filter((e) => e.cmd);
  const states = await Promise.all(entries.map(getState));
  const want = { start: (s) => s.state === 'stopped', stop: (s) => s.pid, restart: (s) => s.state !== 'external' }[cmd];
  const todo = entries.filter((e, i) => {
    if (want(states[i])) return true;
    if (cmd !== 'stop') console.log(`${e.name}: skipped (${states[i].state})`);
    return false;
  });
  if (!todo.length) return console.log(`nothing to ${cmd}`);
  return runEach(cmd, todo);
}

function printTable(rows) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) console.log(r.map((v, c) => String(v).padEnd(widths[c])).join('  ').trimEnd());
}

async function cliStatus(config, named) {
  const entries = named.length ? named : [proxyEntry(config), ...config.servers];
  const [states, ps] = await Promise.all([Promise.all(entries.map(getState)), proxyState(config)]);
  const rows = entries.map((e, i) => {
    const s = states[i];
    const note = e.name === PROXY ? (ps ? `-> ${ps.name} (:${ps.target})` : '')
      : ps?.target === e.port ? '* active'
      : s.state === 'external' ? '(port in use, not ours)' : '';
    return [e.name, e.port, s.state, s.pid || '-', s.pid ? uptime(e.name) : '-', note];
  });
  printTable([['NAME', 'PORT', 'STATE', 'PID', 'UPTIME', ''], ...rows]);
  if (named.length && states.some((s) => s.state !== 'running')) process.exitCode = 3;
}

function cliLogs(entry, { lines, follow }) {
  const file = logFile(entry.name);
  if (!fs.existsSync(file)) throw new Error(`no log for ${entry.name} yet`);
  if (lines) console.log(tail(entry.name, lines));
  if (!follow) return;
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

async function cliSwitch(config, port, label) {
  let res;
  try {
    res = await proxyRequest(config, `${config.proxy.path}/${port}`);
  } catch {
    throw new Error(`the proxy isn't answering on :${config.proxy.port} (portctl start ${PROXY})`);
  }
  if (res.status === 401) throw new Error(`proxy rejected the password: check SWITCH_PASSWORD in ${ENV_FILE} (restart the proxy after changing it)`);
  if (res.status === 503) throw new Error(`the proxy has no SWITCH_PASSWORD: set it in ${ENV_FILE} and run portctl restart ${PROXY}`);
  if (res.status !== 302) throw new Error(`proxy refused: ${res.body.trim()}`);
  console.log(`proxy -> ${label} (:${port})`);
}

const PICK_FILTERS = {
  start: ({ e, s }) => e.cmd && s.state === 'stopped',
  stop: ({ s }) => s.pid,
  restart: ({ e, s }) => e.cmd && s.state !== 'external',
  logs: ({ e }) => fs.existsSync(logFile(e.name)),
  switch: ({ e }) => e.name !== PROXY,
};

async function pick(config, cmd) {
  const all = [...config.servers, proxyEntry(config)];
  const states = await Promise.all(all.map(getState));
  const list = all.map((e, i) => ({ e, s: states[i] })).filter(PICK_FILTERS[cmd]);
  if (!list.length) throw new Error(`nothing to ${cmd}`);

  const multi = cmd in ACTIONS;
  list.forEach(({ e, s }, i) => console.log(`  ${String(i + 1).padStart(2)}) ${e.name}  :${e.port}  [${s.state}]`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${cmd} which?${multi ? ' (space-separated for several)' : ''} `, r));
  rl.close();
  const picks = answer.split(/[\s,]+/).filter(Boolean);
  if (!picks.length) throw new Error('nothing picked');
  if (!multi && picks.length > 1) throw new Error(`pick one for ${cmd}`);
  return picks.map((p) => {
    const hit = list[Number(p) - 1] || list.find(({ e }) => e.name === p);
    if (!hit) throw new Error(`no such choice: ${p}`);
    return hit.e;
  });
}

function parseArgs(argv) {
  const opts = { names: [], all: false, help: false, follow: true, lines: 40 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-a' || a === '--all') opts.all = true;
    else if (a === '--self') opts.names.push(PROXY);
    else if (a === '--no-follow') opts.follow = false;
    else if (a === '-n' || a === '--lines') {
      opts.lines = Number(argv[++i]);
      if (!(Number.isInteger(opts.lines) && opts.lines >= 0)) throw new Error(`${a} needs a number`);
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.names.push(a);
  }
  return opts;
}

async function main(argv) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : null;
  if (cmd === 'help') {
    if (argv[0] && !HELP[argv[0]]) throw new Error(`no help for "${argv[0]}" (commands: ${COMMANDS.join(', ')})`);
    return console.log(HELP[argv[0] || 'portctl']);
  }
  const opts = parseArgs(argv);
  if (!cmd) {
    if (opts.help) return console.log(HELP.portctl);
    if (opts.all || opts.names.length) throw new Error('missing command (see portctl --help)');
  } else if (!HELP[cmd]) {
    const hint = fs.existsSync(CONFIG_FILE) && findEntry(loadConfig(), cmd) ? ` (did you mean "portctl start ${cmd}"?)` : '';
    throw new Error(`unknown command "${cmd}"${hint} - see portctl --help`);
  }
  if (opts.help) return console.log(HELP[cmd]);

  const config = loadConfig();
  if (!cmd || cmd === 'status') return cliStatus(config, resolveNames(config, opts.names));

  if (opts.all) {
    if (!(cmd in ACTIONS)) throw new Error(`--all doesn't apply to ${cmd}`);
    if (opts.names.length) throw new Error('give names or --all, not both');
    return runAll(config, cmd);
  }
  if (cmd === 'switch' && /^\d+$/.test(opts.names[0] || '')) {
    if (opts.names.length > 1) throw new Error('switch takes one name or port');
    return cliSwitch(config, Number(opts.names[0]), `port ${opts.names[0]}`);
  }

  const entries = opts.names.length ? resolveNames(config, opts.names) : await pick(config, cmd);
  if (cmd in ACTIONS) return runEach(cmd, entries);
  if (entries.length > 1) throw new Error(`${cmd} takes one name`);
  if (cmd === 'logs') return cliLogs(entries[0], opts);
  if (cmd === 'switch') {
    if (entries[0].name === PROXY) throw new Error("can't switch the proxy to itself");
    return cliSwitch(config, entries[0].port, entries[0].name);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { loadConfig, findEntry, getState, getPid, probe, start, stop, tail, logFile };
