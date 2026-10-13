#!/usr/bin/env node
// port-switch: a tiny zero-dependency reverse proxy that forwards everything on
// one port (default 3000) to whichever local server is currently "selected".
//
//   GET  /switch                -> page listing servers from servers.json (status, start/stop)
//   GET  /switch/{port}         -> make {port} the active target, redirect to /
//   POST /switch/{start|stop|restart}/{name}
//   GET  /switch/log/{name}     -> live log viewer (?raw: plain-text tail), /stream: SSE
//   GET  /switch/logs           -> every server's log combined, /stream: SSE
//   GET  /switch/api/state      -> {"target":3001,"name":"..."} (used by portctl)
//   GET|POST /switch/login, GET /switch/logout
//   anything else               -> proxied to the active target (incl. WebSockets)
// (/switch is proxy.path in servers.json)
//
// Everything under /switch needs SWITCH_PASSWORD (from .env): log in once in the browser
// for a long-lived cookie, or send "Authorization: Bearer <password>" (portctl does).
//
// Usage: node switch.js   or   portctl start proxy
// env: PORT HOST TARGET SWITCH_PASSWORD SWITCH_COOKIE_DAYS (default 365) SWITCH_COOKIE_DOMAIN

import * as http from 'http';
import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Duplex } from 'stream';
import { StringDecoder } from 'string_decoder';
import * as launcher from './portctl';
import type { Config, ServerEntry, State } from './portctl';
import { logClient, type LogClientOptions } from './logClient';
import { errCode, errMsg, errText } from './util';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

// Timestamp every log line, and record why the process ends: the log (run/proxy.log
// under portctl) is the only trace. If it ends with none of these lines, the process
// got SIGKILL (e.g. the kernel OOM killer) or the log was cleared by a restart.
for (const level of ['log', 'error'] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => write(new Date().toISOString(), ...args);
}
process.on('uncaughtException', (err, origin) => { // also unhandled rejections
  console.error(`[fatal] ${origin}:`, err);
  process.exit(1);
});
for (const [sig, num] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]] as const) {
  process.on(sig, () => { console.log(`[exit] received ${sig}`); process.exit(128 + num); });
}
process.on('exit', (code) => console.log(`[exit] code ${code}`));

const UPSTREAM_HOST = '127.0.0.1';
const ALLOW_UNREGISTERED = true; // allow /switch/{port} for ports not in servers.json

// servers.json is re-read on every /switch page load; keep the last good copy if it breaks.
let config: Config;
let configError: string | null = null;
function reloadConfig(): Config {
  try { config = launcher.loadConfig(); configError = null; } catch (err) { configError = errMsg(err); }
  return config;
}
try {
  config = launcher.loadConfig();
} catch (err) {
  console.error(`[port-switch] ${errMsg(err)}`);
  process.exit(1);
}

const SWITCH_PATH = config.proxy.path;
const LISTEN_PORT = Number(process.env.PORT) || config.proxy.port;
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

let target = Number(process.env.TARGET) || config.servers[0]?.port || 3001;

// Open WebSocket tunnels, killed on switch so clients (e.g. HMR) reconnect to the new target.
const tunnels = new Set<Duplex>();

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const entryOf = (port: number) => config.servers.find((s) => s.port === port);
const nameOf = (port: number) => entryOf(port)?.name || `port ${port}`;

// ---- auth ------------------------------------------------------------------
// Cookie = "<expiry>.<HMAC(password, expiry)>": nothing stored server-side, and
// changing the password logs every browser out.
const PASSWORD = process.env.SWITCH_PASSWORD || '';
const COOKIE = 'port_switch_auth';
const COOKIE_MAX_AGE = (Number(process.env.SWITCH_COOKIE_DAYS) || 365) * 86400;
// Unset = host-only (just the exact host). A domain also covers all its subdomains.
const COOKIE_DOMAIN = process.env.SWITCH_COOKIE_DOMAIN || '';
if (COOKIE_DOMAIN && !/^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(COOKIE_DOMAIN)) {
  console.error(`[port-switch] bad SWITCH_COOKIE_DOMAIN: ${COOKIE_DOMAIN}`);
  process.exit(1);
}
const MAX_FAILURES = 20; // per 15 minutes, across all clients
const failures: number[] = [];

const sign = (exp: string | number) => crypto.createHmac('sha256', PASSWORD).update(`port-switch:${exp}`).digest('base64url');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

function getCookie(req: Req, name: string): string {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function isAuthed(req: Req): boolean {
  if (!PASSWORD) return false;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  if (bearer) return safeEqual(bearer, PASSWORD);
  const [exp, sig] = getCookie(req, COOKIE).split('.');
  return Number(exp) > Date.now() / 1000 && !!sig && safeEqual(sig, sign(exp));
}

function authCookie(req: Req, maxAge: number): string {
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const domain = COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : '';
  return `${COOKIE}=${maxAge ? `${exp}.${sign(exp)}` : ''}; Path=${SWITCH_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${domain}${secure}`;
}

function tooManyFailures(): boolean {
  const cutoff = Date.now() - 15 * 60e3;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= MAX_FAILURES;
}

// Only redirect back into /switch after logging in.
const safeNext = (next: string | null | undefined): string =>
  typeof next === 'string' && (next === SWITCH_PATH || next.startsWith(SWITCH_PATH + '/') || next.startsWith(SWITCH_PATH + '?'))
    ? next : SWITCH_PATH;

function renderLogin(res: Res, status: number, next: string, msg?: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Log in', `
<h1>Switch server</h1>
<p>Password required.</p>
${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
<form class="custom" method="post" action="${SWITCH_PATH}/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <input type="password" name="password" autocomplete="current-password" placeholder="password" autofocus required>
  <button>Log in</button>
</form>`));
}

function readBody(req: Req, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function doLogin(req: Req, res: Res): Promise<void> {
  let form: URLSearchParams;
  try { form = new URLSearchParams(await readBody(req)); } catch { return; }
  const next = safeNext(form.get('next'));
  if (tooManyFailures()) return renderLogin(res, 429, next, 'Too many failed attempts. Try again in a few minutes.');
  if (!safeEqual(form.get('password') || '', PASSWORD)) {
    failures.push(Date.now());
    console.log(`[auth] failed login from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    await new Promise((r) => setTimeout(r, 1000));
    return renderLogin(res, 401, next, 'Wrong password.');
  }
  res.writeHead(303, { location: next, 'set-cookie': authCookie(req, COOKIE_MAX_AGE), 'cache-control': 'no-store' });
  res.end();
}

/** Handles login/logout and rejects unauthenticated requests. Returns true if it responded. */
async function guard(req: Req, res: Res, urlPath: string): Promise<boolean> {
  if (!PASSWORD) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('The switch page is locked: set SWITCH_PASSWORD in .env next to switch.js, then restart the proxy.\n');
    return true;
  }
  if (urlPath === `${SWITCH_PATH}/login`) {
    if (req.method === 'POST') await doLogin(req, res);
    else renderLogin(res, 200, safeNext(new URLSearchParams((req.url ?? '').split('?')[1] || '').get('next')));
    return true;
  }
  if (urlPath === `${SWITCH_PATH}/logout`) {
    res.writeHead(303, { location: SWITCH_PATH, 'set-cookie': authCookie(req, 0), 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (isAuthed(req)) return false;
  // Browsers get the login form (then come back here); scripts get a plain 401.
  if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) renderLogin(res, 401, safeNext(req.url));
  else { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized\n'); }
  return true;
}

// ---- switch UI -------------------------------------------------------------
const STYLE = `
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1b1b1b; --mute:#777; --line:#e2e2de; --acc:#2a6ef0; --err:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151515; --card:#1f1f1f; --fg:#eee; --mute:#999; --line:#333; --acc:#6d9cff; --err:#ff7b6b; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.4 system-ui,sans-serif; }
  main { max-width:520px; margin:48px auto; padding:0 16px; }
  h1 { font-size:18px; margin:0 0 4px; } p { color:var(--mute); margin:0 0 16px; }
  .msg { color:var(--err); background:var(--card); border:1px solid var(--err); border-radius:8px; padding:10px 14px; white-space:pre-wrap; }
  .row { display:flex; align-items:center; gap:10px; padding:0 10px 0 0; background:var(--card);
         border:1px solid var(--line); border-radius:8px; margin-bottom:8px; }
  .row:hover { border-color:var(--acc); } .row.active { border-color:var(--acc); box-shadow:0 0 0 1px var(--acc); }
  .main { flex:1; display:flex; align-items:center; gap:10px; padding:12px 0 12px 14px; color:inherit; text-decoration:none; min-width:0; }
  .dot { width:9px; height:9px; border-radius:50%; flex:none; }
  .running, .external { background:#2bb24c; } .starting { background:#e0a020; } .stopped { background:#888; }
  .name { flex:1; font-weight:500; overflow:hidden; text-overflow:ellipsis; } .port { color:var(--mute); font-family:ui-monospace,monospace; }
  .tag { font-size:12px; color:var(--acc); } .state { font-size:12px; color:var(--mute); }
  .row form { margin:0; } .row a.log { font-size:12px; color:var(--mute); }
  form.custom { display:flex; gap:8px; margin-top:16px; }
  input, button { font:inherit; padding:6px 10px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:inherit; }
  input { flex:1; } button { cursor:pointer; } button:hover { border-color:var(--acc); }`;

const page = (title: string, body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

type Action = 'start' | 'stop' | 'restart';
const ACTIONS: readonly Action[] = ['start', 'stop', 'restart'];

const actionButton = (action: Action, name: string) =>
  `<form method="post" action="${SWITCH_PATH}/${action}/${encodeURIComponent(name)}"><button>${action[0].toUpperCase() + action.slice(1)}</button></form>`;

async function renderSwitchPage(res: Res, msg: string | null): Promise<void> {
  reloadConfig();
  const ports = [...new Set([...config.servers.map((s) => s.port), target])];
  const entries = ports.map((port): ServerEntry & { unregistered?: boolean } =>
    entryOf(port) || { name: `port ${port}`, port, unregistered: true });
  const states = await Promise.all(entries.map((e): Promise<{ state: State }> =>
    e.unregistered ? launcher.probe(e.port).then((up) => ({ state: up ? 'external' : 'stopped' })) : launcher.getState(e)));

  const rows = entries.map((e, i) => {
    const { state } = states[i];
    const active = e.port === target;
    const buttons = e.unregistered || !e.cmd ? '' : state === 'running' || state === 'starting'
      ? actionButton('restart', e.name) + actionButton('stop', e.name)
      : state === 'stopped' ? actionButton('start', e.name) : '';
    const log = e.unregistered || !e.cmd ? '' : `<a class="log" href="${SWITCH_PATH}/log/${encodeURIComponent(e.name)}">log</a>`;
    return `<div class="row${active ? ' active' : ''}">
      <a class="main" href="${SWITCH_PATH}/${e.port}">
        <span class="dot ${state}" title="${state}"></span>
        <span class="name">${esc(e.name)}</span>
        <span class="port">:${e.port}</span>
        ${active ? '<span class="tag">active</span>' : ''}
      </a>
      <span class="state">${state}</span>${log}${buttons}
    </div>`;
  }).join('');

  const custom = ALLOW_UNREGISTERED ? `
    <form class="custom" onsubmit="location.href='${SWITCH_PATH}/'+this.p.value;return false">
      <input name="p" type="number" min="1" max="65535" placeholder="other port" required>
      <button>Go</button>
    </form>` : '';

  const errors = [configError && `servers.json: ${configError}`, msg].filter(Boolean);
  // Keep refreshing while something is booting so the dot turns green on its own.
  const head = states.some((s) => s.state === 'starting') ? `<meta http-equiv="refresh" content="2;url=${SWITCH_PATH}">` : '';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('Switch server', `
<h1>Switch server</h1>
<p>Currently proxying to <b>${esc(nameOf(target))}</b> (:${target})</p>
${errors.map((m) => `<p class="msg">${esc(m)}</p>`).join('')}
${rows}${custom}
<p style="margin-top:24px;font-size:13px">
  <a href="${SWITCH_PATH}/logs" style="color:inherit">All logs</a> &middot;
  <a href="${SWITCH_PATH}/log/${launcher.PROXY}" style="color:inherit">Proxy log</a> &middot;
  <a href="${SWITCH_PATH}/logout" style="color:inherit">Log out</a>
</p>`, head));
}

function doSwitch(port: number, res: Res): void {
  const known = config.servers.some((s) => s.port === port);
  if (!(port > 0 && port < 65536) || port === LISTEN_PORT || (!known && !ALLOW_UNREGISTERED)) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`Not allowed: ${port}\n`);
    return;
  }
  if (port !== target) {
    console.log(`[switch] ${target} -> ${port} (${nameOf(port)})`);
    target = port;
    for (const s of tunnels) s.destroy();
    tunnels.clear();
  }
  res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
  res.end();
}

async function doAction(action: Action, name: string, res: Res): Promise<void> {
  const entry = reloadConfig().servers.find((s) => s.name === name);
  let msg = '';
  try {
    if (!entry) throw new Error(`unknown server "${name}"`);
    if (action !== 'start') await launcher.stop(entry);
    if (action !== 'stop') await launcher.start(entry);
    console.log(`[switch] ${action} ${name}`);
  } catch (err) {
    msg = `${action} ${name}: ${errMsg(err)}`;
  }
  res.writeHead(303, { location: SWITCH_PATH + (msg ? `?msg=${encodeURIComponent(msg)}` : ''), 'cache-control': 'no-store' });
  res.end();
}

// ---- logs ------------------------------------------------------------------
//   GET /switch/log/{name}          viewer page (?raw or a non-browser client: plain text);
//                                   ?lines=N history to load (default 1000, max 5000)
//   GET /switch/log/{name}/stream   SSE: the last ?lines=N lines, then new output live
//   GET /switch/logs[/stream]       the same for every server (plus the proxy), combined
// Each SSE message is {n: name, t: text}; its id holds every file's read position so a
// reconnect (EventSource sends Last-Event-ID) resumes where it left off. A "reset" event
// means the log was started over (server restarted). History reaches back into previous
// runs' logs (<name>.log.1, ...), each preceded by a "run" event that labels it.

const logNames = () => [...config.servers.filter((s) => s.cmd).map((s) => s.name), launcher.PROXY];
const LOG_LINES = 1000; // default history for one server's log (the combined view: 50 per server)
const clampLines = (query: string, dflt: number) =>
  Math.min(5000, Math.max(0, Number(new URLSearchParams(query).get('lines') ?? dflt) || 0));
const linesParam = (query: string) => (new URLSearchParams(query).has('lines') ? `?lines=${clampLines(query, 0)}` : '');

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function readRange(file: string, start: number, end: number): Buffer {
  if (end <= start) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start));
  } finally { fs.closeSync(fd); }
}

/** A log's first line (portctl writes a timestamp there), hashed: when it changes, the file
 *  was rewritten by a restart even if it has already grown past our read position.
 *  null if the file doesn't exist; throws if it exists but can't be read. */
function logSignature(file: string): string | null {
  let head: Buffer;
  try { head = readRange(file, 0, 256); } catch (err) {
    if (errCode(err) === 'ENOENT') return null; // not there (yet), e.g. mid-restart
    throw err; // there but unreadable: the caller reports it
  }
  const nl = head.indexOf(10);
  return crypto.createHash('sha1').update(nl === -1 ? head : head.subarray(0, nl)).digest('hex').slice(0, 8);
}

/** Where the last `lines` lines of a file start (looking back at most 1MB), and how many
 *  lines that actually is (fewer if the file is shorter). */
function tailOffset(file: string, lines: number): { offset: number; count: number } {
  const size = fileSize(file);
  if (!lines) return { offset: size, count: 0 };
  const from = Math.max(0, size - 1024 * 1024);
  let buf: Buffer;
  try { buf = readRange(file, from, size); } catch { return { offset: size, count: 0 }; }
  let i = buf.length - (buf[buf.length - 1] === 10 ? 1 : 0);
  for (let count = 0; i > 0; i--) if (buf[i - 1] === 10 && ++count === lines) break;
  if (i === 0 && from > 0) i = buf.indexOf(10) + 1; // don't start mid-line
  const picked = buf.subarray(i);
  let count = 0;
  for (const b of picked) if (b === 10) count++;
  if (picked.length && picked[picked.length - 1] !== 10) count++;
  return { offset: from + i, count };
}

interface HistoryPart { file: string; label: string; start: number; end: number }

/** The last `lines` lines of a server's log, reaching back into previous runs
 *  (<name>.log.1, .2, ... kept by portctl) when the current run is shorter.
 *  Oldest first; the last part is always the current log. */
function logHistory(name: string, lines: number): HistoryPart[] {
  const file = launcher.logFile(name);
  const parts: HistoryPart[] = [];
  let need = lines;
  for (let run = 0; run === 0 || (need > 0 && run <= 100); run++) {
    const f = run ? `${file}.${run}` : file;
    if (run && !fs.existsSync(f)) break;
    const { offset, count } = tailOffset(f, need);
    parts.unshift({ file: f, label: run ? `previous run (${path.basename(f)})` : 'current run', start: offset, end: fileSize(f) });
    need -= count;
  }
  return parts;
}

// One fs.watchFile per log, shared by every open stream. (Works before the file exists.)
const logWatchers = new Map<string, Set<() => void>>();
function watchLog(file: string, onChange: () => void): () => void {
  let subs = logWatchers.get(file);
  if (!subs) {
    const created = new Set<() => void>();
    subs = created;
    logWatchers.set(file, created);
    fs.watchFile(file, { interval: 300 }, () => { for (const fn of created) fn(); });
  }
  const mine = subs;
  mine.add(onChange);
  return () => {
    mine.delete(onChange);
    if (!mine.size) { fs.unwatchFile(file); logWatchers.delete(file); }
  };
}

function parseLastEventId(header: string | undefined): Record<string, { offset: number; sig: string }> {
  const resume: Record<string, { offset: number; sig: string }> = {};
  for (const part of (header || '').split(';')) {
    const m = /^([\w.-]+)=(\d+)\.(\w+)$/.exec(part);
    if (m) resume[m[1]] = { offset: Number(m[2]), sig: m[3] };
  }
  return resume;
}

interface LogStream {
  name: string;
  file: string;
  sig: string | null;
  offset: number;
  older: HistoryPart[];
  decoder: StringDecoder;
  error?: string;
}

const MAX_STREAMS = 64; // open log streams; past this the oldest is closed (its viewer reconnects)
const MAX_BUFFERED = 8 * 1024 * 1024; // a client this far behind is dropped; it resumes on reconnect
const openStreams = new Set<(why?: string) => void>();

function streamLogs(req: Req, res: Res, names: string[], lines: number): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no', // nginx: don't buffer the stream
  });
  // Notice clients that vanish without closing the connection (sleep, network drop).
  req.socket.setKeepAlive(true, 30000);
  req.socket.setNoDelay(true);

  let closed = false;
  let unwatch: (() => void)[] = [];
  let ping: ReturnType<typeof setInterval> | undefined;
  const close = (why?: string) => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    unwatch.forEach((fn) => fn());
    openStreams.delete(close);
    if (why) console.log(`[logs] closed a stream (${names.join(', ')}): ${why}`);
    res.destroy();
  };
  res.on('close', () => close());
  res.on('error', (err) => close(errText(err)));
  openStreams.add(close);
  if (openStreams.size > MAX_STREAMS) openStreams.values().next().value?.('too many open log streams');
  res.write('retry: 2000\n\n');

  const resume = parseLastEventId(req.headers['last-event-id'] as string | undefined);
  const streams = names.map((name): LogStream => {
    const file = launcher.logFile(name);
    let sig: string | null = null;
    try { sig = logSignature(file); } catch {}
    const prev = resume[name];
    if (prev && sig !== null && prev.sig === sig && prev.offset <= fileSize(file)) {
      return { name, file, sig, offset: prev.offset, older: [], decoder: new StringDecoder('utf8') };
    }
    const parts = logHistory(name, lines);
    const current = parts.pop() as HistoryPart;
    return { name, file, sig, offset: current.start, older: parts, decoder: new StringDecoder('utf8') };
  });
  const id = () => streams.map((s) => `${s.name}=${s.offset}.${s.sig}`).join(';');
  const send = (event: string, data: object) => {
    if (closed) return;
    res.write(`${event ? `event: ${event}\n` : ''}id: ${id()}\ndata: ${JSON.stringify(data)}\n\n`);
    if (res.writableLength > MAX_BUFFERED) close('client too slow');
  };

  // Tell the viewer once when a log can't be read (e.g. permissions), and again when it can.
  const readError = (s: LogStream, err: unknown) => {
    const msg = err ? `can't read ${path.basename(s.file)}: ${errText(err)}` : '';
    if (msg === (s.error || '')) return;
    s.error = msg;
    send('notice', { n: s.name, text: msg || `${path.basename(s.file)} is readable again` });
  };

  const pump = (s: LogStream) => {
    if (closed) return;
    try {
      let sig: string | null;
      try { sig = logSignature(s.file); } catch (err) { return readError(s, err); }
      if (sig === null) return; // gone for the moment (a restart renames it, then writes the new one)
      if (s.error) readError(s, null);
      const size = fileSize(s.file);
      if (sig !== s.sig || size < s.offset) {
        Object.assign(s, { sig, offset: 0, decoder: new StringDecoder('utf8') });
        send('reset', { n: s.name });
      }
      while (s.offset < size && !closed) {
        const end = Math.min(size, s.offset + 256 * 1024);
        let chunk: Buffer;
        try { chunk = readRange(s.file, s.offset, end); } catch (err) { return readError(s, err); }
        s.offset += chunk.length;
        const text = s.decoder.write(chunk); // holds back a multi-byte character cut in half
        if (text) send('', { n: s.name, t: text });
        if (!chunk.length) return;
      }
    } catch (err) {
      console.error(`[logs] ${s.name}:`, err);
      close('error');
    }
  };

  // History from previous runs first (those files don't change), then the live log.
  const sendOlder = (s: LogStream) => {
    if (!s.older.length) return;
    for (const part of s.older) {
      send('run', { n: s.name, label: part.label });
      const decoder = new StringDecoder('utf8');
      for (let pos = part.start; pos < part.end;) {
        let chunk: Buffer;
        try { chunk = readRange(part.file, pos, Math.min(part.end, pos + 256 * 1024)); } catch (err) {
          send('notice', { n: s.name, text: `can't read ${path.basename(part.file)}: ${errText(err)}` });
          break;
        }
        if (!chunk.length) break;
        pos += chunk.length;
        const text = decoder.write(chunk);
        if (text) send('', { n: s.name, t: text });
      }
    }
    send('run', { n: s.name, label: 'current run' });
  };
  try {
    streams.forEach((s) => { sendOlder(s); pump(s); });
  } catch (err) {
    console.error('[logs] sending history:', err);
    return close('error');
  }
  if (closed) return;
  unwatch = streams.map((s) => watchLog(s.file, () => pump(s)));
  ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 20000); // keeps idle proxies from dropping it
}

function showLogText(res: Res, name: string, query: string): void {
  const parts = logHistory(name, clampLines(query, LOG_LINES));
  const text = parts.map((p) => {
    let body = '';
    try { body = readRange(p.file, p.start, p.end).toString('utf8'); } catch {}
    if (parts.length > 1) body = `----- ${name}: ${p.label} -----\n${body}${body && !body.endsWith('\n') ? '\n' : ''}`;
    return body;
  }).join('');
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text || '(no log yet)\n');
}

const LOG_STYLE = `
  html, body { height:100%; }
  body { display:flex; flex-direction:column; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--card); }
  header h1 { margin:0; font-size:16px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header a { color:var(--mute); font-size:13px; }
  .conn { font-size:12px; color:var(--mute); display:flex; align-items:center; gap:6px; }
  .conn .dot { background:#888; } .conn.live .dot { background:#2bb24c; } .conn.wait .dot { background:#e0a020; } .conn.dead .dot { background:#d0473b; }
  header button { font-size:13px; padding:4px 10px; } header button[aria-pressed=true] { border-color:var(--acc); color:var(--acc); }
  #out { flex:1; overflow:auto; margin:0; padding:8px 12px 24px; background:#111214; color:#d6d6d6;
         font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre; }
  #out.wrap { white-space:pre-wrap; overflow-wrap:anywhere; }
  .ln { min-height:1.45em; }
  .sys { color:#8a8f98; font-style:italic; }
  .tag { display:inline-block; margin-right:1ch; font-weight:600; }
  #bottom { position:fixed; right:20px; bottom:20px; display:none; box-shadow:0 2px 8px rgba(0,0,0,.4); }`;

function renderLogViewer(res: Res, { title, streamUrl, combined, names }: { title: string; streamUrl: string; combined: boolean; names: string[] }): void {
  const opts: LogClientOptions = { streamUrl, combined, tagWidth: Math.max(...names.map((n) => n.length)) };
  const json = JSON.stringify(opts).replace(/</g, '\\u003c');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}${LOG_STYLE}</style></head><body>
<header>
  <a href="${SWITCH_PATH}">&larr; servers</a>
  <h1>${esc(title)}</h1>
  <span class="conn wait" id="conn"><span class="dot"></span><span id="conn-text">connecting</span></span>
  <button id="pause" aria-pressed="false">Pause</button>
  <button id="wrap" aria-pressed="false">Wrap</button>
  <button id="clear">Clear</button>
</header>
<pre id="out"></pre>
<button id="bottom">&darr; Latest</button>
<script>(${logClient.toString()})(${json});</script>
</body></html>`);
}

// ---- proxy -----------------------------------------------------------------
// Rewrite absolute redirects to localhost (e.g. http://localhost:3001/login) into
// relative ones so they survive the outer HTTPS proxy.
function fixLocation(loc: string): string {
  return loc.replace(/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(?=\/|$)/i, '') || '/';
}

function upstreamHeaders(req: Req, port: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `localhost:${port}` };
  headers['x-forwarded-host'] ??= req.headers.host;
  headers['x-forwarded-proto'] ??= 'http';
  headers['x-forwarded-for'] ??= req.socket.remoteAddress;
  return headers;
}

function badGateway(res: Res, port: number, err: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  const entry = entryOf(port);
  let running = true;
  try { running = !!entry && !!launcher.getPid(entry.name); } catch {}
  const startBtn = entry?.cmd && !running
    ? `<form method="post" action="${SWITCH_PATH}/start/${encodeURIComponent(entry.name)}"><button>Start ${esc(entry.name)}</button></form>` : '';
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page('502', `
<h1>${esc(nameOf(port))} (:${port}) isn't responding</h1>
<p>${esc(errText(err))}</p>${startBtn}
<p><a href="${SWITCH_PATH}">Switch server &rarr;</a></p>`));
}

const hasBody = (req: Req) => !!req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0;

function proxy(req: Req, res: Res, retry = true): void {
  const port = target;
  const up = http.request({
    host: UPSTREAM_HOST, port, method: req.method, path: req.url,
    headers: upstreamHeaders(req, port),
  }, (pres) => {
    const headers = { ...pres.headers };
    if (headers.location) headers.location = fixLocation(headers.location);
    res.writeHead(pres.statusCode ?? 502, pres.statusMessage, headers);
    pres.pipe(res);
    // The server went away mid-response: end the client's response too instead of leaving it hanging.
    pres.on('aborted', () => res.destroy());
    pres.on('error', () => res.destroy());
  });
  up.on('error', (err) => {
    // A reused keep-alive connection that the server closed just as we sent on it. Nothing
    // reached the server, so a request without a body is safe to send again.
    if (retry && up.reusedSocket && ['ECONNRESET', 'EPIPE'].includes(errCode(err) ?? '') && !res.headersSent && !hasBody(req)) {
      proxy(req, res, false);
      return;
    }
    if (res.destroyed) return; // the client already left; nothing to report to
    console.log(`[proxy] ${req.method} ${req.url} -> :${port}: ${errText(err)}${res.headersSent ? ' (mid-response)' : ''}`);
    badGateway(res, port, err);
  });
  // The client went away first: drop the upstream request.
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (hasBody(req)) req.pipe(up);
  else { req.resume(); up.end(); }
}

async function handleSwitch(req: Req, res: Res, urlPath: string, query: string): Promise<void> {
  if (await guard(req, res, urlPath)) return;
  if (urlPath === SWITCH_PATH || urlPath === SWITCH_PATH + '/') {
    return renderSwitchPage(res, new URLSearchParams(query).get('msg'));
  }
  let parts: string[] = [];
  try { parts = urlPath.slice(SWITCH_PATH.length + 1).split('/').filter(Boolean).map(decodeURIComponent); } catch {}
  if (parts.length === 1 && /^\d+$/.test(parts[0])) return doSwitch(Number(parts[0]), res);
  if (parts.length === 2 && req.method === 'POST' && (ACTIONS as readonly string[]).includes(parts[0])) {
    req.resume();
    return doAction(parts[0] as Action, parts[1], res);
  }
  if (parts[0] === 'log' && parts.length <= 3 && req.method === 'GET') {
    const name = parts[1];
    if (!logNames().includes(name)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('unknown server\n'); return; }
    if (parts[2] === 'stream') return streamLogs(req, res, [name], clampLines(query, LOG_LINES));
    if (parts.length === 3) { res.writeHead(404); res.end(); return; }
    const browser = /text\/html/.test(req.headers.accept || '');
    if (!browser || new URLSearchParams(query).has('raw')) return showLogText(res, name, query);
    const base = `${SWITCH_PATH}/log/${encodeURIComponent(name)}`;
    return renderLogViewer(res, { title: `${name} log`, streamUrl: `${base}/stream${linesParam(query)}`, combined: false, names: [name] });
  }
  if (parts[0] === 'logs' && req.method === 'GET') {
    const names = logNames();
    if (parts[1] === 'stream' && parts.length === 2) return streamLogs(req, res, names, clampLines(query, 50));
    if (parts.length === 1) return renderLogViewer(res, { title: 'All logs', streamUrl: `${SWITCH_PATH}/logs/stream${linesParam(query)}`, combined: true, names });
  }
  if (parts.join('/') === 'api/state') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ target, name: nameOf(target), logStreams: openStreams.size, websockets: tunnels.size }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found\n');
}

const server = http.createServer((req, res) => {
  const [urlPath, query = ''] = (req.url ?? '/').split('?');
  if (urlPath === SWITCH_PATH || urlPath.startsWith(SWITCH_PATH + '/')) {
    handleSwitch(req, res, urlPath, query).catch((err) => {
      console.error('[switch]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  proxy(req, res);
});

// WebSocket / any Upgrade: raw TCP tunnel to the active target.
server.on('upgrade', (req: Req, socket: Duplex, head: Buffer) => {
  const port = target;
  let connected = false;
  const up = net.connect(port, UPSTREAM_HOST, () => {
    connected = true;
    up.setTimeout(0);
    const headers = upstreamHeaders(req, port);
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      for (const val of Array.isArray(v) ? v : [v]) raw += `${k}: ${val}\r\n`;
    }
    up.write(raw + '\r\n');
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  // Small messages (HMR updates) go out at once; dead peers on either side get noticed.
  for (const s of [socket as net.Socket, up]) { s.setNoDelay(true); s.setKeepAlive(true, 30000); }
  up.setTimeout(5000, () => up.destroy(new Error('connect timeout')));
  const close = () => { up.destroy(); socket.destroy(); tunnels.delete(socket); };
  tunnels.add(socket);
  up.on('error', (err) => {
    if (!connected) {
      console.log(`[proxy] websocket ${req.url} -> :${port}: ${errText(err)}`);
      if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    close();
  });
  up.on('close', close);
  socket.on('error', close);
  socket.on('close', close);
});

// Keep idle client connections open longer than the outer proxy does (nginx 60s, Traefik
// 90s, Cloudflare 90s, ...). If we closed first, it could send a request on a connection
// just as we close it, and that request fails with a brief 502.
server.keepAliveTimeout = 150 * 1000;
server.headersTimeout = 155 * 1000; // must exceed keepAliveTimeout on older Node

// Malformed requests and clients that drop mid-request: answer if possible, never throw.
server.on('clientError', (err: NodeJS.ErrnoException, socket: Duplex) => {
  if (err.code !== 'ECONNRESET' && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[port-switch] listening on ${LISTEN_HOST}:${LISTEN_PORT} -> :${target} (${nameOf(target)})`);
  console.log(`[port-switch] switch page: http://localhost:${LISTEN_PORT}${SWITCH_PATH}`);
});
