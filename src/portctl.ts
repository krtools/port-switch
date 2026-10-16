#!/usr/bin/env node
// portctl: manage the servers listed in servers.json as background processes.
// Each running server gets run/<name>.pid and run/<name>.log next to this file.
// Also used as a module by switch.js (start/stop buttons, status dots).

import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, execFileSync, type SpawnOptions } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { sleep, errCode, errMsg } from './util';

const CODE_DIR = __dirname;

// servers.json: --config <file> (portctl or switch.js), else $PORT_SWITCH_CONFIG, else next
// to the code. Everything else lives beside it: .env, run/, and relative "cwd" paths.
function configFromArgs(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') return argv[i + 1];
    if (argv[i].startsWith('--config=')) return argv[i].slice('--config='.length);
  }
  return undefined;
}
const configArg = configFromArgs(process.argv.slice(2));
export const CONFIG_FILE = path.resolve(configArg || process.env.PORT_SWITCH_CONFIG || path.join(CODE_DIR, 'servers.json'));
const HOME_DIR = path.dirname(CONFIG_FILE);
const RUN_DIR = path.join(HOME_DIR, 'run');
const ENV_FILE = path.join(HOME_DIR, '.env');
export const PROXY = 'proxy'; // the proxy itself (switch.js); --self is an alias
const NONE = 'none'; // `portctl switch none`: the proxy serves a placeholder page instead of a server
const RESERVED = new Set([PROXY, 'self', 'all', NONE]);

export interface ServerEntry {
  name: string;
  port: number;
  cmd?: string;
  cwd?: string;
  env?: Record<string, string>;
  color?: boolean;
}

export interface Config {
  proxy: { port: number; path: string };
  logs: { keep: number };
  servers: ServerEntry[];
}

/** running: ours and answering | starting: ours, port not answering yet
 *  external: port answering, not started by us | stopped */
export type State = 'running' | 'starting' | 'external' | 'stopped';

export interface ServerState {
  pid: number | null;
  up: boolean;
  state: State;
}

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
const HELP: Record<string, string> = {
  portctl: `portctl - run the servers in servers.json in the background, behind the port-switch proxy

usage: portctl <command> [args]

commands:
  status  [name...]               show servers (the default with no command)
  start   [name...|--all]         start servers
  stop    [name...|--all]         stop servers
  restart [name...|--all]         restart servers (starts them if stopped)
  logs    [name] [-n N] [--no-follow] [--strip]
                                  show and follow a server's log
  switch  [name|port|none]        point the running proxy at a server (none: serve nothing)
  help    [command]               help for a command (or: portctl <command> --help)

Commands that take names show a picker when no name is given.

--config FILE (anywhere on the line), or PORT_SWITCH_CONFIG=FILE: use that servers.json.
.env, run/ and relative "cwd" paths are then taken from FILE's folder as well.

servers.json entries: name, port, cmd, and optionally cwd, env, color.
"color": true sets FORCE_COLOR=1 and CLICOLOR_FORCE=1 so tools keep their colors
even though their output goes to a log file (some tools need their own flag too).
"${PROXY}" is the proxy itself (switch.js); --self is an alias. --all never includes it.

files: ${CONFIG_FILE}
       ${ENV_FILE}  (SWITCH_PASSWORD for the /switch page)
       ${RUN_DIR}${path.sep}<name>.pid, <name>.log (previous runs: <name>.log.1, .2, ...)`,

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

Output goes to run/<name>.log. The previous run's log is kept as run/<name>.log.1,
the one before as .2, and so on, up to "logs": { "keep": N } in servers.json (default 5),
or PORT_SWITCH_LOG_KEEP=N in the environment or .env, which wins.
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

  logs: `usage: portctl logs [name] [-n N] [--no-follow] [--strip]

Print the end of run/<name>.log and keep following it (Ctrl+C to quit).

  name           server (or "${PROXY}"); picker if omitted
  -n, --lines N  lines to show first (default 40)
  --no-follow    print and exit
  --strip        remove terminal color/escape codes (for grep, less, files)`,

  switch: `usage: portctl switch [name|port|none]

Point the running proxy at a server (same as visiting /switch/<port>).
Any port works, registered or not. Picker if omitted.

"none" stops proxying without stopping the proxy: visitors get a page saying
nothing is being served (and WebSockets a 503) until you switch to a server again.`,

  help: `usage: portctl help [command]

Show help for portctl or one of its commands.`,
};
const COMMANDS = Object.keys(HELP).filter((k) => k !== 'portctl');

// ---- config ----------------------------------------------------------------
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;

export function loadConfig(): Config {
  let text: string;
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
    throw new Error(`no config at ${CONFIG_FILE} (copy servers.example.json there, or point --config / PORT_SWITCH_CONFIG at one)`);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (err) { throw new Error(`${CONFIG_FILE}: ${errMsg(err)}`); }
  if (!isObject(raw)) throw new Error('servers.json: must be a JSON object');
  if (raw.proxy !== undefined && !isObject(raw.proxy)) throw new Error('servers.json: "proxy" must be an object');
  if (raw.logs !== undefined && !isObject(raw.logs)) throw new Error('servers.json: "logs" must be an object');
  if (raw.servers !== undefined && !Array.isArray(raw.servers)) throw new Error('servers.json: "servers" must be a list');

  const proxy = { port: 3000, path: '/switch', ...raw.proxy };
  if (!isPort(proxy.port)) throw new Error('servers.json: proxy.port must be a port number');
  if (typeof proxy.path !== 'string' || !/^\/[\w.~-]+(\/[\w.~-]+)*$/.test(proxy.path)) {
    throw new Error('servers.json: proxy.path must look like "/switch"');
  }
  const logs = { keep: 5, ...raw.logs };
  // PORT_SWITCH_LOG_KEEP (environment or .env) wins over servers.json.
  const keepEnv = process.env.PORT_SWITCH_LOG_KEEP;
  if (keepEnv !== undefined && keepEnv.trim() !== '') {
    logs.keep = /^\d+$/.test(keepEnv.trim()) ? Number(keepEnv) : NaN;
    if (!(logs.keep <= 100)) throw new Error('PORT_SWITCH_LOG_KEEP must be a whole number from 0 to 100');
  }
  if (!Number.isInteger(logs.keep) || logs.keep < 0 || logs.keep > 100) {
    throw new Error('servers.json: logs.keep must be a whole number from 0 to 100');
  }

  const names = new Set<string>();
  const ports = new Set<number>([proxy.port]);
  const servers = ((raw.servers as unknown[] | undefined) ?? []).map((s, i): ServerEntry => {
    const where = `servers.json servers[${i}]`;
    if (!isObject(s)) throw new Error(`${where}: must be an object`);
    const { name, port, cmd, cwd, env, color } = s;
    if (typeof name !== 'string' || !/^\w[\w.-]*$/.test(name)) {
      throw new Error(`${where}: "name" must be letters, digits, _ . - (not starting with . or -)`);
    }
    if (RESERVED.has(name)) throw new Error(`${where}: "${name}" is a reserved name`);
    if (!isPort(port)) throw new Error(`${where}: bad "port"`);
    if (names.has(name)) throw new Error(`${where}: duplicate name "${name}"`);
    if (ports.has(port)) throw new Error(`${where}: port ${port} is already used`);
    if (cmd !== undefined && typeof cmd !== 'string') throw new Error(`${where}: "cmd" must be a string`);
    if (cwd !== undefined && typeof cwd !== 'string') throw new Error(`${where}: "cwd" must be a string`);
    if (color !== undefined && typeof color !== 'boolean') throw new Error(`${where}: "color" must be true or false`);
    if (env !== undefined && !(isObject(env) && Object.values(env).every((v) => typeof v === 'string'))) {
      throw new Error(`${where}: "env" must be an object of strings`);
    }
    names.add(name);
    ports.add(port);
    return { name, port, cmd, cwd, env: env as Record<string, string> | undefined, color };
  });
  return { proxy: proxy as Config['proxy'], logs: logs as Config['logs'], servers };
}

function proxyEntry(config: Config): ServerEntry {
  const script = path.join(CODE_DIR, 'switch.js');
  return { name: PROXY, port: config.proxy.port, cwd: HOME_DIR, cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` };
}

export function findEntry(config: Config, name: string): ServerEntry | undefined {
  return name === PROXY || name === 'self' ? proxyEntry(config) : config.servers.find((s) => s.name === name);
}

function resolveNames(config: Config, names: string[]): ServerEntry[] {
  const entries = [...new Set(names)].map((name) => {
    const entry = findEntry(config, name);
    if (!entry) throw new Error(`unknown server "${name}" (have: ${[PROXY, ...config.servers.map((s) => s.name)].join(', ')})`);
    return entry;
  });
  return [...new Map(entries.map((e) => [e.name, e])).values()]; // "self" + "proxy" -> one
}

// ---- process state ---------------------------------------------------------
const pidFile = (name: string) => path.join(RUN_DIR, `${name}.pid`);
export const logFile = (name: string) => path.join(RUN_DIR, `${name}.log`);
/** Where the proxy keeps its selection between restarts. */
export const PROXY_STATE_FILE = path.join(RUN_DIR, 'proxy.json');
const resolveCwd = (entry: ServerEntry) => path.resolve(HOME_DIR, (entry.cwd || '.').replace(/^~(?=$|[\\/])/, os.homedir()));

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return errCode(e) === 'EPERM'; }
}

/** pid if the server is running, else null (removing a stale pid file). */
export function getPid(name: string): number | null {
  let pid: number;
  try { pid = Number(fs.readFileSync(pidFile(name), 'utf8')); } catch { return null; }
  if (pid > 0 && isAlive(pid)) return pid;
  try { fs.rmSync(pidFile(name), { force: true }); } catch {} // e.g. no permission; harmless, retried next time
  return null;
}

export function probe(port: number, timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const done = (up: boolean) => { sock.destroy(); resolve(up); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export async function getState(entry: ServerEntry): Promise<ServerState> {
  const pid = getPid(entry.name);
  const up = await probe(entry.port);
  const state: State = pid ? (up ? 'running' : 'starting') : (up ? 'external' : 'stopped');
  return { pid, up, state };
}

function uptime(name: string): string {
  let ms: number;
  try { ms = Date.now() - fs.statSync(pidFile(name)).mtimeMs; } catch { return '-'; }
  const s = Math.floor(ms / 1000);
  const [d, h, m] = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60)];
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export function tail(name: string, lines = 40): string {
  try {
    return fs.readFileSync(logFile(name), 'utf8').replace(/\n$/, '').split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

/** GET a path on the running proxy. */
function proxyRequest(config: Config, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = process.env.SWITCH_PASSWORD ? { authorization: `Bearer ${process.env.SWITCH_PASSWORD}` } : {};
    const req = http.get({ host: '127.0.0.1', port: config.proxy.port, path: urlPath, headers, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function proxyState(config: Config): Promise<{ target: number | null; name: string } | null> {
  try {
    const res = await proxyRequest(config, `${config.proxy.path}/api/state`);
    return res.status === 200 ? JSON.parse(res.body) : null;
  } catch { return null; }
}

// ---- start / stop ----------------------------------------------------------
// "color": true -- most tools drop colors when output isn't a terminal; these force them back.
const COLOR_ENV = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' };
const WIN_WRAPPER = `require('child_process')
  .spawn(process.argv[1], { shell: true, stdio: 'inherit', windowsHide: true })
  .on('exit', (code) => process.exit(code ?? 1));`;

export async function start(entry: ServerEntry): Promise<number> {
  if (!entry.cmd) throw new Error(`${entry.name} has no "cmd" in servers.json`);
  const running = getPid(entry.name);
  if (running) throw new Error(`${entry.name} is already running (pid ${running})`);
  if (await probe(entry.port)) throw new Error(`port ${entry.port} is already in use by something else`);
  const cwd = resolveCwd(entry);
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

  fs.mkdirSync(RUN_DIR, { recursive: true });
  rotateLog(entry.name, loadConfig().logs.keep);
  fs.writeFileSync(logFile(entry.name), `# ${new Date().toISOString()}  (cwd ${cwd})\n$ ${entry.cmd}\n`);
  const log = fs.openSync(logFile(entry.name), 'a');
  const env: NodeJS.ProcessEnv = { ...process.env, ...(entry.color && COLOR_ENV), ...entry.env, PORT: String(entry.port) };
  if (entry.name === PROXY) env.PORT_SWITCH_CONFIG = CONFIG_FILE; // the proxy uses the same config
  else for (const k of [...ENV_KEYS, 'PORT_SWITCH_CONFIG']) delete env[k];
  const opts: SpawnOptions = {
    cwd,
    detached: true, // own process group, survives this process / the SSH session
    windowsHide: true,
    stdio: ['ignore', log, log],
    env,
  };
  // On Windows a detached (console-less) cmd.exe doesn't pass the log handles on to the
  // programs it runs, so detach a small node wrapper and let it run the shell normally.
  const child = process.platform === 'win32'
    ? spawn(process.execPath, ['-e', WIN_WRAPPER, entry.cmd], opts)
    : spawn(entry.cmd, { ...opts, shell: true });
  fs.closeSync(log);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const pid = child.pid as number; // set once 'spawn' has fired
  fs.writeFileSync(pidFile(entry.name), String(pid));
  return pid;
}

/** Keep previous runs' logs: <name>.log -> .log.1 -> .log.2 ... up to `keep` (0 = just overwrite). */
function rotateLog(name: string, keep: number): void {
  const file = logFile(name);
  // Runs past the limit (left from a higher setting) go, so lowering it takes effect.
  for (let i = keep + 1; i <= 100; i++) {
    try { fs.rmSync(`${file}.${i}`, { force: true }); } catch {}
  }
  if (!keep || !fs.existsSync(file)) return;
  try {
    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch (err) {
    // e.g. Windows, where a leftover process may still hold the file open; it gets overwritten instead
    console.error(`warning: couldn't keep the previous log for ${name}: ${errMsg(err)}`);
  }
}

// Kill the whole tree: the pid is the shell, and e.g. `npm run dev` puts the real server in a child.
function killTree(pid: number, force: boolean): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {}
}

function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') return isAlive(pid);
  try { process.kill(-pid, 0); return true; } catch (e) { return errCode(e) === 'EPERM'; }
}

export async function stop(entry: ServerEntry): Promise<boolean> {
  const pid = getPid(entry.name);
  if (!pid) return false;
  killTree(pid, false);
  for (let i = 0; i < 30 && groupAlive(pid); i++) await sleep(100);
  if (groupAlive(pid)) killTree(pid, true);
  try { fs.rmSync(pidFile(entry.name), { force: true }); } catch {}
  return true;
}

// ---- CLI -------------------------------------------------------------------
type Result = { ok: boolean; msg: string };
type ActionName = 'start' | 'stop' | 'restart';
type PickCmd = ActionName | 'logs' | 'switch';

async function waitUp(entry: ServerEntry, ms = 15000): Promise<'up' | 'exited' | 'timeout'> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    if (await probe(entry.port)) return 'up';
    if (!getPid(entry.name)) return 'exited';
  }
  return 'timeout';
}

const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');

async function startOne(e: ServerEntry): Promise<Result> {
  const pid = getPid(e.name);
  if (pid) return { ok: true, msg: `already running (pid ${pid})` };
  try { await start(e); } catch (err) { return { ok: false, msg: `error: ${errMsg(err)}` }; }
  const result = await waitUp(e);
  if (result === 'up') return { ok: true, msg: `up on :${e.port}` };
  if (result === 'timeout') return { ok: true, msg: `started, but :${e.port} isn't answering yet` };
  return { ok: false, msg: `exited! end of ${path.relative(process.cwd(), logFile(e.name))}:\n${indent(tail(e.name, 15))}` };
}

async function stopOne(e: ServerEntry): Promise<Result> {
  return { ok: true, msg: (await stop(e)) ? 'stopped' : 'not running' };
}

async function restartOne(e: ServerEntry): Promise<Result> {
  await stop(e);
  return startOne(e);
}

const ACTIONS: Record<ActionName, { fn: (e: ServerEntry) => Promise<Result>; verb?: string }> = {
  start: { fn: startOne, verb: 'starting' },
  stop: { fn: stopOne },
  restart: { fn: restartOne, verb: 'restarting' },
};
const isAction = (cmd: string): cmd is ActionName => cmd in ACTIONS;

async function runEach(cmd: ActionName, entries: ServerEntry[]): Promise<void> {
  const { fn, verb } = ACTIONS[cmd];
  if (verb) console.log(`${verb} ${entries.map((e) => e.name).join(', ')} ...`);
  const results = await Promise.all(entries.map(fn));
  entries.forEach((e, i) => {
    console.log(`${e.name}: ${results[i].msg}`);
    if (!results[i].ok) process.exitCode = 1;
  });
}

async function runAll(config: Config, cmd: ActionName): Promise<void> {
  const entries = config.servers.filter((e) => e.cmd);
  const states = await Promise.all(entries.map(getState));
  const want: Record<ActionName, (s: ServerState) => boolean> = {
    start: (s) => s.state === 'stopped',
    stop: (s) => !!s.pid,
    restart: (s) => s.state !== 'external',
  };
  const todo = entries.filter((e, i) => {
    if (want[cmd](states[i])) return true;
    if (cmd !== 'stop') console.log(`${e.name}: skipped (${states[i].state})`);
    return false;
  });
  if (!todo.length) return console.log(`nothing to ${cmd}`);
  return runEach(cmd, todo);
}

function printTable(rows: (string | number)[][]): void {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) console.log(r.map((v, c) => String(v).padEnd(widths[c])).join('  ').trimEnd());
}

async function cliStatus(config: Config, named: ServerEntry[]): Promise<void> {
  const entries = named.length ? named : [proxyEntry(config), ...config.servers];
  const [states, ps] = await Promise.all([Promise.all(entries.map(getState)), proxyState(config)]);
  const rows = entries.map((e, i) => {
    const s = states[i];
    const note = e.name === PROXY ? (!ps ? '' : ps.target === null ? '-> none (not proxying)' : `-> ${ps.name} (:${ps.target})`)
      : ps?.target === e.port ? '* active'
        : s.state === 'external' ? '(port in use, not ours)' : '';
    return [e.name, e.port, s.state, s.pid || '-', s.pid ? uptime(e.name) : '-', note];
  });
  printTable([['NAME', 'PORT', 'STATE', 'PID', 'UPTIME', ''], ...rows]);
  if (named.length && states.some((s) => s.state !== 'running')) process.exitCode = 3;
}

// Terminal escape sequences: CSI (colors, cursor), OSC (titles, links), and short ones.
const ANSI_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[@-Z\\-_])`;
const ANSI_RE = new RegExp(ANSI_SOURCE, 'g');
const ANSI_AT_START = new RegExp(`^${ANSI_SOURCE}`);
const stripAnsi = (text: string) => text.replace(ANSI_RE, '');

interface Options {
  names: string[];
  all: boolean;
  help: boolean;
  follow: boolean;
  lines: number;
  strip: boolean;
}

function cliLogs(entry: ServerEntry, { lines, follow, strip }: Options): void {
  const file = logFile(entry.name);
  if (!fs.existsSync(file)) throw new Error(`no log for ${entry.name} yet`);
  if (lines) console.log(strip ? stripAnsi(tail(entry.name, lines)) : tail(entry.name, lines));
  if (!follow) return;
  let pos = fs.statSync(file).size;
  let decoder = new StringDecoder('utf8');
  let carry = ''; // an escape sequence cut off at the end of a read
  fs.watchFile(file, { interval: 500 }, (cur) => {
    if (cur.size < pos) { pos = 0; decoder = new StringDecoder('utf8'); carry = ''; } // truncated by a restart
    if (cur.size === pos) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(cur.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = cur.size;
    if (!strip) { process.stdout.write(buf); return; }
    let text = carry + decoder.write(buf);
    const esc = text.lastIndexOf('\x1b');
    const rest = esc === -1 ? '' : text.slice(esc);
    carry = rest && rest.length < 256 && !ANSI_AT_START.test(rest) ? rest : '';
    if (carry) text = text.slice(0, esc);
    process.stdout.write(stripAnsi(text));
  });
}

/** Point the proxy at a port, or at nothing (null = "none"). */
async function cliSwitch(config: Config, port: number | null, label: string): Promise<void> {
  let res;
  try {
    res = await proxyRequest(config, `${config.proxy.path}/${port ?? NONE}`);
  } catch {
    throw new Error(`the proxy isn't answering on :${config.proxy.port} (portctl start ${PROXY})`);
  }
  if (res.status === 401) throw new Error(`proxy rejected the password: check SWITCH_PASSWORD in ${ENV_FILE} (restart the proxy after changing it)`);
  if (res.status === 503) throw new Error(`the proxy has no SWITCH_PASSWORD: set it in ${ENV_FILE} and run portctl restart ${PROXY}`);
  if (res.status !== 302) throw new Error(`proxy refused: ${res.body.trim()}`);
  console.log(port === null ? 'proxy -> none (visitors see a "nothing is being served" page)' : `proxy -> ${label} (:${port})`);
}

type Candidate = { e: ServerEntry; s: ServerState };
const PICK_FILTERS: Record<PickCmd, (c: Candidate) => boolean> = {
  start: ({ e, s }) => !!e.cmd && s.state === 'stopped',
  stop: ({ s }) => !!s.pid,
  restart: ({ e, s }) => !!e.cmd && s.state !== 'external',
  logs: ({ e }) => fs.existsSync(logFile(e.name)),
  switch: ({ e }) => e.name !== PROXY,
};

async function pick(config: Config, cmd: PickCmd): Promise<ServerEntry[]> {
  const all = [...config.servers, proxyEntry(config)];
  const states = await Promise.all(all.map(getState));
  const list = all.map((e, i) => ({ e, s: states[i] })).filter(PICK_FILTERS[cmd]);
  // "none" heads the switch picker, like on the switch page
  if (cmd === 'switch') list.unshift({ e: { name: NONE, port: 0 }, s: { pid: null, up: false, state: 'stopped' } });
  if (!list.length) throw new Error(`nothing to ${cmd}`);

  const multi = isAction(cmd);
  list.forEach(({ e, s }, i) => console.log(`  ${String(i + 1).padStart(2)}) ${e.name === NONE && cmd === 'switch'
    ? 'none  (stop proxying, show a placeholder page)' : `${e.name}  :${e.port}  [${s.state}]`}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(`${cmd} which?${multi ? ' (space-separated for several)' : ''} `, r));
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

function parseArgs(argv: string[]): Options {
  const opts: Options = { names: [], all: false, help: false, follow: true, lines: 40, strip: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-a' || a === '--all') opts.all = true;
    else if (a === '--self') opts.names.push(PROXY);
    else if (a === '--no-follow') opts.follow = false;
    else if (a === '--strip') opts.strip = true;
    else if (a === '-n' || a === '--lines') {
      opts.lines = Number(argv[++i]);
      if (!(Number.isInteger(opts.lines) && opts.lines >= 0)) throw new Error(`${a} needs a number`);
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.names.push(a);
  }
  return opts;
}

/** argv without --config <file> / --config=<file> (already applied at startup). */
function withoutConfig(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') {
      if (argv[i + 1] === undefined) throw new Error('--config needs a file');
      i++;
    } else if (!argv[i].startsWith('--config=')) rest.push(argv[i]);
  }
  return rest;
}

async function main(argv: string[]): Promise<void> {
  argv = withoutConfig(argv);
  const cmd = argv[0] && !argv[0].startsWith('-') ? (argv.shift() as string) : null;
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
  if (opts.help) return console.log(HELP[cmd as string]);

  const config = loadConfig();
  if (!cmd || cmd === 'status') return cliStatus(config, resolveNames(config, opts.names));
  const pickCmd = cmd as PickCmd;

  if (opts.all) {
    if (!isAction(pickCmd)) throw new Error(`--all doesn't apply to ${cmd}`);
    if (opts.names.length) throw new Error('give names or --all, not both');
    return runAll(config, pickCmd);
  }
  if (pickCmd === 'switch' && (/^\d+$/.test(opts.names[0] || '') || opts.names[0] === NONE)) {
    if (opts.names.length > 1) throw new Error('switch takes one name or port');
    if (opts.names[0] === NONE) return cliSwitch(config, null, NONE);
    return cliSwitch(config, Number(opts.names[0]), `port ${opts.names[0]}`);
  }

  const entries = opts.names.length ? resolveNames(config, opts.names) : await pick(config, pickCmd);
  if (isAction(pickCmd)) return runEach(pickCmd, entries);
  if (entries.length > 1) throw new Error(`${cmd} takes one name`);
  if (pickCmd === 'logs') return cliLogs(entries[0], opts);
  if (pickCmd === 'switch') {
    if (entries[0].name === PROXY) throw new Error("can't switch the proxy to itself");
    if (entries[0].name === NONE) return cliSwitch(config, null, NONE); // picked from the list
    return cliSwitch(config, entries[0].port, entries[0].name);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`error: ${errMsg(err)}`);
    process.exit(1);
  });
}
